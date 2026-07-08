//! The seam between the WS hub and whatever produces session events. The mock
//! driver and the real polytoken driver both implement this, so the hub never
//! changes when we swap the fixture for a live agent.
//!
//! Port of `server/src/driver.ts`.

use async_trait::async_trait;
use pantoken_protocol::session_driver::{
    CommandInfo, DirListing, FileInfo, HostUiResponse, ImageContent, ModelDefaults, ModelOption,
    PathStat, PermissionMonitorMode, SessionDriverEvent, SessionId, SessionListEntry, SessionUsage,
};
use pantoken_protocol::wire::{DeliveryMode, LoginEnvStatus, McpAction};

/// Options for `PantokenDriver::new_session`. All optional: a bare new session
/// defaults to $HOME. The first `prompt` is delivered by the hub after
/// the switch, not by the driver.
#[derive(Debug, Clone, Default)]
pub struct NewSessionOptsData {
    pub cwd: Option<String>,
    pub worktree: Option<bool>,
    pub model: Option<NewSessionModel>,
    pub thinking: Option<String>,
    /// Facet to apply at creation (the draft's pick, e.g. start straight in plan).
    pub facet: Option<String>,
    /// Permission-monitor mode to apply at creation; omitted/"standard" = daemon default.
    pub permission_monitor: Option<PermissionMonitorMode>,
}

#[derive(Debug, Clone)]
pub struct NewSessionModel {
    pub provider: String,
    pub model_id: String,
}

/// Atomically clear and return the targeted session's text-only driver queues.
#[derive(Debug, Clone, Default)]
pub struct ClearQueueResult {
    pub steering: Vec<String>,
    pub follow_up: Vec<String>,
}

/// Result of archiving a session — may include a retained worktree.
#[derive(Debug, Clone, Default)]
pub struct ArchiveResult {
    pub worktree_retained: Option<WorktreeRetained>,
}

#[derive(Debug, Clone)]
pub struct WorktreeRetained {
    pub path: String,
    pub reason: String,
}

/// Result of branching from a tree entry.
#[derive(Debug, Clone, Default)]
pub struct BranchResult {
    pub seed: Vec<SessionDriverEvent>,
    pub editor_text: Option<String>,
    pub cancelled: bool,
    pub aborted: Option<bool>,
}

/// Result of cleaning up a worktree.
#[derive(Debug, Clone, Default)]
pub struct WorktreeCleanupResult {
    pub removed: bool,
    pub reason: Option<String>,
}

/// The driver seam. Both the mock (fake daemon) and the real polytoken driver
/// implement this trait. The hub owns a `Box<dyn PantokenDriver + Send + Sync>`.
///
/// Optional methods follow the TS pattern of `?.` optional chaining: the hub
/// guards with `if let Some(_)` before calling them. In Rust we represent this
/// as default implementations that return `None` or a not-supported error.
#[async_trait]
pub trait PantokenDriver: Send + Sync {
    /// Subscribe to driver events. Returns an unsubscribe function.
    fn subscribe(&self, listener: Box<dyn Fn(SessionDriverEvent) + Send + Sync>) -> usize;

    /// Unsubscribe by ID (returned by `subscribe`).
    fn unsubscribe(&self, id: usize);

    /// Send a prompt to the session. Returns `Err(message)` when the driver
    /// rejects the prompt (e.g. the mock's `__pantoken_reject_prompt__` sentinel, or
    /// the polytoken driver's no-warm-session / POST failures) so the hub can
    /// surface a `promptResult { accepted: false }` to the client. Ports the TS
    /// `Promise<void>` that rejects by throwing.
    async fn prompt(
        &self,
        text: String,
        deliver_as: Option<DeliveryMode>,
        session_id: Option<SessionId>,
        images: Vec<ImageContent>,
        prompt_id: Option<String>,
    ) -> Result<(), String>;

    /// Abort the current turn.
    fn abort(&self, session_id: Option<SessionId>);

    /// Atomically clear and return the targeted session's text-only driver queues.
    async fn clear_queue(&self, _session_id: Option<SessionId>) -> ClearQueueResult {
        ClearQueueResult::default()
    }

    /// Respond to a host UI request.
    fn respond_ui(&self, response: HostUiResponse, session_id: Option<SessionId>);

    /// Sessions on disk available to open.
    async fn list_sessions(&self) -> Vec<SessionListEntry>;

    /// Remove a pantoken-created worktree at `path`.
    async fn cleanup_worktree(&self, _path: String, _force: bool) -> WorktreeCleanupResult {
        WorktreeCleanupResult::default()
    }

    /// Archive or unarchive a session by its .jsonl path.
    async fn set_archived(&self, _path: String, _archived: bool) -> ArchiveResult {
        ArchiveResult::default()
    }

    /// The captured login-shell env status, surfaced in the Settings panel. The
    /// live `PolytokenDriver` overrides this with its real capture; mock/default
    /// drivers report `{ok:false}` (no capture ran). Synchronous — the concrete
    /// impl just reads an `RwLock`, and the hub call site is a non-async `&self`.
    fn login_env_status(&self) -> LoginEnvStatus {
        LoginEnvStatus {
            active_shell: None,
            ok: false,
            detail: None,
        }
    }

    /// Rename a session by its .jsonl path.
    async fn rename_session(&self, _path: String, _name: String) {}

    /// Switch the active session to the given .jsonl path. Resolves with the SEED
    /// events for the now-active session, or `Err(message)` on a failure (e.g.
    /// the mock's one-shot `failsession` 409 lease conflict, or a real
    /// claim-lease 409) so `switch_to` can classify + surface a client-visible
    /// `Error`. Ports the TS `Promise<SessionDriverEvent[]>` that throws.
    async fn open_session(&self, path: String) -> Result<Vec<SessionDriverEvent>, String>;

    /// Reload a session from scratch by its .jsonl path.
    async fn reload_session(&self, path: String) -> Result<Vec<SessionDriverEvent>, String> {
        // Default: same as open_session (the mock's reload delegates to open).
        self.open_session(path).await
    }

    /// The landing session a freshly-connecting client adopts.
    fn default_seed(&self) -> Option<Vec<SessionDriverEvent>> {
        None
    }

    /// Create a fresh session and make it active; resolves with its seed events,
    /// or `Err(message)` on a failure (e.g. an invalid cwd, or a spawn failure)
    /// so `switch_to` can classify + surface a client-visible `Error` — the same
    /// path `open_session` uses. Ports the TS `Promise<SessionDriverEvent[]>`
    /// that throws.
    async fn new_session(
        &self,
        opts: NewSessionOptsData,
    ) -> Result<Vec<SessionDriverEvent>, String>;

    /// Jump the session to a prior tree entry and branch from it.
    async fn branch_from(
        &self,
        _entry_id: String,
        _summarize: bool,
        _session_id: Option<SessionId>,
    ) -> BranchResult {
        BranchResult::default()
    }

    /// The current context-window fill for a (warm) session.
    fn get_usage(&self, _session_id: Option<SessionId>) -> Option<SessionUsage> {
        None
    }

    /// Models available to switch to.
    async fn list_models(&self) -> Vec<ModelOption>;

    /// Slash commands the targeted session offers.
    async fn list_commands(&self, session_id: Option<SessionId>) -> Vec<CommandInfo>;

    /// Available facet names for the focused session's cwd.
    async fn list_facets(&self, session_id: Option<SessionId>) -> Vec<String>;

    /// The full file index for a session's cwd.
    async fn list_file_index(&self, session_id: Option<SessionId>) -> (Vec<FileInfo>, bool);

    /// Fallback file search for a composer @-mention query.
    async fn list_files(
        &self,
        query: String,
        session_id: Option<SessionId>,
        cwd: Option<String>,
    ) -> Vec<FileInfo>;

    /// List a directory's child directories for the new-session project picker.
    async fn list_dir(&self, path: Option<String>) -> DirListing;

    /// Quick existence + type check for a path.
    async fn stat_path(&self, path: String) -> PathStat;

    /// Switch a session's model.
    fn set_model(&self, provider: String, model_id: String, session_id: Option<SessionId>);

    /// Switch a session's thinking level.
    fn set_thinking(&self, level: String, session_id: Option<SessionId>);

    /// Switch a session's active facet.
    fn set_facet(&self, facet: String, session_id: Option<SessionId>);

    /// Switch the active permission-monitor mode.
    fn set_permission_monitor(&self, mode: PermissionMonitorMode, session_id: Option<SessionId>);

    /// Toggle the adventurous auto-handoff flag.
    async fn toggle_adventurous_handoff(&self, _session_id: Option<SessionId>) {}

    /// Set the notification auto-drain flag.
    async fn set_notification_autodrain(&self, _enabled: bool, _session_id: Option<SessionId>) {}

    /// Trigger context compaction.
    async fn compact(&self, _session_id: Option<SessionId>) {}

    /// Clear the session's context entirely.
    async fn clear_context(&self, _session_id: Option<SessionId>) {}

    /// Manage an MCP server.
    async fn set_mcp_server(
        &self,
        _server_name: String,
        _action: McpAction,
        _session_id: Option<SessionId>,
    ) {
    }

    /// The daemon's global default model/thinking for new sessions.
    async fn get_model_defaults(&self) -> ModelDefaults {
        ModelDefaults::default()
    }

    /// Wire a live predicate the driver can poll to learn whether SOME connected
    /// client is currently viewing a given session.
    fn set_session_viewers(&self, _is_viewed: Box<dyn Fn(SessionId) -> bool + Send + Sync>) {}

    /// Graceful teardown of driver-owned resources on a clean server exit.
    async fn shutdown(&self) {}

    /// Dev-only: jump the mock to a named scripted state.
    fn run_script(&self, _name: String) {}

    /// Dev/test-only reset.
    fn reset(&self, _bootstrap: bool) {}
}
