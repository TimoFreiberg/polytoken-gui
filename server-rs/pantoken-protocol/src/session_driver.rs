//! Shared domain types — Rust port of `protocol/src/session-driver.ts`.
//!
//! These are the normalized, JSON-serializable types that form pantoken's wire
//! contract. The TS `protocol/` package is the client's source of truth; this
//! crate mirrors it and is validated by byte-compatibility via the e2e suite.

use serde::{Deserialize, Serialize};

// ── Primitive type aliases ──────────────────────────────────────────────

pub type WorkspaceId = String;
pub type SessionId = String;
pub type RunId = String;
pub type Timestamp = String;

// ── Workspace / session refs ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRef {
    #[serde(rename = "workspaceId")]
    pub workspace_id: WorkspaceId,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SessionRef {
    #[serde(rename = "workspaceId")]
    pub workspace_id: WorkspaceId,
    #[serde(rename = "sessionId")]
    pub session_id: SessionId,
}

// ── Status / mode enums ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Idle,
    Initializing,
    Running,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMonitorMode {
    Standard,
    Bypass,
    #[serde(rename = "bypass_plus")]
    BypassPlus,
    Autonomous,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionMessageDeliveryMode {
    Steer,
    FollowUp,
}

// ── Image content ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ImageContent {
    Image {
        data: String, // base64
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

// ── Queued messages ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionQueuedMessage {
    pub id: String,
    pub mode: SessionMessageDeliveryMode,
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: Timestamp,
    #[serde(rename = "updatedAt")]
    pub updated_at: Timestamp,
}

// ── Session config ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "modelId")]
    pub model_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "thinkingLevel"
    )]
    pub thinking_level: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "availableThinkingLevels"
    )]
    pub available_thinking_levels: Option<Vec<String>>,
}

// ── Usage ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionUsage {
    pub tokens: Option<i64>,
    #[serde(rename = "contextWindow")]
    pub context_window: i64,
    pub percent: Option<f64>,
}

// ── MCP ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpServerStatus {
    Connected,
    Disconnected,
    Reconnecting,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerInfo {
    #[serde(rename = "serverName")]
    pub server_name: String,
    pub status: McpServerStatus,
    #[serde(rename = "toolCount")]
    pub tool_count: i64,
}

// ── Models ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOption {
    pub provider: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub label: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "thinkingLevels"
    )]
    pub thinking_levels: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelDefaults {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "modelId")]
    pub model_id: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "thinkingLevel"
    )]
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub favorites: Vec<String>,
}

// ── Commands ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    pub source: CommandSource,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "argumentHint"
    )]
    pub argument_hint: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CommandSource {
    Extension,
    Prompt,
    Skill,
    Builtin,
}

// ── Files ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathStat {
    pub path: String,
    pub exists: bool,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
}

/// Skills + subagents available for the composer's `@skill:`/`@subagent:`
/// reference autocomplete. Server-authoritative like `FileInfo`'s `fileIndex`;
/// pushed on connect and re-pushed on session switch (session/cwd-scoped).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AtRefs {
    pub skills: Vec<String>,
    pub subagents: Vec<String>,
}

// ── Goal / flags / todos ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GoalInfo {
    pub summary: String,
    pub lifecycle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlaggedFile {
    pub path: String,
    pub mode: FlaggedFileMode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FlaggedFileMode {
    Included,
    Referenced,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TodoItem {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub status: TodoStatus,
    pub dependencies: Vec<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "createdAt")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
    Blocked,
}

// ── Background jobs ─────────────────────────────────────────────────────

/// A background job (subagent or shell) running in the daemon. Projected from
/// the daemon's `GET /jobs` `JobSnapshot`. The output tail is the primary
/// summary; `resultSummary` from `SubagentCompleted` is a follow-up not in the
/// MVP.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJob {
    pub handle: String,
    pub kind: JobKind,
    pub status: JobStatusKind,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "endedAt")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "startedAt")]
    pub started_at: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "subagentType"
    )]
    pub subagent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "subagentHandle"
    )]
    pub subagent_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expiring: Option<bool>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "outputTail"
    )]
    pub output_tail: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "outputBytes"
    )]
    pub output_bytes: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Shell,
    Subagent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatusKind {
    Reserved,
    Running,
    Completed,
    Failed,
    Cancelled,
}

// ── Session snapshot ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub r#ref: SessionRef,
    pub workspace: WorkspaceRef,
    pub title: String,
    pub status: SessionStatus,
    #[serde(rename = "updatedAt")]
    pub updated_at: Timestamp,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "archivedAt"
    )]
    pub archived_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub config: Option<SessionConfig>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<SessionUsage>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "runningRunId"
    )]
    pub running_run_id: Option<RunId>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "queuedMessages"
    )]
    pub queued_messages: Option<Vec<SessionQueuedMessage>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub facet: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "permissionMonitor"
    )]
    pub permission_monitor: Option<PermissionMonitorMode>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "adventurousHandoff"
    )]
    pub adventurous_handoff: Option<bool>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "notificationAutodrain"
    )]
    pub notification_autodrain: Option<bool>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "activePlan"
    )]
    pub active_plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "goal")]
    pub goal: Option<Option<GoalInfo>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub flags: Option<Vec<FlaggedFile>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub todos: Option<Vec<TodoItem>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "mcpServers"
    )]
    pub mcp_servers: Option<Vec<McpServerInfo>>,
}

// ── Session list entry ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionListEntry {
    #[serde(rename = "sessionId")]
    pub session_id: SessionId,
    pub path: String,
    pub cwd: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "displayName"
    )]
    pub display_name: Option<String>,
    pub preview: String,
    #[serde(rename = "userMessageCount")]
    pub user_message_count: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: Timestamp,
    #[serde(rename = "createdAt")]
    pub created_at: Timestamp,
    #[serde(rename = "lastUserMessageAt")]
    pub last_user_message_at: Timestamp,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "parentSessionPath"
    )]
    pub parent_session_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<SessionUsage>,
    #[serde(default)]
    pub archived: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub worktree: Option<WorktreeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorktreeInfo {
    pub path: String,
    pub base: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reaped: Option<bool>,
}

// ── Host UI (extension interaction) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QnaQuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QnaQuestion {
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub options: Option<Vec<QnaQuestionOption>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "multiSelect"
    )]
    pub multi_select: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QnaAnswer {
    #[serde(rename = "selectedOptionIndices")]
    pub selected_option_indices: Vec<i64>,
    #[serde(rename = "customText")]
    pub custom_text: String,
}

/// HostUiResponse — discriminated by the presence of value/confirmed/answers/cancelled.
/// The TS type is a union of four shapes, all carrying requestId. We model it
/// as a tagged enum with an explicit tag derived from the payload shape.
/// Since the TS doesn't use a discriminator field, we use serde's untagged
/// representation and let the presence of fields disambiguate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HostUiResponse {
    Value {
        #[serde(rename = "requestId")]
        request_id: String,
        value: String,
    },
    Confirmed {
        #[serde(rename = "requestId")]
        request_id: String,
        confirmed: bool,
    },
    Answers {
        #[serde(rename = "requestId")]
        request_id: String,
        answers: Vec<QnaAnswer>,
    },
    Cancelled {
        #[serde(rename = "requestId")]
        request_id: String,
        cancelled: bool,
    },
}

/// HostUiRequest — uses `kind` as the discriminator (NOT `type`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostUiRequest {
    Confirm {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
        message: String,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "defaultValue"
        )]
        default_value: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "timeoutMs")]
        timeout_ms: Option<i64>,
    },
    Input {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        placeholder: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "initialValue"
        )]
        initial_value: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "timeoutMs")]
        timeout_ms: Option<i64>,
    },
    Select {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
        options: Vec<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "allowMultiple"
        )]
        allow_multiple: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "timeoutMs")]
        timeout_ms: Option<i64>,
    },
    Editor {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "initialValue"
        )]
        initial_value: Option<String>,
    },
    Qna {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        title: Option<String>,
        questions: Vec<QnaQuestion>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "timeoutMs")]
        timeout_ms: Option<i64>,
    },
    Plan {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
        #[serde(rename = "planText")]
        plan_text: String,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "displayPath"
        )]
        display_path: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "targetFacet"
        )]
        target_facet: Option<String>,
        #[serde(rename = "actionLabels")]
        action_labels: [String; 3],
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "timeoutMs")]
        timeout_ms: Option<i64>,
    },
    Permission {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
        #[serde(rename = "toolName")]
        tool_name: Option<String>,
        #[serde(rename = "toolInput")]
        tool_input: Option<String>,
        options: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "timeoutMs")]
        timeout_ms: Option<i64>,
    },
    // FIRE-AND-FORGET — ambient UI, no response
    Notify {
        #[serde(rename = "requestId")]
        request_id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        level: Option<NotifyLevel>,
    },
    Status {
        #[serde(rename = "requestId")]
        request_id: String,
        key: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        text: Option<String>,
    },
    Widget {
        #[serde(rename = "requestId")]
        request_id: String,
        key: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        lines: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        placement: Option<WidgetPlacement>,
    },
    Title {
        #[serde(rename = "requestId")]
        request_id: String,
        title: String,
    },
    EditorText {
        #[serde(rename = "requestId")]
        request_id: String,
        text: String,
    },
    Reset {
        #[serde(rename = "requestId")]
        request_id: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NotifyLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WidgetPlacement {
    AboveComposer,
    BelowComposer,
}

/// The set of HostUiRequest kinds that are BLOCKING dialogs (expect a response).
pub const DIALOG_KINDS: &[&str] = &[
    "confirm",
    "input",
    "select",
    "editor",
    "qna",
    "plan",
    "permission",
];

pub fn is_dialog_request(req: &HostUiRequest) -> bool {
    matches!(
        req,
        HostUiRequest::Confirm { .. }
            | HostUiRequest::Input { .. }
            | HostUiRequest::Select { .. }
            | HostUiRequest::Editor { .. }
            | HostUiRequest::Qna { .. }
            | HostUiRequest::Plan { .. }
            | HostUiRequest::Permission { .. }
    )
}

// ── Extension compatibility ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionCompatibilityIssue {
    pub capability: String,
    pub classification: ExtensionIssueClassification,
    pub message: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        rename = "extensionPath"
    )]
    pub extension_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "eventName")]
    pub event_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExtensionIssueClassification {
    #[serde(rename = "terminal-only")]
    TerminalOnly,
}

// ── Session closed reason ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionClosedReason {
    Manual,
    Ended,
    Failed,
}

// ── Session error info ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionErrorInfo {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<serde_json::Value>,
}

// ── SessionDriverEvent ─────────────────────────────────────────────────
//
// The big one: the discriminated union of all driver events. Uses `type` as
// the serde tag, with camelCase variant names. Every variant also carries
// sessionRef + timestamp (+ optional runId), modeled as a common base via
// flatten where possible.

/// Fields common to every SessionDriverEvent variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEventBase {
    #[serde(rename = "sessionRef")]
    pub session_ref: SessionRef,
    pub timestamp: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "runId")]
    pub run_id: Option<RunId>,
}

/// The full session driver event stream.
///
/// Uses `type` as the discriminator with camelCase rename. Each variant
/// flattens `SessionEventBase` for the common fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionDriverEvent {
    SessionOpened {
        #[serde(flatten)]
        base: SessionEventBase,
        snapshot: SessionSnapshot,
    },
    SessionUpdated {
        #[serde(flatten)]
        base: SessionEventBase,
        snapshot: SessionSnapshot,
    },
    AssistantDelta {
        #[serde(flatten)]
        base: SessionEventBase,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        channel: Option<AssistantDeltaChannel>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "entryId")]
        entry_id: Option<String>,
    },
    QueuedMessageStarted {
        #[serde(flatten)]
        base: SessionEventBase,
        message: SessionQueuedMessage,
    },
    QueueUpdated {
        #[serde(flatten)]
        base: SessionEventBase,
        messages: Vec<SessionQueuedMessage>,
    },
    UserMessage {
        #[serde(flatten)]
        base: SessionEventBase,
        id: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        images: Option<Vec<ImageContent>>,
        #[serde(skip_serializing_if = "Option::is_none", default, rename = "entryId")]
        entry_id: Option<String>,
    },
    CustomMessage {
        #[serde(flatten)]
        base: SessionEventBase,
        id: String,
        #[serde(rename = "customType")]
        custom_type: String,
        text: String,
        #[serde(default)]
        display: bool,
    },
    ToolStarted {
        #[serde(flatten)]
        base: SessionEventBase,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        input: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        description: Option<String>,
    },
    ToolUpdated {
        #[serde(flatten)]
        base: SessionEventBase,
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        progress: Option<f64>,
    },
    ToolFinished {
        #[serde(flatten)]
        base: SessionEventBase,
        #[serde(rename = "callId")]
        call_id: String,
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        output: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        images: Option<Vec<ImageContent>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        interrupted: Option<bool>,
    },
    RunCompleted {
        #[serde(flatten)]
        base: SessionEventBase,
        snapshot: SessionSnapshot,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "userEntryId"
        )]
        user_entry_id: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            default,
            rename = "assistantEntryId"
        )]
        assistant_entry_id: Option<String>,
    },
    UsageUpdated {
        #[serde(flatten)]
        base: SessionEventBase,
        usage: SessionUsage,
    },
    RunFailed {
        #[serde(flatten)]
        base: SessionEventBase,
        error: SessionErrorInfo,
    },
    HostUiRequest {
        #[serde(flatten)]
        base: SessionEventBase,
        request: HostUiRequest,
    },
    HostUiResolved {
        #[serde(flatten)]
        base: SessionEventBase,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    ExtensionCompatibilityIssue {
        #[serde(flatten)]
        base: SessionEventBase,
        issue: ExtensionCompatibilityIssue,
    },
    SessionClosed {
        #[serde(flatten)]
        base: SessionEventBase,
        reason: SessionClosedReason,
    },
    SessionReset {
        #[serde(flatten)]
        base: SessionEventBase,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AssistantDeltaChannel {
    Text,
    Thinking,
}

// ── Accessor helpers ────────────────────────────────────────────────────

impl SessionDriverEvent {
    /// Returns the sessionRef common to all variants.
    pub fn session_ref(&self) -> &SessionRef {
        match self {
            SessionDriverEvent::SessionOpened { base, .. }
            | SessionDriverEvent::SessionUpdated { base, .. }
            | SessionDriverEvent::AssistantDelta { base, .. }
            | SessionDriverEvent::QueuedMessageStarted { base, .. }
            | SessionDriverEvent::QueueUpdated { base, .. }
            | SessionDriverEvent::UserMessage { base, .. }
            | SessionDriverEvent::CustomMessage { base, .. }
            | SessionDriverEvent::ToolStarted { base, .. }
            | SessionDriverEvent::ToolUpdated { base, .. }
            | SessionDriverEvent::ToolFinished { base, .. }
            | SessionDriverEvent::RunCompleted { base, .. }
            | SessionDriverEvent::UsageUpdated { base, .. }
            | SessionDriverEvent::RunFailed { base, .. }
            | SessionDriverEvent::HostUiRequest { base, .. }
            | SessionDriverEvent::HostUiResolved { base, .. }
            | SessionDriverEvent::ExtensionCompatibilityIssue { base, .. }
            | SessionDriverEvent::SessionClosed { base, .. }
            | SessionDriverEvent::SessionReset { base } => &base.session_ref,
        }
    }

    /// Returns the timestamp common to all variants.
    pub fn timestamp(&self) -> &Timestamp {
        match self {
            SessionDriverEvent::SessionOpened { base, .. }
            | SessionDriverEvent::SessionUpdated { base, .. }
            | SessionDriverEvent::AssistantDelta { base, .. }
            | SessionDriverEvent::QueuedMessageStarted { base, .. }
            | SessionDriverEvent::QueueUpdated { base, .. }
            | SessionDriverEvent::UserMessage { base, .. }
            | SessionDriverEvent::CustomMessage { base, .. }
            | SessionDriverEvent::ToolStarted { base, .. }
            | SessionDriverEvent::ToolUpdated { base, .. }
            | SessionDriverEvent::ToolFinished { base, .. }
            | SessionDriverEvent::RunCompleted { base, .. }
            | SessionDriverEvent::UsageUpdated { base, .. }
            | SessionDriverEvent::RunFailed { base, .. }
            | SessionDriverEvent::HostUiRequest { base, .. }
            | SessionDriverEvent::HostUiResolved { base, .. }
            | SessionDriverEvent::ExtensionCompatibilityIssue { base, .. }
            | SessionDriverEvent::SessionClosed { base, .. }
            | SessionDriverEvent::SessionReset { base } => &base.timestamp,
        }
    }

    /// Returns the optional runId common to all variants.
    pub fn run_id(&self) -> Option<&RunId> {
        match self {
            SessionDriverEvent::SessionOpened { base, .. }
            | SessionDriverEvent::SessionUpdated { base, .. }
            | SessionDriverEvent::AssistantDelta { base, .. }
            | SessionDriverEvent::QueuedMessageStarted { base, .. }
            | SessionDriverEvent::QueueUpdated { base, .. }
            | SessionDriverEvent::UserMessage { base, .. }
            | SessionDriverEvent::CustomMessage { base, .. }
            | SessionDriverEvent::ToolStarted { base, .. }
            | SessionDriverEvent::ToolUpdated { base, .. }
            | SessionDriverEvent::ToolFinished { base, .. }
            | SessionDriverEvent::RunCompleted { base, .. }
            | SessionDriverEvent::UsageUpdated { base, .. }
            | SessionDriverEvent::RunFailed { base, .. }
            | SessionDriverEvent::HostUiRequest { base, .. }
            | SessionDriverEvent::HostUiResolved { base, .. }
            | SessionDriverEvent::ExtensionCompatibilityIssue { base, .. }
            | SessionDriverEvent::SessionClosed { base, .. }
            | SessionDriverEvent::SessionReset { base } => base.run_id.as_ref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_session_opened() {
        let json_str = r#"{
            "type": "sessionOpened",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "snapshot": {
                "ref": {"workspaceId": "ws1", "sessionId": "s1"},
                "workspace": {"workspaceId": "ws1", "path": "/home"},
                "title": "Test",
                "status": "idle",
                "updatedAt": "2026-07-03T12:00:00Z"
            }
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::SessionOpened { snapshot, .. } => {
                assert_eq!(snapshot.title, "Test");
                assert_eq!(snapshot.status, SessionStatus::Idle);
            }
            _ => panic!("expected SessionOpened"),
        }
    }

    #[test]
    fn roundtrip_assistant_delta() {
        let json_str = r#"{
            "type": "assistantDelta",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "text": "Hello",
            "channel": "text"
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::AssistantDelta { text, channel, .. } => {
                assert_eq!(text, "Hello");
                assert_eq!(channel, Some(AssistantDeltaChannel::Text));
            }
            _ => panic!("expected AssistantDelta"),
        }
    }

    #[test]
    fn roundtrip_host_ui_request_confirm() {
        let json_str = r#"{
            "type": "hostUiRequest",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "request": {
                "kind": "confirm",
                "requestId": "r1",
                "title": "Confirm?",
                "message": "Are you sure?"
            }
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::HostUiRequest { request, .. } => match request {
                HostUiRequest::Confirm { title, message, .. } => {
                    assert_eq!(title, "Confirm?");
                    assert_eq!(message, "Are you sure?");
                }
                _ => panic!("expected Confirm"),
            },
            _ => panic!("expected HostUiRequest"),
        }
    }

    #[test]
    fn roundtrip_host_ui_request_permission() {
        let json_str = r#"{
            "type": "hostUiRequest",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "request": {
                "kind": "permission",
                "requestId": "r2",
                "title": "Approve tool?",
                "toolName": "shell_exec",
                "toolInput": "{\"command\": \"ls\"}",
                "options": ["Deny", "Allow once"]
            }
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::HostUiRequest { request, .. } => {
                assert!(is_dialog_request(&request));
            }
            _ => panic!("expected HostUiRequest"),
        }
    }

    #[test]
    fn roundtrip_host_ui_request_notify() {
        let json_str = r#"{
            "type": "hostUiRequest",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "request": {
                "kind": "notify",
                "requestId": "r3",
                "message": "Done!",
                "level": "info"
            }
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::HostUiRequest { request, .. } => {
                assert!(!is_dialog_request(&request));
            }
            _ => panic!("expected HostUiRequest"),
        }
    }

    #[test]
    fn roundtrip_run_completed() {
        let json_str = r#"{
            "type": "runCompleted",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "runId": "run1",
            "snapshot": {
                "ref": {"workspaceId": "ws1", "sessionId": "s1"},
                "workspace": {"workspaceId": "ws1", "path": "/home"},
                "title": "Test",
                "status": "idle",
                "updatedAt": "2026-07-03T12:00:00Z"
            },
            "userEntryId": "u1",
            "assistantEntryId": "a1"
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::RunCompleted {
                user_entry_id,
                assistant_entry_id,
                ..
            } => {
                assert_eq!(user_entry_id, Some("u1".to_string()));
                assert_eq!(assistant_entry_id, Some("a1".to_string()));
            }
            _ => panic!("expected RunCompleted"),
        }
    }

    #[test]
    fn roundtrip_session_closed() {
        let json_str = r#"{
            "type": "sessionClosed",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "reason": "manual"
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::SessionClosed { reason, .. } => {
                assert_eq!(reason, SessionClosedReason::Manual);
            }
            _ => panic!("expected SessionClosed"),
        }
    }

    #[test]
    fn roundtrip_session_reset() {
        let json_str = r#"{
            "type": "sessionReset",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z"
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        assert!(matches!(ev, SessionDriverEvent::SessionReset { .. }));
    }

    #[test]
    fn serialize_event_has_camel_case_type() {
        let ev = SessionDriverEvent::SessionReset {
            base: SessionEventBase {
                session_ref: SessionRef {
                    workspace_id: "ws1".into(),
                    session_id: "s1".into(),
                },
                timestamp: "2026-07-03T12:00:00Z".into(),
                run_id: None,
            },
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "sessionReset");
        assert_eq!(json["sessionRef"]["workspaceId"], "ws1");
        assert_eq!(json["sessionRef"]["sessionId"], "s1");
    }

    #[test]
    fn roundtrip_host_ui_request_plan() {
        let json_str = r#"{
            "type": "hostUiRequest",
            "sessionRef": {"workspaceId": "ws1", "sessionId": "s1"},
            "timestamp": "2026-07-03T12:00:00Z",
            "request": {
                "kind": "plan",
                "requestId": "r4",
                "title": "Plan",
                "planText": "Do stuff",
                "actionLabels": ["New context", "Current context", "Cancel"]
            }
        }"#;
        let ev: SessionDriverEvent = serde_json::from_str(json_str).unwrap();
        match ev {
            SessionDriverEvent::HostUiRequest { request, .. } => match request {
                HostUiRequest::Plan {
                    plan_text,
                    action_labels,
                    ..
                } => {
                    assert_eq!(plan_text, "Do stuff");
                    assert_eq!(action_labels[0], "New context");
                }
                _ => panic!("expected Plan"),
            },
            _ => panic!("expected HostUiRequest"),
        }
    }

    #[test]
    fn roundtrip_host_ui_response_value() {
        let json_str = r#"{"requestId":"r1","value":"yes"}"#;
        let resp: HostUiResponse = serde_json::from_str(json_str).unwrap();
        match resp {
            HostUiResponse::Value { value, .. } => assert_eq!(value, "yes"),
            _ => panic!("expected Value"),
        }
    }

    #[test]
    fn roundtrip_host_ui_response_cancelled() {
        let json_str = r#"{"requestId":"r1","cancelled":true}"#;
        let resp: HostUiResponse = serde_json::from_str(json_str).unwrap();
        match resp {
            HostUiResponse::Cancelled { .. } => {}
            _ => panic!("expected Cancelled"),
        }
    }
}
