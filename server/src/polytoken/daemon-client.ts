// The low-level HTTP + SSE + process-lifecycle client for a single polytoken daemon.
//
// One daemon process = one session = one port (confirmed in docs/polytoken-spike.md §1).
// This module owns the lifecycle of ONE such daemon: spawn it, claim the TUI attachment
// lease (+ heartbeat), subscribe to the `/events` SSE stream, and POST to its endpoints.
// The PolytokenDriver composes one of these per warm session.
//
// Design notes (from the spike):
// - The lease is pid-bound and EXCLUSIVE (a second claim → 409). Pilot is the sole
//   attacher; the local TUI detaches while pilot drives.
// - SSE is push-only with no periodic heartbeats on an idle daemon — liveness must be
//   time-based (frame gap), not expect periodic `heartbeat` events.
// - `Last-Event-ID` resume is supported by the `id:` field (== `seq`); not yet wired.
// - All endpoints are flat (no `/session/{id}/…`) — the daemon IS the session.

import type { components } from "./wire-types.js";

// Pull out the wire types we need from the generated schema. These are the shapes
// the daemon's HTTP surface accepts/returns and the SSE stream carries.
type S = components["schemas"];
export type DaemonEvent = S["DaemonEvent"];
export type SseEnvelope = S["SseEnvelope"];
export type SessionStateSnapshot = S["SessionStateSnapshot"];
export type PromptAccepted = S["PromptAccepted"];
export type PromptRequest = S["PromptRequest"];
export type PendingTurnInputRequest = S["PendingTurnInputRequest"];
export type PendingTurnInputSnapshot = S["PendingTurnInputSnapshot"];
export type TuiAttachClaimRequest = S["TuiAttachClaimRequest"];
export type TuiAttachClaimResponse = S["TuiAttachClaimResponse"];
export type TuiAttachHeartbeatRequest = S["TuiAttachHeartbeatRequest"];
export type HealthResponse = S["HealthResponse"];
export type ModelRequest = S["ModelRequest"];
export type RewindRequest = S["RewindRequest"];
export type SessionTitleRequest = S["SessionTitleRequest"];
export type InterrogativeResponse = S["InterrogativeResponse"];
export type PermissionMonitorRequest = S["PermissionMonitorRequest"];
export type SessionHistorySnapshot = S["SessionHistorySnapshot"];
export type FacetRequest = S["FacetRequest"];
export type CompactRequest = S["CompactRequest"];

/** Result of spawning a daemon — parsed from `polytoken new --no-attach` stdout. */
export interface SpawnedDaemon {
  sessionId: string;
  port: number;
}

/** A claimed attachment lease + its lifecycle handles. */
export interface AttachmentLease {
  leaseId: string;
  heartbeatIntervalMs: number;
  expiresAfterMs: number;
  /** The heartbeat timer; cleared on release. */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Parse `polytoken new --no-attach` stdout: `session_id=<id> port=<port>`.
 * Loud-fails on a malformed line — never silently returns a half-parsed session.
 */
export function parseSpawnOutput(stdout: string): SpawnedDaemon {
  // The line looks like: `session_id=04msc4-zesty port=51269` (possibly with ANSI/log noise).
  const line = stdout.split("\n").find((l) => l.includes("session_id="));
  if (!line) {
    throw new Error(
      `polytoken new --no-attach produced no session_id line:\n${stdout.slice(0, 500)}`,
    );
  }
  const sessionMatch = line.match(/session_id=(\S+)/);
  const portMatch = line.match(/port=(\d+)/);
  if (!sessionMatch || !portMatch) {
    throw new Error(
      `polytoken new --no-attach line unparseable: ${JSON.stringify(line)}`,
    );
  }
  const sessionId = sessionMatch[1];
  const portStr = portMatch[1];
  if (!sessionId || !portStr) {
    throw new Error(
      `polytoken new --no-attach line unparseable: ${JSON.stringify(line)}`,
    );
  }
  return { sessionId, port: Number(portStr) };
}

/** Spawn a polytoken daemon (one session, no TUI attach) and return its session id + port.
 *  `--working-dir` is a GLOBAL option (before the subcommand), not a `new` flag. */
export async function spawnDaemon(
  polytokenBin: string,
  opts: { cwd?: string; sessionId?: string } = {},
): Promise<SpawnedDaemon> {
  // Global options come before the subcommand: `polytoken --working-dir <dir> new --no-attach`
  const globalArgs: string[] = [];
  if (opts.cwd) globalArgs.push("--working-dir", opts.cwd);

  const subArgs = ["new", "--no-attach"];
  // --resume with --session-id reopens an existing session's daemon.
  if (opts.sessionId) {
    subArgs.push("--resume", "--session-id", opts.sessionId);
  }
  const proc = Bun.spawn({
    cmd: [polytokenBin, ...globalArgs, ...subArgs],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(
      `polytoken new --no-attach exited ${exitCode}:\nstderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}`,
    );
  }
  return parseSpawnOutput(stdout);
}

/**
 * A typed client for one live polytoken daemon process. Owns the HTTP surface, the
 * attachment lease (+ heartbeat timer), and the SSE subscriber. Call `close()` to
 * release the lease and terminate the daemon — never leave a child process orphaned.
 */
export class DaemonClient {
  readonly sessionId: string;
  readonly port: number;
  private readonly baseUrl: string;
  private readonly pid: number;
  /** The daemon's own OS pid, captured from GET /health. Used as a kill() fallback
   *  when HTTP /terminate fails (a wedged daemon won't respond to HTTP). */
  private daemonPid: number | null = null;
  private lease: AttachmentLease | null = null;
  private sseController: AbortController | null = null;

  constructor(sessionId: string, port: number, pid: number) {
    this.sessionId = sessionId;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.pid = pid;
  }

  // --- HTTP helpers ---

  private async post<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null; error: string | null }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        // Non-JSON response — return raw text in error.
        return { status: res.status, data: null, error: text.slice(0, 500) };
      }
    }
    return {
      status: res.status,
      data,
      error: res.ok ? null : (data as { error?: string } | null)?.error ?? text.slice(0, 200),
    };
  }

  private async get<T>(
    path: string,
  ): Promise<{ status: number; data: T | null; error: string | null }> {
    const res = await fetch(`${this.baseUrl}${path}`);
    const text = await res.text();
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        return { status: res.status, data: null, error: text.slice(0, 500) };
      }
    }
    return { status: res.status, data, error: res.ok ? null : text.slice(0, 200) };
  }

  // --- Lifecycle ---

  /**
   * `GET /health` — confirms the daemon is alive and echoes its session record.
   * Captures the daemon's own OS pid (for the kill() fallback) as a side effect.
   */
  async health(): Promise<{ status: number; data: HealthResponse | null; error: string | null }> {
    const result = await this.get<HealthResponse>("/health");
    if (result.status === 200 && result.data) {
      this.daemonPid = result.data.pid;
    }
    return result;
  }

  /** `POST /terminate` — graceful drain + exit. */
  async terminate(): Promise<void> {
    await this.post("/terminate");
  }

  /**
   * Hard-kill the daemon process (SIGTERM → SIGKILL fallback). Used when HTTP
   * /terminate fails (a wedged daemon won't respond to HTTP) or on a synchronous
   * exit path where we can't await a network round-trip. Requires the daemon pid
   * captured from /health; no-op if the pid is unknown.
   */
  kill(): void {
    if (!this.daemonPid) return;
    try {
      process.kill(this.daemonPid, "SIGTERM");
    } catch {
      // Already dead, or no permission — best-effort.
    }
  }

  // --- Attachment lease ---

  /**
   * Claim the TUI attachment lease. The lease is pid-bound and EXCLUSIVE (a second
   * claim while one is live → 409). Pilot is the sole attacher; the local TUI
   * detaches while pilot drives. Starts the heartbeat timer automatically.
   */
  async claimLease(label = "pilot"): Promise<TuiAttachClaimResponse> {
    const body: TuiAttachClaimRequest = {
      pid: this.pid,
      terminal_label: label,
    };
    const { status, data, error } = await this.post<TuiAttachClaimResponse>(
      "/tui-attachment/claim",
      body,
    );
    if (status !== 200 || !data) {
      throw new Error(`lease claim failed (${status}): ${error}`);
    }
    // Start the heartbeat timer. The spike confirmed heartbeat_interval_seconds: 5,
    // expires_after_seconds: 30 — heartbeat well before the expiry.
    const heartbeatMs = (data.heartbeat_interval_seconds ?? 5) * 1000;
    const heartbeatTimer = setInterval(() => this.heartbeat(data.lease_id), heartbeatMs);
    // unref so a missed cleanup path can't keep the process alive on shutdown —
    // mirrors the driver's reaper timer. clearLease() clears it on the normal path.
    heartbeatTimer.unref?.();
    this.lease = {
      leaseId: data.lease_id,
      heartbeatIntervalMs: heartbeatMs,
      expiresAfterMs: (data.expires_after_seconds ?? 30) * 1000,
      heartbeatTimer,
    };
    return data;
  }

  /** `POST /tui-attachment/heartbeat` — refresh the lease. 409 if the pid doesn't match. */
  private async heartbeat(leaseId: string): Promise<void> {
    const body: TuiAttachHeartbeatRequest = { lease_id: leaseId, pid: this.pid };
    const { status, error } = await this.post("/tui-attachment/heartbeat", body);
    if (status === 404 || status === 409) {
      // Lease expired or stolen — clear the timer; the SSE will gap and the driver
      // will re-seed. Log loudly (this shouldn't happen under normal operation).
      console.error(`[polytoken] lease heartbeat failed (${status}): ${error}`);
      this.clearLease();
    }
  }

  private clearLease(): void {
    if (this.lease?.heartbeatTimer) clearInterval(this.lease.heartbeatTimer);
    this.lease = null;
  }

  /** `DELETE /tui-attachment/{lease_id}` — release the lease (idempotent → 204). */
  async releaseLease(): Promise<void> {
    if (!this.lease) return;
    const leaseId = this.lease.leaseId;
    this.clearLease();
    await fetch(`${this.baseUrl}/tui-attachment/${encodeURIComponent(leaseId)}`, {
      method: "DELETE",
    });
  }

  // --- Prompt + steering ---

  /**
   * `POST /prompt` — the happy-path turn starter. Returns 202 + {prompt_id, session_id}.
   * 409 if a turn is already in flight (the queue does NOT auto-absorb a concurrent
   * prompt — it's rejected). 422 if a pre-user-prompt hook denied it.
   */
  async prompt(content: string, maxToolTurns?: number): Promise<PromptAccepted> {
    const body: PromptRequest = { content, max_tool_turns: maxToolTurns ?? null };
    const { status, data, error } = await this.post<PromptAccepted>("/prompt", body);
    if (status !== 202 || !data) {
      throw new Error(`POST /prompt failed (${status}): ${error}`);
    }
    return data;
  }

  /**
   * `POST /turn/input` — queue steering/follow-up input for the active turn.
   * PendingTurnInputRequest is just {content} — no steer/followUp discriminator
   * (that distinction is pilot-side UX only).
   */
  async queueTurnInput(content: string): Promise<void> {
    const body: PendingTurnInputRequest = { content };
    const { status, error } = await this.post("/turn/input", body);
    if (status !== 202) {
      throw new Error(`POST /turn/input failed (${status}): ${error}`);
    }
  }

  /** `GET /turn/input` — the pending queue snapshot. */
  turnInputSnapshot(): Promise<{ status: number; data: PendingTurnInputSnapshot | null; error: string | null }> {
    return this.get<PendingTurnInputSnapshot>("/turn/input");
  }

  /** `DELETE /turn/input/newest` — dequeue the newest pending input. */
  async dequeueNewestInput(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/turn/input/newest`, {
      method: "DELETE",
    });
    // 200 = dequeued; 409 = no pending input (both are acceptable no-ops).
    if (res.status !== 200 && res.status !== 409) {
      throw new Error(`DELETE /turn/input/newest failed (${res.status})`);
    }
  }

  /**
   * `POST /turn/cancel` — abort the active turn. The spec documents 409 when no turn
   * is in flight, but the live daemon was observed returning 202 with prompt_id:null
   * in that case instead (spike §3). Treat both as no-op.
   */
  async cancelTurn(): Promise<void> {
    const { status, error } = await this.post("/turn/cancel");
    if (status !== 202 && status !== 409) {
      throw new Error(`POST /turn/cancel failed (${status}): ${error}`);
    }
  }

  // --- State + history ---

  /** `GET /state` — the authoritative session state snapshot. */
  state(): Promise<{ status: number; data: SessionStateSnapshot | null; error: string | null }> {
    return this.get<SessionStateSnapshot>("/state");
  }

  /** `GET /history` — the projected session transcript (linear, no branch DAG). */
  history(offset?: number, limit?: number): Promise<{ status: number; data: SessionHistorySnapshot | null; error: string | null }> {
    const params = new URLSearchParams();
    if (offset !== undefined) params.set("offset", String(offset));
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    return this.get<SessionHistorySnapshot>(`/history${qs ? `?${qs}` : ""}`);
  }

  // --- Other endpoints used by the driver ---

  /** `POST /model` — switch the session's model (+ reasoning effort). */
  async setModel(model: string, reasoningEffort?: string): Promise<void> {
    const body: ModelRequest = { model, reasoning_effort: reasoningEffort ?? null };
    const { status, error } = await this.post("/model", body);
    if (status !== 200) throw new Error(`POST /model failed (${status}): ${error}`);
  }

  /** `POST /title` — set the operator title override (empty = clear → revert to inferred). */
  async setTitle(title: string): Promise<void> {
    const body: SessionTitleRequest = { title };
    const { status, error } = await this.post("/title", body);
    if (status !== 200) throw new Error(`POST /title failed (${status}): ${error}`);
  }

  /** `POST /interrogative/{id}/respond` — answer a pending interrogative.
   *  Has a 10s timeout: a wedged daemon that accepts the connection but never
   *  responds would otherwise hang the caller's `hostUiResolved` deferred
   *  promise indefinitely, stranding the approval card. The timeout triggers the
   *  `.catch()` path so the driver can dismiss the card + surface an error. */
  async respondInterrogative(id: string, response: InterrogativeResponse): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `${this.baseUrl}/interrogative/${encodeURIComponent(id)}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(response),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`POST /interrogative/respond failed (${res.status}): ${text.slice(0, 200)}`);
      }
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`POST /interrogative/respond timed out (10s) for ${id}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** `POST /permission-monitor` — switch the permission mode. */
  async setPermissionMode(mode: PermissionMonitorRequest["mode"]): Promise<void> {
    const body: PermissionMonitorRequest = { mode };
    const { status, error } = await this.post("/permission-monitor", body);
    if (status !== 200) throw new Error(`POST /permission-monitor failed (${status}): ${error}`);
  }

  /** `POST /clear` — reset context (also resets the shell env). */
  async clear(): Promise<void> {
    const { status, error } = await this.post("/clear");
    if (status !== 200) throw new Error(`POST /clear failed (${status}): ${error}`);
  }

  /** `POST /compact` — trigger context compaction. */
  async compact(request?: CompactRequest): Promise<void> {
    const { status, error } = await this.post("/compact", request ?? null);
    if (status !== 202) throw new Error(`POST /compact failed (${status}): ${error}`);
  }

  /** `POST /rewind` — destructive: drops the target prompt + everything after it. */
  async rewind(request: RewindRequest): Promise<void> {
    const { status, error } = await this.post("/rewind", request);
    if (status !== 202) throw new Error(`POST /rewind failed (${status}): ${error}`);
  }

  /** `POST /facet` — switch the active facet (mid-conversation persona switch). */
  async setFacet(facet: string): Promise<void> {
    const body: FacetRequest = { facet };
    const { status, error } = await this.post("/facet", body);
    if (status !== 200) throw new Error(`POST /facet failed (${status}): ${error}`);
  }

  /** `POST /reload` — reload the session from scratch (dispose + re-warm). */
  async reload(): Promise<void> {
    const { status, error } = await this.post("/reload");
    if (status !== 200) throw new Error(`POST /reload failed (${status}): ${error}`);
  }

  // --- SSE ---

  /**
   * Subscribe to `GET /events` — the SSE stream of `Envelope<DaemonEvent>` frames.
   * Each frame is `id: <seq>\ndata: {seq, emitted_at, session_id, event: {type, ...}}`.
   * The `type` discriminator lives at `event.type` (not the envelope root).
   *
   * Returns an unsubscribe function that aborts the SSE fetch. The stream is
   * push-only — an idle daemon emits nothing (spike §6), so liveness must be
   * time-based (frame gap), not expect periodic `heartbeat` events.
   */
  subscribe(onEvent: (envelope: SseEnvelope) => void): () => void {
    this.sseController = new AbortController();
    const { signal } = this.sseController;

    // SSE parsing: accumulate a buffer, split on frame boundaries (`\n\n` or `\r\n\r\n`),
    // extract `data:` lines. Per the SSE spec, multiple `data:` lines are concatenated
    // with `\n`. CRLF line endings are normalized to LF first (some HTTP servers emit `\r\n`).
    const decoder = new TextDecoder();
    let buffer = "";

    void (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/events`, { signal });
        if (!res.ok || !res.body) {
          console.error(`[polytoken] SSE connect failed: ${res.status}`);
          return;
        }
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Normalize CRLF → LF so `\n\n` splits work regardless of line ending.
          buffer = buffer.replace(/\r\n/g, "\n");
          // SSE frames are separated by `\n\n`. Process complete frames.
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            // Concatenate all `data:` lines (the spec joins them with `\n`).
            const dataLines = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice("data:".length));
            if (dataLines.length === 0) continue;
            const json = dataLines.join("\n").trim();
            if (!json) continue;
            try {
              const envelope = JSON.parse(json) as SseEnvelope;
              onEvent(envelope);
            } catch (e) {
              console.error("[polytoken] SSE frame parse error:", e);
            }
          }
        }
      } catch (e) {
        if (signal.aborted) return; // clean unsubscribe
        console.error("[polytoken] SSE stream error:", e);
      }
    })();

    return () => {
      this.sseController?.abort();
      this.sseController = null;
    };
  }

  // --- Shutdown ---

  /**
   * Release the lease and terminate the daemon. Idempotent — safe to call on an
   * already-closed client. Never throws (best-effort cleanup on shutdown paths).
   * Falls back to SIGTERM if HTTP /terminate fails or times out (a wedged daemon
   * won't answer HTTP, and a hung fetch wouldn't throw — it would just never resolve).
   */
  async close(): Promise<void> {
    this.sseController?.abort();
    this.sseController = null;
    // Race the HTTP cleanup against a 2s timeout — a wedged daemon's fetch hangs
    // indefinitely, and we can't block shutdown on a dead process.
    const httpCleanup = (async () => {
      try {
        await this.releaseLease();
      } catch {
        // best-effort
      }
      try {
        await this.terminate();
      } catch {
        // HTTP terminate failed — caller will fall back to kill().
      }
    })();
    await Promise.race([
      httpCleanup,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    // Always hard-kill as a final fallback — covers both HTTP failure and timeout.
    // (Idempotent: kill() is a no-op if the process is already dead.)
    this.kill();
  }

  /**
   * Synchronous hard-kill for the process exit path (can't await HTTP round-trips
   * in an exit handler). Aborts SSE, clears the heartbeat, and SIGTERMs the daemon.
   */
  killNow(): void {
    this.sseController?.abort();
    this.sseController = null;
    this.clearLease();
    this.kill();
  }
}
