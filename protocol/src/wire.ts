// The pilot WebSocket envelope. Wraps the vendored session-driver event stream
// with connection bootstrap (snapshot-on-connect) and client commands.
//
// Events carry their own `sessionRef`. Client commands optionally carry a
// `sessionId` to target a specific session (D8 multi-session); omit it and the
// server applies the command to the currently-focused session.

import type {
  CommandInfo,
  ExtensionInfo,
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
  TreeNodeInfo,
} from "./session-driver.js";
import type { SessionState } from "./state.js";

export const PROTOCOL_VERSION = 1;

/** Pilot-local settings (distinct from pi's global/session config). Persisted
 *  server-side in `pilot-settings.json`, broadcast to every client, edited from the
 *  Settings panel. */
export interface PilotSettings {
  /** Explicit login shell pilot runs at startup to reconstruct your interactive
   *  environment (PATH, language-manager shims, exported vars) — the env a TUI tool
   *  inherits when launched from a terminal. `null` = use `$SHELL` / the OS login
   *  shell. A launchd daemon / GUI `.app` has no interactive-shell ancestor, so pilot
   *  captures this once at boot; changing it applies on the NEXT server restart. */
  loginShell: string | null;
  /** Cheap "background model" spec for the tasks pilot's own extensions run
   *  (session auto-naming, the answer tool's structured-extraction) — the model those
   *  out-of-band LLM calls use, separate from the session's primary model. Replaces
   *  the dotfiles `_lib/roles.mjs` per-role resolver.
   *
   *  Value: a pi model spec `provider/model[:thinking]` (e.g.
   *  `anthropic/claude-haiku-4-5:low`), OR a `script:`-prefixed path whose stdout is
   *  such a spec (the escape hatch for an operator who wants their own resolver).
   *  `null` = unset; extensions fall back to a sensible default or no-op. The server
   *  resolves + validates this on read (see `resolveBackgroundModel`) and surfaces a
   *  loud `warning` to the Settings UI when the spec is bad — never silent. */
  backgroundModel: string | null;
  /** Pilot's own enabled/disabled set for the OWNED extension paths (the
   *  `additionalExtensionPaths` entries — session-namer now, answer/tasklist in Chunks
   *  3/4). pi's `-<path>` force-exclude override is a NO-OP on those (Chunk 0 finding),
   *  so pilot maintains its own set and omits disabled owned paths from the array in
   *  `warmUp`. `null` = all owned enabled (the default); an array = the enabled subset
   *  by basename (e.g. `["session-namer"]`) — the operator thinks in names, not paths.
   *  User/project extensions keep pi's force-exclude toggle unchanged. */
  enabledExtensions: string[] | null;
}

/** Runtime status of pilot's startup login-shell env capture, so the Settings panel
 *  can show what's ACTIVE now vs. what's configured (→ "restart to apply"). */
export interface LoginEnvStatus {
  /** Shell pilot actually captured env from at startup, or null if capture was
   *  skipped (mock/dev) or never ran. */
  activeShell: string | null;
  /** Did the capture succeed? false → pilot kept its minimal launch PATH. */
  ok: boolean;
  /** Human-readable outcome (var count, skip reason, or failure), for the panel. */
  detail?: string;
}

/** One choice on the project-trust card (D12). The label is display-only; the index
 *  into a request's `options` is what the client sends back. `trusted` lets the card
 *  style allow-vs-deny without parsing the label. */
export interface TrustRequestOption {
  readonly label: string;
  readonly trusted: boolean;
}

/**
 * An interactive project-trust decision (D12). Travels OUT OF BAND — not as a
 * `SessionDriverEvent` — because trust resolves inside the driver's session warm-up,
 * before that session (and its UI bridge) exists and while the hub is mid-swap
 * (`switching`), so it can't ride the per-session event/fold path. It's a per-cwd
 * question by nature: "may pi load this folder's .pi resources?".
 */
export interface TrustRequest {
  readonly requestId: string;
  readonly cwd: string;
  readonly title: string;
  readonly options: readonly TrustRequestOption[];
}

/** A directory's browsable contents for the new-session project picker. The server
 *  resolves `path` on ITS OWN filesystem (pi runs server-side), so the picker browses
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
    }
  /** Full authoritative state — sent on (re)connect so clients catch up. */
  | { type: "snapshot"; state: SessionState }
  /** One incremental driver event to fold. */
  | { type: "event"; event: SessionDriverEvent }
  /** The sessions available to open + which one is active (server-authoritative).
   *  Kept separate from `snapshot` because it's cross-session meta-state, not the
   *  folded transcript of the active session. */
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
   *  The current selection rides each session's snapshot `config`, not this. */
  | { type: "modelList"; models: readonly ModelOption[] }
  /** The slash commands the focused session offers (extension/template/skill), for the
   *  composer's typeahead. Server-authoritative like `modelList`; re-broadcast on
   *  session switch because the set is cwd-scoped. See {@link CommandInfo}. */
  | { type: "commandList"; commands: readonly CommandInfo[] }
  /** The focused session's full branch tree (pi's /tree). Sent on demand when a client
   *  opens the tree view (it sends {@link queryTree}) and re-broadcast after a `branch` so
   *  an open tree view refreshes. `sessionId` is the session the tree belongs to, so a
   *  client that has since switched away can drop a late tree. See {@link TreeNodeInfo}. */
  | {
      type: "treeState";
      sessionId: SessionId | null;
      nodes: readonly TreeNodeInfo[];
      leafId: string | null;
    }
  /** The focused session's pi extensions (loaded + any pilot-disabled), for the Settings
   *  "Extensions" view. Sent on demand when a client expands that section (it sends
   *  {@link queryExtensions}) and re-sent after a {@link setExtensionEnabled} toggle.
   *  `sessionId` is the session the list belongs to, so a client that switched away can
   *  drop a late list. See {@link ExtensionInfo}. */
  | {
      type: "extensionList";
      sessionId: SessionId | null;
      extensions: readonly ExtensionInfo[];
    }
  /** The full file index for the focused session's cwd, pushed on connect + session
   *  switch (like {@link commandList}). The client fuzzy-matches it locally so the
   *  @-mention menu is instant (no per-keystroke round-trip). Capped server-side;
   *  `truncated` is true when the cwd has more files than the cap, which is the only
   *  case the client falls back to a {@link queryFiles} search. See {@link FileInfo}. */
  | { type: "fileIndex"; files: readonly FileInfo[]; truncated: boolean }
  /** File paths matching a composer @-mention query — the server-side `fd` *fallback*,
   *  used only when the {@link fileIndex} was truncated and local matches are thin (so a
   *  wanted file may live past the index cap). The client sends {@link queryFiles}
   *  (debounced); the `query` field echoes the request so stale responses are dropped.
   *  Merged into the local matches, deduped by path. See {@link FileInfo}. */
  | { type: "fileList"; query: string; files: readonly FileInfo[] }
  /** A directory listing for the new-session project picker, in reply to {@link queryDir}.
   *  Carries the resolved `path` so a client that navigated on can drop a stale response.
   *  See {@link DirListing}. */
  | ({ type: "dirListing" } & DirListing)
  /** A path-existence check for the new-session dir picker's inline validation hint,
   *  in reply to {@link statPath}. Echoes the request `path` so the client can drop a
   *  stale response. See {@link PathStat}. */
  | ({ type: "pathStat" } & PathStat)
  /** The model providers pilot can manage credentials for (curated key-capable +
   *  already-connected), server-authoritative like `modelList`. No secrets — see
   *  {@link ProviderInfo}. */
  | { type: "providerList"; providers: readonly ProviderInfo[] }
  /** pi's global model config: default model/thinking for new sessions + the
   *  favorites subset the header picker filters to. Distinct from a session's
   *  `config` (the CURRENT selection). See {@link ModelDefaults}. */
  | { type: "modelDefaults"; defaults: ModelDefaults }
  /** Pilot-local settings + the live login-env capture status, for the Settings
   *  panel. Sent on connect and re-sent after `setLoginShell`/`setBackgroundModel`.
   *  `pendingRestart` is server-computed (the client can't resolve the server's default
   *  `$SHELL`): true when the shell pilot WOULD use now differs from the one it actually
   *  captured with at boot — i.e. a restart is needed to apply the configured change.
   *  `backgroundModelWarning` is the server's resolution of `settings.backgroundModel`
   *  against the live model registry: present (non-empty) when the spec is bad or
   *  doesn't resolve — the Settings "Models" section surfaces it as a loud red error.
   *  Absent when the spec is unset or resolves cleanly. */
  | {
      type: "pilotSettings";
      settings: PilotSettings;
      env: LoginEnvStatus;
      pendingRestart: boolean;
      backgroundModelWarning?: string;
    }
  /** Surface an interactive project-trust card (D12). Broadcast to every client; the
   *  first answer wins. Carried as its own message — see {@link TrustRequest}. */
  | ({ type: "trustRequest" } & TrustRequest)
  /** A pending trust card was settled (answered, or denied on timeout/disconnect).
   *  Clients dismiss the card for this requestId. */
  | { type: "trustResolved"; requestId: string }
  /** Desktop auto-update status (driven by scripts/desktop/update-watcher.ts via the
   *  /update/state endpoint). `available` true means a new origin/main was staged but
   *  deferred because a client is connected — clients show the sidebar update card.
   *  `applying` flips true after a client clicks "update now" (the watcher then pulls,
   *  rebuilds, and restarts the server). NOT the PWA service-worker update — that's the
   *  separate `swUpdateReady` "reload" toast.
   *
   *  `desktopStale` is independent of `available`: it's true when the running Pilot.app's
   *  native shell (`desktop/`) differs from the clone's checked-out `HEAD:desktop` — i.e. the
   *  binary you're running no longer matches its source and needs a manual `build-app.sh`
   *  rebuild (the TS auto-update can't replace the .app — see desktop/README). Drives the
   *  durable "rebuild" dot on the sidebar build stamp; only ever set under the desktop app
   *  (the watcher knows the running bundle's stamp), so it stays false in a plain browser. */
  | {
      type: "updateStatus";
      available: boolean;
      sha?: string;
      applying: boolean;
      desktopStale?: boolean;
    }
  /** A step in an in-progress OAuth login needs the operator's answer (open a URL +
   *  paste the code, or pick a login method). Broadcast to every client; the first
   *  `oauthRespond` with a matching requestId wins. See {@link OAuthLoginPrompt}. */
  | {
      type: "oauthPrompt";
      requestId: string;
      providerId: string;
      prompt: OAuthLoginPrompt;
    }
  /** Progress text for an in-progress OAuth login (e.g. "Exchanging code for tokens…"). */
  | { type: "oauthProgress"; providerId: string; message: string }
  /** A device-code OAuth login wants the operator to open a URL and enter a code; the
   *  flow then completes by background polling. See {@link OAuthDeviceInfo}. */
  | ({ type: "oauthDeviceCode"; providerId: string } & OAuthDeviceInfo)
  /** A pending OAuth prompt settled (answered elsewhere, cancelled, or timed out).
   *  Clients dismiss the prompt for this requestId. */
  | { type: "oauthResolved"; requestId: string }
  /** An OAuth login finished — `ok` once credentials are stored, else `error` says why.
   *  Clients close the flow; the provider + model lists re-broadcast alongside. */
  | { type: "oauthResult"; providerId: string; ok: boolean; error?: string }
  /** Prefill the composer after a branch landed on a user prompt — navigateTree hands
   *  back that prompt's text for re-editing. Sent ONLY to the client that asked to
   *  branch (per-client composer state, never broadcast / folded into shared state). */
  | { type: "editorPrefill"; text: string }
  /** Acceptance result for a client-generated prompt id. `accepted` means pi's prompt
   *  preflight accepted/queued/handled it; later run failures still arrive normally. */
  | {
      type: "promptResult";
      promptId: string;
      accepted: boolean;
      sessionId?: SessionId;
      error?: string;
    }
  /** Text returned after atomically clearing pi's steering/follow-up queues. Sent only
   *  to the client that requested restore; the shared empty queue arrives as an event. */
  | {
      type: "queueRestored";
      steering: readonly string[];
      followUp: readonly string[];
    }
  /** After archiving a session whose cwd was a pilot worktree, the server tried to reap
   *  it but kept it (it was dirty — uncommitted changes). Sent ONLY to the archiving
   *  client so its archived toast can explain the leftover and offer a force-delete.
   *  `path` == the worktree dir (== the session's cwd), the key `cleanupWorktree` takes. */
  | { type: "worktreeRetained"; path: string; reason: string }
  | { type: "error"; message: string; kind?: "session-switch" };

export type ClientMessage =
  | { type: "hello"; auth?: string }
  | {
      type: "prompt";
      /** Stable client-generated id used for ACK/retry reconciliation and deduplication. */
      promptId?: string;
      text: string;
      images?: readonly ImageContent[];
      deliverAs?: "steer" | "followUp";
      sessionId?: SessionId;
    }
  | { type: "abort"; sessionId?: SessionId }
  /** Clear every pending steering/follow-up message and restore their text to this
   *  client's editor (Pi parity: Alt+Up). */
  | { type: "restoreQueue"; sessionId?: SessionId }
  | { type: "respondUi"; response: HostUiResponse; sessionId?: SessionId }
  /** Switch a session's model. Omit sessionId to target the focused session. */
  | {
      type: "setModel";
      provider: string;
      modelId: string;
      sessionId?: SessionId;
    }
  /** Switch a session's thinking level. Omit sessionId to target the focused one. */
  | { type: "setThinking"; level: string; sessionId?: SessionId }
  /** Save an API key for a provider (writes pi's auth.json — shared with terminal
   *  pi). The server refreshes the model registry and re-broadcasts provider/model
   *  lists; a failure (unsupported provider / empty key) comes back as `error`. */
  | { type: "setProviderApiKey"; providerId: string; apiKey: string }
  /** Remove a pilot-saved API key for a provider (auth_file source only). */
  | { type: "removeProviderApiKey"; providerId: string }
  /** Start an interactive OAuth login for a provider (pi's OAuth registry). The server
   *  drives the flow — surfacing `oauthPrompt`/`oauthProgress`/`oauthDeviceCode` and
   *  finishing with `oauthResult` — then re-broadcasts the provider + model lists. */
  | { type: "oauthLogin"; providerId: string }
  /** Answer the current OAuth prompt. `value` is the pasted code/URL or the selected
   *  option id; null cancels the login. First matching answer wins (others no-op). */
  | { type: "oauthRespond"; requestId: string; value: string | null }
  /** Sign out of an OAuth provider (clears its stored credentials in auth.json). */
  | { type: "oauthLogout"; providerId: string }
  /** Set pi's global default model for NEW sessions (not the current one). */
  | { type: "setDefaultModel"; provider: string; modelId: string }
  /** Set pi's global default thinking level for NEW sessions. */
  | { type: "setDefaultThinking"; level: string }
  /** Replace the favorites subset. `refs` are `provider:modelId`; empty clears the
   *  filter (header picker shows every model again). */
  | { type: "setFavoriteModels"; refs: readonly string[] }
  /** Set the explicit login shell pilot captures env from at startup (null = the
   *  `$SHELL` / OS-login-shell default). Persists server-side; the env is captured
   *  once at boot, so it applies on the next server restart. The server re-broadcasts
   *  `pilotSettings`. */
  | { type: "setLoginShell"; path: string | null }
  /** Set the background-model spec pilot's own extensions run their cheap out-of-band
   *  LLM calls against (null = unset; extensions fall back). A `provider/model[:thinking]`
   *  spec OR a `script:`-prefixed path. Persists server-side; the server resolves +
   *  re-broadcasts `pilotSettings` (carrying any validation `warning` for a bad spec). */
  | { type: "setBackgroundModel"; spec: string | null }
  /** Ask the server to re-scan providers + defaults and re-broadcast them. */
  | { type: "listProviders" }
  /** Switch the active session to this .jsonl path. */
  | { type: "openSession"; path: string }
  /** Reload a session from scratch (by its .jsonl `path`): dispose the warm pi session
   *  (aborting any in-flight run) and re-warm it from disk, rebuilding pi's context anew —
   *  config, project trust, and extensions all loaded fresh. Restores the persisted
   *  transcript as closely as possible; in-memory-only state (an undelivered steer/followUp
   *  queue, an un-persisted branch jump) is lost. The recovery path for when an extension
   *  bug wedges a session: fix the extension elsewhere, then reload here to continue without
   *  restarting pilot. The server re-seeds every client viewing the session. */
  | { type: "reloadSession"; path: string }
  /** Jump the session to a prior tree entry and branch from it (pi's /tree). `entryId`
   *  is a pilot transcript item's `entryId` (a pi tree node). The server calls
   *  navigateTree, then re-seeds every client's transcript to the new branch; if the
   *  target was a user prompt, the requester also gets an `editorPrefill` with its text.
   *  `summarize` asks pi to summarize the abandoned branch first (an LLM call) — the UI
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
   *  new-session draft's config carries through without mutating pi's global
   *  defaults. `prompt`: deliver this as the first message once the session is
   *  active — creation + first turn ride one message, so nothing is created on the
   *  server until the user actually sends (the draft lives client-side until then). */
  | {
      type: "newSession";
      cwd?: string;
      worktree?: boolean;
      model?: { provider: string; modelId: string };
      thinking?: string;
      prompt?: string;
      /** Id of the optional first prompt; deduplicates a retried create+send request. */
      promptId?: string;
      images?: readonly ImageContent[];
    }
  /** Ask the server to re-scan disk and re-broadcast the session list. */
  | { type: "listSessions" }
  /** Archive or unarchive a session (by its .jsonl `path`, the stable switch key).
   *  The flag is pilot-side state (D-archive); the server persists it and re-broadcasts
   *  the session list so every client's active-only filter updates. Archiving a session
   *  whose cwd is a pilot-created worktree also reaps that worktree when it's clean. */
  | { type: "setArchived"; path: string; archived: boolean }
  /** Rename a session (by its .jsonl `path`). Writes pi's session display name (a
   *  `session_info` entry); the server re-broadcasts the session list so every client's
   *  sidebar updates, and a warm session's header title updates live. Empty `name` is a
   *  no-op server-side (the client shouldn't submit one). */
  | { type: "renameSession"; path: string; name: string }
  /** Remove a pilot-created worktree (by its `path` == the session's cwd). `force`
   *  discards uncommitted changes; without it the server refuses a dirty worktree and
   *  reports back. The server re-broadcasts the session list (clearing the indicator). */
  | { type: "cleanupWorktree"; path: string; force?: boolean }
  /** Ask the server to re-read the focused session's commands and re-broadcast them. */
  | { type: "listCommands" }
  /** Ask the server for the focused session's branch tree (the tree view just opened).
   *  The server responds with {@link treeState}. Omit sessionId to target the focused one. */
  | { type: "queryTree"; sessionId?: SessionId }
  /** Ask the server for the focused session's extension list (the Settings "Extensions"
   *  section just expanded). The server responds with {@link extensionList}. Omit sessionId
   *  to target the focused one. */
  | { type: "queryExtensions"; sessionId?: SessionId }
  /** Enable or disable a pi extension by its `resolvedPath` (writes a force-exclude override
   *  to pi's user settings). pi loads extensions at session START, so this applies on the
   *  session's NEXT start, not live — the UI labels it so. The server persists, then re-sends
   *  {@link extensionList}. Omit sessionId to target the focused session. */
  | {
      type: "setExtensionEnabled";
      resolvedPath: string;
      enabled: boolean;
      sessionId?: SessionId;
    }
  /** Fallback file search for a composer @-mention query (the text after `@`). Only sent
   *  when the {@link fileIndex} was truncated and local matches are thin — the common case
   *  is served entirely client-side from the index. The server responds with {@link fileList}.
   *  Debounce client-side (~150ms); the server echoes the query back so stale responses
   *  can be dropped. `cwd` overrides the search root: a new-session draft has no session yet,
   *  so its @-mentions must search the soon-to-be project dir, not the previously focused
   *  session's cwd (which the pushed index reflects). Omitted -> the focused session's cwd. */
  | { type: "queryFiles"; query: string; cwd?: string }
  /** Browse a directory on the SERVER's filesystem for the new-session project picker.
   *  `path` omitted/empty -> the server's $HOME; `~`/relative segments are resolved
   *  server-side. The server responds with {@link dirListing}. */
  | { type: "queryDir"; path?: string }
  /** Check whether a typed path exists on the server — a quick stat for the new-session
   *  dir picker's inline validation hint (debounced). The server responds with
   *  {@link pathStat}. */
  | { type: "statPath"; path: string }
  /** Answer a project-trust card (D12). `choice` indexes the request's `options`;
   *  null denies (cancel / dismiss). */
  | { type: "trustResponse"; requestId: string; choice: number | null }
  /** Apply the staged desktop update now (the sidebar card's button). The server marks
   *  it applying and the update-watcher picks it up on its next poll — pull, rebuild,
   *  restart. No-op if nothing is staged. */
  | { type: "applyUpdate" }
  /** Force an update *now* (the build-stamp right-click menu), for clicking right after a
   *  push to main — before the watcher's next ~60s fetch has even noticed the new commit.
   *  Unlike `applyUpdate` it's NOT a no-op when nothing is staged: it flags a force the
   *  watcher reads on its next poll, then immediately fetches and applies if origin/main
   *  moved (pull → rebuild → restart). No-op only if the clone is already current. */
  | { type: "forceUpdate" }
  /** Dev-only: drive the mock fixture to a named scripted state. */
  | { type: "mock"; script: string }
  /** Reveal the server's data directory in the platform file manager (Finder on macOS).
   *  The client can't spawn processes, so this is a server-side action. The server
   *  best-efforts the spawn; a failure surfaces as an `error` message (e.g. on a
   *  headless/remote host with no GUI). The path itself is already known to the client
   *  via `hello.dataDir`, so copying it is local and needs no round-trip. */
  | { type: "openDataDir" }
  | { type: "ping" };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.type === "string")
      return v as ClientMessage;
  } catch {
    /* drop */
  }
  return null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.type === "string")
      return v as ServerMessage;
  } catch {
    /* drop */
  }
  return null;
}
