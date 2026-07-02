// The session hub: holds the authoritative folded SessionState, folds every
// driver event into it, and fans events out to all connected WS clients. New
// clients get hello + a full snapshot so they catch up without replaying history.

import { homedir } from "node:os";
import {
  type ClientMessage,
  foldEvent,
  initialSessionState,
  isDialogRequest,
  type ModelOption,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionAttention,
  type SessionDriverEvent,
  type SessionId,
  type SessionState,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";
import {
  appendEvent,
  buildSeed,
  bumpEpoch,
  createJournal,
  metaSeedEvents,
  type SessionJournal,
} from "./journal.js";
import { getLoginEnvStatus, resolveLoginShell } from "./shared/login-env.js";
import { resolveBackgroundModel } from "./shared/background-model.js";
import { readPilotSettings, writePilotSettings } from "./settings-store.js";

export type Send = (msg: ServerMessage) => void;

/** The production opener: spawn the platform file manager on a directory (Finder on
 *  macOS, Explorer on Windows, xdg-open elsewhere). Fire-and-forget — a non-zero exit
 *  (e.g. no xdg-open installed on a headless host) surfaces nowhere, which is the
 *  designed graceful degrade. Extracted so `openDataDir` can take it as a seam:
 *  mock mode (e2e/dev) injects a no-op so automated UI never opens real GUI windows. */
export function defaultOpenInFileManager(dir: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", dir]
      : process.platform === "win32"
        ? ["explorer", dir]
        : ["xdg-open", dir];
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  void child.exited.catch(() => {});
}

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

/** Classify a raw session-switch error into a friendly, operator-facing message.
 *  Returns { kind: "session-switch" } so the client renders it as a dismissible
 *  toast rather than the alarming generic error banner — these are known, common
 *  failures (the daemon didn't start, the port didn't bind, a lease conflict),
 *  not unexpected crashes. Unrecognized errors return kind: undefined so they
 *  keep the generic banner (don't silently swallow the unknown). */
function classifySwitchError(raw: unknown): {
  message: string;
  kind?: "session-switch";
} {
  const text = raw instanceof Error ? raw.message : String(raw);
  // Daemon failed to start (startup.json state:"failed") — the message already
  // names the config/parse error; surface it plainly without the stack-ish prefix.
  const failedMatch = text.match(
    /polytoken daemon failed to start:\s*(.+?)(?:\n|$)/,
  );
  if (failedMatch) {
    return {
      message: `Couldn't open this session — the daemon failed to start (${(failedMatch[1] ?? "").trim()}). Try again, or open it in the TUI to diagnose.`,
      kind: "session-switch",
    };
  }
  // Daemon didn't bind its port in time (spawn or health timeout).
  if (/did not become (ready|healthy) within/.test(text)) {
    return {
      message:
        "Couldn't open this session — the daemon took too long to start. Try again.",
      kind: "session-switch",
    };
  }
  // Lease conflict (409) — claimLease already formatted a readable message naming
  // the holder. Surface it; the operator needs to /detach in the TUI or wait.
  if (/another TUI is attached|lease claim failed \(409\)/.test(text)) {
    return {
      message: text.includes("another TUI is attached")
        ? text
        : "This session is open in the TUI. Detach it there (/detach) or wait ~30s for its lease to lapse.",
      kind: "session-switch",
    };
  }
  // Connection refused / timed out reaching the daemon (port not bound, wedged).
  if (
    /lease claim failed \(0\)|request timed out|fetch failed|ECONNREFUSED/.test(
      text,
    )
  ) {
    return {
      message:
        "Couldn't reach the session daemon. Try again — if it persists, the daemon may be wedged.",
      kind: "session-switch",
    };
  }
  // Could not resolve session id from path — a client-side path issue.
  if (/could not resolve session id from path/.test(text)) {
    return {
      message: "Couldn't open this session — its path wasn't recognized.",
      kind: "session-switch",
    };
  }
  // Fallback: unknown error → keep the generic banner, don't prettify blindly.
  return { message: `session switch failed: ${text}` };
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
  // Single-flight per connection: a swap can block (warming the session, or a trust card awaiting
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
  // The per-session event journal (protocol v2): the seed source + resume ring.
  // Lifecycle mirrors `sessionStates` 1:1 — created wherever a state is seeded,
  // deleted wherever the state is dropped. Until the wire flips to seeds, the
  // journal runs dark alongside the legacy fold (the property tests assert
  // foldAll(seed) ≡ the folded state at every step).
  private journals = new Map<SessionId, SessionJournal>();
  // Epoch source for journals. ms-seeded + monotonically bumped so an epoch is
  // unique per hub process: journals are in-memory, so a client resume token
  // minted against a previous process must never falsely match a fresh journal
  // (a restart must read as an epoch bump everywhere).
  private epochCounter = Date.now();
  // The landing session a freshly-connecting client with no focus of its own adopts:
  // the mock's bootstrap greeting, or null for the daemon's empty startup landing. Established
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
  // — the mock's bootstrap greeting, or the polytoken driver's on-load session replay
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
  // Whether the session LIST content may have changed since the last list broadcast.
  // The live-tick calls listSessions (a disk scan) ONLY when this is set, so a long
  // streaming turn doesn't re-scan disk every second when nothing the sidebar shows
  // has changed (assistantDelta/toolStarted/toolUpdated don't change list content —
  // userMessageCount/preview/updatedAt move only at turn boundaries). Set by onEvent
  // for the few events that CAN change list content; explicit list re-broadcasts
  // (open/new/branch/archive) bypass the gate by calling broadcastSessionList directly.
  // Starts true so the very first tick after a turn starts still refreshes.
  private sessionListDirty = true;
  // Desktop auto-update (driven by scripts/desktop/update-watcher.ts via /update/state).
  // `updateSha` is the origin/main commit the watcher staged but deferred because a client
  // is connected; null = up to date. `applying` flips true when a client clicks the
  // sidebar card's "update now" — the watcher reads it back on its next poll and applies.
  private updateSha: string | null = null;
  private applying = false;
  // True when the running Pilot.app's native shell differs from the clone's checked-out
  // `HEAD:desktop` — the binary no longer matches its source and needs a manual build-app.sh
  // rebuild (the TS auto-update path can't replace the .app). Set by the watcher on every
  // /update/state report and broadcast in `updateStatus`; drives the durable sidebar rebuild
  // dot. Independent of `updateSha` (a stale binary is orthogonal to a staged TS commit).
  private desktopStale = false;
  // Set by a `forceUpdate` message (the build-stamp menu, for clicking right after a push).
  // The watcher consumes it on its next /update/state poll and does an immediate fetch +
  // apply, bypassing the ~60s fetch cadence and the defer-while-connected policy. Read-once:
  // reportUpdate hands it to that one caller and clears it (the apply's restart wipes hub
  // state anyway; a failed apply un-flags via applyFailed).
  private forceRequested = false;
  // Cached view of the available models (the `ModelOption[]` the driver returns via
  // listModels), so `pilotSettingsMsg()` can resolve the background-model spec's
  // `warning` SYNCHRONOUSLY without an async driver call on every settings broadcast.
  // Refreshed whenever `broadcastModelList` runs (connect, key change, model switch).
  // Empty until the first list arrives — the background-model warning is a validation
  // display, not load-bearing, so it arriving a tick after hello is fine.
  private availableModels: readonly ModelOption[] = [];
  // Prompt acceptance is idempotent per client-generated id. The promise is stored
  // before dispatch so a reconnect/retry racing the original request attaches to the
  // same result instead of invoking the driver twice. Bounded because this is only a short-term
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
    // The server's data directory. Surfaced in `hello` so the client can show/copy it,
    // and used by `openDataDir` to spawn the platform file manager. Optional so tests
    // that don't exercise it don't have to pass one.
    private dataDir?: string,
    // Spawns the platform file manager (Finder/explorer/xdg-open) on `openDataDir`.
    // Defaults to the real spawn (`defaultOpenInFileManager`); production passes that
    // explicitly, mock mode (e2e/dev) passes a no-op so automated UI never opens real
    // GUI windows on the host. Injected rather than env-gated inside the hub so unit
    // tests can assert the call without touching process state.
    private openInFileManager: (dir: string) => void = defaultOpenInFileManager,
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
   *  No-op (empty landing) when the driver has no default — the daemon at boot, or the mock
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
    this.journals.set(sid, createJournal(this.nextEpoch(), seed));
    this.defaultFocusId = sid;
  }

  /** Epochs are unique per hub process and never reused (see `epochCounter`). */
  private nextEpoch(): number {
    return ++this.epochCounter;
  }

  /** The seed source for one session (protocol v2): the journal's events, delta-
   *  coalesced, plus the {epoch, seq} watermark of the last event folded into it.
   *  Wire-visible once connect/switch flip to seeds; until then the fold-
   *  equivalence tests assert the invariant through it. Null when the session
   *  isn't seeded (nobody viewed it — background transcripts stay private). */
  seedOf(
    sid: SessionId | null,
  ): { epoch: number; seq: number; events: SessionDriverEvent[] } | null {
    const j = sid ? this.journals.get(sid) : undefined;
    return j ? buildSeed(j) : null;
  }

  /** The single append path: every event that reaches a viewed session's folded
   *  state ALSO enters its journal here — `onEvent` and the usage ticker's
   *  synthetic `usageUpdated` both come through, so seeds/resumes can never
   *  diverge from what clients folded. Folds into the legacy state, stamps the
   *  journal, routes to viewers. Background sessions (no state) are untouched. */
  private ingest(ev: SessionDriverEvent): void {
    const sid = ev.sessionRef.sessionId;
    const st = this.sessionStates.get(sid);
    if (!st) return;
    foldEvent(st, ev);
    const j = this.journals.get(sid);
    if (!j) {
      // Lifecycle invariant broken (journal must exist iff state exists). Keep
      // serving viewers, but say so loudly — a stale seed beats a silent one.
      console.error(
        `[hub] no journal for viewed session ${sid} — seeds will be stale`,
      );
    } else if (ev.type === "sessionReset") {
      // Transcript identity changed: restart the journal under a new epoch. The
      // synthetic meta prefix reproduces everything the fold carries across a
      // reset (ref/title/config/queued/approvals/ambient — items clear), so a
      // seed built between the reset and the driver's fresh re-emit is still
      // authoritative, and repeated /clears can't grow the journal unboundedly.
      bumpEpoch(
        j,
        this.nextEpoch(),
        metaSeedEvents(st, ev.sessionRef, ev.timestamp),
      );
    } else {
      appendEvent(j, ev);
    }
    for (const conn of this.clients.values())
      if (conn.focusedId === sid) conn.send({ type: "event", event: ev });
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
    // indicators must still update. LRU eviction (the polytoken driver) disposes a warm session
    // inside another client's swap and emits a synthetic sessionClosed for it; that
    // must clear the running set here regardless of who is focused where.
    const statusChanged = this.trackRunning(sid, ev);
    const attentionChanged = this.trackAttention(sid, ev);
    if (statusChanged || attentionChanged) this.broadcastSessionStatus();
    // Mark the session list dirty for the few events that can change what the sidebar
    // shows (userMessageCount/preview/updatedAt move here; a row appears/disappears).
    // assistantDelta/toolStarted/toolUpdated do NOT change list content, so a long
    // streaming turn skips the per-second listSessions disk scan (Rec #3).
    if (
      ev.type === "userMessage" ||
      ev.type === "runCompleted" ||
      ev.type === "runFailed" ||
      ev.type === "sessionOpened" ||
      ev.type === "sessionClosed"
    )
      this.sessionListDirty = true;
    // Fold + journal + route only for a session someone is viewing (or the landing
    // default). Background sessions nobody opened are tracked above, but their
    // transcript stays private — folded only once a client focuses them (switchTo
    // seeds it then).
    this.ingest(ev);
    // A closed/evicted session drops its folded transcript once nobody is viewing it
    // (a current viewer keeps its last transcript rather than blanking mid-look). The
    // landing default is kept so a fresh connection still has something to adopt.
    if (
      ev.type === "sessionClosed" &&
      sid !== this.defaultFocusId &&
      !this.hasViewer(sid)
    ) {
      this.sessionStates.delete(sid);
      this.journals.delete(sid);
    }
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
   *  / names / previews climb) + every running, viewed session's current context usage.
   *
   *  The listSessions disk scan is gated on `sessionListDirty` (Rec #3): a long
   *  streaming turn fires only assistantDelta/toolStarted/toolUpdated, none of which
   *  changes sidebar-list content, so we skip the per-second disk scan until a
   *  userMessage/runCompleted/etc. marks it dirty. Usage always refreshes (cheap, and
   *  the meter is the reason this ticker exists). */
  private liveTick(): void {
    if (this.sessionListDirty) void this.broadcastSessionList();
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
      // Through the single append path: the synthetic usage event must join the
      // journal too, or resume replays would diverge from what viewers folded.
      this.ingest(ev);
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
    // Backpressure drops are detected + handled in rawSend (index.ts), which
    // closes the connection on a dropped send. This try/catch is a safety net
    // for unexpected synchronous throws (e.g. JSON serialization of a malformed
    // message) — it keeps one client's error from aborting the broadcast loop.
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
        .catch((e): Extract<ServerMessage, { type: "promptResult" }> => ({
          type: "promptResult",
          promptId,
          accepted: false,
          sessionId:
            e && typeof e === "object" && "sessionId" in e
              ? (e.sessionId as SessionId | undefined)
              : undefined,
          error: e instanceof Error ? e.message : String(e),
        }));
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
      this.availableModels = models;
      this.broadcast({ type: "modelList", models });
      // Re-broadcast pilot settings so the background-model `warning` reflects the
      // freshly-cached model list (it's resolved from this cache; an empty pre-list
      // cache would otherwise suppress the warning until the next settings change).
      this.broadcast(this.pilotSettingsMsg());
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

  /** Fetch + send ONE client its focused session's available facets (for the
   *  FacetBadge picker). Per-connection like {@link sendCommandList}. */
  private async sendFacetList(conn: ClientConn): Promise<void> {
    try {
      const facets = await this.driver.listFacets(conn.focusedId ?? undefined);
      conn.send({ type: "facetList", facets });
    } catch (e) {
      console.error("[hub] listFacets failed", e);
    }
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

  /** Build the pilot-local-settings message: the persisted settings + the live login-env
   *  capture status (so the Settings panel can show configured-vs-active and prompt for a
   *  restart when they differ), PLUS the resolved `backgroundModelWarning` (a loud red
   *  error in the Models section when the spec is bad or doesn't resolve). The warning is
   *  resolved synchronously from the cached `availableModels` (refreshed on each
   *  model-list broadcast) — empty cache → no warning (it arrives a tick later, after the
   *  first list broadcasts). */
  private pilotSettingsMsg(): ServerMessage {
    const settings = readPilotSettings();
    const env = getLoginEnvStatus();
    // A restart is pending when the shell we'd resolve now differs from the one captured
    // at boot. Guard on activeShell so mock/dev (no capture ran) never flags a restart.
    const pendingRestart =
      env.activeShell !== null &&
      resolveLoginShell(settings.loginShell) !== env.activeShell;
    // Resolve the background-model spec against the cached available models — the wire
    // `ModelOption` cache is what's in hand on this synchronous broadcast path, so adapt
    // it inline to the resolver's `ModelLike` rather than threading the real
    // `ModelRegistry` here (a bigger change for no fidelity gain: the resolver only reads
    // `getAvailable()`). Empty cache (pre-first-list) → no warning (arrives a tick later).
    const registry = {
      getAvailable: () =>
        this.availableModels.map((m) => ({
          provider: m.provider,
          id: m.modelId,
          name: m.label,
        })),
    };
    const resolved = resolveBackgroundModel(settings.backgroundModel, registry);
    return {
      type: "pilotSettings",
      settings,
      env,
      pendingRestart,
      backgroundModelWarning: resolved.warning,
    };
  }

  /** Fetch + broadcast the daemon's global model defaults + favorites (Settings panel). */
  private async broadcastModelDefaults(): Promise<void> {
    if (!this.driver.getModelDefaults) return;
    try {
      const defaults = await this.driver.getModelDefaults();
      this.broadcast({ type: "modelDefaults", defaults });
    } catch (e) {
      console.error("[hub] getModelDefaults failed", e);
    }
  }

  /** Archive/unarchive a session, then re-broadcast the list so every client's
   *  active-only filter reflects it. Errors (e.g. an unwritable index) go back to the
   *  requester via the `error` channel — surfaced, not swallowed. */
  private async applyArchive(
    send: Send,
    path: string,
    archived: boolean,
  ): Promise<void> {
    let result: Awaited<
      ReturnType<NonNullable<typeof this.driver.setArchived>>
    >;
    try {
      result = await this.driver.setArchived?.(path, archived);
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    // A worktree-backed session whose worktree couldn't be reaped (dirty) is reported
    // back to the archiving client only, so its archived toast can explain the leftover.
    if (result?.worktreeRetained)
      send({
        type: "worktreeRetained",
        path: result.worktreeRetained.path,
        reason: result.worktreeRetained.reason,
      });
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
   *  highlight. Clears `sessionListDirty` once the fresh list has been sent. */
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
      this.sessionListDirty = false;
    } catch (e) {
      console.error("[hub] listSessions failed", e);
    }
  }

  /**
   * Switch ONE client's focus to the session a driver swap resolves to. The swap warms +
   * seeds the target; we fold that seed into the target's shared state (unless it's
   * already live — see below), point this connection at it, and re-snapshot. Other
   * clients are untouched: focus is per-connection. Single-flight per connection (a swap
   * can block for seconds warming the session, or minutes on a trust card): a second request
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
        // A newer switch queued up while this one was warming: the operator has
        // already moved on, so this failure is stale — suppress it and let the
        // queued switch surface its own outcome. (Mirrors the success path's
        // `if (conn.pendingSwitch) return sid;` below.)
        if (!conn.pendingSwitch) {
          const { message, kind } = classifySwitchError(e);
          conn.send({ type: "error", message, kind });
        }
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
        if (!conn.pendingSwitch)
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
        // Fresh transcript identity: a first attach starts a journal, a reseed
        // (reload/branch) restarts it — either way the swap's raw seed events
        // are the new compacted prefix and any resume token goes stale.
        this.journals.set(sid, createJournal(this.nextEpoch(), seed));
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
      void this.sendFacetList(conn);
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
   *  connection focuses (the landing default; a brand-new client has none and lands
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
      dataDir: this.dataDir ?? "",
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
      desktopStale: this.desktopStale,
    });
    // Pilot-local settings + live login-env status (Settings "Environment" section).
    // Synchronous: both are in-memory / a small file read.
    send(this.pilotSettingsMsg());
    // Fire the session + model + provider lists asynchronously (driver disk/registry
    // reads); they arrive as follow-up messages, keeping hello+snapshot synchronous +
    // first.
    void this.broadcastSessionList();
    void this.broadcastModelList();
    void this.sendCommandList(conn);
    void this.sendFacetList(conn);
    void this.sendFileIndex(conn);
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
        const clearQueue = this.driver.clearQueue.bind(this.driver);
        void (async () => {
          const restored = await clearQueue(
            msg.sessionId ?? conn.focusedId ?? undefined,
          );
          send({ type: "queueRestored", ...restored });
        })().catch((e) =>
          send({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          }),
        );
        return;
      }
      case "respondUi": {
        // First-responder-wins: only the first answer for a still-pending dialog
        // reaches the driver. A second device (or co-viewer of the same session)
        // answering the same id is dropped, so the real daemon session never gets a double
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
      case "setFacet":
        this.driver.setFacet(
          msg.facet,
          msg.sessionId ?? conn.focusedId ?? undefined,
        );
        return;
      case "setPermissionMonitor":
        this.driver.setPermissionMonitor(
          msg.mode,
          msg.sessionId ?? conn.focusedId ?? undefined,
        );
        return;
      case "toggleAdventurousHandoff": {
        if (!this.driver.toggleAdventurousHandoff) {
          send({
            type: "error",
            message: "adventurous handoff isn't supported here",
          });
          return;
        }
        void this.driver
          .toggleAdventurousHandoff(
            msg.sessionId ?? conn.focusedId ?? undefined,
          )
          .catch((e) =>
            send({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        return;
      }
      case "setNotificationAutodrain": {
        if (!this.driver.setNotificationAutodrain) {
          send({
            type: "error",
            message: "notification autodrain isn't supported here",
          });
          return;
        }
        void this.driver
          .setNotificationAutodrain(
            msg.enabled,
            msg.sessionId ?? conn.focusedId ?? undefined,
          )
          .catch((e) =>
            send({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        return;
      }
      case "compact": {
        if (!this.driver.compact) {
          send({ type: "error", message: "compaction isn't supported here" });
          return;
        }
        void this.driver
          .compact(msg.sessionId ?? conn.focusedId ?? undefined)
          .catch((e) =>
            send({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        return;
      }
      case "clearContext": {
        if (!this.driver.clearContext) {
          send({
            type: "error",
            message: "clearing context isn't supported here",
          });
          return;
        }
        void this.driver
          .clearContext(msg.sessionId ?? conn.focusedId ?? undefined)
          .catch((e) =>
            send({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        return;
      }
      case "setMcpServer": {
        if (!this.driver.setMcpServer) {
          send({
            type: "error",
            message: "MCP server management isn't supported here",
          });
          return;
        }
        void this.driver
          .setMcpServer(
            msg.serverName,
            msg.action,
            msg.sessionId ?? conn.focusedId ?? undefined,
          )
          .catch((e) =>
            send({
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        return;
      }
      case "openSession":
        void this.switchTo(conn, () => this.driver.openSession(msg.path));
        return;
      case "reloadSession": {
        if (!this.driver.reloadSession) {
          send({
            type: "error",
            message: "reloading a session isn't supported here",
          });
          return;
        }
        // Reseed: the reloaded session keeps its sessionId, so a client already viewing it
        // has a (now-wedged) shared state. Force-rebuild from the fresh seed instead of
        // reusing it — and re-snapshot every viewer of it, not just the requester, so a
        // second client looking at the broken session also recovers.
        void this.switchTo(conn, () => this.driver.reloadSession!(msg.path), {
          reseed: true,
        });
        return;
      }
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
      case "listFacets":
        void this.sendFacetList(conn);
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
      case "setLoginShell": {
        // Persist the override; the capture only re-runs at startup, so this applies on
        // the next restart (the UI says so). Re-broadcast so every client reflects the
        // new configured value next to the still-current active shell.
        const path = msg.path?.trim() ? msg.path.trim() : null;
        writePilotSettings({ loginShell: path });
        this.broadcast(this.pilotSettingsMsg());
        return;
      }
      case "setBackgroundModel": {
        // Persist the spec; re-broadcast so every client reflects it + the resolved
        // `warning` (a bad spec surfaces as a loud red error in the Models section).
        // Trim: empty/whitespace is stored as null (unset — extensions fall back).
        const spec = msg.spec?.trim() ? msg.spec.trim() : null;
        writePilotSettings({ backgroundModel: spec });
        this.broadcast(this.pilotSettingsMsg());
        return;
      }
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
      case "forceUpdate":
        // User picked "force-update" off the build-stamp menu (typically right after
        // pushing to main). Flag the force for the watcher; unlike applyUpdate this is NOT
        // gated on a staged commit — the watcher will fetch-and-apply on its next poll even
        // if it hasn't noticed the new commit yet. If a commit *is* already staged, also
        // flip the card to "Updating…" for immediate feedback (same as applyUpdate).
        this.forceRequested = true;
        if (this.updateSha !== null && !this.applying) {
          this.applying = true;
          this.broadcastUpdateStatus();
        }
        return;
      case "mock":
        this.driver.runScript?.(msg.script);
        return;
      case "openDataDir":
        void this.openDataDir(send);
        return;
      default:
        send({
          type: "error",
          message: `unknown message: ${(msg as { type: string }).type}`,
        });
    }
  }

  /** Open the server's data directory in the platform file manager (Finder on macOS).
   *  The client can't spawn processes, so this is a server-side best-effort: on a
   *  headless/remote host `open` either no-ops or errors, which surfaces as an `error`
   *  message rather than crashing. macOS uses `open` (reveals the folder); other platforms
   *  fall back to the path-copy action the UI offers alongside this. The spawn itself is
   *  the injected `openInFileManager` — a no-op in mock mode so tests never open a real
   *  GUI window. */
  private async openDataDir(send: (msg: ServerMessage) => void): Promise<void> {
    const dir = this.dataDir;
    if (!dir) {
      send({
        type: "error",
        message: "data directory is not configured on this server",
      });
      return;
    }
    try {
      this.openInFileManager(dir);
    } catch (e) {
      send({
        type: "error",
        message: `couldn't open the data directory: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /** Dev/test-only: clear all session state, optionally re-seed the mock's landing
   *  fixture, and re-point + re-snapshot every connected client. `bootstrap:false`
   *  exposes the production empty landing. */
  reset(opts: { bootstrap?: boolean } = {}): void {
    this.sessionStates.clear();
    this.journals.clear();
    this.defaultFocusId = null;
    this.running.clear();
    this.initializing.clear();
    this.attention.clear();
    this.sessionTitles.clear();
    this.updateSha = null;
    this.applying = false;
    this.desktopStale = false;
    this.forceRequested = false;
    // Restore pilot-local settings to defaults so a test's `setBackgroundModel`/
    // `setLoginShell` mutation doesn't leak into sibling specs (the persisted file is
    // shared across the per-port data dir for the whole e2e run). Mirrors how the mock
    // driver's reset() restores providers/defaults/extensions to their fixture baseline.
    writePilotSettings({
      loginShell: null,
      backgroundModel: null,
      enabledExtensions: null,
    });
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
      void this.sendFacetList(conn);
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
   *  offers retry). Broadcasts updateStatus on change. Returns `applying` (did the user
   *  click "update now"?) and `force` (did they pick "force-update"?) so the watcher learns
   *  both on this same poll. `force` is read-once — handed to this caller and cleared — so a
   *  force triggers exactly one fetch-and-apply. `desktopStale` (running .app vs the clone's
   *  HEAD:desktop) rides along when the watcher knows it; `undefined` leaves the last value
   *  untouched so a partial report can't clear the dot. */
  reportUpdate(
    sha: string | null,
    applyFailed = false,
    desktopStale?: boolean,
  ): { applying: boolean; force: boolean } {
    let changed = false;
    if (sha !== this.updateSha) {
      this.updateSha = sha;
      if (sha === null) this.applying = false; // applied/gone — drop any apply flag
      changed = true;
    }
    if (desktopStale !== undefined && desktopStale !== this.desktopStale) {
      this.desktopStale = desktopStale;
      changed = true;
    }
    if (applyFailed && this.applying) {
      this.applying = false;
      changed = true;
    }
    if (applyFailed) this.forceRequested = false; // a failed force shouldn't re-fire
    if (changed) this.broadcastUpdateStatus();
    const force = this.forceRequested;
    this.forceRequested = false; // read-once: this poll owns the force
    return { applying: this.applying, force };
  }

  private broadcastUpdateStatus(): void {
    this.broadcast({
      type: "updateStatus",
      available: this.updateSha !== null,
      sha: this.updateSha ?? undefined,
      applying: this.applying,
      desktopStale: this.desktopStale,
    });
  }
}
