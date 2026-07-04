//! Mock driver for dev/e2e: directly implements PilotDriver with fixture data.
//! Port of `server/src/mock-driver.ts` + `server/src/fixtures.ts`.
//!
//! The mock emits SessionDriverEvent[] directly (no daemon, no wire protocol).
//! This is what the e2e suite tests against.

#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use pilot_protocol::session_driver::*;
use pilot_protocol::wire::DeliveryMode;
use tokio::sync::mpsc;
use tracing::warn;

use async_trait::async_trait;
use crate::driver::{NewSessionOptsData, PilotDriver};

// ── Fixture constants (ported from fixtures.ts) ─────────────────────────

const GREETING_PROMPT: &str = "Add a /health route to the server and a smoke test for it.";
const WORKSPACE_ID: &str = "ws-demo";
const WORKSPACE_PATH: &str = "/Users/timo/src/pilot";
const SESSION_ID: &str = "demo-session";

/// Monotonic mock clock — each call to `ts()` bumps by TS_STEP_MS and returns
/// a zero-padded 10-digit string, matching the TS fixture's `ts()` exactly.
const TS_STEP_MS: u64 = 5;
static MOCK_TS: AtomicU64 = AtomicU64::new(0);

fn ts() -> String {
    let v = MOCK_TS.fetch_add(TS_STEP_MS, Ordering::Relaxed) + TS_STEP_MS;
    format!("{:0>10}", v)
}

/// Bump the mock clock by `ms` WITHOUT emitting an event — used between a tool's
/// start and finish so the derived duration badge reads realistically.
fn advance_ts(ms: u64) {
    MOCK_TS.fetch_add(ms, Ordering::Relaxed);
}

/// Reset the mock clock to zero (called on `reset()`).
fn reset_ts() {
    MOCK_TS.store(0, Ordering::Relaxed);
}

fn mock_session_ref() -> SessionRef {
    SessionRef {
        workspace_id: WORKSPACE_ID.into(),
        session_id: SESSION_ID.into(),
    }
}

fn mock_workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_id: WORKSPACE_ID.into(),
        path: WORKSPACE_PATH.into(),
        display_name: Some("pilot".into()),
    }
}

fn mock_models() -> Vec<ModelOption> {
    vec![
        ModelOption { provider: "anthropic".into(), model_id: "claude-opus-4-8".into(), label: "Claude Opus 4.8".into(), thinking_levels: Some(vec!["off".into(),"low".into(),"medium".into(),"high".into()]) },
        ModelOption { provider: "anthropic".into(), model_id: "claude-sonnet-4-6".into(), label: "Claude Sonnet 4.6".into(), thinking_levels: Some(vec!["off".into(),"low".into(),"medium".into(),"high".into()]) },
        ModelOption { provider: "deepseek".into(), model_id: "deepseek-v4-flash".into(), label: "DeepSeek V4 Flash".into(), thinking_levels: Some(vec!["off".into()]) },
        ModelOption { provider: "openai".into(), model_id: "gpt-5".into(), label: "GPT-5".into(), thinking_levels: Some(vec!["minimal".into(),"low".into(),"medium".into(),"high".into()]) },
    ]
}

fn mock_commands() -> Vec<CommandInfo> {
    vec![
        CommandInfo { name: "review".into(), description: Some("Review the working-copy diff for bugs".into()), source: CommandSource::Prompt, argument_hint: Some("[path]".into()) },
        CommandInfo { name: "plan".into(), description: Some("Draft an implementation plan before coding".into()), source: CommandSource::Prompt, argument_hint: None },
        CommandInfo { name: "commit".into(), description: Some("Stage changes and commit with a generated message".into()), source: CommandSource::Extension, argument_hint: None },
        CommandInfo { name: "pr".into(), description: Some("Open a pull request for the current branch".into()), source: CommandSource::Extension, argument_hint: None },
        CommandInfo { name: "skill:debug".into(), description: Some("Trace a bug end-to-end before forming a hypothesis".into()), source: CommandSource::Skill, argument_hint: None },
        CommandInfo { name: "skill:polish".into(), description: Some("Analyze a codebase for improvements".into()), source: CommandSource::Skill, argument_hint: None },
    ]
}

fn mock_files() -> Vec<FileInfo> {
    vec![
        FileInfo { path: "README.md".into(), is_directory: false },
        FileInfo { path: "AGENTS.md".into(), is_directory: false },
        FileInfo { path: "docs".into(), is_directory: true },
        FileInfo { path: "docs/DESIGN.md".into(), is_directory: false },
        FileInfo { path: "docs/DECISIONS.md".into(), is_directory: false },
        FileInfo { path: "docs/TODO.md".into(), is_directory: false },
        FileInfo { path: "docs/ADR-desktop-shell.md".into(), is_directory: false },
        FileInfo { path: "server".into(), is_directory: true },
        FileInfo { path: "server/src/index.ts".into(), is_directory: false },
        FileInfo { path: "server/src/hub.ts".into(), is_directory: false },
        FileInfo { path: "server/src/driver.ts".into(), is_directory: false },
        FileInfo { path: "server/src/mock-driver.ts".into(), is_directory: false },
        FileInfo { path: "server/src/fixtures.ts".into(), is_directory: false },
        FileInfo { path: "client".into(), is_directory: true },
        FileInfo { path: "client/src/app.css".into(), is_directory: false },
        FileInfo { path: "protocol".into(), is_directory: true },
        FileInfo { path: "package.json".into(), is_directory: false },
    ]
}

fn mock_usage() -> SessionUsage {
    SessionUsage { tokens: Some(47200), context_window: 200000, percent: Some(23.6) }
}

fn mock_usage_full() -> SessionUsage {
    SessionUsage { tokens: Some(182000), context_window: 200000, percent: Some(91.0) }
}

fn session_ref_for(session_id: &str) -> SessionRef {
    SessionRef { workspace_id: WORKSPACE_ID.into(), session_id: session_id.into() }
}

/// Build a snapshot with optional overrides, matching the TS `snapshot(over)` pattern.
fn snap(
    status: SessionStatus,
    facet: Option<String>,
    goal: Option<Option<GoalInfo>>,
    active_plan: Option<String>,
    flags: Option<Vec<FlaggedFile>>,
    todos: Option<Vec<TodoItem>>,
) -> SessionSnapshot {
    SessionSnapshot {
        r#ref: mock_session_ref(),
        workspace: mock_workspace(),
        title: "Wire up the WebSocket bridge".into(),
        status,
        updated_at: ts(),
        archived_at: None,
        preview: None,
        config: Some(mock_default_config()),
        usage: Some(mock_usage()),
        running_run_id: None,
        queued_messages: None,
        facet,
        permission_monitor: Some(PermissionMonitorMode::Standard),
        adventurous_handoff: Some(false),
        notification_autodrain: Some(false),
        active_plan,
        goal,
        flags,
        todos,
        mcp_servers: Some(mock_mcp_servers()),
    }
}

fn mock_snapshot(status: SessionStatus) -> SessionSnapshot {
    snap(status, None, None, None, None, None)
}

fn mock_mcp_servers() -> Vec<McpServerInfo> {
    vec![
        McpServerInfo { server_name: "filesystem".into(), status: McpServerStatus::Connected, tool_count: 11 },
        McpServerInfo { server_name: "github".into(), status: McpServerStatus::Disconnected, tool_count: 0 },
    ]
}

fn mock_default_config() -> SessionConfig {
    SessionConfig {
        provider: Some("anthropic".into()),
        model_id: Some("claude-opus-4-8".into()),
        thinking_level: Some("medium".into()),
        available_thinking_levels: Some(vec!["off".into(),"low".into(),"medium".into(),"high".into()]),
    }
}

// mock_snapshot is defined above ( delegates to snap() with no overrides).

fn mock_session_list() -> Vec<SessionListEntry> {
    vec![
        SessionListEntry {
            session_id: "demo-session".into(), path: "/sessions/demo-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(), display_name: Some("Wire up the WebSocket bridge".into()),
            preview: "Add a /health route to the server and a smoke test for it.".into(),
            user_message_count: 3, usage: Some(mock_usage()),
            updated_at: "2025-01-01T00:05:00Z".into(), created_at: "2024-12-30T00:00:00Z".into(),
            last_user_message_at: "2025-01-01T00:04:00Z".into(),
            parent_session_path: None, archived: false, worktree: None,
        },
        SessionListEntry {
            session_id: "older-session".into(), path: "/sessions/older-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(), display_name: Some("Explore the fold reducer".into()),
            preview: "How does foldEvent assemble the transcript?".into(),
            user_message_count: 5, usage: Some(SessionUsage { tokens: Some(164000), context_window: 200000, percent: Some(82.0) }),
            updated_at: "2024-12-31T22:00:00Z".into(), created_at: "2024-12-29T00:00:00Z".into(),
            last_user_message_at: "2024-12-31T21:59:00Z".into(),
            parent_session_path: None, archived: false, worktree: None,
        },
        SessionListEntry {
            session_id: "scratch-session".into(), path: "/sessions/scratch-session.jsonl".into(),
            cwd: "/Users/timo/src/scratch".into(), display_name: None,
            preview: "quick scratch session".into(),
            user_message_count: 1, usage: None,
            updated_at: "2024-12-31T18:00:00Z".into(), created_at: "2024-12-28T00:00:00Z".into(),
            last_user_message_at: "2024-12-31T17:59:00Z".into(),
            parent_session_path: None, archived: false, worktree: None,
        },
        SessionListEntry {
            session_id: "archived-session".into(), path: "/sessions/archived-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(), display_name: Some("Archived experiment".into()),
            preview: "An old experiment I tucked away.".into(),
            user_message_count: 4, usage: None,
            updated_at: "2024-12-31T23:00:00Z".into(), created_at: "2024-12-27T00:00:00Z".into(),
            last_user_message_at: "2024-12-31T22:59:00Z".into(),
            parent_session_path: None, archived: true, worktree: None,
        },
        SessionListEntry {
            session_id: "stale-session".into(), path: "/sessions/stale-session.jsonl".into(),
            cwd: "/Users/timo/src/stale-proj".into(), display_name: Some("Old spike".into()),
            preview: "A spike from a couple of weeks ago.".into(),
            user_message_count: 2, usage: None,
            updated_at: "2024-06-24T00:00:00Z".into(), created_at: "2024-06-22T00:00:00Z".into(),
            last_user_message_at: "2024-06-24T00:00:00Z".into(),
            parent_session_path: None, archived: false, worktree: None,
        },
    ]
}

// ── Script steps + event builders ──────────────────────────────────────

fn base() -> SessionEventBase {
    SessionEventBase {
        session_ref: mock_session_ref(),
        timestamp: ts(),
        run_id: None,
    }
}

/// Build the greeting fixture: sessionOpened + userMessage + assistant deltas + tool spans + runCompleted.
/// This is the seed every fresh client sees.
fn greeting_seed() -> Vec<SessionDriverEvent> {
    let mut events = vec![
        SessionDriverEvent::SessionOpened { base: base(), snapshot: mock_snapshot(SessionStatus::Idle) },
        SessionDriverEvent::UserMessage { base: base(), id: "u1".into(), text: GREETING_PROMPT.into(), entry_id: Some("e-u1".into()), images: None },
    ];

    // Simulate ~37s of working wall-clock between the prompt and the settled reply,
    // so the collapsed "Worked for Ns" header reads realistically on first load.
    advance_ts(36_600);

    // Assistant deltas (text channel, chunked)
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in deltas(text, 3) {
        events.push(SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None });
    }

    // Tool span: bash (rg) — bump the clock by durationMs between start and finish.
    events.push(SessionDriverEvent::ToolStarted {
        base: base(), call_id: "t1".into(), tool_name: "bash".into(),
        label: Some("Run shell command".into()),
        description: Some("Execute a command in the workspace shell".into()),
        input: Some(serde_json::json!({"command": "rg -n \"app.get\\(\" server/src"})),
    });
    advance_ts(340);
    events.push(SessionDriverEvent::ToolFinished {
        base: base(), call_id: "t1".into(), success: true,
        output: Some(serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)")),
        images: None,
    });

    // More assistant deltas
    let text2 = "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.";
    for chunk in deltas(text2, 3) {
        events.push(SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None });
    }

    // Run completed
    events.push(SessionDriverEvent::RunCompleted {
        base: base(),
        snapshot: mock_snapshot(SessionStatus::Idle),
        user_entry_id: Some("e-u1".into()),
        assistant_entry_id: Some("e-a1".into()),
    });

    events
}

/// Split text into streaming deltas of ~n words, preserving whitespace.
/// Matches the TS `deltas()` which splits on `/(\s+)/` (capturing) so the
/// fold's raw concatenation reproduces the original text exactly.
fn deltas(text: &str, chunk: usize) -> Vec<String> {
    let parts: Vec<&str> = text.split_inclusive(|c: char| c.is_whitespace()).collect();
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut n = 0;
    for w in &parts {
        buf.push_str(w);
        // Count word groups (non-whitespace runs) to decide when to flush.
        if w.trim().is_empty() {
            continue;
        }
        n += 1;
        if n % chunk == 0 {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

/// Script step for delayed playback.
struct ScriptStep {
    wait_ms: u64,
    event: SessionDriverEvent,
}

/// A matched toolStarted → toolFinished pair with a deterministic duration.
/// Bumps the clock by `duration_ms` between stamping the two events so the
/// card's elapsed badge reads realistically.
fn tool_span(
    call_id: &str,
    tool_name: &str,
    label: &str,
    description: Option<&str>,
    input: serde_json::Value,
    success: bool,
    output: serde_json::Value,
    start_wait: u64,
    wait_ms: u64,
    duration_ms: u64,
) -> Vec<ScriptStep> {
    let mut steps = vec![ScriptStep {
        wait_ms: start_wait,
        event: SessionDriverEvent::ToolStarted {
            base: base(),
            call_id: call_id.into(),
            tool_name: tool_name.into(),
            label: Some(label.into()),
            description: description.map(|d| d.into()),
            input: Some(input),
        },
    }];
    advance_ts(duration_ms);
    steps.push(ScriptStep {
        wait_ms,
        event: SessionDriverEvent::ToolFinished {
            base: base(),
            call_id: call_id.into(),
            success,
            output: Some(output),
            images: None,
        },
    });
    steps
}

/// Build the greeting script (with delays for streaming).
fn greeting_script() -> Vec<ScriptStep> {
    let mut steps = vec![
        ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionOpened { base: base(), snapshot: mock_snapshot(SessionStatus::Idle) } },
        ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "u1".into(), text: GREETING_PROMPT.into(), entry_id: Some("e-u1".into()), images: None } },
    ];

    advance_ts(36_600);

    // Assistant deltas with delays
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in deltas(text, 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    // Tool span
    steps.push(ScriptStep { wait_ms: 120, event: SessionDriverEvent::ToolStarted {
        base: base(), call_id: "t1".into(), tool_name: "bash".into(),
        label: Some("Run shell command".into()),
        description: Some("Execute a command in the workspace shell".into()),
        input: Some(serde_json::json!({"command": "rg -n \"app.get\\(\" server/src"})),
    }});
    advance_ts(340);
    steps.push(ScriptStep { wait_ms: 220, event: SessionDriverEvent::ToolFinished {
        base: base(), call_id: "t1".into(), success: true,
        output: Some(serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)")),
        images: None,
    }});

    // More deltas
    let text2 = "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.";
    for chunk in deltas(text2, 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    // Run completed
    steps.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted {
        base: base(),
        snapshot: mock_snapshot(SessionStatus::Idle),
        user_entry_id: Some("e-u1".into()),
        assistant_entry_id: Some("e-a1".into()),
    }});

    steps
}

/// Build a prompt reply script.
fn prompt_reply_script(text: &str, _prompt_id: Option<&str>) -> Vec<ScriptStep> {
    let mut steps = vec![
        ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "u2".into(), text: text.into(), entry_id: None, images: None } },
    ];

    // A short reply with a tool span
    for chunk in deltas("Looking into this now.", 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    steps.push(ScriptStep { wait_ms: 100, event: SessionDriverEvent::ToolStarted {
        base: base(), call_id: "t2".into(), tool_name: "bash".into(),
        label: Some("Run shell command".into()),
        description: Some("Execute a command in the workspace shell".into()),
        input: Some(serde_json::json!({"command": "cat src/index.ts"})),
    }});
    advance_ts(280);
    steps.push(ScriptStep { wait_ms: 200, event: SessionDriverEvent::ToolFinished {
        base: base(), call_id: "t2".into(), success: true,
        output: Some(serde_json::json!("// file contents here")),
        images: None,
    }});

    for chunk in deltas("Done! The change is ready.", 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    steps.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted {
        base: base(),
        snapshot: mock_snapshot(SessionStatus::Idle),
        user_entry_id: None,
        assistant_entry_id: None,
    }});

    steps
}

// ── MockDriver ─────────────────────────────────────────────────────────

pub struct MockDriver {
    listeners: Arc<Mutex<Vec<(usize, mpsc::Sender<SessionDriverEvent>)>>>,
    next_id: Mutex<usize>,
}

impl MockDriver {
    pub fn new() -> Self {
        Self {
            listeners: Arc::new(Mutex::new(Vec::new())),
            next_id: Mutex::new(0),
        }
    }

    fn emit(&self, ev: SessionDriverEvent) {
        let listeners = self.listeners.lock();
        for (_, tx) in listeners.iter() {
            let _ = tx.try_send(ev.clone());
        }
    }

    fn play_script(&self, steps: Vec<ScriptStep>) {
        let listeners = self.listeners.clone();
        tokio::spawn(async move {
            for step in steps {
                if step.wait_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(step.wait_ms)).await;
                }
                let listeners = listeners.lock();
                for (_, tx) in listeners.iter() {
                    let _ = tx.try_send(step.event.clone());
                }
            }
        });
    }
}

impl Default for MockDriver {
    fn default() -> Self { Self::new() }
}

#[async_trait]
impl PilotDriver for MockDriver {
    fn subscribe(&self, listener: Box<dyn Fn(SessionDriverEvent) + Send + Sync>) -> usize {
        let id = {
            let mut next = self.next_id.lock();
            let id = *next;
            *next += 1;
            id
        };
        let (tx, mut rx) = mpsc::channel(256);
        self.listeners.lock().push((id, tx));
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await { listener(ev); }
        });
        id
    }

    fn unsubscribe(&self, id: usize) {
        self.listeners.lock().retain(|(sid, _)| *sid != id);
    }

    async fn prompt(&self, text: String, _deliver_as: Option<DeliveryMode>, _session_id: Option<SessionId>, _images: Vec<ImageContent>, _prompt_id: Option<String>) {
        let steps = prompt_reply_script(&text, _prompt_id.as_deref());
        self.play_script(steps);
    }

    fn abort(&self, _session_id: Option<SessionId>) {
        // Clear pending scheduled events + settle open tools + emit runCompleted.
        // The TS mock tracks openTools and scheduled timers; our simplified version
        // just emits a runCompleted to settle the turn.
        let b = base();
        self.emit(SessionDriverEvent::RunCompleted {
            base: b,
            snapshot: mock_snapshot(SessionStatus::Idle),
            user_entry_id: None,
            assistant_entry_id: None,
        });
    }
    fn respond_ui(&self, response: HostUiResponse, _session_id: Option<SessionId>) {
        let request_id = match &response {
            HostUiResponse::Value { request_id, .. } => request_id.clone(),
            HostUiResponse::Confirmed { request_id, .. } => request_id.clone(),
            HostUiResponse::Answers { request_id, .. } => request_id.clone(),
            HostUiResponse::Cancelled { request_id, .. } => request_id.clone(),
        };
        // Emit HostUiResolved to clear the dialog.
        self.emit(SessionDriverEvent::HostUiResolved {
            base: base(),
            request_id: request_id.clone(),
        });

        match &response {
            HostUiResponse::Answers { answers, .. } => {
                // Q&A: emit a toolStarted/toolFinished pair with the answer text,
                // mirroring the real driver where the `answer` tool records the result.
                let call_id = format!("answer-{request_id}");
                self.emit(SessionDriverEvent::ToolStarted {
                    base: base(),
                    call_id: call_id.clone(),
                    tool_name: "answer".into(),
                    label: Some("Answer".into()),
                    description: None,
                    input: Some(serde_json::json!({"questions": []})),
                });
                self.emit(SessionDriverEvent::ToolFinished {
                    base: base(),
                    call_id,
                    success: true,
                    output: Some(serde_json::json!({
                        "content": [{"type": "text", "text": format!("Q&A answered ({} answers)", answers.len())}]
                    })),
                    images: None,
                });
            }
            _ => {
                // Confirm/input/cancelled: emit a notify with the summary message.
                let summary = match &response {
                    HostUiResponse::Cancelled { .. } => "Dialog cancelled.".to_string(),
                    HostUiResponse::Confirmed { confirmed, .. } => {
                        if *confirmed {
                            "Approved — continuing.".to_string()
                        } else {
                            "Denied — skipping that step.".to_string()
                        }
                    }
                    HostUiResponse::Value { value, .. } => format!("Received: {value}"),
                    HostUiResponse::Answers { .. } => unreachable!(),
                };
                self.emit(SessionDriverEvent::HostUiRequest {
                    base: base(),
                    request: HostUiRequest::Notify {
                        request_id: format!("resolved-{request_id}"),
                        message: summary,
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
        }
    }

    async fn list_sessions(&self) -> Vec<SessionListEntry> { mock_session_list() }

    async fn open_session(&self, _path: String) -> Vec<SessionDriverEvent> { greeting_seed() }
    async fn new_session(&self, _opts: NewSessionOptsData) -> Vec<SessionDriverEvent> { greeting_seed() }
    async fn list_models(&self) -> Vec<ModelOption> { mock_models() }
    async fn list_commands(&self, _session_id: Option<SessionId>) -> Vec<CommandInfo> { mock_commands() }
    async fn list_facets(&self, _session_id: Option<SessionId>) -> Vec<String> { vec!["execute".into(), "plan".into(), "research".into()] }
    async fn list_file_index(&self, _session_id: Option<SessionId>) -> (Vec<FileInfo>, bool) { (mock_files(), false) }
    async fn list_files(&self, query: String, _session_id: Option<SessionId>, _cwd: Option<String>) -> Vec<FileInfo> {
        let q = query.to_lowercase();
        mock_files().into_iter().filter(|f| f.path.to_lowercase().contains(&q)).take(20).collect()
    }
    async fn list_dir(&self, _path: Option<String>) -> DirListing {
        DirListing { path: WORKSPACE_PATH.into(), parent: None, entries: vec!["server".into(), "client".into(), "protocol".into()], error: None }
    }
    async fn stat_path(&self, path: String) -> PathStat {
        let p = std::path::Path::new(&path);
        PathStat { exists: p.exists(), is_dir: p.is_dir(), path }
    }

    fn set_model(&self, provider: String, model_id: String, _session_id: Option<SessionId>) {
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot: snap(SessionStatus::Idle, None, None, None, None, None),
        });
    }
    fn set_thinking(&self, _level: String, _session_id: Option<SessionId>) {}
    fn set_facet(&self, facet: String, _session_id: Option<SessionId>) {
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot: snap(SessionStatus::Idle, Some(facet), None, None, None, None),
        });
    }
    fn set_permission_monitor(&self, mode: PermissionMonitorMode, _session_id: Option<SessionId>) {
        let mut s = snap(SessionStatus::Idle, None, None, None, None, None);
        s.permission_monitor = Some(mode);
        self.emit(SessionDriverEvent::SessionUpdated { base: base(), snapshot: s });
    }

    fn default_seed(&self) -> Option<Vec<SessionDriverEvent>> { Some(greeting_seed()) }

    fn run_script(&self, name: String) {
        let steps: Vec<ScriptStep> = match name.as_str() {
            // ── Approval dialogs ────────────────────────────────────────────
            "confirm" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Confirm {
                    request_id: "req-confirm-1".into(),
                    title: "Run destructive command?".into(),
                    message: "The agent wants to run `git reset --hard origin/main`. This discards all local changes. Allow?".into(),
                    default_value: Some(false),
                    timeout_ms: Some(60000),
                } } },
            ],
            "goal" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Confirm {
                    request_id: "req-goal-1".into(),
                    title: "Ship feature X".into(),
                    message: "Implement the new dashboard widget".into(),
                    default_value: None,
                    timeout_ms: None,
                } } },
            ],
            "unknown" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Confirm {
                    request_id: "req-unknown-1".into(),
                    title: "⚠ Unknown request type: some_future_type".into(),
                    message: "The agent sent a request type this version of pilot doesn't recognize. Dismiss to cancel it and unblock the session.".into(),
                    default_value: None,
                    timeout_ms: None,
                } } },
            ],
            "input" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Input {
                    request_id: "req-input-1".into(),
                    title: "Commit message".into(),
                    placeholder: Some("Describe the change…".into()),
                    initial_value: Some("Add /health route".into()),
                    timeout_ms: None,
                } } },
            ],
            "qna" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Qna {
                    request_id: "req-qna-1".into(),
                    title: Some("A few questions before I proceed".into()),
                    questions: vec![
                        QnaQuestion {
                            question: "Which package manager should I use?".into(),
                            context: Some("The repo has both a bun.lock and a package-lock.json.".into()),
                            multi_select: None,
                            options: Some(vec![
                                QnaQuestionOption { label: "bun".into(), description: Some("Matches bun.lock (recommended)".into()) },
                                QnaQuestionOption { label: "npm".into(), description: Some("Matches package-lock.json".into()) },
                                QnaQuestionOption { label: "pnpm".into(), description: None },
                            ]),
                        },
                        QnaQuestion {
                            question: "Which checks should run before each commit?".into(),
                            context: None,
                            multi_select: Some(true),
                            options: Some(vec![
                                QnaQuestionOption { label: "Typecheck".into(), description: None },
                                QnaQuestionOption { label: "Unit tests".into(), description: None },
                                QnaQuestionOption { label: "Lint".into(), description: None },
                                QnaQuestionOption { label: "e2e".into(), description: None },
                            ]),
                        },
                        QnaQuestion {
                            question: "Anything else I should know before starting?".into(),
                            context: None,
                            multi_select: None,
                            options: None,
                        },
                    ],
                    timeout_ms: None,
                } } },
            ],
            "timeout" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Confirm {
                    request_id: "req-timeout-1".into(),
                    title: "Auto-resolving confirm".into(),
                    message: "This dialog auto-dismisses (deny-safe) if you don't respond.".into(),
                    default_value: Some(false),
                    timeout_ms: Some(3000),
                } } },
            ],
            "yesno" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Select {
                    request_id: "req-yesno-1".into(),
                    title: "Apply the suggested fix?".into(),
                    options: vec!["Don't allow".into(), "Allow".into()],
                    allow_multiple: None,
                    timeout_ms: None,
                } } },
            ],
            // ── Ambient (fire-and-forget) UI ────────────────────────────────
            "ambient" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Status {
                    request_id: "s1".into(),
                    key: "branch".into(),
                    text: Some("on main · 2 files changed".into()),
                } } },
                ScriptStep { wait_ms: 80, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Widget {
                    request_id: "w1".into(),
                    key: "tasklist".into(),
                    lines: Some(vec![
                        "Open Tasks (3):".into(),
                        "  ○ wire up /health route".into(),
                        "  ○ add a smoke test".into(),
                        "  ○ document the deploy step".into(),
                    ]),
                    placement: Some(WidgetPlacement::AboveComposer),
                } } },
                ScriptStep { wait_ms: 80, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Notify {
                    request_id: "n1".into(),
                    message: "Background indexing finished".into(),
                    level: Some(NotifyLevel::Info),
                } } },
            ],
            "context" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, None, None, None,
                    Some(vec![
                        FlaggedFile { path: "src/app.ts".into(), mode: FlaggedFileMode::Included },
                        FlaggedFile { path: "src/lib/store.svelte.ts".into(), mode: FlaggedFileMode::Included },
                        FlaggedFile { path: "README.md".into(), mode: FlaggedFileMode::Referenced },
                    ]),
                    Some(vec![
                        TodoItem { id: 1, title: "Wire up the right sidebar".into(), description: "Add protocol types, event-map threading, and the drawer component".into(), status: TodoStatus::InProgress, dependencies: vec![] },
                        TodoItem { id: 2, title: "Add e2e tests".into(), description: "Assert flagged files + todos render, toggle opens/closes".into(), status: TodoStatus::Pending, dependencies: vec![1] },
                        TodoItem { id: 3, title: "Review with subagent".into(), description: "Check type safety, overwrite-guard consistency, tooltips".into(), status: TodoStatus::Pending, dependencies: vec![2] },
                    ]),
                ) } },
            ],
            // ── Session state scripts ─────────────────────────────────────
            "goalactive" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, None, Some(Some(GoalInfo { summary: "Ship the goal badge feature".into(), lifecycle: "active".into() })), None, None, None,
                ) } },
            ],
            "goalclear" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, None, Some(None), None, None, None,
                ) } },
            ],
            "planview" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(
                    SessionStatus::Idle, Some("plan".into()), None,
                    Some("# Plan: Wire up the plan overlay\n\n## Steps\n1. Add `activePlan` to the SessionSnapshot protocol\n2. Thread `active_plan` through the event-map\n3. Build the PlanView modal + StatusHeader button\n\n## Notes\n- The overlay is read-only — no editing from inside it\n- Renders via Markdown.svelte (same as the plan-handoff card)\n".into()),
                    None, None,
                ) } },
            ],
            "initializing" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionOpened { base: base(), snapshot: snap(SessionStatus::Initializing, None, None, None, None, None) } },
                ScriptStep { wait_ms: 1200, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(SessionStatus::Idle, None, None, None, None, None) } },
            ],
            "staleidle" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-stale-{}", ts()), text: "Run the long thing — but glitch the status mid-turn.".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("On it — kicking off a command that takes a while.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 40, event: SessionDriverEvent::ToolStarted {
                    base: base(), call_id: "stale-tool-1".into(), tool_name: "bash".into(),
                    label: Some("Run shell command".into()),
                    description: Some("Execute a command in the workspace shell".into()),
                    input: Some(serde_json::json!({"command": "sleep 30 && echo done"})),
                } });
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Idle) } });
                s
            }
            // ── Turn scripts ───────────────────────────────────────────────
            "pendinghold" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-pending-{}", ts()), text: "Refactor the auth middleware".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me look at how auth is wired before I touch it.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                s
            }
            "idle" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-idle-{}", ts()), text: "End this turn without a runCompleted, please.".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Done — this turn ends with a status update, not a runCompleted event.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 80, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Idle) } });
                s
            }
            "error" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Attempting the network call now.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 120, event: SessionDriverEvent::RunFailed { base: base(), error: SessionErrorInfo { message: "Provider request failed: 529 overloaded (will not auto-retry)".into(), code: None, details: None } } });
                s
            }
            "reply" => prompt_reply_script("Show me the streamed reply script.", None),
            // ── Background session scripts ────────────────────────────────
            "bgrun" => {
                let ref_id = session_ref_for("older-session");
                let snap_bg = |status: SessionStatus| SessionSnapshot {
                    r#ref: ref_id.clone(),
                    workspace: mock_workspace(),
                    title: "Explore the fold reducer".into(),
                    status,
                    updated_at: ts(),
                    archived_at: None, preview: None, config: None, usage: None,
                    running_run_id: None, queued_messages: None, facet: None,
                    permission_monitor: None, adventurous_handoff: None,
                    notification_autodrain: None, active_plan: None, goal: None,
                    flags: None, todos: None, mcp_servers: None,
                };
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None }, snapshot: snap_bg(SessionStatus::Running) } },
                    ScriptStep { wait_ms: 300, event: SessionDriverEvent::AssistantDelta { base: SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None }, text: "(background turn)".into(), channel: Some(AssistantDeltaChannel::Text), entry_id: None } },
                    ScriptStep { wait_ms: 1500, event: SessionDriverEvent::RunCompleted { base: SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None }, snapshot: snap_bg(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } },
                ]
            }
            "bgwait" => {
                let ref_id = session_ref_for("older-session");
                let snap_bg = SessionSnapshot {
                    r#ref: ref_id.clone(),
                    workspace: mock_workspace(),
                    title: "Explore the fold reducer".into(),
                    status: SessionStatus::Running,
                    updated_at: ts(),
                    archived_at: None, preview: None, config: None, usage: None,
                    running_run_id: None, queued_messages: None, facet: None,
                    permission_monitor: None, adventurous_handoff: None,
                    notification_autodrain: None, active_plan: None, goal: None,
                    flags: None, todos: None, mcp_servers: None,
                };
                let b = || SessionEventBase { session_ref: ref_id.clone(), timestamp: ts(), run_id: None };
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: b(), snapshot: snap_bg } },
                    ScriptStep { wait_ms: 80, event: SessionDriverEvent::ToolStarted {
                        base: b(), call_id: "bg-read".into(), tool_name: "read".into(),
                        label: Some("Read file".into()), description: None,
                        input: Some(serde_json::json!({"path": "docs/TODO.md"})),
                    } },
                    ScriptStep { wait_ms: 120, event: SessionDriverEvent::HostUiRequest { base: b(), request: HostUiRequest::Confirm {
                        request_id: "bg-approval".into(),
                        title: "Review background change".into(),
                        message: "Apply the queued background edit?".into(),
                        default_value: None, timeout_ms: None,
                    } } },
                ]
            }
            // ── Edit diff ──────────────────────────────────────────────────
            "editdiff" => tool_span(
                "edit-1", "edit", "Edit file", Some("Apply edits to a file in the workspace"),
                serde_json::json!({
                    "path": "server/src/health.ts",
                    "edits": [{
                        "oldText": "export function health() {\n  return new Response(\"ok\");\n}",
                        "newText": "export function health() {\n  return Response.json({ status: \"ok\", uptime: process.uptime() });\n}",
                    }]
                }),
                true,
                serde_json::json!("Successfully replaced 1 block(s) in server/src/health.ts"),
                0, 200, 480,
            ),
            // ── Compat ─────────────────────────────────────────────────────
            "compat" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::ExtensionCompatibilityIssue { base: base(), issue: ExtensionCompatibilityIssue {
                    capability: "custom".into(),
                    classification: ExtensionIssueClassification::TerminalOnly,
                    message: "Custom UI is not available in the pilot remote; run the agent in a terminal for this workflow.".into(),
                    extension_path: Some("~/.pi/agent/extensions/fancy-tui.ts".into()),
                    event_name: Some("session_start".into()),
                } } },
            ],
            // ── Journal nudge ──────────────────────────────────────────────
            "journalnudge" => {
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "u-jn-1".into(), text: "Rename the helper and update its callers.".into(), images: None, entry_id: None } },
                ];
                advance_ts(12_000);
                for chunk in deltas("I'll rename it and fix the call sites. Let me find them first.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("jn-t1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "rg -n \"oldHelper\" src"}),
                    true,
                    serde_json::json!("src/a.ts:4:  oldHelper()\nsrc/b.ts:9:  oldHelper()"),
                    100, 200, 380));
                for chunk in deltas("Done — renamed `oldHelper` to `resolveHelper` and updated both call sites in `a.ts` and `b.ts`.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                advance_ts(400);
                s.push(ScriptStep { wait_ms: 120, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } });
                s.push(ScriptStep { wait_ms: 0, event: SessionDriverEvent::CustomMessage { base: base(), id: "inject-jn-1".into(), custom_type: "journal-nudge".into(), text: "<journal-nudge>this turn did work and didn't journal. if a fork or correction formed that's generally applicable AND isn't already in your skills/AGENTS.md, call the journal skill now.</journal-nudge>".into(), display: true } });
                advance_ts(2_000);
                s.extend(tool_span("jn-t2", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "./skills/journal/scripts/journal observation \"prefer X over Y\""}),
                    true,
                    serde_json::json!("journal entry staged"),
                    120, 220, 520));
                for chunk in deltas("Journaled a note about the helper-naming convention.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            // ── Skill load ────────────────────────────────────────────────
            "skill" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Something's off with the fold reducer — can you dig in?".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("This calls for the debug skill — let me load it, then trace the reducer.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("sk1", "read", "read", None, serde_json::json!({"path": ".pi/skills/debug/SKILL.md"}), true, serde_json::json!("# debug\nTrace the code path end-to-end before forming a hypothesis…"), 40, 90, 180));
                s.extend(tool_span("sk2", "read", "read", None, serde_json::json!({"path": "protocol/src/state.ts"}), true, serde_json::json!("// foldEvent — mutates state, returns it"), 40, 90, 180));
                s.extend(tool_span("sk3", "bash", "bash", None, serde_json::json!({"command": "bun test protocol/src/state.test.ts"}), true, serde_json::json!("✓ 12 pass\n0 fail"), 40, 90, 180));
                for chunk in deltas("The reducer is fine; the stray caret came from a missed assistant close. Fixing that.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            // ── Answer card ────────────────────────────────────────────────
            "answercard" => {
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "ac-u1".into(), text: "Strip the unused dep and regenerate the lockfile.".into(), images: None, entry_id: Some("e-ac-u1".into()) } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me check what's currently declared first.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("ac-t1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "rg -n \"unused-pkg\" server/package.json"}),
                    true, serde_json::json!("\"unused-pkg\": \"^1.2.3\""), 120, 220, 900));
                s.extend(tool_span("ac-t2", "answer", "Ask the operator", Some("Ask one or more multiple-choice questions"),
                    serde_json::json!({"questions": [{"question": "How do you want to proceed with removing the unused-pkg dependency?"}]}),
                    true,
                    serde_json::json!("Q: How do you want to proceed with removing the unused-pkg dependency?\n> The dep is declared in server/package.json and pulled transitively elsewhere; removing it needs the manifest edit + a lockfile regenerate.\nA: Drop the line from server/package.json, then run bun install to regenerate the lockfile, then run the full gate and commit"),
                    120, 220, 0));
                for chunk in deltas("Removed the line from server/package.json. Regenerating the lockfile.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("ac-t3", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun install 2>&1 | tail -4"}),
                    true, serde_json::json!("lockfile regenerated, no transitive holdouts ✓"), 120, 220, 830));
                for chunk in deltas("Done — dep dropped, lockfile regenerated, the gate is green.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: Some("e-ac-u1".into()), assistant_entry_id: Some("e-ac-a1".into()) } });
                s
            }
            // ── Answer lead-up card ────────────────────────────────────────
            "answerleadup" => {
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: "alu-u1".into(), text: "Ship the dep removal. Anything I should decide before you commit?".into(), images: None, entry_id: Some("e-alu-u1".into()) } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me check what's currently declared first.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("alu-t1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "rg -n \"unused-pkg\" server/package.json"}),
                    true, serde_json::json!("\"unused-pkg\": \"^1.2.3\""), 120, 220, 900));
                for chunk in deltas("The removal is straightforward, but there's one call to make: the dep is also pulled transitively by a dev-only package, so I can either drop the manifest line and let the transitive copy resolve on its own, or pin an explicit override so the transitive copy disappears too. Dropping is faster but leaves the transitive copy; pinning is cleaner but needs a bunfig override. How do you want to proceed?", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("alu-t2", "answer", "Ask the operator", Some("Ask one or more multiple-choice questions"),
                    serde_json::json!({"questions": [{"question": "How do you want to handle the transitive copy of unused-pkg?", "options": [{"label": "Drop the manifest line only"}, {"label": "Drop + pin a bunfig override"}]}]}),
                    true,
                    serde_json::json!("Q: How do you want to handle the transitive copy of unused-pkg?\nOptions:\n  [x] Drop the manifest line only\n  [ ] Drop + pin a bunfig override\nA: Drop the manifest line only"),
                    120, 220, 0));
                for chunk in deltas("Dropping the manifest line and regenerating now.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("alu-t3", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun install 2>&1 | tail -4"}),
                    true, serde_json::json!("lockfile regenerated, transitive copy resolves ✓"), 120, 220, 830));
                for chunk in deltas("Done — dep dropped, lockfile regenerated, the gate is green.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: Some("e-alu-u1".into()), assistant_entry_id: Some("e-alu-a1".into()) } });
                s
            }
            _ => {
                warn!("[mock] run_script: {name} (not yet implemented)");
                return;
            }
        };
        self.play_script(steps);
    }

    fn reset(&self, _bootstrap: bool) {
        // The TS mock resets its internal state (sessions, queues, timers, etc.).
        // Our simplified version resets the mock clock so fixture timestamps are
        // deterministic across resets. The greeting seed is regenerated on each
        // default_seed() call.
        reset_ts();
    }
}
