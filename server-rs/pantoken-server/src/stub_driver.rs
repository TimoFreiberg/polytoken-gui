//! A minimal stub driver for the Rust server that does nothing.
//! This is a placeholder until the real mock driver (fake daemon) and the
//! polytoken driver are ported (Phase 4/5). It lets the server boot and
//! accept WS connections with an empty landing.

use async_trait::async_trait;
use pantoken_protocol::session_driver::{
    AtRefs, CommandInfo, DirListing, FileInfo, ModelDefaults, ModelOption, PathStat,
    SessionDriverEvent, SessionId, SessionListEntry,
};
use pantoken_protocol::wire::{DeliveryMode, LoginEnvStatus};
use parking_lot::Mutex;
use std::sync::Arc;

use crate::driver::PantokenDriver;

type Listener = Box<dyn Fn(SessionDriverEvent) + Send + Sync>;

/// A stub driver that returns empty results for everything.
/// Used to boot the server without a real driver implementation.
pub struct StubDriver {
    listeners: Arc<Mutex<Vec<Listener>>>,
    login_env_status: LoginEnvStatus,
    abort_error: Option<String>,
}

impl StubDriver {
    pub fn new() -> Self {
        Self {
            listeners: Arc::new(Mutex::new(Vec::new())),
            login_env_status: LoginEnvStatus {
                active_shell: None,
                ok: false,
                detail: None,
            },
            abort_error: None,
        }
    }

    /// Report a specific login-env status. The hub reads this via the
    /// `PantokenDriver` trait for the Settings panel.
    pub fn with_login_env_status(mut self, status: LoginEnvStatus) -> Self {
        self.login_env_status = status;
        self
    }

    pub fn with_abort_error(mut self, error: impl Into<String>) -> Self {
        self.abort_error = Some(error.into());
        self
    }

    pub fn emit(&self, ev: SessionDriverEvent) {
        let listeners = self.listeners.lock();
        for l in listeners.iter() {
            l(ev.clone());
        }
    }
}

impl Default for StubDriver {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PantokenDriver for StubDriver {
    fn subscribe(&self, listener: Box<dyn Fn(SessionDriverEvent) + Send + Sync>) -> usize {
        let mut listeners = self.listeners.lock();
        let id = listeners.len();
        listeners.push(listener);
        id
    }

    fn unsubscribe(&self, id: usize) {
        let mut listeners = self.listeners.lock();
        let _ = listeners.remove(id);
    }

    fn login_env_status(&self) -> LoginEnvStatus {
        self.login_env_status.clone()
    }

    async fn prompt(
        &self,
        _text: String,
        _deliver_as: Option<DeliveryMode>,
        _session_id: Option<SessionId>,
        _images: Vec<pantoken_protocol::session_driver::ImageContent>,
        _prompt_id: Option<String>,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn abort(&self, _session_id: Option<SessionId>) -> Result<(), String> {
        match &self.abort_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn respond_ui(
        &self,
        _response: pantoken_protocol::session_driver::HostUiResponse,
        _session_id: Option<SessionId>,
    ) {
    }

    async fn list_sessions(&self) -> Vec<SessionListEntry> {
        Vec::new()
    }

    async fn open_session(&self, _path: String) -> Result<Vec<SessionDriverEvent>, String> {
        Ok(Vec::new())
    }

    async fn new_session(
        &self,
        _opts: crate::driver::NewSessionOptsData,
    ) -> Result<Vec<SessionDriverEvent>, String> {
        Ok(Vec::new())
    }

    async fn list_models(&self) -> Vec<ModelOption> {
        Vec::new()
    }

    async fn list_commands(&self, _session_id: Option<SessionId>) -> Vec<CommandInfo> {
        Vec::new()
    }

    async fn list_facets(&self, _session_id: Option<SessionId>) -> Vec<String> {
        vec!["execute".into(), "plan".into()]
    }

    async fn list_file_index(&self, _session_id: Option<SessionId>) -> (Vec<FileInfo>, bool) {
        (Vec::new(), false)
    }

    async fn list_at_refs(&self, _session_id: Option<SessionId>) -> AtRefs {
        AtRefs::default()
    }

    async fn list_files(
        &self,
        _query: String,
        _session_id: Option<SessionId>,
        _cwd: Option<String>,
    ) -> Vec<FileInfo> {
        Vec::new()
    }

    async fn list_dir(&self, _path: Option<String>) -> DirListing {
        DirListing {
            path: String::new(),
            parent: None,
            entries: Vec::new(),
            error: None,
        }
    }

    async fn stat_path(&self, path: String) -> PathStat {
        PathStat {
            path,
            exists: false,
            is_dir: false,
        }
    }

    fn set_model(&self, _provider: String, _model_id: String, _session_id: Option<SessionId>) {}

    fn set_thinking(&self, _level: String, _session_id: Option<SessionId>) {}

    fn set_facet(&self, _facet: String, _session_id: Option<SessionId>) {}

    fn set_permission_monitor(
        &self,
        _mode: pantoken_protocol::session_driver::PermissionMonitorMode,
        _session_id: Option<SessionId>,
    ) {
    }

    async fn get_model_defaults(&self) -> ModelDefaults {
        ModelDefaults::default()
    }
}
