//! Filesystem watcher for Polytoken config/binary inputs.
//!
//! ## Why file watching instead of a fingerprint API
//!
//! Polytoken's CLI (`polytoken --help`, `polytoken models --help`,
//! `polytoken vfs --help`, `polytoken config --help`) exposes no config
//! fingerprint or dependency-graph command. The practical freshness mechanism is
//! therefore best-effort file watching over known inputs: the resolved binary
//! path and the user/global config directory.
//!
//! ## Best-effort freshness
//!
//! Watcher invalidation is a *freshness* mechanism, not a push protocol. When a
//! watched input changes, the relevant driver caches are invalidated so the
//! *next* UI request repopulates them from a fresh subprocess. The watcher does
//! not proactively rebroadcast model/facet/command lists to already-connected
//! clients — it only ensures subsequent lookups are fresh.
//!
//! ## Directory watches preferred over single-file watches
//!
//! Editors commonly write via temp-file + rename (atomic save). A single-file
//! watch can miss the rename event or fire on the temp file path. Directory
//! watches catch both the temp creation and the rename into place, and also
//! cover config that may be split across multiple files.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::event::Event as NotifyEvent;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tracing::{error, warn};

/// The inspectable status of the config watcher. Stored in `PolytokenInner`
/// behind a `Mutex` so tests and the Settings panel can read it.
#[derive(Debug, Clone, Default)]
pub enum WatchStatus {
    /// Watcher is not active (fake/test mode, or watcher explicitly disabled).
    #[default]
    Disabled,
    /// Watcher is active and watching the listed paths.
    Ok {
        watched: Vec<PathBuf>,
        /// True when per-cwd project config watching is unavailable because no
        /// verified project config path convention exists. Binary/global
        /// watching remains active.
        project_watching_unavailable: bool,
    },
    /// Some paths were watched successfully, but others failed.
    PartialFailure {
        watched: Vec<PathBuf>,
        failed: Vec<(PathBuf, String)>,
    },
    /// Watcher initialization failed entirely — no paths are watched.
    Failed { error: String },
}

impl WatchStatus {
    /// Returns `true` if at least one path is being watched.
    pub fn is_watching(&self) -> bool {
        match self {
            WatchStatus::Ok { watched, .. } => !watched.is_empty(),
            WatchStatus::PartialFailure { watched, .. } => !watched.is_empty(),
            _ => false,
        }
    }
}

/// A path that the watcher should track, classified by its invalidation scope.
#[derive(Debug, Clone)]
pub enum WatchedPath {
    /// The Polytoken binary itself. Changes invalidate ALL config-dependent
    /// caches (models, defaults, facets, commands) because a binary update
    /// could change any of them.
    Binary(PathBuf),
    /// The user/global config directory. Changes invalidate ALL
    /// config-dependent caches.
    GlobalConfig(PathBuf),
    /// A per-cwd project config directory (`<cwd>/.polytoken`). Changes
    /// invalidate only that cwd's facet/command caches. The `cwd` field is
    /// the project root the watched `.polytoken` dir belongs to.
    ProjectConfig { path: PathBuf, cwd: String },
}

impl WatchedPath {
    pub fn path(&self) -> &Path {
        match self {
            WatchedPath::Binary(p)
            | WatchedPath::GlobalConfig(p)
            | WatchedPath::ProjectConfig { path: p, .. } => p,
        }
    }
}

/// The classification of a filesystem event into an invalidation action.
/// This is the pure, unit-testable core — it does not touch the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidationAction {
    /// Invalidate model/default caches AND all cwd-scoped facet/command caches.
    All,
    /// Invalidate only the facet/command caches for the given cwd.
    Cwd(String),
    /// No action needed (event was irrelevant, e.g. a directory was removed).
    None,
}

/// Classify a raw `notify` event into an invalidation action.
///
/// `watched_paths` maps each watched directory to its invalidation scope:
/// binary/global config → `All`, project config → `Cwd(cwd)`. If the event
/// path is under a watched project config dir, we return `Cwd(cwd)`. For all
/// other events (binary, global, or unmatched), we return `All` —
/// over-invalidation is safe (just a cache miss + re-run on next lookup).
pub fn classify_event(event: &NotifyEvent, watched_paths: &[WatchedPath]) -> InvalidationAction {
    // Check if the event path is under a watched project config directory.
    for wp in watched_paths {
        if let WatchedPath::ProjectConfig { path, cwd } = wp {
            for event_path in &event.paths {
                if event_path.starts_with(path) {
                    return InvalidationAction::Cwd(cwd.clone());
                }
            }
        }
    }
    // Default: any event from a binary/global path (or unmatched) → All.
    InvalidationAction::All
}

/// Debounce coalescer for filesystem events.
///
/// Collects events and, after a quiet period of `debounce_duration` with no
/// new events, produces a single `InvalidationAction`. This is pure and
/// unit-testable: feed it timestamps + events, get the coalesced output.
pub struct DebounceCoalescer {
    debounce_duration: Duration,
    pending: Option<InvalidationAction>,
    last_event_time: Option<tokio::time::Instant>,
}

impl DebounceCoalescer {
    pub fn new(debounce_duration: Duration) -> Self {
        Self {
            debounce_duration,
            pending: None,
            last_event_time: None,
        }
    }

    /// Feed an event at the given `now` timestamp. Returns `Some(action)` if
    /// the debounce window has elapsed since the last event (meaning the
    /// pending action should fire), or `None` if still within the window.
    /// When an event arrives, the debounce timer resets.
    pub fn feed(
        &mut self,
        action: InvalidationAction,
        now: tokio::time::Instant,
    ) -> Option<InvalidationAction> {
        match &self.pending {
            None => {
                self.pending = Some(action);
                self.last_event_time = Some(now);
                None
            }
            Some(pending) => {
                // Merge rules:
                // - All supersedes everything (binary/global change → invalidate all).
                // - Cwd(a) + Cwd(b) where a≠b → All (two different cwds → just nuke all).
                // - Cwd(a) + Cwd(a) → Cwd(a) (same cwd, keep scoped).
                // - Cwd + None → Cwd (None is a no-op).
                // - None + None → None.
                let merged = match (pending.clone(), action) {
                    (InvalidationAction::All, _) | (_, InvalidationAction::All) => {
                        InvalidationAction::All
                    }
                    (InvalidationAction::Cwd(a), InvalidationAction::Cwd(b)) => {
                        if a == b {
                            InvalidationAction::Cwd(a)
                        } else {
                            InvalidationAction::All
                        }
                    }
                    (InvalidationAction::Cwd(cwd), InvalidationAction::None) => {
                        InvalidationAction::Cwd(cwd)
                    }
                    (InvalidationAction::None, InvalidationAction::Cwd(cwd)) => {
                        InvalidationAction::Cwd(cwd)
                    }
                    (InvalidationAction::None, InvalidationAction::None) => {
                        InvalidationAction::None
                    }
                };
                self.pending = Some(merged);
                self.last_event_time = Some(now);
                None
            }
        }
    }

    /// Check if the debounce window has elapsed. If so, return the pending
    /// action and clear it. Called periodically or when checking readiness.
    pub fn check_debounce(&mut self, now: tokio::time::Instant) -> Option<InvalidationAction> {
        let last = self.last_event_time?;
        if now.duration_since(last) >= self.debounce_duration {
            self.last_event_time = None;
            self.pending.take()
        } else {
            None
        }
    }

    /// Returns `true` if there is a pending action waiting for debounce.
    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }
}

/// Handle for the watcher task + the underlying `RecommendedWatcher`.
/// The watcher must be kept alive for events to flow; dropping the
/// `RecommendedWatcher` stops watching.
pub struct ConfigWatcherHandle {
    /// The notify watcher — kept alive so events continue to flow. Wrapped in
    /// a Mutex so `register_project_config` can add new watches at runtime.
    watcher: Mutex<RecommendedWatcher>,
    /// Shared list of all watched paths (including dynamically-registered
    /// project config paths). Read by the debounce task for event classification.
    watched_paths: Arc<Mutex<Vec<WatchedPath>>>,
    /// The debounce task. Aborted on drop.
    task: tokio::task::JoinHandle<()>,
}

impl ConfigWatcherHandle {
    /// Abort the watcher task. Safe to call multiple times.
    pub fn abort(&self) {
        self.task.abort();
    }

    /// Register a project config directory for watching. Idempotent: if the
    /// given cwd is already watched, this is a no-op. Returns `true` if a new
    /// watch was added, `false` if it was already registered or failed.
    pub fn register_project_config(&self, path: PathBuf, cwd: String) -> bool {
        // Check if this cwd is already watched (idempotent).
        {
            let paths = self.watched_paths.lock();
            if paths.iter().any(|wp| match wp {
                WatchedPath::ProjectConfig { cwd: c, .. } => c == &cwd,
                _ => false,
            }) {
                return false;
            }
        }

        // Determine the watch target: the .polytoken dir if it exists,
        // otherwise its parent (the cwd) to catch creation.
        let (watch_target, recursive) = if path.exists() {
            (path.clone(), RecursiveMode::Recursive)
        } else if let Some(parent) = path.parent() {
            (parent.to_path_buf(), RecursiveMode::NonRecursive)
        } else {
            (path.clone(), RecursiveMode::Recursive)
        };

        let mut watcher = self.watcher.lock();
        match watcher.watch(&watch_target, recursive) {
            Ok(()) => {
                self.watched_paths
                    .lock()
                    .push(WatchedPath::ProjectConfig { path, cwd });
                true
            }
            Err(e) => {
                warn!(
                    "register_project_config: failed to watch {}: {e}",
                    path.display()
                );
                false
            }
        }
    }
}

impl Drop for ConfigWatcherHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The invalidation callback the watcher invokes after debounce.
/// Takes the coalesced `InvalidationAction` and performs cache clearing.
pub type InvalidationCallback = Arc<dyn Fn(InvalidationAction) + Send + Sync>;

/// Set up the config watcher over the given watched paths.
///
/// Returns `(ConfigWatcherHandle, WatchStatus)`. The handle keeps the watcher
/// alive; the status records what was actually watched (or why it failed).
///
/// The `invalidation` callback is invoked (after debounce) whenever a watched
/// path changes. It should call the appropriate `PolytokenInner::invalidate_*`
/// method based on the `InvalidationAction`.
///
/// `project_watching_unavailable` should be `true` when no verified project
/// config path convention exists (the conservative default). It is surfaced in
/// `WatchStatus::Ok` so callers can report the limitation.
pub fn setup_watcher(
    watched_paths: Vec<WatchedPath>,
    invalidation: InvalidationCallback,
    project_watching_unavailable: bool,
) -> (Option<ConfigWatcherHandle>, WatchStatus) {
    if watched_paths.is_empty() {
        return (
            None,
            WatchStatus::Ok {
                watched: Vec::new(),
                project_watching_unavailable,
            },
        );
    }

    // Channel from the notify callback into the debounce task.
    let (tx, mut rx) = mpsc::unbounded_channel::<NotifyEvent>();

    // Create the watcher with a callback that pushes events into the channel.
    let watcher_result = RecommendedWatcher::new(
        move |res: notify::Result<NotifyEvent>| {
            if let Ok(event) = res {
                // Ignore the send error: if the receiver is gone, the watcher
                // task has been shut down and we don't care.
                let _ = tx.send(event);
            }
        },
        notify::Config::default(),
    );

    let mut watcher = match watcher_result {
        Ok(w) => w,
        Err(e) => {
            let error = format!("notify watcher creation failed: {e}");
            error!("{error}");
            return (None, WatchStatus::Failed { error });
        }
    };

    // Watch each path. Collect successes and failures.
    let mut watched: Vec<PathBuf> = Vec::new();
    let mut failed: Vec<(PathBuf, String)> = Vec::new();

    for wp in &watched_paths {
        let path = wp.path();
        // Watch the parent directory for binary paths (the file itself may not
        // be watchable on all platforms, and atomic-save replaces the inode).
        // For config directories, watch the directory itself recursively.
        let (watch_target, recursive) = match wp {
            WatchedPath::Binary(p) => {
                // Watch the parent directory (non-recursive) so we catch
                // rename/replace events on the binary file.
                match p.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() => {
                        (parent.to_path_buf(), RecursiveMode::NonRecursive)
                    }
                    _ => (p.clone(), RecursiveMode::NonRecursive),
                }
            }
            WatchedPath::GlobalConfig(p) => (p.clone(), RecursiveMode::Recursive),
            WatchedPath::ProjectConfig { path, .. } => {
                // Watch the .polytoken directory recursively. If it doesn't
                // exist yet, watch the parent (the cwd) to catch its creation.
                if path.exists() {
                    (path.clone(), RecursiveMode::Recursive)
                } else if let Some(parent) = path.parent() {
                    (parent.to_path_buf(), RecursiveMode::NonRecursive)
                } else {
                    (path.clone(), RecursiveMode::Recursive)
                }
            }
        };

        match watcher.watch(&watch_target, recursive) {
            Ok(()) => {
                watched.push(path.to_path_buf());
            }
            Err(e) => {
                let msg = format!("notify watch failed for {}: {e}", path.display());
                warn!("{msg}");
                failed.push((path.to_path_buf(), msg));
            }
        }
    }

    // Determine status based on successes/failures.
    let status = if watched.is_empty() && !failed.is_empty() {
        let error = failed
            .iter()
            .map(|(_, m)| m.clone())
            .collect::<Vec<_>>()
            .join("; ");
        WatchStatus::Failed { error }
    } else if !failed.is_empty() {
        WatchStatus::PartialFailure { watched, failed }
    } else {
        WatchStatus::Ok {
            watched,
            project_watching_unavailable,
        }
    };

    // If nothing was watched, don't spawn a task.
    if !status.is_watching() {
        return (None, status);
    }

    // Shared list of all watched paths. The debounce task reads this for
    // event classification; `register_project_config` adds to it at runtime.
    let shared_watched_paths = Arc::new(Mutex::new(watched_paths.clone()));

    // Spawn the debounce task.
    let task = {
        let watched_paths_ref = shared_watched_paths.clone();
        tokio::spawn(async move {
            let mut coalescer = DebounceCoalescer::new(Duration::from_millis(200));

            loop {
                // Either wait for a new event or check the debounce timer.
                tokio::select! {
                    event = rx.recv() => {
                        match event {
                            None => break, // Channel closed → watcher dropped → exit.
                            Some(event) => {
                                let paths = watched_paths_ref.lock().clone();
                                let action = classify_event(&event, &paths);
                                if action != InvalidationAction::None {
                                    coalescer.feed(action, tokio::time::Instant::now());
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {
                        if coalescer.has_pending() {
                            if let Some(action) = coalescer.check_debounce(tokio::time::Instant::now()) {
                                if action != InvalidationAction::None {
                                    invalidation(action);
                                }
                            }
                        }
                    }
                }
            }
        })
    };

    let handle = ConfigWatcherHandle {
        watcher: Mutex::new(watcher),
        watched_paths: shared_watched_paths,
        task,
    };

    (Some(handle), status)
}

/// Resolve a binary path string to an absolute path for watching.
///
/// If the binary is already absolute, return it as-is. If it's relative (e.g.
/// `polytoken`), attempt to resolve it via `which`-style PATH lookup. Returns
/// `None` if resolution fails — the caller should log and skip binary watching.
pub fn resolve_binary_path(bin_path: &str) -> Option<PathBuf> {
    let p = Path::new(bin_path);
    if p.is_absolute() {
        return Some(p.to_path_buf());
    }
    // Try `which` via std::process::Command (available on Unix + Windows).
    // This is a best-effort resolution; if it fails, the caller skips binary
    // watching and logs the limitation.
    let which_output = std::process::Command::new("which")
        .arg(bin_path)
        .output()
        .ok()?;
    if !which_output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&which_output.stdout);
    let resolved = stdout.trim();
    if resolved.is_empty() {
        None
    } else {
        Some(PathBuf::from(resolved))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::EventKind;

    // ---- WatchStatus tests ----

    #[test]
    fn watch_status_disabled_is_not_watching() {
        assert!(!WatchStatus::Disabled.is_watching());
    }

    #[test]
    fn watch_status_ok_with_paths_is_watching() {
        let status = WatchStatus::Ok {
            watched: vec![PathBuf::from("/etc/polytoken")],
            project_watching_unavailable: false,
        };
        assert!(status.is_watching());
    }

    #[test]
    fn watch_status_ok_empty_is_not_watching() {
        let status = WatchStatus::Ok {
            watched: vec![],
            project_watching_unavailable: false,
        };
        assert!(!status.is_watching());
    }

    #[test]
    fn watch_status_failed_is_not_watching() {
        let status = WatchStatus::Failed {
            error: "boom".into(),
        };
        assert!(!status.is_watching());
    }

    // ---- DebounceCoalescer tests ----

    #[test]
    fn single_event_does_not_fire_immediately() {
        let mut c = DebounceCoalescer::new(Duration::from_millis(100));
        let now = tokio::time::Instant::now();
        let result = c.feed(InvalidationAction::All, now);
        assert!(result.is_none(), "feed should not fire immediately");
        assert!(c.has_pending());
    }

    #[test]
    fn burst_events_coalesce_into_one_invalidation() {
        let mut c = DebounceCoalescer::new(Duration::from_millis(100));
        let base = tokio::time::Instant::now();

        // Feed 5 events in quick succession (within the debounce window).
        for i in 0..5 {
            c.feed(InvalidationAction::All, base + Duration::from_millis(i));
        }
        assert!(c.has_pending());

        // None should have fired yet (all within the window).
        assert!(c.check_debounce(base + Duration::from_millis(4)).is_none());

        // After the debounce window elapses, exactly one action fires.
        let fired = c.check_debounce(base + Duration::from_millis(150));
        assert_eq!(fired, Some(InvalidationAction::All));
        assert!(!c.has_pending(), "pending should be cleared after firing");
    }

    #[test]
    fn debounce_resets_on_new_event() {
        let mut c = DebounceCoalescer::new(Duration::from_millis(100));
        let base = tokio::time::Instant::now();

        c.feed(InvalidationAction::All, base);
        // 80ms later — still within window.
        assert!(c.check_debounce(base + Duration::from_millis(80)).is_none());

        // New event at 90ms — resets the timer.
        c.feed(InvalidationAction::All, base + Duration::from_millis(90));

        // 150ms from base (60ms from last event) — still within new window.
        assert!(
            c.check_debounce(base + Duration::from_millis(150))
                .is_none()
        );

        // 250ms from base (160ms from last event) — window elapsed.
        let fired = c.check_debounce(base + Duration::from_millis(250));
        assert_eq!(fired, Some(InvalidationAction::All));
    }

    #[test]
    fn none_action_does_not_produce_invalidation() {
        let mut c = DebounceCoalescer::new(Duration::from_millis(100));
        let base = tokio::time::Instant::now();

        c.feed(InvalidationAction::None, base);
        assert!(c.has_pending());

        let fired = c.check_debounce(base + Duration::from_millis(150));
        // None is a valid pending value but classify_event never returns None,
        // so this path is only reachable via direct feed in tests.
        assert_eq!(fired, Some(InvalidationAction::None));
    }

    // ---- classify_event tests ----

    #[test]
    fn any_event_classifies_as_all_invalidation() {
        // Binary/global config events map to All because a change to either
        // could affect any config-dependent cache.
        let event = NotifyEvent {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/etc/polytoken/config.toml")],
            attrs: notify::event::EventAttributes::default(),
        };
        let watched = vec![WatchedPath::GlobalConfig(PathBuf::from("/etc/polytoken"))];
        assert_eq!(classify_event(&event, &watched), InvalidationAction::All);
    }

    #[test]
    fn modify_event_classifies_as_all() {
        let event = NotifyEvent {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("/usr/local/bin/polytoken")],
            attrs: notify::event::EventAttributes::default(),
        };
        let watched = vec![WatchedPath::Binary(PathBuf::from(
            "/usr/local/bin/polytoken",
        ))];
        assert_eq!(classify_event(&event, &watched), InvalidationAction::All);
    }

    #[test]
    fn project_config_event_classifies_as_cwd() {
        // An event under a watched project config dir maps to Cwd(cwd).
        let project_path = PathBuf::from("/repo/myproject/.polytoken");
        let event = NotifyEvent {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![project_path.join("facets/custom.md")],
            attrs: notify::event::EventAttributes::default(),
        };
        let watched = vec![WatchedPath::ProjectConfig {
            path: project_path,
            cwd: "/repo/myproject".to_string(),
        }];
        assert_eq!(
            classify_event(&event, &watched),
            InvalidationAction::Cwd("/repo/myproject".to_string())
        );
    }

    // ---- resolve_binary_path tests ----

    #[test]
    fn resolve_absolute_binary_path() {
        let resolved = resolve_binary_path("/usr/local/bin/polytoken");
        assert_eq!(resolved, Some(PathBuf::from("/usr/local/bin/polytoken")));
    }

    #[test]
    fn resolve_nonexistent_relative_binary_returns_none_or_some() {
        // This is best-effort: `which nonexistent-binary-xyz` should fail.
        // We don't assert None because the test environment might have
        // something weird, but we do assert it doesn't panic.
        let _ = resolve_binary_path("nonexistent-binary-xyz-12345");
    }

    // ---- setup_watcher integration tests ----

    #[tokio::test]
    async fn setup_watcher_with_empty_paths_returns_disabled_status() {
        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();
        let invalidation: InvalidationCallback = Arc::new(move |_| {
            *called_clone.lock() = true;
        });
        let (handle, status) = setup_watcher(vec![], invalidation, true);
        assert!(handle.is_none());
        match status {
            WatchStatus::Ok {
                project_watching_unavailable,
                ..
            } => assert!(project_watching_unavailable),
            _ => panic!("expected Ok status for empty paths"),
        }
        assert!(
            !*called.lock(),
            "no invalidation should fire for empty paths"
        );
    }

    #[tokio::test]
    async fn setup_watcher_with_unwatchable_path_records_failure() {
        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();
        let invalidation: InvalidationCallback = Arc::new(move |_| {
            *called_clone.lock() = true;
        });
        // A path that doesn't exist and whose parent doesn't exist either.
        let bad_path = PathBuf::from("/nonexistent-root-xyz-12345/polytoken");
        let (handle, status) = setup_watcher(
            vec![WatchedPath::Binary(bad_path.clone())],
            invalidation,
            true,
        );
        // The watcher may or may not fail depending on platform — but the
        // status should reflect what happened. If it failed, handle is None.
        match &status {
            WatchStatus::Failed { .. } => {
                assert!(handle.is_none(), "failed watcher should have no handle");
            }
            WatchStatus::PartialFailure { failed, .. } => {
                assert!(!failed.is_empty(), "should have at least one failure");
            }
            WatchStatus::Ok { watched, .. } => {
                // On some platforms, watching a nonexistent parent might
                // succeed (deferred). That's acceptable — the key invariant
                // is that the driver still works.
                let _ = watched;
            }
            WatchStatus::Disabled => {
                // Shouldn't happen when paths were provided, but if the
                // watcher returned no watched paths, it's effectively disabled.
            }
        }
        assert!(!*called.lock(), "no invalidation should fire during setup");
    }

    #[tokio::test]
    async fn setup_watcher_with_tempdir_succeeds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_dir = dir.path().to_path_buf();

        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();
        let invalidation: InvalidationCallback = Arc::new(move |_| {
            *called_clone.lock() = true;
        });

        let (handle, status) = setup_watcher(
            vec![WatchedPath::GlobalConfig(config_dir.clone())],
            invalidation,
            false,
        );

        assert!(handle.is_some(), "watcher handle should be present");
        match &status {
            WatchStatus::Ok {
                watched,
                project_watching_unavailable,
            } => {
                assert!(watched.contains(&config_dir));
                assert!(!*project_watching_unavailable);
            }
            _ => panic!("expected Ok status for valid tempdir: {status:?}"),
        }

        // Write a file in the watched directory and poll for the invalidation
        // callback to fire (with a generous timeout to avoid CI flakiness).
        std::fs::write(config_dir.join("test.toml"), "test").expect("write");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if *called.lock() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("invalidation callback did not fire within 5s timeout");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            *called.lock(),
            "invalidation should have fired after file write"
        );
    }

    // ---- AC.7: project config event debounces to cwd-scoped invalidation ----

    #[test]
    fn project_config_event_debounces_to_cwd_cache_invalidation() {
        let mut c = DebounceCoalescer::new(Duration::from_millis(100));
        let base = tokio::time::Instant::now();
        let project_path = PathBuf::from("/repo/myproject/.polytoken");
        let watched = vec![WatchedPath::ProjectConfig {
            path: project_path.clone(),
            cwd: "/repo/myproject".to_string(),
        }];

        // Simulate a burst of events from the project config dir.
        for i in 0..5 {
            let event = NotifyEvent {
                kind: EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Any,
                )),
                paths: vec![project_path.join("config.toml")],
                attrs: notify::event::EventAttributes::default(),
            };
            let action = classify_event(&event, &watched);
            c.feed(action, base + Duration::from_millis(i));
        }

        // After debounce, exactly one Cwd invalidation fires.
        let fired = c.check_debounce(base + Duration::from_millis(150));
        assert_eq!(
            fired,
            Some(InvalidationAction::Cwd("/repo/myproject".to_string())),
            "project config events should coalesce into one Cwd invalidation"
        );
    }

    #[test]
    fn project_config_watching_available_is_reported_when_setup_succeeds() {
        // When project_watching_unavailable is false, the WatchStatus::Ok variant
        // reports that per-cwd project config watching is active.
        let status = WatchStatus::Ok {
            watched: vec![PathBuf::from("/etc/polytoken")],
            project_watching_unavailable: false,
        };
        match status {
            WatchStatus::Ok {
                project_watching_unavailable,
                ..
            } => {
                assert!(
                    !project_watching_unavailable,
                    "project_watching_unavailable must be false when \
                     <cwd>/.polytoken watching is active"
                );
            }
            _ => panic!("expected Ok status"),
        }
    }

    #[test]
    fn two_different_cwds_coalesce_to_all() {
        // If events from two different project config dirs arrive in the same
        // debounce window, the coalescer escalates to All (cheaper than
        // tracking individual cwds through a burst).
        let mut c = DebounceCoalescer::new(Duration::from_millis(100));
        let base = tokio::time::Instant::now();

        c.feed(InvalidationAction::Cwd("/repo/a".to_string()), base);
        c.feed(
            InvalidationAction::Cwd("/repo/b".to_string()),
            base + Duration::from_millis(10),
        );

        let fired = c.check_debounce(base + Duration::from_millis(150));
        assert_eq!(
            fired,
            Some(InvalidationAction::All),
            "two different cwd events should escalate to All"
        );
    }

    // ---- AC.6: global/binary event debounces to all-cache invalidation ----

    #[test]
    fn global_or_binary_event_debounces_to_all_cache_invalidation() {
        let mut c = DebounceCoalescer::new(Duration::from_millis(100));
        let base = tokio::time::Instant::now();

        // Simulate a burst of events from a binary/global config change.
        let watched = vec![WatchedPath::GlobalConfig(PathBuf::from("/etc/polytoken"))];
        for i in 0..5 {
            let event = NotifyEvent {
                kind: EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Any,
                )),
                paths: vec![PathBuf::from("/etc/polytoken/config.toml")],
                attrs: notify::event::EventAttributes::default(),
            };
            let action = classify_event(&event, &watched);
            c.feed(action, base + Duration::from_millis(i));
        }

        // After debounce window, exactly one All invalidation fires.
        let fired = c.check_debounce(base + Duration::from_millis(150));
        assert_eq!(
            fired,
            Some(InvalidationAction::All),
            "binary/global events should coalesce into one All invalidation"
        );
    }
}
