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
  readonly runningRunId?: RunId;
  readonly queuedMessages?: readonly SessionQueuedMessage[];
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
  | RunFailedEvent
  | HostUiRequestEvent
  | HostUiResolvedEvent
  | ExtensionCompatibilityIssueEvent
  | SessionClosedEvent;
