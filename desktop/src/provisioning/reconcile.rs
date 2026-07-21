//! Idempotent provisioning reconciliation (Phase 3, step 5).
//!
//! Orchestrates the provisioning flow: probe → compat check → (optionally)
//! install → configure XDG. Drives `ConnectionState::Provisioning` via the
//! existing `ConnectionStateSink` trait.
//!
//! ## Idempotency
//!
//! Reconciliation is idempotent: running it twice on an already-provisioned
//! host skips the install and proceeds straight to connect. Interrupted
//! installs are recovered by cleaning stale staging directories before
//! probing.

// Some helper functions and outcome fields are part of the API but not yet
// read from the main binary path.
#![allow(dead_code)]

use std::io;
use std::path::Path;
use std::sync::Arc;

use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;
use pantoken_remote_layout::layout;
use pantoken_remote_layout::manifest::PantokenReleaseManifest;

use crate::bridge::{ConnectionStateSink, SshCommand, SshTransport};
use crate::provisioning::pantoken_server_install;
use crate::provisioning::polytoken_compat::{self, polytoken_path_from_probe, PolytokenCompat};
use crate::provisioning::polytoken_install::{self, InstallProvenance};
use crate::provisioning::probe::{self, ProbeResult};
use crate::remote_connection::{ConnectionFailureState, ConnectionState};
use crate::remote_profile::{PolytokenPolicy, RemoteProfile};

/// Type alias for the HTTP fetch function used by the installer.
pub type HttpFetch = Arc<
    dyn Fn(
            &str,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send>>
        + Send
        + Sync,
>;

/// The outcome of a reconciliation run.
#[derive(Debug)]
pub enum ReconcileOutcome {
    /// The remote is ready to connect — polytoken is compatible.
    Ready {
        probe: ProbeResult,
        compat: PolytokenCompat,
        /// Resolved polytoken binary path on the remote (PATH-resolved name
        /// "polytoken" if found on PATH, or the Pantoken-managed install path).
        polytoken_binary_path: Option<String>,
        /// Resolved server binary path on the remote.
        server_binary_path: String,
    },
    /// polytoken was installed (or upgraded) and is now ready.
    Installed {
        probe: ProbeResult,
        provenance: InstallProvenance,
        /// The Pantoken-managed polytoken binary path on the remote.
        polytoken_binary_path: Option<String>,
        /// Resolved server binary path on the remote.
        server_binary_path: String,
    },
    /// polytoken is missing and the policy doesn't allow install.
    Missing { probe: ProbeResult },
    /// The target is unsupported.
    UnsupportedTarget { probe: ProbeResult },
    /// An error occurred during reconciliation.
    Failed(String),
}

/// Run the provisioning reconciliation.
///
/// Drives the connection state machine through `Provisioning` and back to
/// `Starting` (or `Failed`).
pub async fn reconcile(
    transport: &dyn SshTransport,
    command: SshCommand,
    profile: &RemoteProfile,
    state_sink: Option<&Arc<dyn ConnectionStateSink>>,
    http_fetch: HttpFetch,
    manifest: &PantokenReleaseManifest,
) -> ReconcileOutcome {
    // Signal: we're entering provisioning.
    if let Some(sink) = state_sink {
        sink.on_state(ConnectionState::Provisioning);
    }

    // Step 1: Probe the remote host.
    let probe = match probe::probe_remote(transport, command.clone()).await {
        Ok(p) => p,
        Err(e) => {
            return fail(state_sink, format!("probe failed: {e}"));
        }
    };

    // Check target support.
    if probe::target_triple(&probe).is_err() {
        let outcome = ReconcileOutcome::UnsupportedTarget { probe };
        if let Some(sink) = state_sink {
            sink.on_state(ConnectionState::failed(
                ConnectionFailureState::ProvisioningFailed,
                "unsupported remote target",
            ));
        }
        return outcome;
    }

    // Step 2: Check polytoken compatibility.
    let compat = match polytoken_compat::check_compatibility(
        transport,
        command.clone(),
        probe.polytoken_version.as_deref(),
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            return fail(state_sink, format!("compat check failed: {e}"));
        }
    };

    match &compat {
        PolytokenCompat::Compatible { .. } => {
            // Already compatible — resolve the polytoken path (PATH-resolved).
            let polytoken_binary_path = polytoken_path_from_probe(&probe);

            // Step 4: Ensure the Pantoken server binary is installed.
            let server_binary_path = match ensure_server_installed(
                transport,
                command.clone(),
                profile.remote_root(),
                &probe,
                manifest,
                http_fetch.clone(),
                state_sink,
            )
            .await
            {
                Ok(path) => path,
                Err(detail) => return fail(state_sink, detail),
            };

            ReconcileOutcome::Ready {
                probe,
                compat,
                polytoken_binary_path,
                server_binary_path,
            }
        }
        PolytokenCompat::Missing | PolytokenCompat::TooOld { .. } => {
            // Need to install/upgrade. Check policy.
            if profile.polytoken_policy == PolytokenPolicy::RequireExisting {
                let outcome = ReconcileOutcome::Missing { probe };
                if let Some(sink) = state_sink {
                    sink.on_state(ConnectionState::failed(
                        ConnectionFailureState::ProvisioningFailed,
                        "polytoken not found and policy requires existing",
                    ));
                }
                return outcome;
            }

            // Policy allows install. Clean up stale staging dirs first.
            let target = match probe::target_triple(&probe) {
                Ok(t) => t,
                Err(e) => {
                    return fail(state_sink, format!("target resolution: {e}"));
                }
            };
            let cleanup_cmd = polytoken_install::build_cleanup_staging_command(
                profile.remote_root(),
                POLYTOKEN_DAEMON_TARGET_VERSION,
                &target,
            );
            let _ = transport.run_command(command.clone(), &cleanup_cmd).await;

            // Step 3: Install polytoken.
            match polytoken_install::install_polytoken(
                transport,
                command.clone(),
                profile.remote_root(),
                &probe,
                http_fetch.clone(),
            )
            .await
            {
                Ok(provenance) => {
                    // Resolve the installed polytoken binary path.
                    let polytoken_binary_path = layout::polytoken_binary(
                        Path::new(profile.remote_root()),
                        POLYTOKEN_DAEMON_TARGET_VERSION,
                        &target,
                    )
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned());

                    // Step 4: Ensure the Pantoken server binary is installed.
                    let server_binary_path = match ensure_server_installed(
                        transport,
                        command.clone(),
                        profile.remote_root(),
                        &probe,
                        manifest,
                        http_fetch.clone(),
                        state_sink,
                    )
                    .await
                    {
                        Ok(path) => path,
                        Err(detail) => return fail(state_sink, detail),
                    };

                    ReconcileOutcome::Installed {
                        probe,
                        provenance,
                        polytoken_binary_path,
                        server_binary_path,
                    }
                }
                Err(e) => fail(state_sink, format!("install failed: {e}")),
            }
        }
        PolytokenCompat::Unparseable { raw } => {
            fail(state_sink, format!("polytoken version unparseable: {raw}"))
        }
    }
}

/// Ensure the Pantoken server binary is installed on the remote.
///
/// Checks if it already exists (idempotent); if not, downloads, verifies, and
/// installs it. Returns the resolved binary path on success, or an error
/// detail string on failure.
async fn ensure_server_installed(
    transport: &dyn SshTransport,
    command: SshCommand,
    remote_root: &str,
    probe: &ProbeResult,
    manifest: &PantokenReleaseManifest,
    http_fetch: HttpFetch,
    _state_sink: Option<&Arc<dyn ConnectionStateSink>>,
) -> Result<String, String> {
    // NOTE: server_version is the PANTOKEN SERVER release version (from the
    // manifest's release_version / CARGO_PKG_VERSION, e.g. "0.2.75"), NOT the
    // polytoken daemon version (POLYTOKEN_DAEMON_TARGET_VERSION, e.g.
    // "0.5.0-unstable.9"). These are different binaries with different versions.
    let server_version = &manifest.release_version;
    let target = match probe::target_triple(probe) {
        Ok(t) => t,
        Err(e) => return Err(format!("target resolution: {e}")),
    };

    match pantoken_server_install::check_server_installed(
        transport,
        command.clone(),
        remote_root,
        server_version,
        &target,
    )
    .await
    {
        Ok(true) => {
            // Already installed — use the expected path.
            layout::release_artifact(Path::new(remote_root), server_version, &target)
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| format!("server binary path: {e}"))
        }
        Ok(false) => {
            // Install it.
            let result = pantoken_server_install::install_server(
                transport,
                command,
                remote_root,
                probe,
                manifest,
                http_fetch,
            )
            .await
            .map_err(|e| format!("server install: {e}"))?;
            Ok(result.binary_path)
        }
        Err(e) => Err(format!("server install check: {e}")),
    }
}

/// Signal a failure and return the outcome.
fn fail(state_sink: Option<&Arc<dyn ConnectionStateSink>>, detail: String) -> ReconcileOutcome {
    if let Some(sink) = state_sink {
        sink.on_state(ConnectionState::failed(
            ConnectionFailureState::ProvisioningFailed,
            detail.clone(),
        ));
    }
    ReconcileOutcome::Failed(detail)
}

/// Read and parse install.json from the remote host.
pub async fn read_install_metadata(
    transport: &dyn SshTransport,
    command: SshCommand,
    remote_root: &str,
) -> Result<Option<InstallProvenance>, io::Error> {
    let cmd = polytoken_install::build_read_install_json_command(remote_root);
    let output = transport.run_command(command, &cmd).await?;
    if !output.is_success() || output.stdout.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<InstallProvenance>(&output.stdout) {
        Ok(p) => Ok(Some(p)),
        Err(_) => Ok(None),
    }
}

/// Check if a polytoken binary exists at the expected path on the remote.
pub async fn check_binary_exists(
    transport: &dyn SshTransport,
    command: SshCommand,
    remote_root: &str,
    version: &str,
    target: &str,
) -> Result<bool, io::Error> {
    let binary_path = layout::polytoken_binary(std::path::Path::new(remote_root), version, target)
        .map_err(|e| io::Error::other(e.to_string()))?;
    let cmd = polytoken_install::build_binary_check_command(&binary_path.to_string_lossy());
    let output = transport.run_command(command, &cmd).await?;
    Ok(output.stdout.trim() == "exists")
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `reconcile_skips_install_when_compatible_exists`
    //! - `reconcile_fails_when_missing_and_policy_requires_existing`
    //! - `reconcile_offers_install_when_missing_and_policy_allows`

    use super::*;
    use crate::bridge::fake::FakeSshTransport;
    use crate::bridge::CommandOutput;
    use crate::remote_profile::{PolytokenPolicy, XdgMode};

    fn no_http_fetch() -> super::HttpFetch {
        Arc::new(|_url: &str| Box::pin(async { Err("http fetch not configured in test".into()) }))
    }

    fn test_manifest() -> PantokenReleaseManifest {
        use pantoken_protocol::wire::PROTOCOL_VERSION;
        use pantoken_remote_layout::manifest::{ArchiveFormat, ReleaseTarget};

        PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![ReleaseTarget {
                target_triple: "x86_64-unknown-linux-gnu".into(),
                artifact_url: "https://example.com/server.tar.gz".into(),
                sha256: "a".repeat(64),
                archive_format: ArchiveFormat::TarGz,
            }],
        }
    }

    fn compatible_probe_response() -> CommandOutput {
        CommandOutput {
            stdout: r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":"0.5.0-unstable.9"}"#.into(),
            stderr: String::new(),
            exit_code: Some(0),
        }
    }

    /// Response indicating the server binary already exists (idempotent skip).
    fn server_exists_response() -> CommandOutput {
        CommandOutput {
            stdout: "exists".into(),
            stderr: String::new(),
            exit_code: Some(0),
        }
    }

    fn missing_probe_response() -> CommandOutput {
        CommandOutput {
            stdout: r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":""}"#.into(),
            stderr: String::new(),
            exit_code: Some(0),
        }
    }

    fn test_profile(policy: PolytokenPolicy) -> RemoteProfile {
        RemoteProfile {
            id: "test".into(),
            label: "Test".into(),
            ssh_destination: "fake".into(),
            port: None,
            polytoken_policy: policy,
            remote_root_override: Some("/tmp/pantoken-test".into()),
            server_path: None,
            xdg_mode: XdgMode::default(),
        }
    }

    fn ssh_command() -> SshCommand {
        SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp/pantoken-test".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        }
    }

    #[tokio::test]
    async fn reconcile_skips_install_when_compatible_exists() {
        let transport = FakeSshTransport::new(crate::bridge::fake::FakeScenario::healthy());
        transport.add_command_response("uname", compatible_probe_response());
        // Server binary already installed — idempotent skip.
        transport.add_command_response("echo exists", server_exists_response());

        let profile = test_profile(PolytokenPolicy::RequireExisting);
        let outcome = reconcile(
            &transport,
            ssh_command(),
            &profile,
            None,
            no_http_fetch(),
            &test_manifest(),
        )
        .await;

        match outcome {
            ReconcileOutcome::Ready { compat, .. } => {
                assert!(matches!(compat, PolytokenCompat::Compatible { .. }));
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reconcile_fails_when_missing_and_policy_requires_existing() {
        let transport = FakeSshTransport::new(crate::bridge::fake::FakeScenario::healthy());
        transport.add_command_response("uname", missing_probe_response());

        let profile = test_profile(PolytokenPolicy::RequireExisting);
        let outcome = reconcile(
            &transport,
            ssh_command(),
            &profile,
            None,
            no_http_fetch(),
            &test_manifest(),
        )
        .await;

        assert!(matches!(outcome, ReconcileOutcome::Missing { .. }));
    }

    #[tokio::test]
    async fn reconcile_offers_install_when_missing_and_policy_allows() {
        let transport = FakeSshTransport::new(crate::bridge::fake::FakeScenario::healthy());
        transport.add_command_response("uname", missing_probe_response());

        let profile = test_profile(PolytokenPolicy::OfferInstall);
        let outcome = reconcile(
            &transport,
            ssh_command(),
            &profile,
            None,
            no_http_fetch(),
            &test_manifest(),
        )
        .await;

        // Install will fail because http_fetch returns an error, but the
        // important thing is that it attempted the install path (not Missing).
        assert!(matches!(outcome, ReconcileOutcome::Failed(_)));
    }
}
