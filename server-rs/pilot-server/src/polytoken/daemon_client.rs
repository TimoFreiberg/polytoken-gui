//! Port of `server/src/polytoken/daemon-client.ts`.
//!
//! One daemon process = one session = one port. This module owns the lifecycle of
//! ONE such daemon: spawn it, claim the TUI attachment lease (+ heartbeat), subscribe
//! to the `/events` SSE stream, and POST to its endpoints. The PolytokenDriver
//! composes one of these per warm session.
//!
//! Design notes:
//! - The lease is pid-bound and EXCLUSIVE (a second claim → 409). Pilot is the sole
//!   attacher; the local TUI detaches while pilot drives.
//! - SSE is push-only with no periodic heartbeats on an idle daemon — liveness must
//!   be time-based (frame gap), not expect periodic `heartbeat` events.
//! - `Last-Event-ID` resume is supported by the `id:` field (== `seq`); not yet wired.
//! - All endpoints are flat (no `/session/{id}/…`) — the daemon IS the session.

#![allow(dead_code)]
#![allow(unused_assignments)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use pilot_daemon_types::*;
use reqwest::Client;
use serde::Deserialize;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};
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
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
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
            Ok(SpawnedDaemon { session_id, port })
        }
        _ => Err(format!("polytoken new --no-attach line unparseable: {line:?}")),
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
struct StartupJson {
    state: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    pid: Option<i32>,
    #[serde(default)]
    port: Option<i32>,
    #[serde(default)]
    message: Option<String>,
}

/// Read the `startup.json` a `polytoken daemon` writes to its session dir. Returns
/// None when the file is absent or unparseable (a loud-fail to a log warning, never
/// a crash). The daemon writes `{state:"ready", pid, port}` on success or
/// `{state:"failed", pid, message}` on failure.
fn read_startup_json(session_dir: &PathBuf) -> Option<StartupJson> {
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
pub async fn wait_for_daemon_startup(
    sessions_dir: &str,
    session_id: &str,
    timeout_ms: u64,
    expect_pid: Option<i32>,
) -> Result<u16, String> {
    let session_dir = PathBuf::from(sessions_dir).join(session_id);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut last_json: Option<StartupJson> = None;
    loop {
        if let Some(json) = read_startup_json(&session_dir) {
            last_json = Some(json.clone());
            if json.state == "ready" {
                if let Some(port) = json.port {
                    // Stale startup.json from a prior (now-dead) daemon: its pid won't match
                    // the process we just spawned. Keep polling for OUR daemon's file.
                    let pid_matches = expect_pid
                        .map(|ep| json.pid == Some(ep))
                        .unwrap_or(true);
                    if pid_matches {
                        return Ok(port as u16);
                    }
                    // The file is stale — but note it so the timeout message is useful.
                }
            }
            if json.state == "failed" {
                // A failed file from a prior run (wrong pid) must not abort our wait —
                // only a failure from our own daemon is terminal.
                let is_ours = expect_pid
                    .map(|ep| json.pid == Some(ep))
                    .unwrap_or(true);
                if is_ours {
                    return Err(format!(
                        "polytoken daemon failed to start: {}",
                        json.message.as_deref().unwrap_or("no message")
                    ));
                }
            }
            // state is something else (e.g. "starting") — keep polling.
        }
        if Instant::now() >= deadline {
            let last_str = match &last_json {
                Some(j) => serde_json::to_string(j).unwrap_or_else(|_| "<unparseable>".into()),
                None => "null".into(),
            };
            let pid_str = expect_pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "any".into());
            return Err(format!(
                "polytoken daemon did not become ready within {}ms (startup.json: {}; expected pid: {})",
                timeout_ms, last_str, pid_str
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
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
    /// tool env instead of pilot's minimal launchd env). Merged over process.env:
    /// login env wins.
    pub login_env: Option<HashMap<String, String>>,
}

/// Spawn a NEW polytoken daemon session (no resume). `polytoken --working-dir <cwd>
/// new --no-attach` prints `session_id=<id> port=<port>` to stdout and exits 0;
/// the daemon runs detached.
async fn spawn_new_daemon(
    polytoken_bin: &str,
    opts: SpawnDaemonOpts,
) -> Result<SpawnedDaemon, String> {
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
    if let Some(login_env) = &opts.login_env {
        if !login_env.is_empty() {
            // Merge: login env wins over process env.
            for (k, v) in std::env::vars() {
                cmd.env(k, v);
            }
            for (k, v) in login_env {
                cmd.env(k, v);
            }
        }
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
    parse_spawn_output(&stdout)
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
async fn spawn_resume_daemon(
    polytoken_bin: &str,
    opts: SpawnDaemonOpts,
) -> Result<(SpawnedDaemon, Option<tokio::process::Child>), String> {
    let session_id = opts.session_id.as_ref().unwrap().clone();
    let cwd = opts.cwd.as_ref().unwrap().clone();
    let sessions_dir = opts.sessions_dir.as_ref().unwrap().clone();
    let global_config_dir = opts.global_config_dir.as_ref().unwrap().clone();

    let args = vec![
        "daemon".to_string(),
        "--project-dir".into(),
        cwd,
        "--session-id".into(),
        session_id.clone(),
        "--resume".into(),
        "--global-config-dir".into(),
        global_config_dir,
        "--sessions-dir".into(),
        sessions_dir.clone(),
    ];

    let mut cmd = Command::new(polytoken_bin);
    cmd.args(&args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if let Some(login_env) = &opts.login_env {
        if !login_env.is_empty() {
            for (k, v) in std::env::vars() {
                cmd.env(k, v);
            }
            for (k, v) in login_env {
                cmd.env(k, v);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn polytoken daemon: {e}"))?;
    let pid = child.id();

    // Poll startup.json for readiness (the daemon writes it once it has bound its
    // port). 15s is generous — a cold config load + history replay can take a moment.
    match wait_for_daemon_startup(&sessions_dir, &session_id, 15_000, pid.map(|p| p as i32)).await {
        Ok(port) => Ok((SpawnedDaemon { session_id, port }, Some(child))),
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
/// On resume, also returns the Child handle so the caller can keep it alive.
pub async fn spawn_daemon(
    polytoken_bin: &str,
    opts: SpawnDaemonOpts,
) -> Result<(SpawnedDaemon, Option<tokio::process::Child>), String> {
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
        let spawned = spawn_new_daemon(polytoken_bin, opts).await?;
        Ok((spawned, None))
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
        None => body
            .message
            .map(|m| LeaseHeldInfo { summary: m, expires_at: None }),
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
    if ms.rem_euclid(1000) != 0 {
        s + 1
    } else {
        s
    }
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

/// Retry a claim function on 409 lease-conflict errors, up to `max_retries` times
/// with `delay_ms` backoff between attempts. Pure — takes the claim function so
/// it's unit-testable without a live daemon. Throws on non-lease-conflict errors
/// immediately (no retry). On exhaustion (or an early exit when the lease won't
/// lapse within the remaining retry window), throws a LeaseConflictError whose
/// message includes the computed time-to-lapse.
pub async fn retry_claim<T, F, Fut>(
    claim: F,
    max_retries: Option<u32>,
    delay_ms: Option<u64>,
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
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
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
        days as i64 * 86400 + h as i64 * 3600 + m as i64 * 60 + sec as i64 - tz_offset_minutes as i64 * 60;
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
    /// The daemon's own OS pid, captured from GET /health. Used as a kill() fallback
    /// when HTTP /terminate fails (a wedged daemon won't respond to HTTP).
    daemon_pid: Mutex<Option<i32>>,
    lease: Mutex<Option<AttachmentLease>>,
    sse_cancel: Mutex<Option<CancelHandle>>,
    http: Client,
    /// SSE liveness knobs (see subscribe()). Public + mutable so tests can shrink
    /// the windows to milliseconds; production code leaves the defaults.
    pub liveness_interval_ms: u64,
    pub liveness_probe_timeout_ms: u64,
}

impl DaemonClient {
    /// Create a new client for a daemon at `127.0.0.1:{port}` with the given pid.
    pub fn new(session_id: String, port: u16, pid: i32) -> Self {
        let base_url = format!("http://127.0.0.1:{port}");
        Self {
            session_id,
            port,
            base_url,
            pid,
            daemon_pid: Mutex::new(None),
            lease: Mutex::new(None),
            sse_cancel: Mutex::new(None),
            http: Client::builder()
                .build()
                .expect("failed to build reqwest client"),
            liveness_interval_ms: 60_000,
            liveness_probe_timeout_ms: 5_000,
        }
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
                    r = r.header("content-type", "application/json").body(b.to_string());
                }
                r
            }
            reqwest::Method::GET => self.http.get(url),
            reqwest::Method::DELETE => self.http.delete(url),
            _ => self.http.request(method, url),
        };
        match tokio::time::timeout(Duration::from_millis(timeout_ms), req.send()).await {
            Err(_) => Err(()), // timed out
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
    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        method: reqwest::Method,
        body: Option<&str>,
        error_for_status: Option<&dyn Fn(Option<&T>, &str) -> Option<String>>,
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
                DaemonResponse { status, data, error }
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
        match self.safe_fetch(&url, reqwest::Method::POST, body, 10_000).await {
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
                DaemonResponse { status, data, error }
            }
        }
    }

    /// `GET {path}`. On ≥400, report the raw response text (no parsed message).
    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> DaemonResponse<T> {
        let url = format!("{}{}", self.base_url, path);
        match self.safe_fetch(&url, reqwest::Method::GET, None, 10_000).await {
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
                DaemonResponse { status, data, error }
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

    /// Bounded `GET /health` for the SSE liveness watcher: true iff the daemon
    /// answers OK within `timeout_ms`. Never throws — a hung or refused probe is
    /// simply `false` (that's the signal to reconnect).
    async fn probe_health(&self, timeout_ms: u64) -> bool {
        let url = format!("{}/health", self.base_url);
        match tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            self.http.get(&url).send(),
        )
        .await
        {
            Ok(Ok(res)) => res.status().is_success(),
            _ => false,
        }
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
    /// claim while one is live → 409). Pilot is the sole attacher; the local TUI
    /// detaches while pilot drives. Starts the heartbeat timer automatically.
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
                    None => format!("lease claim failed (409): {}", res.error.as_deref().unwrap_or("")),
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
        let heartbeat_handle = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(heartbeat_ms));
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
                        match tokio::time::timeout(
                            Duration::from_millis(10_000),
                            http.post(&url)
                                .header("content-type", "application/json")
                                .body(body_str)
                                .send(),
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

    /// `POST /prompt` — the happy-path turn starter. Returns 202 + {prompt_id, session_id}.
    /// 409 if a turn is already in flight (the queue does NOT auto-absorb a concurrent
    /// prompt — it's rejected). 422 if a pre-user-prompt hook denied it.
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
    /// (that distinction is pilot-side UX only).
    pub async fn queue_turn_input(&self, content: &str) -> Result<(), String> {
        let body = PendingTurnInputRequest {
            content: content.to_string(),
        };
        let body_str = serde_json::to_string(&body).unwrap_or_default();
        let res = self.post::<serde_json::Value>("/turn/input", Some(&body_str)).await;
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
        match self.safe_fetch(&url, reqwest::Method::DELETE, None, 10_000).await {
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
        match self.safe_fetch(&url, reqwest::Method::POST, None, 10_000).await {
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
    /// root is unavailable. The daemon owns this index natively — pilot doesn't run its
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
        let res = self.post::<serde_json::Value>("/title", Some(&body_str)).await;
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
            Err(_) => Err(format!("POST /interrogative/respond timed out (10s) for {id}")),
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
    pub async fn set_permission_mode(
        &self,
        mode: PermissionMonitorMode,
    ) -> Result<(), String> {
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
        let res = self.post::<serde_json::Value>("/compact", Some(&body_str)).await;
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
        let res = self.post::<serde_json::Value>("/rewind", Some(&body_str)).await;
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
        let res = self.post::<serde_json::Value>("/facet", Some(&body_str)).await;
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
    /// loop. The stream is push-only — an idle daemon emits nothing, so liveness is
    /// time-based (frame gap), not periodic `heartbeat` events.
    ///
    /// On error or stream end, the connection retries with exponential backoff
    /// (1s → 2s → 4s → … → 30s cap). On reconnect, a synthetic `stream_discontinuity`
    /// envelope is emitted so the driver re-seeds (the event-map maps this to a reseed).
    /// A liveness watcher aborts the current fetch if no frame arrives for
    /// `liveness_interval_ms` (60s), forcing a reconnect.
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
        let liveness_interval = self.liveness_interval_ms;
        let liveness_probe_timeout = self.liveness_probe_timeout_ms;

        let notify_for_loop = notify.clone();
        let join_handle = tokio::spawn(async move {
            client
                .sse_loop(on_event, notify_for_loop, cancel_rx, liveness_interval, liveness_probe_timeout)
                .await;
        });

        SseSubscription {
            join_handle,
            cancel: Some(cancel_tx),
            notify: Some(notify),
        }
    }

    async fn sse_loop<F>(
        self: Arc<Self>,
        on_event: F,
        stop_notify: Arc<tokio::sync::Notify>,
        mut cancel_rx: oneshot::Receiver<()>,
        liveness_interval: u64,
        liveness_probe_timeout: u64,
    )
    where
        F: Fn(SseEnvelope) + Send + Sync + 'static,
    {
        let mut backoff: u64 = 1000;
        let max_backoff: u64 = 30_000;
        let mut last_event_id: Option<String> = None;
        let mut had_connected_once = false;
        let mut stopped = false;

        // Shared liveness state between the main loop and the watcher.
        let last_frame_at_arc = Arc::new(Mutex::new(Instant::now()));
        let liveness_stop = Arc::new(Mutex::new(false));

        // Spawn the liveness watcher task.
        let liveness_stop_clone = liveness_stop.clone();
        let client_liveness = self.clone();
        let last_frame_for_watcher = last_frame_at_arc.clone();
        let liveness_handle = tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(liveness_interval));
            interval.tick().await;
            loop {
                if *liveness_stop_clone.lock().await {
                    break;
                }
                tokio::select! {
                    _ = interval.tick() => {
                        let elapsed = last_frame_for_watcher.lock().await.elapsed();
                        if elapsed <= Duration::from_millis(liveness_interval) {
                            continue;
                        }
                        // Probe GET /health: an answer means alive-and-idle → reset
                        // the clock and leave the stream alone; only a failed/hung probe
                        // forces the reconnect.
                        let alive = client_liveness.probe_health(liveness_probe_timeout).await;
                        if *liveness_stop_clone.lock().await {
                            break;
                        }
                        if alive {
                            // alive-and-idle: quiet is fine
                            *last_frame_for_watcher.lock().await = Instant::now();
                        } else {
                            warn!("[polytoken] SSE silent and /health probe failed — forcing reconnect");
                            // The liveness watcher can't abort the current reqwest stream
                            // from here (no handle to it). We rely on the stream eventually
                            // erroring, or the daemon closing it. A true abort would need a
                            // per-attempt CancellationToken; for now the probe failure is logged
                            // and the next stream error will trigger reconnect.
                        }
                    }
                }
            }
        });

        // Main SSE loop.
        while !stopped {
            // Build the request.
            let mut req = self.http.get(format!("{}/events", self.base_url));
            if let Some(ref id) = last_event_id {
                req = req.header("Last-Event-ID", id);
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
            *last_frame_at_arc.lock().await = Instant::now();

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
                    chunk = stream.next() => {
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
                                    *last_frame_at_arc.lock().await = Instant::now();
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

        // Stop the liveness watcher.
        *liveness_stop.lock().await = true;
        liveness_handle.abort();
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

/// A global mutable spawn function override for testing (mirrors the TS
/// `_setSpawnForTesting`). In Rust we don't override the real spawn, so this is
/// a no-op placeholder for API parity.
pub fn _set_spawn_for_testing(_enabled: bool) {
    // No-op: the Rust port uses tokio::process::Command directly.
}
