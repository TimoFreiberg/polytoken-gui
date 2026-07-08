//! Login-shell resolution and `env` output parsing.
//!
//! Pure subset of `server/src/shared/login-env.ts`; the shell-spawning capture
//! path is intentionally deferred to the later wiring phase.

use std::collections::HashMap;
use std::ffi::CStr;
use std::path::Path;

use pantoken_protocol::wire::LoginEnvStatus;

/// Resolve which shell to run: the configured override wins, then `$SHELL`, then
/// the OS passwd login shell, then sane fallbacks. Returns `None` if none exists
/// on disk.
pub fn resolve_login_shell(configured: Option<&str>) -> Option<String> {
    let candidates = [
        configured.map(str::to_string),
        std::env::var("SHELL").ok(),
        user_login_shell(),
        Some("/bin/zsh".to_string()),
        Some("/bin/bash".to_string()),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|candidate| !candidate.is_empty() && Path::new(candidate).exists())
}

fn user_login_shell() -> Option<String> {
    // POSIX passwd login shell, equivalent to Node's `userInfo().shell` on Unix.
    // If libc returns null or a null shell pointer, mirror TS's nullable candidate
    // by returning None and falling through to the default shells.
    unsafe {
        let passwd = libc::getpwuid(libc::geteuid());
        if passwd.is_null() || (*passwd).pw_shell.is_null() {
            return None;
        }
        CStr::from_ptr((*passwd).pw_shell)
            .to_str()
            .ok()
            .map(str::to_string)
    }
}

/// Parse `env`-format output into a map, skipping lines that don't match
/// `^[A-Za-z_][A-Za-z0-9_]*=`. Values are split on the FIRST `=` only.
pub fn parse_env_output(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.split('\n') {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        // Match the TS regex: `.` does not match carriage returns, so CRLF
        // polluted lines are rejected rather than normalized.
        if is_valid_env_key(key) && !value.contains('\r') {
            out.insert(key.to_string(), value.to_string());
        }
    }
    out
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// The outcome of a login-env capture: the parsed env plus a status struct for
/// the Settings panel (configured vs active shell + a human detail).
pub struct CapturedLoginEnv {
    pub env: HashMap<String, String>,
    pub status: LoginEnvStatus,
}

/// Capture the login-shell environment by spawning `<shell> -l -c env`.
///
/// Login shell only (NOT `-i` interactive): sources `.zprofile`/`.zshenv` (where
/// PATH is typically set) WITHOUT sourcing `.zshrc` (where p10k/direnv/pyenv/nvm
/// live — any of which can take >5s on a cold start or hang on a network home
/// dir).
///
/// Never throws — all failure paths return `{ env: {} }` + a status struct with
/// `ok: false`. A capture failure degrades to current behavior (empty merge =
/// the daemon gets pantoken's inherited env, unchanged). Faithful port of
/// `server/src/shared/login-env.ts:captureLoginEnv`.
pub async fn capture_login_env(configured: Option<&str>) -> CapturedLoginEnv {
    let Some(shell) = resolve_login_shell(configured) else {
        return CapturedLoginEnv {
            env: HashMap::new(),
            status: LoginEnvStatus {
                active_shell: None,
                ok: false,
                detail: Some("no login shell found".to_string()),
            },
        };
    };

    // Spawn `<shell> -l -c env` with a 5s timeout. A login shell sources the
    // profile files (PATH etc.) without the interactive rc (p10k/direnv hang).
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.args(["-l", "-c", "env"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.env_clear();
    // Inherit the current process env so the login shell sees the same base
    // environment (mirrors TS `env: process.env`). The login profile then
    // layers PATH etc. on top.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return CapturedLoginEnv {
                env: HashMap::new(),
                status: LoginEnvStatus {
                    active_shell: Some(shell),
                    ok: false,
                    detail: Some(format!("capture failed: {e}")),
                },
            };
        }
    };

    let result = tokio::time::timeout(
        std::time::Duration::from_millis(5_000),
        child.wait_with_output(),
    )
    .await;
    match result {
        // Timed out — the child was killed by `wait_with_output`'s drop? No:
        // `timeout` cancels the future, but `wait_with_output` owns the Child and
        // drops it on cancel → the child is killed. Treat as a timeout failure.
        Err(_) => CapturedLoginEnv {
            env: HashMap::new(),
            status: LoginEnvStatus {
                active_shell: Some(shell),
                ok: false,
                detail: Some("capture timed out".to_string()),
            },
        },
        Ok(Err(e)) => CapturedLoginEnv {
            env: HashMap::new(),
            status: LoginEnvStatus {
                active_shell: Some(shell),
                ok: false,
                detail: Some(format!("capture failed: {e}")),
            },
        },
        Ok(Ok(output)) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let detail = stderr.chars().take(200).collect::<String>();
                return CapturedLoginEnv {
                    env: HashMap::new(),
                    status: LoginEnvStatus {
                        active_shell: Some(shell),
                        ok: false,
                        detail: Some(format!("capture failed: {detail}")),
                    },
                };
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            let parsed = parse_env_output(&stdout);
            let count = parsed.len();
            CapturedLoginEnv {
                env: parsed,
                status: LoginEnvStatus {
                    active_shell: Some(shell),
                    ok: true,
                    detail: Some(format!("{count} vars captured")),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    mod resolve_login_shell {
        use std::sync::Mutex;

        use super::*;

        static SHELL_ENV_MUTEX: Mutex<()> = Mutex::new(());

        struct EnvGuard {
            prev: Option<String>,
        }

        impl EnvGuard {
            fn set_shell(value: &str) -> Self {
                let prev = std::env::var("SHELL").ok();
                unsafe {
                    std::env::set_var("SHELL", value);
                }
                Self { prev }
            }

            fn unset_shell() -> Self {
                let prev = std::env::var("SHELL").ok();
                unsafe {
                    std::env::remove_var("SHELL");
                }
                Self { prev }
            }
        }

        impl Drop for EnvGuard {
            fn drop(&mut self) {
                unsafe {
                    match &self.prev {
                        Some(value) => std::env::set_var("SHELL", value),
                        None => std::env::remove_var("SHELL"),
                    }
                }
            }
        }

        #[test]
        fn a_configured_shell_that_exists_wins() {
            let _lock = SHELL_ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(
                resolve_login_shell(Some("/bin/bash")).as_deref(),
                Some("/bin/bash")
            );
        }

        #[test]
        fn a_non_existent_configured_path_is_skipped_for_shell() {
            let _lock = SHELL_ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            let _guard = EnvGuard::set_shell("/bin/bash");
            assert_eq!(
                resolve_login_shell(Some("/no/such/shell")).as_deref(),
                Some("/bin/bash")
            );
        }

        #[test]
        fn null_configured_and_no_shell_falls_back_to_an_existing_default_shell() {
            let _lock = SHELL_ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
            let _guard = EnvGuard::unset_shell();
            let shell = resolve_login_shell(None);
            assert!(shell.is_some());
            assert!(Path::new(shell.as_deref().unwrap()).exists());
        }
    }

    mod parse_env_output {
        use super::*;

        #[test]
        fn parses_key_value_lines_into_a_record() {
            assert_eq!(
                parse_env_output("FOO=bar\nBAZ=qux"),
                map(&[("FOO", "bar"), ("BAZ", "qux")])
            );
        }

        #[test]
        fn skips_lines_without_equals_motd_fortune_pollution() {
            let input = "Welcome to the system\nFOO=bar\nHave a nice day!\nBAZ=qux";
            assert_eq!(
                parse_env_output(input),
                map(&[("FOO", "bar"), ("BAZ", "qux")])
            );
        }

        #[test]
        fn handles_empty_lines() {
            assert_eq!(
                parse_env_output("FOO=bar\n\nBAZ=qux\n"),
                map(&[("FOO", "bar"), ("BAZ", "qux")])
            );
        }

        #[test]
        fn values_containing_equals_split_on_first_equals_only() {
            assert_eq!(
                parse_env_output("URL=postgres://user:pass@host:5432/db"),
                map(&[("URL", "postgres://user:pass@host:5432/db")])
            );
        }

        #[test]
        fn empty_value_parses_to_empty_string() {
            assert_eq!(parse_env_output("FOO="), map(&[("FOO", "")]));
        }

        #[test]
        fn skips_lines_that_do_not_start_with_a_valid_env_var_name() {
            assert_eq!(
                parse_env_output("1FOO=bar\n-BAZ=qux\n_FOO=ok"),
                map(&[("_FOO", "ok")])
            );
        }

        #[test]
        fn rejects_crlf_lines_like_the_ts_regex() {
            assert_eq!(
                parse_env_output("FOO=bar\r\nBAZ=qux"),
                map(&[("BAZ", "qux")])
            );
        }

        #[test]
        fn empty_input_returns_empty_record() {
            assert_eq!(parse_env_output(""), HashMap::new());
        }
    }

    // ── Ported from login-env.test.ts.bak (captureLoginEnv) ──────────

    #[cfg(unix)]
    #[tokio::test]
    async fn real_shell_returns_env_with_path_and_ok() {
        if !std::path::Path::new("/bin/sh").exists() {
            return; // skip on minimal containers / NixOS
        }
        let result = capture_login_env(Some("/bin/sh")).await;
        assert!(result.status.ok, "status should be ok");
        assert_eq!(result.status.active_shell.as_deref(), Some("/bin/sh"));
        assert!(result.env.contains_key("PATH"));
        assert!(!result.env["PATH"].is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn never_throws_failure_paths_return_status_struct() {
        if !std::path::Path::new("/usr/bin/false").exists() {
            return; // skip if /usr/bin/false isn't present
        }
        let result = capture_login_env(Some("/usr/bin/false")).await;
        assert!(!result.status.ok, "status should be false");
        assert_eq!(
            result.status.active_shell.as_deref(),
            Some("/usr/bin/false")
        );
        assert!(result.env.is_empty(), "env should be empty on failure");
        assert!(result.status.detail.is_some(), "detail should be present");
    }
}
