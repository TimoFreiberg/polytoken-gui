//! Remote on-disk layout spec.
//!
//! Pure functions over a root [`PathBuf`] — no filesystem writes, no process
//! spawning. The remote runtime and provisioning logic call these functions to
//! derive where releases, tools, sockets, and metadata live on the remote host.
//!
//! ## XDG distinction
//!
//! This root is for the **remote runtime/provisioning** only: provisioned
//! binaries, runtime sockets, and durable session metadata. The default is
//! `~/.local/share/pantoken` (XDG `DATA`) — the same tier the local server
//! now uses (see `config.rs`). The two roots hold different things:
//!
//! - **Local** (`XDG_DATA_HOME`): archive/worktree indices + session worktrees
//!   — sources of truth, not cache.
//! - **Remote** (`XDG_DATA_HOME` / `~/.local/share`): provisioned binaries +
//!   runtime sockets + durable session metadata.
//!
//! The `XDG_DATA_HOME` choice matches polytoken's own sessions-registry
//! convention (`XDG_DATA_HOME/polytoken/sessions`), so a Pantoken-managed
//! polytoken can be isolated under `~/.local/share/pantoken/tools/...` with
//! XDG roots derived from the same base.

use std::path::{Path, PathBuf};

/// Validation error for the remote layout.
#[derive(Debug, PartialEq, Eq)]
pub enum LayoutError {
    /// The root path is empty.
    EmptyRoot,
    /// The root path is relative (not absolute).
    RelativeRoot,
    /// The root path contains a `..` component that would escape.
    TraversalInRoot,
    /// A version or target input contains `..` and would escape the root.
    TraversalInInput { input: String },
}

impl std::fmt::Display for LayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LayoutError::EmptyRoot => write!(f, "remote root is empty"),
            LayoutError::RelativeRoot => write!(f, "remote root is relative (must be absolute)"),
            LayoutError::TraversalInRoot => {
                write!(f, "remote root contains '..' traversal")
            }
            LayoutError::TraversalInInput { input } => {
                write!(f, "input contains '..' traversal: {:?}", input)
            }
        }
    }
}

impl std::error::Error for LayoutError {}

/// Resolve the default remote root: `~/.local/share/pantoken`.
///
/// Honors `XDG_DATA_HOME` if set and non-empty, falling back to
/// `~/.local/share`. This mirrors polytoken's own sessions-registry convention.
/// Distinct from the local server's `default_data_dir()` (which uses
/// `XDG_STATE_HOME`).
pub fn default_remote_root() -> PathBuf {
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local").join("share"));
    data_home.join("pantoken")
}

/// Resolve the remote root from the environment.
///
/// Reads `PANTOKEN_REMOTE_ROOT` override (for tests/advanced use), falling back
/// to [`default_remote_root()`].
pub fn remote_root_from_env() -> PathBuf {
    std::env::var("PANTOKEN_REMOTE_ROOT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_remote_root)
}

/// Home directory (cross-platform). Uses the `HOME` env var on Unix.
fn home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    // Fallback — unlikely to be reached on a normal Unix system.
    PathBuf::from("/")
}

// ── Path derivation ───────────────────────────────────────────────────

/// `<root>/releases` — installed Pantoken server releases.
pub fn releases_dir(root: &Path) -> PathBuf {
    root.join("releases")
}

/// `<root>/releases/<version>/<target>/pantoken-server` — the server binary
/// for a specific release + target.
///
/// Returns an error if `version` or `target` contains a `..` path component.
pub fn release_artifact(root: &Path, version: &str, target: &str) -> Result<PathBuf, LayoutError> {
    Ok(releases_dir(root)
        .join(sanitize_or_err(version)?)
        .join(sanitize_or_err(target)?)
        .join("pantoken-server"))
}

/// `<root>/tools` — provisioned tool binaries (e.g. polytoken).
pub fn tools_dir(root: &Path) -> PathBuf {
    root.join("tools")
}

/// `<root>/tools/polytoken/<version>/<target>/polytoken` — the polytoken
/// binary for a specific version + target.
///
/// Returns an error if `version` or `target` contains a `..` path component.
pub fn polytoken_binary(root: &Path, version: &str, target: &str) -> Result<PathBuf, LayoutError> {
    Ok(tools_dir(root)
        .join("polytoken")
        .join(sanitize_or_err(version)?)
        .join(sanitize_or_err(target)?)
        .join("polytoken"))
}

/// `<root>/run` — private socket, pid/lock, runtime metadata.
pub fn run_dir(root: &Path) -> PathBuf {
    root.join("run")
}

/// `<root>/run/server.sock` — the private server socket.
pub fn private_socket(root: &Path) -> PathBuf {
    run_dir(root).join("server.sock")
}

/// `<root>/run/server.pid` — the pid/lock file.
pub fn pid_file(root: &Path) -> PathBuf {
    run_dir(root).join("server.pid")
}

/// `<root>/logs` — log directory.
pub fn logs_dir(root: &Path) -> PathBuf {
    root.join("logs")
}

/// `<root>/install.json` — install metadata.
pub fn install_metadata(root: &Path) -> PathBuf {
    root.join("install.json")
}

// ── XDG isolation paths (Phase 3) ──────────────────────────────────────

/// `<root>/tools/polytoken/xdg/config` — isolated XDG_CONFIG_HOME for a
/// Pantoken-managed polytoken.
pub fn polytoken_xdg_config(root: &Path) -> PathBuf {
    tools_dir(root).join("polytoken").join("xdg").join("config")
}

/// `<root>/tools/polytoken/xdg/data` — isolated XDG_DATA_HOME for a
/// Pantoken-managed polytoken.
pub fn polytoken_xdg_data(root: &Path) -> PathBuf {
    tools_dir(root).join("polytoken").join("xdg").join("data")
}

/// `<root>/tools/polytoken/xdg/cache` — isolated XDG_CACHE_HOME for a
/// Pantoken-managed polytoken.
pub fn polytoken_xdg_cache(root: &Path) -> PathBuf {
    tools_dir(root).join("polytoken").join("xdg").join("cache")
}

// ── Validation ────────────────────────────────────────────────────────

/// Validate a root path.
///
/// Rejects roots that are empty, relative, or escape via `..`. No
/// `canonicalize` — the paths may not exist yet.
pub fn validate_layout(root: &Path) -> Result<(), LayoutError> {
    if root.as_os_str().is_empty() {
        return Err(LayoutError::EmptyRoot);
    }
    if !root.is_absolute() {
        return Err(LayoutError::RelativeRoot);
    }
    for component in root.components() {
        if component == std::path::Component::ParentDir {
            return Err(LayoutError::TraversalInRoot);
        }
    }
    Ok(())
}

/// Sanitize a version or target input, returning an error on traversal.
///
/// Checks for `..` path components using `Path::components()`, which correctly
/// distinguishes `..` (traversal) from `..bar` (a valid name). Returns the
/// input as-is if safe.
///
/// Public API for callers that want graceful error handling before calling a
/// derivation function. The derivation functions (`release_artifact`,
/// `polytoken_binary`) also call this internally.
pub fn sanitize_or_err(input: &str) -> Result<String, LayoutError> {
    for component in Path::new(input).components() {
        if component == std::path::Component::ParentDir {
            return Err(LayoutError::TraversalInInput {
                input: input.to_string(),
            });
        }
    }
    Ok(input.to_string())
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `remote_layout_default_and_override_tests`
    //! - `remote_layout_path_safety_tests`
    //! - `xdg_paths_stay_under_remote_root`

    use super::*;
    use std::sync::Mutex;

    // Env var tests can race if run in parallel with other tests touching the
    // same env var. Use a mutex to serialize them.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Helper: set an env var, wrapping the Rust 2024 unsafe requirement.
    fn set_env(key: &str, val: &str) {
        // SAFETY: tests are serialized by ENV_MUTEX, so there is no concurrent
        // access to the process environment from these tests.
        unsafe { std::env::set_var(key, val) };
    }

    /// Helper: remove an env var, wrapping the Rust 2024 unsafe requirement.
    fn remove_env(key: &str) {
        // SAFETY: tests are serialized by ENV_MUTEX.
        unsafe { std::env::remove_var(key) };
    }

    // ── default_and_override_tests ────────────────────────────────────

    #[test]
    fn default_root_is_xdg_data_home_pantoken() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_xdg = std::env::var("XDG_DATA_HOME").ok();
        let saved_remote = std::env::var("PANTOKEN_REMOTE_ROOT").ok();

        remove_env("XDG_DATA_HOME");
        remove_env("PANTOKEN_REMOTE_ROOT");
        set_env("HOME", "/tmp/test-home");

        let root = default_remote_root();
        assert_eq!(root, PathBuf::from("/tmp/test-home/.local/share/pantoken"));

        restore_env("HOME", saved_home);
        restore_env("XDG_DATA_HOME", saved_xdg);
        restore_env("PANTOKEN_REMOTE_ROOT", saved_remote);
    }

    #[test]
    fn default_root_honors_xdg_data_home() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_xdg = std::env::var("XDG_DATA_HOME").ok();
        let saved_remote = std::env::var("PANTOKEN_REMOTE_ROOT").ok();

        set_env("HOME", "/tmp/test-home");
        set_env("XDG_DATA_HOME", "/tmp/xdg-data");
        remove_env("PANTOKEN_REMOTE_ROOT");

        let root = default_remote_root();
        assert_eq!(root, PathBuf::from("/tmp/xdg-data/pantoken"));

        restore_env("HOME", saved_home);
        restore_env("XDG_DATA_HOME", saved_xdg);
        restore_env("PANTOKEN_REMOTE_ROOT", saved_remote);
    }

    #[test]
    fn remote_root_from_env_override() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let saved_remote = std::env::var("PANTOKEN_REMOTE_ROOT").ok();

        set_env("PANTOKEN_REMOTE_ROOT", "/custom/remote/root");
        assert_eq!(remote_root_from_env(), PathBuf::from("/custom/remote/root"));

        restore_env("PANTOKEN_REMOTE_ROOT", saved_remote);
    }

    #[test]
    fn remote_root_from_env_empty_falls_back_to_default() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let saved_remote = std::env::var("PANTOKEN_REMOTE_ROOT").ok();
        let saved_home = std::env::var("HOME").ok();

        set_env("HOME", "/tmp/test-home2");
        set_env("PANTOKEN_REMOTE_ROOT", "");
        let root = remote_root_from_env();
        assert_eq!(root, PathBuf::from("/tmp/test-home2/.local/share/pantoken"));

        restore_env("PANTOKEN_REMOTE_ROOT", saved_remote);
        restore_env("HOME", saved_home);
    }

    fn restore_env(key: &str, saved: Option<String>) {
        match saved {
            Some(v) => set_env(key, &v),
            None => remove_env(key),
        }
    }

    // ── path derivation tests ─────────────────────────────────────────

    #[test]
    fn all_derivation_functions_produce_documented_paths() {
        let root = Path::new("/opt/pantoken");

        assert_eq!(releases_dir(root), PathBuf::from("/opt/pantoken/releases"));
        assert_eq!(
            release_artifact(root, "0.1.0", "aarch64-apple-darwin").unwrap(),
            PathBuf::from("/opt/pantoken/releases/0.1.0/aarch64-apple-darwin/pantoken-server")
        );
        assert_eq!(tools_dir(root), PathBuf::from("/opt/pantoken/tools"));
        assert_eq!(
            polytoken_binary(root, "0.5.0-unstable.9", "x86_64-unknown-linux-gnu").unwrap(),
            PathBuf::from(
                "/opt/pantoken/tools/polytoken/0.5.0-unstable.9/x86_64-unknown-linux-gnu/polytoken"
            )
        );
        assert_eq!(run_dir(root), PathBuf::from("/opt/pantoken/run"));
        assert_eq!(
            private_socket(root),
            PathBuf::from("/opt/pantoken/run/server.sock")
        );
        assert_eq!(
            pid_file(root),
            PathBuf::from("/opt/pantoken/run/server.pid")
        );
        assert_eq!(logs_dir(root), PathBuf::from("/opt/pantoken/logs"));
        assert_eq!(
            install_metadata(root),
            PathBuf::from("/opt/pantoken/install.json")
        );
    }

    // ── XDG path tests ─────────────────────────────────────────────────

    #[test]
    fn xdg_paths_stay_under_remote_root() {
        let root = Path::new("/opt/pantoken");
        assert!(polytoken_xdg_config(root).starts_with(root));
        assert!(polytoken_xdg_data(root).starts_with(root));
        assert!(polytoken_xdg_cache(root).starts_with(root));

        assert_eq!(
            polytoken_xdg_config(root),
            PathBuf::from("/opt/pantoken/tools/polytoken/xdg/config")
        );
        assert_eq!(
            polytoken_xdg_data(root),
            PathBuf::from("/opt/pantoken/tools/polytoken/xdg/data")
        );
        assert_eq!(
            polytoken_xdg_cache(root),
            PathBuf::from("/opt/pantoken/tools/polytoken/xdg/cache")
        );
    }

    // ── path_safety_tests ─────────────────────────────────────────────

    #[test]
    fn validate_layout_rejects_empty_root() {
        let err = validate_layout(Path::new("")).unwrap_err();
        assert_eq!(err, LayoutError::EmptyRoot);
    }

    #[test]
    fn validate_layout_rejects_relative_root() {
        let err = validate_layout(Path::new("relative/path")).unwrap_err();
        assert_eq!(err, LayoutError::RelativeRoot);
    }

    #[test]
    fn validate_layout_rejects_traversal_in_root() {
        let err = validate_layout(Path::new("/opt/../etc/pantoken")).unwrap_err();
        assert_eq!(err, LayoutError::TraversalInRoot);
    }

    #[test]
    fn validate_layout_accepts_absolute_root() {
        assert!(validate_layout(Path::new("/opt/pantoken")).is_ok());
        assert!(validate_layout(Path::new("/home/user/.local/share/pantoken")).is_ok());
    }

    #[test]
    fn sanitize_or_err_rejects_traversal() {
        assert!(sanitize_or_err("..").is_err());
        assert!(sanitize_or_err("../etc").is_err());
        assert!(sanitize_or_err("foo/../bar").is_err());
        assert!(sanitize_or_err("foo/..").is_err());
    }

    #[test]
    fn sanitize_or_err_accepts_safe_inputs() {
        assert!(sanitize_or_err("0.1.0").is_ok());
        assert!(sanitize_or_err("aarch64-apple-darwin").is_ok());
        assert!(sanitize_or_err("0.5.0-unstable.9").is_ok());
    }

    #[test]
    fn derived_paths_stay_under_root_with_safe_inputs() {
        let root = Path::new("/opt/pantoken");
        let release = release_artifact(root, "0.1.0", "aarch64-apple-darwin").unwrap();
        assert!(
            release.starts_with(root),
            "release artifact must be under root"
        );

        let binary = polytoken_binary(root, "0.5.0", "x86_64-unknown-linux-gnu").unwrap();
        assert!(
            binary.starts_with(root),
            "polytoken binary must be under root"
        );
    }

    #[test]
    fn derivation_functions_reject_traversal_in_version() {
        let root = Path::new("/opt/pantoken");
        let err = release_artifact(root, "..", "aarch64-apple-darwin").unwrap_err();
        assert!(matches!(err, LayoutError::TraversalInInput { .. }));

        let err = polytoken_binary(root, "..", "x86_64").unwrap_err();
        assert!(matches!(err, LayoutError::TraversalInInput { .. }));
    }

    #[test]
    fn derivation_functions_reject_traversal_in_target() {
        let root = Path::new("/opt/pantoken");
        let err = release_artifact(root, "0.1.0", "..").unwrap_err();
        assert!(matches!(err, LayoutError::TraversalInInput { .. }));

        let err = polytoken_binary(root, "0.5.0", "..").unwrap_err();
        assert!(matches!(err, LayoutError::TraversalInInput { .. }));
    }

    #[test]
    fn sanitize_or_err_accepts_dotdot_substring_in_name() {
        // `..bar` is a valid directory name, not a traversal — the old
        // substring-based check falsely rejected it. The component-based
        // check correctly accepts it.
        assert!(sanitize_or_err("foo/..bar").is_ok());
        assert!(sanitize_or_err("..bar").is_ok());
    }
}
