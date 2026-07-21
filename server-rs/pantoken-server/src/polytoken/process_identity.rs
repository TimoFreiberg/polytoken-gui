//! Process identity verification for safe daemon cleanup (AC.10).
//!
//! When `DaemonClient::kill()` signals a PID captured from `/health`, the daemon
//! may have already died and the OS may have recycled that PID to an unrelated
//! process. Signaling a recycled PID would kill an unrelated process — a safety
//! violation of AC.10 ("cleanup must use pid/start-token identity checks and
//! never kill an unrelated process").
//!
//! This module captures a process start-time token at health-check time and
//! verifies it before signaling. The start time is a monotonic-ish identity
//! token: if the PID was recycled, the new process has a different start time.
//!
//! ## Platform support
//!
//! - **Linux:** reads `/proc/<pid>/stat` field 22 (starttime in clock ticks
//!   since boot). This is the same field `ps` uses for `lstart`.
//! - **macOS:** uses `libc::proc_pidinfo` with `PROC_PIDTASKINFO` to read
//!   `pti_start_time` (absolute time in nanoseconds since epoch). The `libc`
//!   crate links `libproc` on macOS via the system — no new crate dependency.
//! - **Unsupported platforms:** `capture_start_time` returns `None` and
//!   `verify` returns `true` (verification skipped, with a warning logged).
//!
//! ## Testability
//!
//! `verify()` accepts an injectable start-time reader (the `StartTimeReader`
//! trait) so unit tests can simulate PID recycling by returning a different
//! start time on the second call, without relying on OS-level PID reuse.

use tracing::warn;

/// A trait for reading the start time of a process by PID. The default
/// implementation reads from the OS; tests inject a mock implementation to
/// simulate PID recycling.
pub trait StartTimeReader: Send + Sync {
    /// Read the start time of the process with the given PID. Returns `None`
    /// if the process doesn't exist or the start time can't be read.
    fn read_start_time(&self, pid: i32) -> Option<u64>;
}

/// The default OS-level start-time reader. Reads from `/proc` on Linux and
/// `libproc` on macOS.
pub struct OsStartTimeReader;

impl StartTimeReader for OsStartTimeReader {
    fn read_start_time(&self, pid: i32) -> Option<u64> {
        capture_start_time(pid)
    }
}

/// Capture the start time of the process with the given PID.
///
/// Returns `None` on unsupported platforms or if the process doesn't exist.
pub fn capture_start_time(pid: i32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        capture_start_time_linux(pid)
    }
    #[cfg(target_os = "macos")]
    {
        capture_start_time_macos(pid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        warn!(
            "process start-time verification not supported on this platform; \
             kill() identity check skipped"
        );
        None
    }
}

/// Linux: read `/proc/<pid>/stat` field 22 (starttime in clock ticks since boot).
#[cfg(target_os = "linux")]
fn capture_start_time_linux(pid: i32) -> Option<u64> {
    let stat_path = format!("/proc/{pid}/stat");
    let stat_content = std::fs::read_to_string(&stat_path).ok()?;

    // The stat file format is: pid (comm) state ppid ... starttime ...
    // Field 22 is starttime. But `comm` (field 2) can contain spaces and
    // parentheses, so we can't just split on whitespace. We find the last ')'
    // and parse from there.
    let last_paren = stat_content.rfind(')')?;
    let after_comm = &stat_content[last_paren + 1..];
    let fields: Vec<&str> = after_comm.split_whitespace().collect();

    // After the closing paren, the fields are:
    //   [0]=state, [1]=ppid, [2]=pgrp, [3]=session, [4]=tty_nr, [5]=tpgid,
    //   [6]=flags, [7]=minflt, [8]=cminflt, [9]=majflt, [10]=cmajflt,
    //   [11]=utime, [12]=stime, [13]=cutime, [14]=cstime, [15]=priority,
    //   [16]=nice, [17]=num_threads, [18]=itrealvalue, [19]=starttime, ...
    // So starttime is at index 19 (field 22 overall, but we're 0-indexed from
    // after the comm field, and field 1 is pid, field 2 is comm, so field 22
    // is index 19 in our after_comm array).
    let starttime_str = fields.get(19)?;
    starttime_str.parse::<u64>().ok()
}

/// macOS: use `libc::proc_pidinfo` with `PROC_PIDTASKINFO` to read
/// `pti_start_time` (absolute time in nanoseconds since epoch).
#[cfg(target_os = "macos")]
fn capture_start_time_macos(pid: i32) -> Option<u64> {
    use libc::{PROC_PIDTASKINFO, c_int, c_void, proc_pidinfo};

    #[repr(C)]
    struct ProcTaskInfo {
        pti_virtual_size: u64,
        pti_resident_size: u64,
        pti_total_user: u64,
        pti_total_system: u64,
        pti_threads_user: u64,
        pti_threads_system: u64,
        pti_policy: i32,
        pti_faults: i32,
        pti_pageins: i32,
        pti_cow_faults: i32,
        pti_messages_sent: i32,
        pti_messages_received: i32,
        pti_syscalls_mach: i32,
        pti_syscalls_unix: i32,
        pti_csw: i32,
        pti_threadnum: i32,
        pti_numrunning: i32,
        pti_priority: i32,
        /// The process start time in nanoseconds since the epoch. This is the
        /// identity token — if the PID was recycled, this value differs.
        pti_start_time: u64,
        // Remaining fields are padding/unused for our purposes.
        _padding: [u8; 512],
    }

    let mut info = ProcTaskInfo {
        pti_virtual_size: 0,
        pti_resident_size: 0,
        pti_total_user: 0,
        pti_total_system: 0,
        pti_threads_user: 0,
        pti_threads_system: 0,
        pti_policy: 0,
        pti_faults: 0,
        pti_pageins: 0,
        pti_cow_faults: 0,
        pti_messages_sent: 0,
        pti_messages_received: 0,
        pti_syscalls_mach: 0,
        pti_syscalls_unix: 0,
        pti_csw: 0,
        pti_threadnum: 0,
        pti_numrunning: 0,
        pti_priority: 0,
        pti_start_time: 0,
        _padding: [0u8; 512],
    };

    let size = unsafe {
        proc_pidinfo(
            pid as c_int,
            PROC_PIDTASKINFO,
            0,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<ProcTaskInfo>() as c_int,
        )
    };

    if size <= 0 {
        return None;
    }

    Some(info.pti_start_time)
}

/// Verify that the process with `pid` still has the same start time as
/// `stored_start_time`. Returns `true` if the identity matches (safe to
/// signal), `false` if the PID was recycled or no longer exists.
///
/// If `stored_start_time` is `None` (capture failed or unsupported platform),
/// returns `true` (verification skipped — the caller proceeds without
/// identity protection, matching the pre-verification behavior).
pub fn verify(pid: i32, stored_start_time: Option<u64>, reader: &dyn StartTimeReader) -> bool {
    let stored = match stored_start_time {
        Some(t) => t,
        None => {
            // No stored start time — can't verify. Proceed without identity
            // check (the pre-verification behavior). This is the graceful
            // degradation path for unsupported platforms.
            return true;
        }
    };

    match reader.read_start_time(pid) {
        Some(current) => current == stored,
        None => {
            // Process doesn't exist — PID was recycled or died. Don't signal.
            warn!(
                pid,
                "process identity check: PID no longer exists or start time \
                 unreadable; skipping kill to avoid signaling a recycled PID"
            );
            false
        }
    }
}

/// Wait briefly for a process to exit, polling `try_wait`-style. This is a
/// helper for the `dispose_warm` path that uses the `Child` handle — it
/// checks whether the child has already exited before attempting to kill it.
///
/// Returns `true` if the process has exited (skip the kill), `false` if it's
/// still running (safe to kill).
pub async fn child_already_exited(try_wait_fn: impl Fn() -> std::io::Result<Option<i32>>) -> bool {
    match try_wait_fn() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(_) => {
            // Error from try_wait — the process may have been reaped already.
            // Treat as exited to avoid signaling a potentially recycled PID.
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A mock start-time reader that returns configurable values, simulating
    /// PID recycling (different start time on second read).
    struct MockStartTimeReader {
        start_times: Arc<AtomicU64>,
    }

    impl MockStartTimeReader {
        fn new(initial: u64) -> Self {
            Self {
                start_times: Arc::new(AtomicU64::new(initial)),
            }
        }

        fn change_to(&self, new_time: u64) {
            self.start_times.store(new_time, Ordering::SeqCst);
        }
    }

    impl StartTimeReader for MockStartTimeReader {
        fn read_start_time(&self, _pid: i32) -> Option<u64> {
            Some(self.start_times.load(Ordering::SeqCst))
        }
    }

    /// A reader that always returns None (process doesn't exist).
    struct MissingProcessReader;

    impl StartTimeReader for MissingProcessReader {
        fn read_start_time(&self, _pid: i32) -> Option<u64> {
            None
        }
    }

    #[test]
    fn verify_returns_true_when_start_time_matches() {
        let reader = MockStartTimeReader::new(12345);
        assert!(verify(9999, Some(12345), &reader));
    }

    #[test]
    fn verify_returns_false_when_start_time_changed() {
        // Simulate PID recycling: the stored start time was 12345, but the
        // current process at that PID has a different start time (99999).
        let reader = MockStartTimeReader::new(99999);
        assert!(!verify(9999, Some(12345), &reader));
    }

    #[test]
    fn verify_returns_false_when_process_missing() {
        let reader = MissingProcessReader;
        assert!(!verify(9999, Some(12345), &reader));
    }

    #[test]
    fn verify_returns_true_when_no_stored_start_time() {
        // Graceful degradation: no stored start time → skip verification.
        let reader = MissingProcessReader;
        assert!(verify(9999, None, &reader));
    }

    #[test]
    fn verify_simulates_pid_recycling_mid_lifecycle() {
        // Simulate the full lifecycle: capture start time, then the PID gets
        // recycled (new process with different start time).
        let reader = MockStartTimeReader::new(1000);
        let pid = 42;

        // Capture phase: start time is 1000.
        let captured = reader.read_start_time(pid);
        assert_eq!(captured, Some(1000));

        // Verify phase (before kill): still 1000 → safe to signal.
        assert!(verify(pid, captured, &reader));

        // PID gets recycled: new process at the same PID has start time 2000.
        reader.change_to(2000);

        // Verify phase (after recycling): start time changed → NOT safe.
        assert!(!verify(pid, captured, &reader));
    }

    #[tokio::test]
    async fn child_already_exited_returns_true_for_exited_process() {
        // A try_wait that always reports the process exited.
        let result = child_already_exited(|| Ok(Some(0))).await;
        assert!(result);
    }

    #[tokio::test]
    async fn child_already_exited_returns_false_for_running_process() {
        let result = child_already_exited(|| Ok(None)).await;
        assert!(!result);
    }

    #[tokio::test]
    async fn child_already_exited_returns_true_on_error() {
        // An error from try_wait means the process was likely reaped.
        let result = child_already_exited(|| Err(std::io::Error::other("no child process"))).await;
        assert!(result);
    }

    #[test]
    fn os_start_time_reader_returns_some_for_self() {
        // The current process should always have a readable start time on
        // supported platforms (Linux + macOS). On unsupported platforms,
        // capture_start_time returns None and this test is a no-op.
        let pid = std::process::id() as i32;
        let result = capture_start_time(pid);
        // On Linux and macOS, we expect a start time. On other platforms,
        // this returns None — the test still passes (it's a no-op check).
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            assert!(
                result.is_some(),
                "expected start time for self on supported platform"
            );
        }
    }

    #[test]
    fn os_start_time_reader_returns_none_for_nonexistent_pid() {
        // PID 0 is the kernel scheduler (Linux) or never assigned (macOS);
        // a very high PID is almost certainly not in use.
        let pid = 2_000_000;
        let result = capture_start_time(pid);
        assert!(result.is_none(), "expected None for nonexistent PID {pid}");
    }
}
