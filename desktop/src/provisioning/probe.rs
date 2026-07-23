//! Remote host probe (Phase 3, step 1).
//!
//! Probes the remote host over SSH to collect OS, architecture, tool
//! availability, and polytoken version information. The probe is a single SSH
//! command emitting one JSON record on the last line of stdout.
//!
//! ## Shell-noise handling
//!
//! Remote shells may emit noise (banner messages, shell init output) before
//! the JSON record. The probe parses only the **last line** of stdout. If the
//! last line isn't valid JSON, it returns [`ProbeError::ParseError`] with the
//! raw tail so the UI can tell the user shell initialization is likely the cause.

// probe_remote is called from the reconcile module; some helpers are only
// used in tests.
#![allow(dead_code)]

use std::io;

use serde::{Deserialize, Serialize};

use crate::bridge::CommandOutput;
use crate::remote_executor::RemoteExecutor;

/// Structured result of probing the remote host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// OS kernel: "linux" | "darwin"
    pub os: String,
    /// Machine architecture: "x86_64" | "aarch64" | "arm64"
    pub arch: String,
    /// Bitness: 64 | 32
    pub bitness: u32,
    /// C library: "glibc" | "musl" | "darwin"
    pub libc: String,
    /// Home directory path.
    pub home_dir: String,
    /// Writable temp directory, if one was found.
    pub writable_temp: Option<String>,
    /// Which tools are available on the remote host.
    pub tools: ProbeTools,
    /// polytoken version from `polytoken --version`, if installed.
    pub polytoken_version: Option<String>,
}

/// Which tools are available on the remote host.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeTools {
    /// `tar` is available (for .tar.gz extraction).
    pub tar: bool,
    /// `unzip` is available (for .zip extraction).
    pub unzip: bool,
    /// `curl` is available.
    pub curl: bool,
    /// `sha256sum` is available.
    pub sha256sum: bool,
}

/// Error from probing the remote host.
#[derive(Debug)]
pub enum ProbeError {
    /// SSH command failed (transport error).
    Ssh(io::Error),
    /// The remote command exited non-zero.
    CommandFailed {
        exit_code: Option<i32>,
        stderr: String,
    },
    /// The last line of stdout wasn't valid JSON.
    ParseError { raw_tail: String },
    /// The target is not supported (e.g. freebsd/amd64).
    UnsupportedTarget { os: String, arch: String },
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Ssh(e) => write!(f, "SSH error during probe: {e}"),
            ProbeError::CommandFailed { exit_code, stderr } => {
                write!(f, "probe command failed (exit {:?}): {}", exit_code, stderr)
            }
            ProbeError::ParseError { raw_tail } => {
                write!(
                    f,
                    "probe output was not valid JSON (shell noise?). Last line: {:?}",
                    raw_tail
                )
            }
            ProbeError::UnsupportedTarget { os, arch } => {
                write!(f, "unsupported target: {os}/{arch}")
            }
        }
    }
}

impl std::error::Error for ProbeError {}

/// The POSIX-sh probe script. Emits a single JSON record on the last line of
/// stdout.
///
/// Collects: `uname -s`, `uname -m`, `getconf LONG_BIT`, libc detection,
/// `$HOME`, `mktemp -d` write test, `command -v` for tools, and
/// `polytoken --version`.
pub const PROBE_SCRIPT: &str = r#"sh -c '
os=$(uname -s | tr "[:upper:]" "[:lower:]")
arch=$(uname -m)
bitness=$(getconf LONG_BIT 2>/dev/null || echo 64)
home_dir="$HOME"
libc="unknown"
if [ "$os" = "linux" ]; then
  if ldd --version 2>&1 | grep -qi musl; then libc="musl"; else libc="glibc"; fi
elif [ "$os" = "darwin" ]; then
  libc="darwin"
fi
writable_temp=""
tmpdir=$(mktemp -d 2>/dev/null) && { echo test > "$tmpdir/.probe" 2>/dev/null && writable_temp="$tmpdir"; rm -rf "$tmpdir"; }
has_tar="false"; command -v tar >/dev/null 2>&1 && has_tar="true"
has_unzip="false"; command -v unzip >/dev/null 2>&1 && has_unzip="true"
has_curl="false"; command -v curl >/dev/null 2>&1 && has_curl="true"
has_sha256sum="false"; command -v sha256sum >/dev/null 2>&1 && has_sha256sum="true"
polytoken_version=""
if command -v polytoken >/dev/null 2>&1; then
  polytoken_version=$(polytoken --version 2>/dev/null | head -1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?" || echo "")
fi
printf "{\"os\":\"%s\",\"arch\":\"%s\",\"bitness\":%s,\"libc\":\"%s\",\"homeDir\":\"%s\",\"writableTemp\":\"%s\",\"tools\":{\"tar\":%s,\"unzip\":%s,\"curl\":%s,\"sha256sum\":%s},\"polytokenVersion\":\"%s\"}\n" \
  "$os" "$arch" "$bitness" "$libc" "$home_dir" "$writable_temp" "$has_tar" "$has_unzip" "$has_curl" "$has_sha256sum" "$polytoken_version"
'"#;

/// Run the probe over SSH and parse the result.
pub async fn probe_remote(executor: &dyn RemoteExecutor) -> Result<ProbeResult, ProbeError> {
    let output = executor
        .run_script(PROBE_SCRIPT.to_owned())
        .await
        .map_err(ProbeError::Ssh)?;

    parse_probe_output(&output)
}

/// Parse the output of the probe command into a [`ProbeResult`].
pub fn parse_probe_output(output: &CommandOutput) -> Result<ProbeResult, ProbeError> {
    if !output.is_success() {
        return Err(ProbeError::CommandFailed {
            exit_code: output.exit_code,
            stderr: output.stderr.clone(),
        });
    }

    // Parse the last non-empty line of stdout.
    let last_line = output
        .stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| ProbeError::ParseError {
            raw_tail: output.stdout.clone(),
        })?;

    let mut result: ProbeResult =
        serde_json::from_str(last_line).map_err(|e| ProbeError::ParseError {
            raw_tail: format!("{last_line} (parse error: {e})"),
        })?;

    // Normalize empty-string polytoken_version to None.
    if result.polytoken_version.as_deref() == Some("") {
        result.polytoken_version = None;
    }
    // Normalize empty-string writable_temp to None.
    if result.writable_temp.as_deref() == Some("") {
        result.writable_temp = None;
    }

    Ok(result)
}

/// Map a [`ProbeResult`] to a published Pantoken helper target triple.
///
/// A Rust target name alone does not make a remote target supported. This
/// mapping intentionally contains only combinations whose helper artifacts are
/// built, embedded, published, and smoke-tested. In particular, musl must not
/// be treated as glibc-compatible and unshipped architectures stay unsupported.
pub fn target_triple(probe: &ProbeResult) -> Result<String, ProbeError> {
    match (probe.os.as_str(), probe.arch.as_str(), probe.libc.as_str()) {
        ("linux", "x86_64", "glibc") => Ok("x86_64-unknown-linux-gnu".into()),
        ("darwin", "aarch64" | "arm64", "darwin") => Ok("aarch64-apple-darwin".into()),
        _ => Err(ProbeError::UnsupportedTarget {
            os: format!("{}/{}", probe.os, probe.libc),
            arch: probe.arch.clone(),
        }),
    }
}

#[cfg(test)]
mod tests {
    //! Named validations:
    //! - `probe_parses_structured_json`
    //! - `probe_rejects_shell_noise`
    //! - `probe_normalizes_target_triples`
    //! - `probe_rejects_unsupported_target`
    //! - `probe_reports_missing_polytoken`

    use super::*;
    use crate::bridge::CommandOutput;

    fn success_output(stdout: &str) -> CommandOutput {
        CommandOutput {
            stdout: stdout.to_string(),
            stderr: String::new(),
            exit_code: Some(0),
        }
    }

    #[test]
    fn probe_parses_structured_json() {
        let json = r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"/tmp/tmp.xxx","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":"0.5.0-unstable.9"}"#;
        let output = success_output(json);
        let result = parse_probe_output(&output).expect("parse");
        assert_eq!(result.os, "linux");
        assert_eq!(result.arch, "x86_64");
        assert_eq!(result.bitness, 64);
        assert_eq!(result.libc, "glibc");
        assert_eq!(result.home_dir, "/home/user");
        assert_eq!(result.writable_temp.as_deref(), Some("/tmp/tmp.xxx"));
        assert!(result.tools.tar);
        assert!(!result.tools.unzip);
        assert!(result.tools.curl);
        assert!(result.tools.sha256sum);
        assert_eq!(
            result.polytoken_version.as_deref(),
            Some("0.5.0-unstable.9")
        );
    }

    #[test]
    fn probe_rejects_shell_noise() {
        // Garbage before JSON line — last line wins.
        let stdout = "Welcome to Ubuntu 22.04\nLast login: ...\n{\"os\":\"linux\",\"arch\":\"x86_64\",\"bitness\":64,\"libc\":\"glibc\",\"homeDir\":\"/home/user\",\"writableTemp\":\"\",\"tools\":{\"tar\":true,\"unzip\":false,\"curl\":true,\"sha256sum\":true},\"polytokenVersion\":\"\"}";
        let output = success_output(stdout);
        let result = parse_probe_output(&output).expect("parse");
        assert_eq!(result.os, "linux");
        assert_eq!(result.arch, "x86_64");
        // Empty strings normalized to None.
        assert!(result.writable_temp.is_none());
        assert!(result.polytoken_version.is_none());
    }

    #[test]
    fn probe_normalizes_target_triples() {
        let cases = [
            ("linux", "x86_64", "glibc", "x86_64-unknown-linux-gnu"),
            ("darwin", "aarch64", "darwin", "aarch64-apple-darwin"),
            ("darwin", "arm64", "darwin", "aarch64-apple-darwin"),
        ];
        for (os, arch, libc, expected) in cases {
            let probe = ProbeResult {
                os: os.into(),
                arch: arch.into(),
                bitness: 64,
                libc: libc.into(),
                home_dir: "/h".into(),
                writable_temp: None,
                tools: ProbeTools::default(),
                polytoken_version: None,
            };
            assert_eq!(target_triple(&probe).unwrap(), expected);
        }
    }

    #[test]
    fn docker_musl_is_explicitly_unsupported() {
        for (os, arch, libc) in [
            ("linux", "x86_64", "musl"),
            ("linux", "aarch64", "glibc"),
            ("darwin", "x86_64", "darwin"),
        ] {
            let probe = ProbeResult {
                os: os.into(),
                arch: arch.into(),
                bitness: 64,
                libc: libc.into(),
                home_dir: "/h".into(),
                writable_temp: None,
                tools: ProbeTools::default(),
                polytoken_version: None,
            };
            assert!(matches!(
                target_triple(&probe),
                Err(ProbeError::UnsupportedTarget { .. })
            ));
        }
    }

    #[test]
    fn probe_rejects_unsupported_target() {
        let probe = ProbeResult {
            os: "freebsd".into(),
            arch: "amd64".into(),
            bitness: 64,
            libc: "unknown".into(),
            home_dir: "/h".into(),
            writable_temp: None,
            tools: ProbeTools::default(),
            polytoken_version: None,
        };
        assert!(matches!(
            target_triple(&probe),
            Err(ProbeError::UnsupportedTarget { .. })
        ));
    }

    #[test]
    fn probe_reports_missing_polytoken() {
        let json = r#"{"os":"linux","arch":"x86_64","bitness":64,"libc":"glibc","homeDir":"/home/user","writableTemp":"","tools":{"tar":true,"unzip":false,"curl":true,"sha256sum":true},"polytokenVersion":""}"#;
        let output = success_output(json);
        let result = parse_probe_output(&output).expect("parse");
        assert!(result.polytoken_version.is_none());
    }

    #[test]
    fn probe_parse_error_on_garbage() {
        let output = success_output("not json at all");
        assert!(matches!(
            parse_probe_output(&output),
            Err(ProbeError::ParseError { .. })
        ));
    }

    #[test]
    fn probe_command_failed_on_nonzero_exit() {
        let output = CommandOutput {
            stdout: String::new(),
            stderr: "command not found".into(),
            exit_code: Some(127),
        };
        assert!(matches!(
            parse_probe_output(&output),
            Err(ProbeError::CommandFailed { .. })
        ));
    }
}
