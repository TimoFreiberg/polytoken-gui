//! Folded session state + foldEvent reducer — Rust port of `protocol/src/state.ts`.
//!
//! The server holds the authoritative copy; clients fold the same event stream
//! into an identical local copy. On (re)connect the server ships the transcript
//! as seed EVENTS which the client folds from `initial_session_state()` (protocol
//! v2), then resumes incremental folding — no folded state ever crosses the wire.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::session_driver::{
    FlaggedFile, GoalInfo, HostUiRequest, ImageContent,
    McpServerInfo, NotifyLevel, PermissionMonitorMode, SessionConfig, SessionDriverEvent,
    SessionQueuedMessage, SessionRef, SessionStatus, SessionUsage, TodoItem,
};

// ── Transcript items ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TranscriptItem {
    User(UserItem),
    Assistant(AssistantItem),
    Tool(ToolItem),
    Notice(NoticeItem),
    Inject(InjectItem),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserItem {
    pub id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub images: Option<Vec<ImageContent>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "entryId")]
    pub entry_id: Option<String>,
    /// Client-only delivery state for an optimistic prompt row. Authoritative
    /// server transcript items omit it; the client overlays pending outbox
    /// entries at render time.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub delivery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "deliveryError")]
    pub delivery_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantItem {
    pub id: String,
    pub text: String,
    pub thinking: String,
    pub streaming: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "entryId")]
    pub entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "completedAt")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    Running,
    Ok,
    Error,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolItem {
    pub id: String, // callId
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub images: Option<Vec<ImageContent>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub progress: Option<f64>,
    pub status: ToolStatus,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "startedAt")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "finishedAt")]
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoticeItem {
    pub id: String,
    pub level: NoticeLevel,
    pub text: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InjectItem {
    pub id: String,
    #[serde(rename = "customType")]
    pub custom_type: String,
    pub text: String,
    #[serde(default)]
    pub display: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ts: Option<String>,
}

// ── Ambient widgets ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmbientWidget {
    pub key: String,
    pub lines: Vec<String>,
    pub placement: AmbientPlacement,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AmbientPlacement {
    AboveComposer,
    BelowComposer,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AmbientState {
    pub statuses: HashMap<String, String>,
    pub widgets: HashMap<String, AmbientWidget>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
}

// ── SessionState ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none", default)]
    pub session_ref: Option<SessionRef>,
    pub title: String,
    pub status: SessionStatus,
    #[serde(default)]
    pub config: SessionConfig,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<SessionUsage>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub facet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "permissionMonitor")]
    pub permission_monitor: Option<PermissionMonitorMode>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "adventurousHandoff")]
    pub adventurous_handoff: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "notificationAutodrain")]
    pub notification_autodrain: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "activePlan")]
    pub active_plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default, rename = "default")]
    pub goal: Option<Option<GoalInfo>>,
    #[serde(default)]
    pub flags: Vec<FlaggedFile>,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
    #[serde(default, rename = "mcpServers")]
    pub mcp_servers: Vec<McpServerInfo>,
    pub items: Vec<TranscriptItem>,
    #[serde(rename = "pendingApprovals")]
    pub pending_approvals: Vec<HostUiRequest>,
    #[serde(default)]
    pub ambient: AmbientState,
    #[serde(default)]
    pub queued: Vec<SessionQueuedMessage>,
}

pub fn initial_session_state() -> SessionState {
    SessionState {
        session_ref: None,
        title: String::new(),
        status: SessionStatus::Idle,
        config: SessionConfig::default(),
        usage: None,
        facet: None,
        permission_monitor: None,
        adventurous_handoff: None,
        notification_autodrain: None,
        active_plan: None,
        goal: None,
        flags: Vec::new(),
        todos: Vec::new(),
        mcp_servers: Vec::new(),
        items: Vec::new(),
        pending_approvals: Vec::new(),
        ambient: AmbientState::default(),
        queued: Vec::new(),
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn last_item(items: &[TranscriptItem]) -> Option<&TranscriptItem> {
    items.last()
}

/// True if there is an assistant item currently accumulating deltas.
fn open_assistant(items: &mut [TranscriptItem]) -> Option<&mut AssistantItem> {
    match items.last_mut() {
        Some(TranscriptItem::Assistant(a)) if a.streaming => Some(a),
        _ => None,
    }
}

/// Close the open assistant bubble (if any). When `completed_at` is given —
/// i.e. the turn actually ended, not just got interrupted by a new item —
/// stamp it so the UI can derive the turn's "Worked for Ns" duration.
fn close_open_assistant(items: &mut [TranscriptItem], completed_at: Option<&str>) {
    if let Some(a) = open_assistant(items) {
        a.streaming = false;
        if let Some(ts) = completed_at {
            a.completed_at = Some(ts.to_string());
        }
    }
}

/// Backfill a daemon tree entry id onto the most recent item of `kind`.
fn stamp_last_entry_id(items: &mut [TranscriptItem], kind: EntryIdKind, entry_id: &str) {
    for item in items.iter_mut().rev() {
        match (kind, item) {
            (EntryIdKind::User, TranscriptItem::User(u)) => {
                u.entry_id = Some(entry_id.to_string());
                return;
            }
            (EntryIdKind::Assistant, TranscriptItem::Assistant(a)) => {
                a.entry_id = Some(entry_id.to_string());
                return;
            }
            _ => continue,
        }
    }
}

#[derive(Clone, Copy)]
enum EntryIdKind {
    User,
    Assistant,
}

/// Settle tool cards that never received a matching toolFinished event.
fn interrupt_running_tools(items: &mut [TranscriptItem], finished_at: &str) {
    for item in items.iter_mut() {
        if let TranscriptItem::Tool(t) = item {
            if t.status == ToolStatus::Running {
                t.status = ToolStatus::Interrupted;
                t.finished_at = Some(finished_at.to_string());
            }
        }
    }
}

// ── foldEvent ───────────────────────────────────────────────────────────

/// Fold one driver event into state. MUTATES `state` and returns it —
/// matching the TS behavior where mutation keeps the hot streaming path
/// allocation-free.
pub fn fold_event(state: &mut SessionState, ev: &SessionDriverEvent) {
    use crate::session_driver::{
        AssistantDeltaChannel, HostUiRequest as H, SessionDriverEvent as E,
    };

    match ev {
        E::SessionOpened { snapshot, .. }
        | E::SessionUpdated { snapshot, .. }
        | E::RunCompleted { snapshot, .. } => {
            state.session_ref = Some(snapshot.r#ref.clone());
            state.title = snapshot.title.clone();
            state.status = snapshot.status;
            if let Some(c) = &snapshot.config {
                state.config = c.clone();
            }
            // Only overwrite when the snapshot carries usage
            if let Some(u) = &snapshot.usage {
                state.usage = Some(u.clone());
            }
            if snapshot.facet.is_some() {
                state.facet = snapshot.facet.clone();
            }
            if snapshot.permission_monitor.is_some() {
                state.permission_monitor = snapshot.permission_monitor;
            }
            if snapshot.adventurous_handoff.is_some() {
                state.adventurous_handoff = snapshot.adventurous_handoff;
            }
            if snapshot.notification_autodrain.is_some() {
                state.notification_autodrain = snapshot.notification_autodrain;
            }
            if snapshot.active_plan.is_some() {
                state.active_plan = snapshot.active_plan.clone();
            }
            // goal: null → None (badge hides), object → set, undefined → preserved
            if let Some(g) = &snapshot.goal {
                state.goal = Some(g.clone());
            }
            if let Some(f) = &snapshot.flags {
                state.flags = f.clone();
            }
            if let Some(t) = &snapshot.todos {
                state.todos = t.clone();
            }
            if let Some(m) = &snapshot.mcp_servers {
                state.mcp_servers = m.clone();
            }
            if let Some(q) = &snapshot.queued_messages {
                if !q.is_empty() {
                    state.queued = q.clone();
                }
            }
            // Close any open assistant when the turn ends
            if snapshot.status != SessionStatus::Running {
                close_open_assistant(&mut state.items, Some(ev.timestamp()));
            }
            // runCompleted is an authoritative turn boundary
            if let E::RunCompleted {
                assistant_entry_id,
                user_entry_id,
                ..
            } = ev
            {
                interrupt_running_tools(&mut state.items, ev.timestamp());
                if let Some(aid) = assistant_entry_id {
                    stamp_last_entry_id(&mut state.items, EntryIdKind::Assistant, aid);
                }
                if let Some(uid) = user_entry_id {
                    stamp_last_entry_id(&mut state.items, EntryIdKind::User, uid);
                }
            }
        }

        E::UserMessage {
            id,
            text,
            images,
            entry_id,
            ..
        } => {
            close_open_assistant(&mut state.items, None);
            state.items.push(TranscriptItem::User(UserItem {
                id: id.clone(),
                text: text.clone(),
                images: images.clone(),
                ts: Some(ev.timestamp().clone()),
                entry_id: entry_id.clone(),
                delivery: None,
                delivery_error: None,
            }));
        }

        E::CustomMessage {
            id,
            custom_type,
            text,
            display,
            ..
        } => {
            close_open_assistant(&mut state.items, None);
            state.items.push(TranscriptItem::Inject(InjectItem {
                id: id.clone(),
                custom_type: custom_type.clone(),
                text: text.clone(),
                display: *display,
                ts: Some(ev.timestamp().clone()),
            }));
        }

        E::QueuedMessageStarted { message, .. } => {
            close_open_assistant(&mut state.items, None);
            state.items.push(TranscriptItem::User(UserItem {
                id: message.id.clone(),
                text: message.text.clone(),
                images: None,
                ts: Some(message.created_at.clone()),
                entry_id: None,
                delivery: None,
                delivery_error: None,
            }));
            state.queued.retain(|q| q.id != message.id);
        }

        E::QueueUpdated { messages, .. } => {
            state.queued = messages.clone();
        }

        E::AssistantDelta {
            text,
            channel,
            entry_id,
            ..
        } => {
            // Check if we need to open a new assistant bubble
            let need_new = !matches!(
                last_item(&state.items),
                Some(TranscriptItem::Assistant(a)) if a.streaming
            );

            if need_new {
                let id = format!("a-{}-{}", ev.timestamp(), state.items.len());
                state.items.push(TranscriptItem::Assistant(AssistantItem {
                    id,
                    text: String::new(),
                    thinking: String::new(),
                    streaming: true,
                    ts: Some(ev.timestamp().clone()),
                    entry_id: entry_id.clone(),
                    completed_at: None,
                }));
            }

            // Now append the delta text
            if let Some(TranscriptItem::Assistant(a)) = state.items.last_mut() {
                match channel {
                    Some(AssistantDeltaChannel::Thinking) => a.thinking.push_str(text),
                    _ => a.text.push_str(text),
                }
            }
        }

        E::ToolStarted {
            tool_name,
            call_id,
            input,
            label,
            description,
            ..
        } => {
            close_open_assistant(&mut state.items, None);
            state.items.push(TranscriptItem::Tool(ToolItem {
                id: call_id.clone(),
                name: tool_name.clone(),
                label: label.clone(),
                description: description.clone(),
                input: input.clone(),
                output: None,
                images: None,
                text: None,
                progress: None,
                status: ToolStatus::Running,
                started_at: Some(ev.timestamp().clone()),
                finished_at: None,
            }));
        }

        E::ToolUpdated {
            call_id, text, progress, ..
        } => {
            for item in state.items.iter_mut() {
                if let TranscriptItem::Tool(t) = item {
                    if t.id == *call_id {
                        if let Some(txt) = text {
                            t.text = Some(txt.clone());
                        }
                        if let Some(p) = progress {
                            t.progress = Some(*p);
                        }
                    }
                }
            }
        }

        E::ToolFinished {
            call_id,
            success,
            output,
            images,
            ..
        } => {
            for item in state.items.iter_mut() {
                if let TranscriptItem::Tool(t) = item {
                    if t.id == *call_id {
                        t.status = if *success {
                            ToolStatus::Ok
                        } else {
                            ToolStatus::Error
                        };
                        t.output = output.clone();
                        if let Some(imgs) = images {
                            t.images = Some(imgs.clone());
                        }
                        t.finished_at = Some(ev.timestamp().clone());
                    }
                }
            }
        }

        E::UsageUpdated { usage, .. } => {
            state.usage = Some(usage.clone());
        }

        E::RunFailed { error, .. } => {
            close_open_assistant(&mut state.items, None);
            interrupt_running_tools(&mut state.items, ev.timestamp());
            state.status = SessionStatus::Failed;
            state.items.push(TranscriptItem::Notice(NoticeItem {
                id: format!("err-{}", ev.timestamp()),
                level: NoticeLevel::Error,
                text: error.message.clone(),
            }));
        }

        E::HostUiRequest { request, .. } => {
            if crate::session_driver::is_dialog_request(request) {
                // Only add if not already present
                let already = state
                    .pending_approvals
                    .iter()
                    .any(|p| host_request_id(p) == host_request_id(request));
                if !already {
                    state.pending_approvals.push(request.clone());
                }
            } else {
                // Fire-and-forget ambient UI
                match request {
                    H::Status { key, text, .. } => {
                        if let Some(t) = text {
                            state.ambient.statuses.insert(key.clone(), t.clone());
                        } else {
                            state.ambient.statuses.remove(key);
                        }
                    }
                    H::Widget {
                        key, lines, placement, ..
                    } => {
                        if let Some(ls) = lines {
                            if !ls.is_empty() {
                                let ap = match placement.unwrap_or(crate::session_driver::WidgetPlacement::AboveComposer) {
                                    crate::session_driver::WidgetPlacement::AboveComposer => AmbientPlacement::AboveComposer,
                                    crate::session_driver::WidgetPlacement::BelowComposer => AmbientPlacement::BelowComposer,
                                };
                                state.ambient.widgets.insert(
                                    key.clone(),
                                    AmbientWidget {
                                        key: key.clone(),
                                        lines: ls.clone(),
                                        placement: ap,
                                    },
                                );
                            }
                        } else {
                            state.ambient.widgets.remove(key);
                        }
                    }
                    H::Title { title, .. } => {
                        state.ambient.title = Some(title.clone());
                    }
                    H::Notify {
                        request_id: rid,
                        message,
                        level,
                        ..
                    } => {
                        close_open_assistant(&mut state.items, None);
                        let notice_level = match level.unwrap_or(NotifyLevel::Info) {
                            NotifyLevel::Info => NoticeLevel::Info,
                            NotifyLevel::Warning => NoticeLevel::Warning,
                            NotifyLevel::Error => NoticeLevel::Error,
                        };
                        state.items.push(TranscriptItem::Notice(NoticeItem {
                            id: rid.clone(),
                            level: notice_level,
                            text: message.clone(),
                        }));
                    }
                    H::Reset { .. } => {
                        state.ambient = AmbientState::default();
                    }
                    H::EditorText { .. } => {
                        // prefill belongs to the per-client composer; ignored in shared state
                    }
                    // Dialog types already handled above
                    _ => unreachable!("non-dialog request not handled: is_dialog_request should have caught it"),
                }
            }
        }

        E::HostUiResolved { request_id: rid, .. } => {
            state
                .pending_approvals
                .retain(|p| host_request_id(p) != *rid);
        }

        E::ExtensionCompatibilityIssue { issue, .. } => {
            close_open_assistant(&mut state.items, None);
            state.items.push(TranscriptItem::Notice(NoticeItem {
                id: format!("compat-{}", ev.timestamp()),
                level: NoticeLevel::Warning,
                text: format!(
                    "Extension capability \"{}\" is terminal-only: {}",
                    issue.capability, issue.message
                ),
            }));
        }

        E::SessionClosed { reason, .. } => {
            close_open_assistant(&mut state.items, Some(ev.timestamp()));
            interrupt_running_tools(&mut state.items, ev.timestamp());
            state.status = if *reason == crate::session_driver::SessionClosedReason::Failed {
                SessionStatus::Failed
            } else {
                SessionStatus::Idle
            };
        }

        E::SessionReset { .. } => {
            // Clear the items so the fresh events that follow fold into an
            // empty state instead of duplicating. Preserve metadata.
            state.items.clear();
        }
    }
}

/// Extract the requestId from a HostUiRequest (used for dedup).
fn host_request_id(req: &HostUiRequest) -> &str {
    use crate::session_driver::HostUiRequest as H;
    match req {
        H::Confirm { request_id, .. }
        | H::Input { request_id, .. }
        | H::Select { request_id, .. }
        | H::Editor { request_id, .. }
        | H::Qna { request_id, .. }
        | H::Plan { request_id, .. }
        | H::Permission { request_id, .. }
        | H::Notify { request_id, .. }
        | H::Status { request_id, .. }
        | H::Widget { request_id, .. }
        | H::Title { request_id, .. }
        | H::EditorText { request_id, .. }
        | H::Reset { request_id } => request_id,
    }
}

/// Convenience: fold a batch (used to rebuild state from an event log).
pub fn fold_all(events: &[SessionDriverEvent]) -> SessionState {
    fold_all_from(initial_session_state(), events)
}

/// Fold a batch starting from a given state.
pub fn fold_all_from(mut state: SessionState, events: &[SessionDriverEvent]) -> SessionState {
    for ev in events {
        fold_event(&mut state, ev);
    }
    state
}

// ── unused import guard ─────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_driver::{
        AssistantDeltaChannel, HostUiRequest, NotifyLevel, SessionClosedReason,
        SessionDriverEvent as E, SessionEventBase, SessionRef, SessionSnapshot, SessionStatus,
        WorkspaceRef,
    };

    fn base() -> SessionEventBase {
        SessionEventBase {
            session_ref: SessionRef {
                workspace_id: "ws".into(),
                session_id: "s1".into(),
            },
            timestamp: "2026-01-01T00:00:00Z".into(),
            run_id: None,
        }
    }

    fn snapshot(status: SessionStatus) -> SessionSnapshot {
        SessionSnapshot {
            r#ref: SessionRef {
                workspace_id: "ws".into(),
                session_id: "s1".into(),
            },
            workspace: WorkspaceRef {
                workspace_id: "ws".into(),
                path: "/home".into(),
                display_name: None,
            },
            title: "Test".into(),
            status,
            updated_at: "2026-01-01T00:00:00Z".into(),
            archived_at: None,
            preview: None,
            config: None,
            usage: None,
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

    #[test]
    fn initial_state_is_empty() {
        let s = initial_session_state();
        assert_eq!(s.status, SessionStatus::Idle);
        assert!(s.items.is_empty());
        assert!(s.pending_approvals.is_empty());
        assert!(s.queued.is_empty());
        assert!(s.flags.is_empty());
    }

    #[test]
    fn fold_session_opened_sets_state() {
        let mut s = initial_session_state();
        let ev = E::SessionOpened {
            base: base(),
            snapshot: snapshot(SessionStatus::Idle),
        };
        fold_event(&mut s, &ev);
        assert_eq!(s.title, "Test");
        assert_eq!(s.status, SessionStatus::Idle);
        assert!(s.session_ref.is_some());
    }

    #[test]
    fn fold_assistant_delta_creates_streaming_item() {
        let mut s = initial_session_state();
        let ev = E::AssistantDelta {
            base: base(),
            text: "Hello".into(),
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        };
        fold_event(&mut s, &ev);
        assert_eq!(s.items.len(), 1);
        match &s.items[0] {
            TranscriptItem::Assistant(a) => {
                assert_eq!(a.text, "Hello");
                assert!(a.streaming);
            }
            _ => panic!("expected assistant item"),
        }
    }

    #[test]
    fn fold_thinking_delta_appends_to_thinking() {
        let mut s = initial_session_state();
        let ev1 = E::AssistantDelta {
            base: base(),
            text: "thinking...".into(),
            channel: Some(AssistantDeltaChannel::Thinking),
            entry_id: None,
        };
        fold_event(&mut s, &ev1);
        let ev2 = E::AssistantDelta {
            base: base(),
            text: " answer".into(),
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        };
        fold_event(&mut s, &ev2);
        match &s.items[0] {
            TranscriptItem::Assistant(a) => {
                assert_eq!(a.thinking, "thinking...");
                assert_eq!(a.text, " answer");
            }
            _ => panic!("expected assistant item"),
        }
    }

    #[test]
    fn fold_run_completed_closes_assistant() {
        let mut s = initial_session_state();
        fold_event(
            &mut s,
            &E::AssistantDelta {
                base: base(),
                text: "Hello".into(),
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        );
        fold_event(
            &mut s,
            &E::RunCompleted {
                base: base(),
                snapshot: snapshot(SessionStatus::Idle),
                user_entry_id: None,
                assistant_entry_id: Some("e1".into()),
            },
        );
        match &s.items[0] {
            TranscriptItem::Assistant(a) => {
                assert!(!a.streaming);
                assert_eq!(a.entry_id, Some("e1".to_string()));
                assert!(a.completed_at.is_some());
            }
            _ => panic!("expected assistant item"),
        }
    }

    #[test]
    fn fold_user_message_creates_user_item() {
        let mut s = initial_session_state();
        let ev = E::UserMessage {
            base: base(),
            id: "u1".into(),
            text: "Hello".into(),
            images: None,
            entry_id: None,
        };
        fold_event(&mut s, &ev);
        assert_eq!(s.items.len(), 1);
        match &s.items[0] {
            TranscriptItem::User(u) => assert_eq!(u.text, "Hello"),
            _ => panic!("expected user item"),
        }
    }

    #[test]
    fn fold_tool_started_then_finished() {
        let mut s = initial_session_state();
        fold_event(
            &mut s,
            &E::ToolStarted {
                base: base(),
                tool_name: "shell".into(),
                call_id: "c1".into(),
                input: None,
                label: None,
                description: None,
            },
        );
        fold_event(
            &mut s,
            &E::ToolFinished {
                base: base(),
                call_id: "c1".into(),
                success: true,
                output: None,
                images: None,
            },
        );
        match &s.items[0] {
            TranscriptItem::Tool(t) => {
                assert_eq!(t.status, ToolStatus::Ok);
                assert!(t.finished_at.is_some());
            }
            _ => panic!("expected tool item"),
        }
    }

    #[test]
    fn fold_run_failed_adds_error_notice() {
        let mut s = initial_session_state();
        let ev = E::RunFailed {
            base: base(),
            error: crate::session_driver::SessionErrorInfo {
                message: "boom".into(),
                code: None,
                details: None,
            },
        };
        fold_event(&mut s, &ev);
        assert_eq!(s.status, SessionStatus::Failed);
        assert_eq!(s.items.len(), 1);
        match &s.items[0] {
            TranscriptItem::Notice(n) => {
                assert_eq!(n.level, NoticeLevel::Error);
                assert_eq!(n.text, "boom");
            }
            _ => panic!("expected notice item"),
        }
    }

    #[test]
    fn fold_host_ui_request_dialog_adds_pending() {
        let mut s = initial_session_state();
        let ev = E::HostUiRequest {
            base: base(),
            request: HostUiRequest::Confirm {
                request_id: "r1".into(),
                title: "Confirm?".into(),
                message: "Sure?".into(),
                default_value: None,
                timeout_ms: None,
            },
        };
        fold_event(&mut s, &ev);
        assert_eq!(s.pending_approvals.len(), 1);
    }

    #[test]
    fn fold_host_ui_request_notify_adds_notice() {
        let mut s = initial_session_state();
        let ev = E::HostUiRequest {
            base: base(),
            request: HostUiRequest::Notify {
                request_id: "n1".into(),
                message: "Done".into(),
                level: Some(NotifyLevel::Info),
            },
        };
        fold_event(&mut s, &ev);
        assert_eq!(s.pending_approvals.len(), 0);
        assert_eq!(s.items.len(), 1);
        match &s.items[0] {
            TranscriptItem::Notice(n) => assert_eq!(n.text, "Done"),
            _ => panic!("expected notice"),
        }
    }

    #[test]
    fn fold_host_ui_resolved_removes_pending() {
        let mut s = initial_session_state();
        fold_event(
            &mut s,
            &E::HostUiRequest {
                base: base(),
                request: HostUiRequest::Confirm {
                    request_id: "r1".into(),
                    title: "T".into(),
                    message: "M".into(),
                    default_value: None,
                    timeout_ms: None,
                },
            },
        );
        assert_eq!(s.pending_approvals.len(), 1);
        fold_event(
            &mut s,
            &E::HostUiResolved {
                base: base(),
                request_id: "r1".into(),
            },
        );
        assert!(s.pending_approvals.is_empty());
    }

    #[test]
    fn fold_session_reset_clears_items() {
        let mut s = initial_session_state();
        fold_event(
            &mut s,
            &E::UserMessage {
                base: base(),
                id: "u1".into(),
                text: "hi".into(),
                images: None,
                entry_id: None,
            },
        );
        assert!(!s.items.is_empty());
        fold_event(
            &mut s,
            &E::SessionReset {
                base: base(),
            },
        );
        assert!(s.items.is_empty());
    }

    #[test]
    fn fold_session_closed_sets_status() {
        let mut s = initial_session_state();
        fold_event(
            &mut s,
            &E::SessionClosed {
                base: base(),
                reason: SessionClosedReason::Failed,
            },
        );
        assert_eq!(s.status, SessionStatus::Failed);

        let mut s2 = initial_session_state();
        fold_event(
            &mut s2,
            &E::SessionClosed {
                base: base(),
                reason: SessionClosedReason::Manual,
            },
        );
        assert_eq!(s2.status, SessionStatus::Idle);
    }

    #[test]
    fn fold_overwrite_guarded_fields() {
        let mut s = initial_session_state();
        // First snapshot sets facet
        let mut snap1 = snapshot(SessionStatus::Running);
        snap1.facet = Some("plan".into());
        fold_event(&mut s, &E::SessionUpdated { base: base(), snapshot: snap1 });
        assert_eq!(s.facet, Some("plan".to_string()));

        // Second snapshot without facet should NOT clear it
        let snap2 = snapshot(SessionStatus::Idle);
        fold_event(&mut s, &E::SessionUpdated { base: base(), snapshot: snap2 });
        assert_eq!(s.facet, Some("plan".to_string()));
    }

    #[test]
    fn fold_queue_updated_replaces_queue() {
        let mut s = initial_session_state();
        let msg = crate::session_driver::SessionQueuedMessage {
            id: "q1".into(),
            mode: crate::session_driver::SessionMessageDeliveryMode::Steer,
            text: "queued msg".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        fold_event(
            &mut s,
            &E::QueueUpdated {
                base: base(),
                messages: vec![msg],
            },
        );
        assert_eq!(s.queued.len(), 1);
        assert_eq!(s.queued[0].id, "q1");
    }

    #[test]
    fn fold_all_builds_from_event_log() {
        let events = vec![
            E::SessionOpened {
                base: base(),
                snapshot: snapshot(SessionStatus::Idle),
            },
            E::UserMessage {
                base: base(),
                id: "u1".into(),
                text: "Hello".into(),
                images: None,
                entry_id: None,
            },
            E::AssistantDelta {
                base: base(),
                text: "Hi there".into(),
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
            E::RunCompleted {
                base: base(),
                snapshot: snapshot(SessionStatus::Idle),
                user_entry_id: Some("ue1".into()),
                assistant_entry_id: Some("ae1".into()),
            },
        ];
        let s = fold_all(&events);
        assert_eq!(s.items.len(), 2);
        // User item should have entryId backfilled
        match &s.items[0] {
            TranscriptItem::User(u) => {
                assert_eq!(u.entry_id, Some("ue1".to_string()));
            }
            _ => panic!("expected user item"),
        }
        // Assistant should be closed + have entryId
        match &s.items[1] {
            TranscriptItem::Assistant(a) => {
                assert!(!a.streaming);
                assert_eq!(a.entry_id, Some("ae1".to_string()));
                assert_eq!(a.text, "Hi there");
            }
            _ => panic!("expected assistant item"),
        }
    }

    #[test]
    fn fold_usage_updated_only_touches_usage() {
        let mut s = initial_session_state();
        s.title = "My Title".into();
        s.facet = Some("plan".into());
        fold_event(
            &mut s,
            &E::UsageUpdated {
                base: base(),
                usage: SessionUsage {
                    tokens: Some(500),
                    context_window: 200000,
                    percent: Some(0.25),
                },
            },
        );
        // Title and facet should be untouched
        assert_eq!(s.title, "My Title");
        assert_eq!(s.facet, Some("plan".to_string()));
        assert_eq!(s.usage.as_ref().unwrap().tokens, Some(500));
    }

    #[test]
    fn fold_custom_message_creates_inject_item() {
        let mut s = initial_session_state();
        fold_event(
            &mut s,
            &E::CustomMessage {
                base: base(),
                id: "c1".into(),
                custom_type: "system".into(),
                text: "injected".into(),
                display: true,
            },
        );
        assert_eq!(s.items.len(), 1);
        match &s.items[0] {
            TranscriptItem::Inject(i) => {
                assert_eq!(i.custom_type, "system");
                assert_eq!(i.text, "injected");
                assert!(i.display);
            }
            _ => panic!("expected inject item"),
        }
    }

    #[test]
    fn fold_queued_message_started_surfaces_user_and_dequeues() {
        let mut s = initial_session_state();
        let msg = crate::session_driver::SessionQueuedMessage {
            id: "q1".into(),
            mode: crate::session_driver::SessionMessageDeliveryMode::Steer,
            text: "queued".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        s.queued.push(msg);
        assert_eq!(s.queued.len(), 1);

        fold_event(
            &mut s,
            &E::QueuedMessageStarted {
                base: base(),
                message: crate::session_driver::SessionQueuedMessage {
                    id: "q1".into(),
                    mode: crate::session_driver::SessionMessageDeliveryMode::Steer,
                    text: "queued".into(),
                    created_at: "2026-01-01T00:00:00Z".into(),
                    updated_at: "2026-01-01T00:00:00Z".into(),
                },
            },
        );
        assert_eq!(s.queued.len(), 0);
        assert_eq!(s.items.len(), 1);
        match &s.items[0] {
            TranscriptItem::User(u) => assert_eq!(u.text, "queued"),
            _ => panic!("expected user item"),
        }
    }

    #[test]
    fn fold_extension_compat_issue_adds_warning_notice() {
        let mut s = initial_session_state();
        fold_event(
            &mut s,
            &E::ExtensionCompatibilityIssue {
                base: base(),
                issue: crate::session_driver::ExtensionCompatibilityIssue {
                    capability: "ui.status".into(),
                    classification: crate::session_driver::ExtensionIssueClassification::TerminalOnly,
                    message: "not available in TUI".into(),
                    extension_path: None,
                    event_name: None,
                },
            },
        );
        match &s.items[0] {
            TranscriptItem::Notice(n) => {
                assert_eq!(n.level, NoticeLevel::Warning);
                assert!(n.text.contains("ui.status"));
            }
            _ => panic!("expected notice"),
        }
    }
}
