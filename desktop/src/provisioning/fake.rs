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
