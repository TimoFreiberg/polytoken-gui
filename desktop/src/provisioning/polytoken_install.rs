//! Polytoken installer (Phase 3, step 3).
//!
//! Downloads polytoken archives **locally on the Pantoken device**, verifies
//! SHA256, uploads over SSH, extracts on the remote, and atomically installs
//! into the version-target directory. Never replaces a working version in
//! place — new versions install to a new directory.
//!
//! ## Trust level
//!
//! Checksum-only (SHA256). No signature verification. This is a documented
//! constraint of the polytoken release artifacts. The trust level is recorded
//! in `install.json`.

// Several builder functions and types are part of the provisioning API but
// not yet called from the main binary path (only from tests). They will be
// wired as the provisioning flow matures.
#![allow(dead_code)]

use std::io;
use std::path::Path;
use std::sync::Arc;

use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;
use pantoken_remote_layout::layout;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::bridge::{SshCommand, SshTransport};
use crate::provisioning::probe::ProbeResult;

/// Type alias for the HTTP fetch function used by the installer.
pub type HttpFetch = Arc<
    dyn Fn(
            &str,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send>>
        + Send
        + Sync,
>;

/// The download channel: stable or unstable (prerelease).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Unstable,
}

/// The archive format to use for a given target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    TarGz,
    Zip,
}

/// Resolved artifact URLs for a polytoken install.
#[derive(Debug, Clone)]
pub struct ArtifactUrls {
    /// The archive download URL.
    pub archive_url: String,
    /// The SHA256SUMS file URL.
    pub checksums_url: String,
    /// The archive format.
    pub format: ArchiveFormat,
}

/// Provenance metadata recorded in `install.json` after a successful install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProvenance {
    /// The polytoken version that was installed.
    pub version: String,
    /// The Rust target triple.
    pub target: String,
    /// The source URL the archive was downloaded from.
    pub source_url: String,
    /// The SHA256 hash of the archive (64 lowercase hex chars).
    pub sha256: String,
    /// The install channel (stable/unstable).
    pub channel: String,
    /// Unix timestamp (seconds since epoch) of the install.
    pub installed_at: String,
    /// Trust level: "checksum-only" (no signature verification).
    pub trust_level: String,
}

/// Error from the polytoken installer.
#[derive(Debug)]
pub enum InstallError {
    /// The target is not supported for download.
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

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::UnsupportedTarget(t) => write!(f, "unsupported target: {t}"),
            InstallError::Download(e) => write!(f, "download failed: {e}"),
            InstallError::ChecksumMismatch { expected, actual } => {
                write!(f, "SHA256 mismatch: expected {expected}, got {actual}")
            }
            InstallError::Ssh(e) => write!(f, "SSH error: {e}"),
            InstallError::RemoteCommand { exit_code, stderr } => {
                write!(
                    f,
                    "remote command failed (exit {:?}): {}",
                    exit_code, stderr
                )
            }
        }
    }
}

impl std::error::Error for InstallError {}

impl From<io::Error> for InstallError {
    fn from(e: io::Error) -> Self {
        InstallError::Ssh(e)
    }
}

/// Derive the channel from the target version string.
///
/// If the version has a prerelease tag (contains `-`), use the unstable
/// channel; otherwise stable.
pub fn channel_for_version(version: &str) -> Channel {
    if version.contains('-') {
        Channel::Unstable
    } else {
        Channel::Stable
    }
}

/// Map a Rust target triple to the download platform + architecture.
fn target_to_platform(target: &str) -> Option<(&'static str, &'static str)> {
    match target {
        "x86_64-unknown-linux-gnu" => Some(("linux", "amd64")),
        "aarch64-unknown-linux-gnu" => Some(("linux", "arm64")),
        "x86_64-apple-darwin" => Some(("macos", "amd64")),
        "aarch64-apple-darwin" => Some(("macos", "arm64")),
        _ => None,
    }
}

/// Resolve the artifact URLs for a given target + version.
///
/// Uses the channel derived from the version: prerelease → unstable, else
/// stable. Prefers `.tar.gz` on Linux, `.zip` on macOS.
pub fn resolve_artifact_urls(target: &str, version: &str) -> Result<ArtifactUrls, InstallError> {
    let (platform, arch) =
        target_to_platform(target).ok_or_else(|| InstallError::UnsupportedTarget(target.into()))?;

    let channel = channel_for_version(version);
    let format = if platform == "linux" {
        ArchiveFormat::TarGz
    } else {
        ArchiveFormat::Zip
    };

    let ext = match format {
        ArchiveFormat::TarGz => "tar.gz",
        ArchiveFormat::Zip => "zip",
    };

    let base = match channel {
        Channel::Stable => format!("https://dl.polytoken.dev/{version}"),
        Channel::Unstable => format!("https://dl.polytoken.dev/unstable/{version}"),
    };

    let archive_url = format!("{base}/{platform}-{arch}/polytoken.{ext}");
    let checksums_url = format!("{base}/SHA256SUMS.{platform}");

    Ok(ArtifactUrls {
        archive_url,
        checksums_url,
        format,
    })
}

/// Compute the SHA256 hash of a byte buffer.
pub fn compute_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Parse a SHA256SUMS file and find the hash for the given filename.
///
/// The file format is: `<hash>  <filename>` per line. Matches on the
/// basename (last path component) of the entry for robustness against
/// path-prefixed entries.
pub fn find_checksum_in_sums(sums_content: &str, filename: &str) -> Option<String> {
    for line in sums_content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            // Match on the basename of the entry (handles path-prefixed entries).
            let entry_basename = parts[1].rsplit('/').next().unwrap_or(parts[1]);
            if entry_basename == filename {
                return Some(parts[0].to_lowercase());
            }
        }
    }
    None
}

/// The filename of the archive for a given platform + format.
pub fn archive_filename(platform: &str, arch: &str, format: ArchiveFormat) -> String {
    let ext = match format {
        ArchiveFormat::TarGz => "tar.gz",
        ArchiveFormat::Zip => "zip",
    };
    format!("polytoken-{platform}-{arch}.{ext}")
}

/// Verify a downloaded archive's SHA256 against the expected hash.
pub fn verify_checksum(data: &[u8], expected_sha256: &str) -> Result<(), InstallError> {
    let actual = compute_sha256(data);
    if actual == expected_sha256 {
        Ok(())
    } else {
        Err(InstallError::ChecksumMismatch {
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

/// Build the remote extraction + atomic-install command.
///
/// Extracts the archive into a staging directory, verifies the binary, then
/// atomic-renames the staging directory into the final version-target
/// directory.
pub fn build_install_command(
    remote_root: &str,
    version: &str,
    target: &str,
    archive_path: &str,
    format: ArchiveFormat,
) -> Result<String, InstallError> {
    let root = Path::new(remote_root);
    let final_dir = layout::polytoken_binary(root, version, target)
        .map_err(|e| InstallError::UnsupportedTarget(e.to_string()))?
        .parent()
        .ok_or_else(|| InstallError::UnsupportedTarget("empty parent path".into()))?
        .to_string_lossy()
        .to_string();

    let staging_dir = format!("{final_dir}/.staging-$$");
    let staging_q = shell_quote(&staging_dir);
    let final_q = shell_quote(&final_dir);
    let archive_q = shell_quote(archive_path);

    let extract_cmd = match format {
        ArchiveFormat::TarGz => format!("tar xzf {archive_q} -C {staging_q}"),
        ArchiveFormat::Zip => format!("unzip -o {archive_q} -d {staging_q}"),
    };

    let binary_in_staging = shell_quote(&format!("{staging_dir}/polytoken"));

    // The install command:
    // 1. Create staging dir
    // 2. Extract archive into staging
    // 3. Verify the binary exists and is executable
    // 4. Atomic-rename staging → final dir
    // 5. Clean up archive
    Ok(format!(
        "set -e; \
         mkdir -p {staging_q}; \
         {extract_cmd}; \
         chmod +x {binary_in_staging}; \
         test -x {binary_in_staging}; \
         mkdir -p {final_q}; \
         rm -rf {final_q}; \
         mv {staging_q} {final_q}; \
         rm -f {archive_q}; \
         echo ok"
    ))
}

/// Build the command to clean up stale staging directories.
pub fn build_cleanup_staging_command(remote_root: &str, version: &str, target: &str) -> String {
    let root = Path::new(remote_root);
    let final_dir = layout::polytoken_binary(root, version, target)
        .map(|p| {
            p.parent()
                .map(|parent| parent.to_string_lossy().to_string())
        })
        .unwrap_or(None)
        .unwrap_or_default();
    let final_q = shell_quote(&final_dir);
    // The glob .staging-* must be outside the quotes for shell expansion.
    format!("rm -rf {final_q}/.staging-* 2>/dev/null; true")
}

/// Build the command to check if a polytoken binary exists at a given path.
pub fn build_binary_check_command(binary_path: &str) -> String {
    let path_q = shell_quote(binary_path);
    format!("test -x {path_q} && echo exists || echo missing")
}

/// Build the command to write install.json on the remote.
pub fn build_write_install_json_command(
    remote_root: &str,
    provenance: &InstallProvenance,
) -> Result<String, InstallError> {
    let json_path = layout::install_metadata(Path::new(remote_root));
    let json = serde_json::to_string_pretty(provenance)
        .map_err(|e| InstallError::Download(format!("serialize install.json: {e}")))?;
    let json_path_q = shell_quote(&json_path.to_string_lossy());
    // Write via heredoc to handle JSON safely.
    Ok(format!(
        "cat > {json_path_q} << 'PANTOKEN_INSTALL_JSON_EOF'\n{json}\nPANTOKEN_INSTALL_JSON_EOF"
    ))
}

/// Build the command to read install.json from the remote.
pub fn build_read_install_json_command(remote_root: &str) -> String {
    let json_path = layout::install_metadata(Path::new(remote_root));
    let json_path_q = shell_quote(&json_path.to_string_lossy());
    format!("cat {json_path_q} 2>/dev/null || echo ''")
}

/// The full install flow: download, verify, upload, extract, install.
///
/// This is the high-level orchestrator. It uses the provided HTTP fetch
/// function (injectable for testing) and the SSH transport.
pub async fn install_polytoken(
    transport: &dyn SshTransport,
    command: SshCommand,
    remote_root: &str,
    probe: &ProbeResult,
    http_fetch: HttpFetch,
) -> Result<InstallProvenance, InstallError> {
    let target = crate::provisioning::probe::target_triple(probe)
        .map_err(|e| InstallError::UnsupportedTarget(e.to_string()))?;

    let version = POLYTOKEN_DAEMON_TARGET_VERSION;
    let urls = resolve_artifact_urls(&target, version)?;
    let filename = {
        let (platform, arch) = target_to_platform(&target).unwrap();
        archive_filename(platform, arch, urls.format)
    };

    // 1. Download archive locally.
    let archive_data = http_fetch(&urls.archive_url)
        .await
        .map_err(InstallError::Download)?;

    // 2. Download checksums and verify.
    let sums_data = http_fetch(&urls.checksums_url)
        .await
        .map_err(InstallError::Download)?;
    let sums_content = String::from_utf8_lossy(&sums_data);
    let expected_hash = find_checksum_in_sums(&sums_content, &filename).ok_or_else(|| {
        InstallError::Download(format!("checksum for {filename} not found in SHA256SUMS"))
    })?;

    verify_checksum(&archive_data, &expected_hash)?;

    // 3. Upload archive to remote.
    let archive_remote_path = format!("{remote_root}/.cache/{filename}");
    // Ensure the cache dir exists.
    let cache_dir = format!("{remote_root}/.cache");
    let mkdir_cmd = format!("mkdir -p {}", shell_quote(&cache_dir));
    let mkdir_output = transport.run_command(command.clone(), &mkdir_cmd).await?;
    if !mkdir_output.is_success() {
        return Err(InstallError::RemoteCommand {
            exit_code: mkdir_output.exit_code,
            stderr: mkdir_output.stderr,
        });
    }

    transport
        .upload_file(command.clone(), &archive_remote_path, archive_data)
        .await?;

    // 4. Extract + atomic install on remote.
    let install_cmd = build_install_command(
        remote_root,
        version,
        &target,
        &archive_remote_path,
        urls.format,
    )?;
    let install_output = transport.run_command(command.clone(), &install_cmd).await?;
    if !install_output.is_success() {
        return Err(InstallError::RemoteCommand {
            exit_code: install_output.exit_code,
            stderr: install_output.stderr,
        });
    }

    // 5. Write provenance metadata.
    let provenance = InstallProvenance {
        version: version.to_string(),
        target: target.clone(),
        source_url: urls.archive_url.clone(),
        sha256: expected_hash,
        channel: match channel_for_version(version) {
            Channel::Stable => "stable".into(),
            Channel::Unstable => "unstable".into(),
        },
        installed_at: now_timestamp(),
        trust_level: "checksum-only".into(),
    };

    let write_cmd = build_write_install_json_command(remote_root, &provenance)?;
    let write_output = transport.run_command(command, &write_cmd).await?;
    if !write_output.is_success() {
        return Err(InstallError::RemoteCommand {
            exit_code: write_output.exit_code,
            stderr: write_output.stderr,
        });
    }

    Ok(provenance)
}

/// Get the current time as a Unix timestamp string.
///
/// Used for provenance metadata. A full ISO 8601 timestamp would require
/// chrono, but we keep the crate zero-dep for this. The Unix timestamp is
/// sufficient for provenance ordering.
fn now_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Default HTTP fetch function using `reqwest`.
///
/// Downloads the full response body into a `Vec<u8>`. Used by the real
/// provisioning flow (tests inject a mock).
pub fn default_http_fetch() -> HttpFetch {
    // Create the client once and reuse it across requests (connection pool,
    // TLS context, DNS resolver are shared).
    let client = Arc::new(reqwest::Client::new());
    Arc::new(move |url: &str| {
        let url = url.to_string();
        let client = client.clone();
        Box::pin(async move {
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("HTTP GET {url}: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {url}: status {}", resp.status()));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("HTTP body {url}: {e}"))?;
            Ok(bytes.to_vec())
        })
    })
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `polytoken_install_artifact_matrix`
    //! - `polytoken_checksum_failure_is_atomic`
    //! - `polytoken_install_preserves_previous_version`
    //! - `polytoken_install_records_provenance`

    use super::*;

    #[test]
    fn polytoken_install_artifact_matrix() {
        let version = "0.5.0-unstable.9";

        let cases = [
            (
                "x86_64-unknown-linux-gnu",
                "linux",
                "amd64",
                ArchiveFormat::TarGz,
            ),
            (
                "aarch64-unknown-linux-gnu",
                "linux",
                "arm64",
                ArchiveFormat::TarGz,
            ),
            ("x86_64-apple-darwin", "macos", "amd64", ArchiveFormat::Zip),
            ("aarch64-apple-darwin", "macos", "arm64", ArchiveFormat::Zip),
        ];

        for (target, platform, arch, format) in cases {
            let urls = resolve_artifact_urls(target, version).expect("resolve");
            assert_eq!(urls.format, format);
            assert!(urls.archive_url.contains(platform));
            assert!(urls.archive_url.contains(arch));
            assert!(urls.archive_url.contains(version));
            assert!(urls.archive_url.contains("unstable"));
            assert!(urls.checksums_url.contains(platform));
            assert!(urls.checksums_url.contains("SHA256SUMS"));
        }
    }

    #[test]
    fn polytoken_install_stable_channel() {
        let urls = resolve_artifact_urls("x86_64-unknown-linux-gnu", "1.0.0").expect("resolve");
        assert!(!urls.archive_url.contains("unstable"));
        assert!(urls.archive_url.contains("1.0.0"));
    }

    #[test]
    fn polytoken_install_unsupported_target() {
        assert!(resolve_artifact_urls("freebsd-amd64", "0.5.0").is_err());
    }

    #[test]
    fn polytoken_checksum_failure_is_atomic() {
        // verify_checksum returns an error on mismatch — the caller never
        // proceeds to upload, so no binary lands at the final path.
        let data = b"not the right content";
        let expected = "0000000000000000000000000000000000000000000000000000000000000000";
        let result = verify_checksum(data, expected);
        assert!(matches!(result, Err(InstallError::ChecksumMismatch { .. })));

        // The actual hash of the data is not the expected one.
        let actual = compute_sha256(data);
        assert_ne!(actual, expected);
    }

    #[test]
    fn polytoken_install_preserves_previous_version() {
        // The install command uses atomic-rename of a staging dir into the
        // final version-target dir. Different versions get different dirs
        // (the version is in the path), so installing a new version doesn't
        // touch the old version's directory.
        let root = "/opt/pantoken";
        let old_binary =
            layout::polytoken_binary(Path::new(root), "0.4.2", "x86_64-unknown-linux-gnu").unwrap();
        let new_binary = layout::polytoken_binary(
            Path::new(root),
            "0.5.0-unstable.9",
            "x86_64-unknown-linux-gnu",
        )
        .unwrap();

        // The paths are distinct.
        assert_ne!(old_binary, new_binary);

        // The install command for the new version doesn't reference the old.
        let cmd = build_install_command(
            root,
            "0.5.0-unstable.9",
            "x86_64-unknown-linux-gnu",
            "/tmp/archive.tar.gz",
            ArchiveFormat::TarGz,
        )
        .unwrap();
        assert!(!cmd.contains("0.4.2"));
    }

    #[test]
    fn polytoken_install_records_provenance() {
        let provenance = InstallProvenance {
            version: "0.5.0-unstable.9".into(),
            target: "x86_64-unknown-linux-gnu".into(),
            source_url:
                "https://dl.polytoken.dev/unstable/0.5.0-unstable.9/linux-amd64/polytoken.tar.gz"
                    .into(),
            sha256: "abc123".into(),
            channel: "unstable".into(),
            installed_at: "1234567890".into(),
            trust_level: "checksum-only".into(),
        };

        let json = serde_json::to_string(&provenance).expect("serialize");
        let back: InstallProvenance = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.version, "0.5.0-unstable.9");
        assert_eq!(back.target, "x86_64-unknown-linux-gnu");
        assert_eq!(back.sha256, "abc123");
        assert_eq!(back.channel, "unstable");
        assert_eq!(back.trust_level, "checksum-only");
    }

    #[test]
    fn find_checksum_in_sums_works() {
        let sums = "abc123  polytoken-linux-amd64.tar.gz\ndef456  polytoken-linux-arm64.tar.gz\n";
        let found = find_checksum_in_sums(sums, "polytoken-linux-amd64.tar.gz");
        assert_eq!(found.as_deref(), Some("abc123"));

        let not_found = find_checksum_in_sums(sums, "polytoken-macos-amd64.zip");
        assert!(not_found.is_none());
    }

    #[test]
    fn compute_sha256_known_value() {
        let data = b"hello";
        let hash = compute_sha256(data);
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn channel_derivation() {
        assert_eq!(channel_for_version("1.0.0"), Channel::Stable);
        assert_eq!(channel_for_version("0.5.0-unstable.9"), Channel::Unstable);
        assert_eq!(channel_for_version("1.0.0-rc.1"), Channel::Unstable);
    }
}
