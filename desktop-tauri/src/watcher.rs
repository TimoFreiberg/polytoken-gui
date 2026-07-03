//! Spawns and babysits the TS update-watcher (`scripts/desktop/update-watcher.ts` in the
//! clone) and turns its machine channel — one JSON object per stdout line — into typed
//! events. If the watcher dies it's respawned after a beat; losing it only costs
//! auto-update, never the app.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::config::PilotConfig;

pub enum WatcherEvent {
    /// An update is staged but a session is live — the shell posts a notification.
    /// `remote` is the target commit sha (dedupe key: the watcher re-emits every tick).
    UpdateDeferred { remote: Option<String> },
    /// One per apply phase: starting → installing? → building → restarting, or failed.
    Apply {
        phase: String,
        label: Option<String>,
    },
}

pub struct Watcher {
    stop: Arc<AtomicBool>,
    child_pid: Arc<AtomicI32>,
}

impl Watcher {
    pub fn start(
        config: Arc<PilotConfig>,
        on_event: impl Fn(WatcherEvent) + Send + 'static,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let child_pid = Arc::new(AtomicI32::new(0));
        {
            let stop = stop.clone();
            let child_pid = child_pid.clone();
            std::thread::spawn(move || run_loop(&config, &stop, &child_pid, &on_event));
        }
        Self { stop, child_pid }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
}

fn run_loop(
    config: &PilotConfig,
    stop: &AtomicBool,
    child_pid: &AtomicI32,
    on_event: &(impl Fn(WatcherEvent) + Send),
) {
    while !stop.load(Ordering::SeqCst) {
        let mut cmd = Command::new(&config.bun_path);
        cmd.args(["run", "scripts/desktop/update-watcher.ts"])
            .current_dir(&config.clone)
            .envs(config.watcher_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        let mut child = match crate::proc::spawn_with_clean_signals(&mut cmd) {
            Ok(c) => c,
            Err(e) => {
                // A missing watcher only costs auto-update, not the app. Log + retry.
                eprintln!("pilot: failed to start update-watcher: {e}");
                if !sleep_unless_stopped(stop, Duration::from_secs(5)) {
                    return;
                }
                continue;
            }
        };
        child_pid.store(child.id() as i32, Ordering::SeqCst);

        if let Some(stdout) = child.stdout.take() {
            // Blocks until the watcher exits (EOF). Chunks aren't line-aligned; BufRead
            // hands us complete lines, matching the watcher's one-JSON-per-line channel.
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(event) = parse_event(&line) {
                    on_event(event);
                }
            }
        }
        let _ = child.wait();
        child_pid.store(0, Ordering::SeqCst);

        // Non-fatal: respawn after a beat so auto-update keeps running.
        if !sleep_unless_stopped(stop, Duration::from_secs(5)) {
            return;
        }
    }
}

fn parse_event(line: &str) -> Option<WatcherEvent> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let str_field = |k: &str| v.get(k).and_then(|s| s.as_str()).map(String::from);
    match v.get("event")?.as_str()? {
        "update-deferred" => Some(WatcherEvent::UpdateDeferred {
            remote: str_field("remote"),
        }),
        "apply" => Some(WatcherEvent::Apply {
            phase: str_field("phase")?,
            label: str_field("label"),
        }),
        // desktop-update-available never fires (we don't pass PILOT_APP_DESKTOP_SHA);
        // restart-requested is the supervisor's respawn path, nothing to render.
        _ => None,
    }
}

fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) -> bool {
    let deadline = std::time::Instant::now() + total;
    while std::time::Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !stop.load(Ordering::SeqCst)
}
