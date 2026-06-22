// The seam between the WS hub and whatever produces session events. The mock
// driver and the real pi-sdk driver both implement this, so the hub never changes
// when we swap the fixture for a live agent.

import type {
  CommandInfo,
  DirListing,
  ExtensionInfo,
  PathStat,
  FileInfo,
  HostUiResponse,
  ImageContent,
  ModelDefaults,
  ModelOption,
  OAuthDeviceInfo,
  OAuthLoginPrompt,
  ProviderInfo,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  SessionUsage,
  TreeSnapshot,
  TrustRequest,
} from "@pilot/protocol";

/** What the driver's trust channel emits: a card to surface, or a settle signal so
 *  clients dismiss it (D12). Kept off the SessionDriverEvent stream because trust is
 *  decided before a session exists and while the hub suppresses session events. */
export type TrustEvent =
  | { kind: "request"; request: TrustRequest }
  | { kind: "resolved"; requestId: string };

/** How the driver drives an interactive OAuth login through the hub. The hub provides
 *  this to {@link PilotDriver.oauthLogin}; the driver maps pi's OAuth callbacks onto it.
 *  Each `prompt` renders to clients and resolves with the operator's answer — a pasted
 *  code/URL or a selected option id — or null if they cancelled / it timed out (the
 *  driver should treat null as an aborted login). `progress`/`deviceCode` are
 *  fire-and-forget. */
export interface OAuthLoginIO {
  prompt(prompt: OAuthLoginPrompt): Promise<string | null>;
  progress(message: string): void;
  deviceCode(info: OAuthDeviceInfo): void;
}

/** Options for {@link PilotDriver.newSession}. All optional: a bare new session
 *  defaults to $HOME. The first `prompt` is delivered by the hub after
 *  the switch, not by the driver. */
export interface NewSessionOpts {
  cwd?: string;
  worktree?: boolean;
  model?: { provider: string; modelId: string };
  thinking?: string;
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
  /** Atomically clear and return the targeted session's text-only pi queues. */
  clearQueue?(sessionId?: SessionId): {
    steering: string[];
    followUp: string[];
  };
  respondUi(response: HostUiResponse, sessionId?: SessionId): void;

  /** Sessions on disk available to open (D13: pi's .jsonl files are authoritative).
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
   *  session list afterward so every client's active-only filter updates. */
  setArchived?(path: string, archived: boolean): Promise<void>;
  /** Rename a session by its .jsonl path, writing pi's display name. Optional: a bare
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
  /** The landing session a freshly-connecting client adopts when it has no focus of
   *  its own yet (per-client focus): the seed for the driver's current/default session,
   *  or null for an empty landing. The mock returns its bootstrap greeting; the pi
   *  driver returns the current warm session's seed (null at boot — it starts empty).
   *  Read synchronously by the hub on connect/reset, so it must not block. The events
   *  must NOT also be emitted via `subscribe` — the hub folds this once. Optional: a bare
   *  driver omits it and the hub treats every fresh connection as an empty landing. */
  defaultSeed?(): SessionDriverEvent[] | null;

  /** Create a fresh session and make it active; resolves with its seed events (an
   *  empty `sessionOpened`). `cwd` (an absolute dir) picks the workspace per D12;
   *  omit it for $HOME. `worktree`: create an isolated jj/git
   *  worktree of `cwd` first and bind the session to it. `model`/`thinking`: apply
   *  this config to the new session at creation (not pi's global defaults). The
   *  first prompt is NOT delivered here — the hub sends it after the switch lands,
   *  so creation + first turn stay correctly ordered. */
  newSession(opts?: NewSessionOpts): Promise<SessionDriverEvent[]>;

  /** Jump the session to a prior tree entry (pi's /tree) and branch from it. Mutates the
   *  live session's leaf, then resolves with the new branch's SEED events — like
   *  {@link openSession}, so the hub resets + re-broadcasts the transcript through the same
   *  atomic path. `editorText` is set when the target was a user prompt (its text comes
   *  back for re-editing); the hub forwards it to the requesting client's composer.
   *  `cancelled`/`aborted` mirror navigateTree (a no-op jump to the current leaf, or an
   *  aborted summary) — the seed still reflects the (unchanged) branch so the re-seed is
   *  safe. `summarize` runs pi's branch-summarization (an LLM call) first. Throws if the
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

  /** The focused (warm) session's full branch tree + active leaf — pi's /tree, projected
   *  JSON-safe. Read on demand when a client opens the tree view; the hub broadcasts it as
   *  `treeState`, and re-broadcasts after a `branchFrom`. Optional (the hub guards with
   *  `?.`); sessionId omitted -> the driver's current session. Resolves undefined when
   *  there's no session to read. */
  getTree?(sessionId?: SessionId): Promise<TreeSnapshot | undefined>;

  /** The CURRENT context-window fill for a (warm) session — lets the hub refresh the
   *  composer's context meter mid-turn without waiting for a turn-boundary snapshot.
   *  getContextUsage is O(messages), so the hub only calls this on its debounced live
   *  tick, never on the per-delta path. Optional (the hub guards with `?.`); sessionId
   *  omitted -> the driver's current session. Undefined when no model / no window. */
  getUsage?(sessionId?: SessionId): SessionUsage | undefined;

  /** Models available to switch to (driver-wide; the real driver reads pi's model
   *  registry, the mock returns a fixture set). */
  listModels(): Promise<ModelOption[]>;

  /** Slash commands the targeted session offers (extension commands + prompt templates
   *  + skills, pi's `get_commands` set). Per-session because the set is cwd-scoped;
   *  sessionId omitted -> the driver's current session. The mock returns a fixture set. */
  listCommands(sessionId?: SessionId): Promise<CommandInfo[]>;
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
   *  read happen on the SERVER's filesystem (pi runs server-side), so the picker browses
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

  // --- Global model/provider config (Settings panel). All optional: the mock and
  // pi driver implement them; a future bare driver may omit, and the hub guards with
  // `?.`. These touch pi's GLOBAL state (auth.json + global settings), not a session.

  /** Providers pilot can manage (curated key-capable + already-connected). Carries
   *  no secrets — only auth presence/source. */
  listProviders?(): Promise<ProviderInfo[]>;
  /** Save an API key for a provider (writes auth.json) and refresh model availability.
   *  Rejects on an unsupported provider or empty key — the hub relays it as an error. */
  setProviderApiKey?(providerId: string, apiKey: string): Promise<void>;
  /** Remove a pilot-saved API key (auth_file source only) and refresh availability. */
  removeProviderApiKey?(providerId: string): Promise<void>;
  /** Run an interactive OAuth sign-in for a provider in pi's OAuth registry (Anthropic
   *  Claude Pro/Max, OpenAI Codex, GitHub Copilot), driving the flow's prompts through
   *  `io`. Resolves once credentials are stored; rejects on failure/cancel. The hub
   *  re-broadcasts the provider + model lists afterward. */
  oauthLogin?(providerId: string, io: OAuthLoginIO): Promise<void>;
  /** Sign out of an OAuth provider (clears its stored credentials), refreshing
   *  availability so the now-unauthed provider's models drop out. */
  oauthLogout?(providerId: string): Promise<void>;

  /** pi's global default model/thinking for new sessions + the favorites subset. */
  getModelDefaults?(): Promise<ModelDefaults>;
  /** Set the global default model for NEW sessions (persists to pi's settings). */
  setDefaultModel?(provider: string, modelId: string): Promise<void>;
  /** Set the global default thinking level for NEW sessions. */
  setDefaultThinking?(level: string): Promise<void>;
  /** Replace the favorites subset (concrete `provider:modelId` refs). */
  setFavoriteModels?(refs: readonly string[]): Promise<void>;

  /** The targeted session's pi extensions (loaded, projected JSON-safe via pi's
   *  `resourceLoader.getExtensions()`), plus any pilot-disabled ones reconstructed from the
   *  force-exclude overrides in pi's settings. Read on demand for the Settings "Extensions"
   *  view; the hub sends it as `extensionList`. sessionId omitted -> the driver's current
   *  session. The mock returns a fixture set. */
  listExtensions?(sessionId?: SessionId): Promise<ExtensionInfo[]>;
  /** Enable/disable an extension by its `resolvedPath`, persisting a force-exclude override
   *  to pi's user settings. pi loads extensions at session START, so the change applies on
   *  the session's NEXT start, not live (the UI labels it). The hub re-sends `extensionList`
   *  afterward. sessionId omitted -> the driver's current session. */
  setExtensionEnabled?(
    resolvedPath: string,
    enabled: boolean,
    sessionId?: SessionId,
  ): Promise<void>;

  /** Subscribe to host-level project-trust requests (D12). The driver fires the
   *  listener when opening/creating a session in an untrusted cwd needs an
   *  interactive decision; the hub relays it to clients. Optional: a driver with no
   *  trust gate omits it. */
  subscribeTrust?(listener: (ev: TrustEvent) => void): () => void;
  /** Wire a live predicate the driver can poll to learn whether any client is currently
   *  connected. The pi driver uses it to deny-safe an interactive trust prompt the instant
   *  nobody could answer it (a startup resume before anyone connects, or a phone that
   *  flapped mid-warm), rather than hanging the swap until the prompt times out. The trust
   *  subscription can't double as this signal — the hub subscribes once at construction
   *  and never unsubscribes, so its listener count is a constant, not a client count. The
   *  hub sets this at construction. Optional: a driver with no interactive prompts omits it. */
  setClientPresence?(hasClients: () => boolean): void;
  /** Answer a pending trust request. `choice` indexes the request's options; null
   *  denies (deny-safe). Settling also fires a `resolved` TrustEvent. */
  respondTrust?(requestId: string, choice: number | null): void;

  /** Dev-only: jump the mock to a named scripted state. No-op for the real driver. */
  runScript?(name: string): void;
  /** Dev/test-only reset. Mock drivers may skip their bootstrap fixture so the empty
   *  production landing can be exercised deterministically. No-op for real drivers. */
  reset?(opts?: { bootstrap?: boolean }): void;
}
