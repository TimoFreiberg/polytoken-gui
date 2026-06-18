// Vendored from pi-gui's @pi-gui/session-driver (private 0.0.0).
// This is the normalized, JSON-serializable surface of a pi session.
// Source: ~/src/pi-gui/packages/session-driver/src/types.ts
// We adopt it as pilot's wire contract; trimmed to what pilot consumes.

export type WorkspaceId = string;
export type SessionId = string;
export type RunId = string;
export type Timestamp = string;

export interface WorkspaceRef {
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly displayName?: string;
}

export interface SessionRef {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
}

export type SessionStatus = "idle" | "running" | "failed";
export type SessionMessageDeliveryMode = "steer" | "followUp";

export interface SessionQueuedMessage {
  readonly id: string;
  readonly mode: SessionMessageDeliveryMode;
  readonly text: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface SessionConfig {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  /** Thinking levels the current model supports — drives the picker's options. */
  readonly availableThinkingLevels?: readonly string[];
}

/** How full the active model's context window is — drives the composer's context
 *  meter. A JSON-safe projection of pi's `AgentSession.getContextUsage()`. `tokens`
 *  is the estimated token count currently in context; it's `null` when unknown
 *  (e.g. right after a compaction, until the next assistant response re-grounds it),
 *  in which case `percent` is null too but `contextWindow` (the model's max) is still
 *  known and worth showing. */
export interface SessionUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

/** One selectable model for the per-session model picker (the available set is
 *  broadcast separately from the per-session snapshot; see `modelList`). */
export interface ModelOption {
  readonly provider: string;
  readonly modelId: string;
  readonly label: string;
  /** Thinking levels this model supports (pi's `getSupportedThinkingLevels`). Lets the
   *  new-session draft's effort picker offer accurate options before a session exists —
   *  per-session `availableThinkingLevels` is only known once a model is warm. */
  readonly thinkingLevels?: readonly string[];
}

/** One slash command the composer's typeahead can offer — a JSON-safe projection of
 *  pi's `get_commands` (extension commands, prompt templates, skills). The heavy
 *  `sourceInfo` path metadata is dropped; `source` drives a small origin badge.
 *  Commands are cwd/session-scoped (loaded from the focused session's `.pi`), so the
 *  list is re-broadcast on every session switch — see `commandList`. Execution needs
 *  nothing extra: sending `/name args` as a normal prompt routes through pi's
 *  `prompt()`, which runs extension commands and expands templates/skills. */
export interface CommandInfo {
  /** Invocation name without the leading slash (e.g. "review", "skill:debug"). */
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  /** Usage hint shown after the name (prompt templates only), e.g. "[path]". */
  readonly argumentHint?: string;
}

/** A model provider pilot can manage credentials for. No secret ever crosses the
 *  wire — only whether it's authed and where that auth comes from, so the UI can
 *  style remove-vs-readonly. Broadcast as `providerList`. */
export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly hasAuth: boolean;
  /** Where the working credential lives: "auth_file" = a key pilot saved and can
   *  remove; "env"/"external" = configured outside pilot (env var, models.json) and
   *  read-only here; "oauth" = an OAuth token; "none" = unauthed. */
  readonly authSource: "none" | "oauth" | "auth_file" | "env" | "external";
  /** Whether pilot can set a plain API key for this provider (pi's curated set). */
  readonly apiKeySetupSupported: boolean;
}

/** Pilot's view of pi's GLOBAL model config (not per-session): the default new
 *  sessions start from, plus the favorites subset the header picker is filtered to.
 *  `favorites` are concrete `provider:modelId` refs (resolved server-side from pi's
 *  glob-capable `enabledModels` patterns); empty = no filter, show every model.
 *  Broadcast as `modelDefaults`. */
export interface ModelDefaults {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly favorites: readonly string[];
}

export interface SessionSnapshot {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: Timestamp;
  readonly archivedAt?: Timestamp;
  readonly preview?: string;
  readonly config?: SessionConfig;
  /** Context-window fill at the moment the snapshot was taken. Recomputed at turn
   *  boundaries + on model/thinking change, not per streamed delta. */
  readonly usage?: SessionUsage;
  readonly runningRunId?: RunId;
  readonly queuedMessages?: readonly SessionQueuedMessage[];
}

/**
 * One row in the session picker — a JSON-safe projection of pi's `SessionInfo`
 * (Dates rendered as ISO strings, the heavy `allMessagesText` dropped). `path` (the
 * .jsonl file) is the switch key, since pi's resume/open APIs are path-based and the
 * `sessionId`/cwd can be empty for older sessions.
 */
export interface SessionListEntry {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly cwd: string;
  readonly displayName?: string;
  readonly preview: string;
  /** Count of the operator's own turns (messages with role "user") — NOT every
   *  message. pi's session files interleave assistant + toolResult messages, so a
   *  raw message count balloons with tool traffic; the sidebar wants "how many times
   *  did I write something", which is this. */
  readonly userMessageCount: number;
  readonly updatedAt: Timestamp;
  readonly createdAt: Timestamp;
  readonly parentSessionPath?: string;
  /** Context-window fill, present only for sessions already loaded in memory (the
   *  driver can read it for free from a warm session). Disk-only sessions omit it —
   *  we don't load a session just to show its gauge — so the sidebar shows a ring
   *  only where this is set. */
  readonly usage?: SessionUsage;
  /** Whether the operator has archived this session (pilot-side flag; the driver
   *  resolves it at list time). Archived sessions are hidden by the sidebar's
   *  active-only filter, alongside ones untouched for >7 days. */
  readonly archived: boolean;
  /** Present when this session runs in a jj/git worktree pilot created (the cwd is the
   *  worktree). The driver resolves it at list time from its worktree index; the sidebar
   *  shows an indicator + a clean-up/copy-path action. Absent for normal sessions. */
  readonly worktree?: { readonly path: string };
}

// --- Host UI (extension interaction) ---

export type HostUiResponse =
  | { readonly requestId: string; readonly value: string }
  | { readonly requestId: string; readonly confirmed: boolean }
  | { readonly requestId: string; readonly cancelled: true };

export type HostUiRequest =
  // BLOCKING dialogs — expect a HostUiResponse
  | {
      readonly kind: "confirm";
      readonly requestId: string;
      readonly title: string;
      readonly message: string;
      readonly defaultValue?: boolean;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "input";
      readonly requestId: string;
      readonly title: string;
      readonly placeholder?: string;
      readonly initialValue?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "select";
      readonly requestId: string;
      readonly title: string;
      readonly options: readonly string[];
      readonly allowMultiple?: boolean;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "editor";
      readonly requestId: string;
      readonly title: string;
      readonly initialValue?: string;
    }
  // FIRE-AND-FORGET — ambient UI, no response
  | {
      readonly kind: "notify";
      readonly requestId: string;
      readonly message: string;
      readonly level?: "info" | "warning" | "error";
    }
  | {
      readonly kind: "status";
      readonly requestId: string;
      readonly key: string;
      readonly text?: string;
    }
  | {
      readonly kind: "widget";
      readonly requestId: string;
      readonly key: string;
      readonly lines?: readonly string[];
      readonly placement?: "aboveComposer" | "belowComposer";
    }
  | {
      readonly kind: "title";
      readonly requestId: string;
      readonly title: string;
    }
  | {
      readonly kind: "editorText";
      readonly requestId: string;
      readonly text: string;
    }
  | { readonly kind: "reset"; readonly requestId: string };

export type HostUiDialogKind = "confirm" | "input" | "select" | "editor";

export function isDialogRequest(
  r: HostUiRequest,
): r is Extract<HostUiRequest, { kind: HostUiDialogKind }> {
  return (
    r.kind === "confirm" ||
    r.kind === "input" ||
    r.kind === "select" ||
    r.kind === "editor"
  );
}

// --- Driver event stream ---

export interface SessionEventBase {
  readonly type: string;
  readonly sessionRef: SessionRef;
  readonly timestamp: Timestamp;
  readonly runId?: RunId;
}

export interface SessionOpenedEvent extends SessionEventBase {
  readonly type: "sessionOpened";
  readonly snapshot: SessionSnapshot;
}
export interface SessionUpdatedEvent extends SessionEventBase {
  readonly type: "sessionUpdated";
  readonly snapshot: SessionSnapshot;
}
export interface AssistantDeltaEvent extends SessionEventBase {
  readonly type: "assistantDelta";
  readonly text: string;
  /** pilot extension: distinguish reasoning deltas from answer text */
  readonly channel?: "text" | "thinking";
}
export interface QueuedMessageStartedEvent extends SessionEventBase {
  readonly type: "queuedMessageStarted";
  readonly message: SessionQueuedMessage;
}
export interface UserMessageEvent extends SessionEventBase {
  // pilot extension: echo the user's submitted prompt into the transcript
  readonly type: "userMessage";
  readonly id: string;
  readonly text: string;
}
export interface ToolStartedEvent extends SessionEventBase {
  readonly type: "toolStarted";
  readonly toolName: string;
  readonly callId: string;
  readonly input?: unknown;
  /** pilot extension: human label + description resolved from getAllTools() */
  readonly label?: string;
  readonly description?: string;
}
export interface ToolUpdatedEvent extends SessionEventBase {
  readonly type: "toolUpdated";
  readonly callId: string;
  readonly text?: string;
  readonly progress?: number;
}
export interface ToolFinishedEvent extends SessionEventBase {
  readonly type: "toolFinished";
  readonly callId: string;
  readonly success: boolean;
  readonly output?: unknown;
}
export interface RunCompletedEvent extends SessionEventBase {
  readonly type: "runCompleted";
  readonly snapshot: SessionSnapshot;
}
export interface UsageUpdatedEvent extends SessionEventBase {
  // pilot-synthetic: the context-window fill changed mid-turn. Emitted by the hub on a
  // debounced timer while a turn runs, so the composer's context meter climbs live
  // instead of freezing at the last turn-boundary snapshot. Carries ONLY usage — unlike
  // a full sessionUpdated it never touches title/config/queued, so a mid-turn refresh
  // can't clobber them.
  readonly type: "usageUpdated";
  readonly usage: SessionUsage;
}
export interface SessionErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
}
export interface RunFailedEvent extends SessionEventBase {
  readonly type: "runFailed";
  readonly error: SessionErrorInfo;
}
export interface HostUiRequestEvent extends SessionEventBase {
  readonly type: "hostUiRequest";
  readonly request: HostUiRequest;
}
export interface HostUiResolvedEvent extends SessionEventBase {
  // pilot-synthetic: a pending dialog settled (a client answered, or the agent
  // auto-resolved on timeout). Emitted by the server, never by pi.
  readonly type: "hostUiResolved";
  readonly requestId: string;
}
export interface ExtensionCompatibilityIssue {
  readonly capability: string;
  readonly classification: "terminal-only";
  readonly message: string;
  readonly extensionPath?: string;
  readonly eventName?: string;
}
export interface ExtensionCompatibilityIssueEvent extends SessionEventBase {
  readonly type: "extensionCompatibilityIssue";
  readonly issue: ExtensionCompatibilityIssue;
}
export interface SessionClosedEvent extends SessionEventBase {
  readonly type: "sessionClosed";
  readonly reason: "manual" | "ended" | "failed";
}

export type SessionDriverEvent =
  | SessionOpenedEvent
  | SessionUpdatedEvent
  | AssistantDeltaEvent
  | QueuedMessageStartedEvent
  | UserMessageEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolFinishedEvent
  | RunCompletedEvent
  | UsageUpdatedEvent
  | RunFailedEvent
  | HostUiRequestEvent
  | HostUiResolvedEvent
  | ExtensionCompatibilityIssueEvent
  | SessionClosedEvent;
