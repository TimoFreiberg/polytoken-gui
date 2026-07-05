//! Auto-generated daemon wire types from `polytoken openapi`.
//!
//! This crate intentionally models the daemon's exhaustive wire vocabulary. Some
//! generated structs/enums/variants are unused by the Rust server until the daemon
//! bumps or a later porting phase wires that endpoint/event kind, so this generated
//! file keeps a crate-level dead_code allowance. Do not copy this pattern into
//! hand-written server modules; annotate those gaps at item level instead.
//!
//! Regenerate after a polytoken bump: `bun run scripts/codegen-polytoken-rs.ts`
//! DO NOT EDIT MANUALLY.

#![allow(dead_code)]

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AskUserQuestionMode {
    SingleSelect,
    MultiSelect,
    Text,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CancellationReason {
    UserCancelled,
    Shutdown,
    HookBlocked,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    ReadFiles,
    WriteFiles,
    Network,
    Shell,
    ModelAccess,
    SessionState,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClassifierOutcome {
    Allow,
    Unsure,
    Deny,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompactionReason {
    Threshold,
    Manual,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FlagMode {
    Included,
    Referenced,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HookOutcome {
    Allowed,
    Blocked,
    Suppressed,
    Error,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InterrogativeType {
    Permission,
    Confirmation,
    Clarification,
    Capability,
    PlanHandoff,
    GoalProposal,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Shell,
    Subagent,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobOutputChannel {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LockSource {
    Initial,
    PostCompaction,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpServerStatus {
    Connected,
    Disconnected,
    Reconnecting,
    Disabled,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpTransportKind {
    Stdio,
    Http,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageUserKind {
    Human,
    Reiterated,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMonitorMode {
    Standard,
    Bypass,
    BypassPlus,
    Autonomous,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PersistenceTarget {
    Session,
    ProjectLocal,
    Project,
    UserLocal,
    User,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorPhase {
    HttpResponse,
    SseEvent,
    LocalPreSendGuard,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReloadSubsystem {
    Facets,
    Hooks,
    Permissions,
    ContextFiles,
    Extensions,
    Subagents,
    Skills,
    Providers,
    ActiveModel,
    Mcp,
    PermissionMonitor,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScratchPad {
    Session,
    Context,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionLifecycleKind {
    Created,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceControlKind {
    Git,
    Jj,
    Sapling,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubagentResultKind {
    Success,
    Failure,
    Cancelled,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminateStatus {
    Terminating,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TitleChangeSource {
    Operator,
    Inferred,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
    Blocked,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolLoading {
    Eager,
    NativeDeferred,
    NoTools,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransportKind {
    Timeout,
    ConnectionRefused,
    TlsError,
    Other,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AdventurousHandoffResponse {
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentsMdEntry {
    pub content: String,
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AskUserQuestion {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub allow_free_text: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context: Option<String>,
    pub id: String,
    pub mode: AskUserQuestionMode,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub options: Option<Vec<AskUserQuestionOption>>,
    pub question: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AskUserQuestionOption {
    pub description: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub justification: Option<String>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AskUserQuestionPayload {
    pub questions: Vec<AskUserQuestion>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AskUserQuestionReply {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub free_text: Option<String>,
    pub question_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub selected_option_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AvailableModelEntry {
    pub label: String,
    pub name: String,
    pub reasoning: WireModelReasoningCapability,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BlockDeltaPayload {
    Text { text: String },
    ToolUseInput { partial_json: String },
    Thinking { text: String },
    SignatureDelta { signature: String },
    RedactedThinking { data: String },
    OpenAiReasoningOpaque { data: String, id: String },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClarificationOption {
    pub key: String,
    pub label: String,
}

pub type CodexAuthProfile = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompactAccepted {
    pub compaction_id: CompactionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CompactRequest {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub guidance: Option<String>,
}

pub type CompactionId = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        input: serde_json::Value,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        provider_metadata: Option<serde_json::Value>,
    },
    Thinking {
        signature: String,
        text: String,
    },
    RedactedThinking {
        data: String,
    },
    OpenAiReasoningOpaque {
        data: String,
        id: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlockKind {
    Text,
    ToolUse {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        provider_metadata: Option<serde_json::Value>,
    },
    Thinking,
    RedactedThinking,
    OpenAiReasoningOpaque,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContextUsageSnapshot {
    pub limit_tokens: i32,
    pub used_tokens: i32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CurrentGoal {
    pub activated_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub blocked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub completed_at: Option<String>,
    pub continuation_count: i32,
    pub created_at: String,
    pub file: GoalFileReference,
    pub id: GoalId,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_reiterated_at: Option<String>,
    pub lifecycle: GoalLifecycle,
    pub source: GoalSource,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub terminal_reason: Option<TerminalReason>,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[allow(
    clippy::large_enum_variant,
    reason = "generated wire type mirrors daemon OpenAPI shape"
)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonEvent {
    Heartbeat {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        timestamp: String,
    },
    ContentBlockStart {
        block_index: i32,
        block_type: ContentBlockKind,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ContentBlockDelta {
        block_index: i32,
        delta: BlockDeltaPayload,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ContentBlockStop {
        block_index: i32,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    MessageStart {
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    MessageComplete {
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    PendingTurnInputQueued {
        admission_prompt_id: PromptId,
        content: String,
        item_id: PendingTurnInputId,
        queue_revision: i64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    PendingTurnInputDequeued {
        item_id: PendingTurnInputId,
        queue_revision: i64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    PendingTurnInputDrained {
        admission_prompt_ids: Vec<PromptId>,
        content: String,
        final_prompt_id: PromptId,
        item_ids: Vec<PendingTurnInputId>,
        queue_revision: i64,
        raw_history_index: i64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        resolved_references: Option<Vec<ResolvedPromptReference>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    PendingTurnInputDiscarded {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        admission_prompt_ids: Option<Vec<PromptId>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        content: Option<String>,
        item_ids: Vec<PendingTurnInputId>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        missing_references: Option<Vec<ResolvedPromptReference>>,
        queue_revision: i64,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason_code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    TurnCancelled {
        prompt_id: PromptId,
        reason: CancellationReason,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ModelError {
        error: ProviderError,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    StreamDiscontinuity {
        missed: i64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ToolCall {
        call_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        input: Option<serde_json::Value>,
        name: String,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ToolResult {
        call_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        content_full: Option<ToolLiveDisplayContent>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        is_error: Option<bool>,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    JobPromoted {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    JobCompleted {
        exit_code: i32,
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    JobExpiring {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    JobCancelled {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    JobUpdated {
        job_id: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    SessionRewound {
        rewound_to_index: i64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        rewound_to_prompt_id: Option<PromptId>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    SessionStateChanged {
        domains: Vec<SessionStateDomain>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        source_subagent_handle: Option<String>,
    },
    SessionTitleChanged {
        source: TitleChangeSource,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        title: String,
    },
    FacetSwitch {
        from_facet: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        to_facet: String,
    },
    ContextCleared {
        facet: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        plan_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ModelSwitch {
        from_model: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        from_reasoning_effort: Option<ReasoningEffort>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        to_model: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        to_reasoning_effort: Option<ReasoningEffort>,
    },
    PermissionMonitorSwitch {
        from_monitor: PermissionMonitor,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        to_monitor: PermissionMonitor,
    },
    Interrogative {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        clarification_options: Option<Vec<ClarificationOption>>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        extension_context: Option<ExtensionContext>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        goal_proposal: Option<GoalProposalContext>,
        interrogative_id: InterrogativeId,
        interrogative_type: InterrogativeType,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        permission_candidate_rule: Option<PermissionCandidateRuleContext>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        permission_tool_call: Option<PermissionToolCallContext>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        plan_handoff: Option<PlanHandoffContext>,
        prompt_id: PromptId,
        question: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    AskUserQuestion {
        interrogative_id: InterrogativeId,
        payload: AskUserQuestionPayload,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    HookFired {
        event_type: String,
        hook_name: String,
        outcome: HookOutcome,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ContextLoaded {
        hash: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    CompactionStarted {
        compaction_id: CompactionId,
        reason: CompactionReason,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    CompactionComplete {
        compaction_id: CompactionId,
        preserved_files_count: i64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        summary_length: i64,
        todos_count: i64,
    },
    CompactionCancelled {
        compaction_id: CompactionId,
        reason: CancellationReason,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    CompactionFailed {
        compaction_id: CompactionId,
        reason: FailureReason,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    SubagentCompactionNotice {
        compaction_id: CompactionId,
        emitted_at: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        summary: String,
    },
    NotificationQueued {
        notification: Notification,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    NotificationsDrained {
        count: i32,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    NotificationAutodrainSwitch {
        enabled: bool,
    },
    SystemReminder {
        body: String,
        display_name: String,
        emitted_at: String,
        reason: SystemReminderReason,
        slug: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    ToolReveal {
        prompt_id: PromptId,
        source: ToolRevealSource,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        tool_names: Vec<String>,
    },
    ToolExposureChanged {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        catalog_count: Option<i32>,
        exposed_count: i32,
        provider_capability_mode: ToolLoading,
        reason: ToolExposureReason,
        revealed_count: i32,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    GoalDriverUpdate {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        goal: Option<CurrentGoal>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        proposed_summary: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        transition: GoalTransition,
    },
    ClassifierDecision {
        call_id: String,
        outcome: ClassifierOutcome,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        tool_name: String,
    },
    ExtensionRegistered {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    SubagentStarted {
        handle: String,
        model: String,
        subagent_type: String,
    },
    SubagentCompleted {
        handle: String,
        outcome: SubagentOutcome,
        result_summary: String,
    },
    SubsessionCreated {
        facet: String,
        port: i32,
        prompt_summary: String,
        subsession_id: SessionId,
    },
    SubsessionStopped {
        subsession_id: SessionId,
        summary: String,
    },
    SubsessionTerminated {
        reason: String,
        subsession_id: SessionId,
    },
    SubsessionInterrogative {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        clarification_options: Option<Vec<ClarificationOption>>,
        interrogative_id: InterrogativeId,
        interrogative_type: InterrogativeType,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        permission_candidate_rule: Option<PermissionCandidateRuleContext>,
        question: String,
        subsession_id: SessionId,
    },
    SubsessionMessage {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        detail: Option<serde_json::Value>,
        subsession_id: SessionId,
        summary: String,
    },
    McpServerConnected {
        resource_count: i32,
        server_name: String,
        tool_count: i32,
        transport: McpTransportKind,
    },
    McpServerDisconnected {
        reason: String,
        server_name: String,
        transport: McpTransportKind,
    },
    McpServerReconnecting {
        attempt: i32,
        next_retry_in_ms: i64,
        server_name: String,
        transport: McpTransportKind,
    },
    McpServerDisabled {
        reason: String,
        server_name: String,
        transport: McpTransportKind,
    },
    ImageReferenceResolved {
        file_size_bytes: i64,
        media_type: String,
        path: String,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    UsageThrottle {
        action: UsageAction,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt_id: Option<PromptId>,
        provider: String,
        snapshot: ProviderUsageSnapshot,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    RetryWait {
        attempt: i32,
        delay_ms: i64,
        error_summary: String,
        error_type: String,
        max_retries: i32,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
    },
    AgentBlockViolation {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt_id: Option<PromptId>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        tool_name: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DiffPreviewContent {
    pub lines: Vec<DiffPreviewLine>,
    pub new_path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub old_path: Option<String>,
    pub omitted_line_count: i64,
    pub summary: String,
}

pub type DiffPreviewLine = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EditFormatLockedResponse {
    pub code: String,
    pub resolution: String,
    pub session_format: String,
    pub target_format: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub retry_after_seconds: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtensionContext {
    pub capabilities: Vec<Capability>,
    pub extension_name: String,
    pub manifest_summary: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FacetRequest {
    pub facet: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FailureReason {
    NoModelFits,
    ProviderError {
        detail: String,
    },
    RateLimited {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        retry_after_seconds: Option<i64>,
    },
    EmptySummary,
    InternalError {
        detail: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileCatalogResponse {
    pub files: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileObservation {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub len: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub modified_unix_nanos: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FlagEntry {
    pub mode: FlagMode,
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GoalFileReference {
    pub display_path: String,
    pub path: String,
}

pub type GoalId = String;

pub type GoalLifecycle = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GoalLifecycleResponse {
    pub goal: CurrentGoal,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GoalProposalActionLabels {
    pub accept: String,
    pub reject: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GoalProposalContext {
    pub action_labels: GoalProposalActionLabels,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub proposed_file_path: Option<String>,
    pub proposed_summary: String,
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GoalSetRequest {
    pub summary: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GoalSetResponse {
    pub goal: CurrentGoal,
}

pub type GoalSource = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GoalStatusResponse {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub current_goal: Option<CurrentGoal>,
}

pub type GoalTransition = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HealthResponse {
    pub last_heartbeat_at: String,
    pub parent_session_id: SessionRef,
    pub pid: i32,
    pub port: i32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub process_start_token: Option<i64>,
    pub project_path: String,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_title: Option<String>,
    pub started_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HistoryItemMeta {
    pub item_id: String,
    pub projected_index: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub raw_history_index: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IncludedFileEntry {
    pub content: String,
    pub full_size_bytes: i64,
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IncludedImageEntry {
    pub data: String,
    pub full_size_bytes: i64,
    pub media_type: String,
    pub path: String,
}

pub type InterrogativeId = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InterrogativeResponse {
    Cancel,
    PermissionAnswer {
        granted: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        persistence_target: Option<PersistenceTarget>,
    },
    ConfirmationAnswer {
        confirmed: bool,
    },
    ClarificationChoice {
        choice: String,
    },
    ClarificationText {
        text: String,
    },
    CapabilityAnswer {
        granted: bool,
    },
    PlanHandoffAnswer {
        decision: PlanHandoffDecision,
    },
    GoalProposalAnswer {
        accepted: bool,
    },
    AskUserQuestionAnswers {
        answers: Vec<AskUserQuestionReply>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JobOutputChannelSnapshot {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bytes: Option<i64>,
    pub channel: JobOutputChannel,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tail: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JobOutputPage {
    pub channel: JobOutputChannel,
    pub content: String,
    pub handle: String,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JobSnapshot {
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expiring: Option<bool>,
    pub handle: String,
    pub kind: JobKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_channels: Option<Vec<JobOutputChannelSnapshot>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parent: Option<ParentRef>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub started_at: Option<String>,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subagent_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subagent_type: Option<String>,
    pub tool_name: String,
    pub updated_at: String,
}

pub type JobStatus = serde_json::Value;

pub type KnownSessionHistoryItem = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpOAuthCallbackRequest {
    pub redirect_url: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpOAuthCallbackResponse {
    pub access_token_available: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpOAuthStartRequest {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub redirect_uri: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpOAuthStartResponse {
    pub authorization_url: String,
    pub local_callback: bool,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpServerStatusEntry {
    pub server_name: String,
    pub status: McpServerStatus,
    pub tool_count: i32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    SessionLifecycle {
        emitted_at: String,
        session_id: SessionId,
    },
    User {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        emitted_at: Option<String>,
        prompt_id: PromptId,
    },
    Assistant {
        blocks: Vec<ContentBlock>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        emitted_at: Option<String>,
        prompt_id: PromptId,
    },
    ToolResult {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        emitted_at: Option<String>,
        prompt_id: PromptId,
        results: Vec<ToolResult>,
    },
    StateUpdate {
        delta: StateDelta,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        emitted_at: Option<String>,
    },
    FacetSwitch {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        emitted_at: Option<String>,
        from_facet: String,
        prompt_id: PromptId,
        to_facet: String,
    },
    ModelSwitch {
        emitted_at: String,
        from_model: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        from_reasoning_effort: Option<ReasoningEffort>,
        to_model: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        to_reasoning_effort: Option<ReasoningEffort>,
    },
    ContextCleared {
        emitted_at: String,
        facet: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        plan_path: Option<String>,
    },
    Notification {
        emitted_at: String,
        notifications: Vec<Notification>,
    },
    CompactionFencepost {
        compaction_id: CompactionId,
        emitted_at: String,
        reattachment: ReattachmentState,
        summary: String,
    },
    ToolExposureReminder {
        emitted_at: String,
        text: String,
    },
    SystemReminder {
        reminder: SystemReminder,
    },
    ClassifierDecision {
        call_id: String,
        emitted_at: String,
        outcome: ClassifierOutcome,
        prompt_id: PromptId,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subagent_handle: Option<String>,
        tool_name: String,
    },
    ImageReference {
        data: String,
        emitted_at: String,
        file_size_bytes: i64,
        media_type: String,
        path: String,
        prompt_id: PromptId,
    },
    SubagentSpawn {
        emitted_at: String,
        handle: String,
        model: String,
        subagent_type: String,
    },
    SubagentComplete {
        emitted_at: String,
        handle: String,
        outcome: SubagentOutcome,
        result_summary: String,
    },
}

pub type ModelConflictResponse = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelLocator {
    pub provider: String,
    pub provider_name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelRequest {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Notification {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<serde_json::Value>,
    pub id: NotificationId,
    pub notification_type: NotificationType,
    pub source: String,
    pub summary: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NotificationAutodrainRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NotificationAutodrainResponse {
    pub config_default: bool,
    pub enabled: bool,
}

pub type NotificationId = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NotificationType {
    JobComplete {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        exit_code: Option<i32>,
    },
    HookResult,
    SubagentComplete {
        handle: String,
        outcome: SubagentOutcome,
    },
    SubsessionMessage,
    ExtensionMessage {
        extension_name: String,
    },
    Unknown,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ParentRef {
    Subagent { handle: String },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingTurnInputAccepted {
    pub item: PendingTurnInputItem,
    pub queue_revision: i64,
}

pub type PendingTurnInputId = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingTurnInputItem {
    pub admission_prompt_id: PromptId,
    pub content: String,
    pub id: PendingTurnInputId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingTurnInputRequest {
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingTurnInputSnapshot {
    pub items: Vec<PendingTurnInputItem>,
    pub queue_revision: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionCandidateRuleContext {
    pub candidate_rule_raw: String,
    pub candidate_rule_resolved_today: String,
    pub default_target: PersistenceTarget,
    pub floor_context: PermissionCandidateRuleFloorContext,
    pub keep_targets: Vec<PersistenceTarget>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionCandidateRuleFloorContext {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subject_kind: Option<String>,
    pub tool_name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PermissionMonitor {
    Standard,
    Bypass,
    BypassPlus,
    Autonomous {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        classifier_model: Option<ModelLocator>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        classifier_rules: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        max_consecutive_denials: Option<i32>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionMonitorRequest {
    pub mode: PermissionMonitorMode,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionMonitorResponse {
    pub config_default: PermissionMonitor,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub configured_autonomous: Option<PermissionMonitor>,
    pub monitor: PermissionMonitor,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PermissionToolCallContext {
    pub input: serde_json::Value,
    pub tool_name: String,
    pub tool_use_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlanHandoffActionLabels {
    pub cancel: String,
    pub implement_current_context: String,
    pub implement_new_context: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub refuse: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlanHandoffContext {
    pub action_labels: PlanHandoffActionLabels,
    pub display_path: String,
    pub plan_path: String,
    pub plan_text: String,
    pub target_facet: String,
    pub title: String,
}

pub type PlanHandoffDecision = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PreUserPromptDenied {
    pub blocked_by_hook: String,
    pub prompt_id: PromptId,
    pub reason: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PromptAccepted {
    pub prompt_id: PromptId,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub queued_item: Option<PendingTurnInputItem>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub resolved_references: Option<Vec<ResolvedPromptReference>>,
    pub session_id: SessionId,
}

pub type PromptId = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PromptRequest {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max_tool_turns: Option<i32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderError {
    RateLimited {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        retry_after_seconds: Option<i64>,
    },
    AuthFailed,
    LoginRequired {
        profile: CodexAuthProfile,
    },
    ModelNotFound,
    ContextTooLarge {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        upstream: Option<ProviderUpstreamErrorMetadata>,
    },
    Transport {
        message: String,
    },
    ProtocolMalformed {
        detail: String,
    },
    Canceled,
    Other {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderUpstreamErrorMetadata {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub event_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub http_status: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message_char_length: Option<i64>,
    pub phase: ProviderErrorPhase,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderUsageSnapshot {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub boxed_until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub concurrency_hard_cap: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub concurrency_limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub concurrent_sessions: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub degraded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub remaining_requests: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_hard_cap: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_utilization_bps: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_window_seconds: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub requests_in_window: Option<i32>,
}

pub type ReasoningEffort = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReattachmentState {
    pub agents_md: Vec<AgentsMdEntry>,
    pub included_files: Vec<IncludedFileEntry>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub included_images: Option<Vec<IncludedImageEntry>>,
    pub referenced_paths: Vec<String>,
    pub todos: Vec<TodoSnapshot>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReloadResponse {
    pub context_files_reloaded: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub extensions_changed: Option<bool>,
    pub facets_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub failed: Option<Vec<ReloadSubsystem>>,
    pub hooks_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mcp_servers_changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub permission_monitor_changed: Option<bool>,
    pub permissions_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub skills_changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subagents_changed: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ResolvedPromptReference {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file_kind: Option<String>,
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RewindAccepted {
    pub domains_applied: Vec<String>,
    pub rewound_to: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RewindRequest {
    pub domains: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub to_message_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub to_prompt_id: Option<PromptId>,
}

pub type SessionHistoryItem = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionHistorySnapshot {
    pub history_revision: i64,
    pub items: Vec<SessionHistoryItem>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub limit: Option<i64>,
    pub offset: i64,
    pub session_id: SessionId,
    pub total_projected_items: i64,
}

pub type SessionId = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionRecord {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub non_interactive: Option<bool>,
    pub parent_session_id: SessionRef,
    pub pid: i32,
    pub port: i32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub process_start_token: Option<i64>,
    pub project_path: String,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_title: Option<String>,
    pub started_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionRef {
    Standalone,
    Local { session_id: SessionId },
}

pub type SessionStateDomain = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionStateSnapshot {
    pub active_facet: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_reasoning_effort: Option<ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub adventurous_handoff_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub available_models: Option<Vec<AvailableModelEntry>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub available_skills: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub available_subagents: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_usage: Option<ContextUsageSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub current_goal: Option<CurrentGoal>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cwd_stack_depth: Option<i64>,
    pub env: std::collections::HashMap<String, String>,
    pub flags: Vec<FlagEntry>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub latest_compaction_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mcp_servers: Option<Vec<McpServerStatusEntry>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub most_recent_assistant_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pending_interrogatives: Option<Vec<DaemonEvent>>,
    pub plugin_config: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub project_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_control: Option<SourceControlSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub symlink_warnings: Option<Vec<SymlinkWarningInfo>>,
    pub todos: Vec<TodoSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub turn_in_flight: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTitleRequest {
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTitleResponse {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub overridden: Option<bool>,
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SourceControlSnapshot {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ahead: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub behind: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub dirty: Option<bool>,
    pub kind: SourceControlKind,
    pub label: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SseEnvelope {
    pub emitted_at: String,
    pub event: DaemonEvent,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub seq: Option<i64>,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[allow(
    clippy::large_enum_variant,
    reason = "generated wire type mirrors daemon OpenAPI shape"
)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StateDelta {
    FlagImportant {
        mode: FlagMode,
        path: String,
    },
    UnflagImportant {
        path: String,
    },
    TodoCreate {
        dependencies: Vec<i64>,
        description: String,
        id: i64,
        title: String,
    },
    TodoUpdate {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        description: Option<String>,
        id: i64,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        status: Option<TodoStatus>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        title: Option<String>,
    },
    TodoComplete {
        id: i64,
    },
    TodoDeleted {
        id: i64,
    },
    EnvUpdate {
        env_vars: std::collections::HashMap<String, String>,
    },
    ToolReveal {
        names: Vec<String>,
        source: ToolRevealSource,
    },
    SessionEditFormatLocked {
        format: String,
        source: LockSource,
    },
    SubagentExitMode,
    FileTouched {
        observation: FileObservation,
        path: String,
    },
    GitMetadataObserved {
        fingerprint: String,
    },
    ScratchWrite {
        key: String,
        pad: ScratchPad,
        value: serde_json::Value,
    },
    ScratchClear {
        pad: ScratchPad,
    },
    GoalMetadataChanged {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        goal: Option<CurrentGoal>,
        transition: GoalTransition,
    },
    Pushd {
        path: String,
    },
    Popd,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SubagentOutcome {
    pub kind: SubagentResultKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SymlinkWarningInfo {
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SystemReminder {
    pub body: String,
    pub display_name: String,
    pub emitted_at: String,
    pub reason: SystemReminderReason,
    pub slug: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SystemReminderReason {
    SessionStart,
    SessionResumed,
    PostCompaction {
        compaction_id: CompactionId,
    },
    PostContextCleared,
    HookAdditionalContext {
        hook_name: String,
    },
    SkillReference {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt_id: Option<PromptId>,
    },
    FileReference {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt_id: Option<PromptId>,
    },
    SubagentReference {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt_id: Option<PromptId>,
    },
    ForcedToolCall {
        tool_name: String,
    },
    ContextPressure,
    TaskTrackingNudge,
    TodoStatusNudge,
    GoalReminder,
    PlanModeReinforcement,
    PlanReviewRequired,
    PlanVerification,
    CwdChanged,
    WorkingDirectoryDeleted,
    McpServerDisabled {
        server_name: String,
    },
    McpServerEnabled {
        server_name: String,
    },
    PermissionRuleMessage {
        tool_name: String,
    },
    EmptyResponseNudge,
    NotificationDrain,
    PlanReentryTodoCleanup,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TerminalReason {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
    pub kind: TerminalReasonKind,
}

pub type TerminalReasonKind = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TerminateResponse {
    pub status: TerminateStatus,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TodoDeleteConflictResponse {
    DependentsExist {
        code: String,
        dependents: Vec<TodoDeleteDependent>,
        message: String,
    },
    TurnInFlight {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        retry_after_seconds: Option<i64>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TodoDeleteDependent {
    pub id: i64,
    pub status: TodoStatus,
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TodoSnapshot {
    pub dependencies: Vec<i64>,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub emitted_at: Option<String>,
    pub id: i64,
    pub status: TodoStatus,
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Tool { name: String },
}

pub type ToolError = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolExposureReason {
    ModelChanged,
    FacetChanged,
    ReloadAffectedToolLoading,
    CompactionReset,
    EagerFallbackActivated,
    SessionEditFormatRelocked { from: String, to: String },
}

pub type ToolLiveDisplayContent = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolResult {
    pub content: ToolResultContent,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub live_display: Option<ToolLiveDisplayContent>,
    pub tool_use_id: String,
}

pub type ToolResultContent = serde_json::Value;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolRevealSource {
    ToolSearch,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TuiAttachClaimRequest {
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub process_start_token: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub terminal_label: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TuiAttachClaimResponse {
    pub expires_after_seconds: i64,
    pub expires_at: String,
    pub heartbeat_interval_seconds: i64,
    pub lease_id: TuiAttachmentLeaseId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TuiAttachHeartbeatRequest {
    pub lease_id: TuiAttachmentLeaseId,
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub process_start_token: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TuiAttachHeartbeatResponse {
    pub expires_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TuiAttachmentConflictResponse {
    pub active: TuiAttachmentSnapshot,
    pub message: String,
}

pub type TuiAttachmentLeaseId = String;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TuiAttachmentSnapshot {
    pub active_pid: i32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_process_start_token: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_terminal_label: Option<String>,
    pub expires_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TuiAttachmentSnapshotResponse {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active: Option<TuiAttachmentSnapshot>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TurnCancelAccepted {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub prompt_id: Option<PromptId>,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TurnChunk {
    BlockStart {
        index: i32,
    },
    Delta {
        delta: BlockDeltaPayload,
        index: i32,
    },
    BlockStop {
        index: i32,
    },
    Usage {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cache_creation_input_tokens: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        cache_read_input_tokens: Option<i32>,
        input_tokens: i32,
        output_tokens: i32,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UsageAction {
    Proceed,
    Delay { delay_ms: i64 },
    Backoff { retry_after_ms: i64 },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VersionResponse {
    pub version: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireModelReasoningCapability {
    NoReasoning,
    Effort {
        can_disable: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        default_level: Option<String>,
        effort_set: String,
        levels: Vec<String>,
    },
    Thinking {
        can_disable: bool,
    },
}
