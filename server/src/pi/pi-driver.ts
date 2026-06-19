// The real driver: keeps N independent pi AgentSessions warm and presents them through
// PilotDriver, the same seam the mock implements. Selected via PILOT_DRIVER=pi. Uses the
// user's existing pi config (model + credentials from ~/.pi) unless overridden.
//
// D8 increment 2: instead of a single runtime that disposes the old session on every
// switch, we hold a `Map<sessionId, WarmSession>` of fully-independent sessions, each with
// its own cwd-bound services (trust resolver per cwd), UI bridge, and event subscription.
// They all stream concurrently into the shared `emit`; every event carries its session's
// ref, so the hub folds only the focused one but still lets a background run notify a
// closed phone. `openSession`/`newSession` warm-and-focus (create on first touch, reuse
// after); `prompt`/`abort`/`respondUi` dispatch by sessionId. Nothing is disposed on a
// switch — a backgrounded session keeps running and is instantly re-focusable with its
// full transcript. A warm-cap (PILOT_WARM_CAP, default 8) bounds the pool: when warming
// a session would exceed it, the least-recently-focused victims are disposed (see the
// eviction loop in warmUp). Disposing aborts any in-flight run, so eviction emits a
// synthetic sessionClosed for each victim to clear the hub's cross-session running set.
//
// This replaces the old runtime-swap model: AgentSessionRuntime exists precisely to
// replace+dispose the active session, which is the opposite of keeping N warm.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type AgentSession,
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionUIContext,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  CommandInfo,
  HostUiResponse,
  ModelDefaults,
  ProviderInfo,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  SessionUsage,
} from "@pilot/protocol";
import { ArchiveStore } from "../archive-store.js";
import { config } from "../config.js";
import type {
  NewSessionOpts,
  OAuthLoginIO,
  PilotDriver,
  TrustEvent,
} from "../driver.js";
import { mapPiEvent } from "./event-map.js";
import { type HistoryMessage, historyToEvents } from "./history-map.js";
import { createWorktree, removeWorktree } from "./worktree.js";
import { WorktreeStore } from "../worktree-store.js";
import { evictionPlan } from "./warm-cap.js";
import {
  type AuthCred,
  apiKeySetupSupported,
  inferAuthSource,
  mergeFavoritePatterns,
  type ModelLike,
  resolveFavorites,
} from "./model-config.js";
import { firstUserPreview, mergeSessionLists } from "./session-list.js";
import { makeTrustResolver, type TrustAsk } from "./trust.js";
import { PiUiBridge } from "./ui-bridge.js";
import { countUserMessages } from "./user-message-count.js";

export interface PiDriverOptions {
  /** Max kept-warm sessions before LRU eviction. Defaults to config.warmCap. */
  warmCap?: number;
}

// pi's thinking-level ladder. Mirrors `getSupportedThinkingLevels` from
// @earendil-works/pi-ai, which isn't a direct/resolvable dep here — we read the same
// `reasoning` + `thinkingLevelMap` model metadata it does. Used to enrich the model
// list so the new-session draft's effort picker has accurate options before a session
// exists (per-session `availableThinkingLevels` is only known once a model is warm).
const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
function supportedThinkingLevels(model: {
  reasoning?: unknown;
  thinkingLevelMap?: Record<string, string | null | undefined>;
}): string[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

// One kept-warm session and everything bound to it. Fully independent: its own
// AgentSession, UI bridge, and event subscription. `ref`/`cwd` are fixed for the
// session's lifetime — there is no swap, so nothing here is ever rebound.
interface WarmSession {
  session: AgentSession;
  ref: SessionRef;
  cwd: string;
  bridge: PiUiBridge;
  unsubscribe: () => void;
}

export async function createPiDriver(
  opts: PiDriverOptions = {},
): Promise<PilotDriver> {
  // The server's own cwd carries no operator intent (a Finder-launched desktop app
  // starts in `/`; even `bun run dev` is run from the repo, not the project you want
  // to work in), so it must NOT feed any logic: not trust (no dir is implicitly
  // trusted — every cwd goes through pi's built-in trust: trust.json → interactive
  // card → deny-safe), not the initial session (boot to an empty landing, not a
  // session at the server cwd), and not the new-session default ($HOME). See D12.
  const agentDir = getAgentDir();
  const now = () => String(Date.now());

  // Pilot-side archive index (source of truth for the archived flag; see ArchiveStore).
  // Read at list time as an in-memory lookup — no per-session file reads.
  const archiveStore = new ArchiveStore();

  // Pilot-side worktree index: the jj/git worktrees pilot created (keyed by cwd), so the
  // sidebar can flag them and cleanup only ever touches worktrees we own.
  const worktreeStore = new WorktreeStore();

  // ONE shared auth store + model registry across every warm session. Both are global
  // (auth.json + models.json under agentDir, cwd-independent), and sharing them is what
  // lets the Settings panel's provider/key changes take effect everywhere: a key saved
  // here + `modelRegistry.refresh()` immediately updates each warm session's available
  // models (and `setModel`'s `find`). Per-session settings managers stay cwd-bound (they
  // layer project settings at session creation); for the GLOBAL defaults/favorites the
  // panel edits we keep a separate cwd-independent manager (projectTrusted:false) —
  // so the bound cwd doesn't matter for what we read/write.
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(
    authStorage,
    join(agentDir, "models.json"),
  );
  // Global settings only: pass projectTrusted:false so the project-scope settings
  // file at the (irrelevant) cwd is never loaded — this manager is cwd-independent.
  const globalSettings = SettingsManager.create(homedir(), agentDir, {
    projectTrusted: false,
  });

  // Available models as the small shape model-config helpers want.
  const availableModelLikes = (): ModelLike[] => {
    modelRegistry.refresh();
    return modelRegistry
      .getAvailable()
      .map((m) => ({ provider: String(m.provider), id: m.id }));
  };

  const listeners = new Set<(ev: SessionDriverEvent) => void>();
  const emit = (ev: SessionDriverEvent) => {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[pi] listener error", e);
      }
    }
  };

  // --- Host-level project-trust channel (D12 interactive card) ---
  // Trust resolves inside warmUp's createAgentSessionServices — before the session (and
  // its PiUiBridge) exists, and while the hub is mid-swap (switching=true) suppressing
  // session events. So the card can't ride the per-session stream. It travels here
  // instead: makeTrustResolver's `ask` blocks (pi awaits resolveProjectTrust, exactly as
  // its TUI blocks on ui.select) until a client answers via respondTrust, or it denies
  // deny-safe on timeout / no client. Per-cwd, not per-session, by nature.
  const trustListeners = new Set<(ev: TrustEvent) => void>();
  const emitTrust = (ev: TrustEvent) => {
    for (const l of trustListeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[pi] trust listener error", e);
      }
    }
  };
  const pendingTrust = new Map<
    string,
    {
      resolve: (choice: number | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let trustSeq = 0;
  // Disambiguates live user-message ids within a millisecond: `u-${now()}` alone
  // collides on a fast double-send, and Transcript.svelte keys its {#each} by id.
  let userSeq = 0;
  // Generous: the operator may be answering from a pocket. On expiry, deny-safe.
  const TRUST_TIMEOUT_MS = 5 * 60_000;

  const settleTrust = (requestId: string, choice: number | null): void => {
    const p = pendingTrust.get(requestId);
    if (!p) return; // already settled / unknown
    pendingTrust.delete(requestId);
    clearTimeout(p.timer);
    emitTrust({ kind: "resolved", requestId });
    p.resolve(choice);
  };

  const ask: TrustAsk = ({ cwd, title, options }) =>
    new Promise<number | null>((resolve) => {
      // No one to answer (e.g. a startup resume of an untrusted cwd before any client
      // connects) → deny-safe at once rather than hang the swap for 5 minutes.
      if (trustListeners.size === 0) {
        resolve(null);
        return;
      }
      const requestId = `trust-${now()}-${trustSeq++}`;
      const timer = setTimeout(
        () => settleTrust(requestId, null),
        TRUST_TIMEOUT_MS,
      );
      (timer as { unref?: () => void }).unref?.();
      pendingTrust.set(requestId, { resolve, timer });
      emitTrust({
        kind: "request",
        request: {
          requestId,
          cwd,
          title,
          options: options.map((o) => ({ label: o.label, trusted: o.trusted })),
        },
      });
    });

  // Every kept-warm session, keyed by sessionId. Created on first touch (startup
  // resume, newSession, or openSession); never disposed on a focus switch.
  const warm = new Map<SessionId, WarmSession>();
  // Fallback target when a command arrives without a sessionId (the hub normally
  // passes the focused id). Tracks the most-recently focused/created session.
  let currentId: SessionId | null = null;
  const warmCap = opts.warmCap ?? config.warmCap;

  // Mark a session as most-recently focused: set it current AND move it to the end of
  // the warm map, whose insertion order IS the recency order eviction reads.
  function focus(id: SessionId): void {
    currentId = id;
    const ws = warm.get(id);
    if (ws) {
      warm.delete(id);
      warm.set(id, ws);
    }
  }

  // Snapshot for one warm session at a given status. Reads the session live so
  // model/title/thinking changes show up whenever a snapshot is taken.
  const snapshotFor = (
    ws: WarmSession,
    status: SessionStatus,
  ): SessionSnapshot => {
    const m = ws.session.model;
    return {
      ref: ws.ref,
      workspace: {
        workspaceId: ws.cwd,
        path: ws.cwd,
        displayName: basename(ws.cwd),
      },
      title: ws.session.sessionName ?? "pi session",
      status,
      updatedAt: now(),
      config: {
        provider: m && typeof m.provider === "string" ? m.provider : undefined,
        modelId: m?.id,
        thinkingLevel: ws.session.thinkingLevel,
        availableThinkingLevels: ws.session.getAvailableThinkingLevels(),
      },
      usage: usageFor(ws),
    };
  };

  // Context-window fill for a warm session, re-shaped to the wire type so nothing
  // pi-internal leaks. getContextUsage() walks the branch + estimates tokens over the
  // message list — O(messages), fine at turn boundaries / list refreshes, never on the
  // per-delta path. Undefined when the session has no model / no known window.
  const usageFor = (ws: WarmSession): SessionUsage | undefined => {
    const cu = ws.session.getContextUsage();
    return cu
      ? {
          tokens: cu.tokens,
          contextWindow: cu.contextWindow,
          percent: cu.percent,
        }
      : undefined;
  };

  // Emit a fresh snapshot for a warm session (after a model/thinking change). Status
  // tracks whether it's mid-stream so a change during a run doesn't read as idle.
  const emitUpdate = (ws: WarmSession): void =>
    emit({
      sessionRef: ws.ref,
      timestamp: now(),
      type: "sessionUpdated",
      snapshot: snapshotFor(ws, ws.session.isStreaming ? "running" : "idle"),
    });

  const toolMetaFor = (ws: WarmSession, name: string) => {
    const t = ws.session.getAllTools().find((x) => x.name === name);
    return { label: undefined, description: t?.description };
  };

  // The seed for a warm session: a sessionOpened snapshot + its replayed history.
  // Emitted to the first subscriber for the startup session; returned (not emitted)
  // from openSession/newSession so the hub resets state and folds it atomically.
  const seedFor = (ws: WarmSession): SessionDriverEvent[] => [
    {
      sessionRef: ws.ref,
      timestamp: now(),
      type: "sessionOpened",
      snapshot: snapshotFor(ws, ws.session.isStreaming ? "running" : "idle"),
    },
    ...historyToEvents(
      ws.session.messages as unknown as readonly HistoryMessage[],
      {
        ref: ws.ref,
        idleSnapshot: snapshotFor(ws, "idle"),
        toolMeta: (name) => toolMetaFor(ws, name),
      },
    ),
  ];

  // Warm up a brand-new session from a SessionManager: create cwd-bound services (with
  // the per-cwd trust resolver), build the session, bind the UI bridge for approvals,
  // and subscribe its event stream into the shared emit. The cwd is taken from the
  // manager so an opened session is bound to ITS stored cwd, not the server's. Registers
  // and returns the WarmSession.
  async function warmUp(sessionManager: SessionManager): Promise<WarmSession> {
    const cwd = sessionManager.getCwd();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      // Share the driver-wide auth store + model registry (see createPiDriver) so a key
      // saved via the Settings panel is visible to this session after a refresh. The
      // settings manager is left to default (cwd-bound, for correct project layering).
      authStorage,
      modelRegistry,
      // Without this, pi leaves projectTrusted=true and auto-loads every project's .pi
      // resources — the D12 gap. Resolve trust per cwd instead (non-interactive MVP;
      // honors trust.json, denies untrusted paths (no implicit trust — see createPiDriver).
      resourceLoaderReloadOptions: {
        resolveProjectTrust: makeTrustResolver(cwd, ask),
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
    });

    const ref: SessionRef = { workspaceId: cwd, sessionId: session.sessionId };
    const bridge = new PiUiBridge(ref, emit, now);
    const ws: WarmSession = {
      session,
      ref,
      cwd,
      bridge,
      unsubscribe: () => {},
    };

    // Extension UI calls (approvals + ambient) flow through this session's bridge;
    // binding is per-AgentSession and required for hostUiRequest to reach clients.
    // mode "rpc": pilot is a headless-but-dialog-capable host (a UI bridge, no
    // terminal) — pi's own semantics for that combination. Left unset it defaults to
    // "print" (hasUI=false territory), so pilot ran as the untested "print"+hasUI=true
    // combo and reported ctx.mode="print" to extensions. "rpc" lets terminal-only
    // extensions (e.g. a notify ext writing OSC escape codes) detect a non-tui host and
    // self-suppress, instead of firing a stray escape sequence into the server's stdout.
    await session.bindExtensions({
      uiContext: bridge as unknown as ExtensionUIContext,
      mode: "rpc",
    });
    ws.unsubscribe = session.subscribe((ev) => {
      for (const out of mapPiEvent(ev, {
        ref,
        now,
        toolMeta: (name) => toolMetaFor(ws, name),
        snapshot: (status) => snapshotFor(ws, status),
        // The live run status, for out-of-band events (e.g. a rename mid-turn) that
        // must NOT report idle — that would close the streaming bubble + clear the
        // running indicator. Turn-boundary events still hardcode running/idle.
        liveStatus: () => (ws.session.isStreaming ? "running" : "idle"),
      })) {
        emit(out);
      }
    });

    warm.set(session.sessionId, ws);
    // Enforce the warm cap: evict the least-recently-focused sessions (never the one
    // just created), disposing each — dispose() also aborts any in-flight run.
    for (const id of evictionPlan(
      [...warm.keys()],
      session.sessionId,
      warmCap,
    )) {
      const victim = warm.get(id);
      if (!victim) continue;
      // dispose() aborts any in-flight run but tears down pi's own event listeners, so
      // the abort's terminal event never reaches the hub. Emit a synthetic sessionClosed
      // FIRST (while the subscription is still live) so trackRunning clears this id from
      // the cross-session running set; otherwise an evicted mid-run session shows a
      // perpetual running indicator. Eviction happens inside a swap, so the hub only acts
      // on this for the running set — it's never folded into the focused transcript.
      emit({
        sessionRef: victim.ref,
        timestamp: now(),
        type: "sessionClosed",
        reason: "ended",
      });
      victim.unsubscribe();
      victim.session.dispose();
      warm.delete(id);
      console.log(`[pi] evicted LRU warm session ${id}; ${warm.size} warm`);
    }
    console.log(
      `[pi] warmed session ${session.sessionId} (${cwd}); ${warm.size} warm`,
    );
    return ws;
  }

  // Resolve the warm session a command targets: the explicit id, else the driver's
  // current focus. Returns null (caller drops) if neither resolves — loud, not silent.
  const target = (sessionId?: SessionId): WarmSession | null => {
    const id = sessionId ?? currentId;
    const ws = id ? warm.get(id) : undefined;
    if (!ws) {
      console.error(`[pi] no warm session for id=${id ?? "(none)"}`);
      return null;
    }
    return ws;
  };

  // Startup: boot to an empty landing (no warm session, focusedId=null). The client
  // opens a new-session draft at $HOME; a session is only materialized when the
  // operator sends a first prompt or opens one from the sidebar. (Restoring the
  // last-focused session on boot is a separate, planned fast-follow.)

  const toEntry = async (
    info: Awaited<ReturnType<typeof SessionManager.list>>[number],
  ): Promise<SessionListEntry> => ({
    sessionId: info.id,
    path: info.path,
    cwd: info.cwd,
    displayName: info.name,
    preview: info.firstMessage ?? "",
    // info.messageCount counts user + assistant + toolResult; the sidebar wants only
    // the operator's turns, so re-scan for role-"user" entries (cached by mtime+total).
    userMessageCount: await countUserMessages(
      info.path,
      info.modified.getTime(),
      info.messageCount,
    ),
    updatedAt: info.modified.toISOString(),
    createdAt: info.created.toISOString(),
    parentSessionPath: info.parentSessionPath,
    archived: archiveStore.has(info.path),
    worktree: worktreeStore.get(info.cwd) ? { path: info.cwd } : undefined,
  });

  // A list entry for a warm session that isn't on disk yet. pi doesn't write a
  // session's .jsonl until its first ASSISTANT message — it buffers the header +
  // opening user turn in memory until then (SessionManager._persist). So a session
  // we just created + focused via newSession is invisible to listAll() and would be
  // missing from the very list we broadcast alongside its activeSessionId. Synthesize
  // a placeholder so the sidebar shows it the instant it's created; once it persists,
  // the richer disk entry supersedes it (deduped by sessionId in listSessions). cwd is
  // the only stable field; the timestamp is "now" so a brand-new session sorts to the
  // top and never reads as stale. preview = the first user message (firstUserPreview) so
  // an unnamed new session reads as its prompt, not "(untitled)", before pi names it.
  const warmEntry = (ws: WarmSession): SessionListEntry | null => {
    const path = ws.session.sessionFile;
    if (!path) return null; // non-persistent session (pilot never makes these)
    const nowIso = new Date().toISOString();
    const messages = ws.session
      .messages as unknown as readonly HistoryMessage[];
    return {
      sessionId: ws.ref.sessionId,
      path,
      cwd: ws.cwd,
      displayName: ws.session.sessionName,
      preview: firstUserPreview(messages),
      userMessageCount: messages.filter((m) => m.role === "user").length,
      // usage is attached uniformly by the post-merge overlay in listSessions (which
      // covers warm-only and disk-superseded entries alike), so it's omitted here.
      updatedAt: nowIso,
      createdAt: nowIso,
      archived: archiveStore.has(path),
    };
  };

  // Remove a pilot-created worktree at `cwd` and forget it. `force=false` leaves a dirty
  // worktree in place (returns removed:false). The index is the gate — we never touch a
  // worktree pilot didn't create.
  const reapWorktree = async (
    cwd: string,
    force: boolean,
  ): Promise<{ removed: boolean; reason?: string }> => {
    const meta = worktreeStore.get(cwd);
    if (!meta)
      return { removed: false, reason: "no pilot worktree at this path" };
    const res = await removeWorktree(meta, force);
    if (res.removed) worktreeStore.remove(cwd);
    return res;
  };

  return {
    subscribe(l) {
      listeners.add(l);
      // No boot session to seed: the server starts on an empty landing, and each
      // opened/created session delivers its own seed through switchTo. The first
      // subscriber (the hub) simply starts listening.
      return () => listeners.delete(l);
    },

    subscribeTrust(l) {
      trustListeners.add(l);
      return () => trustListeners.delete(l);
    },

    respondTrust(requestId, choice) {
      settleTrust(requestId, choice);
    },

    prompt(text, deliverAs, sessionId, images) {
      const ws = target(sessionId);
      if (!ws) return;
      emit({
        sessionRef: ws.ref,
        timestamp: now(),
        type: "userMessage",
        id: `u-${now()}-${userSeq++}`,
        text,
        images,
      });
      const options: Record<string, unknown> = {};
      if (images && images.length > 0) options.images = images;
      if (ws.session.isStreaming && deliverAs)
        options.streamingBehavior = deliverAs;
      ws.session.prompt(text, options).catch((e) => {
        emit({
          sessionRef: ws.ref,
          timestamp: now(),
          type: "runFailed",
          error: { message: String(e) },
        });
      });
    },

    abort(sessionId) {
      target(sessionId)
        ?.session.abort()
        .catch(() => {});
    },

    respondUi(response: HostUiResponse, sessionId) {
      target(sessionId)?.bridge.resolve(response);
    },

    getUsage(sessionId) {
      // The same getContextUsage() snapshotFor reads, exposed standalone so the hub's
      // live ticker can refresh the meter mid-turn. O(messages) — only that ~1s tick
      // calls it, never the per-delta path.
      const cu = target(sessionId)?.session.getContextUsage();
      return cu
        ? {
            tokens: cu.tokens,
            contextWindow: cu.contextWindow,
            percent: cu.percent,
          }
        : undefined;
    },

    async listSessions() {
      // Every session on the machine, so the sidebar can group them by project dir
      // (the owner's choice — a cross-project navigator, not just the server cwd's sessions).
      const onDisk = await Promise.all(
        (await SessionManager.listAll()).map(toEntry),
      );
      // Surface warm sessions not yet persisted to disk (e.g. a just-created one) so the
      // sidebar shows them immediately; mergeSessionLists dedupes against the disk list.
      const warmEntries = [...warm.values()]
        .map(warmEntry)
        .filter((e): e is SessionListEntry => e !== null);
      const merged = mergeSessionLists(onDisk, warmEntries);
      // Overlay live context usage onto whichever entry won the merge (the disk entry
      // supersedes the warm placeholder, so usage set only on warmEntry would be lost).
      // Sessions not currently warm get no usage — we don't load them to compute it.
      const warmUsage = new Map<SessionId, SessionUsage>();
      for (const ws of warm.values()) {
        const u = usageFor(ws);
        if (u) warmUsage.set(ws.ref.sessionId, u);
      }
      return merged.map((e) => {
        const u = warmUsage.get(e.sessionId);
        return u ? { ...e, usage: u } : e;
      });
    },

    async setArchived(path: string, archived: boolean) {
      // Option B: the flag lives only in pilot's index, keyed by the .jsonl path. We do
      // NOT append to the session file — pi's list path drops custom entries, so that
      // copy would be write-only and force a per-session scan to read back.
      archiveStore.set(path, archived);
      // Archiving a worktree-backed session reaps the worktree when it's clean; a dirty
      // one is left in place (the sidebar keeps flagging it for manual cleanup). Resolve
      // the cwd from the .jsonl path via the same list the sidebar is built from.
      if (!archived) return;
      const info = (await SessionManager.listAll()).find(
        (s) => s.path === path,
      );
      if (info && worktreeStore.get(info.cwd))
        await reapWorktree(info.cwd, false).catch((e) =>
          console.error("[worktree] archive cleanup failed", e),
        );
    },

    async cleanupWorktree(path: string, opts?: { force?: boolean }) {
      return reapWorktree(path, opts?.force ?? false);
    },

    async renameSession(path: string, name: string) {
      const next = name.trim();
      if (!next) return;
      // A warm session owns an open AgentSession on this JSONL — rename through it so the
      // write goes through the single owning writer AND emits `session_info_changed`,
      // which re-snapshots the header title live (event-map.ts). Opening a second
      // SessionManager on the same file would race that writer.
      const warmSession = [...warm.values()].find(
        (w) => w.session.sessionFile === path,
      );
      if (warmSession) {
        warmSession.session.setSessionName(next);
        return;
      }
      // Cold session: append a `session_info` entry directly, exactly as pi's TUI rename
      // does. No live AgentSession, so the hub's list re-broadcast is what surfaces it.
      SessionManager.open(path).appendSessionInfo(next);
    },

    async openSession(path: string) {
      // Already warm (matched by session file)? Just refocus — never open a second
      // AgentSession on the same JSONL; that would double-write the file. This is the
      // instant focus-switch for a backgrounded session, history and all.
      const existing = [...warm.values()].find(
        (w) => w.session.sessionFile === path,
      );
      if (existing)
        console.log(`[pi] refocus warm session ${existing.ref.sessionId}`);
      const ws = existing ?? (await warmUp(SessionManager.open(path)));
      focus(ws.ref.sessionId);
      return seedFor(ws);
    },

    async newSession(opts: NewSessionOpts = {}) {
      const { cwd, worktree, model, thinking } = opts;
      // D12: the GUI may open any path. Expand a leading `~/` (or bare `~`), make it
      // absolute, and fail loudly if it isn't a real directory rather than letting pi
      // create a session against a typo'd cwd. An untrusted new cwd still works — trust
      // only gates that repo's .pi resources (resolved per-cwd in warmUp), not the
      // session. `~otheruser` is left literal (we can't resolve another user's home);
      // it falls through to the statSync guard and fails loudly like any bad path.
      let dir = homedir();
      if (cwd?.trim()) {
        const raw = cwd.trim();
        const expanded =
          raw === "~" || raw.startsWith("~/")
            ? resolve(homedir(), `.${raw.slice(1)}`)
            : raw;
        dir = resolve(expanded);
        let stat: ReturnType<typeof statSync> | undefined;
        try {
          stat = statSync(dir);
        } catch {
          throw new Error(`no such directory: ${dir}`);
        }
        if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
      }
      // Worktree toggle: isolate the session in a fresh jj/git worktree of `dir` so the
      // agent works on a clean copy. Throws loudly if `dir` isn't a repo (surfaced to UI).
      // Record it (keyed by the worktree dir, which becomes the session cwd) so the
      // sidebar can flag it and it can be cleaned up later.
      if (worktree) {
        const meta = await createWorktree(dir);
        worktreeStore.add(meta);
        dir = meta.path;
      }
      const ws = await warmUp(SessionManager.create(dir));
      // Apply the draft's model/thinking BEFORE seedFor so the returned seed snapshot
      // already reflects them (the hub folds the seed atomically; subscribe-side
      // sessionUpdated emissions are dropped while switching). setThinkingLevel clamps
      // to what the chosen model supports, so an unsupported draft level is graceful.
      if (model) {
        const m = ws.session.modelRegistry.find(model.provider, model.modelId);
        if (m) await ws.session.setModel(m);
        else
          console.error(
            `[pi] newSession: unknown model ${model.provider}:${model.modelId}`,
          );
      }
      if (thinking)
        ws.session.setThinkingLevel(
          thinking as Parameters<typeof ws.session.setThinkingLevel>[0],
        );
      focus(ws.ref.sessionId);
      return seedFor(ws);
    },

    async listModels() {
      // The shared registry (createPiDriver) is the same view every warm session sees.
      // getAvailable() = models with working credentials, i.e. the ones actually
      // switchable — and it reflects any key just saved via the Settings panel.
      modelRegistry.refresh();
      return modelRegistry.getAvailable().map((m) => ({
        provider: String(m.provider),
        modelId: m.id,
        label: m.name,
        thinkingLevels: supportedThinkingLevels(m),
      }));
    },

    async listCommands(sessionId) {
      // The three user-defined command sources pi's own RPC `get_commands` returns; the
      // TUI builtins (/model, /settings, …) are intentionally omitted — pilot has native
      // UI for those. Read from the targeted session because each is cwd-scoped (its
      // extensions/templates/skills come from that workspace's `.pi`). Sending one is a
      // plain prompt: pi's prompt() runs extension commands and expands templates/skills.
      const ws = target(sessionId);
      if (!ws) return [];
      const out: CommandInfo[] = [];
      for (const c of ws.session.extensionRunner.getRegisteredCommands())
        out.push({
          name: c.invocationName,
          description: c.description,
          source: "extension",
        });
      for (const t of ws.session.promptTemplates)
        out.push({
          name: t.name,
          description: t.description,
          source: "prompt",
          argumentHint: t.argumentHint,
        });
      for (const s of ws.session.resourceLoader.getSkills().skills)
        out.push({
          name: `skill:${s.name}`,
          description: s.description,
          source: "skill",
        });
      return out;
    },

    setModel(provider, modelId, sessionId) {
      const ws = target(sessionId);
      if (!ws) return;
      const model = ws.session.modelRegistry.find(provider, modelId);
      if (!model) {
        console.error(`[pi] setModel: unknown model ${provider}:${modelId}`);
        return;
      }
      ws.session
        .setModel(model)
        .then(() => emitUpdate(ws))
        .catch((e) => console.error("[pi] setModel failed", e));
    },

    setThinking(level, sessionId) {
      const ws = target(sessionId);
      if (!ws) return;
      // setThinkingLevel wants pi's ThinkingLevel union; the wire carries a string.
      ws.session.setThinkingLevel(
        level as Parameters<typeof ws.session.setThinkingLevel>[0],
      );
      emitUpdate(ws);
    },

    // --- Global provider/model config (Settings panel) ---

    async listProviders() {
      modelRegistry.refresh();
      // Provider id -> display name for the OAuth-capable set (Anthropic, OpenAI Codex,
      // GitHub Copilot). Carries pi's nicer label ("Anthropic (Claude Pro/Max)") and is
      // what lets an UNAUTHED OAuth provider still show a row (so its "Sign in" button
      // has a home) even though it isn't in the curated key-capable set.
      const oauthProviders = new Map(
        authStorage.getOAuthProviders().map((p) => [p.id, p.name]),
      );
      // Every provider pi knows a model for, plus every OAuth-capable and every
      // already-authed one — then narrowed (Q2) to the curated key-capable set, the
      // OAuth-capable set, and the already-connected, so the phone panel isn't a wall of
      // irrelevant rows.
      const ids = new Set<string>([
        ...modelRegistry.getAll().map((m) => String(m.provider)),
        ...oauthProviders.keys(),
        ...authStorage.list(),
      ]);
      const out: ProviderInfo[] = [];
      for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
        const keySetup = apiKeySetupSupported(id);
        const oauthSupported = oauthProviders.has(id);
        const status = modelRegistry.getProviderAuthStatus(id);
        const hasAuth = status.configured || authStorage.hasAuth(id);
        if (!keySetup && !oauthSupported && !hasAuth) continue;
        out.push({
          id,
          name:
            modelRegistry.getProviderDisplayName(id) ||
            oauthProviders.get(id) ||
            id,
          hasAuth,
          authSource: inferAuthSource(
            authStorage.get(id) as AuthCred | undefined,
            status,
            keySetup,
          ),
          apiKeySetupSupported: keySetup,
          oauthSupported,
        });
      }
      return out;
    },

    async setProviderApiKey(providerId, apiKey) {
      const key = apiKey.trim();
      if (!key) throw new Error("API key is required");
      if (!apiKeySetupSupported(providerId))
        throw new Error(`API key setup isn't supported for ${providerId}`);
      authStorage.set(providerId, { type: "api_key", key });
      modelRegistry.refresh(); // newly-authed provider's models become available
    },

    async removeProviderApiKey(providerId) {
      authStorage.remove(providerId);
      modelRegistry.refresh();
    },

    async oauthLogin(providerId: string, io: OAuthLoginIO) {
      // Map pi's OAuth callbacks onto the hub's IO. The flow is built for the remote
      // case: pi opens an authorize URL (onAuth), starts a localhost loopback that the
      // phone can't reach, and — because we provide onManualCodeInput — races that
      // loopback against the operator pasting the code/redirect-URL back. authStorage
      // persists the tokens + auto-refreshes them on use; we only bridge the prompts.
      let authUrl: string | undefined;
      let authInstructions: string | undefined;
      // A cancelled prompt (io.prompt -> null) must abort, not silently retry with "".
      const required = (answer: string | null): string => {
        if (answer == null) throw new Error("OAuth login cancelled");
        return answer;
      };
      await authStorage.login(providerId, {
        onAuth: (info) => {
          authUrl = info.url;
          authInstructions = info.instructions;
          // Surface the link immediately too, so it's visible even for a loopback-only
          // provider that never calls onManualCodeInput/onPrompt to carry it.
          io.progress(`Open this URL to authorize:\n${info.url}`);
        },
        onManualCodeInput: () =>
          io
            .prompt({
              kind: "input",
              message: "Paste the authorization code or the full redirect URL",
              placeholder: "code, or http://localhost/callback?code=…",
              url: authUrl,
              instructions: authInstructions,
            })
            .then(required),
        onPrompt: (p) =>
          io
            .prompt({
              kind: "input",
              message: p.message,
              placeholder: p.placeholder,
              url: authUrl,
              instructions: authInstructions,
            })
            .then((answer) =>
              answer == null ? (p.allowEmpty ? "" : required(answer)) : answer,
            ),
        onSelect: (p) =>
          io
            .prompt({
              kind: "select",
              message: p.message,
              options: p.options.map((o) => ({ id: o.id, label: o.label })),
            })
            .then((answer) => answer ?? undefined),
        onProgress: (m) => io.progress(m),
        onDeviceCode: (info) =>
          io.deviceCode({
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            expiresInSeconds: info.expiresInSeconds,
          }),
      });
      modelRegistry.refresh(); // the newly-authed provider's models become available
    },

    async oauthLogout(providerId: string) {
      authStorage.logout(providerId);
      modelRegistry.refresh();
    },

    async getModelDefaults(): Promise<ModelDefaults> {
      return {
        provider: globalSettings.getDefaultProvider(),
        modelId: globalSettings.getDefaultModel(),
        thinkingLevel: globalSettings.getDefaultThinkingLevel(),
        favorites: resolveFavorites(
          globalSettings.getEnabledModels(),
          availableModelLikes(),
        ),
      };
    },

    async setDefaultModel(provider, modelId) {
      globalSettings.setDefaultModelAndProvider(provider, modelId);
      await globalSettings.flush();
    },

    async setDefaultThinking(level) {
      globalSettings.setDefaultThinkingLevel(
        level as Parameters<typeof globalSettings.setDefaultThinkingLevel>[0],
      );
      await globalSettings.flush();
    },

    async setFavoriteModels(refs) {
      // Preserve patterns the GUI can't represent (CLI globs, offline-provider
      // favorites); replace the available-resolvable ones with the explicit selection.
      const patterns = mergeFavoritePatterns(
        globalSettings.getEnabledModels(),
        refs,
        availableModelLikes(),
      );
      globalSettings.setEnabledModels(patterns);
      await globalSettings.flush();
    },
  };
}
