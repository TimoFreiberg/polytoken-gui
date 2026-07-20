//! Semver parsing and comparison (Phase 3).
//!
//! A minimal semver implementation: parse + compare with prerelease
//! precedence. No external `semver` crate dependency — the provisioning layer
//! only needs parse + compare, not the full semver spec (build metadata is
//! ignored for comparison).
//!
//! ## Prerelease precedence
//!
//! Per the semver spec, a version with a prerelease tag is *lower* than the
//! same version without one: `0.5.0-unstable.9` < `0.5.0`. Prerelease
//! segments are compared numerically when both are numeric, else lexically.
//! Numeric segments have lower precedence than non-numeric (e.g. `alpha`).

use std::cmp::Ordering;

/// A parsed semver version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Option<String>,
}

/// Parse a version string into a structured [`Version`]. Returns `None` if
/// invalid.
///
/// Accepts `MAJOR.MINOR.PATCH` with an optional `-prerelease` suffix.
/// Components must be numeric with no leading zeros (except `0` itself).
/// Prerelease segments are alphanumeric + hyphen, dot-separated.
pub fn parse_version(s: &str) -> Option<Version> {
    let (core, prerelease) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };

    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    let mut nums = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            return None;
        }
        if *part == "0" {
            continue;
        }
        if !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        if part.starts_with('0') {
            return None; // leading zero
        }
        nums[i] = part.parse().ok()?;
    }

    if let Some(pre) = prerelease {
        if pre.is_empty() {
            return None;
        }
        for segment in pre.split('.') {
            if segment.is_empty() {
                return None;
            }
            if !segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return None;
            }
        }
    }

    Some(Version {
        major: nums[0],
        minor: nums[1],
        patch: nums[2],
        prerelease: prerelease.map(|s| s.to_string()),
    })
}

/// Validate a version string is semver (with optional prerelease).
/// Thin wrapper: `parse_version(s).is_some()`.
pub fn parse_semver(s: &str) -> bool {
    parse_version(s).is_some()
}

/// Compare two semver version strings. Returns [`std::cmp::Ordering`].
///
/// Prerelease < release: `0.5.0-unstable.9` < `0.5.0`.
/// Prerelease segments compared numerically when both numeric, else lexically.
/// Returns [`Ordering::Equal`] if both are unparseable (defensive — callers
/// should check `parse_version` first for distinct handling).
pub fn compare_semver(a: &str, b: &str) -> Ordering {
    match (parse_version(a), parse_version(b)) {
        (Some(va), Some(vb)) => compare_versions(&va, &vb),
        // If either is unparseable, we can't meaningfully compare.
        // Treat unparseable as "less than" parseable for ordering stability.
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

/// Compare two parsed [`Version`] structs with prerelease precedence.
fn compare_versions(a: &Version, b: &Version) -> Ordering {
    // Compare major.minor.patch numerically.
    match a.major.cmp(&b.major) {
        Ordering::Equal => {}
        ord => return ord,
    }
    match a.minor.cmp(&b.minor) {
        Ordering::Equal => {}
        ord => return ord,
    }
    match a.patch.cmp(&b.patch) {
        Ordering::Equal => {}
        ord => return ord,
    }

    // Prerelease precedence: None > Some (release > prerelease).
    match (&a.prerelease, &b.prerelease) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(pa), Some(pb)) => compare_prerelease(pa, pb),
    }
}

/// Compare two prerelease strings per semver spec.
///
/// Segments are compared left-to-right. When both segments are numeric,
/// compare numerically; otherwise compare lexically. Numeric segments have
/// lower precedence than non-numeric. A shorter prerelease with all matching
/// segments is less than a longer one.
fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let segs_a: Vec<&str> = a.split('.').collect();
    let segs_b: Vec<&str> = b.split('.').collect();

    for (sa, sb) in segs_a.iter().zip(segs_b.iter()) {
        let ord = compare_prerelease_segment(sa, sb);
        if ord != Ordering::Equal {
            return ord;
        }
    }

    // All compared segments equal — longer prerelease wins (is greater).
    segs_a.len().cmp(&segs_b.len())
}

/// Compare a single prerelease segment.
fn compare_prerelease_segment(a: &str, b: &str) -> Ordering {
    let a_num = a.chars().all(|c| c.is_ascii_digit()) && !a.is_empty();
    let b_num = b.chars().all(|c| c.is_ascii_digit()) && !b.is_empty();

    match (a_num, b_num) {
        // Both numeric: compare numerically.
        (true, true) => {
            let na: u64 = a.parse().unwrap_or(0);
            let nb: u64 = b.parse().unwrap_or(0);
            na.cmp(&nb)
        }
        // Numeric < non-numeric (numeric has lower precedence).
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        // Both non-numeric: compare lexically.
        (false, false) => a.cmp(b),
    }
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `semver_comparison_handles_prerelease`

    use super::*;

    #[test]
    fn parse_version_accepts_stable() {
        let v = parse_version("1.2.3").unwrap();
        assert_eq!(
            v,
            Version {
                major: 1,
                minor: 2,
                patch: 3,
                prerelease: None
            }
        );
    }

    #[test]
    fn parse_version_accepts_prerelease() {
        let v = parse_version("0.5.0-unstable.9").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 5);
        assert_eq!(v.patch, 0);
        assert_eq!(v.prerelease.as_deref(), Some("unstable.9"));
    }

    #[test]
    fn parse_version_rejects_invalid() {
        assert!(parse_version("").is_none());
        assert!(parse_version("1.0").is_none());
        assert!(parse_version("1.0.0.0").is_none());
        assert!(parse_version("01.0.0").is_none());
        assert!(parse_version("v1.0.0").is_none());
        assert!(parse_version("1.0.0-").is_none());
        assert!(parse_version("1.0.x").is_none());
    }

    #[test]
    fn parse_semver_wrapper() {
        assert!(parse_semver("0.5.0"));
        assert!(parse_semver("0.5.0-unstable.9"));
        assert!(!parse_semver("not-a-version"));
    }

    #[test]
    fn semver_comparison_handles_prerelease() {
        // Prerelease < release.
        assert_eq!(compare_semver("0.5.0-unstable.9", "0.5.0"), Ordering::Less);
        assert_eq!(
            compare_semver("0.5.0", "0.5.0-unstable.9"),
            Ordering::Greater
        );

        // Normal version ordering.
        assert_eq!(compare_semver("0.5.0", "0.5.1"), Ordering::Less);
        assert_eq!(compare_semver("0.5.1", "0.5.0"), Ordering::Greater);
        assert_eq!(compare_semver("0.5.0", "0.5.0"), Ordering::Equal);

        // Prerelease numeric segment comparison.
        assert_eq!(
            compare_semver("0.5.0-unstable.9", "0.5.0-unstable.10"),
            Ordering::Less
        );
        assert_eq!(
            compare_semver("0.5.0-unstable.10", "0.5.0-unstable.9"),
            Ordering::Greater
        );

        // Different prerelease tags: lexical comparison.
        assert_eq!(compare_semver("0.5.0-alpha", "0.5.0-beta"), Ordering::Less);

        // Major version dominates.
        assert_eq!(compare_semver("1.0.0", "0.9.9"), Ordering::Greater);

        // Unparseable handling.
        assert_eq!(compare_semver("garbage", "0.5.0"), Ordering::Less);
        assert_eq!(compare_semver("0.5.0", "garbage"), Ordering::Greater);
    }
}
