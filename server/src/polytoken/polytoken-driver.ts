// The PolytokenDriver: a PilotDriver backed by an out-of-process polytoken daemon.
//
// polytoken is a daemon-first coding agent with a versioned OpenAPI 3.1 HTTP surface
// + an SSE event stream; the TUI is just one client of it. This driver is mostly an
// HTTP+SSE client that maps polytoken's event vocabulary onto pilot's SessionDriverEvent.
//
// This driver is the I/O glue — it feeds SSE envelopes to the pure mapper
// (event-map.ts) and executes the returned effect descriptors (fetchState, reseed,
// refetchQueue). It also owns session lifecycle: spawning daemons, claiming leases,
// warm-pool management (LRU eviction + idle reaper), worktree integration, and
// branchFrom → POST /rewind (destructive; the history is linear, no branch DAG).
//
// Process model: one daemon = one session = one port. The driver keeps a
// Map<SessionId, WarmSession>; the cap + idle reaper bound the pool so N background
// sessions stay warm but idle ones eventually retire. Cold (not-spawned) sessions are
// listed straight from disk — no daemon needed until opened.

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CommandInfo,
  DirListing,
  FileInfo,
  HostUiResponse,
  ImageContent,
  ModelDefaults,
  ModelOption,
  PathStat,
  PermissionMonitorMode,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  SessionQueuedMessage,
  SessionUsage,
  WorkspaceRef,
} from "@pilot/protocol";
import { ArchiveStore } from "../archive-store.js";
import { WorktreeStore } from "../worktree-store.js";
import {
  listDirOnDisk,
  resolveGuiPath,
  statPathOnDisk,
} from "../fs-helpers.js";
import {
  createWorktree,
  removeWorktree,
  type WorktreeMeta,
} from "../shared/worktree.js";
import { evictionPlan } from "../shared/warm-cap.js";
import { mergeSessionLists } from "../shared/session-list.js";
import {
  DaemonClient,
  spawnDaemon,
  defaultGlobalConfigDir,
  type SseEnvelope,
  type SessionStateSnapshot as DaemonStateSnapshot,
} from "./daemon-client.js";
import type { NewSessionOpts, PilotDriver } from "../driver.js";
import {
  type FoldAccumulator,
  buildPostFetchEvent,
  createAccumulator,
  mapDaemonEvent,
  resetAccumulator,
  snapshotFromState,
  usageFromState as usageFromStatePure,
} from "./event-map.js";
import {
  buildInterrogativeResponse,
  type PendingInterrogative,
} from "./ui-bridge.js";
import { historyToSeedEvents } from "./history-seed.js";
import { defaultModelRef, modelPostKey, parseModels } from "./models.js";
import { parseSlashCommands } from "./commands.js";
import { parseFileCatalog } from "./file-catalog.js";
import { parseFacetName } from "./facets.js";
import { errorNotify, withErrorNotify } from "./config-notify.js";
import { listFilesWithFd, FILE_INDEX_CAP } from "../file-search.js";
import {
  defaultSessionsDir,
  listColdSessions,
  readSessionJson as readSessionJsonSync,
} from "./sessions-registry.js";
import { captureLoginEnv, setLoginEnvStatus } from "../shared/login-env.js";
import { readPilotSettings } from "../settings-store.js";

interface PolytokenDriverOptions {
  /** Path to the polytoken binary. Defaults to "polytoken" ($PATH lookup). */
  bin?: string;
  /** Max warm daemons before LRU eviction. Defaults to 8 — the warm pool keeps
   *  several sessions hot for instant switching (polytoken's out-of-process model
   *  makes this its natural advantage); idle ones are reaped on a timer. */
  warmCap?: number;
  /** The on-disk sessions registry dir (where `session.json` files live). Defaults
   *  to polytoken's own default (`$XDG_DATA_HOME/polytoken/sessions` or
   *  `~/.local/share/polytoken/sessions`). Override to match a daemon spawned with
   *  `--sessions-dir`. */
  sessionsDir?: string;
  /** The global config dir (where `config.yaml` lives). Defaults to polytoken's own
   *  default (`$XDG_CONFIG_HOME/polytoken` or `~/.config/polytoken`). The `daemon`
   *  resume subcommand needs this explicitly (it doesn't walk upward from the project
   *  dir like `new --working-dir` does). */
  globalConfigDir?: string;
  /** Idle reap timeout in ms. A warm session untouched (no prompt/switch) for this
   *  long is disposed — frees the daemon process + port. Defaults to 10 min; 0
   *  disables reaping (sessions stay warm until the cap evicts them). */
  idleReapMs?: number;
}

/** A warm (spawned) daemon session + its pilot-side metadata. */
interface WarmSession {
  client: DaemonClient;
  /** pilot's sessionRef for this session — threaded onto every emitted event. */
  ref: { workspaceId: string; sessionId: string };
  /** The workspace path (the daemon's --working-dir). */
  cwd: string;
  /** SSE unsubscribe, held so the driver can tear it down on close. */
  unsub: (() => void) | null;
  /** The event-fold accumulator — per-session working memory for content-block
   *  streaming (block kind, tool-input buffer, turn-error state). */
  acc: FoldAccumulator;
  /** Cached last-known daemon state snapshot. Kept fresh by fetchState effects +
   *  updated whenever the driver reads GET /state. Lets ctx.snapshot() be
   *  synchronous (the pure mapper never does I/O). */
  lastState: DaemonStateSnapshot | null;
  /** Cached active permission-monitor mode ("standard"|"bypass"|"autonomous").
   *  Seeded once at warm-up via GET /permission-monitor (the monitor isn't in
   *  GET /state) + kept in sync by the permission_monitor_switch event. Lets
   *  ctx.snapshot() be synchronous like lastState. */
  monitorMode: PermissionMonitorMode | undefined;
  /** Cached notification-autodrain flag. Seeded once at warm-up via
   *  GET /notification-autodrain (it isn't in GET /state) + kept in sync by
   *  the notification_autodrain_switch event. */
  autodrainEnabled: boolean | undefined;
  /** Pending host-UI interrogatives awaiting an operator response, keyed by the
   *  daemon's interrogative id. Populated by registerInterrogative effects;
   *  drained by respondUi. Lets the reverse builder (ui-bridge.ts) recover the
   *  option keys/ids it needs to map a pilot HostUiResponse back to the daemon's
   *  InterrogativeResponse shape. Cleared on dispose (a closed session's
   *  pending cards can't be answered). */
  pendingInterrogatives: Map<string, PendingInterrogative>;
  /** Last-focused timestamp (ms). The idle reaper disposes sessions untouched longer
   *  than idleReapMs — frees the daemon process + port without losing the session
   *  (it's still on disk; reopening re-spawns). */
  lastFocusedAt: number;
  /** Cached last-seed transcript events (the replayed history). Updated by
   *  reseedFromHistory so defaultSeed() can return the full transcript synchronously
   *  (it must not do I/O). Mirrors the original driver's in-memory `ws.session.messages` —
   *  without this, a reconnecting client sees the header but an empty transcript. */
  lastSeed: SessionDriverEvent[];
  /** Mid-turn usage polling (see getUsage): timestamp of the last kicked
   *  GET /state + the in-flight poll, so the refresh is throttled and
   *  single-flight per session. */
  usagePolledAt?: number;
  usagePoll?: Promise<void> | null;
}

/** Min gap between mid-turn GET /state usage polls per session (getUsage). */
const USAGE_POLL_MS = 3000;

export async function createPolytokenDriver(
  opts: PolytokenDriverOptions = {},
): Promise<PilotDriver> {
  const polytokenBin = opts.bin ?? "polytoken";
  const warmCap = opts.warmCap ?? 8;
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir();
  const globalConfigDir = opts.globalConfigDir ?? defaultGlobalConfigDir();
  const idleReapMs = opts.idleReapMs ?? 10 * 60 * 1000;

  // Capture the login-shell env ONCE at construction so every daemon spawn gets the
  // user's real PATH + tool env (pilot launched from the .app bundle inherits
  // launchd's minimal PATH — no brew/nvm). Login shell only (NOT interactive) to
  // avoid sourcing .zshrc where p10k/direnv/pyenv/nvm can hang. Never throws — a
  // failure degrades to {} (empty merge = current behavior).
  const { env: loginEnv, status: loginStatus } = await captureLoginEnv(
    readPilotSettings().loginShell,
  );
  setLoginEnvStatus(loginStatus);

  // Pilot-side stores, mirrored from the original driver: the archive flag + the worktree
  // index are pilot's own state (polytoken has no concept of either), keyed by
  // the session path / cwd. They persist under config.dataDir next to the VAPID key.
  const archiveStore = new ArchiveStore();
  const worktreeStore = new WorktreeStore();

  // Listeners — the hub subscribes once and folds whatever the driver emits.
  const listeners = new Set<(ev: SessionDriverEvent) => void>();
  const emit = (ev: SessionDriverEvent) => {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[polytoken] listener error", e);
      }
    }
  };

  // The warm session pool. Insertion order IS recency order (focus moves a session
  // to the end); eviction reads front-to-back. Bounded by warmCap + the idle reaper.
  const warm = new Map<string, WarmSession>();
  let activeSessionId: string | null = null;

  const now = () => new Date().toISOString();

  // Viewed-session predicate, set by the hub at construction (per-client focus is
  // hub state the driver can't see). Consulted by the idle reaper so a session an
  // operator is currently reading is never disposed under them. Defaults to
  // "nobody is viewing" — without a hub the reaper keeps its old timer-only
  // behavior rather than never reaping at all.
  let isViewed: (sessionId: string) => boolean = () => false;

  /** Per-cwd cache of parsed slash commands. The set is cwd-scoped and re-broadcast
   *  on every session switch; re-shelling-out to `polytoken print-slash-commands` on
   *  each switch would be wasteful when the set rarely changes. Cleared nowhere — a
   *  config change needs a reload (acceptable for v1 dogfooding; polytoken's own
   *  /reload re-seeds state but not pilot's caches). */
  const commandsCache = new Map<string, CommandInfo[]>();

  /** Run `polytoken <args>` and capture stdout/stderr as text. Throws on non-zero
   *  exit OR on an 8s timeout (mirrors runFd's kill-on-timeout pattern in
   *  file-search.ts — a hung `polytoken` binary, e.g. one blocking on stdin or
   *  deadlocked on a config lock, must not permanently wedge the calling hub
   *  method, which is `void`-fired with no internal timeout). `--working-dir`
   *  is a GLOBAL option (before the subcommand) — callers that need cwd pass it
   *  in `args` themselves, matching spawnDaemon's convention. */
  async function runPolytokenText(
    bin: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // Already dead — best-effort.
      }
    }, 8_000);
    try {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (timedOut) {
        throw new Error(
          `polytoken ${args.join(" ")} timed out after 8s:\nstderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}`,
        );
      }
      if (exitCode !== 0) {
        throw new Error(
          `polytoken ${args.join(" ")} exited ${exitCode}:\nstderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}`,
        );
      }
      return { stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mark a session most-recently-focused: set it active AND move it to the end of
   *  the warm map, whose insertion order is the recency order eviction reads. */
  function focus(id: string): void {
    activeSessionId = id;
    const ws = warm.get(id);
    if (ws) {
      ws.lastFocusedAt = Date.now();
      warm.delete(id);
      warm.set(id, ws);
    }
  }

  /** Build a workspace ref object for a warm session. */
  function workspaceFor(ws: WarmSession): WorkspaceRef {
    return {
      workspaceId: ws.ref.workspaceId,
      path: ws.cwd,
      displayName: ws.cwd.replace(/\/+$/, "").split("/").pop() || ws.cwd,
    };
  }

  /** Derive pilot's SessionStatus from the cached daemon state snapshot. Uses the
   *  daemon's authoritative `turn_in_flight` flag   rather than inferring
   *  from events — the daemon knows its own turn state. */
  function statusFromState(
    state: DaemonStateSnapshot | null,
  ): "idle" | "running" {
    return state?.turn_in_flight ? "running" : "idle";
  }

  /** Build a session snapshot for a warm session, defaulting the status to what the
   *  cached daemon state implies. Collapses the 7-arg snapshotFromState incantation
   *  repeated at every broadcast site in the driver. */
  function snapshotFor(
    ws: WarmSession,
    status: "idle" | "running" | "initializing" | "failed" = statusFromState(
      ws.lastState,
    ),
  ) {
    return snapshotFromState(
      ws.lastState,
      ws.ref,
      workspaceFor(ws),
      status,
      now(),
      ws.monitorMode,
      ws.autodrainEnabled,
    );
  }

  /**
   * Shared "call a daemon action → refresh state → emit a sessionUpdated
   * snapshot → log on failure" skeleton used by the simple mutating methods
   * (compact, clearContext, toggleAdventurousHandoff, setMcpServer,
   * setNotificationAutodrain). `action` runs the daemon call(s); on success we
   * fetch fresh state (unless `fetchState` is false) and emit the rebuilt
   * snapshot. `setNotificationAutodrain` passes false — it flips a local flag
   * and emits the cached snapshot without a state round-trip.
   */
  async function refreshAndEmit(
    ws: WarmSession,
    label: string,
    action: () => Promise<void>,
    fetchState = true,
  ): Promise<void> {
    try {
      await action();
      if (fetchState) {
        const { data } = await ws.client.state();
        if (data) ws.lastState = data;
      }
      emit({
        sessionRef: ws.ref,
        timestamp: now(),
        type: "sessionUpdated",
        snapshot: snapshotFor(ws),
      });
    } catch (e) {
      console.error(`[polytoken] ${label} failed`, e);
    }
  }

  /**
   * The event-fold: feed a polytoken SSE envelope to the pure mapper, emit its
   * returned pilot events, then execute its returned effect descriptors (which
   * involve I/O the pure mapper can't do). The mapper is the testable heart
   * (event-map.ts); this is the I/O glue.
   *
   * Effects:
   * - fetchState: GET /state → update ws.lastState → emit buildPostFetchEvent.
   *   Usage is on GET /state, not on the event .
   * - reseed: GET /history + GET /state → full re-broadcast (for now
   *   just refresh the state and emit sessionUpdated).
   * - refetchQueue: GET /turn/input → emit queueUpdated with the full queue.
   */
  function foldEvent(ws: WarmSession, envelope: SseEnvelope): void {
    const ev = envelope.event;
    const ctx = makeCtx(ws, envelope.emitted_at ?? now());

    const { events: pilotEvents, effects } = mapDaemonEvent(ev, ws.acc, ctx);

    // Emit the pure events first (deterministic, no I/O).
    for (const e of pilotEvents) emit(e);

    // Then execute the effect descriptors (I/O — order matters for fetchState
    // since buildPostFetchEvent reads the refreshed cache).
    for (const effect of effects) {
      executeEffect(ws, effect, ctx);
    }
  }

  /** Build a MapCtx for a warm session — the single place ctx is constructed.
   *  Used by both foldEvent (for SSE events) and executeEffect (for post-fetch
   *  follow-up events, which must read the refreshed lastState cache). */
  function makeCtx(ws: WarmSession, ts: string) {
    return {
      ref: ws.ref,
      workspace: workspaceFor(ws),
      now: () => ts,
      snapshot: (status: "idle" | "running" | "initializing" | "failed") =>
        snapshotFromState(
          ws.lastState,
          ws.ref,
          workspaceFor(ws),
          status,
          ts,
          ws.monitorMode,
          ws.autodrainEnabled,
        ),
      liveStatus: () => statusFromState(ws.lastState),
    };
  }

  /** Execute a side-effect descriptor returned by the mapper. */
  function executeEffect(
    ws: WarmSession,
    effect:
      | {
          type: "fetchState";
          emit: "runCompleted" | "sessionUpdated";
          promptId?: string;
        }
      | { type: "reseed" }
      | { type: "refetchQueue" }
      | { type: "setMonitorMode"; mode: PermissionMonitorMode }
      | { type: "setAutodrainEnabled"; enabled: boolean }
      | { type: "registerInterrogative"; pending: PendingInterrogative },
    ctx: ReturnType<typeof makeCtx>,
  ): void {
    switch (effect.type) {
      case "registerInterrogative": {
        // Store the pending interrogative so respondUi can build the reverse
        // InterrogativeResponse from a later HostUiResponse. The hostUiRequest
        // card was already emitted (in the events array, before effects run);
        // this just registers the metadata for the response path.
        ws.pendingInterrogatives.set(
          effect.pending.interrogativeId,
          effect.pending,
        );
        return;
      }
      case "fetchState": {
        // Refresh the cached state, then build the follow-up event from the
        // refreshed cache (buildPostFetchEvent is pure + tested). The promptId
        // (from message_complete) is threaded through so runCompleted carries the
        // branch-handle entryIds.
        void ws.client.state().then(({ data }) => {
          if (!data) return;
          ws.lastState = data;
          emit(buildPostFetchEvent(effect.emit, ctx, effect.promptId));
        });
        break;
      }
      case "reseed": {
        // The history was truncated (session_rewound / context_cleared) or the SSE
        // stream gapped (stream_discontinuity). Re-broadcast the FULL transcript from
        // GET /history so the hub's state matches the daemon's truth. Emit a
        // `sessionReset` first so the hub clears the stale folded state — the fold
        // is additive, so emitting fresh events on top of stale ones would duplicate.
        resetAccumulator(ws.acc);
        void (async () => {
          try {
            const events = await reseedFromHistory(ws, false);
            // Clear the hub's stale state, then emit the fresh transcript.
            emit({
              sessionRef: ws.ref,
              timestamp: now(),
              type: "sessionReset",
            });
            for (const e of events) emit(e);
          } catch (e) {
            console.error("[polytoken] reseed failed", e);
          }
        })();
        break;
      }
      case "refetchQueue": {
        // The queue events carry one item + revision, not the full queue. pilot's
        // queueUpdated REPLACES the full queue, so we must fetch GET /turn/input.
        // NOTE: PendingTurnInputItem carries no timestamp (only id + content), so
        // createdAt/updatedAt are set to fetch-time, not queue-time. This means
        // time-based sort is fetch-order, not queue-order — acceptable for v1 since
        // items[] order is queue order and the queue is display-only.
        void ws.client.turnInputSnapshot().then(({ data }) => {
          if (!data) return;
          emit({
            sessionRef: ws.ref,
            timestamp: now(),
            type: "queueUpdated",
            messages: data.items.map((item) => queueMsg(item, now())),
          });
        });
        break;
      }
      case "setMonitorMode": {
        // The permission_monitor_switch event carried the authoritative new mode;
        // update the cache so subsequent ctx.snapshot() calls reflect it. (The
        // matching sessionUpdated snapshot was already emitted from the event
        // payload, ahead of this effect.)
        ws.monitorMode = effect.mode;
        return;
      }
      case "setAutodrainEnabled": {
        ws.autodrainEnabled = effect.enabled;
        return;
      }
    }
  }

  /** Spawn a daemon, claim the lease, subscribe to SSE, and warm it into the pool. */
  async function warmSession(
    cwd: string,
    sessionId?: string,
  ): Promise<WarmSession> {
    const spawned = await spawnDaemon(polytokenBin, {
      cwd,
      sessionId,
      sessionsDir,
      globalConfigDir,
      loginEnv,
    });
    const client = new DaemonClient(
      spawned.sessionId,
      spawned.port,
      process.pid,
    );

    // Wait for the daemon to be ready (health check), then claim the lease.
    // The daemon may take a moment to bind its port after `new --no-attach` returns.
    try {
      await waitForHealth(client);
      await client.claimLeaseWithRetry("pilot");
    } catch (e) {
      // Lease claim failed (e.g. 409 stale lease from a prior crash) or the daemon
      // didn't become healthy. Terminate the spawned daemon to avoid a leak.
      await client.close().catch(() => {});
      throw e;
    }

    // Seed the state cache so ctx.snapshot() works on the very first event.
    const { data: initialState } = await client.state();
    // Seed the permission-monitor mode once (it isn't in GET /state). Best-effort:
    // a failure leaves monitorMode undefined until the first permission_monitor_switch
    // event — the badge is empty but functional, not a hard failure.
    let seedMode: PermissionMonitorMode | undefined;
    try {
      const resp = await client.getPermissionMonitor();
      seedMode = resp.monitor.type;
    } catch (e) {
      console.error("[polytoken] getPermissionMonitor seed failed", e);
    }

    // Seed the notification-autodrain flag once (it isn't in GET /state).
    let seedAutodrain: boolean | undefined;
    try {
      const resp = await client.getNotificationAutodrain();
      seedAutodrain = resp.enabled;
    } catch (e) {
      console.error("[polytoken] getNotificationAutodrain seed failed", e);
    }

    const ref = {
      workspaceId: cwd,
      sessionId: spawned.sessionId,
    };
    const ws: WarmSession = {
      client,
      ref,
      cwd,
      unsub: null,
      acc: createAccumulator(),
      lastState: initialState ?? null,
      monitorMode: seedMode,
      autodrainEnabled: seedAutodrain,
      pendingInterrogatives: new Map(),
      lastFocusedAt: Date.now(),
      lastSeed: [],
    };

    // Subscribe to the SSE stream and fold every frame.
    ws.unsub = client.subscribe((envelope) => foldEvent(ws, envelope));

    warm.set(spawned.sessionId, ws);
    focus(spawned.sessionId);
    // Enforce the warm cap: evict the least-recently-focused sessions (never the
    // one just warmed). Sessions with a running turn (turn_in_flight) are never
    // evicted — disposing one mid-turn kills it and the synthetic sessionClosed
    // makes it look finished. If all candidates are running, we stay temporarily
    // over-cap until a turn finishes (logged below).
    for (const id of evictionPlan(
      [...warm.keys()],
      spawned.sessionId,
      warmCap,
      (id) => !warm.get(id)?.lastState?.turn_in_flight,
    )) {
      const victim = warm.get(id);
      if (!victim) continue;
      // Emit a synthetic sessionClosed BEFORE dispose so the hub clears the
      // running indicator on an evicted session (dispose tears down SSE, so the
      // abort's terminal event never arrives). Exactly the original driver's pattern.
      emit({
        sessionRef: victim.ref,
        timestamp: now(),
        type: "sessionClosed",
        reason: "ended",
      });
      await disposeSession(victim).catch(() => {});
      console.log(
        `[polytoken] evicted LRU warm session ${id}; ${warm.size} warm`,
      );
    }
    if (warmCap > 0 && warm.size > warmCap) {
      console.warn(
        `[polytoken] warm cap ${warmCap} exceeded (${warm.size} warm) — ` +
          "not enough idle eviction candidates; deferring until running turns finish",
      );
    }
    console.log(
      `[polytoken] warmed session ${spawned.sessionId} (${cwd}); ${warm.size} warm`,
    );
    return ws;
  }

  /** Seed events for a warm session: a `sessionOpened` (with the live snapshot) +
   *  the replayed transcript from GET /history. The hub resets + folds these
   *  atomically on open/reload/new. `emitOpened=false` skips the sessionOpened
   *  (the reseed path — the session is already open, just refresh the transcript).
   *  Mirrors the original driver's seedFor. */
  async function seedFor(
    ws: WarmSession,
    emitOpened = true,
  ): Promise<SessionDriverEvent[]> {
    const events: SessionDriverEvent[] = [];
    // Refresh the state cache BEFORE building the sessionOpened snapshot. The
    // cached `lastState` may be stale (a warm session backgrounded mid-turn may
    // have since gone idle; the daemon's turn_in_flight is the authoritative
    // signal). Without this refresh, the sessionOpened snapshot carries a stale
    // `turn_in_flight:true` → the hub marks the session "running" and it stays
    // that way until the next SSE-driven sessionUpdated corrects it. This was
    // the "warm an existing session shows as in-progress" bug.
    const stateRes = await ws.client.state();
    if (stateRes.data) ws.lastState = stateRes.data;
    if (emitOpened) {
      events.push({
        sessionRef: ws.ref,
        timestamp: now(),
        type: "sessionOpened",
        snapshot: snapshotFor(ws),
      });
    }
    const historyEvents = await reseedFromHistory(ws, false);
    // Recover pending interrogatives: the daemon exposes them on GET /state so a
    // reconnecting client can re-render blocked approvals. Without this, an approval
    // pending across a server restart or re-warm = permanently wedged "Working…" with
    // no card. Pass each through mapDaemonEvent to produce the hostUiRequest card +
    // registerInterrogative effect, then execute the effects (registering them in the
    // pending map so respondUi can build the reverse response).
    const pendingEvents = recoverPendingInterrogatives(ws);
    return [...events, ...historyEvents, ...pendingEvents];
  }

  /** Map the daemon's pending_interrogatives (from GET /state) through the event-map
   *  so they re-render as hostUiRequest cards on warm-up/reconnect. Also executes the
   *  registerInterrogative effects so respondUi can build the reverse response. */
  function recoverPendingInterrogatives(ws: WarmSession): SessionDriverEvent[] {
    const pending = ws.lastState?.pending_interrogatives;
    if (!pending || pending.length === 0) return [];
    const ts = now();
    const ctx = makeCtx(ws, ts);
    const events: SessionDriverEvent[] = [];
    for (const ev of pending) {
      const result = mapDaemonEvent(ev, ws.acc, ctx);
      for (const effect of result.effects) {
        if (effect.type === "registerInterrogative") {
          ws.pendingInterrogatives.set(
            effect.pending.interrogativeId,
            effect.pending,
          );
        }
      }
      events.push(...result.events);
    }
    return events;
  }

  /** Fetch GET /history + GET /state, fold the history into transcript events, and
   *  return them (for the seed) OR emit them live (for the reseed effect). Resets
   *  the accumulator first so stale in-flight block state can't leak. The history
   *  fold (history-seed.ts) is the inverse of the live event-fold: user→userMessage,
   *  assistant blocks→assistantDelta/toolStarted, tool_result→toolFinished. */
  async function reseedFromHistory(
    ws: WarmSession,
    emitEvents: boolean,
  ): Promise<SessionDriverEvent[]> {
    resetAccumulator(ws.acc);
    // Refresh the state cache first so the snapshot reflects the current truth.
    const stateRes = await ws.client.state();
    if (stateRes.data) ws.lastState = stateRes.data;
    const histRes = await ws.client.history();
    const items = histRes.data?.items ?? [];
    const events = historyToSeedEvents(items, { ref: ws.ref });
    // Close any open assistant bubble and settle orphaned running tools, exactly as a
    // finished live turn would — runCompleted is the ONLY event that closes a
    // streaming bubble (foldEvent's closeOpenAssistant on a non-running snapshot
    // covers it too, but runCompleted also calls interruptRunningTools). Without this
    // the replayed transcript's last assistant stays streaming:true and any tool
    // without a persisted tool_result stays "running" → turnActive stays true → the
    // sidebar spinner + working indicator show on an idle reopened session. This was
    // the "open an existing session shows as in-progress" bug. Mirrors the original driver's
    // historyToEvents, which appends a trailing runCompleted(idle). The idle snapshot
    // is correct here because reseedFromHistory already refreshed lastState above, so
    // statusFromState reflects the daemon's authoritative turn_in_flight (false for a
    // resumed idle session). On the refocus path (a genuinely running warm session),
    // the sessionOpened snapshot carries "running" and arrives BEFORE this trailing
    // event, so a live turn's spinner is preserved — same ordering as the original driver.
    if (events.length > 0) {
      const ts = now();
      events.push({
        sessionRef: ws.ref,
        timestamp: ts,
        type: "runCompleted",
        // Kept inline (not snapshotFor) so the snapshot shares this captured ts as
        // its updatedAt — snapshotFor would call now() a second time and the two
        // could drift by microseconds.
        snapshot: snapshotFromState(
          ws.lastState,
          ws.ref,
          workspaceFor(ws),
          statusFromState(ws.lastState),
          ts,
          ws.monitorMode,
          ws.autodrainEnabled,
        ),
      });
    }
    // Cache the transcript so defaultSeed() can return it synchronously (no I/O).
    ws.lastSeed = events;
    if (emitEvents) {
      for (const e of events) emit(e);
    }
    return events;
  }

  /** Active warm session, or null. */
  function active(): WarmSession | null {
    if (!activeSessionId) return null;
    return warm.get(activeSessionId) ?? null;
  }

  /** Resolve the warm session a command targets: the explicit id, else the active
   *  one. Loud (logs) on a miss, never throws — callers drop a no-op. */
  function target(sessionId?: string): WarmSession | null {
    const id = sessionId ?? activeSessionId;
    if (!id) return null;
    const ws = warm.get(id);
    if (!ws) {
      console.error(`[polytoken] no warm session for id=${id}`);
      return null;
    }
    return ws;
  }

  /** Tear down a warm session (release lease, terminate daemon, unsubscribe SSE). */
  async function disposeSession(ws: WarmSession): Promise<void> {
    ws.unsub?.();
    ws.unsub = null;
    // Clear pending interrogatives — a closed session's cards can't be answered,
    // and the daemon will reject any late POST. Leaving them would leak the map.
    ws.pendingInterrogatives.clear();
    await ws.client.close();
    for (const [id, entry] of warm) {
      if (entry === ws) {
        warm.delete(id);
        if (activeSessionId === id) activeSessionId = null;
      }
    }
  }

  // Idle reaper: on a timer, dispose warm sessions untouched longer than idleReapMs
  // (never the active one). Frees the daemon process + port without losing the
  // session — it's still on disk; reopening re-spawns. Owns its lifecycle (the
  // harness turn-hygiene lesson: a long-lived timer is a child — cleared on shutdown).
  const reaper =
    idleReapMs > 0
      ? setInterval(
          () => {
            const cutoff = Date.now() - idleReapMs;
            for (const [id, ws] of [...warm]) {
              if (id === activeSessionId) continue; // never reap the active session
              if (ws.lastFocusedAt > cutoff) continue;
              // Never reap a session mid-turn — background turns keep running,
              // and killing the daemon aborts them. The daemon's turn_in_flight is the
              // authoritative signal  . A backgrounded running turn is the
              // headline feature of the warm pool; reaping it would defeat it.
              if (ws.lastState?.turn_in_flight) continue;
              // Never reap a session a connected client is viewing — reading a
              // long transcript for >idleReapMs without prompting is normal, and
              // the driver-level activeSessionId can't see per-client focus.
              if (isViewed(id)) continue;
              // Idle too long — reap. Emit sessionClosed first (mirrors LRU eviction)
              // so the hub clears the running indicator on an evicted mid-run session.
              emit({
                sessionRef: ws.ref,
                timestamp: now(),
                type: "sessionClosed",
                reason: "ended",
              });
              void disposeSession(ws).catch(() => {});
              console.log(
                `[polytoken] reaped idle warm session ${id}; ${warm.size} warm`,
              );
            }
          },
          Math.min(idleReapMs, 60_000),
        )
      : null;
  reaper?.unref?.();

  // --- Helpers for sessions + worktree resolution (used by the methods below) ---

  /** Map a pending queue item to a pilot SessionQueuedMessage. The daemon
   *  carries no timestamp on queued items (only id + content) and no
   *  steer/followUp discriminator — pilot's `mode` is UX-only, so it defaults
   *  to "steer" (the mid-turn case). `ts` is caller-supplied (fetch-time, not
   *  queue-time); both createdAt/updatedAt share it, matching the prior inline
   *  behavior. */
  function queueMsg(
    item: { id: string; content: string },
    ts: string,
  ): SessionQueuedMessage {
    return {
      id: item.id,
      mode: "steer", // daemon doesn't distinguish steer/followUp
      text: item.content,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  /** The worktree field for a session's cwd, or undefined. Resolved from the
   *  worktree store at list time (pilot's own flag — polytoken has no concept).
   *  Carries `name` + `reaped` so the sidebar can show a tooltip + a tombstoned
   *  indicator, exactly like the original driver's worktreeFieldFor. */
  function worktreeFieldFor(
    cwd: string,
  ):
    { path: string; base: string; name: string; reaped?: boolean } | undefined {
    const meta = worktreeStore.get(cwd);
    if (!meta) return undefined;
    return {
      path: meta.path,
      base: meta.base,
      name: meta.name,
      reaped: worktreeStore.isReaped(cwd) || undefined,
    };
  }

  /** Resolve a polytoken session id from a session.json path (the sidebar's switch
   *  key). The id is the parent directory's basename. Returns null if the path
   *  doesn't look like a session.json. */
  function sessionIdFromPath(path: string): string | null {
    // The path is `.../sessions/<session_id>/session.json`. Walk up one dir.
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    if (parts[parts.length - 1] !== "session.json") return null;
    return parts[parts.length - 2] ?? null;
  }

  /** Read a session's project_path (cwd) from its on-disk session.json — needed to
   *  resume a cold session in the right project dir. Returns null if unreadable. */
  function cwdForSession(dir: string, sessionId: string): string | null {
    const meta = readSessionJsonSync(join(dir, sessionId, "session.json"));
    return meta?.project_path ?? null;
  }

  /** Remove a pilot-created worktree at `cwd` and tombstone it. `force=false` leaves
   *  a dirty worktree in place (returns removed:false). The index is the gate — we
   *  never touch a worktree pilot didn't create. Mirrors the original driver's reapWorktree. */
  async function reapWorktree(
    cwd: string,
    force: boolean,
  ): Promise<{ removed: boolean; reason?: string }> {
    const meta = worktreeStore.live(cwd);
    if (!meta)
      return { removed: false, reason: "no pilot worktree at this path" };
    const res = await removeWorktree(meta, force);
    if (res.removed) worktreeStore.markReaped(cwd);
    return res;
  }

  // Build the driver object. Optional methods are implemented where the daemon
  // supports them; the hub guards the rest with `?.`.
  const driver: PilotDriver = {
    subscribe(listener: (ev: SessionDriverEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async prompt(
      text: string,
      deliverAs?: "steer" | "followUp",
      sessionId?: string,
      images?: readonly ImageContent[],
      promptId?: string,
    ): Promise<void> {
      const ws = target(sessionId);
      if (!ws) {
        throw new Error("no warm polytoken session to prompt");
      }
      focus(ws.ref.sessionId);
      // Mid-turn (a turn is in flight): queue as input the agent reads between
      // steps via POST /turn/input. Otherwise start a new turn via POST /prompt.
      // deliverAs is pilot-side UX only — the daemon's queue API has no
      // steer/follow-up discriminator (every drained queued message is "steer").
      // The param stays on the signature to avoid a wire/seam change.
      //
      // The POST comes FIRST, the transcript echo after: an echo emitted before
      // the POST becomes a ghost row when the POST fails — an authoritative-
      // looking userMessage the daemon never received, which also swallows the
      // client's rejected-prompt Retry/Edit affordance (its optimistic pending
      // row reconciles against this echo). The client's own pending row covers
      // the instant render; the echo is confirmation, not the first paint.
      if (ws.lastState?.turn_in_flight) {
        await ws.client.queueTurnInput(text);
      } else {
        await ws.client.prompt(text);
      }
      emit({
        sessionRef: ws.ref,
        timestamp: now(),
        type: "userMessage",
        id: promptId ?? `pt-${Date.now()}`,
        text,
        // Echo images into the transcript so the client renders them (the mock does
        // this too). The daemon's /prompt endpoint doesn't accept images yet, so they
        // don't reach the model — but the operator sees what they attached.
        images,
      });
      // The daemon's POST /prompt (PromptRequest) accepts only `content: string` —
      // no image channel. Surface a warning notice so the operator knows their images
      // weren't sent to the model (rather than silently dropping them).
      if (images && images.length > 0) {
        emit({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `img-unsupported-${now()}`,
            message: `⚠ ${images.length === 1 ? "1 image was" : `${images.length} images were`} attached but the daemon doesn't support images yet — only the text was sent.`,
            level: "warning",
          },
        });
      }
    },

    abort(sessionId?: SessionId): void {
      const ws = target(sessionId);
      if (!ws) return;
      // cancelTurn can fail (network/daemon gone). Surface the error so the
      // operator knows the abort didn't reach the daemon — a stuck "Working…"
      // with no signal is worse than an error notify they can act on.
      withErrorNotify(
        ws.client.cancelTurn(),
        emit,
        ws.ref,
        now,
        "abort",
        "Failed to abort turn",
      );
    },

    respondUi(response: HostUiResponse, sessionId?: SessionId): void {
      // The reverse half of the host-UI bridge: translate pilot's HostUiResponse
      // back into the daemon's InterrogativeResponse and POST it, so the paused
      // turn resumes. The requestId IS the daemon's interrogative_id (the forward
      // mapping set them equal), so we look up the pending metadata, build the
      // response via the pure ui-bridge, POST it, and emit hostUiResolved so the
      // hub dismisses the card.
      //
      // Ordering matters for retry/failure UX:
      // - Drain the pending entry BEFORE the POST. This is the ACTUAL double-answer
      //   guard: a second client's respondUi hits the now-empty pending map and
      //   no-ops. The hub's first-responder-wins does NOT cover the in-flight-POST
      //   window (hostUiResolved is deferred, so the entry stays in the hub's
      //   pendingApprovals during the POST), so this drain is load-bearing, not
      //   belt-and-suspenders — don't remove it thinking the hub covers it.
      // - Defer hostUiResolved until the POST resolves. Emitting it before the
      //   POST would dismiss the card everywhere on a flaky POST (realistic over
      //   Tailscale), stranding the turn with no retry UI — the operator's only
      //   escape would be cancel. Instead, on POST failure we emit hostUiResolved
      //   (to dismiss the dead card) + an error notify so the operator sees the
      //   failure (the daemon keeps waiting, but the UI isn't frozen on a dead card).
      const ws = target(sessionId);
      if (!ws) {
        console.error("[polytoken] respondUi: no warm session for", sessionId);
        return;
      }
      const pending = ws.pendingInterrogatives.get(response.requestId);
      if (!pending) {
        // No pending interrogative for this requestId — either it was already
        // answered, or the requestId isn't a polytoken interrogative id (a
        // notify/status card pilot generated internally). Silently ignore: those
        // fire-and-forget cards have no daemon response path.
        return;
      }
      const interrogativeResponse = buildInterrogativeResponse(
        pending,
        response,
      );
      if (!interrogativeResponse) {
        // The response shape didn't match the pending type (a misroute, or a
        // malformed/out-of-range value). Dismiss the card so the UI isn't
        // stuck, but surface an error notify so the operator knows the answer
        // was rejected (not silently dropped). The daemon still awaits a
        // response; the operator can re-trigger the turn if needed.
        ws.pendingInterrogatives.delete(response.requestId);
        emit({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "hostUiResolved",
          requestId: response.requestId,
        });
        emit({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `respond-reject-${response.requestId}`,
            message: `Answer rejected (type ${pending.interrogativeType})`,
            level: "error",
          },
        });
        console.error(
          "[polytoken] respondUi: response shape didn't match interrogative type",
          pending.interrogativeType,
          "for",
          response.requestId,
        );
        return;
      }
      // Drain before POST (double-answer safety). Then POST, deferring
      // hostUiResolved until success so a flaky POST doesn't strand the card.
      ws.pendingInterrogatives.delete(response.requestId);
      void ws.client
        .respondInterrogative(pending.interrogativeId, interrogativeResponse)
        .then(() => {
          emit({
            sessionRef: ws.ref,
            timestamp: now(),
            type: "hostUiResolved",
            requestId: response.requestId,
          });
        })
        .catch((e) => {
          // POST failed (network/daemon). The card is already dismissed from the
          // pending map, but we held hostUiResolved — so emit it now to dismiss
          // the UI card, plus an error notify so the operator sees the failure
          // (the turn is paused; re-prompting or cancel resumes it).
          emit({
            sessionRef: ws.ref,
            timestamp: now(),
            type: "hostUiResolved",
            requestId: response.requestId,
          });
          emit({
            sessionRef: ws.ref,
            timestamp: now(),
            type: "hostUiRequest",
            request: {
              kind: "notify",
              requestId: `respond-failed-${response.requestId}`,
              message: `Failed to send answer: ${e instanceof Error ? e.message : String(e)}`,
              level: "error",
            },
          });
          console.error(
            "[polytoken] respondInterrogative failed for",
            pending.interrogativeId,
            e,
          );
        });
    },

    async listSessions(): Promise<SessionListEntry[]> {
      // The sidebar wants every session that has ever existed, cold or warm. The
      // authoritative source is the on-disk registry (sessions-registry.ts): each
      // `session.json` has the metadata, no daemon needed. Warm sessions not yet
      // flushed (a just-created one with no turn) are merged in via mergeSessionLists,
      // mirroring the original driver. Live usage is overlaid only where a session is warm.
      const onDisk = listColdSessions(sessionsDir, {
        archivedFor: (p) => archiveStore.has(p),
        worktreeFor: (cwd) => worktreeFieldFor(cwd),
      });
      const warmEntries: SessionListEntry[] = [];
      const warmUsage = new Map<string, SessionUsage>();
      // Snapshot warm.values() before iterating — the reaper/eviction can mutate
      // `warm` on its timer between this async function's yields. Matches the
      // reaper's own defensive `[...warm]` spread.
      for (const ws of [...warm.values()]) {
        // A warm session's title comes from the live state snapshot; cwd is stable.
        const title = ws.lastState?.session_title;
        const sessionPath = join(sessionsDir, ws.ref.sessionId, "session.json");
        warmEntries.push({
          sessionId: ws.ref.sessionId,
          path: sessionPath,
          cwd: ws.cwd,
          displayName: title ?? undefined,
          preview: "",
          userMessageCount: 0,
          updatedAt: now(),
          createdAt: now(),
          lastUserMessageAt: now(),
          archived: archiveStore.has(sessionPath),
          worktree: worktreeFieldFor(ws.cwd),
        });
        const u = usageFromStatePure(ws.lastState);
        if (u) warmUsage.set(ws.ref.sessionId, u);
      }
      const merged = mergeSessionLists(onDisk, warmEntries);
      // Overlay live context usage onto the winning entry (disk supersedes the warm
      // placeholder, so usage set only on warmEntries would be lost on merge).
      return merged.map((e) => {
        const u = warmUsage.get(e.sessionId);
        return u ? { ...e, usage: u } : e;
      });
    },

    async openSession(path: string): Promise<SessionDriverEvent[]> {
      // Resume an existing session by spawning `daemon --resume --session-id` and
      // seeding from GET /history + GET /state. `path` is the session.json path the
      // sidebar sent (the stable switch key); the session id is its parent dir name.
      // Already warm? Just refocus — never spawn a second daemon on the same session
      // (the lease is exclusive; a second claim 409s). This is the instant switch for
      // a backgrounded session, history and all.
      const sessionId = sessionIdFromPath(path);
      const existing = sessionId ? warm.get(sessionId) : undefined;
      if (existing) {
        console.log(
          `[polytoken] refocus warm session ${existing.ref.sessionId}`,
        );
        focus(existing.ref.sessionId);
        return seedFor(existing);
      }
      if (!sessionId) {
        throw new Error(`could not resolve session id from path: ${path}`);
      }
      // Resolve the cwd from the on-disk session.json so the daemon resumes in the
      // right project (a daemon needs --working-dir). Fall back to the sessions dir
      // if the metadata is missing — the daemon will still resume the session.
      const cwd = cwdForSession(sessionsDir, sessionId) ?? sessionsDir;
      const ws = await warmSession(cwd, sessionId);
      return seedFor(ws);
    },

    async reloadSession(path: string): Promise<SessionDriverEvent[]> {
      // Recovery path: dispose the warm daemon (if any) and re-spawn from the same
      // session id. POST /reload exists but a fresh spawn guarantees a clean state
      // (no stale accumulator, no leaked lease) — and the daemon re-reads its config
      // + project files on resume. Mirrors the original driver's reloadSession semantics.
      const sessionId = sessionIdFromPath(path);
      if (sessionId && warm.has(sessionId)) {
        const existing = warm.get(sessionId)!;
        // Do NOT emit sessionClosed here (unlike LRU eviction): the requester is
        // viewing this session, so a sessionClosed would flash "ended" into their
        // transcript for the whole re-warm window. The fresh seed's idle
        // sessionOpened resets the running indicator when the hub folds it instead.
        // (Mirrors the original driver's reloadSession — see its comment in the deleted driver.)
        await disposeSession(existing).catch(() => {});
        console.log(
          `[polytoken] reload: disposed warm session ${sessionId}; re-spawning`,
        );
      }
      if (!sessionId) {
        throw new Error(`could not resolve session id from path: ${path}`);
      }
      const cwd = cwdForSession(sessionsDir, sessionId) ?? sessionsDir;
      const ws = await warmSession(cwd, sessionId);
      return seedFor(ws);
    },

    async newSession(opts: NewSessionOpts = {}): Promise<SessionDriverEvent[]> {
      // Create a fresh session. The cwd is the project dir (the daemon's
      // --working-dir); `worktree` isolates it in a fresh jj/git worktree first.
      // `model`/`thinking` apply after warm-up via POST /model (the daemon's
      // default applies until then).
      let cwd = opts.cwd?.trim() || join(homedir(), "projects");
      cwd = resolveGuiPath(cwd);
      // Validate the cwd exists + is a dir, loudly — don't let the daemon spawn
      // against a typo'd path. Mirrors the original driver's newSession guard.
      const stat = statPathOnDisk(cwd);
      if (!stat.exists) throw new Error(`no such directory: ${cwd}`);
      if (!stat.isDir) throw new Error(`not a directory: ${cwd}`);
      if (opts.worktree) {
        const meta = await createWorktree(cwd);
        worktreeStore.add(meta);
        cwd = meta.path;
      }
      const ws = await warmSession(cwd);
      // Apply the draft's model/thinking if given (needs a valid provider/modelId string).
      if (opts.model) {
        try {
          // opts.model.modelId is the FULL registry name (provider/id) — POST it
          // directly via modelPostKey, no join (see setModel notes).
          await ws.client.setModel(
            modelPostKey(opts.model.modelId),
            opts.thinking,
          );
          // Refresh the cached state so the seed snapshot reflects the applied model.
          const { data } = await ws.client.state();
          if (data) ws.lastState = data;
        } catch (e) {
          console.error("[polytoken] newSession: model apply failed", e);
        }
      } else if (opts.thinking) {
        // thinking without a model: read the current model from state, then set.
        try {
          const model = ws.lastState?.active_model;
          if (model) await ws.client.setModel(model, opts.thinking);
          const { data } = await ws.client.state();
          if (data) ws.lastState = data;
        } catch (e) {
          console.error("[polytoken] newSession: thinking apply failed", e);
        }
      }
      // Apply the draft's facet if it diverges from the daemon default ("execute").
      // No state refresh needed here — seedFor does an unconditional client.state()
      // and snapshotFromState reads facet from state.active_facet.
      if (opts.facet && opts.facet !== "execute") {
        try {
          await ws.client.setFacet(opts.facet);
        } catch (e) {
          console.error("[polytoken] newSession: facet apply failed", e);
        }
      }
      // Apply the draft's permission-monitor if it diverges from the daemon default
      // ("standard"). Unlike facet/model/thinking, permissionMonitor does NOT round-trip
      // through GET /state — snapshotFromState reads it from the ws.monitorMode arg. So
      // set ws.monitorMode on the success path (before seedFor builds the snapshot) to
      // avoid a stale-"standard" flicker on the live path. On failure, leave it at its
      // seeded value so the badge reflects daemon reality.
      if (opts.permissionMonitor && opts.permissionMonitor !== "standard") {
        try {
          await ws.client.setPermissionMode(opts.permissionMonitor);
          ws.monitorMode = opts.permissionMonitor;
        } catch (e) {
          console.error("[polytoken] newSession: permission-monitor apply failed", e);
        }
      }
      return seedFor(ws);
    },

    async renameSession(path: string, name: string): Promise<void> {
      // A warm session is renamed via POST /title (the daemon owns the title; the
      // session_title_changed event follows, mapped to sessionUpdated by event-map).
      // A cold session has no daemon — but POST /title requires a warm daemon. So
      // cold rename spawns the daemon, sets the title, and leaves it warm (the
      // operator just opened it in everything but name). This differs from the original driver
      // (which appends to the .jsonl cold), but polytoken's title is daemon-owned.
      const next = name.trim();
      if (!next) return;
      const sessionId = sessionIdFromPath(path);
      if (!sessionId) {
        throw new Error(`could not resolve session id from path: ${path}`);
      }
      const existing = warm.get(sessionId);
      if (existing) {
        await existing.client.setTitle(next).catch((e) => {
          console.error("[polytoken] renameSession (warm) failed", e);
        });
        return;
      }
      // Cold: spawn + set title. The session_title_changed event will flow through
      // SSE; if nobody's listening the title is still persisted by the daemon.
      const cwd = cwdForSession(sessionsDir, sessionId) ?? sessionsDir;
      const ws = await warmSession(cwd, sessionId).catch((e) => {
        throw new Error(`failed to spawn daemon for cold rename: ${e}`);
      });
      await ws.client.setTitle(next).catch((e) => {
        console.error("[polytoken] renameSession (cold) failed", e);
      });
    },

    async branchFrom(
      entryId: string,
      _opts: { summarize?: boolean },
      sessionId?: SessionId,
    ): Promise<{
      seed: SessionDriverEvent[];
      editorText?: string;
      cancelled: boolean;
      aborted?: boolean;
    }> {
      // polytoken's history is LINEAR (no branch DAG), so this is
      // NOT a branch — it's a destructive REWIND. POST /rewind drops the target
      // prompt + everything after it (irreversible), and the prompt text returns to
      // the input for re-editing. pilot's UX must warn "deletes everything after
      // this point" (not the original driver's safe branch-and-keep). `entryId` is a prompt_id or
      // message index the client derived from the transcript; we pass it through.
      const ws = target(sessionId);
      if (!ws) {
        throw new Error(
          `no warm session to rewind (id=${sessionId ?? "(none)"})`,
        );
      }
      // The rewind request: rewind to the given prompt_id (entryId). The domains
      // field is required (an empty array = no domains, just the truncation); we
      // pass an empty array since we want the transcript truncation only.
      await ws.client
        .rewind({ domains: [], to_prompt_id: entryId })
        .catch((e) => {
          throw new Error(`POST /rewind failed: ${e}`);
        });
      // session_rewound will fire on SSE → the reseed effect re-broadcasts the
      // truncated history. We also return a fresh seed (WITH sessionOpened) so the
      // hub resets atomically — the hub's branchFrom handler calls switchTo with
      // reseed:true, which REPLACES the entire SessionState from the seed, so the
      // seed MUST include sessionOpened (the snapshot) or the rebuilt state has no
      // title/status/config. The sessionOpened snapshot is built from the refreshed
      // lastState (reseedFromHistory refreshes it via GET /state before history).
      const seed = await seedFor(ws, /*emitOpened*/ true);
      return { seed, cancelled: false };
    },

    getUsage(sessionId?: SessionId): SessionUsage | undefined {
      // The CURRENT context-window fill for a warm session. Read live from the
      // cached state (refreshed by fetchState effects); the daemon's context_usage
      // is the authoritative fill. Cold sessions return undefined (not loaded).
      const ws = target(sessionId);
      if (!ws) return undefined;
      // Mid-turn the cached state goes stale (fetchState effects fire at turn
      // boundaries), which froze the meter at turn-start values for the whole
      // turn. Kick a throttled single-flight GET /state so the meter climbs
      // during long turns; the sync return stays the cached value and the next
      // ticker read picks up the refresh. Scope is naturally running+viewed —
      // the hub only calls getUsage for those sessions.
      if (
        ws.lastState?.turn_in_flight &&
        !ws.usagePoll &&
        Date.now() - (ws.usagePolledAt ?? 0) > USAGE_POLL_MS
      ) {
        ws.usagePolledAt = Date.now();
        ws.usagePoll = ws.client
          .state()
          .then(({ data }) => {
            if (data) ws.lastState = data;
          })
          .catch(() => {
            // Best-effort — the meter just stays at the cached value.
          })
          .finally(() => {
            ws.usagePoll = null;
          });
      }
      return usageFromStatePure(ws.lastState);
    },

    async setArchived(
      path: string,
      archived: boolean,
    ): Promise<{ worktreeRetained?: { path: string; reason: string } } | void> {
      // The archive flag is pilot-side state (polytoken has no concept), keyed by
      // the session.json path. Archiving a worktree-backed session reaps the
      // worktree when clean (mirrors the original driver); a dirty one is left in place.
      archiveStore.set(path, archived);
      if (!archived) return;
      // Reap the worktree if this session's cwd is a pilot-created worktree.
      const sessionId = sessionIdFromPath(path);
      const cwd = sessionId ? cwdForSession(sessionsDir, sessionId) : undefined;
      if (!cwd) return;
      const meta = worktreeStore.live(cwd);
      if (!meta) return;
      const res = await reapWorktree(cwd, false).catch((e) => {
        console.error("[polytoken] archive cleanup failed", e);
        return { removed: false, reason: String(e) };
      });
      if (!res.removed) {
        return {
          worktreeRetained: {
            path: cwd,
            reason: res.reason ?? "uncommitted changes",
          },
        };
      }
    },

    async cleanupWorktree(
      path: string,
      opts?: { force?: boolean },
    ): Promise<{ removed: boolean; reason?: string }> {
      // Remove a pilot-created worktree at `path` (== a session cwd). The index is
      // the gate — we never touch a worktree pilot didn't create.
      return reapWorktree(path, opts?.force ?? false);
    },

    defaultSeed(): SessionDriverEvent[] | null {
      // Per-client focus: a freshly-connecting client adopts the driver's current
      // session if one is warm. Returns the snapshot + the cached transcript (from
      // the last seed/reseed), so a reconnecting phone keeps the full conversation —
      // not just the header. The transcript cache (lastSeed) is updated by
      // seedFor/reseedFromHistory; without it a reconnect would show an empty
      // transcript (the out-of-process daemon isn't readable synchronously).
      // Mirrors the original driver, which reads ws.session.messages in-memory here.
      if (!activeSessionId) return null;
      const ws = warm.get(activeSessionId);
      if (!ws) return null;
      return [
        {
          sessionRef: ws.ref,
          timestamp: now(),
          type: "sessionOpened",
          snapshot: snapshotFor(ws),
        },
        ...ws.lastSeed,
      ];
    },

    async listModels(): Promise<ModelOption[]> {
      // `polytoken models` prints a human-readable config dump (NOT JSON — no
      // --format flag on this subcommand). parseModels is the pure parser over it.
      // Shell out each call: the model set can change via `polytoken auth` /
      // config edits between calls, and a stale list would offer unswitchable
      // models. The dump is small (a few KB) and the call is driver-wide (not
      // per-session), so the cost is negligible. Errors degrade to an empty list
      // (an honest "no models available") rather than blank the picker on a
      // misconfigured polytoken.
      try {
        const { stdout } = await runPolytokenText(polytokenBin, ["models"]);
        const parsed = parseModels(stdout);
        return parsed.models;
      } catch (e) {
        console.error("[polytoken] listModels failed", e);
        return [];
      }
    },

    async getModelDefaults(): Promise<ModelDefaults> {
      // Resolve the catalog default from the `default_model` marker — polytoken
      // exposes no /models enumeration endpoint, so `polytoken models` (the text
      // dump) is the only source. Shells out fresh each call (same rationale as
      // listModels). Only `defaultModel` (the large/primary default) seeds the
      // draft; `defaultSmallModel` is the mini/background default — surfaced for
      // the Settings panel later, not used here. modelId is the FULL registry
      // name (provider/id), which is what POST /model and the picker ModelOption
      // both expect.
      try {
        const { stdout } = await runPolytokenText(polytokenBin, ["models"]);
        const { defaultModel } = parseModels(stdout);
        const ref = defaultModel ? defaultModelRef(defaultModel) : undefined;
        return {
          provider: ref?.provider,
          modelId: ref?.modelId,
          thinkingLevel: undefined, // dump carries no default thinking level
          favorites: [], // polytoken has no favorites concept yet
        };
      } catch (e) {
        console.error("[polytoken] getModelDefaults failed", e);
        return { favorites: [] };
      }
    },

    async listCommands(_sessionId?: SessionId): Promise<CommandInfo[]> {
      // `polytoken print-slash-commands --format json` is the daemon's slash-menu
      // metadata (canonical, aliases, category, description). Cached per cwd because
      // the set is cwd-scoped (loaded from the workspace's config) and re-broadcast
      // on every session switch — re-shelling-out on each switch would be wasteful
      // when the set rarely changes. parseSlashCommands is the pure parser.
      const cwd = active()?.cwd;
      if (!cwd) return [];
      const cached = commandsCache.get(cwd);
      if (cached) return cached;
      try {
        const { stdout } = await runPolytokenText(polytokenBin, [
          "--working-dir",
          cwd,
          "print-slash-commands",
          "--format",
          "json",
        ]);
        const cmds = parseSlashCommands(stdout);
        commandsCache.set(cwd, cmds);
        return cmds;
      } catch (e) {
        console.error("[polytoken] listCommands failed", e);
        return [];
      }
    },

    async listFacets(_sessionId?: SessionId): Promise<string[]> {
      // `polytoken vfs ls polytoken://facets` lists facet FILE names (e.g.
      // `execute.md`, `plan.md`), NOT facet names. The daemon's `POST /facet`
      // API and `active_facet` state field use the frontmatter `name` value
      // (e.g. `plan`), so we must read each file via `vfs cat` and extract the
      // `name` from its YAML frontmatter. Falls back to the file stem (minus `.md`)
      // when a file has no frontmatter or no `name` field.
      //
      // Not cached — called only on connect/switch/reload (not per keystroke),
      // and the reload affordance needs a fresh read. Returns at minimum
      // ["execute", "plan"] (the builtins) so the picker always has the two
      // states it used to toggle between.
      const cwd = active()?.cwd;
      if (!cwd) return ["execute", "plan"];
      try {
        const { stdout } = await runPolytokenText(polytokenBin, [
          "--working-dir",
          cwd,
          "vfs",
          "ls",
          "polytoken://facets",
        ]);
        // Keep only `.md` entries: `vfs ls` is expected to emit bare facet file
        // names, but trusting that shape verbatim would send any stray line
        // (header, directory, non-facet file) into a `vfs cat` subprocess and
        // surface it as a junk facet name.
        const files = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.endsWith(".md"));
        if (files.length === 0) return ["execute", "plan"];

        // For each facet file, read its content via `vfs cat` and extract the
        // `name` from the frontmatter. Falls back to the file stem (strip `.md`)
        // when parsing fails. Each `vfs cat` is a separate subprocess; with a
        // typical 2–5 facets this is acceptable given the 8s timeout per call
        // and the no-per-keystroke call pattern.
        const names: string[] = [];
        for (const file of files) {
          try {
            const { stdout: content } = await runPolytokenText(polytokenBin, [
              "--working-dir",
              cwd,
              "vfs",
              "cat",
              `polytoken://facets/${file}`,
            ]);
            const name = parseFacetName(content);
            names.push(name ?? file.replace(/\.md$/, ""));
          } catch (e) {
            console.error(`[polytoken] vfs cat facet ${file} failed`, e);
            // Fall back to the file stem so one unreadable file doesn't nuke
            // the whole facet list.
            names.push(file.replace(/\.md$/, ""));
          }
        }
        return names.length > 0 ? names : ["execute", "plan"];
      } catch (e) {
        console.error("[polytoken] listFacets failed", e);
        return ["execute", "plan"];
      }
    },

    async listFileIndex(
      sessionId?: SessionId,
    ): Promise<{ files: FileInfo[]; truncated: boolean }> {
      // The daemon owns a native file index (GET /files, ignore-aware, alphabetical,
      // dirs trailing `/`). This is the @-mention index the client fuzzy-matches
      // locally — it replaces pilot's `fd`-based index under this driver. The daemon
      // does not expose a cap param, so we cap client-side to FILE_INDEX_CAP (the same
      // cap the original driver's fd index uses) and report `truncated: true` on overflow —
      // matching the original driver's contract exactly, so the client's per-query `fd` fallback
      // (listFiles) engages on a large repo identically under both drivers. A cold
      // (no-warm-session) call returns empty — there's no daemon to ask.
      const ws = target(sessionId);
      if (!ws) return { files: [], truncated: false };
      try {
        const { data } = await ws.client.files();
        if (!data) return { files: [], truncated: false };
        const all = parseFileCatalog(data.files);
        const truncated = all.length > FILE_INDEX_CAP;
        return {
          files: truncated ? all.slice(0, FILE_INDEX_CAP) : all,
          truncated,
        };
      } catch (e) {
        console.error("[polytoken] listFileIndex failed", e);
        return { files: [], truncated: false };
      }
    },

    async listFiles(
      query: string,
      sessionId?: SessionId,
      cwd?: string,
    ): Promise<FileInfo[]> {
      // Fallback @-mention search when the index was truncated (or for a new-session
      // draft with no session). The daemon's GET /files has no query param, so the
      // fallback is the shared `fd` search — the same path the polytoken driver uses. `cwd`
      // (the draft's target dir) overrides; otherwise resolve from the session.
      const root = cwd ?? target(sessionId)?.cwd;
      if (!root) return [];
      return listFilesWithFd(root, query);
    },

    async listDir(path?: string): Promise<DirListing> {
      // New-session project picker browses the SERVER's filesystem — same as
      // the original driver. Empty/blank → $HOME; otherwise expand + resolve on the server.
      const dir = path?.trim() ? resolveGuiPath(path) : homedir();
      return listDirOnDisk(dir);
    },

    async statPath(path: string): Promise<PathStat> {
      return statPathOnDisk(path);
    },

    setModel(provider: string, modelId: string, sessionId?: SessionId): void {
      const ws = target(sessionId);
      if (!ws) return;
      // POST /model {model, reasoning_effort}. The model string is matched
      // against ModelConfig.name (the registry map key) — which is the FULL
      // `provider/id` that modelId already carries, so POST it directly via
      // modelPostKey (no join). `provider` is kept for the PilotDriver contract
      // (the original driver uses it for modelRegistry.find) but unused here. Preserve the
      // current reasoning_effort (setModel requires both fields).
      const effort = ws.lastState?.active_reasoning_effort ?? undefined;
      withErrorNotify(
        ws.client.setModel(modelPostKey(modelId), effort),
        emit,
        ws.ref,
        now,
        "setModel",
        "Failed to set model",
      );
    },

    setThinking(level: string, sessionId?: SessionId): void {
      const ws = target(sessionId);
      if (!ws) return;
      // POST /model with reasoning_effort (the "thinking" lever). We need the current
      // model from state — setModel requires both model + reasoning_effort.
      void ws.client
        .state()
        .then(({ data }) => {
          if (!data?.active_model) {
            // No active model — can't set thinking without it. Surface the error
            // so the operator knows the level change was a no-op.
            emit(
              errorNotify(
                ws.ref,
                now(),
                "setThinking",
                "Can't set thinking level: no active model",
              ),
            );
            return;
          }
          ws.lastState = data;
          withErrorNotify(
            ws.client.setModel(data.active_model, level),
            emit,
            ws.ref,
            now,
            "setThinking",
            "Failed to set thinking level",
          );
        })
        .catch((e: unknown) => {
          // state() GET failed (network/daemon). Surface it — the old code had no
          // catch here at all, so a network error was silently swallowed.
          const detail = e instanceof Error ? e.message : String(e);
          emit(
            errorNotify(
              ws.ref,
              now(),
              "setThinking",
              `Failed to set thinking level: ${detail}`,
            ),
          );
        });
    },

    setFacet(facet: string, sessionId?: SessionId): void {
      const ws = target(sessionId);
      if (!ws) return;
      withErrorNotify(
        ws.client.setFacet(facet),
        emit,
        ws.ref,
        now,
        "setFacet",
        "Failed to set facet",
      );
    },
    setPermissionMonitor(
      mode: PermissionMonitorMode,
      sessionId?: SessionId,
    ): void {
      const ws = target(sessionId);
      if (!ws) return;
      // Optimistically set the cached mode so the badge updates immediately; the
      // permission_monitor_switch event will confirm (or correct) it authoritatively.
      // On failure, restore the previous mode so the badge doesn't claim a safer
      // mode than the daemon is actually in.
      const prevMode = ws.monitorMode;
      ws.monitorMode = mode;
      withErrorNotify(
        ws.client.setPermissionMode(mode),
        emit,
        ws.ref,
        now,
        "setPermissionMonitor",
        "Failed to set permission monitor mode",
        () => {
          // Only restore if the cache still holds our optimistic value — an
          // intervening permission_monitor_switch event may have updated it
          // authoritatively, and we must not clobber that.
          if (ws.monitorMode === mode) ws.monitorMode = prevMode;
        },
      );
    },
    async toggleAdventurousHandoff(sessionId?: SessionId): Promise<void> {
      const ws = target(sessionId);
      if (!ws) return;
      // Toggle the flag, then fetch state so the snapshot carries the computed
      // `adventurous_handoff_active` (which ANDs `enabled` with facet support).
      await refreshAndEmit(ws, "toggleAdventurousHandoff", () =>
        ws.client.toggleAdventurousHandoff(),
      );
    },
    async setNotificationAutodrain(
      enabled: boolean,
      sessionId?: SessionId,
    ): Promise<void> {
      const ws = target(sessionId);
      if (!ws) return;
      // No state round-trip: flip the local flag and emit the cached snapshot
      // (snapshotFor already folds ws.autodrainEnabled into the result).
      await refreshAndEmit(
        ws,
        "setNotificationAutodrain",
        async () => {
          await ws.client.setNotificationAutodrain(enabled);
          ws.autodrainEnabled = enabled;
        },
        false,
      );
    },
    async compact(sessionId?: SessionId): Promise<void> {
      const ws = target(sessionId);
      if (!ws) return;
      // compact() is called with no argument (matching the /compact slash-command
      // behavior); CompactRequest is optional. The daemon's compaction_started/
      // complete events are already mapped (notify + fetchState); this explicit
      // fetchState + sessionUpdated is a safety net for the non-SSE path.
      await refreshAndEmit(ws, "compact", () => ws.client.compact());
    },
    async clearContext(sessionId?: SessionId): Promise<void> {
      const ws = target(sessionId);
      if (!ws) return;
      // context_cleared is already mapped to a reseed effect; this explicit
      // fetchState + sessionUpdated refreshes the usage meter.
      await refreshAndEmit(ws, "clearContext", () => ws.client.clear());
    },
    async setMcpServer(
      serverName: string,
      action: "enable" | "disable" | "disconnect" | "reconnect",
      sessionId?: SessionId,
    ): Promise<void> {
      const ws = target(sessionId);
      if (!ws) return;
      // The daemon emits mcp_server_* lifecycle events (already mapped to
      // notify + fetchState). Emit a sessionUpdated as a safety net.
      await refreshAndEmit(ws, `setMcpServer ${action}`, async () => {
        switch (action) {
          case "enable":
            await ws.client.enableMcpServer(serverName);
            break;
          case "disable":
            await ws.client.disableMcpServer(serverName);
            break;
          case "disconnect":
            await ws.client.disconnectMcpServer(serverName);
            break;
          case "reconnect":
            await ws.client.reconnectMcpServer(serverName);
            break;
        }
      });
    },
    setSessionViewers(fn: (sessionId: string) => boolean): void {
      isViewed = fn;
    },
    async clearQueue(
      sessionId?: SessionId,
    ): Promise<{ steering: string[]; followUp: string[] }> {
      const ws = target(sessionId);
      if (!ws) return { steering: [], followUp: [] };
      // Snapshot the pending queue, then drain it by repeatedly dequeuing the
      // newest item (the daemon has no bulk-clear endpoint). Return all texts in
      // followUp — the daemon has no steer/followUp discriminator (pilot-side UX
      // only), and the client joins both arrays into the composer draft.
      let items: { id: string; content: string }[];
      try {
        const { data } = await ws.client.turnInputSnapshot();
        items = data?.items ?? [];
      } catch (e) {
        console.error("[polytoken] clearQueue: queue snapshot failed", e);
        return { steering: [], followUp: [] };
      }
      // A drain failure is PARTIAL by nature: every dequeue that already
      // succeeded deleted that item from the daemon, so its text MUST still
      // reach the composer or it's destroyed. Stop at the first failure and
      // reconcile below.
      let dequeued = 0;
      let drainFailed = false;
      for (const _ of items) {
        try {
          await ws.client.dequeueNewestInput();
          dequeued++;
        } catch (e) {
          console.error(
            `[polytoken] clearQueue: drain failed after ${dequeued}/${items.length} items`,
            e,
          );
          drainFailed = true;
          break;
        }
      }
      if (!drainFailed) {
        // Emit an empty queueUpdated so all clients' queue trays clear.
        emit({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "queueUpdated",
          messages: [],
        });
        return { steering: [], followUp: items.map((item) => item.content) };
      }
      // Partial drain: re-fetch the daemon's REAL remaining queue. It gives
      // both an honest tray broadcast (assuming empty — or leaving the stale
      // pre-drain tray — would show clients a queue the daemon no longer has)
      // and ground truth for WHICH items were deleted (by id — the snapshot's
      // ordering vs /turn/input/newest is undocumented, so counting is a guess).
      try {
        const { data } = await ws.client.turnInputSnapshot();
        const remaining = data?.items ?? [];
        emit({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "queueUpdated",
          messages: remaining.map((item) => queueMsg(item, now())),
        });
        const remainingIds = new Set(remaining.map((item) => item.id));
        const drained = items
          .filter((item) => !remainingIds.has(item.id))
          .map((item) => item.content);
        return { steering: [], followUp: drained };
      } catch (e) {
        console.error("[polytoken] clearQueue: post-failure resync failed", e);
        // Can't resync — fall back to the dequeue count, assuming the snapshot
        // lists oldest→newest (newest-K were removed). Imperfect, but the texts
        // still reach the composer instead of being destroyed.
        return {
          steering: [],
          followUp: items.slice(items.length - dequeued).map((i) => i.content),
        };
      }
    },
  };

  // --- Driver shutdown: tear down all warm daemons on process exit. ---
  // (The harness turn-hygiene lesson: own the lifecycle of every child — a daemon
  // process is a long-lived child. Clear it on shutdown so no zombie daemons remain.)
  // Three paths:
  // - SIGTERM/SIGINT (the common kill paths for `bun run dev`): run the async shutdown
  //   (HTTP /terminate + lease release), then exit.
  // - process.on("exit") (synchronous backstop): can't await HTTP round-trips, so
  //   hard-kill via killNow() (SIGTERM the daemon pid captured from /health).
  const shutdown = async () => {
    if (reaper) clearInterval(reaper);
    const all = [...warm.values()];
    warm.clear();
    await Promise.allSettled(all.map((ws) => disposeSession(ws)));
  };

  // Async shutdown for signals — awaits HTTP /terminate for a clean daemon drain.
  let shuttingDown = false;
  const handleSignal = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[polytoken] received ${sig} — shutting down daemons`);
    void shutdown().then(() => process.exit(0));
    // Force-exit after 3s if daemons don't drain (don't hang the kill).
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  // Synchronous backstop for exit (covers normal return + signals that bypassed the
  // async handler). Can't await — hard-kill the daemon pids directly.
  process.on("exit", () => {
    for (const ws of warm.values()) {
      ws.client.killNow();
    }
  });

  return driver;
}

/** Poll GET /health until the daemon responds, with a timeout. The daemon takes a
 *  moment to bind its port after `new --no-attach` returns the port. */
async function waitForHealth(
  client: DaemonClient,
  timeoutMs = 10_000,
): Promise<void> {
  // The daemon writes `startup.json {state:"ready"}` once its HTTP server is about
  // to bind, but there's a window where the port isn't accepting connections yet.
  // safeFetch catches the connection-refused throw and returns {status:0, error};
  // a non-200 (incl. status 0) means not-yet-healthy — keep polling. Only a real
  // 200 means healthy. The stale-startup.json fix above means we're now polling
  // OUR daemon's port, so a persistent status 0 here is a real bind failure, not
  // a dead prior daemon's port.
  const deadline = Date.now() + timeoutMs;
  let lastErr: string | null = null;
  while (Date.now() < deadline) {
    const { status, error } = await client.health();
    if (status === 200) return;
    if (status === 0 && error) lastErr = error;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `daemon did not become healthy within ${timeoutMs}ms${lastErr ? ` (last error: ${lastErr})` : ""}`,
  );
}
