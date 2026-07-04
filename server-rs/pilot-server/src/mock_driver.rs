//! Mock driver for dev/e2e: directly implements PilotDriver with fixture data.
//! Port of `server/src/mock-driver.ts` + `server/src/fixtures.ts`.
//!
//! The mock emits SessionDriverEvent[] directly (no daemon, no wire protocol).
//! This is what the e2e suite tests against.

#![allow(dead_code)]

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

fn mock_snapshot(status: SessionStatus) -> SessionSnapshot {
    SessionSnapshot {
        r#ref: mock_session_ref(),
        workspace: mock_workspace(),
        title: "Wire up the WebSocket bridge".into(),
        status,
        updated_at: "0000000005".into(),
        archived_at: None,
        preview: None,
        config: Some(mock_default_config()),
        usage: Some(mock_usage()),
        running_run_id: None,
        queued_messages: None,
        facet: None,
        permission_monitor: Some(PermissionMonitorMode::Standard),
        adventurous_handoff: Some(false),
        notification_autodrain: Some(false),
        active_plan: None,
        goal: None,
        flags: None,
        todos: None,
        mcp_servers: Some(mock_mcp_servers()),
    }
}

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
        timestamp: "0000000005".into(),
        run_id: None,
    }
}

/// Build the greeting fixture: sessionOpened + userMessage + assistant deltas + tool spans + runCompleted.
/// This is the seed every fresh client sees.
fn greeting_seed() -> Vec<SessionDriverEvent> {
    let b = base();
    let mut events = vec![
        SessionDriverEvent::SessionOpened { base: b.clone(), snapshot: mock_snapshot(SessionStatus::Idle) },
        SessionDriverEvent::UserMessage { base: b.clone(), id: "u1".into(), text: GREETING_PROMPT.into(), entry_id: Some("e-u1".into()), images: None },
    ];

    // Assistant deltas (text channel, chunked)
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in chunk_text(text, 3) {
        events.push(SessionDriverEvent::AssistantDelta { base: b.clone(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None });
    }

    // Tool span: bash (rg)
    events.push(SessionDriverEvent::ToolStarted {
        base: b.clone(), call_id: "t1".into(), tool_name: "bash".into(),
        label: Some("Run shell command".into()),
        description: Some("Execute a command in the workspace shell".into()),
        input: Some(serde_json::json!({"command": "rg -n \"app.get\\(\" server/src"})),
    });
    events.push(SessionDriverEvent::ToolFinished {
        base: b.clone(), call_id: "t1".into(), success: true,
        output: Some(serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)")),
        images: None,
    });

    // More assistant deltas
    let text2 = "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.";
    for chunk in chunk_text(text2, 3) {
        events.push(SessionDriverEvent::AssistantDelta { base: b.clone(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None });
    }

    // Run completed
    events.push(SessionDriverEvent::RunCompleted {
        base: b.clone(),
        snapshot: mock_snapshot(SessionStatus::Idle),
        user_entry_id: Some("e-u1".into()),
        assistant_entry_id: Some("e-a1".into()),
    });

    events
}

/// Split text into streaming chunks of ~n words.
fn chunk_text(text: &str, chunk_size: usize) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    words.chunks(chunk_size).map(|c| c.join(" ")).collect()
}

/// Script step for delayed playback.
struct ScriptStep {
    wait_ms: u64,
    event: SessionDriverEvent,
}

/// Build the greeting script (with delays for streaming).
fn greeting_script() -> Vec<ScriptStep> {
    let b = base();
    let mut steps = vec![
        ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionOpened { base: b.clone(), snapshot: mock_snapshot(SessionStatus::Idle) } },
        ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: b.clone(), id: "u1".into(), text: GREETING_PROMPT.into(), entry_id: Some("e-u1".into()), images: None } },
    ];

    // Assistant deltas with delays
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in chunk_text(text, 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: b.clone(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    // Tool span
    steps.push(ScriptStep { wait_ms: 120, event: SessionDriverEvent::ToolStarted {
        base: b.clone(), call_id: "t1".into(), tool_name: "bash".into(),
        label: Some("Run shell command".into()),
        description: Some("Execute a command in the workspace shell".into()),
        input: Some(serde_json::json!({"command": "rg -n \"app.get\\(\" server/src"})),
    }});
    steps.push(ScriptStep { wait_ms: 220, event: SessionDriverEvent::ToolFinished {
        base: b.clone(), call_id: "t1".into(), success: true,
        output: Some(serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)")),
        images: None,
    }});

    // More deltas
    let text2 = "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.";
    for chunk in chunk_text(text2, 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: b.clone(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    // Run completed
    steps.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted {
        base: b.clone(),
        snapshot: mock_snapshot(SessionStatus::Idle),
        user_entry_id: Some("e-u1".into()),
        assistant_entry_id: Some("e-a1".into()),
    }});

    steps
}

/// Build a prompt reply script.
fn prompt_reply_script(text: &str, _prompt_id: Option<&str>) -> Vec<ScriptStep> {
    let b = base();
    let mut steps = vec![
        ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: b.clone(), id: "u2".into(), text: text.into(), entry_id: None, images: None } },
    ];

    // A short reply with a tool span
    for chunk in chunk_text("Looking into this now.", 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: b.clone(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    steps.push(ScriptStep { wait_ms: 100, event: SessionDriverEvent::ToolStarted {
        base: b.clone(), call_id: "t2".into(), tool_name: "bash".into(),
        label: Some("Run shell command".into()),
        description: Some("Execute a command in the workspace shell".into()),
        input: Some(serde_json::json!({"command": "cat src/index.ts"})),
    }});
    steps.push(ScriptStep { wait_ms: 200, event: SessionDriverEvent::ToolFinished {
        base: b.clone(), call_id: "t2".into(), success: true,
        output: Some(serde_json::json!("// file contents here")),
        images: None,
    }});

    for chunk in chunk_text("Done! The change is ready.", 3) {
        steps.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: b.clone(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
    }

    steps.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted {
        base: b.clone(),
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

    fn abort(&self, _session_id: Option<SessionId>) {}
    fn respond_ui(&self, _response: HostUiResponse, _session_id: Option<SessionId>) {}

    async fn list_sessions(&self) -> Vec<SessionListEntry> { mock_session_list() }

    async fn open_session(&self, _path: String) -> Vec<SessionDriverEvent> { greeting_seed() }
    async fn new_session(&self, _opts: NewSessionOptsData) -> Vec<SessionDriverEvent> { greeting_seed() }
    async fn list_models(&self) -> Vec<ModelOption> { mock_models() }
    async fn list_commands(&self, _session_id: Option<SessionId>) -> Vec<CommandInfo> { mock_commands() }
    async fn list_facets(&self, _session_id: Option<SessionId>) -> Vec<String> { vec!["execute".into(), "plan".into()] }
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

    fn set_model(&self, _provider: String, _model_id: String, _session_id: Option<SessionId>) {}
    fn set_thinking(&self, _level: String, _session_id: Option<SessionId>) {}
    fn set_facet(&self, _facet: String, _session_id: Option<SessionId>) {}
    fn set_permission_monitor(&self, _mode: PermissionMonitorMode, _session_id: Option<SessionId>) {}

    fn default_seed(&self) -> Option<Vec<SessionDriverEvent>> { Some(greeting_seed()) }

    fn run_script(&self, name: String) {
        let b = base();
        let steps: Vec<ScriptStep> = match name.as_str() {
            "pendinghold" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: b.clone(), id: "u-pending".into(), text: "Refactor the auth middleware".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: b.clone(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in chunk_text("Let me look at how auth is wired before I touch it.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: b.clone(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                s
            }
            "reply" => prompt_reply_script("Show me the streamed reply script.", None),
            "confirm" => {
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: b.clone(), request: HostUiRequest::Confirm { request_id: "req-confirm-1".into(), title: "Allow git push?".into(), message: "Allow the agent to run `git push`?".into(), default_value: Some(true), timeout_ms: None } } },
                ]
            }
            "input" => {
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: b.clone(), request: HostUiRequest::Input { request_id: "req-input-1".into(), title: "What should the commit message be?".into(), placeholder: None, initial_value: Some("fix: update auth middleware".into()), timeout_ms: None } } },
                ]
            }
            "ambient" => {
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: b.clone(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ]
            }
            "idle" => {
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: b.clone(), id: "u-idle".into(), text: "End this turn without a runCompleted, please.".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: b.clone(), snapshot: mock_snapshot(SessionStatus::Running) } },
                    ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: b.clone(), text: "Sure thing.".into(), channel: Some(AssistantDeltaChannel::Text), entry_id: None } },
                    ScriptStep { wait_ms: 50, event: SessionDriverEvent::SessionUpdated { base: b.clone(), snapshot: mock_snapshot(SessionStatus::Idle) } },
                ]
            }
            "error" => {
                vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: b.clone(), id: "u-err".into(), text: "Do something that fails.".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: b.clone(), snapshot: mock_snapshot(SessionStatus::Running) } },
                    ScriptStep { wait_ms: 100, event: SessionDriverEvent::RunFailed { base: b.clone(), error: SessionErrorInfo { message: "API rate limit exceeded".into(), code: None, details: None } } },
                ]
            }
            _ => {
                warn!("[mock] run_script: {name} (not yet implemented)");
                return;
            }
        };
        self.play_script(steps);
    }

    fn reset(&self, _bootstrap: bool) {}
}
