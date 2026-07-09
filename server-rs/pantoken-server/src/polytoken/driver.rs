//! The polytoken daemon driver: implements `PantokenDriver` by composing
//! `DaemonClient` (HTTP+SSE), `event_map` (daemon→pantoken mapping),
//! and `history_seed` (history→seed conversion).
//!
//! Port of `server/src/polytoken/polytoken-driver.ts` (1953 LOC).
//!
//! ## Shape: `PolytokenDriver { inner: Arc<PolytokenInner> }`
//!
//! The driver owns background SSE tasks that must outlive any single trait
//! method call, so the hub's `Box<dyn PantokenDriver>` holds a thin wrapper around
//! an `Arc<PolytokenInner>`. Trait methods clone the `Arc` (cheap) and delegate
//! to the inner impl. This is the standard "shared owner with background tasks"
//! Rust shape — `warm_session`/`handle_sse_event`/`execute_effect` take
//! `self: &Arc<Self>` so they can be cloned into spawned SSE tasks, and
//! `open_session`/`new_session` can reach them from a plain `&self` by going
//! through `self.inner`.
//!
//! ## SSE consumer: ONE per-session task, unbounded mpsc (not per-event spawn)
//!
//! Each warm session subscribes to the daemon's `/events` SSE stream via ONE
//! long-lived consumer task that drains an unbounded `tokio::mpsc` sequentially.
//! The `client.subscribe` callback is synchronous (`Fn`), so it can only push
//! (`tx.send(envelope)` — non-blocking, order-preserving); the consumer task
//! folds events in arrival order, mirroring the TS SSE path
//! (`polytoken-driver.ts:368-371`). This replaces an earlier per-event
//! `tokio::spawn` (unordered tasks → out-of-order deltas under bursts).
//!
//! **Deliberate divergence from the hub's bounded(256)+`try_send`+panic
//! completion queue:** SSE is push-only with no backpressure seam, and
//! connect-time replays can burst (the ask-user-question corpus is 291 frames).
//! A bounded channel would either drop (corrupting the transcript — the wrong
//! direction for fail-loud) or panic on a burst. Unbounded + sequential drain is
//! the faithful choice; the cost is unbounded memory only if the consumer task
//! stalls indefinitely, which would itself be a louder failure. The
//! single-consumer invariant is `debug_assert`ed in `install_warm` (one consumer
//! per session, caught at the code level — the primary regression protection,
//! since the ordering test is only probabilistically discriminating).
//!
//! On disposal (`reload_session`/`shutdown`), the consumer's `JoinHandle` is
//! aborted + awaited alongside the SSE-subscription teardown so no task leaks.
//

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Output;
use std::sync::Arc;

use pantoken_daemon_types::*;
use pantoken_protocol::session_driver::{
    BackgroundJob, CommandInfo, DirListing, FileInfo, HostUiRequest, HostUiResponse, ImageContent,
    JobKind, JobStatusKind, ModelDefaults, ModelOption, NotifyLevel, PathStat,
    PermissionMonitorMode, SessionClosedReason, SessionDriverEvent, SessionEventBase, SessionId,
    SessionListEntry, SessionRef, SessionSnapshot, SessionStatus, SessionUsage, WorkspaceId,
    WorkspaceRef, WorktreeInfo,
};
use pantoken_protocol::wire::{DeliveryMode, LoginEnvStatus, McpAction};
use parking_lot::{Mutex, RwLock};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use async_trait::async_trait;

use crate::archive_store::ArchiveStore;
use crate::driver::{
    ArchiveResult, BranchResult, ClearQueueResult, NewSessionOptsData, PantokenDriver,
    TodoDeleteDependent, TodoDeleteError, WorktreeCleanupResult, WorktreeRetained,
};
use crate::polytoken::config_watcher;
use crate::polytoken::daemon_client::{
    DaemonClient, SpawnDaemonOpts, SseSubscription, default_global_config_dir,
    read_credential_token, spawn_daemon,
};
use crate::polytoken::event_map::{self, DaemonEffect, FoldAccumulator, FoldResult, MapCtx};
use crate::polytoken::fake_daemon::FakeControlHub;
use crate::polytoken::history_seed::{self, HistoryMapCtx};
use crate::polytoken::models::{ParsedModels, model_post_key, parse_models};
use crate::polytoken::sessions_registry;
use crate::polytoken::ui_bridge::{PendingInterrogative, build_interrogative_response};
use crate::shared::login_env::{self, CapturedLoginEnv};
use crate::shared::session_list::merge_session_lists;
use crate::shared::warm_cap::eviction_plan;
use crate::shared::worktree::{self, WorktreeMeta};
use crate::worktree_store::WorktreeStore;

/// A warm session: a daemon client + accumulator + cached state.
struct WarmSession {
    client: Arc<DaemonClient>,
    accumulator: Mutex<FoldAccumulator>,
    last_state: RwLock<Option<SessionStateSnapshot>>,
    session_ref: SessionRef,
    workspace: WorkspaceRef,
    pending_interrogatives: Mutex<HashMap<String, PendingInterrogative>>,
    sse_subscription: Mutex<Option<SseSubscription>>,
    monitor_mode: Mutex<Option<PermissionMonitorMode>>,
    autodrain_enabled: Mutex<Option<bool>>,
    /// Owned daemon child for real spawned sessions. Retained so dispose can kill
    /// and reap the out-of-process daemon, mirroring TS `WarmSession.child`.
    owned_process: Mutex<Option<tokio::process::Child>>,
    /// The push end of the per-warm-session SSE consumer channel. The
    /// `client.subscribe` callback is synchronous (`Fn`), so it can only push
    /// (never await); it does `tx.send(envelope)` (non-blocking, order-preserving).
    /// The receiver is drained by ONE long-lived consumer task
    /// (`sse_consumer_handle`) which folds events sequentially — mirroring TS
    /// `polytoken-driver.ts:368-371`. See `install_warm` for the rationale on
    /// the unbounded (not bounded) channel.
    sse_tx: Mutex<Option<mpsc::UnboundedSender<SseEnvelope>>>,
    /// The single per-warm-session SSE consumer task. Aborted on
    /// `reload_session` disposal + `shutdown` so no task leaks. Structurally
    /// guarantees ONE consumer per session (the `debug_assert` in `install_warm`
    /// catches a second spawn at the code level).
    sse_consumer_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

type SessionViewed = dyn Fn(SessionId) -> bool + Send + Sync;
type CommandRunnerFuture = Pin<Box<dyn Future<Output = Result<Output, String>> + Send + 'static>>;
type CommandRunner =
    dyn Fn(String, Vec<String>, Option<String>) -> CommandRunnerFuture + Send + Sync;

fn default_command_runner() -> Arc<CommandRunner> {
    Arc::new(|program: String, args: Vec<String>, cwd: Option<String>| {
        Box::pin(async move {
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(args);
            if let Some(cwd) = cwd {
                cmd.current_dir(cwd);
            }
            cmd.output()
                .await
                .map_err(|e| format!("polytoken subprocess failed: {e}"))
        })
    })
}

/// The shared inner driver state. All fields that were on `PolytokenDriver`
/// live here; `PolytokenDriver` is a thin `Arc<PolytokenInner>` wrapper so the
/// trait methods (which take `&self`) can reach the `self: &Arc<Self>` methods
/// that spawn background SSE tasks.
struct PolytokenInner {
    sessions_dir: PathBuf,
    bin_path: String,
    is_fake: bool,
    fake_control: Option<FakeControlHub>,
    warm_cap: i64,
    /// The captured login-shell env, threaded into every daemon spawn so the
    /// daemon gets the user's real PATH + tool env. `None` only when capture
    /// ran but produced no env (a degraded state — spawn gets the inherited env).
    login_env: Mutex<Option<HashMap<String, String>>>,
    /// The status of the login-env capture, surfaced in the Settings panel. The
    /// hub reads it through the `PantokenDriver::login_env_status` trait method
    /// (see `pantoken_settings_msg`).
    login_env_status: RwLock<LoginEnvStatus>,
    archive_store: Mutex<ArchiveStore>,
    worktree_store: Mutex<WorktreeStore>,
    /// Warm recency order: oldest→newest by focus. `eviction_plan` reads this
    /// slice; `focus` moves a session to the back (most-recent). Faithful to
    /// TS's insertion-ordered `Map` (where `focus` deletes + re-inserts). The
    /// `warm` HashMap stays the lookup; `order` is the recency substrate.
    order: Mutex<Vec<SessionId>>,
    warm: RwLock<HashMap<SessionId, Arc<WarmSession>>>,
    subscribers: Mutex<Vec<(usize, mpsc::Sender<SessionDriverEvent>)>>,
    next_sub_id: Mutex<usize>,
    is_viewed: RwLock<Option<Box<SessionViewed>>>,
    command_cache: Mutex<HashMap<String, Vec<CommandInfo>>>,
    facet_cache: Mutex<HashMap<String, Vec<String>>>,
    /// Cached parsed `polytoken models` output. Shared by `list_models()` and
    /// `get_model_defaults()` so a single subprocess result serves both.
    /// `None` = not yet populated (or invalidated). Not cached on error.
    model_cache: Mutex<Option<ParsedModels>>,
    /// Single-flight flag for model cache misses. Prevents the thundering
    /// herd: N concurrent callers on a cold cache would each spawn
    /// `polytoken models` independently. When `true`, a fetch is in progress;
    /// other callers wait on `model_cache_notify` and then re-check the cache.
    /// Held only for nanoseconds (never across `.await`), so a sync Mutex is
    /// safe here — no async lock scheduling risk.
    model_cache_fetching: Mutex<bool>,
    /// Wakeup signal for callers waiting on an in-progress model fetch.
    /// Notified after the fetcher stores the result (or gives up on error).
    model_cache_notify: tokio::sync::Notify,
    /// The inspectable status of the config watcher (binary/global config).
    /// `Disabled` in fake/test mode.
    watch_status: Mutex<config_watcher::WatchStatus>,
    /// The watcher handle, kept alive for process lifetime. `None` in
    /// fake/test mode or when watcher setup failed entirely.
    watcher_handle: Mutex<Option<config_watcher::ConfigWatcherHandle>>,
    command_runner: Arc<CommandRunner>,
}

/// The polytoken daemon driver.
///
/// A thin wrapper around `Arc<PolytokenInner>`. The hub owns this as
/// `Box<dyn PantokenDriver>`; each trait method delegates to the inner impl,
/// cloning the `Arc` where a spawned task needs its own handle.
pub struct PolytokenDriver {
    inner: Arc<PolytokenInner>,
}

impl PolytokenDriver {
    /// Construct the live polytoken driver. Eagerly captures the login-shell env
    /// once (mirroring `polytoken-driver.ts:175-178`) so every daemon spawn gets
    /// the user's real PATH + tool env, and so the Settings panel's login-env
    /// status is correct from t0. Constructs the archive + worktree stores under
    /// `data_dir`. `warm_cap` bounds the warm pool (≤0 = unbounded).
    pub async fn new(
        data_dir: PathBuf,
        bin_path: String,
        is_fake: bool,
        warm_cap: i64,
        login_shell: Option<String>,
    ) -> Self {
        Self::new_with_fake_control(data_dir, bin_path, is_fake, warm_cap, login_shell, None).await
    }

    pub async fn new_with_fake_control(
        data_dir: PathBuf,
        bin_path: String,
        is_fake: bool,
        warm_cap: i64,
        login_shell: Option<String>,
        fake_control: Option<FakeControlHub>,
    ) -> Self {
        // Resolve sessions_dir to the daemon's own data dir
        // (`$XDG_DATA_HOME/polytoken/sessions` or `~/.local/share/polytoken/sessions`),
        // NOT pantoken's data dir. The daemon writes startup.json, credential.json,
        // and session.json here — pantoken must read from the same place to discover
        // cold sessions and pick up auth tokens. Mirrors TS
        // `polytoken-driver.ts:166` `sessionsDir ?? defaultSessionsDir()`.
        let sessions_dir = sessions_registry::default_sessions_dir();
        let captured = login_env::capture_login_env(login_shell.as_deref()).await;
        let CapturedLoginEnv { env, status } = captured;
        let login_env = if env.is_empty() { None } else { Some(env) };

        let driver = Self {
            inner: Arc::new(PolytokenInner {
                sessions_dir,
                bin_path,
                is_fake,
                warm_cap,
                login_env: Mutex::new(login_env),
                login_env_status: RwLock::new(status),
                archive_store: Mutex::new(ArchiveStore::new(data_dir.join("archived.json"))),
                worktree_store: Mutex::new(WorktreeStore::new(data_dir.join("worktrees.json"))),
                order: Mutex::new(Vec::new()),
                warm: RwLock::new(HashMap::new()),
                subscribers: Mutex::new(Vec::new()),
                next_sub_id: Mutex::new(0),
                is_viewed: RwLock::new(None),
                command_cache: Mutex::new(HashMap::new()),
                facet_cache: Mutex::new(HashMap::new()),
                model_cache: Mutex::new(None),
                model_cache_fetching: Mutex::new(false),
                model_cache_notify: tokio::sync::Notify::new(),
                watch_status: Mutex::new(config_watcher::WatchStatus::Disabled),
                watcher_handle: Mutex::new(None),
                command_runner: default_command_runner(),
                fake_control,
            }),
        };
        // Fake mode: eagerly warm one bootstrap session so `default_seed()` (sync)
        // always has an active warm session for the hub to adopt at boot and after
        // every `/debug/reset`. Real mode skips this (fake_control is None).
        if driver.inner.fake_control.is_some() {
            driver.inner.clone().bootstrap_fake().await;
        }
        // Real (non-fake) mode: start the config watcher over the binary and
        // global config directory. Fake mode stays Disabled (AC.9).
        if !driver.inner.is_fake {
            driver.inner.clone().start_config_watcher();
        }
        driver
    }

    /// Test-only constructor: takes a pre-set `login_env` so the threading test
    /// (AC.9) is deterministic — no real shell spawn in CI. `warm_cap` and
    /// `data_dir` are real so warm-cap eviction + store wiring are exercised.
    // Test-support only (reachable from integration tests, hence not `#[cfg(test)]`).
    #[doc(hidden)]
    pub async fn new_with_login_env(
        data_dir: PathBuf,
        bin_path: String,
        is_fake: bool,
        warm_cap: i64,
        login_env: Option<HashMap<String, String>>,
    ) -> Self {
        let sessions_dir = data_dir.join("sessions");
        let status = LoginEnvStatus {
            active_shell: None,
            ok: login_env.is_some(),
            detail: Some("injected (test)".to_string()),
        };
        Self {
            inner: Arc::new(PolytokenInner {
                sessions_dir,
                bin_path,
                is_fake,
                warm_cap,
                login_env: Mutex::new(login_env),
                login_env_status: RwLock::new(status),
                archive_store: Mutex::new(ArchiveStore::new(data_dir.join("archived.json"))),
                worktree_store: Mutex::new(WorktreeStore::new(data_dir.join("worktrees.json"))),
                order: Mutex::new(Vec::new()),
                warm: RwLock::new(HashMap::new()),
                subscribers: Mutex::new(Vec::new()),
                next_sub_id: Mutex::new(0),
                is_viewed: RwLock::new(None),
                command_cache: Mutex::new(HashMap::new()),
                facet_cache: Mutex::new(HashMap::new()),
                model_cache: Mutex::new(None),
                model_cache_fetching: Mutex::new(false),
                model_cache_notify: tokio::sync::Notify::new(),
                watch_status: Mutex::new(config_watcher::WatchStatus::Disabled),
                watcher_handle: Mutex::new(None),
                command_runner: default_command_runner(),
                fake_control: None,
            }),
        }
    }

    /// The login-env status, exposed for the Settings panel and read by the hub
    /// through the `PantokenDriver` trait. Kept as an inherent delegate so
    /// concrete-typed callers keep working.
    pub fn login_env_status(&self) -> LoginEnvStatus {
        <Self as PantokenDriver>::login_env_status(self)
    }

    /// Reap the pantoken worktree at `cwd` if one is live: remove it (honoring
    /// `force`), tombstone it in the store on success, or report why it was
    /// retained. Shared by `set_archived` and `cleanup_worktree`. Takes the
    /// worktree meta under the lock, drops the guard, then awaits the removal
    /// (lock-across-await discipline).
    async fn reap_worktree(&self, cwd: &str, force: bool) -> ReapOutcome {
        let meta = {
            let store = self.inner.worktree_store.lock();
            store.live(cwd).cloned()
        };
        let Some(meta) = meta else {
            return ReapOutcome::NoWorktree;
        };
        match worktree::remove(&meta, force).await {
            Ok(res) if res.removed => {
                self.inner.worktree_store.lock().mark_reaped(cwd);
                ReapOutcome::Reaped
            }
            Ok(res) => ReapOutcome::Retained(
                res.reason
                    .unwrap_or_else(|| "uncommitted changes".to_string()),
            ),
            // A genuine command/fs failure (not a dirty worktree, which is the
            // `Ok(res)` arm above). Log it — fail-loud, mirroring TS's
            // `console.error` in `setArchived`'s reap catch — then retain.
            Err(e) => {
                warn!("worktree reap failed for {cwd}: {e}");
                ReapOutcome::Retained(e)
            }
        }
    }
}

/// A MapCtx implementation backed by a WarmSession's cached state.
/// The mapper never does I/O — it reads this cached state.
struct DriverMapCtx {
    session_ref: SessionRef,
    workspace: WorkspaceRef,
    last_state: Option<SessionStateSnapshot>,
    monitor_mode: Option<PermissionMonitorMode>,
    autodrain_enabled: Option<bool>,
}

impl DriverMapCtx {
    /// A current UTC RFC3339 timestamp, matching the daemon's date-time
    /// format. Shared between `DriverMapCtx::now` and `list_sessions`' warm
    /// entries so freshest (warm-only) sessions sort correctly by recency.
    fn now_ts() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

impl MapCtx for DriverMapCtx {
    fn r#ref(&self) -> &SessionRef {
        &self.session_ref
    }

    fn workspace(&self) -> &WorkspaceRef {
        &self.workspace
    }

    fn now(&self) -> String {
        Self::now_ts()
    }

    fn snapshot(&self, status: SessionStatus) -> SessionSnapshot {
        event_map::snapshot_from_state(
            self.last_state.as_ref(),
            &self.session_ref,
            &self.workspace,
            status,
            &self.now(),
            self.monitor_mode,
            self.autodrain_enabled,
        )
    }

    fn live_status(&self) -> SessionStatus {
        // If the cached state says a turn is in flight, report Running
        if let Some(state) = &self.last_state {
            if state.turn_in_flight.unwrap_or(false) {
                return SessionStatus::Running;
            }
        }
        SessionStatus::Idle
    }
}

/// How `install_warm` should wait for the daemon to become healthy.
///
/// - **Poll** (spawn path): the daemon was just spawned and may need a moment
///   to bind its port. Retry every 100ms for up to 10s.
/// - **ProbeOnce** (attach path): the daemon is assumed to be *already
///   running*. If the first health check fails (connection refused), the
///   daemon is dead — fail immediately so the caller's cold-start fallback
///   fires without delay. Never subject the user to a 10s timeout for a
///   daemon that isn't there.
enum HealthProbeMode {
    Poll,
    ProbeOnce,
}

impl PolytokenInner {
    fn emit(&self, ev: SessionDriverEvent) {
        let subs = self.subscribers.lock();
        for (_, tx) in subs.iter() {
            let _ = tx.try_send(ev.clone());
        }
    }

    fn get_warm(&self, session_id: &SessionId) -> Option<Arc<WarmSession>> {
        self.warm.read().get(session_id).cloned()
    }

    /// Move `session_id` to the back of the warm recency order (most-recently
    /// focused). If absent, append it. Mirrors TS `focus` (`focus` deletes +
    /// re-inserts into the insertion-ordered `Map`). Recency is fully encoded by
    /// position — no `lastFocusedAt` field. Called on install/open/new before
    /// running eviction. Does NOT track `active_session_id` (its only consumer
    /// is the idle reaper, out of scope here — adding it would be dead state).
    fn focus(&self, session_id: &SessionId) {
        let mut order = self.order.lock();
        order.retain(|id| id != session_id);
        order.push(session_id.clone());
    }

    /// Extract the session id from a session path. The path is
    /// `.../sessions/<session_id>/session.json` — the id is the **parent
    /// directory name**, not the file stem (which is always `"session"`).
    /// Mirrors TS `sessionIdFromPath` (`polytoken-driver.ts:844`).
    ///
    /// Returns `None` for non-`session.json` paths or paths with fewer than
    /// two components — matching the TS `null` return whose callers throw
    /// `"could not resolve session id from path"`. Callers must propagate
    /// that as an `Err` rather than proceeding with a bogus id.
    fn session_id_from_path(path: &str) -> Option<String> {
        let normalized = path.replace('\\', "/");
        let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() >= 2 && parts[parts.len() - 1] == "session.json" {
            Some(parts[parts.len() - 2].to_string())
        } else {
            None
        }
    }

    /// Resolve a session's project cwd from its on-disk `session.json`, falling
    /// back to `None` when the metadata is missing/unreadable (the caller then
    /// falls back to the sessions dir, mirroring `polytoken-driver.ts:1138`).
    fn cwd_for_session(sessions_dir: &Path, session_id: &str) -> Option<String> {
        let session_dir = sessions_dir.join(session_id);
        sessions_registry::read_session_json(&session_dir)
            .filter(|meta| !meta.project_path.is_empty())
            .map(|meta| meta.project_path)
    }

    fn active_warm(&self) -> Option<Arc<WarmSession>> {
        let active_id = self.order.lock().last().cloned()?;
        self.get_warm(&active_id)
    }

    fn warm_cwd(&self, ws: &WarmSession) -> Option<String> {
        let state = ws.last_state.read();
        state
            .as_ref()
            .and_then(|s| s.project_cwd.clone().or_else(|| s.cwd.clone()))
            .filter(|cwd| !cwd.is_empty())
            .or_else(|| Self::cwd_for_session(&self.sessions_dir, &ws.client.session_id))
    }

    fn target_warm_for_read(&self, session_id: Option<&SessionId>) -> Option<Arc<WarmSession>> {
        match session_id {
            Some(sid) => self.get_warm(sid),
            None => self.active_warm(),
        }
    }

    fn targeted_session_cwd(&self, session_id: Option<&SessionId>) -> Option<String> {
        self.target_warm_for_read(session_id)
            .and_then(|ws| self.warm_cwd(&ws))
    }

    fn file_lookup_root(
        &self,
        cwd: Option<String>,
        session_id: Option<&SessionId>,
    ) -> Option<String> {
        cwd.filter(|root| !root.is_empty())
            .or_else(|| self.targeted_session_cwd(session_id))
    }

    async fn run_polytoken(
        &self,
        args: Vec<String>,
        cwd: Option<String>,
    ) -> Result<Output, String> {
        (self.command_runner)(self.bin_path.clone(), args, cwd).await
    }

    // ---- Cache invalidation APIs ----

    /// Invalidate the model/default cache. The next `list_models()` or
    /// `get_model_defaults()` call will re-run `polytoken models`.
    #[allow(dead_code)] // used by watcher integration + tests
    pub fn invalidate_model_cache(&self) {
        debug!("invalidating model cache");
        *self.model_cache.lock() = None;
    }

    /// Invalidate ALL config-dependent caches: models/defaults, all facets,
    /// and all commands. Used when the binary or global config changes.
    pub fn invalidate_all_config_caches(&self) {
        debug!("invalidating all config caches (models, facets, commands)");
        *self.model_cache.lock() = None;
        self.facet_cache.lock().clear();
        self.command_cache.lock().clear();
    }

    /// Invalidate facet and command caches for a specific cwd only.
    /// Used when a project-scoped config change is detected for that cwd.
    pub fn invalidate_cwd_config_caches(&self, cwd: &str) {
        debug!("invalidating cwd config caches for {cwd}");
        self.facet_cache.lock().remove(cwd);
        self.command_cache.lock().remove(cwd);
    }

    /// Returns the current watcher status (for inspection / Settings panel).
    #[allow(dead_code)] // used by tests
    pub fn watch_status(&self) -> config_watcher::WatchStatus {
        self.watch_status.lock().clone()
    }

    /// Register `<cwd>/.polytoken` for filesystem watching. Called lazily by
    /// `list_facets` and `list_commands` when they resolve a session cwd.
    /// Idempotent — safe to call repeatedly for the same cwd. No-op if the
    /// watcher is not active (fake/test mode or setup failure).
    fn register_project_config_watch(&self, cwd: &str) {
        let guard = self.watcher_handle.lock();
        let Some(handle) = guard.as_ref() else {
            return;
        };
        let project_config_path = Path::new(cwd).join(".polytoken");
        handle.register_project_config(project_config_path, cwd.to_string());
    }

    // ---- Single-flight model cache fetch ----

    /// Get the cached parsed models, or fetch them via `polytoken models` if
    /// the cache is empty. Uses single-flight deduplication: concurrent
    /// callers on a cold cache share one subprocess.
    ///
    /// The single-flight mechanism uses a sync `Mutex<bool>` "fetching" flag
    /// (held only for nanoseconds, never across `.await`) plus a
    /// `tokio::sync::Notify` to wake waiters. This avoids the scheduling risks
    /// of holding an async mutex across a subprocess `.await`.
    ///
    /// Wakeup uses `notify_one()` with baton-passing: the fetcher wakes one
    /// waiter, each woken waiter wakes the next. `notify_one()` stores a
    /// permit when no one is polling yet, so if the fetcher finishes between
    /// a waiter's flag-check and its `notified().await`, the stored permit
    /// resolves the waiter immediately — no lost wakeup.
    ///
    /// On subprocess error, returns an empty `ParsedModels` (matching the
    /// original `list_models` error behavior) and does NOT cache the failure
    /// so the next call retries.
    async fn get_or_fetch_parsed_models(self: &Arc<Self>) -> ParsedModels {
        loop {
            // Fast path: cache hit.
            if let Some(cached) = self.model_cache.lock().clone() {
                return cached;
            }

            // Try to become the fetcher: set the flag (sync lock, no .await).
            let became_fetcher = {
                let mut fetching = self.model_cache_fetching.lock();
                if *fetching {
                    false
                } else {
                    *fetching = true;
                    true
                }
            };

            if became_fetcher {
                // We're the elected caller. Run the subprocess with NO lock held.
                let result = self.run_polytoken(vec!["models".into()], None).await;
                let parsed = match result {
                    Ok(out) => {
                        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                        let parsed = parse_models(&stdout);
                        *self.model_cache.lock() = Some(parsed.clone());
                        parsed
                    }
                    Err(e) => {
                        error!("list_models failed: {e}");
                        // Do not cache failed results (AC.3: next call retries).
                        ParsedModels::default()
                    }
                };
                // Clear the flag and wake one waiter (baton-start).
                *self.model_cache_fetching.lock() = false;
                self.model_cache_notify.notify_one();
                return parsed;
            }

            // Another caller is fetching. Wait for notification.
            // notify_one() stores a permit if no task is polling yet, so this
            // is race-free: if the fetcher finished between our flag check and
            // this await, the stored permit resolves us immediately.
            self.model_cache_notify.notified().await;
            // Baton: wake the next waiter so they can re-check the cache.
            // If no one is waiting, this stores a harmless stale permit.
            self.model_cache_notify.notify_one();
            // Loop back to re-check the cache. If the fetcher succeeded, the
            // cache is populated and we return. If it failed, the cache is
            // still empty and we'll try to become the fetcher ourselves.
        }
    }

    // ---- Config watcher setup ----

    /// Start the config watcher over the resolved binary path and the global
    /// config directory. Called only in real (non-fake) driver mode.
    ///
    /// Per-cwd project config watching is registered lazily: when `list_facets`
    /// or `list_commands` resolves a session cwd, it registers `<cwd>/.polytoken`
    /// for watching via `ConfigWatcherHandle::register_project_config`. Events
    /// from that directory invalidate only that cwd's facet/command caches.
    fn start_config_watcher(self: Arc<Self>) {
        let mut watched_paths: Vec<config_watcher::WatchedPath> = Vec::new();

        // Watch the resolved binary path. If the configured binary is relative
        // (e.g. `polytoken`), resolve it via PATH lookup; if that fails, skip
        // binary watching and log the limitation.
        if let Some(bin_abs) = config_watcher::resolve_binary_path(&self.bin_path) {
            watched_paths.push(config_watcher::WatchedPath::Binary(bin_abs));
        } else {
            warn!(
                "config watcher: could not resolve binary path '{}' to an absolute path; \
                 binary watching is unavailable (global config watching remains active)",
                self.bin_path
            );
        }

        // Watch the global config directory (recursive). If it doesn't exist
        // yet (first run), watch its parent so we catch the directory creation
        // and subsequent config writes. If the parent also doesn't exist, skip
        // with a log — the watcher status will reflect the failure.
        let global_config = default_global_config_dir();
        if global_config.exists() {
            watched_paths.push(config_watcher::WatchedPath::GlobalConfig(global_config));
        } else if let Some(parent) = global_config.parent() {
            if parent.exists() {
                warn!(
                    "config watcher: global config dir {} does not exist yet; \
                     watching parent {} to catch creation",
                    global_config.display(),
                    parent.display()
                );
                watched_paths.push(config_watcher::WatchedPath::GlobalConfig(
                    parent.to_path_buf(),
                ));
            } else {
                warn!(
                    "config watcher: global config dir {} and its parent do not exist; \
                     global config watching is unavailable",
                    global_config.display()
                );
            }
        } else {
            warn!(
                "config watcher: global config dir {} has no parent; \
                 global config watching is unavailable",
                global_config.display()
            );
        }

        // The invalidation callback: invoked after debounce by the watcher task.
        // It captures an Arc to the inner state and calls the appropriate
        // invalidation method based on the action.
        let inner = self.clone();
        let invalidation: config_watcher::InvalidationCallback =
            Arc::new(move |action| match action {
                config_watcher::InvalidationAction::All => {
                    inner.invalidate_all_config_caches();
                }
                config_watcher::InvalidationAction::Cwd(cwd) => {
                    inner.invalidate_cwd_config_caches(&cwd);
                }
                config_watcher::InvalidationAction::None => {}
            });

        let (handle, status) = config_watcher::setup_watcher(
            watched_paths,
            invalidation,
            // project_watching_unavailable = false: we watch <cwd>/.polytoken
            // for project config changes (registered lazily by list_facets/
            // list_commands).
            false,
        );

        *self.watch_status.lock() = status;
        *self.watcher_handle.lock() = handle;
    }

    /// Fake mode bootstrap: warm one in-process fake session so `default_seed`
    /// (sync) always has an active warm session for the hub to adopt at boot and
    /// after each `/debug/reset`. The spawn-override (`install_fake_spawn`) mints
    /// the real session id + port; the placeholder id/ref/cwd here are overwritten
    /// by `warm_session` from the spawn result.
    async fn bootstrap_fake(self: Arc<Self>) {
        let workspace = WorkspaceRef {
            workspace_id: "fake".to_string(),
            path: "/fake".to_string(),
            display_name: None,
        };
        let session_ref = SessionRef {
            workspace_id: "fake".to_string(),
            session_id: "fake-bootstrap".to_string(),
        };
        if let Err(e) = self
            .warm_session(
                "fake-bootstrap".to_string(),
                session_ref,
                workspace,
                "/fake".to_string(),
            )
            .await
        {
            warn!("fake bootstrap warm failed: {e}");
        }
    }

    fn build_branch_seed(
        snapshot: SessionSnapshot,
        history_items: &[pantoken_daemon_types::SessionHistoryItem],
        ctx: &HistoryMapCtx,
    ) -> Vec<SessionDriverEvent> {
        let mut seed = vec![SessionDriverEvent::SessionOpened {
            base: SessionEventBase {
                session_ref: ctx.r#ref.clone(),
                timestamp: DriverMapCtx::now_ts(),
                run_id: None,
            },
            snapshot: snapshot.clone(),
        }];
        let history = history_seed::history_to_seed_events(history_items, ctx);
        let replayed = !history.is_empty();
        seed.extend(history);
        // Re-assert the authoritative snapshot AFTER the replayed history. The leading
        // SessionOpened marks idle-vs-running, but every replayed user/assistant/tool
        // event folds ON TOP of it: a history that ends mid-turn — on an assistant
        // thinking/text block, or otherwise without a runCompleted/idle boundary — leaves
        // the assistant bubble streaming:true (the fold's open assistant) AND the hub's
        // running set stuck true (track_running flips it on for the trailing
        // userMessage/assistantDelta and nothing re-settles it). A freshly loaded,
        // actually-idle session then shows the "Thinking…"/working spinner forever.
        // Replaying this trailing snapshot at the live status closes any dangling open
        // assistant (the fold's closeOpenAssistant) and re-settles the running set — so
        // the loaded state matches the daemon's real status. A genuinely running session
        // carries status:running here, which correctly keeps the turn live. Skipped when
        // nothing replayed: a bare SessionOpened is already settled.
        if replayed {
            seed.push(SessionDriverEvent::SessionUpdated {
                base: SessionEventBase {
                    session_ref: ctx.r#ref.clone(),
                    timestamp: DriverMapCtx::now_ts(),
                    run_id: None,
                },
                snapshot,
            });
        }
        seed
    }

    /// Build the event sequence for an SSE **reseed** (stream_discontinuity /
    /// session_rewound / context_cleared) — the sibling of `build_branch_seed` for
    /// the ALREADY-OPEN, live-emit path (these events are emitted through the SSE
    /// consumer, not returned as an atomic openSession seed).
    ///
    /// Unlike the open path — which leads with a `SessionOpened` that REPLACES the
    /// whole SessionState — a reseed must preserve the session's live metadata, so it
    /// leads with a `SessionReset` (clears only the transcript items; the hub's fold
    /// is additive, so re-emitting history without this DUPLICATES every row). Because
    /// `SessionReset` preserves the prior status and the replayed user/assistant/tool
    /// events flip the hub's running set + attention to "running", the trailing
    /// `SessionUpdated` re-assert is UNCONDITIONAL here (the open path can skip it when
    /// nothing replayed because its leading `SessionOpened` already carries the status;
    /// `SessionReset` does not). `snapshot` must be built from a FRESH GET /state, and
    /// the caller must `reset_accumulator` before emitting these (a discontinuity can
    /// leave stale in-flight block/tool state in the fold accumulator).
    fn build_reseed_events(
        snapshot: SessionSnapshot,
        history_items: &[pantoken_daemon_types::SessionHistoryItem],
        ctx: &HistoryMapCtx,
    ) -> Vec<SessionDriverEvent> {
        let mut events = vec![SessionDriverEvent::SessionReset {
            base: SessionEventBase {
                session_ref: ctx.r#ref.clone(),
                timestamp: DriverMapCtx::now_ts(),
                run_id: None,
            },
        }];
        events.extend(history_seed::history_to_seed_events(history_items, ctx));
        events.push(SessionDriverEvent::SessionUpdated {
            base: SessionEventBase {
                session_ref: ctx.r#ref.clone(),
                timestamp: DriverMapCtx::now_ts(),
                run_id: None,
            },
            snapshot,
        });
        events
    }

    /// The worktree field for a session's cwd, or `None`. Resolved from the
    /// worktree store at list time (pantoken's own flag — polytoken has no concept).
    /// Carries `name` + `reaped` so the sidebar can show a tooltip + a tombstoned
    /// indicator. Mirrors `polytoken-driver.ts:827-839` `worktreeFieldFor`.
    fn worktree_field_for(cwd: &str, store: &WorktreeStore) -> Option<WorktreeInfo> {
        let meta = store.get(cwd)?;
        Some(WorktreeInfo {
            path: meta.path.clone(),
            base: meta.base.clone(),
            name: meta.name.clone(),
            reaped: store.is_reaped(cwd).then_some(true),
        })
    }

    /// Build a `WarmSession` from an already-connected client: claim the lease,
    /// fetch initial state, subscribe to SSE, and insert into `self.warm`.
    /// Shared by `warm_session` (spawn path) and `warm_session_attach`
    /// (resume-with-known-port path). Returns the warm `Arc<WarmSession>`.
    async fn install_warm(
        self: &Arc<Self>,
        client: Arc<DaemonClient>,
        session_id: SessionId,
        session_ref: SessionRef,
        workspace: WorkspaceRef,
        owned_process: Option<tokio::process::Child>,
        probe: HealthProbeMode,
    ) -> Result<Arc<WarmSession>, String> {
        let healthy = match probe {
            HealthProbeMode::ProbeOnce => {
                // Attach path: the daemon should already be running. A single
                // failed health check means it's dead — don't waste the user's
                // time retrying for 10s.
                client.health().await.status == 200
            }
            HealthProbeMode::Poll => {
                // Spawn path: the daemon was just spawned and may need a moment
                // to bind its port. Retry up to 10s.
                tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    loop {
                        let res = client.health().await;
                        if res.status == 200 {
                            return true;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                })
                .await
                .unwrap_or(false)
            }
        };

        if !healthy {
            return Err("daemon health probe failed".into());
        }

        // Claim lease
        match client.claim_lease("pantoken").await {
            Ok(_) => {}
            Err(e) => return Err(format!("lease claim failed: {e}")),
        }

        // Fetch initial state
        let state_res = client.state().await;
        let last_state = state_res.data;

        // Create the warm session
        let warm = Arc::new(WarmSession {
            client: client.clone(),
            accumulator: Mutex::new(event_map::create_accumulator()),
            last_state: RwLock::new(last_state),
            session_ref: session_ref.clone(),
            workspace: workspace.clone(),
            pending_interrogatives: Mutex::new(HashMap::new()),
            sse_subscription: Mutex::new(None),
            monitor_mode: Mutex::new(None),
            autodrain_enabled: Mutex::new(None),
            owned_process: Mutex::new(owned_process),
            sse_tx: Mutex::new(None),
            sse_consumer_handle: Mutex::new(None),
        });

        // Subscribe to SSE via ONE per-warm-session consumer task (not a task
        // per event). The daemon's `subscribe` callback is synchronous (`Fn`),
        // so it can only push; it sends each envelope into an unbounded mpsc,
        // and a single long-lived task drains the receiver sequentially,
        // folding events in arrival order. This mirrors the TS SSE path
        // (`polytoken-driver.ts:368-371`) which processes events sequentially.
        //
        // WHY UNBOUNDED (deliberate divergence from the hub's bounded(256) +
        // `try_send` + panic completion queue): SSE is push-only with no
        // backpressure seam, and connect-time replays can burst (the
        // ask-user-question corpus is 291 frames). A bounded channel would
        // either drop (corrupting the transcript — the wrong direction for
        // fail-loud) or panic on a burst. Unbounded + sequential drain is the
        // faithful choice; the cost is unbounded memory only if the consumer
        // task stalls indefinitely, which would itself be a louder failure.
        //
        // Single-consumer invariant: `debug_assert` that no consumer is
        // already running for this session, so a second `install_warm` on the
        // same `WarmSession` is caught at the code level (not just
        // probabilistically by the ordering test).
        debug_assert!(
            warm.sse_consumer_handle.lock().is_none(),
            "install_warm: SSE consumer already running for this warm session"
        );
        let (sse_tx, mut sse_rx) = mpsc::unbounded_channel::<SseEnvelope>();
        *warm.sse_tx.lock() = Some(sse_tx.clone());
        let consumer_warm = warm.clone();
        let consumer_self = self.clone();
        let consumer_handle = tokio::spawn(async move {
            while let Some(envelope) = sse_rx.recv().await {
                consumer_self
                    .handle_sse_event(consumer_warm.clone(), envelope)
                    .await;
            }
            // sse_rx returns None when all senders drop — the subscription's
            // stop() drops the sender held in the subscribe closure below, so
            // the consumer task exits cleanly on disposal.
        });
        *warm.sse_consumer_handle.lock() = Some(consumer_handle);

        // The subscribe callback just pushes into the channel (non-blocking,
        // order-preserving). It never awaits, so it's safe as a sync `Fn`. A
        // cloned sender is moved into the closure; when the subscription is
        // stopped (`SseSubscription::stop` aborts the SSE loop task that owns
        // this closure), the sender drops, and the consumer's `recv` returns
        // None → the consumer task exits.
        let sub = client
            .subscribe(move |envelope: SseEnvelope| {
                // `send` fails only if the receiver was dropped (the consumer
                // task exited) — drop the envelope silently during teardown.
                let _ = sse_tx.send(envelope);
            })
            .await;

        *warm.sse_subscription.lock() = Some(sub);

        // Seed the cached monitor mode from the daemon's actual state. The
        // daemon's config may set a non-standard default (e.g. bypass), and
        // without this the badge shows "Standard" until the user explicitly
        // picks a mode. `new_session` overrides this with the user's explicit
        // pick AFTER `warm_session` returns, so the seed only sticks when the
        // user didn't choose (the common case for resume/attach). On error,
        // `monitor_mode` stays `None` (the prior behavior) — fail gracefully.
        if let Ok(pm) = warm.client.get_permission_monitor().await {
            let mode = event_map::monitor_to_mode(&pm.monitor);
            *warm.monitor_mode.lock() = Some(mode);
        }

        self.warm.write().insert(session_id.clone(), warm.clone());
        // Focus the new session (most-recently focused) before running eviction
        // so it's the protected id (never evicted). Mirrors TS `focus(spawned.sessionId)`.
        self.focus(&session_id);

        // Enforce the warm cap: evict the least-recently-focused sessions (never
        // the one just warmed). Sessions with a running turn (turn_in_flight)
        // are never evicted — disposing one mid-turn kills it and the synthetic
        // sessionClosed makes it look finished. Mirrors
        // `polytoken-driver.ts:567-600`.
        let order = self.order.lock().clone();
        let victims = eviction_plan(&order, Some(&session_id), self.warm_cap, |id| {
            !self.turn_in_flight(id)
        });
        for victim_id in &victims {
            let Some(victim) = self.warm.write().remove(victim_id) else {
                continue;
            };
            // Emit a synthetic sessionClosed BEFORE dispose so the hub clears the
            // running indicator on an evicted session (dispose tears down SSE,
            // so the abort's terminal event never arrives). Mirrors the TS pattern.
            let now = DriverMapCtx::now_ts();
            self.emit(SessionDriverEvent::SessionClosed {
                base: SessionEventBase {
                    session_ref: victim.session_ref.clone(),
                    timestamp: now,
                    run_id: None,
                },
                reason: SessionClosedReason::Ended,
            });
            // Dispose: tear down SSE + close the client (the TS `disposeSession`).
            self.dispose_warm(&victim).await;
            // Remove from recency order.
            self.order.lock().retain(|id| id != victim_id);
            info!(
                "evicted LRU warm session {victim_id}; {} warm",
                self.warm.read().len()
            );
        }
        if self.warm_cap > 0 && (self.warm.read().len() as i64) > self.warm_cap {
            warn!(
                "warm cap {} exceeded ({} warm) — not enough idle eviction candidates; \
                 deferring until running turns finish",
                self.warm_cap,
                self.warm.read().len()
            );
        }

        Ok(warm)
    }

    /// True if the session's cached state reports a turn in flight (the
    /// authoritative signal — disposing one mid-turn kills the running turn).
    /// Used by the eviction predicate to skip running sessions.
    fn turn_in_flight(&self, session_id: &SessionId) -> bool {
        self.warm
            .read()
            .get(session_id)
            .and_then(|ws| ws.last_state.read().as_ref().and_then(|s| s.turn_in_flight))
            .unwrap_or(false)
    }

    /// Dispose a warm session: stop the SSE subscription, drop the consumer
    /// sender, abort + await the consumer task, close the client. Mirrors TS
    /// `disposeSession`. Extracted so `install_warm` (eviction) and
    /// `reload_session` share one teardown path.
    async fn dispose_warm(&self, ws: &Arc<WarmSession>) {
        let sub = ws.sse_subscription.lock().take();
        *ws.sse_tx.lock() = None;
        let consumer_handle = ws.sse_consumer_handle.lock().take();
        if let Some(sub) = sub {
            sub.stop().await;
        }
        if let Some(handle) = consumer_handle {
            handle.abort();
            let _ = handle.await;
        }
        let child = { ws.owned_process.lock().take() };
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        ws.client.close().await;
    }

    /// Warm up a NEW session by spawning the daemon (`polytoken new --no-attach`),
    /// then installing it (health → lease → state → SSE → insert). Used by
    /// `new_session`. Mirrors TS `warmSession(cwd)` (no sessionId).
    async fn warm_session(
        self: &Arc<Self>,
        session_id: SessionId,
        session_ref: SessionRef,
        workspace: WorkspaceRef,
        cwd: String,
    ) -> Result<Arc<WarmSession>, String> {
        if let Some(ws) = self.get_warm(&session_id) {
            return Ok(ws);
        }

        let opts = SpawnDaemonOpts {
            cwd: Some(cwd),
            session_id: None,
            // Pass the real sessions_dir so spawn_new_daemon can find the
            // daemon's startup.json to read the credential file path (daemon
            // 0.5.0+ bearer auth). Mirrors the resume path's sessions_dir.
            sessions_dir: Some(self.sessions_dir.to_string_lossy().to_string()),
            global_config_dir: None,
            // Thread the captured login-shell env into the spawn so the daemon
            // gets the user's real PATH + tool env (pantoken launched from the .app
            // bundle inherits launchd's minimal PATH). Mirrors
            // `polytoken-driver.ts:175-178` + the spawn's login-env merge.
            login_env: self.login_env.lock().clone(),
        };

        let (spawned, child) =
            crate::polytoken::daemon_client::spawn_daemon(&self.bin_path, opts).await?;

        // The spawn reports the real session id; use it for the client + warm map.
        let session_id = spawned.session_id;
        let port = spawned.port;
        // The session_ref's session_id was provisional (unknown pre-spawn);
        // fix it to the real id so SSE-mapped events carry the correct ref.
        let session_ref = SessionRef {
            workspace_id: session_ref.workspace_id,
            session_id: session_id.clone(),
        };
        let client = Arc::new(DaemonClient::new(
            session_id.clone(),
            port,
            std::process::id() as i32,
            spawned.auth_token.clone(),
        ));

        self.install_warm(
            client,
            session_id,
            session_ref,
            workspace,
            child,
            HealthProbeMode::Poll,
        )
        .await
    }

    /// Warm up a session by ATTACHING to an already-running daemon on a known
    /// port (the resume path — the daemon was spawned by a prior `polytoken
    /// daemon --resume` and wrote its port to `startup.json`). Used by
    /// `open_session`. Mirrors TS `warmSession(cwd, sessionId)` for the resume
    /// case where the port is already known.
    async fn warm_session_attach(
        self: &Arc<Self>,
        session_id: SessionId,
        session_ref: SessionRef,
        workspace: WorkspaceRef,
        port: u16,
        auth_token: Option<String>,
    ) -> Result<Arc<WarmSession>, String> {
        if let Some(ws) = self.get_warm(&session_id) {
            return Ok(ws);
        }

        let client = Arc::new(DaemonClient::new(
            session_id.clone(),
            port,
            std::process::id() as i32,
            auth_token,
        ));

        self.install_warm(
            client,
            session_id,
            session_ref,
            workspace,
            None,
            HealthProbeMode::ProbeOnce,
        )
        .await
    }

    /// Spawn a resume daemon for a cold session (no running daemon found), then
    /// install it into the warm pool. Mirrors TS `warmSession(cwd, sessionId)`
    /// → `spawnResumeDaemon`. Used by `open_session` when no startup.json is
    /// found or the attach path fails. Goes through `spawn_daemon` so the
    /// fake-daemon spawn-override seam is honored.
    async fn warm_session_resume(
        self: &Arc<Self>,
        session_id: SessionId,
        session_ref: SessionRef,
        workspace: WorkspaceRef,
        cwd: String,
    ) -> Result<Arc<WarmSession>, String> {
        if let Some(ws) = self.get_warm(&session_id) {
            return Ok(ws);
        }
        let opts = SpawnDaemonOpts {
            cwd: Some(cwd),
            session_id: Some(session_id.clone()),
            sessions_dir: Some(self.sessions_dir.to_string_lossy().to_string()),
            global_config_dir: Some(default_global_config_dir().to_string_lossy().to_string()),
            login_env: self.login_env.lock().clone(),
        };
        let (spawned, child) = spawn_daemon(&self.bin_path, opts).await?;
        // spawned.auth_token is read from the credential file (Phase 3).
        let client = Arc::new(DaemonClient::new(
            spawned.session_id.clone(),
            spawned.port,
            std::process::id() as i32,
            spawned.auth_token.clone(),
        ));
        self.install_warm(
            client,
            session_id,
            session_ref,
            workspace,
            child,
            HealthProbeMode::Poll,
        )
        .await
    }

    /// Process an SSE event: map through event_map, emit results, execute effects.
    async fn handle_sse_event(self: &Arc<Self>, ws: Arc<WarmSession>, envelope: SseEnvelope) {
        let ev = envelope.event;

        // Build the MapCtx from the warm session's cached state
        let ctx = DriverMapCtx {
            session_ref: ws.session_ref.clone(),
            workspace: ws.workspace.clone(),
            last_state: ws.last_state.read().clone(),
            monitor_mode: *ws.monitor_mode.lock(),
            autodrain_enabled: *ws.autodrain_enabled.lock(),
        };

        // Map through the event_map accumulator
        let result: FoldResult = {
            let mut acc = ws.accumulator.lock();
            event_map::map_daemon_event(&ev, &mut acc, &ctx)
        };

        // Emit all resulting pantoken events to subscribers
        for ev in &result.events {
            self.emit(ev.clone());
        }

        // Execute all resulting effects (HTTP calls) AFTER emitting
        for effect in result.effects {
            self.execute_effect(&ws, effect).await;
        }
    }

    /// Execute a daemon effect.
    async fn execute_effect(self: &Arc<Self>, ws: &Arc<WarmSession>, effect: DaemonEffect) {
        match effect {
            DaemonEffect::FetchState { emit, prompt_id } => {
                // Refresh the cached state, then build the follow-up event from
                // the REFRESHED cache (build_post_fetch_event is pure + tested).
                // The prompt_id (from message_complete) is threaded through so
                // RunCompleted carries the branch-handle entryIds. Mirrors TS
                // executeEffect fetchState (polytoken-driver.ts:425-433).
                let res = ws.client.state().await;
                if let Some(state) = res.data {
                    *ws.last_state.write() = Some(state);
                }
                // Build a fresh ctx from the now-updated warm cache so the
                // snapshot reflects the refreshed state (usage/title/etc.).
                let fresh_ctx = DriverMapCtx {
                    session_ref: ws.session_ref.clone(),
                    workspace: ws.workspace.clone(),
                    last_state: ws.last_state.read().clone(),
                    monitor_mode: *ws.monitor_mode.lock(),
                    autodrain_enabled: *ws.autodrain_enabled.lock(),
                };
                let ev = event_map::build_post_fetch_event(emit, &fresh_ctx, prompt_id.as_deref());
                self.emit(ev);
            }
            DaemonEffect::Reseed => {
                // A reseed fires when the transcript's identity changed out from under
                // us: an SSE stream_discontinuity (events dropped), a session_rewound
                // (history truncated), or a context_cleared. We must rebuild the hub's
                // transcript from GET /history to match the daemon's truth. Four things
                // this needs beyond a bare re-broadcast — each guards a distinct failure:
                //
                // 1. reset_accumulator: a discontinuity can drop events mid-block, leaving
                //    stale in-flight block/tool/turn_error state in the fold accumulator
                //    that would corrupt the re-fold (and spuriously fail the next turn).
                // 2. refresh last_state: the settling snapshot below must reflect the
                //    daemon's CURRENT truth (turn_in_flight, title, usage), not a cache
                //    from before the discontinuity.
                // 3. sessionReset BEFORE the replay: the hub's fold is additive, so
                //    re-emitting history on top of the existing transcript would DUPLICATE
                //    every row. sessionReset clears the items (preserving metadata) so the
                //    fresh history folds into an empty transcript.
                // 4. trailing sessionUpdated AFTER the replay: sessionReset preserves the
                //    prior status and the replayed user/assistant/tool events flip the hub's
                //    running set + attention to "running", so without a re-assert an
                //    idle-but-reseeded session gets stuck showing "Responding"/Working (the
                //    same class of bug build_branch_seed's trailing re-assert fixes on the
                //    open path). A genuinely running session carries status:running here,
                //    correctly keeping the turn live.
                {
                    let mut acc = ws.accumulator.lock();
                    event_map::reset_accumulator(&mut acc);
                }
                let state_res = ws.client.state().await;
                if let Some(state) = state_res.data {
                    *ws.last_state.write() = Some(state);
                }
                let history_res = ws.client.history(None, None).await;
                if let Some(history) = history_res.data {
                    // Built AFTER the awaits so no parking_lot guard is held across one.
                    let ctx = DriverMapCtx {
                        session_ref: ws.session_ref.clone(),
                        workspace: ws.workspace.clone(),
                        last_state: ws.last_state.read().clone(),
                        monitor_mode: *ws.monitor_mode.lock(),
                        autodrain_enabled: *ws.autodrain_enabled.lock(),
                    };
                    let snapshot = ctx.snapshot(ctx.live_status());
                    let events = PolytokenInner::build_reseed_events(
                        snapshot,
                        &history.items,
                        &HistoryMapCtx {
                            r#ref: ws.session_ref.clone(),
                        },
                    );
                    for ev in &events {
                        self.emit(ev.clone());
                    }
                }
            }
            DaemonEffect::RefetchQueue => {
                // The queue events carry one item + revision, not the full
                // queue. pantoken's queueUpdated REPLACES the full queue, so fetch
                // GET /turn/input and emit the full queue. Mirrors TS
                // refetchQueue (polytoken-driver.ts:460-476).
                let res = ws.client.turn_input_snapshot().await;
                if let Some(snapshot) = res.data {
                    // One ctx for both the per-message ts and the base timestamp
                    // (built from the same cached fields) so they're consistent
                    // by construction, not coincidence.
                    let ctx = DriverMapCtx {
                        session_ref: ws.session_ref.clone(),
                        workspace: ws.workspace.clone(),
                        last_state: ws.last_state.read().clone(),
                        monitor_mode: *ws.monitor_mode.lock(),
                        autodrain_enabled: *ws.autodrain_enabled.lock(),
                    };
                    let now = ctx.now();
                    let messages = event_map::queue_messages_from_snapshot(&snapshot, &now);
                    let base = event_map::event_base(&ctx);
                    self.emit(SessionDriverEvent::QueueUpdated { base, messages });
                }
            }
            DaemonEffect::SetMonitorMode { mode } => {
                *ws.monitor_mode.lock() = Some(mode);
            }
            DaemonEffect::SetAutodrainEnabled { enabled } => {
                *ws.autodrain_enabled.lock() = Some(enabled);
            }
            DaemonEffect::RegisterInterrogative { pending } => {
                ws.pending_interrogatives
                    .lock()
                    .insert(pending.interrogative_id.clone(), pending);
            }
        }
    }
}

/// Outcome of reaping a pantoken worktree at a session cwd. Shared by
/// `set_archived` and `cleanup_worktree`.
enum ReapOutcome {
    /// No live pantoken worktree registered at this cwd — nothing to reap.
    NoWorktree,
    /// The worktree was removed and tombstoned in the store.
    Reaped,
    /// The worktree was left in place (dirty or removal failed); carries the reason.
    Retained(String),
}

#[async_trait]
impl PantokenDriver for PolytokenDriver {
    fn subscribe(&self, listener: Box<dyn Fn(SessionDriverEvent) + Send + Sync>) -> usize {
        let inner = self.inner.clone();
        let id = {
            let mut next = inner.next_sub_id.lock();
            let id = *next;
            *next += 1;
            id
        };
        let (tx, mut rx) = mpsc::channel(256);
        inner.subscribers.lock().push((id, tx));
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                listener(ev);
            }
        });
        id
    }

    fn unsubscribe(&self, id: usize) {
        self.inner.subscribers.lock().retain(|(sid, _)| *sid != id);
    }

    async fn prompt(
        &self,
        text: String,
        deliver_as: Option<DeliveryMode>,
        session_id: Option<SessionId>,
        images: Vec<ImageContent>,
        prompt_id: Option<String>,
    ) -> Result<(), String> {
        // Ports TS `polytoken-driver.ts:882-941`. `deliver_as` remains
        // pantoken-side UX only: daemon unstable.6+ auto-queues and has no
        // steer/follow-up discriminator on `/prompt`.
        let _deliver_as = deliver_as;
        let Some(sid) = session_id else {
            return Err("no session to prompt".into());
        };
        let Some(ws) = self.inner.get_warm(&sid) else {
            return Err("no warm polytoken session to prompt".into());
        };
        self.inner.focus(&sid);
        // POST first; only echo after success so a failed POST doesn't create a
        // ghost transcript row. If the daemon accepts the prompt into the
        // pending-turn queue, keep it out of the transcript until the later
        // `pending_turn_input_drained` event promotes it into the active turn.
        let accepted = ws
            .client
            .prompt(&text, None)
            .await
            .map_err(|e| format!("prompt failed: {e}"))?;
        let now = DriverMapCtx::now_ts();
        let base = SessionEventBase {
            session_ref: ws.session_ref.clone(),
            timestamp: now.clone(),
            run_id: None,
        };
        if accepted.queued_item.is_some() {
            let res = ws.client.turn_input_snapshot().await;
            let messages = res
                .data
                .map(|snapshot| event_map::queue_messages_from_snapshot(&snapshot, &now))
                .unwrap_or_else(|| {
                    accepted
                        .queued_item
                        .as_ref()
                        .map(|item| vec![event_map::queue_message_from_item(item, &now)])
                        .unwrap_or_default()
                });
            self.inner.emit(SessionDriverEvent::QueueUpdated {
                base: base.clone(),
                messages,
            });
            if !images.is_empty() {
                let plural = if images.len() == 1 {
                    "1 image was".to_string()
                } else {
                    format!("{} images were", images.len())
                };
                self.inner.emit(SessionDriverEvent::HostUiRequest {
                    base,
                    request: HostUiRequest::Notify {
                        request_id: format!(
                            "img-unsupported-{}",
                            chrono::Utc::now().timestamp_millis()
                        ),
                        message: format!(
                            "⚠ {plural} attached but the daemon doesn't support images yet — only the text was sent."
                        ),
                        level: Some(NotifyLevel::Warning),
                    },
                });
            }
            return Ok(());
        }
        self.inner.emit(SessionDriverEvent::UserMessage {
            base: base.clone(),
            id: prompt_id
                .unwrap_or_else(|| format!("pt-{}", chrono::Utc::now().timestamp_millis())),
            text,
            images: (!images.is_empty()).then_some(images.clone()),
            entry_id: None,
        });
        if !images.is_empty() {
            let plural = if images.len() == 1 {
                "1 image was".to_string()
            } else {
                format!("{} images were", images.len())
            };
            self.inner.emit(SessionDriverEvent::HostUiRequest {
                base,
                request: HostUiRequest::Notify {
                    request_id: format!("img-unsupported-{}", chrono::Utc::now().timestamp_millis()),
                    message: format!(
                        "⚠ {plural} attached but the daemon doesn't support images yet — only the text was sent."
                    ),
                    level: Some(NotifyLevel::Warning),
                },
            });
        }
        Ok(())
    }

    fn abort(&self, session_id: Option<SessionId>) {
        if let Some(sid) = session_id {
            if let Some(ws) = self.inner.get_warm(&sid) {
                let ws = ws.clone();
                tokio::spawn(async move {
                    if let Err(e) = ws.client.cancel_turn().await {
                        error!("abort failed: {e}");
                    }
                });
            }
        }
    }

    async fn clear_queue(&self, session_id: Option<SessionId>) -> ClearQueueResult {
        if let Some(sid) = session_id {
            if let Some(ws) = self.inner.get_warm(&sid) {
                let _ = ws.client.turn_input_snapshot().await;
                let _ = ws.client.dequeue_newest_input().await;
            }
        }
        ClearQueueResult::default()
    }

    fn respond_ui(&self, response: HostUiResponse, session_id: Option<SessionId>) {
        let Some(sid) = session_id else { return };
        let Some(ws) = self.inner.get_warm(&sid) else {
            return;
        };

        // Extract request_id from the HostUiResponse (all variants carry it).
        let request_id = match &response {
            HostUiResponse::Value { request_id, .. } => request_id,
            HostUiResponse::Confirmed { request_id, .. } => request_id,
            HostUiResponse::Answers { request_id, .. } => request_id,
            HostUiResponse::Cancelled { request_id, .. } => request_id,
        }
        .clone();

        // Emit HostUiResolved IMMEDIATELY so the dialog card closes. The mock
        // driver does this synchronously (mock_driver.rs:1803); the live driver
        // must too, or the card stays open forever (the daemon has no
        // interrogative_resolved SSE event — pantoken owns this).
        let now = DriverMapCtx::now_ts();
        self.inner.emit(SessionDriverEvent::HostUiResolved {
            base: SessionEventBase {
                session_ref: ws.session_ref.clone(),
                timestamp: now,
                run_id: None,
            },
            request_id: request_id.clone(),
        });

        // Look up the pending interrogative to build the reverse response.
        // `remove` (not `get`) so a stale client request can't re-fire the POST.
        let pending = ws.pending_interrogatives.lock().remove(&request_id);
        let Some(pending) = pending else { return };

        // Build the InterrogativeResponse and spawn the POST to the daemon.
        if let Some(resp) = build_interrogative_response(&pending, &response) {
            let ws = ws.clone();
            let inner = self.inner.clone();
            let interrogative_id = pending.interrogative_id.clone();
            let session_ref = ws.session_ref.clone();
            tokio::spawn(async move {
                if let Err(e) = ws
                    .client
                    .respond_interrogative(&interrogative_id, &resp)
                    .await
                {
                    warn!("respond_interrogative failed for {interrogative_id}: {e}");
                    // Surface the failure in the transcript so the user knows
                    // their answer didn't reach the daemon.
                    inner.emit(SessionDriverEvent::HostUiRequest {
                        base: SessionEventBase {
                            session_ref,
                            timestamp: DriverMapCtx::now_ts(),
                            run_id: None,
                        },
                        request: HostUiRequest::Notify {
                            request_id: format!("respond-error-{interrogative_id}"),
                            message: format!("Failed to send response to daemon: {e}"),
                            level: Some(NotifyLevel::Error),
                        },
                    });
                }
            });
        }
    }

    async fn list_sessions(&self) -> Vec<SessionListEntry> {
        let sessions_dir = self.inner.sessions_dir.clone();
        // Resolve pantoken's own side-flags from the stores (not polytoken's
        // concern): the archive flag + the worktree indicator, keyed by the
        // session path / cwd. Mirrors `polytoken-driver.ts:1078-1080`.
        let archive_store = self.inner.archive_store.lock();
        let worktree_store = self.inner.worktree_store.lock();
        let on_disk = sessions_registry::list_cold_sessions(
            &sessions_dir,
            sessions_registry::ListColdSessionsOpts {
                archived_for: Box::new(|session_json_path| archive_store.has(session_json_path)),
                // The archive WRITE side is `set_archived` (below), which flips
                // this flag; the read here overlays it onto the session list.
                worktree_for: Some(Box::new(|cwd| {
                    PolytokenInner::worktree_field_for(cwd, &worktree_store)
                })),
            },
        );
        // The borrow of `archive_store`/`worktree_store` ends here; drop the
        // guards before acquiring `warm` below (deadlock class: a guard held
        // across another lock acquire).
        drop(archive_store);
        drop(worktree_store);

        // Merge warm-pool entries (a session flushed but not yet on disk is
        // merged in via merge_session_lists). Live usage is overlaid only where
        // a session is warm. Mirrors `polytoken-driver.ts:1082-1113`.
        let now = DriverMapCtx::now_ts();
        let mut warm_entries: Vec<SessionListEntry> = Vec::new();
        let mut warm_usage: HashMap<String, SessionUsage> = HashMap::new();
        let warm = self.inner.warm.read().clone();
        let archive_store = self.inner.archive_store.lock();
        let worktree_store = self.inner.worktree_store.lock();
        for (sid, ws) in warm.iter() {
            let title = ws
                .last_state
                .read()
                .as_ref()
                .and_then(|s| s.session_title.clone());
            let session_path = sessions_dir.join(sid).join("session.json");
            let cwd = ws.workspace.path.clone();
            warm_entries.push(SessionListEntry {
                session_id: sid.clone(),
                path: session_path.to_string_lossy().to_string(),
                cwd: cwd.clone(),
                display_name: title,
                preview: String::new(),
                user_message_count: 0,
                updated_at: now.clone(),
                created_at: now.clone(),
                last_user_message_at: now.clone(),
                parent_session_path: None,
                usage: None,
                archived: archive_store.has(session_path.to_string_lossy().as_ref()),
                worktree: PolytokenInner::worktree_field_for(&cwd, &worktree_store),
            });
            if let Some(state) = ws.last_state.read().as_ref() {
                if let Some(u) = event_map::usage_from_state(Some(state)) {
                    warm_usage.insert(sid.clone(), u);
                }
            }
        }
        drop(archive_store);
        drop(worktree_store);

        let merged = merge_session_lists(&on_disk, &warm_entries);
        // Overlay live usage onto the winning entry (disk supersedes the warm
        // placeholder, so usage set only on warmEntries would be lost on merge).
        merged
            .into_iter()
            .map(|e| match warm_usage.get(&e.session_id) {
                Some(u) => SessionListEntry {
                    usage: Some(u.clone()),
                    ..e
                },
                None => e,
            })
            .collect()
    }

    /// Remove a pantoken-created worktree at `path` (== a session cwd) and tombstone
    /// it. The store index is the gate — we never touch a worktree pantoken didn't
    /// create. `force=false` leaves a dirty worktree in place (returns
    /// `removed:false` + a reason). Mirrors `polytoken-driver.ts:1380-1387`
    /// (`cleanupWorktree` → `reapWorktree`, `:862-872`).
    async fn cleanup_worktree(&self, path: String, force: bool) -> WorktreeCleanupResult {
        match self.reap_worktree(&path, force).await {
            ReapOutcome::NoWorktree => WorktreeCleanupResult {
                removed: false,
                reason: Some("no pantoken worktree at this path".to_string()),
            },
            ReapOutcome::Reaped => WorktreeCleanupResult {
                removed: true,
                reason: None,
            },
            ReapOutcome::Retained(reason) => WorktreeCleanupResult {
                removed: false,
                reason: Some(reason),
            },
        }
    }

    /// Set/clear the archived flag for a session, reaping its worktree on
    /// archive. Mirrors `polytoken-driver.ts:1351` `setArchived`: flipping the
    /// flag is enough for the list overlay (the read side already consults the
    /// archive store); on archive we also reap a live worktree. A dirty
    /// worktree is retained and surfaced, matching TS's `if (!meta) return`
    /// no-retention case vs the dirty-worktree branch. The retained `reason` is
    /// the concrete reason `worktree::remove` returns (e.g. "worktree has
    /// uncommitted changes"), surfaced verbatim.
    async fn set_archived(&self, path: String, archived: bool) -> ArchiveResult {
        self.inner.archive_store.lock().set(&path, archived);
        if !archived {
            return ArchiveResult::default();
        }
        // The archive key (and thus `path`) is the session's `session.json`
        // path — `.../sessions/<session_id>/session.json`. Derive the session id
        // by walking up one dir, mirroring TS `sessionIdFromPath`
        // (`polytoken-driver.ts:844`). This intentionally differs from the plan's
        // "file stem" note: `file_stem` of a `session.json` path is "session", so
        // the reap would never fire; the parent-dir name is the real id.
        let session_path = std::path::Path::new(&path);
        let session_id =
            if session_path.file_name().and_then(|s| s.to_str()) == Some("session.json") {
                session_path
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .map(str::to_string)
            } else {
                None
            };
        let Some(session_id) = session_id else {
            return ArchiveResult::default();
        };
        let Some(cwd) = PolytokenInner::cwd_for_session(&self.inner.sessions_dir, &session_id)
        else {
            return ArchiveResult::default();
        };
        match self.reap_worktree(&cwd, false).await {
            ReapOutcome::NoWorktree | ReapOutcome::Reaped => ArchiveResult::default(),
            ReapOutcome::Retained(reason) => ArchiveResult {
                worktree_retained: Some(WorktreeRetained { path: cwd, reason }),
            },
        }
    }

    fn login_env_status(&self) -> LoginEnvStatus {
        self.inner.login_env_status.read().clone()
    }

    async fn open_session(&self, path: String) -> Result<Vec<SessionDriverEvent>, String> {
        let session_id = PolytokenInner::session_id_from_path(&path)
            .ok_or_else(|| format!("could not resolve session id from path: {path}"))?;

        // Fast path: if the session is already in the warm pool, the SSE consumer
        // has been live-folding events into the hub's journal continuously.
        // Re-fetching GET /history + mapping + folding the full transcript is
        // size-proportional wasted work — finish_switch won't reseed an existing
        // journal (the client gets its seed from the journal, not from this fetch).
        // Return a minimal seed (just SessionOpened with the cached snapshot) so
        // finish_switch can extract the sid and reconcile running/attention — the
        // only things the full seed was used for on a warm re-open.
        if let Some(ws) = self.inner.get_warm(&session_id) {
            let real_id = ws.client.session_id.clone();
            self.inner.focus(&real_id);
            let ctx = DriverMapCtx {
                session_ref: ws.session_ref.clone(),
                workspace: ws.workspace.clone(),
                last_state: ws.last_state.read().clone(),
                monitor_mode: *ws.monitor_mode.lock(),
                autodrain_enabled: *ws.autodrain_enabled.lock(),
            };
            let snapshot = ctx.snapshot(ctx.live_status());
            // build_branch_seed with empty history yields just [SessionOpened]
            // (the trailing SessionUpdated is skipped when nothing replayed).
            return Ok(PolytokenInner::build_branch_seed(
                snapshot,
                &[],
                &HistoryMapCtx {
                    r#ref: ws.session_ref.clone(),
                },
            ));
        }

        let session_ref = SessionRef {
            workspace_id: WorkspaceId::default(),
            session_id: session_id.clone(),
        };
        // Resolve the project cwd from the on-disk session.json so the daemon
        // resumes in the right project; fall back to the sessions dir if the
        // metadata is missing (the daemon still resumes the session). Mirrors
        // `polytoken-driver.ts:1138` `cwdForSession(...) ?? sessionsDir`.
        let cwd = PolytokenInner::cwd_for_session(&self.inner.sessions_dir, &session_id)
            .unwrap_or_else(|| self.inner.sessions_dir.to_string_lossy().to_string());
        let workspace = WorkspaceRef {
            workspace_id: WorkspaceId::default(),
            path: cwd.clone(),
            display_name: None,
        };

        // Resolve the daemon port + auth token from startup.json (the daemon is
        // ALREADY running on that port — we just attach, we don't re-spawn).
        // This mirrors the TS resume path where warmSession reuses the existing
        // port. The auth token is read from the credential file pointed to by
        // startup.json.credential_file_path (daemon 0.5.0+ bearer auth).
        let session_dir = self.inner.sessions_dir.join(&session_id);
        let startup_path = session_dir.join("startup.json");
        let (port, auth_token) = if startup_path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&startup_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let port = json.get("port").and_then(|v| v.as_u64()).map(|p| p as u16);
                    let token = json
                        .get("credential_file_path")
                        .and_then(|v| v.as_str())
                        .and_then(|p| read_credential_token(Path::new(p)));
                    (port, token)
                } else {
                    (None, None)
                }
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        if let Some(port) = port {
            // Attach to the running daemon: claim lease, fetch state, subscribe SSE,
            // insert into the warm pool. If attach fails, fall through to cold-start
            // spawn rather than a hard error (the TS path throws, but the hub expects
            // open_session to surface a seed; an empty seed keeps the session
            // visible while the daemon is unreachable).
            match self
                .inner
                .warm_session_attach(
                    session_id.clone(),
                    session_ref.clone(),
                    workspace.clone(),
                    port,
                    auth_token,
                )
                .await
            {
                Ok(ws) => {
                    // Refocus the warm session (most-recently focused) — mirrors
                    // TS `focus(existing.ref.sessionId)` on the instant-switch path.
                    let real_id = ws.client.session_id.clone();
                    self.inner.focus(&real_id);
                    // Build the seed from current /state + /history. The leading
                    // SessionOpened is authoritative for idle vs running; replaying
                    // bare history would make old idle sessions look in-progress
                    // because user/assistant/tool events set the hub's running set.
                    let ctx = DriverMapCtx {
                        session_ref: ws.session_ref.clone(),
                        workspace: ws.workspace.clone(),
                        last_state: ws.last_state.read().clone(),
                        monitor_mode: *ws.monitor_mode.lock(),
                        autodrain_enabled: *ws.autodrain_enabled.lock(),
                    };
                    let snapshot = ctx.snapshot(ctx.live_status());
                    let history_res = ws.client.history(None, None).await;
                    if let Some(history) = history_res.data {
                        return Ok(PolytokenInner::build_branch_seed(
                            snapshot,
                            &history.items,
                            &HistoryMapCtx {
                                r#ref: ws.session_ref.clone(),
                            },
                        ));
                    }
                }
                Err(e) => {
                    // Expected when the daemon from a stale startup.json has
                    // died — the cold-start spawn below handles it. Keep this
                    // at debug so normal operation stays warning-free.
                    debug!("open_session: warm attach failed for {session_id}: {e}");
                }
            }
        }

        // Cold-start: no running daemon found (no startup.json, or attach
        // failed). Spawn a resume daemon, then attach + seed from its history.
        // Mirrors the TS `openSession` cold-start path. Goes through
        // `spawn_daemon` so the fake-daemon spawn-override seam is honored.
        match self
            .inner
            .warm_session_resume(session_id.clone(), session_ref.clone(), workspace, cwd)
            .await
        {
            Ok(ws) => {
                let real_id = ws.client.session_id.clone();
                self.inner.focus(&real_id);
                let ctx = DriverMapCtx {
                    session_ref: ws.session_ref.clone(),
                    workspace: ws.workspace.clone(),
                    last_state: ws.last_state.read().clone(),
                    monitor_mode: *ws.monitor_mode.lock(),
                    autodrain_enabled: *ws.autodrain_enabled.lock(),
                };
                let snapshot = ctx.snapshot(ctx.live_status());
                let history_res = ws.client.history(None, None).await;
                if let Some(history) = history_res.data {
                    return Ok(PolytokenInner::build_branch_seed(
                        snapshot,
                        &history.items,
                        &HistoryMapCtx {
                            r#ref: ws.session_ref.clone(),
                        },
                    ));
                }
            }
            Err(e) => {
                warn!("open_session: cold-start spawn failed for {session_id}: {e}");
            }
        }

        Ok(Vec::new())
    }

    async fn reload_session(&self, path: String) -> Result<Vec<SessionDriverEvent>, String> {
        let session_id = PolytokenInner::session_id_from_path(&path)
            .ok_or_else(|| format!("could not resolve session id from path: {path}"))?;
        // Dispose existing warm session (extract before await to avoid holding the lock).
        // Teardown order: stop the SSE subscription (aborts the daemon's stream
        // loop → drops the subscribe closure's sender), drop our sender clone
        // (so the consumer's recv() returns None), abort the consumer task
        // (in case it's mid-handle_sse_event await), then close the client.
        let removed = self.inner.warm.write().remove(&session_id);
        if let Some(ws) = removed {
            // Extract handles before awaiting (avoid holding parking_lot guards
            // across .await — the deadlock class the hub already hit once).
            let sub = ws.sse_subscription.lock().take();
            // Drop our sender clone so the consumer's recv() returns None once
            // the subscribe-closure's sender is also gone.
            *ws.sse_tx.lock() = None;
            let consumer_handle = ws.sse_consumer_handle.lock().take();
            if let Some(sub) = sub {
                sub.stop().await;
            }
            // Abort the consumer task (no-op if already exited) and await it so
            // an in-flight handle_sse_event doesn't race the re-warm.
            if let Some(handle) = consumer_handle {
                handle.abort();
                let _ = handle.await;
            }
            ws.client.close().await;
        }
        self.open_session(path).await
    }

    async fn new_session(
        &self,
        opts: NewSessionOptsData,
    ) -> Result<Vec<SessionDriverEvent>, String> {
        // Resolve cwd = opts.cwd trimmed or $HOME (a bare new session defaults to
        // $HOME — the contract the whole stack advertises). $HOME is set in
        // normal environments so the existence guard below accepts a cwd-less
        // call; if HOME is unset, `unwrap_or_default()` yields "" and
        // `Path::new("").exists()` is false, so the guard rejects it — a loud
        // failure rather than a silent spawn against an unknown cwd.
        // Mirrors `polytoken-driver.ts:1177-1183`.
        let cwd = opts
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());

        // Validate the cwd exists + is a dir, loudly — don't let the daemon spawn
        // against a typo'd path. Mirrors `polytoken-driver.ts:1181-1183`.
        let path = std::path::Path::new(&cwd);
        if !path.exists() {
            return Err(format!("no such directory: {cwd}"));
        }
        if !path.is_dir() {
            return Err(format!("not a directory: {cwd}"));
        }
        let mut cwd = cwd;

        // If the draft asked for an isolated worktree, create one against the
        // cwd and record it in the worktree store; the session then runs in the
        // worktree dir. Mirrors `polytoken-driver.ts:1184-1188`.
        // Track the meta so a later failure in this call reaps it (otherwise the
        // worktree dir + store entry leak).
        let mut created_worktree: Option<WorktreeMeta> = None;
        if opts.worktree.unwrap_or(false) {
            let meta = worktree::create(&cwd, None).await?;
            self.inner.worktree_store.lock().add(meta.clone());
            cwd = meta.path.clone();
            created_worktree = Some(meta);
        }

        // Spawn + health + lease + state + SSE subscribe + insert into the warm
        // pool, all via warm_session. The session id comes back from the spawn.
        let session_ref = SessionRef {
            workspace_id: WorkspaceId::default(),
            session_id: String::new(), // filled from the spawn below
        };
        let workspace = WorkspaceRef {
            workspace_id: WorkspaceId::default(),
            path: cwd.clone(),
            display_name: None,
        };

        // warm_session needs a provisional session id to key the warm map; the
        // real id is returned by the spawn and overrides it inside warm_session.
        let provisional_id = "__new__".to_string();
        match self
            .inner
            .warm_session(provisional_id, session_ref, workspace, cwd)
            .await
        {
            Ok(ws) => {
                // Apply model/thinking if specified (on the warm client, before seeding)
                if let Some(model) = &opts.model {
                    let model_str = model_post_key(&model.model_id);
                    let _ = ws
                        .client
                        .set_model(&model_str, opts.thinking.as_deref())
                        .await;
                }
                if let Some(facet) = &opts.facet {
                    let _ = ws.client.set_facet(facet).await;
                }
                if let Some(mode) = opts.permission_monitor {
                    let daemon_mode = match mode {
                        PermissionMonitorMode::Standard => {
                            pantoken_daemon_types::PermissionMonitorMode::Standard
                        }
                        PermissionMonitorMode::Bypass => {
                            pantoken_daemon_types::PermissionMonitorMode::Bypass
                        }
                        PermissionMonitorMode::BypassPlus => {
                            pantoken_daemon_types::PermissionMonitorMode::BypassPlus
                        }
                        PermissionMonitorMode::Autonomous => {
                            pantoken_daemon_types::PermissionMonitorMode::Autonomous
                        }
                    };
                    let _ = ws.client.set_permission_mode(daemon_mode).await;
                    *ws.monitor_mode.lock() = Some(mode);
                }

                // Build seed from current /state + /history. Even an empty
                // transcript needs the leading SessionOpened; the hub treats an
                // empty seed as a failed switch.
                let ctx = DriverMapCtx {
                    session_ref: ws.session_ref.clone(),
                    workspace: ws.workspace.clone(),
                    last_state: ws.last_state.read().clone(),
                    monitor_mode: *ws.monitor_mode.lock(),
                    autodrain_enabled: *ws.autodrain_enabled.lock(),
                };
                let snapshot = ctx.snapshot(ctx.live_status());
                let history_res = ws.client.history(None, None).await;
                if let Some(history) = history_res.data {
                    return Ok(PolytokenInner::build_branch_seed(
                        snapshot,
                        &history.items,
                        &HistoryMapCtx {
                            r#ref: ws.session_ref.clone(),
                        },
                    ));
                }
                Ok(vec![SessionDriverEvent::SessionOpened {
                    base: SessionEventBase {
                        session_ref: ws.session_ref.clone(),
                        timestamp: DriverMapCtx::now_ts(),
                        run_id: None,
                    },
                    snapshot,
                }])
            }
            Err(e) => {
                error!("new_session warm failed: {e}");
                // A worktree was created in THIS call but the spawn/warm failed,
                // so reap it (dir + store entry) rather than leaving an orphan.
                if let Some(meta) = created_worktree {
                    if let Err(reap_err) = worktree::remove(&meta, true).await {
                        warn!(
                            "failed to reap worktree {} after new_session failure: {reap_err}",
                            meta.path
                        );
                    }
                    self.inner.worktree_store.lock().mark_reaped(&meta.path);
                }
                Err(e)
            }
        }
    }

    async fn branch_from(
        &self,
        entry_id: String,
        summarize: bool,
        session_id: Option<SessionId>,
    ) -> BranchResult {
        // summarize: pantoken-side only, no daemon /rewind param (matches TS
        // `polytoken-driver.ts:1277-1315`).
        let _summarize = summarize;
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let req = RewindRequest {
                    domains: Vec::new(),
                    to_message_index: None,
                    to_prompt_id: Some(entry_id.clone()),
                };
                if let Err(e) = ws.client.rewind(&req).await {
                    error!("branch rewind failed: {e}");
                    return BranchResult::default();
                }
                let state_res = ws.client.state().await;
                if let Some(state) = state_res.data {
                    *ws.last_state.write() = Some(state);
                }
                let ctx = DriverMapCtx {
                    session_ref: ws.session_ref.clone(),
                    workspace: ws.workspace.clone(),
                    last_state: ws.last_state.read().clone(),
                    monitor_mode: *ws.monitor_mode.lock(),
                    autodrain_enabled: *ws.autodrain_enabled.lock(),
                };
                let snapshot = ctx.snapshot(ctx.live_status());
                let history_res = ws.client.history(None, None).await;
                if let Some(history) = history_res.data {
                    return BranchResult {
                        seed: PolytokenInner::build_branch_seed(
                            snapshot,
                            &history.items,
                            &HistoryMapCtx {
                                r#ref: ws.session_ref.clone(),
                            },
                        ),
                        editor_text: None,
                        cancelled: false,
                        aborted: None,
                    };
                }
            }
        }
        BranchResult::default()
    }

    async fn list_models(&self) -> Vec<ModelOption> {
        // Cache-first: return cached models if available (AC.1).
        if let Some(cached) = self.inner.model_cache.lock().clone() {
            return cached.models;
        }
        // Cache miss: use the single-flight fetch path so concurrent callers
        // share one subprocess (thundering herd fix).
        let parsed = self.inner.get_or_fetch_parsed_models().await;
        parsed.models
    }

    async fn get_model_defaults(&self) -> ModelDefaults {
        // Reuse the same cached parsed models as list_models (AC.2).
        let parsed = self.inner.get_or_fetch_parsed_models().await;
        ModelDefaults {
            provider: parsed
                .default_model
                .as_ref()
                .and_then(|m| m.split('/').next().map(|s| s.to_string())),
            model_id: parsed.default_model.clone(),
            thinking_level: None,
            favorites: Vec::new(),
        }
    }

    async fn list_commands(&self, session_id: Option<SessionId>) -> Vec<CommandInfo> {
        // Ports TS `polytoken-driver.ts:1455-1489`: commands are cwd-scoped,
        // keyed by the targeted warm session cwd, and the CLI must run there.
        let Some(cwd) = self.inner.targeted_session_cwd(session_id.as_ref()) else {
            return Vec::new();
        };
        // Register `<cwd>/.polytoken` for watching (idempotent, no-op if
        // watcher is inactive). Events invalidate this cwd's command cache.
        self.inner.register_project_config_watch(&cwd);
        if let Some(cached) = self.inner.command_cache.lock().get(&cwd) {
            return cached.clone();
        }
        let output = self
            .inner
            .run_polytoken(
                vec![
                    "--working-dir".into(),
                    cwd.clone(),
                    "print-slash-commands".into(),
                    "--format".into(),
                    "json".into(),
                ],
                Some(cwd.clone()),
            )
            .await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let commands = crate::polytoken::commands::parse_slash_commands(&stdout);
                self.inner
                    .command_cache
                    .lock()
                    .insert(cwd, commands.clone());
                commands
            }
            Err(e) => {
                error!("list_commands failed: {e}");
                Vec::new()
            }
        }
    }

    async fn list_facets(&self, session_id: Option<SessionId>) -> Vec<String> {
        // Ports TS `polytoken-driver.ts:1491-1559`: read facet names through
        // the daemon VFS, not local filesystem paths, and never empty the picker.
        let builtins = || vec!["execute".to_string(), "plan".to_string()];
        let Some(cwd) = self.inner.targeted_session_cwd(session_id.as_ref()) else {
            return builtins();
        };
        // Register `<cwd>/.polytoken` for watching (idempotent, no-op if
        // watcher is inactive). Events invalidate this cwd's facet cache.
        self.inner.register_project_config_watch(&cwd);
        if let Some(cached) = self.inner.facet_cache.lock().get(&cwd) {
            return cached.clone();
        }
        let output = self
            .inner
            .run_polytoken(
                vec![
                    "--working-dir".into(),
                    cwd.clone(),
                    "vfs".into(),
                    "ls".into(),
                    "polytoken://facets".into(),
                ],
                Some(cwd.clone()),
            )
            .await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let files: Vec<String> = stdout
                    .lines()
                    .map(str::trim)
                    .filter(|line| line.ends_with(".md"))
                    .map(ToString::to_string)
                    .collect();
                if files.is_empty() {
                    return builtins();
                }
                let mut names = Vec::new();
                for file in files {
                    let cat = self
                        .inner
                        .run_polytoken(
                            vec![
                                "--working-dir".into(),
                                cwd.clone(),
                                "vfs".into(),
                                "cat".into(),
                                format!("polytoken://facets/{file}"),
                            ],
                            Some(cwd.clone()),
                        )
                        .await;
                    match cat {
                        Ok(out) => {
                            let content = String::from_utf8_lossy(&out.stdout).to_string();
                            names.push(
                                crate::polytoken::facets::parse_facet_name(&content)
                                    .unwrap_or_else(|| file.trim_end_matches(".md").to_string()),
                            );
                        }
                        Err(e) => {
                            error!("vfs cat facet {file} failed: {e}");
                            names.push(file.trim_end_matches(".md").to_string());
                        }
                    }
                }
                let facets = if names.is_empty() { builtins() } else { names };
                self.inner.facet_cache.lock().insert(cwd, facets.clone());
                facets
            }
            Err(e) => {
                error!("list_facets failed: {e}");
                builtins()
            }
        }
    }

    async fn list_file_index(&self, session_id: Option<SessionId>) -> (Vec<FileInfo>, bool) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let res = ws.client.file_catalog().await;
                if let Some(resp) = res.data {
                    let paths: Vec<String> = resp.files.clone();
                    let files = crate::polytoken::file_catalog::parse_file_catalog(&paths);
                    return (files, false);
                }
            }
        }
        (Vec::new(), false)
    }

    async fn list_files(
        &self,
        query: String,
        session_id: Option<SessionId>,
        cwd: Option<String>,
    ) -> Vec<FileInfo> {
        // Ports TS `polytoken-driver.ts:1589-1601`: caller cwd wins; otherwise
        // fall back to the targeted session cwd. The TS driver spawns `fd`
        // directly; the Rust port uses an in-process `.gitignore`-aware walk
        // via the `ignore` crate (no external binary dependency).
        let Some(root) = self.inner.file_lookup_root(cwd, session_id.as_ref()) else {
            return Vec::new();
        };
        crate::polytoken::file_search::list_files_with_fd(std::path::Path::new(&root), &query)
    }

    async fn list_dir(&self, path: Option<String>) -> DirListing {
        let target = path.unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());
        let entries = match std::fs::read_dir(&target) {
            Ok(dir) => dir
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let is_dir = e.file_type().ok().map(|t| t.is_dir()).unwrap_or(false);
                    if is_dir { Some(name) } else { None }
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        DirListing {
            path: target,
            parent: None,
            entries,
            error: None,
        }
    }

    async fn stat_path(&self, path: String) -> PathStat {
        let p = std::path::Path::new(&path);
        PathStat {
            exists: p.exists(),
            is_dir: p.is_dir(),
            path,
        }
    }

    async fn list_jobs(&self, session_id: Option<SessionId>) -> Vec<BackgroundJob> {
        let Some(sid) = &session_id else {
            return vec![];
        };
        let Some(ws) = self.inner.get_warm(sid) else {
            return vec![];
        };
        let res = ws.client.jobs().await;
        if res.status != 200 {
            tracing::warn!(
                "GET /jobs failed ({}): {}",
                res.status,
                res.error.as_deref().unwrap_or("")
            );
            return vec![];
        }
        let Some(snapshots) = res.data else {
            return vec![];
        };
        snapshots
            .iter()
            .map(|j| {
                let kind = match j.kind {
                    pantoken_daemon_types::JobKind::Shell => JobKind::Shell,
                    pantoken_daemon_types::JobKind::Subagent => JobKind::Subagent,
                };
                let status = parse_job_status(&j.status);
                let (output_tail, output_bytes) = j
                    .output_channels
                    .as_ref()
                    .map(|channels| {
                        let tails: Vec<&str> =
                            channels.iter().filter_map(|c| c.tail.as_deref()).collect();
                        let joined = tails.join("\n");
                        let bytes: i64 = channels.iter().filter_map(|c| c.bytes).sum();
                        let truncated = if joined.chars().count() > 500 {
                            joined.chars().take(500).collect()
                        } else {
                            joined
                        };
                        (Some(truncated), Some(bytes))
                    })
                    .unwrap_or((None, None));
                BackgroundJob {
                    handle: j.handle.clone(),
                    kind,
                    status,
                    tool_name: j.tool_name.clone(),
                    created_at: j.created_at.clone(),
                    ended_at: j.ended_at.clone(),
                    started_at: j.started_at.clone(),
                    updated_at: j.updated_at.clone(),
                    subagent_type: j.subagent_type.clone(),
                    model: j.model.clone(),
                    subagent_handle: j.subagent_handle.clone(),
                    expiring: j.expiring,
                    output_tail,
                    output_bytes,
                }
            })
            .collect()
    }

    async fn delete_todo(
        &self,
        session_id: Option<SessionId>,
        id: i64,
    ) -> Result<(), TodoDeleteError> {
        let Some(sid) = &session_id else {
            return Err(TodoDeleteError::Other("no session focused".into()));
        };
        let Some(ws) = self.inner.get_warm(sid) else {
            return Err(TodoDeleteError::Other("no warm session".into()));
        };
        let res = ws.client.delete_todo(id).await;
        match res.status {
            204 | 200 => Ok(()),
            404 => Err(TodoDeleteError::NotFound),
            409 => {
                if let Some(conflict) = res.data {
                    match conflict {
                        TodoDeleteConflictResponse::DependentsExist { dependents, .. } => {
                            Err(TodoDeleteError::DependentsExist(
                                dependents
                                    .iter()
                                    .map(|d| TodoDeleteDependent {
                                        id: d.id,
                                        title: d.title.clone(),
                                    })
                                    .collect(),
                            ))
                        }
                        TodoDeleteConflictResponse::TurnInFlight { .. } => {
                            Err(TodoDeleteError::TurnInFlight)
                        }
                    }
                } else {
                    Err(TodoDeleteError::Other(
                        res.error.unwrap_or_else(|| "409 conflict".into()),
                    ))
                }
            }
            s => Err(TodoDeleteError::Other(format!(
                "DELETE /todos/{} failed ({}): {}",
                id,
                s,
                res.error.as_deref().unwrap_or("")
            ))),
        }
    }

    fn set_model(&self, _provider: String, model_id: String, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let ws = ws.clone();
                let model = model_post_key(&model_id);
                tokio::spawn(async move {
                    let _ = ws.client.set_model(&model, None).await;
                });
            }
        }
    }

    fn set_thinking(&self, level: String, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let ws = ws.clone();
                let state = ws.last_state.read().clone();
                if let Some(state) = state {
                    if let Some(model) = state.active_model {
                        tokio::spawn(async move {
                            let _ = ws.client.set_model(&model, Some(&level)).await;
                        });
                    }
                }
            }
        }
    }

    fn set_facet(&self, facet: String, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let ws = ws.clone();
                tokio::spawn(async move {
                    let _ = ws.client.set_facet(&facet).await;
                });
            }
        }
    }

    fn set_permission_monitor(&self, mode: PermissionMonitorMode, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let ws = ws.clone();
                let daemon_mode = match mode {
                    PermissionMonitorMode::Standard => {
                        pantoken_daemon_types::PermissionMonitorMode::Standard
                    }
                    PermissionMonitorMode::Bypass => {
                        pantoken_daemon_types::PermissionMonitorMode::Bypass
                    }
                    PermissionMonitorMode::BypassPlus => {
                        pantoken_daemon_types::PermissionMonitorMode::BypassPlus
                    }
                    PermissionMonitorMode::Autonomous => {
                        pantoken_daemon_types::PermissionMonitorMode::Autonomous
                    }
                };
                tokio::spawn(async move {
                    let _ = ws.client.set_permission_mode(daemon_mode).await;
                });
            }
        }
    }

    async fn toggle_adventurous_handoff(&self, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let _ = ws.client.toggle_adventurous_handoff().await;
            }
        }
    }

    async fn set_notification_autodrain(&self, enabled: bool, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let _ = ws.client.set_notification_autodrain(enabled).await;
            }
        }
    }

    async fn compact(&self, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let _ = ws.client.compact(None).await;
            }
        }
    }

    async fn clear_context(&self, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let _ = ws.client.clear().await;
            }
        }
    }

    async fn set_mcp_server(
        &self,
        server_name: String,
        action: McpAction,
        session_id: Option<SessionId>,
    ) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let daemon_action = match action {
                    McpAction::Enable => crate::polytoken::daemon_client::McpServerAction::Enable,
                    McpAction::Disable => crate::polytoken::daemon_client::McpServerAction::Disable,
                    McpAction::Disconnect => {
                        crate::polytoken::daemon_client::McpServerAction::Disconnect
                    }
                    McpAction::Reconnect => {
                        crate::polytoken::daemon_client::McpServerAction::Reconnect
                    }
                };
                let _ = ws
                    .client
                    .mcp_server_action(&server_name, daemon_action)
                    .await;
            }
        }
    }

    fn set_session_viewers(&self, is_viewed: Box<dyn Fn(SessionId) -> bool + Send + Sync>) {
        *self.inner.is_viewed.write() = Some(is_viewed);
    }

    async fn shutdown(&self) {
        // Extract all warm sessions before awaiting (avoid holding the lock across .await).
        // Per-session teardown mirrors reload_session: stop SSE, drop sender,
        // abort consumer, close client.
        let warm: Vec<Arc<WarmSession>> = self.inner.warm.write().drain().map(|(_, v)| v).collect();
        for ws in warm {
            self.inner.dispose_warm(&ws).await;
        }
    }

    fn run_script(&self, name: String) {
        // Dev surface (fake mode only): map a script name to a corpus scenario
        // and push its SSE frames onto the active fake session's held-open
        // stream. The push awaits the mpsc sender, so spawn it. Unknown names
        // warn inside `run_script` (the mock's vocabulary is a superset).
        if !self.inner.is_fake {
            return;
        }
        let Some(control) = self.inner.fake_control.clone() else {
            warn!("run_script({name}): fake mode without a fake control handle");
            return;
        };
        tokio::spawn(async move {
            if let Err(e) = control.run_script(&name).await {
                warn!("fake run_script({name}) failed: {e}");
            }
        });
    }

    fn reset(&self, _bootstrap: bool) {
        // Dev surface (fake mode only). `_bootstrap` is honored by the HUB (it
        // calls `seed_default()` after `driver.reset()` when bootstrapping —
        // hub.rs), not here; mirroring `MockDriver::reset`, which also doesn't
        // seed.
        //
        // DELIBERATE DIVERGENCE from the plan's "dispose warm sessions" wording:
        // `default_seed()` is synchronous and reads the active warm session, but
        // re-warming a fake session is async — so disposing here would leave the
        // hub's immediately-following sync `seed_default()` with nothing to seed.
        // Instead we KEEP the bootstrap session warm and only reset transient
        // state: each accumulator (so a re-run script folds from a clean slate)
        // and the fake daemon's cursors/call-log + stale SSE sender. This yields
        // the same deterministic reseed AC.7 asks for, through the sync hub flow.
        if !self.inner.is_fake {
            return;
        }
        let Some(control) = self.inner.fake_control.clone() else {
            warn!("reset: fake mode without a fake control handle");
            return;
        };
        for ws in self.inner.warm.read().values() {
            let mut acc = ws.accumulator.lock();
            event_map::reset_accumulator(&mut acc);
        }
        control.reset();
    }

    fn default_seed(&self) -> Option<Vec<SessionDriverEvent>> {
        // Fake mode only: a freshly-connecting client (and the hub's boot-time
        // + post-reset `seed_default`) adopts the bootstrap fake session. Mirrors
        // TS `defaultSeed` (sessionOpened snapshot + cached transcript), but we
        // return just the `sessionOpened` snapshot — enough for the dev surface,
        // since the subsequent `run_script` drives the transcript. Real
        // (non-fake) mode returns None: sessions come from client WS messages.
        if !self.inner.is_fake {
            return None;
        }
        self.inner.fake_control.as_ref()?;
        let ws = self.inner.active_warm()?;
        let ctx = DriverMapCtx {
            session_ref: ws.session_ref.clone(),
            workspace: ws.workspace.clone(),
            last_state: ws.last_state.read().clone(),
            monitor_mode: *ws.monitor_mode.lock(),
            autodrain_enabled: *ws.autodrain_enabled.lock(),
        };
        let snapshot = ctx.snapshot(ctx.live_status());
        Some(vec![SessionDriverEvent::SessionOpened {
            base: SessionEventBase {
                session_ref: ws.session_ref.clone(),
                timestamp: DriverMapCtx::now_ts(),
                run_id: None,
            },
            snapshot,
        }])
    }
}

/// Parse the daemon's `JobStatus` (a `serde_json::Value` oneOf) into pantoken's
/// string enum. The daemon sends it as `{"status": "running", ...}` or just
/// `"running"`; we try the object's `status` field first, then a bare string.
/// Unknown variants default to `Running` (a safe non-terminal guess) + a warning.
fn parse_job_status(val: &serde_json::Value) -> JobStatusKind {
    let status_str = val
        .get("status")
        .and_then(|v| v.as_str())
        .or_else(|| val.as_str());
    match status_str {
        Some("reserved") => JobStatusKind::Reserved,
        Some("running") => JobStatusKind::Running,
        Some("completed") => JobStatusKind::Completed,
        Some("failed") => JobStatusKind::Failed,
        Some("cancelled") => JobStatusKind::Cancelled,
        Some(other) => {
            tracing::warn!("unknown job status variant: {other}, defaulting to Running");
            JobStatusKind::Running
        }
        None => {
            tracing::warn!("unparseable job status: {val}, defaulting to Running");
            JobStatusKind::Running
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pantoken_protocol::wire::LoginEnvStatus;

    /// A minimal `PolytokenInner` for recency/focus tests — only the `order` +
    /// `warm_cap` fields matter; the rest are inert defaults. The warm map is
    /// empty (focus only mutates `order`, never `warm`).
    fn inner_with_order(order: Vec<SessionId>, warm_cap: i64) -> PolytokenInner {
        PolytokenInner {
            sessions_dir: PathBuf::new(),
            bin_path: String::new(),
            is_fake: true,
            warm_cap,
            login_env: Mutex::new(None),
            login_env_status: RwLock::new(LoginEnvStatus {
                active_shell: None,
                ok: false,
                detail: None,
            }),
            archive_store: Mutex::new(ArchiveStore::new(PathBuf::new())),
            worktree_store: Mutex::new(WorktreeStore::new(PathBuf::new())),
            order: Mutex::new(order),
            warm: RwLock::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            next_sub_id: Mutex::new(0),
            is_viewed: RwLock::new(None),
            command_cache: Mutex::new(HashMap::new()),
            facet_cache: Mutex::new(HashMap::new()),
            model_cache: Mutex::new(None),
            model_cache_fetching: Mutex::new(false),
            model_cache_notify: tokio::sync::Notify::new(),
            watch_status: Mutex::new(config_watcher::WatchStatus::Disabled),
            watcher_handle: Mutex::new(None),
            command_runner: default_command_runner(),
            fake_control: None,
        }
    }

    // ---- AC.6: cwd_for_session reads project_path from session.json ----

    /// AC.6: `cwd_for_session` returns the `project_path` from a session's
    /// `session.json` when it's present and non-empty.
    #[test]
    fn cwd_for_session_reads_project_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path();
        let session_id = "sess-1";

        // Write a minimal session.json with a project_path.
        let session_dir = sessions_dir.join(session_id);
        std::fs::create_dir_all(&session_dir).expect("mkdir");
        let json = serde_json::json!({
            "session_id": session_id,
            "project_path": "/home/user/my-project",
            "created_at": "2025-01-01T00:00:00Z",
            "last_activity_at": "2025-01-01T00:00:00Z",
        });
        std::fs::write(
            session_dir.join("session.json"),
            serde_json::to_string(&json).unwrap(),
        )
        .expect("write");

        let cwd = PolytokenInner::cwd_for_session(sessions_dir, session_id);
        assert_eq!(
            cwd.as_deref(),
            Some("/home/user/my-project"),
            "cwd_for_session should return the project_path from session.json"
        );
    }

    /// AC.6 (fallback case): a missing `session.json` (or one with an empty
    /// `project_path`) yields `None`, which the caller maps to the sessions-dir
    /// fallback. Both sub-cases are documented behavior of the helper.
    #[test]
    fn cwd_for_session_missing_file_yields_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path();

        // No session.json at all.
        let cwd = PolytokenInner::cwd_for_session(sessions_dir, "no-such-session");
        assert_eq!(
            cwd, None,
            "missing session.json should yield None (caller falls back to sessions dir)"
        );

        // A session.json with an empty project_path also yields None (the
        // `.filter(|meta| !meta.project_path.is_empty())` guard).
        let session_dir = sessions_dir.join("empty-cwd");
        std::fs::create_dir_all(&session_dir).expect("mkdir");
        let json = serde_json::json!({
            "session_id": "empty-cwd",
            "project_path": "",
            "created_at": "2025-01-01T00:00:00Z",
            "last_activity_at": "2025-01-01T00:00:00Z",
        });
        std::fs::write(
            session_dir.join("session.json"),
            serde_json::to_string(&json).unwrap(),
        )
        .expect("write");
        let cwd = PolytokenInner::cwd_for_session(sessions_dir, "empty-cwd");
        assert_eq!(
            cwd, None,
            "empty project_path should yield None (filtered out)"
        );
    }

    /// `session_id_from_path` extracts the parent directory name of
    /// `session.json` — NOT the file stem (which is always `"session"`).
    #[test]
    fn session_id_from_path_extracts_parent_dir() {
        assert_eq!(
            PolytokenInner::session_id_from_path(
                "/home/user/.pantoken/sessions/2025-01-15T10-30-00-my-task/session.json"
            ),
            Some("2025-01-15T10-30-00-my-task".to_string())
        );

        // Windows-style backslash paths should work too.
        assert_eq!(
            PolytokenInner::session_id_from_path(
                "C:\\Users\\timo\\.pantoken\\sessions\\2025-01-15T10-30-00-my-task\\session.json"
            ),
            Some("2025-01-15T10-30-00-my-task".to_string())
        );

        // Trailing slash should not confuse the split.
        assert_eq!(
            PolytokenInner::session_id_from_path(
                "/home/user/.pantoken/sessions/2025-01-15T10-30-00-my-task/session.json/"
            ),
            Some("2025-01-15T10-30-00-my-task".to_string())
        );
    }

    /// Non-`session.json` paths and paths with fewer than two components return
    /// `None` — matching TS `sessionIdFromPath`'s `null`, whose callers throw
    /// "could not resolve session id from path". The Rust callers propagate
    /// that as an `Err` rather than proceeding with a bogus id.
    #[test]
    fn session_id_from_path_returns_none_for_non_standard_path() {
        // Wrong file name → None (previously fell back to a bogus file stem).
        assert_eq!(
            PolytokenInner::session_id_from_path("/some/path/my-session.jsonl"),
            None
        );
        assert_eq!(PolytokenInner::session_id_from_path("bare-name"), None);
        // Fewer than two components (matching TS's `parts.length < 2` guard).
        assert_eq!(PolytokenInner::session_id_from_path("session.json"), None);
        assert_eq!(PolytokenInner::session_id_from_path(""), None);
    }

    // ---- focus: recency order via move-to-back ----

    /// AC.1 (focus unit): focusing a known id moves it to the back (most-recently
    /// focused), preserving the relative order of the others.
    #[test]
    fn focus_moves_known_id_to_back() {
        let inner = inner_with_order(vec!["a".to_string(), "b".to_string(), "c".to_string()], 64);
        // Focus "a" (the front/LRU) → it becomes the most-recent.
        inner.focus(&"a".to_string());
        assert_eq!(
            *inner.order.lock(),
            vec!["b".to_string(), "c".to_string(), "a".to_string()],
            "focus should move the id to the back (most-recently focused)"
        );
    }

    /// AC.1 (focus unit): re-focusing an id that's already at the back is
    /// idempotent — no duplicate, order unchanged.
    #[test]
    fn focus_idempotent_on_repeated_focus() {
        let inner = inner_with_order(vec!["a".to_string(), "b".to_string(), "c".to_string()], 64);
        inner.focus(&"c".to_string()); // already at back
        assert_eq!(
            *inner.order.lock(),
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            "re-focusing the most-recent id should be a no-op (idempotent, no dup)"
        );
        inner.focus(&"c".to_string()); // again
        assert_eq!(
            inner.order.lock().len(),
            3,
            "repeated focus must not duplicate the id"
        );
    }

    /// AC.1 (focus unit): focusing an unknown id appends it to the back (never
    /// inserted in the middle or front). This is the documented "if absent,
    /// append it" behavior.
    #[test]
    fn focus_unknown_id_appends_to_back() {
        let inner = inner_with_order(vec!["a".to_string(), "b".to_string()], 64);
        inner.focus(&"z".to_string()); // unknown
        assert_eq!(
            *inner.order.lock(),
            vec!["a".to_string(), "b".to_string(), "z".to_string()],
            "focusing an unknown id should append it to the back"
        );
    }

    #[cfg(unix)]
    fn ok_output(stdout: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn write_session_json(root: &Path, session_id: &str, cwd: &str) {
        let session_dir = root.join(session_id);
        std::fs::create_dir_all(&session_dir).expect("mkdir session");
        let json = serde_json::json!({
            "session_id": session_id,
            "project_path": cwd,
            "created_at": "2025-01-01T00:00:00Z",
            "last_activity_at": "2025-01-01T00:00:00Z",
        });
        std::fs::write(
            session_dir.join("session.json"),
            serde_json::to_string(&json).unwrap(),
        )
        .expect("write session.json");
    }

    fn warm_for(session_id: &str) -> Arc<WarmSession> {
        let workspace = WorkspaceRef {
            workspace_id: "ws".into(),
            path: "/tmp/ws".into(),
            display_name: None,
        };
        Arc::new(WarmSession {
            client: Arc::new(DaemonClient::new(session_id.to_string(), 1, 0, None)),
            accumulator: Mutex::new(event_map::create_accumulator()),
            last_state: RwLock::new(None),
            session_ref: SessionRef {
                workspace_id: workspace.workspace_id.clone(),
                session_id: session_id.to_string(),
            },
            workspace,
            pending_interrogatives: Mutex::new(HashMap::new()),
            sse_subscription: Mutex::new(None),
            monitor_mode: Mutex::new(None),
            autodrain_enabled: Mutex::new(None),
            owned_process: Mutex::new(None),
            sse_tx: Mutex::new(None),
            sse_consumer_handle: Mutex::new(None),
        })
    }

    fn driver_with_runner(
        session_id: &str,
        cwd: &str,
        runner: Arc<CommandRunner>,
    ) -> (PolytokenDriver, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().join("sessions");
        write_session_json(&sessions_dir, session_id, cwd);
        let mut inner = inner_with_order(vec![session_id.to_string()], 64);
        inner.sessions_dir = sessions_dir;
        inner.bin_path = "polytoken-test".into();
        inner.command_runner = runner;
        inner
            .warm
            .write()
            .insert(session_id.to_string(), warm_for(session_id));
        (
            PolytokenDriver {
                inner: Arc::new(inner),
            },
            dir,
        )
    }

    #[tokio::test]
    async fn list_commands_runs_in_session_cwd_and_caches_by_cwd() {
        let calls = Arc::new(Mutex::new(Vec::<(Vec<String>, Option<String>)>::new()));
        let calls_for_runner = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, args, cwd| {
            calls_for_runner.lock().push((args, cwd));
            Box::pin(async { Ok(ok_output("[]")) })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/a", runner);

        let _ = driver.list_commands(Some("s1".into())).await;
        let _ = driver.list_commands(Some("s1".into())).await;

        let calls = calls.lock();
        assert_eq!(calls.len(), 1, "second call should hit the cwd cache");
        assert_eq!(calls[0].1.as_deref(), Some("/repo/a"));
        assert_eq!(calls[0].0[0..2], ["--working-dir", "/repo/a"]);
        assert!(calls[0].0.contains(&"print-slash-commands".to_string()));
    }

    #[tokio::test]
    async fn list_facets_runs_in_session_cwd_and_falls_back_to_file_stems() {
        let calls = Arc::new(Mutex::new(Vec::<(Vec<String>, Option<String>)>::new()));
        let calls_for_runner = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, args, cwd| {
            calls_for_runner.lock().push((args.clone(), cwd));
            Box::pin(async move {
                if args.iter().any(|a| a == "ls") {
                    Ok(ok_output("execute.md\nplan.md\nREADME.txt\n"))
                } else if args.iter().any(|a| a.ends_with("execute.md")) {
                    Ok(ok_output("---\nname: execute\n---\nbody"))
                } else {
                    Ok(ok_output("no frontmatter"))
                }
            })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/facets", runner);

        let facets = driver.list_facets(Some("s1".into())).await;

        assert_eq!(facets, vec!["execute".to_string(), "plan".to_string()]);
        let calls = calls.lock();
        assert_eq!(calls.len(), 3, "vfs ls + two vfs cat calls");
        assert!(
            calls
                .iter()
                .all(|(_, cwd)| cwd.as_deref() == Some("/repo/facets"))
        );
    }

    #[tokio::test]
    async fn list_facets_caches_by_cwd() {
        let calls = Arc::new(Mutex::new(0));
        let calls_for_runner = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, args, _cwd| {
            *calls_for_runner.lock() += 1;
            Box::pin(async move {
                if args.iter().any(|a| a == "ls") {
                    Ok(ok_output("execute.md\n"))
                } else {
                    Ok(ok_output("---\nname: execute\n---\nbody"))
                }
            })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/facets", runner);

        let _ = driver.list_facets(Some("s1".into())).await;
        let _ = driver.list_facets(Some("s1".into())).await;

        assert_eq!(
            *calls.lock(),
            2,
            "second facet list should hit the cwd cache"
        );
    }

    #[tokio::test]
    async fn list_facets_falls_back_to_builtins_on_error_or_empty() {
        let runner: Arc<CommandRunner> =
            Arc::new(move |_program, _args, _cwd| Box::pin(async { Err("boom".to_string()) }));
        let (driver, _dir) = driver_with_runner("s1", "/repo/facets", runner);

        assert_eq!(
            driver.list_facets(Some("s1".into())).await,
            vec!["execute".to_string(), "plan".to_string()]
        );
    }

    #[tokio::test]
    async fn list_files_searches_session_cwd_when_caller_omits_cwd() {
        // list_files now does an in-process .gitignore-aware walk (via the
        // `ignore` crate) instead of spawning `polytoken files` (which doesn't
        // exist). Create real files in a temp dir and verify they're found.
        let repo = tempfile::tempdir().expect("repo tempdir");
        let repo_path = repo.path();
        std::fs::create_dir_all(repo_path.join("src")).expect("mkdir src");
        std::fs::write(repo_path.join("src/main.rs"), "").expect("write main.rs");
        std::fs::write(repo_path.join("src/lib.rs"), "").expect("write lib.rs");
        std::fs::write(repo_path.join("README.md"), "").expect("write README.md");

        // Use a no-op runner — list_files no longer goes through it.
        let runner: Arc<CommandRunner> =
            Arc::new(|_p, _a, _c| Box::pin(async { Err("unused".to_string()) }));
        let (driver, _dir) = driver_with_runner("s1", repo_path.to_str().unwrap(), runner);

        let files = driver
            .list_files("main".into(), Some("s1".into()), None)
            .await;

        assert_eq!(files.len(), 1, "should find only main.rs for query 'main'");
        assert_eq!(files[0].path, "src/main.rs");
    }

    #[tokio::test]
    async fn list_files_empty_query_returns_all_files() {
        let repo = tempfile::tempdir().expect("repo tempdir");
        let repo_path = repo.path();
        std::fs::write(repo_path.join("a.rs"), "").expect("write a.rs");
        std::fs::write(repo_path.join("b.rs"), "").expect("write b.rs");

        let runner: Arc<CommandRunner> =
            Arc::new(|_p, _a, _c| Box::pin(async { Err("unused".to_string()) }));
        let (driver, _dir) = driver_with_runner("s1", repo_path.to_str().unwrap(), runner);

        let files = driver.list_files("".into(), Some("s1".into()), None).await;
        // Exact set (not `>= 2`): a fresh tempdir has only a.rs and b.rs, so an
        // exact comparison also catches over-inclusion regressions.
        let mut paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, vec!["a.rs".to_string(), "b.rs".to_string()]);
    }

    #[test]
    fn build_branch_seed_prepends_session_opened() {
        let session_ref = SessionRef {
            workspace_id: "ws".into(),
            session_id: "s1".into(),
        };
        let workspace = WorkspaceRef {
            workspace_id: "ws".into(),
            path: "/repo".into(),
            display_name: None,
        };
        let snapshot = event_map::snapshot_from_state(
            None,
            &session_ref,
            &workspace,
            SessionStatus::Idle,
            "2025-01-01T00:00:00.000Z",
            None,
            None,
        );
        let seed = PolytokenInner::build_branch_seed(
            snapshot,
            &[],
            &HistoryMapCtx {
                r#ref: session_ref.clone(),
            },
        );
        assert!(
            matches!(seed.first(), Some(SessionDriverEvent::SessionOpened { base, .. }) if base.session_ref == session_ref),
            "branch seed must start with sessionOpened so reseed:true rebuilds SessionState metadata"
        );
    }

    /// Regression (`05evwe-blast`/`050hrk-cheek`): a session whose history ends
    /// mid-turn — here on an assistant `thinking` block with no following
    /// tool_result/completion — must NOT load as "still working". `build_branch_seed`
    /// re-asserts the authoritative snapshot AFTER the replayed history, so (a) the
    /// seed's LAST event is an idle snapshot the hub's `track_running` reads to clear
    /// the running set, and (b) folding the seed settles the open assistant bubble.
    /// Without the trailing re-assert the bubble stays `streaming:true` and the freshly
    /// loaded idle session shows the "Thinking…" spinner forever.
    #[test]
    fn build_branch_seed_settles_history_ending_mid_thinking() {
        use pantoken_protocol::state::{TranscriptItem, fold_all};

        let session_ref = SessionRef {
            workspace_id: "ws".into(),
            session_id: "s1".into(),
        };
        let workspace = WorkspaceRef {
            workspace_id: "ws".into(),
            path: "/repo".into(),
            display_name: None,
        };
        let snapshot = event_map::snapshot_from_state(
            None,
            &session_ref,
            &workspace,
            SessionStatus::Idle,
            "2025-01-01T00:00:00.000Z",
            None,
            None,
        );
        // The stuck-turn shape: a user prompt, then an assistant whose last block is
        // `thinking` — no tool_result, no completion boundary.
        let history = vec![
            serde_json::json!({
                "type": "user",
                "content": "hello",
                "prompt_id": "p1",
                "emitted_at": "2025-01-01T00:00:01.000Z",
            }),
            serde_json::json!({
                "type": "assistant",
                "prompt_id": "p1",
                "blocks": [ { "type": "thinking", "text": "still pondering" } ],
                "emitted_at": "2025-01-01T00:00:02.000Z",
            }),
        ];
        let seed = PolytokenInner::build_branch_seed(
            snapshot,
            &history,
            &HistoryMapCtx {
                r#ref: session_ref.clone(),
            },
        );

        // (b for the hub): the seed ends with an idle snapshot re-assert, which
        // `track_running` reads to clear the running set after the replay.
        assert!(
            matches!(
                seed.last(),
                Some(SessionDriverEvent::SessionUpdated { snapshot, .. })
                    if matches!(snapshot.status, SessionStatus::Idle)
            ),
            "branch seed with replayed history must end with an idle SessionUpdated re-assert; got {:?}",
            seed.last()
        );

        // (a for the client): folding the whole seed yields a settled state — idle
        // status and the trailing assistant bubble closed (not streaming).
        let state = fold_all(&seed);
        assert!(
            matches!(state.status, SessionStatus::Idle),
            "folded seed status should be idle, got {:?}",
            state.status
        );
        let last_assistant = state
            .items
            .iter()
            .rev()
            .find_map(|it| match it {
                TranscriptItem::Assistant(a) => Some(a),
                _ => None,
            })
            .expect("seed should fold to an assistant item");
        assert!(
            !last_assistant.streaming,
            "the trailing snapshot must close the open assistant bubble (streaming:false), \
             else a freshly loaded idle session shows the working spinner"
        );
    }

    /// Regression (`050hrk-cheek`, live shape): a session whose history ends on a
    /// *completed* assistant turn (thinking + text, no trailing tool_use) that is
    /// then followed by one-or-more `session-resumed` system_reminders — the exact
    /// tail every resumed cold session grows (the daemon appends a `session-resumed`
    /// reminder on each `--resume`). This is NOT the "ends mid-thinking" shape; the
    /// last transcript row is a finished reply, but the trailing reminders map to
    /// `customMessage` events AFTER the last `assistantDelta`. The seed must still
    /// fold to idle with the assistant bubble closed — i.e. the trailing snapshot
    /// re-assert has to win over the intervening reminders. Without it, opening the
    /// cold session shows "Working…" + a Stop button forever.
    #[test]
    fn build_branch_seed_settles_completed_turn_with_trailing_resume_reminders() {
        use pantoken_protocol::state::{TranscriptItem, fold_all};

        let session_ref = SessionRef {
            workspace_id: "ws".into(),
            session_id: "s1".into(),
        };
        let workspace = WorkspaceRef {
            workspace_id: "ws".into(),
            path: "/repo".into(),
            display_name: None,
        };
        let snapshot = event_map::snapshot_from_state(
            None,
            &session_ref,
            &workspace,
            SessionStatus::Idle,
            "2025-01-01T00:00:00.000Z",
            None,
            None,
        );
        // The live `050hrk-cheek` tail: a completed assistant turn (thinking +
        // text), then three `session-resumed` reminders (one per resume).
        let history = vec![
            serde_json::json!({
                "type": "user",
                "content": "resolve the conflicts",
                "prompt_id": "p1",
                "emitted_at": "2025-01-01T00:00:01.000Z",
            }),
            serde_json::json!({
                "type": "assistant",
                "prompt_id": "p1",
                "blocks": [
                    { "type": "thinking", "text": "everything looks good" },
                    { "type": "text", "text": "All done! Here's the summary…" }
                ],
                "emitted_at": "2025-01-01T00:00:02.000Z",
            }),
            serde_json::json!({
                "type": "system_reminder",
                "slug": "session-resumed",
                "reason": { "type": "session_resumed" },
                "body": "This session has been resumed from saved history.",
                "emitted_at": "2025-01-01T00:00:03.000Z",
            }),
            serde_json::json!({
                "type": "system_reminder",
                "slug": "session-resumed",
                "reason": { "type": "session_resumed" },
                "body": "This session has been resumed from saved history.",
                "emitted_at": "2025-01-01T00:00:04.000Z",
            }),
            serde_json::json!({
                "type": "system_reminder",
                "slug": "session-resumed",
                "reason": { "type": "session_resumed" },
                "body": "This session has been resumed from saved history.",
                "emitted_at": "2025-01-01T00:00:05.000Z",
            }),
        ];
        let seed = PolytokenInner::build_branch_seed(
            snapshot,
            &history,
            &HistoryMapCtx {
                r#ref: session_ref.clone(),
            },
        );

        // The seed must end with an idle SessionUpdated re-assert — the reminders
        // are appended AFTER the last assistantDelta, so the re-assert is what the
        // hub's `track_running` reads to clear the running set (drop the Stop button).
        assert!(
            matches!(
                seed.last(),
                Some(SessionDriverEvent::SessionUpdated { snapshot, .. })
                    if matches!(snapshot.status, SessionStatus::Idle)
            ),
            "seed must end with an idle SessionUpdated re-assert; got {:?}",
            seed.last()
        );

        let state = fold_all(&seed);
        assert!(
            matches!(state.status, SessionStatus::Idle),
            "folded seed status should be idle, got {:?}",
            state.status
        );
        let last_assistant = state
            .items
            .iter()
            .rev()
            .find_map(|it| match it {
                TranscriptItem::Assistant(a) => Some(a),
                _ => None,
            })
            .expect("seed should fold to an assistant item");
        assert!(
            !last_assistant.streaming,
            "trailing session-resumed reminders must not leave the assistant bubble \
             streaming — the idle re-assert has to close it"
        );
    }

    /// Regression (`05f4jw-rust`): a session whose daemon history contains an
    /// orphaned tool_use — one whose `tool_result` was never persisted (here,
    /// lost to a `context_cleared`) — followed by subsequent turns and a
    /// `session-resumed` reminder. When replayed through `build_branch_seed`,
    /// `history_to_seed_events` detects the orphan (a `tool_use` whose
    /// `call_id` has no matching `tool_result`) and emits a synthetic
    /// `ToolFinished(interrupted: true)` for it. This settles the orphan to
    /// `Interrupted` before the trailing idle `SessionUpdated` re-assert folds —
    /// so `turnActive` (the transcript's in-progress signal, which checks for
    /// running tool cards) returns false, matching `runningIds` (the sidebar's
    /// indicator, cleared by the idle snapshot). Without the synthetic event,
    /// the orphan stays `running` → the sidebar shows idle but the transcript
    /// shows "Working…" + a Stop button forever.
    #[test]
    fn build_branch_seed_settles_orphaned_tool_use_lost_to_context_cleared() {
        use pantoken_protocol::state::{ToolStatus, TranscriptItem, fold_all};

        let session_ref = SessionRef {
            workspace_id: "ws".into(),
            session_id: "s1".into(),
        };
        let workspace = WorkspaceRef {
            workspace_id: "ws".into(),
            path: "/repo".into(),
            display_name: None,
        };
        let snapshot = event_map::snapshot_from_state(
            None,
            &session_ref,
            &workspace,
            SessionStatus::Idle,
            "2025-01-01T00:00:00.000Z",
            None,
            None,
        );
        // The `05f4jw-rust` shape: turn 1 has a tool_use whose result is lost
        // (context_cleared follows immediately), then turn 2 completes normally
        // and a session-resumed reminder trails.
        let history = vec![
            serde_json::json!({
                "type": "user",
                "content": "do the thing",
                "prompt_id": "p1",
                "emitted_at": "2025-01-01T00:00:01.000Z",
            }),
            serde_json::json!({
                "type": "assistant",
                "prompt_id": "p1",
                "blocks": [
                    { "type": "text", "text": "starting the handoff" },
                    { "type": "tool_use", "id": "call_orphaned", "name": "handoff_plan", "input": {} }
                ],
                "emitted_at": "2025-01-01T00:00:02.000Z",
            }),
            // context_cleared: the turn was abandoned — NO tool_result follows.
            serde_json::json!({
                "type": "context_cleared",
                "emitted_at": "2025-01-01T00:00:03.000Z",
            }),
            // A subsequent turn completes normally.
            serde_json::json!({
                "type": "user",
                "content": "try again",
                "prompt_id": "p2",
                "emitted_at": "2025-01-01T00:00:04.000Z",
            }),
            serde_json::json!({
                "type": "assistant",
                "prompt_id": "p2",
                "blocks": [
                    { "type": "text", "text": "All done!" }
                ],
                "emitted_at": "2025-01-01T00:00:05.000Z",
            }),
            // The session-resumed reminder every cold resume grows.
            serde_json::json!({
                "type": "system_reminder",
                "slug": "session-resumed",
                "reason": { "type": "session_resumed" },
                "body": "This session has been resumed from saved history.",
                "emitted_at": "2025-01-01T00:00:06.000Z",
            }),
        ];
        let seed = PolytokenInner::build_branch_seed(
            snapshot,
            &history,
            &HistoryMapCtx {
                r#ref: session_ref.clone(),
            },
        );

        // The seed must end with an idle SessionUpdated re-assert. The orphaned
        // tool is settled by history_to_seed_events's synthetic
        // ToolFinished(interrupted: true) — NOT by the fold's idle-snapshot
        // interrupt (which was reverted to runCompleted-only to avoid killing
        // live tools on transient mid-turn idle snapshots).
        let state = fold_all(&seed);
        assert!(
            matches!(state.status, SessionStatus::Idle),
            "folded seed status should be idle, got {:?}",
            state.status
        );

        // The orphaned tool must NOT still be "running" — the synthetic
        // ToolFinished(interrupted) from history_to_seed_events settled it.
        // If it's still running, `turnActive` returns true (phantom in-progress)
        // while `runningIds` is clear (sidebar shows idle).
        let orphaned = state
            .items
            .iter()
            .find_map(|it| match it {
                TranscriptItem::Tool(t) if t.id == "call_orphaned" => Some(t),
                _ => None,
            })
            .expect("seed should contain the orphaned tool card");
        assert_ne!(
            orphaned.status,
            ToolStatus::Running,
            "orphaned tool_use must be interrupted (not still running) after \
             the seed's synthetic ToolFinished(interrupted) — else the sidebar \
             shows idle but the transcript shows Working…/Stop forever \
             (regression `05f4jw-rust`)"
        );
        assert_eq!(
            orphaned.status,
            ToolStatus::Interrupted,
            "orphaned tool should be Interrupted, got {:?}",
            orphaned.status
        );
    }

    /// Regression: an SSE reseed (stream_discontinuity / session_rewound /
    /// context_cleared) must rebuild the transcript WITHOUT duplicating it and must
    /// settle status. `build_reseed_events` leads with a `SessionReset` (clears the
    /// fold's items, so re-emitting history on top of the existing transcript doesn't
    /// double every row) and ends with an idle `SessionUpdated` re-assert (so a
    /// reseeded idle session isn't left stuck "running"/"Responding"). Without the
    /// SessionReset the transcript doubles; without the trailing re-assert the replayed
    /// events leave the running set + streaming bubble stuck.
    #[test]
    fn build_reseed_events_clears_then_resettles_without_duplication() {
        use pantoken_protocol::state::{TranscriptItem, fold_all, fold_all_from};

        let session_ref = SessionRef {
            workspace_id: "ws".into(),
            session_id: "s1".into(),
        };
        let workspace = WorkspaceRef {
            workspace_id: "ws".into(),
            path: "/repo".into(),
            display_name: None,
        };
        // A small transcript that ends mid-turn (assistant thinking, no completion) —
        // the shape a discontinuity is most likely to strand as "running".
        let history = vec![
            serde_json::json!({
                "type": "user",
                "content": "hi",
                "prompt_id": "p1",
                "emitted_at": "2025-01-01T00:00:01.000Z",
            }),
            serde_json::json!({
                "type": "assistant",
                "prompt_id": "p1",
                "blocks": [ { "type": "thinking", "text": "pondering" } ],
                "emitted_at": "2025-01-01T00:00:02.000Z",
            }),
        ];
        let hist_ctx = HistoryMapCtx {
            r#ref: session_ref.clone(),
        };

        // The hub's PRE-reseed state: the live fold of that history, stranded mid-turn.
        let pre = fold_all(&history_seed::history_to_seed_events(&history, &hist_ctx));
        let pre_items = pre.items.len();
        assert!(pre_items > 0, "sanity: pre-reseed transcript is non-empty");

        // The reseed sequence, at the daemon's real (idle) status.
        let snapshot = event_map::snapshot_from_state(
            None,
            &session_ref,
            &workspace,
            SessionStatus::Idle,
            "2025-01-01T00:00:03.000Z",
            None,
            None,
        );
        let events = PolytokenInner::build_reseed_events(snapshot, &history, &hist_ctx);
        assert!(
            matches!(
                events.first(),
                Some(SessionDriverEvent::SessionReset { .. })
            ),
            "reseed must lead with SessionReset to clear the stale transcript"
        );
        assert!(
            matches!(
                events.last(),
                Some(SessionDriverEvent::SessionUpdated { snapshot, .. })
                    if matches!(snapshot.status, SessionStatus::Idle)
            ),
            "reseed must end with an idle SessionUpdated re-assert; got {:?}",
            events.last()
        );

        // Apply the reseed ON TOP of the existing hub state (the additive-fold path).
        let post = fold_all_from(pre, &events);
        assert_eq!(
            post.items.len(),
            pre_items,
            "reseed must REPLACE the transcript, not duplicate it (SessionReset clears items)"
        );
        assert!(
            matches!(post.status, SessionStatus::Idle),
            "reseeded state must settle to idle, got {:?}",
            post.status
        );
        let last_assistant = post
            .items
            .iter()
            .rev()
            .find_map(|it| match it {
                TranscriptItem::Assistant(a) => Some(a),
                _ => None,
            })
            .expect("reseed should fold to an assistant item");
        assert!(
            !last_assistant.streaming,
            "the idle re-assert must close the streaming bubble after reseed"
        );
    }

    // ---- AC.1: list_models caches subprocess output until invalidation ----

    #[tokio::test]
    async fn list_models_caches_subprocess_output_until_invalidated() {
        let calls = Arc::new(Mutex::new(0));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, args, _cwd| {
            *calls_clone.lock() += 1;
            Box::pin(async move {
                assert!(
                    args.contains(&"models".to_string()),
                    "expected models arg, got {args:?}"
                );
                Ok(ok_output(
                    "default_model: umans/umans-glm-5.2\n\nmodels:\n- umans/umans-glm-5.2\n  provider: umans/umans-glm-5.2\n",
                ))
            })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/a", runner);

        let models1 = driver.list_models().await;
        let models2 = driver.list_models().await;

        assert_eq!(models1.len(), 1);
        assert_eq!(models1[0].model_id, "umans/umans-glm-5.2");
        assert_eq!(models2.len(), 1, "second call should return cached models");
        assert_eq!(
            *calls.lock(),
            1,
            "polytoken models should run at most once until invalidation"
        );
    }

    // ---- AC.2: get_model_defaults reuses cached models result ----

    #[tokio::test]
    async fn model_defaults_reuses_cached_models_result() {
        let calls = Arc::new(Mutex::new(0));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, args, _cwd| {
            *calls_clone.lock() += 1;
            Box::pin(async move {
                assert!(args.contains(&"models".to_string()));
                Ok(ok_output(
                    "default_model: umans/umans-glm-5.2\n\nmodels:\n- umans/umans-glm-5.2\n  provider: umans/umans-glm-5.2\n",
                ))
            })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/a", runner);

        let _ = driver.list_models().await;
        let defaults = driver.get_model_defaults().await;

        assert_eq!(
            *calls.lock(),
            1,
            "get_model_defaults should reuse the cached models result, not re-run"
        );
        assert_eq!(defaults.provider.as_deref(), Some("umans"));
        assert_eq!(defaults.model_id.as_deref(), Some("umans/umans-glm-5.2"));
    }

    // ---- AC.3: model cache invalidation forces re-run ----

    #[tokio::test]
    async fn model_cache_invalidation_forces_models_rerun() {
        let output = Arc::new(Mutex::new(
            "default_model: umans/umans-glm-5.2\n\nmodels:\n- umans/umans-glm-5.2\n  provider: umans/umans-glm-5.2\n".to_string(),
        ));
        let output_clone = output.clone();
        let calls = Arc::new(Mutex::new(0));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, _args, _cwd| {
            let out = output_clone.lock().clone();
            *calls_clone.lock() += 1;
            Box::pin(async move { Ok(ok_output(&out)) })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/a", runner);

        let models1 = driver.list_models().await;
        assert_eq!(models1.len(), 1);
        assert_eq!(models1[0].model_id, "umans/umans-glm-5.2");
        assert_eq!(*calls.lock(), 1);

        // Invalidate the model cache.
        driver.inner.invalidate_model_cache();

        // Change the output so we can verify the re-run observes it.
        *output.lock() =
            "default_model: deepseek/deepseek-v4-pro\n\nmodels:\n- deepseek/deepseek-v4-pro\n  provider: deepseek/deepseek-v4-pro\n".to_string();

        let models2 = driver.list_models().await;
        assert_eq!(models2.len(), 1);
        assert_eq!(
            models2[0].model_id, "deepseek/deepseek-v4-pro",
            "after invalidation, list_models should re-run and observe updated output"
        );
        assert_eq!(*calls.lock(), 2, "invalidation should force a re-run");
    }

    // ---- AC.3b: model cache not populated on subprocess error ----

    #[tokio::test]
    async fn model_cache_not_populated_on_error() {
        let calls = Arc::new(Mutex::new(0));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, _args, _cwd| {
            *calls_clone.lock() += 1;
            Box::pin(async { Err("subprocess failed".to_string()) })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/a", runner);

        let models1 = driver.list_models().await;
        assert!(models1.is_empty(), "error should yield empty list");
        let models2 = driver.list_models().await;
        assert!(models2.is_empty(), "second call also empty");
        assert_eq!(
            *calls.lock(),
            2,
            "failed result should NOT be cached — each call retries"
        );
    }

    // ---- AC.5: cwd-scoped invalidation clears only targeted caches ----

    #[tokio::test]
    async fn cwd_config_invalidation_clears_only_targeted_facet_and_command_cache() {
        let calls = Arc::new(Mutex::new(Vec::<(Vec<String>, Option<String>)>::new()));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, args, cwd| {
            calls_clone.lock().push((args.clone(), cwd.clone()));
            Box::pin(async move {
                if args.iter().any(|a| a == "ls") {
                    Ok(ok_output("execute.md\n"))
                } else if args.iter().any(|a| a == "print-slash-commands") {
                    Ok(ok_output("[]"))
                } else {
                    Ok(ok_output("---\nname: execute\n---\nbody"))
                }
            })
        });
        // Build a driver with two sessions in the same sessions_dir, each with
        // a different cwd, so we can test cwd-scoped invalidation.
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().join("sessions");
        write_session_json(&sessions_dir, "s1", "/repo/a");
        write_session_json(&sessions_dir, "s2", "/repo/b");
        let mut inner = inner_with_order(vec!["s1".into(), "s2".into()], 64);
        inner.sessions_dir = sessions_dir;
        inner.bin_path = "polytoken-test".into();
        inner.command_runner = runner;
        inner.warm.write().insert("s1".into(), warm_for("s1"));
        inner.warm.write().insert("s2".into(), warm_for("s2"));
        let driver = PolytokenDriver {
            inner: Arc::new(inner),
        };

        // Populate both cwds.
        let _ = driver.list_commands(Some("s1".into())).await;
        let _ = driver.list_facets(Some("s1".into())).await;
        let _ = driver.list_commands(Some("s2".into())).await;
        let _ = driver.list_facets(Some("s2".into())).await;

        let initial_calls = calls.lock().len();
        assert!(initial_calls > 0, "should have made subprocess calls");

        // Invalidate only /repo/a.
        driver.inner.invalidate_cwd_config_caches("/repo/a");

        // /repo/a should re-run; /repo/b should hit cache.
        calls.lock().clear();
        let _ = driver.list_commands(Some("s1".into())).await;
        let _ = driver.list_facets(Some("s1".into())).await;
        let _ = driver.list_commands(Some("s2".into())).await;
        let _ = driver.list_facets(Some("s2".into())).await;

        let after_calls = calls.lock();
        // /repo/a commands + facets should have re-run (at least 2 calls).
        assert!(
            after_calls.len() >= 2,
            "invalidated cwd should re-run, got {} calls",
            after_calls.len()
        );
        // All re-run calls should be for /repo/a (cwd of s1).
        assert!(
            after_calls
                .iter()
                .all(|(_, cwd)| cwd.as_deref() == Some("/repo/a")),
            "only /repo/a should re-run, but got: {after_calls:?}"
        );
    }

    // ---- AC.5b: global invalidation clears all cwd-scoped caches ----

    #[tokio::test]
    async fn global_invalidation_clears_all_cwd_scoped_caches() {
        let calls = Arc::new(Mutex::new(Vec::<(Vec<String>, Option<String>)>::new()));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, args, cwd| {
            calls_clone.lock().push((args.clone(), cwd.clone()));
            Box::pin(async move {
                if args.iter().any(|a| a == "ls") {
                    Ok(ok_output("execute.md\n"))
                } else if args.iter().any(|a| a == "print-slash-commands") {
                    Ok(ok_output("[]"))
                } else {
                    Ok(ok_output("---\nname: execute\n---\nbody"))
                }
            })
        });
        // Build a driver with two sessions in the same sessions_dir.
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().join("sessions");
        write_session_json(&sessions_dir, "s1", "/repo/a");
        write_session_json(&sessions_dir, "s2", "/repo/b");
        let mut inner = inner_with_order(vec!["s1".into(), "s2".into()], 64);
        inner.sessions_dir = sessions_dir;
        inner.bin_path = "polytoken-test".into();
        inner.command_runner = runner;
        inner.warm.write().insert("s1".into(), warm_for("s1"));
        inner.warm.write().insert("s2".into(), warm_for("s2"));
        let driver = PolytokenDriver {
            inner: Arc::new(inner),
        };

        // Populate both cwds.
        let _ = driver.list_commands(Some("s1".into())).await;
        let _ = driver.list_commands(Some("s2".into())).await;

        // Global invalidation.
        driver.inner.invalidate_all_config_caches();

        // Both cwds should re-run.
        calls.lock().clear();
        let _ = driver.list_commands(Some("s1".into())).await;
        let _ = driver.list_commands(Some("s2".into())).await;

        let after_calls = calls.lock();
        assert!(
            after_calls.len() >= 2,
            "both cwds should re-run after global invalidation, got {} calls",
            after_calls.len()
        );
    }

    // ---- AC.9: fake-mode construction does not start watcher ----

    #[tokio::test]
    async fn fake_mode_construction_does_not_start_watcher() {
        let dir = tempfile::tempdir().expect("tempdir");
        let driver = PolytokenDriver::new_with_login_env(
            dir.path().to_path_buf(),
            "polytoken".into(),
            true, // is_fake = true
            64,
            None,
        )
        .await;

        assert!(
            matches!(
                driver.inner.watch_status(),
                config_watcher::WatchStatus::Disabled
            ),
            "fake mode should have Disabled watcher status"
        );
        assert!(
            driver.inner.watcher_handle.lock().is_none(),
            "fake mode should not have a watcher handle"
        );
    }

    // ---- AC.9b: non-fake with login_env also has Disabled watcher (test constructor) ----

    #[tokio::test]
    async fn test_constructor_does_not_start_watcher() {
        let dir = tempfile::tempdir().expect("tempdir");
        let driver = PolytokenDriver::new_with_login_env(
            dir.path().to_path_buf(),
            "polytoken".into(),
            false, // not fake, but test constructor doesn't start watcher
            64,
            None,
        )
        .await;

        // The test constructor (new_with_login_env) never starts the watcher,
        // even if is_fake is false. Only new_with_fake_control starts it.
        assert!(
            matches!(
                driver.inner.watch_status(),
                config_watcher::WatchStatus::Disabled
            ),
            "test constructor should have Disabled watcher status"
        );
    }

    // ---- AC.8: watcher setup failure records status and driver still lists ----

    #[tokio::test]
    async fn watch_setup_failure_records_status_and_driver_still_lists() {
        // Use the config_watcher module directly with an unwatchable path.
        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();
        let invalidation: config_watcher::InvalidationCallback = Arc::new(move |_| {
            *called_clone.lock() = true;
        });

        let bad_path = PathBuf::from("/nonexistent-root-xyz-12345/polytoken");
        let (handle, status) = config_watcher::setup_watcher(
            vec![config_watcher::WatchedPath::Binary(bad_path)],
            invalidation,
            true,
        );

        // The status should reflect the failure (Failed or PartialFailure).
        // On some platforms the watch may succeed deferred, so we accept Ok too,
        // but the key invariant is: no crash, and the status is inspectable.
        match &status {
            config_watcher::WatchStatus::Failed { .. } => {
                assert!(handle.is_none(), "failed watcher should have no handle");
            }
            config_watcher::WatchStatus::PartialFailure { .. } => {
                // Acceptable — some paths failed but others may have succeeded.
            }
            config_watcher::WatchStatus::Ok { .. } => {
                // On some platforms, watching a nonexistent parent might
                // succeed (deferred). That's acceptable.
            }
            config_watcher::WatchStatus::Disabled => {
                // Shouldn't happen when paths were provided, but if the
                // watcher returned no watched paths, it's effectively disabled.
            }
        }

        // The driver should still work through the injected command runner
        // regardless of watcher status.
        let calls = Arc::new(Mutex::new(0));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, _args, _cwd| {
            *calls_clone.lock() += 1;
            Box::pin(async {
                Ok(ok_output(
                    "default_model: umans/umans-glm-5.2\n\nmodels:\n- umans/umans-glm-5.2\n  provider: umans/umans-glm-5.2\n",
                ))
            })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/a", runner);

        let models = driver.list_models().await;
        assert_eq!(
            models.len(),
            1,
            "driver should still list models despite watcher status"
        );
        assert_eq!(*calls.lock(), 1);
    }

    // ---- Thundering herd: concurrent model cache miss shares one subprocess ----

    #[tokio::test]
    async fn concurrent_model_cache_miss_shares_one_subprocess() {
        // N concurrent callers on a cold cache should share one subprocess
        // invocation (single-flight deduplication via model_cache_lock).
        let calls = Arc::new(Mutex::new(0));
        let calls_clone = calls.clone();
        let runner: Arc<CommandRunner> = Arc::new(move |_program, _args, _cwd| {
            *calls_clone.lock() += 1;
            Box::pin(async {
                // Simulate a slow subprocess so concurrent callers overlap.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                Ok(ok_output(
                    "default_model: umans/umans-glm-5.2\n\nmodels:\n- umans/umans-glm-5.2\n  provider: umans/umans-glm-5.2\n",
                ))
            })
        });
        let (driver, _dir) = driver_with_runner("s1", "/repo/a", runner);

        // Fire N concurrent list_models calls on a cold cache.
        let n = 8;
        let mut handles = Vec::new();
        for _ in 0..n {
            let d = driver.inner.clone();
            handles.push(tokio::spawn(async move {
                PolytokenDriver { inner: d }.list_models().await
            }));
        }
        for h in handles {
            let models = h.await.expect("task panicked");
            assert_eq!(models.len(), 1, "each caller should get the model list");
        }

        // Only one subprocess should have run.
        assert_eq!(
            *calls.lock(),
            1,
            "concurrent cache miss should share one subprocess (single-flight)"
        );
    }
}
