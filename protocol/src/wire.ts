// The pilot WebSocket envelope. Wraps the vendored session-driver event stream
// with connection bootstrap (snapshot-on-connect) and client commands.
//
// Events carry their own `sessionRef`. Client commands optionally carry a
// `sessionId` to target a specific session (D8 multi-session); omit it and the
// server applies the command to the currently-focused session.

import type {
  CommandInfo,
  HostUiResponse,
  ModelDefaults,
  ModelOption,
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
    }
  /** Which sessions currently have a live turn (D8 multi-session). Pushed whenever
   *  the running set changes, so background rows can show a running/done indicator
   *  without the client folding their (un-broadcast) event streams. */
  | { type: "sessionStatus"; runningIds: readonly SessionId[] }
  /** The models available to switch to (server-authoritative, like `sessionList`).
   *  The current selection rides each session's snapshot `config`, not this. */
  | { type: "modelList"; models: readonly ModelOption[] }
  /** The slash commands the focused session offers (extension/template/skill), for the
   *  composer's typeahead. Server-authoritative like `modelList`; re-broadcast on
   *  session switch because the set is cwd-scoped. See {@link CommandInfo}. */
  | { type: "commandList"; commands: readonly CommandInfo[] }
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
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "hello"; auth?: string }
  | {
      type: "prompt";
      text: string;
      deliverAs?: "steer" | "followUp";
      sessionId?: SessionId;
    }
  | { type: "abort"; sessionId?: SessionId }
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
  /** Create a fresh session and make it active. `cwd` (an absolute dir, D12
   *  arbitrary GUI paths) picks the workspace; omit it for the server's launch cwd.
   *  `worktree`: create an isolated jj/git worktree of `cwd` and run the session
   *  there, leaving the main tree clean (like the Claude app's worktree toggle). */
  | { type: "newSession"; cwd?: string; worktree?: boolean }
  /** Ask the server to re-scan disk and re-broadcast the session list. */
  | { type: "listSessions" }
  /** Archive or unarchive a session (by its .jsonl `path`, the stable switch key).
   *  The flag is pilot-side state (D-archive); the server persists it and re-broadcasts
   *  the session list so every client's active-only filter updates. */
  | { type: "setArchived"; path: string; archived: boolean }
  /** Ask the server to re-read the focused session's commands and re-broadcast them. */
  | { type: "listCommands" }
  /** Answer a project-trust card (D12). `choice` indexes the request's `options`;
   *  null denies (cancel / dismiss). */
  | { type: "trustResponse"; requestId: string; choice: number | null }
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
