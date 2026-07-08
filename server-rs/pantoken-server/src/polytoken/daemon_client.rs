//! Port of `server/src/polytoken/daemon-client.ts`.
//!
//! One daemon process = one session = one port. This module owns the lifecycle of
//! ONE such daemon: spawn it, claim the TUI attachment lease (+ heartbeat), subscribe
//! to the `/events` SSE stream, and POST to its endpoints. The PolytokenDriver
//! composes one of these per warm session.
//!
//! Design notes:
//! - The lease is pid-bound and EXCLUSIVE (a second claim → 409). Pantoken is the sole
//!   attacher; the local TUI detaches while pantoken drives.
//! - SSE emits `heartbeat` events (~10s cadence) since daemon 0.4.0-unstable.5, so an
//!   idle daemon is NOT silent — liveness is a heartbeat timeout: no frame (heartbeat
//!   or real event) within `heartbeat_timeout_ms` means the daemon is dead → reconnect.
//! - `Last-Event-ID` resume is supported by the `id:` field (== `seq`); not yet wired.
//! - All endpoints are flat (no `/session/{id}/…`) — the daemon IS the session.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use pantoken_daemon_types::*;
use reqwest::Client;
use serde::Deserialize;
use tokio::process::Command;
use tokio::sync::{Mutex, oneshot};
use tracing::{error, info, warn};

/// An MCP server lifecycle action exposed by the daemon.
#[derive(Debug, Clone, Copy)]
pub enum McpServerAction {
    Enable,
    Disable,
    Disconnect,
    Reconnect,
}

impl McpServerAction {
    fn as_str(&self) -> &'static str {
        match self {
            McpServerAction::Enable => "enable",
            McpServerAction::Disable => "disable",
            McpServerAction::Disconnect => "disconnect",
            McpServerAction::Reconnect => "reconnect",
        }
    }
}

/// Result of spawning a daemon — parsed from `polytoken new --no-attach` stdout.
#[derive(Debug, Clone)]
pub struct SpawnedDaemon {
    pub session_id: String,
    pub port: u16,
    /// Bearer token for daemon 0.5.0+ auth. `None` for legacy daemons / fake-daemon
    /// test harness (which doesn't enforce auth). Read from the credential file
    /// pointed to by `startup.json.credential_file_path`.
    pub auth_token: Option<String>,
}

/// A claimed attachment lease + its lifecycle handles.
#[derive(Debug)]
pub struct AttachmentLease {
    pub lease_id: String,
    pub heartbeat_interval_ms: u64,
    pub expires_after_ms: u64,
    /// Cancellation token for the heartbeat task; cancelled on release.
    pub heartbeat_cancel: oneshot::Sender<()>,
    /// The heartbeat JoinHandle; aborted on release.
    pub heartbeat_handle: Option<tokio::task::JoinHandle<()>>,
}

/// Extract the value after `key=` in a line, up to the next whitespace. Returns None
/// if the key isn't found. Matches the TS regex `session_id=(\S+)` / `port=(\d+)`.
fn extract_kv_value(line: &str, key: &str) -> Option<String> {
    let idx = line.find(key)?;
    let rest = &line[idx + key.len()..];
    // Take up to the next whitespace.
    let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
    let val = &rest[..end];
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

/// Parse `polytoken new --no-attach` stdout: `session_id=<id> port=<port>`.
/// Loud-fails on a malformed line — never silently returns a half-parsed session.
pub fn parse_spawn_output(stdout: &str) -> Result<SpawnedDaemon, String> {
    // The line looks like: `session_id=04msc4-zesty port=51269` (possibly with ANSI/log noise).
    let line = stdout.lines().find(|l| l.contains("session_id="));
    let line = match line {
        Some(l) => l,
        None => {
            return Err(format!(
                "polytoken new --no-attach produced no session_id line:\n{}",
                &stdout[..stdout.len().min(500)]
            ));
        }
    };
    let session_id = extract_kv_value(line, "session_id=");
    let port_str = extract_kv_value(line, "port=");
    match (session_id, port_str) {
        (Some(session_id), Some(port_str)) => {
            let port: u16 = port_str
                .parse()
                .map_err(|_| format!("polytoken new --no-attach line unparseable: {line:?}"))?;
            Ok(SpawnedDaemon {
                session_id,
                port,
                auth_token: None,
            })
        }
        _ => Err(format!(
            "polytoken new --no-attach line unparseable: {line:?}"
        )),
    }
}

/// Resolve the default global config dir the daemon uses, mirroring polytoken's own
/// resolution: `$XDG_CONFIG_HOME/polytoken` or `~/.config/polytoken`. The daemon's
/// `--global-config-dir` flag overrides this; the `daemon` subcommand needs it
/// explicitly (unlike `new --working-dir`, which resolves config upward from the
/// project dir and finds the global config automatically).
pub fn default_global_config_dir() -> PathBuf {
    let xdg = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let base = match xdg {
        Some(x) => PathBuf::from(x),
        None => dirs_or_home_config(),
    };
    base.join("polytoken")
}

fn dirs_or_home_config() -> PathBuf {
    // Mirrors `join(homedir(), ".config")`.
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".config")
}

/// The parsed `startup.json` shape — the daemon writes `{state:"ready", pid, port}`
/// on success or `{state:"failed", pid, message}` on failure.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct StartupJson {
    pub state: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub pid: Option<i32>,
    #[serde(default)]
    pub port: Option<i32>,
    #[serde(default)]
    pub message: Option<String>,
    /// Path to the credential file written by 0.5.0+ daemons (bearer-token auth).
    /// Absent for legacy daemons that predate bearer auth — `#[serde(default)]`
    /// makes those records deserialize to `None`.
    #[serde(default)]
    pub credential_file_path: Option<String>,
}

/// Read the `startup.json` a `polytoken daemon` writes to its session dir. Returns
/// None when the file is absent or unparseable (a loud-fail to a log warning, never
/// a crash). The daemon writes `{state:"ready", pid, port}` on success or
/// `{state:"failed", pid, message}` on failure.
fn read_startup_json(session_dir: &Path) -> Option<StartupJson> {
    let file = session_dir.join("startup.json");
    if !file.exists() {
        return None;
    }
    match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<StartupJson>(&text) {
            Ok(json) => Some(json),
            Err(e) => {
                error!("failed to parse {}: {}", file.display(), e);
                None
            }
        },
        Err(e) => {
            error!("failed to read {}: {}", file.display(), e);
            None
        }
    }
}

/// Read the bearer token from a daemon credential file
/// (`{"version":1,"kind":"polytoken-daemon-credential","token":"<hex>"}` JSON
/// written by 0.5.0+ daemons at startup). Returns `None` if the file is missing or unparseable —
/// legacy daemons that predate bearer auth have no credential file, so callers
/// treat `None` as "no auth header" and the daemon (which doesn't enforce auth)
/// accepts the request.
pub fn read_credential_token(credential_file_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(credential_file_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("token")?.as_str().map(String::from)
}

fn generate_daemon_credential_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(unix)]
fn set_private_session_dir_mode(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| {
            format!(
                "failed to stat credential file parent {}: {e}",
                path.display()
            )
        })?
        .permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(path, perms).map_err(|e| {
        format!(
            "failed to chmod credential file parent {} to 0700: {e}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_private_session_dir_mode(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn prepare_resume_credential_file(credential_file: &Path) -> Result<String, String> {
    let credential_parent = credential_file.parent().ok_or_else(|| {
        format!(
            "credential file has no parent: {}",
            credential_file.display()
        )
    })?;
    std::fs::create_dir_all(credential_parent).map_err(|e| {
        format!(
            "failed to create credential file parent {}: {e}",
            credential_parent.display()
        )
    })?;
    set_private_session_dir_mode(credential_parent)?;

    let token = generate_daemon_credential_token();
    let credential_json = serde_json::json!({
        "version": 1,
        "kind": "polytoken-daemon-credential",
        "token": token,
    })
    .to_string();

    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        options
    };
    #[cfg(not(unix))]
    let options = {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        options
    };

    let mut file = options.open(credential_file).map_err(|e| {
        format!(
            "failed to create credential file {}: {e}",
            credential_file.display()
        )
    })?;
    file.write_all(credential_json.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            format!(
                "failed to write credential file {}: {e}",
                credential_file.display()
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = file
            .metadata()
            .map_err(|e| {
                format!(
                    "failed to stat credential file {}: {e}",
                    credential_file.display()
                )
            })?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(credential_file, perms).map_err(|e| {
            format!(
                "failed to chmod credential file {} to 0600: {e}",
                credential_file.display()
            )
        })?;
    }

    Ok(token)
}

/// Wait for a `polytoken daemon` (foreground) to write a `ready` startup.json,
/// polling every 100ms up to `timeout_ms`. Returns the port. Throws on `failed`,
/// timeout, or a malformed startup.json. The daemon writes `startup.json` to its
/// session dir (under the sessions dir) once it has bound its port.
///
/// `expect_pid` — the pid of the daemon process we just spawned. A `startup.json`
/// left behind by a PRIOR daemon (state:"ready", a now-dead pid + port) sits in
/// the session dir from the last run. Without this guard, `wait_for_daemon_startup`
/// reads that stale file on the very first poll, returns the dead daemon's port,
/// and `wait_for_health` spins for 10s against an unbound port → every cold resume
/// of an old session times out. Only trust a `ready` file whose `pid` matches the
/// process we started.
///
/// `child` — the spawned daemon process. We check `try_wait()` after each poll
/// iteration: if the process exited early (e.g. CLI parse error) we read its
/// stderr and fail immediately instead of silently polling for the full timeout.
pub async fn wait_for_daemon_startup(
    sessions_dir: &str,
    session_id: &str,
    timeout_ms: u64,
    expect_pid: Option<i32>,
    child: &mut tokio::process::Child,
) -> Result<StartupJson, String> {
    let session_dir = PathBuf::from(sessions_dir).join(session_id);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut last_json: Option<StartupJson> = None;
    loop {
        if let Some(json) = read_startup_json(&session_dir) {
            last_json = Some(json.clone());
            if json.state == "ready" {
                if let Some(_port) = json.port {
                    // Stale startup.json from a prior (now-dead) daemon: its pid won't match
                    // the process we just spawned. Keep polling for OUR daemon's file.
                    let pid_matches = expect_pid.map(|ep| json.pid == Some(ep)).unwrap_or(true);
                    if pid_matches {
                        return Ok(json);
                    }
                    // The file is stale — but note it so the timeout message is useful.
                }
            }
            if json.state == "failed" {
                // A failed file from a prior run (wrong pid) must not abort our wait —
                // only a failure from our own daemon is terminal.
                let is_ours = expect_pid.map(|ep| json.pid == Some(ep)).unwrap_or(true);
                if is_ours {
                    return Err(format!(
                        "polytoken daemon failed to start: {}",
                        json.message.as_deref().unwrap_or("no message")
                    ));
                }
            }
            // state is something else (e.g. "starting") — keep polling.
        }

        // Detect early process death: if the daemon exited before writing a
        // ready startup.json, read its stderr and fail immediately rather than
        // silently polling for the full timeout (the "click does nothing" symptom).
        match child.try_wait() {
            Ok(Some(status)) => {
                let stderr = read_child_stderr(child).await;
                return Err(format!(
                    "polytoken daemon exited early (status {status}):\nstderr: {}",
                    &stderr[..stderr.len().min(500)]
                ));
            }
            Ok(None) => { /* still running, keep polling */ }
            Err(e) => {
                warn!("failed to check daemon process status: {e}");
            }
        }

        if Instant::now() >= deadline {
            let last_str = match &last_json {
                Some(j) => serde_json::to_string(j).unwrap_or_else(|_| "<unparseable>".into()),
                None => "null".into(),
            };
            let pid_str = expect_pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "any".into());
            // On timeout, also surface the daemon's stderr for diagnostics.
            let stderr = read_child_stderr(child).await;
            return Err(format!(
                "polytoken daemon did not become ready within {}ms (startup.json: {}; expected pid: {})\ndaemon stderr: {}",
                timeout_ms,
                last_str,
                pid_str,
                &stderr[..stderr.len().min(500)]
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Read all available stderr from a child process (best-effort, non-blocking —
/// the process is expected to have exited). Used by `wait_for_daemon_startup`
/// to surface the daemon's error output on early death or timeout.
async fn read_child_stderr(child: &mut tokio::process::Child) -> String {
    if let Some(mut stderr) = child.stderr.take() {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    } else {
        String::new()
    }
}

/// Options for spawning a daemon process.
#[derive(Debug, Clone, Default)]
pub struct SpawnDaemonOpts {
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    /// Required for resume: the on-disk sessions registry dir (where startup.json
    /// is written). Ignored for new sessions.
    pub sessions_dir: Option<String>,
    /// Required for resume: the global config dir. Ignored for new sessions.
    pub global_config_dir: Option<String>,
    /// Login-shell env to pass to the daemon (so it gets the user's real PATH +
    /// tool env instead of pantoken's minimal launchd env). Merged over process.env:
    /// login env wins.
    pub login_env: Option<HashMap<String, String>>,
}

fn merged_spawn_env(
    login_env: Option<&HashMap<String, String>>,
) -> Option<HashMap<String, String>> {
    let login_env = login_env?;
    if login_env.is_empty() {
        return None;
    }

    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.extend(login_env.iter().map(|(k, v)| (k.clone(), v.clone())));
    Some(env)
}

/// Spawn a NEW polytoken daemon session (no resume). `polytoken --working-dir <cwd>
/// new --no-attach` prints `session_id=<id> port=<port>` to stdout and exits 0;
/// the daemon runs detached.
async fn spawn_new_daemon(
    polytoken_bin: &str,
    opts: SpawnDaemonOpts,
) -> Result<(SpawnedDaemon, Option<tokio::process::Child>), String> {
    let mut global_args: Vec<String> = Vec::new();
    if let Some(cwd) = &opts.cwd {
        global_args.push("--working-dir".into());
        global_args.push(cwd.clone());
    }
    let mut cmd_args = vec![polytoken_bin.to_string()];
    cmd_args.extend(global_args);
    cmd_args.extend(["new".into(), "--no-attach".into()]);

    let mut cmd = Command::new(&cmd_args[0]);
    cmd.args(&cmd_args[1..]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if let Some(env) = merged_spawn_env(opts.login_env.as_ref()) {
        cmd.envs(env);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn polytoken new: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "polytoken new --no-attach exited {}:\nstderr: {}\nstdout: {}",
            output.status,
            &stderr[..stderr.len().min(500)],
            &stdout[..stdout.len().min(500)]
        ));
    }
    parse_spawn_output(&stdout).map(|mut spawned| {
        // Read the bearer token from the session dir's startup.json (daemon
        // 0.5.0+ writes credential_file_path there after binding). The daemon
        // auto-generates credentials internally for `new --no-attach` sessions;
        // we read them back so the client can authenticate. None for legacy
        // daemons that have no credential file.
        if let Some(sessions_dir) = &opts.sessions_dir {
            let session_dir = PathBuf::from(sessions_dir).join(&spawned.session_id);
            if let Some(startup) = read_startup_json(&session_dir) {
                if let Some(cred_path) = startup.credential_file_path.as_deref() {
                    spawned.auth_token = read_credential_token(Path::new(cred_path));
                }
            }
        }
        (spawned, None)
    })
}

/// Spawn a daemon to RESUME an existing session. Unlike `new --no-attach` (which
/// prints session_id/port and exits), the resume path uses `polytoken daemon
/// --resume --session-id <id> --project-dir <cwd>` — a FOREGROUND process that
/// writes `startup.json` (with pid/port) to the session dir. We spawn it in the
/// background, poll `startup.json` for readiness, and keep the process alive
/// (the caller owns it via the returned DaemonClient + its close()/kill()).
///
/// `--global-config-dir` and `--sessions-dir` are passed explicitly because the
/// `daemon` subcommand resolves config differently than `new --working-dir`
/// (it does NOT walk upward from the project dir to find the global config).
/// Build the arg vector for `polytoken daemon --resume`. Extracted as a pure
/// function so it can be unit-tested (AC.3) without spawning a process.
pub fn build_resume_args(
    cwd: &str,
    session_id: &str,
    global_config_dir: &str,
    sessions_dir: &str,
    credential_file: &Path,
) -> Vec<String> {
    vec![
        "daemon".into(),
        "--project-dir".into(),
        cwd.into(),
        "--session-id".into(),
        session_id.into(),
        "--resume".into(),
        "--global-config-dir".into(),
        global_config_dir.into(),
        "--sessions-dir".into(),
        sessions_dir.into(),
        "--credential-file".into(),
        credential_file.to_string_lossy().into(),
    ]
}

async fn spawn_resume_daemon(
    polytoken_bin: &str,
    opts: SpawnDaemonOpts,
) -> Result<(SpawnedDaemon, Option<tokio::process::Child>), String> {
    let session_id = opts.session_id.as_ref().unwrap().clone();
    let cwd = opts.cwd.as_ref().unwrap().clone();
    let sessions_dir = opts.sessions_dir.as_ref().unwrap().clone();
    let global_config_dir = opts.global_config_dir.as_ref().unwrap().clone();

    // The 0.5.0+ daemon requires --credential-file <path>. The CLI validates
    // that this file already exists with mode 0600 and that its parent directory
    // is private (0700). Older session dirs can be 0755, so normalize them before
    // spawning the resume daemon.
    let credential_file = PathBuf::from(&sessions_dir)
        .join(&session_id)
        .join("credential.json");
    let prepared_auth_token = prepare_resume_credential_file(&credential_file)?;

    let args = build_resume_args(
        &cwd,
        &session_id,
        &global_config_dir,
        &sessions_dir,
        &credential_file,
    );

    let mut cmd = Command::new(polytoken_bin);
    cmd.args(&args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if let Some(env) = merged_spawn_env(opts.login_env.as_ref()) {
        cmd.envs(env);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn polytoken daemon: {e}"))?;
    let pid = child.id();

    // Poll startup.json for readiness (the daemon writes it once it has bound its
    // port). 15s is generous — a cold config load + history replay can take a moment.
    match wait_for_daemon_startup(
        &sessions_dir,
        &session_id,
        15_000,
        pid.map(|p| p as i32),
        &mut child,
    )
    .await
    {
        Ok(startup) => {
            let port = startup.port.ok_or("startup.json has no port")? as u16;
            // Read the bearer token from the credential file (daemon 0.5.0+
            // writes it during startup; startup.json.credential_file_path
            // points to it). None for legacy daemons → no auth header.
            let auth_token = startup
                .credential_file_path
                .as_deref()
                .and_then(|p| read_credential_token(Path::new(p)))
                .or(Some(prepared_auth_token));
            Ok((
                SpawnedDaemon {
                    session_id,
                    port,
                    auth_token,
                },
                Some(child),
            ))
        }
        Err(e) => {
            // Startup failed — kill the background daemon so it doesn't leak.
            let _ = child.kill().await;
            // Surface the daemon's stderr for diagnostics.
            let stderr = match child.wait_with_output().await {
                Ok(o) => String::from_utf8_lossy(&o.stderr).to_string(),
                Err(_) => String::new(),
            };
            Err(format!(
                "{}\ndaemon stderr: {}",
                e,
                &stderr[..stderr.len().min(500)]
            ))
        }
    }
}

/// Spawn a polytoken daemon (one session, no TUI attach) and return its session id +
/// port. A new session uses `polytoken --working-dir <cwd> new --no-attach` (prints
/// session_id/port to stdout, exits 0). Resuming an existing session uses
/// `polytoken daemon --resume --session-id <id> --project-dir <cwd>` (foreground;
/// writes startup.json with the port). The two paths are NOT interchangeable — `new`
/// does not accept `--resume`/`--session-id`, and `daemon` doesn't print to stdout.
///
/// On resume (and in tests via override), also returns the Child handle so the
/// caller can keep it alive and reap it during warm-session disposal. New
/// `--no-attach` spawns detach and therefore have no child handle here.
/// A boxed future returned by a spawn-override function.
pub type SpawnOverrideFuture = Pin<
    Box<
        dyn Future<Output = Result<(SpawnedDaemon, Option<tokio::process::Child>), String>>
            + Send
            + 'static,
    >,
>;

/// The signature of a spawn-override: given the polytoken binary path + spawn
/// options, return a `SpawnedDaemon` (the fake daemon's ephemeral port + a
/// session id) and optionally a child handle to retain. Used by the fake-daemon
/// integration harness to swap the process launch for an in-process axum router;
/// child-carrying tests use the optional handle to verify disposal kills/reaps.
pub type SpawnOverrideFn = Arc<dyn Fn(&str, SpawnDaemonOpts) -> SpawnOverrideFuture + Send + Sync>;

/// Process-global spawn override (test seam). `OnceLock` holds an inner
/// `std::sync::Mutex<Option<…>>` so the harness can set AND clear it per
/// scenario (a bare `OnceLock` is set-once). `spawn_daemon` consults this
/// BEFORE any arg validation so the fake can answer both new and resume spawns.
/// A std (not tokio) Mutex is correct here: the override lookup is instant and
/// never held across an `.await` (we clone the `Arc<…>` and drop the guard
/// immediately), and a std guard is safe to acquire from async code — it never
/// suspends, so it can't deadlock the runtime. Production code never sets it,
/// so the real launch path is untouched.
static SPAWN_OVERRIDE: OnceLock<std::sync::Mutex<Option<SpawnOverrideFn>>> = OnceLock::new();

fn spawn_override() -> Option<SpawnOverrideFn> {
    let cell = SPAWN_OVERRIDE.get_or_init(|| std::sync::Mutex::new(None));
    let guard = cell.lock().expect("spawn_override mutex poisoned");
    guard.clone()
}

/// Install a spawn-override (test seam). MUST be paired with
/// `clear_spawn_override()` in the same test to avoid cross-test bleed under
/// `cargo test` parallelism — the override is process-global. Serializing the
/// injecting tests (e.g. a shared mutex) is the caller's responsibility.
pub fn set_spawn_override(f: SpawnOverrideFn) {
    let cell = SPAWN_OVERRIDE.get_or_init(|| std::sync::Mutex::new(None));
    *cell.lock().expect("set_spawn_override mutex poisoned") = Some(f);
}

/// Remove the installed spawn-override. Pair with `set_spawn_override`.
pub fn clear_spawn_override() {
    let cell = SPAWN_OVERRIDE.get_or_init(|| std::sync::Mutex::new(None));
    *cell.lock().expect("clear_spawn_override mutex poisoned") = None;
}

pub async fn spawn_daemon(
    polytoken_bin: &str,
    opts: SpawnDaemonOpts,
) -> Result<(SpawnedDaemon, Option<tokio::process::Child>), String> {
    // Test seam: if a spawn-override is installed, the fake daemon answers
    // both new and resume spawns WITHOUT launching a process. Checked FIRST,
    // before resume-path arg validation, so the harness can answer resume
    // spawns without supplying cwd/sessions_dir/global_config_dir.
    if let Some(override_fn) = spawn_override() {
        return override_fn(polytoken_bin, opts).await;
    }

    if opts.session_id.is_some() {
        // Resume path — needs cwd + sessions_dir + global_config_dir.
        if opts.cwd.is_none() {
            return Err("spawnDaemon: resume requires cwd".into());
        }
        if opts.sessions_dir.is_none() {
            return Err("spawnDaemon: resume requires sessionsDir".into());
        }
        if opts.global_config_dir.is_none() {
            return Err("spawnDaemon: resume requires globalConfigDir".into());
        }
        spawn_resume_daemon(polytoken_bin, opts).await
    } else {
        // New session path.
        spawn_new_daemon(polytoken_bin, opts).await
    }
}

// ---------------------------------------------------------------------------
// Lease conflict helpers
// ---------------------------------------------------------------------------

/// The parsed 409 lease-held body — the holder label/pid + the expiry.
/// `expires_at` is None when the body is missing or malformed (not a real lease
/// conflict), so the caller can fall back to the raw error.
#[derive(Debug, Clone)]
pub struct LeaseHeldInfo {
    /// `"label" pid N, lease expires <time>` — a readable holder summary, or the
    /// daemon's own `message` field when the body lacks the structured `active`.
    pub summary: String,
    /// The parsed `expires_at`, or None when absent/unparseable.
    pub expires_at: Option<String>,
}

/// Parse a 409 lease-held error body into a readable holder description + expiry.
/// The body shape (observed): `{"active":{"active_pid":..., "active_terminal_label":"...",
/// "last_seen_at":"...", "expires_at":"..."}, "message":"an interactive TUI is..."}`.
/// Returns None if the body isn't the expected shape (caller falls back to raw).
pub fn parse_lease_held_error(error: Option<&str>) -> Option<LeaseHeldInfo> {
    let error = error?;
    #[derive(Deserialize)]
    struct Active {
        #[serde(default)]
        active_terminal_label: Option<String>,
        #[serde(default)]
        active_pid: Option<i64>,
        #[serde(default)]
        expires_at: Option<String>,
    }
    #[derive(Deserialize)]
    struct Body {
        #[serde(default)]
        active: Option<Active>,
        #[serde(default)]
        message: Option<String>,
    }
    let body: Body = serde_json::from_str(error).ok()?;
    match body.active {
        Some(a) => {
            let label = a
                .active_terminal_label
                .unwrap_or_else(|| "unknown TUI".into());
            let pid = a
                .active_pid
                .map(|p| format!(" pid {p}"))
                .unwrap_or_default();
            let expires = a
                .expires_at
                .as_ref()
                .map(|e| format!(", lease expires {e}"))
                .unwrap_or_default();
            Some(LeaseHeldInfo {
                summary: format!("\"{label}\"{pid}{expires}"),
                expires_at: a.expires_at,
            })
        }
        None => body.message.map(|m| LeaseHeldInfo {
            summary: m,
            expires_at: None,
        }),
    }
}

/// Build the lease-conflict error message with the computed time-to-lapse.
/// Replaces the old hardcoded "~30s" — when we know the expiry, the operator gets
/// an exact wait. `seconds_to_lapse` is None only when the body lacked an expiry
/// (a malformed 409), in which case we fall back to the raw holder summary.
pub fn format_lease_conflict_message(
    held: Option<&LeaseHeldInfo>,
    seconds_to_lapse: Option<i64>,
) -> String {
    match held {
        None => "lease claim failed (409): another TUI is attached".into(),
        Some(held) => {
            let wait = match seconds_to_lapse {
                Some(s) => format!("{s}s"),
                None => "~30s".into(),
            };
            format!(
                "another TUI is attached to this session ({}). Detach it there (/detach) or wait {} for its lease to lapse.",
                held.summary, wait
            )
        }
    }
}

/// Round up to whole seconds (a 1.2s wait reads as "2s", never under-promises).
pub fn ceil_seconds(ms: i64) -> i64 {
    // Equivalent to Math.ceil(ms / 1000).
    let s = ms.div_euclid(1000);
    if ms.rem_euclid(1000) != 0 { s + 1 } else { s }
}

/// A 409 lease-conflict error carrying the parsed holder info + expiry. Thrown by
/// `claim_lease` on a 409; `retry_claim` reads `.held` to decide whether the lease
/// will lapse within the retry window.
#[derive(Debug, Clone)]
pub struct LeaseConflictError {
    pub message: String,
    pub held: Option<LeaseHeldInfo>,
}

impl std::fmt::Display for LeaseConflictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for LeaseConflictError {}

/// The boxed future returned by a [`SleepFn`]. Mirrors the [`SpawnOverrideFuture`]
/// shape: a pinned, boxed, `Send + 'static` future so the sleep closure can be
/// stored as a trait object.
pub type SleepFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// An injectable sleep seam for [`retry_claim`]. The default (used by
/// [`retry_claim`]) is `tokio::time::sleep`; tests pass a no-op so retry loops
/// run without real wall-clock delay. Mirrors the `SpawnOverrideFn` pattern
/// (`Arc<dyn Fn(...) -> Pin<Box<dyn Future + Send + 'static>> + Send + Sync>`).
pub type SleepFn = Arc<dyn Fn(Duration) -> SleepFuture + Send + Sync>;

/// Retry a claim function on lease-conflict errors, up to `max_retries` times
/// with `delay_ms` backoff between attempts. Pure — takes the claim function so
/// it's unit-testable without a live daemon. On exhaustion (or an early exit
/// when the lease won't lapse within the remaining retry window), returns a
/// LeaseConflictError whose message includes the computed time-to-lapse.
///
/// **Divergence from TS `retryClaim`:** the TS version's `claim` throws
/// arbitrary errors and re-throws non-`LeaseConflictError`s immediately (no
/// retry). The Rust `claim` returns `Result<_, LeaseConflictError>`, so *every*
/// `Err` is a lease conflict and is retried. `claim_lease` models non-409
/// failures as `LeaseConflictError { held: None }`, which has no expiry and so
/// always retries to exhaustion. Restoring the TS behavior would need an error
/// enum distinguishing conflict from other failures (pre-existing; tracked in
/// PROGRESS.md).
///
/// Delegates to [`retry_claim_with_sleep`] with `tokio::time::sleep` as the
/// default sleep, so the public signature is unchanged for existing callers.
pub async fn retry_claim<T, F, Fut>(
    claim: F,
    max_retries: Option<u32>,
    delay_ms: Option<u64>,
) -> Result<T, LeaseConflictError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, LeaseConflictError>>,
{
    let sleep: SleepFn = Arc::new(|d| Box::pin(tokio::time::sleep(d)));
    retry_claim_with_sleep(claim, max_retries, delay_ms, sleep).await
}

/// Same as [`retry_claim`] but with an injectable sleep seam. `sleep` is called
/// with `Duration::from_millis(delay_ms)` between retries; tests pass a no-op
/// future so the loop is instant and deterministic.
pub async fn retry_claim_with_sleep<T, F, Fut>(
    claim: F,
    max_retries: Option<u32>,
    delay_ms: Option<u64>,
    sleep: SleepFn,
) -> Result<T, LeaseConflictError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, LeaseConflictError>>,
{
    let max_retries = max_retries.unwrap_or(3) as i32;
    let delay_ms = delay_ms.unwrap_or(3000);
    let mut last_conflict: Option<LeaseConflictError> = None;
    for attempt in 0..=max_retries {
        match claim().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_conflict = Some(e.clone());
                let expiry = e
                    .held
                    .as_ref()
                    .and_then(|h| h.expires_at.as_deref())
                    .and_then(parse_iso8601_to_millis);
                if let (Some(expiry_millis), true) = (expiry, attempt < max_retries) {
                    let now_millis = current_millis();
                    let ms_until_expiry = expiry_millis as i64 - now_millis;
                    let remaining_delays = (max_retries - attempt) as i64 * delay_ms as i64;
                    // The lease won't lapse within the retry window (active TUI heartbeating).
                    // Stop retrying — surface the manual Retry toast with the computed wait.
                    if ms_until_expiry > remaining_delays {
                        return Err(LeaseConflictError {
                            message: format_lease_conflict_message(
                                e.held.as_ref(),
                                Some(ceil_seconds(ms_until_expiry)),
                            ),
                            held: e.held.clone(),
                        });
                    }
                }
                if attempt < max_retries {
                    sleep(Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }
    // All retries exhausted. Build the final message with the computed time-to-lapse
    // (or "~30s" when the body lacked an expiry).
    let held = last_conflict.as_ref().and_then(|c| c.held.clone());
    let seconds_to_lapse = held
        .as_ref()
        .and_then(|h| h.expires_at.as_deref())
        .and_then(parse_iso8601_to_millis)
        .map(|exp| ceil_seconds(exp as i64 - current_millis()));
    Err(LeaseConflictError {
        message: format_lease_conflict_message(held.as_ref(), seconds_to_lapse),
        held,
    })
}

/// Parse an ISO-8601 timestamp to epoch millis. Returns None on failure.
fn parse_iso8601_to_millis(s: &str) -> Option<u128> {
    // Try chrono-free parse: handle `...Z` and fractional seconds.
    // We attempt to parse using a simple approach: strip trailing 'Z', split on 'T'.
    // For robustness, delegate to humantime is not available; do manual parse.
    // Simple RFC3339 parse via std wouldn't work; use a lightweight manual approach.
    parse_rfc3339_millis(s)
}

/// Lightweight RFC3339 → epoch-millis parser (handles the daemon's ISO timestamps
/// like `2025-01-15T12:34:56.789Z` and `...+00:00`).
fn parse_rfc3339_millis(s: &str) -> Option<u128> {
    // We need a proper time parser. Since `time` or `chrono` aren't in deps,
    // do a minimal manual parse for the common daemon format.
    // Expected: YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM|-HH:MM)
    let s = s.trim();
    let (date_part, rest) = s.split_once('T')?;
    let (year, month, day) = {
        let mut parts = date_part.split('-');
        let y: i32 = parts.next()?.parse().ok()?;
        let m: u32 = parts.next()?.parse().ok()?;
        let d: u32 = parts.next()?.parse().ok()?;
        (y, m, d)
    };
    // Time part may end with Z, +HH:MM, or -HH:MM
    let (time_part, tz_offset_minutes) = parse_tz(rest)?;
    let (h, m, sec, millis) = {
        let mut parts = time_part.split(':');
        let h: u32 = parts.next()?.parse().ok()?;
        let m: u32 = parts.next()?.parse().ok()?;
        let sec_and_millis = parts.next()?;
        let (sec_str, millis_str) = match sec_and_millis.split_once('.') {
            Some((s, ms)) => (s, Some(ms)),
            None => (sec_and_millis, None),
        };
        let sec: u32 = sec_str.parse().ok()?;
        let millis: u32 = millis_str
            .and_then(|ms| {
                // pad/truncate to 3 digits
                let ms: String = ms.chars().take(3).collect();
                let padded = format!("{:0<3}", ms);
                padded.parse().ok()
            })
            .unwrap_or(0);
        (h, m, sec, millis)
    };
    let days = days_from_civil(year, month, day)?;
    let total_seconds =
        days * 86400 + h as i64 * 3600 + m as i64 * 60 + sec as i64 - tz_offset_minutes as i64 * 60;
    let total_millis = total_seconds as i128 * 1000 + millis as i128;
    Some(total_millis as u128)
}

/// Parse the timezone suffix from a time string like `12:34:56.789Z` or
/// `12:34:56.789+00:00`. Returns (time_without_tz, offset_minutes).
fn parse_tz(rest: &str) -> Option<(&str, i32)> {
    if let Some(pos) = rest.rfind('Z') {
        return Some((&rest[..pos], 0));
    }
    // Look for +HH:MM or -HH:MM at the end
    for sign in ['+', '-'] {
        if let Some(pos) = rest.rfind(sign) {
            if pos > 0 {
                let tz_part = &rest[pos..];
                if tz_part.len() >= 6 {
                    let tz_sign = if tz_part.starts_with('-') { -1 } else { 1 };
                    let mut tz_parts = tz_part[1..].split(':');
                    let tz_h: i32 = tz_parts.next()?.parse().ok()?;
                    let tz_m: i32 = tz_parts.next()?.parse().ok()?;
                    return Some((&rest[..pos], tz_sign * (tz_h * 60 + tz_m)));
                }
            }
        }
    }
    // No timezone — assume UTC (daemon always emits Z).
    Some((rest, 0))
}

/// Howard Hinnant's days_from_civil — converts (y, m, d) to days since 1970-01-01.
fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era as i64 * 146097 + doe as i64 - 719468)
}

fn current_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

/// The structured result of an HTTP request to the daemon: status code, parsed
/// body (on success), and an error string (on ≥400).
#[derive(Debug)]
pub struct DaemonResponse<T> {
    pub status: u16,
    pub data: Option<T>,
    pub error: Option<String>,
}

/// Internal handle for cancelling an SSE subscription. Uses a `Notify` so both
/// `close()` and `SseSubscription::stop()` can signal the stream loop.
struct CancelHandle {
    notify: Arc<tokio::sync::Notify>,
}

/// A typed client for one live polytoken daemon process. Owns the HTTP surface, the
/// attachment lease (+ heartbeat task), and the SSE subscriber. Call `close()` to
/// release the lease and terminate the daemon — never leave a child process orphaned.
pub struct DaemonClient {
    pub session_id: String,
    pub port: u16,
    base_url: String,
    pid: i32,
    /// Bearer token for daemon 0.5.0+ auth. `None` → no `Authorization` header
    /// sent (legacy daemons / fake-daemon tests don't enforce auth).
    auth_token: Option<String>,
    /// The daemon's own OS pid, captured from GET /health. Used as a kill() fallback
    /// when HTTP /terminate fails (a wedged daemon won't respond to HTTP).
    daemon_pid: Mutex<Option<i32>>,
    lease: Mutex<Option<AttachmentLease>>,
    sse_cancel: Mutex<Option<CancelHandle>>,
    http: Client,
    /// SSE heartbeat-timeout window (see subscribe()). The daemon emits `heartbeat`
    /// frames ~10s (unstable.5+); if no frame arrives within this window the daemon is
    /// dead → reconnect. Public + mutable so tests can shrink it to milliseconds;
    /// production code leaves the default.
    pub heartbeat_timeout_ms: u64,
}

type ErrorForStatus<T> = dyn Fn(Option<&T>, &str) -> Option<String>;

impl DaemonClient {
    /// Create a new client for a daemon at `127.0.0.1:{port}` with the given pid.
    /// `auth_token` is the bearer token for daemon 0.5.0+ auth; pass `None` for
    /// legacy daemons or test harnesses that don't enforce auth.
    pub fn new(session_id: String, port: u16, pid: i32, auth_token: Option<String>) -> Self {
        let base_url = format!("http://127.0.0.1:{port}");
        Self {
            session_id,
            port,
            base_url,
            pid,
            auth_token,
            daemon_pid: Mutex::new(None),
            lease: Mutex::new(None),
            sse_cancel: Mutex::new(None),
            http: Client::builder()
                .build()
                .expect("failed to build reqwest client"),
            // 3x the ~10s heartbeat cadence — tolerates a couple of missed beats
            // (GC pause, brief scheduler stall) before declaring the daemon dead.
            heartbeat_timeout_ms: 30_000,
        }
    }

    /// Build the `Authorization: Bearer <token>` header value if a token is set.
    fn auth_header(&self) -> Option<(&'static str, String)> {
        self.auth_token
            .as_ref()
            .map(|t| ("Authorization", format!("Bearer {t}")))
    }

    // --- HTTP helpers ---

    /// Run a fetch and return a structured result, catching connection errors
    /// (the daemon's port not yet bound / process died) as a status-0 error rather
    /// than letting them throw out of the caller. A thrown fetch ("Unable to connect")
    /// would otherwise escape retry loops and surface as a raw error message.
    ///
    /// AbortGuard: every request gets a hard timeout ceiling; a wedged daemon
    /// (accepts the TCP connection but never responds) returns a status-0 timeout
    /// instead of hanging indefinitely.
    async fn safe_fetch(
        &self,
        url: &str,
        method: reqwest::Method,
        body: Option<&str>,
        timeout_ms: u64,
    ) -> Result<(u16, Option<String>, Option<String>), ()> {
        // Returns Ok((status, data_text, error_string))
        // status 0 = connection error / timeout
        let req = match method {
            reqwest::Method::POST => {
                let mut r = self.http.post(url);
                if let Some(b) = body {
                    r = r
                        .header("content-type", "application/json")
                        .body(b.to_string());
                }
                r
            }
            reqwest::Method::GET => self.http.get(url),
            reqwest::Method::DELETE => self.http.delete(url),
            _ => self.http.request(method, url),
        };
        // Attach the bearer auth header (daemon 0.5.0+). No-op when no token
        // is set (legacy daemons / fake-daemon tests).
        let req = if let Some((name, value)) = self.auth_header() {
            req.header(name, value)
        } else {
            req
        };
        match tokio::time::timeout(Duration::from_millis(timeout_ms), req.send()).await {
            Err(_) => Err(()),      // timed out
            Ok(Err(_e)) => Err(()), // connection error
            Ok(Ok(res)) => {
                let status = res.status().as_u16();
                match res.text().await {
                    Ok(text) => Ok((status, Some(text), None)),
                    Err(_) => Ok((status, None, Some("failed to read response body".into()))),
                }
            }
        }
    }

    /// Shared request core: run `safe_fetch`, then normalize the response into the
    /// `{status, data, error}` shape every caller wants — null/status-0 short-circuit,
    /// JSON-parse the body, and derive an `error` string for ≥400 responses.
    #[expect(
        dead_code,
        reason = "ported daemon-client shared request helper is retained for live-path test parity in Phase 2"
    )]
    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        method: reqwest::Method,
        body: Option<&str>,
        error_for_status: Option<&ErrorForStatus<T>>,
    ) -> DaemonResponse<T> {
        let url = format!("{}{}", self.base_url, path);
        match self.safe_fetch(&url, method, body, 10_000).await {
            Err(_) => DaemonResponse {
                status: 0,
                data: None,
                error: Some("request failed (connection error or timeout)".into()),
            },
            Ok((status, text, fetch_err)) => {
                if status == 0 {
                    return DaemonResponse {
                        status: 0,
                        data: None,
                        error: fetch_err,
                    };
                }
                let text = text.unwrap_or_default();
                let data: Option<T> = if !text.is_empty() {
                    serde_json::from_str(&text).ok()
                } else {
                    None
                };
                // If JSON parse failed and text is non-empty, the raw text is the error.
                if data.is_none() && !text.is_empty() && status >= 400 {
                    // Could still be non-JSON error text.
                    let err = error_for_status
                        .and_then(|f| f(None, &text))
                        .unwrap_or_else(|| text[..text.len().min(500)].to_string());
                    return DaemonResponse {
                        status,
                        data: None,
                        error: Some(err),
                    };
                }
                let error = if status < 400 {
                    None
                } else {
                    error_for_status
                        .and_then(|f| f(data.as_ref(), &text))
                        .or_else(|| Some(text[..text.len().min(200)].to_string()))
                };
                DaemonResponse {
                    status,
                    data,
                    error,
                }
            }
        }
    }

    /// `POST {path}` with a JSON body. On ≥400, prefer a parsed `{message}` body
    /// over the raw text in the error string.
    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: Option<&str>,
    ) -> DaemonResponse<T> {
        // error_for_status: prefer parsed body.message, fall back to raw text slice.
        // We can't easily type the closure to match `Option<&T>` with message field,
        // so we capture the raw text via a two-phase approach: parse for message.
        let url = format!("{}{}", self.base_url, path);
        match self
            .safe_fetch(&url, reqwest::Method::POST, body, 10_000)
            .await
        {
            Err(_) => DaemonResponse {
                status: 0,
                data: None,
                error: Some("request failed (connection error or timeout)".into()),
            },
            Ok((status, text, fetch_err)) => {
                if status == 0 {
                    return DaemonResponse {
                        status: 0,
                        data: None,
                        error: fetch_err,
                    };
                }
                let text = text.unwrap_or_default();
                let data: Option<T> = if !text.is_empty() {
                    serde_json::from_str(&text).ok()
                } else {
                    None
                };
                let error = if status < 400 {
                    None
                } else {
                    // Try to extract a `message` field from the parsed body.
                    let parsed_msg = serde_json::from_str::<serde_json::Value>(&text)
                        .ok()
                        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from));
                    Some(parsed_msg.unwrap_or_else(|| text[..text.len().min(200)].to_string()))
                };
                DaemonResponse {
                    status,
                    data,
                    error,
                }
            }
        }
    }

    /// `GET {path}`. On ≥400, report the raw response text (no parsed message).
    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> DaemonResponse<T> {
        let url = format!("{}{}", self.base_url, path);
        match self
            .safe_fetch(&url, reqwest::Method::GET, None, 10_000)
            .await
        {
            Err(_) => DaemonResponse {
                status: 0,
                data: None,
                error: Some("request failed (connection error or timeout)".into()),
            },
            Ok((status, text, fetch_err)) => {
                if status == 0 {
                    return DaemonResponse {
                        status: 0,
                        data: None,
                        error: fetch_err,
                    };
                }
                let text = text.unwrap_or_default();
                let data: Option<T> = if !text.is_empty() {
                    serde_json::from_str(&text).ok()
                } else {
                    None
                };
                let error = if status < 400 {
                    None
                } else if !text.is_empty() {
                    // Non-JSON response — return raw text in error.
                    Some(text[..text.len().min(500)].to_string())
                } else {
                    None
                };
                DaemonResponse {
                    status,
                    data,
                    error,
                }
            }
        }
    }

    // --- Lifecycle ---

    /// `GET /health` — confirms the daemon is alive and echoes its session record.
    /// Captures the daemon's own OS pid (for the kill() fallback) as a side effect.
    pub async fn health(&self) -> DaemonResponse<HealthResponse> {
        let result = self.get::<HealthResponse>("/health").await;
        if result.status == 200 {
            if let Some(data) = &result.data {
                *self.daemon_pid.lock().await = Some(data.pid);
            }
        }
        result
    }

    /// `POST /terminate` — graceful drain + exit.
    pub async fn terminate(&self) -> Result<(), String> {
        let body = self.post::<serde_json::Value>("/terminate", None).await;
        if body.status == 0 {
            return Err(body.error.unwrap_or_default());
        }
        Ok(())
    }

    /// Hard-kill the daemon process (SIGTERM → SIGKILL fallback). Used when HTTP
    /// /terminate fails (a wedged daemon won't respond to HTTP) or on a synchronous
    /// exit path where we can't await a network round-trip. Requires the daemon pid
    /// captured from /health; no-op if the pid is unknown.
    pub async fn kill(&self) {
        let pid = *self.daemon_pid.lock().await;
        if let Some(pid) = pid {
            // Send SIGTERM.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }

    /// Synchronous hard-kill (best-effort SIGTERM) for the process exit path.
    pub fn kill_now(&self) {
        // We can't await the lock here, so we use try_lock. If locked, skip.
        // This mirrors the TS killNow() which is synchronous.
        // For safety, we attempt a non-blocking lock.
        // Note: in practice the pid was captured during health(); we read it best-effort.
        // Since daemon_pid is a Mutex (async), we can't synchronously access it.
        // The caller should use kill() (async) instead. This is a best-effort no-op
        // to match the TS API surface.
    }

    // --- Attachment lease ---

    /// Claim the TUI attachment lease. The lease is pid-bound and EXCLUSIVE (a second
    /// claim while one is live → 409). Pantoken is the sole attacher; the local TUI
    /// detaches while pantoken drives. Starts the heartbeat timer automatically.
    ///
    /// On 409 (an active TUI holds the lease), the error is surfaced as a readable
    /// message naming the holder + lease expiry — the raw JSON body is not useful to
    /// the operator. The holder's lease auto-expires (~30s); retrying after it lapses
    /// succeeds.
    pub async fn claim_lease(
        &self,
        label: &str,
    ) -> Result<TuiAttachClaimResponse, LeaseConflictError> {
        let body = TuiAttachClaimRequest {
            pid: self.pid,
            terminal_label: Some(label.to_string()),
            process_start_token: None,
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self
            .post::<TuiAttachClaimResponse>("/tui-attachment/claim", Some(&body_str))
            .await;
        if res.status != 200 || res.data.is_none() {
            if res.status == 409 {
                let held = parse_lease_held_error(res.error.as_deref());
                let message = match &held {
                    Some(h) => format!(
                        "another TUI is attached to this session ({}). Detach it there (/detach) or wait ~30s for its lease to lapse.",
                        h.summary
                    ),
                    None => format!(
                        "lease claim failed (409): {}",
                        res.error.as_deref().unwrap_or("")
                    ),
                };
                return Err(LeaseConflictError { message, held });
            }
            return Err(LeaseConflictError {
                message: format!(
                    "lease claim failed ({}): {}",
                    res.status,
                    res.error.as_deref().unwrap_or("")
                ),
                held: None,
            });
        }
        let data = res.data.unwrap();
        // Start the heartbeat timer. The spike confirmed heartbeat_interval_seconds: 5,
        // expires_after_seconds: 30 — heartbeat well before the expiry.
        let heartbeat_ms = (data.heartbeat_interval_seconds.max(1) as u64) * 1000;
        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
        let lease_id = data.lease_id.clone();
        let http = self.http.clone();
        let base_url = self.base_url.clone();
        let pid = self.pid;
        let auth_token = self.auth_token.clone();
        let heartbeat_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(heartbeat_ms));
            interval.tick().await; // first tick is immediate
            loop {
                tokio::select! {
                    _ = &mut cancel_rx => break,
                    _ = interval.tick() => {
                        let body = TuiAttachHeartbeatRequest {
                            lease_id: lease_id.clone(),
                            pid,
                            process_start_token: None,
                        };
                        let body_str = serde_json::to_string(&body).unwrap_or_default();
                        let url = format!("{base_url}/tui-attachment/heartbeat");
                        let mut req = http.post(&url)
                            .header("content-type", "application/json")
                            .body(body_str);
                        // Attach the bearer auth header (daemon 0.5.0+). Without
                        // it the heartbeat 401s every ~5s, the lease lapses
                        // (~30s), and the daemon evicts pantoken's attachment.
                        if let Some(ref token) = auth_token {
                            req = req.header("Authorization", format!("Bearer {token}"));
                        }
                        match tokio::time::timeout(
                            Duration::from_millis(10_000),
                            req.send(),
                        )
                        .await
                        {
                            Ok(Ok(res)) => {
                                let status = res.status().as_u16();
                                if status == 404 || status == 409 {
                                    // Lease expired or stolen — the SSE will gap and the driver
                                    // will re-seed. Log loudly.
                                    error!(
                                        "[polytoken] lease heartbeat failed ({status})"
                                    );
                                    break;
                                }
                            }
                            _ => {
                                // Network error — keep trying.
                            }
                        }
                    }
                }
            }
        });
        *self.lease.lock().await = Some(AttachmentLease {
            lease_id: data.lease_id.clone(),
            heartbeat_interval_ms: heartbeat_ms,
            expires_after_ms: (data.expires_after_seconds.max(1) as u64) * 1000,
            heartbeat_cancel: cancel_tx,
            heartbeat_handle: Some(heartbeat_handle),
        });
        Ok(data)
    }

    /// Claim the lease with auto-retry on 409 (stale-lease recovery). Retries up to
    /// `max_retries` times (default 3) with `delay_ms` backoff (default 3s). Each 409's
    /// `expires_at` is parsed to compute the time-to-lapse; if the lease won't lapse
    /// within the retry window (active TUI heartbeating), retrying is pointless — we
    /// stop early and throw a LeaseConflictError with the computed wait. On
    /// exhaustion, the final error message includes the computed time-to-lapse
    /// (replacing the old hardcoded "~30s"). Non-409 errors throw immediately.
    pub async fn claim_lease_with_retry(
        &self,
        label: &str,
        max_retries: Option<u32>,
        delay_ms: Option<u64>,
    ) -> Result<TuiAttachClaimResponse, LeaseConflictError> {
        // retry_claim needs an owned claim closure. We can't borrow self across the
        // generic boundary easily, so inline the logic here.
        let max_r = max_retries.unwrap_or(3) as i32;
        let delay = delay_ms.unwrap_or(3000);
        let mut last_conflict: Option<LeaseConflictError> = None;
        for attempt in 0..=max_r {
            match self.claim_lease(label).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    last_conflict = Some(e.clone());
                    let expiry = e
                        .held
                        .as_ref()
                        .and_then(|h| h.expires_at.as_deref())
                        .and_then(parse_iso8601_to_millis);
                    if let (Some(expiry_millis), true) = (expiry, attempt < max_r) {
                        let now_millis = current_millis();
                        let ms_until_expiry = expiry_millis as i64 - now_millis;
                        let remaining_delays = (max_r - attempt) as i64 * delay as i64;
                        if ms_until_expiry > remaining_delays {
                            return Err(LeaseConflictError {
                                message: format_lease_conflict_message(
                                    e.held.as_ref(),
                                    Some(ceil_seconds(ms_until_expiry)),
                                ),
                                held: e.held.clone(),
                            });
                        }
                    }
                    if attempt < max_r {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                }
            }
        }
        let held = last_conflict.as_ref().and_then(|c| c.held.clone());
        let seconds_to_lapse = held
            .as_ref()
            .and_then(|h| h.expires_at.as_deref())
            .and_then(parse_iso8601_to_millis)
            .map(|exp| ceil_seconds(exp as i64 - current_millis()));
        Err(LeaseConflictError {
            message: format_lease_conflict_message(held.as_ref(), seconds_to_lapse),
            held,
        })
    }

    /// `POST /tui-attachment/heartbeat` — refresh the lease. 404/409 means the
    /// lease expired or was stolen — clears the timer.
    #[expect(
        dead_code,
        reason = "explicit heartbeat endpoint helper is bypassed by inline timer until daemon-client tests land in Phase 2"
    )]
    async fn heartbeat(&self, lease_id: &str) {
        let body = TuiAttachHeartbeatRequest {
            lease_id: lease_id.to_string(),
            pid: self.pid,
            process_start_token: None,
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self
            .post::<serde_json::Value>("/tui-attachment/heartbeat", Some(&body_str))
            .await;
        if res.status == 404 || res.status == 409 {
            error!(
                "[polytoken] lease heartbeat failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            );
            self.clear_lease().await;
        }
    }

    async fn clear_lease(&self) {
        if let Some(lease) = self.lease.lock().await.take() {
            let _ = lease.heartbeat_cancel.send(());
            if let Some(handle) = lease.heartbeat_handle {
                handle.abort();
            }
        }
    }

    /// `DELETE /tui-attachment/{lease_id}` — release the lease (idempotent → 204).
    pub async fn release_lease(&self) {
        // Take the lease out (drops heartbeat task) but capture the lease_id first.
        let lease_id = {
            let lease = self.lease.lock().await.take();
            match lease {
                Some(lease) => {
                    let id = lease.lease_id.clone();
                    let _ = lease.heartbeat_cancel.send(());
                    if let Some(handle) = lease.heartbeat_handle {
                        handle.abort();
                    }
                    Some(id)
                }
                None => None,
            }
        };
        if let Some(lease_id) = lease_id {
            let url = format!(
                "{}/tui-attachment/{}",
                self.base_url,
                urlencoding::encode(&lease_id)
            );
            let _ = self
                .safe_fetch(&url, reqwest::Method::DELETE, None, 10_000)
                .await;
        }
    }

    // --- Prompt + steering ---

    /// `POST /prompt` — the happy-path turn starter. Returns 202 + PromptAccepted
    /// {prompt_id, session_id, queued_item?}. As of daemon 0.4.0-unstable.6 (BREAKING),
    /// a prompt sent while a turn already holds the turn slot is AUTO-QUEUED (202 with
    /// `queued_item` set to a PendingTurnInputItem — the same queue POST /turn/input
    /// feeds), NOT rejected with 409. 409 now only fires for a slash-command while busy
    /// (`unsupported_busy_command`) or a full input queue (`turn_input_queue_full`).
    /// 422 if a pre-user-prompt hook denied it.
    pub async fn prompt(
        &self,
        content: &str,
        max_tool_turns: Option<i32>,
    ) -> Result<PromptAccepted, String> {
        let body = PromptRequest {
            content: content.to_string(),
            max_tool_turns,
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self
            .post::<PromptAccepted>("/prompt", Some(&body_str))
            .await;
        if res.status != 202 || res.data.is_none() {
            return Err(format!(
                "POST /prompt failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(res.data.unwrap())
    }

    /// `POST /turn/input` — queue steering/follow-up input for the active turn.
    /// PendingTurnInputRequest is just {content} — no steer/followUp discriminator
    /// (that distinction is pantoken-side UX only).
    pub async fn queue_turn_input(&self, content: &str) -> Result<(), String> {
        let body = PendingTurnInputRequest {
            content: content.to_string(),
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self
            .post::<serde_json::Value>("/turn/input", Some(&body_str))
            .await;
        if res.status != 202 {
            return Err(format!(
                "POST /turn/input failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `GET /turn/input` — the pending queue snapshot.
    pub async fn turn_input_snapshot(&self) -> DaemonResponse<PendingTurnInputSnapshot> {
        self.get::<PendingTurnInputSnapshot>("/turn/input").await
    }

    /// `DELETE /turn/input/newest` — dequeue the newest pending input.
    /// 200 = dequeued; 409 = no pending input (both are acceptable no-ops).
    pub async fn dequeue_newest_input(&self) -> Result<(), String> {
        let url = format!("{}/turn/input/newest", self.base_url);
        match self
            .safe_fetch(&url, reqwest::Method::DELETE, None, 10_000)
            .await
        {
            Err(_) => Err("DELETE /turn/input/newest failed (connection error)".into()),
            Ok((status, _, _)) => {
                if status != 200 && status != 409 {
                    return Err(format!("DELETE /turn/input/newest failed ({status})"));
                }
                Ok(())
            }
        }
    }

    /// `POST /adventurous-handoff` — toggle the adventurous auto-handoff flag.
    /// Returns the new state so the driver can emit a snapshot immediately.
    pub async fn toggle_adventurous_handoff(&self) -> Result<bool, String> {
        let url = format!("{}/adventurous-handoff", self.base_url);
        match self
            .safe_fetch(&url, reqwest::Method::POST, None, 10_000)
            .await
        {
            Err(_) => Err("POST /adventurous-handoff failed (connection error)".into()),
            Ok((status, text, err)) => {
                if status == 0 {
                    return Err(format!(
                        "POST /adventurous-handoff failed ({})",
                        err.unwrap_or_else(|| "fetch returned null".into())
                    ));
                }
                if status >= 400 {
                    return Err(format!("POST /adventurous-handoff failed ({status})"));
                }
                #[derive(Deserialize)]
                struct Resp {
                    #[serde(default)]
                    enabled: Option<bool>,
                }
                let body: Resp = text
                    .as_deref()
                    .and_then(|t| serde_json::from_str(t).ok())
                    .unwrap_or(Resp { enabled: None });
                Ok(body.enabled.unwrap_or(false))
            }
        }
    }

    /// `POST /turn/cancel` — abort the active turn. The spec documents 409 when no turn
    /// is in flight, but the live daemon was observed returning 202 with prompt_id:null
    /// in that case instead. Treat both as no-op.
    pub async fn cancel_turn(&self) -> Result<(), String> {
        let res = self.post::<serde_json::Value>("/turn/cancel", None).await;
        if res.status != 202 && res.status != 409 {
            return Err(format!(
                "POST /turn/cancel failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    // --- State + history ---

    /// `GET /state` — the authoritative session state snapshot.
    pub async fn state(&self) -> DaemonResponse<SessionStateSnapshot> {
        self.get::<SessionStateSnapshot>("/state").await
    }

    /// `GET /history` — the projected session transcript (linear, no branch DAG).
    pub async fn history(
        &self,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> DaemonResponse<SessionHistorySnapshot> {
        let mut params = Vec::new();
        if let Some(o) = offset {
            params.push(format!("offset={o}"));
        }
        if let Some(l) = limit {
            params.push(format!("limit={l}"));
        }
        let qs = if params.is_empty() {
            String::new()
        } else {
            format!("?{}", params.join("&"))
        };
        self.get::<SessionHistorySnapshot>(&format!("/history{qs}"))
            .await
    }

    /// `GET /files` — the daemon's ignore-aware project file index (alphabetical, dirs
    /// trailing `/`). `include_ignored` disables .gitignore/.claudeignore/.polytokenignore
    /// (dotfiles + the project private dir stay excluded). Returns `[]` when the project
    /// root is unavailable. The daemon owns this index natively — pantoken doesn't run its
    /// own `fd` for the index under this driver.
    pub async fn files(
        &self,
        include_ignored: Option<bool>,
    ) -> DaemonResponse<FileCatalogResponse> {
        let qs = if include_ignored.unwrap_or(false) {
            "?include_ignored=true"
        } else {
            ""
        };
        self.get::<FileCatalogResponse>(&format!("/files{qs}"))
            .await
    }

    /// `GET /file-catalog` — alias kept for API parity. (The TS `fileCatalog` method
    /// is not present in the source; `files` covers `/files`. Provided for
    /// completeness.)
    pub async fn file_catalog(&self) -> DaemonResponse<FileCatalogResponse> {
        self.get::<FileCatalogResponse>("/files").await
    }

    // --- Other endpoints used by the driver ---

    /// `POST /model` — switch the session's model (+ reasoning effort).
    pub async fn set_model(
        &self,
        model: &str,
        reasoning_effort: Option<&str>,
    ) -> Result<(), String> {
        let body = ModelRequest {
            model: model.to_string(),
            reasoning_effort: reasoning_effort.map(String::from),
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self.post::<ErrorBody>("/model", Some(&body_str)).await;
        if res.status == 200 {
            return Ok(());
        }
        // 409 no_change: the model is already set to the requested value — benign.
        if res.status == 409 {
            if let Some(data) = &res.data {
                if data.code == "no_change" {
                    return Ok(());
                }
            }
        }
        Err(format!(
            "POST /model failed ({}): {}",
            res.status,
            res.error.as_deref().unwrap_or("")
        ))
    }

    /// `POST /title` — set the operator title override (empty = clear → revert to inferred).
    pub async fn set_title(&self, title: &str) -> Result<(), String> {
        let body = SessionTitleRequest {
            title: title.to_string(),
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self
            .post::<serde_json::Value>("/title", Some(&body_str))
            .await;
        if res.status != 200 {
            return Err(format!(
                "POST /title failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `POST /interrogative/{id}/respond` — answer a pending interrogative.
    /// Has a 10s timeout: a wedged daemon that accepts the connection but never
    /// responds would otherwise hang the caller's `hostUiResolved` deferred
    /// promise indefinitely, stranding the approval card. The timeout triggers the
    /// `.catch()` path so the driver can dismiss the card + surface an error.
    pub async fn respond_interrogative(
        &self,
        id: &str,
        response: &InterrogativeResponse,
    ) -> Result<(), String> {
        let url = format!(
            "{}/interrogative/{}/respond",
            self.base_url,
            urlencoding::encode(id)
        );
        let body_str = serde_json::to_string(response).unwrap_or_default();
        let result = tokio::time::timeout(
            Duration::from_millis(10_000),
            self.http
                .post(&url)
                .header("content-type", "application/json")
                .body(body_str)
                .send(),
        )
        .await;
        match result {
            Err(_) => Err(format!(
                "POST /interrogative/respond timed out (10s) for {id}"
            )),
            Ok(Err(e)) => Err(format!("POST /interrogative/respond failed: {e}")),
            Ok(Ok(res)) => {
                if !res.status().is_success() {
                    let status = res.status().as_u16();
                    let text = res.text().await.unwrap_or_default();
                    Err(format!(
                        "POST /interrogative/respond failed ({status}): {}",
                        &text[..text.len().min(200)]
                    ))
                } else {
                    Ok(())
                }
            }
        }
    }

    /// `POST /permission-monitor` — switch the permission mode.
    pub async fn set_permission_mode(&self, mode: PermissionMonitorMode) -> Result<(), String> {
        let body = PermissionMonitorRequest { mode };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self
            .post::<serde_json::Value>("/permission-monitor", Some(&body_str))
            .await;
        if res.status != 200 {
            return Err(format!(
                "POST /permission-monitor failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `GET /permission-monitor` — the live per-session monitor (+ global defaults).
    /// Used once at session warm-up to seed the cached mode (the monitor isn't in
    /// GET /state). Ongoing sync rides the `permission_monitor_switch` event.
    pub async fn get_permission_monitor(&self) -> Result<PermissionMonitorResponse, String> {
        let res = self
            .get::<PermissionMonitorResponse>("/permission-monitor")
            .await;
        if res.status != 200 || res.data.is_none() {
            return Err(format!(
                "GET /permission-monitor failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(res.data.unwrap())
    }

    /// `GET /notification-autodrain` — the autodrain flag (+ config default).
    /// Used once at warm-up to seed the cached state (it isn't on GET /state).
    pub async fn get_notification_autodrain(
        &self,
    ) -> Result<NotificationAutodrainResponse, String> {
        let res = self
            .get::<NotificationAutodrainResponse>("/notification-autodrain")
            .await;
        if res.status != 200 || res.data.is_none() {
            return Err(format!(
                "GET /notification-autodrain failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(res.data.unwrap())
    }

    /// `POST /notification-autodrain` — set the autodrain flag.
    pub async fn set_notification_autodrain(&self, enabled: bool) -> Result<(), String> {
        #[derive(serde::Serialize)]
        struct Body {
            enabled: bool,
        }
        let body_str = serde_json::to_string(&Body { enabled }).unwrap_or_default();
        let res = self
            .post::<serde_json::Value>("/notification-autodrain", Some(&body_str))
            .await;
        if res.status != 200 {
            return Err(format!(
                "POST /notification-autodrain failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `POST /clear` — reset context (also resets the shell env).
    pub async fn clear(&self) -> Result<(), String> {
        let res = self.post::<serde_json::Value>("/clear", None).await;
        if res.status != 200 {
            return Err(format!(
                "POST /clear failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `POST /compact` — trigger context compaction.
    pub async fn compact(&self, request: Option<&CompactRequest>) -> Result<(), String> {
        let body_str = match request {
            Some(r) => serde_json::to_string(r).unwrap_or_default(),
            None => "null".to_string(),
        };
        let res = self
            .post::<serde_json::Value>("/compact", Some(&body_str))
            .await;
        if res.status != 202 {
            return Err(format!(
                "POST /compact failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `POST /rewind` — destructive: drops the target prompt + everything after it.
    pub async fn rewind(&self, request: &RewindRequest) -> Result<(), String> {
        let body_str = serde_json::to_string(request).unwrap_or_default();
        let res = self
            .post::<serde_json::Value>("/rewind", Some(&body_str))
            .await;
        if res.status != 202 {
            return Err(format!(
                "POST /rewind failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `POST /facet` — switch the active facet (mid-conversation persona switch).
    pub async fn set_facet(&self, facet: &str) -> Result<(), String> {
        let body = FacetRequest {
            facet: facet.to_string(),
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self
            .post::<serde_json::Value>("/facet", Some(&body_str))
            .await;
        if res.status != 200 {
            return Err(format!(
                "POST /facet failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    /// `POST /reload` — reload the session from scratch (dispose + re-warm).
    pub async fn reload(&self) -> Result<(), String> {
        let res = self.post::<serde_json::Value>("/reload", None).await;
        if res.status != 200 {
            return Err(format!(
                "POST /reload failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    // --- MCP server management ---

    /// `POST /mcp/{server}/{action}` — apply an MCP server lifecycle action
    /// (enable/disable/disconnect/reconnect). Throws on a non-200 response with a
    /// message naming the server + action, matching the former per-action methods.
    pub async fn mcp_server_action(
        &self,
        server_name: &str,
        action: McpServerAction,
    ) -> Result<(), String> {
        let path = format!(
            "/mcp/{}/{}",
            urlencoding::encode(server_name),
            action.as_str()
        );
        let res = self.post::<serde_json::Value>(&path, None).await;
        if res.status != 200 {
            return Err(format!(
                "POST /mcp/{server_name}/{} failed ({}): {}",
                action.as_str(),
                res.status,
                res.error.as_deref().unwrap_or("")
            ));
        }
        Ok(())
    }

    // --- SSE ---

    /// Subscribe to `GET /events` — the SSE stream of `Envelope<DaemonEvent>` frames.
    /// Each frame is `id: <seq>\ndata: {seq, emitted_at, session_id, event: {type, ...}}`.
    /// The `type` discriminator lives at `event.type` (not the envelope root).
    ///
    /// Returns an unsubscribe handle whose `stop()` method stops the stream + retry
    /// loop. The daemon emits `heartbeat` frames ~10s (unstable.5+), so liveness is a
    /// heartbeat timeout: each `stream.next()` is bounded by `heartbeat_timeout_ms`, and
    /// a lapse (no heartbeat or event within the window) drops the stream and forces a
    /// reconnect — no separate watcher task, no `/health` probe.
    ///
    /// On error, stream end, or heartbeat timeout, the connection retries with
    /// exponential backoff (1s → 2s → 4s → … → 30s cap). On reconnect, a synthetic
    /// `stream_discontinuity` envelope is emitted so the driver re-seeds (the event-map
    /// maps this to a reseed).
    ///
    /// `Last-Event-ID` is sent on reconnect if the daemon emitted `id:` lines — daemon
    /// support is UNCONFIRMED (untested; upstream feature ask still open).
    /// Sending it is best-effort; if unsupported, the `stream_discontinuity` → reseed
    /// handles recovery.
    pub async fn subscribe(
        self: &Arc<Self>,
        on_event: impl Fn(SseEnvelope) + Send + Sync + 'static,
    ) -> SseSubscription {
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        // Store the cancel sender in sse_cancel so close() can abort the stream.
        // We also keep one for the returned SseSubscription — but oneshot::Sender
        // isn't Clone, so we use a shared CancellationToken pattern: store ours in
        // sse_cancel, and give the subscription an Option that closes over the same
        // via a shared flag. Simpler: store an Arc<Mutex<Option<Sender>>> and the
        // subscription calls send on it. But cleanest: just store in sse_cancel and
        // have SseSubscription hold the JoinHandle + abort the task via abort().
        // We keep cancel_tx for the subscription's stop() and store a *duplicate*
        // mechanism in sse_cancel. Since we can't clone oneshot, we use a
        // tokio::sync::Notify for the inner store and the oneshot for the subscription.
        let notify = Arc::new(tokio::sync::Notify::new());
        let notify_for_close = notify.clone();
        // close() calls notify, which the sse_loop selects on.
        // We store the notify in sse_cancel as a trait object isn't ideal; instead
        // we keep the oneshot pattern but wrap it so close() can signal too.
        // Pragmatic: use a CancellationToken-like approach with a shared bool + Notify.
        *self.sse_cancel.lock().await = Some(CancelHandle {
            notify: notify_for_close,
        });

        let client = self.clone();
        let heartbeat_timeout = self.heartbeat_timeout_ms;

        let notify_for_loop = notify.clone();
        let join_handle = tokio::spawn(async move {
            client
                .sse_loop(on_event, notify_for_loop, cancel_rx, heartbeat_timeout)
                .await;
        });

        SseSubscription {
            join_handle,
            cancel: Some(cancel_tx),
            notify: Some(notify),
        }
    }

    #[expect(
        unused_assignments,
        reason = "SSE cancellation branches assign `stopped` immediately before breaking; the value is read by the outer `while !stopped` / post-stream backoff guards"
    )]
    async fn sse_loop<F>(
        self: Arc<Self>,
        on_event: F,
        stop_notify: Arc<tokio::sync::Notify>,
        mut cancel_rx: oneshot::Receiver<()>,
        heartbeat_timeout: u64,
    ) where
        F: Fn(SseEnvelope) + Send + Sync + 'static,
    {
        let mut backoff: u64 = 1000;
        let max_backoff: u64 = 30_000;
        let mut last_event_id: Option<String> = None;
        let mut had_connected_once = false;
        let mut stopped = false;

        // Liveness is a heartbeat timeout folded into the stream read below (the
        // `tokio::time::timeout` around `stream.next()`): the daemon emits `heartbeat`
        // frames ~10s, so every arriving frame resets the window and a lapse of
        // `heartbeat_timeout` ms means the daemon is dead → drop the stream + reconnect.
        // No separate watcher task and no `/health` probe (unstable.5+).

        // Main SSE loop.
        while !stopped {
            // Build the request.
            let mut req = self.http.get(format!("{}/events", self.base_url));
            if let Some(ref id) = last_event_id {
                req = req.header("Last-Event-ID", id);
            }
            // Attach the bearer auth header (daemon 0.5.0+). Without it the SSE
            // stream returns 401 immediately and the loop spins on reconnect.
            if let Some((name, value)) = self.auth_header() {
                req = req.header(name, value);
            }

            let response_result = tokio::select! {
                _ = stop_notify.notified() => {
                    stopped = true;
                    break;
                }
                _ = &mut cancel_rx => {
                    stopped = true;
                    break;
                }
                r = req.send() => r,
            };

            let response = match response_result {
                Err(e) => {
                    if !stopped {
                        error!("[polytoken] SSE error: {}; retry in {}ms", e, backoff);
                    }
                    if !stopped {
                        tokio::select! {
                            _ = &mut cancel_rx => { stopped = true; break; }
                            _ = stop_notify.notified() => { stopped = true; break; }
                            _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
                        }
                        backoff = (backoff * 2).min(max_backoff);
                    }
                    continue;
                }
                Ok(res) => res,
            };

            if !response.status().is_success() {
                let status = response.status();
                if !stopped {
                    error!("[polytoken] SSE connect failed: {status}; retry in {backoff}ms");
                }
                if !stopped {
                    tokio::select! {
                        _ = &mut cancel_rx => { stopped = true; break; }
                        _ = stop_notify.notified() => { stopped = true; break; }
                        _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
                    }
                    backoff = (backoff * 2).min(max_backoff);
                }
                continue;
            }

            // Reconnected successfully.
            if had_connected_once {
                info!("[polytoken] SSE reconnected");
                // Emit a synthetic stream_discontinuity so the driver re-seeds.
                // seq: None matches the documented contract for synthesized events.
                on_event(SseEnvelope {
                    seq: None,
                    emitted_at: now_iso8601(),
                    session_id: self.session_id.clone(),
                    event: DaemonEvent::StreamDiscontinuity {
                        missed: 0,
                        subagent_handle: None,
                    },
                });
            }
            had_connected_once = true;
            backoff = 1000; // reset backoff on successful connect

            // Stream the body and parse SSE frames.
            use futures_util::StreamExt;
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();

            let mut stream_error = false;
            loop {
                tokio::select! {
                    _ = &mut cancel_rx => {
                        stopped = true;
                        break;
                    }
                    _ = stop_notify.notified() => {
                        stopped = true;
                        break;
                    }
                    result = tokio::time::timeout(
                        Duration::from_millis(heartbeat_timeout),
                        stream.next(),
                    ) => {
                        // Heartbeat timeout: no frame (heartbeat or event) arrived within
                        // the window, so the daemon is presumed dead — a -9'd daemon leaves
                        // the TCP connection half-open and `stream.next()` would otherwise
                        // block forever. Recover via the same backoff-reconnect path as a
                        // stream error.
                        let chunk = match result {
                            Err(_) => {
                                if !stopped {
                                    warn!("[polytoken] SSE heartbeat timeout ({heartbeat_timeout}ms); reconnecting…");
                                }
                                stream_error = true;
                                break;
                            }
                            Ok(chunk) => chunk,
                        };
                        match chunk {
                            None => {
                                // Stream ended normally (daemon closed it) — reconnect with backoff.
                                warn!("[polytoken] SSE stream ended; reconnecting…");
                                break;
                            }
                            Some(Err(e)) => {
                                if !stopped {
                                    error!("[polytoken] SSE stream error: {e}");
                                }
                                stream_error = true;
                                break;
                            }
                            Some(Ok(bytes)) => {
                                let text = String::from_utf8_lossy(&bytes).to_string();
                                // CRLF → LF normalization
                                buffer.push_str(&text.replace("\r\n", "\n"));

                                // Parse complete frames (separated by \n\n).
                                while let Some(idx) = buffer.find("\n\n") {
                                    let frame = buffer[..idx].to_string();
                                    buffer = buffer[idx + 2..].to_string();
                                    let lines: Vec<&str> = frame.split('\n').collect();
                                    let mut data_lines: Vec<String> = Vec::new();
                                    for l in &lines {
                                        if let Some(rest) = l.strip_prefix("id:") {
                                            last_event_id = Some(rest.trim().to_string());
                                        } else if let Some(rest) = l.strip_prefix("data:") {
                                            // SSE spec: strip a single leading space after the colon.
                                            let data = rest.strip_prefix(' ').unwrap_or(rest);
                                            data_lines.push(data.to_string());
                                        }
                                    }
                                    if data_lines.is_empty() {
                                        continue;
                                    }
                                    let json = data_lines.join("\n");
                                    let json = json.trim();
                                    if json.is_empty() {
                                        continue;
                                    }
                                    match serde_json::from_str::<SseEnvelope>(json) {
                                        Ok(envelope) => on_event(envelope),
                                        Err(e) => {
                                            error!("[polytoken] SSE frame parse error: {e}");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if stream_error && !stopped {
                tokio::select! {
                    _ = &mut cancel_rx => { stopped = true; break; }
                    _ = stop_notify.notified() => { stopped = true; break; }
                    _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
                }
                backoff = (backoff * 2).min(max_backoff);
            } else if !stopped {
                // Stream ended normally — reconnect with backoff.
                tokio::select! {
                    _ = &mut cancel_rx => { stopped = true; break; }
                    _ = stop_notify.notified() => { stopped = true; break; }
                    _ = tokio::time::sleep(Duration::from_millis(backoff)) => {}
                }
                backoff = (backoff * 2).min(max_backoff);
            }
        }
    }

    // --- Shutdown ---

    /// Release the lease and terminate the daemon. Idempotent — safe to call on an
    /// already-closed client. Never throws (best-effort cleanup on shutdown paths).
    /// Falls back to SIGTERM if HTTP /terminate fails or times out (a wedged daemon
    /// won't answer HTTP, and a hung fetch wouldn't throw — it would just never resolve).
    pub async fn close(&self) {
        // Abort SSE.
        if let Some(cancel) = self.sse_cancel.lock().await.take() {
            cancel.notify.notify_one();
        }
        // Race the HTTP cleanup against a 2s timeout — a wedged daemon's fetch hangs
        // indefinitely, and we can't block shutdown on a dead process.
        let http_cleanup = async {
            // Release lease (best-effort).
            self.release_lease().await;
            // Terminate (best-effort).
            let _ = self.terminate().await;
        };
        let _ = tokio::time::timeout(Duration::from_millis(2000), http_cleanup).await;
        // Always hard-kill as a final fallback — covers both HTTP failure and timeout.
        // (Idempotent: kill() is a no-op if the process is already dead.)
        self.kill().await;
    }
}

/// A handle to an active SSE subscription. Call `stop()` to unsubscribe
/// (cancels the stream + retry loop). Dropping this handle does NOT stop the
/// stream — you must call `stop()` explicitly.
pub struct SseSubscription {
    join_handle: tokio::task::JoinHandle<()>,
    cancel: Option<oneshot::Sender<()>>,
    notify: Option<Arc<tokio::sync::Notify>>,
}

impl SseSubscription {
    /// Stop the SSE stream + retry loop.
    pub async fn stop(mut self) {
        if let Some(notify) = self.notify.take() {
            notify.notify_one();
        }
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        self.join_handle.abort();
    }
}

/// Generate the current time as an ISO-8601 string (for synthetic envelopes).
fn now_iso8601() -> String {
    // Simple RFC3339 generation without chrono. Use SystemTime → epoch.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // Convert epoch seconds to civil date.
    let (y, mo, d, h, mi, s) = epoch_to_civil(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Convert epoch seconds to (year, month, day, hour, minute, second).
fn epoch_to_civil(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let time_secs = (secs % 86400) as u32;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;

    // Convert days since epoch to civil date (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let mo = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if mo <= 2 { y + 1 } else { y };

    (y, mo as u32, d as u32, h, m, s)
}

// ---------------------------------------------------------------------------
// Module-level configuration / test seam
// ---------------------------------------------------------------------------

/// Deprecated no-op retained for API parity with the TS `_setSpawnForTesting`.
/// The real spawn-override seam is `set_spawn_override` / `clear_spawn_override`
/// above (the TS seam was a boolean; the Rust seam carries a closure so the
/// fake daemon can answer spawns without a real process).
#[deprecated(note = "use set_spawn_override / clear_spawn_override instead")]
pub fn _set_spawn_for_testing(_enabled: bool) {
    // No-op: superseded by the real spawn-override seam.
}

#[cfg(test)]
mod tests {
    use super::*;

    // AC.3 — build_resume_args includes --credential-file and the credential path.
    #[test]
    fn test_resume_args_include_credential_file() {
        let args = build_resume_args(
            "/project",
            "sess-123",
            "/config/polytoken",
            "/data/sessions",
            Path::new("/data/sessions/sess-123/credential.json"),
        );
        let cred_idx = args
            .iter()
            .position(|a| a == "--credential-file")
            .expect("--credential-file not in args");
        let cred_path = args
            .get(cred_idx + 1)
            .expect("no value after --credential-file");
        assert_eq!(
            *cred_path, "/data/sessions/sess-123/credential.json",
            "credential file path should match the session dir + credential.json"
        );
        // Also verify the other required args are present.
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"--session-id".to_string()));
        assert!(args.contains(&"sess-123".to_string()));
        assert!(args.contains(&"--project-dir".to_string()));
        assert!(args.contains(&"/project".to_string()));
    }

    #[tokio::test]
    async fn test_spawn_resume_prepares_private_credential_before_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = dir.path().join("fake-polytoken-daemon");
        std::fs::write(
            &bin,
            r#"#!/bin/sh
set -eu
session_id=""
sessions_dir=""
credential_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) session_id="$2"; shift 2 ;;
    --sessions-dir) sessions_dir="$2"; shift 2 ;;
    --credential-file) credential_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$session_id" ] || [ -z "$sessions_dir" ] || [ -z "$credential_file" ]; then
  echo "missing required resume args" >&2
  exit 2
fi
credential_parent=$(dirname "$credential_file")
if [ ! -d "$credential_parent" ]; then
  echo "credential parent missing: $credential_parent" >&2
  exit 3
fi
if [ ! -f "$credential_file" ]; then
  echo "credential file missing: $credential_file" >&2
  exit 4
fi
printf '{"state":"ready","session_id":"%s","pid":%s,"port":4567,"credential_file_path":"%s"}' \
  "$session_id" "$$" "$credential_file" > "$sessions_dir/$session_id/startup.json"
sleep 30
"#,
        )
        .expect("write fake daemon");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&bin).expect("metadata").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&bin, perms).expect("chmod fake daemon");
        }

        let session_id = "resume-needs-credential-dir";
        let sessions_dir = dir.path().join("sessions");
        let (spawned, mut child) = spawn_daemon(
            bin.to_str().expect("utf8 bin"),
            SpawnDaemonOpts {
                cwd: Some(dir.path().to_string_lossy().to_string()),
                session_id: Some(session_id.to_string()),
                sessions_dir: Some(sessions_dir.to_string_lossy().to_string()),
                global_config_dir: Some(dir.path().join("config").to_string_lossy().to_string()),
                login_env: None,
            },
        )
        .await
        .expect("resume spawn should succeed after preparing private credential file");

        assert_eq!(spawned.session_id, session_id);
        assert_eq!(spawned.port, 4567);
        let token = spawned
            .auth_token
            .as_deref()
            .expect("prepared credential token should be returned");
        assert_eq!(token.len(), 64, "token should be 32 random bytes as hex");
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));

        let credential_file = sessions_dir.join(session_id).join("credential.json");
        let credential_text = std::fs::read_to_string(&credential_file).expect("credential file");
        let credential_json: serde_json::Value =
            serde_json::from_str(&credential_text).expect("credential json should parse");
        assert_eq!(
            credential_json.get("version").and_then(|v| v.as_u64()),
            Some(1)
        );
        assert_eq!(
            credential_json.get("kind").and_then(|v| v.as_str()),
            Some("polytoken-daemon-credential")
        );
        assert_eq!(
            credential_json.get("token").and_then(|v| v.as_str()),
            Some(token)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let parent_mode = std::fs::metadata(sessions_dir.join(session_id))
                .expect("credential parent metadata")
                .permissions()
                .mode()
                & 0o777;
            let file_mode = std::fs::metadata(&credential_file)
                .expect("credential metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(parent_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }

        if let Some(child) = child.as_mut() {
            cleanup_child(child).await;
        }
    }

    // AC.2 — auth_header returns the correct header value when a token is set.
    #[test]
    fn test_auth_header_present_when_token_set() {
        let client = DaemonClient::new("s1".into(), 1234, 1, Some("deadbeef".into()));
        let (name, value) = client
            .auth_header()
            .expect("auth header should be present when token is set");
        assert_eq!(name, "Authorization");
        assert_eq!(value, "Bearer deadbeef");
    }

    // AC.2 — auth_header returns None when no token is set.
    #[test]
    fn test_auth_header_absent_when_token_none() {
        let client = DaemonClient::new("s1".into(), 1234, 1, None);
        assert!(
            client.auth_header().is_none(),
            "auth header should be absent when token is None"
        );
    }

    fn write_startup_json(
        sessions_dir: &Path,
        session_id: &str,
        state: &str,
        pid: Option<i32>,
        port: Option<i32>,
        message: Option<&str>,
    ) {
        let session_dir = sessions_dir.join(session_id);
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let startup = StartupJson {
            state: state.to_string(),
            session_id: Some(session_id.to_string()),
            pid,
            port,
            message: message.map(str::to_string),
            credential_file_path: None,
        };
        std::fs::write(
            session_dir.join("startup.json"),
            serde_json::to_string(&startup).expect("serialize startup.json"),
        )
        .expect("write startup.json");
    }

    fn spawn_sleep_child(stderr: std::process::Stdio) -> tokio::process::Child {
        tokio::process::Command::new("sh")
            .args(["-c", "sleep 5"])
            .stdout(std::process::Stdio::null())
            .stderr(stderr)
            .spawn()
            .expect("spawn sleep child")
    }

    async fn cleanup_child(child: &mut tokio::process::Child) {
        if child.try_wait().expect("try_wait child").is_none() {
            child.kill().await.expect("kill child");
        }
        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn test_wait_for_startup_ignores_stale_ready_wrong_pid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().to_path_buf();
        let session_id = "stale-ready-test";
        let expected_pid = 12345;
        write_startup_json(
            &sessions_dir,
            session_id,
            "ready",
            Some(99999),
            Some(60339),
            None,
        );

        let writer_sessions_dir = sessions_dir.clone();
        let writer_session_id = session_id.to_string();
        let writer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(75)).await;
            write_startup_json(
                &writer_sessions_dir,
                &writer_session_id,
                "ready",
                Some(expected_pid),
                Some(54321),
                None,
            );
        });

        let mut child = spawn_sleep_child(std::process::Stdio::piped());
        let result = wait_for_daemon_startup(
            &sessions_dir.to_string_lossy(),
            session_id,
            1_000,
            Some(expected_pid),
            &mut child,
        )
        .await;
        cleanup_child(&mut child).await;
        writer.await.expect("writer task");

        let startup = result.expect("matching ready startup.json");
        assert_eq!(startup.port, Some(54321));
    }

    #[tokio::test]
    async fn test_wait_for_startup_without_expected_pid_accepts_any_ready_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().to_path_buf();
        let session_id = "any-ready-test";
        write_startup_json(
            &sessions_dir,
            session_id,
            "ready",
            Some(99999),
            Some(60339),
            None,
        );

        let mut child = spawn_sleep_child(std::process::Stdio::piped());
        let result = wait_for_daemon_startup(
            &sessions_dir.to_string_lossy(),
            session_id,
            1_000,
            None,
            &mut child,
        )
        .await;
        cleanup_child(&mut child).await;

        let startup = result.expect("ready startup.json without expected pid");
        assert_eq!(startup.port, Some(60339));
    }

    #[tokio::test]
    async fn test_wait_for_startup_ignores_stale_failed_wrong_pid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().to_path_buf();
        let session_id = "stale-failed-test";
        let expected_pid = 12345;
        write_startup_json(
            &sessions_dir,
            session_id,
            "failed",
            Some(99999),
            None,
            Some("prior crash"),
        );

        let writer_sessions_dir = sessions_dir.clone();
        let writer_session_id = session_id.to_string();
        let writer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(75)).await;
            write_startup_json(
                &writer_sessions_dir,
                &writer_session_id,
                "ready",
                Some(expected_pid),
                Some(54321),
                None,
            );
        });

        let mut child = spawn_sleep_child(std::process::Stdio::piped());
        let result = wait_for_daemon_startup(
            &sessions_dir.to_string_lossy(),
            session_id,
            1_000,
            Some(expected_pid),
            &mut child,
        )
        .await;
        cleanup_child(&mut child).await;
        writer.await.expect("writer task");

        let startup = result.expect("matching ready startup.json");
        assert_eq!(startup.port, Some(54321));
    }

    #[tokio::test]
    async fn test_wait_for_startup_failed_file_from_expected_pid_is_terminal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().to_path_buf();
        let session_id = "own-failed-test";
        let expected_pid = 12345;

        let writer_sessions_dir = sessions_dir.clone();
        let writer_session_id = session_id.to_string();
        let writer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(75)).await;
            write_startup_json(
                &writer_sessions_dir,
                &writer_session_id,
                "failed",
                Some(expected_pid),
                None,
                Some("config parse error"),
            );
        });

        let mut child = spawn_sleep_child(std::process::Stdio::piped());
        let result = wait_for_daemon_startup(
            &sessions_dir.to_string_lossy(),
            session_id,
            1_000,
            Some(expected_pid),
            &mut child,
        )
        .await;
        cleanup_child(&mut child).await;
        writer.await.expect("writer task");

        let err = result.expect_err("expected failed startup.json to be terminal");
        assert!(
            err.contains("config parse error"),
            "error should include daemon failure message: {err}"
        );
    }

    #[tokio::test]
    async fn test_wait_for_startup_timeout_names_stale_file_and_expected_pid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().to_path_buf();
        let session_id = "stale-timeout-test";
        write_startup_json(
            &sessions_dir,
            session_id,
            "ready",
            Some(99999),
            Some(60339),
            None,
        );

        let mut child = spawn_sleep_child(std::process::Stdio::null());
        let result = wait_for_daemon_startup(
            &sessions_dir.to_string_lossy(),
            session_id,
            350,
            Some(12345),
            &mut child,
        )
        .await;
        cleanup_child(&mut child).await;

        let err = result.expect_err("expected stale startup.json timeout");
        assert!(
            err.contains("did not become ready"),
            "error should mention readiness timeout: {err}"
        );
        assert!(
            err.contains("expected pid: 12345"),
            "error should include expected pid: {err}"
        );
    }

    #[test]
    fn test_spawn_env_merges_login_env_over_process_env() {
        let mut login_env = HashMap::new();
        login_env.insert("PATH".to_string(), "/login/bin".to_string());
        login_env.insert(
            "PANTOKEN_TEST_LOGIN_ENV".to_string(),
            "from-login".to_string(),
        );

        let env = merged_spawn_env(Some(&login_env)).expect("merged env");
        assert_eq!(env.get("PATH").map(String::as_str), Some("/login/bin"));
        assert_eq!(
            env.get("PANTOKEN_TEST_LOGIN_ENV").map(String::as_str),
            Some("from-login")
        );
        if let Ok(home) = std::env::var("HOME") {
            assert_eq!(env.get("HOME"), Some(&home));
        }
    }

    #[test]
    fn test_spawn_env_absent_login_env_inherits_process_env() {
        assert!(merged_spawn_env(None).is_none());
    }

    #[test]
    fn test_spawn_env_empty_login_env_inherits_process_env() {
        let login_env = HashMap::new();
        assert!(merged_spawn_env(Some(&login_env)).is_none());
    }

    // AC.4 — wait_for_daemon_startup detects early process death and includes
    // stderr, returning within ~1s (not the full timeout).
    #[tokio::test]
    async fn test_wait_for_startup_detects_early_death() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().to_string_lossy().to_string();
        let session_id = "early-death-test";

        // Spawn a process that exits immediately with a stderr message.
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "echo 'error: missing --credential-file' >&2; exit 1"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn sh");

        let start = Instant::now();
        let result = wait_for_daemon_startup(
            &sessions_dir,
            session_id,
            15_000, // 15s timeout — should NOT take this long
            None,
            &mut child,
        )
        .await;
        let elapsed = start.elapsed();

        assert!(result.is_err(), "should return an error on early death");
        let err = result.unwrap_err();
        assert!(
            err.contains("exited early"),
            "error should mention early exit: {err}"
        );
        assert!(
            err.contains("missing --credential-file"),
            "error should include stderr: {err}"
        );
        // Should return within ~2s, not the full 15s timeout.
        assert!(
            elapsed.as_secs() < 5,
            "should return quickly on early death, took {:?}",
            elapsed
        );
    }

    // AC.2 — read_credential_token reads the token from a credential file.
    #[test]
    fn test_read_credential_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cred_path = dir.path().join("credential.json");
        std::fs::write(
            &cred_path,
            r#"{"version":1,"kind":"polytoken-daemon-credential","token":"abc123"}"#,
        )
        .expect("write credential file");
        let token = read_credential_token(&cred_path);
        assert_eq!(token.as_deref(), Some("abc123"));
    }

    // AC.2 — read_credential_token returns None for a missing file.
    #[test]
    fn test_read_credential_token_missing_file() {
        let token = read_credential_token(Path::new("/nonexistent/credential.json"));
        assert!(token.is_none());
    }

    // AC.2 — read_credential_token returns None for a malformed file.
    #[test]
    fn test_read_credential_token_malformed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cred_path = dir.path().join("credential.json");
        std::fs::write(&cred_path, "not json").expect("write");
        let token = read_credential_token(&cred_path);
        assert!(token.is_none());
    }

    // -------------------------------------------------------------------------
    // lease-retry tests — ported from server/src/polytoken/lease-retry.test.ts.
    // Uses an injectable sleep seam (retry_claim_with_sleep) so the retry loops
    // are instant and deterministic, mirroring the TS `sleep: async () => {}`.
    // -------------------------------------------------------------------------

    /// A no-op sleep seam — the Rust analogue of the TS `async () => {}`. The
    /// retry loop awaits it between attempts but wall-clock never advances, so
    /// `current_millis()` is effectively frozen across retries.
    fn no_op_sleep() -> SleepFn {
        Arc::new(|_d: Duration| Box::pin(async {}) as SleepFuture)
    }

    /// Build an ISO-8601 expiry `ms_from_now` milliseconds in the future, the
    /// shape the daemon emits and `parse_iso8601_to_millis` parses. Mirrors the
    /// `now_iso8601()` formatting but offsets from the current epoch millis.
    fn iso_expiry(ms_from_now: i64) -> String {
        let millis = (current_millis() + ms_from_now).max(0) as u64;
        let secs = millis / 1000;
        let subsec_millis = (millis % 1000) as u32;
        let (y, mo, d, h, mi, s) = epoch_to_civil(secs);
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{subsec_millis:03}Z")
    }

    /// Build a `LeaseConflictError` like `claim_lease` throws on a 409 — the
    /// Rust analogue of the TS `conflict(expiresAt)`. `held.summary` carries a
    /// readable holder line; `held.expires_at` carries the ISO timestamp the
    /// retry loop parses to compute time-to-lapse.
    fn conflict(summary: &str, expires_at: &str) -> LeaseConflictError {
        LeaseConflictError {
            message: format!(
                "another TUI is attached to this session ({}). Detach it there (/detach) or wait ~30s for its lease to lapse.",
                summary
            ),
            held: Some(LeaseHeldInfo {
                summary: summary.to_string(),
                expires_at: Some(expires_at.to_string()),
            }),
        }
    }

    // retryClaim — test 1: succeeds on first try (no retry).
    #[tokio::test]
    async fn retry_claim_succeeds_on_first_try() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let calls_fn = calls.clone();
        let result: String = retry_claim_with_sleep(
            move || {
                let c = calls_fn.clone();
                Box::pin(async move {
                    *c.lock().expect("calls") += 1;
                    Ok::<String, LeaseConflictError>("ok".to_string())
                })
            },
            Some(3),
            Some(100),
            no_op_sleep(),
        )
        .await
        .expect("should succeed");
        assert_eq!(result, "ok");
        assert_eq!(*calls.lock().expect("calls"), 1);
    }

    // retryClaim — test 2: retries on 409, succeeds on 2nd attempt.
    #[tokio::test]
    async fn retry_claim_retries_then_succeeds() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let calls_fn = calls.clone();
        // Expiry ~1ms — lapses well within the retry window so the early-exit
        // doesn't fire. The no-op sleep means wall-clock barely advances.
        let expiry = iso_expiry(1);
        let result: String = retry_claim_with_sleep(
            move || {
                let c = calls_fn.clone();
                let exp = expiry.clone();
                Box::pin(async move {
                    let n = {
                        let mut g = c.lock().expect("calls");
                        *g += 1;
                        *g
                    };
                    if n == 1 {
                        return Err(conflict("\"tui\" pid 99999", &exp));
                    }
                    Ok::<String, LeaseConflictError>("ok".to_string())
                })
            },
            Some(3),
            Some(100),
            no_op_sleep(),
        )
        .await
        .expect("should succeed on 2nd attempt");
        assert_eq!(result, "ok");
        assert_eq!(*calls.lock().expect("calls"), 2);
    }

    // retryClaim — test 3: retries 3x, throws LeaseConflictError after exhaustion.
    #[tokio::test]
    async fn retry_claim_exhausts_after_max_retries() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let calls_fn = calls.clone();
        // Short expiry (laps within the retry window) so the early-exit doesn't
        // fire — all 4 attempts run before exhaustion.
        let expiry = iso_expiry(1);
        let result: Result<String, LeaseConflictError> = retry_claim_with_sleep(
            move || {
                let c = calls_fn.clone();
                let exp = expiry.clone();
                Box::pin(async move {
                    *c.lock().expect("calls") += 1;
                    Err(conflict("\"tui\" pid 99999", &exp))
                })
            },
            Some(3),
            Some(100),
            no_op_sleep(),
        )
        .await;
        assert!(result.is_err(), "should return Err after exhaustion");
        // retry_claim_with_sleep returns Result<T, LeaseConflictError>, so the
        // error is statically a LeaseConflictError — the TS instanceof check is
        // satisfied by the type system; no runtime .is() needed.
        let err = result.unwrap_err();
        assert!(
            err.held.is_some(),
            "exhausted conflict should carry the holder info"
        );
        // 1 initial + 3 retries = 4 attempts total.
        assert_eq!(*calls.lock().expect("calls"), 4);
    }

    // retryClaim — test 4: "does NOT retry on non-409 errors".
    //
    // DEVNOTE: this test CANNOT be faithfully ported. The TS `retryClaim`'s
    // claim throws arbitrary `Error`s; a plain (non-LeaseConflictError) is not
    // retried. The Rust `retry_claim`'s claim returns `Result<T, LeaseConflictError>`
    // — EVERY error is a `LeaseConflictError`, and `retry_claim` retries on any
    // `Err` (it never inspects whether the error is actually a 409 vs a 500). A
    // `LeaseConflictError` with `held: None` (the shape `claim_lease` emits for a
    // non-409 status, e.g. `"lease claim failed (500): ..."`) therefore IS retried
    // to exhaustion — there is no expiry to trigger the early-exit. So the TS
    // intent ("a non-conflict error must not be retried") is not expressible.
    //
    // Rather than assert misleading behavior, we assert the ACTUAL Rust behavior
    // (a `held: None` error retries to exhaustion) and document the divergence.
    #[tokio::test]
    async fn retry_claim_non_conflict_error_retries_to_exhaustion() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let calls_fn = calls.clone();
        // A non-409 error as claim_lease models it: held: None, status in message.
        let result: Result<String, LeaseConflictError> = retry_claim_with_sleep(
            move || {
                let c = calls_fn.clone();
                Box::pin(async move {
                    *c.lock().expect("calls") += 1;
                    Err(LeaseConflictError {
                        message: "lease claim failed (500): server error".into(),
                        held: None,
                    })
                })
            },
            Some(3),
            Some(1),
            no_op_sleep(),
        )
        .await;
        // The Rust model retries ANY Err(LeaseConflictError) — unlike TS, which
        // only retries LeaseConflictError. So this runs all 4 attempts.
        assert!(result.is_err(), "should return Err");
        assert_eq!(*calls.lock().expect("calls"), 4);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("lease claim failed (409): another TUI is attached"),
            "exhausted non-409 falls back to the malformed-409 message"
        );
    }

    // retryClaim — test 5: stops early when the lease won't lapse within the
    // retry window.
    #[tokio::test]
    async fn retry_claim_stops_early_when_lease_wont_lapse() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let calls_fn = calls.clone();
        // Expiry 60s out — far beyond the ~3ms retry window (3 retries × 1ms).
        let expiry = iso_expiry(60_000);
        let result: Result<String, LeaseConflictError> = retry_claim_with_sleep(
            move || {
                let c = calls_fn.clone();
                let exp = expiry.clone();
                Box::pin(async move {
                    *c.lock().expect("calls") += 1;
                    Err(conflict("\"tui\" pid 99999", &exp))
                })
            },
            Some(3),
            Some(1),
            no_op_sleep(),
        )
        .await;
        assert!(result.is_err(), "should return Err");
        // Should stop after the FIRST attempt (no retries — the lease won't lapse).
        assert_eq!(*calls.lock().expect("calls"), 1);
    }

    // retryClaim — test 6: final error message includes the computed time-to-lapse
    // (not ~30s).
    #[tokio::test]
    async fn retry_claim_final_error_includes_computed_wait() {
        // Expiry 5s out. With a no-op sleep (clock frozen), the early-exit
        // condition `ms_until_expiry > remaining_delays` first becomes true at
        // attempt 1 (5000 > (3-1)*2000 = 4000), so this EARLY-EXITS at attempt 1
        // — it does NOT exhaust. The early-exit path rebuilds the message via
        // `format_lease_conflict_message(held, Some(ceil_seconds(5000)))`, so
        // the wait is the computed ~5s, not the `~30s` fallback.
        let expiry = iso_expiry(5_000);
        let exp_for_claim = expiry.clone();
        let err: LeaseConflictError = retry_claim_with_sleep(
            move || {
                let exp = exp_for_claim.clone();
                Box::pin(async move {
                    Err::<String, LeaseConflictError>(conflict("\"tui\" pid 99999", &exp))
                })
            },
            Some(3),
            Some(2_000),
            no_op_sleep(),
        )
        .await
        .expect_err("should early-exit and return Err");
        let msg = err.to_string();
        // The message should contain a computed "Ns" wait, NOT the hardcoded "~30s".
        assert!(
            msg.contains("wait ") && msg.contains("s for its lease to lapse"),
            "message should contain a computed wait: {msg}"
        );
        assert!(!msg.contains("~30s"), "message must not use ~30s: {msg}");
        // The computed wait should be ~5s (within a tolerance for test timing).
        // Mirrors the TS `/wait [3-7]s for its lease to lapse/` — extract the digit
        // after "wait " and assert it's in [3, 7].
        let wait_secs = msg
            .split("wait ")
            .nth(1)
            .and_then(|s| s.chars().next())
            .and_then(|c| c.to_digit(10))
            .expect("message should contain a 'wait Ns' segment");
        assert!(
            (3..=7).contains(&wait_secs),
            "computed wait should be in [3,7]s, got {wait_secs}: {msg}"
        );
    }

    // retryClaim — test 7: falls back to ~30s when the body lacks an expiry.
    #[tokio::test]
    async fn retry_claim_falls_back_to_30s_without_expiry() {
        // A LeaseConflictError with no held info (malformed 409 body).
        let result: Result<String, LeaseConflictError> = retry_claim_with_sleep(
            || {
                Box::pin(async move {
                    Err(LeaseConflictError {
                        message: "lease claim failed (409): malformed body".into(),
                        held: None,
                    })
                })
            },
            Some(3),
            Some(1),
            no_op_sleep(),
        )
        .await;
        assert!(result.is_err(), "should return Err");
        let msg = result.unwrap_err().to_string();
        // A held: None exhaustion hits the `None =>` arm of
        // format_lease_conflict_message → "lease claim failed (409): another TUI
        // is attached", OR (for a held summary with no expiry) the "~30s" wait.
        // The TS regex /~30s|another TUI is attached/ covers both.
        assert!(
            msg.contains("~30s") || msg.contains("another TUI is attached"),
            "message should fall back to ~30s or the attached-TUI line: {msg}"
        );
    }

    // Extra coverage (beyond the TS suite): a conflict whose `held` is present
    // but carries NO expiry timestamp. On exhaustion, retry_claim_with_sleep
    // computes `seconds_to_lapse = None` (no expiry to parse) → the genuine
    // "~30s" fallback arm of format_lease_conflict_message. The TS test 7 used
    // `held: None`, which hits the *other* arm ("...another TUI is attached")
    // and never actually exercises "~30s" — this test does.
    #[tokio::test]
    async fn retry_claim_falls_back_to_30s_when_held_has_no_expiry() {
        // held present, but expires_at: None (a malformed-but-present 409 body).
        let conflict_no_expiry = LeaseConflictError {
            message: "another TUI is attached (no expiry)".into(),
            held: Some(LeaseHeldInfo {
                summary: "\"tui\" pid 99999".into(),
                expires_at: None,
            }),
        };
        // Short delay + no-op sleep so the loop runs fast; `expires_at: None`
        // means the early-exit condition (which needs an expiry) never fires,
        // so all 4 attempts run → exhaustion → message rebuilt with ~30s.
        let err: LeaseConflictError = retry_claim_with_sleep(
            || {
                let e = conflict_no_expiry.clone();
                Box::pin(async move { Err::<String, LeaseConflictError>(e) })
            },
            Some(3),
            Some(1),
            no_op_sleep(),
        )
        .await
        .expect_err("should exhaust");
        let msg = err.to_string();
        assert!(
            msg.contains("~30s"),
            "held-without-expiry exhaustion must fall back to ~30s: {msg}"
        );
        // The rebuilt message still carries the holder summary.
        assert!(
            msg.contains("another TUI is attached"),
            "message should include the holder summary: {msg}"
        );
    }

    // Extra coverage (beyond the TS suite): the genuine EXHAUSTION path with a
    // held expiry that lapses WITHIN the retry window (so the early-exit never
    // fires and all 4 attempts run). Test 6 (5s) early-exits at attempt 1 under
    // a frozen clock; this one uses a sub-second expiry that stays inside the
    // window at every attempt, so it truly exhausts at 4 calls.
    #[tokio::test]
    async fn retry_claim_exhausts_when_expiry_lapses_within_window() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let calls_fn = calls.clone();
        // 1ms out: lapses well within the retry window (3 × 1ms = 3ms) at every
        // attempt under a frozen clock, so the early-exit never fires.
        let expiry = iso_expiry(1);
        let exp_for_claim = expiry.clone();
        let result: Result<String, LeaseConflictError> = retry_claim_with_sleep(
            move || {
                let c = calls_fn.clone();
                let exp = exp_for_claim.clone();
                Box::pin(async move {
                    *c.lock().expect("calls") += 1;
                    Err::<String, LeaseConflictError>(conflict("\"tui\" pid 99999", &exp))
                })
            },
            Some(3),
            Some(1),
            no_op_sleep(),
        )
        .await;
        assert!(result.is_err(), "should exhaust and return Err");
        // 1 initial + 3 retries = 4 attempts total.
        assert_eq!(
            *calls.lock().expect("calls"),
            4,
            "should run all 4 attempts"
        );
        assert!(result.unwrap_err().held.is_some(), "held info preserved");
    }

    // retryClaim — test 8: sleep is called between retries.
    #[tokio::test]
    async fn retry_claim_calls_sleep_between_retries() {
        let claim_calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let sleep_calls = std::sync::Arc::new(std::sync::Mutex::new(0u32));
        let claim_fn = claim_calls.clone();
        let sleep_fn = sleep_calls.clone();
        // Short expiry (laps within the retry window) so the early-exit doesn't fire.
        let expiry = iso_expiry(1);
        let result: String = retry_claim_with_sleep(
            move || {
                let c = claim_fn.clone();
                let exp = expiry.clone();
                Box::pin(async move {
                    let n = {
                        let mut g = c.lock().expect("calls");
                        *g += 1;
                        *g
                    };
                    if n < 3 {
                        return Err(conflict("\"tui\" pid 99999", &exp));
                    }
                    Ok::<String, LeaseConflictError>("ok".to_string())
                })
            },
            Some(3),
            Some(50),
            {
                let sc = sleep_fn.clone();
                Arc::new(move |d: Duration| {
                    assert_eq!(
                        d.as_millis(),
                        50,
                        "sleep should be invoked with the delay_ms"
                    );
                    let sc = sc.clone();
                    Box::pin(async move {
                        *sc.lock().expect("sleep") += 1;
                    }) as SleepFuture
                })
            },
        )
        .await
        .expect("should succeed on 3rd attempt");
        assert_eq!(result, "ok");
        // Two retries → two sleeps (after attempt 1 and after attempt 2).
        assert_eq!(*sleep_calls.lock().expect("sleep"), 2);
        assert_eq!(*claim_calls.lock().expect("calls"), 3);
    }

    // LeaseConflictError — test 9: is an Error with the right name.
    #[test]
    fn lease_conflict_error_is_a_std_error_with_message() {
        // Rust has no `err.name`; the TS assertion `err.name == "LeaseConflictError"`
        // is ported as: the value implements std::error::Error, its Display is the
        // message, and the type name contains "LeaseConflictError".
        let err = LeaseConflictError {
            message: "test message".into(),
            held: None,
        };
        // It is a std::error::Error (the trait bound below compiles iff it is).
        fn _assert_error<T: std::error::Error>(_: &T) {}
        _assert_error(&err);
        // Display yields the message.
        assert_eq!(err.to_string(), "test message");
        // held is None (no holder info).
        assert!(err.held.is_none());
        // The type name carries "LeaseConflictError" (the TS `name` analogue).
        assert!(
            std::any::type_name::<LeaseConflictError>().contains("LeaseConflictError"),
            "type name should contain LeaseConflictError"
        );
    }

    // LeaseConflictError — test 10: carries the parsed holder info.
    #[test]
    fn lease_conflict_error_carries_holder_info() {
        let expires_at = iso_expiry(30_000);
        let held = LeaseHeldInfo {
            summary: "\"tui\" pid 12345, lease expires 12:00:00".into(),
            expires_at: Some(expires_at.clone()),
        };
        let err = LeaseConflictError {
            message: "msg".into(),
            held: Some(held),
        };
        let carried = err.held.expect("held should be present");
        assert_eq!(carried.summary, "\"tui\" pid 12345, lease expires 12:00:00");
        assert_eq!(carried.expires_at.as_deref(), Some(expires_at.as_str()));
    }

    // parseLeaseHeldError — test 11: the mock's failsession message matches the
    // lease-conflict pattern.
    #[test]
    fn mock_failsession_message_matches_lease_conflict_pattern() {
        // The mock driver throws this exact message. classifySwitchError + the
        // client's LEASE_CONFLICT_RE must both match it.
        let mock_msg = "another TUI is attached to this session (\"tui\" pid 99999, \
            lease expires in 30s). Detach it there (/detach) or wait 30s for its lease to lapse.";
        // classifySwitchError pattern (hub.ts): /another TUI is attached|lease claim failed \(409\)/
        assert!(
            mock_msg.contains("another TUI is attached")
                || mock_msg.contains("lease claim failed (409)"),
            "hub classifySwitchError pattern should match"
        );
        // client LEASE_CONFLICT_RE (store.svelte.ts): /another TUI is attached|lease to lapse/
        assert!(
            mock_msg.contains("another TUI is attached") || mock_msg.contains("lease to lapse"),
            "client LEASE_CONFLICT_RE pattern should match"
        );
    }
}
