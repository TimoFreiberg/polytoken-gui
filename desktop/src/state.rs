//! Shared app state, managed by Tauri and reached from tray handlers / event threads.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::config::PantokenConfig;
use crate::shell::Overlay;
use crate::supervisor::Supervisor;

pub struct AppState {
    pub config: Arc<PantokenConfig>,
    pub supervisor: Mutex<Option<Supervisor>>,
    pub overlay: Overlay,
    /// Quit signal for the bundled-mode updater loop (a plain detached thread — this
    /// keeps it from starting an install/relaunch while teardown is in flight).
    pub updater_stop: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(config: PantokenConfig) -> Self {
        Self {
            config: Arc::new(config),
            supervisor: Mutex::new(None),
            overlay: Overlay::new(),
            updater_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Stop the updater loop first (so it can't start an install/relaunch mid-teardown),
    /// then the supervisor (SIGTERM → bounded wait → SIGKILL).
    /// Idempotent: the flag is sticky and the handle is take()n.
    pub fn teardown(&self) {
        self.updater_stop.store(true, Ordering::SeqCst);
        if let Some(mut s) = self.supervisor.lock().unwrap().take() {
            s.stop();
        }
    }
}
