//! Server configuration from the environment. Defaults are safe for local dev;
//! the deploy sets PANTOKEN_TOKEN and runs behind `tailscale serve`.
//
// Port of `server/src/config.ts`.

use std::path::{Path, PathBuf};

/// Default server-state dir, XDG-conformant: `$XDG_STATE_HOME/pantoken`, falling back to
/// `~/.local/state/pantoken`. This is STATE (persists across restarts, machine-local, not
/// precious enough for `~/.local/share`) — the archive index here is a source of truth,
/// not a cache, so it must NOT land under `~/.cache` where a cleaner may wipe it.
fn default_data_dir() -> PathBuf {
    let state_home = std::env::var("XDG_STATE_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs().join(".local").join("state"));
    state_home.join("pantoken")
}

/// Home directory (cross-platform). Uses the `HOME` env var on Unix, falling back
/// to the system's home dir.
fn dirs() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    // Fallback — unlikely to be reached on a normal Unix system.
    PathBuf::from("/")
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub vapid_subject: String,
    pub host: String,
    /// None = no auth (dev). When set, WS clients must present it and /debug is gated.
    pub token: Option<String>,
    pub debug: bool,
    /// Built client bundle (served in prod; in dev Vite serves it instead).
    pub client_dist: PathBuf,
    /// Max kept-warm sessions before LRU eviction. ≤0 disables the cap.
    pub warm_cap: i64,
    /// Idle-reap timeout (ms). ≤0 disables reaping.
    pub idle_reap_ms: i64,
    /// Cadence (ms) of the hub's live-refresh ticker.
    pub live_refresh_ms: u64,
    /// Flush window (ms) for server-side coalescing of streamed assistantDeltas.
    pub delta_flush_ms: u64,
}

pub fn load() -> Config {
    let port = env_parse("PANTOKEN_PORT", 8787);
    let data_dir = std::env::var("PANTOKEN_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir);
    let vapid_subject = std::env::var("PANTOKEN_VAPID_SUBJECT")
        .unwrap_or_else(|_| "mailto:pantoken@example.com".into());
    let host = std::env::var("PANTOKEN_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let token = std::env::var("PANTOKEN_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());
    let debug = std::env::var("PANTOKEN_DEBUG")
        .map(|v| v != "0")
        .unwrap_or(true);
    let client_dist = std::env::var("PANTOKEN_CLIENT_DIST")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Default: ../../client/dist relative to the crate root (server-rs/pantoken-server)
            // In dev, Vite serves the client and proxies here, so this path is only used
            // when the client has been built. The CARGO_MANIFEST_DIR points at
            // server-rs/pantoken-server, so ../../client/dist = the repo's client/dist.
            let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
            manifest_dir.join("../../client/dist")
        });
    let warm_cap = env_parse("PANTOKEN_WARM_CAP", 8);
    let idle_reap_ms = env_parse("PANTOKEN_IDLE_REAP_MS", 10 * 60 * 1000);
    let live_refresh_ms = env_parse("PANTOKEN_LIVE_REFRESH_MS", 1000);
    let delta_flush_ms = env_parse("PANTOKEN_DELTA_FLUSH_MS", 50);

    Config {
        port,
        data_dir,
        vapid_subject,
        host,
        token,
        debug,
        client_dist,
        warm_cap,
        idle_reap_ms,
        live_refresh_ms,
        delta_flush_ms,
    }
}

fn env_parse<T: std::str::FromStr>(var: &str, default: T) -> T {
    std::env::var(var)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Token check. None token = auth disabled. This is a plain string compare, not a
/// constant-time one: pantoken is single-user behind `tailscale serve`, so a timing
/// side-channel on the token isn't in the threat model.
pub fn token_ok(provided: Option<&str>, config: &Config) -> bool {
    config.token.is_none() || provided == config.token.as_deref()
}

/// Extract the app token from a request. Prefers `Authorization: Bearer <token>`,
/// falls back to a `?token=` query param.
pub fn token_from_request(auth_header: Option<&str>, query_token: Option<&str>) -> Option<String> {
    if let Some(auth) = auth_header {
        if let Some(rest) = auth.strip_prefix("Bearer ") {
            return Some(rest.trim().to_string());
        }
    }
    query_token.map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_ok_when_no_token_configured() {
        let cfg = Config {
            port: 8787,
            data_dir: PathBuf::from("/tmp"),
            vapid_subject: "mailto:test@test.com".into(),
            host: "127.0.0.1".into(),
            token: None,
            debug: true,
            client_dist: PathBuf::from("/tmp"),
            warm_cap: 8,
            idle_reap_ms: 600000,
            live_refresh_ms: 1000,
            delta_flush_ms: 50,
        };
        assert!(token_ok(None, &cfg));
        assert!(token_ok(Some("anything"), &cfg));
    }

    #[test]
    fn token_ok_with_exact_match() {
        let cfg = Config {
            token: Some("secret".into()),
            ..test_config()
        };
        assert!(token_ok(Some("secret"), &cfg));
        assert!(!token_ok(Some("wrong"), &cfg));
        assert!(!token_ok(None, &cfg));
    }

    #[test]
    fn token_from_request_prefers_bearer_header() {
        let token = token_from_request(Some("Bearer abc123"), Some("query456"));
        assert_eq!(token, Some("abc123".into()));
    }

    #[test]
    fn token_from_request_falls_back_to_query() {
        let token = token_from_request(None, Some("query456"));
        assert_eq!(token, Some("query456".into()));
    }

    #[test]
    fn token_from_request_returns_none_when_absent() {
        let token = token_from_request(None, None);
        assert_eq!(token, None);
    }

    // ── Ported from config.test.ts.bak ──────────────────────────

    #[test]
    fn empty_string_token_behaves_like_real_token() {
        // An empty env var would set token=""; it must NOT be treated as
        // "auth disabled" (which None means). Only None disables.
        let cfg = Config {
            token: Some("".into()),
            ..test_config()
        };
        assert!(token_ok(Some(""), &cfg));
        assert!(!token_ok(None, &cfg));
    }

    #[test]
    fn trims_whitespace_around_bearer_token() {
        let token = token_from_request(Some("Bearer   spaced   "), None);
        assert_eq!(token, Some("spaced".into()));
    }

    fn test_config() -> Config {
        Config {
            port: 8787,
            data_dir: PathBuf::from("/tmp"),
            vapid_subject: "mailto:test@test.com".into(),
            host: "127.0.0.1".into(),
            token: None,
            debug: true,
            client_dist: PathBuf::from("/tmp"),
            warm_cap: 8,
            idle_reap_ms: 600000,
            live_refresh_ms: 1000,
            delta_flush_ms: 50,
        }
    }
}
