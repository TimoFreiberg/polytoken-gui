//! Shared app state, managed by Tauri and reached from tray handlers / event threads.

use std::sync::{Arc, Mutex};

use crate::config::PilotConfig;
use crate::shell::Overlay;
use crate::supervisor::Supervisor;
use crate::watcher::Watcher;

pub struct AppState {
    pub config: Arc<PilotConfig>,
    pub supervisor: Mutex<Option<Supervisor>>,
    pub watcher: Mutex<Option<Watcher>>,
    pub overlay: Overlay,
    /// Target sha of the last update-deferred notification — the watcher re-emits the
    /// event every tick while an update is pending; notify once per new target.
    pub last_deferred: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(config: PilotConfig) -> Self {
        Self {
            config: Arc::new(config),
            supervisor: Mutex::new(None),
            watcher: Mutex::new(None),
            overlay: Overlay::new(),
            last_deferred: Mutex::new(None),
        }
    }

    /// Stop the watcher first (so it can't SIGTERM the server mid-teardown), then the
    /// supervisor (SIGTERM → bounded wait → SIGKILL). Idempotent: both are take()n.
    pub fn teardown(&self) {
        if let Some(w) = self.watcher.lock().unwrap().take() {
            w.stop();
        }
        if let Some(mut s) = self.supervisor.lock().unwrap().take() {
            s.stop();
        }
    }
}
