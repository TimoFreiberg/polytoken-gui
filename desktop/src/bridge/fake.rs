//! Fake SSH transport for testing (Phase 2, step 14).
//!
//! [`FakeSshTransport`] speaks the framed protocol over in-memory duplexes,
//! matching what the bridge sees from a real SSH proxy: framed
//! `ClientMessage` in → framed `ServerMessage` out, exit codes, stderr, and
//! delays. It does NOT simulate the remote-runtime's internal identity probe
//! (that happens inside the remote `pantoken-server` process — already tested
//! in `server-rs`).
//!
//! The fake is configurable to drive each connection phase deterministically:
//! - Respond to `Hello` with a configurable `Hello` (success path).
//! - Exit after N messages with a specific code + stderr (failure injection).
//! - Delay before the first frame (slow SSH handshake).
//! - Fail immediately with auth / host-key / unreachable / clean-exit
//!   classifications (see [`FakeExitScenario`]).
//
// dead_code: scenario builders + helpers are exercised by integration tests;
// not all paths fire in every test.
#![allow(dead_code)]

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pantoken_protocol::frame::{self, FrameDecoder};
use pantoken_protocol::transport::{ClientEnvelope, ServerEnvelope};
use pantoken_protocol::wire::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;

use crate::bridge::{CommandOutput, ExitInfo, SshCommand, SshProxy, SshTransport};

/// A configurable scenario for the fake transport.
#[derive(Clone, Debug)]
pub struct FakeScenario {
    /// How many inbound client messages to accept before exiting. `None` =
    /// never exit (the relay runs until the streams drop). `Some(0)` = exit
    /// immediately on spawn (before any frame).
    pub exit_after_messages: Option<usize>,
    /// The exit info to report when `exit_after_messages` is hit.
    pub exit_info: ExitInfo,
    /// Delay before the first frame is sent (simulates a slow SSH handshake).
    pub startup_delay: Duration,
    /// The server label to send in the Hello response.
    pub server_label: String,
    /// The data dir to send in the Hello response.
    pub data_dir: String,
}

impl Default for FakeScenario {
    fn default() -> Self {
        Self {
            exit_after_messages: None,
            exit_info: ExitInfo {
                code: Some(0),
                signal: None,
                stderr: String::new(),
            },
            startup_delay: Duration::ZERO,
            server_label: "fake-remote".into(),
            data_dir: "/tmp/fake-remote".into(),
        }
    }
}

/// Pre-built failure scenarios matching the bridge's exit classification table.
impl FakeScenario {
    /// Auth failure: exit 255 + "Permission denied".
    pub fn auth_failure() -> Self {
        Self {
            exit_after_messages: Some(0),
            exit_info: ExitInfo {
                code: Some(255),
                signal: None,
                stderr: "user@host: Permission denied (publickey).".into(),
            },
            ..Default::default()
        }
    }

    /// Host-key failure: exit 255 + "Host key verification failed".
    pub fn host_key_failure() -> Self {
        Self {
            exit_after_messages: Some(0),
            exit_info: ExitInfo {
                code: Some(255),
                signal: None,
                stderr: "Host key verification failed.".into(),
            },
            ..Default::default()
        }
    }

    /// Unreachable: exit 255 + "Connection refused".
    pub fn unreachable() -> Self {
        Self {
            exit_after_messages: Some(0),
            exit_info: ExitInfo {
                code: Some(255),
                signal: None,
                stderr: "connection refused".into(),
            },
            ..Default::default()
        }
    }

    /// Clean exit: exit 0 (remote closed deliberately).
    pub fn clean_exit() -> Self {
        Self {
            exit_after_messages: Some(0),
            exit_info: ExitInfo {
                code: Some(0),
                signal: None,
                stderr: String::new(),
            },
            ..Default::default()
        }
    }

    /// A healthy relay that answers Hello + echoes Pong for each Ping, never
    /// exiting on its own.
    pub fn healthy() -> Self {
        Self::default()
    }

    /// Exit after N messages with a transient (retryable) error.
    pub fn exit_after(n: usize, code: i32, stderr: &str) -> Self {
        Self {
            exit_after_messages: Some(n),
            exit_info: ExitInfo {
                code: Some(code),
                signal: None,
                stderr: stderr.into(),
            },
            ..Default::default()
        }
    }
}

/// A fake SSH transport that drives the bridge with configurable scenarios.
///
/// Each `spawn_proxy` call clones the scenario and increments an internal
/// spawn counter (so tests can assert how many proxies the bridge spawned
/// across reconnects).
///
/// `run_command` and `upload_file` are backed by a shared command-response
/// registry and an in-memory `FakeRemoteFs`, enabling provisioning tests
/// without a real SSH process.
pub struct FakeSshTransport {
    scenario: FakeScenario,
    spawn_count: Arc<AtomicUsize>,
    /// A notify that fires on each spawn (tests can await to synchronize).
    spawn_notify: Arc<Notify>,
    /// Canned responses for `run_command`, keyed by a substring match against
    /// the remote command. The first matching entry wins.
    command_responses: Arc<Mutex<Vec<CommandResponseEntry>>>,
    /// In-memory model of the remote filesystem for host `upload_file`.
    remote_fs: Arc<Mutex<FakeRemoteFs>>,
    /// Exact remote stdin commands and their byte streams (Docker uploads).
    #[allow(clippy::type_complexity)]
    stdin_commands: Arc<Mutex<Vec<(String, Vec<u8>)>>>,
}

/// A canned response for a `run_command` call.
#[derive(Clone)]
pub struct CommandResponseEntry {
    /// A substring to match against the remote command. If this substring
    /// appears in the command, this response is used.
    pub match_substring: String,
    /// The canned output to return.
    pub output: CommandOutput,
}

/// In-memory model of the remote filesystem for fake SSH uploads.
#[derive(Default)]
pub struct FakeRemoteFs {
    /// Files written via `upload_file`, keyed by remote path.
    pub files: std::collections::HashMap<String, Vec<u8>>,
}

impl FakeRemoteFs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get the bytes written to a remote path, if any.
    pub fn get(&self, path: &str) -> Option<&[u8]> {
        self.files.get(path).map(|v| v.as_slice())
    }

    /// Check if a file exists at the given path.
    pub fn exists(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }
}

impl std::fmt::Debug for FakeRemoteFs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeRemoteFs")
            .field("file_count", &self.files.len())
            .finish()
    }
}

impl FakeSshTransport {
    pub fn new(scenario: FakeScenario) -> Self {
        Self {
            scenario,
            spawn_count: Arc::new(AtomicUsize::new(0)),
            spawn_notify: Arc::new(Notify::new()),
            command_responses: Arc::new(Mutex::new(Vec::new())),
            remote_fs: Arc::new(Mutex::new(FakeRemoteFs::new())),
            stdin_commands: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// How many times `spawn_proxy` was called.
    pub fn spawn_count(&self) -> usize {
        self.spawn_count.load(Ordering::SeqCst)
    }

    /// Wait for the next spawn (resolves when `spawn_proxy` is called again).
    pub async fn wait_for_spawn(&self) {
        self.spawn_notify.notified().await;
    }

    /// Add a canned response for `run_command`. The first entry whose
    /// `match_substring` appears in the remote command wins. Responses are
    /// checked in insertion order.
    pub fn add_command_response(&self, match_substring: impl Into<String>, output: CommandOutput) {
        self.command_responses
            .lock()
            .unwrap()
            .push(CommandResponseEntry {
                match_substring: match_substring.into(),
                output,
            });
    }

    /// Get a clone of the shared `FakeRemoteFs` handle for inspection in tests.
    pub fn remote_fs(&self) -> Arc<Mutex<FakeRemoteFs>> {
        self.remote_fs.clone()
    }

    #[allow(clippy::type_complexity)]
    pub fn stdin_commands(&self) -> Arc<Mutex<Vec<(String, Vec<u8>)>>> {
        self.stdin_commands.clone()
    }
}

#[cfg(test)]
impl crate::remote_executor::RemoteExecutor for FakeSshTransport {
    fn run_script(
        &self,
        script: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<CommandOutput>> + Send>>
    {
        self.run_command(
            SshCommand {
                destination: "fake".into(),
                port: None,
                remote_root: "/tmp/pantoken-test".into(),
                server_path: "pantoken-server".into(),
                extra_env: Vec::new(),
                raw_remote_command: None,
            },
            &script,
        )
    }

    fn upload(
        &self,
        destination: String,
        data: Vec<u8>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<()>> + Send>> {
        self.upload_file(
            SshCommand {
                destination: "fake".into(),
                port: None,
                remote_root: "/tmp/pantoken-test".into(),
                server_path: "pantoken-server".into(),
                extra_env: Vec::new(),
                raw_remote_command: None,
            },
            &destination,
            data,
        )
    }

    fn spawn_proxy(
        &self,
        server_path: String,
        env: Vec<(String, String)>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<SshProxy>> + Send>> {
        SshTransport::spawn_proxy(
            self,
            SshCommand {
                destination: "fake".into(),
                port: None,
                remote_root: "/tmp/pantoken-test".into(),
                server_path,
                extra_env: env,
                raw_remote_command: None,
            },
        )
    }

    fn remote_root(&self) -> &str {
        "/tmp/pantoken-test"
    }
}

impl Clone for FakeSshTransport {
    fn clone(&self) -> Self {
        // Cloning preserves the shared counters so a test can hold a clone
        // and observe spawns driven through the Arc'd transport the bridge
        // holds.
        Self {
            scenario: self.scenario.clone(),
            spawn_count: self.spawn_count.clone(),
            spawn_notify: self.spawn_notify.clone(),
            command_responses: self.command_responses.clone(),
            remote_fs: self.remote_fs.clone(),
            stdin_commands: self.stdin_commands.clone(),
        }
    }
}

impl SshTransport for FakeSshTransport {
    fn spawn_proxy(
        &self,
        _command: SshCommand,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<SshProxy>> + Send>> {
        let scenario = self.scenario.clone();
        self.spawn_count.fetch_add(1, Ordering::SeqCst);
        self.spawn_notify.notify_one();

        Box::pin(async move {
            // Duplex pair: the bridge writes framed client messages to
            // `client_write`; the handler reads them and writes framed server
            // messages to `server_write`, read back by the bridge via
            // `client_read`.
            let (client_write, mut server_read) = tokio::io::duplex(8192);
            let (mut server_write, client_read) = tokio::io::duplex(8192);

            // If the scenario exits immediately (before any frame), skip the
            // relay task entirely and resolve the exit future right away.
            let immediate_exit = matches!(scenario.exit_after_messages, Some(0));

            if !immediate_exit {
                let exit_after = scenario.exit_after_messages;
                let server_label = scenario.server_label.clone();
                let data_dir = scenario.data_dir.clone();
                let startup_delay = scenario.startup_delay;

                tokio::spawn(async move {
                    if !startup_delay.is_zero() {
                        tokio::time::sleep(startup_delay).await;
                    }
                    let mut decoder = FrameDecoder::new();
                    let mut buf = [0u8; 8192];
                    let mut messages_seen = 0usize;
                    loop {
                        match server_read.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => {
                                for body in decoder.push(&buf[..n]).into_iter().flatten() {
                                    messages_seen += 1;
                                    let response =
                                        handle_client_frame(&body, &server_label, &data_dir);
                                    if let Ok(env) = serde_json::from_slice::<ClientEnvelope>(&body)
                                    {
                                        if let ClientMessage::Hello { .. } = env.message {
                                            // Hello always gets a Hello back.
                                        }
                                    }
                                    let resp_env = ServerEnvelope::new(response);
                                    let resp_json =
                                        serde_json::to_vec(&resp_env).unwrap_or_default();
                                    let mut frame_bytes = Vec::with_capacity(4 + resp_json.len());
                                    frame_bytes
                                        .extend_from_slice(&(resp_json.len() as u32).to_be_bytes());
                                    frame_bytes.extend_from_slice(&resp_json);
                                    if server_write.write_all(&frame_bytes).await.is_err() {
                                        return;
                                    }
                                    let _ = server_write.flush().await;

                                    // Exit-after-N: drop the server side so the
                                    // bridge sees an EOF, and let the exit
                                    // future resolve with the configured info.
                                    if let Some(after) = exit_after {
                                        if messages_seen >= after {
                                            // Close the server write so the
                                            // bridge's read loop sees EOF, then
                                            // let the task exit (the exit future
                                            // resolves separately below).
                                            drop(server_write);
                                            return;
                                        }
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                });
            }

            // The exit future: resolves with the configured ExitInfo. For
            // immediate-exit scenarios, it resolves right away. For relay
            // scenarios, it resolves after the configured message count or
            // when the streams drop.
            let exit_info = scenario.exit_info.clone();
            let immediate = immediate_exit;
            let exit: std::pin::Pin<Box<dyn std::future::Future<Output = ExitInfo> + Send>> =
                Box::pin(async move {
                    if immediate {
                        return exit_info;
                    }
                    // For a never-exit scenario the exit future hangs until
                    // the bridge drops the proxy (teardown); tests that want a
                    // specific exit use exit_after_messages > 0, in which case
                    // the relay task drops the server write and the exit future
                    // resolves after a brief flush.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    exit_info
                });

            let stdin: Box<dyn AsyncWrite + Send + Unpin> = Box::new(client_write);
            let stdout: Box<dyn AsyncRead + Send + Unpin> = Box::new(client_read);
            Ok(SshProxy {
                stdin,
                stdout,
                exit,
            })
        })
    }

    fn run_command(
        &self,
        _command: SshCommand,
        remote_command: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<CommandOutput>> + Send>>
    {
        let responses = self.command_responses.lock().unwrap();
        // Find the first matching response.
        let matched = responses
            .iter()
            .find(|entry| remote_command.contains(&entry.match_substring))
            .map(|entry| entry.output.clone());
        drop(responses);

        Box::pin(async move {
            match matched {
                Some(output) => Ok(output),
                None => {
                    // Default: empty success (command ran, produced no output).
                    Ok(CommandOutput {
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: Some(0),
                    })
                }
            }
        })
    }

    fn run_command_with_stdin(
        &self,
        _command: SshCommand,
        remote_command: String,
        data: Vec<u8>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<()>> + Send>> {
        let commands = self.stdin_commands.clone();
        Box::pin(async move {
            commands.lock().unwrap().push((remote_command, data));
            Ok(())
        })
    }

    fn upload_file(
        &self,
        _command: SshCommand,
        remote_path: &str,
        data: Vec<u8>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = io::Result<()>> + Send>> {
        let remote_fs = self.remote_fs.clone();
        let path = remote_path.to_string();
        Box::pin(async move {
            remote_fs.lock().unwrap().files.insert(path, data);
            Ok(())
        })
    }
}

/// Build a `ServerMessage` in response to a framed `ClientEnvelope` body.
fn handle_client_frame(body: &[u8], server_label: &str, data_dir: &str) -> ServerMessage {
    match serde_json::from_slice::<ClientEnvelope>(body) {
        Ok(env) => match env.message {
            ClientMessage::Hello { .. } => ServerMessage::Hello {
                protocol_version: PROTOCOL_VERSION,
                server_id: "fake-remote".into(),
                server_label: server_label.into(),
                data_dir: data_dir.into(),
                build_sha: None,
            },
            ClientMessage::Ping => ServerMessage::Pong,
            // For any other client message, echo a Pong so the relay has a
            // deterministic response shape (the bridge forwards it as-is).
            _ => ServerMessage::Pong,
        },
        Err(_) => ServerMessage::Pong,
    }
}

// Avoid an unused-import warning when the `_ = frame::encode_client` path
// isn't exercised here (the fake builds frames manually to mirror the real
// transport's wire bytes).
#[allow(unused_imports)]
use frame as _frame;
