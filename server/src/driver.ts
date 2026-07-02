// The seam between the WS hub and whatever produces session events. The mock
// driver and the real polytoken driver both implement this, so the hub never changes
// when we swap the fixture for a live agent.

import type {
  CommandInfo,
  DirListing,
  PathStat,
  FileInfo,
  HostUiResponse,
  ImageContent,
  ModelDefaults,
  ModelOption,
  PermissionMonitorMode,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  SessionUsage,
} from "@pilot/protocol";

/** Options for {@link PilotDriver.newSession}. All optional: a bare new session
 *  defaults to $HOME. The first `prompt` is delivered by the hub after
 *  the switch, not by the driver. */
export interface NewSessionOpts {
  cwd?: string;
  worktree?: boolean;
  model?: { provider: string; modelId: string };
  thinking?: string;
  /** Facet to apply at creation (the draft's pick, e.g. start straight in plan). */
  facet?: string;
  /** Permission-monitor mode to apply at creation; omitted/"standard" = daemon default. */
  permissionMonitor?: PermissionMonitorMode;
}

export interface PilotDriver {
  subscribe(listener: (ev: SessionDriverEvent) => void): () => void;
  // sessionId targets a specific (warm) session; omit it to act on the session
  // the driver currently treats as active. Single-session drivers ignore it.
  prompt(
    text: string,
    deliverAs?: "steer" | "followUp",
    sessionId?: SessionId,
    images?: readonly ImageContent[],
    /** Stable client id used as the live userMessage id for optimistic reconciliation. */
    promptId?: string,
  ): Promise<void>;
  abort(sessionId?: SessionId): void;
  /** Atomically clear and return the targeted session's text-only driver queues. */
  clearQueue?(sessionId?: SessionId): Promise<{
    steering: string[];
    followUp: string[];
  }>;
  respondUi(response: HostUiResponse, sessionId?: SessionId): void;

  /** Sessions on disk available to open (D13: the daemon's .jsonl files are authoritative).
   *  Each entry's `archived` flag is resolved here from the driver's archive index, and
   *  `worktree` from its worktree index. */
  listSessions(): Promise<SessionListEntry[]>;

  /** Remove a pilot-created worktree at `path` (== a session cwd). `force` discards
   *  uncommitted changes; without it a dirty worktree is left in place. Resolves with
   *  whether it was removed (and why not). Optional: a driver with no worktree support
   *  omits it and the hub guards with `?.`. */
  cleanupWorktree?(
    path: string,
    opts?: { force?: boolean },
  ): Promise<{ removed: boolean; reason?: string }>;
  /** Archive or unarchive a session by its .jsonl path (pilot-side flag). Optional:
   *  a bare driver may omit it and the hub guards with `?.`. The hub re-broadcasts the
   *  session list afterward so every client's active-only filter updates. Resolves with
   *  `worktreeRetained` when archiving a worktree-backed session failed to reap its
   *  worktree (dirty); the hub relays that to the archiving client as an explanatory toast. */
  setArchived?(
    path: string,
    archived: boolean,
  ): Promise<{ worktreeRetained?: { path: string; reason: string } } | void>;
  /** Rename a session by its .jsonl path, writing the daemon's display name. Optional: a bare
   *  driver may omit it (the hub guards with `?.`). A warm (open) session is renamed
   *  through its live AgentSession so its header title updates immediately; a cold one
   *  is renamed by appending a `session_info` entry to its file. The hub re-broadcasts
   *  the session list afterward so every client's sidebar reflects the new name. */
  renameSession?(path: string, name: string): Promise<void>;
  /**
   * Switch the active session to the given .jsonl path. Resolves with the SEED
   * events (a `sessionOpened` + the replayed history) for the now-active session;
   * the hub resets its state and folds them. The driver must NOT also emit these
   * via `subscribe` — the hub orchestrates the reset so the swap is atomic.
   */
  openSession(path: string): Promise<SessionDriverEvent[]>;
  /**
   * Reload a session from scratch by its .jsonl path: dispose the warm session if one is
   * open (aborting any in-flight run), then warm it up again from disk — which rebuilds
   * the session's context anew (config, project-trust resolution, and extensions all loaded
   * fresh), the recovery path when an extension bug wedges a session. Resolves with the
   * SEED events for the now-reloaded session, exactly like {@link openSession}, so the hub
   * resets + re-broadcasts the transcript through the same atomic path (it reseeds, so a
   * client already viewing the session swaps to the fresh state instead of keeping the
   * wedged one). The persisted transcript is restored; in-memory-only state (an undelivered
   * queue, an un-persisted branch jump) is not. Optional: a bare driver omits it and the
   * hub reports that reload isn't supported.
   */
  reloadSession?(path: string): Promise<SessionDriverEvent[]>;
  /** The landing session a freshly-connecting client adopts when it has no focus of
   *  its own yet (per-client focus): the seed for the driver's current/default session,
   *  or null for an empty landing. The mock returns its bootstrap greeting; the polytoken
   *  driver returns the current warm session's seed (null at boot — it starts empty).
   *  Read synchronously by the hub on connect/reset, so it must not block. The events
   *  must NOT also be emitted via `subscribe` — the hub folds this once. Optional: a bare
   *  driver omits it and the hub treats every fresh connection as an empty landing. */
  defaultSeed?(): SessionDriverEvent[] | null;

  /** Create a fresh session and make it active; resolves with its seed events (an
   *  empty `sessionOpened`). `cwd` (an absolute dir) picks the workspace per D12;
   *  omit it for $HOME. `worktree`: create an isolated jj/git
   *  worktree of `cwd` first and bind the session to it. `model`/`thinking`: apply
   *  this config to the new session at creation (not the daemon's global defaults). The
   *  first prompt is NOT delivered here — the hub sends it after the switch lands,
   *  so creation + first turn stay correctly ordered. */
  newSession(opts?: NewSessionOpts): Promise<SessionDriverEvent[]>;

  /** Jump the session to a prior tree entry (the daemon's /tree) and branch from it. Mutates the
   *  live session's leaf, then resolves with the new branch's SEED events — like
   *  {@link openSession}, so the hub resets + re-broadcasts the transcript through the same
   *  atomic path. `editorText` is set when the target was a user prompt (its text comes
   *  back for re-editing); the hub forwards it to the requesting client's composer.
   *  `cancelled`/`aborted` mirror navigateTree (a no-op jump to the current leaf, or an
   *  aborted summary) — the seed still reflects the (unchanged) branch so the re-seed is
   *  safe. `summarize` runs the daemon's branch-summarization (an LLM call) first. Throws if the
   *  session/entry can't be resolved (the hub keeps the current transcript on a throw).
   *  Optional: a bare driver omits it and the hub guards with `?.`. */
  branchFrom?(
    entryId: string,
    opts: { summarize?: boolean },
    sessionId?: SessionId,
  ): Promise<{
    seed: SessionDriverEvent[];
    editorText?: string;
    cancelled: boolean;
    aborted?: boolean;
  }>;

  /** The CURRENT context-window fill for a (warm) session — lets the hub refresh the
   *  composer's context meter mid-turn without waiting for a turn-boundary snapshot.
   *  getContextUsage is O(messages), so the hub only calls this on its debounced live
   *  tick, never on the per-delta path. Optional (the hub guards with `?.`); sessionId
   *  omitted -> the driver's current session. Undefined when no model / no window. */
  getUsage?(sessionId?: SessionId): SessionUsage | undefined;

  /** Models available to switch to (driver-wide; the real driver reads the daemon's model
   *  registry, the mock returns a fixture set). */
  listModels(): Promise<ModelOption[]>;

  /** Slash commands the targeted session offers (extension commands + prompt templates
   *  + skills, the daemon's `get_commands` set). Per-session because the set is cwd-scoped;
   *  sessionId omitted -> the driver's current session. The mock returns a fixture set. */
  listCommands(sessionId?: SessionId): Promise<CommandInfo[]>;
  /** Available facet names for the focused session's cwd (from `polytoken vfs ls
   *  polytoken://facets`). Always includes at least ["execute", "plan"]. */
  listFacets(sessionId?: SessionId): Promise<string[]>;
  /** The full file index for a session's cwd — pushed on connect + switch so the client
   *  can fuzzy-match @-mentions locally (no per-keystroke round-trip). The real driver
   *  runs one .gitignore-aware `fd` capped at a few thousand entries; `truncated` is true
   *  when the cwd exceeds the cap (the only case the client falls back to {@link listFiles}).
   *  The mock returns its fixture set, never truncated. sessionId omitted -> current. */
  listFileIndex(
    sessionId?: SessionId,
  ): Promise<{ files: FileInfo[]; truncated: boolean }>;
  /** Fallback file search for a composer @-mention query — used when the index was
   *  truncated and local matches are thin, OR for a new-session draft (which has no session,
   *  so it always searches via this path). The real driver runs `fd` against the query,
   *  capped at ~50; the mock filters its fixture by substring. `cwd`, when given, overrides
   *  the search root (the draft's target project dir); otherwise the cwd is resolved from
   *  sessionId (omitted -> the driver's current session). Returns up to 50 entries,
   *  directories ranked above files. */
  listFiles(
    query: string,
    sessionId?: SessionId,
    cwd?: string,
  ): Promise<FileInfo[]>;
  /** List a directory's child directories for the new-session project picker. `path`
   *  omitted/empty -> $HOME; `~` and relative segments are resolved. Resolution and the
   *  read happen on the SERVER's filesystem (the agent runs server-side), so the picker browses
   *  the server regardless of which device the client is on. The real driver reads disk;
   *  the mock returns a fixture tree. Unreadable paths come back with `error: true` and
   *  no entries — never a silent empty listing. Not session-scoped (a new session has no
   *  cwd yet); it browses absolute paths. See {@link DirListing}. */
  listDir(path?: string): Promise<DirListing>;
  /** Quick existence + type check for a path typed into the new-session dir picker.
   *  The client calls this debounced for inline validation before a full `listDir`.
   *  The real driver stats the disk; the mock checks its fixture tree. See {@link PathStat}. */
  statPath(path: string): Promise<PathStat>;
  /** Switch a session's model. The driver emits a `sessionUpdated` reflecting it.
   *  sessionId omitted -> the driver's current session. */
  setModel(provider: string, modelId: string, sessionId?: SessionId): void;
  /** Switch a session's thinking level, emitting a `sessionUpdated`. */
  setThinking(level: string, sessionId?: SessionId): void;
  /** Switch a session's active facet (e.g. "execute" ↔ "plan"), emitting a
   *  `sessionUpdated` snapshot. */
  setFacet(facet: string, sessionId?: SessionId): void;
  /** Switch the active permission-monitor mode, emitting a `sessionUpdated`
   *  snapshot. Mirrors `setFacet` (per-session, both drivers implement it). */
  setPermissionMonitor(
    mode: PermissionMonitorMode,
    sessionId?: SessionId,
  ): void;

  /** Toggle the adventurous auto-handoff flag (lets plan mode autonomously start
   *  implementing). Emits a sessionUpdated snapshot with the new state. */
  toggleAdventurousHandoff?(sessionId?: SessionId): Promise<void>;

  /** Set the notification auto-drain flag. Emits a sessionUpdated snapshot with
   *  the new state. */
  setNotificationAutodrain?(
    enabled: boolean,
    sessionId?: SessionId,
  ): Promise<void>;

  /** Trigger context compaction (the daemon's POST /compact). Emits a
   *  sessionUpdated snapshot after the daemon's compaction_complete event
   *  fires (the event-map already maps compaction events to notify +
   *  fetchState). Optional: a driver without compaction support omits it. */
  compact?(sessionId?: SessionId): Promise<void>;

  /** Clear the session's context entirely (the daemon's POST /clear — resets
   *  context + shell env). The daemon's context_cleared event is already mapped
   *  to a reseed. Optional: a driver without clear support omits it. */
  clearContext?(sessionId?: SessionId): Promise<void>;

  /** Manage an MCP server (enable/disable/disconnect/reconnect). Emits a
   *  sessionUpdated snapshot with the new server status. Optional: a driver
   *  without MCP support omits it. */
  setMcpServer?(
    serverName: string,
    action: "enable" | "disable" | "disconnect" | "reconnect",
    sessionId?: SessionId,
  ): Promise<void>;

  /** The daemon's global default model/thinking for new sessions + the favorites subset. */
  getModelDefaults?(): Promise<ModelDefaults>;

  /** Wire a live predicate the driver can poll to learn whether SOME connected client is
   *  currently viewing a given session (per-client focus — the hub knows, the driver
   *  doesn't). The polytoken driver's idle reaper consults it so a background session an
   *  operator is reading (but not prompting) isn't disposed under them. The hub sets this
   *  at construction. Optional: a driver with no session pool omits it. */
  setSessionViewers?(isViewed: (sessionId: SessionId) => boolean): void;

  /** Dev-only: jump the mock to a named scripted state. No-op for the real driver. */
  runScript?(name: string): void;
  /** Dev/test-only reset. Mock drivers may skip their bootstrap fixture so the empty
   *  production landing can be exercised deterministically. No-op for real drivers. */
  reset?(opts?: { bootstrap?: boolean }): void;
}
