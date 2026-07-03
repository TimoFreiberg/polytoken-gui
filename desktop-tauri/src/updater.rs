//! Shell self-update via tauri-plugin-updater — the thing the Swift shell couldn't do
//! (ad-hoc signed bundles can't self-replace through the manual-rebuild path it used).
//! Artifacts are minisign-signed with OUR key; no Apple involvement.
//!
//! Two consumers:
//! - `spawn_check` — one-shot check (startup in clone mode, or the tray item; `manual`
//!   surfaces every outcome in a dialog).
//! - `spawn_periodic` — the **bundled-mode auto-update loop**. One updater artifact is
//!   the whole app (shell + hub + client), so this loop inherits the TS update-watcher's
//!   job AND its policy: unattended-and-idle → install + relaunch silently; anything
//!   else → defer, surface the sidebar update card by POSTing /update/state to the hub
//!   (exactly the wire the watcher used), and poll the same endpoint for the user's
//!   "Update now"/force click. The card, the notification dedupe, and the never-restart-
//!   mid-turn guarantee all carry over; only the payload changed (git pull+rebuild →
//!   signed bundle swap + app relaunch).
//!
//! The endpoint is deliberately not hardcoded: artifact hosting is still an open owner
//! decision (tangled remote → no GitHub releases; likely a Tailscale-served static dir).
//! Resolution order:
//!   1. PILOT_SHELL_UPDATE_URL env var
//!   2. a `shell-update-url` file in the data dir (one URL, trimmed)
//!   3. none → automatic checks stay dormant; the tray item says how to enable them.
//!      (The periodic loop keeps re-resolving, so dropping the file into the data dir
//!      enables updates without a relaunch.)

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;

/// One check at a time — a tray click during the startup check shouldn't stack dialogs,
/// and the periodic loop skips a cycle rather than racing a manual check's install.
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

// ───────────────────────── bundled-mode periodic loop ─────────────────────────

/// Manifest re-check cadence while up to date. Overridable for testing.
fn check_interval() -> Duration {
    let ms = std::env::var("PILOT_SHELL_UPDATE_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60_000);
    Duration::from_millis(ms.max(1_000))
}

/// Fast cadence while an update is staged — keeps the card's "Update now" responsive
/// (same 5s the TS watcher used for its /update/state poll).
const PENDING_POLL: Duration = Duration::from_secs(5);

pub fn spawn_periodic(app: AppHandle) {
    std::thread::spawn(move || {
        // First cycle immediately (the startup check), then pace by what it found.
        loop {
            let state = app.state::<AppState>();
            if state.updater_stop.load(Ordering::SeqCst) {
                return;
            }
            let wait = run_cycle(&app);
            let deadline = std::time::Instant::now() + wait;
            while std::time::Instant::now() < deadline {
                if app.state::<AppState>().updater_stop.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    });
}

/// One check-decide-act cycle. Returns how long to sleep before the next one.
fn run_cycle(app: &AppHandle) -> Duration {
    let state = app.state::<AppState>();
    let port = state.config.server_port;

    // Re-resolved every cycle so configuring the endpoint doesn't need a relaunch.
    let Some(endpoint) = endpoint(app) else {
        return check_interval();
    };
    // A manual tray check (with its dialogs) is mid-flight — try again shortly.
    if CHECK_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return PENDING_POLL;
    }
    let wait = run_cycle_locked(app, port, &endpoint);
    CHECK_IN_FLIGHT.store(false, Ordering::SeqCst);
    wait
}

fn run_cycle_locked(app: &AppHandle, port: u16, endpoint: &str) -> Duration {
    let update = match check_endpoint(app, endpoint) {
        Err(e) => {
            // Transient (offline, host down): keep the last reported card state and
            // retry at the slow cadence. Never clear the card on a flaky check.
            eprintln!("pilot: shell update check failed: {e}");
            return check_interval();
        }
        Ok(None) => {
            // Up to date. Tell the hub so a stale card clears (e.g. an update we
            // reported was published-then-yanked). Any pending force click is
            // meaningless with nothing to install — reading it here consumes it.
            report_update_state(port, None, false);
            return check_interval();
        }
        Ok(Some(u)) => u,
    };
    let version = update.version.clone();

    // Same policy as the TS watcher's decideAction: restart unattended only when
    // there's no open UI (not even a half-typed prompt) and no turn in flight.
    // /health unreachable → unattended-and-idle (nothing to interrupt), same as TS.
    let (clients, busy) = hub_activity(port);
    let unattended = clients == 0 && !busy;

    if !unattended {
        // Defer: raise/refresh the sidebar card and learn whether the user clicked.
        let (applying, force) = report_update_state(port, Some(&version), false);
        notify_once(app, &version);
        if !(applying || force) {
            return PENDING_POLL;
        }
    }

    let state = app.state::<AppState>();
    if state.updater_stop.load(Ordering::SeqCst) {
        return PENDING_POLL;
    }
    state.overlay.raise(app, "Updating Pilot…");
    eprintln!(
        "pilot: installing shell update {version} ({})",
        if unattended {
            "unattended"
        } else {
            "user-approved"
        }
    );
    match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
        Ok(()) => {
            // Relaunch = RunEvent::Exit teardown (hub SIGTERM'd) then exec of the new
            // bundle; its hub serves the new client and the webview reloads on health.
            app.request_restart();
            PENDING_POLL // unreached in practice; the event loop is exiting
        }
        Err(e) => {
            eprintln!("pilot: shell update install failed: {e}");
            state.overlay.hide(app);
            // applyFailed un-sticks the card's "Updating…" state so it offers retry.
            report_update_state(port, Some(&version), true);
            check_interval()
        }
    }
}

/// Build an updater against `endpoint` and check it. Blocking; error string flattened
/// (the loop logs it — no dialogs on the automatic path).
fn check_endpoint(
    app: &AppHandle,
    endpoint: &str,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let url = url::Url::parse(endpoint).map_err(|e| format!("invalid endpoint {endpoint}: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())
}

/// Deferred-update notification, once per version (the loop re-reports every cycle).
fn notify_once(app: &AppHandle, version: &str) {
    let state = app.state::<AppState>();
    let mut last = state.last_deferred.lock().unwrap();
    if last.as_deref() != Some(version) {
        *last = Some(version.to_string());
        crate::shell::notify(
            app,
            "Pilot update ready",
            &format!(
                "Pilot {version} is ready — it installs when your session is idle, or \
                 use the sidebar's Update now."
            ),
        );
    }
}

/// POST /update/state — the same wire the TS watcher drove the sidebar card with.
/// `version` Some → card up (sha field carries the version string); None → card
/// cleared. Returns (applying, force): did the user click the card / force-update?
/// Any transport error → (false, false): a flaky report must never trigger an install.
fn report_update_state(port: u16, version: Option<&str>, apply_failed: bool) -> (bool, bool) {
    let body = serde_json::json!({
        "available": version.is_some(),
        "sha": version,
        "applyFailed": apply_failed,
    })
    .to_string();
    let Some(resp) = http_loopback(port, "POST", "/update/state", Some(&body)) else {
        return (false, false);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&resp) else {
        return (false, false);
    };
    (
        v.get("applying").and_then(|b| b.as_bool()).unwrap_or(false),
        v.get("force").and_then(|b| b.as_bool()).unwrap_or(false),
    )
}

/// GET /health → (clients, busy). Unreachable/garbled → (0, false): if the hub isn't
/// answering there's no UI to interrupt and no turn to protect (the supervisor is
/// already respawning it) — mirrors the TS watcher's readHostState.
fn hub_activity(port: u16) -> (u64, bool) {
    let Some(body) = http_loopback(port, "GET", "/health", None) else {
        return (0, false);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
        return (0, false);
    };
    (
        v.get("clients").and_then(|c| c.as_u64()).unwrap_or(0),
        v.get("busy").and_then(|b| b.as_bool()).unwrap_or(false),
    )
}

/// Minimal loopback HTTP/1.1 over a raw TcpStream — same std-only posture as the
/// supervisor's health probe (no async runtime, no TLS: the hub is plain http on
/// 127.0.0.1). Connection: close + read-to-EOF keeps the parsing trivial. Returns the
/// body on a 200, None on anything else.
fn http_loopback(port: u16, method: &str, path: &str, json_body: Option<&str>) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(3))).ok()?;
    let body = json_body.unwrap_or("");
    let content_type = if json_body.is_some() {
        "Content-Type: application/json\r\n"
    } else {
        ""
    };
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\
         {content_type}Content-Length: {}\r\n\r\n{body}",
        body.len(),
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (head, rest) = text.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 200").then(|| rest.to_string())
}
