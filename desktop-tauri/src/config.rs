//! Resolved launch configuration — the Rust port of the Swift shell's `Config.swift`.
//! The app itself is nearly stateless: the real pilot code (server + client + watcher)
//! lives in `clone`, a dedicated checkout that tracks origin/main and auto-updates.
//! The shell just supervises processes against it.

use std::net::TcpListener;
use std::path::PathBuf;

pub struct PilotConfig {
    /// Dedicated checkout the app runs from (NOT your dev tree). Override: PILOT_APP_CLONE.
    pub clone: PathBuf,
    /// Server state (VAPID key, archive index, pilot.pid). Same dir as the Swift shell so
    /// the two apps share one identity — but never run both at once (the pidlock refuses).
    /// Override: PILOT_APP_DATA_DIR (a name the server never exports into spawned shells,
    /// unlike PILOT_DATA_DIR — so a test launch can't be hijacked by an inherited value).
    pub data_dir: PathBuf,
    /// Absolute path to `bun` — a Finder-launched app has a minimal PATH that omits it.
    pub bun_path: String,
    /// Free loopback port chosen at launch; passed to the server and the watcher.
    pub server_port: u16,
    /// PATH handed to spawned processes so the server (git/rg/shell) and the watcher
    /// (git/bun) resolve their tools. Mirrors the deploy plists' PATH.
    pub augmented_path: String,
    /// Node-style dependency lookup path for Bun-hosted provider packages.
    pub bun_node_path: String,
}

impl PilotConfig {
    pub fn resolve(server_port: u16) -> Self {
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
    pub fn server_env(&self) -> Vec<(String, String)> {
        let node_path = match std::env::var("NODE_PATH") {
            Ok(existing) if !existing.is_empty() => {
                format!("{}:{existing}", self.bun_node_path)
            }
            _ => self.bun_node_path.clone(),
        };
        vec![
            ("PATH".into(), self.augmented_path.clone()),
            ("NODE_PATH".into(), node_path),
            ("PILOT_HOST".into(), "127.0.0.1".into()),
            ("PILOT_PORT".into(), self.server_port.to_string()),
            (
                "PILOT_DATA_DIR".into(),
                self.data_dir.to_string_lossy().into_owned(),
            ),
        ]
    }

    /// Environment for the update-watcher: point it at this clone, this server's port, and
    /// the same data dir (so it finds pilot.pid for the restart signal). PILOT_PORT (not
    /// individual URLs) so the watcher derives BOTH /health and /update/state from one
    /// source of truth. We do NOT pass PILOT_APP_DESKTOP_SHA: that was the Swift shell's
    /// "rebuild desktop/ by hand" detection — this shell updates itself via the Tauri
    /// updater instead, and without the sha the watcher never emits a native-stale signal.
    pub fn watcher_env(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".into(), self.augmented_path.clone()),
            (
                "PILOT_APP_CLONE".into(),
                self.clone.to_string_lossy().into_owned(),
            ),
            ("PILOT_PORT".into(), self.server_port.to_string()),
            (
                "PILOT_DATA_DIR".into(),
                self.data_dir.to_string_lossy().into_owned(),
            ),
            // The shell owns notifications (posted on the watcher's stdout events); the
            // watcher's own osascript fallback is attributed to Script Editor — disable it.
            ("PILOT_UPDATE_NATIVE_NOTIFY".into(), "0".into()),
        ]
    }
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
