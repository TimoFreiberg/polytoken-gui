// The session hub: holds the authoritative folded SessionState, folds every
// driver event into it, and fans events out to all connected WS clients. New
// clients get hello + a full snapshot so they catch up without replaying history.

import { homedir } from "node:os";
import {
  type ClientMessage,
  foldEvent,
  initialSessionState,
  isDialogRequest,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionAttention,
  type SessionDriverEvent,
  type SessionId,
  type SessionState,
} from "@pilot/protocol";
import type { OAuthLoginIO, PilotDriver } from "./driver.js";

export type Send = (msg: ServerMessage) => void;

// How long an OAuth prompt waits for the operator before the login aborts itself. The
// browser hop + copy/paste is slow but human-paced; a few minutes is generous without
// leaving a zombie login (and its loopback server) pending forever if a phone is closed.
const OAUTH_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/** What the hub hands to a notifier (e.g. the Web Push sender) for notable events. */
export interface HubNotification {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

interface AttentionRecord {
  phase: "running" | "failed" | "done";
  activity?: string;
  updatedAt: string;
  pending: Map<string, string>;
}

function clipped(value: string, max = 72): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function inputString(
  input: unknown,
  keys: readonly string[],
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const values = input as Record<string, unknown>;
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return clipped(value);
  }
  return undefined;
}

function toolActivity(
  ev: Extract<SessionDriverEvent, { type: "toolStarted" }>,
): string {
  const name = ev.toolName.toLowerCase();
  const path = inputString(ev.input, ["path", "filePath", "file_path"]);
  if (name.includes("read")) return path ? `Reading ${path}` : "Reading files";
  if (name.includes("edit") || name.includes("write"))
    return path ? `Editing ${path}` : "Editing files";
  if (name.includes("search") || name.includes("grep") || name === "rg")
    return "Searching the workspace";
  if (name === "bash" || name === "shell" || name === "exec") {
    const command = inputString(ev.input, ["command", "cmd"]);
    return command ? `Running ${command}` : "Running a command";
  }
  return clipped(ev.label ?? ev.description ?? ev.toolName);
}

function requestTitle(
  request: Extract<SessionDriverEvent, { type: "hostUiRequest" }>["request"],
): string {
  if ("title" in request && request.title) return clipped(request.title);
  if ("message" in request && request.message) return clipped(request.message);
  return request.kind === "qna" ? "Questions need answers" : "Waiting on you";
}

/** One connected client (WS connection). Focus is per-connection: each browser picks
 *  which session it's looking at independently, so the phone switching can't move the
 *  desktop underneath it. Durable session state + actions stay shared. Keyed in the hub
 *  by its stable `send` closure (index.ts gives each connection exactly one). */
interface ClientConn {
  send: Send;
  // The session this connection is viewing (null = the empty landing). Points into
  // `sessionStates`; null until the client adopts the default or opens a session.
  focusedId: SessionId | null;
  // Single-flight per connection: a swap can block (warming pi, or a trust card awaiting
  // input), so only one runs at a time on THIS connection (others are free). A second
  // request arriving meanwhile isn't rejected — it's coalesced into `pendingSwitch` and
  // run when the current one finishes (see switchTo). This kills the boot-restore-vs-click
  // race: a click during the fresh-start restore warm used to draw a misleading "answer
  // the trust prompt first" error and drop the click; now the click just wins.
  switchInFlight: boolean;
  // The latest switch queued behind an in-flight one (depth 1 — a newer request supersedes
  // an older queued one, so the operator's last gesture wins). `resolve` settles the
  // promise switchTo handed its caller, with the eventual session id (or null if the swap
  // failed / this request got superseded before it ran).
  pendingSwitch: PendingSwitch | null;
}

interface PendingSwitch {
  swap: () => Promise<SessionDriverEvent[]>;
  opts: { reseed?: boolean };
  resolve: (sid: SessionId | null) => void;
}

export class SessionHub {
  // Folded transcript state per session, for every session a client is viewing (plus
  // the bootstrap landing default). Multiple clients on the same session share one
  // entry. Background sessions nobody opened are tracked only via running/attention
  // below — their transcript stays private to the driver until someone focuses them.
  private sessionStates = new Map<SessionId, SessionState>();
  // The landing session a freshly-connecting client with no focus of its own adopts:
  // the mock's bootstrap greeting, or null for pi's empty startup landing. Established
  // from the driver's defaultSeed() on construction + reset.
  private defaultFocusId: SessionId | null = null;
  // Session ids with a live turn right now — tracked across ALL sessions, not just
  // the focused one (a background turn never folds into `state`/broadcasts events,
  // but the client still needs its running/done indicator). Pushed as `sessionStatus`
  // when the set changes. In-memory only: a session on disk is never "running".
  private running = new Set<SessionId>();
  // Sessions surfaced as `initializing` — created/opened but not yet streaming (warming
  // up: model load, history replay, trust). Tracked + broadcast alongside `running` so a
  // background/just-created row shows a distinct "spinning up" indicator. A session is
  // never both running and initializing; entering either clears the other here.
  private initializing = new Set<SessionId>();
  // Compact metadata for every warm session. Background transcripts stay private to the
  // driver; this map carries only enough state to route the operator's attention.
  private attention = new Map<SessionId, AttentionRecord>();
  private sessionTitles = new Map<SessionId, string>();
  private clients = new Map<Send, ClientConn>();
  // Whether any client has connected since startup. Gates push so replayed history
  // — the mock's bootstrap greeting, or the pi driver's on-load session replay
  // (both can end in runCompleted while clientCount is 0) — doesn't buzz a stored
  // subscription on every restart. This is also how replay is told apart from live
  // events (D13): cold-start seeds fold before anyone connects, and switchTo folds
  // its seed directly rather than through onEvent, so neither reaches maybeNotify.
  private everConnected = false;
  // Debounced live-refresh ticker. While a turn runs, the only events that fire are
  // deltas/tool/user — none carries fresh `usage` and none re-lists sessions, so the
  // composer's context meter AND the sidebar rows (message count / name / preview)
  // freeze at their last turn-boundary value. This ticker re-broadcasts both on a
  // cadence; it runs only while something is running AND a client is watching, and is
  // nulled when idle. (getContextUsage / listSessions are O(messages|files) — fine once
  // a second, never on the per-delta path.)
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  // Desktop auto-update (driven by scripts/desktop/update-watcher.ts via /update/state).
  // `updateSha` is the origin/main commit the watcher staged but deferred because a client
  // is connected; null = up to date. `applying` flips true when a client clicks the
  // sidebar card's "update now" — the watcher reads it back on its next poll and applies.
  private updateSha: string | null = null;
  private applying = false;
  // OAuth login (Settings panel) is a GLOBAL interactive flow — it writes pi's shared
  // auth.json, not a session — so it rides its own wire messages, not the session-scoped
  // Host UI channel. While a login runs, its prompts wait here keyed by requestId; an
  // `oauthRespond` resolves one (first-responder-wins across devices). Single-flight:
  // one login at a time keeps the pending map unambiguous (a single user, one browser).
  private oauthPending = new Map<string, (value: string | null) => void>();
  private oauthSeq = 0;
  private oauthInFlight = false;
  // Prompt acceptance is idempotent per client-generated id. The promise is stored
  // before dispatch so a reconnect/retry racing the original request attaches to the
  // same result instead of invoking pi twice. Bounded because this is only a short-term
  // reconnect ledger, not durable session history.
  private promptResults = new Map<
    string,
    Promise<Extract<ServerMessage, { type: "promptResult" }>>
  >();
  private static readonly PROMPT_RESULT_CAP = 2048;

  constructor(
    private driver: PilotDriver,
    // Called on run-done / approval-needed when NO client is connected, i.e. every
    // surface is backgrounded/closed — exactly when a Web Push should reach a pocket.
    private notify?: (n: HubNotification) => void,
    // Cadence (ms) for the live-refresh ticker above. Default 1s; the e2e suite sets a
    // shorter value (PILOT_LIVE_REFRESH_MS) so the meter/list visibly climb in a test.
    private liveRefreshMs = 1000,
    // Stable per data-dir identity. Production passes the persisted id minted at startup;
    // tests that construct a hub directly get a process-local fallback.
    private serverId = `pilot-${Math.floor(Date.now() / 1000)}`,
  ) {
    driver.subscribe((ev) => this.onEvent(ev));
    // Project-trust cards travel their own channel (D12): they're decided before a
    // session exists and while `switching` suppresses session events, so they can't go
    // through onEvent. Relay request → broadcast card, resolved → dismiss it.
    driver.subscribeTrust?.((ev) => {
      if (ev.kind === "request")
        this.broadcast({ type: "trustRequest", ...ev.request });
      else this.broadcast({ type: "trustResolved", requestId: ev.requestId });
    });
    // Let the driver learn whether anyone is connected to answer an interactive prompt.
    // The trust subscription above persists for the hub's life (it's the relay channel),
    // so it can't double as a presence signal — this live predicate can. The driver
    // deny-safes a project-trust card immediately when this reads false rather than
    // hanging the swap for the prompt's full timeout.
    driver.setClientPresence?.(() => this.clients.size > 0);
    this.seedDefault();
  }

  /** Establish the landing session a fresh client adopts: fold the driver's
   *  defaultSeed() into a shared session state and record it as `defaultFocusId`.
   *  No-op (empty landing) when the driver has no default — pi at boot, or the mock
   *  reset with bootstrap:false. Called on construction + after reset. */
  private seedDefault(): void {
    const seed = this.driver.defaultSeed?.();
    const sid = seed?.[0]?.sessionRef.sessionId;
    if (!seed || seed.length === 0 || !sid) return;
    const st = initialSessionState();
    for (const e of seed) {
      foldEvent(st, e);
      this.trackRunning(e.sessionRef.sessionId, e);
      this.trackAttention(e.sessionRef.sessionId, e);
    }
    this.sessionStates.set(sid, st);
    this.defaultFocusId = sid;
  }

  /** A JSON-safe snapshot of one session's folded state (or the empty landing). */
  private snapshotOf(sid: SessionId | null): SessionState {
    const st = sid ? this.sessionStates.get(sid) : undefined;
    return structuredClone(st ?? initialSessionState());
  }

  /** Whether any connected client is currently focused on a session. */
  private hasViewer(sid: SessionId): boolean {
    for (const conn of this.clients.values())
      if (conn.focusedId === sid) return true;
    return false;
  }

  private onEvent(ev: SessionDriverEvent): void {
    const sid = ev.sessionRef.sessionId;
    // Cross-session tracking is GLOBAL and runs for every event regardless of focus —
    // a background turn never folds into a transcript, but the running/attention
    // indicators must still update. LRU eviction (pi-driver) disposes a warm session
    // inside another client's swap and emits a synthetic sessionClosed for it; that
    // must clear the running set here regardless of who is focused where.
    const statusChanged = this.trackRunning(sid, ev);
    const attentionChanged = this.trackAttention(sid, ev);
    if (statusChanged || attentionChanged) this.broadcastSessionStatus();
    // Fold + route only for a session someone is viewing (or the landing default).
    // Background sessions nobody opened are tracked above, but their transcript stays
    // private — folded only once a client focuses them (switchTo seeds it then).
    const st = this.sessionStates.get(sid);
    if (st) {
      foldEvent(st, ev);
      for (const conn of this.clients.values())
        if (conn.focusedId === sid) conn.send({ type: "event", event: ev });
    }
    // A closed/evicted session drops its folded transcript once nobody is viewing it
    // (a current viewer keeps its last transcript rather than blanking mid-look). The
    // landing default is kept so a fresh connection still has something to adopt.
    if (
      ev.type === "sessionClosed" &&
      sid !== this.defaultFocusId &&
      !this.hasViewer(sid)
    )
      this.sessionStates.delete(sid);
    this.maybeNotify(ev);
  }

  /** Update the running set from one event and report whether it changed.
   *  Snapshot-bearing events carry an authoritative status; mid-turn events
   *  (deltas, tool/user/queued) imply a live turn; failure/close end it. */
  private trackRunning(sid: SessionId, ev: SessionDriverEvent): boolean {
    const before = this.running.has(sid);
    const beforeInit = this.initializing.has(sid);
    switch (ev.type) {
      case "sessionOpened":
      case "sessionUpdated":
      case "runCompleted":
        this.setRunning(sid, ev.snapshot.status === "running");
        // `initializing` is a snapshot-only phase: a session is in it iff its latest
        // snapshot says so. setRunning already cleared it for the running case.
        this.setInitializing(sid, ev.snapshot.status === "initializing");
        break;
      case "assistantDelta":
      case "toolStarted":
      case "toolUpdated":
      case "userMessage":
      case "queuedMessageStarted":
        // A live mid-turn event means it's running, not warming up.
        this.setRunning(sid, true);
        break;
      case "runFailed":
      case "sessionClosed":
        this.setRunning(sid, false);
        this.setInitializing(sid, false);
        break;
    }
    return (
      this.running.has(sid) !== before ||
      this.initializing.has(sid) !== beforeInit
    );
  }

  private attentionFor(sid: SessionId): SessionAttention | undefined {
    const record = this.attention.get(sid);
    if (!record) return undefined;
    const pending = [...record.pending.values()];
    if (pending.length > 0)
      return {
        sessionId: sid,
        phase: "waiting",
        activity: "Waiting on you",
        pendingCount: pending.length,
        pendingTitle: pending[0],
        updatedAt: record.updatedAt,
      };
    return {
      sessionId: sid,
      phase: record.phase,
      activity: record.activity,
      updatedAt: record.updatedAt,
    };
  }

  /** Update one session's compact attention summary. Returns true only when the wire
   * projection changed, so repeated deltas don't turn sessionStatus into a hot stream. */
  private trackAttention(sid: SessionId, ev: SessionDriverEvent): boolean {
    const before = JSON.stringify(this.attentionFor(sid));
    let record = this.attention.get(sid);
    const ensure = (): AttentionRecord => {
      if (!record) {
        record = {
          phase: "running",
          activity: "Working",
          updatedAt: ev.timestamp,
          pending: new Map(),
        };
        this.attention.set(sid, record);
      }
      return record;
    };
    const setBase = (
      phase: AttentionRecord["phase"],
      activity?: string,
    ): void => {
      const current = ensure();
      const changed = current.phase !== phase || current.activity !== activity;
      current.phase = phase;
      current.activity = activity;
      if (changed) current.updatedAt = ev.timestamp;
    };

    switch (ev.type) {
      case "sessionOpened":
      case "sessionUpdated":
        this.sessionTitles.set(sid, ev.snapshot.title);
        if (ev.snapshot.status === "running") setBase("running", "Working");
        else if (ev.snapshot.status === "initializing")
          setBase("running", "Starting session");
        else if (ev.snapshot.status === "failed")
          setBase("failed", "Run failed");
        // An idle sessionUpdated may be a transient isStreaming glitch. Only an
        // authoritative runCompleted changes attention to done.
        break;
      case "userMessage":
        setBase("running", "Starting");
        break;
      case "queuedMessageStarted":
        setBase("running", "Queued a follow-up");
        break;
      case "assistantDelta":
        setBase(
          "running",
          ev.channel === "thinking" ? "Thinking" : "Responding",
        );
        break;
      case "toolStarted":
        setBase("running", toolActivity(ev));
        break;
      case "toolFinished":
        if (record?.phase === "running") setBase("running", "Working");
        break;
      case "runCompleted":
        this.sessionTitles.set(sid, ev.snapshot.title);
        setBase("done", "Done");
        break;
      case "runFailed": {
        const failed = ensure();
        failed.pending.clear();
        setBase("failed", clipped(ev.error.message));
        break;
      }
      case "hostUiRequest":
        if (isDialogRequest(ev.request)) {
          const waiting = ensure();
          waiting.pending.set(ev.request.requestId, requestTitle(ev.request));
          waiting.updatedAt = ev.timestamp;
        } else if (
          ev.request.kind === "status" &&
          ev.request.text &&
          record?.phase === "running"
        ) {
          setBase("running", clipped(ev.request.text));
        } else if (ev.request.kind === "title") {
          this.sessionTitles.set(sid, ev.request.title);
        }
        break;
      case "hostUiResolved":
        if (record?.pending.delete(ev.requestId))
          record.updatedAt = ev.timestamp;
        break;
      case "sessionClosed":
        this.attention.delete(sid);
        this.sessionTitles.delete(sid);
        break;
    }

    return before !== JSON.stringify(this.attentionFor(sid));
  }

  // Running and initializing are mutually exclusive phases; turning one on clears the
  // other so a row never reports both.
  private setRunning(sid: SessionId, on: boolean): void {
    if (on) {
      this.running.add(sid);
      this.initializing.delete(sid);
    } else this.running.delete(sid);
  }

  private setInitializing(sid: SessionId, on: boolean): void {
    if (on) {
      this.initializing.add(sid);
      this.running.delete(sid);
    } else this.initializing.delete(sid);
  }

  private broadcastSessionStatus(): void {
    this.broadcast({
      type: "sessionStatus",
      runningIds: [...this.running],
      initializingIds: [...this.initializing],
      attention: [...this.attention.keys()].flatMap((sid) => {
        const item = this.attentionFor(sid);
        return item ? [item] : [];
      }),
    });
    // Attention-only changes also travel through this method. Reconcile the live-refresh
    // ticker every time; syncLiveRefresh is idempotent and keys only off running/client sets.
    this.syncLiveRefresh();
  }

  /** Start/stop the live-refresh ticker to track "something is running AND someone is
   *  watching". Idempotent — safe to call on every running-set / client-set change. */
  private syncLiveRefresh(): void {
    const want = this.running.size > 0 && this.clients.size > 0;
    if (want === (this.liveTimer !== null)) return;
    if (want) {
      this.liveTimer = setInterval(() => this.liveTick(), this.liveRefreshMs);
      // Don't keep the process alive just for the ticker.
      (this.liveTimer as { unref?: () => void }).unref?.();
    } else if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
      // The ticker stopped up to one interval before the turn actually ended; a final
      // list broadcast settles the last message count (usage settles via runCompleted).
      void this.broadcastSessionList();
    }
  }

  /** One live-refresh pass: a fresh session list for every client (running rows' counts
   *  / names / previews climb) + every running, viewed session's current context usage. */
  private liveTick(): void {
    void this.broadcastSessionList();
    this.refreshUsage();
  }

  /** Emit each running, currently-viewed session's context usage as a `usageUpdated`
   *  event (folded into its shared state + routed to its viewers). A dedicated event
   *  (not a full snapshot) so a mid-turn refresh touches only `usage`, never the
   *  streaming transcript / queued / config. Sessions nobody is viewing are skipped —
   *  there is no transcript to refresh. */
  private refreshUsage(): void {
    for (const [sid, st] of this.sessionStates) {
      if (!this.running.has(sid)) continue;
      const usage = this.driver.getUsage?.(sid);
      if (!usage) continue;
      const ev: SessionDriverEvent = {
        type: "usageUpdated",
        sessionRef: st.ref ?? { workspaceId: sid, sessionId: sid },
        timestamp: new Date().toISOString(),
        usage,
      };
      foldEvent(st, ev);
      for (const conn of this.clients.values())
        if (conn.focusedId === sid) conn.send({ type: "event", event: ev });
    }
  }

  // Mirror of the client's tab-open notify rules (App.svelte), but server-side and
  // only when no client is connected — a connected client buzzes itself when
  // unfocused, and a focused client needs no buzz at all, so focus is purely a
  // client-side concern (the server can't observe it anyway).
  private maybeNotify(ev: SessionDriverEvent): void {
    // Push only when someone has been here and then left — never on a cold replay
    // (no one to "return" to a backgrounded app that was never opened).
    if (!this.notify || this.clients.size > 0 || !this.everConnected) return;
    const sid = ev.sessionRef.sessionId;
    const session = this.sessionTitles.get(sid) ?? sid;
    const url = `/?session=${encodeURIComponent(sid)}`;
    if (ev.type === "runCompleted")
      this.notify({
        title: "pilot",
        body: `${session} finished its turn`,
        tag: `pilot-run-${sid}`,
        url,
      });
    else if (ev.type === "runFailed")
      this.notify({
        title: "pilot",
        body: `${session} failed: ${clipped(ev.error.message)}`,
        tag: `pilot-run-${sid}`,
        url,
      });
    else if (ev.type === "hostUiRequest") {
      const kind = ev.request.kind;
      if (
        kind === "confirm" ||
        kind === "select" ||
        kind === "input" ||
        kind === "editor" ||
        kind === "qna"
      ) {
        const r = ev.request as { title?: string };
        this.notify({
          title: "Approval needed",
          body: `${session}: ${r.title ?? "Waiting on you"}`,
          tag: `pilot-approval-${sid}`,
          url,
        });
      }
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const conn of this.clients.values()) {
      try {
        conn.send(msg);
      } catch (e) {
        console.error("[hub] send failed", e);
      }
    }
  }

  private acceptPrompt(
    send: Send,
    promptId: string | undefined,
    run: () => Promise<SessionId | undefined>,
  ): void {
    // Backward compatibility for an older client: dispatch, but there is no id to ACK
    // or deduplicate. Current clients always send promptId.
    if (!promptId) {
      void run().catch((e) =>
        send({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      return;
    }

    let result = this.promptResults.get(promptId);
    if (!result) {
      result = run()
        .then(
          (sessionId): Extract<ServerMessage, { type: "promptResult" }> => ({
            type: "promptResult",
            promptId,
            accepted: true,
            sessionId,
          }),
        )
        .catch(
          (e): Extract<ServerMessage, { type: "promptResult" }> => ({
            type: "promptResult",
            promptId,
            accepted: false,
            sessionId:
              e && typeof e === "object" && "sessionId" in e
                ? (e.sessionId as SessionId | undefined)
                : undefined,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      this.promptResults.set(promptId, result);
      if (this.promptResults.size > SessionHub.PROMPT_RESULT_CAP) {
        const oldest = this.promptResults.keys().next().value;
        if (oldest) this.promptResults.delete(oldest);
      }
    }
    void result.then(send);
  }

  /** Fetch + broadcast the models available to switch to (driver-authoritative). */
  private async broadcastModelList(): Promise<void> {
    try {
      const models = await this.driver.listModels();
      this.broadcast({ type: "modelList", models });
    } catch (e) {
      console.error("[hub] listModels failed", e);
    }
  }

  /** Fetch + send ONE client its focused session's slash commands (for the composer
   *  typeahead). Per-connection because the set is cwd-scoped and focus is per-client;
   *  re-sent on that client's connect + session switch. */
  private async sendCommandList(conn: ClientConn): Promise<void> {
    try {
      const commands = await this.driver.listCommands(
        conn.focusedId ?? undefined,
      );
      conn.send({ type: "commandList", commands });
    } catch (e) {
      console.error("[hub] listCommands failed", e);
    }
  }

  /** Fetch + send ONE client its focused session's extension list (Settings "Extensions"
   *  view). Per-connection (scoped to the requester's focus, like the command/tree lists);
   *  re-sent after that client toggles an extension. No-op if the driver can't list them. */
  private async sendExtensionList(conn: ClientConn): Promise<void> {
    if (!this.driver.listExtensions) return;
    try {
      const extensions = await this.driver.listExtensions(
        conn.focusedId ?? undefined,
      );
      conn.send({
        type: "extensionList",
        sessionId: conn.focusedId,
        extensions,
      });
    } catch (e) {
      console.error("[hub] listExtensions failed", e);
    }
  }

  /** Persist an extension enable/disable for the requester's focused session, then re-send
   *  that client the refreshed list so the row reflects the new state (applies next start). */
  private async applyExtensionEnabled(
    conn: ClientConn,
    resolvedPath: string,
    enabled: boolean,
  ): Promise<void> {
    try {
      await this.driver.setExtensionEnabled?.(
        resolvedPath,
        enabled,
        conn.focusedId ?? undefined,
      );
    } catch (e) {
      console.error("[hub] setExtensionEnabled failed", e);
    }
    void this.sendExtensionList(conn);
  }

  /** Fetch + send ONE client the full @-mention file index for its focused session's cwd.
   *  Pushed on that client's connect + session switch (like {@link sendCommandList}); the
   *  client fuzzy-matches it locally so the menu is instant. `truncated` tells the client
   *  whether to fall back to a per-query `fd` search ({@link sendFileList}). */
  private async sendFileIndex(conn: ClientConn): Promise<void> {
    try {
      const { files, truncated } = await this.driver.listFileIndex(
        conn.focusedId ?? undefined,
      );
      conn.send({ type: "fileIndex", files, truncated });
    } catch (e) {
      console.error("[hub] listFileIndex failed", e);
    }
  }

  /** Fetch + send ONE client files matching its composer @-mention query — the fallback
   *  path, used only when the index was truncated and local matches are thin. The server
   *  runs `fd` and echoes the query so the client can ignore stale responses. Searches the
   *  requesting client's focused session's cwd. */
  private async sendFileList(
    conn: ClientConn,
    query: string,
    cwd?: string,
  ): Promise<void> {
    try {
      const files = await this.driver.listFiles(
        query,
        conn.focusedId ?? undefined,
        cwd,
      );
      conn.send({ type: "fileList", query, files });
    } catch (e) {
      console.error("[hub] listFiles failed", e);
    }
  }

  /** Fetch + send ONE client a directory listing for the new-session project picker. Not
   *  focus-scoped (a new session has no cwd yet) — it browses absolute server paths the
   *  client navigates to. `path` empty -> the server's $HOME. See {@link DirListing}. */
  private async sendDirListing(
    conn: ClientConn,
    path: string | undefined,
  ): Promise<void> {
    try {
      const listing = await this.driver.listDir(path);
      conn.send({ type: "dirListing", ...listing });
    } catch (e) {
      console.error("[hub] listDir failed", e);
    }
  }

  /** Quick existence + type check for a path the client typed into the new-session dir
   *  picker. Not focus-scoped (the draft has no session yet) — it stats absolute paths
   *  on the server. The client calls this debounced for inline validation. */
  private async sendPathStat(conn: ClientConn, path: string): Promise<void> {
    try {
      const stat = await this.driver.statPath(path);
      conn.send({ type: "pathStat", ...stat });
    } catch (e) {
      console.error("[hub] statPath failed", e);
    }
  }

  /** Fetch + send ONE client its focused session's branch tree (pi's /tree) for the tree
   *  view. Per-connection (scoped to the requester's focus, like the command/file lists),
   *  so a client opening the tree view sees ITS session, not whatever another client is on.
   *  No-op if the driver can't read a tree. */
  private async sendTree(conn: ClientConn): Promise<void> {
    if (!this.driver.getTree) return;
    try {
      const tree = await this.driver.getTree(conn.focusedId ?? undefined);
      if (!tree) return;
      conn.send({
        type: "treeState",
        sessionId: conn.focusedId,
        nodes: tree.nodes,
        leafId: tree.leafId,
      });
    } catch (e) {
      console.error("[hub] getTree failed", e);
    }
  }

  /** Re-send the branch tree to every client viewing `sid` after a branch moved its leaf
   *  (or added an abandoned-branch summary), so an open tree view refreshes. The branch
   *  mutated the shared session, so all its viewers — not just the brancher — must update. */
  private async refreshTreeForViewers(sid: SessionId): Promise<void> {
    if (!this.driver.getTree) return;
    try {
      const tree = await this.driver.getTree(sid);
      if (!tree) return;
      for (const conn of this.clients.values())
        if (conn.focusedId === sid)
          conn.send({
            type: "treeState",
            sessionId: sid,
            nodes: tree.nodes,
            leafId: tree.leafId,
          });
    } catch (e) {
      console.error("[hub] getTree failed", e);
    }
  }

  /** Fetch + broadcast the manageable providers (Settings panel). No-op if the driver
   *  doesn't support credential management. */
  private async broadcastProviderList(): Promise<void> {
    if (!this.driver.listProviders) return;
    try {
      const providers = await this.driver.listProviders();
      this.broadcast({ type: "providerList", providers });
    } catch (e) {
      console.error("[hub] listProviders failed", e);
    }
  }

  /** Fetch + broadcast pi's global model defaults + favorites (Settings panel). */
  private async broadcastModelDefaults(): Promise<void> {
    if (!this.driver.getModelDefaults) return;
    try {
      const defaults = await this.driver.getModelDefaults();
      this.broadcast({ type: "modelDefaults", defaults });
    } catch (e) {
      console.error("[hub] getModelDefaults failed", e);
    }
  }

  /** Save/remove a provider key, then refresh the provider + model lists (a key change
   *  shifts model availability and which favorites resolve). Errors go to the requester
   *  via the `error` channel — surfaced in the panel, not swallowed. */
  private async applyProviderKey(
    send: Send,
    action: () => Promise<void> | undefined,
  ): Promise<void> {
    try {
      await action();
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    await this.broadcastProviderList();
    await this.broadcastModelList();
    await this.broadcastModelDefaults();
  }

  /** Run an interactive OAuth login end to end: hand the driver an IO that broadcasts
   *  each prompt + awaits the answer, report the terminal result, then refresh the
   *  provider/model lists (a fresh sign-in shifts model availability). Single-flight —
   *  a second login while one is pending is refused, so the pending map stays unambiguous. */
  private async runOAuthLogin(send: Send, providerId: string): Promise<void> {
    if (!this.driver.oauthLogin) {
      send({ type: "error", message: "this driver can't do OAuth login" });
      return;
    }
    if (this.oauthInFlight) {
      send({
        type: "error",
        message:
          "an OAuth login is already in progress — finish or cancel it first",
      });
      return;
    }
    this.oauthInFlight = true;
    const io: OAuthLoginIO = {
      prompt: (prompt) => {
        const requestId = `oauth-${this.serverId}-${++this.oauthSeq}`;
        return new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            if (this.oauthPending.delete(requestId)) {
              this.broadcast({ type: "oauthResolved", requestId });
              resolve(null); // timed out — the driver treats null as a cancel
            }
          }, OAUTH_PROMPT_TIMEOUT_MS);
          (timer as { unref?: () => void }).unref?.();
          this.oauthPending.set(requestId, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          this.broadcast({
            type: "oauthPrompt",
            requestId,
            providerId,
            prompt,
          });
        });
      },
      progress: (message) =>
        this.broadcast({ type: "oauthProgress", providerId, message }),
      deviceCode: (info) =>
        this.broadcast({ type: "oauthDeviceCode", providerId, ...info }),
    };
    try {
      await this.driver.oauthLogin(providerId, io);
      this.broadcast({ type: "oauthResult", providerId, ok: true });
    } catch (e) {
      this.broadcast({
        type: "oauthResult",
        providerId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.oauthInFlight = false;
      // Resolve (null) + dismiss any prompt still pending — a thrown/aborted login
      // shouldn't leave a dangling dialog on clients or a leaked resolver here.
      for (const [requestId, resolve] of this.oauthPending) {
        this.broadcast({ type: "oauthResolved", requestId });
        resolve(null);
      }
      this.oauthPending.clear();
    }
    await this.broadcastProviderList();
    await this.broadcastModelList();
    await this.broadcastModelDefaults();
  }

  /** Apply a defaults/favorites mutation, then re-broadcast the defaults so every
   *  client (and the header picker's favorites filter) updates. */
  private async applyModelDefaults(
    action: () => Promise<void> | undefined,
  ): Promise<void> {
    try {
      await action();
    } catch (e) {
      console.error("[hub] model-defaults mutation failed", e);
    }
    await this.broadcastModelDefaults();
  }

  /** Archive/unarchive a session, then re-broadcast the list so every client's
   *  active-only filter reflects it. Errors (e.g. an unwritable index) go back to the
   *  requester via the `error` channel — surfaced, not swallowed. */
  private async applyArchive(
    send: Send,
    path: string,
    archived: boolean,
  ): Promise<void> {
    try {
      await this.driver.setArchived?.(path, archived);
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    await this.broadcastSessionList();
  }

  /** Rename a session, then re-broadcast the list so every client's sidebar reflects
   *  the new name. A warm session also emits a `sessionUpdated` (via the driver) so its
   *  header title updates live. Empty names are dropped here — clearing a name isn't a
   *  rename. Errors go back to the requester via the `error` channel. */
  private async applyRename(
    send: Send,
    path: string,
    name: string,
  ): Promise<void> {
    if (!name.trim()) return;
    try {
      await this.driver.renameSession?.(path, name.trim());
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    await this.broadcastSessionList();
  }

  /** Remove a pilot-created worktree on request (the sidebar's clean-up action). Surfaces
   *  a refusal (dirty worktree without force) as an error so the client can offer force;
   *  re-broadcasts the list either way so the indicator clears when it's gone. */
  private async applyWorktreeCleanup(
    send: Send,
    path: string,
    force?: boolean,
  ): Promise<void> {
    if (!this.driver.cleanupWorktree) {
      send({ type: "error", message: "this driver can't clean up worktrees" });
      return;
    }
    try {
      const res = await this.driver.cleanupWorktree(path, { force });
      if (!res.removed)
        send({
          type: "error",
          message: `worktree not removed: ${res.reason ?? "unknown reason"}`,
        });
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    await this.broadcastSessionList();
  }

  /** Re-scan available sessions and send the list to every client. The list CONTENT is
   *  shared (one disk scan), but `activeSessionId` is per-connection — each client
   *  highlights its OWN focused row, so one client switching never moves another's
   *  highlight. */
  private async broadcastSessionList(): Promise<void> {
    try {
      const sessions = await this.driver.listSessions();
      const defaultNewSessionCwd = homedir();
      for (const conn of this.clients.values())
        conn.send({
          type: "sessionList",
          sessions,
          activeSessionId: conn.focusedId,
          defaultNewSessionCwd,
        });
    } catch (e) {
      console.error("[hub] listSessions failed", e);
    }
  }

  /**
   * Switch ONE client's focus to the session a driver swap resolves to. The swap warms +
   * seeds the target; we fold that seed into the target's shared state (unless it's
   * already live — see below), point this connection at it, and re-snapshot. Other
   * clients are untouched: focus is per-connection. Single-flight per connection (a swap
   * can block for seconds warming pi, or minutes on a trust card): a second request
   * arriving mid-swap is coalesced (queued, latest wins) and run when this one finishes,
   * not rejected — so an operator clicking a session during the fresh-start boot-restore
   * warm lands on it instead of getting a spurious error. The session LIST re-broadcasts
   * to all (its content may have changed, e.g. a new session) but each keeps its own
   * activeSessionId; commands are cwd-scoped, so only the switcher gets them.
   *
   * `reseed` (branch): rebuild the state even if the session is already live and
   * re-snapshot EVERY viewer — navigateTree mutated the shared session, so the new
   * branch transcript is authoritative for everyone looking at it. Without it, opening
   * an already-viewed session reuses the live state (which may hold an in-flight
   * streaming bubble the seed's committed-history view would drop).
   */
  private async switchTo(
    conn: ClientConn,
    swap: () => Promise<SessionDriverEvent[]>,
    opts: { reseed?: boolean } = {},
  ): Promise<SessionId | null> {
    if (conn.switchInFlight) {
      // A swap is mid-flight on this connection. Queue this one (depth 1, latest wins)
      // and run it from the in-flight swap's `finally`; hand the caller a promise that
      // settles with the eventual session id. A previously-queued request is superseded
      // — resolve it null so any awaiter (e.g. newSession) unblocks.
      conn.pendingSwitch?.resolve(null);
      return new Promise<SessionId | null>((resolve) => {
        conn.pendingSwitch = { swap, opts, resolve };
      });
    }
    conn.switchInFlight = true;
    try {
      let seed: SessionDriverEvent[];
      try {
        seed = await swap();
      } catch (e) {
        conn.send({ type: "error", message: `session switch failed: ${e}` });
        return null;
      }
      // Fold into a fresh state to learn the authoritative session id — the seed's
      // sessionOpened snapshot ref, which is what the focus + list highlight key off.
      const built = initialSessionState();
      let metaChanged = false;
      for (const e of seed) {
        foldEvent(built, e);
        metaChanged =
          this.trackRunning(e.sessionRef.sessionId, e) || metaChanged;
        metaChanged =
          this.trackAttention(e.sessionRef.sessionId, e) || metaChanged;
      }
      const sid = built.ref?.sessionId ?? seed[0]?.sessionRef.sessionId ?? null;
      if (!sid) {
        conn.send({
          type: "error",
          message: "session switch returned no session",
        });
        return null;
      }
      // (Re)build the shared state from this authoritative seed when the session isn't
      // already live, or always on a branch reseed. If another client is already viewing
      // it, its shared state is current (and may hold an in-flight streaming bubble the
      // seed's committed-history view would drop) — reuse it rather than clobber.
      if (opts.reseed || !this.sessionStates.has(sid)) {
        this.sessionStates.set(sid, built);
        if (metaChanged) this.broadcastSessionStatus();
      }
      // A newer switch queued up while this one was warming (the boot-restore-vs-click
      // race). Don't move focus or push this now-superseded snapshot — the queued switch,
      // dispatched from `finally`, sends the authoritative view. The warm session is still
      // cached above, and skipping the send avoids a flash of the transcript being left.
      if (conn.pendingSwitch) return sid;
      conn.focusedId = sid;
      // On a reseed (branch) the shared transcript changed for everyone viewing it; else
      // only the requester moved its focus.
      if (opts.reseed)
        for (const viewer of this.clients.values()) {
          if (viewer.focusedId === sid)
            viewer.send({ type: "snapshot", state: this.snapshotOf(sid) });
        }
      else conn.send({ type: "snapshot", state: this.snapshotOf(sid) });
      await this.broadcastSessionList();
      await this.sendCommandList(conn);
      void this.sendFileIndex(conn);
      return sid;
    } finally {
      conn.switchInFlight = false;
      // Run whatever queued up while we were busy. Runs on every exit path (success,
      // swap failure, no-session) so a coalesced request is never stranded. switchInFlight
      // was just cleared, so the recursive call starts its swap immediately; its outcome
      // settles the promise the queued caller is awaiting.
      const next = conn.pendingSwitch;
      if (next) {
        conn.pendingSwitch = null;
        void this.switchTo(conn, next.swap, next.opts).then(next.resolve);
      }
    }
  }

  /** Register a client. Synchronously sends hello + a snapshot of the session this
   *  connection focuses (the landing default; a brand-new pi client has none and lands
   *  empty, then restores its own last-focused session). Focus is per-connection. */
  addClient(send: Send): () => void {
    const conn: ClientConn = {
      send,
      focusedId: this.defaultFocusId,
      switchInFlight: false,
      pendingSwitch: null,
    };
    this.clients.set(send, conn);
    this.everConnected = true;
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverId: this.serverId,
    });
    send({ type: "snapshot", state: this.snapshotOf(conn.focusedId) });
    // Tell the fresh client what's already running / warming up (in-memory, synchronous).
    send({
      type: "sessionStatus",
      runningIds: [...this.running],
      initializingIds: [...this.initializing],
      attention: [...this.attention.keys()].flatMap((sid) => {
        const item = this.attentionFor(sid);
        return item ? [item] : [];
      }),
    });
    // Current desktop-update state, so a connecting client immediately shows (or hides)
    // the sidebar update card without waiting for the watcher's next poll.
    send({
      type: "updateStatus",
      available: this.updateSha !== null,
      sha: this.updateSha ?? undefined,
      applying: this.applying,
    });
    // Fire the session + model + provider lists asynchronously (driver disk/registry
    // reads); they arrive as follow-up messages, keeping hello+snapshot synchronous +
    // first.
    void this.broadcastSessionList();
    void this.broadcastModelList();
    void this.sendCommandList(conn);
    void this.sendFileIndex(conn);
    void this.broadcastProviderList();
    void this.broadcastModelDefaults();
    // A client arriving while a turn is already running starts the ticker (and one
    // leaving the last viewer stops it).
    this.syncLiveRefresh();
    return () => {
      // Settle any switch queued behind an in-flight one so a caller awaiting it (e.g. a
      // newSession that got coalesced) doesn't hang on a now-dead connection.
      conn.pendingSwitch?.resolve(null);
      conn.pendingSwitch = null;
      this.clients.delete(send);
      this.syncLiveRefresh();
    };
  }

  handleClient(send: Send, msg: ClientMessage): void {
    // Resolve the connection so session-scoped commands fall back to ITS focus, not a
    // global one. A transient stand-in (focus = the landing default) covers tests that
    // drive handleClient without addClient — none of those switch focus.
    const conn = this.clients.get(send) ?? {
      send,
      focusedId: this.defaultFocusId,
      switchInFlight: false,
      pendingSwitch: null,
    };
    switch (msg.type) {
      case "hello":
      case "ping":
        return;
      case "prompt":
        this.acceptPrompt(send, msg.promptId, async () => {
          const sessionId = msg.sessionId ?? conn.focusedId ?? undefined;
          await this.driver.prompt(
            msg.text,
            msg.deliverAs,
            sessionId,
            msg.images,
            msg.promptId,
          );
          return sessionId;
        });
        return;
      case "abort":
        this.driver.abort(msg.sessionId ?? conn.focusedId ?? undefined);
        return;
      case "restoreQueue": {
        if (!this.driver.clearQueue) {
          send({
            type: "error",
            message: "queue restore isn't supported here",
          });
          return;
        }
        const restored = this.driver.clearQueue(
          msg.sessionId ?? conn.focusedId ?? undefined,
        );
        send({ type: "queueRestored", ...restored });
        return;
      }
      case "respondUi": {
        // First-responder-wins: only the first answer for a still-pending dialog
        // reaches the driver. A second device (or co-viewer of the same session)
        // answering the same id is dropped, so the real pi session never gets a double
        // resolution. The dialog lives in the targeted session's shared state.
        const sid = msg.sessionId ?? conn.focusedId ?? undefined;
        const st = sid ? this.sessionStates.get(sid) : undefined;
        const id = msg.response.requestId;
        if (!st?.pendingApprovals.some((p) => p.requestId === id)) return;
        this.driver.respondUi(msg.response, sid);
        return;
      }
      case "setModel":
        this.driver.setModel(
          msg.provider,
          msg.modelId,
          msg.sessionId ?? conn.focusedId ?? undefined,
        );
        return;
      case "setThinking":
        this.driver.setThinking(
          msg.level,
          msg.sessionId ?? conn.focusedId ?? undefined,
        );
        return;
      case "openSession":
        void this.switchTo(conn, () => this.driver.openSession(msg.path));
        return;
      case "branch": {
        if (!this.driver.branchFrom) {
          send({ type: "error", message: "branching isn't supported here" });
          return;
        }
        const targetId = msg.sessionId ?? conn.focusedId ?? undefined;
        // A navigate mid-turn would interleave the in-flight run into the new branch.
        // Gate on the target session's status — the transcript this client is branching.
        const targetState = targetId
          ? this.sessionStates.get(targetId)
          : undefined;
        if (
          targetState?.status === "running" ||
          targetState?.status === "initializing"
        ) {
          send({
            type: "error",
            message: "Can't branch while a turn is running — stop it first.",
          });
          return;
        }
        // navigateTree mutates the shared session's leaf, so reseed re-snapshots every
        // viewer of it. The editorText (a user-prompt branch's re-editable text) is
        // per-client, so it goes ONLY to the requester after the swap lands.
        let prefill: string | undefined;
        void this.switchTo(
          conn,
          async () => {
            const r = await this.driver.branchFrom!(
              msg.entryId,
              { summarize: msg.summarize },
              targetId,
            );
            prefill = r.editorText;
            return r.seed;
          },
          { reseed: true },
        ).then((sid) => {
          if (sid && prefill) send({ type: "editorPrefill", text: prefill });
          // The leaf moved (and an abandoned-branch summary may have appeared), so
          // refresh any open tree view on every client viewing this session.
          if (sid) void this.refreshTreeForViewers(sid);
        });
        return;
      }
      case "newSession": {
        // Deferred creation: the draft lives client-side until the user sends, so this
        // message creates the session AND carries its first prompt. Deliver the prompt
        // only after the switch lands (focusedId now points at the new session) — doing
        // it inside the driver's newSession would race the hub's atomic state reset.
        const firstPrompt = msg.prompt?.trim() ?? "";
        const firstImages = msg.images;
        const hasFirstPrompt =
          firstPrompt.length > 0 || (firstImages?.length ?? 0) > 0;
        const createAndPrompt = async (): Promise<SessionId | undefined> => {
          const sid = await this.switchTo(conn, () =>
            this.driver.newSession({
              cwd: msg.cwd,
              worktree: msg.worktree,
              model: msg.model,
              thinking: msg.thinking,
            }),
          );
          if (!sid) throw new Error("Could not create the new session");
          const sessionId = sid;
          if (hasFirstPrompt) {
            try {
              await this.driver.prompt(
                firstPrompt,
                undefined,
                sessionId,
                firstImages,
                msg.promptId,
              );
            } catch (e) {
              const error = e instanceof Error ? e : new Error(String(e));
              Object.assign(error, { sessionId });
              throw error;
            }
          }
          return sessionId;
        };
        if (hasFirstPrompt) {
          this.acceptPrompt(send, msg.promptId, createAndPrompt);
        } else {
          void createAndPrompt().catch((e) => {
            send({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            });
          });
        }
        return;
      }
      case "listSessions":
        void this.broadcastSessionList();
        return;
      case "setArchived":
        void this.applyArchive(send, msg.path, msg.archived);
        return;
      case "renameSession":
        void this.applyRename(send, msg.path, msg.name);
        return;
      case "cleanupWorktree":
        void this.applyWorktreeCleanup(send, msg.path, msg.force);
        return;
      case "listCommands":
        void this.sendCommandList(conn);
        return;
      case "queryTree":
        void this.sendTree(conn);
        return;
      case "queryExtensions":
        void this.sendExtensionList(conn);
        return;
      case "setExtensionEnabled":
        void this.applyExtensionEnabled(conn, msg.resolvedPath, msg.enabled);
        return;
      case "queryFiles":
        void this.sendFileList(conn, msg.query, msg.cwd);
        return;
      case "queryDir":
        void this.sendDirListing(conn, msg.path);
        return;
      case "statPath":
        void this.sendPathStat(conn, msg.path);
        return;
      case "listProviders":
        void this.broadcastProviderList();
        void this.broadcastModelDefaults();
        return;
      case "setProviderApiKey":
        void this.applyProviderKey(send, () =>
          this.driver.setProviderApiKey?.(msg.providerId, msg.apiKey),
        );
        return;
      case "removeProviderApiKey":
        void this.applyProviderKey(send, () =>
          this.driver.removeProviderApiKey?.(msg.providerId),
        );
        return;
      case "oauthLogin":
        void this.runOAuthLogin(send, msg.providerId);
        return;
      case "oauthRespond": {
        // First-responder-wins: only the first answer for a still-pending prompt
        // reaches the driver; a second device answering the same id no-ops.
        const resolve = this.oauthPending.get(msg.requestId);
        if (!resolve) return;
        this.oauthPending.delete(msg.requestId);
        this.broadcast({ type: "oauthResolved", requestId: msg.requestId });
        resolve(msg.value);
        return;
      }
      case "oauthLogout":
        void this.applyProviderKey(send, () =>
          this.driver.oauthLogout?.(msg.providerId),
        );
        return;
      case "setDefaultModel":
        void this.applyModelDefaults(() =>
          this.driver.setDefaultModel?.(msg.provider, msg.modelId),
        );
        return;
      case "setDefaultThinking":
        void this.applyModelDefaults(() =>
          this.driver.setDefaultThinking?.(msg.level),
        );
        return;
      case "setFavoriteModels":
        void this.applyModelDefaults(() =>
          this.driver.setFavoriteModels?.(msg.refs),
        );
        return;
      case "trustResponse":
        // The driver dedups (first answer settles it); a stale/duplicate id no-ops.
        this.driver.respondTrust?.(msg.requestId, msg.choice);
        return;
      case "applyUpdate":
        // User clicked "update now". Flag it (the watcher reads it back on its next
        // /update/state poll and applies) and reflect "applying" in the card. No-op if
        // nothing is staged or an apply is already in flight.
        if (this.updateSha !== null && !this.applying) {
          this.applying = true;
          this.broadcastUpdateStatus();
        }
        return;
      case "mock":
        this.driver.runScript?.(msg.script);
        return;
      default:
        send({
          type: "error",
          message: `unknown message: ${(msg as { type: string }).type}`,
        });
    }
  }

  /** Dev/test-only: clear all session state, optionally re-seed the mock's landing
   *  fixture, and re-point + re-snapshot every connected client. `bootstrap:false`
   *  exposes the production empty landing. */
  reset(opts: { bootstrap?: boolean } = {}): void {
    this.sessionStates.clear();
    this.defaultFocusId = null;
    this.running.clear();
    this.initializing.clear();
    this.attention.clear();
    this.sessionTitles.clear();
    this.updateSha = null;
    this.applying = false;
    this.driver.reset?.(opts);
    this.seedDefault();
    for (const conn of this.clients.values()) {
      conn.focusedId = this.defaultFocusId;
      conn.switchInFlight = false;
      conn.pendingSwitch?.resolve(null);
      conn.pendingSwitch = null;
      conn.send({ type: "snapshot", state: this.snapshotOf(conn.focusedId) });
    }
    this.broadcastSessionStatus();
    void this.broadcastSessionList();
    for (const conn of this.clients.values()) {
      void this.sendCommandList(conn);
      void this.sendFileIndex(conn);
    }
  }

  /** A JSON-safe deep copy of the landing session's folded state (foldEvent mutates in
   *  place). Per-client focus means there's no single global view; this reports the
   *  landing default — what a fresh client sees, and what /debug/state surfaces. */
  snapshot(): SessionState {
    return this.snapshotOf(this.defaultFocusId);
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Host activity, surfaced on /health so an external poller (the desktop
   *  update-watcher, scripts/desktop/update-watcher.ts) can tell whether it may
   *  auto-apply an update or must defer to avoid interrupting a turn. `busy` is the
   *  only thing the watcher reads; the breakdown is there for eyeballing /health.
   *  `/debug/state` can't answer this — it only carries the *focused* session, so a
   *  background session running a turn would be invisible to it. */
  activity(): { running: number; initializing: number; busy: boolean } {
    return {
      running: this.running.size,
      initializing: this.initializing.size,
      busy: this.running.size + this.initializing.size > 0,
    };
  }

  /** Watcher → server: report the staged-update commit (or null when up to date), and
   *  optionally that an attempted apply failed (resets a stuck "applying" so the card
   *  offers retry). Broadcasts updateStatus on change. Returns `applying` so the watcher
   *  learns on this same poll whether the user clicked "update now". */
  reportUpdate(sha: string | null, applyFailed = false): { applying: boolean } {
    let changed = false;
    if (sha !== this.updateSha) {
      this.updateSha = sha;
      if (sha === null) this.applying = false; // applied/gone — drop any apply flag
      changed = true;
    }
    if (applyFailed && this.applying) {
      this.applying = false;
      changed = true;
    }
    if (changed) this.broadcastUpdateStatus();
    return { applying: this.applying };
  }

  private broadcastUpdateStatus(): void {
    this.broadcast({
      type: "updateStatus",
      available: this.updateSha !== null,
      sha: this.updateSha ?? undefined,
      applying: this.applying,
    });
  }
}
