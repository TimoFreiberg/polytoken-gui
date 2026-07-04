//! The testable heart of the polytoken driver — given a daemon event,
//! an accumulator, and a little context, it returns zero or more pilot events to fold +
//! broadcast, plus zero or more side-effect descriptors for the driver to execute.
//!
//! Port of `server/src/polytoken/event-map.ts` (1286 LOC).
//!
//! polytoken's stream is Anthropic Messages-API-shaped (message_start →
//! content_block_start → content_block_delta → content_block_stop → message_complete),
//! so this mapper carries a small ACCUMULATOR that tracks the current block kind and
//! accrues tool-use input.
//!
//! This is a PURE function (no I/O). The driver executes the returned
//! [`DaemonEffect`]s after emitting the pure [`SessionDriverEvent`]s.
//!
//! Shapes grounded in the binary's own self-describing schemas (`polytoken openapi` /
//! `polytoken event-schema`).

use pilot_daemon_types::{
    BlockDeltaPayload, ContentBlockKind, CurrentGoal, DaemonEvent, PermissionCandidateRuleContext,
    PermissionMonitor, ProviderError, SessionStateSnapshot, SystemReminderReason,
    ToolLiveDisplayContent,
};
use pilot_protocol::session_driver::{
    AssistantDeltaChannel, FlaggedFile, FlaggedFileMode, GoalInfo, HostUiRequest, ImageContent,
    McpServerInfo, NotifyLevel, PermissionMonitorMode, QnaQuestion, QnaQuestionOption,
    SessionConfig, SessionDriverEvent, SessionEventBase, SessionMessageDeliveryMode,
    SessionQueuedMessage, SessionSnapshot, SessionStatus, SessionUsage, TodoItem,
    TodoStatus as PilotTodoStatus, WorkspaceRef,
};

use crate::polytoken::models::{ModelRef, default_model_ref};
use crate::polytoken::ui_bridge::{
    PERMISSION_APPROVAL_CHOICES, PERMISSION_APPROVAL_LABELS, PendingInterrogative,
    PendingInterrogativeType, PendingQuestion, prune_approval_options,
};

// ---------------------------------------------------------------------------
// Accumulator — the event-fold's working memory.
//
// polytoken streams content blocks incrementally: content_block_start sets the
// kind, content_block_delta(s) feed text or accrue tool-use input, content_block_stop
// closes the window. tool_call is authoritative — it carries the complete parsed
// input, so we emit toolStarted immediately. message_complete is the turn boundary.
//
// The accumulator also tracks turn-level error state: model_error sets it,
// message_start (a retry/new message) clears it, message_complete consumes it to
// decide runFailed vs runCompleted. This mirrors the original driver's pattern of deferring the
// failure decision to the turn boundary (the original driver scans messages at agent_end for
// stopReason:"error"), rather than failing the run on every transient error that
// the daemon might retry past.
// ---------------------------------------------------------------------------

/// The current block's ContentBlockKind discriminator (from content_block_start).
/// `None` when no block is open. Routes deltas to the correct channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Text,
    ToolUse,
    Thinking,
    RedactedThinking,
    OpenAiReasoningOpaque,
}

/// The current tool_use block's metadata from content_block_start (id, name).
/// Used as a fallback if the tool_call event omits them.
#[derive(Debug, Clone)]
pub struct ToolUseBlockMeta {
    pub id: String,
    pub name: String,
}

/// The event-fold's working memory. Tracks the current streaming block kind,
/// accrues partial JSON for tool_use blocks, and holds turn-level error state.
#[derive(Debug, Clone)]
pub struct FoldAccumulator {
    /// The current block's kind discriminator (from content_block_start).
    /// `None` when no block is open. Routes deltas to the correct channel.
    pub block_kind: Option<BlockKind>,
    /// Accumulated partial_json for an in-flight tool_use block (emitted on tool_call).
    pub tool_input_buffer: String,
    /// The current tool_use block's metadata from content_block_start (id, name).
    /// Used as a fallback if the tool_call event omits them.
    pub tool_use_block: Option<ToolUseBlockMeta>,
    /// Set by model_error; consumed (and cleared) by message_complete. If set at
    /// turn end, the run fails instead of completing. Cleared by message_start
    /// (a retry starts a new message — the error was transient).
    pub turn_error: Option<TurnError>,
}

/// Turn-level error state set by `model_error`, consumed by `message_complete`.
#[derive(Debug, Clone)]
pub struct TurnError {
    pub message: String,
}

/// Create a fresh accumulator in its initial state.
pub fn create_accumulator() -> FoldAccumulator {
    FoldAccumulator {
        block_kind: None,
        tool_input_buffer: String::new(),
        tool_use_block: None,
        turn_error: None,
    }
}

/// Reset an accumulator to its initial state. The driver MUST call this on SSE
/// reconnect (a stream_discontinuity → reseed, or a fresh subscribe after a
/// dropped connection): without it, a stale `turn_error` from a turn that never
/// reached message_complete (e.g. the daemon crashed mid-error-retry) would leave
/// the session stuck "running" forever — the reseed refreshes the state snapshot
/// to idle, but the accumulator's turn_error would cause the NEXT message_complete
/// to spuriously fail. Spike §6: SSE is push-only with no periodic heartbeats,
/// so a reconnect is the only signal that stream state may have been lost.
pub fn reset_accumulator(acc: &mut FoldAccumulator) {
    acc.block_kind = None;
    acc.tool_input_buffer.clear();
    acc.tool_use_block = None;
    acc.turn_error = None;
}

// ---------------------------------------------------------------------------
// Context — provided by the driver, like the original driver's MapCtx.
// ---------------------------------------------------------------------------

/// Context provided by the driver. The TS `MapCtx` interface becomes this trait.
/// The mapper never does I/O — it reads the driver's cached state via `snapshot()`
/// and `live_status()`.
pub trait MapCtx {
    /// The session ref (workspaceId + sessionId).
    fn r#ref(&self) -> &pilot_protocol::session_driver::SessionRef;
    /// The workspace ref.
    fn workspace(&self) -> &WorkspaceRef;
    /// A current timestamp string (ISO 8601).
    fn now(&self) -> String;
    /// Build a snapshot reflecting the current title/config/usage at a given status.
    /// Uses the driver's cached lastState (the mapper never does I/O).
    fn snapshot(&self, status: SessionStatus) -> SessionSnapshot;
    /// The session's live run status, for out-of-band events (a rename mid-turn) that
    /// must NOT report idle — that would close the streaming bubble + clear the
    /// running indicator. Derived from the cached state's turn_in_flight flag.
    fn live_status(&self) -> SessionStatus;
}

// ---------------------------------------------------------------------------
// Effects — side-effect descriptors the mapper returns alongside events.
//
// The mapper is pure (no I/O). Some mappings need a state fetch (usage is on
// GET /state, not on the event) or a queue refresh. These
// are returned as effect descriptors; the driver executes them after emitting the
// pure events. For fetchState effects, the driver calls build_post_fetch_event()
// (also pure, tested) to produce the follow-up event from the refreshed cache.
// ---------------------------------------------------------------------------

/// Which follow-up event a `FetchState` effect should emit after refreshing the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchEmit {
    RunCompleted,
    SessionUpdated,
}

/// Side-effect descriptors the mapper returns alongside events. The driver
/// executes these (HTTP calls) AFTER emitting the pure events.
#[derive(Debug, Clone)]
pub enum DaemonEffect {
    /// GET /state → refresh the cached state, then emit the named follow-up event
    /// via `build_post_fetch_event()`. The mapper can't build these events itself
    /// because they need the FRESH state (usage, title, config) that only the
    /// fetch provides. `prompt_id` is the daemon's per-turn PromptId (carried by
    /// message_complete); `build_post_fetch_event` threads it onto runCompleted
    /// as the branch-handle entryIds so the transcript's branch buttons work.
    /// Absent for sessionUpdated (no turn completed) and on the sessionUpdated
    /// fetchState from turn_cancelled.
    FetchState {
        emit: FetchEmit,
        prompt_id: Option<String>,
    },
    /// GET /history + GET /state → full re-seed (stream_discontinuity drops
    /// events; session_rewound truncates history). Emits a sessionUpdated
    /// from the refreshed state, then the full re-broadcast.
    Reseed,
    /// GET /turn/input → queueUpdated with the refreshed queue. The queue events
    /// (queued/dequeued/discarded) don't carry the FULL queue, only one item +
    /// revision; pilot's queueUpdated REPLACES the full queue, so we must fetch.
    RefetchQueue,
    /// Update the cached permission-monitor mode (the permission_monitor_switch
    /// event carries the authoritative new mode; the cache must track it so
    /// subsequent ctx.snapshot() calls reflect it). Emitted alongside a
    /// sessionUpdated snapshot that carries the new mode directly (the snapshot is
    /// built from the event payload, not the still-stale cache).
    SetMonitorMode { mode: PermissionMonitorMode },
    /// Update the cached notification-autodrain flag so subsequent ctx.snapshot()
    /// calls reflect it. Emitted alongside a sessionUpdated snapshot carrying the
    /// new value from the event payload.
    SetAutodrainEnabled { enabled: bool },
    /// Register a pending interrogative in the driver's pending map (so respondUi
    /// can build the reverse InterrogativeResponse from a later HostUiResponse) AND
    /// emit the matching pilot hostUiRequest card. The effect carries the
    /// PendingInterrogative metadata the reverse builder needs; the hostUiRequest
    /// event is in the returned `events` (emitted before effects, per the driver's
    /// emit-then-execute contract).
    RegisterInterrogative { pending: PendingInterrogative },
}

/// The result of mapping one daemon event: pilot events to emit + side-effect
/// requests for the driver to execute (HTTP calls) AFTER emitting.
#[derive(Debug, Clone, Default)]
pub struct FoldResult {
    /// Pilot driver events to emit (broadcast to hub listeners).
    pub events: Vec<SessionDriverEvent>,
    /// Side-effect requests for the driver to execute (HTTP calls) AFTER emitting.
    pub effects: Vec<DaemonEffect>,
}

/// Build a `FoldResult` from events + optional effects. Convenience helper
/// matching the TS `events()` function.
fn fold_result(events: Vec<SessionDriverEvent>, effects: Vec<DaemonEffect>) -> FoldResult {
    FoldResult { events, effects }
}

/// Build the `SessionEventBase` (sessionRef + timestamp) common to every event.
fn meta(ctx: &dyn MapCtx) -> SessionEventBase {
    SessionEventBase {
        session_ref: ctx.r#ref().clone(),
        timestamp: ctx.now(),
        run_id: None,
    }
}

/// Build a `hostUiRequest{kind:"notify"}` SessionDriverEvent. Pure — no I/O.
/// Encapsulates the shared notify structure so each call site only specifies its
/// requestId, message, and level.
fn notify(
    base: SessionEventBase,
    request_id: String,
    message: String,
    level: NotifyLevel,
) -> SessionDriverEvent {
    SessionDriverEvent::HostUiRequest {
        base,
        request: HostUiRequest::Notify {
            request_id,
            message,
            level: Some(level),
        },
    }
}

/// System-reminder reason types that surface as visible inject pills instead of
/// silent turn-boundary markers. Maps the daemon's `SystemReminderReason` to a
/// human-readable pill label.
fn plan_review_label(reason: &SystemReminderReason) -> Option<&'static str> {
    match reason {
        SystemReminderReason::PlanReviewRequired => Some("Plan review required"),
        SystemReminderReason::PlanModeReinforcement => Some("Plan mode reminder"),
        SystemReminderReason::PlanVerification => Some("Plan verification"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Extract a human-readable message from a ProviderError (the model_error payload).
fn provider_error_message(error: &ProviderError) -> String {
    match error {
        ProviderError::RateLimited {
            retry_after_seconds,
        } => match retry_after_seconds {
            Some(secs) => format!("Rate limited (retry in {}s)", secs),
            None => "Rate limited".to_string(),
        },
        ProviderError::AuthFailed => "Authentication failed".to_string(),
        ProviderError::LoginRequired { profile } => {
            format!("Login required ({})", profile)
        }
        ProviderError::ModelNotFound => "Model not found".to_string(),
        ProviderError::ContextTooLarge { .. } => "Context too large".to_string(),
        ProviderError::Transport { message } => {
            format!("Transport error: {}", message)
        }
        ProviderError::ProtocolMalformed { detail } => {
            format!("Protocol error: {}", detail)
        }
        ProviderError::Canceled => "Request canceled".to_string(),
        ProviderError::Other { code, message } => format!("{}: {}", code, message),
    }
}

// ---------------------------------------------------------------------------
// Goal projection
// ---------------------------------------------------------------------------

/// Project the daemon's `current_goal` onto pilot's `GoalInfo` for the StatusHeader
/// goal badge. Mirrors the null/undefined distinction the daemon makes:
/// - a CurrentGoal object → `Some(Some(GoalInfo))` (summary + lifecycle), so the badge renders
/// - null (explicitly cleared) → `Some(None)`, so the fold clears state.goal (badge hides)
/// - undefined (field absent, older daemon / event omits it) → `None`, so the
///   fold preserves a known goal (no clobber).
///
/// The daemon's full CurrentGoal (timestamps, continuation count, file paths) is
/// trimmed to just what the UI needs. Shared by `snapshot_from_state` (reads
/// `state.current_goal`) and the `goal_driver_update` handler (reads `ev.goal`).
///
/// # The three-way input
///
/// The TS input is `CurrentGoal | null | undefined`. We model this as
/// `Option<Option<&CurrentGoal>>`:
/// - `Some(Some(&g))` → the daemon carried a goal object → set
/// - `Some(None)` → the daemon carried `null` (explicitly cleared) → clear
/// - `None` → the field was absent (older daemon / event omitted it) → preserve
fn project_goal(g: Option<Option<&CurrentGoal>>) -> Option<Option<GoalInfo>> {
    match g {
        Some(Some(goal)) => Some(Some(GoalInfo {
            summary: goal.summary.clone(),
            lifecycle: goal.lifecycle.clone(),
        })),
        Some(None) => Some(None),
        None => None,
    }
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

/// Extract pilot's `SessionUsage` from a daemon state snapshot's `context_usage`.
/// Returns `None` when the daemon didn't carry context_usage.
pub fn usage_from_state(state: Option<&SessionStateSnapshot>) -> Option<SessionUsage> {
    let cu = state.and_then(|s| s.context_usage.as_ref())?;
    let percent = if cu.limit_tokens > 0 {
        Some((cu.used_tokens as f64 / cu.limit_tokens as f64 * 100.0).round())
    } else {
        None
    };
    Some(SessionUsage {
        tokens: Some(cu.used_tokens as i64),
        context_window: cu.limit_tokens as i64,
        percent,
    })
}

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

/// Build a `SessionSnapshot` from a cached daemon state snapshot. Pure — used by
/// the driver's `ctx.snapshot()` and by `build_post_fetch_event()`.
///
/// `monitor_mode` and `autodrain_enabled` override the snapshot's respective
/// fields (they come from the event payload, not the still-stale cache).
#[allow(clippy::too_many_arguments)]
pub fn snapshot_from_state(
    state: Option<&SessionStateSnapshot>,
    r#ref: &pilot_protocol::session_driver::SessionRef,
    workspace: &WorkspaceRef,
    status: SessionStatus,
    now: &str,
    monitor_mode: Option<PermissionMonitorMode>,
    autodrain_enabled: Option<bool>,
) -> SessionSnapshot {
    let title = state
        .and_then(|s| s.session_title.as_deref())
        .unwrap_or(&r#ref.session_id)
        .to_string();

    // active_model is stored as the FULL `provider/id` registry name
    // (e.g. "anthropic/claude-sonnet-4"). modelId stays the full registry name —
    // matching ModelOption.modelId from parseModels and the default markers via
    // defaultModelRef — so ModelPicker's store.models.find() resolves the friendly
    // label instead of falling back to the bare id. `provider` is the bare prefix
    // (group key), mirroring parseModels. If a model string ever lacks a slash (a
    // custom/local name), defaultModelRef degrades both to the whole string.
    let config = state.and_then(|s| s.active_model.as_deref()).map(|m| {
        let ModelRef { provider, model_id } = default_model_ref(m);
        SessionConfig {
            provider: Some(provider),
            model_id: Some(model_id),
            thinking_level: state
                .and_then(|s| s.active_reasoning_effort.as_deref())
                .map(|s| s.to_string()),
            available_thinking_levels: None,
        }
    });

    // Thread current_goal → goal. Three cases: a CurrentGoal object → set (the
    // daemon carries summary + lifecycle); null (explicitly cleared) → null (the
    // fold clears state.goal so the badge hides); undefined (field absent, older
    // daemon) → undefined (the fold preserves a known goal).
    //
    // When `state` is None (no cached state), current_goal is absent → preserve.
    // When `state` is Some, current_goal is Option<CurrentGoal>: Some → set, None → cleared.
    let goal = project_goal(state.map(|s| s.current_goal.as_ref()));

    // Thread flags + todos from the daemon state. The daemon's schema requires
    // these (FlagEntry[] / TodoSnapshot[]), so they're present on every snapshot.
    // Project to pilot's trimmed types. None when state is null (older daemon
    // or cold path — the fold preserves the known list).
    let flags = state.map(|s| {
        s.flags
            .iter()
            .map(|f| FlaggedFile {
                path: f.path.clone(),
                mode: match f.mode {
                    pilot_daemon_types::FlagMode::Included => FlaggedFileMode::Included,
                    pilot_daemon_types::FlagMode::Referenced => FlaggedFileMode::Referenced,
                },
            })
            .collect::<Vec<_>>()
    });

    let todos = state.map(|s| {
        s.todos
            .iter()
            .map(|t| TodoItem {
                id: t.id,
                title: t.title.clone(),
                description: t.description.clone(),
                status: match t.status {
                    pilot_daemon_types::TodoStatus::Pending => PilotTodoStatus::Pending,
                    pilot_daemon_types::TodoStatus::InProgress => PilotTodoStatus::InProgress,
                    pilot_daemon_types::TodoStatus::Done => PilotTodoStatus::Done,
                    pilot_daemon_types::TodoStatus::Blocked => PilotTodoStatus::Blocked,
                },
                dependencies: t.dependencies.clone(),
            })
            .collect::<Vec<_>>()
    });

    // Thread MCP server statuses from the daemon state. Same overwrite-guarded
    // semantics as flags/todos.
    let mcp_servers = state.and_then(|s| s.mcp_servers.as_ref()).map(|servers| {
        servers
            .iter()
            .map(|s| McpServerInfo {
                server_name: s.server_name.clone(),
                status: match s.status {
                    pilot_daemon_types::McpServerStatus::Connected => {
                        pilot_protocol::session_driver::McpServerStatus::Connected
                    }
                    pilot_daemon_types::McpServerStatus::Disconnected => {
                        pilot_protocol::session_driver::McpServerStatus::Disconnected
                    }
                    pilot_daemon_types::McpServerStatus::Reconnecting => {
                        pilot_protocol::session_driver::McpServerStatus::Reconnecting
                    }
                    pilot_daemon_types::McpServerStatus::Disabled => {
                        pilot_protocol::session_driver::McpServerStatus::Disabled
                    }
                },
                tool_count: s.tool_count as i64,
            })
            .collect::<Vec<_>>()
    });

    SessionSnapshot {
        r#ref: r#ref.clone(),
        workspace: workspace.clone(),
        title,
        status,
        updated_at: now.to_string(),
        archived_at: None,
        preview: None,
        config,
        usage: usage_from_state(state),
        running_run_id: None,
        queued_messages: None,
        facet: state.map(|s| s.active_facet.clone()),
        permission_monitor: monitor_mode,
        adventurous_handoff: state
            .and_then(|s| s.adventurous_handoff_active)
            .or(Some(false))
            .filter(|&v| v),
        notification_autodrain: autodrain_enabled,
        active_plan: state
            .and_then(|s| s.active_plan.as_deref())
            .map(|s| s.to_string()),
        goal,
        flags,
        todos,
        mcp_servers,
    }
}

// ---------------------------------------------------------------------------
// Tool input / result helpers
// ---------------------------------------------------------------------------

/// Parse accumulated tool-use input. Falls back to raw string if not valid JSON.
/// Returns `None` for an empty buffer (matching the TS `undefined` return).
fn parse_tool_input(buffer: &str) -> Option<serde_json::Value> {
    if buffer.is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(buffer) {
        Ok(v) => Some(v),
        Err(_) => Some(serde_json::Value::String(buffer.to_string())),
    }
}

/// The extracted output text + optional images from a tool_result event.
struct ToolResultExtract {
    output: Option<serde_json::Value>,
    images: Option<Vec<ImageContent>>,
}

/// Extract output text + lift image content from a polytoken tool_result event.
///
/// `content` is the short-form truncated string; `content_full` carries the rich
/// display content (ToolLiveDisplayContent = ToolResultContent | {diff_preview}).
/// ToolResultContent has three variants: {text}, {blocks}, {image}. We lift the
/// image into the typed `images` field (like the original driver's splitToolResult) and extract text
/// for `output`.
fn extract_tool_result(
    content: Option<&str>,
    content_full: Option<&ToolLiveDisplayContent>,
) -> ToolResultExtract {
    if let Some(cf) = content_full {
        if let Some(cf_obj) = cf.as_object() {
            // Image variant: {image: {data, media_type, text_fallback}}
            if let Some(img) = cf_obj.get("image").and_then(|v| v.as_object()) {
                let data = img.get("data").and_then(|v| v.as_str());
                let media_type = img.get("media_type").and_then(|v| v.as_str());
                if let (Some(data), Some(media_type)) = (data, media_type) {
                    let text_fallback = img.get("text_fallback").and_then(|v| v.as_str());
                    return ToolResultExtract {
                        output: Some(serde_json::Value::String(
                            content.unwrap_or(text_fallback.unwrap_or("")).to_string(),
                        )),
                        images: Some(vec![ImageContent::Image {
                            data: data.to_string(),
                            mime_type: media_type.to_string(),
                        }]),
                    };
                }
            }
            // Text variant: {text: string}
            if let Some(text) = cf_obj.get("text").and_then(|v| v.as_str()) {
                return ToolResultExtract {
                    output: Some(serde_json::Value::String(
                        content.unwrap_or(text).to_string(),
                    )),
                    images: None,
                };
            }
            // Blocks variant: {blocks: ContentBlock[]} — extract text blocks
            if let Some(blocks) = cf_obj.get("blocks").and_then(|v| v.as_array()) {
                let text = blocks
                    .iter()
                    .filter_map(|b| {
                        let is_text = b
                            .as_object()
                            .and_then(|o| o.get("type"))
                            .and_then(|v| v.as_str())
                            == Some("text");
                        if is_text {
                            b.as_object()
                                .and_then(|o| o.get("text"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        } else {
                            None
                        }
                    })
                    .collect::<String>();
                return ToolResultExtract {
                    output: Some(serde_json::Value::String(
                        content.unwrap_or(&text).to_string(),
                    )),
                    images: None,
                };
            }
            // Diff preview variant: {diff_preview: {summary, ...}}
            if let Some(dp) = cf_obj.get("diff_preview").and_then(|v| v.as_object()) {
                let summary = dp.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                return ToolResultExtract {
                    output: Some(serde_json::Value::String(
                        content.unwrap_or(summary).to_string(),
                    )),
                    images: None,
                };
            }
        }
    }
    // Fallback: just the truncated content string
    ToolResultExtract {
        output: content.map(|c| serde_json::Value::String(c.to_string())),
        images: None,
    }
}

/// Build a stable `SessionQueuedMessage` from a `pending_turn_input_drained` event's
/// content. The daemon doesn't distinguish steer from followUp; pilot's
/// mode is UX-only, so we default to "steer" (the mid-turn case).
fn drained_queue_message(text: &str, item_id: Option<&str>, ts: &str) -> SessionQueuedMessage {
    let id = item_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("drain-{}", ts));
    SessionQueuedMessage {
        id,
        mode: SessionMessageDeliveryMode::Steer,
        text: text.to_string(),
        created_at: ts.to_string(),
        updated_at: ts.to_string(),
    }
}

/// JSON-stringify a `serde_json::Value` with a fallback for non-serializable values.
/// Pretty-prints with 2-space indent (matching `JSON.stringify(value, null, 2)`).
fn safe_stringify(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

// ---------------------------------------------------------------------------
// Forward interrogative mapping — DaemonEvent → pilot hostUiRequest card.
//
// Each builder returns (a) the pilot hostUiRequest event to emit AND (b) the
// PendingInterrogative metadata the reverse builder (ui-bridge.rs) needs to
// translate a later HostUiResponse back. The mapper bundles the metadata into
// a registerInterrogative effect; the driver stores it in its pending map.
//
// The index↔key/id mappings here are the SINGLE source of truth — ui-bridge.rs's
// reverse builders read them back by index, so the order here MUST match.
// ---------------------------------------------------------------------------

/// The result of building an interrogative mapping: the pilot event to emit +
/// the pending metadata for the reverse builder.
struct InterrogativeMapping {
    event: SessionDriverEvent,
    pending: PendingInterrogative,
}

/// Build the pilot hostUiRequest + pending metadata for an `interrogative` event.
/// One interrogative_type → one card kind. The card carries a stable requestId
/// equal to the daemon's interrogative_id, so respondUi can look it up. For an
/// unrecognized type (a runtime-only path — serde would deserialize it as an
/// unknown variant), the default arm emits a blocking `confirm` dialog and
/// registers the pending so the operator can dismiss it → {kind:"cancel"}.
#[allow(
    clippy::too_many_arguments,
    reason = "mapping mirrors daemon interrogative payload fields"
)]
fn build_interrogative_mapping(
    interrogative_id: &str,
    interrogative_type: &pilot_daemon_types::InterrogativeType,
    question: &str,
    clarification_options: Option<&[pilot_daemon_types::ClarificationOption]>,
    plan_handoff: Option<&pilot_daemon_types::PlanHandoffContext>,
    goal_proposal: Option<&pilot_daemon_types::GoalProposalContext>,
    permission_candidate_rule: Option<&PermissionCandidateRuleContext>,
    permission_tool_call: Option<&pilot_daemon_types::PermissionToolCallContext>,
    base: SessionEventBase,
) -> InterrogativeMapping {
    let request_id = interrogative_id.to_string();
    let pending_type: PendingInterrogativeType = interrogative_type.clone().into();
    let mut pending = PendingInterrogative {
        interrogative_id: interrogative_id.to_string(),
        interrogative_type: pending_type,
        clarification_labels: None,
        clarification_option_keys: None,
        plan_handoff_labels: None,
        questions: None,
        permission_choices: None,
    };

    match interrogative_type {
        pilot_daemon_types::InterrogativeType::Confirmation => {
            let event = SessionDriverEvent::HostUiRequest {
                base,
                request: HostUiRequest::Confirm {
                    request_id,
                    title: "Confirm".to_string(),
                    message: question.to_string(),
                    default_value: None,
                    timeout_ms: None,
                },
            };
            InterrogativeMapping { event, pending }
        }
        pilot_daemon_types::InterrogativeType::Clarification => {
            // Clarification options carry {key,label}. pilot's select renders labels;
            // the response carries the chosen LABEL, which the reverse builder maps
            // back to the daemon's key via the parallel labels/keys arrays.
            let options = clarification_options.unwrap_or(&[]);
            let labels: Vec<String> = options.iter().map(|o| o.label.clone()).collect();
            let keys: Vec<String> = options.iter().map(|o| o.key.clone()).collect();
            pending.clarification_labels = Some(labels.clone());
            pending.clarification_option_keys = Some(keys);
            let event = SessionDriverEvent::HostUiRequest {
                base,
                request: HostUiRequest::Select {
                    request_id,
                    title: question.to_string(),
                    options: labels,
                    allow_multiple: None,
                    timeout_ms: None,
                },
            };
            InterrogativeMapping { event, pending }
        }
        pilot_daemon_types::InterrogativeType::Capability => {
            // A capability grant is a yes/no — pilot's confirm card fits.
            let event = SessionDriverEvent::HostUiRequest {
                base,
                request: HostUiRequest::Confirm {
                    request_id,
                    title: "Grant capability?".to_string(),
                    message: question.to_string(),
                    default_value: None,
                    timeout_ms: None,
                },
            };
            InterrogativeMapping { event, pending }
        }
        pilot_daemon_types::InterrogativeType::PlanHandoff => {
            // Plan handoff: 3 choices. The action_labels (from PlanHandoffContext) give
            // the button text; the index order matches ui-bridge's PLAN_HANDOFF_DECISIONS.
            // Capture the rendered labels so the reverse builder can map the chosen
            // label → index → decision (the client sends the label, not an index).
            // Unlike `select`, the `plan` kind carries the plan markdown so ApprovalLayer
            // renders it instead of a blind generic dropdown.
            let labels: [String; 3] = if let Some(ph) = plan_handoff {
                [
                    ph.action_labels.implement_new_context.clone(),
                    ph.action_labels.implement_current_context.clone(),
                    ph.action_labels.cancel.clone(),
                ]
            } else {
                [
                    "Implement (new context)".to_string(),
                    "Implement (current context)".to_string(),
                    "Cancel".to_string(),
                ]
            };
            pending.plan_handoff_labels = Some(labels.to_vec());
            let ph = plan_handoff;
            let event = SessionDriverEvent::HostUiRequest {
                base,
                request: HostUiRequest::Plan {
                    request_id,
                    title: ph
                        .map(|p| p.title.clone())
                        .unwrap_or_else(|| "Plan handoff".to_string()),
                    plan_text: ph.map(|p| p.plan_text.clone()).unwrap_or_default(),
                    display_path: ph.map(|p| p.display_path.clone()),
                    target_facet: ph.map(|p| p.target_facet.clone()),
                    action_labels: labels,
                    timeout_ms: None,
                },
            };
            InterrogativeMapping { event, pending }
        }
        pilot_daemon_types::InterrogativeType::Permission => {
            // Permission approval: surfaces the tool name + input preview + pruned
            // options (only grants whose persistence target the daemon allows). The
            // build_permission_request helper captures the pruned choices in pending
            // so the reverse builder maps the chosen label → the right grant/target pair.
            build_permission_request(
                interrogative_id,
                question,
                permission_candidate_rule,
                permission_tool_call,
                base,
                &mut pending,
            )
        }
        pilot_daemon_types::InterrogativeType::GoalProposal => {
            // Goal proposal: the daemon proposes a goal and asks accept/reject. The
            // GoalProposalContext carries title + proposed_summary + optional file
            // path + action_labels (accept/reject button text). We render a confirm
            // card (Accept/Reject = confirmed true/false). The response maps to
            // goal_proposal_answer{accepted: boolean}.
            let gp = goal_proposal;
            let title = gp
                .map(|g| g.title.clone())
                .unwrap_or_else(|| "Goal proposal".to_string());
            let summary = gp.map(|g| g.proposed_summary.clone()).unwrap_or_default();
            let message = if summary.is_empty() {
                title.clone()
            } else {
                summary
            };
            let event = SessionDriverEvent::HostUiRequest {
                base,
                request: HostUiRequest::Confirm {
                    request_id,
                    title,
                    message,
                    default_value: None,
                    timeout_ms: None,
                },
            };
            InterrogativeMapping { event, pending }
        }
    }
}

/// Build the pilot `permission` hostUiRequest + pending metadata for a
/// permission interrogative. Surfaces the tool name + a JSON preview of the
/// tool's input (from the daemon's permission_tool_call), and prunes the 7
/// approval choices down to those whose persistence target the daemon's
/// keep_targets rule allows.
///
/// The pruned choices are captured in `pending.permission_choices` so the
/// reverse builder (ui-bridge.rs) can map the chosen label → its grant/target
/// pair. Pruning uses the shared `prune_approval_options` helper — the single
/// source of truth, also used by the mock fixture.
#[allow(clippy::too_many_arguments)]
fn build_permission_request(
    interrogative_id: &str,
    question: &str,
    permission_candidate_rule: Option<&PermissionCandidateRuleContext>,
    permission_tool_call: Option<&pilot_daemon_types::PermissionToolCallContext>,
    base: SessionEventBase,
    pending: &mut PendingInterrogative,
) -> InterrogativeMapping {
    let tc = permission_tool_call;
    let tool_name = tc.map(|t| t.tool_name.clone());
    // JSON-stringify the tool input for display, truncating to bound the card.
    // A null tool_call → null input (degraded but not silent).
    let tool_input = tc.map(|t| {
        let json = safe_stringify(&t.input);
        if json.len() > 500 {
            format!("{}…", &json[..499])
        } else {
            json
        }
    });

    let keep_targets: Option<&[pilot_daemon_types::PersistenceTarget]> =
        permission_candidate_rule.map(|r| r.keep_targets.as_slice());
    let choices = prune_approval_options(keep_targets);
    pending.permission_choices = Some(choices.clone());
    // Map each pruned choice to its label via the ORIGINAL index in the full
    // choices array (a choice's label is at the same index in
    // PERMISSION_APPROVAL_LABELS). Using the pruned array's index would misalign
    // labels after the first pruned entry.
    let options: Vec<String> = choices
        .iter()
        .filter_map(|choice| {
            // Find the original index of this choice in PERMISSION_APPROVAL_CHOICES
            PERMISSION_APPROVAL_CHOICES
                .iter()
                .position(|c| c == choice)
                .and_then(|i| PERMISSION_APPROVAL_LABELS.get(i).map(|s| s.to_string()))
        })
        .collect();

    let event = SessionDriverEvent::HostUiRequest {
        base,
        request: HostUiRequest::Permission {
            request_id: interrogative_id.to_string(),
            title: if question.is_empty() {
                "Approve?".to_string()
            } else {
                question.to_string()
            },
            tool_name,
            tool_input,
            options,
            timeout_ms: None,
        },
    };
    InterrogativeMapping {
        event,
        pending: pending.clone(),
    }
}

/// Build the pilot hostUiRequest (qna) + pending metadata for an
/// ask_user_question event. Each question maps to a QnaQuestion; the option ids
/// are captured so the reverse builder can map selected indices → ids.
fn build_ask_user_question_mapping(
    interrogative_id: &str,
    questions: &[pilot_daemon_types::AskUserQuestion],
    base: SessionEventBase,
) -> InterrogativeMapping {
    let request_id = interrogative_id.to_string();

    let pending_questions: Vec<PendingQuestion> = questions
        .iter()
        .map(|q| PendingQuestion {
            question_id: q.id.clone(),
            option_ids: q
                .options
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|o| o.id.clone())
                .collect(),
            option_labels: Some(
                q.options
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .map(|o| o.label.clone())
                    .collect(),
            ),
        })
        .collect();

    let pending = PendingInterrogative {
        interrogative_id: interrogative_id.to_string(),
        interrogative_type: PendingInterrogativeType::AskUserQuestion,
        clarification_labels: None,
        clarification_option_keys: None,
        plan_handoff_labels: None,
        questions: Some(pending_questions),
        permission_choices: None,
    };

    // Map the daemon's AskUserQuestion to pilot's QnaQuestion. single_select /
    // multi_select → a choice card (options present); text → free-text.
    let pilot_questions: Vec<QnaQuestion> = questions
        .iter()
        .map(|q| QnaQuestion {
            question: q.question.clone(),
            context: q.context.clone(),
            options: q.options.as_deref().map(|opts| {
                opts.iter()
                    .map(|o| QnaQuestionOption {
                        label: o.label.clone(),
                        description: if o.description.is_empty() {
                            None
                        } else {
                            Some(o.description.clone())
                        },
                    })
                    .collect()
            }),
            multi_select: Some(q.mode == pilot_daemon_types::AskUserQuestionMode::MultiSelect),
        })
        .collect();

    let event = SessionDriverEvent::HostUiRequest {
        base,
        request: HostUiRequest::Qna {
            request_id,
            title: None,
            questions: pilot_questions,
            timeout_ms: None,
        },
    };
    InterrogativeMapping { event, pending }
}

// ---------------------------------------------------------------------------
// Post-fetch event builder — pure, tested separately.
//
// After the driver executes a fetchState effect (GET /state → update cache), it
// calls this to build the follow-up event from the refreshed ctx (which reads the
// now-updated cache). This keeps ALL event-construction logic in pure, testable
// functions — the driver is just the I/O glue.
// ---------------------------------------------------------------------------

/// Build the follow-up event from a refreshed `MapCtx` after a `FetchState` effect.
///
/// On `RunCompleted`, the snapshot is built at `Idle` status and the `prompt_id`
/// (the daemon's per-turn id) becomes both `user_entry_id` and `assistant_entry_id`
/// — the branch handles the reducer stamps onto the turn's last user + assistant
/// items so the transcript's branch buttons resolve. Absent when the daemon
/// omitted `prompt_id` — the buttons stay hidden, matching the pre-fix state,
/// rather than sending a bad rewind target.
///
/// On `SessionUpdated`, the snapshot is built at the live status (a state change
/// can land mid-turn; don't force idle).
pub fn build_post_fetch_event(
    emit: FetchEmit,
    ctx: &dyn MapCtx,
    prompt_id: Option<&str>,
) -> SessionDriverEvent {
    let base = meta(ctx);
    match emit {
        FetchEmit::RunCompleted => SessionDriverEvent::RunCompleted {
            base,
            snapshot: ctx.snapshot(SessionStatus::Idle),
            user_entry_id: prompt_id.map(|s| s.to_string()),
            assistant_entry_id: prompt_id.map(|s| s.to_string()),
        },
        FetchEmit::SessionUpdated => SessionDriverEvent::SessionUpdated {
            base,
            snapshot: ctx.snapshot(ctx.live_status()),
        },
    }
}

// ---------------------------------------------------------------------------
// Daemon PermissionMonitor → pilot PermissionMonitorMode conversion
// ---------------------------------------------------------------------------

/// Convert the daemon's `PermissionMonitor` (a tagged enum with data) to pilot's
/// `PermissionMonitorMode` (a flat copy enum). The daemon's `type` tag is the
/// discriminator the TS reads via `ev.to_monitor.type`.
fn monitor_to_mode(monitor: &PermissionMonitor) -> PermissionMonitorMode {
    match monitor {
        PermissionMonitor::Standard => PermissionMonitorMode::Standard,
        PermissionMonitor::Bypass => PermissionMonitorMode::Bypass,
        PermissionMonitor::BypassPlus => PermissionMonitorMode::BypassPlus,
        PermissionMonitor::Autonomous { .. } => PermissionMonitorMode::Autonomous,
    }
}

// ---------------------------------------------------------------------------
// Subagent handle extraction
// ---------------------------------------------------------------------------

/// Extract the `subagent_handle` from a `DaemonEvent` (most variants carry it).
/// Returns `Some(handle)` when the event belongs to a nested subagent turn —
/// these must NOT pollute the top-level transcript.
///
/// Variants that DON'T carry subagent_handle (notification_autodrain_switch,
/// subsession_*, subagent_*, mcp_server_*) return `None` — they are never
/// subagent-filtered (the TS doesn't check them either; the switch in TS only
/// reads `subagent_handle` for variants that have it, and the others fall through
/// to their handlers because the check is at the top: `const subHandle = (ev as
/// {subagent_handle?: string | null}).subagent_handle; if (subHandle != null) return EMPTY;`
/// — for variants without the field, `subHandle` is `undefined` so they pass).
fn subagent_handle(ev: &DaemonEvent) -> Option<&str> {
    match ev {
        DaemonEvent::Heartbeat {
            subagent_handle, ..
        }
        | DaemonEvent::ContentBlockStart {
            subagent_handle, ..
        }
        | DaemonEvent::ContentBlockDelta {
            subagent_handle, ..
        }
        | DaemonEvent::ContentBlockStop {
            subagent_handle, ..
        }
        | DaemonEvent::MessageStart {
            subagent_handle, ..
        }
        | DaemonEvent::MessageComplete {
            subagent_handle, ..
        }
        | DaemonEvent::PendingTurnInputQueued {
            subagent_handle, ..
        }
        | DaemonEvent::PendingTurnInputDequeued {
            subagent_handle, ..
        }
        | DaemonEvent::PendingTurnInputDrained {
            subagent_handle, ..
        }
        | DaemonEvent::PendingTurnInputDiscarded {
            subagent_handle, ..
        }
        | DaemonEvent::TurnCancelled {
            subagent_handle, ..
        }
        | DaemonEvent::ModelError {
            subagent_handle, ..
        }
        | DaemonEvent::StreamDiscontinuity {
            subagent_handle, ..
        }
        | DaemonEvent::ToolCall {
            subagent_handle, ..
        }
        | DaemonEvent::ToolResult {
            subagent_handle, ..
        }
        | DaemonEvent::JobPromoted {
            subagent_handle, ..
        }
        | DaemonEvent::JobCompleted {
            subagent_handle, ..
        }
        | DaemonEvent::JobExpiring {
            subagent_handle, ..
        }
        | DaemonEvent::JobCancelled {
            subagent_handle, ..
        }
        | DaemonEvent::JobUpdated {
            subagent_handle, ..
        }
        | DaemonEvent::SessionRewound {
            subagent_handle, ..
        }
        | DaemonEvent::SessionStateChanged {
            source_subagent_handle: subagent_handle,
            ..
        }
        | DaemonEvent::SessionTitleChanged {
            subagent_handle, ..
        }
        | DaemonEvent::FacetSwitch {
            subagent_handle, ..
        }
        | DaemonEvent::ContextCleared {
            subagent_handle, ..
        }
        | DaemonEvent::ModelSwitch {
            subagent_handle, ..
        }
        | DaemonEvent::PermissionMonitorSwitch {
            subagent_handle, ..
        }
        | DaemonEvent::Interrogative {
            subagent_handle, ..
        }
        | DaemonEvent::AskUserQuestion {
            subagent_handle, ..
        }
        | DaemonEvent::HookFired {
            subagent_handle, ..
        }
        | DaemonEvent::ContextLoaded {
            subagent_handle, ..
        }
        | DaemonEvent::CompactionStarted {
            subagent_handle, ..
        }
        | DaemonEvent::CompactionComplete {
            subagent_handle, ..
        }
        | DaemonEvent::CompactionCancelled {
            subagent_handle, ..
        }
        | DaemonEvent::CompactionFailed {
            subagent_handle, ..
        }
        | DaemonEvent::SubagentCompactionNotice {
            subagent_handle, ..
        }
        | DaemonEvent::NotificationQueued {
            subagent_handle, ..
        }
        | DaemonEvent::NotificationsDrained {
            subagent_handle, ..
        }
        | DaemonEvent::SystemReminder {
            subagent_handle, ..
        }
        | DaemonEvent::ToolReveal {
            subagent_handle, ..
        }
        | DaemonEvent::ToolExposureChanged {
            subagent_handle, ..
        }
        | DaemonEvent::GoalDriverUpdate {
            subagent_handle, ..
        }
        | DaemonEvent::ClassifierDecision {
            subagent_handle, ..
        }
        | DaemonEvent::ExtensionRegistered {
            subagent_handle, ..
        }
        | DaemonEvent::ImageReferenceResolved {
            subagent_handle, ..
        }
        | DaemonEvent::UsageThrottle {
            subagent_handle, ..
        }
        | DaemonEvent::RetryWait {
            subagent_handle, ..
        }
        | DaemonEvent::AgentBlockViolation {
            subagent_handle, ..
        } => subagent_handle.as_deref(),
        // Variants that DON'T carry subagent_handle — always pass the filter.
        DaemonEvent::NotificationAutodrainSwitch { .. }
        | DaemonEvent::SubagentStarted { .. }
        | DaemonEvent::SubagentCompleted { .. }
        | DaemonEvent::SubsessionCreated { .. }
        | DaemonEvent::SubsessionStopped { .. }
        | DaemonEvent::SubsessionTerminated { .. }
        | DaemonEvent::SubsessionInterrogative { .. }
        | DaemonEvent::SubsessionMessage { .. }
        | DaemonEvent::McpServerConnected { .. }
        | DaemonEvent::McpServerDisconnected { .. }
        | DaemonEvent::McpServerReconnecting { .. }
        | DaemonEvent::McpServerDisabled { .. } => None,
    }
}

// ---------------------------------------------------------------------------
// ContentBlockKind → BlockKind conversion
// ---------------------------------------------------------------------------

/// Convert the daemon's `ContentBlockKind` (a tagged enum with data) to the
/// accumulator's `BlockKind` discriminator. Extracts just the variant — the
/// id/name metadata is handled separately by `content_block_start`.
fn block_kind_from_content(kind: &ContentBlockKind) -> BlockKind {
    match kind {
        ContentBlockKind::Text => BlockKind::Text,
        ContentBlockKind::ToolUse { .. } => BlockKind::ToolUse,
        ContentBlockKind::Thinking => BlockKind::Thinking,
        ContentBlockKind::RedactedThinking => BlockKind::RedactedThinking,
        ContentBlockKind::OpenAiReasoningOpaque => BlockKind::OpenAiReasoningOpaque,
    }
}

// ---------------------------------------------------------------------------
// The mapper — map one DaemonEvent to zero or more pilot events + effects.
//
// Subagent routing: every event variant (except subsession_*, mcp_server_*,
// subagent_*, notification_autodrain_switch) carries an optional subagent_handle.
// When non-null, the frame belongs to a NESTED subagent turn — not the
// top-level transcript. These route to empty (the subagent view is later);
// they must NOT pollute the top-level transcript.
// ---------------------------------------------------------------------------

/// Map one daemon event to zero or more pilot events + side-effect descriptors.
///
/// This is the core of the polytoken driver. It's a pure function (no I/O) with
/// an accumulator that tracks streaming block state. The driver calls this for
/// each SSE event, emits the returned `events`, then executes the returned
/// `effects` (HTTP calls).
pub fn map_daemon_event(
    ev: &DaemonEvent,
    acc: &mut FoldAccumulator,
    ctx: &dyn MapCtx,
) -> FoldResult {
    // Subagent routing: skip frames from nested subagent turns.
    if subagent_handle(ev).is_some() {
        return FoldResult::default();
    }

    let base = meta(ctx);

    match ev {
        // ===== Turn boundaries =====
        DaemonEvent::MessageStart { .. } => {
            // A turn began — the turn-start signal (like the original driver's agent_start). Also clears
            // any transient error state: if the daemon retries after a model_error, this
            // new message_start means the retry is underway.
            acc.turn_error = None;
            fold_result(
                vec![SessionDriverEvent::SessionUpdated {
                    base,
                    snapshot: ctx.snapshot(SessionStatus::Running),
                }],
                vec![],
            )
        }

        DaemonEvent::MessageComplete { prompt_id, .. } => {
            // The turn ended — the boundary choke point (like the original driver's agent_end). If a
            // model_error occurred during the turn (and wasn't cleared by a retry's
            // message_start), fail the run; otherwise fetch fresh state for usage +
            // emit runCompleted.
            if let Some(turn_err) = acc.turn_error.take() {
                return fold_result(
                    vec![SessionDriverEvent::RunFailed {
                        base,
                        error: pilot_protocol::session_driver::SessionErrorInfo {
                            message: turn_err.message,
                            code: None,
                            details: None,
                        },
                    }],
                    vec![],
                );
            }
            // Usage is on GET /state, not on the event. Defer to
            // the driver's fetchState effect, which refreshes the cache and then calls
            // build_post_fetch_event("runCompleted", ctx, promptId) to produce the
            // runCompleted event. The prompt_id is the daemon's per-turn id — the same
            // one the user message and assistant reply share — and becomes the branch
            // handle (entryId) that the transcript's "branch from here" buttons name.
            fold_result(
                vec![],
                vec![DaemonEffect::FetchState {
                    emit: FetchEmit::RunCompleted,
                    prompt_id: Some(prompt_id.clone()),
                }],
            )
        }

        DaemonEvent::TurnCancelled { .. } => {
            // Abort ack — the turn was cancelled. Re-read state for the authoritative
            // status (the daemon may have already settled to idle).
            fold_result(
                vec![],
                vec![DaemonEffect::FetchState {
                    emit: FetchEmit::SessionUpdated,
                    prompt_id: None,
                }],
            )
        }

        // ===== Content block streaming (the accumulator) =====
        DaemonEvent::ContentBlockStart { block_type, .. } => {
            // Set the current block kind so deltas know which channel to route to.
            acc.block_kind = Some(block_kind_from_content(block_type));
            acc.tool_input_buffer.clear();
            if let ContentBlockKind::ToolUse { id, name, .. } = block_type {
                acc.tool_use_block = Some(ToolUseBlockMeta {
                    id: id.clone(),
                    name: name.clone(),
                });
            } else {
                acc.tool_use_block = None;
            }
            FoldResult::default()
        }

        DaemonEvent::ContentBlockDelta { delta, .. } => {
            // text → assistantDelta (main channel)
            if let BlockDeltaPayload::Text { text } = delta {
                if acc.block_kind == Some(BlockKind::Text) {
                    return fold_result(
                        vec![SessionDriverEvent::AssistantDelta {
                            base,
                            text: text.clone(),
                            channel: Some(AssistantDeltaChannel::Text),
                            entry_id: None,
                        }],
                        vec![],
                    );
                }
            }
            // thinking → assistantDelta (thinking channel)
            if let BlockDeltaPayload::Thinking { text } = delta {
                if acc.block_kind == Some(BlockKind::Thinking) {
                    return fold_result(
                        vec![SessionDriverEvent::AssistantDelta {
                            base,
                            text: text.clone(),
                            channel: Some(AssistantDeltaChannel::Thinking),
                            entry_id: None,
                        }],
                        vec![],
                    );
                }
            }
            // redacted_thinking → assistantDelta (thinking channel, redacted content)
            if let BlockDeltaPayload::RedactedThinking { data } = delta {
                if acc.block_kind == Some(BlockKind::RedactedThinking) {
                    return fold_result(
                        vec![SessionDriverEvent::AssistantDelta {
                            base,
                            text: data.clone(),
                            channel: Some(AssistantDeltaChannel::Thinking),
                            entry_id: None,
                        }],
                        vec![],
                    );
                }
            }
            // open_ai_reasoning_opaque → assistantDelta (thinking channel, opaque reasoning)
            if let BlockDeltaPayload::OpenAiReasoningOpaque { data, .. } = delta {
                if acc.block_kind == Some(BlockKind::OpenAiReasoningOpaque) {
                    return fold_result(
                        vec![SessionDriverEvent::AssistantDelta {
                            base,
                            text: data.clone(),
                            channel: Some(AssistantDeltaChannel::Thinking),
                            entry_id: None,
                        }],
                        vec![],
                    );
                }
            }
            // tool_use_input → accumulate partial JSON (emit on tool_call)
            if let BlockDeltaPayload::ToolUseInput { partial_json } = delta {
                if acc.block_kind == Some(BlockKind::ToolUse) {
                    acc.tool_input_buffer.push_str(partial_json);
                }
            }
            // signature_delta: Anthropic thinking-block signature — pass through (no
            // pilot event; preserved for turn-2 replay by the daemon).
            FoldResult::default()
        }

        DaemonEvent::ContentBlockStop { .. } => {
            // Block complete. The tool_use accumulator emits on tool_call, not here.
            acc.block_kind = None;
            FoldResult::default()
        }

        // ===== Tool plumbing =====
        DaemonEvent::ToolCall {
            input,
            name,
            call_id,
            ..
        } => {
            // tool_call is authoritative: input is the complete parsed input.
            // Prefer the event's input; fall back to the accumulated buffer.
            let resolved_input = input
                .clone()
                .or_else(|| parse_tool_input(&acc.tool_input_buffer));
            let resolved_name = if !name.is_empty() {
                name.clone()
            } else {
                acc.tool_use_block
                    .as_ref()
                    .map(|b| b.name.clone())
                    .unwrap_or_else(|| "unknown".to_string())
            };
            let resolved_call_id = if !call_id.is_empty() {
                call_id.clone()
            } else {
                acc.tool_use_block
                    .as_ref()
                    .map(|b| b.id.clone())
                    .unwrap_or_default()
            };
            fold_result(
                vec![SessionDriverEvent::ToolStarted {
                    base,
                    tool_name: resolved_name,
                    call_id: resolved_call_id,
                    input: resolved_input,
                    label: None,
                    description: None,
                }],
                vec![],
            )
        }

        DaemonEvent::ToolResult {
            call_id,
            content,
            content_full,
            is_error,
            ..
        } => {
            let extracted = extract_tool_result(content.as_deref(), content_full.as_ref());
            fold_result(
                vec![SessionDriverEvent::ToolFinished {
                    base,
                    call_id: call_id.clone(),
                    success: !is_error.unwrap_or(false),
                    output: extracted.output,
                    images: extracted.images,
                }],
                vec![],
            )
        }

        // ===== Queue (steering / follow-up) =====
        DaemonEvent::PendingTurnInputQueued { .. }
        | DaemonEvent::PendingTurnInputDequeued { .. }
        | DaemonEvent::PendingTurnInputDiscarded { .. } => {
            // These events carry one item + revision, NOT the full queue. pilot's
            // queueUpdated REPLACES the full queue, so we must fetch GET /turn/input.
            fold_result(vec![], vec![DaemonEffect::RefetchQueue])
        }

        DaemonEvent::PendingTurnInputDrained {
            content, item_ids, ..
        } => {
            // A queued message is being delivered (admitted into the active turn).
            // Emit queuedMessageStarted (with the content). The spike (§3) only observed
            // single-item drains (item_ids.length === 1), so we declare the queue empty
            // in that case. If the daemon ever batches multiple drains in one event,
            // we can't know from item_ids[0] alone whether the queue is now empty — so
            // conservatively emit a refetchQueue effect to get the authoritative queue
            // state when more than one item was drained.
            let now = ctx.now();
            let msg = drained_queue_message(content, item_ids.first().map(|s| s.as_str()), &now);
            let single_item = item_ids.len() <= 1;
            let mut evs = vec![SessionDriverEvent::QueuedMessageStarted {
                base: base.clone(),
                message: msg,
            }];
            if single_item {
                evs.push(SessionDriverEvent::QueueUpdated {
                    base,
                    messages: vec![],
                });
                return fold_result(evs, vec![]);
            }
            // Multi-item drain: emit the started message, then fetch the real queue.
            fold_result(evs, vec![DaemonEffect::RefetchQueue])
        }

        // ===== Errors + retries =====
        DaemonEvent::ModelError { error, .. } => {
            // A provider error occurred. Don't fail the run yet — the daemon may retry
            // (retry_wait → message_start clears the error). Defer the failure decision
            // to message_complete, like the original driver defers to agent_end. Surface a warning notify.
            let message = provider_error_message(error);
            acc.turn_error = Some(TurnError {
                message: message.clone(),
            });
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("model-error-{}", ts),
                    message,
                    NotifyLevel::Warning,
                )],
                vec![],
            )
        }

        DaemonEvent::RetryWait {
            attempt,
            max_retries,
            error_summary,
            ..
        } => {
            // The daemon is waiting before retrying (like the original driver's auto_retry_start).
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("retry-{}", ts),
                    format!(
                        "Retrying (attempt {}/{}): {}",
                        attempt, max_retries, error_summary
                    ),
                    NotifyLevel::Warning,
                )],
                vec![],
            )
        }

        DaemonEvent::StreamDiscontinuity { .. } => {
            // Events were dropped — re-seed from GET /history + GET /state.
            fold_result(vec![], vec![DaemonEffect::Reseed])
        }

        // ===== Session metadata =====
        DaemonEvent::SessionTitleChanged { title, .. } => {
            // The event carries the title + source (operator|inferred). Build a snapshot
            // at the live status (a rename can land mid-turn; don't force idle).
            let mut snapshot = ctx.snapshot(ctx.live_status());
            snapshot.title = title.clone();
            fold_result(
                vec![SessionDriverEvent::SessionUpdated { base, snapshot }],
                vec![],
            )
        }

        DaemonEvent::SessionStateChanged { .. } => {
            // The daemon's state changed (carries invalidation domains, not values).
            // Re-read GET /state for the authoritative snapshot.
            fold_result(
                vec![],
                vec![DaemonEffect::FetchState {
                    emit: FetchEmit::SessionUpdated,
                    prompt_id: None,
                }],
            )
        }

        DaemonEvent::ModelSwitch {
            to_model,
            to_reasoning_effort,
            ..
        } => {
            // The model/reasoning changed. The event carries from/to — build a snapshot
            // with the NEW config directly (no state fetch needed).
            // Same full-registry-name modelId as snapshot_from_state — to_model is the
            // FULL `provider/id`, so defaultModelRef gives the bare provider prefix +
            // the full modelId (matching ModelOption.modelId) so the picker's find()
            // resolves the friendly label. Degrades both to the whole string if a model
            // string ever lacks a slash (config is display-only).
            let ModelRef { provider, model_id } = default_model_ref(to_model);
            let config = SessionConfig {
                provider: Some(provider),
                model_id: Some(model_id),
                thinking_level: to_reasoning_effort.as_deref().map(|s| s.to_string()),
                available_thinking_levels: None,
            };
            let mut snapshot = ctx.snapshot(ctx.live_status());
            snapshot.config = Some(config);
            fold_result(
                vec![SessionDriverEvent::SessionUpdated { base, snapshot }],
                vec![],
            )
        }

        DaemonEvent::AgentBlockViolation { tool_name, .. } => {
            // The agent tried to use a tool that's blocked by a block constraint. Low
            // frequency but a safety signal worth surfacing loudly (crash-don't-corrupt
            // philosophy) — the operator needs to know a violation occurred.
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("block-violation-{}", ts),
                    format!(
                        "Blocked: the agent tried to use {}, which is blocked by a constraint",
                        tool_name
                    ),
                    NotifyLevel::Warning,
                )],
                vec![],
            )
        }

        DaemonEvent::ToolExposureChanged { reason, .. } => {
            // Tool exposure changed — the reason explains why. When the daemon
            // auto-switched to a fallback model, surface it so the operator knows the
            // model changed because the primary was down/rate-limited (model_switch
            // already updated the picker, but not the reason). Other reasons are
            // internal (model_changed, facet_changed, reload, compaction_reset,
            // edit_format_relocked) and don't need a user-visible notice.
            use pilot_daemon_types::ToolExposureReason;
            if matches!(reason, ToolExposureReason::EagerFallbackActivated) {
                let ts = base.timestamp.clone();
                return fold_result(
                    vec![notify(
                        base,
                        format!("fallback-{}", ts),
                        "Auto-switched to a fallback model — the primary may be down or rate-limited"
                            .to_string(),
                        NotifyLevel::Warning,
                    )],
                    vec![],
                );
            }
            FoldResult::default()
        }

        DaemonEvent::SessionRewound { .. } => {
            // History was truncated destructively. Re-seed.
            fold_result(vec![], vec![DaemonEffect::Reseed])
        }

        DaemonEvent::ContextCleared { .. } => {
            // /clear was called (resets context + shell env). Re-seed.
            fold_result(vec![], vec![DaemonEffect::Reseed])
        }

        DaemonEvent::FacetSwitch { .. } => {
            // Facet changed (mid-conversation persona switch). Re-read state for the
            // snapshot (the facet indicator comes from the snapshot's facet field).
            fold_result(
                vec![],
                vec![DaemonEffect::FetchState {
                    emit: FetchEmit::SessionUpdated,
                    prompt_id: None,
                }],
            )
        }

        // ===== Compaction =====
        DaemonEvent::CompactionStarted { .. } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("compact-{}", ts),
                    "Compacting context…".to_string(),
                    NotifyLevel::Info,
                )],
                vec![],
            )
        }

        DaemonEvent::CompactionComplete { .. } => {
            // Usage changed after compaction — re-read state for the context meter.
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("compact-done-{}", ts),
                    "Context compacted".to_string(),
                    NotifyLevel::Info,
                )],
                vec![DaemonEffect::FetchState {
                    emit: FetchEmit::SessionUpdated,
                    prompt_id: None,
                }],
            )
        }

        DaemonEvent::CompactionCancelled { .. } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("compact-cancelled-{}", ts),
                    "Compaction cancelled".to_string(),
                    NotifyLevel::Warning,
                )],
                vec![],
            )
        }

        DaemonEvent::CompactionFailed { .. } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("compact-failed-{}", ts),
                    "Compaction failed".to_string(),
                    NotifyLevel::Error,
                )],
                vec![],
            )
        }

        DaemonEvent::SubagentCompactionNotice { summary, .. } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("subagent-compact-{}", ts),
                    summary.clone(),
                    NotifyLevel::Info,
                )],
                vec![],
            )
        }

        // ===== Notifications =====
        DaemonEvent::NotificationQueued { notification, .. } => fold_result(
            vec![notify(
                base,
                format!("notif-{}", notification.id),
                notification.summary.clone(),
                NotifyLevel::Info,
            )],
            vec![],
        ),

        // ===== System reminders =====
        DaemonEvent::SystemReminder {
            reason, slug, body, ..
        } => {
            // A system-injected reminder — like the original driver's role:"custom" message.
            // Most reasons are turn-boundary markers (display:false, robustness net only).
            // Plan-review reasons surface visibly so the operator sees a review is needed.
            let label = plan_review_label(reason);
            let visible = label.is_some();
            let custom_type = if visible {
                label.unwrap().to_string()
            } else {
                slug.clone()
            };
            let ts = base.timestamp.clone();
            fold_result(
                vec![SessionDriverEvent::CustomMessage {
                    base,
                    id: format!("reminder-{}-{}", slug, ts),
                    custom_type,
                    text: body.clone(),
                    display: visible,
                }],
                vec![],
            )
        }

        // ===== Host UI + permissions =====
        //
        // interrogative / ask_user_question / permission_monitor_switch are the
        // daemon's host-UI surface. The first two emit a pilot hostUiRequest card
        // (the turn is paused until the operator answers) and a registerInterrogative
        // effect so the driver can build the reverse response. The third is an
        // ambient mode-change notify (the mode SWITCHER UI itself is a later concern;
        // the approval CARDS surface via interrogative{type:"permission"}).
        DaemonEvent::Interrogative {
            interrogative_id,
            interrogative_type,
            question,
            clarification_options,
            plan_handoff,
            goal_proposal,
            permission_candidate_rule,
            permission_tool_call,
            ..
        } => {
            // The 6 interrogative_types each map to a pilot card kind. The card's
            // requestId == the daemon's interrogative_id, so respondUi can look up the
            // pending metadata to build the InterrogativeResponse.
            let mapping = build_interrogative_mapping(
                interrogative_id,
                interrogative_type,
                question,
                clarification_options.as_deref(),
                plan_handoff.as_ref(),
                goal_proposal.as_ref(),
                permission_candidate_rule.as_ref(),
                permission_tool_call.as_ref(),
                base,
            );
            fold_result(
                vec![mapping.event],
                vec![DaemonEffect::RegisterInterrogative {
                    pending: mapping.pending,
                }],
            )
        }

        DaemonEvent::AskUserQuestion {
            interrogative_id,
            payload,
            ..
        } => {
            // A separate DaemonEvent (not an interrogative_type), but responds via the
            // same /interrogative/{id}/respond endpoint with kind:"ask_user_question_answers".
            // Maps to pilot's qna card (purpose-built multi-question form).
            let mapping =
                build_ask_user_question_mapping(interrogative_id, &payload.questions, base);
            fold_result(
                vec![mapping.event],
                vec![DaemonEffect::RegisterInterrogative {
                    pending: mapping.pending,
                }],
            )
        }

        DaemonEvent::PermissionMonitorSwitch { to_monitor, .. } => {
            // The permission MODE changed (standard/bypass/autonomous) — daemon-side
            // (e.g. an autonomous classifier took over approvals) or echoing a
            // user-initiated POST /permission-monitor. Update the cached mode + emit a
            // sessionUpdated snapshot carrying the new mode so the composer-toolbar
            // badge reflects it. (Replaces the old notify toast — the persistent badge
            // is strictly better than a transient toast; the switcher UI has landed.)
            let to_mode = monitor_to_mode(to_monitor);
            let mut snapshot = ctx.snapshot(ctx.live_status());
            snapshot.permission_monitor = Some(to_mode);
            fold_result(
                vec![SessionDriverEvent::SessionUpdated { base, snapshot }],
                vec![DaemonEffect::SetMonitorMode { mode: to_mode }],
            )
        }

        DaemonEvent::GoalDriverUpdate { goal, .. } => {
            // Mirror permission_monitor_switch (above): the event carries the
            // authoritative new goal, so emit a sessionUpdated from the payload
            // immediately, then fire fetchState to sync the cached lastState. The goal
            // field is `goal?: null | CurrentGoal` — optional on the wire. Three cases:
            // object (set), null (cleared), undefined (not carried — preserve existing,
            // don't emit a sessionUpdated that would blank the badge). The fetchState
            // effect re-fetches GET /state (which carries current_goal natively) and
            // emits another sessionUpdated — harmless (same goal value, fold is
            // idempotent). This syncs the cached lastState so subsequent ctx.snapshot()
            // calls are consistent (goal lives on lastState, which fetchState refreshes
            // wholesale — unlike permissionMonitor which has a separate cache field).
            //
            // NOTE: The daemon type `goal: Option<CurrentGoal>` collapses null and
            // absent (both → None). With serde's default Option, we can't distinguish
            // "field absent" from "field null". The TS checks `goal === undefined`
            // (field absent → preserve). Here, `None` is treated as "cleared" (null),
            // matching the TS behavior for null. The truly-absent case is lost — but
            // serde can't represent it with `Option<CurrentGoal>`.
            let projected = project_goal(Some(goal.as_ref()));
            // `Some(goal.as_ref())` means the field was present in the deserialized
            // struct. `project_goal(Some(None))` → `Some(None)` (cleared).
            // `project_goal(Some(Some(&g)))` → `Some(Some(goal))` (set).
            // Both cases emit a sessionUpdated + fetchState (matching the TS's
            // non-undefined path).
            let mut snapshot = ctx.snapshot(ctx.live_status());
            snapshot.goal = projected;
            fold_result(
                vec![SessionDriverEvent::SessionUpdated { base, snapshot }],
                vec![DaemonEffect::FetchState {
                    emit: FetchEmit::SessionUpdated,
                    prompt_id: None,
                }],
            )
        }

        // ===== v1-ignored variants (return empty — the stream stays live) =====
        //
        // These are ambient metadata, new concepts not yet surfaced, or host-UI
        // concerns. Each returns empty.
        DaemonEvent::NotificationAutodrainSwitch { enabled, .. } => {
            // The autodrain flag changed — daemon-side or echoing a user-initiated
            // POST. Update the cached flag + emit a sessionUpdated snapshot.
            let mut snapshot = ctx.snapshot(ctx.live_status());
            snapshot.notification_autodrain = Some(*enabled);
            fold_result(
                vec![SessionDriverEvent::SessionUpdated { base, snapshot }],
                vec![DaemonEffect::SetAutodrainEnabled { enabled: *enabled }],
            )
        }

        DaemonEvent::Heartbeat { .. }
        | DaemonEvent::NotificationsDrained { .. }
        | DaemonEvent::HookFired { .. }
        | DaemonEvent::ContextLoaded { .. }
        | DaemonEvent::ToolReveal { .. }
        | DaemonEvent::ClassifierDecision { .. }
        | DaemonEvent::ExtensionRegistered { .. }
        | DaemonEvent::SubagentStarted { .. }
        | DaemonEvent::SubagentCompleted { .. }
        | DaemonEvent::SubsessionCreated { .. }
        | DaemonEvent::SubsessionStopped { .. }
        | DaemonEvent::SubsessionTerminated { .. }
        | DaemonEvent::SubsessionInterrogative { .. }
        | DaemonEvent::SubsessionMessage { .. }
        | DaemonEvent::ImageReferenceResolved { .. }
        | DaemonEvent::JobPromoted { .. }
        | DaemonEvent::JobCompleted { .. }
        | DaemonEvent::JobExpiring { .. }
        | DaemonEvent::JobCancelled { .. }
        | DaemonEvent::JobUpdated { .. }
        | DaemonEvent::UsageThrottle { .. } => FoldResult::default(),

        // ===== MCP server lifecycle =====
        DaemonEvent::McpServerConnected { server_name, .. } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("mcp-conn-{}", ts),
                    format!("MCP server {} connected", server_name),
                    NotifyLevel::Info,
                )],
                vec![],
            )
        }

        DaemonEvent::McpServerDisconnected {
            server_name,
            reason,
            ..
        } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("mcp-disc-{}", ts),
                    format!("MCP server {} disconnected ({})", server_name, reason),
                    NotifyLevel::Warning,
                )],
                vec![],
            )
        }

        DaemonEvent::McpServerReconnecting {
            server_name,
            attempt,
            ..
        } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("mcp-reconn-{}", ts),
                    format!(
                        "MCP server {} reconnecting (attempt {})…",
                        server_name, attempt
                    ),
                    NotifyLevel::Info,
                )],
                vec![],
            )
        }

        DaemonEvent::McpServerDisabled {
            server_name,
            reason,
            ..
        } => {
            let ts = base.timestamp.clone();
            fold_result(
                vec![notify(
                    base,
                    format!("mcp-disabled-{}", ts),
                    format!("MCP server {} disabled ({})", server_name, reason),
                    NotifyLevel::Warning,
                )],
                vec![],
            )
        } // NOTE: The TS has a `default` arm that emits a runtime warn for unknown
          // variants (a newer daemon sent a type the codegen hasn't caught). Rust's
          // exhaustive match makes this a compile error instead — if a new DaemonEvent
          // variant is added to the generated schema, this match won't compile until
          // it's handled. That's the desired behavior (the codegen regen is the
          // catching mechanism, not a runtime warn).
    }
}
