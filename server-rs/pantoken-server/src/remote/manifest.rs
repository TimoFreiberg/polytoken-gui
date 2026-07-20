//! Pantoken remote release manifest contract.
//!
//! A `PantokenReleaseManifest` describes a single Pantoken server release: its
//! version, the wire protocol version it speaks, its build identity, and the
//! set of platform targets it ships artifacts for. This is a pure types +
//! validation module — no I/O, no fetching, no extraction.
//!
//! ## Identity separation
//!
//! The manifest carries **Pantoken's own** identity (`release_version` +
//! `build_sha`). This is kept separate from the polytoken compatibility floor
//! (`POLYTOKEN_DAEMON_TARGET_VERSION` in `pantoken-daemon-types`), which is the
//! *minimum* daemon version a Pantoken release was codegen'd against. The two
//! serve different purposes:
//!
//! - **Pantoken identity** (here): exact match — "is this the release I think
//!   it is?" Used for verifying downloaded artifacts and pinning a specific
//!   Pantoken build.
//! - **polytoken floor** (in `pantoken-daemon-types`): minimum bound — "is the
//!   daemon new enough to speak the wire format this Pantoken was built
//!   against?"
//!
//! Do not conflate them: a Pantoken release's `build_sha` is its own compile
//! identity (the `PANTOKEN_BUILD_SHA` env var at release build time), not the
//! daemon's version.

use pantoken_protocol::wire::PROTOCOL_VERSION;
use pantoken_remote_layout::semver;

/// A Pantoken server release manifest.
///
/// See the module doc-comment for the identity-separation rationale.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PantokenReleaseManifest {
    /// Semver release version of this Pantoken build (e.g. "0.1.0").
    pub release_version: String,
    /// Wire protocol version this release speaks. Must match
    /// [`PROTOCOL_VERSION`].
    pub protocol_version: u32,
    /// Build identity — the value `PANTOKEN_BUILD_SHA` resolved to at the
    /// release build's compile time. `None` if the build did not stamp a SHA.
    pub build_sha: Option<String>,
    /// Platform targets available in this release.
    pub targets: Vec<ReleaseTarget>,
}

/// A single platform target within a release.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReleaseTarget {
    /// Rust target triple (e.g. "aarch64-apple-darwin").
    pub target_triple: String,
    /// URL to download the release artifact (archive).
    pub artifact_url: String,
    /// SHA-256 hash of the artifact (64 lowercase hex chars).
    pub sha256: String,
    /// Archive format of the artifact.
    pub archive_format: ArchiveFormat,
}

/// Archive format of a release artifact.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub enum ArchiveFormat {
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "zip")]
    Zip,
}

/// Validation error for a release manifest.
#[derive(Debug, PartialEq, Eq)]
pub enum ManifestError {
    /// No targets in the manifest.
    NoTargets,
    /// Duplicate target triple(s) found.
    DuplicateTargets(Vec<String>),
    /// A sha256 hash is not 64 lowercase hex characters.
    InvalidSha256 { target: String, sha256: String },
    /// The manifest's protocol version does not match the expected
    /// `PROTOCOL_VERSION`.
    ProtocolVersionMismatch { expected: u32, actual: u32 },
    /// The release version is not valid semver.
    InvalidReleaseVersion { version: String },
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::NoTargets => write!(f, "manifest has no targets"),
            ManifestError::DuplicateTargets(dups) => {
                write!(f, "duplicate target triples: {}", dups.join(", "))
            }
            ManifestError::InvalidSha256 { target, sha256 } => write!(
                f,
                "invalid sha256 for target {}: expected 64 lowercase hex chars, got {:?}",
                target, sha256
            ),
            ManifestError::ProtocolVersionMismatch { expected, actual } => {
                write!(
                    f,
                    "protocol version mismatch: expected {}, got {}",
                    expected, actual
                )
            }
            ManifestError::InvalidReleaseVersion { version } => {
                write!(f, "invalid release version (not semver): {:?}", version)
            }
        }
    }
}

impl std::error::Error for ManifestError {}

/// Validate a release manifest.
///
/// Checks:
/// - At least one target.
/// - No duplicate target triples.
/// - Each `sha256` is 64 lowercase hex characters.
/// - `protocol_version` matches [`PROTOCOL_VERSION`].
/// - `release_version` parses as semver (with optional prerelease).
pub fn validate(manifest: &PantokenReleaseManifest) -> Result<(), ManifestError> {
    // At least one target.
    if manifest.targets.is_empty() {
        return Err(ManifestError::NoTargets);
    }

    // No duplicate target triples.
    let mut seen = std::collections::HashSet::new();
    let mut dups = Vec::new();
    for target in &manifest.targets {
        if !seen.insert(&target.target_triple) && !dups.contains(&target.target_triple) {
            dups.push(target.target_triple.clone());
        }
    }
    if !dups.is_empty() {
        return Err(ManifestError::DuplicateTargets(dups));
    }

    // Each sha256 is 64 lowercase hex chars.
    for target in &manifest.targets {
        if !is_valid_sha256(&target.sha256) {
            return Err(ManifestError::InvalidSha256 {
                target: target.target_triple.clone(),
                sha256: target.sha256.clone(),
            });
        }
    }

    // Protocol version matches PROTOCOL_VERSION.
    if manifest.protocol_version != PROTOCOL_VERSION {
        return Err(ManifestError::ProtocolVersionMismatch {
            expected: PROTOCOL_VERSION,
            actual: manifest.protocol_version,
        });
    }

    // Release version parses as semver.
    if !semver::parse_semver(&manifest.release_version) {
        return Err(ManifestError::InvalidReleaseVersion {
            version: manifest.release_version.clone(),
        });
    }

    Ok(())
}

/// Check if a string is a valid SHA-256 hash (64 lowercase hex characters).
fn is_valid_sha256(s: &str) -> bool {
    s.len() == 64
        && s.chars()
            .all(|c: char| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

#[cfg(test)]
mod tests {
    //! Named validation: `release_manifest_validation_tests`.

    use super::*;

    fn valid_target() -> ReleaseTarget {
        ReleaseTarget {
            target_triple: "aarch64-apple-darwin".into(),
            artifact_url: "https://example.com/pantoken-0.1.0-aarch64.tar.gz".into(),
            sha256: "a".repeat(64),
            archive_format: ArchiveFormat::TarGz,
        }
    }

    fn valid_manifest() -> PantokenReleaseManifest {
        PantokenReleaseManifest {
            release_version: "0.1.0".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: Some("abcdef0123".into()),
            targets: vec![valid_target()],
        }
    }

    #[test]
    fn valid_manifest_passes_validation() {
        let manifest = valid_manifest();
        assert!(validate(&manifest).is_ok(), "valid manifest should pass");
    }

    #[test]
    fn valid_manifest_with_prerelease_version_passes() {
        let mut manifest = valid_manifest();
        manifest.release_version = "0.1.0-rc.1".into();
        assert!(validate(&manifest).is_ok());
    }

    #[test]
    fn manifest_with_no_targets_fails() {
        let mut manifest = valid_manifest();
        manifest.targets = vec![];
        let err = validate(&manifest).unwrap_err();
        assert_eq!(err, ManifestError::NoTargets);
    }

    #[test]
    fn manifest_with_duplicate_targets_fails() {
        let mut manifest = valid_manifest();
        manifest.targets = vec![valid_target(), valid_target()];
        let err = validate(&manifest).unwrap_err();
        match err {
            ManifestError::DuplicateTargets(dups) => {
                assert_eq!(dups, vec!["aarch64-apple-darwin".to_string()]);
            }
            other => panic!("expected DuplicateTargets, got {:?}", other),
        }
    }

    #[test]
    fn manifest_with_bad_sha256_fails() {
        let mut manifest = valid_manifest();
        manifest.targets[0].sha256 = "short".into();
        let err = validate(&manifest).unwrap_err();
        match err {
            ManifestError::InvalidSha256 { target, sha256 } => {
                assert_eq!(target, "aarch64-apple-darwin");
                assert_eq!(sha256, "short");
            }
            other => panic!("expected InvalidSha256, got {:?}", other),
        }
    }

    #[test]
    fn manifest_with_uppercase_sha256_fails() {
        let mut manifest = valid_manifest();
        manifest.targets[0].sha256 = "A".repeat(64);
        let err = validate(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::InvalidSha256 { .. }));
    }

    #[test]
    fn manifest_with_wrong_protocol_version_fails() {
        let mut manifest = valid_manifest();
        manifest.protocol_version = PROTOCOL_VERSION + 1;
        let err = validate(&manifest).unwrap_err();
        match err {
            ManifestError::ProtocolVersionMismatch { expected, actual } => {
                assert_eq!(expected, PROTOCOL_VERSION);
                assert_eq!(actual, PROTOCOL_VERSION + 1);
            }
            other => panic!("expected ProtocolVersionMismatch, got {:?}", other),
        }
    }

    #[test]
    fn manifest_with_invalid_release_version_fails() {
        let mut manifest = valid_manifest();
        manifest.release_version = "not-a-version".into();
        let err = validate(&manifest).unwrap_err();
        match err {
            ManifestError::InvalidReleaseVersion { version } => {
                assert_eq!(version, "not-a-version");
            }
            other => panic!("expected InvalidReleaseVersion, got {:?}", other),
        }
    }

    #[test]
    fn manifest_with_build_sha_none_passes() {
        let mut manifest = valid_manifest();
        manifest.build_sha = None;
        assert!(validate(&manifest).is_ok());
    }

    #[test]
    fn manifest_with_multiple_distinct_targets_passes() {
        let mut manifest = valid_manifest();
        let mut target2 = valid_target();
        target2.target_triple = "x86_64-unknown-linux-gnu".into();
        manifest.targets.push(target2);
        assert!(validate(&manifest).is_ok());
    }
}
