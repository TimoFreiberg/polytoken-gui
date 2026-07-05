//! Mock driver for dev/e2e: directly implements PilotDriver with fixture data.
//! Port of `server/src/mock-driver.ts` + `server/src/fixtures.ts`.
//!
//! The mock emits SessionDriverEvent[] directly (no daemon, no wire protocol).
//! This is what the e2e suite tests against.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use pilot_protocol::session_driver::*;
use pilot_protocol::wire::DeliveryMode;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use crate::driver::{
    ArchiveResult, BranchResult, ClearQueueResult, NewSessionOptsData, PilotDriver,
    WorktreeCleanupResult, WorktreeRetained,
};
use async_trait::async_trait;

/// Whether a HostUiRequest is a dialog (awaiting a response), mirroring the TS
/// `isDialogRequest`. Notify/Status/Widget are fire-and-forget ambient UI.
fn is_dialog_request(r: &HostUiRequest) -> bool {
    matches!(
        r,
        HostUiRequest::Confirm { .. }
            | HostUiRequest::Input { .. }
            | HostUiRequest::Select { .. }
            | HostUiRequest::Editor { .. }
            | HostUiRequest::Qna { .. }
            | HostUiRequest::Plan { .. }
            | HostUiRequest::Permission { .. }
    )
}

/// Accessor for the requestId field shared by every HostUiRequest variant.
/// (Free function — we can't add an inherent impl on a type from another crate.)
fn request_id_of(r: &HostUiRequest) -> &str {
    match r {
        HostUiRequest::Confirm { request_id, .. }
        | HostUiRequest::Input { request_id, .. }
        | HostUiRequest::Select { request_id, .. }
        | HostUiRequest::Editor { request_id, .. }
        | HostUiRequest::Qna { request_id, .. }
        | HostUiRequest::Plan { request_id, .. }
        | HostUiRequest::Permission { request_id, .. }
        | HostUiRequest::Notify { request_id, .. }
        | HostUiRequest::Status { request_id, .. }
        | HostUiRequest::Widget { request_id, .. }
        | HostUiRequest::Title { request_id, .. }
        | HostUiRequest::EditorText { request_id, .. }
        | HostUiRequest::Reset { request_id, .. } => request_id,
    }
}

// ── Fixture constants (ported from fixtures.ts) ─────────────────────────

pub(crate) const GREETING_PROMPT: &str =
    "Add a /health route to the server and a smoke test for it.";
const WORKSPACE_ID: &str = "ws-demo";
const WORKSPACE_PATH: &str = "/Users/timo/src/pilot";
const SESSION_ID: &str = "demo-session";

/// The synthetic session list row prepended when a new session is created —
/// faithful port of TS `NEW_SESSION_ENTRY` (fixtures.ts). `new_session` spreads
/// the resolved cwd + a cwd-derived session id over this before prepending it.
const NEW_SESSION_PATH: &str = "/sessions/new-session.jsonl";
const NEW_SESSION_TITLE: &str = "New session";

/// Markdown showcase text (ported from fixtures.ts MARKDOWN_SAMPLE).
const MARKDOWN_SAMPLE: &str = "## Markdown showcase\n\nHere's **bold**, *italic*, ~~struck~~, and `inline code`, plus a [link](https://example.com).\n\n### A table\n\n| Feature     | Status |\n| ----------- | ------ |\n| Headers     | done   |\n| Tables      | done   |\n| Code blocks | done   |\n\n### A wide table\n\nA many-columned table is wider than a phone screen; it must scroll\nhorizontally instead of overflowing the viewport.\n\n| Country | Capital  | Population | Currency | Language   | Continent     | CallingCode |\n| ------- | -------- | ---------- | -------- | ---------- | ------------- | ----------- |\n| Japan   | Tokyo    | 125.7M     | JPY      | Japanese   | Asia          | +81         |\n| Brazil  | Brasília | 214.3M     | BRL      | Portuguese | South America | +55         |\n\n### A list\n\n1. First item\n2. Second item\n   - nested bullet\n   - another\n\n> A blockquote, for good measure.\n\n```ts\nfunction greet(name: string) {\n  return `hello, ${name}`;\n}\n```";

/// Plan handoff text (ported from fixtures.ts planHandoff()).
const PLAN_HANDOFF_TEXT: &str = "# Plan: Add facet indicator + plan-handoff card\n\n## Goal\nStop discarding plan-mode data the daemon already streams. Render the plan\nmarkdown in the handoff card and show a facet badge in the header.\n\n## Steps\n1. Add a `plan` variant to `HostUiRequest` in the protocol.\n2. Thread `plan_text` through the server event-map.\n3. Render markdown + 3 buttons in `ApprovalLayer.svelte`.\n4. Add a facet badge to `StatusHeader.svelte`.\n\n## Code\n```ts\ncase \"plan_handoff\": {\n  const ph = ev.plan_handoff;\n  const labels = ph\n    ? [ph.action_labels.implement_new_context,\n       ph.action_labels.implement_current_context,\n       ph.action_labels.cancel]\n    : [\"Implement (new context)\", \"Implement (current context)\", \"Cancel\"];\n  pending.planHandoffLabels = labels;\n}\n```\n\n## Risks\n- `plan_text` can be several KB; the card caps height at ~50vh and scrolls.\n- The default-facet sentinel is `\"execute\"`; a different default would show the\n  badge spuriously.\n\nOnce approved, the chosen label round-trips to a `plan_handoff_answer` decision\nvia the reverse mapping in `ui-bridge.ts` (no change needed there).";

/// Tiny deterministic PNGs (solid-color rectangles) for the images fixture.
const MOCKUP_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwE9pDFMazBQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEX9RS5koKflW4AAAAASUVORK5CYII=";
const SHOT_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAqElEQVR4nO3QAQkAIADAMFMaw5QGs4XCHTzA2dhr6kLj+cEngQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnSrA0Iub1g8jaYyAAAAAElFTkSuQmCC";

/// Monotonic mock clock — each call to `ts()` bumps by TS_STEP_MS and returns
/// a zero-padded 10-digit string, matching the TS fixture's `ts()` exactly.
const TS_STEP_MS: u64 = 5;
static MOCK_TS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn ts() -> String {
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
    LIVE_USAGE_TOKENS.store(47200, Ordering::Relaxed);
}

/// Live context meter — climbs each poll so it's visibly non-static during a run.
static LIVE_USAGE_TOKENS: AtomicU64 = AtomicU64::new(47200);

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
        ModelOption {
            provider: "anthropic".into(),
            model_id: "claude-opus-4-8".into(),
            label: "Claude Opus 4.8".into(),
            thinking_levels: Some(vec![
                "off".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
        },
        ModelOption {
            provider: "anthropic".into(),
            model_id: "claude-sonnet-4-6".into(),
            label: "Claude Sonnet 4.6".into(),
            thinking_levels: Some(vec![
                "off".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
        },
        ModelOption {
            provider: "deepseek".into(),
            model_id: "deepseek-v4-flash".into(),
            label: "DeepSeek V4 Flash".into(),
            thinking_levels: Some(vec!["off".into()]),
        },
        ModelOption {
            provider: "openai".into(),
            model_id: "gpt-5".into(),
            label: "GPT-5".into(),
            thinking_levels: Some(vec![
                "minimal".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ]),
        },
    ]
}

fn mock_commands() -> Vec<CommandInfo> {
    vec![
        CommandInfo {
            name: "review".into(),
            description: Some("Review the working-copy diff for bugs".into()),
            source: CommandSource::Prompt,
            argument_hint: Some("[path]".into()),
        },
        CommandInfo {
            name: "plan".into(),
            description: Some("Draft an implementation plan before coding".into()),
            source: CommandSource::Prompt,
            argument_hint: None,
        },
        CommandInfo {
            name: "commit".into(),
            description: Some("Stage changes and commit with a generated message".into()),
            source: CommandSource::Extension,
            argument_hint: None,
        },
        CommandInfo {
            name: "pr".into(),
            description: Some("Open a pull request for the current branch".into()),
            source: CommandSource::Extension,
            argument_hint: None,
        },
        CommandInfo {
            name: "skill:debug".into(),
            description: Some("Trace a bug end-to-end before forming a hypothesis".into()),
            source: CommandSource::Skill,
            argument_hint: None,
        },
        CommandInfo {
            name: "skill:journal".into(),
            description: Some("Capture a durable judgment for a future session".into()),
            source: CommandSource::Skill,
            argument_hint: None,
        },
    ]
}

fn mock_files() -> Vec<FileInfo> {
    // Faithful port of TS `MOCK_FILES` (`server/src/fixtures.ts:100-133`).
    vec![
        FileInfo {
            path: "README.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "AGENTS.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs".into(),
            is_directory: true,
        },
        FileInfo {
            path: "docs/DESIGN.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs/DECISIONS.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs/TODO.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "docs/ADR-desktop-shell.md".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server".into(),
            is_directory: true,
        },
        FileInfo {
            path: "server/src/index.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/hub.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/mock-driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/hub.test.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/fixtures.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "server/src/polytoken/polytoken-driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client".into(),
            is_directory: true,
        },
        FileInfo {
            path: "client/src/app.css".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/components/Composer.svelte".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/components/SlashMenu.svelte".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/store.svelte.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/slash.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/slash.test.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "client/src/lib/ws.svelte.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "e2e".into(),
            is_directory: true,
        },
        FileInfo {
            path: "e2e/slash.e2e.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "e2e/composer-resize.e2e.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "protocol".into(),
            is_directory: true,
        },
        FileInfo {
            path: "protocol/src/wire.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "protocol/src/session-driver.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "protocol/src/state.ts".into(),
            is_directory: false,
        },
        FileInfo {
            path: "package.json".into(),
            is_directory: false,
        },
        FileInfo {
            path: "tsconfig.json".into(),
            is_directory: false,
        },
    ]
}

fn mock_usage() -> SessionUsage {
    SessionUsage {
        tokens: Some(47200),
        context_window: 200000,
        percent: Some(23.6),
    }
}

fn mock_usage_full() -> SessionUsage {
    SessionUsage {
        tokens: Some(182000),
        context_window: 200000,
        percent: Some(91.0),
    }
}

pub(crate) fn session_ref_for(session_id: &str) -> SessionRef {
    SessionRef {
        workspace_id: WORKSPACE_ID.into(),
        session_id: session_id.into(),
    }
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
        McpServerInfo {
            server_name: "filesystem".into(),
            status: McpServerStatus::Connected,
            tool_count: 11,
        },
        McpServerInfo {
            server_name: "github".into(),
            status: McpServerStatus::Disconnected,
            tool_count: 0,
        },
    ]
}

fn mock_default_config() -> SessionConfig {
    SessionConfig {
        provider: Some("anthropic".into()),
        model_id: Some("claude-opus-4-8".into()),
        thinking_level: Some("medium".into()),
        available_thinking_levels: Some(vec![
            "off".into(),
            "low".into(),
            "medium".into(),
            "high".into(),
        ]),
    }
}

// mock_snapshot is defined above ( delegates to snap() with no overrides).

fn mock_session_list() -> Vec<SessionListEntry> {
    let now = chrono::Utc::now();
    // JS `new Date(...).toISOString()` → `YYYY-MM-DDTHH:mm:ss.SSSZ` (trailing Z,
    // exactly 3 fractional digits). chrono's default `to_rfc3339()` emits a
    // `+00:00` offset + up to 9 digits, which is NOT byte-faithful to the TS
    // wire format. Match `toISOString()` exactly via SecondsFormat::Millis + use_z.
    let iso_ago = |ms: i64| {
        (now - chrono::Duration::milliseconds(ms))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let day = 24 * 60 * 60 * 1000;
    vec![
        SessionListEntry {
            session_id: "demo-session".into(),
            path: "/sessions/demo-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(),
            display_name: Some("Wire up the WebSocket bridge".into()),
            preview: "Add a /health route to the server and a smoke test for it.".into(),
            user_message_count: 3,
            usage: Some(mock_usage()),
            updated_at: iso_ago(5 * 60_000),
            created_at: iso_ago(2 * day),
            last_user_message_at: iso_ago(6 * 60_000),
            parent_session_path: None,
            archived: false,
            worktree: None,
        },
        SessionListEntry {
            session_id: "older-session".into(),
            path: "/sessions/older-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(),
            display_name: Some("Explore the fold reducer".into()),
            preview: "How does foldEvent assemble the transcript?".into(),
            user_message_count: 5,
            usage: Some(SessionUsage {
                tokens: Some(164000),
                context_window: 200000,
                percent: Some(82.0),
            }),
            updated_at: iso_ago(2 * 60 * 60 * 1000),
            created_at: iso_ago(3 * day),
            last_user_message_at: iso_ago(2 * 60 * 60 * 1000 + 60_000),
            parent_session_path: None,
            archived: false,
            worktree: None,
        },
        SessionListEntry {
            session_id: "scratch-session".into(),
            path: "/sessions/scratch-session.jsonl".into(),
            cwd: "/Users/timo/src/scratch".into(),
            display_name: None,
            preview: "quick scratch session".into(),
            user_message_count: 1,
            usage: None,
            updated_at: iso_ago(6 * 60 * 60 * 1000),
            created_at: iso_ago(4 * day),
            last_user_message_at: iso_ago(6 * 60 * 60 * 1000 - 60_000),
            parent_session_path: None,
            archived: false,
            worktree: None,
        },
        SessionListEntry {
            session_id: "archived-session".into(),
            path: "/sessions/archived-session.jsonl".into(),
            cwd: WORKSPACE_PATH.into(),
            display_name: Some("Archived experiment".into()),
            preview: "An old experiment I tucked away.".into(),
            user_message_count: 4,
            usage: None,
            updated_at: iso_ago(5 * day),
            created_at: iso_ago(8 * day),
            last_user_message_at: iso_ago(5 * day),
            parent_session_path: None,
            archived: true,
            worktree: None,
        },
        SessionListEntry {
            session_id: "stale-session".into(),
            path: "/sessions/stale-session.jsonl".into(),
            cwd: "/Users/timo/src/stale-proj".into(),
            display_name: Some("Old spike".into()),
            preview: "A spike from a couple of weeks ago.".into(),
            user_message_count: 2,
            usage: None,
            updated_at: iso_ago(10 * day),
            created_at: iso_ago(12 * day),
            last_user_message_at: iso_ago(10 * day),
            parent_session_path: None,
            archived: false,
            worktree: None,
        },
    ]
}

/// Seed the `worktrees` map from the fixture session list — faithful port of TS
/// `seedWorktrees(SESSION_LIST)`: every entry whose `worktree` is set contributes
/// `{ base, name }` keyed by its cwd. The static `mock_session_list()` baseline
/// carries no worktree rows, so this yields an empty map (as in TS where SESSION_LIST
/// has no worktree entries either); `new_session(worktree: true)` populates it.
fn seed_worktrees(
    sessions: &[SessionListEntry],
) -> std::collections::HashMap<String, WorktreeMeta> {
    sessions
        .iter()
        .filter_map(|s| {
            s.worktree.as_ref().map(|w| {
                (
                    s.cwd.clone(),
                    WorktreeMeta {
                        base: w.base.clone(),
                        name: w.name.clone(),
                    },
                )
            })
        })
        .collect()
}

/// Resolve a path the way TS `path.resolve` does for the dir-picker: normalize
/// `.`/`..`, drop trailing slashes, and make it absolute against `/` (the mock's
/// fixture paths are already absolute under `/Users/timo` or `$HOME`). Empty →
/// `$HOME` (the picker's default open). Mirrors TS `listDir`/`statPath`'s
/// `resolve(path.trim())`.
fn mock_resolve(path: Option<&str>) -> String {
    use std::path::{Component, Path, PathBuf};
    let raw = path.map(|s| s.trim()).filter(|s| !s.is_empty());
    let (mut out, rel): (PathBuf, Option<&Path>) = match raw {
        Some(p) if Path::new(p).is_absolute() => (PathBuf::from("/"), Some(Path::new(p))),
        // Node's `path.resolve(p)` resolves a non-empty relative path against
        // `process.cwd()`, NOT `$HOME`. (The empty/whitespace → `$HOME` case is
        // handled by the `None` arm below, mirroring TS `listDir`'s `homedir()`.)
        Some(p) => (
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            Some(Path::new(p)),
        ),
        None => return std::env::var("HOME").unwrap_or_else(|_| "/".to_string()),
    };
    for comp in rel.unwrap().components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(c) => out.push(c),
            Component::RootDir | Component::Prefix(_) => {} // already rooted (out starts at "/")
        }
    }
    let s = out.to_string_lossy().into_owned();
    if s.is_empty() { "/".to_string() } else { s }
}

/// The synthetic directory tree for the new-session picker — faithful port of TS
/// `MOCK_DIR_LAYOUT` + `MOCK_DIR_TREE` (fixtures.ts / mock-driver.ts). Keyed by
/// absolute path under BOTH `$HOME` and `/Users/timo` (the fixture-cwd prefix) so
/// the picker has content regardless of the dev host's `$HOME`; child names are
/// stable. `demo`/`elsewhere` are empty project dirs e2e navigates into; `dirty`
/// simulates uncommitted changes (archive keeps its worktree). The picker
/// (`list_dir`) reads this; `stat_path` reports existence from it. The mock never
/// touches the real disk.
fn mock_dir_tree() -> &'static std::collections::HashMap<String, Vec<String>> {
    use std::sync::OnceLock;
    static TREE: OnceLock<std::collections::HashMap<String, Vec<String>>> = OnceLock::new();
    TREE.get_or_init(|| {
        // rel-path → child names (TS MOCK_DIR_LAYOUT). "" is the root ($HOME).
        let layout: &[(&str, &[&str])] = &[
            (
                "",
                &["src", "Documents", "Downloads", "Projects", ".config"],
            ),
            (
                "src",
                &[
                    "pilot",
                    "pi",
                    "pi-gui",
                    "kellercomm",
                    "scratch",
                    "demo",
                    "elsewhere",
                    "dirty",
                ],
            ),
            (
                "src/pilot",
                &["client", "server", "protocol", "e2e", "docs"],
            ),
            ("src/pi", &["src", "docs", "examples"]),
            ("Documents", &["notes", "receipts"]),
            ("Projects", &["website"]),
            (".config", &["pi", "fish"]),
        ];
        let roots: Vec<String> =
            std::iter::once(std::env::var("HOME").unwrap_or_else(|_| String::new()))
                .chain(std::iter::once("/Users/timo".to_string()))
                .filter(|r| !r.is_empty())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
        let mut tree: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for root in &roots {
            for (rel, kids) in layout {
                let key = if rel.is_empty() {
                    root.clone()
                } else {
                    format!("{root}/{rel}")
                };
                tree.insert(key, kids.iter().map(|s| s.to_string()).collect());
            }
        }
        tree
    })
}

// ── Script steps + event builders ──────────────────────────────────────

fn base() -> SessionEventBase {
    SessionEventBase {
        session_ref: mock_session_ref(),
        timestamp: ts(),
        run_id: None,
    }
}

/// Like `base()` but stamps a specific session ref — used by `respond_ui`, which
/// must emit under the dialog's session (not always the default mock session),
/// mirroring TS `respondUi`'s `pending?.sessionRef ?? SESSION_REF`.
fn base_with_ref(session_ref: SessionRef) -> SessionEventBase {
    SessionEventBase {
        session_ref,
        timestamp: ts(),
        run_id: None,
    }
}

/// Build a session-specific seed for opening a given session path.
/// Mirrors the TS `mockSessionSeed(path)` — returns different fixture content
/// per session so switching to "older-session" shows its own transcript, not
/// the greeting's.
fn mock_session_seed(path: &str) -> Vec<SessionDriverEvent> {
    fn session_seed(
        session_id: &str,
        title: &str,
        user_text: &str,
        assistant_text: &str,
    ) -> Vec<SessionDriverEvent> {
        let ref_id = session_ref_for(session_id);
        let b = || SessionEventBase {
            session_ref: ref_id.clone(),
            timestamp: ts(),
            run_id: None,
        };
        let snap = |status: SessionStatus| SessionSnapshot {
            r#ref: ref_id.clone(),
            workspace: mock_workspace(),
            title: title.into(),
            status,
            updated_at: ts(),
            archived_at: None,
            preview: None,
            config: Some(mock_default_config()),
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
        };
        vec![
            SessionDriverEvent::SessionOpened {
                base: b(),
                snapshot: snap(SessionStatus::Idle),
            },
            SessionDriverEvent::UserMessage {
                base: b(),
                id: format!("u-{session_id}"),
                text: user_text.into(),
                images: None,
                entry_id: None,
            },
            SessionDriverEvent::AssistantDelta {
                base: b(),
                text: assistant_text.into(),
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
            SessionDriverEvent::RunCompleted {
                base: b(),
                snapshot: snap(SessionStatus::Idle),
                user_entry_id: None,
                assistant_entry_id: None,
            },
        ]
    }
    match path {
        "/sessions/demo-session.jsonl" => greeting_seed(),
        "/sessions/older-session.jsonl" => session_seed(
            "older-session",
            "Explore the fold reducer",
            "How does foldEvent assemble the transcript?",
            "It folds each driver event into render-ready items — assistant deltas accumulate into one bubble, tool cards key off callId, and ambient UI lives in keyed maps.",
        ),
        "/sessions/scratch-session.jsonl" => session_seed(
            "scratch-session",
            "scratch",
            "quick scratch session",
            "Noted — nothing else here.",
        ),
        _ => session_seed(
            "unknown",
            "Session",
            "(opened)",
            "No fixture for this session.",
        ),
    }
}

/// Build the greeting fixture: sessionOpened + userMessage + assistant deltas + tool spans + runCompleted.
/// This is the seed every fresh client sees.
fn branched_seed() -> Vec<SessionDriverEvent> {
    vec![SessionDriverEvent::SessionOpened {
        base: base(),
        snapshot: mock_snapshot(SessionStatus::Idle),
    }]
}

fn greeting_seed() -> Vec<SessionDriverEvent> {
    let mut events = vec![
        SessionDriverEvent::SessionOpened {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
        },
        SessionDriverEvent::UserMessage {
            base: base(),
            id: "u1".into(),
            text: GREETING_PROMPT.into(),
            entry_id: Some("e-u1".into()),
            images: None,
        },
    ];

    // Simulate ~37s of working wall-clock between the prompt and the settled reply,
    // so the collapsed "Worked for Ns" header reads realistically on first load.
    advance_ts(36_600);

    // Assistant deltas (text channel, chunked)
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in deltas(text, 3) {
        events.push(SessionDriverEvent::AssistantDelta {
            base: base(),
            text: chunk,
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        });
    }

    // Tool span: bash (rg) — bump the clock by durationMs between start and finish.
    events.push(SessionDriverEvent::ToolStarted {
        base: base(),
        call_id: "t1".into(),
        tool_name: "bash".into(),
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
        events.push(SessionDriverEvent::AssistantDelta {
            base: base(),
            text: chunk,
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        });
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

/// Render submitted Q&A into the same transcript text the answer extension's
/// `formatQnA` produces (Q / context / Options / A lines), so the mock exercises
/// the client's parse-and-render path. Faithful port of TS `formatQnaText`.
fn format_qna_text(questions: &[QnaQuestion], answers: &[QnaAnswer]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (i, q) in questions.iter().enumerate() {
        let a = answers.get(i);
        parts.push(format!("Q: {}", q.question));
        if let Some(ctx) = &q.context {
            parts.push(format!("> {ctx}"));
        }
        let opts: &[QnaQuestionOption] = q.options.as_deref().unwrap_or(&[]);
        let has_options = !opts.is_empty();
        if has_options {
            let picked: std::collections::HashSet<i64> = a
                .map(|ans| ans.selected_option_indices.iter().copied().collect())
                .unwrap_or_default();
            parts.push("Options:".into());
            for (j, opt) in opts.iter().enumerate() {
                let mark = if picked.contains(&(j as i64)) {
                    "[x]"
                } else {
                    "[ ]"
                };
                parts.push(format!("  {mark} {}", opt.label));
            }
        }
        let chosen: Vec<String> = match a {
            Some(ans) => ans
                .selected_option_indices
                .iter()
                .filter(|&&idx| idx >= 0 && (idx as usize) < opts.len())
                .map(|&idx| opts[idx as usize].label.clone())
                .collect(),
            None => Vec::new(),
        };
        let mut segments = chosen;
        let custom = a
            .map(|ans| ans.custom_text.trim().to_string())
            .unwrap_or_default();
        if !custom.is_empty() {
            segments.push(if has_options {
                format!("(typed) {custom}")
            } else {
                custom
            });
        }
        let answer = if segments.is_empty() {
            "(no answer)".to_string()
        } else {
            segments.join(", ")
        };
        parts.push(format!("A: {answer}"));
        parts.push(String::new());
    }
    parts.join("\n").trim_end().to_string()
}

/// Script step for delayed playback.
struct ScriptStep {
    wait_ms: u64,
    event: SessionDriverEvent,
}

/// A matched toolStarted → toolFinished pair with a deterministic duration.
/// Bumps the clock by `duration_ms` between stamping the two events so the
/// card's elapsed badge reads realistically.
#[allow(
    clippy::too_many_arguments,
    reason = "mock fixture helper mirrors scripted tool event fields"
)]
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
#[expect(
    dead_code,
    reason = "fixture kept for mock parity; current default seed uses a prebuilt greeting session"
)]
fn greeting_script() -> Vec<ScriptStep> {
    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionOpened {
                base: base(),
                snapshot: mock_snapshot(SessionStatus::Idle),
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: base(),
                id: "u1".into(),
                text: GREETING_PROMPT.into(),
                entry_id: Some("e-u1".into()),
                images: None,
            },
        },
    ];

    advance_ts(36_600);

    // Assistant deltas with delays
    let text = "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.";
    for chunk in deltas(text, 3) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    // Tool span
    steps.push(ScriptStep {
        wait_ms: 120,
        event: SessionDriverEvent::ToolStarted {
            base: base(),
            call_id: "t1".into(),
            tool_name: "bash".into(),
            label: Some("Run shell command".into()),
            description: Some("Execute a command in the workspace shell".into()),
            input: Some(serde_json::json!({"command": "rg -n \"app.get\\(\" server/src"})),
        },
    });
    advance_ts(340);
    steps.push(ScriptStep { wait_ms: 220, event: SessionDriverEvent::ToolFinished {
        base: base(), call_id: "t1".into(), success: true,
        output: Some(serde_json::json!("server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)")),
        images: None,
    }});

    // More deltas
    let text2 = "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.";
    for chunk in deltas(text2, 3) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    // Run completed
    steps.push(ScriptStep {
        wait_ms: 60,
        event: SessionDriverEvent::RunCompleted {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
            user_entry_id: Some("e-u1".into()),
            assistant_entry_id: Some("e-a1".into()),
        },
    });

    steps
}

/// Build a prompt reply script — faithful port of TS `promptReply()`.
/// Emits: userMessage (with stable branch handles) → sessionUpdated(running) →
/// thinking deltas → text deltas → read tool span → text deltas → runCompleted.
fn prompt_reply_script(text: &str, prompt_id: Option<&str>) -> Vec<ScriptStep> {
    // Stable branch handles for this turn, derived from the user message id so the
    // turn-final assistant offers "branch from here" and the prompt offers "branch
    // from this prompt" — mirroring the real daemon. (See TS promptReply.)
    let u_id = prompt_id
        .map(|p| p.to_string())
        .unwrap_or_else(|| format!("u-{}", ts()));
    let call_id = format!("t-{}", ts());

    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: base(),
                id: u_id.clone(),
                text: text.into(),
                images: None,
                entry_id: Some(format!("e-{u_id}")),
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionUpdated {
                base: base(),
                snapshot: mock_snapshot(SessionStatus::Running),
            },
        },
    ];

    // Thinking deltas (rendered under a "Thought process" collapsed block).
    for chunk in deltas("Let me think about the cleanest way to do that.", 3) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Thinking),
                entry_id: None,
            },
        });
    }

    // Text deltas — the visible narration.
    for chunk in deltas(
        "Good question. Here's the plan: I'll start by checking the existing structure, then make the change incrementally so each step is verifiable.",
        3,
    ) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    // Read tool span — ~1.2s (a file read that touches disk).
    steps.extend(tool_span(
        &call_id,
        "read",
        "Read file",
        Some("Read a file from the workspace"),
        serde_json::json!({"path": "server/src/index.ts"}),
        true,
        serde_json::json!("// 42 lines — Bun.serve with WS + /debug/state"),
        140,
        260,
        1200,
    ));

    // Final text deltas.
    for chunk in deltas(
        "That confirms it. Making the change now and then I'll verify it builds.",
        3,
    ) {
        steps.push(ScriptStep {
            wait_ms: 28,
            event: SessionDriverEvent::AssistantDelta {
                base: base(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }

    steps.push(ScriptStep {
        wait_ms: 80,
        event: SessionDriverEvent::RunCompleted {
            base: base(),
            snapshot: mock_snapshot(SessionStatus::Idle),
            user_entry_id: Some(format!("e-{u_id}")),
            assistant_entry_id: Some(format!("e-a-{u_id}")),
        },
    });

    steps
}

/// The synthetic sidebar row prepended for a freshly-created session — faithful
/// port of TS `NEW_SESSION_ENTRY` (fixtures.ts), spread with the resolved cwd +
/// a cwd-derived session id by `new_session`. Empty preview/count, not archived,
/// no worktree field (listSessions overlays that). Timestamps are `isoAgo(0)` — a
/// REAL RFC3339 now (NOT the mock clock's `ts()`): the client sorts rows by
/// `updatedAt` lexicographically, and `ts()` returns a zero-padded 10-digit mock
/// string (e.g. "0000037045") that sorts BEFORE the fixture rows' real ISO
/// timestamps, dropping the just-created (newest) row to the bottom of the
/// group instead of the top.
fn new_session_entry(session_id: &str, cwd: &str) -> SessionListEntry {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    SessionListEntry {
        session_id: session_id.into(),
        path: NEW_SESSION_PATH.into(),
        cwd: cwd.into(),
        display_name: Some(NEW_SESSION_TITLE.into()),
        preview: String::new(),
        user_message_count: 0,
        updated_at: now.clone(),
        created_at: now.clone(),
        last_user_message_at: now,
        parent_session_path: None,
        usage: None,
        archived: false,
        worktree: None,
    }
}

/// Seed events for a freshly created (empty) session — faithful port of TS
/// `newSessionSeed`. `dir`/`config` are the ALREADY-RESOLVED cwd + config — the
/// `new_session` driver method derives them (worktree suffix, chosen model's
/// thinking levels) the way TS `newSession()` does before calling `newSessionSeed`.
/// Returns the seed events + the sessionOpened snapshot (so the caller can
/// remember it for the deferred first-prompt flow).
fn new_session_seed(
    dir: &str,
    config: SessionConfig,
    facet: Option<String>,
    permission_monitor: PermissionMonitorMode,
) -> (Vec<SessionDriverEvent>, SessionSnapshot) {
    let ref_id = session_ref_for("new-session");
    let workspace = if dir == WORKSPACE_PATH {
        mock_workspace()
    } else {
        WorkspaceRef {
            workspace_id: dir.into(),
            path: dir.into(),
            display_name: Some(
                dir.trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or(dir)
                    .to_string(),
            ),
        }
    };
    let snapshot = SessionSnapshot {
        r#ref: ref_id.clone(),
        workspace,
        title: "New session".into(),
        status: SessionStatus::Idle,
        updated_at: ts(),
        archived_at: None,
        preview: None,
        config: Some(config),
        usage: None,
        running_run_id: None,
        queued_messages: None,
        facet,
        permission_monitor: Some(permission_monitor),
        adventurous_handoff: None,
        notification_autodrain: None,
        active_plan: None,
        goal: None,
        flags: None,
        todos: None,
        mcp_servers: None,
    };
    let events = vec![SessionDriverEvent::SessionOpened {
        base: SessionEventBase {
            session_ref: ref_id,
            timestamp: ts(),
            run_id: None,
        },
        snapshot: snapshot.clone(),
    }];
    (events, snapshot)
}

/// The first turn of a freshly created session, streamed under that session's OWN
/// ref — faithful port of TS `newSessionReply`. The deferred-creation flow
/// delivers the first prompt only after the new session is focused, so its turn
/// must land in the new session's transcript. Streams "On it — the session's up."
fn new_session_reply(
    template: &SessionSnapshot,
    user_text: &str,
    user_id: &str,
    images: &[ImageContent],
) -> Vec<ScriptStep> {
    let ref_id = template.r#ref.clone();
    let b = || SessionEventBase {
        session_ref: ref_id.clone(),
        timestamp: ts(),
        run_id: None,
    };
    let snap = |status: SessionStatus| SessionSnapshot {
        status,
        updated_at: ts(),
        ..template.clone()
    };
    let reply = "On it — the session's up. Let me take a first look at what you asked for.";
    let mut steps = vec![
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::UserMessage {
                base: b(),
                id: user_id.into(),
                text: user_text.into(),
                images: if images.is_empty() {
                    None
                } else {
                    Some(images.to_vec())
                },
                entry_id: Some(format!("e-{user_id}")),
            },
        },
        ScriptStep {
            wait_ms: 0,
            event: SessionDriverEvent::SessionUpdated {
                base: b(),
                snapshot: snap(SessionStatus::Running),
            },
        },
    ];
    // Stream the reply in ~3-word chunks (same cadence as deltas, inlined so the
    // events carry the new session's ref instead of base()'s demo ref).
    for chunk in deltas(reply, 3) {
        steps.push(ScriptStep {
            wait_ms: 32,
            event: SessionDriverEvent::AssistantDelta {
                base: b(),
                text: chunk,
                channel: Some(AssistantDeltaChannel::Text),
                entry_id: None,
            },
        });
    }
    steps.push(ScriptStep {
        wait_ms: 80,
        event: SessionDriverEvent::RunCompleted {
            base: b(),
            snapshot: snap(SessionStatus::Idle),
            user_entry_id: Some(format!("e-{user_id}")),
            assistant_entry_id: Some(format!("e-a-{user_id}")),
        },
    });
    steps
}

// ── MockDriver ─────────────────────────────────────────────────────────

type ListenerList = Arc<Mutex<Vec<(usize, mpsc::Sender<SessionDriverEvent>)>>>;

pub struct MockDriver {
    listeners: ListenerList,
    next_id: Mutex<usize>,
    /// Generation counter — bumped on reset(). play_script captures the current
    /// generation and aborts if it changes (cancel pending events on reset).
    generation: Arc<AtomicU64>,
    /// The most recently created session's id + seed snapshot, so the FIRST prompt
    /// that follows (the deferred-creation first turn) streams under that session's
    /// own ref instead of the demo session's. Consumed (cleared) by that first prompt.
    /// Mirrors the TS MockDriver's `lastCreated`.
    last_created: Mutex<Option<LastCreated>>,
    /// One-shot: when set, the next `new_session()` returns no seed events then clears
    /// (armed via `run_script("failnewsession")`). Mirrors TS `failNextNewSession`.
    fail_next_new_session: Arc<AtomicBool>,
    /// Pending host-UI dialogs (keyed by requestId), so respondUi can look up the
    /// original request (e.g. a Q&A's questions) when forming the tool result.
    /// Mirrors the TS MockDriver's `pendingDialogs`.
    pending_dialogs: Arc<Mutex<std::collections::HashMap<String, PendingDialog>>>,
    /// The adventurous-handoff flag, toggled by `toggle_adventurous_handoff`.
    /// Mirrors the TS MockDriver's `adventurousHandoff` private field.
    adventurous_handoff: Arc<std::sync::Mutex<bool>>,
    /// In-flight script flush handle. When `play_script` starts a new script, it
    /// flushes any previous one first — mirroring TS `play()` → `flushScheduled()`,
    /// which fires all pending steps immediately (cancelling timers) so two scripts
    /// never interleave. The spawned task parks on `flush_rx` between steps; a flush
    /// closes the channel, which makes `flush_rx.try_recv()` return `Err(Closed)`,
    /// signalling the task to drain its remaining steps with zero delay.
    in_flight: Arc<Mutex<Option<InFlightHandle>>>,
    /// Monotonic per-script id, so a spawned task can compare-and-clear `in_flight`
    /// only for its own handle (TOCTOU: an old task finishing concurrently with a
    /// new `play_script` must not null out the newer handle).
    next_script_id: AtomicU64,
    /// Mutable session list — `mock_session_list()` at construction + reset, with a
    /// synthetic "new" row PREPENDED by `new_session` (mirrors TS `this.sessions`).
    /// `list_sessions` returns this overlaid with worktree/archive state. The TS
    /// mock served this mutable list so a freshly-created session appears in the
    /// sidebar immediately; the Rust mock previously returned the static list and a
    /// new session never showed up.
    sessions: Arc<Mutex<Vec<SessionListEntry>>>,
    /// Worktrees the mock "created" (the `-worktree` sibling dirs), keyed by the
    /// worktree cwd (== the session's cwd) → {base, name}. Mirrors the TS
    /// `worktrees` map (seeded from SESSION_LIST at construction + reset) so
    /// `list_sessions` flags worktree-backed rows with their parent project for
    /// grouping, and cleanup/archive only ever touch mock worktrees.
    worktrees: Arc<Mutex<std::collections::HashMap<String, WorktreeMeta>>>,
    /// cwds of mock worktrees created under a `dirty` project — simulate
    /// uncommitted changes so archive keeps them + reports `worktreeRetained`
    /// (mirrors TS `dirtyWorktrees`).
    dirty_worktrees: Arc<Mutex<std::collections::HashSet<String>>>,
    /// cwds whose worktree dir has been reaped (cleaned up / archived). Tombstone:
    /// the meta stays in `worktrees` so the orphaned session keeps grouping under
    /// its parent project, but the live affordances + ownership gate drop it
    /// (mirrors TS `reapedWorktrees`).
    reaped_worktrees: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Per-session queued input overlay. Mirrors TS MockDriver.queues: queueUpdated
    /// events replace the client queue, and openSession overlays queuedMessages on
    /// seed snapshots so reconnect/session refocus preserve queued rows.
    queues: Arc<Mutex<HashMap<SessionId, Vec<SessionQueuedMessage>>>>,
    /// The mock's current model selection, mutated by set_model/set_thinking so
    /// the picker reflects config changes. Mirrors TS MockDriver.config.
    config: Arc<Mutex<SessionConfig>>,
}

/// Handle to a currently-running script, so the next `play_script` can flush it.
struct InFlightHandle {
    /// Per-script id, so the spawned task can compare-and-clear `in_flight` only
    /// when it still holds THIS handle (prevents a late-exiting old task from
    /// nulling out a newer script's handle — TOCTOU).
    script_id: u64,
    /// Remaining steps the spawned task hasn't fired yet. The task PEEKS the front
    /// step while sleeping and only `pop_front()`s it immediately before firing —
    /// so a flush arriving mid-sleep can still drain (and fire) that step. Mirrors
    /// TS `play()`, where a timer splices its entry out of `scheduled` only inside
    /// its own callback, immediately before `fireStep`; `flushScheduled` fires ALL
    /// still-pending entries in order. The pop+fire happens UNDER this lock so the
    /// flusher's drain can't interleave between them (ordering — see play_script).
    remaining: Arc<Mutex<VecDeque<ScriptStep>>>,
    /// Set by the flusher once it has drained + fired `remaining`. The task checks
    /// this after waking from sleep, before pop+fire, so it never double-fires a
    /// step the flusher already emitted.
    drained: Arc<AtomicBool>,
    /// Closed by the flusher to signal the spawned task to stop sleeping.
    flush_tx: oneshot::Sender<()>,
}

/// The ref + snapshot of a just-created session, consumed by the first prompt.
struct LastCreated {
    session_id: String,
    snapshot: SessionSnapshot,
}

/// A pending host-UI dialog, tracked so respondUi can look up the original
/// request (e.g. a Q&A's questions) when forming the answer tool result.
struct PendingDialog {
    request: HostUiRequest,
    session_ref: SessionRef,
}

/// A mock worktree's parent-project metadata, keyed by the worktree cwd in the
/// `worktrees` map. Mirrors TS `{ base, name }` — `base` is the parent project
/// dir the worktree groups under, `name` the worktree's own dir name.
struct WorktreeMeta {
    base: String,
    name: String,
}

impl MockDriver {
    pub fn new() -> Self {
        Self {
            listeners: Arc::new(Mutex::new(Vec::new())),
            next_id: Mutex::new(0),
            generation: Arc::new(AtomicU64::new(0)),
            last_created: Mutex::new(None),
            fail_next_new_session: Arc::new(AtomicBool::new(false)),
            pending_dialogs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            adventurous_handoff: Arc::new(std::sync::Mutex::new(false)),
            in_flight: Arc::new(Mutex::new(None)),
            next_script_id: AtomicU64::new(0),
            sessions: Arc::new(Mutex::new(mock_session_list())),
            worktrees: Arc::new(Mutex::new(seed_worktrees(&mock_session_list()))),
            dirty_worktrees: Arc::new(Mutex::new(std::collections::HashSet::new())),
            reaped_worktrees: Arc::new(Mutex::new(std::collections::HashSet::new())),
            queues: Arc::new(Mutex::new(HashMap::new())),
            config: Arc::new(Mutex::new(mock_default_config())),
        }
    }

    fn emit(&self, ev: SessionDriverEvent) {
        let listeners = self.listeners.lock();
        for (_, tx) in listeners.iter() {
            let _ = tx.try_send(ev.clone());
        }
    }

    fn emit_queue(&self, session_id: &str) {
        let messages = self
            .queues
            .lock()
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        self.emit(SessionDriverEvent::QueueUpdated {
            base: SessionEventBase {
                session_ref: session_ref_for(session_id),
                timestamp: ts(),
                run_id: None,
            },
            messages,
        });
    }

    fn cancel_timers(&self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        *self.in_flight.lock() = None;
        self.pending_dialogs.lock().clear();
    }

    fn play_script(&self, steps: Vec<ScriptStep>) {
        // Serialize replays: instantly settle any in-flight script before starting a
        // new one — faithful port of TS `play()` → `flushScheduled()`. Two concurrent
        // timer sequences interleave their assistantDelta events, and foldEvent appends
        // each delta to whichever assistant is currently open — so an overlapping
        // greeting + reply splits one thinking block across two turns and leaks the
        // greeting's tail text into the reply. Flushing keeps the mock's
        // one-turn-at-a-time semantics, matching the real driver.
        self.flush_scheduled();

        let remaining: Arc<Mutex<VecDeque<ScriptStep>>> =
            Arc::new(Mutex::new(steps.into_iter().collect()));
        let drained = Arc::new(AtomicBool::new(false));
        let (flush_tx, mut flush_rx) = oneshot::channel::<()>();
        let script_id = self.next_script_id.fetch_add(1, Ordering::Relaxed);
        *self.in_flight.lock() = Some(InFlightHandle {
            script_id,
            remaining: remaining.clone(),
            drained: drained.clone(),
            flush_tx,
        });

        let listeners = self.listeners.clone();
        let gen_ctr = self.generation.clone();
        let start_gen = gen_ctr.load(Ordering::Relaxed);
        let pending = self.pending_dialogs.clone();
        let in_flight = self.in_flight.clone();
        tokio::spawn(async move {
            loop {
                // PEEK (don't pop) the front step while we may still sleep on it.
                // TS `play()` keeps every not-yet-fired timer entry in `scheduled`;
                // the timer only splices its entry out inside its own callback,
                // immediately before `fireStep`. We mirror that: the step stays in
                // the deque across the await so a flush can still drain + fire it.
                let wait_ms = {
                    let q = remaining.lock();
                    match q.front() {
                        Some(step) => step.wait_ms,
                        None => break,
                    }
                };
                if wait_ms > 0 {
                    // Race the delay against a flush. On the flush arm we return
                    // WITHOUT popping — the step is still in the deque, so the
                    // flusher's drain(..) picks it up and fires it. (No dropped step.)
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(wait_ms)) => {}
                        _ = &mut flush_rx => { return; }
                    }
                }
                // Abort if reset() was called since we started.
                if gen_ctr.load(Ordering::Relaxed) != start_gen {
                    return;
                }
                // The flusher may have drained + fired `remaining` while we slept
                // (it sets `drained` under the same lock). If so, skip pop+fire to
                // avoid duplicating a step the flusher already emitted. The drained
                // check + pop are atomic under one lock hold, matching the flusher's
                // atomic set-drained + drain — so the two can't interleave.
                //
                // ORDERING: fire_step runs UNDER the `remaining` lock (no `drop(q)`
                // first). Without this, on a multi-threaded runtime a flusher could
                // run in the gap between our pop and our fire: it takes the handle,
                // sets `drained`, drains+fires the LATER queued steps, then we resume
                // and fire this earlier step — emitting later steps before the popped
                // one and violating TS's strict step order (transcript fold order).
                // TS `play()` splices a timer entry out and calls `fireStep` in the
                // SAME synchronous JS callback; `flushScheduled` cannot run between
                // splice and fireStep on the single event loop. Holding the lock here
                // reproduces that atomicity: pop+fire is one critical section, so the
                // flusher's drain (which locks `remaining`) can't observe a popped-
                // but-unfired step — it only ever drains steps AFTER the one we fire.
                // fire_step is non-blocking (try_send + a HashMap insert), so holding
                // the lock across it is cheap and deadlock-free: it takes
                // `pending`→`listeners`, never the inverse, and no path takes
                // `remaining` after either.
                let fired_here = {
                    let mut q = remaining.lock();
                    if drained.load(Ordering::Relaxed) {
                        false
                    } else {
                        match q.pop_front() {
                            Some(step) => {
                                fire_step(&step, &listeners, &pending);
                                true
                            }
                            None => false,
                        }
                    }
                };
                if !fired_here {
                    // Either the queue was drained by the flusher (stop — it owns
                    // the rest) or it emptied naturally (loop will break next iter).
                    if drained.load(Ordering::Relaxed) {
                        return;
                    }
                }
            }
            // Script completed normally — clear the in-flight handle, but ONLY if it
            // still points at THIS task (compare-and-clear). A concurrent
            // `play_script` may have flushed us and installed a newer handle; we must
            // not null that out (TOCTOU).
            {
                let mut h = in_flight.lock();
                if let Some(current) = h.as_ref() {
                    if current.script_id == script_id {
                        *h = None;
                    }
                }
            }
        });
    }

    /// Fire all remaining steps of the in-flight script immediately, in order,
    /// then clear the handle. Mirrors TS `flushScheduled()` — cancelling timers
    /// and emitting each step so a new replay never overlaps the previous one.
    /// Invariant: fires EVERY not-yet-fired step (including the one the task is
    /// currently sleeping on, which stays in the deque), with zero dropped and
    /// zero duplicated (the `drained` flag makes the task skip pop+fire).
    fn flush_scheduled(&self) {
        let handle = { self.in_flight.lock().take() };
        if let Some(handle) = handle {
            // Mark drained BEFORE draining so the task, if it wakes from sleep
            // concurrently, sees `drained` and skips pop+fire (no double-fire).
            // The drain holds `remaining`, serializing against the task's pop+fire
            // (which now also fires UNDER that lock — see play_script). By the time
            // we release the lock the deque is EMPTY, so the task can't pop any of
            // the steps we drained: its next `front()` is None (break) and, even on
            // a racy re-entry, `drained` is set (return). That makes firing the
            // drained steps OUTSIDE the lock safe — we own all of them exclusively,
            // matching TS `flushScheduled`'s single synchronous clear+fire loop.
            let drained_steps: Vec<ScriptStep> = {
                let _ = handle.flush_tx.send(());
                handle.drained.store(true, Ordering::Relaxed);
                handle.remaining.lock().drain(..).collect()
            };
            let listeners = self.listeners.clone();
            let pending = self.pending_dialogs.clone();
            for step in drained_steps {
                fire_step(&step, &listeners, &pending);
            }
        }
    }
}

/// Emit one step's event plus its side bookkeeping. Shared by the timer path and
/// `flush_scheduled` so a flushed event behaves exactly like a fired one — faithful
/// port of TS `fireStep()`.
fn fire_step(
    step: &ScriptStep,
    listeners: &ListenerList,
    pending: &Arc<Mutex<std::collections::HashMap<String, PendingDialog>>>,
) {
    // Track dialog requests so respondUi can look them up later
    // (mirrors TS fireStep's pendingDialogs.set for hostUiRequest).
    if let SessionDriverEvent::HostUiRequest { base, request } = &step.event {
        if is_dialog_request(request) {
            pending.lock().insert(
                request_id_of(request).to_string(),
                PendingDialog {
                    request: request.clone(),
                    session_ref: base.session_ref.clone(),
                },
            );
        }
    }
    let listeners = listeners.lock();
    for (_, tx) in listeners.iter() {
        let _ = tx.try_send(step.event.clone());
    }
}

impl Default for MockDriver {
    fn default() -> Self {
        Self::new()
    }
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
            while let Some(ev) = rx.recv().await {
                listener(ev);
            }
        });
        id
    }

    fn unsubscribe(&self, id: usize) {
        self.listeners.lock().retain(|(sid, _)| *sid != id);
    }

    async fn prompt(
        &self,
        text: String,
        _deliver_as: Option<DeliveryMode>,
        session_id: Option<SessionId>,
        images: Vec<ImageContent>,
        prompt_id: Option<String>,
    ) -> Result<(), String> {
        // Faithful port of TS `MockDriver.prompt()` (`server/src/mock-driver.ts:381`):
        // the `__pilot_reject_prompt__` sentinel rejects (surfaces as a
        // `promptResult { accepted: false }` so the client shows "Not sent — …"),
        // then the deferred-creation first turn + normal demo-session reply.
        if text == "__pilot_reject_prompt__" {
            return Err("Mock prompt rejected before acceptance".into());
        }
        // Deferred-creation first turn: this prompt targets the session we JUST
        // created, so stream it under that session's own ref (not the demo
        // session's) and consume the one-shot marker. Subsequent prompts fall
        // through to the normal demo-session reply. (Mirrors TS prompt().)
        let pid = prompt_id.clone().unwrap_or_else(|| format!("u-{}", ts()));
        if let Some(session_id) = session_id {
            let taken = {
                let mut lc = self.last_created.lock();
                if lc
                    .as_ref()
                    .map(|c| c.session_id == session_id)
                    .unwrap_or(false)
                {
                    lc.take()
                } else {
                    None
                }
            };
            if let Some(created) = taken {
                let steps = new_session_reply(&created.snapshot, &text, &pid, &images);
                self.play_script(steps);
                return Ok(());
            }
        }
        let steps = prompt_reply_script(&text, Some(&pid));
        self.play_script(steps);
        Ok(())
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

    async fn clear_queue(&self, session_id: Option<SessionId>) -> ClearQueueResult {
        let sid = session_id.unwrap_or_else(|| SESSION_ID.into());
        let queued = {
            let mut queues = self.queues.lock();
            let queued = queues.get(&sid).cloned().unwrap_or_default();
            queues.insert(sid.clone(), Vec::new());
            queued
        };
        self.emit_queue(&sid);
        ClearQueueResult {
            steering: queued
                .iter()
                .filter(|message| message.mode == SessionMessageDeliveryMode::Steer)
                .map(|message| message.text.clone())
                .collect(),
            follow_up: queued
                .iter()
                .filter(|message| message.mode == SessionMessageDeliveryMode::FollowUp)
                .map(|message| message.text.clone())
                .collect(),
        }
    }

    fn respond_ui(&self, response: HostUiResponse, _session_id: Option<SessionId>) {
        let request_id = match &response {
            HostUiResponse::Value { request_id, .. } => request_id.clone(),
            HostUiResponse::Confirmed { request_id, .. } => request_id.clone(),
            HostUiResponse::Answers { request_id, .. } => request_id.clone(),
            HostUiResponse::Cancelled { request_id, .. } => request_id.clone(),
        };
        // Look up the pending dialog (mirrors TS pendingDialogs.get/delete) so we
        // can recover the Q&A questions for the answer tool's input + formatted text.
        let pending = self.pending_dialogs.lock().remove(&request_id);
        let session_ref = pending
            .as_ref()
            .map(|d| d.session_ref.clone())
            .unwrap_or_else(mock_session_ref);
        // Emit HostUiResolved to clear the dialog.
        self.emit(SessionDriverEvent::HostUiResolved {
            base: base_with_ref(session_ref.clone()),
            request_id: request_id.clone(),
        });

        match &response {
            HostUiResponse::Answers { answers, .. } => {
                // Q&A: mirror the real driver, where the `answer` tool records the
                // filled-in Q&A as its result. Emit a toolStarted/toolFinished pair
                // (not a notify) so the client's tool-result render path is exercised.
                let questions: Vec<QnaQuestion> = match &pending {
                    Some(d) => match &d.request {
                        HostUiRequest::Qna { questions, .. } => questions.clone(),
                        _ => Vec::new(),
                    },
                    None => Vec::new(),
                };
                let text = format_qna_text(&questions, answers);
                let call_id = format!("answer-{request_id}");
                self.emit(SessionDriverEvent::ToolStarted {
                    base: base_with_ref(session_ref.clone()),
                    call_id: call_id.clone(),
                    tool_name: "answer".into(),
                    label: Some("Answer".into()),
                    description: None,
                    input: Some(serde_json::json!({ "questions": questions })),
                });
                self.emit(SessionDriverEvent::ToolFinished {
                    base: base_with_ref(session_ref.clone()),
                    call_id,
                    success: true,
                    output: Some(serde_json::json!({
                        "content": [{ "type": "text", "text": text }]
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
                    base: base_with_ref(session_ref.clone()),
                    request: HostUiRequest::Notify {
                        request_id: format!("resolved-{request_id}"),
                        message: summary,
                        level: Some(NotifyLevel::Info),
                    },
                });
            }
        }
    }

    async fn list_sessions(&self) -> Vec<SessionListEntry> {
        // Faithful port of TS `listSessions()`: clone the mutable `sessions` list
        // and overlay each row's `worktree` field from the driver's `worktrees` map
        // (carrying `reaped` from the tombstone set). The static baseline rows carry
        // no worktree meta; rows `new_session` created under `worktree: true` do, so
        // the sidebar groups them under their parent project and shows the path chip.
        // (TS also overlays a transient `liveCountBumps` on `userMessageCount`; the
        // Rust mock never tracked that overlay — it's exercised only by specs outside
        // this fix's scope, so it's omitted here to avoid changing get_usage behavior.)
        let worktrees = self.worktrees.lock();
        let reaped = self.reaped_worktrees.lock();
        self.sessions
            .lock()
            .iter()
            .map(|s| {
                let mut s = s.clone();
                if let Some(meta) = worktrees.get(&s.cwd) {
                    s.worktree = Some(WorktreeInfo {
                        path: s.cwd.clone(),
                        base: meta.base.clone(),
                        name: meta.name.clone(),
                        reaped: if reaped.contains(&s.cwd) {
                            Some(true)
                        } else {
                            None
                        },
                    });
                }
                s
            })
            .collect()
    }

    async fn open_session(&self, path: String) -> Vec<SessionDriverEvent> {
        // Faithful port of TS MockDriver.openSession(): the base seed, then any
        // pending host-UI dialogs for this session appended to the end so opening
        // a background session blocked on an approval replays that dialog.
        let mut seed = mock_session_seed(&path);
        let session_id = seed.first().map(|e| e.session_ref().session_id.clone());
        if let Some(sid) = session_id {
            let queued = self.queues.lock().get(&sid).cloned().unwrap_or_default();
            for event in &mut seed {
                match event {
                    SessionDriverEvent::SessionOpened { snapshot, .. }
                    | SessionDriverEvent::SessionUpdated { snapshot, .. }
                    | SessionDriverEvent::RunCompleted { snapshot, .. } => {
                        snapshot.queued_messages = Some(queued.clone());
                    }
                    _ => {}
                }
            }

            let pending = self.pending_dialogs.lock();
            for (_, p) in pending.iter() {
                if p.session_ref.session_id == sid {
                    seed.push(SessionDriverEvent::HostUiRequest {
                        base: SessionEventBase {
                            session_ref: p.session_ref.clone(),
                            timestamp: ts(),
                            run_id: None,
                        },
                        request: p.request.clone(),
                    });
                }
            }
        }
        seed
    }

    /// Deterministic stand-in for the driver's dispose-and-re-warm. The mock has no
    /// warm AgentSession to throw away, so a reload is just a fresh seed of the same
    /// session — enough to exercise the hub's reseed path and the client wiring.
    /// (Faithful port of TS `MockDriver.reloadSession`, mock-driver.ts:649-651.)
    async fn reload_session(&self, path: String) -> Vec<SessionDriverEvent> {
        self.open_session(path).await
    }

    async fn branch_from(
        &self,
        entry_id: String,
        _summarize: bool,
        _session_id: Option<SessionId>,
    ) -> BranchResult {
        self.cancel_timers();
        let is_user = entry_id == "e-u1" || entry_id == "e-u2";
        if is_user {
            return BranchResult {
                seed: branched_seed(),
                editor_text: Some(if entry_id == "e-u1" {
                    GREETING_PROMPT.into()
                } else {
                    "actually, put it in a separate health-router module".into()
                }),
                cancelled: false,
                aborted: None,
            };
        }
        BranchResult {
            seed: greeting_seed(),
            editor_text: None,
            cancelled: false,
            aborted: None,
        }
    }

    async fn new_session(&self, opts: NewSessionOptsData) -> Vec<SessionDriverEvent> {
        // One-shot failure injection (armed via run_script("failnewsession")): fail before
        // any state mutation, mirroring TS `MockDriver.failNextNewSession`.
        if self.fail_next_new_session.swap(false, Ordering::SeqCst) {
            return Vec::new();
        }
        // Faithful port of TS `newSession()`: resolve the cwd (applying a
        // `-worktree` suffix when the draft asked for an isolated worktree) and
        // build a config carrying the chosen model's availableThinkingLevels +
        // the draft's (or default) thinking level, then hand the resolved dir +
        // config to `newSessionSeed`. Remember the snapshot so the first prompt
        // streams under this session's own ref — mirrors the real driver's
        // apply-on-create. Also records the worktree (so listSessions flags it) and
        // prepends a synthetic "new" row to the mutable session list (so the new
        // session appears in the sidebar immediately) — both faithful to TS.
        let NewSessionOptsData {
            cwd,
            worktree,
            model,
            thinking,
            facet,
            permission_monitor,
        } = opts;
        // base = cwd?.trim() || NEW_SESSION_ENTRY.cwd  (== WORKSPACE_PATH)
        let base = cwd
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| WORKSPACE_PATH.to_string());
        // dir = worktree ? `${base.replace(/\/+$/, "")}-worktree` : base
        // (clone in the non-worktree arm so `base` stays live for the worktree record below.)
        let dir = if worktree.unwrap_or(false) {
            format!("{}-worktree", base.trim_end_matches('/'))
        } else {
            base.clone()
        };
        // Record the worktree so listSessions flags the row with its parent project
        // for grouping + shows the isolated-path chip. A `dirty` base simulates
        // uncommitted changes (archive keeps it + reports worktreeRetained).
        // Mirrors TS: worktrees.set(dir, { base, name: `pilot-mock-${dir}` });
        // dirtyWorktrees.add(dir) when /(^|\/)dirty$/.test(base).
        if worktree.unwrap_or(false) {
            self.worktrees.lock().insert(
                dir.clone(),
                WorktreeMeta {
                    base: base.clone(),
                    name: format!("pilot-mock-{dir}"),
                },
            );
            if base
                .rsplit('/')
                .next()
                .map(|seg| seg == "dirty")
                .unwrap_or(false)
                || base == "dirty"
            {
                self.dirty_worktrees.lock().insert(dir.clone());
            }
        }
        // sessionId = dir === NEW_SESSION_ENTRY.cwd ? NEW_SESSION_ENTRY.sessionId : `new-${dir}`
        let session_id = if dir == WORKSPACE_PATH {
            "new-session".to_string()
        } else {
            format!("new-{dir}")
        };
        // Prepend a synthetic "new" row (unless one for this sessionId already
        // exists) so the new session shows in the sidebar — faithful port of TS
        // `this.sessions = [{ ...NEW_SESSION_ENTRY, sessionId, cwd: dir }, ...]`.
        {
            let mut sessions = self.sessions.lock();
            if !sessions.iter().any(|s| s.session_id == session_id) {
                sessions.insert(0, new_session_entry(&session_id, &dir));
            }
        }
        // Build the config: provider/modelId from the draft (or the default),
        // thinkingLevel from the draft (or the default), availableThinkingLevels
        // from the chosen model's entry in MOCK_MODELS (or the default).
        let default = mock_default_config();
        let chosen = model.as_ref().and_then(|m| {
            mock_models()
                .into_iter()
                .find(|opt| opt.provider == m.provider && opt.model_id == m.model_id)
        });
        let config = SessionConfig {
            provider: Some(
                model
                    .as_ref()
                    .map(|m| m.provider.clone())
                    .unwrap_or_else(|| default.provider.clone().unwrap()),
            ),
            model_id: Some(
                model
                    .as_ref()
                    .map(|m| m.model_id.clone())
                    .unwrap_or_else(|| default.model_id.clone().unwrap()),
            ),
            thinking_level: Some(
                thinking.unwrap_or_else(|| default.thinking_level.clone().unwrap()),
            ),
            available_thinking_levels: Some(
                chosen
                    .and_then(|m| m.thinking_levels)
                    .unwrap_or_else(|| default.available_thinking_levels.clone().unwrap()),
            ),
        };
        *self.config.lock() = config.clone();
        let permission_monitor = permission_monitor.unwrap_or(PermissionMonitorMode::Standard);
        let (events, snapshot) = new_session_seed(&dir, config, facet, permission_monitor);
        let session_id = snapshot.r#ref.session_id.clone();
        *self.last_created.lock() = Some(LastCreated {
            session_id,
            snapshot,
        });
        events
    }

    async fn set_archived(&self, path: String, archived: bool) -> ArchiveResult {
        // Faithful port of TS `setArchived()`: flip the row's `archived` flag in the
        // mutable session list, then — on archive — reap a (clean) mock worktree so
        // the indicator clears. A dirty worktree is kept and reported back so the
        // client explains the leftover (exactly as the real driver does).
        {
            let mut sessions = self.sessions.lock();
            for s in sessions.iter_mut() {
                if s.path == path {
                    s.archived = archived;
                }
            }
        }
        if archived {
            let cwd = self
                .sessions
                .lock()
                .iter()
                .find(|s| s.path == path)
                .map(|s| s.cwd.clone());
            if let Some(cwd) = cwd {
                let has_wt = self.worktrees.lock().contains_key(&cwd);
                let already_reaped = self.reaped_worktrees.lock().contains(&cwd);
                if has_wt && !already_reaped {
                    if self.dirty_worktrees.lock().contains(&cwd) {
                        return ArchiveResult {
                            worktree_retained: Some(WorktreeRetained {
                                path: cwd,
                                reason: "uncommitted changes".into(),
                            }),
                        };
                    }
                    // Tombstone, don't delete: keep the meta so the session keeps grouping.
                    self.reaped_worktrees.lock().insert(cwd);
                }
            }
        }
        ArchiveResult::default()
    }

    async fn cleanup_worktree(&self, path: String, _force: bool) -> WorktreeCleanupResult {
        // Faithful port of TS `cleanupWorktree()`. Mock worktrees are always clean,
        // so force is moot — just tombstone (mark reaped) rather than delete so the
        // orphaned session keeps grouping under its parent project.
        let has_wt = self.worktrees.lock().contains_key(&path);
        let already_reaped = self.reaped_worktrees.lock().contains(&path);
        if !has_wt || already_reaped {
            return WorktreeCleanupResult {
                removed: false,
                reason: Some("no pilot worktree at this path".into()),
            };
        }
        self.reaped_worktrees.lock().insert(path);
        WorktreeCleanupResult {
            removed: true,
            reason: None,
        }
    }

    async fn rename_session(&self, path: String, name: String) {
        // Faithful port of TS `renameSession()`: set the row's displayName to the
        // trimmed name (no-op on empty).
        let next = name.trim();
        if next.is_empty() {
            return;
        }
        let mut sessions = self.sessions.lock();
        for s in sessions.iter_mut() {
            if s.path == path {
                s.display_name = Some(next.to_string());
            }
        }
    }

    async fn list_models(&self) -> Vec<ModelOption> {
        mock_models()
    }
    async fn get_model_defaults(&self) -> ModelDefaults {
        let default = mock_default_config();
        ModelDefaults {
            provider: default.provider,
            model_id: default.model_id,
            thinking_level: default.thinking_level,
            favorites: Vec::new(),
        }
    }
    async fn list_commands(&self, _session_id: Option<SessionId>) -> Vec<CommandInfo> {
        mock_commands()
    }
    async fn list_facets(&self, _session_id: Option<SessionId>) -> Vec<String> {
        vec!["execute".into(), "plan".into(), "research".into()]
    }
    async fn list_file_index(&self, _session_id: Option<SessionId>) -> (Vec<FileInfo>, bool) {
        (mock_files(), false)
    }
    async fn list_files(
        &self,
        query: String,
        _session_id: Option<SessionId>,
        cwd: Option<String>,
    ) -> Vec<FileInfo> {
        // Faithful port of TS `MockDriver.listFiles()` (`server/src/mock-driver.ts:764-788`):
        // a new-session draft passes its target cwd — surface it as a synthetic
        // `<cwd>/DRAFT-CWD.md` match so the draft @-mention path
        // (Composer → store → hub → driver) is verifiable end-to-end; the real
        // driver actually searches that dir. A real session passes no cwd, so the
        // marker is absent. Then case-insensitive substring filter, sort by path
        // length, cap at 20.
        let mut pool: Vec<FileInfo> = mock_files();
        if let Some(cwd) = cwd {
            let trimmed = cwd.trim_end_matches('/');
            pool.insert(
                0,
                FileInfo {
                    path: format!("{trimmed}/DRAFT-CWD.md"),
                    is_directory: false,
                },
            );
        }
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return pool.into_iter().take(20).collect();
        }
        let mut matched: Vec<FileInfo> = pool
            .into_iter()
            .filter(|f| f.path.to_lowercase().contains(&q))
            .collect();
        // sort_by is stable; sort by path length to match TS.
        matched.sort_by_key(|f| f.path.len());
        matched.truncate(20);
        matched
    }
    async fn list_dir(&self, path: Option<String>) -> DirListing {
        // Faithful port of TS `listDir()`: resolve the (possibly-empty) path, look
        // it up in the synthetic MOCK_DIR_TREE, and return its entries + parent.
        // Empty → $HOME (the picker's default open). Unknown dirs come back empty
        // (the mock never touches the real disk). The picker navigates by `parent`
        // (Backspace-up) and child `entries`, so both must be right or it hangs.
        let dir = mock_resolve(path.as_deref());
        let parent = std::path::Path::new(&dir)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| p != &dir);
        let entries = mock_dir_tree().get(&dir).cloned().unwrap_or_default();
        DirListing {
            path: dir,
            parent,
            entries,
            error: None,
        }
    }
    async fn stat_path(&self, path: String) -> PathStat {
        // Faithful port of TS `statPath()`: existence comes from the synthetic
        // MOCK_DIR_TREE (never the real disk) so a typed-but-fixture path like
        // /Users/timo/src/demo reports as existing on a dev host where it doesn't.
        let abs = mock_resolve(Some(&path));
        let exists = mock_dir_tree().contains_key(&abs);
        PathStat {
            path: abs,
            exists,
            is_dir: exists,
        }
    }

    fn set_model(&self, provider: String, model_id: String, _session_id: Option<SessionId>) {
        let mut config = self.config.lock();
        config.provider = Some(provider);
        config.model_id = Some(model_id);
        let mut snapshot = snap(SessionStatus::Idle, None, None, None, None, None);
        snapshot.config = Some(config.clone());
        drop(config);
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot,
        });
    }
    fn set_thinking(&self, level: String, _session_id: Option<SessionId>) {
        let mut config = self.config.lock();
        config.thinking_level = Some(level);
        let mut snapshot = snap(SessionStatus::Idle, None, None, None, None, None);
        snapshot.config = Some(config.clone());
        drop(config);
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot,
        });
    }
    fn set_facet(&self, facet: String, _session_id: Option<SessionId>) {
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot: snap(SessionStatus::Idle, Some(facet), None, None, None, None),
        });
    }
    fn set_permission_monitor(&self, mode: PermissionMonitorMode, _session_id: Option<SessionId>) {
        let mut s = snap(SessionStatus::Idle, None, None, None, None, None);
        s.permission_monitor = Some(mode);
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot: s,
        });
    }

    async fn toggle_adventurous_handoff(&self, _session_id: Option<SessionId>) {
        // Flip the local flag and broadcast a sessionUpdated snapshot carrying the
        // new value — faithful port of the TS MockDriver.toggleAdventurousHandoff.
        let flipped = {
            let mut g = self.adventurous_handoff.lock().unwrap();
            *g = !*g;
            *g
        };
        let mut s = snap(SessionStatus::Idle, None, None, None, None, None);
        s.adventurous_handoff = Some(flipped);
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot: s,
        });
    }

    fn get_usage(&self, _session_id: Option<SessionId>) -> Option<SessionUsage> {
        let tokens = LIVE_USAGE_TOKENS.fetch_add(2800, Ordering::Relaxed) + 2800;
        let tokens = tokens.min(200000) as i64;
        let percent = ((tokens as f64 / 200000.0) * 1000.0).round() / 10.0;
        Some(SessionUsage {
            tokens: Some(tokens),
            context_window: 200000,
            percent: Some(percent),
        })
    }

    // Faithful port of TS `MockDriver.compact()` (`server/src/mock-driver.ts:860`):
    // drop usage to a small post-compaction residual (the daemon keeps a summary,
    // so context isn't zero), then notify "Context compacted". Does not reset
    // `liveUsageTokens`, mirroring the TS override exactly.
    async fn compact(&self, _session_id: Option<SessionId>) {
        self.emit(SessionDriverEvent::UsageUpdated {
            base: base(),
            usage: SessionUsage {
                tokens: Some(8000),
                context_window: 200000,
                percent: Some(4.0),
            },
        });
        self.emit(SessionDriverEvent::HostUiRequest {
            base: base(),
            request: HostUiRequest::Notify {
                request_id: format!("compact-done-{}", ts()),
                message: "Context compacted".into(),
                level: Some(NotifyLevel::Info),
            },
        });
    }

    // Faithful port of TS `MockDriver.clearContext()` (`server/src/mock-driver.ts:887`):
    // usage drops to zero so the ring renders "0%", then notify "Context cleared".
    async fn clear_context(&self, _session_id: Option<SessionId>) {
        self.emit(SessionDriverEvent::UsageUpdated {
            base: base(),
            usage: SessionUsage {
                tokens: Some(0),
                context_window: 200000,
                percent: Some(0.0),
            },
        });
        self.emit(SessionDriverEvent::HostUiRequest {
            base: base(),
            request: HostUiRequest::Notify {
                request_id: format!("clear-done-{}", ts()),
                message: "Context cleared".into(),
                level: Some(NotifyLevel::Info),
            },
        });
    }

    // Faithful port of TS `MockDriver.setNotificationAutodrain()`
    // (`server/src/mock-driver.ts:849-858`): set the flag and emit a
    // `sessionUpdated` whose snapshot carries `notificationAutodrain: enabled`
    // so the Settings toggle round-trips through the hub → client.
    async fn set_notification_autodrain(&self, enabled: bool, _session_id: Option<SessionId>) {
        let mut snapshot = mock_snapshot(SessionStatus::Idle);
        snapshot.notification_autodrain = Some(enabled);
        self.emit(SessionDriverEvent::SessionUpdated {
            base: base(),
            snapshot,
        });
    }

    fn default_seed(&self) -> Option<Vec<SessionDriverEvent>> {
        Some(greeting_seed())
    }

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
            // ── Additional scripts ────────────────────────────────────────
            "selectmany" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Select {
                    request_id: "req-select-many-1".into(),
                    title: "Which environment should I deploy to?".into(),
                    options: vec!["staging".into(), "production".into(), "canary".into()],
                    allow_multiple: None,
                    timeout_ms: None,
                } } },
            ],
            "planhandoff" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Plan {
                    request_id: "req-plan-handoff-1".into(),
                    title: "Plan handoff".into(),
                    plan_text: PLAN_HANDOFF_TEXT.into(),
                    display_path: Some("plan.md".into()),
                    target_facet: Some("execute".into()),
                    action_labels: ["Implement (new context)".into(), "Implement (current context)".into(), "Cancel".into()],
                    timeout_ms: None,
                } } },
            ],
            "planhandofftimeout" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Plan {
                    request_id: "req-plan-handoff-timeout-1".into(),
                    title: "Plan handoff (timed)".into(),
                    plan_text: "A short plan that will auto-dismiss on timeout.".into(),
                    display_path: Some("plan.md".into()),
                    target_facet: Some("execute".into()),
                    action_labels: ["Implement (new context)".into(), "Implement (current context)".into(), "Cancel".into()],
                    timeout_ms: Some(1200),
                } } },
            ],
            "planfacet" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(SessionStatus::Idle, Some("plan".into()), None, None, None, None) } },
                ScriptStep { wait_ms: 1500, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: snap(SessionStatus::Idle, Some("execute".into()), None, None, None, None) } },
            ],
            "permission" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::HostUiRequest { base: base(), request: HostUiRequest::Permission {
                    request_id: "req-permission-1".into(),
                    title: "Run bash?".into(),
                    tool_name: Some("shell_exec".into()),
                    tool_input: Some(serde_json::to_string_pretty(&serde_json::json!({"command": "rm -rf /tmp/test"})).unwrap_or_default()),
                    options: vec!["Deny".into(), "Allow once".into(), "Allow for session".into()],
                    timeout_ms: None,
                } } },
            ],
            "reset" => {
                let u_id = format!("u-reset-{}", ts());
                let mut s: Vec<ScriptStep> = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionReset { base: base() } },
                    ScriptStep { wait_ms: 20, event: SessionDriverEvent::UserMessage { base: base(), id: u_id.clone(), text: "Replayed prompt after the reset.".into(), images: None, entry_id: Some(format!("e-{u_id}")) } },
                ];
                for chunk in deltas("Transcript rebuilt from daemon history after a reset.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 40, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: Some(format!("e-{u_id}")), assistant_entry_id: Some(format!("e-a-{u_id}")) } });
                s
            }
            "images" => {
                let call_id = format!("img-{}", ts());
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Here's the current screen — can you mock up a cleaner layout?".into(), images: Some(vec![ImageContent::Image { data: SHOT_PNG_B64.into(), mime_type: "image/png".into() }]), entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Sure — let me render a quick mockup and show it to you.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                // Tool span with image output — built manually (tool_span doesn't support images).
                s.push(ScriptStep { wait_ms: 140, event: SessionDriverEvent::ToolStarted {
                    base: base(), call_id: call_id.clone(), tool_name: "render_mockup".into(),
                    label: Some("Render mockup".into()),
                    description: Some("Render a UI mockup to a PNG and return it".into()),
                    input: Some(serde_json::json!({"spec": "two-column layout, sticky header"})),
                } });
                advance_ts(900);
                s.push(ScriptStep { wait_ms: 320, event: SessionDriverEvent::ToolFinished {
                    base: base(), call_id, success: true,
                    output: Some(serde_json::json!({"content": [{"type": "text", "text": "Rendered mockup (160×100 PNG)."}]})),
                    images: Some(vec![ImageContent::Image { data: MOCKUP_PNG_B64.into(), mime_type: "image/png".into() }]),
                } });
                for chunk in deltas("Here's the mockup — a two-column layout with a sticky header. Want me to wire it up?", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 80, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "longoutput" => {
                let log: String = (1..=40).map(|i| format!("[{:02}] test/case-{}.spec.ts … ok ({}ms)", i, i, i * 3)).collect::<Vec<_>>().join("\n");
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Run the test suite and show me the output.".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Running the suite now.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.extend(tool_span("long-1", "bash", "Run shell command", Some("Execute a command in the workspace shell"),
                    serde_json::json!({"command": "bun test --reporter=verbose"}),
                    true, serde_json::json!(format!("{log}\n\n40 pass, 0 fail")),
                    120, 200, 620));
                for chunk in deltas("All 40 cases passed.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 80, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "markdown" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Show me a markdown formatting sample.".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas(MARKDOWN_SAMPLE, 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "search" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Where is the WebSocket reconnect logic?".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Let me poke around the codebase a few ways.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                for (cid, name, input, output) in [
                    ("r1", "read", serde_json::json!({"path": "client/src/lib/store.svelte.ts"}), serde_json::json!("// store.svelte.ts\n  private reconnect() { /* WS singleton backoff */ }")),
                    ("r2", "read", serde_json::json!({"path": "client/src/App.svelte"}), serde_json::json!("// App.svelte — mounts the store and the transcript")),
                    ("g1", "grep", serde_json::json!({"pattern": "reconnect", "path": "client/src"}), serde_json::json!("client/src/lib/store.svelte.ts:88:  private reconnect() {")),
                    ("g2", "grep", serde_json::json!({"pattern": "WebSocket", "path": "client/src"}), serde_json::json!("client/src/lib/store.svelte.ts:31:    this.ws = new WebSocket(url);")),
                    ("f1", "find", serde_json::json!({"pattern": "*.svelte", "path": "client/src/components"}), serde_json::json!("client/src/components/Transcript.svelte\nclient/src/components/ToolCard.svelte")),
                    ("b1", "bash", serde_json::json!({"command": "rg -n \"reconnect\" client/src/lib"}), serde_json::json!("client/src/lib/store.svelte.ts:88:  private reconnect() {")),
                ] {
                    s.extend(tool_span(cid, name, name, Some(&format!("Run {name}")), input, true, output, 40, 90, 180));
                }
                for chunk in deltas("Reconnect lives in the store's WS singleton.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "thinkingtools" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::UserMessage { base: base(), id: format!("u-{}", ts()), text: "Trace the reconnect path and check it end-to-end.".into(), images: None, entry_id: None } },
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                let c1 = format!("tbt-1-{}", ts());
                s.extend(tool_span(&c1, "bash", "bash", Some("Run bash"), serde_json::json!({"command": "ls client/src/lib"}), true, serde_json::json!("store.svelte.ts\nws.ts"), 40, 90, 180));
                for chunk in deltas("That lists the lib dir. The WS singleton is the likely home.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                let c2 = format!("tbt-2-{}", ts());
                s.extend(tool_span(&c2, "bash", "bash", Some("Run bash"), serde_json::json!({"command": "rg -n reconnect client/src"}), true, serde_json::json!("ws.ts:88: scheduleReconnect()"), 40, 90, 180));
                for chunk in deltas("Found the scheduler. Let me read the file to confirm the backoff.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                let c3 = format!("tbt-3-{}", ts());
                s.extend(tool_span(&c3, "read", "read", Some("Run read"), serde_json::json!({"path": "client/src/lib/ws.ts"}), true, serde_json::json!("// reconnecting WS singleton"), 40, 90, 180));
                for chunk in deltas("Backoff looks right. One more check on the call site.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Thinking), entry_id: None } });
                }
                let c4 = format!("tbt-4-{}", ts());
                s.extend(tool_span(&c4, "bash", "bash", Some("Run bash"), serde_json::json!({"command": "rg -n scheduleReconnect client/src"}), true, serde_json::json!("ws.ts:88\nws.ts:142"), 40, 90, 180));
                for chunk in deltas("Reconnect is wired correctly — exponential backoff, capped, re-armed on close.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s.push(ScriptStep { wait_ms: 60, event: SessionDriverEvent::RunCompleted { base: base(), snapshot: mock_snapshot(SessionStatus::Idle), user_entry_id: None, assistant_entry_id: None } });
                s
            }
            "streamhold" => {
                let mut s = vec![
                    ScriptStep { wait_ms: 0, event: SessionDriverEvent::SessionUpdated { base: base(), snapshot: mock_snapshot(SessionStatus::Running) } },
                ];
                for chunk in deltas("Working on it — this turn stays open for the test.", 3) {
                    s.push(ScriptStep { wait_ms: 28, event: SessionDriverEvent::AssistantDelta { base: base(), text: chunk, channel: Some(AssistantDeltaChannel::Text), entry_id: None } });
                }
                s
            }
            "contextfull" => vec![
                ScriptStep { wait_ms: 0, event: SessionDriverEvent::UsageUpdated { base: base(), usage: mock_usage_full() } },
            ],
            // ── Non-script controls (return early, no play_script) ─────────
            "queue" => {
                self.queues.lock().insert(
                    SESSION_ID.into(),
                    vec![
                        SessionQueuedMessage {
                            id: "queue-steer-fixture".into(),
                            mode: SessionMessageDeliveryMode::Steer,
                            text: "Please inspect the failing test first.".into(),
                            created_at: "queue-1".into(),
                            updated_at: "queue-1".into(),
                        },
                        SessionQueuedMessage {
                            id: "queue-followup-fixture".into(),
                            mode: SessionMessageDeliveryMode::FollowUp,
                            text: "Then summarize the fix and remaining risks.".into(),
                            created_at: "queue-2".into(),
                            updated_at: "queue-2".into(),
                        },
                    ],
                );
                self.emit_queue(SESSION_ID);
                return;
            }
            "deliverqueue" => {
                let next = {
                    let mut queues = self.queues.lock();
                    let queued = queues.entry(SESSION_ID.into()).or_default();
                    if queued.is_empty() {
                        None
                    } else {
                        Some(queued.remove(0))
                    }
                };
                if let Some(message) = next {
                    self.emit(SessionDriverEvent::QueuedMessageStarted {
                        base: base(),
                        message,
                    });
                    self.emit_queue(SESSION_ID);
                }
                return;
            }
            "failnewsession" => {
                self.fail_next_new_session.store(true, Ordering::SeqCst);
                return;
            }
            "failsession" => {
                warn!("[mock] run_script: {name} (not yet implemented — non-script control)");
                return;
            }
            _ => {
                warn!("[mock] run_script: {name} (not yet implemented)");
                return;
            }
        };
        self.play_script(steps);
    }

    fn reset(&self, _bootstrap: bool) {
        // Cancel all pending script tasks/dialogs + reset the mock clock so fixture
        // timestamps are deterministic across resets.
        self.cancel_timers();
        reset_ts();
        *self.last_created.lock() = None;
        self.fail_next_new_session.store(false, Ordering::SeqCst);
        *self.adventurous_handoff.lock().unwrap() = false;
        // Restore the mutable session/worktree state to the fixture baseline —
        // faithful port of TS `reset()`: `this.sessions = SESSION_LIST.map(...)`,
        // `this.worktrees = seedWorktrees(SESSION_LIST)`, clear dirty/reaped sets.
        // Without this, a `new_session`-created row + its worktree meta survive
        // `/debug/reset` and leak into the next test's sidebar.
        *self.sessions.lock() = mock_session_list();
        *self.worktrees.lock() = seed_worktrees(&mock_session_list());
        *self.config.lock() = mock_default_config();
        self.queues.lock().clear();
        self.dirty_worktrees.lock().clear();
        self.reaped_worktrees.lock().clear();
    }
}
