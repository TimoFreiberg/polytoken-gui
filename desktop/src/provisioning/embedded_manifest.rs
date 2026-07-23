//! Embedded release manifest for Pantoken server provisioning.
//!
//! Constructs a [`PantokenReleaseManifest`] at runtime from compile-time
//! constants, describing the headless release artifacts that contain the
//! `pantoken-server` binary. The manifest is validated at first use; a
//! malformed manifest panics at startup (loud failure, not silent corruption).
//!
//! ## SHA256 source
//!
//! Digests are computed at build time by `build.rs` from the local headless
//! artifacts (`target/release/headless/pantoken-headless-*.tar.gz`). In local
//! dev and CI gate builds where the artifacts don't exist, placeholders (64
//! zeros) are used — dev builds don't provision real hosts. Only release builds
//! (tag pushes) embed the real digest, and the release build gate must refuse to
//! emit a release build where any supported target still has a placeholder.
//!
//! ## Target scope
//!
//! This session ships two headless artifacts:
//! - `aarch64-apple-darwin` — macOS arm64 (the desktop host running Pantoken)
//! - `x86_64-unknown-linux-gnu` — Linux x86_64 glibc (the SSH-accessible dev
//!   server / Docker container scenario)
//!
//! Both targets are embedded so the manifest covers the full supported matrix.
//! The embedded manifest passes field validation (`validate_manifest_fields`)
//! but the full matrix validation (`validate`) requires the digests to be real
//! (non-placeholder) — see the release build gate. Other targets (Linux arm64,
//! macOS x86_64, musl) produce `UnsupportedTarget` at install time until a
//! matching artifact is built, published, embedded, and smoke-tested.

use pantoken_protocol::wire::PROTOCOL_VERSION;
use pantoken_remote_layout::manifest::{
    validate_manifest_fields, ArchiveFormat, PantokenReleaseManifest, ReleaseTarget,
};

/// The GitHub releases base URL for Pantoken artifacts.
const GITHUB_RELEASES_BASE: &str = "https://github.com/TimoFreiberg/pantoken/releases/download";

/// The macOS arm64 headless artifact filename.
const MACOS_AARCH64_ASSET: &str = "pantoken-headless-macos-aarch64.tar.gz";
/// The Linux x86_64 headless artifact filename.
const LINUX_X86_64_ASSET: &str = "pantoken-headless-linux-x86_64.tar.gz";

/// The target triple for macOS arm64.
const MACOS_AARCH64_TRIPLE: &str = "aarch64-apple-darwin";
/// The target triple for Linux x86_64 glibc.
const LINUX_X86_64_TRIPLE: &str = "x86_64-unknown-linux-gnu";

/// The all-zero placeholder digest used when an artifact is not present at
/// build time (local dev / CI gate). Release builds must not ship placeholders.
#[cfg(test)]
const PLACEHOLDER_SHA256: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Construct the embedded release manifest.
///
/// This is built from compile-time constants: `CARGO_PKG_VERSION` (the Pantoken
/// server release version), `PANTOKEN_BUILD_SHA` (optional build identity),
/// `PANTOKEN_HEADLESS_SHA256_MACOS_AARCH64` and
/// `PANTOKEN_HEADLESS_SHA256_LINUX_X86_64` (SHA256 digests of the headless
/// artifacts, computed by `build.rs`), and `PROTOCOL_VERSION`.
///
/// The manifest is validated via [`validate_manifest_fields`] before returning.
/// A malformed manifest (wrong protocol version, bad SHA256 format, invalid
/// semver) panics — this is a build-time configuration error, not a runtime
/// condition.
///
/// In dev/CI-gate builds, the digests are placeholders (64 zeros). This is
/// valid 64-hex format so field validation passes. The release build gate
/// (CI) must verify that no placeholder digests remain in a release build.
pub fn get() -> PantokenReleaseManifest {
    let release_version = env!("CARGO_PKG_VERSION");
    let build_sha = option_env!("PANTOKEN_BUILD_SHA").map(|s| s.to_string());

    let tag = format!("v{release_version}");

    let targets = vec![
        ReleaseTarget {
            target_triple: MACOS_AARCH64_TRIPLE.to_string(),
            artifact_url: format!("{GITHUB_RELEASES_BASE}/{tag}/{MACOS_AARCH64_ASSET}"),
            sha256: env!("PANTOKEN_HEADLESS_SHA256_MACOS_AARCH64").to_string(),
            archive_format: ArchiveFormat::TarGz,
        },
        ReleaseTarget {
            target_triple: LINUX_X86_64_TRIPLE.to_string(),
            artifact_url: format!("{GITHUB_RELEASES_BASE}/{tag}/{LINUX_X86_64_ASSET}"),
            sha256: env!("PANTOKEN_HEADLESS_SHA256_LINUX_X86_64").to_string(),
            archive_format: ArchiveFormat::TarGz,
        },
    ];

    let manifest = PantokenReleaseManifest {
        release_version: release_version.to_string(),
        protocol_version: PROTOCOL_VERSION,
        build_sha,
        targets,
    };

    if let Err(e) = validate_manifest_fields(&manifest) {
        panic!("embedded release manifest is invalid: {e}");
    }

    manifest
}

/// Returns `true` if any embedded target digest is the all-zero placeholder.
/// Used by the release build gate to refuse publishing a release that would
/// embed placeholder digests.
#[cfg(test)]
pub fn has_placeholder_digests(manifest: &PantokenReleaseManifest) -> bool {
    manifest
        .targets
        .iter()
        .any(|t| t.sha256 == PLACEHOLDER_SHA256)
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `embedded_manifest_construction_validates`
    //! - `malformed_manifest_fails_validation`
    //! - `embedded_manifest_contains_real_linux_digest`
    //! - `embedded_manifest_covers_supported_matrix`
    //! - `embedded_manifest_rejects_placeholder_in_release`

    use super::*;
    use pantoken_protocol::wire::PROTOCOL_VERSION;
    use pantoken_remote_layout::manifest::{
        validate_manifest_fields, ArchiveFormat, ManifestError, PantokenReleaseManifest,
        ReleaseTarget, SUPPORTED_TARGET_TRIPLES,
    };

    #[test]
    fn embedded_manifest_construction_validates() {
        // The embedded manifest should always validate — if it doesn't,
        // get() would have panicked at startup.
        let manifest = get();
        assert!(validate_manifest_fields(&manifest).is_ok());
        assert_eq!(manifest.protocol_version, PROTOCOL_VERSION);
        assert!(!manifest.targets.is_empty());
    }

    #[test]
    fn embedded_manifest_covers_supported_matrix() {
        // The embedded manifest must include every supported target triple.
        let manifest = get();
        let present: std::collections::HashSet<&str> = manifest
            .targets
            .iter()
            .map(|t| t.target_triple.as_str())
            .collect();
        for triple in SUPPORTED_TARGET_TRIPLES {
            assert!(
                present.contains(*triple),
                "embedded manifest is missing supported target: {triple}"
            );
        }
    }

    #[test]
    fn embedded_manifest_contains_real_linux_digest() {
        // Named validation: `embedded_manifest_contains_real_linux_digest`.
        // In a dev build the digest is a placeholder; in a release build it
        // must be real. This test checks the structure: the Linux target is
        // present with the correct format and a non-empty URL.
        let manifest = get();
        let linux_target = manifest
            .targets
            .iter()
            .find(|t| t.target_triple == LINUX_X86_64_TRIPLE)
            .expect("embedded manifest must contain the Linux x86_64 target");

        assert_eq!(linux_target.sha256.len(), 64);
        assert_eq!(
            linux_target.archive_format,
            ArchiveFormat::TarGz,
            "Linux artifacts must be tar.gz"
        );
        assert!(
            !linux_target.artifact_url.is_empty(),
            "Linux target must have a download URL"
        );
        assert!(
            linux_target.artifact_url.contains(LINUX_X86_64_ASSET),
            "Linux artifact URL must reference its asset name"
        );

        // In a release build (PANTOKEN_RELEASE_BUILD=1), the digest must not be
        // a placeholder. In dev builds, it may be.
        if std::env::var("PANTOKEN_RELEASE_BUILD").as_deref() == Ok("1") {
            assert!(
                linux_target.sha256 != PLACEHOLDER_SHA256,
                "release build must embed a real Linux digest, not a placeholder"
            );
        }
    }

    #[test]
    fn embedded_manifest_rejects_placeholder_in_release() {
        // The has_placeholder_digests helper must detect all-zero digests.
        let manifest_with_placeholder = PantokenReleaseManifest {
            release_version: "0.1.0".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![
                ReleaseTarget {
                    target_triple: "aarch64-apple-darwin".into(),
                    artifact_url: "https://example.com/a.tar.gz".into(),
                    sha256: "a".repeat(64),
                    archive_format: ArchiveFormat::TarGz,
                },
                ReleaseTarget {
                    target_triple: "x86_64-unknown-linux-gnu".into(),
                    artifact_url: "https://example.com/b.tar.gz".into(),
                    sha256: PLACEHOLDER_SHA256.into(),
                    archive_format: ArchiveFormat::TarGz,
                },
            ],
        };
        assert!(has_placeholder_digests(&manifest_with_placeholder));

        let manifest_real = PantokenReleaseManifest {
            release_version: "0.1.0".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![
                ReleaseTarget {
                    target_triple: "aarch64-apple-darwin".into(),
                    artifact_url: "https://example.com/a.tar.gz".into(),
                    sha256: "a".repeat(64),
                    archive_format: ArchiveFormat::TarGz,
                },
                ReleaseTarget {
                    target_triple: "x86_64-unknown-linux-gnu".into(),
                    artifact_url: "https://example.com/b.tar.gz".into(),
                    sha256: "b".repeat(64),
                    archive_format: ArchiveFormat::TarGz,
                },
            ],
        };
        assert!(!has_placeholder_digests(&manifest_real));
    }

    #[test]
    fn malformed_manifest_fails_validation() {
        // Wrong protocol version.
        let mut manifest = valid_test_manifest();
        manifest.protocol_version = PROTOCOL_VERSION + 1;
        assert!(matches!(
            validate_manifest_fields(&manifest),
            Err(ManifestError::ProtocolVersionMismatch { .. })
        ));

        // Bad SHA256 format.
        let mut manifest = valid_test_manifest();
        manifest.targets[0].sha256 = "short".into();
        assert!(matches!(
            validate_manifest_fields(&manifest),
            Err(ManifestError::InvalidSha256 { .. })
        ));

        // Invalid semver.
        let mut manifest = valid_test_manifest();
        manifest.release_version = "not-a-version".into();
        assert!(matches!(
            validate_manifest_fields(&manifest),
            Err(ManifestError::InvalidReleaseVersion { .. })
        ));
    }

    fn valid_test_manifest() -> PantokenReleaseManifest {
        PantokenReleaseManifest {
            release_version: "0.2.75".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: Some("abc123".into()),
            targets: SUPPORTED_TARGET_TRIPLES
                .iter()
                .map(|triple| ReleaseTarget {
                    target_triple: triple.to_string(),
                    artifact_url: format!("https://example.com/pantoken-{triple}.tar.gz"),
                    sha256: "a".repeat(64),
                    archive_format: ArchiveFormat::TarGz,
                })
                .collect(),
        }
    }
}
