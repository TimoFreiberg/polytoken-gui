//! Polytoken compatibility check (Phase 3, step 2).
//!
//! Checks whether the polytoken daemon on the remote host is compatible with
//! the version this Pantoken build was codegen'd against
//! (`POLYTOKEN_DAEMON_TARGET_VERSION`). Uses the shared semver comparison from
//! `pantoken-remote-layout`.

// polytoken_path_from_probe is part of the API but not yet called from the
// main binary path.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::io;

use pantoken_daemon_types::POLYTOKEN_DAEMON_TARGET_VERSION;
use pantoken_remote_layout::semver;

use crate::bridge::CommandOutput;
use crate::provisioning::probe::ProbeResult;
use crate::remote_executor::RemoteExecutor;

/// The compatibility state of the remote polytoken install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolytokenCompat {
    /// No polytoken found on the remote host.
    Missing,
    /// polytoken is installed but older than the target version.
    TooOld { found: String, target: String },
    /// polytoken is installed and compatible (equal or newer than target).
    Compatible {
        found: String,
        target: String,
        newer_than_target: bool,
    },
    /// polytoken is installed but its version string couldn't be parsed.
    Unparseable { raw: String },
}

/// The command to check the polytoken version on the remote host.
///
/// Searches PATH and any recorded path from `install.json`. The output is
/// expected to be the version string on the first line of stdout.
pub const VERSION_CHECK_COMMAND: &str = "polytoken --version 2>/dev/null | head -1 || echo ''";

/// Check polytoken compatibility by running `polytoken --version` over SSH.
///
/// If the probe already found a polytoken version, pass it via `probe_version`
/// to avoid a redundant SSH command.
pub async fn check_compatibility(
    executor: &dyn RemoteExecutor,
    probe_version: Option<&str>,
) -> Result<PolytokenCompat, io::Error> {
    // If the probe already found a version, use it directly.
    let raw_version = if let Some(v) = probe_version {
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    } else {
        // Run the version check command.
        let output = executor
            .run_script(VERSION_CHECK_COMMAND.to_owned())
            .await?;
        extract_version_string(&output)
    };

    Ok(classify_compat(
        raw_version,
        POLYTOKEN_DAEMON_TARGET_VERSION,
    ))
}

/// Extract the version string from a `polytoken --version` command output.
///
/// Looks for a semver pattern in the first non-empty line of stdout.
pub fn extract_version_string(output: &CommandOutput) -> Option<String> {
    if !output.is_success() {
        return None;
    }
    let first_line = output.stdout.lines().next()?;
    extract_semver_from_line(first_line)
}

/// Extract a semver version from a line of text.
///
/// Looks for the pattern `MAJOR.MINOR.PATCH[-prerelease]` anywhere in the
/// string.
fn extract_semver_from_line(line: &str) -> Option<String> {
    // Find a digit, then try to parse a semver from there.
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i].is_ascii_digit() {
            let candidate = &line[i..];
            if let Some(v) = parse_semver_prefix(candidate) {
                return Some(v);
            }
        }
    }
    None
}

/// Try to extract a semver prefix from a string.
fn parse_semver_prefix(s: &str) -> Option<String> {
    // Find the end of the version string: it ends at the first character
    // that isn't part of a semver (digit, dot, hyphen, alphanumeric prerelease).
    let mut end = 0;
    let chars: Vec<char> = s.chars().collect();
    let mut seen_dot = 0;
    let mut in_prerelease = false;

    for (i, &c) in chars.iter().enumerate() {
        if c == '.' {
            seen_dot += 1;
            end = i + 1;
        } else if c == '-' && seen_dot == 2 {
            in_prerelease = true;
            end = i + 1;
        } else if c.is_ascii_alphanumeric() || (in_prerelease && c == '.') {
            end = i + 1;
        } else if i == 0 {
            return None;
        } else {
            break;
        }
    }

    if seen_dot < 2 {
        return None;
    }

    let candidate = &s[..end];
    if semver::parse_semver(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// Classify the compatibility of a found version against the target.
pub fn classify_compat(found: Option<String>, target: &str) -> PolytokenCompat {
    let Some(found) = found else {
        return PolytokenCompat::Missing;
    };

    if !semver::parse_semver(&found) {
        return PolytokenCompat::Unparseable { raw: found };
    }

    match semver::compare_semver(&found, target) {
        Ordering::Less => PolytokenCompat::TooOld {
            found,
            target: target.to_string(),
        },
        Ordering::Equal => PolytokenCompat::Compatible {
            found,
            target: target.to_string(),
            newer_than_target: false,
        },
        Ordering::Greater => PolytokenCompat::Compatible {
            found,
            target: target.to_string(),
            newer_than_target: true,
        },
    }
}

/// Determine the polytoken binary path from the probe result.
///
/// If polytoken was found on PATH during probing, returns "polytoken" (the
/// PATH-resolved name). Otherwise returns None.
pub fn polytoken_path_from_probe(probe: &ProbeResult) -> Option<String> {
    if probe.polytoken_version.is_some() {
        Some("polytoken".into())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `polytoken_compatibility_matrix`
    //! - `polytoken_compat_records_observed_version`

    use super::*;
    use crate::bridge::CommandOutput;

    #[test]
    fn polytoken_compatibility_matrix() {
        let target = "0.5.0-unstable.9";

        // Missing → Missing.
        assert_eq!(classify_compat(None, target), PolytokenCompat::Missing);

        // Too old.
        assert_eq!(
            classify_compat(Some("0.4.2".into()), target),
            PolytokenCompat::TooOld {
                found: "0.4.2".into(),
                target: target.into()
            }
        );

        // Equal.
        assert_eq!(
            classify_compat(Some("0.5.0-unstable.9".into()), target),
            PolytokenCompat::Compatible {
                found: "0.5.0-unstable.9".into(),
                target: target.into(),
                newer_than_target: false
            }
        );

        // Newer.
        assert_eq!(
            classify_compat(Some("0.5.0".into()), target),
            PolytokenCompat::Compatible {
                found: "0.5.0".into(),
                target: target.into(),
                newer_than_target: true
            }
        );

        // Unparseable.
        assert_eq!(
            classify_compat(Some("garbage".into()), target),
            PolytokenCompat::Unparseable {
                raw: "garbage".into()
            }
        );
    }

    #[test]
    fn polytoken_compat_records_observed_version() {
        let compat = classify_compat(Some("0.5.0-unstable.9".into()), "0.5.0-unstable.9");
        match compat {
            PolytokenCompat::Compatible { found, .. } => {
                assert_eq!(found, "0.5.0-unstable.9");
            }
            other => panic!("expected Compatible, got {other:?}"),
        }
    }

    #[test]
    fn extract_version_from_command_output() {
        let output = CommandOutput {
            stdout: "polytoken 0.5.0-unstable.9\n".into(),
            stderr: String::new(),
            exit_code: Some(0),
        };
        assert_eq!(
            extract_version_string(&output).as_deref(),
            Some("0.5.0-unstable.9")
        );

        // Version with build metadata / extra text.
        let output = CommandOutput {
            stdout: "polytoken version 0.5.0-unstable.9 (build abc123)\n".into(),
            stderr: String::new(),
            exit_code: Some(0),
        };
        assert_eq!(
            extract_version_string(&output).as_deref(),
            Some("0.5.0-unstable.9")
        );
    }

    #[test]
    fn extract_version_from_failed_command() {
        let output = CommandOutput {
            stdout: String::new(),
            stderr: "command not found".into(),
            exit_code: Some(127),
        };
        assert!(extract_version_string(&output).is_none());
    }
}
