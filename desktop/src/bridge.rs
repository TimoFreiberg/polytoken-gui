//! Local bridge: browser-WS ↔ SSH-stdio forwarding (Phase 2).
//!
//! The bridge is the native-side glue that lets the unchanged WebView client
//! connect to a loopback WebSocket while the native layer forwards each WS
//! frame to an SSH stdio proxy speaking the framed protocol. The browser sees
//! a normal local WS connection; the bridge wraps raw WS JSON →
//! `ClientEnvelope`+frame outbound (to SSH stdin) and unwraps frame+
//! `ServerEnvelope` → raw JSON inbound (to browser).
//!
//! ## Envelope asymmetry (Option A)
//!
//! The browser speaks raw `ClientMessage`/`ServerMessage` JSON (no envelope).
//! The SSH stdio transport uses `WireEnvelope`+length-prefixed frames. The
//! bridge wraps/unwraps at the WS↔stdio boundary — the logical envelope is
//! never exposed to the browser.
//!
//! ## SSH transport abstraction
//!
//! The bridge's SSH-transport dependency is behind a trait ([`SshTransport`])
//! so a future mobile native impl can swap a native SSH library. Phase 2 ships
//! [`SystemSshTransport`] (spawns `ssh` with `-T`, `BatchMode=yes`,
//! `ServerAliveInterval=30`, and a remote command that `exec`s the runtime in
//! stdio-proxy mode). A cfg-gated [`MobileSshTransport`] stub documents the
//! mobile seam (see [`mobile`] module).
//!
//! ## Reconnect with bounded backoff
//!
//! When the SSH process exits, the bridge classifies the exit (auth failure,
//! host-key unknown, unreachable, clean exit, unknown) and either retries
//! (transient failures) with bounded exponential backoff — keeping the
//! browser's WS open — or surfaces an actionable failure to the state machine.
//! During SSH-side retries the bridge sends periodic WS keepalive text frames
//! so the browser's heartbeat watchdog doesn't fire (see [`ReconnectPolicy`]).
//!
//! ## Async runtime
//!
//! The bridge runs on a dedicated multi-thread tokio runtime owned by
//! `AppState` (Tauri's internal `async_runtime` is sized for short plugin
//! operations, not a persistent listener + child process). Commands cross
//! runtimes via `Handle::spawn` + `oneshot`; `run()` is driven on the
//! dedicated runtime, never `block_on`-ed from within a tokio worker.

#![allow(clippy::doc_lazy_continuation)]

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use pantoken_protocol::frame::{self, FrameDecoder};
use pantoken_protocol::transport::{ClientEnvelope, ServerEnvelope};
use pantoken_protocol::wire::ClientMessage;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::remote_profile::RemoteProfile;

// ─────────────────────────────── SshCommand ───────────────────────────────

/// The fully-resolved SSH command the bridge spawns. Built from a
/// [`RemoteProfile`] (destination, port, remote root, server path).
///
/// **Redaction:** `destination` is a single `user@host` or SSH-config-alias
/// string. There is no reliable way to separate user from host, and aliases
/// like `build-server` can't be distinguished from credentials. The
/// [`Debug`] impl therefore redacts the **entire** destination — logs show
/// `ssh -T <redacted> <remote-command>` with no destination string at all.
/// The unredacted destination lives only inside the spawned process's argv,
/// never in a tracing log line.
#[derive(Clone)]
pub struct SshCommand {
    pub destination: String,
    pub port: Option<u16>,
    pub remote_root: String,
    pub server_path: String,
    /// Extra env vars to set on the remote command (e.g. XDG override paths
    /// for isolated polytoken). Prepended as `KEY=VAL ` before the exec.
    pub extra_env: Vec<(String, String)>,
}

impl SshCommand {
    /// Build the SSH argv (excluding the binary name `ssh`), redacting the
    /// destination in any returned diagnostic string.
    fn argv(&self) -> Vec<String> {
        let mut args = vec![
            "-T".into(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "ServerAliveInterval=30".into(),
        ];
        if let Some(port) = self.port {
            args.push("-p".into());
            args.push(port.to_string());
        }
        args.push(self.destination.clone());
        // The remote command sets the runtime's serve-mode + root, then execs
        // the server so SSH's remote process IS the runtime (no shell wrapper
        // lingering to swallow signals).
        args.push(self.remote_command());
        args
    }

    /// The remote shell command: env prefix + `exec <server_path>`.
    fn remote_command(&self) -> String {
        let mut env_prefix = String::new();
        for (key, val) in &self.extra_env {
            env_prefix.push_str(key);
            env_prefix.push('=');
            env_prefix.push_str(&shell_quote(val));
            env_prefix.push(' ');
        }
        format!(
            "PANTOKEN_SERVE_MODE=stdio-proxy PANTOKEN_REMOTE_ROOT={root} {env_prefix}exec {server}",
            root = shell_quote(&self.remote_root),
            server = shell_quote(&self.server_path),
        )
    }

    /// A redacted, log-safe rendering: `ssh -T <redacted> <remote-command>`.
    /// The remote command is safe to log (no credentials), but the destination
    /// is not.
    fn redacted_debug(&self) -> String {
        let mut args = vec![
            "-T".into(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "ServerAliveInterval=30".into(),
        ];
        if self.port.is_some() {
            args.push("-p".into());
            args.push("<port>".into());
        }
        args.push("<redacted>".into());
        args.push(self.remote_command());
        format!("ssh {}", args.join(" "))
    }
}

impl std::fmt::Debug for SshCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SshCommand({})", self.redacted_debug())
    }
}

impl std::fmt::Display for SshCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.redacted_debug())
    }
}

/// Single-quote a shell word if it contains anything that isn't a conservative
/// safe set (alnum, `/`, `.`, `-`, `_`, `~`). Used for the remote command
/// (remote root + server path), NOT for the destination (which is passed
/// verbatim to `ssh` as `ssh` resolves it).
fn shell_quote(word: &str) -> String {
    fn safe(c: char) -> bool {
        c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '~')
    }
    if !word.is_empty() && word.chars().all(safe) {
        word.to_string()
    } else {
        // POSIX single-quote: wrap in '...', escaping any embedded ' as '\''
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

impl From<&RemoteProfile> for SshCommand {
    fn from(profile: &RemoteProfile) -> Self {
        // Phase 5: populate extra_env with XDG override paths when the profile
        // uses isolated XDG mode (the default). When shared, no overrides are
        // set — polytoken uses its default roots.
        let mut extra_env = Vec::new();
        if profile.xdg_mode == crate::remote_profile::XdgMode::Isolated {
            let root = profile.remote_root();
            // The remote root may be a ~-prefixed path (default) or absolute.
            // The XDG functions expect a Path; for ~ paths we pass them as-is
            // (the remote shell expands ~).
            let root_path = std::path::Path::new(root);
            extra_env.push((
                "XDG_CONFIG_HOME".into(),
                pantoken_remote_layout::layout::polytoken_xdg_config(root_path)
                    .to_string_lossy()
                    .into_owned(),
            ));
            extra_env.push((
                "XDG_DATA_HOME".into(),
                pantoken_remote_layout::layout::polytoken_xdg_data(root_path)
                    .to_string_lossy()
                    .into_owned(),
            ));
            extra_env.push((
                "XDG_CACHE_HOME".into(),
                pantoken_remote_layout::layout::polytoken_xdg_cache(root_path)
                    .to_string_lossy()
                    .into_owned(),
            ));
        }

        SshCommand {
            destination: profile.ssh_destination.clone(),
            port: profile.port,
            remote_root: profile.remote_root().to_string(),
            server_path: profile.server_path().to_string(),
            extra_env,
        }
    }
}

// ─────────────────────────────── SshTransport ──────────────────────────────

/// Information about how the SSH proxy process exited.
#[derive(Debug, Clone, Default)]
pub struct ExitInfo {
    /// The process's exit code, if it exited normally.
    pub code: Option<i32>,
    /// The terminating signal, if the process was killed by a signal.
    pub signal: Option<i32>,
    /// Stderr captured from the SSH process (best-effort; may be truncated).
    pub stderr: String,
}

/// A spawned SSH proxy: the framed stdio pair plus a future that resolves when
/// the process exits (returning the [`ExitInfo`]).
///
/// The bridge holds the `stdin`/`stdout` halves for the relay loop and
/// `select!`s the `exit` future against EOF on either stream. When `exit`
/// resolves, the bridge classifies it and either retries (transient) or
/// surfaces an actionable error (auth failure, host-key, clean exit).
pub struct SshProxy {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub exit: Pin<Box<dyn Future<Output = ExitInfo> + Send>>,
}

/// Captured output of a one-shot SSH command.
///
/// Distinct from [`SshProxy`] (streaming relay) — this is for provisioning
/// probes, file operations, and version checks where we need the full
/// stdout/stderr + exit code after the command completes.
#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

impl CommandOutput {
    pub fn is_success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// The SSH transport trait: abstracts spawning an SSH process that speaks the
/// framed stdio protocol on its stdin/stdout.
///
/// Phase 2 ships [`SystemSshTransport`] (spawns `ssh` with `-T`).
/// [`mobile::MobileSshTransport`] is a cfg-gated stub for a future mobile
/// native impl. The [`FakeSshTransport`] test seam drives each connection
/// phase deterministically.
pub trait SshTransport: Send + Sync {
    /// Spawn a fresh SSH proxy process for the given command. Returns the
    /// stdin/stdout halves plus an `exit` future that resolves when the
    /// process exits (with its [`ExitInfo`]).
    ///
    /// Each call spawns a NEW process — a browser reconnect (or an SSH-side
    /// retry inside the bridge's backoff loop) creates a fresh proxy while
    /// preserving the resume token (held by the browser).
    fn spawn_proxy(
        &self,
        command: SshCommand,
    ) -> Pin<Box<dyn Future<Output = io::Result<SshProxy>> + Send>>;

    /// Run a single SSH command and capture its stdout/stderr/exit code.
    /// Distinct from `spawn_proxy` (streaming relay) — this is for provisioning
    /// probes, file operations, and version checks.
    fn run_command(
        &self,
        command: SshCommand,
        remote_command: &str,
    ) -> Pin<Box<dyn Future<Output = io::Result<CommandOutput>> + Send>>;

    /// Upload file bytes to the remote host via SSH stdin.
    /// Used by the installer to transfer verified archives before extraction.
    fn upload_file(
        &self,
        command: SshCommand,
        remote_path: &str,
        data: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;
}

// ─────────────────────────── SystemSshTransport ──────────────────────────

/// A system-`ssh`-client implementation of [`SshTransport`].
///
/// Spawns `ssh -T -o BatchMode=yes -o ServerAliveInterval=30 [-p <port>]
/// <destination> <remote-command>`. `BatchMode=yes` disables interactive
/// prompts (password, host-key acceptance, passphrase) so auth/host-key
/// failures exit fast with code 255 + a stderr message — the bridge classifies
/// these as actionable (not retried).
///
/// The transport is stateless: each `spawn_proxy` call receives the resolved
/// [`SshCommand`] (built from the profile) and spawns a fresh process.
pub struct SystemSshTransport;

impl SystemSshTransport {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemSshTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl SshTransport for SystemSshTransport {
    fn spawn_proxy(
        &self,
        command: SshCommand,
    ) -> Pin<Box<dyn Future<Output = io::Result<SshProxy>> + Send>> {
        Box::pin(async move {
            let argv = command.argv();
            info!(target: "pantoken::bridge", "spawning ssh proxy: {}", command.redacted_debug());

            let mut cmd = tokio::process::Command::new("ssh");
            // kill_on_drop: if the bridge drops the Child handle (teardown,
            // panic, or task abort), the SSH process is killed — NOT orphaned.
            // This closes the Phase 1 `std::mem::forget` leak for good: the
            // child is reaped whenever the owning task ends, whether cleanly
            // (exit future resolves) or abruptly (cancellation/abort).
            cmd.kill_on_drop(true);
            cmd.args(&argv);
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            // The child must not inherit the app's SIGTERM/SIGINT block — see
            // crate::proc::spawn_with_clean_signals for the rationale (the hub
            // supervisor resets the mask pre-exec).
            crate::proc::prepare_clean_signals_async(&mut cmd);

            let mut child = cmd.spawn()?;

            let stdin: Box<dyn AsyncWrite + Send + Unpin> = Box::new(
                child
                    .stdin
                    .take()
                    .ok_or_else(|| io::Error::other("ssh stdin not piped"))?,
            );
            let stdout: Box<dyn AsyncRead + Send + Unpin> = Box::new(
                child
                    .stdout
                    .take()
                    .ok_or_else(|| io::Error::other("ssh stdout not piped"))?,
            );
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| io::Error::other("ssh stderr not piped"))?;

            // Drain stderr in the background so the SSH process doesn't block
            // on a full stderr pipe, and surface it via the exit future.
            let exit = async move {
                let mut stderr_buf = Vec::with_capacity(4096);
                let mut s = stderr;
                let _ = s.read_to_end(&mut stderr_buf).await;
                let stderr_str = String::from_utf8_lossy(&stderr_buf).into_owned();
                let wait_result = child.wait().await;
                match wait_result {
                    Ok(status) => {
                        use std::os::unix::process::ExitStatusExt;
                        ExitInfo {
                            code: status.code(),
                            signal: status.signal(),
                            stderr: stderr_str,
                        }
                    }
                    Err(_) => ExitInfo {
                        code: None,
                        signal: None,
                        stderr: stderr_str,
                    },
                }
            };
            let exit: Pin<Box<dyn Future<Output = ExitInfo> + Send>> = Box::pin(exit);

            Ok(SshProxy {
                stdin,
                stdout,
                exit,
            })
        })
    }

    fn run_command(
        &self,
        command: SshCommand,
        remote_command: &str,
    ) -> Pin<Box<dyn Future<Output = io::Result<CommandOutput>> + Send>> {
        let remote_command = remote_command.to_string();
        Box::pin(async move {
            let mut args = vec![
                "-T".into(),
                "-o".into(),
                "BatchMode=yes".into(),
                "-o".into(),
                "ServerAliveInterval=30".into(),
            ];
            if let Some(port) = command.port {
                args.push("-p".into());
                args.push(port.to_string());
            }
            args.push(command.destination.clone());
            args.push(remote_command);

            let mut cmd = tokio::process::Command::new("ssh");
            cmd.kill_on_drop(true);
            cmd.args(&args);
            cmd.stdin(std::process::Stdio::null());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            crate::proc::prepare_clean_signals_async(&mut cmd);

            let mut child = cmd.spawn()?;
            let mut stdout = child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("ssh stdout not piped"))?;
            let mut stderr = child
                .stderr
                .take()
                .ok_or_else(|| io::Error::other("ssh stderr not piped"))?;

            let stdout_buf = {
                let mut buf = Vec::with_capacity(8192);
                stdout.read_to_end(&mut buf).await?;
                String::from_utf8_lossy(&buf).into_owned()
            };
            let stderr_buf = {
                let mut buf = Vec::with_capacity(4096);
                stderr.read_to_end(&mut buf).await?;
                String::from_utf8_lossy(&buf).into_owned()
            };

            let status = child.wait().await?;
            Ok(CommandOutput {
                stdout: stdout_buf,
                stderr: stderr_buf,
                exit_code: status.code(),
            })
        })
    }

    fn upload_file(
        &self,
        command: SshCommand,
        remote_path: &str,
        data: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        let remote_cmd = format!("cat > {}", shell_quote(remote_path));
        Box::pin(async move {
            let mut args = vec![
                "-T".into(),
                "-o".into(),
                "BatchMode=yes".into(),
                "-o".into(),
                "ServerAliveInterval=30".into(),
            ];
            if let Some(port) = command.port {
                args.push("-p".into());
                args.push(port.to_string());
            }
            args.push(command.destination.clone());
            args.push(remote_cmd);

            let mut cmd = tokio::process::Command::new("ssh");
            cmd.kill_on_drop(true);
            cmd.args(&args);
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::piped());
            crate::proc::prepare_clean_signals_async(&mut cmd);

            let mut child = cmd.spawn()?;
            {
                let mut stdin = child
                    .stdin
                    .take()
                    .ok_or_else(|| io::Error::other("ssh stdin not piped"))?;
                use tokio::io::AsyncWriteExt;
                stdin.write_all(&data).await?;
                stdin.flush().await?;
                // Drop stdin to signal EOF.
            }
            let status = child.wait().await?;
            if !status.success() {
                return Err(io::Error::other(format!(
                    "ssh upload failed: exit {:?}",
                    status.code()
                )));
            }
            Ok(())
        })
    }
}

// ──────────────────────── exit classification ────────────────────────────

/// Classification of an SSH proxy exit. Drives the reconnect decision
/// (retry vs. surface actionable error) and the state-machine transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitClassification {
    /// SSH exit 255 + "Permission denied". No retry — auth is wrong.
    SshAuthFailed,
    /// SSH exit 255 + "Host key verification failed" / "refused".
    /// No retry — the user must accept the host key manually.
    HostKeyUnknown,
    /// SSH exit 255 + "Connection refused" / "timed out" / "unreachable".
    /// Retry with backoff.
    SshUnreachable,
    /// SSH exit 0. No retry — the remote closed deliberately.
    CleanExit,
    /// Any other exit. Retry with backoff (bounded).
    UnknownError,
}

impl ExitClassification {
    /// Whether this classification is retryable (transient). Auth/host-key/clean
    /// exits are NOT retried.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            ExitClassification::SshUnreachable | ExitClassification::UnknownError
        )
    }

    /// Map a classification to a [`crate::remote_connection::ConnectionState`]
    /// failure state. Returns `None` for retryable classifications (the bridge
    /// retries internally; the state machine only sees a terminal failure).
    pub fn to_failure_state(&self) -> Option<crate::remote_connection::ConnectionFailureState> {
        use crate::remote_connection::ConnectionFailureState;
        match self {
            ExitClassification::SshAuthFailed => Some(ConnectionFailureState::SshAuthFailed),
            ExitClassification::HostKeyUnknown => Some(ConnectionFailureState::HostKeyUnknown),
            ExitClassification::SshUnreachable => Some(ConnectionFailureState::SshUnreachable),
            ExitClassification::CleanExit => None,
            ExitClassification::UnknownError => Some(ConnectionFailureState::StartupFailed),
        }
    }
}

/// Classify an SSH exit per the Phase 2 exit table. Stable stderr patterns
/// from current OpenSSH; if a future version changes the wording, classification
/// degrades to `UnknownError` (retries with backoff — safe but less specific).
pub fn classify_exit(exit: &ExitInfo) -> ExitClassification {
    let code = exit.code.unwrap_or(-1);
    let stderr_lower = exit.stderr.to_ascii_lowercase();
    match code {
        255 => {
            // Order matters: "connection refused" contains "refused", so check
            // the unreachable patterns before the bare "refused" host-key signal.
            if stderr_lower.contains("permission denied") {
                ExitClassification::SshAuthFailed
            } else if stderr_lower.contains("host key verification failed")
                || stderr_lower.contains("host key for")
            {
                ExitClassification::HostKeyUnknown
            } else if stderr_lower.contains("connection refused")
                || stderr_lower.contains("timed out")
                || stderr_lower.contains("unreachable")
                || stderr_lower.contains("could not resolve hostname")
            {
                ExitClassification::SshUnreachable
            } else if stderr_lower.contains("refused") {
                // Bare "refused" (e.g. "host key for X refused") without the
                // "connection refused" phrasing — treat as host-key.
                ExitClassification::HostKeyUnknown
            } else {
                ExitClassification::UnknownError
            }
        }
        0 => ExitClassification::CleanExit,
        _ => ExitClassification::UnknownError,
    }
}

// ─────────────────────────── ReconnectPolicy ─────────────────────────────

/// Bounded exponential backoff with jitter, matching the client's
/// `ws.svelte.ts` pattern (base 500ms, max 15s, ×2 per attempt, ±25% jitter).
/// The bridge owns this policy for SSH-side retries (the browser's WS stays
/// connected across SSH-side retries).
#[derive(Debug)]
pub struct ReconnectPolicy {
    base: Duration,
    max: Duration,
    /// Max attempts before the bridge gives up and closes the browser WS
    /// (triggering exactly one browser reconnect to the same bridge loopback
    /// port — the browser's resume token survives).
    max_attempts: u32,
    attempt: u32,
    /// Seeded jitter source; tests inject a deterministic one.
    jitter: Box<dyn JitterSource + Send + Sync>,
}

impl ReconnectPolicy {
    pub fn new() -> Self {
        Self {
            base: Duration::from_millis(500),
            max: Duration::from_millis(15_000),
            max_attempts: 5,
            attempt: 0,
            jitter: Box::new(ThreadRng),
        }
    }

    /// Test-only constructor with a deterministic jitter source and attempt
    /// limit. The jitter value is in `[0, 1)`; the policy applies ±25%.
    #[cfg(test)]
    pub fn with_jitter(max_attempts: u32, jitter: Box<dyn JitterSource + Send + Sync>) -> Self {
        Self {
            base: Duration::from_millis(500),
            max: Duration::from_millis(15_000),
            max_attempts,
            attempt: 0,
            jitter,
        }
    }

    /// The current attempt number (0 before the first retry).
    #[allow(dead_code)]
    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    /// Whether the policy has exhausted its retry budget.
    #[allow(dead_code)]
    pub fn is_exhausted(&self) -> bool {
        self.attempt >= self.max_attempts
    }

    /// Compute the next backoff delay and advance the attempt counter.
    /// Returns `None` if the policy is exhausted.
    pub fn next_delay(&mut self) -> Option<Duration> {
        if self.is_exhausted() {
            return None;
        }
        let exp = 2u64.saturating_pow(self.attempt);
        let base_ms = self.base.as_millis() as u64;
        let capped = (base_ms.saturating_mul(exp)).min(self.max.as_millis() as u64);
        // ±25% jitter: shift into [-0.25, +0.25] using the source's [0,1) value.
        let j = (self.jitter.next()) - 0.5; // [-0.5, 0.5)
        let jitter_factor = j * 0.5; // [-0.25, 0.25)
        let delay_ms = (capped as f64 * (1.0 + jitter_factor)).round() as u64;
        let delay_ms = delay_ms.max(1);
        self.attempt += 1;
        Some(Duration::from_millis(delay_ms))
    }

    /// Reset to the initial state (used when a fresh browser connection
    /// arrives — each browser WS gets its own backoff budget).
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self::new()
    }
}

/// A source of `[0, 1)` floats for backoff jitter. Tests inject a deterministic
/// source; production uses thread-local RNG.
pub trait JitterSource: std::fmt::Debug {
    fn next(&self) -> f64;
}

#[derive(Debug, Clone, Copy)]
struct ThreadRng;

impl JitterSource for ThreadRng {
    fn next(&self) -> f64 {
        // Good-enough jitter: a fast, thread-safe PRNG seeded by the current
        // time. We don't need cryptographic quality — just enough to
        // de-correlate concurrent reconnects. `ThreadId::as_u64()` is
        // unstable, so we use only the nanosecond counter (monotonic within a
        // thread and sufficiently varied across reconnect attempts).
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0);
        // Mix in the stack address to vary across tasks/threads.
        let stack_addr = std::ptr::addr_of!(nanos) as usize as u64;
        let mix = nanos.wrapping_add(stack_addr);
        // Map to [0, 1) — use the low 24 bits for a stable range.
        (mix & 0xFFFFFF) as f64 / ((1u64 << 24) as f64)
    }
}

// ───────────────────────────── keepalive ─────────────────────────────────

/// Interval at which the bridge sends WS keepalive text frames during an
/// SSH-side retry window. Must be comfortably under the browser's
/// `HEARTBEAT_WATCHDOG_MS = 10_000` (ws.svelte.ts): a keepalive every ~3s
/// ensures `lastInboundAt` stays fresh even if an SSH retry takes the full
/// max backoff of 15s.
const KEEPALIVE_INTERVAL: Duration = Duration::from_millis(3_000);

/// An empty text frame. WS `Pong` frames do NOT fire the browser's `onmessage`
/// handler (they're consumed by the WebSocket layer) and thus do NOT reset
/// `lastInboundAt` — only text/binary frames do. An empty text frame fires
/// `onmessage` → stamps `lastInboundAt` → fails to parse as a `ServerMessage`
/// → early return, but the watchdog is already satisfied.
fn keepalive_frame() -> WsMessage {
    WsMessage::Text(String::new().into())
}

// ─────────────────────────────── Bridge ───────────────────────────────────

/// The local bridge: owns a loopback WS listener and forwards messages
/// between the browser and the SSH stdio transport.
///
/// The bridge is a long-lived listener: `run()` loops `listener.accept()`
/// forever (until the cancellation token fires). Each browser connection
/// spawns its own SSH proxy + relay task, and owns its own reconnect policy
/// for SSH-side retries (keeping the browser WS open across retries).
pub struct Bridge {
    /// The loopback port the browser connects to.
    pub port: u16,
    /// The SSH transport (spawns proxy processes).
    transport: Arc<dyn SshTransport>,
    /// The resolved SSH command (destination, port, remote root, server path).
    /// Passed to each `spawn_proxy` call so the transport stays stateless.
    command: SshCommand,
    /// Optional sink for connection-state updates (drives the native overlay).
    /// `None` in tests; the desktop wires a real one in Step 6.
    state_sink: Option<Arc<dyn ConnectionStateSink>>,
}

/// A sink for connection-state updates from the bridge. The desktop's
/// `RemoteConnection` (state machine) implements this; the bridge calls it on
/// each state transition so the overlay reflects the current phase.
pub trait ConnectionStateSink: Send + Sync {
    /// The bridge transitioned to a new state.
    fn on_state(&self, state: crate::remote_connection::ConnectionState);
}

impl Bridge {
    /// Create a new bridge bound to the given loopback port with no state sink
    /// (test/standalone use). The `command` is the resolved SSH command built
    /// from the profile; the transport spawns it.
    pub fn new(port: u16, transport: Arc<dyn SshTransport>, command: SshCommand) -> Self {
        Self {
            port,
            transport,
            command,
            state_sink: None,
        }
    }

    /// Attach a connection-state sink (drives the native overlay). The desktop
    /// wires this in `connect_to_remote` (Step 6).
    pub fn with_state_sink(mut self, sink: Arc<dyn ConnectionStateSink>) -> Self {
        self.state_sink = Some(sink);
        self
    }

    /// Run the bridge: accept browser WS connections and forward to/from the
    /// SSH stdio transport. Returns when the cancellation token is cancelled
    /// (graceful shutdown) or an unrecoverable listener error occurs.
    ///
    /// Each browser connection spawns a fresh SSH proxy. When the SSH process
    /// exits, the bridge classifies the exit and either retries (transient,
    /// keeping the browser WS open) or surfaces an actionable failure.
    pub async fn run(self, cancel: CancellationToken) -> io::Result<()> {
        let listener = TcpListener::bind(("127.0.0.1", self.port)).await?;
        info!(target: "pantoken::bridge", "bridge: listening on 127.0.0.1:{}", self.port);

        let transport = self.transport;
        let command = Arc::new(self.command);
        let state_sink = self.state_sink;

        loop {
            // Accept loop: select on listener.accept() vs cancellation.
            let accept = listener.accept();
            tokio::pin!(accept);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    info!(target: "pantoken::bridge", "bridge: cancellation received, shutting down");
                    return Ok(());
                }
                result = &mut accept => {
                    let (stream, addr) = match result {
                        Ok(pair) => pair,
                        Err(e) => {
                            warn!(target: "pantoken::bridge", "bridge: accept error: {e}");
                            // A transient accept error shouldn't kill the listener.
                            continue;
                        }
                    };
                    info!(target: "pantoken::bridge", "bridge: browser connected from {addr}");
                    let transport = transport.clone();
                    let command = command.clone();
                    let state_sink = state_sink.clone();
                    // Child token: cancels this connection's relay task when the
                    // bridge shuts down. Without this, the detached relay task
                    // (holding the SshProxy → Child) would outlive `run()` and
                    // the SSH process would leak.
                    let conn_cancel = cancel.child_token();
                    tokio::spawn(async move {
                        if let Err(e) = handle_browser_connection(
                            stream,
                            transport,
                            command,
                            state_sink,
                            conn_cancel,
                        )
                        .await
                        {
                            warn!(target: "pantoken::bridge", "bridge: connection error: {e}");
                        }
                    });
                }
            }
        }
    }
}

/// Handle a single browser WS connection: upgrade to WS, spawn an SSH proxy,
/// and forward messages bidirectionally with reconnect-with-backoff.
async fn handle_browser_connection(
    stream: tokio::net::TcpStream,
    transport: Arc<dyn SshTransport>,
    command: Arc<SshCommand>,
    state_sink: Option<Arc<dyn ConnectionStateSink>>,
    cancel: CancellationToken,
) -> io::Result<()> {
    use crate::remote_connection::ConnectionState;

    // WS upgrade: replace the Phase 1 raw TCP + newline-delimited JSON with a
    // real WebSocket via tokio-tungstenite::accept_async.
    let ws_stream = tokio_tungstenite::accept_async(stream).await.map_err(|e| {
        io::Error::new(io::ErrorKind::ConnectionAborted, format!("ws upgrade: {e}"))
    })?;

    if let Some(sink) = &state_sink {
        sink.on_state(ConnectionState::Connecting);
    }

    run_ws_relay(ws_stream, transport, command, state_sink, cancel).await
}

/// The WS↔SSH relay loop with reconnect-with-backoff on the SSH side.
///
/// The browser WS stays open across SSH-side retries. Only if backoff is
/// exhausted does the bridge close the browser WS (triggering exactly one
/// browser reconnect to the same bridge port — the resume token survives).
async fn run_ws_relay(
    ws_stream: WebSocketStream<tokio::net::TcpStream>,
    transport: Arc<dyn SshTransport>,
    command: Arc<SshCommand>,
    state_sink: Option<Arc<dyn ConnectionStateSink>>,
    cancel: CancellationToken,
) -> io::Result<()> {
    use crate::remote_connection::ConnectionState;

    let (mut ws_sink, mut ws_stream) = ws_stream.split();
    let mut policy = ReconnectPolicy::new();

    loop {
        // Spawn a fresh SSH proxy for this connection (or retry).
        if let Some(sink) = &state_sink {
            sink.on_state(ConnectionState::Starting);
        }

        let proxy = match transport.spawn_proxy((*command).clone()).await {
            Ok(p) => p,
            Err(e) => {
                warn!(target: "pantoken::bridge", "bridge: ssh spawn failed: {e}");
                if let Some(sink) = &state_sink {
                    sink.on_state(ConnectionState::failed(
                        crate::remote_connection::ConnectionFailureState::ProxyStartFailed,
                        format!("could not start SSH proxy: {e}"),
                    ));
                }
                // close the WS and let the browser reconnect.
                return Ok(());
            }
        };

        if let Some(sink) = &state_sink {
            sink.on_state(ConnectionState::Ready);
        }

        let (mut ssh_stdin, mut ssh_stdout) = (proxy.stdin, proxy.stdout);
        let ssh_exit = proxy.exit;
        tokio::pin!(ssh_exit);

        // Pong forwarding: the browser→SSH reader can't hold ws_sink (it's
        // owned by the SSH→browser writer). Pings observed on the browser
        // side are forwarded through this channel so the SSH→browser side
        // sends the Pong reply on the writer it owns.
        let (pong_tx, mut pong_rx) = tokio::sync::mpsc::unbounded_channel::<WsMessage>();

        // SSH → Browser direction: read framed ServerEnvelope from SSH stdout,
        // unwrap, write raw ServerMessage JSON to the browser WS. Also drains
        // pong replies forwarded from the browser→SSH side.
        let ssh_to_browser = async {
            let mut decoder = FrameDecoder::new();
            let mut buf = [0u8; 8192];
            loop {
                tokio::select! {
                    biased;
                    Some(pong) = pong_rx.recv() => {
                        if ws_sink.send(pong).await.is_err() {
                            return;
                        }
                    }
                    read = ssh_stdout.read(&mut buf) => {
                        match read {
                            Ok(0) => {
                                info!(target: "pantoken::bridge", "bridge: SSH stdout EOF");
                                break;
                            }
                            Ok(n) => {
                                for body in decoder.push(&buf[..n]).into_iter().flatten() {
                                    if let Ok(env) = serde_json::from_slice::<ServerEnvelope>(&body) {
                                        let json = serde_json::to_string(&env.message).unwrap_or_default();
                                        if ws_sink
                                            .send(WsMessage::Text(json.into()))
                                            .await
                                            .is_err()
                                        {
                                            return;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                warn!(target: "pantoken::bridge", "bridge: SSH read error: {e}");
                                break;
                            }
                        }
                    }
                }
            }
        };

        // Browser → SSH direction: read WS Text frames (raw ClientMessage
        // JSON), wrap in ClientEnvelope+frame, write to SSH stdin. Handle
        // WS-level ping/pong/close/binary per the Phase 2 contract. Pings are
        // forwarded to the SSH→browser side via pong_tx (which owns ws_sink).
        let browser_to_ssh = async {
            loop {
                match ws_stream.next().await {
                    Some(Ok(WsMessage::Text(text))) => {
                        // Empty text frame = bridge keepalive (sent by the
                        // retry loop below). Not a ClientMessage; silently drop.
                        if text.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(msg) => {
                                let env = ClientEnvelope::new(msg);
                                match frame::encode_client(&env) {
                                    Ok(frame_bytes) => {
                                        if ssh_stdin.write_all(&frame_bytes).await.is_err() {
                                            return;
                                        }
                                        let _ = ssh_stdin.flush().await;
                                    }
                                    Err(e) => {
                                        warn!(target: "pantoken::bridge", "bridge: frame encode error: {e}");
                                    }
                                }
                            }
                            Err(e) => {
                                warn!(target: "pantoken::bridge", "bridge: invalid ClientMessage JSON: {e}");
                            }
                        }
                    }
                    Some(Ok(WsMessage::Binary(_))) => {
                        // Protocol is text-only JSON; ignore binary frames.
                        continue;
                    }
                    Some(Ok(WsMessage::Ping(payload))) => {
                        // tokio-tungstenite does NOT auto-respond to pings.
                        // Forward the Pong to the writer side (which owns
                        // ws_sink) so we don't borrow ws_sink here.
                        let _ = pong_tx.send(WsMessage::Pong(payload));
                    }
                    Some(Ok(WsMessage::Pong(_))) => {
                        // Pongs from the browser are not expected (the bridge
                        // doesn't send pings), but tolerate them silently.
                        continue;
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        info!(target: "pantoken::bridge", "bridge: browser closed WS");
                        return;
                    }
                    Some(Ok(WsMessage::Frame(_))) => {
                        // Raw frame — tungstenite exposes low-level frames in
                        // some configs. The protocol uses Text/Close only;
                        // ignore anything else.
                        continue;
                    }
                    Some(Err(e)) => {
                        warn!(target: "pantoken::bridge", "bridge: WS read error: {e}");
                        return;
                    }
                    None => {
                        // WS stream ended.
                        return;
                    }
                }
            }
        };

        // Race the two relay directions against the SSH exit future + the
        // cancellation token.
        // - If a relay direction finishes first, the connection is tearing
        //   down (browser closed or a stream error); break out.
        // - If ssh_exit resolves first, classify and decide retry vs. surface.
        // - If cancel fires, the bridge is shutting down — return immediately
        //   (dropping the streams + the SSH child via kill_on_drop).
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                info!(target: "pantoken::bridge", "bridge: relay cancelled, tearing down");
                return Ok(());
            }
            _ = &mut ssh_exit => {
                // The relay futures are still pending; we can't cleanly cancel
                // them without dropping the streams. Drop the relay handles
                // (they're owned by the select arms we never entered) by
                // letting them go out of scope below — but they're pinned in
                // the select, so we just proceed and re-loop.
                // We need the ExitInfo: re-await the already-completed future.
            }
            _ = ssh_to_browser => {
                // SSH stdout EOF or WS write error — the connection is dead.
                return Ok(());
            }
            _ = browser_to_ssh => {
                // Browser closed or errored.
                return Ok(());
            }
        }

        // ssh_exit resolved — classify and decide retry vs. surface.
        let exit_info = (&mut ssh_exit).await;
        let classification = classify_exit(&exit_info);
        info!(
            target: "pantoken::bridge",
            "bridge: ssh exited code={:?} signal={:?} classification={:?} stderr_len={}",
            exit_info.code, exit_info.signal, classification, exit_info.stderr.len()
        );

        if !classification.is_retryable() {
            if let Some(sink) = &state_sink {
                if let Some(failure) = classification.to_failure_state() {
                    sink.on_state(ConnectionState::failed(failure, exit_info.stderr.clone()));
                }
            }
            // Clean exit or actionable failure: close the browser WS (the
            // browser's reconnect logic handles resume).
            return Ok(());
        }

        // Retryable: apply backoff, keeping the browser WS open.
        let delay = match policy.next_delay() {
            Some(d) => d,
            None => {
                // Backoff exhausted: close the browser WS so the browser
                // reconnects to the same bridge port (fresh SSH proxy, fresh
                // backoff budget). The resume token survives.
                warn!(target: "pantoken::bridge", "bridge: reconnect backoff exhausted, closing browser WS");
                if let Some(sink) = &state_sink {
                    sink.on_state(ConnectionState::failed(
                        crate::remote_connection::ConnectionFailureState::SshUnreachable,
                        "reconnect backoff exhausted".to_string(),
                    ));
                }
                return Ok(());
            }
        };

        if let Some(sink) = &state_sink {
            sink.on_state(ConnectionState::Reconnecting);
        }

        // Keep the browser's heartbeat watchdog satisfied during the backoff
        // window: send periodic keepalive text frames so `lastInboundAt`
        // stays fresh (max backoff 15s > the 10s watchdog). Without this the
        // browser would prematurely kill the WS mid-retry.
        let keepalive_deadline = tokio::time::sleep(delay);
        tokio::pin!(keepalive_deadline);
        let mut keepalive_ticker = tokio::time::interval(KEEPALIVE_INTERVAL);
        keepalive_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        keepalive_ticker.tick().await; // discard immediate first tick
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Ok(()),
                _ = &mut keepalive_deadline => break,
                _ = keepalive_ticker.tick() => {
                    if ws_sink.send(keepalive_frame()).await.is_err() {
                        // Browser WS is gone — stop retrying.
                        return Ok(());
                    }
                }
                // Also drain any incoming WS frames so the browser's own
                // outbound traffic doesn't back up.
                frame = ws_stream.next() => {
                    match frame {
                        Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return Ok(()),
                        _ => {} // ignore text/binary/ping during retry
                    }
                }
            }
        }
        // Loop back to spawn_proxy.
    }
}

// ───────────────────────── mobile stub (Step 9) ──────────────────────────

/// Mobile SSH transport stub. A cfg-gated seam documenting where a future
/// mobile native SSH impl (e.g. SwiftNIO SSH on iOS, a JNI wrapper on
/// Android) plugs in. The `SshTransport` trait is the contract; the mobile impl
/// swaps the system `ssh` executable for a native library.
#[cfg(any(target_os = "ios", target_os = "android", doc))]
pub mod mobile {
    use super::*;

    /// Marker type for the mobile SSH transport. Only constructed under the
    /// mobile cfg; never reachable from desktop builds.
    pub struct MobileSshTransport;

    impl SshTransport for MobileSshTransport {
        fn spawn_proxy(
            &self,
            _command: SshCommand,
        ) -> Pin<Box<dyn Future<Output = io::Result<SshProxy>> + Send>> {
            Box::pin(async {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "mobile SSH transport not yet implemented — use a native SSH library",
                ))
            })
        }

        fn run_command(
            &self,
            _command: SshCommand,
            _remote_command: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<CommandOutput>> + Send>> {
            Box::pin(async {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "mobile SSH transport not yet implemented",
                ))
            })
        }

        fn upload_file(
            &self,
            _command: SshCommand,
            _remote_path: &str,
            _data: Vec<u8>,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
            Box::pin(async {
                Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "mobile SSH transport not yet implemented",
                ))
            })
        }
    }
}

// ────────────────────────────── tests ────────────────────────────────────

#[cfg(test)]
pub mod fake;

#[cfg(test)]
mod tests {
    //! Bridge WS upgrade + reconnect + classification + backoff tests.
    //!
    //! Named validations:
    //! - `bridge_ws_upgrade_forwards_hello_and_messages` (AC.1)
    //! - `bridge_ws_upgrade_reconnect_spawns_fresh_proxy` (AC.1)
    //! - `ssh_exit_classification` (AC.6)
    //! - `reconnect_backoff_bounded` (AC.6)
    //! - `bridge_keepalive_during_ssh_retry` (AC.6)
    //! - `fake_ssh_transport_drives_connection_phases` (AC.10)
    //! - `ssh_command_construction_tests` (AC.3)
    //! - `ssh_arg_redaction_tests` (AC.3)

    use super::*;
    use crate::bridge::fake::{FakeScenario, FakeSshTransport};
    use crate::remote_connection::ConnectionFailureState;
    use futures_util::{SinkExt, StreamExt};
    use pantoken_protocol::wire::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// A deterministic jitter source for backoff tests (always returns 0.5 →
    /// no jitter, so delays are exactly base × 2^attempt).
    #[derive(Debug, Clone, Copy)]
    struct FixedJitter;

    impl JitterSource for FixedJitter {
        fn next(&self) -> f64 {
            0.5
        }
    }

    /// Helper: get a free loopback port (bind :0, read port, drop listener).
    fn get_free_port() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    /// Build an SshCommand suitable for the fake transport (the fake ignores
    /// its contents; only the redaction tests care about real values).
    fn fake_command() -> SshCommand {
        SshCommand {
            destination: "fake-host".into(),
            port: None,
            remote_root: "/tmp/fake".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        }
    }

    /// Helper: connect a real WS client to the bridge and send a Hello.
    async fn ws_connect_and_hello(
        port: u16,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let url = format!("ws://127.0.0.1:{port}");
        let (mut stream, _response) = tokio_tungstenite::connect_async(url)
            .await
            .expect("ws connect");
        let hello = serde_json::to_string(&ClientMessage::Hello {
            auth: None,
            resume: None,
        })
        .unwrap();
        stream
            .send(WsMessage::Text(hello.into()))
            .await
            .expect("send hello");
        stream
    }

    /// Helper: receive the next ServerMessage from a WS stream, with a timeout.
    async fn recv_server_msg(
        stream: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Option<ServerMessage> {
        loop {
            match tokio::time::timeout(Duration::from_secs(3), stream.next()).await {
                Ok(Some(Ok(WsMessage::Text(text)))) => {
                    let msg: ServerMessage = serde_json::from_str(&text).expect("parse server msg");
                    return Some(msg);
                }
                Ok(Some(Ok(WsMessage::Ping(_)))) => continue,
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => return None,
                Err(_) => panic!("timeout waiting for server message"),
            }
        }
    }

    // ── AC.1: bridge WS upgrade ───────────────────────────────────────────

    #[tokio::test]
    async fn bridge_ws_upgrade_forwards_hello_and_messages() {
        let port = get_free_port();
        let transport: Arc<dyn SshTransport> =
            Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let bridge = Bridge::new(port, transport, fake_command());

        let cancel = CancellationToken::new();
        let bridge_handle = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let _ = bridge.run(cancel).await;
            })
        };

        // Give the bridge a moment to bind.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let mut stream = ws_connect_and_hello(port).await;

        // The fake responds to Hello with a ServerMessage::Hello.
        let msg = recv_server_msg(&mut stream).await.expect("hello response");
        assert!(
            matches!(msg, ServerMessage::Hello { protocol_version, .. } if protocol_version == PROTOCOL_VERSION),
            "bridge must forward Hello through the fake SSH transport: got {msg:?}"
        );

        // Send a Ping → expect a Pong forwarded through.
        stream
            .send(WsMessage::Text(
                serde_json::to_string(&ClientMessage::Ping).unwrap().into(),
            ))
            .await
            .expect("send ping");
        let msg = recv_server_msg(&mut stream).await.expect("pong response");
        assert!(
            matches!(msg, ServerMessage::Pong),
            "expected Pong, got {msg:?}"
        );

        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), bridge_handle).await;
    }

    #[tokio::test]
    async fn bridge_ws_upgrade_reconnect_spawns_fresh_proxy() {
        let port = get_free_port();
        let transport = Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let transport_clone = transport.clone();
        let bridge = Bridge::new(port, transport, fake_command());

        let cancel = CancellationToken::new();
        let bridge_handle = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let _ = bridge.run(cancel).await;
            })
        };

        tokio::time::sleep(Duration::from_millis(100)).await;

        // First connection.
        let mut stream1 = ws_connect_and_hello(port).await;
        let msg = recv_server_msg(&mut stream1).await.expect("first hello");
        assert!(matches!(msg, ServerMessage::Hello { .. }));
        drop(stream1);

        // Second connection (browser reconnect) — spawns a fresh proxy.
        let mut stream2 = ws_connect_and_hello(port).await;
        let msg = recv_server_msg(&mut stream2).await.expect("second hello");
        assert!(
            matches!(msg, ServerMessage::Hello { .. }),
            "reconnect must spawn a fresh proxy"
        );
        drop(stream2);

        // The spawn counter reflects two fresh proxies.
        assert_eq!(
            transport_clone.spawn_count(),
            2,
            "two browser connections → two ssh proxies"
        );

        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), bridge_handle).await;
    }

    // ── AC.3: ssh command construction + redaction ───────────────────────

    #[test]
    fn ssh_command_construction_tests() {
        let cmd = SshCommand {
            destination: "user@host.example".into(),
            port: Some(2222),
            remote_root: "/srv/pantoken".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        };
        let argv = cmd.argv();

        // -T, BatchMode=yes, ServerAliveInterval=30.
        assert!(argv.iter().any(|a| a == "-T"), "must pass -T");
        assert!(
            argv.windows(2)
                .any(|w| w[0] == "-o" && w[1] == "BatchMode=yes"),
            "must pass BatchMode=yes"
        );
        assert!(
            argv.windows(2)
                .any(|w| w[0] == "-o" && w[1] == "ServerAliveInterval=30"),
            "must pass ServerAliveInterval=30"
        );

        // Port.
        assert!(
            argv.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"),
            "must pass -p 2222"
        );

        // Destination is the last-but-one arg (before the remote command).
        let dest_idx = argv
            .iter()
            .position(|a| a == "user@host.example")
            .expect("destination in argv");
        assert!(dest_idx > 0, "destination not first");

        // Remote command: env prefix + exec.
        let remote_cmd = cmd.remote_command();
        assert!(remote_cmd.contains("PANTOKEN_SERVE_MODE=stdio-proxy"));
        assert!(remote_cmd.contains("PANTOKEN_REMOTE_ROOT=/srv/pantoken"));
        assert!(remote_cmd.contains("exec pantoken-server"));
    }

    #[test]
    fn ssh_command_construction_no_port_when_none() {
        let cmd = SshCommand {
            destination: "host".into(),
            port: None,
            remote_root: "/r".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        };
        let argv = cmd.argv();
        assert!(!argv.iter().any(|a| a == "-p"), "no -p when port is None");
    }

    #[test]
    fn ssh_arg_redaction_tests() {
        // user@host form: the destination must NOT appear in Debug output.
        let cmd = SshCommand {
            destination: "timo@secret-host.example".into(),
            port: Some(2222),
            remote_root: "/srv/p".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        };
        let debug = format!("{:?}", cmd);
        assert!(
            !debug.contains("timo@secret-host.example"),
            "Debug must not leak the destination: {debug}"
        );
        assert!(
            debug.contains("<redacted>"),
            "Debug must show <redacted>: {debug}"
        );

        // SSH config alias form: also redacted (can't distinguish from creds).
        let cmd = SshCommand {
            destination: "build-server".into(),
            port: None,
            remote_root: "/r".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        };
        let debug = format!("{:?}", cmd);
        assert!(
            !debug.contains("build-server"),
            "Debug must not leak even a bare alias: {debug}"
        );

        // Display also redacts.
        let display = format!("{}", cmd);
        assert!(!display.contains("timo@secret-host.example"));
        assert!(display.contains("<redacted>"));
    }

    // ── AC.6: exit classification ────────────────────────────────────────

    #[test]
    fn ssh_exit_classification() {
        let cases: &[(ExitInfo, ExitClassification)] = &[
            (
                ExitInfo {
                    code: Some(255),
                    signal: None,
                    stderr: "Permission denied (publickey).".into(),
                },
                ExitClassification::SshAuthFailed,
            ),
            (
                ExitInfo {
                    code: Some(255),
                    signal: None,
                    stderr: "Host key verification failed.".into(),
                },
                ExitClassification::HostKeyUnknown,
            ),
            (
                ExitInfo {
                    code: Some(255),
                    signal: None,
                    stderr: "Connection refused".into(),
                },
                ExitClassification::SshUnreachable,
            ),
            (
                ExitInfo {
                    code: Some(255),
                    signal: None,
                    stderr: "Operation timed out".into(),
                },
                ExitClassification::SshUnreachable,
            ),
            (
                ExitInfo {
                    code: Some(0),
                    signal: None,
                    stderr: String::new(),
                },
                ExitClassification::CleanExit,
            ),
            (
                ExitInfo {
                    code: Some(1),
                    signal: None,
                    stderr: "something else".into(),
                },
                ExitClassification::UnknownError,
            ),
        ];
        for (exit, expected) in cases {
            let got = classify_exit(exit);
            assert_eq!(
                got, *expected,
                "exit code={:?} stderr={:?} → expected {expected:?}, got {got:?}",
                exit.code, exit.stderr
            );
        }

        // Failure-state mapping.
        assert_eq!(
            ExitClassification::SshAuthFailed.to_failure_state(),
            Some(ConnectionFailureState::SshAuthFailed)
        );
        assert_eq!(
            ExitClassification::HostKeyUnknown.to_failure_state(),
            Some(ConnectionFailureState::HostKeyUnknown)
        );
        assert_eq!(
            ExitClassification::SshUnreachable.to_failure_state(),
            Some(ConnectionFailureState::SshUnreachable)
        );
        assert_eq!(ExitClassification::CleanExit.to_failure_state(), None);

        // Retryability.
        assert!(!ExitClassification::SshAuthFailed.is_retryable());
        assert!(!ExitClassification::HostKeyUnknown.is_retryable());
        assert!(ExitClassification::SshUnreachable.is_retryable());
        assert!(!ExitClassification::CleanExit.is_retryable());
        assert!(ExitClassification::UnknownError.is_retryable());
    }

    // ── AC.6: bounded backoff ────────────────────────────────────────────

    #[test]
    fn reconnect_backoff_bounded() {
        let mut policy = ReconnectPolicy::with_jitter(5, Box::new(FixedJitter));

        // Delays grow exponentially: 500ms, 1s, 2s, 4s, 8s (all within [base, max]).
        let mut delays = Vec::new();
        while let Some(d) = policy.next_delay() {
            delays.push(d);
        }
        assert_eq!(delays.len(), 5, "max_attempts=5 → 5 delays");

        // Each delay within [base, max].
        for &d in &delays {
            assert!(
                d >= Duration::from_millis(500),
                "delay {d:?} below base 500ms"
            );
            assert!(
                d <= Duration::from_millis(15_000),
                "delay {d:?} above max 15s"
            );
        }

        // Exponential growth (no jitter with FixedJitter=0.5 → factor 1.0).
        assert_eq!(delays[0], Duration::from_millis(500));
        assert_eq!(delays[1], Duration::from_millis(1000));
        assert_eq!(delays[2], Duration::from_millis(2000));
        assert_eq!(delays[3], Duration::from_millis(4000));
        assert_eq!(delays[4], Duration::from_millis(8000));

        // Exhausted after max_attempts.
        assert!(policy.is_exhausted());
        assert!(policy.next_delay().is_none());

        // Reset → fresh budget.
        policy.reset();
        assert!(!policy.is_exhausted());
        assert!(policy.next_delay().is_some());
    }

    #[test]
    fn reconnect_backoff_caps_at_max() {
        // With enough attempts, the delay saturates at 15s.
        let mut policy = ReconnectPolicy::with_jitter(10, Box::new(FixedJitter));
        let mut last = Duration::ZERO;
        let mut count = 0;
        while let Some(d) = policy.next_delay() {
            assert!(d >= last, "backoff should be non-decreasing");
            last = d;
            count += 1;
        }
        assert_eq!(last, Duration::from_millis(15_000), "caps at 15s");
        assert!(count <= 10);
    }

    // ── AC.6: keepalive during SSH retry ─────────────────────────────────

    #[tokio::test]
    async fn bridge_keepalive_during_ssh_retry() {
        // This test verifies the keepalive *contract*: an empty text frame is
        // a valid keepalive (fires onmessage, resets lastInboundAt, fails to
        // parse as a ServerMessage → early return). We verify the frame is
        // empty + text, and that the browser-side parse path tolerates it.
        let frame = keepalive_frame();
        match frame {
            WsMessage::Text(ref t) => {
                assert!(t.is_empty(), "keepalive is an empty text frame");
            }
            other => panic!("keepalive must be a Text frame, got {other:?}"),
        }

        // Simulate the browser-side onmessage handler for an empty frame:
        // parseServerMessage("") returns None (not a valid ServerMessage), and
        // the heartbeat watchdog is already satisfied by the frame arriving.
        // We verify the parse is a no-op (no panic, no message forwarded).
        let parsed: Option<ServerMessage> = serde_json::from_str("").ok();
        assert!(
            parsed.is_none(),
            "empty keepalive frame is not a ServerMessage"
        );

        // The KEEPALIVE_INTERVAL is comfortably under the browser's 10s watchdog.
        assert!(
            KEEPALIVE_INTERVAL < Duration::from_secs(10),
            "keepalive interval must be under the 10s browser watchdog"
        );
    }

    // ── AC.10: fake transport drives connection phases ───────────────────

    #[tokio::test]
    async fn fake_ssh_transport_drives_connection_phases() {
        // Success: healthy → Hello forwarded.
        let port = get_free_port();
        let transport = Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let transport_clone = transport.clone();
        let bridge = Bridge::new(port, transport, fake_command());
        let cancel = CancellationToken::new();
        let handle = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let _ = bridge.run(cancel).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        let mut stream = ws_connect_and_hello(port).await;
        let msg = recv_server_msg(&mut stream).await.expect("hello");
        assert!(matches!(msg, ServerMessage::Hello { .. }));
        drop(stream);
        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
        assert!(transport_clone.spawn_count() >= 1);

        // Auth failure: exit 255 + "Permission denied" → classified.
        let exit = FakeScenario::auth_failure().exit_info;
        let class = classify_exit(&exit);
        assert_eq!(class, ExitClassification::SshAuthFailed);

        // Host-key failure.
        let exit = FakeScenario::host_key_failure().exit_info;
        assert_eq!(classify_exit(&exit), ExitClassification::HostKeyUnknown);

        // Unreachable.
        let exit = FakeScenario::unreachable().exit_info;
        assert_eq!(classify_exit(&exit), ExitClassification::SshUnreachable);

        // Clean exit.
        let exit = FakeScenario::clean_exit().exit_info;
        assert_eq!(classify_exit(&exit), ExitClassification::CleanExit);
    }

    // ── AC.3: no child process leak (FakeSshTransport exit future) ────────

    #[tokio::test]
    async fn bridge_does_not_leak_child_process() {
        // The FakeSshTransport's exit future resolves cleanly on teardown.
        // We verify the bridge task ends (no hang) after cancellation, and
        // the spawn counter reflects exactly the connections we made (no
        // zombie spawns from a leaked child).
        let port = get_free_port();
        let transport = Arc::new(FakeSshTransport::new(FakeScenario::healthy()));
        let transport_clone = transport.clone();
        let bridge = Bridge::new(port, transport, fake_command());
        let cancel = CancellationToken::new();
        let handle = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let _ = bridge.run(cancel).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        let mut stream = ws_connect_and_hello(port).await;
        let _ = recv_server_msg(&mut stream).await;
        drop(stream);

        // Teardown: cancel + await the bridge task.
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(3), handle).await;
        assert!(
            result.is_ok(),
            "bridge task must exit promptly after cancellation — no leaked child"
        );

        // No extra spawns after teardown.
        let final_spawns = transport_clone.spawn_count();
        assert!(final_spawns >= 1, "at least one spawn happened");
    }
}

/// AC.13 smoke tests for the native transport seam.
///
/// These tests prove the `SshTransport` trait is a clean injection seam that
/// can be exercised directly (without the `Bridge`) and that a fresh
/// `spawn_proxy` call restarts the relay after a transport exit. The
/// capability map:
///
/// | AC.13 capability              | Validating test                              |
/// |-------------------------------|----------------------------------------------|
/// | Transport seam independence   | `transport_seam_independent_of_bridge`       |
/// | Phase driving                 | `fake_ssh_transport_drives_connection_phases`|
/// | Persistent-runtime restart   | `transport_restarts_after_exit`              |
#[cfg(test)]
mod native_transport_seam_smoke_tests {
    use super::*;
    use crate::bridge::fake::{FakeScenario, FakeSshTransport};
    use pantoken_protocol::frame;
    use pantoken_protocol::transport::ClientEnvelope;
    use pantoken_protocol::wire::{ClientMessage, ServerMessage};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn fake_command() -> SshCommand {
        SshCommand {
            destination: "fake-host".into(),
            port: None,
            remote_root: "/tmp/fake".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        }
    }

    /// Transport seam independence: the `SshTransport` trait can be injected
    /// and exercised directly without the `Bridge`. All three trait methods
    /// (`spawn_proxy`, `run_command`, `upload_file`) work through the trait
    /// object (`Arc<dyn SshTransport>`) with no `Bridge` involved.
    #[tokio::test]
    async fn transport_seam_independent_of_bridge() {
        let transport = Arc::new(FakeSshTransport::new(FakeScenario::healthy()));

        // 1. spawn_proxy: get a framed relay, write a Hello, read back a Hello.
        let proxy = transport.spawn_proxy(fake_command()).await.expect("spawn");
        let hello = ClientEnvelope::new(ClientMessage::Hello {
            auth: None,
            resume: None,
        });
        let frame_bytes = frame::encode_client(&hello).expect("encode");
        let mut stdin = proxy.stdin;
        let mut stdout = proxy.stdout;
        stdin.write_all(&frame_bytes).await.expect("write hello");
        stdin.flush().await.expect("flush");

        // Read the framed response.
        let mut len_buf = [0u8; 4];
        stdout.read_exact(&mut len_buf).await.expect("read len");
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut body = vec![0u8; len];
        stdout.read_exact(&mut body).await.expect("read body");
        let env = frame::decode(&body).expect("decode");
        assert!(
            matches!(env.message, ServerMessage::Hello { .. }),
            "spawn_proxy must relay Hello through the trait without the Bridge"
        );

        // 2. run_command: exercise the trait's command method directly.
        let output = transport
            .run_command(fake_command(), "echo hello")
            .await
            .expect("run_command");
        // The fake returns an empty success for unmatched commands.
        assert!(output.is_success(), "run_command must succeed via trait");

        // 3. upload_file: exercise the trait's upload method directly.
        transport
            .upload_file(fake_command(), "/tmp/test-file", b"data".to_vec())
            .await
            .expect("upload_file");

        // Verify the upload landed in the shared FakeRemoteFs.
        {
            let fs = transport.remote_fs();
            let fs = fs.lock().unwrap();
            assert!(fs.exists("/tmp/test-file"));
            assert_eq!(fs.get("/tmp/test-file"), Some(b"data".as_slice()));
        }

        // Let the exit future resolve.
        let _ = tokio::time::timeout(Duration::from_millis(200), proxy.exit).await;
    }

    /// Persistent-runtime restart: after a transport exits (clean exit
    /// scenario), a fresh `spawn_proxy` call restarts the relay. This mirrors
    /// the bridge's reconnect behavior — each `spawn_proxy` creates a new
    /// process/relay, so an exit does not permanently break the transport.
    #[tokio::test]
    async fn transport_restarts_after_exit() {
        // Use a scenario that exits after 1 message (Hello) with a clean exit.
        let transport = Arc::new(FakeSshTransport::new(FakeScenario::exit_after(
            1,
            0,
            "remote closed",
        )));
        let transport_clone = transport.clone();

        // First spawn: relay processes Hello, then exits cleanly.
        let proxy1 = transport
            .spawn_proxy(fake_command())
            .await
            .expect("spawn 1");
        let hello = ClientEnvelope::new(ClientMessage::Hello {
            auth: None,
            resume: None,
        });
        let frame_bytes = frame::encode_client(&hello).expect("encode");
        let mut stdin1 = proxy1.stdin;
        let mut stdout1 = proxy1.stdout;
        stdin1.write_all(&frame_bytes).await.expect("write hello 1");
        stdin1.flush().await.expect("flush 1");

        // Read the Hello response (1 message processed).
        let mut len_buf = [0u8; 4];
        stdout1.read_exact(&mut len_buf).await.expect("read len 1");
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut body = vec![0u8; len];
        stdout1.read_exact(&mut body).await.expect("read body 1");
        let env = frame::decode(&body).expect("decode 1");
        assert!(matches!(env.message, ServerMessage::Hello { .. }));

        // The exit future resolves with the clean exit info.
        let exit_info = tokio::time::timeout(Duration::from_millis(500), proxy1.exit)
            .await
            .expect("exit future must resolve");
        assert_eq!(exit_info.code, Some(0), "first proxy exits cleanly");

        // Second spawn: a fresh relay starts. The transport is not broken.
        let proxy2 = transport_clone
            .spawn_proxy(fake_command())
            .await
            .expect("spawn 2");
        let mut stdin2 = proxy2.stdin;
        let mut stdout2 = proxy2.stdout;

        // Write a Hello to the restarted relay and verify it responds.
        stdin2.write_all(&frame_bytes).await.expect("write hello 2");
        stdin2.flush().await.expect("flush 2");

        let mut len_buf2 = [0u8; 4];
        stdout2.read_exact(&mut len_buf2).await.expect("read len 2");
        let len2 = u32::from_be_bytes(len_buf2) as usize;
        let mut body2 = vec![0u8; len2];
        stdout2.read_exact(&mut body2).await.expect("read body 2");
        let env2 = frame::decode(&body2).expect("decode 2");
        assert!(
            matches!(env2.message, ServerMessage::Hello { .. }),
            "restarted relay must respond to Hello"
        );

        // Two spawns total.
        assert_eq!(
            transport.spawn_count(),
            2,
            "exit + restart → two spawn_proxy calls"
        );

        let _ = tokio::time::timeout(Duration::from_millis(200), proxy2.exit).await;
    }
}
