//! Resolved launch configuration — the Rust port of the Swift shell's `Config.swift`.
//!
//! The hub is a compiled Rust sidecar binary inside the bundle
//! (Contents/MacOS/pilot-server) serving the bundled client (Resources/client-dist).
//! Fully self-contained — the Tauri updater updates shell + hub + client atomically
//! (updater.rs owns the loop).
//!
//! `PILOT_HUB_MODE=bundled` overrides the default detection; a bundled resolution
//! with a missing sidecar/client is a FATAL config error, never a silent fallback.

use std::net::TcpListener;
use std::path::{Path, PathBuf};

pub struct PilotConfig {
    /// The hub binary path and client dist dir.
    pub hub_bin: PathBuf,
    pub client_dist: PathBuf,
    /// Server state (VAPID key, archive index, pilot.pid). Same dir as the Swift shell so
    /// the two apps share one identity — but never run both at once (the pidlock refuses).
    /// Override: PILOT_APP_DATA_DIR (a name the server never exports into spawned shells,
    /// unlike PILOT_DATA_DIR — so a test launch can't be hijacked by an inherited value).
    pub data_dir: PathBuf,
    /// Free loopback port chosen at launch; passed to the server.
    pub server_port: u16,
    /// PATH handed to the spawned server so it (git/rg/shell) resolves its tools.
    /// Mirrors the deploy plists' PATH.
    pub augmented_path: String,
}

impl PilotConfig {
    /// `resource_dir`: the app's resource dir from Tauri's path resolver (bundle:
    /// Contents/Resources; dev: the staging dir next to the target binary). Passed in
    /// rather than resolved here so this stays a dumb, testable struct.
    /// Err = misconfiguration that must be presented fatally (never fall back silent).
    pub fn resolve(server_port: u16, resource_dir: &Path) -> Result<Self, String> {
        Ok(Self::build(server_port, resolve_hub_mode(resource_dir)?))
    }

    /// Config for the fatal-error path when resolve() failed: dummy paths that
    /// nothing will ever spawn from — it exists so the window/tray (which read config
    /// for display) can come up under the fatal dialog.
    pub fn fallback(server_port: u16) -> Self {
        Self::build(
            server_port,
            HubResolution {
                hub_bin: PathBuf::new(),
                client_dist: PathBuf::new(),
            },
        )
    }

    fn build(server_port: u16, resolution: HubResolution) -> Self {
        let home = home_dir();
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
        let augmented_path = path_dirs
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(":");

        Self {
            hub_bin: resolution.hub_bin,
            client_dist: resolution.client_dist,
            data_dir,
            server_port,
            augmented_path,
        }
    }

    pub fn app_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.server_port)
    }

    /// Environment for the spawned server: inherit the app's (Command does that), then
    /// force a usable PATH and pin host/port/data dir. No PILOT_TOKEN — loopback +
    /// single-user means auth off, and nothing is exposed off-device.
    ///
    /// PILOT_CLIENT_DIST points the Rust server at the bundled client (it can't
    /// resolve the client relative to its own source — it has none).
    pub fn server_env(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".into(), self.augmented_path.clone()),
            ("PILOT_HOST".into(), "127.0.0.1".into()),
            ("PILOT_PORT".into(), self.server_port.to_string()),
            (
                "PILOT_DATA_DIR".into(),
                self.data_dir.to_string_lossy().into_owned(),
            ),
            (
                "PILOT_CLIENT_DIST".into(),
                self.client_dist.to_string_lossy().into_owned(),
            ),
        ]
    }
}

struct HubResolution {
    hub_bin: PathBuf,
    client_dist: PathBuf,
}

/// The sidecar lands next to the main exe: Contents/MacOS/pilot-server in the bundle,
/// target/<profile>/pilot-server when tauri-build stages it for a dev/debug run.
fn resolve_hub_mode(resource_dir: &Path) -> Result<HubResolution, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;

    // PILOT_HUB_MODE=bundled forces the bundled path (useful for testing a debug
    // binary as if it were packaged). Any other value is rejected.
    match std::env::var("PILOT_HUB_MODE").as_deref() {
        Ok("bundled") => {}
        Ok(other) => {
            return Err(format!(
                "PILOT_HUB_MODE must be 'bundled' (got '{other}'); clone mode was removed when the TS server was deleted"
            ))
        }
        Err(_) => {
            // Auto-detect: are we inside a .app bundle?
            if !(exe.components().any(|c| c.as_os_str() == "Contents")
                && exe.parent().is_some_and(|p| p.ends_with("MacOS")))
            {
                // Dev mode: look for the binary tauri-build staged next to the
                // dev binary (target/<profile>/pilot-server), or fall back to the
                // repo's cargo build output.
                let dev_bin = exe
                    .parent()
                    .ok_or("exe has no parent dir")?
                    .join("pilot-server");
                if dev_bin.is_file() {
                    let client_dist = resource_dir.join("client-dist");
                    if !client_dist.join("index.html").is_file() {
                        // In dev the client may not be built yet — use the repo's client/dist.
                        return Ok(HubResolution {
                            hub_bin: dev_bin,
                            client_dist: std::env::current_dir()
                                .unwrap_or_default()
                                .join("client/dist"),
                        });
                    }
                    return Ok(HubResolution {
                        hub_bin: dev_bin,
                        client_dist,
                    });
                }
                // Not staged — use the cargo release build if it exists, else error.
                return Ok(HubResolution {
                    hub_bin: dev_bin,
                    client_dist: resource_dir.join("client-dist"),
                });
            }
        }
    }

    let hub_bin = exe
        .parent()
        .ok_or("exe has no parent dir")?
        .join("pilot-server");
    let client_dist = resource_dir.join("client-dist");
    // Loud precondition checks: a packaged app missing its payload is a broken build —
    // crash with specifics rather than limping along.
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
    Ok(HubResolution {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_env_always_includes_client_dist() {
        let cfg = PilotConfig::build(
            12345,
            HubResolution {
                hub_bin: PathBuf::from("/tmp/pilot-server"),
                client_dist: PathBuf::from("/tmp/client-dist"),
            },
        );
        let env = cfg.server_env();
        let has_client_dist = env
            .iter()
            .any(|(k, v)| k == "PILOT_CLIENT_DIST" && v == "/tmp/client-dist");
        assert!(has_client_dist, "PILOT_CLIENT_DIST must always be set");
    }

    #[test]
    fn server_env_has_port_and_host() {
        let cfg = PilotConfig::build(
            9999,
            HubResolution {
                hub_bin: PathBuf::new(),
                client_dist: PathBuf::new(),
            },
        );
        let env = cfg.server_env();
        assert!(env.iter().any(|(k, v)| k == "PILOT_PORT" && v == "9999"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "PILOT_HOST" && v == "127.0.0.1"));
    }
}
