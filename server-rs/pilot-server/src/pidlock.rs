//! PID lock + stable server identity. Nothing structurally stops two pilot
//! processes from sharing one data dir, and if they do they fight over the
//! archive/worktree/push stores and — the real hazard — the VAPID keypair,
//! whose regeneration silently invalidates every phone's push subscription.
//! So on startup we take an exclusive lock at `dataDir/pilot.pid`.
//!
//! House failure philosophy: a double-start should fail LOUD and diagnosable,
//! not clobber. A lock held by a LIVE process aborts startup with the offending
//! pid + data dir named; a STALE lock (its pid is gone) is reclaimed silently —
//! that's a crash/kill leftover, not a conflict.
//!
//! Port of `server/src/pidlock.ts`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Parsed contents of a pilot.pid lock file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    pub pid: i64,
    /// server-id of the holder, if it was recorded (older locks may omit it).
    #[serde(rename = "serverId", skip_serializing_if = "Option::is_none", default)]
    pub server_id: Option<String>,
}

/// Parse a lock file's text into a LockInfo, or None if it's unusable (empty,
/// garbage, or a non-positive pid). A None parse is treated as "no valid lock"
/// by the caller — i.e. reclaimable — because an unparseable lock can't name a
/// live process to defer to.
///
/// The on-disk format is a single JSON object; we also accept a bare integer for
/// forward/backward tolerance.
pub fn parse_lock(text: &str) -> Option<LockInfo> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Try JSON parse first
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let pid = if parsed.is_number() {
            parsed.as_i64()
        } else if parsed.is_object() {
            parsed.get("pid").and_then(|v| v.as_i64())
        } else {
            None
        };
        let server_id = parsed
            .get("serverId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(pid) = pid {
            if pid > 0 {
                return Some(LockInfo { pid, server_id });
            }
        }
    }
    // Tolerate a bare integer that isn't valid JSON-as-written
    if let Ok(pid) = trimmed.parse::<i64>() {
        if pid > 0 {
            return Some(LockInfo {
                pid,
                server_id: None,
            });
        }
    }
    None
}

/// Is `pid` a live process we should defer to? Uses signal 0, which performs the
/// permission/existence checks without delivering a signal.
///   - ESRCH -> no such process            -> dead
///   - EPERM -> exists but not ours to signal -> ALIVE (treat as live)
///   - ok    -> alive
pub fn is_pid_alive(pid: i64) -> bool {
    // signal 0 is a standard Unix "check if process exists" idiom.
    // It doesn't actually deliver a signal.
    let result = libc_kill(pid, 0);
    if result == 0 {
        true
    } else {
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        // EPERM = 1 (exists but not ours), ESRCH = 3 (no such process)
        errno == libc::EPERM
    }
}

/// Decide what to do with an existing lock given the current pid.
///   - no/empty/garbage lock      -> "reclaim"
///   - lock pid is us             -> "reclaim" (re-entrant; e.g. --hot reload)
///   - lock pid is a live process -> "live"   (caller must abort)
///   - lock pid is dead           -> "reclaim"
pub fn lock_decision(existing: Option<&LockInfo>, self_pid: i64) -> &'static str {
    let Some(lock) = existing else {
        return "reclaim";
    };
    if lock.pid == self_pid {
        return "reclaim";
    }
    if is_pid_alive(lock.pid) {
        "live"
    } else {
        "reclaim"
    }
}

/// Error thrown when a live lock blocks startup. Carries the data for a clear log.
#[derive(Debug)]
pub struct LockHeldError {
    pub pid: i64,
    pub data_dir: PathBuf,
    pub lock_path: PathBuf,
}

impl std::fmt::Display for LockHeldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "pilot is already running: pid {} holds the lock at {} (data dir {}). \
             Refusing to start a second server on the same data dir — two servers \
             would corrupt the archive/worktree/push stores and regenerating the \
             VAPID keypair would invalidate every phone's push subscription. \
             Stop that process, or point this one at a different PILOT_DATA_DIR.",
            self.pid,
            self.lock_path.display(),
            self.data_dir.display()
        )
    }
}

impl std::error::Error for LockHeldError {}

/// A handle to the PID lock. Call `release()` on shutdown.
pub struct PidLock {
    pub path: PathBuf,
    pub pid: i64,
    pub server_id: String,
    released: bool,
}

impl PidLock {
    /// Remove our lock file (idempotent). Safe to call from shutdown handlers.
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        // Only unlink if it's still ours — never delete a lock another process
        // took over after we wrote ours.
        if let Ok(text) = fs::read_to_string(&self.path) {
            if let Some(cur) = parse_lock(&text) {
                if cur.pid != self.pid {
                    return; // another process took over
                }
            }
        }
        let _ = fs::remove_file(&self.path);
    }
}

impl Drop for PidLock {
    fn drop(&mut self) {
        self.release();
    }
}

/// Acquire the PID lock at `dataDir/pilot.pid`, reclaiming a stale one and
/// returning an error if a live process holds it. Writes our pid + serverId.
/// The caller is responsible for wiring `release()` to shutdown (or just
/// dropping the handle — Drop calls release).
pub fn acquire_pid_lock(
    data_dir: &Path,
    server_id: &str,
    self_pid: i64,
) -> Result<PidLock, LockHeldError> {
    fs::create_dir_all(data_dir).ok();
    let lock_path = data_dir.join("pilot.pid");

    let existing = fs::read_to_string(&lock_path)
        .ok()
        .and_then(|text| parse_lock(&text));

    if lock_decision(existing.as_ref(), self_pid) == "live" {
        let lock = existing.unwrap();
        return Err(LockHeldError {
            pid: lock.pid,
            data_dir: data_dir.to_path_buf(),
            lock_path,
        });
    }

    let lock_info = LockInfo {
        pid: self_pid,
        server_id: Some(server_id.to_string()),
    };
    let json = serde_json::to_string(&lock_info).unwrap_or_else(|_| format!("{}", self_pid));
    fs::write(&lock_path, &json).ok();

    Ok(PidLock {
        path: lock_path,
        pid: self_pid,
        server_id: server_id.to_string(),
        released: false,
    })
}

/// Mint-or-read the stable server-id for a data dir. Created once (random 16-byte
/// hex) and persisted at `dataDir/server-id`; every later read returns the same
/// value. Trims whitespace and treats an empty/whitespace file as absent (so a
/// truncated write self-heals on the next read).
pub fn mint_or_read_server_id(data_dir: &Path) -> io::Result<String> {
    fs::create_dir_all(data_dir)?;
    let id_path = data_dir.join("server-id");
    if id_path.exists() {
        if let Ok(existing) = fs::read_to_string(&id_path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    // Generate a random 16-byte hex id
    let id = random_hex(16);
    fs::write(&id_path, &id)?;
    Ok(id)
}

fn random_hex(bytes: usize) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Simple non-cryptographic randomness — server-id is for log attribution,
    // not a security boundary. Mix in PID + nanoseconds for uniqueness.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id() as u128;
    let mut state = now ^ (pid << 64);
    // Avoid all-zero state (would cause xorshift to stuck at 0)
    if state == 0 {
        state = 0xDEADBEEFCAFEBABE;
    }
    let mut bytes_out = Vec::with_capacity(bytes);
    for _ in 0..bytes {
        // xorshift64* — fast, adequate for a non-crypto id
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        // Use wrapping_mul to avoid overflow panic; we only take the high 32 bits
        bytes_out.push(((state.wrapping_mul(0x2545F4914F6CDD1D)) >> 32) as u8);
    }
    bytes_out.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Wrapper around libc::kill for signal 0 check.
/// We use the `libc` crate for cross-platform signal constants.
#[cfg(unix)]
fn libc_kill(pid: i64, sig: i32) -> i32 {
    unsafe { libc::kill(pid as i32, sig) }
}

#[cfg(not(unix))]
fn libc_kill(_pid: i64, _sig: i32) -> i32 {
    // On non-Unix, we can't check process liveness via signals.
    // Treat all locks as reclaimable — not ideal, but pilot is Unix-only in practice.
    -1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lock_json_object() {
        let lock = parse_lock(r#"{"pid": 12345, "serverId": "abc"}"#).unwrap();
        assert_eq!(lock.pid, 12345);
        assert_eq!(lock.server_id, Some("abc".into()));
    }

    #[test]
    fn parse_lock_json_object_without_server_id() {
        let lock = parse_lock(r#"{"pid": 12345}"#).unwrap();
        assert_eq!(lock.pid, 12345);
        assert_eq!(lock.server_id, None);
    }

    #[test]
    fn parse_lock_bare_integer() {
        let lock = parse_lock("12345\n").unwrap();
        assert_eq!(lock.pid, 12345);
    }

    #[test]
    fn parse_lock_bare_integer_as_json() {
        let lock = parse_lock("12345").unwrap();
        assert_eq!(lock.pid, 12345);
    }

    #[test]
    fn parse_lock_empty_returns_none() {
        assert!(parse_lock("").is_none());
        assert!(parse_lock("   \n  ").is_none());
    }

    #[test]
    fn parse_lock_garbage_returns_none() {
        assert!(parse_lock("not a number or json").is_none());
    }

    #[test]
    fn parse_lock_non_positive_pid_returns_none() {
        assert!(parse_lock("0").is_none());
        assert!(parse_lock("-1").is_none());
        assert!(parse_lock(r#"{"pid": 0}"#).is_none());
    }

    #[test]
    fn lock_decision_reclaim_for_none() {
        assert_eq!(lock_decision(None, 100), "reclaim");
    }

    #[test]
    fn lock_decision_reclaim_for_self() {
        let lock = LockInfo {
            pid: 100,
            server_id: None,
        };
        assert_eq!(lock_decision(Some(&lock), 100), "reclaim");
    }

    #[test]
    fn lock_decision_reclaim_for_dead_pid() {
        // PID 999999 is very unlikely to exist
        let lock = LockInfo {
            pid: 999999,
            server_id: None,
        };
        // This test may be flaky if PID 999999 happens to exist, but that's extremely unlikely
        assert_eq!(lock_decision(Some(&lock), 100), "reclaim");
    }

    #[test]
    fn mint_or_read_server_id_creates_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let id1 = mint_or_read_server_id(dir.path()).unwrap();
        assert!(!id1.is_empty());
        // Second read should return the same id
        let id2 = mint_or_read_server_id(dir.path()).unwrap();
        assert_eq!(id1, id2);
    }

    #[test]
    fn mint_or_read_server_id_self_heals_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let id_path = dir.path().join("server-id");
        fs::write(&id_path, "   \n  ").unwrap();
        let id = mint_or_read_server_id(dir.path()).unwrap();
        assert!(!id.is_empty());
        // Should have overwritten the truncated file
        let written = fs::read_to_string(&id_path).unwrap();
        assert_eq!(written, id);
    }

    #[test]
    fn acquire_pid_lock_succeeds_on_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let lock = acquire_pid_lock(dir.path(), "test-id", 12345).unwrap();
        assert_eq!(lock.pid, 12345);
        assert_eq!(lock.server_id, "test-id");

        // Verify file was written
        let text = fs::read_to_string(&lock.path).unwrap();
        let parsed = parse_lock(&text).unwrap();
        assert_eq!(parsed.pid, 12345);
        assert_eq!(parsed.server_id, Some("test-id".into()));
    }

    #[test]
    fn acquire_pid_lock_reclaims_stale() {
        let dir = tempfile::tempdir().unwrap();
        // Write a stale lock (dead pid)
        fs::write(dir.path().join("pilot.pid"), r#"{"pid": 999999}"#).unwrap();
        let lock = acquire_pid_lock(dir.path(), "test-id", 12345).unwrap();
        assert_eq!(lock.pid, 12345);
    }

    #[test]
    fn acquire_pid_lock_reclaims_self() {
        let dir = tempfile::tempdir().unwrap();
        // Write a lock with our own pid
        fs::write(dir.path().join("pilot.pid"), r#"{"pid": 12345}"#).unwrap();
        let lock = acquire_pid_lock(dir.path(), "test-id", 12345).unwrap();
        assert_eq!(lock.pid, 12345);
    }

    #[test]
    fn pid_lock_release_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut lock = acquire_pid_lock(dir.path(), "test-id", 12345).unwrap();
        lock.release();
        assert!(!lock.path.exists());
    }

    #[test]
    fn pid_lock_release_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let mut lock = acquire_pid_lock(dir.path(), "test-id", 12345).unwrap();
        lock.release();
        lock.release(); // should not panic
    }

    #[test]
    fn pid_lock_release_does_not_delete_other_process_lock() {
        let dir = tempfile::tempdir().unwrap();
        let mut lock = acquire_pid_lock(dir.path(), "test-id", 12345).unwrap();
        // Simulate another process taking over
        fs::write(&lock.path, r#"{"pid": 99999, "serverId": "other"}"#).unwrap();
        lock.release();
        // The other process's lock should still be there
        assert!(lock.path.exists());
    }
}
