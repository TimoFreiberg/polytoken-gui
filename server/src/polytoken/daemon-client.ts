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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { components } from "./wire-types.js";

// Test seam: allows tests to intercept Bun.spawn and assert call args.
// Production code uses the real Bun.spawn; tests override via _setSpawnForTesting.
let _spawn: typeof Bun.spawn = Bun.spawn;
export function _setSpawnForTesting(fn: typeof Bun.spawn | null): void {
  _spawn = fn ?? Bun.spawn;
}

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
export type PermissionMonitorResponse = S["PermissionMonitorResponse"];
export type SessionHistorySnapshot = S["SessionHistorySnapshot"];
export type FacetRequest = S["FacetRequest"];
export type CompactRequest = S["CompactRequest"];
export type FileCatalogResponse = S["FileCatalogResponse"];
export type ErrorBody = S["ErrorBody"];

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

/** Resolve the default global config dir the daemon uses, mirroring polytoken's own
 *  resolution: `$XDG_CONFIG_HOME/polytoken` or `~/.config/polytoken`. The daemon's
 *  `--global-config-dir` flag overrides this; the `daemon` subcommand needs it
 *  explicitly (unlike `new --working-dir`, which resolves config upward from the
 *  project dir and finds the global config automatically). */
export function defaultGlobalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(homedir(), ".config");
  return join(base, "polytoken");
}

/** Read the `startup.json` a `polytoken daemon` writes to its session dir. Returns
 *  null when the file is absent or unparseable (a loud-fail to a console warning,
 *  never a crash). The daemon writes `{state:"ready", pid, port}` on success or
 *  `{state:"failed", pid, message}` on failure. */
interface StartupJson {
  state: string;
  session_id?: string;
  pid?: number;
  port?: number;
  message?: string;
}
function readStartupJson(sessionDir: string): StartupJson | null {
  const file = join(sessionDir, "startup.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StartupJson;
  } catch (e) {
    console.error(`[polytoken] failed to parse ${file}`, e);
    return null;
  }
}

/** Wait for a `polytoken daemon` (foreground) to write a `ready` startup.json,
 *  polling every 100ms up to `timeoutMs`. Returns the port. Throws on `failed`,
 *  timeout, or a malformed startup.json. The daemon writes `startup.json` to its
 *  session dir (under the sessions dir) once it has bound its port.
 *
 *  `expectPid` — the pid of the daemon process we just spawned. A `startup.json`
 *  left behind by a PRIOR daemon (state:"ready", a now-dead pid + port) sits in
 *  the session dir from the last run. Without this guard, waitForDaemonStartup
 *  reads that stale file on the very first poll, returns the dead daemon's port,
 *  and `waitForHealth` spins for 10s against an unbound port → every cold resume
 *  of an old session times out. Only trust a `ready` file whose `pid` matches the
 *  process we started. */
// Exported for testing (the spawn path is exercised via a temp dir).
export async function waitForDaemonStartup(
  sessionsDir: string,
  sessionId: string,
  timeoutMs: number,
  expectPid?: number,
): Promise<number> {
  const sessionDir = join(sessionsDir, sessionId);
  const deadline = Date.now() + timeoutMs;
  let lastJson: StartupJson | null = null;
  for (;;) {
    const json = readStartupJson(sessionDir);
    if (json) {
      lastJson = json;
      if (json.state === "ready" && typeof json.port === "number") {
        // Stale startup.json from a prior (now-dead) daemon: its pid won't match
        // the process we just spawned. Keep polling for OUR daemon's file.
        if (expectPid !== undefined && json.pid !== expectPid) {
          // The file is stale — but note it so the timeout message is useful.
          // (The prior daemon's pid is dead; our daemon hasn't written yet.)
        } else {
          return json.port;
        }
      }
      if (json.state === "failed") {
        // A failed file from a prior run (wrong pid) must not abort our wait —
        // only a failure from our own daemon is terminal.
        if (expectPid === undefined || json.pid === expectPid) {
          throw new Error(
            `polytoken daemon failed to start: ${json.message ?? "no message"}`,
          );
        }
      }
      // state is something else (e.g. "starting") — keep polling.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `polytoken daemon did not become ready within ${timeoutMs}ms (startup.json: ${JSON.stringify(lastJson)}; expected pid: ${expectPid ?? "any"})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Spawn a NEW polytoken daemon session (no resume). `polytoken --working-dir <cwd>
 *  new --no-attach` prints `session_id=<id> port=<port>` to stdout and exits 0;
 *  the daemon runs detached. */
async function spawnNewDaemon(
  polytokenBin: string,
  opts: { cwd?: string; loginEnv?: Record<string, string> },
): Promise<SpawnedDaemon> {
  const globalArgs: string[] = [];
  if (opts.cwd) globalArgs.push("--working-dir", opts.cwd);
  const spawnOpts: Parameters<typeof Bun.spawn>[0] = {
    cmd: [polytokenBin, ...globalArgs, "new", "--no-attach"],
    stdout: "pipe",
    stderr: "pipe",
  };
  if (opts.loginEnv && Object.keys(opts.loginEnv).length > 0) {
    spawnOpts.env = { ...process.env, ...opts.loginEnv };
  }
  const proc = _spawn(spawnOpts);
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

/** Spawn a daemon to RESUME an existing session. Unlike `new --no-attach` (which
 *  prints session_id/port and exits), the resume path uses `polytoken daemon
 *  --resume --session-id <id> --project-dir <cwd>` — a FOREGROUND process that
 *  writes `startup.json` (with pid/port) to the session dir. We spawn it in the
 *  background, poll `startup.json` for readiness, and keep the process alive
 *  (the caller owns it via the returned DaemonClient + its close()/kill()).
 *
 *  `--global-config-dir` and `--sessions-dir` are passed explicitly because the
 *  `daemon` subcommand resolves config differently than `new --working-dir`
 *  (it does NOT walk upward from the project dir to find the global config). */
async function spawnResumeDaemon(
  polytokenBin: string,
  opts: {
    sessionId: string;
    cwd: string;
    sessionsDir: string;
    globalConfigDir: string;
    loginEnv?: Record<string, string>;
  },
): Promise<SpawnedDaemon> {
  const args = [
    "daemon",
    "--project-dir",
    opts.cwd,
    "--session-id",
    opts.sessionId,
    "--resume",
    "--global-config-dir",
    opts.globalConfigDir,
    "--sessions-dir",
    opts.sessionsDir,
  ];
  const spawnOpts: Parameters<typeof Bun.spawn>[0] = {
    cmd: [polytokenBin, ...args],
    stdout: "pipe",
    stderr: "pipe",
  };
  if (opts.loginEnv && Object.keys(opts.loginEnv).length > 0) {
    spawnOpts.env = { ...process.env, ...opts.loginEnv };
  }
  const proc = _spawn(spawnOpts);
  // Poll startup.json for readiness (the daemon writes it once it has bound its
  // port). 15s is generous — a cold config load + history replay can take a moment.
  try {
    const port = await waitForDaemonStartup(
      opts.sessionsDir,
      opts.sessionId,
      15_000,
      proc.pid,
    );
    return { sessionId: opts.sessionId, port };
  } catch (e) {
    // Startup failed — kill the background daemon so it doesn't leak.
    try {
      proc.kill();
    } catch {
      // Already dead.
    }
    // Surface the daemon's stderr for diagnostics.
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\ndaemon stderr: ${stderr.slice(0, 500)}`,
    );
  }
}

/** Spawn a polytoken daemon (one session, no TUI attach) and return its session id +
 *  port. A new session uses `polytoken --working-dir <cwd> new --no-attach` (prints
 *  session_id/port to stdout, exits 0). Resuming an existing session uses
 *  `polytoken daemon --resume --session-id <id> --project-dir <cwd>` (foreground;
 *  writes startup.json with the port). The two paths are NOT interchangeable — `new`
 *  does not accept `--resume`/`--session-id`, and `daemon` doesn't print to stdout. */
export async function spawnDaemon(
  polytokenBin: string,
  opts: {
    cwd?: string;
    sessionId?: string;
    /** Required for resume: the on-disk sessions registry dir (where startup.json
     *  is written). Ignored for new sessions. */
    sessionsDir?: string;
    /** Required for resume: the global config dir. Ignored for new sessions. */
    globalConfigDir?: string;
    /** Login-shell env to pass to the daemon (so it gets the user's real PATH +
     *  tool env instead of pilot's minimal launchd env). Merged over process.env:
     *  login env wins. */
    loginEnv?: Record<string, string>;
  } = {},
): Promise<SpawnedDaemon> {
  if (opts.sessionId) {
    // Resume path — needs cwd + sessionsDir + globalConfigDir.
    if (!opts.cwd) {
      throw new Error("spawnDaemon: resume requires cwd");
    }
    if (!opts.sessionsDir) {
      throw new Error("spawnDaemon: resume requires sessionsDir");
    }
    if (!opts.globalConfigDir) {
      throw new Error("spawnDaemon: resume requires globalConfigDir");
    }
    return spawnResumeDaemon(polytokenBin, {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      sessionsDir: opts.sessionsDir,
      globalConfigDir: opts.globalConfigDir,
      loginEnv: opts.loginEnv,
    });
  }
  // New session path.
  return spawnNewDaemon(polytokenBin, { cwd: opts.cwd, loginEnv: opts.loginEnv });
}

/** The parsed 409 lease-held body — the holder label/pid + the expiry Date.
 *  `expiresAt` is null when the body is missing or malformed (not a real lease
 *  conflict), so the caller can fall back to the raw error. */
interface LeaseHeldInfo {
  /** `"label" pid N, lease expires <time>` — a readable holder summary, or the
   *  daemon's own `message` field when the body lacks the structured `active`. */
  summary: string;
  /** The parsed `expires_at`, or null when absent/unparseable. */
  expiresAt: Date | null;
}

/** Parse a 409 lease-held error body into a readable holder description + expiry.
 *  The body shape (observed): `{"active":{"active_pid":..., "active_terminal_label":"...",
 *  "last_seen_at":"...", "expires_at":"..."}, "message":"an interactive TUI is..."}`.
 *  Returns null if the body isn't the expected shape (caller falls back to raw). */
function parseLeaseHeldError(error: string | null): LeaseHeldInfo | null {
  if (!error) return null;
  try {
    const body = JSON.parse(error) as {
      active?: {
        active_terminal_label?: string;
        active_pid?: number;
        expires_at?: string;
      };
      message?: string;
    };
    const a = body.active;
    if (!a) return body.message ? { summary: body.message, expiresAt: null } : null;
    const label = a.active_terminal_label ?? "unknown TUI";
    const pid = a.active_pid ? ` pid ${a.active_pid}` : "";
    const expiresAt = a.expires_at ? new Date(a.expires_at) : null;
    const expires = expiresAt
      ? `, lease expires ${expiresAt.toLocaleTimeString()}`
      : "";
    return { summary: `"${label}"${pid}${expires}`, expiresAt };
  } catch {
    return null;
  }
}

/** Build the lease-conflict error message with the computed time-to-lapse.
 *  Replaces the old hardcoded "~30s" — when we know the expiry, the operator gets
 *  an exact wait. `secondsToLapse` is null only when the body lacked an expiry
 *  (a malformed 409), in which case we fall back to the raw holder summary. */
function formatLeaseConflictMessage(
  held: LeaseHeldInfo | null,
  secondsToLapse: number | null,
): string {
  if (!held) return "lease claim failed (409): another TUI is attached";
  const wait = secondsToLapse != null ? `${secondsToLapse}s` : "~30s";
  return `another TUI is attached to this session (${held.summary}). Detach it there (/detach) or wait ${wait} for its lease to lapse.`;
}

/** Round up to whole seconds (a 1.2s wait reads as "2s", never under-promises). */
function ceilSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

/** A 409 lease-conflict error carrying the parsed holder info + expiry. Thrown by
 *  `claimLease` on a 409; `retryClaim` reads `.held` to decide whether the lease
 *  will lapse within the retry window. `extends Error` so existing catch blocks
 *  that read `.message` are unaffected. */
export class LeaseConflictError extends Error {
  readonly held: LeaseHeldInfo | null;
  constructor(message: string, held: LeaseHeldInfo | null = null) {
    super(message);
    this.name = "LeaseConflictError";
    this.held = held;
  }
}

/** Retry a claim function on 409 lease-conflict errors, up to `maxRetries` times
 *  with `delayMs` backoff between attempts. Pure — takes the claim function so
 *  it's unit-testable without a live daemon. Throws on non-lease-conflict errors
 *  immediately (no retry). On exhaustion (or an early exit when the lease won't
 *  lapse within the remaining retry window), throws a LeaseConflictError whose
 *  message includes the computed time-to-lapse. */
export async function retryClaim<T>(
  claim: () => Promise<T>,
  opts: {
    maxRetries?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const delayMs = opts.delayMs ?? 3000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastConflict: LeaseConflictError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await claim();
    } catch (e) {
      // Only retry LeaseConflictError (409). Other errors throw immediately.
      if (!(e instanceof LeaseConflictError)) throw e;
      lastConflict = e;
      const expiry = e.held?.expiresAt ?? null;
      if (expiry && attempt < maxRetries) {
        const msUntilExpiry = expiry.getTime() - Date.now();
        const remainingDelays = (maxRetries - attempt) * delayMs;
        // The lease won't lapse within the retry window (active TUI heartbeating).
        // Stop retrying — surface the manual Retry toast with the computed wait.
        if (msUntilExpiry > remainingDelays) {
          throw new LeaseConflictError(
            formatLeaseConflictMessage(e.held, ceilSeconds(msUntilExpiry)),
            e.held,
          );
        }
      }
      if (attempt < maxRetries) await sleep(delayMs);
    }
  }
  // All retries exhausted. Build the final message with the computed time-to-lapse
  // (or "~30s" when the body lacked an expiry).
  const held = lastConflict?.held ?? null;
  const expiry = held?.expiresAt ?? null;
  const secondsToLapse = expiry ? ceilSeconds(expiry.getTime() - Date.now()) : null;
  throw new LeaseConflictError(
    formatLeaseConflictMessage(held, secondsToLapse),
    held,
  );
}

/** Default sleep: setTimeout with unref so a pending retry can't keep the process
 *  alive on shutdown. Injectable for tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
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

  /** Run a fetch and return a structured result, catching connection errors
   *  (the daemon's port not yet bound / process died) as a status-0 error rather
   *  than letting them throw out of the caller. A thrown fetch ("Unable to connect")
   *  would otherwise escape retry loops and surface as a raw TypeError message.
   *
   *  AbortGuard: fetch has no default timeout. A daemon that accepts the TCP
   *  connection but never responds (wedged mid-config, deadlocked on a lock) would
   *  hang until the OS TCP keepalive gives up — minutes. That stalls the hub's
   *  switch-queue indefinitely. An AbortController gives every request a hard
   *  ceiling; a wedged daemon returns a status-0 timeout instead of hanging. */
  private async safeFetch(
    url: string,
    init?: RequestInit,
    timeoutMs = 10_000,
  ): Promise<{ status: number; data: unknown; error: string | null } | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      return { status: res.status, data: text, error: null };
    } catch (e) {
      // fetch throws on connection refused / process gone / abort — surface as
      // status 0 with the error message so callers can retry or report cleanly.
      return {
        status: 0,
        data: null,
        error:
          e instanceof DOMException && e.name === "AbortError"
            ? `request timed out after ${timeoutMs}ms`
            : e instanceof Error
              ? e.message
              : String(e),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T | null; error: string | null }> {
    const res = await this.safeFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res) return { status: 0, data: null, error: "fetch returned null" };
    if (res.status === 0) return { status: 0, data: null, error: res.error };
    const text = res.data as string;
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
      error: res.status < 400
        ? null
        : (data as { code?: string; message?: string } | null)?.message ?? text.slice(0, 200),
    };
  }

  private async get<T>(
    path: string,
  ): Promise<{ status: number; data: T | null; error: string | null }> {
    const res = await this.safeFetch(`${this.baseUrl}${path}`);
    if (!res) return { status: 0, data: null, error: "fetch returned null" };
    if (res.status === 0) return { status: 0, data: null, error: res.error };
    const text = res.data as string;
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        return { status: res.status, data: null, error: text.slice(0, 500) };
      }
    }
    return { status: res.status, data, error: res.status < 400 ? null : text.slice(0, 200) };
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
   *
   * On 409 (an active TUI holds the lease), the error is surfaced as a readable
   * message naming the holder + lease expiry — the raw JSON body is not useful to
   * the operator. The holder's lease auto-expires (~30s); retrying after it lapses
   * succeeds.
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
      // 409 = an interactive TUI is already attached. Parse the structured body to
      // name the holder + when its lease expires, so the operator knows to either
      // /detach in the TUI or wait for the lease to lapse. Throws LeaseConflictError
      // (carries the parsed holder info + expiry) so claimLeaseWithRetry can decide
      // whether the lease will lapse within the retry window.
      if (status === 409) {
        const held = parseLeaseHeldError(error);
        throw new LeaseConflictError(
          held
            ? `another TUI is attached to this session (${held.summary}). Detach it there (/detach) or wait ~30s for its lease to lapse.`
            : `lease claim failed (409): ${error}`,
          held,
        );
      }
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

  /**
   * Claim the lease with auto-retry on 409 (stale-lease recovery). Retries up to
   * `maxRetries` times (default 3) with `delayMs` backoff (default 3s). Each 409's
   * `expires_at` is parsed to compute the time-to-lapse; if the lease won't lapse
   * within the retry window (active TUI heartbeating), retrying is pointless — we
   * stop early and throw a LeaseConflictError with the computed wait. On
   * exhaustion, the final error message includes the computed time-to-lapse
   * (replacing the old hardcoded "~30s"). Non-409 errors throw immediately.
   *
   * Catches STALE leases (TUI crashed, lease expiring soon) transparently — the
   * session opens on a retry after the lease lapses. Does NOT add a force-kill
   * mechanism; a live TUI session surfaces a manual Retry toast instead.
   */
  async claimLeaseWithRetry(
    label = "pilot",
    opts: { maxRetries?: number; delayMs?: number } = {},
  ): Promise<TuiAttachClaimResponse> {
    return retryClaim(() => this.claimLease(label), opts);
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

  /** `POST /adventurous-handoff` — toggle the adventurous auto-handoff flag.
   *  Returns the new state so the driver can emit a snapshot immediately (the
   *  daemon's computed `adventurous_handoff_active` on GET /state may lag by one
   *  fetch — this returns the raw `enabled` flag, not the computed value). */
  async toggleAdventurousHandoff(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/adventurous-handoff`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`POST /adventurous-handoff failed (${res.status})`);
    }
    const body = await res.json() as { enabled?: boolean };
    return body.enabled ?? false;
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

  /** `GET /files` — the daemon's ignore-aware project file index (alphabetical, dirs
   *  trailing `/`). `include_ignored` disables .gitignore/.claudeignore/.polytokenignore
   *  (dotfiles + the project private dir stay excluded). Returns `[]` when the project
   *  root is unavailable. The daemon owns this index natively — pilot doesn't run its
   *  own `fd` for the index under this driver (spike §8). */
  files(opts?: { includeIgnored?: boolean }): Promise<{ status: number; data: FileCatalogResponse | null; error: string | null }> {
    const qs = opts?.includeIgnored ? "?include_ignored=true" : "";
    return this.get<FileCatalogResponse>(`/files${qs}`);
  }

  // --- Other endpoints used by the driver ---

  /** `POST /model` — switch the session's model (+ reasoning effort). */
  async setModel(model: string, reasoningEffort?: string): Promise<void> {
    const body: ModelRequest = { model, reasoning_effort: reasoningEffort ?? null };
    const { status, data, error } = await this.post<ErrorBody>("/model", body);
    if (status === 200) return;
    // 409 no_change: the model is already set to the requested value — benign.
    if (status === 409 && data?.code === "no_change") return;
    throw new Error(`POST /model failed (${status}): ${error}`);
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

  /** `GET /permission-monitor` — the live per-session monitor (+ global defaults).
   *  Used once at session warm-up to seed the cached mode (the monitor isn't in
   *  GET /state). Ongoing sync rides the `permission_monitor_switch` event. */
  async getPermissionMonitor(): Promise<PermissionMonitorResponse> {
    const { status, data, error } = await this.get<PermissionMonitorResponse>(
      "/permission-monitor",
    );
    if (status !== 200 || !data)
      throw new Error(`GET /permission-monitor failed (${status}): ${error}`);
    return data;
  }

  /** `GET /notification-autodrain` — the autodrain flag (+ config default).
   *  Used once at warm-up to seed the cached state (it isn't on GET /state). */
  async getNotificationAutodrain(): Promise<{ enabled: boolean; config_default: boolean }> {
    const { status, data, error } = await this.get<{
      enabled: boolean;
      config_default: boolean;
    }>("/notification-autodrain");
    if (status !== 200 || !data)
      throw new Error(`GET /notification-autodrain failed (${status}): ${error}`);
    return data;
  }

  /** `POST /notification-autodrain` — set the autodrain flag. */
  async setNotificationAutodrain(enabled: boolean): Promise<void> {
    const { status, error } = await this.post("/notification-autodrain", { enabled });
    if (status !== 200)
      throw new Error(`POST /notification-autodrain failed (${status}): ${error}`);
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
