// The seam between the WS hub and whatever produces session events. The mock
// driver and the real pi-sdk driver both implement this, so the hub never changes
// when we swap the fixture for a live agent.

import type {
  CommandInfo,
  HostUiResponse,
  ModelDefaults,
  ModelOption,
  ProviderInfo,
  SessionDriverEvent,
  SessionId,
  SessionListEntry,
  TrustRequest,
} from "@pilot/protocol";

/** What the driver's trust channel emits: a card to surface, or a settle signal so
 *  clients dismiss it (D12). Kept off the SessionDriverEvent stream because trust is
 *  decided before a session exists and while the hub suppresses session events. */
export type TrustEvent =
  | { kind: "request"; request: TrustRequest }
  | { kind: "resolved"; requestId: string };

export interface PilotDriver {
  subscribe(listener: (ev: SessionDriverEvent) => void): () => void;
  // sessionId targets a specific (warm) session; omit it to act on the session
  // the driver currently treats as active. Single-session drivers ignore it.
  prompt(
    text: string,
    deliverAs?: "steer" | "followUp",
    sessionId?: SessionId,
  ): void;
  abort(sessionId?: SessionId): void;
  respondUi(response: HostUiResponse, sessionId?: SessionId): void;

  /** Sessions on disk available to open (D13: pi's .jsonl files are authoritative). */
  listSessions(): Promise<SessionListEntry[]>;
  /**
   * Switch the active session to the given .jsonl path. Resolves with the SEED
   * events (a `sessionOpened` + the replayed history) for the now-active session;
   * the hub resets its state and folds them. The driver must NOT also emit these
   * via `subscribe` — the hub orchestrates the reset so the swap is atomic.
   */
  openSession(path: string): Promise<SessionDriverEvent[]>;
  /** Create a fresh session and make it active; resolves with its seed events (an
   *  empty `sessionOpened`). `cwd` (an absolute dir) picks the workspace per D12;
   *  omit it for the driver's launch cwd. `worktree`: create an isolated jj/git
   *  worktree of `cwd` first and bind the session to it. */
  newSession(cwd?: string, worktree?: boolean): Promise<SessionDriverEvent[]>;

  /** Models available to switch to (driver-wide; the real driver reads pi's model
   *  registry, the mock returns a fixture set). */
  listModels(): Promise<ModelOption[]>;

  /** Slash commands the targeted session offers (extension commands + prompt templates
   *  + skills, pi's `get_commands` set). Per-session because the set is cwd-scoped;
   *  sessionId omitted -> the driver's current session. The mock returns a fixture set. */
  listCommands(sessionId?: SessionId): Promise<CommandInfo[]>;
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

  /** pi's global default model/thinking for new sessions + the favorites subset. */
  getModelDefaults?(): Promise<ModelDefaults>;
  /** Set the global default model for NEW sessions (persists to pi's settings). */
  setDefaultModel?(provider: string, modelId: string): Promise<void>;
  /** Set the global default thinking level for NEW sessions. */
  setDefaultThinking?(level: string): Promise<void>;
  /** Replace the favorites subset (concrete `provider:modelId` refs). */
  setFavoriteModels?(refs: readonly string[]): Promise<void>;

  /** Subscribe to host-level project-trust requests (D12). The driver fires the
   *  listener when opening/creating a session in an untrusted cwd needs an
   *  interactive decision; the hub relays it to clients. Optional: a driver with no
   *  trust gate omits it. */
  subscribeTrust?(listener: (ev: TrustEvent) => void): () => void;
  /** Answer a pending trust request. `choice` indexes the request's options; null
   *  denies (deny-safe). Settling also fires a `resolved` TrustEvent. */
  respondTrust?(requestId: string, choice: number | null): void;

  /** Dev-only: jump the mock to a named scripted state. No-op for the real driver. */
  runScript?(name: string): void;
  /** Dev/test-only: clear all state and replay the initial fixture. No-op for real. */
  reset?(): void;
}
