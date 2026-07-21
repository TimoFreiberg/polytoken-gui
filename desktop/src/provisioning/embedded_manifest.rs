//! Embedded release manifest for Pantoken server provisioning.
//!
//! Constructs a [`PantokenReleaseManifest`] at runtime from compile-time
//! constants, describing the headless release artifact that contains the
//! `pantoken-server` binary. The manifest is validated at first use; a
//! malformed manifest panics at startup (loud failure, not silent corruption).
//!
//! ## SHA256 source
//!
//! The digest is computed at build time by `build.rs` from the local headless
//! artifact (`target/release/headless/pantoken-headless-macos-aarch64.tar.gz`).
//! In local dev and CI gate builds where the artifact doesn't exist, a
//! placeholder (64 zeros) is used — dev builds don't provision real hosts.
//! Only release builds (tag pushes) embed the real digest.
//!
//! ## Target scope
//!
//! This session ships macOS arm64 only (matching the existing headless
//! artifact). Non-macOS-arm64 targets produce `UnsupportedTarget` at install
//! time. Cross-target CI matrix expansion is a follow-up.

use pantoken_protocol::wire::PROTOCOL_VERSION;
use pantoken_remote_layout::manifest::{
    validate, ArchiveFormat, PantokenReleaseManifest, ReleaseTarget,
};

/// The GitHub releases base URL for Pantoken artifacts.
const GITHUB_RELEASES_BASE: &str = "https://github.com/TimoFreiberg/pantoken/releases/download";

/// The macOS arm64 headless artifact filename.
const HEADLESS_ARTIFACT_NAME: &str = "pantoken-headless-macos-aarch64.tar.gz";

/// The target triple for macOS arm64.
const MACOS_AARCH64_TRIPLE: &str = "aarch64-apple-darwin";

/// Construct the embedded release manifest.
///
/// This is built from compile-time constants: `CARGO_PKG_VERSION` (the Pantoken
/// server release version), `PANTOKEN_BUILD_SHA` (optional build identity),
/// `PANTOKEN_HEADLESS_SHA256` (the SHA256 of the headless artifact, computed by
/// `build.rs`), and `PROTOCOL_VERSION`.
///
/// The manifest is validated via [`validate`] before returning. A malformed
/// manifest (wrong protocol version, bad SHA256 format, invalid semver) panics
/// — this is a build-time configuration error, not a runtime condition.
pub fn get() -> PantokenReleaseManifest {
    let release_version = env!("CARGO_PKG_VERSION");
    let build_sha = option_env!("PANTOKEN_BUILD_SHA").map(|s| s.to_string());
    let sha256 = env!("PANTOKEN_HEADLESS_SHA256");

    // The tag is `v<version>` (e.g. v0.2.75).
    let tag = format!("v{release_version}");
    let artifact_url = format!("{GITHUB_RELEASES_BASE}/{tag}/{HEADLESS_ARTIFACT_NAME}");

    let manifest = PantokenReleaseManifest {
        release_version: release_version.to_string(),
        protocol_version: PROTOCOL_VERSION,
        build_sha,
        targets: vec![ReleaseTarget {
            target_triple: MACOS_AARCH64_TRIPLE.to_string(),
            artifact_url,
            sha256: sha256.to_string(),
            archive_format: ArchiveFormat::TarGz,
        }],
    };

    if let Err(e) = validate(&manifest) {
        panic!("embedded release manifest is invalid: {e}");
    }

    manifest
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `embedded_manifest_construction_validates`
    //! - `malformed_manifest_fails_validation`

    use super::*;
    use pantoken_protocol::wire::PROTOCOL_VERSION;
    use pantoken_remote_layout::manifest::{
        ArchiveFormat, ManifestError, PantokenReleaseManifest, ReleaseTarget,
    };

    #[test]
    fn embedded_manifest_construction_validates() {
        // The embedded manifest should always validate — if it doesn't,
        // get() would have panicked at startup.
        let manifest = get();
        assert!(validate(&manifest).is_ok());
        assert_eq!(manifest.protocol_version, PROTOCOL_VERSION);
        assert!(!manifest.targets.is_empty());
        assert_eq!(manifest.targets[0].target_triple, "aarch64-apple-darwin");
        assert_eq!(manifest.targets[0].archive_format, ArchiveFormat::TarGz);
    }

    #[test]
    fn malformed_manifest_fails_validation() {
        // Wrong protocol version.
        let mut manifest = valid_test_manifest();
        manifest.protocol_version = PROTOCOL_VERSION + 1;
        assert!(matches!(
            validate(&manifest),
            Err(ManifestError::ProtocolVersionMismatch { .. })
        ));

        // Bad SHA256 format.
        let mut manifest = valid_test_manifest();
        manifest.targets[0].sha256 = "short".into();
        assert!(matches!(
            validate(&manifest),
            Err(ManifestError::InvalidSha256 { .. })
        ));

        // Invalid semver.
        let mut manifest = valid_test_manifest();
        manifest.release_version = "not-a-version".into();
        assert!(matches!(
            validate(&manifest),
            Err(ManifestError::InvalidReleaseVersion { .. })
        ));
    }

    fn valid_test_manifest() -> PantokenReleaseManifest {
        PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: Some("abc123".into()),
            targets: vec![ReleaseTarget {
                target_triple: "aarch64-apple-darwin".into(),
                artifact_url: "https://example.com/artifact.tar.gz".into(),
                sha256: "a".repeat(64),
                archive_format: ArchiveFormat::TarGz,
            }],
        }
    }
}
