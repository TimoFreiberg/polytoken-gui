//! Resolved launch configuration — the Rust port of the Swift shell's `Config.swift`.
//!
//! Two hub modes (docs/ADR-desktop-shell.md "Sidecar mechanics"):
//! - **Bundled** (the packaged .app): the hub is a compiled sidecar binary inside the
//!   bundle (Contents/MacOS/pilot-hub) serving the bundled client (Resources/client-dist).
//!   Fully self-contained — no clone, no bun; the Tauri updater updates shell + hub +
//!   client atomically (updater.rs owns the loop).
//! - **Clone** (dev / `tauri dev` / bare binary runs): the hub is `bun run src/index.ts`
//!   in a dedicated checkout. The dev loop — no payload auto-update; restart the hub
//!   (tray) after editing it.
//!
//! Default: running from inside a .app → bundled, anything else → clone.
//! `PILOT_HUB_MODE=clone|bundled` overrides (e.g. bundled-mode testing on a debug
//! binary, or forcing a packaged app back onto a clone). A bundled resolution with a
//! missing sidecar/client is a FATAL config error, never a silent clone fallback.

use std::net::TcpListener;
use std::path::{Path, PathBuf};

pub enum HubMode {
    /// `bun run src/index.ts` in the dedicated clone.
    Clone,
    /// Spawn the compiled hub binary shipped inside the bundle.
    Bundled {
        hub_bin: PathBuf,
        client_dist: PathBuf,
    },
}

pub struct PilotConfig {
    /// How the hub is launched (see module docs). Everything clone-related below is
    /// only *used* in clone mode but stays resolved unconditionally — it's cheap and
    /// keeps this struct dumb.
    pub hub_mode: HubMode,
    /// Dedicated checkout the app runs from (NOT your dev tree). Override: PILOT_APP_CLONE.
    pub clone: PathBuf,
    /// Server state (VAPID key, archive index, pilot.pid). Same dir as the Swift shell so
    /// the two apps share one identity — but never run both at once (the pidlock refuses).
    /// Override: PILOT_APP_DATA_DIR (a name the server never exports into spawned shells,
    /// unlike PILOT_DATA_DIR — so a test launch can't be hijacked by an inherited value).
    pub data_dir: PathBuf,
    /// Absolute path to `bun` — a Finder-launched app has a minimal PATH that omits it.
    pub bun_path: String,
    /// Free loopback port chosen at launch; passed to the server.
    pub server_port: u16,
    /// PATH handed to the spawned server so it (git/rg/shell) resolves its tools.
    /// Mirrors the deploy plists' PATH.
    pub augmented_path: String,
    /// Node-style dependency lookup path for Bun-hosted provider packages.
    pub bun_node_path: String,
}

impl PilotConfig {
    /// `resource_dir`: the app's resource dir from Tauri's path resolver (bundle:
    /// Contents/Resources; dev: the staging dir next to the target binary). Passed in
    /// rather than resolved here so this stays a dumb, testable struct.
    /// Err = misconfiguration that must be presented fatally (never fall back silent).
    pub fn resolve(server_port: u16, resource_dir: &Path) -> Result<Self, String> {
        Ok(Self::build(server_port, resolve_hub_mode(resource_dir)?))
    }

    /// Config for the fatal-error path when resolve() failed: clone-mode defaults that
    /// nothing will ever spawn from — it exists so the window/tray (which read config
    /// for display) can come up under the fatal dialog.
    pub fn fallback(server_port: u16) -> Self {
        Self::build(server_port, HubMode::Clone)
    }

    fn build(server_port: u16, hub_mode: HubMode) -> Self {
        let home = home_dir();
        let clone = std::env::var("PILOT_APP_CLONE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("pilot-app"));
        let data_dir = std::env::var("PILOT_APP_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("Library/Application Support/Pilot"));

        let path_dirs = [
            home.join(".bun/bin"),
            home.join(".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];
        let bun_path = path_dirs
            .iter()
            .map(|d| d.join("bun"))
            .find(|p| is_executable(p))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "bun".to_string());
        let augmented_path = path_dirs
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(":");
        let bun_node_path = clone
            .join("node_modules/.bun/node_modules")
            .to_string_lossy()
            .into_owned();

        Self {
            hub_mode,
            clone,
            data_dir,
            bun_path,
            server_port,
            augmented_path,
            bun_node_path,
        }
    }

    pub fn app_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.server_port)
    }

    /// Environment for the spawned server: inherit the app's (Command does that), then
    /// force a usable PATH and pin host/port/data dir. No PILOT_TOKEN — loopback +
    /// single-user means auth off, and nothing is exposed off-device.
    ///
    /// Bundled mode adds PILOT_CLIENT_DIST (the compiled hub can't resolve the client
    /// relative to its own source — it has none) and skips NODE_PATH (a clone-mode
    /// affordance for bun-run module resolution; meaningless to a compiled binary).
    pub fn server_env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("PATH".into(), self.augmented_path.clone()),
            ("PILOT_HOST".into(), "127.0.0.1".into()),
            ("PILOT_PORT".into(), self.server_port.to_string()),
            (
                "PILOT_DATA_DIR".into(),
                self.data_dir.to_string_lossy().into_owned(),
            ),
        ];
        match &self.hub_mode {
            HubMode::Bundled { client_dist, .. } => {
                env.push((
                    "PILOT_CLIENT_DIST".into(),
                    client_dist.to_string_lossy().into_owned(),
                ));
            }
            HubMode::Clone => {
                let node_path = match std::env::var("NODE_PATH") {
                    Ok(existing) if !existing.is_empty() => {
                        format!("{}:{existing}", self.bun_node_path)
                    }
                    _ => self.bun_node_path.clone(),
                };
                env.push(("NODE_PATH".into(), node_path));
            }
        }
        env
    }
}

/// Bundled vs clone (see module docs). The "am I inside a .app" probe is the exe path
/// containing Contents/MacOS — exactly the packaged layout, and never true for
/// `tauri dev` / bare cargo binaries (target/{debug,release}/pilot-desktop).
fn resolve_hub_mode(resource_dir: &Path) -> Result<HubMode, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let bundled = match std::env::var("PILOT_HUB_MODE").as_deref() {
        Ok("bundled") => true,
        Ok("clone") => false,
        Ok(other) => {
            return Err(format!(
                "PILOT_HUB_MODE must be 'bundled' or 'clone', got '{other}'"
            ))
        }
        Err(_) => {
            exe.components().any(|c| c.as_os_str() == "Contents")
                && exe.parent().is_some_and(|p| p.ends_with("MacOS"))
        }
    };
    if !bundled {
        return Ok(HubMode::Clone);
    }

    // The sidecar lands next to the main exe: Contents/MacOS/pilot-hub in the bundle,
    // target/<profile>/pilot-hub when tauri-build stages it for a dev/debug run.
    let hub_bin = exe
        .parent()
        .ok_or("exe has no parent dir")?
        .join("pilot-hub");
    let client_dist = resource_dir.join("client-dist");
    // Loud precondition checks: a packaged app missing its payload is a broken build —
    // crash with specifics rather than limping into clone mode against a checkout that
    // may not exist on this machine.
    if !hub_bin.is_file() {
        return Err(format!(
            "bundled hub binary missing at {} — broken bundle (was the app built with \
             `bun run build` in desktop, which compiles the hub sidecar?)",
            hub_bin.display()
        ));
    }
    if !client_dist.join("index.html").is_file() {
        return Err(format!(
            "bundled client missing at {} — broken bundle (tauri.conf.json maps \
             ../client/dist as the client-dist resource; was the client built?)",
            client_dist.display()
        ));
    }
    Ok(HubMode::Bundled {
        hub_bin,
        client_dist,
    })
}

pub fn free_port() -> std::io::Result<u16> {
    // Bind :0, read the assigned port, drop the listener. Same small race the Swift
    // PortFinder accepted: the port could be taken between here and the server's bind —
    // the supervisor's health gate + crash-loop breaker surface that loudly if it ever
    // happens.
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME not set"))
}

fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}
