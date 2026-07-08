//! Owns the lifecycle of the local pilot server process, plus the liveness loop the ADR
//! asked for: spawn, gate on /health, poll for liveness, respawn on crash with a
//! crash-loop breaker, SIGTERM → bounded wait → SIGKILL on teardown.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config::PilotConfig;

pub enum SupervisorEvent {
    /// Server answered /health. `first_time` → initial boot (load the web client);
    /// otherwise it just came back from a restart (reload to pick up new client assets).
    Healthy { first_time: bool },
    /// Initial boot never got healthy, or it's crash-looping. Fatal.
    Unrecoverable(String),
}

/// Strikes before a crash-loop is declared unrecoverable (exits with <5s uptime).
const MAX_RAPID_RESTARTS: u32 = 5;
/// Initial-boot health deadline.
const BOOT_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Consecutive liveness-probe failures (5s apart) before we SIGTERM a hung-but-running
/// server and let the respawn path recover it.
const LIVENESS_STRIKES: u32 = 6;

pub struct Supervisor {
    stop: Arc<AtomicBool>,
    child_pid: Arc<AtomicI32>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Supervisor {
    pub fn start(
        config: Arc<PilotConfig>,
        on_event: impl Fn(SupervisorEvent) + Send + 'static,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let child_pid = Arc::new(AtomicI32::new(0));
        let thread = {
            let stop = stop.clone();
            let child_pid = child_pid.clone();
            std::thread::spawn(move || run_loop(&config, &stop, &child_pid, &on_event))
        };
        Self {
            stop,
            child_pid,
            thread: Some(thread),
        }
    }

    /// SIGTERM the server; the run loop sees the exit and respawns it (uptime was real, so
    /// the crash-loop counter resets). Used by the tray's "Restart Hub".
    pub fn restart_hub(&self) {
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }

    /// SIGTERM the server and stop respawning (app quit). Blocks briefly for a clean exit;
    /// escalates to SIGKILL if the server ignores SIGTERM.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run_loop(
    config: &PilotConfig,
    stop: &AtomicBool,
    child_pid: &AtomicI32,
    on_event: &(impl Fn(SupervisorEvent) + Send),
) {
    let mut started = false; // have we ever been healthy?
    let mut rapid_restarts: u32 = 0;

    while !stop.load(Ordering::SeqCst) {
        let spawn_time = Instant::now();
        // The compiled Rust server sidecar, cwd'd to the data dir (the server resolves
        // every path it needs from env — cwd just has to exist and stay valid across
        // updates).
        let mut cmd = Command::new(&config.hub_bin);
        cmd.current_dir(&config.data_dir);
        cmd.envs(config.server_env()).stdin(Stdio::null());
        let mut child = match crate::proc::spawn_with_clean_signals(&mut cmd) {
            Ok(c) => c,
            Err(e) => {
                let what = format!(
                    "Couldn't launch the pilot server at {}: {e}",
                    config.hub_bin.display()
                );
                on_event(SupervisorEvent::Unrecoverable(what));
                return;
            }
        };
        child_pid.store(child.id() as i32, Ordering::SeqCst);

        supervise_one(config, stop, &mut child, &mut started, on_event);

        child_pid.store(0, Ordering::SeqCst);
        if stop.load(Ordering::SeqCst) {
            reap(&mut child);
            return;
        }
        let _ = child.wait();

        // KeepAlive with a crash-loop guard: a quick exit (<5s uptime) counts toward the
        // strike limit; a restart after real uptime (e.g. a tray-menu restart) resets it.
        let uptime = spawn_time.elapsed();
        rapid_restarts = if uptime < Duration::from_secs(5) {
            rapid_restarts + 1
        } else {
            0
        };
        if rapid_restarts > MAX_RAPID_RESTARTS {
            let hint = format!(
                "Check the hub log at {} — the bundled hub may be refusing a locked \
                 data dir or crashing at startup.",
                config.data_dir.join("pilot.log").display()
            );
            on_event(SupervisorEvent::Unrecoverable(format!(
                "The pilot server keeps exiting right after launch. {hint}"
            )));
            return;
        }
        let delay = Duration::from_secs(rapid_restarts.min(3) as u64);
        if !sleep_unless_stopped(stop, delay) {
            reap(&mut child);
            return;
        }
    }
}

/// Drive one child process: gate on /health (fatal if the *initial* boot never gets
/// there), report healthy, then run the liveness loop until the child exits or a hung
/// server earns a SIGTERM. Returns when the child is gone (caller reaps + respawns).
fn supervise_one(
    config: &PilotConfig,
    stop: &AtomicBool,
    child: &mut Child,
    started: &mut bool,
    on_event: &(impl Fn(SupervisorEvent) + Send),
) {
    let port = config.server_port;
    let boot_deadline = Instant::now() + BOOT_HEALTH_TIMEOUT;
    let mut healthy = false;
    let mut liveness_failures: u32 = 0;
    let mut next_probe = Instant::now();

    loop {
        if stop.load(Ordering::SeqCst) {
            terminate(child);
            return;
        }
        match child.try_wait() {
            Ok(Some(_)) => return, // exited — caller handles respawn policy
            Ok(None) => {}
            Err(_) => return,
        }

        if Instant::now() >= next_probe {
            if health_ok(port) {
                liveness_failures = 0;
                if !healthy {
                    healthy = true;
                    let first_time = !*started;
                    *started = true;
                    on_event(SupervisorEvent::Healthy { first_time });
                }
                next_probe = Instant::now() + Duration::from_secs(5);
            } else if healthy {
                // Was healthy, now probing dead: a hung server. Give it LIVENESS_STRIKES
                // consecutive misses (probes 5s apart) before forcing a restart.
                liveness_failures += 1;
                if liveness_failures >= LIVENESS_STRIKES {
                    terminate(child);
                    return;
                }
                next_probe = Instant::now() + Duration::from_secs(5);
            } else {
                // Still waiting for the first health of this child.
                if !*started && Instant::now() > boot_deadline {
                    on_event(SupervisorEvent::Unrecoverable(format!(
                        "The pilot server didn't become healthy within {}s.",
                        BOOT_HEALTH_TIMEOUT.as_secs()
                    )));
                    terminate(child);
                    return;
                }
                next_probe = Instant::now() + Duration::from_millis(250);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// GET /health over a raw loopback socket — std-only, tight timeouts, no async runtime.
fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let req =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    // The status line arrives in the first segment on loopback; read once and check it.
    let mut buf = [0u8; 128];
    match s.read(&mut buf) {
        Ok(n) if n > 0 => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"),
        _ => false,
    }
}

/// SIGTERM, wait up to 5s, then SIGKILL. The server exits cleanly on SIGTERM (releases
/// its pidlock, shuts daemons down); the KILL is a last resort so quit can't hang.
fn terminate(child: &mut Child) {
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn reap(child: &mut Child) {
    terminate(child);
}

/// Sleep in small ticks so a stop request interrupts promptly. Returns false if stopped.
fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !stop.load(Ordering::SeqCst)
}
