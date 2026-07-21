//! Pantoken server binary installer (Phase 3, step 3b).
//!
//! Downloads the headless release artifact **locally on the Pantoken device**,
//! verifies SHA256 against the embedded manifest, uploads over SSH, extracts the
//! `bin/pantoken-server` binary from the archive, and atomically installs it
//! into the releases directory. Never replaces a working version in place —
//! new versions install to a new version-target directory.
//!
//! ## Trust level
//!
//! Checksum-only (SHA256). No signature verification. This matches the
//! polytoken installer's trust model and is a documented constraint of the
//! release artifacts. The trust level matches [`polytoken_install`].
//!
//! ## Relationship to the embedded manifest
//!
//! The artifact URL, SHA256, and archive format all come from the
//! [`PantokenReleaseManifest`] (see [`embedded_manifest`]). The manifest is
//! validated at construction time, so the SHA256 format is guaranteed correct.
//! The actual digest is only correct in release builds (where `build.rs`
//! computed it from the real artifact); dev builds use a placeholder.
//!
//! ## Headless artifact repurposing
//!
//! The headless tar.gz contains `bin/pantoken-server` + other files
//! (`bin/pantoken-tar-validate`, `run.sh`, `update.sh`, `client-dist/`). The
//! server install only needs `bin/pantoken-server`. The extract step pulls
//! just that file via a targeted `tar xzf` (the other files are ignored).

// Several builder functions are part of the provisioning API but not yet
// called from the main binary path (only from tests). They will be wired as
// the provisioning flow matures.
#![allow(dead_code)]

use std::io;
use std::path::Path;

use pantoken_remote_layout::layout;
use pantoken_remote_layout::manifest::{
    ArchiveFormat, PantokenReleaseManifest, ReleaseTarget,
};
use serde::{Deserialize, Serialize};

use crate::bridge::{SshCommand, SshTransport};
use crate::provisioning::probe::ProbeResult;
use crate::provisioning::reconcile::HttpFetch;

/// The path to `pantoken-server` inside the headless archive.
const SERVER_BINARY_IN_ARCHIVE: &str = "bin/pantoken-server";

/// The result of a successful server install.
#[derive(Debug, Clone)]
pub struct ServerInstallResult {
    /// The installed binary path on the remote.
    pub binary_path: String,
}

/// Provenance metadata recorded in `install.json` after a successful server
/// install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInstallProvenance {
    /// The Pantoken server version that was installed.
    pub version: String,
    /// The Rust target triple.
    pub target: String,
    /// The source URL the archive was downloaded from.
    pub source_url: String,
    /// The SHA256 hash of the archive (64 lowercase hex chars).
    pub sha256: String,
    /// Unix timestamp (seconds since epoch) of the install.
    pub installed_at: String,
    /// Trust level: "checksum-only" (no signature verification).
    pub trust_level: String,
}

/// Error from the server installer.
#[derive(Debug)]
pub enum ServerInstallError {
    /// The target is not supported (no matching artifact in the manifest).
    UnsupportedTarget(String),
    /// HTTP download failed.
    Download(String),
    /// SHA256 verification failed.
    ChecksumMismatch { expected: String, actual: String },
    /// SSH transport error.
    Ssh(io::Error),
    /// Remote extraction or install command failed.
    RemoteCommand {
        exit_code: Option<i32>,
        stderr: String,
    },
}

impl std::fmt::Display for ServerInstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServerInstallError::UnsupportedTarget(t) => {
                write!(f, "unsupported target for server install: {t}")
            }
            ServerInstallError::Download(e) => write!(f, "server download failed: {e}"),
            ServerInstallError::ChecksumMismatch { expected, actual } => {
                write!(f, "server SHA256 mismatch: expected {expected}, got {actual}")
            }
            ServerInstallError::Ssh(e) => write!(f, "SSH error: {e}"),
            ServerInstallError::RemoteCommand { exit_code, stderr } => {
                write!(
                    f,
                    "remote command failed (exit {:?}): {}",
                    exit_code, stderr
                )
            }
        }
    }
}

impl std::error::Error for ServerInstallError {}

impl From<io::Error> for ServerInstallError {
    fn from(e: io::Error) -> Self {
        ServerInstallError::Ssh(e)
    }
}

/// Resolve the server artifact for a given target from the manifest.
///
/// Returns `UnsupportedTarget` if no matching target triple is found.
pub fn resolve_server_artifact<'a>(
    manifest: &'a PantokenReleaseManifest,
    target: &str,
) -> Result<&'a ReleaseTarget, ServerInstallError> {
    manifest
        .targets
        .iter()
        .find(|t| t.target_triple == target)
        .ok_or_else(|| ServerInstallError::UnsupportedTarget(target.into()))
}

/// Compute the SHA256 hash of a byte buffer.
fn compute_sha256(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Verify a downloaded archive's SHA256 against the expected hash.
fn verify_checksum(data: &[u8], expected_sha256: &str) -> Result<(), ServerInstallError> {
    let actual = compute_sha256(data);
    if actual == expected_sha256 {
        Ok(())
    } else {
        Err(ServerInstallError::ChecksumMismatch {
            expected: expected_sha256.into(),
            actual,
        })
    }
}

/// Single-quote a shell word for safe interpolation into SSH commands.
/// Wraps in `'...'` and escapes embedded single quotes as `'\''`.
fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// Build the remote extraction + atomic-install command for the server binary.
///
/// The headless archive contains `bin/pantoken-server` (a nested path), but the
/// final binary must land at `release_artifact(root, version, target)` =
/// `<root>/releases/<version>/<target>/pantoken-server` (root-level). This
/// command:
///
/// 1. Creates a staging directory (with a unique PID-suffixed name).
/// 2. Extracts only `bin/pantoken-server` from the archive into staging.
/// 3. Moves it to the staging root as `pantoken-server`.
/// 4. Verifies it's executable.
/// 5. Creates the final dir's parent, removes any stale final dir, and
///    atomic-renames staging → final dir.
/// 6. Cleans up the uploaded archive.
pub fn build_server_install_command(
    remote_root: &str,
    version: &str,
    target: &str,
    archive_path: &str,
    format: ArchiveFormat,
) -> Result<String, ServerInstallError> {
    let root = Path::new(remote_root);
    let final_dir = layout::release_artifact(root, version, target)
        .map_err(|e| ServerInstallError::UnsupportedTarget(e.to_string()))?
        .parent()
        .ok_or_else(|| ServerInstallError::UnsupportedTarget("empty parent path".into()))?
        .to_string_lossy()
        .to_string();

    // Staging is a SIBLING of final_dir, not a child — so `rm -rf final_dir`
    // doesn't delete the staging directory before the atomic rename.
    let staging_dir = format!("{final_dir}.staging-$$");
    let staging_q = shell_quote(&staging_dir);
    let final_q = shell_quote(&final_dir);
    let archive_q = shell_quote(archive_path);

    let extract_cmd = match format {
        ArchiveFormat::TarGz => format!(
            "tar xzf {archive_q} -C {staging_q} {SERVER_BINARY_IN_ARCHIVE}"
        ),
        ArchiveFormat::Zip => format!(
            "unzip -o {archive_q} {SERVER_BINARY_IN_ARCHIVE} -d {staging_q}"
        ),
    };

    // The binary starts at <staging>/bin/pantoken-server; move it to
    // <staging>/pantoken-server so the final dir's root has the binary.
    let binary_nested = shell_quote(&format!("{staging_dir}/{SERVER_BINARY_IN_ARCHIVE}"));
    let binary_root = shell_quote(&format!("{staging_dir}/pantoken-server"));

    Ok(format!(
        "set -e; \
         mkdir -p {staging_q}; \
         {extract_cmd}; \
         chmod +x {binary_nested}; \
         test -x {binary_nested}; \
         mv {binary_nested} {binary_root}; \
         mkdir -p {final_q}; \
         rm -rf {final_q}; \
         mv {staging_q} {final_q}; \
         rm -f {archive_q}; \
         echo ok"
    ))
}

/// Build the command to check if the server binary exists at the expected path.
pub fn build_binary_check_command(binary_path: &str) -> String {
    let path_q = shell_quote(binary_path);
    format!("test -x {path_q} && echo exists || echo missing")
}

/// Build the command to write install.json for the server binary.
///
/// The provenance is written to `<remote_root>/releases/<version>/<target>/install.json`
/// (inside the release directory, alongside the binary).
pub fn build_write_install_json_command(
    remote_root: &str,
    version: &str,
    target: &str,
    provenance: &ServerInstallProvenance,
) -> Result<String, ServerInstallError> {
    let root = Path::new(remote_root);
    let install_dir = layout::release_artifact(root, version, target)
        .map_err(|e| ServerInstallError::UnsupportedTarget(e.to_string()))?
        .parent()
        .ok_or_else(|| ServerInstallError::UnsupportedTarget("empty parent path".into()))?
        .to_string_lossy()
        .to_string();
    let json_path = format!("{install_dir}/install.json");
    let json = serde_json::to_string_pretty(provenance)
        .map_err(|e| ServerInstallError::Download(format!("serialize install.json: {e}")))?;
    let json_path_q = shell_quote(&json_path);
    Ok(format!(
        "cat > {json_path_q} << 'PANTOKEN_SERVER_INSTALL_JSON_EOF'\n{json}\nPANTOKEN_SERVER_INSTALL_JSON_EOF"
    ))
}

/// Check if the server binary is already installed at the expected path.
///
/// Idempotent reconciliation: returns `true` if the binary exists and is
/// executable, `false` otherwise.
pub async fn check_server_installed(
    transport: &dyn SshTransport,
    command: SshCommand,
    remote_root: &str,
    version: &str,
    target: &str,
) -> Result<bool, ServerInstallError> {
    let binary_path =
        layout::release_artifact(Path::new(remote_root), version, target)
            .map_err(|e| ServerInstallError::UnsupportedTarget(e.to_string()))?;
    let cmd = build_binary_check_command(&binary_path.to_string_lossy());
    let output = transport.run_command(command, &cmd).await?;
    Ok(output.stdout.trim() == "exists")
}

/// The full server install flow: download, verify, upload, extract, install.
///
/// Uses the provided HTTP fetch function (injectable for testing) and the SSH
/// transport. Returns the installed binary path on success.
pub async fn install_server(
    transport: &dyn SshTransport,
    command: SshCommand,
    remote_root: &str,
    probe: &ProbeResult,
    manifest: &PantokenReleaseManifest,
    http_fetch: HttpFetch,
) -> Result<ServerInstallResult, ServerInstallError> {
    let target = crate::provisioning::probe::target_triple(probe)
        .map_err(|e| ServerInstallError::UnsupportedTarget(e.to_string()))?;

    // 1. Resolve the artifact for this target.
    let artifact = resolve_server_artifact(manifest, &target)?;
    let version = &manifest.release_version;

    // 2. Download the archive locally.
    let archive_data = http_fetch(&artifact.artifact_url)
        .await
        .map_err(ServerInstallError::Download)?;

    // 3. Verify SHA256 against the manifest.
    verify_checksum(&archive_data, &artifact.sha256)?;

    // 4. Upload the archive to the remote cache.
    let filename = artifact
        .artifact_url
        .rsplit('/')
        .next()
        .unwrap_or("pantoken-server-archive.tar.gz");
    let archive_remote_path = format!("{remote_root}/.cache/{filename}");
    let cache_dir = format!("{remote_root}/.cache");
    let mkdir_cmd = format!("mkdir -p {}", shell_quote(&cache_dir));
    let mkdir_output = transport.run_command(command.clone(), &mkdir_cmd).await?;
    if !mkdir_output.is_success() {
        return Err(ServerInstallError::RemoteCommand {
            exit_code: mkdir_output.exit_code,
            stderr: mkdir_output.stderr,
        });
    }

    transport
        .upload_file(command.clone(), &archive_remote_path, archive_data)
        .await?;

    // 5. Extract + atomic install on remote.
    let install_cmd = build_server_install_command(
        remote_root,
        version,
        &target,
        &archive_remote_path,
        artifact.archive_format.clone(),
    )?;
    let install_output = transport.run_command(command.clone(), &install_cmd).await?;
    if !install_output.is_success() || !install_output.stdout.contains("ok") {
        return Err(ServerInstallError::RemoteCommand {
            exit_code: install_output.exit_code,
            stderr: install_output.stderr,
        });
    }

    // 6. Write provenance metadata.
    let provenance = ServerInstallProvenance {
        version: version.to_string(),
        target: target.clone(),
        source_url: artifact.artifact_url.clone(),
        sha256: artifact.sha256.clone(),
        installed_at: now_timestamp(),
        trust_level: "checksum-only".into(),
    };
    let write_cmd = build_write_install_json_command(remote_root, version, &target, &provenance)?;
    let write_output = transport.run_command(command, &write_cmd).await?;
    if !write_output.is_success() {
        return Err(ServerInstallError::RemoteCommand {
            exit_code: write_output.exit_code,
            stderr: write_output.stderr,
        });
    }

    // 7. Return the installed binary path.
    let binary_path = layout::release_artifact(Path::new(remote_root), version, &target)
        .map_err(|e| ServerInstallError::UnsupportedTarget(e.to_string()))?;

    Ok(ServerInstallResult {
        binary_path: binary_path.to_string_lossy().into_owned(),
    })
}

/// Get the current time as a Unix timestamp string.
fn now_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `server_install_resolves_macos_arm64_target`
    //! - `server_install_rejects_unsupported_target`
    //! - `server_install_preserves_previous_version`
    //! - `server_install_checksum_mismatch_is_atomic`

    use super::*;
    use pantoken_protocol::wire::PROTOCOL_VERSION;
    use pantoken_remote_layout::manifest::ArchiveFormat;

    fn test_manifest() -> PantokenReleaseManifest {
        PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: Some("abc123".into()),
            targets: vec![ReleaseTarget {
                target_triple: "aarch64-apple-darwin".into(),
                artifact_url:
                    "https://github.com/TimoFreiberg/pantoken/releases/download/v0.2.75/pantoken-headless-macos-aarch64.tar.gz"
                        .into(),
                sha256: "a".repeat(64),
                archive_format: ArchiveFormat::TarGz,
            }],
        }
    }

    #[test]
    fn server_install_resolves_macos_arm64_target() {
        let manifest = test_manifest();
        let artifact = resolve_server_artifact(&manifest, "aarch64-apple-darwin")
            .expect("should resolve");
        assert_eq!(artifact.target_triple, "aarch64-apple-darwin");
        assert!(artifact.artifact_url.contains("pantoken-headless-macos-aarch64.tar.gz"));
    }

    #[test]
    fn server_install_rejects_unsupported_target() {
        let manifest = test_manifest();
        let result = resolve_server_artifact(&manifest, "x86_64-unknown-linux-gnu");
        assert!(matches!(result, Err(ServerInstallError::UnsupportedTarget(_))));
    }

    #[test]
    fn server_install_preserves_previous_version() {
        let root = "/opt/pantoken";
        let old_binary =
            layout::release_artifact(Path::new(root), "0.2.74", "aarch64-apple-darwin").unwrap();
        let new_binary =
            layout::release_artifact(Path::new(root), "0.2.75", "aarch64-apple-darwin").unwrap();

        // The paths are distinct.
        assert_ne!(old_binary, new_binary);

        // The install command for the new version doesn't reference the old.
        let cmd = build_server_install_command(
            root,
            "0.2.75",
            "aarch64-apple-darwin",
            "/tmp/archive.tar.gz",
            ArchiveFormat::TarGz,
        )
        .unwrap();
        assert!(!cmd.contains("0.2.74"));
    }

    #[test]
    fn server_install_checksum_mismatch_unit() {
        // verify_checksum returns an error on mismatch — the caller never
        // proceeds to upload, so no binary lands at the final path.
        let data = b"not the right content";
        let expected = "0".repeat(64);
        let result = verify_checksum(data, &expected);
        assert!(matches!(result, Err(ServerInstallError::ChecksumMismatch { .. })));

        // The actual hash of the data is not the expected one.
        let actual = compute_sha256(data);
        assert_ne!(actual, expected);
    }

    #[test]
    fn server_install_command_extracts_nested_binary() {
        let cmd = build_server_install_command(
            "/opt/pantoken",
            "0.2.75",
            "aarch64-apple-darwin",
            "/opt/pantoken/.cache/archive.tar.gz",
            ArchiveFormat::TarGz,
        )
        .unwrap();

        // The command must extract the nested bin/pantoken-server path.
        assert!(cmd.contains("bin/pantoken-server"));
        // It must move the nested binary to the staging root.
        assert!(cmd.contains("mv"));
        // It must do the atomic rename.
        assert!(cmd.contains("rm -rf"));
        assert!(cmd.contains("echo ok"));
    }

    // Silence unused warning for now_timestamp in test builds.
    #[test]
    fn now_timestamp_returns_nonempty() {
        assert!(!now_timestamp().is_empty());
    }

    // ── Integration tests (fake SSH transport) ──────────────────────────────

    use std::sync::Arc;

    use crate::bridge::SshCommand;
    use crate::provisioning::fake::{build_transport, Scenario};
    use crate::provisioning::probe::ProbeResult;

    fn ssh_command() -> SshCommand {
        SshCommand {
            destination: "fake".into(),
            port: None,
            remote_root: "/tmp/pantoken-test".into(),
            server_path: "pantoken-server".into(),
            extra_env: Vec::new(),
        }
    }

    fn macos_arm64_probe() -> ProbeResult {
        ProbeResult {
            os: "darwin".into(),
            arch: "arm64".into(),
            bitness: 64,
            libc: "darwin".into(),
            home_dir: "/home/user".into(),
            writable_temp: Some("/tmp/x".into()),
            tools: crate::provisioning::probe::ProbeTools {
                tar: true,
                unzip: false,
                curl: true,
                sha256sum: true,
            },
            polytoken_version: Some("0.5.0-unstable.9".into()),
        }
    }

    /// AC.4: server install is idempotent — when the binary already exists,
    /// `check_server_installed` returns true and no download occurs.
    #[tokio::test]
    async fn server_install_already_installed_skips_download() {
        let transport = build_transport(Scenario::ServerAlreadyInstalled);
        let manifest = test_manifest();

        let installed = check_server_installed(
            &transport,
            ssh_command(),
            "/tmp/pantoken-test",
            &manifest.release_version,
            "aarch64-apple-darwin",
        )
        .await
        .expect("check should not error");

        assert!(installed, "binary should already be installed");
    }

    /// AC.3: server install downloads, verifies, uploads, extracts, and
    /// installs the binary to the expected path.
    #[tokio::test]
    async fn server_install_downloads_verifies_installs() {
        let transport = build_transport(Scenario::ServerInstallNeeded);

        // Build a fake archive with a known SHA256.
        let archive_bytes = b"fake headless archive with bin/pantoken-server".to_vec();
        let actual_hash = compute_sha256(&archive_bytes);

        // Build a manifest with the correct hash.
        let manifest = PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![ReleaseTarget {
                target_triple: "aarch64-apple-darwin".into(),
                artifact_url: "https://example.com/pantoken-headless-macos-aarch64.tar.gz"
                    .into(),
                sha256: actual_hash,
                archive_format: ArchiveFormat::TarGz,
            }],
        };

        let http_fetch: HttpFetch = {
            let archive = Arc::new(archive_bytes.clone());
            Arc::new(move |_url: &str| {
                let archive = archive.clone();
                Box::pin(async move { Ok((*archive).clone()) })
            })
        };

        let result = install_server(
            &transport,
            ssh_command(),
            "/tmp/pantoken-test",
            &macos_arm64_probe(),
            &manifest,
            http_fetch,
        )
        .await
        .expect("install should succeed");

        // The binary path should be the release artifact path.
        let expected = layout::release_artifact(
            Path::new("/tmp/pantoken-test"),
            "0.2.75",
            "aarch64-apple-darwin",
        )
        .unwrap();
        assert_eq!(result.binary_path, expected.to_string_lossy());

        // The archive was uploaded to the fake FS.
        let fs = transport.remote_fs();
        let fs = fs.lock().unwrap();
        assert!(
            fs.exists("/tmp/pantoken-test/.cache/pantoken-headless-macos-aarch64.tar.gz"),
            "archive should have been uploaded"
        );
    }

    /// AC.5: a checksum mismatch fails and no binary lands at the final path.
    #[tokio::test]
    async fn server_install_checksum_mismatch_is_atomic() {
        let transport = build_transport(Scenario::ServerChecksumMismatch);

        let archive_bytes = b"fake archive with wrong content".to_vec();
        let wrong_hash = "0".repeat(64); // doesn't match the archive

        let manifest = PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![ReleaseTarget {
                target_triple: "aarch64-apple-darwin".into(),
                artifact_url: "https://example.com/pantoken-headless-macos-aarch64.tar.gz"
                    .into(),
                sha256: wrong_hash,
                archive_format: ArchiveFormat::TarGz,
            }],
        };

        let http_fetch: HttpFetch = {
            let archive = Arc::new(archive_bytes.clone());
            Arc::new(move |_url: &str| {
                let archive = archive.clone();
                Box::pin(async move { Ok((*archive).clone()) })
            })
        };

        let result = install_server(
            &transport,
            ssh_command(),
            "/tmp/pantoken-test",
            &macos_arm64_probe(),
            &manifest,
            http_fetch,
        )
        .await;

        assert!(
            matches!(result, Err(ServerInstallError::ChecksumMismatch { .. })),
            "should fail with checksum mismatch, got {result:?}"
        );

        // No archive should have been uploaded (verification happens before
        // upload).
        let fs = transport.remote_fs();
        let fs = fs.lock().unwrap();
        assert!(
            !fs.exists("/tmp/pantoken-test/.cache/pantoken-headless-macos-aarch64.tar.gz"),
            "archive should NOT have been uploaded on checksum mismatch"
        );
    }
}
