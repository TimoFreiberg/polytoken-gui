//! The testable heart of the polytoken driver — given a daemon event,
//! an accumulator, and a little context, it returns zero or more pantoken events to fold +
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

use pantoken_daemon_types::{
    BlockDeltaPayload, ContentBlockKind, CurrentGoal, DaemonEvent, HookOutcome, NotificationType,
    PendingTurnInputItem, PendingTurnInputSnapshot, PermissionCandidateRuleContext,
    PermissionMonitor, ProviderError, ResolvedPromptReference, SessionStateSnapshot,
    SubagentResultKind, SystemReminderReason, ToolLiveDisplayContent,
};
use pantoken_protocol::session_driver::{
    AssistantDeltaChannel, FlaggedFile, FlaggedFileMode, GoalInfo, HostUiRequest, ImageContent,
    McpServerInfo, NotifyLevel, PermissionMonitorMode, QnaQuestion, QnaQuestionOption, ResolvedRef,
    SessionConfig, SessionDriverEvent, SessionEventBase, SessionMessageDeliveryMode,
    SessionQueuedMessage, SessionSnapshot, SessionStatus, SessionUsage, TodoItem,
    TodoStatus as PantokenTodoStatus, WorkspaceRef,
};

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
    fn r#ref(&self) -> &pantoken_protocol::session_driver::SessionRef;
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
    /// revision; pantoken's queueUpdated REPLACES the full queue, so we must fetch.
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
    /// emit the matching pantoken hostUiRequest card. The effect carries the
    /// PendingInterrogative metadata the reverse builder needs; the hostUiRequest
    /// event is in the returned `events` (emitted before effects, per the driver's
    /// emit-then-execute contract).
    RegisterInterrogative { pending: PendingInterrogative },
}

/// The result of mapping one daemon event: pantoken events to emit + side-effect
/// requests for the driver to execute (HTTP calls) AFTER emitting.
#[derive(Debug, Clone, Default)]
pub struct FoldResult {
    /// Pantoken driver events to emit (broadcast to hub listeners).
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

/// Public wrapper around `meta` so the driver (and other callers outside
/// event_map) can build a `SessionEventBase` from a `MapCtx` without
/// duplicating the sessionRef + timestamp convention. Used by the
/// `RefetchQueue` effect's `QueueUpdated` emit.
pub fn event_base(ctx: &dyn MapCtx) -> SessionEventBase {
    meta(ctx)
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

/// Build a concise notice for a queued notification. Completion notifications carry their
/// full report in `summary`, but that report is already available through the background-job
/// detail view; putting it in the transcript creates an enormous notice. Other notification
/// types use `summary` as their actual user-facing message.
fn notification_message(notification: &pantoken_daemon_types::Notification) -> String {
    match &notification.notification_type {
        NotificationType::JobComplete { exit_code } => match exit_code {
            Some(code) => format!("Job completed (exit {})", code),
            None => "Job completed".to_string(),
        },
        NotificationType::SubagentComplete { handle, outcome } => {
            let result = match &outcome.kind {
                SubagentResultKind::Success => "Success",
                SubagentResultKind::Failure => "Failure",
                SubagentResultKind::Cancelled => "Cancelled",
            };
            format!("Subagent {} {}", handle, result)
        }
        NotificationType::HookResult
        | NotificationType::ExtensionMessage { .. }
        | NotificationType::Unknown => notification.summary.clone(),
    }
}

/// System-reminder reason types that surface as visible inject pills. Maps the
/// daemon's `SystemReminderReason` to a human-readable pill label; visibility is
/// independent from the explicit goal-reminder turn boundary.
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
        ProviderError::Transport { message, .. } => {
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

/// Project the daemon's `current_goal` onto pantoken's `GoalInfo` for the StatusHeader
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

/// Extract pantoken's `SessionUsage` from a daemon state snapshot's `context_usage`.
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
    r#ref: &pantoken_protocol::session_driver::SessionRef,
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
    // (e.g. "anthropic/claude-sonnet-4"). modelId IS the full registry name —
    // matching ModelOption.modelId from parseModels and the default markers —
    // so ModelPicker's store.models.find() resolves the friendly label instead
    // of falling back to the bare id. There is no separate `provider` field:
    // the registry name already carries its provider prefix, and grouping can
    // derive the prefix at display time via `modelId.split('/')[0]`.
    let config = state
        .and_then(|s| s.active_model.as_deref())
        .map(|m| SessionConfig {
            model_id: Some(m.to_string()),
            thinking_level: state
                .and_then(|s| s.active_reasoning_effort.as_deref())
                .map(|s| s.to_string()),
            available_thinking_levels: None,
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
    // Project to pantoken's trimmed types. None when state is null (older daemon
    // or cold path — the fold preserves the known list).
    let flags = state.map(|s| {
        s.flags
            .iter()
            .map(|f| FlaggedFile {
                path: f.path.clone(),
                mode: match f.mode {
                    pantoken_daemon_types::FlagMode::Included => FlaggedFileMode::Included,
                    pantoken_daemon_types::FlagMode::Referenced => FlaggedFileMode::Referenced,
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
                    pantoken_daemon_types::TodoStatus::Pending => PantokenTodoStatus::Pending,
                    pantoken_daemon_types::TodoStatus::InProgress => PantokenTodoStatus::InProgress,
                    pantoken_daemon_types::TodoStatus::Done => PantokenTodoStatus::Done,
                    pantoken_daemon_types::TodoStatus::Blocked => PantokenTodoStatus::Blocked,
                },
                dependencies: t.dependencies.clone(),
                created_at: t.emitted_at.clone(),
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
                    pantoken_daemon_types::McpServerStatus::Connected => {
                        pantoken_protocol::session_driver::McpServerStatus::Connected
                    }
                    pantoken_daemon_types::McpServerStatus::Disconnected => {
                        pantoken_protocol::session_driver::McpServerStatus::Disconnected
                    }
                    pantoken_daemon_types::McpServerStatus::Reconnecting => {
                        pantoken_protocol::session_driver::McpServerStatus::Reconnecting
                    }
                    pantoken_daemon_types::McpServerStatus::Disabled => {
                        pantoken_protocol::session_driver::McpServerStatus::Disabled
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
/// Recognized non-empty rich text is preferred, image data is lifted into `images`,
/// and unrecognized non-empty rich variants are preserved. Empty rich values fall
/// back to the short-form content.
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
                            text_fallback
                                .filter(|text| !text.is_empty())
                                .or(content)
                                .unwrap_or("")
                                .to_string(),
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
                        if text.is_empty() {
                            content.unwrap_or("")
                        } else {
                            text
                        }
                        .to_string(),
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
                    output: Some(serde_json::Value::String(if text.is_empty() {
                        content.unwrap_or("").to_string()
                    } else {
                        text
                    })),
                    images: None,
                };
            }
            // Diff preview variant: {diff_preview: {summary, ...}}
            if let Some(dp) = cf_obj.get("diff_preview").and_then(|v| v.as_object()) {
                let summary = dp.get("summary").and_then(|v| v.as_str()).unwrap_or("");
                return ToolResultExtract {
                    output: Some(serde_json::Value::String(
                        if summary.is_empty() {
                            content.unwrap_or("")
                        } else {
                            summary
                        }
                        .to_string(),
                    )),
                    images: None,
                };
            }
        }
        // Preserve an unrecognized future rich variant rather than replacing it with
        // the short-form summary.
        if !cf.is_null() && !cf.as_object().is_some_and(serde_json::Map::is_empty) {
            return ToolResultExtract {
                output: Some(cf.clone()),
                images: None,
            };
        }
    }
    // Fallback: just the truncated content string
    ToolResultExtract {
        output: content.map(|c| serde_json::Value::String(c.to_string())),
        images: None,
    }
}

/// Build a stable `SessionQueuedMessage` from a `pending_turn_input_drained` event's
/// content. The daemon doesn't distinguish steer from followUp; pantoken's
/// mode is UX-only, so we default to "steer" (the mid-turn case).
///
/// `resolved_references` is the daemon's `PendingTurnInputDrained.resolved_references`
/// — the queued item's `@`-refs are only resolved NOW, at drain time (the initial
/// queueing via POST /turn/input carries none). Threaded onto the message so the
/// fold (`queuedMessageStarted` → UserItem) can show the same resolution chips a
/// live send gets.
fn drained_queue_message(
    text: &str,
    item_id: Option<&str>,
    ts: &str,
    resolved_references: Option<&[ResolvedPromptReference]>,
) -> SessionQueuedMessage {
    let id = item_id
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("drain-{}", ts));
    SessionQueuedMessage {
        id,
        mode: SessionMessageDeliveryMode::Steer,
        text: text.to_string(),
        created_at: ts.to_string(),
        updated_at: ts.to_string(),
        references: resolved_references.map(map_resolved_references),
    }
}

/// Map the daemon's `ResolvedPromptReference` list onto pantoken's wire
/// `ResolvedRef` — a pure, direct field-for-field projection (no I/O), shared by
/// the live driver's `PromptAccepted`/`PendingTurnInputDrained` handling.
pub fn map_resolved_references(refs: &[ResolvedPromptReference]) -> Vec<ResolvedRef> {
    refs.iter()
        .map(|r| ResolvedRef {
            kind: r.kind.clone(),
            name: r.name.clone(),
            file_kind: r.file_kind.clone(),
        })
        .collect()
}

/// Render a `PendingTurnInputDiscarded.missing_references` list into the visible
/// warning text (`notify`, level Warning) shown when a queued steer/follow-up is
/// dropped for lacking a reference the daemon couldn't resolve. Generic over
/// `(kind, name)` pairs so both the live daemon's `ResolvedPromptReference` and the
/// mock driver's own `ResolvedRef` fixtures can share the exact wording.
pub fn format_missing_references_message<'a>(
    refs: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> String {
    let parts: Vec<String> = refs
        .into_iter()
        .map(|(kind, name)| format!("{kind} \"{name}\""))
        .collect();
    format!(
        "Queued message dropped — missing references: {}",
        parts.join(", ")
    )
}

/// Build the pantoken `queueUpdated` event's `messages` from a daemon
/// `PendingTurnInputSnapshot` — a pure mapping (no I/O), unit-tested in isolation.
///
/// Mirrors TS `polytoken-driver.ts` `queueMsg(item, ts)` (the `refetchQueue`
/// effect at :467-476): each `PendingTurnInputItem` → a `SessionQueuedMessage`
/// with `mode: steer` (the daemon doesn't distinguish steer/followUp), `text`
/// from `content`, and the fetch-time `ts` for both `created_at`/`updated_at`.
///
/// `PendingTurnInputItem` carries no
/// timestamp (only id + content), so the timestamps are fetch-time, not
/// queue-time. The `items[]` order IS queue order, so the message order is
/// preserved; time-based sort would be fetch-order. Acceptable for v1 (the queue
/// is display-only).
pub fn queue_messages_from_snapshot(
    snapshot: &PendingTurnInputSnapshot,
    ts: &str,
) -> Vec<SessionQueuedMessage> {
    snapshot
        .items
        .iter()
        .map(|item| queue_message_from_item(item, ts))
        .collect()
}

/// Map one `PendingTurnInputItem` → `SessionQueuedMessage` (the per-item shape
/// shared by `queue_messages_from_snapshot` and any future direct use).
pub fn queue_message_from_item(item: &PendingTurnInputItem, ts: &str) -> SessionQueuedMessage {
    SessionQueuedMessage {
        id: item.id.clone(),
        mode: SessionMessageDeliveryMode::Steer,
        text: item.content.clone(),
        created_at: ts.to_string(),
        updated_at: ts.to_string(),
        // `PendingTurnInputItem` (the GET /turn/input snapshot shape) carries no
        // resolved_references — the daemon only resolves refs at drain time
        // (PendingTurnInputDrained), not while an item merely sits in the queue.
        references: None,
    }
}

/// JSON-stringify a `serde_json::Value` with a fallback for non-serializable values.
/// Pretty-prints with 2-space indent (matching `JSON.stringify(value, null, 2)`).
fn safe_stringify(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

// ---------------------------------------------------------------------------
// Forward interrogative mapping — DaemonEvent → pantoken hostUiRequest card.
//
// Each builder returns (a) the pantoken hostUiRequest event to emit AND (b) the
// PendingInterrogative metadata the reverse builder (ui-bridge.rs) needs to
// translate a later HostUiResponse back. The mapper bundles the metadata into
// a registerInterrogative effect; the driver stores it in its pending map.
//
// The index↔key/id mappings here are the SINGLE source of truth — ui-bridge.rs's
// reverse builders read them back by index, so the order here MUST match.
// ---------------------------------------------------------------------------

/// The result of building an interrogative mapping: the pantoken event to emit +
/// the pending metadata for the reverse builder.
struct InterrogativeMapping {
    event: SessionDriverEvent,
    pending: PendingInterrogative,
}

/// Build the pantoken hostUiRequest + pending metadata for an `interrogative` event.
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
    interrogative_type: &pantoken_daemon_types::InterrogativeType,
    question: &str,
    clarification_options: Option<&[pantoken_daemon_types::ClarificationOption]>,
    plan_handoff: Option<&pantoken_daemon_types::PlanHandoffContext>,
    goal_proposal: Option<&pantoken_daemon_types::GoalProposalContext>,
    permission_candidate_rule: Option<&PermissionCandidateRuleContext>,
    permission_tool_call: Option<&pantoken_daemon_types::PermissionToolCallContext>,
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
        pantoken_daemon_types::InterrogativeType::Confirmation => {
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
        pantoken_daemon_types::InterrogativeType::Clarification => {
            // Clarification options carry {key,label}. pantoken's select renders labels;
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
        pantoken_daemon_types::InterrogativeType::Capability => {
            // A capability grant is a yes/no — pantoken's confirm card fits.
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
        pantoken_daemon_types::InterrogativeType::PlanHandoff => {
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
        pantoken_daemon_types::InterrogativeType::Permission => {
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
        pantoken_daemon_types::InterrogativeType::GoalProposal => {
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

/// Build the pantoken `permission` hostUiRequest + pending metadata for a
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
    permission_tool_call: Option<&pantoken_daemon_types::PermissionToolCallContext>,
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

    let keep_targets: Option<&[pantoken_daemon_types::PersistenceTarget]> =
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

/// Build the pantoken hostUiRequest (qna) + pending metadata for an
/// ask_user_question event. Each question maps to a QnaQuestion; the option ids
/// are captured so the reverse builder can map selected indices → ids.
fn build_ask_user_question_mapping(
    interrogative_id: &str,
    questions: &[pantoken_daemon_types::AskUserQuestion],
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

    // Map the daemon's AskUserQuestion to pantoken's QnaQuestion. single_select /
    // multi_select → a choice card (options present); text → free-text.
    let pantoken_questions: Vec<QnaQuestion> = questions
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
            multi_select: Some(q.mode == pantoken_daemon_types::AskUserQuestionMode::MultiSelect),
        })
        .collect();

    let event = SessionDriverEvent::HostUiRequest {
        base,
        request: HostUiRequest::Qna {
            request_id,
            title: None,
            questions: pantoken_questions,
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
// Daemon PermissionMonitor → pantoken PermissionMonitorMode conversion
// ---------------------------------------------------------------------------

/// Convert the daemon's `PermissionMonitor` (a tagged enum with data) to pantoken's
/// `PermissionMonitorMode` (a flat copy enum). The daemon's `type` tag is the
/// discriminator the TS reads via `ev.to_monitor.type`.
pub fn monitor_to_mode(monitor: &PermissionMonitor) -> PermissionMonitorMode {
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
// The mapper — map one DaemonEvent to zero or more pantoken events + effects.
//
// Subagent routing: every event variant (except subsession_*, mcp_server_*,
// subagent_*, notification_autodrain_switch) carries an optional subagent_handle.
// When non-null, the frame belongs to a NESTED subagent turn — not the
// top-level transcript. These route to empty (the subagent view is later);
// they must NOT pollute the top-level transcript.
// ---------------------------------------------------------------------------

/// Map one daemon event to zero or more pantoken events + side-effect descriptors.
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
                        error: pantoken_protocol::session_driver::SessionErrorInfo {
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
            // pantoken event; preserved for turn-2 replay by the daemon).
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
                    interrupted: None,
                }],
                vec![],
            )
        }

        // ===== Queue (steering / follow-up) =====
        DaemonEvent::PendingTurnInputQueued { .. }
        | DaemonEvent::PendingTurnInputDequeued { .. } => {
            // These events carry one item + revision, NOT the full queue. pantoken's
            // queueUpdated REPLACES the full queue, so we must fetch GET /turn/input.
            fold_result(vec![], vec![DaemonEffect::RefetchQueue])
        }

        DaemonEvent::PendingTurnInputDiscarded {
            missing_references, ..
        } => {
            // Same "refetch the authoritative queue" need as Queued/Dequeued above
            // (this event carries one item + revision, not the full queue), plus: when
            // the daemon names WHY (missing_references — an `@`-reference it couldn't
            // resolve), surface a visible warning so the operator knows their queued
            // steer/follow-up never made it into the turn. Other discard reasons
            // (cancelled, superseded, …) carry no missing_references and stay silent,
            // matching prior behavior.
            let mut evs = vec![];
            if let Some(refs) = missing_references {
                if !refs.is_empty() {
                    let ts = base.timestamp.clone();
                    let message = format_missing_references_message(
                        refs.iter().map(|r| (r.kind.as_str(), r.name.as_str())),
                    );
                    evs.push(notify(
                        base,
                        format!("discard-missing-refs-{}", ts),
                        message,
                        NotifyLevel::Warning,
                    ));
                }
            }
            fold_result(evs, vec![DaemonEffect::RefetchQueue])
        }

        DaemonEvent::PendingTurnInputDrained {
            content,
            item_ids,
            resolved_references,
            ..
        } => {
            // A queued message is being delivered (admitted into the active turn).
            // Emit queuedMessageStarted (with the content + the daemon's now-resolved
            // `@`-refs — PendingTurnInputDrained.resolved_references — so the fold shows
            // the same resolution chips a live send gets). The spike (§3) only observed
            // single-item drains (item_ids.length === 1), so we declare the queue empty
            // in that case. If the daemon ever batches multiple drains in one event,
            // we can't know from item_ids[0] alone whether the queue is now empty — so
            // conservatively emit a refetchQueue effect to get the authoritative queue
            // state when more than one item was drained.
            let now = ctx.now();
            let msg = drained_queue_message(
                content,
                item_ids.first().map(|s| s.as_str()),
                &now,
                resolved_references.as_deref(),
            );
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
            // with the NEW config directly (no state fetch needed). to_model is the
            // FULL `provider/id` registry name, which IS modelId (matching
            // ModelOption.modelId) so the picker's find() resolves the friendly label.
            // There's no separate `provider` field; grouping derives the prefix at
            // display time.
            let config = SessionConfig {
                model_id: Some(to_model.to_string()),
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
            use pantoken_daemon_types::ToolExposureReason;
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
                notification_message(notification),
                NotifyLevel::Info,
            )],
            vec![],
        ),

        // ===== System reminders =====
        DaemonEvent::SystemReminder {
            reason, slug, body, ..
        } => {
            // Visibility and turn grouping are independent: only an explicit goal reminder
            // starts a new outer turn. Plan-review reasons remain visible but same-turn.
            let label = plan_review_label(reason);
            let turn_boundary = matches!(reason, SystemReminderReason::GoalReminder);
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
                    turn_boundary,
                }],
                vec![],
            )
        }

        // ===== Host UI + permissions =====
        //
        // interrogative / ask_user_question / permission_monitor_switch are the
        // daemon's host-UI surface. The first two emit a pantoken hostUiRequest card
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
            // The 6 interrogative_types each map to a pantoken card kind. The card's
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
            // Maps to pantoken's qna card (purpose-built multi-question form).
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

        DaemonEvent::GoalDriverUpdate {
            goal, transition, ..
        } => {
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
            // NOTE: The daemon type collapses `goal:null` and an absent `goal`
            // (both → None) because serde's `Option<CurrentGoal>` can't distinguish
            // them. The TS distinguishes via `goal === undefined`; we recover the
            // distinction from the REQUIRED `transition` field instead:
            //   - goal object present             → set   (sessionUpdated(goal))
            //   - goal None && transition=cleared → clear (sessionUpdated(goal:null))
            //   - goal None && transition≠cleared → preserve (only fetchState — a
            //     `proposed` goal must NOT blank the badge). The fetchState re-syncs
            //     the cached lastState from GET /state in every case.
            // Equivalence to the TS (which branches on goal-presence, not
            // `transition`) rests on the daemon invariant
            // `goal:null ⟺ transition=="cleared"`; the contradictory inputs
            // (null on a non-cleared transition, or absent on a cleared one) are
            // unreachable, so the two never diverge observably.
            let fetch = DaemonEffect::FetchState {
                emit: FetchEmit::SessionUpdated,
                prompt_id: None,
            };
            match goal.as_ref() {
                Some(g) => {
                    let mut snapshot = ctx.snapshot(ctx.live_status());
                    snapshot.goal = project_goal(Some(Some(g)));
                    fold_result(
                        vec![SessionDriverEvent::SessionUpdated { base, snapshot }],
                        vec![fetch],
                    )
                }
                None if transition.as_str() == "cleared" => {
                    let mut snapshot = ctx.snapshot(ctx.live_status());
                    snapshot.goal = Some(None);
                    fold_result(
                        vec![SessionDriverEvent::SessionUpdated { base, snapshot }],
                        vec![fetch],
                    )
                }
                None => fold_result(vec![], vec![fetch]),
            }
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

        // A stop hook returned "continue" (mapped to outcome:"blocked" on the
        // SSE stream). The daemon injects the hook's reason text as a new user
        // turn internally, but does NOT emit a pending_turn_input_drained or any
        // event carrying the reason text. Without intervention, the preceding
        // assistant response has no completedAt and no turn boundary — so it
        // collapses behind "Worked for Ns" when the agent continues.
        //
        // We synthesize both signals from hook_fired itself:
        // 1. RunCompleted — stamps completedAt on the open assistant bubble and
        //    settles running tools (the turn IS over; the agent stopped).
        // 2. CustomMessage with turn_boundary:true — creates an InjectItem that
        //    startsTurn returns true for, splitting the transcript into two
        //    turns so the summary stays visible as the prior turn's trailing
        //    response.
        //
        // The hook's reason text is not on the SSE stream, so the inject
        // carries a generic label. On history replay (reconnect), the daemon's
        // type:"user" item replaces this with the real reason text.
        DaemonEvent::HookFired {
            event_type,
            outcome: HookOutcome::Blocked,
            ..
        } if event_type == "stop" => {
            let snapshot = ctx.snapshot(SessionStatus::Idle);
            let ts = base.timestamp.clone();
            fold_result(
                vec![
                    SessionDriverEvent::RunCompleted {
                        base: base.clone(),
                        snapshot,
                        user_entry_id: None,
                        assistant_entry_id: None,
                    },
                    SessionDriverEvent::CustomMessage {
                        base,
                        id: format!("stop-hook-redirect-{}", ts),
                        custom_type: "stop_hook_redirect".to_string(),
                        text: "Stop hook redirected — continuing.".to_string(),
                        display: false,
                        turn_boundary: true,
                    },
                ],
                vec![],
            )
        }

        DaemonEvent::Heartbeat { .. }
        | DaemonEvent::NotificationsDrained { .. }
        | DaemonEvent::HookFired { .. }
        | DaemonEvent::ContextLoaded { .. }
        | DaemonEvent::ToolReveal { .. }
        | DaemonEvent::ClassifierDecision { .. }
        | DaemonEvent::ExtensionRegistered { .. }
        | DaemonEvent::ImageReferenceResolved { .. }
        | DaemonEvent::JobPromoted { .. }
        | DaemonEvent::JobCompleted { .. }
        | DaemonEvent::JobExpiring { .. }
        | DaemonEvent::JobCancelled { .. }
        | DaemonEvent::JobUpdated { .. }
        | DaemonEvent::UsageThrottle { .. } => FoldResult::default(),

        // Subagent lifecycle: refresh state so the hub re-fetches the jobs list
        // (the hub broadcasts JobsList on every SessionUpdated). Low-frequency,
        // acceptable cost. result_summary / outcome.kind are NOT plumbed into
        // jobs in the MVP — the output tail from GET /jobs is the summary.
        DaemonEvent::SubagentStarted { .. } | DaemonEvent::SubagentCompleted { .. } => fold_result(
            vec![],
            vec![DaemonEffect::FetchState {
                emit: FetchEmit::SessionUpdated,
                prompt_id: None,
            }],
        ),

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

#[cfg(test)]
mod tests {
    #![allow(dead_code, unused_imports)]
    use super::*;
    use pantoken_daemon_types::{
        ContextUsageSnapshot, FlagEntry, FlagMode, GoalFileReference, TodoSnapshot,
    };
    use pantoken_protocol::session_driver::{
        PermissionMonitorMode, SessionRef, TodoStatus, WorkspaceRef,
    };
    use serde_json::{Value, json};

    fn snap(items: Vec<(&str, &str)>) -> PendingTurnInputSnapshot {
        PendingTurnInputSnapshot {
            items: items
                .iter()
                .map(|(id, content)| PendingTurnInputItem {
                    id: id.to_string(),
                    content: content.to_string(),
                    admission_prompt_id: "PROMPT_0".to_string(),
                })
                .collect(),
            queue_revision: 1,
        }
    }

    #[test]
    fn queue_messages_from_snapshot_maps_items_in_order() {
        let snapshot = snap(vec![("q1", "first"), ("q2", "second")]);
        let msgs = queue_messages_from_snapshot(&snapshot, "t0");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "q1");
        assert_eq!(msgs[0].text, "first");
        assert_eq!(msgs[0].mode, SessionMessageDeliveryMode::Steer);
        assert_eq!(msgs[0].created_at, "t0");
        assert_eq!(msgs[0].updated_at, "t0");
        // Order preserved (queue order = items[] order).
        assert_eq!(msgs[1].id, "q2");
        assert_eq!(msgs[1].text, "second");
    }

    #[test]
    fn queue_messages_from_snapshot_empty_snapshot_yields_empty() {
        let snapshot = snap(vec![]);
        let msgs = queue_messages_from_snapshot(&snapshot, "t0");
        assert!(msgs.is_empty());
    }

    #[test]
    fn queue_message_from_item_carries_no_references() {
        // PendingTurnInputItem (the GET /turn/input snapshot shape) has no
        // resolved-reference field — the daemon only resolves refs at drain time.
        let item = PendingTurnInputItem {
            id: "q1".into(),
            content: "@skill:debug please".into(),
            admission_prompt_id: "PROMPT_0".into(),
        };
        let msg = queue_message_from_item(&item, "t0");
        assert!(msg.references.is_none());
    }

    // --- map_resolved_references (pure helper) ---

    #[test]
    fn map_resolved_references_maps_each_field() {
        let refs = vec![
            ResolvedPromptReference {
                kind: "skill".into(),
                name: "debug".into(),
                file_kind: None,
            },
            ResolvedPromptReference {
                kind: "file".into(),
                name: "README.md".into(),
                file_kind: Some("file".into()),
            },
        ];
        let mapped = map_resolved_references(&refs);
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].kind, "skill");
        assert_eq!(mapped[0].name, "debug");
        assert_eq!(mapped[0].file_kind, None);
        assert_eq!(mapped[1].kind, "file");
        assert_eq!(mapped[1].name, "README.md");
        assert_eq!(mapped[1].file_kind, Some("file".to_string()));
    }

    #[test]
    fn map_resolved_references_empty_yields_empty() {
        assert!(map_resolved_references(&[]).is_empty());
    }

    // --- format_missing_references_message (pure helper) ---

    #[test]
    fn format_missing_references_message_joins_kind_and_name_pairs() {
        let message = format_missing_references_message([("skill", "foo"), ("file", "bar.md")]);
        assert_eq!(
            message,
            "Queued message dropped — missing references: skill \"foo\", file \"bar.md\""
        );
    }

    #[test]
    fn format_missing_references_message_single_ref() {
        let message = format_missing_references_message([("subagent", "reviewer")]);
        assert_eq!(
            message,
            "Queued message dropped — missing references: subagent \"reviewer\""
        );
    }

    struct TestCtx {
        r#ref: SessionRef,
        workspace: WorkspaceRef,
        live_status: SessionStatus,
    }

    impl Default for TestCtx {
        fn default() -> Self {
            Self {
                r#ref: test_ref(),
                workspace: test_workspace(),
                live_status: SessionStatus::Idle,
            }
        }
    }

    impl MapCtx for TestCtx {
        fn r#ref(&self) -> &SessionRef {
            &self.r#ref
        }

        fn workspace(&self) -> &WorkspaceRef {
            &self.workspace
        }

        fn now(&self) -> String {
            "t".to_string()
        }

        fn snapshot(&self, status: SessionStatus) -> SessionSnapshot {
            SessionSnapshot {
                r#ref: self.r#ref.clone(),
                workspace: self.workspace.clone(),
                title: "Test Session".to_string(),
                status,
                updated_at: "t".to_string(),
                archived_at: None,
                preview: None,
                config: Some(SessionConfig {
                    model_id: Some("anthropic/claude-sonnet-4".to_string()),
                    thinking_level: Some("medium".to_string()),
                    available_thinking_levels: None,
                }),
                usage: Some(SessionUsage {
                    tokens: Some(50_000),
                    context_window: 200_000,
                    percent: Some(25.0),
                }),
                running_run_id: None,
                queued_messages: None,
                facet: None,
                permission_monitor: None,
                adventurous_handoff: None,
                notification_autodrain: None,
                active_plan: None,
                goal: None,
                flags: None,
                todos: None,
                mcp_servers: None,
            }
        }

        fn live_status(&self) -> SessionStatus {
            self.live_status
        }
    }

    fn test_ref() -> SessionRef {
        SessionRef {
            workspace_id: "w".to_string(),
            session_id: "s".to_string(),
        }
    }

    fn test_workspace() -> WorkspaceRef {
        WorkspaceRef {
            workspace_id: "w".to_string(),
            path: "/w".to_string(),
            display_name: None,
        }
    }

    fn base_state() -> SessionStateSnapshot {
        SessionStateSnapshot {
            active_facet: "execute".to_string(),
            active_model: Some("anthropic/claude-sonnet-4".to_string()),
            active_plan: None,
            active_reasoning_effort: Some("medium".to_string()),
            adventurous_handoff_active: None,
            available_models: None,
            available_skills: None,
            available_subagents: None,
            context_usage: Some(ContextUsageSnapshot {
                limit_tokens: 200_000,
                used_tokens: 50_000,
            }),
            current_goal: None,
            cwd: None,
            cwd_stack_depth: None,
            env: Default::default(),
            flags: vec![],
            latest_compaction_summary: None,
            mcp_servers: None,
            most_recent_assistant_text: None,
            pending_interrogatives: None,
            plugin_config: Value::Null,
            project_cwd: None,
            session_title: Some("Test Session".to_string()),
            source_control: None,
            symlink_warnings: None,
            todos: vec![],
            turn_in_flight: Some(false),
        }
    }

    fn make_goal(summary: &str, lifecycle: &str) -> CurrentGoal {
        CurrentGoal {
            activated_at: "2026-01-01T00:00:00Z".to_string(),
            blocked_at: None,
            completed_at: None,
            continuation_count: 0,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            file: GoalFileReference {
                display_path: "goal.md".to_string(),
                path: "/goal.md".to_string(),
            },
            id: "g1".to_string(),
            last_reiterated_at: None,
            lifecycle: lifecycle.to_string(),
            source: "operator".to_string(),
            summary: summary.to_string(),
            terminal_reason: None,
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn daemon_event(value: Value) -> DaemonEvent {
        serde_json::from_value(value).expect("valid daemon event literal")
    }

    fn fold(value: Value, acc: &mut FoldAccumulator) -> FoldResult {
        let ctx = TestCtx::default();
        let ev = daemon_event(value);
        map_daemon_event(&ev, acc, &ctx)
    }

    fn fold_fresh(value: Value) -> FoldResult {
        fold(value, &mut create_accumulator())
    }

    fn event_json(ev: &SessionDriverEvent) -> Value {
        serde_json::to_value(ev).unwrap()
    }

    fn effect_json(effect: &DaemonEffect) -> Value {
        match effect {
            DaemonEffect::FetchState { emit, prompt_id } => json!({
                "type": "fetchState",
                "emit": match emit {
                    FetchEmit::RunCompleted => "runCompleted",
                    FetchEmit::SessionUpdated => "sessionUpdated",
                },
                "promptId": prompt_id,
            }),
            DaemonEffect::Reseed => json!({ "type": "reseed" }),
            DaemonEffect::RefetchQueue => json!({ "type": "refetchQueue" }),
            DaemonEffect::SetMonitorMode { mode } => json!({
                "type": "setMonitorMode",
                "mode": match mode {
                    PermissionMonitorMode::Standard => "standard",
                    PermissionMonitorMode::Bypass => "bypass",
                    PermissionMonitorMode::BypassPlus => "bypass_plus",
                    PermissionMonitorMode::Autonomous => "autonomous",
                },
            }),
            DaemonEffect::SetAutodrainEnabled { enabled } => {
                json!({ "type": "setAutodrainEnabled", "enabled": enabled })
            }
            DaemonEffect::RegisterInterrogative { pending } => {
                // Mirror the TS `registerInterrogative` pending object EXACTLY.
                // Two divergences from a naive projection: (1) interrogativeType
                // is the RAW daemon string (TS stores `ev.interrogative_type`),
                // not Rust's PascalCase `{:?}` Debug rendering; (2) TS builds a
                // minimal object and only adds the keys relevant to each kind,
                // whereas the Rust struct carries every field as `Option`, so we
                // omit the `None` ones here rather than emitting them as `null`.
                use crate::polytoken::ui_bridge::PendingInterrogativeType as Pit;
                let type_str = match pending.interrogative_type {
                    Pit::Permission => "permission",
                    Pit::Confirmation => "confirmation",
                    Pit::Clarification => "clarification",
                    Pit::Capability => "capability",
                    Pit::PlanHandoff => "plan_handoff",
                    Pit::GoalProposal => "goal_proposal",
                    Pit::AskUserQuestion => "ask_user_question",
                    Pit::Unknown => "unknown",
                };
                let mut p = serde_json::Map::new();
                p.insert("interrogativeId".into(), json!(pending.interrogative_id));
                p.insert("interrogativeType".into(), json!(type_str));
                if let Some(v) = &pending.clarification_labels {
                    p.insert("clarificationLabels".into(), json!(v));
                }
                if let Some(v) = &pending.clarification_option_keys {
                    p.insert("clarificationOptionKeys".into(), json!(v));
                }
                if let Some(v) = &pending.plan_handoff_labels {
                    p.insert("planHandoffLabels".into(), json!(v));
                }
                if let Some(qs) = &pending.questions {
                    // TS pending.questions is the full array of
                    // {questionId, optionIds, optionLabels} the reverse builder
                    // reads back by index — project it whole, not as a count.
                    let arr: Vec<Value> = qs
                        .iter()
                        .map(|q| {
                            json!({
                                "questionId": q.question_id,
                                "optionIds": q.option_ids,
                                "optionLabels": q.option_labels.clone().unwrap_or_default(),
                            })
                        })
                        .collect();
                    p.insert("questions".into(), json!(arr));
                }
                if let Some(choices) = &pending.permission_choices {
                    // TS pending.permissionChoices is the full array of
                    // {granted, persistenceTarget} the reverse builder maps a chosen
                    // label back through — project it whole, not as a count, so the
                    // forward mapper's stored choice CONTENT (grant + target, in
                    // pruned order) is actually asserted.
                    let arr: Vec<Value> = choices
                        .iter()
                        .map(|c| {
                            json!({
                                "granted": c.granted,
                                "persistenceTarget": c.persistence_target,
                            })
                        })
                        .collect();
                    p.insert("permissionChoices".into(), json!(arr));
                }
                json!({ "type": "registerInterrogative", "pending": Value::Object(p) })
            }
        }
    }

    fn effects_json(out: &FoldResult) -> Vec<Value> {
        out.effects.iter().map(effect_json).collect()
    }

    /// The full sessionUpdated snapshot the TestCtx emits for a given status, as
    /// serialized JSON — so per-case tests can assert the whole event equals the
    /// oracle's `ctx.snapshot(status)` (mirrors TS `toEqual([ctx.snapshot(...)])`).
    fn snapshot_event(status: &str) -> Value {
        let s = match status {
            "running" => SessionStatus::Running,
            "idle" => SessionStatus::Idle,
            _ => panic!("test helper: unknown status {status}"),
        };
        let ctx = TestCtx::default();
        event_json(&SessionDriverEvent::SessionUpdated {
            base: SessionEventBase {
                session_ref: ctx.r#ref().clone(),
                timestamp: "t".to_string(),
                run_id: None,
            },
            snapshot: ctx.snapshot(s),
        })
    }

    // ===== Chunk 1: turn boundaries, content-block streaming, tool plumbing, queue =====
    // One Rust #[test] per TS test(...) in event-map.test.ts L81–L465. Assertions
    // derive from the TS ORACLE's expected values, not from current Rust behavior;
    // any mismatch indicates a source bug.

    #[test]
    fn message_start_session_updated_running_and_clears_turn_error() {
        let mut acc = create_accumulator();
        acc.turn_error = Some(TurnError {
            message: "old error".to_string(),
        });
        let out = fold(
            json!({ "type": "message_start", "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(out.events.len(), 1);
        assert_eq!(event_json(&out.events[0]), snapshot_event("running"));
        assert!(acc.turn_error.is_none());
    }

    #[test]
    fn message_complete_no_error_fetch_state_run_completed_with_prompt_id() {
        let out = fold_fresh(json!({ "type": "message_complete", "prompt_id": "p1" }));
        assert!(out.events.is_empty());
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "runCompleted", "promptId": "p1" })]
        );
    }

    #[test]
    fn message_complete_with_turn_error_run_failed_and_clears_error() {
        let mut acc = create_accumulator();
        acc.turn_error = Some(TurnError {
            message: "529 overloaded".to_string(),
        });
        let out = fold(
            json!({ "type": "message_complete", "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(out.events.len(), 1);
        assert_eq!(
            event_json(&out.events[0]),
            json!({
                "sessionRef": { "workspaceId": "w", "sessionId": "s" },
                "timestamp": "t",
                "type": "runFailed",
                "error": { "message": "529 overloaded" },
            })
        );
        assert!(acc.turn_error.is_none());
    }

    #[test]
    fn message_complete_after_retry_error_cleared_by_message_start_run_completed_effect() {
        let mut acc = create_accumulator();
        acc.turn_error = Some(TurnError {
            message: "transient".to_string(),
        });
        fold(
            json!({ "type": "message_start", "prompt_id": "p2" }),
            &mut acc,
        );
        let out = fold(
            json!({ "type": "message_complete", "prompt_id": "p2" }),
            &mut acc,
        );
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "runCompleted", "promptId": "p2" })]
        );
    }

    #[test]
    fn turn_cancelled_fetch_state_session_updated() {
        let out = fold_fresh(
            json!({ "type": "turn_cancelled", "prompt_id": "p1", "reason": "user_cancelled" }),
        );
        assert!(out.events.is_empty());
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "sessionUpdated", "promptId": null })]
        );
    }

    #[test]
    fn content_block_start_text_sets_block_kind_no_events() {
        let mut acc = create_accumulator();
        let out = fold(
            json!({ "type": "content_block_start", "block_index": 0, "block_type": { "type": "text" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());
        assert_eq!(acc.block_kind, Some(BlockKind::Text));
    }

    #[test]
    fn content_block_start_tool_use_sets_block_kind_and_tool_use_block() {
        let mut acc = create_accumulator();
        let out = fold(
            json!({ "type": "content_block_start", "block_index": 1, "block_type": { "type": "tool_use", "id": "tu1", "name": "bash" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());
        assert_eq!(acc.block_kind, Some(BlockKind::ToolUse));
        assert_eq!(acc.tool_use_block.as_ref().unwrap().id, "tu1");
        assert_eq!(acc.tool_use_block.as_ref().unwrap().name, "bash");
    }

    #[test]
    fn content_block_delta_text_assistant_delta_text_channel() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::Text);
        let out = fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "text", "text": "hello" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(out.events.len(), 1);
        assert_eq!(
            event_json(&out.events[0]),
            json!({
                "sessionRef": { "workspaceId": "w", "sessionId": "s" },
                "timestamp": "t",
                "type": "assistantDelta",
                "text": "hello",
                "channel": "text",
            })
        );
    }

    #[test]
    fn content_block_delta_thinking_assistant_delta_thinking_channel() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::Thinking);
        let out = fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "thinking", "text": "hmm" }, "prompt_id": "p1" }),
            &mut acc,
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "assistantDelta");
        assert_eq!(ev["channel"], "thinking");
        assert_eq!(ev["text"], "hmm");
    }

    #[test]
    fn content_block_delta_redacted_thinking_assistant_delta_thinking() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::RedactedThinking);
        let out = fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "redacted_thinking", "data": "[redacted]" }, "prompt_id": "p1" }),
            &mut acc,
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "assistantDelta");
        assert_eq!(ev["channel"], "thinking");
        assert_eq!(ev["text"], "[redacted]");
    }

    #[test]
    fn content_block_delta_open_ai_reasoning_opaque_assistant_delta_thinking() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::OpenAiReasoningOpaque);
        let out = fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "open_ai_reasoning_opaque", "data": "opaque", "id": "rs_123" }, "prompt_id": "p1" }),
            &mut acc,
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "assistantDelta");
        assert_eq!(ev["channel"], "thinking");
        assert_eq!(ev["text"], "opaque");
    }

    #[test]
    fn content_block_delta_tool_use_input_accumulates_no_events() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::ToolUse);
        fold(
            json!({ "type": "content_block_delta", "block_index": 1, "delta": { "type": "tool_use_input", "partial_json": "{\"command\":\"ls" }, "prompt_id": "p1" }),
            &mut acc,
        );
        let out = fold(
            json!({ "type": "content_block_delta", "block_index": 1, "delta": { "type": "tool_use_input", "partial_json": "\"}" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());
        assert_eq!(acc.tool_input_buffer, "{\"command\":\"ls\"}");
    }

    #[test]
    fn content_block_delta_signature_delta_no_events_pass_through() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::Thinking);
        let out = fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "signature_delta", "signature": "sig" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());
    }

    #[test]
    fn content_block_delta_text_when_block_kind_null_no_events_stale_misordered() {
        let out = fold_fresh(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "text", "text": "orphan" }, "prompt_id": "p1" }),
        );
        assert!(out.events.is_empty());
    }

    #[test]
    fn content_block_stop_clears_block_kind() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::Text);
        let out = fold(
            json!({ "type": "content_block_stop", "block_index": 0, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());
        assert!(acc.block_kind.is_none());
    }

    #[test]
    fn tool_call_tool_started_with_parsed_input_from_accumulator() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::ToolUse);
        acc.tool_use_block = Some(ToolUseBlockMeta {
            id: "tu1".to_string(),
            name: "bash".to_string(),
        });
        acc.tool_input_buffer = "{\"command\":\"ls -la\"}".to_string();
        let out = fold(
            json!({ "type": "tool_call", "call_id": "call1", "name": "bash", "prompt_id": "p1" }),
            &mut acc,
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "toolStarted");
        assert_eq!(ev["toolName"], "bash");
        assert_eq!(ev["callId"], "call1");
        assert_eq!(ev["input"], json!({ "command": "ls -la" }));
    }

    #[test]
    fn tool_call_with_explicit_input_field_uses_it_over_accumulator() {
        let mut acc = create_accumulator();
        acc.tool_input_buffer = "{\"old\":\"stale\"}".to_string();
        let out = fold(
            json!({ "type": "tool_call", "call_id": "call1", "input": { "command": "echo hi" }, "name": "bash", "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(
            event_json(&out.events[0])["input"],
            json!({ "command": "echo hi" })
        );
    }

    #[test]
    fn tool_call_with_no_input_and_no_buffer_undefined_input() {
        let out = fold_fresh(
            json!({ "type": "tool_call", "call_id": "call1", "name": "bash", "prompt_id": "p1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "toolStarted");
        // TS oracle: input === undefined (absent). Rust serializes None as absent
        // (skip_serializing_if), so the key is missing.
        assert!(ev.get("input").is_none() || ev["input"].is_null());
    }

    #[test]
    fn tool_call_with_invalid_json_buffer_falls_back_to_raw_string() {
        let mut acc = create_accumulator();
        acc.tool_input_buffer = "not json".to_string();
        let out = fold(
            json!({ "type": "tool_call", "call_id": "call1", "name": "bash", "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(event_json(&out.events[0])["input"], json!("not json"));
    }

    #[test]
    fn tool_result_success_content_string_tool_finished() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": "done", "is_error": false, "prompt_id": "p1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "toolFinished");
        assert_eq!(ev["callId"], "call1");
        assert_eq!(ev["success"], true);
        assert_eq!(ev["output"], "done");
    }

    #[test]
    fn tool_result_error_tool_finished_with_success_false() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": "boom", "is_error": true, "prompt_id": "p1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["success"], false);
        assert_eq!(ev["output"], "boom");
    }

    #[test]
    fn tool_result_with_content_full_image_lifts_image_and_prefers_full_fallback() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": "Rendered.", "content_full": { "image": { "data": "QUJD", "media_type": "image/png", "text_fallback": "img" } }, "is_error": false, "prompt_id": "p1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "toolFinished");
        assert_eq!(ev["output"], "img");
        assert_eq!(
            ev["images"],
            json!([{ "type": "image", "data": "QUJD", "mimeType": "image/png" }])
        );
    }

    #[test]
    fn tool_result_with_content_full_text_prefers_full_and_matches_replay() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": "short", "content_full": { "text": "longer text" }, "prompt_id": "p1" }),
        );
        let live_output = event_json(&out.events[0])["output"].clone();
        assert_eq!(live_output, "longer text");

        let replay = crate::polytoken::history_seed::history_to_seed_events(
            &[json!({
                "type": "tool_result",
                "call_id": "call1",
                "content": { "text": "longer text" },
            })],
            &crate::polytoken::history_seed::HistoryMapCtx {
                r#ref: SessionRef {
                    workspace_id: "ws".into(),
                    session_id: "s1".into(),
                },
            },
        );
        assert_eq!(event_json(&replay[0])["output"], live_output);
    }

    #[test]
    fn tool_result_with_content_full_blocks_variant_extracts_text() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": "short", "content_full": { "blocks": [{ "type": "text", "text": "line1 " }, { "type": "text", "text": "line2" }] }, "prompt_id": "p1" }),
        );
        assert_eq!(event_json(&out.events[0])["output"], "line1 line2");
    }

    #[test]
    fn tool_result_preserves_unknown_content_full_variant_for_forward_compatibility() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": "short", "content_full": { "future_variant": { "raw": "complete" } }, "prompt_id": "p1" }),
        );
        let live_output = event_json(&out.events[0])["output"].clone();
        assert_eq!(
            live_output,
            json!({ "future_variant": { "raw": "complete" } })
        );

        let replay = crate::polytoken::history_seed::history_to_seed_events(
            &[json!({
                "type": "tool_result",
                "call_id": "call1",
                "content": { "future_variant": { "raw": "complete" } },
            })],
            &crate::polytoken::history_seed::HistoryMapCtx {
                r#ref: SessionRef {
                    workspace_id: "ws".into(),
                    session_id: "s1".into(),
                },
            },
        );
        assert_eq!(event_json(&replay[0])["output"], live_output);
    }

    #[test]
    fn tool_result_recognized_rich_variants_use_expected_fallbacks() {
        let cases = [
            (
                "empty image fallback text",
                json!({ "image": { "data": "QUJD", "media_type": "image/png", "text_fallback": "" } }),
                "short",
                true,
            ),
            ("empty text", json!({ "text": "" }), "short", false),
            (
                "empty extracted blocks",
                json!({ "blocks": [] }),
                "short",
                false,
            ),
            (
                "empty diff summary",
                json!({ "diff_preview": { "summary": "" } }),
                "short",
                false,
            ),
            (
                "nonempty diff summary",
                json!({ "diff_preview": { "summary": "full diff" } }),
                "full diff",
                false,
            ),
        ];

        for (name, content_full, expected_output, expects_image) in cases {
            let extracted = extract_tool_result(Some("short"), Some(&content_full));
            assert_eq!(
                extracted.output,
                Some(json!(expected_output)),
                "{name} output"
            );
            assert_eq!(
                extracted.images.as_ref().map(Vec::len),
                expects_image.then_some(1),
                "{name} images"
            );
        }
    }

    #[test]
    fn tool_result_empty_content_full_falls_back_to_short_content() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": "short", "content_full": {}, "prompt_id": "p1" }),
        );
        assert_eq!(event_json(&out.events[0])["output"], "short");
    }

    #[test]
    fn tool_result_with_null_content_and_null_content_full_undefined_output() {
        let out = fold_fresh(
            json!({ "type": "tool_result", "call_id": "call1", "content": null, "prompt_id": "p1" }),
        );
        let ev = event_json(&out.events[0]);
        assert!(ev.get("output").is_none() || ev["output"].is_null());
    }

    #[test]
    fn pending_turn_input_queued_refetch_queue_effect_no_events() {
        let out = fold_fresh(
            json!({ "type": "pending_turn_input_queued", "admission_prompt_id": "p1", "content": "steer this", "item_id": "item1", "queue_revision": 1 }),
        );
        assert!(out.events.is_empty());
        assert_eq!(effects_json(&out), vec![json!({ "type": "refetchQueue" })]);
    }

    #[test]
    fn pending_turn_input_dequeued_refetch_queue_effect() {
        let out = fold_fresh(
            json!({ "type": "pending_turn_input_dequeued", "item_id": "item1", "queue_revision": 2 }),
        );
        assert_eq!(effects_json(&out), vec![json!({ "type": "refetchQueue" })]);
    }

    #[test]
    fn pending_turn_input_discarded_refetch_queue_effect() {
        // No missing_references on this discard (e.g. superseded/cancelled) — must
        // stay silent (no notify), matching prior behavior; only the refetch fires.
        let out = fold_fresh(
            json!({ "type": "pending_turn_input_discarded", "item_ids": ["item1"], "queue_revision": 3, "reason": "superseded" }),
        );
        assert!(out.events.is_empty());
        assert_eq!(effects_json(&out), vec![json!({ "type": "refetchQueue" })]);
    }

    #[test]
    fn pending_turn_input_discarded_with_missing_references_emits_visible_warning() {
        let out = fold_fresh(json!({
            "type": "pending_turn_input_discarded",
            "item_ids": ["item1"],
            "queue_revision": 4,
            "reason": "unresolved reference",
            "missing_references": [
                { "kind": "skill", "name": "foo" },
                { "kind": "file", "name": "bar.md" }
            ]
        }));
        assert_eq!(out.events.len(), 1);
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "notify");
        assert_eq!(ev["request"]["level"], "warning");
        assert_eq!(
            ev["request"]["message"],
            "Queued message dropped — missing references: skill \"foo\", file \"bar.md\""
        );
        // Still refetches the authoritative queue, same as every other discard.
        assert_eq!(effects_json(&out), vec![json!({ "type": "refetchQueue" })]);
    }

    #[test]
    fn pending_turn_input_discarded_with_empty_missing_references_stays_silent() {
        // The field can be present-but-empty (defensive daemon-schema edge case) —
        // treat like absent, not like "zero refs, still warn" (an empty warning
        // reads as a bug, not a discard reason).
        let out = fold_fresh(json!({
            "type": "pending_turn_input_discarded",
            "item_ids": ["item1"],
            "queue_revision": 5,
            "reason": "unresolved reference",
            "missing_references": []
        }));
        assert!(out.events.is_empty());
        assert_eq!(effects_json(&out), vec![json!({ "type": "refetchQueue" })]);
    }

    #[test]
    fn pending_turn_input_drained_queued_message_started_and_queue_updated_empty() {
        let out = fold_fresh(
            json!({ "type": "pending_turn_input_drained", "admission_prompt_ids": ["p1"], "content": "steer this", "final_prompt_id": "p2", "item_ids": ["item1"], "queue_revision": 0, "raw_history_index": 5 }),
        );
        assert_eq!(out.events.len(), 2);
        let ev0 = event_json(&out.events[0]);
        assert_eq!(ev0["type"], "queuedMessageStarted");
        assert_eq!(ev0["message"]["mode"], "steer");
        assert_eq!(ev0["message"]["text"], "steer this");
        // No resolved_references on this drain — the promoted message carries none.
        assert!(ev0["message"].get("references").is_none());
        let ev1 = event_json(&out.events[1]);
        assert_eq!(ev1["type"], "queueUpdated");
        assert_eq!(ev1["messages"], json!([]));
    }

    #[test]
    fn pending_turn_input_drained_carries_resolved_references_onto_queued_message() {
        // The daemon resolves a drained queue item's `@`-refs only now
        // (PendingTurnInputDrained.resolved_references) — must ride onto the
        // QueuedMessageStarted event's message, not get dropped.
        let out = fold_fresh(json!({
            "type": "pending_turn_input_drained",
            "admission_prompt_ids": ["p1"],
            "content": "@skill:debug please",
            "final_prompt_id": "p2",
            "item_ids": ["item1"],
            "queue_revision": 0,
            "raw_history_index": 5,
            "resolved_references": [{ "kind": "skill", "name": "debug" }]
        }));
        let ev0 = event_json(&out.events[0]);
        assert_eq!(ev0["type"], "queuedMessageStarted");
        assert_eq!(
            ev0["message"]["references"],
            json!([{ "kind": "skill", "name": "debug" }])
        );
    }

    #[test]
    fn pending_turn_input_drained_multi_item_queued_message_started_and_refetch_queue_effect() {
        let out = fold_fresh(
            json!({ "type": "pending_turn_input_drained", "admission_prompt_ids": ["p1", "p2"], "content": "steer this", "final_prompt_id": "p3", "item_ids": ["item1", "item2"], "queue_revision": 0, "raw_history_index": 5 }),
        );
        assert_eq!(out.events.len(), 1);
        assert_eq!(event_json(&out.events[0])["type"], "queuedMessageStarted");
        assert_eq!(effects_json(&out), vec![json!({ "type": "refetchQueue" })]);
    }

    // ===== Chunk 2a: errors/retries, session metadata, compaction =====

    #[test]
    fn model_error_rate_limited_sets_turn_error_and_notify_warning() {
        let mut acc = create_accumulator();
        let out = fold(
            json!({ "type": "model_error", "error": { "type": "rate_limited", "retry_after_seconds": 30 }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(
            acc.turn_error.as_ref().unwrap().message,
            "Rate limited (retry in 30s)"
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "notify");
        assert_eq!(ev["request"]["level"], "warning");
    }

    #[test]
    #[ignore = "reason: phase 4/openapi type gap — generated ProviderError::Transport { message } lacks the oracle's `kind` field, so the TS transport-message case ('Transport error (connection_refused): conn refused') is unrepresentable without a codegen/type edit (out of event_map.rs scope)"]
    fn model_error_transport_human_readable_message() {
        // TS L499: error { type:"transport", kind:"connection_refused", message:"conn refused" }
        // → turnError.message == "Transport error (connection_refused): conn refused".
        let mut acc = create_accumulator();
        fold(
            json!({ "type": "model_error", "error": { "type": "transport", "kind": "connection_refused", "message": "conn refused" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(
            acc.turn_error.as_ref().unwrap().message,
            "Transport error (connection_refused): conn refused"
        );
    }

    #[test]
    fn model_error_other_code_message_format() {
        let mut acc = create_accumulator();
        fold(
            json!({ "type": "model_error", "error": { "type": "other", "code": "E500", "message": "internal" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(acc.turn_error.as_ref().unwrap().message, "E500: internal");
    }

    #[test]
    fn retry_wait_notify_with_attempt_max_retries() {
        let out = fold_fresh(
            json!({ "type": "retry_wait", "attempt": 2, "delay_ms": 5000, "error_summary": "rate_limited", "error_type": "rate_limited", "max_retries": 5, "prompt_id": "p1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "notify");
        assert_eq!(
            ev["request"]["message"],
            "Retrying (attempt 2/5): rate_limited"
        );
        assert_eq!(ev["request"]["level"], "warning");
    }

    #[test]
    fn stream_discontinuity_reseed_effect() {
        let out = fold_fresh(json!({ "type": "stream_discontinuity", "missed": 3 }));
        assert_eq!(effects_json(&out), vec![json!({ "type": "reseed" })]);
    }

    #[test]
    fn session_title_changed_session_updated_with_new_title_live_status() {
        let out = fold_fresh(
            json!({ "type": "session_title_changed", "source": "inferred", "title": "My New Title" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "sessionUpdated");
        assert_eq!(ev["snapshot"]["title"], "My New Title");
        assert_eq!(ev["snapshot"]["status"], "idle");
    }

    #[test]
    fn session_title_changed_mid_turn_uses_live_status_running() {
        let ctx = TestCtx {
            live_status: SessionStatus::Running,
            ..TestCtx::default()
        };
        let ev = daemon_event(
            json!({ "type": "session_title_changed", "source": "operator", "title": "X" }),
        );
        let out = map_daemon_event(&ev, &mut create_accumulator(), &ctx);
        assert_eq!(event_json(&out.events[0])["snapshot"]["status"], "running");
    }

    #[test]
    fn session_state_changed_fetch_state_session_updated_effect() {
        let out = fold_fresh(json!({ "type": "session_state_changed", "domains": ["todos"] }));
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "sessionUpdated", "promptId": null })]
        );
    }

    #[test]
    fn model_switch_session_updated_with_new_config_no_fetch() {
        let out = fold_fresh(
            json!({ "type": "model_switch", "from_model": "anthropic/old", "to_model": "openai/gpt-5", "to_reasoning_effort": "high" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "sessionUpdated");
        assert_eq!(
            ev["snapshot"]["config"],
            json!({ "modelId": "openai/gpt-5", "thinkingLevel": "high" })
        );
    }

    #[test]
    fn session_rewound_reseed_effect() {
        let out = fold_fresh(json!({ "type": "session_rewound", "rewound_to_index": 3 }));
        assert_eq!(effects_json(&out), vec![json!({ "type": "reseed" })]);
    }

    #[test]
    fn context_cleared_reseed_effect() {
        let out = fold_fresh(json!({ "type": "context_cleared", "facet": "execute" }));
        assert_eq!(effects_json(&out), vec![json!({ "type": "reseed" })]);
    }

    #[test]
    fn facet_switch_fetch_state_session_updated_effect() {
        let out = fold_fresh(
            json!({ "type": "facet_switch", "from_facet": "plan", "to_facet": "execute" }),
        );
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "sessionUpdated", "promptId": null })]
        );
    }

    #[test]
    fn compaction_started_notify_info() {
        // The TS oracle (L622) uses reason:"auto_threshold", but the live daemon
        // schema (wire-types.ts CompactionReason) is "threshold"|"manual" — the
        // oracle is stale. Use the schema-valid "threshold" so the event
        // deserializes; the assertion target (the notify message) is unchanged.
        let out = fold_fresh(
            json!({ "type": "compaction_started", "compaction_id": "c1", "reason": "threshold" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "notify");
        assert_eq!(ev["request"]["message"], "Compacting context…");
        assert_eq!(ev["request"]["level"], "info");
    }

    #[test]
    fn compaction_complete_notify_and_fetch_state() {
        let out = fold_fresh(
            json!({ "type": "compaction_complete", "compaction_id": "c1", "preserved_files_count": 3, "summary_length": 500, "todos_count": 2 }),
        );
        assert_eq!(event_json(&out.events[0])["request"]["kind"], "notify");
        assert_eq!(event_json(&out.events[0])["request"]["level"], "info");
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "sessionUpdated", "promptId": null })]
        );
    }

    #[test]
    fn compaction_cancelled_notify_warning() {
        let out = fold_fresh(
            json!({ "type": "compaction_cancelled", "compaction_id": "c1", "reason": "user_cancelled" }),
        );
        assert_eq!(event_json(&out.events[0])["request"]["level"], "warning");
    }

    #[test]
    fn compaction_failed_notify_error() {
        let out = fold_fresh(
            json!({ "type": "compaction_failed", "compaction_id": "c1", "reason": { "type": "provider_error", "detail": "boom" } }),
        );
        assert_eq!(event_json(&out.events[0])["request"]["level"], "error");
    }

    #[test]
    fn subagent_compaction_notice_notify_with_summary() {
        let out = fold_fresh(
            json!({ "type": "subagent_compaction_notice", "compaction_id": "c1", "emitted_at": "2026-06-28T10:00:00Z", "summary": "Subagent context compacted" }),
        );
        assert_eq!(
            event_json(&out.events[0])["request"]["message"],
            "Subagent context compacted"
        );
    }

    // ===== Chunk 2b: notifications, system reminders, subagent routing, v1-ignored, permissions =====

    #[test]
    fn notification_queued_job_completion_uses_short_label() {
        let out = fold_fresh(
            json!({ "type": "notification_queued", "notification": { "id": "n1", "notification_type": { "type": "job_complete", "exit_code": 0 }, "source": "background", "summary": "A full job report that must not become a transcript notice", "timestamp": "2026-06-28T10:00:00Z" } }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "notify");
        assert_eq!(ev["request"]["message"], "Job completed (exit 0)");
    }

    #[test]
    fn notification_queued_job_completion_without_exit_code_uses_short_label() {
        let out = fold_fresh(
            json!({ "type": "notification_queued", "notification": { "id": "n1", "notification_type": { "type": "job_complete" }, "source": "background", "summary": "A full job report", "timestamp": "2026-06-28T10:00:00Z" } }),
        );
        assert_eq!(
            event_json(&out.events[0])["request"]["message"],
            "Job completed"
        );
    }

    #[test]
    fn notification_queued_subagent_completion_uses_handle_and_outcome() {
        let out = fold_fresh(
            json!({ "type": "notification_queued", "notification": { "id": "n1", "notification_type": { "type": "subagent_complete", "handle": "job-42", "outcome": { "kind": "failure", "message": "details" } }, "source": "background", "summary": "A full review report", "timestamp": "2026-06-28T10:00:00Z" } }),
        );
        assert_eq!(
            event_json(&out.events[0])["request"]["message"],
            "Subagent job-42 Failure"
        );
    }

    #[test]
    fn notification_queued_non_completion_preserves_summary() {
        let out = fold_fresh(
            json!({ "type": "notification_queued", "notification": { "id": "n1", "notification_type": { "type": "extension_message", "extension_name": "journal" }, "source": "extension", "summary": "Journal entry saved", "timestamp": "2026-06-28T10:00:00Z" } }),
        );
        assert_eq!(
            event_json(&out.events[0])["request"]["message"],
            "Journal entry saved"
        );
    }

    #[test]
    fn tool_exposure_changed_eager_fallback_warning_notify() {
        // The TS oracle (L690) passes provider_capability_mode {type:"full_schema"},
        // but the live ToolLoading enum is eager|native_deferred|no_tools (oracle is
        // stale). Use a schema-valid value; the assertion target (eager_fallback
        // reason → warning notify containing "fallback") is unchanged.
        let out = fold_fresh(
            json!({ "type": "tool_exposure_changed", "exposed_count": 10, "revealed_count": 5, "provider_capability_mode": "native_deferred", "reason": { "type": "eager_fallback_activated" } }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "notify");
        assert_eq!(ev["request"]["level"], "warning");
        let msg = ev["request"]["message"].as_str().unwrap();
        assert!(
            msg.contains("fallback"),
            "notify message {msg} should contain 'fallback'"
        );
    }

    #[test]
    fn tool_exposure_changed_other_reason_empty() {
        // Same stale provider_capability_mode as above; use a schema-valid value.
        let out = fold_fresh(
            json!({ "type": "tool_exposure_changed", "exposed_count": 10, "revealed_count": 5, "provider_capability_mode": "native_deferred", "reason": { "type": "model_changed" } }),
        );
        assert_eq!(out.events.len(), 0);
    }

    #[test]
    fn agent_block_violation_warning_notify_naming_the_tool() {
        // The TS oracle (L719) passes only tool_name, but the live schema's
        // AgentBlockViolation also requires `path` (oracle is stale). Add a path so
        // the event deserializes; the assertion target (notify names the tool) is
        // unchanged.
        let out = fold_fresh(
            json!({ "type": "agent_block_violation", "tool_name": "shell_exec", "path": "/w/secret" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "notify");
        assert_eq!(ev["request"]["level"], "warning");
        let msg = ev["request"]["message"].as_str().unwrap();
        assert!(
            msg.contains("shell_exec"),
            "notify message {msg} should name 'shell_exec'"
        );
    }

    #[test]
    fn system_reminder_non_plan_review_reason_custom_message_display_false() {
        let out = fold_fresh(
            json!({ "type": "system_reminder", "body": "Don't forget the tests", "display_name": "Reminder", "emitted_at": "2026-06-28T10:00:00Z", "reason": { "type": "session_start" }, "slug": "test-reminder" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "customMessage");
        assert_eq!(ev["customType"], "test-reminder");
        assert_eq!(ev["text"], "Don't forget the tests");
        assert_eq!(ev["display"], false);
        assert!(ev.get("turnBoundary").is_none());
    }

    #[test]
    fn system_reminder_goal_reminder_marks_turn_boundary() {
        let out = fold_fresh(
            json!({ "type": "system_reminder", "body": "Goal reminder", "display_name": "Reminder", "emitted_at": "2026-06-28T10:00:00Z", "reason": { "type": "goal_reminder" }, "slug": "goal-reminder" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "customMessage");
        assert_eq!(ev["turnBoundary"], true);
        assert_eq!(ev["display"], false);
    }

    #[test]
    fn system_reminder_plan_review_required_visible_custom_message() {
        let out = fold_fresh(
            json!({ "type": "system_reminder", "body": "The plan reviewer flagged a missing error-handling path.", "display_name": "Reminder", "emitted_at": "2026-06-28T10:00:00Z", "reason": { "type": "plan_review_required" }, "slug": "plan-review-1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "customMessage");
        assert_eq!(ev["customType"], "Plan review required");
        assert_eq!(
            ev["text"],
            "The plan reviewer flagged a missing error-handling path."
        );
        assert_eq!(ev["display"], true);
    }

    #[test]
    fn system_reminder_plan_mode_reinforcement_visible_custom_message() {
        let out = fold_fresh(
            json!({ "type": "system_reminder", "body": "Stay in plan mode until the design is settled.", "display_name": "Reminder", "emitted_at": "2026-06-28T10:00:00Z", "reason": { "type": "plan_mode_reinforcement" }, "slug": "plan-reinforce-1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "customMessage");
        assert_eq!(ev["customType"], "Plan mode reminder");
        assert_eq!(ev["display"], true);
    }

    #[test]
    fn system_reminder_plan_verification_visible_custom_message() {
        let out = fold_fresh(
            json!({ "type": "system_reminder", "body": "Verify the implementation matches the approved plan.", "display_name": "Reminder", "emitted_at": "2026-06-28T10:00:00Z", "reason": { "type": "plan_verification" }, "slug": "plan-verify-1" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "customMessage");
        assert_eq!(ev["customType"], "Plan verification");
        assert_eq!(ev["display"], true);
    }

    #[test]
    #[ignore = "reason: phase 4/openapi enum gap — the generated SystemReminderReason enum rejects unknown reason values before map_daemon_event, so the TS 'unknown reason (forward-compat)' case ({type:'some_future_reason'}) cannot be constructed without a codegen/type edit"]
    fn system_reminder_unknown_reason_custom_message_display_false_forward_compat() {
        // TS L802: reason { type:"some_future_reason" } → customMessage(customType=slug,
        // display:false). The TS source has a forward-compat default arm; the generated
        // Rust enum has no default, so an unknown reason fails to deserialize here.
        let out = fold_fresh(
            json!({ "type": "system_reminder", "body": "Some future reason not yet in the enum.", "display_name": "Reminder", "emitted_at": "2026-06-28T10:00:00Z", "reason": { "type": "some_future_reason" }, "slug": "future-reminder" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "customMessage");
        assert_eq!(ev["customType"], "future-reminder");
        assert_eq!(ev["text"], "Some future reason not yet in the enum.");
        assert_eq!(ev["display"], false);
    }

    #[test]
    fn events_with_subagent_handle_are_skipped_not_top_level_transcript() {
        let out = fold_fresh(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "text", "text": "subagent text" }, "prompt_id": "p1", "subagent_handle": "sub1" }),
        );
        assert!(out.events.is_empty());
        assert!(out.effects.is_empty());
    }

    #[test]
    fn message_start_with_subagent_handle_is_skipped() {
        let out = fold_fresh(
            json!({ "type": "message_start", "prompt_id": "p1", "subagent_handle": "sub1" }),
        );
        assert!(out.events.is_empty());
    }

    #[test]
    fn heartbeat_empty() {
        let out = fold_fresh(json!({ "type": "heartbeat", "timestamp": "t" }));
        assert!(out.events.is_empty());
        assert!(out.effects.is_empty());
    }

    #[test]
    fn notification_autodrain_switch_session_updated_and_set_autodrain_enabled_regression() {
        let out = fold_fresh(json!({ "type": "notification_autodrain_switch", "enabled": true }));
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "sessionUpdated");
        assert_eq!(ev["snapshot"]["notificationAutodrain"], true);
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "setAutodrainEnabled", "enabled": true })]
        );
    }

    #[test]
    fn notifications_drained_empty() {
        let out = fold_fresh(json!({ "type": "notifications_drained", "count": 3 }));
        assert!(out.events.is_empty());
        assert!(out.effects.is_empty());
    }

    #[test]
    fn permission_monitor_switch_session_updated_carries_new_mode_and_set_monitor_mode_effect() {
        let out = fold_fresh(
            json!({ "type": "permission_monitor_switch", "from_monitor": { "type": "standard" }, "to_monitor": { "type": "bypass" } }),
        );
        assert_eq!(out.events.len(), 1);
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "sessionUpdated");
        assert_eq!(ev["snapshot"]["permissionMonitor"], "bypass");
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "setMonitorMode", "mode": "bypass" })]
        );
    }

    #[test]
    fn notification_autodrain_switch_session_updated_and_set_autodrain_enabled_effect() {
        let out = fold_fresh(json!({ "type": "notification_autodrain_switch", "enabled": true }));
        assert_eq!(out.events.len(), 1);
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "sessionUpdated");
        assert_eq!(ev["snapshot"]["notificationAutodrain"], true);
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "setAutodrainEnabled", "enabled": true })]
        );
    }

    // ===== Chunk 3a: interrogatives (all variants) =====

    #[test]
    fn interrogative_confirmation_confirm_card_and_register_interrogative() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i1", "interrogative_type": "confirmation", "question": "Continue?", "prompt_id": "p1" }),
        );
        assert_eq!(out.events.len(), 1);
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "confirm");
        assert_eq!(ev["request"]["requestId"], "i1");
        assert_eq!(ev["request"]["message"], "Continue?");
        assert_eq!(
            effects_json(&out),
            vec![
                json!({ "type": "registerInterrogative", "pending": { "interrogativeId": "i1", "interrogativeType": "confirmation" } })
            ]
        );
    }

    #[test]
    fn interrogative_clarification_select_card_and_option_keys_captured() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "clarification_options": [{ "key": "yes", "label": "Yes" }, { "key": "no", "label": "No" }], "interrogative_id": "i2", "interrogative_type": "clarification", "prompt_id": "p1", "question": "Which?" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "select");
        assert_eq!(ev["request"]["requestId"], "i2");
        assert_eq!(ev["request"]["options"], json!(["Yes", "No"]));
        let eff = &effects_json(&out)[0];
        assert_eq!(eff["type"], "registerInterrogative");
        assert_eq!(eff["pending"]["interrogativeId"], "i2");
        assert_eq!(eff["pending"]["interrogativeType"], "clarification");
        assert_eq!(eff["pending"]["clarificationLabels"], json!(["Yes", "No"]));
        assert_eq!(
            eff["pending"]["clarificationOptionKeys"],
            json!(["yes", "no"])
        );
    }

    #[test]
    fn interrogative_capability_confirm_card() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i3", "interrogative_type": "capability", "prompt_id": "p1", "question": "Grant network access?" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        assert_eq!(ev["request"]["kind"], "confirm");
        assert_eq!(ev["request"]["requestId"], "i3");
        assert_eq!(ev["request"]["message"], "Grant network access?");
    }

    #[test]
    fn interrogative_plan_handoff_plan_card_with_markdown_and_action_labels() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i4", "interrogative_type": "plan_handoff", "plan_handoff": { "action_labels": { "cancel": "Cancel", "implement_current_context": "Implement here", "implement_new_context": "Implement fresh" }, "display_path": "/plan.md", "plan_path": "/plan.md", "plan_text": "the plan", "target_facet": "execute", "title": "Review plan" }, "prompt_id": "p1", "question": "Approve plan?" }),
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "hostUiRequest");
        let req = &ev["request"];
        assert_eq!(req["kind"], "plan");
        assert_eq!(req["requestId"], "i4");
        assert_eq!(req["title"], "Review plan");
        assert_eq!(req["planText"], "the plan");
        assert_eq!(req["displayPath"], "/plan.md");
        assert_eq!(req["targetFacet"], "execute");
        assert_eq!(
            req["actionLabels"],
            json!(["Implement fresh", "Implement here", "Cancel"])
        );
    }

    #[test]
    fn interrogative_plan_handoff_null_fallback_labels_and_empty_body() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i4", "interrogative_type": "plan_handoff", "plan_handoff": null, "prompt_id": "p1", "question": "Approve plan?" }),
        );
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "plan");
        assert_eq!(req["planText"], "");
        assert_eq!(
            req["actionLabels"],
            json!([
                "Implement (new context)",
                "Implement (current context)",
                "Cancel"
            ])
        );
    }

    #[test]
    fn interrogative_permission_null_context_all_7_options() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i5", "interrogative_type": "permission", "prompt_id": "p1", "question": "Run bash?" }),
        );
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "permission");
        assert_eq!(req["requestId"], "i5");
        assert_eq!(req["title"], "Run bash?");
        assert_eq!(req["toolName"], Value::Null);
        assert_eq!(req["toolInput"], Value::Null);
        assert_eq!(
            req["options"],
            json!([
                "Deny",
                "Allow once",
                "Allow for session",
                "Allow for project (local)",
                "Allow for project",
                "Allow for user (local)",
                "Allow for user"
            ])
        );
        let eff = &effects_json(&out)[0];
        assert_eq!(eff["type"], "registerInterrogative");
        assert_eq!(eff["pending"]["interrogativeId"], "i5");
        assert_eq!(eff["pending"]["interrogativeType"], "permission");
        // All 7 choices captured (no pruning — keep_targets absent); the first
        // (Deny) is granted:false with no persistence target (matches the oracle).
        assert_eq!(
            eff["pending"]["permissionChoices"]
                .as_array()
                .unwrap()
                .len(),
            7
        );
        assert_eq!(
            eff["pending"]["permissionChoices"][0],
            json!({ "granted": false, "persistenceTarget": null })
        );
    }

    #[test]
    fn interrogative_permission_with_tool_call_shows_tool_name_and_input() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i6", "interrogative_type": "permission", "prompt_id": "p1", "question": "Run bash?", "permission_tool_call": { "tool_name": "shell_exec", "tool_use_id": "tu1", "input": { "command": "rm -rf /tmp/test" } } }),
        );
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "permission");
        assert_eq!(req["toolName"], "shell_exec");
        assert_eq!(
            req["toolInput"],
            serde_json::to_string_pretty(&json!({ "command": "rm -rf /tmp/test" })).unwrap()
        );
    }

    #[test]
    fn interrogative_permission_keep_targets_session_only_3_options_render() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i7", "interrogative_type": "permission", "prompt_id": "p1", "question": "Run bash?", "permission_candidate_rule": { "keep_targets": ["session"], "default_target": "session", "candidate_rule_raw": "rule", "candidate_rule_resolved_today": "rule-today", "floor_context": { "tool_name": "shell_exec" } } }),
        );
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "permission");
        assert_eq!(
            req["options"],
            json!(["Deny", "Allow once", "Allow for session"])
        );
        let eff = &effects_json(&out)[0];
        // Pruned to 3; the "Allow for session" choice (index 2) grants + targets
        // session — assert the stored choice CONTENT, not just the count.
        assert_eq!(
            eff["pending"]["permissionChoices"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            eff["pending"]["permissionChoices"][2],
            json!({ "granted": true, "persistenceTarget": "session" })
        );
    }

    #[test]
    fn interrogative_permission_keep_targets_user_4_options_render() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i8", "interrogative_type": "permission", "prompt_id": "p1", "question": "Run bash?", "permission_candidate_rule": { "keep_targets": ["user_local", "user"], "default_target": "user", "candidate_rule_raw": "rule", "candidate_rule_resolved_today": "rule-today", "floor_context": { "tool_name": "shell_exec" } } }),
        );
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(
            req["options"],
            json!([
                "Deny",
                "Allow once",
                "Allow for user (local)",
                "Allow for user"
            ])
        );
        let eff = &effects_json(&out)[0];
        // TS asserts the count only here (4 pruned choices).
        assert_eq!(
            eff["pending"]["permissionChoices"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[test]
    fn ask_user_question_qna_card_and_question_option_ids_captured() {
        let out = fold_fresh(
            json!({ "type": "ask_user_question", "interrogative_id": "q1", "payload": { "questions": [{ "id": "q-a", "mode": "single_select", "options": [{ "id": "o1", "label": "Opt1", "description": "desc" }, { "id": "o2", "label": "Opt2", "description": "" }], "question": "Pick one?" }, { "id": "q-b", "mode": "text", "question": "Free text?", "allow_free_text": true }] }, "prompt_id": "p1" }),
        );
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "qna");
        assert_eq!(req["requestId"], "q1");
        assert_eq!(req["questions"][0]["question"], "Pick one?");
        assert_eq!(req["questions"][0]["options"][0]["label"], "Opt1");
        assert_eq!(req["questions"][0]["options"][0]["description"], "desc");
        assert_eq!(req["questions"][0]["options"][1]["label"], "Opt2");
        assert_eq!(req["questions"][0]["multiSelect"], false);
        assert_eq!(req["questions"][1]["question"], "Free text?");
        assert_eq!(req["questions"][1]["multiSelect"], false);
        let eff = &effects_json(&out)[0];
        assert_eq!(eff["type"], "registerInterrogative");
        assert_eq!(eff["pending"]["interrogativeId"], "q1");
        assert_eq!(eff["pending"]["interrogativeType"], "ask_user_question");
        assert_eq!(eff["pending"]["questions"][0]["questionId"], "q-a");
        assert_eq!(
            eff["pending"]["questions"][0]["optionIds"],
            json!(["o1", "o2"])
        );
        assert_eq!(
            eff["pending"]["questions"][0]["optionLabels"],
            json!(["Opt1", "Opt2"])
        );
        assert_eq!(eff["pending"]["questions"][1]["questionId"], "q-b");
        assert_eq!(eff["pending"]["questions"][1]["optionIds"], json!([]));
        assert_eq!(eff["pending"]["questions"][1]["optionLabels"], json!([]));
    }

    #[test]
    fn interrogative_goal_proposal_confirm_card_and_register_interrogative() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "g1", "interrogative_type": "goal_proposal", "goal_proposal": { "title": "Ship feature X", "proposed_summary": "Implement the new dashboard widget", "proposed_file_path": "/goal.md", "action_labels": { "accept": "Accept", "reject": "Reject" } }, "prompt_id": "p1", "question": "Propose goal?" }),
        );
        assert_eq!(out.events.len(), 1);
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "confirm");
        assert_eq!(req["requestId"], "g1");
        assert_eq!(req["title"], "Ship feature X");
        assert_eq!(req["message"], "Implement the new dashboard widget");
        assert_eq!(
            effects_json(&out),
            vec![
                json!({ "type": "registerInterrogative", "pending": { "interrogativeId": "g1", "interrogativeType": "goal_proposal" } })
            ]
        );
    }

    #[test]
    fn interrogative_goal_proposal_null_fallback_title() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "g2", "interrogative_type": "goal_proposal", "goal_proposal": null, "prompt_id": "p1", "question": "Propose goal?" }),
        );
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "confirm");
        assert_eq!(req["requestId"], "g2");
        assert_eq!(req["title"], "Goal proposal");
        let eff = &effects_json(&out)[0];
        assert_eq!(eff["type"], "registerInterrogative");
        assert_eq!(eff["pending"]["interrogativeId"], "g2");
        assert_eq!(eff["pending"]["interrogativeType"], "goal_proposal");
    }

    #[test]
    #[ignore = "reason: phase 4/openapi enum gap — the generated InterrogativeType enum rejects unknown values before map_daemon_event, so the TS 'unknown_type' forward-compat case ({interrogative_type:'some_future_type'}) cannot be constructed without a codegen/type edit"]
    fn interrogative_unknown_type_confirm_dialog_deny_safe_and_register_interrogative() {
        // TS L1247: interrogative_type 'some_future_type' → confirm card titled
        // '⚠ Unknown request type: some_future_type' + registerInterrogative with
        // interrogativeType 'unknown'. The TS source has a runtime default arm; the
        // generated Rust enum has none, so an unknown type fails to deserialize.
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "u1", "interrogative_type": "some_future_type", "prompt_id": "p1", "question": "?" }),
        );
        assert_eq!(out.events.len(), 1);
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "confirm");
        assert_eq!(req["requestId"], "u1");
        assert_eq!(req["title"], "⚠ Unknown request type: some_future_type");
        assert_eq!(
            effects_json(&out),
            vec![
                json!({ "type": "registerInterrogative", "pending": { "interrogativeId": "u1", "interrogativeType": "unknown" } })
            ]
        );
    }

    #[test]
    fn interrogative_with_subagent_handle_is_skipped_not_top_level() {
        let out = fold_fresh(
            json!({ "type": "interrogative", "interrogative_id": "i1", "interrogative_type": "confirmation", "prompt_id": "p1", "question": "ok?", "subagent_handle": "sub1" }),
        );
        assert!(out.events.is_empty());
        assert!(out.effects.is_empty());
    }

    // -----------------------------------------------------------------------
    // buildPostFetchEvent — pure follow-up event builder after a fetchState.
    // Port of event-map.test.ts `describe("buildPostFetchEvent")`.
    // -----------------------------------------------------------------------

    #[test]
    fn post_fetch_run_completed_idle_snapshot() {
        let ctx = TestCtx::default();
        let j = event_json(&build_post_fetch_event(FetchEmit::RunCompleted, &ctx, None));
        assert_eq!(j["type"], "runCompleted");
        assert_eq!(j["snapshot"]["status"], "idle");
    }

    #[test]
    fn post_fetch_run_completed_with_prompt_id_stamps_entry_ids() {
        let ctx = TestCtx::default();
        let j = event_json(&build_post_fetch_event(
            FetchEmit::RunCompleted,
            &ctx,
            Some("p1"),
        ));
        assert_eq!(j["type"], "runCompleted");
        assert_eq!(j["snapshot"]["status"], "idle");
        assert_eq!(j["userEntryId"], "p1");
        assert_eq!(j["assistantEntryId"], "p1");
    }

    #[test]
    fn post_fetch_run_completed_without_prompt_id_no_entry_ids() {
        let ctx = TestCtx::default();
        let j = event_json(&build_post_fetch_event(FetchEmit::RunCompleted, &ctx, None));
        assert_eq!(j["type"], "runCompleted");
        // TS asserts the entryId properties are absent; serde omits `None`, and
        // serde_json Index yields Null for a missing key — either way, null-ish.
        assert!(j["userEntryId"].is_null());
        assert!(j["assistantEntryId"].is_null());
    }

    #[test]
    fn post_fetch_session_updated_uses_live_status() {
        let ctx = TestCtx {
            live_status: SessionStatus::Running,
            ..TestCtx::default()
        };
        let j = event_json(&build_post_fetch_event(
            FetchEmit::SessionUpdated,
            &ctx,
            None,
        ));
        assert_eq!(j["type"], "sessionUpdated");
        assert_eq!(j["snapshot"]["status"], "running");
    }

    // -----------------------------------------------------------------------
    // resetAccumulator — clears stale stream state on reconnect/reseed.
    // Port of event-map.test.ts `describe("resetAccumulator")`.
    // -----------------------------------------------------------------------

    #[test]
    fn reset_accumulator_clears_stream_state() {
        let mut acc = create_accumulator();
        acc.block_kind = Some(BlockKind::ToolUse);
        acc.tool_input_buffer = "{\"partial\":true}".to_string();
        acc.tool_use_block = Some(ToolUseBlockMeta {
            id: "tu1".to_string(),
            name: "bash".to_string(),
        });
        acc.turn_error = Some(TurnError {
            message: "stale error".to_string(),
        });
        reset_accumulator(&mut acc);
        assert!(acc.block_kind.is_none());
        assert_eq!(acc.tool_input_buffer, "");
        assert!(acc.tool_use_block.is_none());
        assert!(acc.turn_error.is_none());
    }

    #[test]
    fn reset_accumulator_prevents_stale_turn_error_failing_next_complete() {
        let mut acc = create_accumulator();
        fold(
            json!({ "type": "message_start", "prompt_id": "p1" }),
            &mut acc,
        );
        fold(
            json!({ "type": "model_error", "error": { "type": "auth_failed" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(acc.turn_error.is_some());

        // Reconnect → reseed → reset clears the stale error.
        reset_accumulator(&mut acc);

        // The next turn completes successfully (NOT a runFailed).
        fold(
            json!({ "type": "message_start", "prompt_id": "p2" }),
            &mut acc,
        );
        let out = fold(
            json!({ "type": "message_complete", "prompt_id": "p2" }),
            &mut acc,
        );
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "runCompleted", "promptId": "p2" })]
        );
        assert!(out.events.is_empty());
    }

    // -----------------------------------------------------------------------
    // Streaming pipeline integration — full observed traces across the fold.
    // Port of event-map.test.ts `describe("streaming pipeline integration")`.
    // -----------------------------------------------------------------------

    #[test]
    fn streaming_full_text_turn() {
        let mut acc = create_accumulator();
        let out = fold(
            json!({ "type": "message_start", "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(event_json(&out.events[0])["type"], "sessionUpdated");
        assert_eq!(event_json(&out.events[0])["snapshot"]["status"], "running");

        let out = fold(
            json!({ "type": "content_block_start", "block_index": 0, "block_type": { "type": "text" }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());

        let out = fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "text", "text": "hello world" }, "prompt_id": "p1" }),
            &mut acc,
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "assistantDelta");
        assert_eq!(ev["text"], "hello world");
        assert_eq!(ev["channel"], "text");

        let out = fold(
            json!({ "type": "content_block_stop", "block_index": 0, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());

        let out = fold(
            json!({ "type": "message_complete", "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.events.is_empty());
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "runCompleted", "promptId": "p1" })]
        );

        // The driver would then call build_post_fetch_event for the follow-up.
        let ctx = TestCtx::default();
        let fin = event_json(&build_post_fetch_event(
            FetchEmit::RunCompleted,
            &ctx,
            Some("p1"),
        ));
        assert_eq!(fin["type"], "runCompleted");
        assert_eq!(fin["snapshot"]["status"], "idle");
        assert_eq!(fin["userEntryId"], "p1");
        assert_eq!(fin["assistantEntryId"], "p1");
    }

    #[test]
    fn streaming_tool_turn() {
        let mut acc = create_accumulator();
        fold(
            json!({ "type": "message_start", "prompt_id": "p1" }),
            &mut acc,
        );
        fold(
            json!({ "type": "content_block_start", "block_index": 0, "block_type": { "type": "tool_use", "id": "tu1", "name": "bash" }, "prompt_id": "p1" }),
            &mut acc,
        );
        fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "tool_use_input", "partial_json": "{\"command\":\"ls\"" }, "prompt_id": "p1" }),
            &mut acc,
        );
        fold(
            json!({ "type": "content_block_delta", "block_index": 0, "delta": { "type": "tool_use_input", "partial_json": "}" }, "prompt_id": "p1" }),
            &mut acc,
        );

        // tool_call — authoritative tool start.
        let out = fold(
            json!({ "type": "tool_call", "call_id": "call1", "name": "bash", "prompt_id": "p1" }),
            &mut acc,
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "toolStarted");
        assert_eq!(ev["toolName"], "bash");
        assert_eq!(ev["callId"], "call1");
        assert_eq!(ev["input"]["command"], "ls");

        // tool_result.
        let out = fold(
            json!({ "type": "tool_result", "call_id": "call1", "content": "file1\nfile2", "is_error": false, "prompt_id": "p1" }),
            &mut acc,
        );
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "toolFinished");
        assert_eq!(ev["success"], true);
        assert_eq!(ev["output"], "file1\nfile2");

        let out = fold(
            json!({ "type": "message_complete", "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "runCompleted", "promptId": "p1" })]
        );
    }

    #[test]
    fn streaming_error_then_retry_clears_and_completes() {
        let mut acc = create_accumulator();
        fold(
            json!({ "type": "message_start", "prompt_id": "p1" }),
            &mut acc,
        );
        fold(
            json!({ "type": "model_error", "error": { "type": "rate_limited", "retry_after_seconds": 10 }, "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(acc.turn_error.is_some());

        // Retry — message_start clears the error.
        fold(
            json!({ "type": "message_start", "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(acc.turn_error.is_none());

        let out = fold(
            json!({ "type": "message_complete", "prompt_id": "p1" }),
            &mut acc,
        );
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "runCompleted", "promptId": "p1" })]
        );
    }

    #[test]
    fn streaming_unretried_error_fails_the_run() {
        let mut acc = create_accumulator();
        fold(
            json!({ "type": "message_start", "prompt_id": "p1" }),
            &mut acc,
        );
        fold(
            json!({ "type": "model_error", "error": { "type": "auth_failed" }, "prompt_id": "p1" }),
            &mut acc,
        );
        let out = fold(
            json!({ "type": "message_complete", "prompt_id": "p1" }),
            &mut acc,
        );
        assert!(out.effects.is_empty());
        assert_eq!(out.events.len(), 1);
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "runFailed");
        assert_eq!(ev["timestamp"], "t");
        assert_eq!(ev["sessionRef"]["sessionId"], "s");
        assert_eq!(ev["error"]["message"], "Authentication failed");
    }

    // -----------------------------------------------------------------------
    // snapshotFromState — projecting a daemon /state snapshot into a pantoken
    // SessionSnapshot. Ports both `snapshotFromState config` and
    // `snapshotFromState` describe blocks.
    // -----------------------------------------------------------------------

    fn snap_from(state: Option<&SessionStateSnapshot>) -> SessionSnapshot {
        snapshot_from_state(
            state,
            &test_ref(),
            &test_workspace(),
            SessionStatus::Idle,
            "t",
            None,
            None,
        )
    }

    #[test]
    fn snapshot_config_slash_bearing_model_full_form() {
        let st = base_state();
        let cfg = snap_from(Some(&st)).config.expect("config present");
        assert_eq!(cfg.model_id.as_deref(), Some("anthropic/claude-sonnet-4"));
        assert_eq!(cfg.thinking_level.as_deref(), Some("medium"));
    }

    #[test]
    fn snapshot_config_slash_less_model_whole_string() {
        let mut st = base_state();
        st.active_model = Some("local-model".to_string());
        let cfg = snap_from(Some(&st)).config.expect("config present");
        assert_eq!(cfg.model_id.as_deref(), Some("local-model"));
        assert_eq!(cfg.thinking_level.as_deref(), Some("medium"));
    }

    #[test]
    fn snapshot_config_null_state_none() {
        assert!(snap_from(None).config.is_none());
    }

    #[test]
    fn snapshot_threads_active_facet() {
        let mut st = base_state();
        st.active_facet = "plan".to_string();
        assert_eq!(snap_from(Some(&st)).facet.as_deref(), Some("plan"));
    }

    #[test]
    fn snapshot_facet_none_for_null_state() {
        assert!(snap_from(None).facet.is_none());
    }

    #[test]
    fn snapshot_threads_active_plan() {
        let mut st = base_state();
        st.active_plan = Some("# My Plan\n- Step 1".to_string());
        assert_eq!(
            snap_from(Some(&st)).active_plan.as_deref(),
            Some("# My Plan\n- Step 1")
        );
    }

    #[test]
    fn snapshot_active_plan_none_for_null_state() {
        assert!(snap_from(None).active_plan.is_none());
    }

    #[test]
    fn snapshot_threads_current_goal() {
        use pantoken_protocol::session_driver::GoalInfo;
        let mut st = base_state();
        st.current_goal = Some(make_goal("Ship feature X", "active"));
        assert_eq!(
            snap_from(Some(&st)).goal,
            Some(Some(GoalInfo {
                summary: "Ship feature X".to_string(),
                lifecycle: "active".to_string(),
            }))
        );
    }

    #[test]
    fn snapshot_projects_current_goal_null_to_cleared() {
        // The daemon sends current_goal:null when a goal is cleared. serde maps
        // that to `None` on the single-Option field; snapshot_from_state projects
        // a PRESENT state's None → Some(None) (cleared → badge hides).
        let st = base_state(); // current_goal: None (== daemon null)
        assert_eq!(snap_from(Some(&st)).goal, Some(None));
    }

    #[test]
    fn snapshot_goal_none_for_null_state() {
        // Null state → no goal projection (preserve). This is the portable half
        // of the TS "defaults goal to undefined when current_goal is absent" case.
        assert!(snap_from(None).goal.is_none());
    }

    #[test]
    #[ignore = "reason: daemon-type collapse (codegen/Phase 4). SessionStateSnapshot.current_goal is a single Option<CurrentGoal>, so serde maps BOTH daemon `null` and an absent field to None. snapshot_from_state therefore treats a PRESENT state whose current_goal is None as `cleared` (Some(None)) — correct for the real daemon, which always emits current_goal. The TS 'present state + absent current_goal -> undefined (older-daemon preserve)' distinction is structurally unrepresentable after deserialization; restoring it needs a double-Option in the generated type."]
    fn snapshot_goal_undefined_when_current_goal_absent_present_state() {
        // TS: snapshotFromState(baseState, ...) -> snap.goal undefined (preserve).
        // Rust collapses absent into null, so the source yields Some(None) here.
        let st = base_state(); // current_goal absent/None
        assert!(snap_from(Some(&st)).goal.is_none());
    }

    #[test]
    fn snapshot_threads_flags() {
        use pantoken_protocol::session_driver::{FlaggedFile, FlaggedFileMode};
        let mut st = base_state();
        st.flags = serde_json::from_value(json!([
            { "path": "src/app.ts", "mode": "included" },
            { "path": "README.md", "mode": "referenced" },
        ]))
        .expect("valid flag entries");
        assert_eq!(
            snap_from(Some(&st)).flags,
            Some(vec![
                FlaggedFile {
                    path: "src/app.ts".to_string(),
                    mode: FlaggedFileMode::Included,
                },
                FlaggedFile {
                    path: "README.md".to_string(),
                    mode: FlaggedFileMode::Referenced,
                },
            ])
        );
    }

    #[test]
    fn snapshot_threads_todos() {
        use pantoken_protocol::session_driver::{TodoItem, TodoStatus};
        let mut st = base_state();
        st.todos = serde_json::from_value(json!([
            { "id": 1, "title": "Write tests", "description": "Add unit tests", "status": "in_progress", "dependencies": [2], "emitted_at": "2025-01-01T00:00:00Z" },
        ]))
        .expect("valid todo entries");
        assert_eq!(
            snap_from(Some(&st)).todos,
            Some(vec![TodoItem {
                id: 1,
                title: "Write tests".to_string(),
                description: "Add unit tests".to_string(),
                status: TodoStatus::InProgress,
                dependencies: vec![2],
                created_at: Some("2025-01-01T00:00:00Z".to_string()),
            }])
        );
    }

    #[test]
    fn snapshot_flags_todos_none_for_null_state() {
        let snap = snap_from(None);
        assert!(snap.flags.is_none());
        assert!(snap.todos.is_none());
    }

    // -----------------------------------------------------------------------
    // Remaining mapDaemonEvent cases: "-> empty" ambient events, mcp_server
    // notices, agent_block_violation regression, and goal_driver_update.
    // Ports the tail of event-map.test.ts `describe("mapDaemonEvent")`.
    // -----------------------------------------------------------------------

    /// Assert a daemon event folds to an empty result (no events, no effects).
    fn assert_empty(value: Value) {
        let out = fold_fresh(value);
        assert!(out.events.is_empty(), "expected no events");
        assert!(out.effects.is_empty(), "expected no effects");
    }

    #[test]
    fn hook_fired_empty() {
        assert_empty(
            json!({ "type": "hook_fired", "event_type": "pre_tool", "hook_name": "my-hook", "outcome": "allowed" }),
        );
    }

    #[test]
    fn hook_fired_stop_blocked_emits_run_completed_and_turn_boundary() {
        let out = fold_fresh(
            json!({ "type": "hook_fired", "event_type": "stop", "hook_name": "stop-test-hook", "outcome": "blocked" }),
        );
        assert_eq!(
            out.events.len(),
            2,
            "should emit RunCompleted + CustomMessage"
        );
        assert!(out.effects.is_empty(), "should emit no effects");

        // First event: RunCompleted (stamps completedAt on the open assistant)
        let ev0 = event_json(&out.events[0]);
        assert_eq!(
            ev0["type"], "runCompleted",
            "first event should be RunCompleted"
        );
        assert_eq!(ev0["snapshot"]["status"], "idle", "snapshot should be idle");

        // Second event: CustomMessage with turn_boundary:true
        let ev1 = event_json(&out.events[1]);
        assert_eq!(
            ev1["type"], "customMessage",
            "second event should be CustomMessage"
        );
        assert_eq!(ev1["customType"], "stop_hook_redirect");
        assert_eq!(ev1["turnBoundary"], true, "should set turnBoundary");
        assert_eq!(ev1["display"], false, "should not display the inject");
    }

    #[test]
    fn hook_fired_stop_allowed_is_empty() {
        // A stop hook that allows the stop (outcome:"allowed") should be a no-op.
        assert_empty(
            json!({ "type": "hook_fired", "event_type": "stop", "hook_name": "my-hook", "outcome": "allowed" }),
        );
    }

    #[test]
    fn hook_fired_non_stop_blocked_is_empty() {
        // A non-stop hook with outcome:"blocked" (e.g. a pre_tool hook that blocks)
        // should NOT trigger the turn-boundary synthesis — only stop hooks do.
        assert_empty(
            json!({ "type": "hook_fired", "event_type": "pre_tool", "hook_name": "my-hook", "outcome": "blocked" }),
        );
    }

    #[test]
    fn context_loaded_empty() {
        assert_empty(json!({ "type": "context_loaded", "hash": "abc", "path": "/foo" }));
    }

    #[test]
    fn tool_reveal_empty() {
        assert_empty(
            json!({ "type": "tool_reveal", "prompt_id": "p1", "source": { "type": "tool_search" }, "tool_names": ["bash"] }),
        );
    }

    #[test]
    fn classifier_decision_empty() {
        assert_empty(
            json!({ "type": "classifier_decision", "call_id": "c1", "outcome": "allow", "prompt_id": "p1", "tool_name": "bash" }),
        );
    }

    #[test]
    fn extension_registered_empty() {
        assert_empty(json!({ "type": "extension_registered", "name": "my-ext" }));
    }

    #[test]
    fn subagent_started_emits_fetch_state() {
        let out = fold_fresh(
            json!({ "type": "subagent_started", "handle": "h1", "model": "m", "subagent_type": "general" }),
        );
        assert!(out.events.is_empty());
        assert_eq!(out.effects.len(), 1);
        assert!(matches!(
            out.effects[0],
            DaemonEffect::FetchState {
                emit: FetchEmit::SessionUpdated,
                prompt_id: None,
            }
        ));
    }

    #[test]
    fn subagent_completed_emits_fetch_state() {
        let out = fold_fresh(
            json!({ "type": "subagent_completed", "handle": "h1", "outcome": { "kind": "success" }, "result_summary": "done" }),
        );
        assert!(out.events.is_empty());
        assert_eq!(out.effects.len(), 1);
        assert!(matches!(
            out.effects[0],
            DaemonEffect::FetchState {
                emit: FetchEmit::SessionUpdated,
                prompt_id: None,
            }
        ));
    }

    #[test]
    fn image_reference_resolved_empty() {
        assert_empty(
            json!({ "type": "image_reference_resolved", "file_size_bytes": 1024, "media_type": "image/png", "path": "/img.png", "prompt_id": "p1" }),
        );
    }

    #[test]
    fn job_promoted_empty() {
        assert_empty(json!({ "type": "job_promoted", "job_id": "j1" }));
    }

    #[test]
    fn job_completed_empty() {
        assert_empty(json!({ "type": "job_completed", "exit_code": 0, "job_id": "j1" }));
    }

    #[test]
    fn job_expiring_empty() {
        assert_empty(json!({ "type": "job_expiring", "job_id": "j1" }));
    }

    #[test]
    fn job_cancelled_empty() {
        assert_empty(json!({ "type": "job_cancelled", "job_id": "j1" }));
    }

    #[test]
    fn job_updated_empty() {
        assert_empty(json!({ "type": "job_updated", "job_id": "j1" }));
    }

    #[test]
    fn usage_throttle_empty() {
        assert_empty(
            json!({ "type": "usage_throttle", "action": { "kind": "proceed" }, "provider": "anthropic", "snapshot": {} }),
        );
    }

    /// Assert a daemon event folds to a single notify hostUiRequest at the given
    /// level whose message names `needle`, with no effects.
    fn assert_notify(value: Value, level: &str, needle: &str) {
        let out = fold_fresh(value);
        assert!(out.effects.is_empty(), "expected no effects");
        assert_eq!(out.events.len(), 1);
        let req = &event_json(&out.events[0])["request"];
        assert_eq!(req["kind"], "notify");
        assert_eq!(req["level"], level);
        assert!(
            req["message"].as_str().unwrap().contains(needle),
            "message {:?} should contain {:?}",
            req["message"],
            needle
        );
    }

    #[test]
    fn mcp_server_connected_info_notice() {
        assert_notify(
            json!({ "type": "mcp_server_connected", "resource_count": 3, "server_name": "my-mcp", "tool_count": 5, "transport": "stdio" }),
            "info",
            "my-mcp",
        );
    }

    #[test]
    fn mcp_server_disconnected_warning_notice() {
        assert_notify(
            json!({ "type": "mcp_server_disconnected", "reason": "error", "server_name": "my-mcp", "transport": "stdio" }),
            "warning",
            "my-mcp",
        );
    }

    #[test]
    fn mcp_server_reconnecting_info_notice() {
        assert_notify(
            json!({ "type": "mcp_server_reconnecting", "attempt": 1, "next_retry_in_ms": 1000, "server_name": "my-mcp", "transport": "stdio" }),
            "info",
            "my-mcp",
        );
    }

    #[test]
    fn mcp_server_disabled_warning_notice() {
        assert_notify(
            json!({ "type": "mcp_server_disabled", "reason": "config_error", "server_name": "my-mcp", "transport": "stdio" }),
            "warning",
            "my-mcp",
        );
    }

    #[test]
    fn agent_block_violation_warning_notify_regression() {
        assert_notify(
            json!({ "type": "agent_block_violation", "path": "/some/path", "tool_name": "shell_exec" }),
            "warning",
            "shell_exec",
        );
    }

    #[test]
    fn goal_driver_update_with_goal_object_session_updated_and_fetch_state() {
        let goal = serde_json::to_value(make_goal("Ship feature X", "active")).unwrap();
        let out = fold_fresh(
            json!({ "type": "goal_driver_update", "goal": goal, "proposed_summary": null, "transition": "set" }),
        );
        assert_eq!(out.events.len(), 1);
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "sessionUpdated");
        assert_eq!(ev["snapshot"]["goal"]["summary"], "Ship feature X");
        assert_eq!(ev["snapshot"]["goal"]["lifecycle"], "active");
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "sessionUpdated", "promptId": null })]
        );
    }

    #[test]
    fn goal_driver_update_with_goal_null_clears_goal() {
        // The daemon sends goal:null when a goal is cleared. serde maps that to
        // None on the single-Option field; the handler projects a `cleared`
        // transition to a sessionUpdated carrying goal:null.
        let out = fold_fresh(
            json!({ "type": "goal_driver_update", "goal": null, "proposed_summary": null, "transition": "cleared" }),
        );
        assert_eq!(out.events.len(), 1);
        let ev = event_json(&out.events[0]);
        assert_eq!(ev["type"], "sessionUpdated");
        assert!(ev["snapshot"]["goal"].is_null());
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "sessionUpdated", "promptId": null })]
        );
    }

    #[test]
    fn goal_driver_update_with_goal_omitted_only_fetch_state() {
        // goal absent + a non-`cleared` transition (`proposed`) must NOT emit a
        // sessionUpdated (that would blank the badge) — only a fetchState. The
        // handler recovers this from the required `transition` field despite the
        // serde null-vs-absent collapse (see the GoalDriverUpdate arm), so this
        // case is faithfully portable (no longer #[ignore]d).
        let out = fold_fresh(
            json!({ "type": "goal_driver_update", "proposed_summary": null, "transition": "proposed" }),
        );
        assert!(out.events.is_empty());
        assert_eq!(
            effects_json(&out),
            vec![json!({ "type": "fetchState", "emit": "sessionUpdated", "promptId": null })]
        );
    }

    #[test]
    #[ignore = "reason: phase 4/openapi enum gap — the generated DaemonEvent enum is exhaustive (serde tag), so an unknown `type` fails to deserialize before map_daemon_event runs. The TS 'unknown variant -> empty + console.warn (observable)' forward-compat case cannot be constructed without a codegen/type edit; the Rust-idiomatic equivalent is that deserialization rejects the unknown variant loudly."]
    fn unknown_variant_type_empty_observable() {
        // TS L1621: fold({type:"future_unknown_variant"}) -> {events:[],effects:[]}
        // plus a console.warn. Not constructible against the exhaustive Rust enum.
        assert_empty(json!({ "type": "future_unknown_variant" }));
    }
}
