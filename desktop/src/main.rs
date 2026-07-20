//! Pantoken desktop shell (Tauri). Boots a local pantoken server (bundled Rust sidecar
//! binary), gates on /health, then shows the hub-served web client in a chromeless
//! window. See desktop/README.md and docs/ADR-desktop-shell.md.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod bridge;
mod config;
mod mouse_nav;
mod proc;
mod provisioning;
mod remote_commands;
mod remote_connection;
mod remote_profile;
mod shell;
mod state;
mod supervisor;
mod updater;

use tauri::{AppHandle, Manager, RunEvent};

use crate::config::{free_port, PantokenConfig};
use std::sync::OnceLock;

use crate::state::AppState;
use crate::supervisor::{Supervisor, SupervisorEvent};

/// Process start, for the launch-to-healthy stderr line (agent-legible perf probe).
static LAUNCHED: OnceLock<std::time::Instant> = OnceLock::new();

fn main() {
    // Block SIGTERM/SIGINT process-wide BEFORE any thread exists (threads inherit the
    // mask); a dedicated thread sigwait()s them into a normal app exit. Without this a
    // logout / launchd stop / plain `kill` tears the shell down WITHOUT RunEvent::Exit,
    // orphaning the hub it supervises.
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
        .invoke_handler(tauri::generate_handler![
            remote_commands::list_remote_profiles,
            remote_commands::add_remote_profile,
            remote_commands::update_remote_profile,
            remote_commands::delete_remote_profile,
            remote_commands::connect_to_remote,
            remote_commands::disconnect_remote,
            remote_commands::remote_connection_state,
        ])
        .setup(|app| {
            let port = free_port()?;
            let resource_dir = app.path().resource_dir()?;
            let handle = app.handle().clone();
            let (config, fatal) = match PantokenConfig::resolve(port, &resource_dir) {
                Ok(c) => (c, None),
                // A resolve failure still wants the window + tray up so the fatal
                // dialog has an app to hang off — park a harmless fallback config
                // (nothing gets started; the dialog exits on dismiss).
                Err(message) => (PantokenConfig::fallback(port), Some(message)),
            };
            app.manage(AppState::new(config));

            shell::create_main_window(&handle)?;
            shell::create_tray(&handle)?;

            // Native macOS mouse thumb-button (back/forward) → webview nav.
            // No-op on non-macOS; the DOM onauxclick handler is the browser fallback.
            mouse_nav::install(app.handle().clone());

            if let Some(message) = fatal {
                shell::present_fatal(&handle, &message);
                return Ok(());
            }

            let state = app.state::<AppState>();
            let config = state.config.clone();

            std::fs::create_dir_all(&config.data_dir)?;

            let supervisor = Supervisor::start(config.clone(), {
                let app = app.handle().clone();
                move |event| on_supervisor_event(&app, event)
            });
            state.supervisor.lock().unwrap().replace(supervisor);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pantoken")
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
            eprintln!("pantoken: received signal {sig}, shutting down");
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
                        "pantoken: hub healthy {}ms after launch",
                        t0.elapsed().as_millis()
                    );
                }
            }
            state.overlay.navigated();
            shell::navigate_main(app, &state.config.app_url());
            if first_time {
                // One artifact = shell + hub + client, so the shell's own update loop
                // owns updates — it drives the sidebar card over /update/state and
                // applies via the Tauri updater.
                updater::spawn_periodic(app.clone());
            }
        }
        SupervisorEvent::Unrecoverable(message) => {
            state.overlay.hide(app);
            shell::present_fatal(app, &message);
        }
    }
}
