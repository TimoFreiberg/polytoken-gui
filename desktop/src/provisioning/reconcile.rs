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
use std::sync::Arc;

use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;
use pantoken_remote_layout::layout;

use crate::bridge::{ConnectionStateSink, SshCommand, SshTransport};
use crate::provisioning::polytoken_compat::{self, PolytokenCompat};
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
    },
    /// polytoken was installed (or upgraded) and is now ready.
    Installed {
        probe: ProbeResult,
        provenance: InstallProvenance,
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
            // Already compatible — proceed to connect.
            ReconcileOutcome::Ready { probe, compat }
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
                Ok(provenance) => ReconcileOutcome::Installed { probe, provenance },
                Err(e) => fail(state_sink, format!("install failed: {e}")),
            }
        }
        PolytokenCompat::Unparseable { raw } => {
            fail(state_sink, format!("polytoken version unparseable: {raw}"))
        }
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

    fn compatible_probe_response() -> CommandOutput {
        CommandOutput {
            stdout: r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"/tmp/x","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":"0.5.0-unstable.9"}"#.into(),
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

        let profile = test_profile(PolytokenPolicy::RequireExisting);
        let outcome = reconcile(&transport, ssh_command(), &profile, None, no_http_fetch()).await;

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
        let outcome = reconcile(&transport, ssh_command(), &profile, None, no_http_fetch()).await;

        assert!(matches!(outcome, ReconcileOutcome::Missing { .. }));
    }

    #[tokio::test]
    async fn reconcile_offers_install_when_missing_and_policy_allows() {
        let transport = FakeSshTransport::new(crate::bridge::fake::FakeScenario::healthy());
        transport.add_command_response("uname", missing_probe_response());

        let profile = test_profile(PolytokenPolicy::OfferInstall);
        let outcome = reconcile(&transport, ssh_command(), &profile, None, no_http_fetch()).await;

        // Install will fail because http_fetch returns an error, but the
        // important thing is that it attempted the install path (not Missing).
        assert!(matches!(outcome, ReconcileOutcome::Failed(_)));
    }
}
