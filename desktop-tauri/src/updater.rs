//! Shell self-update via tauri-plugin-updater — the thing the Swift shell couldn't do
//! (ad-hoc signed bundles can't self-replace through the manual-rebuild path it used).
//! Artifacts are minisign-signed with OUR key; no Apple involvement.
//!
//! The endpoint is deliberately not hardcoded: artifact hosting is still an open owner
//! decision (tangled remote → no GitHub releases; likely a Tailscale-served static dir).
//! Resolution order:
//!   1. PILOT_SHELL_UPDATE_URL env var
//!   2. a `shell-update-url` file in the data dir (one URL, trimmed)
//!   3. none → automatic checks stay dormant; the tray item says how to enable them.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;

/// One check at a time — a tray click during the startup check shouldn't stack dialogs.
static CHECK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

pub fn endpoint(app: &AppHandle) -> Option<String> {
    if let Ok(url) = std::env::var("PILOT_SHELL_UPDATE_URL") {
        if !url.trim().is_empty() {
            return Some(url.trim().to_string());
        }
    }
    let state = app.state::<AppState>();
    let path = state.config.data_dir.join("shell-update-url");
    let url = std::fs::read_to_string(path).ok()?.trim().to_string();
    (!url.is_empty()).then_some(url)
}

/// Check for a shell update on a background thread. `manual` (tray click) surfaces every
/// outcome in a dialog; the automatic startup check stays silent unless there IS one.
pub fn spawn_check(app: AppHandle, manual: bool) {
    if CHECK_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        run_check(&app, manual);
        CHECK_IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

fn run_check(app: &AppHandle, manual: bool) {
    let Some(endpoint) = endpoint(app) else {
        if manual {
            let state = app.state::<AppState>();
            app.dialog()
                .message(format!(
                    "No shell update endpoint is configured, so the app can't look for \
                     new builds.\n\nSet PILOT_SHELL_UPDATE_URL, or put the manifest URL \
                     in {}.",
                    state.config.data_dir.join("shell-update-url").display()
                ))
                .title("Shell updates not configured")
                .blocking_show();
        }
        return;
    };
    let Ok(url) = url::Url::parse(&endpoint) else {
        eprintln!("pilot: invalid shell update endpoint: {endpoint}");
        return;
    };

    let updater = match app.updater_builder().endpoints(vec![url]) {
        Ok(b) => match b.build() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("pilot: updater build failed: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("pilot: updater endpoint rejected: {e}");
            return;
        }
    };

    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(u)) => u,
        Ok(None) => {
            if manual {
                app.dialog()
                    .message(format!(
                        "You're on the latest shell ({}).",
                        app.package_info().version
                    ))
                    .title("Pilot is up to date")
                    .blocking_show();
            }
            return;
        }
        Err(e) => {
            eprintln!("pilot: update check failed: {e}");
            if manual {
                app.dialog()
                    .message(format!("Couldn't check for updates:\n{e}"))
                    .title("Update check failed")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
            return;
        }
    };

    // PILOT_SHELL_UPDATE_AUTO=1 installs startup-check updates without asking — the
    // unattended dogfood posture (mirrors the TS watcher's apply-when-idle policy).
    // Manual tray checks always ask.
    let auto = !manual && std::env::var("PILOT_SHELL_UPDATE_AUTO").as_deref() == Ok("1");
    if !auto {
        let install = app
            .dialog()
            .message(format!(
                "Pilot shell {} is available (you have {}). Install and relaunch?\n\nThe \
                 hub restarts with it; your phone reconnects automatically.",
                update.version,
                app.package_info().version
            ))
            .title("Shell update available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Install & Relaunch".into(),
                "Later".into(),
            ))
            .blocking_show();
        if !install {
            return;
        }
    }

    let state = app.state::<AppState>();
    state.overlay.raise(app, "Updating Pilot shell…");
    let result = tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {}));
    match result {
        Ok(()) => {
            // The event-loop-mediated restart: RunEvent::Exit fires first (teardown
            // SIGTERMs the hub + watcher), then the new binary execs. Plain restart()
            // from a non-main thread does the same, but this is the documented-reliable
            // variant.
            app.request_restart();
        }
        Err(e) => {
            state.overlay.hide(app);
            app.dialog()
                .message(format!("Installing the update failed:\n{e}"))
                .title("Update failed")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}
