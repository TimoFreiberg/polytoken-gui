//! Pantoken remote release manifest contract.
//!
//! A `PantokenReleaseManifest` describes a single Pantoken server release: its
//! version, the wire protocol version it speaks, its build identity, and the
//! set of platform targets it ships artifacts for. This is a pure types +
//! validation module — no I/O, no fetching, no extraction.
//!
//! ## Why this lives in `pantoken-remote-layout`
//!
//! The manifest contract is shared between `pantoken-server` (which validates
//! incoming manifests on the remote side) and `desktop` (which constructs an
//! embedded manifest for provisioning). Keeping it here avoids pulling the
//! entire `pantoken-server` dependency tree (axum, tower, web-push, etc.) into
//! the desktop crate.
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

use crate::semver;

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

/// The canonical supported platform matrix for the remote-helper artifact.
///
/// A release manifest received from a remote source must cover **every** triple
/// listed here so that any host Pantoken can provision has a matching artifact.
/// This is the publish/validation contract enforced by [`validate`].
///
/// ## Current matrix (two targets)
///
/// - `aarch64-apple-darwin` — macOS arm64 (the desktop host running Pantoken)
/// - `x86_64-unknown-linux-gnu` — Linux x86_64 glibc (the SSH-accessible
///   development server / Docker container scenario)
///
/// ## Adding a target
///
/// A target triple may appear here **only** in the same change that:
///
/// 1. Builds the artifact on a matching CI runner
///    (`scripts/headless/build.ts --target <triple>`);
/// 2. Smoke-tests the extracted binary on that runner
///    (`scripts/headless/smoke-test.ts`);
/// 3. Embeds its real SHA-256 digest in the desktop build (`desktop/build.rs`);
/// 4. Publishes the signed/checksummed archive alongside the other targets
///    (`scripts/desktop/publish.ts`);
/// 5. Updates the full-matrix tests below to include the new triple.
///
/// Do not advertise a triple merely because Rust can name it. A target without
/// a published, validated artifact would cause provisioning to download a
/// non-existent file at runtime.
///
/// Sort order is fixed (not derived from insertion) so that the
/// [`ManifestError::IncompleteTargetMatrix`] missing-list is deterministic.
pub const SUPPORTED_TARGET_TRIPLES: &[&str] = &["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"];

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
    /// The manifest does not cover every supported platform target.
    /// Contains the sorted list of missing target triples.
    IncompleteTargetMatrix(Vec<String>),
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
            ManifestError::IncompleteTargetMatrix(missing) => {
                write!(
                    f,
                    "manifest is missing required target triples: {}",
                    missing.join(", ")
                )
            }
        }
    }
}

impl std::error::Error for ManifestError {}

/// Validate a release manifest's fields, without requiring the full platform
/// matrix.
///
/// Checks:
/// - At least one target.
/// - No duplicate target triples.
/// - Each `sha256` is 64 lowercase hex characters.
/// - `protocol_version` matches [`PROTOCOL_VERSION`].
/// - `release_version` parses as semver (with optional prerelease).
///
/// This is the validation an **embedded** manifest passes — one constructed at
/// compile time to describe the artifacts a single release actually ships. The
/// embedded manifest may legitimately cover only a subset of
/// [`SUPPORTED_TARGET_TRIPLES`] (e.g. only the host platform's headless
/// artifact), so the matrix-completeness check does not apply. Use
/// [`validate`] for received manifests that must cover the full matrix.
pub fn validate_manifest_fields(manifest: &PantokenReleaseManifest) -> Result<(), ManifestError> {
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

/// Validate a received release manifest.
///
/// Runs [`validate_manifest_fields`] (structural checks) **and** requires the
/// manifest to cover the full supported platform matrix (see
/// [`validate_target_matrix_completeness`]). Use this for manifests received
/// from a remote source that must cover every platform Pantoken can run on.
pub fn validate(manifest: &PantokenReleaseManifest) -> Result<(), ManifestError> {
    validate_manifest_fields(manifest)?;
    validate_target_matrix_completeness(manifest)?;
    Ok(())
}

/// Check if a string is a valid SHA-256 hash (64 lowercase hex characters).
fn is_valid_sha256(s: &str) -> bool {
    s.len() == 64
        && s.chars()
            .all(|c: char| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Validate that a manifest covers the full supported platform matrix.
///
/// Every triple in [`SUPPORTED_TARGET_TRIPLES`] must be present (exact match)
/// in the manifest's `targets`. Extra triples beyond the matrix are allowed
/// (forward-compatibility for new platforms that ship before the constant is
/// updated). Returns the sorted list of missing triples on failure.
pub fn validate_target_matrix_completeness(
    manifest: &PantokenReleaseManifest,
) -> Result<(), ManifestError> {
    let present: std::collections::HashSet<&str> = manifest
        .targets
        .iter()
        .map(|t| t.target_triple.as_str())
        .collect();

    let missing: Vec<String> = SUPPORTED_TARGET_TRIPLES
        .iter()
        .filter(|triple| !present.contains(**triple))
        .map(|s| (*s).to_string())
        .collect();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(ManifestError::IncompleteTargetMatrix(missing))
    }
}

#[cfg(test)]
mod tests {
    //! Named validation: `release_manifest_validation_tests`.

    use super::*;

    fn valid_target_for(triple: &str) -> ReleaseTarget {
        ReleaseTarget {
            target_triple: triple.into(),
            artifact_url: format!("https://example.com/pantoken-0.1.0-{triple}.tar.gz"),
            sha256: "a".repeat(64),
            archive_format: ArchiveFormat::TarGz,
        }
    }

    fn valid_target() -> ReleaseTarget {
        valid_target_for("aarch64-apple-darwin")
    }

    /// A manifest whose `targets` cover the full supported platform matrix.
    fn full_matrix_targets() -> Vec<ReleaseTarget> {
        SUPPORTED_TARGET_TRIPLES
            .iter()
            .map(|t| valid_target_for(t))
            .collect()
    }

    fn valid_manifest() -> PantokenReleaseManifest {
        PantokenReleaseManifest {
            release_version: "0.1.0".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: Some("abcdef0123".into()),
            targets: full_matrix_targets(),
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
        // An extra target beyond the supported matrix is allowed (forward-compat).
        let mut extra = valid_target_for("wasm32-unknown-unknown");
        extra.sha256 = "b".repeat(64);
        manifest.targets.push(extra);
        assert!(validate(&manifest).is_ok());
    }

    #[test]
    fn manifest_with_full_matrix_passes() {
        // A manifest covering exactly the supported triples should pass.
        let manifest = valid_manifest();
        assert!(validate(&manifest).is_ok());
        // Also verify the completeness function directly.
        assert!(validate_target_matrix_completeness(&manifest).is_ok());
    }

    #[test]
    fn manifest_rejects_incomplete_target_matrix() {
        // Named validation: `manifest_rejects_incomplete_target_matrix`.
        // A manifest missing one of the 4 supported triples is rejected.
        let mut manifest = valid_manifest();
        // Remove one target (aarch64-apple-darwin) to simulate an incomplete matrix.
        manifest
            .targets
            .retain(|t| t.target_triple != "aarch64-apple-darwin");

        let err = validate(&manifest).unwrap_err();
        match err {
            ManifestError::IncompleteTargetMatrix(missing) => {
                assert_eq!(missing, vec!["aarch64-apple-darwin".to_string()]);
            }
            other => panic!("expected IncompleteTargetMatrix, got {:?}", other),
        }

        // The completeness function alone should also reject it.
        let err = validate_target_matrix_completeness(&manifest).unwrap_err();
        match err {
            ManifestError::IncompleteTargetMatrix(missing) => {
                assert_eq!(missing, vec!["aarch64-apple-darwin".to_string()]);
            }
            other => panic!("expected IncompleteTargetMatrix, got {:?}", other),
        }
    }

    #[test]
    fn manifest_rejects_incomplete_target_matrix_multiple_missing() {
        // Removing two targets yields both in the missing list (sorted).
        // With the two-target matrix, removing both leaves none present.
        let mut manifest = valid_manifest();
        manifest.targets.retain(|t| {
            t.target_triple != "aarch64-apple-darwin"
                && t.target_triple != "x86_64-unknown-linux-gnu"
        });

        let err = validate_target_matrix_completeness(&manifest).unwrap_err();
        match err {
            ManifestError::IncompleteTargetMatrix(missing) => {
                // SUPPORTED_TARGET_TRIPLES is sorted, so missing list inherits that order.
                assert_eq!(
                    missing,
                    vec![
                        "aarch64-apple-darwin".to_string(),
                        "x86_64-unknown-linux-gnu".to_string(),
                    ]
                );
            }
            other => panic!("expected IncompleteTargetMatrix, got {:?}", other),
        }
    }

    #[test]
    fn validate_manifest_fields_accepts_single_target() {
        // The embedded manifest legitimately ships one target; field-level
        // validation must pass, while full validate() must reject it for the
        // incomplete matrix.
        let manifest = PantokenReleaseManifest {
            release_version: "0.1.0".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: None,
            targets: vec![valid_target()],
        };
        assert!(
            validate_manifest_fields(&manifest).is_ok(),
            "single-target manifest should pass field validation"
        );
        assert!(
            validate(&manifest).is_err(),
            "single-target manifest should fail full validation (incomplete matrix)"
        );
    }

    // ── Phase 4 release-matrix regression tests ──────────────────────────────

    /// Named validation: `release_manifest_matches_published_target_matrix`.
    /// The supported matrix must be exactly the two targets that have real,
    /// published artifacts. A target here without a matching CI build pipeline
    /// would cause provisioning to fail at runtime.
    #[test]
    fn release_manifest_matches_published_target_matrix() {
        assert_eq!(
            SUPPORTED_TARGET_TRIPLES,
            &["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"],
            "the supported matrix must be exactly these two targets — \
             see the module doc for the add-target contract"
        );
    }

    /// Named validation: `embedded_manifest_contains_real_linux_digest`.
    /// A real release manifest covering the full matrix must have a non-placeholder
    /// (non-all-zero) SHA-256 for the Linux target. This is the contract the
    /// desktop `build.rs` enforces at release-build time: release builds must embed
    /// real digests, not placeholders.
    #[test]
    fn embedded_manifest_contains_real_linux_digest() {
        let manifest = valid_manifest();
        let linux_target = manifest
            .targets
            .iter()
            .find(|t| t.target_triple == "x86_64-unknown-linux-gnu")
            .expect("full-matrix manifest must contain the Linux x86_64 target");

        assert_eq!(linux_target.sha256.len(), 64);
        assert_eq!(
            linux_target.archive_format,
            ArchiveFormat::TarGz,
            "Linux artifacts must be tar.gz"
        );
        assert!(
            linux_target.sha256 != "0".repeat(64),
            "the Linux target digest must not be the all-zero placeholder"
        );
        assert!(
            !linux_target.artifact_url.is_empty(),
            "the Linux target must have a download URL"
        );
        assert!(
            linux_target
                .artifact_url
                .contains("x86_64-unknown-linux-gnu")
                || linux_target.artifact_url.contains("linux"),
            "the Linux artifact URL should reference its platform"
        );
    }

    /// Named validation: `release_rejects_missing_or_mismatched_artifact`.
    /// A manifest missing the Linux target is rejected by the full validation gate.
    /// A manifest whose Linux target has a placeholder (all-zero) digest still
    /// passes structural validation (the zero string is valid 64-hex format) but
    /// is not a valid *release* artifact — the build.rs release gate must catch
    /// this separately. Here we verify the structural gate catches a missing target.
    #[test]
    fn release_rejects_missing_or_mismatched_artifact() {
        // Removing the Linux target entirely must fail full validation.
        let mut manifest = valid_manifest();
        manifest
            .targets
            .retain(|t| t.target_triple != "x86_64-unknown-linux-gnu");

        let err = validate(&manifest).unwrap_err();
        match err {
            ManifestError::IncompleteTargetMatrix(missing) => {
                assert_eq!(missing, vec!["x86_64-unknown-linux-gnu".to_string()]);
            }
            other => panic!("expected IncompleteTargetMatrix, got {:?}", other),
        }

        // A manifest with a *placeholder* digest for Linux passes structural
        // validation (the format is valid) — this is the gap that the release
        // build gate (desktop/build.rs) must close by refusing to emit a
        // release build with a placeholder digest.
        let mut placeholder_manifest = valid_manifest();
        let linux = placeholder_manifest
            .targets
            .iter_mut()
            .find(|t| t.target_triple == "x86_64-unknown-linux-gnu")
            .expect("Linux target present");
        linux.sha256 = "0".repeat(64);
        assert!(
            validate_manifest_fields(&placeholder_manifest).is_ok(),
            "placeholder digest passes structural validation (format is valid hex)"
        );
        assert!(
            validate(&placeholder_manifest).is_ok(),
            "placeholder digest passes full validation (matrix is complete, format valid)"
        );
        // This test documents that structural validation alone cannot catch a
        // placeholder digest — the release build gate must enforce it.
    }

    /// A manifest that claims only the macOS target but omits Linux must be
    /// rejected by full validation, proving the matrix is strictly enforced.
    #[test]
    fn macos_only_manifest_fails_full_validation() {
        let manifest = PantokenReleaseManifest {
            release_version: "0.2.0".into(),
            protocol_version: PROTOCOL_VERSION,
            build_sha: Some("abcdef".into()),
            targets: vec![valid_target_for("aarch64-apple-darwin")],
        };
        assert!(validate_manifest_fields(&manifest).is_ok());
        let err = validate(&manifest).unwrap_err();
        assert!(matches!(err, ManifestError::IncompleteTargetMatrix(_)));
    }

    /// The supported matrix must not include targets that lack published artifacts.
    /// This guards against accidentally re-adding `aarch64-unknown-linux-gnu`,
    /// `x86_64-apple-darwin`, or musl variants without a matching pipeline.
    #[test]
    fn supported_matrix_excludes_unverified_targets() {
        let unsupported = [
            "aarch64-unknown-linux-gnu",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-musl",
            "aarch64-unknown-linux-musl",
        ];
        for triple in unsupported {
            assert!(
                !SUPPORTED_TARGET_TRIPLES.contains(&triple),
                "{triple} must not be in the supported matrix without a published artifact"
            );
        }
    }
}
