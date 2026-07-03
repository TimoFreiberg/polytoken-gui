//! Pilot desktop shell (Tauri). Boots a local pilot server from the dedicated clone,
//! gates on /health, then shows the hub-served web client in a chromeless window and
//! starts the TS update-watcher. See desktop-tauri/README.md and docs/ADR-desktop-shell.md.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod config;
mod proc;
mod shell;
mod state;
mod supervisor;
mod updater;
mod watcher;

use tauri::{AppHandle, Manager, RunEvent};

use crate::config::{free_port, PilotConfig};
use std::sync::OnceLock;

use crate::state::AppState;
use crate::supervisor::{Supervisor, SupervisorEvent};
use crate::watcher::{Watcher, WatcherEvent};

/// Process start, for the launch-to-healthy stderr line (agent-legible perf probe).
static LAUNCHED: OnceLock<std::time::Instant> = OnceLock::new();

fn main() {
    // Block SIGTERM/SIGINT process-wide BEFORE any thread exists (threads inherit the
    // mask); a dedicated thread sigwait()s them into a normal app exit. Without this a
    // logout / launchd stop / plain `kill` tears the shell down WITHOUT RunEvent::Exit,
    // orphaning the hub and watcher it supervises.
    let term_signals = block_term_signals();
    LAUNCHED.set(std::time::Instant::now()).ok();

    tauri::Builder::default()
        // Must be first: a second launch hands off to us and exits before other plugins run.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            shell::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let port = free_port()?;
            let resource_dir = app.path().resource_dir()?;
            let handle = app.handle().clone();
            let (config, fatal) = match PilotConfig::resolve(port, &resource_dir) {
                Ok(c) => (c, None),
                // A resolve failure still wants the window + tray up so the fatal
                // dialog has an app to hang off — park a harmless fallback config
                // (nothing gets started; the dialog exits on dismiss).
                Err(message) => (PilotConfig::fallback(port), Some(message)),
            };
            app.manage(AppState::new(config));

            shell::create_main_window(&handle)?;
            shell::create_tray(&handle)?;

            if let Some(message) = fatal {
                shell::present_fatal(&handle, &message);
                return Ok(());
            }

            let state = app.state::<AppState>();
            let config = state.config.clone();

            // Clone mode runs everything from a dedicated checkout — a bare `.git` check
            // is enough (always a plain `git clone`, not a worktree). Fail with setup
            // instructions rather than a confusing blank window (present_fatal shows the
            // dialog on its own thread while the loading page sits underneath). Bundled
            // mode already verified its payload in resolve().
            if matches!(config.hub_mode, crate::config::HubMode::Clone)
                && !config.clone.join(".git").exists()
            {
                shell::present_fatal(
                    &handle,
                    &format!(
                        "No pilot checkout at {clone}.\n\nCreate it once:\n  git clone \
                         <pilot-repo> {clone}\n  cd {clone} && bun install && bun run \
                         build\n\nOr set PILOT_APP_CLONE to an existing checkout.",
                        clone = config.clone.display()
                    ),
                );
                return Ok(());
            }
            std::fs::create_dir_all(&config.data_dir)?;

            let supervisor = Supervisor::start(config.clone(), {
                let app = app.handle().clone();
                move |event| on_supervisor_event(&app, event)
            });
            state.supervisor.lock().unwrap().replace(supervisor);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pilot")
        .run_with_signals(term_signals);
}

trait RunWithSignals {
    fn run_with_signals(self, signals: libc::sigset_t);
}

impl RunWithSignals for tauri::App {
    fn run_with_signals(self, signals: libc::sigset_t) {
        let handle = self.handle().clone();
        std::thread::spawn(move || {
            let mut sig: libc::c_int = 0;
            unsafe { libc::sigwait(&signals, &mut sig) };
            eprintln!("pilot: received signal {sig}, shutting down");
            // Routes into RunEvent::Exit below — the same teardown as a normal quit.
            handle.exit(0);
        });
        self.run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<AppState>().teardown();
            }
        });
    }
}

/// Block SIGTERM/SIGINT for the whole process (called before any thread spawns, so every
/// thread inherits the mask) and return the set for the sigwait thread.
fn block_term_signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    }
}

fn on_supervisor_event(app: &AppHandle, event: SupervisorEvent) {
    let state = app.state::<AppState>();
    match event {
        SupervisorEvent::Healthy { first_time } => {
            if first_time {
                if let Some(t0) = LAUNCHED.get() {
                    eprintln!(
                        "pilot: hub healthy {}ms after launch",
                        t0.elapsed().as_millis()
                    );
                }
            }
            state.overlay.navigated();
            shell::navigate_main(app, &state.config.app_url());
            if first_time {
                match state.config.hub_mode {
                    // Clone mode: the TS update-watcher owns TS-payload updates; the
                    // Tauri updater covers only the shell (one startup check).
                    crate::config::HubMode::Clone => {
                        let watcher = Watcher::start(state.config.clone(), {
                            let app = app.clone();
                            move |event| on_watcher_event(&app, event)
                        });
                        state.watcher.lock().unwrap().replace(watcher);
                        // Startup shell-update check; silent when no endpoint is configured.
                        updater::spawn_check(app.clone(), false);
                    }
                    // Bundled mode: one artifact = shell + hub + client, so the shell's
                    // own update loop replaces the watcher — it drives the sidebar card
                    // over /update/state and applies via the Tauri updater.
                    crate::config::HubMode::Bundled { .. } => {
                        updater::spawn_periodic(app.clone());
                    }
                }
            }
        }
        SupervisorEvent::Unrecoverable(message) => {
            state.overlay.hide(app);
            shell::present_fatal(app, &message);
        }
    }
}

fn on_watcher_event(app: &AppHandle, event: WatcherEvent) {
    let state = app.state::<AppState>();
    match event {
        WatcherEvent::UpdateDeferred { remote } => {
            // The watcher re-emits every tick while an update is pending — buzz once per
            // new target commit.
            let mut last = state.last_deferred.lock().unwrap();
            if *last != remote {
                *last = remote;
                shell::notify(
                    app,
                    "Pilot update ready",
                    "A new version is ready — it applies when your session is idle, or \
                     use the sidebar's Update now.",
                );
            }
        }
        WatcherEvent::Apply { phase, label } => {
            if phase == "failed" {
                // The sidebar update card offers retry; just drop the scrim.
                state.overlay.hide(app);
            } else {
                state
                    .overlay
                    .raise(app, label.as_deref().unwrap_or("Updating Pilot…"));
            }
        }
    }
}
