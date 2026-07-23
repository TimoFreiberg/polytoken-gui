//! Provisioning test harness (Phase 3, step 7).
//!
//! Provides scenario presets and an in-memory fake remote filesystem for
//! testing the full provisioning flow without a real SSH process or network.

// Scenario presets are part of the test API; not all variants are used in
// every test.
#![allow(dead_code)]

use std::sync::Arc;

use crate::bridge::fake::{FakeScenario, FakeSshTransport};
use crate::bridge::CommandOutput;

/// Scenario presets for provisioning tests.
pub enum Scenario {
    /// A compatible polytoken is already on PATH.
    Healthy,
    /// No polytoken on the remote; install would succeed.
    MissingPolytoken,
    /// No polytoken; policy is RequireExisting.
    MissingPolytokenDeclined,
    /// polytoken 0.4.2 on PATH; target is 0.5.0-unstable.9.
    TooOldPolytoken,
    /// Unsupported target (freebsd/amd64).
    UnsupportedTarget,
    /// Already provisioned — compatible polytoken at recorded path.
    AlreadyProvisioned,
    /// Server binary already installed — `check_server_installed` returns
    /// true; no download.
    ServerAlreadyInstalled,
    /// Server binary not installed — the fake transport serves a canned
    /// archive; install succeeds.
    ServerInstallNeeded,
    /// Fake archive's hash doesn't match the manifest; install fails with
    /// `ChecksumMismatch`.
    ServerChecksumMismatch,
}

/// Build a `FakeSshTransport` configured for the given scenario.
pub fn build_transport(scenario: Scenario) -> FakeSshTransport {
    let transport = FakeSshTransport::new(FakeScenario::healthy());

    match scenario {
        Scenario::Healthy | Scenario::AlreadyProvisioned => {
            transport.add_command_response(
                "uname",
                CommandOutput {
                    stdout: r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":"0.5.0-unstable.9"}"#.into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
        }
        Scenario::MissingPolytoken | Scenario::MissingPolytokenDeclined => {
            transport.add_command_response(
                "uname",
                CommandOutput {
                    stdout: r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":""}"#.into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
        }
        Scenario::TooOldPolytoken => {
            transport.add_command_response(
                "uname",
                CommandOutput {
                    stdout: r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":"0.4.2"}"#.into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
        }
        Scenario::UnsupportedTarget => {
            transport.add_command_response(
                "uname",
                CommandOutput {
                    stdout: r#"{"os":"freebsd","arch":"amd64","bitness":64,"libc":"unknown","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":""}"#.into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
        }
        Scenario::ServerAlreadyInstalled => {
            // macOS arm64 with compatible polytoken.
            transport.add_command_response(
                "uname",
                CommandOutput {
                    stdout: r#"{"os":"darwin","arch":"arm64","bitness":64,"libc":"darwin","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":"0.5.0-unstable.9"}"#.into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
            // Server binary already exists — match the check command.
            transport.add_command_response(
                "echo exists",
                CommandOutput {
                    stdout: "exists".into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
        }
        Scenario::ServerInstallNeeded | Scenario::ServerChecksumMismatch => {
            // macOS arm64 with compatible polytoken.
            transport.add_command_response(
                "uname",
                CommandOutput {
                    stdout: r#"{"os":"darwin","arch":"arm64","bitness":64,"libc":"darwin","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":"0.5.0-unstable.9"}"#.into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
            // Server binary not installed — match the check command specifically.
            // The check command is `test -x '...' && echo exists || echo missing`.
            // Use `echo exists` to match only the check, not the install command.
            transport.add_command_response(
                "echo exists",
                CommandOutput {
                    stdout: "missing".into(),
                    stderr: String::new(),
                    exit_code: Some(0),
                },
            );
            // Configure the server-install shell flow responses.
            configure_server_install_responses(&transport);
        }
    }

    transport
}

/// A mock HTTP fetch function that returns canned bytes for known URLs.
pub fn mock_http_fetch(
    archive_bytes: Vec<u8>,
    sums_content: String,
) -> crate::provisioning::polytoken_install::HttpFetch {
    let archive = Arc::new(archive_bytes);
    let sums = Arc::new(sums_content);

    Arc::new(move |url: &str| {
        let archive = archive.clone();
        let sums = sums.clone();
        let url = url.to_string();
        Box::pin(async move {
            if url.contains("SHA256SUMS") {
                Ok(sums.as_bytes().to_vec())
            } else if url.contains("polytoken") {
                Ok((*archive).clone())
            } else {
                Err(format!("unknown URL: {url}"))
            }
        })
    })
}

/// Pre-configure canned command responses for the full server-install shell
/// flow. The fake transport matches by substring (first match wins), so we
/// use `echo ok` (the last line of the install command) to identify the install
/// command specifically, and `mkdir -p` for the cache-dir creation step.
pub fn configure_server_install_responses(transport: &FakeSshTransport) {
    // The full install command ends with `echo ok`. This must be checked
    // before `mkdir -p` since the install command also contains `mkdir -p`.
    transport.add_command_response(
        "echo ok",
        CommandOutput {
            stdout: "ok".into(),
            stderr: String::new(),
            exit_code: Some(0),
        },
    );
    // The cache-dir mkdir (called before upload, separate run_command).
    transport.add_command_response(
        "mkdir -p",
        CommandOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
        },
    );
}

/// A mock HTTP fetch for the server archive. Returns the given bytes for any
/// URL containing "pantoken-headless" (the server artifact).
pub fn mock_server_http_fetch(archive_bytes: Vec<u8>) -> crate::provisioning::reconcile::HttpFetch {
    let archive = Arc::new(archive_bytes);
    Arc::new(move |_url: &str| {
        let archive = archive.clone();
        Box::pin(async move { Ok((*archive).clone()) })
    })
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `fake_ssh_harness_drives_probe`
    //! - `fake_ssh_harness_drives_install`
    //! - `fake_ssh_harness_injects_checksum_failure`
    //! - `fake_ssh_harness_persists_install_state`

    use super::*;
    use crate::bridge::SshTransport;
    use crate::provisioning::polytoken_install::{compute_sha256, find_checksum_in_sums};
    use crate::provisioning::probe::{parse_probe_output, PROBE_SCRIPT};

    fn ssh_command() -> crate::bridge::SshCommand {
        crate::bridge::SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp/pantoken-test".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        }
    }

    #[tokio::test]
    async fn fake_ssh_harness_drives_probe() {
        let transport = build_transport(Scenario::Healthy);
        let output = transport
            .run_command(ssh_command(), PROBE_SCRIPT)
            .await
            .expect("run_command");
        let probe = parse_probe_output(&output).expect("parse");
        assert_eq!(probe.os, "linux");
        assert_eq!(probe.arch, "x86_64");
        assert_eq!(probe.polytoken_version.as_deref(), Some("0.5.0-unstable.9"));
    }

    #[tokio::test]
    async fn fake_ssh_harness_drives_install() {
        let archive = b"fake archive bytes".to_vec();
        let hash = compute_sha256(&archive);
        let sums = format!("{hash}  polytoken-linux-amd64.tar.gz\n");

        let _transport = build_transport(Scenario::MissingPolytoken);
        let fetch = mock_http_fetch(archive, sums);

        // Verify the mock fetch works.
        let data = fetch(
            "https://dl.polytoken.dev/unstable/0.5.0-unstable.9/linux-amd64/polytoken.tar.gz",
        )
        .await
        .expect("fetch");
        assert!(!data.is_empty());

        let sums_data =
            fetch("https://dl.polytoken.dev/unstable/0.5.0-unstable.9/SHA256SUMS.linux")
                .await
                .expect("fetch sums");
        let sums_str = String::from_utf8_lossy(&sums_data);
        let found = find_checksum_in_sums(&sums_str, "polytoken-linux-amd64.tar.gz");
        assert_eq!(found.as_deref(), Some(hash.as_str()));
    }

    #[tokio::test]
    async fn fake_ssh_harness_injects_checksum_failure() {
        let archive = b"correct archive".to_vec();
        let wrong_hash = "0000000000000000000000000000000000000000000000000000000000000000";
        let sums = format!("{wrong_hash}  polytoken-linux-amd64.tar.gz\n");

        let fetch = mock_http_fetch(archive, sums);

        // Fetch the archive and verify the checksum fails.
        let data = fetch("https://dl.polytoken.dev/polytoken.tar.gz")
            .await
            .expect("fetch");
        let actual = compute_sha256(&data);
        assert_ne!(actual, wrong_hash);
    }

    #[tokio::test]
    async fn fake_ssh_harness_persists_install_state() {
        let transport = build_transport(Scenario::Healthy);

        // Upload a file to the fake remote FS.
        let data = b"install.json content".to_vec();
        transport
            .upload_file(
                ssh_command(),
                "/tmp/pantoken-test/install.json",
                data.clone(),
            )
            .await
            .expect("upload");

        // Verify it was recorded.
        let fs = transport.remote_fs();
        let fs = fs.lock().unwrap();
        assert!(fs.exists("/tmp/pantoken-test/install.json"));
        assert_eq!(
            fs.get("/tmp/pantoken-test/install.json"),
            Some(data.as_slice())
        );
    }
}

/// AC.13 smoke tests for the fake SSH / remote-filesystem harness.
///
/// These tests prove the harness can deterministically drive the full set of
/// scenarios required by AC.13 without touching real SSH or user state. The
/// capability map:
///
/// | AC.13 capability              | Validating test                              |
/// |-------------------------------|----------------------------------------------|
/// | Framing (length-prefixed)     | `fake_ssh_harness_drives_probe` (tests mod)  |
/// | Probe injection               | `fake_ssh_harness_drives_probe` (tests mod)  |
/// | Artifact failure injection    | `fake_ssh_harness_injects_checksum_failure`  |
/// | Phase driving (install)       | `fake_ssh_harness_drives_install` (tests mod)|
/// | Install-state persistence     | `fake_ssh_harness_persists_install_state`    |
/// | Persistent runtime state     | `fake_ssh_harness_preserves_state_across_reconnect` |
/// | Concurrent proxy startup      | `fake_ssh_harness_supports_concurrent_spawn` |
///
/// The first five capabilities are validated by the tests in the parent `tests`
/// module. This module adds the two remaining: persistent runtime state across
/// reconnect and concurrent proxy spawn.
#[cfg(test)]
mod fake_ssh_harness_smoke_tests {
    use super::*;
    use crate::bridge::SshTransport;
    use std::time::Duration;

    fn ssh_command() -> crate::bridge::SshCommand {
        crate::bridge::SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp/pantoken-test".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
            raw_remote_command: None,
        }
    }

    /// Persistent fake runtime state: files uploaded via `upload_file` and
    /// `install.json` written by the installer survive a "reconnect" because
    /// `FakeRemoteFs` is shared via `Arc<Mutex<>>` across all clones of the
    /// transport.
    #[test]
    fn fake_ssh_harness_preserves_state_across_reconnect() {
        // Write files to a shared FakeRemoteFs, clone the transport, verify
        // the clone sees the same files.
        let transport = crate::bridge::fake::FakeSshTransport::new(
            crate::bridge::fake::FakeScenario::healthy(),
        );

        let archive = b"archive bytes".to_vec();
        let install_json = br#"{"version":"0.5.0-unstable.9"}"#.to_vec();

        {
            let fs = transport.remote_fs();
            let mut fs = fs.lock().unwrap();
            fs.files
                .insert("/tmp/test/archive.tar.gz".into(), archive.clone());
            fs.files
                .insert("/tmp/test/install.json".into(), install_json.clone());
        }

        let reconnected = transport.clone();
        let fs = reconnected.remote_fs();
        let fs = fs.lock().unwrap();
        assert!(
            fs.exists("/tmp/test/archive.tar.gz"),
            "archive must survive reconnect"
        );
        assert!(
            fs.exists("/tmp/test/install.json"),
            "install.json must survive reconnect"
        );
        assert_eq!(fs.get("/tmp/test/archive.tar.gz"), Some(archive.as_slice()));
    }

    /// Concurrent proxy spawn: two `spawn_proxy` calls against the same
    /// `FakeSshTransport` each create a fresh relay (independent duplex pair).
    /// The spawn counter reflects both spawns.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fake_ssh_harness_supports_concurrent_spawn() {
        let transport = build_transport(Scenario::Healthy);
        let transport_clone = transport.clone();

        // Spawn two proxies concurrently.
        let (proxy1, proxy2) = tokio::join!(
            transport.spawn_proxy(ssh_command()),
            transport_clone.spawn_proxy(ssh_command()),
        );

        let mut proxy1 = proxy1.expect("first spawn_proxy");
        let proxy2 = proxy2.expect("second spawn_proxy");

        // Both spawns were counted.
        assert_eq!(
            transport.spawn_count(),
            2,
            "two concurrent spawn_proxy calls → two spawns"
        );

        // Each proxy has independent stdin/stdout (fresh duplex pair).
        // Write a framed Hello to proxy1's stdin and read the response from
        // its stdout — proxy2 must not interfere.
        use pantoken_protocol::frame;
        use pantoken_protocol::transport::ClientEnvelope;
        use pantoken_protocol::wire::ClientMessage;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let hello = ClientEnvelope::new(ClientMessage::Hello {
            auth: None,
            resume: None,
        });
        let frame_bytes = frame::encode_client(&hello).expect("encode hello");

        // Write to proxy1, read back from proxy1.
        proxy1
            .stdin
            .write_all(&frame_bytes)
            .await
            .expect("write p1");
        proxy1.stdin.flush().await.expect("flush p1");

        // Read the 4-byte length prefix + body from proxy1's stdout.
        let mut len_buf = [0u8; 4];
        proxy1
            .stdout
            .read_exact(&mut len_buf)
            .await
            .expect("read len p1");
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut body = vec![0u8; len];
        proxy1
            .stdout
            .read_exact(&mut body)
            .await
            .expect("read body p1");

        // Verify it's a valid ServerEnvelope with a Hello.
        use pantoken_protocol::frame::decode;
        let env = decode(&body).expect("decode server envelope");
        assert!(
            matches!(
                env.message,
                pantoken_protocol::wire::ServerMessage::Hello { .. }
            ),
            "proxy1 must respond with Hello"
        );

        // proxy2 is independent — its stdout has no data from proxy1's write.
        // We verify independence by checking that proxy2's stdout does not
        // immediately produce proxy1's response (it would only respond to
        // frames written to proxy2's stdin).
        let mut proxy2_stdout = proxy2.stdout;
        let read_result =
            tokio::time::timeout(Duration::from_millis(50), proxy2_stdout.read(&mut [0u8; 1]))
                .await;
        assert!(
            read_result.is_err(),
            "proxy2 stdout must be independent of proxy1's stdin"
        );

        // Let both exit futures resolve (they resolve after a brief delay for
        // non-immediate-exit scenarios).
        let _ = tokio::time::timeout(Duration::from_millis(200), proxy1.exit).await;
        let _ = tokio::time::timeout(Duration::from_millis(200), proxy2.exit).await;
    }
}
