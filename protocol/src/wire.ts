// The pantoken WebSocket envelope. Wraps the vendored session-driver event stream
// with connection bootstrap (seed-on-connect + tail resume) and client commands.
//
// Events carry their own `sessionRef`. Client commands optionally carry a
// `sessionId` to target a specific session (D8 multi-session); omit it and the
// server applies the command to the currently-focused session.

import type {
  BackgroundJob,
  CommandInfo,
  FileInfo,
  HostUiResponse,
  ImageContent,
  ModelCatalogDiagnostic,
  ModelDefaults,
  ModelOption,
  PermissionMonitorMode,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
} from "./session-driver.js";
// Bump on any breaking client↔server wire change so the hello handshake fails
// loud (client/src/lib/store.svelte.ts mismatch guard) instead of a stale bundle
// silently dropping unparseable messages. History: 1→2 = journal-first seed
// (2026-07-03); 2→3 = the nine settings/context ClientMessage variants collapsed
// into the single `sessionAction` envelope (a stale client's old-shape
// setModel/compact/… now fail serde on the server).
export const PROTOCOL_VERSION = 3;

/** Pantoken-local settings (distinct from the daemon's global/session config). Persisted
 *  server-side in `pantoken-settings.json`, broadcast to every client, edited from the
 *  Settings panel. */
export interface PantokenSettings {
  /** Explicit login shell pantoken runs at startup to reconstruct your interactive
   *  environment (PATH, language-manager shims, exported vars) — the env a TUI tool
   *  inherits when launched from a terminal. `null` = use `$SHELL` / the OS login
   *  shell. A launchd daemon / GUI `.app` has no interactive-shell ancestor, so pantoken
   *  captures this once at boot; changing it applies on the NEXT server restart. */
  loginShell: string | null;
  /** Cheap "background model" spec for the tasks pantoken's own extensions run
   *  (session auto-naming, the answer tool's structured-extraction) — the model those
   *  out-of-band LLM calls use, separate from the session's primary model. Replaces
   *  the dotfiles `_lib/roles.mjs` per-role resolver.
   *
   *  Value: a daemon model spec `provider/model[:thinking]` (e.g.
   *  `anthropic/claude-haiku-4-5:low`), OR a `script:`-prefixed path whose stdout is
   *  such a spec (the escape hatch for an operator who wants their own resolver).
   *  `null` = unset; extensions fall back to a sensible default or no-op. The server
   *  resolves + validates this on read (see `resolveBackgroundModel`) and surfaces a
   *  loud `warning` to the Settings UI when the spec is bad — never silent. */
  backgroundModel: string | null;
}

/** Runtime status of pantoken's startup login-shell env capture, so the Settings panel
 *  can show what's ACTIVE now vs. what's configured (→ "restart to apply"). */
export interface LoginEnvStatus {
  /** Shell pantoken actually captured env from at startup, or null if capture was
   *  skipped (mock/dev) or never ran. */
  activeShell: string | null;
  /** Did the capture succeed? false → pantoken kept its minimal launch PATH. */
  ok: boolean;
  /** Human-readable outcome (var count, skip reason, or failure), for the panel. */
  detail?: string;
}

/** A directory's browsable contents for the new-session project picker. The server
 *  resolves `path` on ITS OWN filesystem (the agent runs server-side), so the picker browses
 *  the server, not whichever device the client runs on — a native browser file picker
 *  can't do that (it only sees the client device, and never yields a real path string).
 *  Files are omitted: you're choosing a working directory, so only child directories
 *  matter. The client sends {@link queryDir} and renders this as {@link dirListing}. */
export interface DirListing {
  /** The resolved absolute directory actually listed. Echoes the request so a client
   *  that has since navigated elsewhere can drop a stale response. */
  readonly path: string;
  /** The parent directory, or null when `path` is the filesystem root. */
  readonly parent: string | null;
  /** Child directory basenames, sorted (non-hidden first). Tap one to descend. */
  readonly entries: readonly string[];
  /** True when `path` couldn't be read (missing / not a directory / no permission).
   *  `entries` is then empty and the client surfaces the failure instead of showing
   *  it as an empty folder. */
  readonly error?: boolean;
}

/** A quick existence-and-type check for a path the user typed into the new-session
 *  dir picker, so the client can show an inline hint before the full directory listing
 *  arrives. The client sends {@link statPath} (debounced) and renders the reply as a
 *  validation cue. */
export interface PathStat {
  /** The resolved absolute path that was checked. Echoes the request. */
  readonly path: string;
  /** True when `path` exists on the server's filesystem. */
  readonly exists: boolean;
  /** True when `path` exists AND is a directory (implies `exists`). */
  readonly isDir: boolean;
}

/** Compact cross-session state for attention routing without broadcasting background
 * transcripts. `waiting` overrides the underlying run phase while dialogs are pending;
 * `done` remains useful until each client marks that session read locally. */
export interface SessionAttention {
  readonly sessionId: SessionId;
  readonly phase: "running" | "waiting" | "failed" | "done";
  readonly activity?: string;
  readonly pendingCount?: number;
  readonly pendingTitle?: string;
  readonly updatedAt: string;
}

export type ServerMessage =
  | {
      type: "hello";
      protocolVersion: number;
      serverId: string;
      dataDir: string;
      /** Full commit sha of the client bundle the server is SERVING (from
       *  dist/.pantoken-built-sha). A running client compares it against its own
       *  baked sha to detect that the server updated underneath it — the SW is
       *  byte-identical across builds, so `updatefound` alone never fires.
       *  Empty/absent when no build marker exists (dev). */
      buildSha?: string;
    }
  /** Heartbeat reply to a client `ping` — transport-level only (never folded or
   *  journaled), the same shape of message as `hello`. The client's ws layer already
   *  treats ANY inbound frame as proof of liveness, so `pong` carries no fields of its
   *  own; it exists purely to give a sent ping something to solicit. */
  | { type: "pong" }
  /** Seed-on-connect (protocol v2): the focused session's full transcript as
   *  EVENTS, which the client folds from a fresh `initialSessionState()` — the
   *  replacement for v1's folded-state `snapshot`, so no server-side fold is
   *  client-visible. `epoch` names this transcript build (bumped on reset /
   *  reload / re-attach; a resume across a bump is impossible); `seq` is the
   *  stamp of the last event folded into the seed — the client's resume
   *  watermark. `sessionId` is null for the empty landing (nothing focused;
   *  `events` is then empty and the client just resets). */
  | {
      type: "seed";
      sessionId: SessionId | null;
      epoch: number;
      seq: number;
      events: readonly SessionDriverEvent[];
    }
  /** One incremental driver event to fold, stamped with the journal watermark
   *  it advanced the session to. The client folds it only when `epoch` matches
   *  its adopted seed and `seq` is contiguous — an epoch mismatch is a stale
   *  frame racing a reseed (drop it), a seq gap is a lost frame (request a
   *  fresh seed rather than fold a diverged stream). */
  | { type: "event"; event: SessionDriverEvent; epoch: number; seq: number }
  /** The sessions available to open + which one is active (server-authoritative).
   *  Kept separate from the per-session `seed`/`event` stream because it's
   *  cross-session meta-state, not the folded transcript of the active session. */
  | {
      type: "sessionList";
      sessions: readonly SessionListEntry[];
      activeSessionId: SessionId | null;
      /** The cwd a bare new session defaults to when the operator doesn't pick one
       *  ($HOME). The client uses it to open the boot landing draft and as the
       *  new-session placeholder. Surfaced here (cross-session meta, like
       *  activeSessionId) so the client doesn't have to guess the server's $HOME. */
      defaultNewSessionCwd: string;
    }
  /** Which sessions currently have a live turn, and which are still warming up (D8
   *  multi-session). Pushed whenever either set changes, so background rows can show a
   *  running / initializing / done indicator without the client folding their
   *  (un-broadcast) event streams. `initializingIds` is optional on the wire so an older
   *  client tolerates its absence; the hub always sends it. */
  | {
      type: "sessionStatus";
      runningIds: readonly SessionId[];
      initializingIds?: readonly SessionId[];
      /** Current cross-session attention summaries. Optional for older servers/clients. */
      attention?: readonly SessionAttention[];
    }
  /** The models available to switch to (server-authoritative, like `sessionList`).
   *  The current selection rides each session's snapshot `config`, not this. When
   *  discovery degraded, `diagnostic` explains why the list is empty so the GUI can
   *  fail visibly instead of silently hiding the picker. */
  | {
      type: "modelList";
      models: readonly ModelOption[];
      diagnostic?: ModelCatalogDiagnostic;
    }
  /** The slash commands the focused session offers (extension/template/skill), for the
   *  composer's typeahead. Server-authoritative like `modelList`; re-broadcast on
   *  session switch because the set is cwd-scoped. See {@link CommandInfo}. */
  | { type: "commandList"; commands: readonly CommandInfo[] }
  /** The available facets for the focused session's cwd (for the FacetBadge picker).
   *  Pushed on connect + session switch like {@link commandList}. */
  | { type: "facetList"; facets: readonly string[] }
  /** Background jobs (subagent + shell) for the focused session. Broadcast on
   *  every snapshot refresh and on explicit {@link fetchJobs}. See
   *  {@link BackgroundJob}. */
  | { type: "jobsList"; jobs: readonly BackgroundJob[] }
  /** The full file index for the focused session's cwd, pushed on connect + session
   *  switch (like {@link commandList}). The client fuzzy-matches it locally so the
   *  @-mention menu is instant (no per-keystroke round-trip). Capped server-side;
   *  `truncated` is true when the cwd has more files than the cap, which is the only
   *  case the client falls back to a {@link queryFiles} search. See {@link FileInfo}. */
  | { type: "fileIndex"; files: readonly FileInfo[]; truncated: boolean }
  /** Skills + subagents available for the composer's `@skill:`/`@subagent:`
   *  reference autocomplete. Server-authoritative like {@link fileIndex}; pushed
   *  on connect and re-pushed on session switch (they're session/cwd-scoped). */
  | { type: "atRefs"; skills: readonly string[]; subagents: readonly string[] }
  /** File paths matching a composer @-mention query — the server-side `fd` *fallback*,
   *  used only when the {@link fileIndex} was truncated and local matches are thin (so a
   *  wanted file may live past the index cap). The client sends {@link queryFiles}
   *  (debounced); the `query` field echoes the request so stale responses are dropped.
   *  Merged into the local matches, deduped by path. See {@link FileInfo}.
   *
   *  `includeIgnored` echoes the request's flag (Shift+Tab picker toggle) — a second
   *  staleness guard alongside `query`: a toggled request must not be satisfied by a
   *  stale untoggled response (or vice versa) racing back after the toggle flipped. */
  | {
      type: "fileList";
      query: string;
      files: readonly FileInfo[];
      includeIgnored?: boolean;
    }
  /** A directory listing for the new-session project picker, in reply to {@link queryDir}.
   *  Carries the resolved `path` so a client that navigated on can drop a stale response.
   *  See {@link DirListing}. */
  | ({ type: "dirListing" } & DirListing)
  /** A path-existence check for the new-session dir picker's inline validation hint,
   *  in reply to {@link statPath}. Echoes the request `path` so the client can drop a
   *  stale response. See {@link PathStat}. */
  | ({ type: "pathStat" } & PathStat)
  /** the daemon's global model config: default model/thinking for new sessions + the
   *  favorites subset the header picker filters to. Distinct from a session's
   *  `config` (the CURRENT selection). See {@link ModelDefaults}. */
  | { type: "modelDefaults"; defaults: ModelDefaults }
  /** Pantoken-local settings + the live login-env capture status, for the Settings
   *  panel. Sent on connect and re-sent after `setLoginShell`/`setBackgroundModel`.
   *  `pendingRestart` is server-computed (the client can't resolve the server's default
   *  `$SHELL`): true when the shell pantoken WOULD use now differs from the one it actually
   *  captured with at boot — i.e. a restart is needed to apply the configured change.
   *  `backgroundModelWarning` is the server's resolution of `settings.backgroundModel`
   *  against the live model registry: present (non-empty) when the spec is bad or
   *  doesn't resolve — the Settings "Models" section surfaces it as a loud red error.
   *  Absent when the spec is unset or resolves cleanly. */
  | {
      type: "pantokenSettings";
      settings: PantokenSettings;
      env: LoginEnvStatus;
      pendingRestart: boolean;
      backgroundModelWarning?: string;
    }
  /** Desktop auto-update status (driven by the desktop shell's updater loop via the
   *  /update/state endpoint). `available` true means a new app version was downloaded but
   *  deferred because a client is connected — clients show the sidebar update card; `sha`
   *  carries the version string. `applying` flips true after a client clicks "update now"
   *  (the shell then installs the bundle and relaunches). NOT the PWA service-worker
   *  update — that's the separate `swUpdateReady` "reload" toast. */
  | {
      type: "updateStatus";
      available: boolean;
      sha?: string;
      applying: boolean;
    }
  /** Prefill the composer after a branch landed on a user prompt — navigateTree hands
   *  back that prompt's text for re-editing. Sent ONLY to the client that asked to
   *  branch (per-client composer state, never broadcast / folded into shared state). */
  | { type: "editorPrefill"; text: string }
  /** Acceptance result for a client-generated prompt id. `accepted` means the daemon's prompt
   *  preflight accepted/queued/handled it; later run failures still arrive normally. */
  | {
      type: "promptResult";
      promptId: string;
      accepted: boolean;
      sessionId?: SessionId;
      error?: string;
    }
  /** Text returned after atomically clearing the daemon's steering/follow-up queues. Sent only
   *  to the client that requested restore; the shared empty queue arrives as an event. */
  | {
      type: "queueRestored";
      steering: readonly string[];
      followUp: readonly string[];
    }
  /** After archiving a session whose cwd was a pantoken worktree, the server tried to reap
   *  it but kept it (it was dirty — uncommitted changes). Sent ONLY to the archiving
   *  client so its archived toast can explain the leftover and offer a force-delete.
   *  `path` == the worktree dir (== the session's cwd), the key `cleanupWorktree` takes. */
  | { type: "worktreeRetained"; path: string; reason: string }
  /** Correlated outcome for one stop attempt. `accepted` means the daemon accepted
   *  the request; the transcript still has to receive a terminal event before the
   *  client may call the turn stopped. */
  | {
      type: "abortResult";
      requestId?: string;
      accepted: boolean;
      error?: string;
    }
  | { type: "error"; message: string; kind?: "session-switch" | "abort" };

/** Tail-resume request: "I still hold {sessionId} folded through {epoch, seq}".
 *  Carried on the reconnect hello; when the server's journal epoch matches and
 *  its ring still covers the gap, it replays only the missed stamped events
 *  instead of re-shipping the whole transcript — the cost that hurts on every
 *  phone wake over LTE. Any mismatch degrades to a full seed, never an error. */
export interface ResumeToken {
  readonly sessionId: SessionId;
  readonly epoch: number;
  readonly seq: number;
}

/** The fire-and-forget pass-through actions carried by the `sessionAction`
 *  ClientMessage. They share one lifecycle: POST to the daemon, no direct
 *  reply — the effect arrives as later driver events. Daemon endpoints:
 *  POST /adventurous-handoff (toggle), /notifications/autodrain, /compact,
 *  /clear (context + shell env), /mcp/{server}/{action}. */
export type SessionAction =
  | { kind: "toggleAdventurousHandoff" }
  | { kind: "setNotificationAutodrain"; enabled: boolean }
  | { kind: "compact" }
  | { kind: "clearContext" }
  | {
      kind: "setMcpServer";
      serverName: string;
      action: "enable" | "disable" | "disconnect" | "reconnect";
    }
  | { kind: "setModel"; provider: string; modelId: string }
  | { kind: "setThinking"; level: string }
  | { kind: "setFacet"; facet: string }
  | { kind: "setPermissionMonitor"; mode: PermissionMonitorMode };

export type ClientMessage =
  | { type: "hello"; auth?: string; resume?: ResumeToken }
  | {
      type: "prompt";
      /** Stable client-generated id used for ACK/retry reconciliation and deduplication. */
      promptId?: string;
      text: string;
      images?: readonly ImageContent[];
      deliverAs?: "steer" | "followUp";
      sessionId?: SessionId;
    }
  | {
      type: "abort";
      /** Correlates this request with its `abortResult`, so a late response cannot
       *  overwrite the state of a retry or a subsequently-started turn. */
      requestId?: string;
      sessionId?: SessionId;
    }
  /** Clear every pending steering/follow-up message and restore their text to this
   *  client's editor (Pi parity: Alt+Up). */
  | { type: "restoreQueue"; sessionId?: SessionId }
  | { type: "respondUi"; response: HostUiResponse; sessionId?: SessionId }
  /** The data-driven envelope for fire-and-forget session actions that share one
   *  shape: a daemon POST whose effect arrives via later events (snapshots,
   *  notifications, usage updates) — no direct reply. Adding an action = one
   *  `SessionAction` variant + one arm per driver; the hub routes them all
   *  identically. Omit sessionId to target the focused session. */
  | { type: "sessionAction"; action: SessionAction; sessionId?: SessionId }
  /** Set the explicit login shell pantoken captures env from at startup (null = the
   *  `$SHELL` / OS-login-shell default). Persists server-side; the env is captured
   *  once at boot, so it applies on the next server restart. The server re-broadcasts
   *  `pantokenSettings`. */
  | { type: "setLoginShell"; path: string | null }
  /** Set the background-model spec pantoken's own extensions run their cheap out-of-band
   *  LLM calls against (null = unset; extensions fall back). A `provider/model[:thinking]`
   *  spec OR a `script:`-prefixed path. Persists server-side; the server resolves +
   *  re-broadcasts `pantokenSettings` (carrying any validation `warning` for a bad spec). */
  | { type: "setBackgroundModel"; spec: string | null }
  /** Switch the active session to this .jsonl path. */
  | { type: "openSession"; path: string }
  /** Reload a session from scratch (by its .jsonl `path`): dispose the warm session
   *  (aborting any in-flight run) and re-warm it from disk, rebuilding the session's context anew —
   *  config, project trust, and extensions all loaded fresh. Restores the persisted
   *  transcript as closely as possible; in-memory-only state (an undelivered steer/followUp
   *  queue, an un-persisted branch jump) is lost. The recovery path for when an extension
   *  bug wedges a session: fix the extension elsewhere, then reload here to continue without
   *  restarting pantoken. The server re-seeds every client viewing the session. */
  | { type: "reloadSession"; path: string }
  /** Jump the session to a prior tree entry and branch from it (the daemon's /tree). `entryId`
   *  is a pantoken transcript item's `entryId` (a daemon tree node). The server calls
   *  navigateTree, then re-seeds every client's transcript to the new branch; if the
   *  target was a user prompt, the requester also gets an `editorPrefill` with its text.
   *  `summarize` asks the daemon to summarize the abandoned branch first (an LLM call) — the UI
   *  ships without it, but the flag is carried so the summarize path is additive later.
   *  Omit sessionId to target the focused session. */
  | {
      type: "branch";
      entryId: string;
      summarize?: boolean;
      sessionId?: SessionId;
    }
  /** Create a fresh session and make it active. `cwd` (an absolute dir, D12
   *  arbitrary GUI paths) picks the workspace; omit it for $HOME.
   *  `worktree`: create an isolated jj/git worktree of `cwd` and run the session
   *  there, leaving the main tree clean (like the Claude app's worktree toggle).
   *  `model`/`thinking`: apply this model + thinking level at creation, so the
   *  new-session draft's config carries through without mutating the daemon's global
   *  defaults. `prompt`: deliver this as the first message once the session is
   *  active — creation + first turn ride one message, so nothing is created on the
   *  server until the user actually sends (the draft lives client-side until then). */
  | {
      type: "newSession";
      cwd?: string;
      worktree?: boolean;
      model?: { provider: string; modelId: string };
      thinking?: string;
      /** Apply this facet at creation (draft-picked, e.g. start straight in plan). */
      facet?: string;
      /** Permission-monitor mode to apply at creation. Omitted/"standard" = daemon default. */
      permissionMonitor?: PermissionMonitorMode;
      prompt?: string;
      /** Id of the optional first prompt; deduplicates a retried create+send request. */
      promptId?: string;
      images?: readonly ImageContent[];
    }
  /** Ask the server to re-scan disk and re-broadcast the session list. */
  | { type: "listSessions" }
  /** Archive or unarchive a session (by its .jsonl `path`, the stable switch key).
   *  The flag is pantoken-side state (D-archive); the server persists it and re-broadcasts
   *  the session list so every client's active-only filter updates. Archiving a session
   *  whose cwd is a pantoken-created worktree also reaps that worktree when it's clean. */
  | { type: "setArchived"; path: string; archived: boolean }
  /** Rename a session (by its .jsonl `path`). Writes the daemon's session display name (a
   *  `session_info` entry); the server re-broadcasts the session list so every client's
   *  sidebar updates, and a warm session's header title updates live. Empty `name` is a
   *  no-op server-side (the client shouldn't submit one). */
  | { type: "renameSession"; path: string; name: string }
  /** Remove a pantoken-created worktree (by its `path` == the session's cwd). `force`
   *  discards uncommitted changes; without it the server refuses a dirty worktree and
   *  reports back. The server re-broadcasts the session list (clearing the indicator). */
  | { type: "cleanupWorktree"; path: string; force?: boolean }
  /** Ask the server to re-read the focused session's commands and re-broadcast them. */
  | { type: "listCommands" }
  /** Ask the server to re-read the focused session's available facets and
   *  re-broadcast them (reload affordance for the FacetBadge picker). */
  | { type: "listFacets" }
  /** Ask the server to re-fetch the daemon's background jobs list and
   *  re-broadcast it (reload affordance for the RightSidebar jobs section). */
  | { type: "fetchJobs" }
  /** Delete a todo by its integer ID. The daemon returns 409 if other todos
   *  depend on it or a turn is in flight; the server surfaces that as an error. */
  | { type: "deleteTodo"; id: number }
  /** Fallback file search for a composer @-mention query (the text after `@`). Only sent
   *  when the {@link fileIndex} was truncated and local matches are thin — the common case
   *  is served entirely client-side from the index. The server responds with {@link fileList}.
   *  Debounce client-side (~150ms); the server echoes the query back so stale responses
   *  can be dropped. `cwd` overrides the search root: a new-session draft has no session yet,
   *  so its @-mentions must search the soon-to-be project dir, not the previously focused
   *  session's cwd (which the pushed index reflects). Omitted -> the focused session's cwd.
   *
   *  `includeIgnored`: the picker's Shift+Tab toggle — when true, hidden dotfiles and
   *  gitignored entries are included too (project AND external browsing), bypassing the
   *  normal ignore-file filtering. Omitted/false is the default (filtered) behavior. */
  | {
      type: "queryFiles";
      query: string;
      cwd?: string;
      includeIgnored?: boolean;
    }
  /** Browse a directory on the SERVER's filesystem for the new-session project picker.
   *  `path` omitted/empty -> the server's $HOME; `~`/relative segments are resolved
   *  server-side. The server responds with {@link dirListing}. */
  | { type: "queryDir"; path?: string }
  /** Check whether a typed path exists on the server — a quick stat for the new-session
   *  dir picker's inline validation hint (debounced). The server responds with
   *  {@link pathStat}. */
  | { type: "statPath"; path: string }
  /** Apply the staged desktop update now (the sidebar card's button). The server marks
   *  it applying and the shell's updater picks it up on its next /update/state poll —
   *  install the bundle, relaunch. No-op if nothing is staged. */
  | { type: "applyUpdate" }
  /** Force an update check *now* (the build-stamp right-click menu), for clicking right
   *  after publishing a release — before the updater's next periodic check has noticed.
   *  Unlike `applyUpdate` it's NOT a no-op when nothing is staged: it flags a force the
   *  shell reads on its next poll, then immediately checks and applies if a new version
   *  exists. No-op only if the app is already current. */
  | { type: "forceUpdate" }
  /** Client-detected desync (an event-seq gap): ask for a fresh seed of the
   *  targeted session (omitted -> this connection's focus) instead of folding
   *  a diverged stream. */
  | { type: "requestSeed"; sessionId?: SessionId }
  /** Dev-only: drive the mock fixture to a named scripted state. */
  | { type: "mock"; script: string }
  /** Reveal the server's data directory in the platform file manager (Finder on macOS).
   *  The client can't spawn processes, so this is a server-side action. The server
   *  best-efforts the spawn; a failure surfaces as an `error` message (e.g. on a
   *  headless/remote host with no GUI). The path itself is already known to the client
   *  via `hello.dataDir`, so copying it is local and needs no round-trip. */
  | { type: "openDataDir" }
  /** Heartbeat probe: sent on an interval while connected (and once immediately on a
   *  wake — tab foregrounded, bfcache restore, network back online) to catch a
   *  half-open socket that TCP itself may never surface (phone slept, NAT dropped the
   *  stream, no FIN/RST ever arrives). The server replies with `pong`; the client
   *  actually treats ANY inbound frame as liveness, so this mostly exists to solicit
   *  one on a schedule. */
  | { type: "ping" };

/** Parse a raw WS frame into a typed message, or null on bad JSON / missing `type`.
 *  The two wire envelopes (client + server) are structurally identical, so one
 *  generic parser backs both public functions. */
function parseMessage<T extends { type: string }>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.type === "string") return v as T;
  } catch {
    /* drop */
  }
  return null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  return parseMessage<ClientMessage>(raw);
}

export function parseServerMessage(raw: string): ServerMessage | null {
  return parseMessage<ServerMessage>(raw);
}
