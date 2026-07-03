//! A minimal stub driver for the Rust server that does nothing.
//! This is a placeholder until the real mock driver (fake daemon) and the
//! polytoken driver are ported (Phase 4/5). It lets the server boot and
//! accept WS connections with an empty landing.

use async_trait::async_trait;
use parking_lot::Mutex;
use pilot_protocol::session_driver::{
    CommandInfo, DirListing, FileInfo, ModelDefaults, ModelOption, PathStat, SessionDriverEvent,
    SessionId, SessionListEntry,
};
use pilot_protocol::wire::DeliveryMode;
use std::sync::Arc;

use crate::driver::PilotDriver;

type Listener = Box<dyn Fn(SessionDriverEvent) + Send + Sync>;

/// A stub driver that returns empty results for everything.
/// Used to boot the server without a real driver implementation.
pub struct StubDriver {
    listeners: Arc<Mutex<Vec<Listener>>>,
}

impl StubDriver {
    pub fn new() -> Self {
        Self {
            listeners: Arc::new(Mutex::new(Vec::new())),
        }
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
impl PilotDriver for StubDriver {
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

    async fn prompt(
        &self,
        _text: String,
        _deliver_as: Option<DeliveryMode>,
        _session_id: Option<SessionId>,
        _images: Vec<pilot_protocol::session_driver::ImageContent>,
        _prompt_id: Option<String>,
    ) {
    }

    fn abort(&self, _session_id: Option<SessionId>) {}

    fn respond_ui(
        &self,
        _response: pilot_protocol::session_driver::HostUiResponse,
        _session_id: Option<SessionId>,
    ) {
    }

    async fn list_sessions(&self) -> Vec<SessionListEntry> {
        Vec::new()
    }

    async fn open_session(&self, _path: String) -> Vec<SessionDriverEvent> {
        Vec::new()
    }

    async fn new_session(
        &self,
        _opts: crate::driver::NewSessionOptsData,
    ) -> Vec<SessionDriverEvent> {
        Vec::new()
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

    async fn list_file_index(
        &self,
        _session_id: Option<SessionId>,
    ) -> (Vec<FileInfo>, bool) {
        (Vec::new(), false)
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
        _mode: pilot_protocol::session_driver::PermissionMonitorMode,
        _session_id: Option<SessionId>,
    ) {
    }

    async fn get_model_defaults(&self) -> ModelDefaults {
        ModelDefaults::default()
    }
}
