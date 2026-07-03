//! Process-spawn helper shared by the supervisor and watcher.

use std::process::{Child, Command};

/// Spawn with an EMPTY signal mask. main() blocks SIGTERM/SIGINT process-wide for the
/// sigwait thread, and the mask survives fork+exec — without this reset the hub and
/// watcher would be born deaf to SIGTERM, breaking both our teardown and the watcher's
/// restart-via-pilot.pid contract.
pub fn spawn_with_clean_signals(cmd: &mut Command) -> std::io::Result<Child> {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::pthread_sigmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
            Ok(())
        });
    }
    cmd.spawn()
}
