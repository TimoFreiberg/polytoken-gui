//! The visible shell: main window (chromeless, hosting the hub-served web client), tray
//! (close-to-tray keeps the hub — and any phone connection — alive), the "Updating
//! Pilot…" overlay, notifications, and the fatal-error dialog.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

pub const MAIN_WINDOW: &str = "main";

/// Build the main window on the bundled "Starting Pilot…" page. The supervisor navigates
/// it to the hub URL once /health answers. Chromeless: transparent titlebar, traffic
/// lights floating over the client's own header — same look as the Swift shell.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let handle = app.clone();
    let mut builder =
        WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
            .title("Pilot")
            .inner_size(1100.0, 760.0)
            .center()
            .on_navigation(move |url| {
                // Keep the chromeless window on the app's own pages: the bundled loading page
                // (tauri://) and the local hub (127.0.0.1/localhost). Anything else — a clicked
                // external link — goes to the system browser instead.
                if is_app_local(url) {
                    return true;
                }
                if matches!(url.scheme(), "http" | "https") {
                    let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                }
                false
            })
            .on_download(on_download_handler(app.clone()));
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    let window = builder.build()?;

    // Close-to-tray: the window hides, the process (and therefore the hub and every phone
    // connection) stays alive. Accessory policy so no zombie Dock icon while hidden.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
                let _ = w.hide();
            }
            #[cfg(target_os = "macos")]
            let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    });
    Ok(())
}

fn is_app_local(url: &url::Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost")
    )
}

/// Downloads auto-save to ~/Downloads with a collision-free name (Chrome-style), then
/// notify. The Swift shell showed a save panel instead; the download hook here runs on
/// the main thread where a blocking panel would deadlock, and auto-save is the better
/// default anyway for the rare in-app download.
fn on_download_handler(
    app: AppHandle,
) -> impl Fn(tauri::webview::Webview, tauri::webview::DownloadEvent<'_>) -> bool + Send + Sync {
    move |_webview, event| {
        match event {
            tauri::webview::DownloadEvent::Requested { url, destination } => {
                let suggested = destination
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .filter(|n| !n.is_empty())
                    .or_else(|| {
                        url.path_segments()
                            .and_then(|mut s| s.next_back())
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                    })
                    .unwrap_or_else(|| "download".to_string());
                let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
                    .join("Downloads");
                *destination = unique_path(&dir, &suggested);
            }
            tauri::webview::DownloadEvent::Finished { path, success, .. } => {
                let body = match (&path, success) {
                    (Some(p), true) => format!(
                        "Saved {} to Downloads.",
                        p.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    ),
                    _ => "Download failed.".to_string(),
                };
                let _ = app
                    .notification()
                    .builder()
                    .title(if success {
                        "Download complete"
                    } else {
                        "Download failed"
                    })
                    .body(body)
                    .show();
            }
            _ => {}
        }
        true
    }
}

fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for i in 1..1000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    dir.join(name)
}

/// Show + focus the main window (tray "Open", second-instance launch, notification click).
pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn navigate_main(app: &AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if let Ok(parsed) = url::Url::parse(url) {
            let _ = w.navigate(parsed);
        }
    }
}

/// Fatal path — dialog then exit, like the Swift shell's presentFatal. The dialog runs
/// on its own thread so the CALLER never blocks: the supervisor thread reports fatal and
/// returns, which keeps quit-teardown's thread-join deadlock-free even with the dialog up.
pub fn present_fatal(app: &AppHandle, message: &str) {
    eprintln!("pilot: fatal: {message}");
    let app = app.clone();
    let message = message.to_string();
    std::thread::spawn(move || {
        app.dialog()
            .message(&message)
            .title("Pilot can't start")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        app.exit(1);
    });
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// ───────────────────────────── update overlay ─────────────────────────────
// The frosted "Updating Pilot…" scrim, painted INTO the page via eval rather than as a
// native view: the DOM freezes during the apply (the client's WS is dying anyway), the
// post-update navigation replaces the document — which tears the scrim down for free —
// and a failsafe timer catches an apply that never completes. Shell-owned, not served:
// the web client is exactly what's restarting, so it can't paint its own progress.

pub struct Overlay {
    pending: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}

impl Overlay {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn raise(&self, app: &AppHandle, label: &str) {
        self.pending.store(true, Ordering::SeqCst);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
            let label_js =
                serde_json::to_string(label).unwrap_or_else(|_| "\"Updating Pilot…\"".into());
            let _ = w.eval(raise_js(&label_js));
        }
        // Failsafe: drop the overlay if the teardown signal never arrives, so a modal
        // scrim can't strand the window forever. Re-armed at every phase; 5 min
        // comfortably outlasts the longest single phase (a cold bun install).
        let app = app.clone();
        let pending = self.pending.clone();
        let gen_ref = self.generation.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(300));
            if pending.load(Ordering::SeqCst) && gen_ref.load(Ordering::SeqCst) == generation {
                eprintln!("pilot: update overlay failsafe fired — tearing it down");
                pending.store(false, Ordering::SeqCst);
                if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = w.eval(HIDE_JS);
                }
            }
        });
    }

    pub fn hide(&self, app: &AppHandle) {
        self.pending.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
            let _ = w.eval(HIDE_JS);
        }
    }

    /// The post-update navigation replaced the document — the scrim is gone with it.
    /// Just settle the bookkeeping so the failsafe stays quiet.
    pub fn navigated(&self) {
        self.pending.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

fn raise_js(label_json: &str) -> String {
    format!(
        r#"(() => {{
  let o = document.getElementById('pilot-native-overlay');
  if (!o) {{
    o = document.createElement('div');
    o.id = 'pilot-native-overlay';
    o.innerHTML = '<div class="pno-spin"></div><div class="pno-label"></div>';
    const st = document.createElement('style');
    st.textContent = `
      #pilot-native-overlay {{ position: fixed; inset: 0; z-index: 2147483647;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 18px; background: rgba(30,30,28,.45);
        backdrop-filter: blur(22px) saturate(120%); -webkit-backdrop-filter: blur(22px) saturate(120%);
        opacity: 0; transition: opacity .18s ease; }}
      #pilot-native-overlay .pno-spin {{ width: 30px; height: 30px; border-radius: 50%;
        border: 3px solid rgba(255,255,255,.25); border-top-color: rgba(255,255,255,.85);
        animation: pno-rot .8s linear infinite; }}
      #pilot-native-overlay .pno-label {{ color: rgba(255,255,255,.82);
        font: 500 13px -apple-system, system-ui, sans-serif; }}
      @keyframes pno-rot {{ to {{ transform: rotate(360deg); }} }}`;
    o.appendChild(st);
    document.documentElement.appendChild(o);
    requestAnimationFrame(() => {{ o.style.opacity = '1'; }});
  }}
  o.style.opacity = '1';
  const l = o.querySelector('.pno-label');
  if (l) l.textContent = {label_json};
}})();"#
    )
}

const HIDE_JS: &str = r#"(() => {
  const o = document.getElementById('pilot-native-overlay');
  if (o) { o.style.opacity = '0'; setTimeout(() => o.remove(), 220); }
})();"#;

// ───────────────────────────────── tray ─────────────────────────────────

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Pilot").build(app)?;
    let copy_url = MenuItemBuilder::with_id("copy-url", "Copy App URL").build(app)?;
    let restart = MenuItemBuilder::with_id("restart-hub", "Restart Hub").build(app)?;
    let updates =
        MenuItemBuilder::with_id("check-updates", "Check for Shell Updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Pilot").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open])
        .item(&PredefinedMenuItem::separator(app)?)
        .items(&[&copy_url, &restart, &updates])
        .item(&PredefinedMenuItem::separator(app)?)
        .items(&[&quit])
        .build()?;

    TrayIconBuilder::with_id("pilot-tray")
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .tooltip("Pilot")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let state = app.state::<AppState>();
            match event.id().as_ref() {
                "open" => show_main(app),
                "copy-url" => {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    let _ = app.clipboard().write_text(state.config.app_url());
                }
                "restart-hub" => {
                    if let Some(s) = state.supervisor.lock().unwrap().as_ref() {
                        s.restart_hub();
                    }
                }
                "check-updates" => crate::updater::spawn_check(app.clone(), true),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}
