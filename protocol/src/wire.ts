// The pilot WebSocket envelope. Wraps the vendored session-driver event stream
// with connection bootstrap (snapshot-on-connect) and client commands.
//
// Events carry their own `sessionRef`. Client commands optionally carry a
// `sessionId` to target a specific session (D8 multi-session); omit it and the
// server applies the command to the currently-focused session.

import type {
  CommandInfo,
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
} from "./session-driver.js";
import type { SessionState } from "./state.js";

export const PROTOCOL_VERSION = 1;

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
  | { type: "hello"; protocolVersion: number; serverId: string }
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
  /** File paths matching a composer @-mention query, returned by the server on
   *  demand (the client sends {@link queryFiles} on each keystroke after `@`,
   *  debounced). Re-broadcast per-query, not per-session — the client caches the
   *  empty-query result. The `query` field echoes the request so the client can
   *  ignore stale responses. See {@link FileInfo}. */
  | { type: "fileList"; query: string; files: readonly FileInfo[] }
  /** The model providers pilot can manage credentials for (curated key-capable +
   *  already-connected), server-authoritative like `modelList`. No secrets — see
   *  {@link ProviderInfo}. */
  | { type: "providerList"; providers: readonly ProviderInfo[] }
  /** pi's global model config: default model/thinking for new sessions + the
   *  favorites subset the header picker filters to. Distinct from a session's
   *  `config` (the CURRENT selection). See {@link ModelDefaults}. */
  | { type: "modelDefaults"; defaults: ModelDefaults }
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
   *  separate `swUpdateReady` "reload" toast. */
  | {
      type: "updateStatus";
      available: boolean;
      sha?: string;
      applying: boolean;
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
  | { type: "error"; message: string };

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
  /** Ask the server to re-scan providers + defaults and re-broadcast them. */
  | { type: "listProviders" }
  /** Switch the active session to this .jsonl path. */
  | { type: "openSession"; path: string }
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
  /** Ask the server to search for files matching a composer @-mention query (the text
   *  after `@`, empty for the initial list). The server responds with {@link fileList}.
   *  Debounce client-side (~150ms); the server echoes the query back so stale responses
   *  can be dropped. */
  | { type: "queryFiles"; query: string }
  /** Answer a project-trust card (D12). `choice` indexes the request's `options`;
   *  null denies (cancel / dismiss). */
  | { type: "trustResponse"; requestId: string; choice: number | null }
  /** Apply the staged desktop update now (the sidebar card's button). The server marks
   *  it applying and the update-watcher picks it up on its next poll — pull, rebuild,
   *  restart. No-op if nothing is staged. */
  | { type: "applyUpdate" }
  /** Dev-only: drive the mock fixture to a named scripted state. */
  | { type: "mock"; script: string }
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
