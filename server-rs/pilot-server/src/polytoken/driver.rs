//! The polytoken daemon driver: implements `PilotDriver` by composing
//! `DaemonClient` (HTTP+SSE), `event_map` (daemon→pilot mapping),
//! and `history_seed` (history→seed conversion).
//!
//! Port of `server/src/polytoken/polytoken-driver.ts` (1953 LOC).
//!
//! ## Shape: `PolytokenDriver { inner: Arc<PolytokenInner> }`
//!
//! The driver owns background SSE tasks that must outlive any single trait
//! method call, so the hub's `Box<dyn PilotDriver>` holds a thin wrapper around
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

use parking_lot::{Mutex, RwLock};
use pilot_daemon_types::*;
use pilot_protocol::session_driver::{
    CommandInfo, DirListing, FileInfo, HostUiRequest, HostUiResponse, ImageContent, ModelDefaults,
    ModelOption, NotifyLevel, PathStat, PermissionMonitorMode, SessionClosedReason,
    SessionDriverEvent, SessionEventBase, SessionId, SessionListEntry, SessionRef, SessionSnapshot,
    SessionStatus, SessionUsage, WorkspaceId, WorkspaceRef, WorktreeInfo,
};
use pilot_protocol::wire::{DeliveryMode, LoginEnvStatus, McpAction};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use async_trait::async_trait;

use crate::archive_store::ArchiveStore;
use crate::driver::{
    ArchiveResult, BranchResult, ClearQueueResult, NewSessionOptsData, PilotDriver,
    WorktreeCleanupResult, WorktreeRetained,
};
use crate::polytoken::daemon_client::{
    DaemonClient, SpawnDaemonOpts, SseSubscription, default_global_config_dir,
    read_credential_token, spawn_daemon,
};
use crate::polytoken::event_map::{self, DaemonEffect, FoldAccumulator, FoldResult, MapCtx};
use crate::polytoken::fake_daemon::FakeControlHub;
use crate::polytoken::history_seed::{self, HistoryMapCtx};
use crate::polytoken::models::parse_models;
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
    /// hub reads it through the `PilotDriver::login_env_status` trait method
    /// (see `pilot_settings_msg`).
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
    command_runner: Arc<CommandRunner>,
}

/// The polytoken daemon driver.
///
/// A thin wrapper around `Arc<PolytokenInner>`. The hub owns this as
/// `Box<dyn PilotDriver>`; each trait method delegates to the inner impl,
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
        // NOT pilot's data dir. The daemon writes startup.json, credential.json,
        // and session.json here — pilot must read from the same place to discover
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
                command_runner: default_command_runner(),
                fake_control: None,
            }),
        }
    }

    /// The login-env status, exposed for the Settings panel and read by the hub
    /// through the `PilotDriver` trait. Kept as an inherent delegate so
    /// concrete-typed callers keep working.
    pub fn login_env_status(&self) -> LoginEnvStatus {
        <Self as PilotDriver>::login_env_status(self)
    }

    /// Reap the pilot worktree at `cwd` if one is live: remove it (honoring
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
        history_items: &[pilot_daemon_types::SessionHistoryItem],
        ctx: &HistoryMapCtx,
    ) -> Vec<SessionDriverEvent> {
        let mut seed = vec![SessionDriverEvent::SessionOpened {
            base: SessionEventBase {
                session_ref: ctx.r#ref.clone(),
                timestamp: DriverMapCtx::now_ts(),
                run_id: None,
            },
            snapshot,
        }];
        seed.extend(history_seed::history_to_seed_events(history_items, ctx));
        seed
    }

    /// The worktree field for a session's cwd, or `None`. Resolved from the
    /// worktree store at list time (pilot's own flag — polytoken has no concept).
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
        match client.claim_lease("pilot").await {
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
            // gets the user's real PATH + tool env (pilot launched from the .app
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

        // Emit all resulting pilot events to subscribers
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
                let res = ws.client.history(None, None).await;
                if let Some(history) = res.data {
                    let seed = history_seed::history_to_seed_events(
                        &history.items,
                        &HistoryMapCtx {
                            r#ref: ws.session_ref.clone(),
                        },
                    );
                    for ev in &seed {
                        self.emit(ev.clone());
                    }
                }
            }
            DaemonEffect::RefetchQueue => {
                // The queue events carry one item + revision, not the full
                // queue. pilot's queueUpdated REPLACES the full queue, so fetch
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

/// Outcome of reaping a pilot worktree at a session cwd. Shared by
/// `set_archived` and `cleanup_worktree`.
enum ReapOutcome {
    /// No live pilot worktree registered at this cwd — nothing to reap.
    NoWorktree,
    /// The worktree was removed and tombstoned in the store.
    Reaped,
    /// The worktree was left in place (dirty or removal failed); carries the reason.
    Retained(String),
}

#[async_trait]
impl PilotDriver for PolytokenDriver {
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
        // pilot-side UX only: daemon unstable.6+ auto-queues and has no
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
        // ghost transcript row.
        if let Err(e) = ws.client.prompt(&text, None).await {
            return Err(format!("prompt failed: {e}"));
        }
        let now = DriverMapCtx::now_ts();
        let base = SessionEventBase {
            session_ref: ws.session_ref.clone(),
            timestamp: now.clone(),
            run_id: None,
        };
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
        if let Some(ws) = self.inner.get_warm(&sid) {
            // Extract request_id from the HostUiResponse
            let request_id = match &response {
                pilot_protocol::session_driver::HostUiResponse::Value { request_id, .. } => {
                    request_id
                }
                pilot_protocol::session_driver::HostUiResponse::Confirmed {
                    request_id, ..
                } => request_id,
                pilot_protocol::session_driver::HostUiResponse::Answers { request_id, .. } => {
                    request_id
                }
                pilot_protocol::session_driver::HostUiResponse::Cancelled {
                    request_id, ..
                } => request_id,
            };
            let pending = ws.pending_interrogatives.lock().get(request_id).cloned();
            if let Some(pending) = pending {
                if let Some(resp) = build_interrogative_response(&pending, &response) {
                    let ws = ws.clone();
                    let id = pending.interrogative_id.clone();
                    tokio::spawn(async move {
                        let _ = ws.client.respond_interrogative(&id, &resp).await;
                    });
                }
            }
        }
    }

    async fn list_sessions(&self) -> Vec<SessionListEntry> {
        let sessions_dir = self.inner.sessions_dir.clone();
        // Resolve pilot's own side-flags from the stores (not polytoken's
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

    /// Remove a pilot-created worktree at `path` (== a session cwd) and tombstone
    /// it. The store index is the gate — we never touch a worktree pilot didn't
    /// create. `force=false` leaves a dirty worktree in place (returns
    /// `removed:false` + a reason). Mirrors `polytoken-driver.ts:1380-1387`
    /// (`cleanupWorktree` → `reapWorktree`, `:862-872`).
    async fn cleanup_worktree(&self, path: String, force: bool) -> WorktreeCleanupResult {
        match self.reap_worktree(&path, force).await {
            ReapOutcome::NoWorktree => WorktreeCleanupResult {
                removed: false,
                reason: Some("no pilot worktree at this path".to_string()),
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
                    warn!("open_session: warm attach failed for {session_id}: {e}");
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
                    let model_str = format!("{}/{}", model.provider, model.model_id);
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
                            pilot_daemon_types::PermissionMonitorMode::Standard
                        }
                        PermissionMonitorMode::Bypass => {
                            pilot_daemon_types::PermissionMonitorMode::Bypass
                        }
                        PermissionMonitorMode::BypassPlus => {
                            pilot_daemon_types::PermissionMonitorMode::BypassPlus
                        }
                        PermissionMonitorMode::Autonomous => {
                            pilot_daemon_types::PermissionMonitorMode::Autonomous
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
        // summarize: pilot-side only, no daemon /rewind param (matches TS
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
        let bin_path = self.inner.bin_path.clone();
        let output = tokio::process::Command::new(&bin_path)
            .arg("models")
            .output()
            .await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                parse_models(&stdout).models
            }
            Err(e) => {
                error!("list_models failed: {e}");
                Vec::new()
            }
        }
    }

    async fn get_model_defaults(&self) -> ModelDefaults {
        let bin_path = self.inner.bin_path.clone();
        let output = tokio::process::Command::new(&bin_path)
            .arg("models")
            .output()
            .await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let parsed = parse_models(&stdout);
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
            Err(_) => ModelDefaults::default(),
        }
    }

    async fn list_commands(&self, session_id: Option<SessionId>) -> Vec<CommandInfo> {
        // Ports TS `polytoken-driver.ts:1455-1489`: commands are cwd-scoped,
        // keyed by the targeted warm session cwd, and the CLI must run there.
        let Some(cwd) = self.inner.targeted_session_cwd(session_id.as_ref()) else {
            return Vec::new();
        };
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
                if names.is_empty() { builtins() } else { names }
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

    fn set_model(&self, provider: String, model_id: String, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.inner.get_warm(sid) {
                let ws = ws.clone();
                let model = format!("{provider}/{model_id}");
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
                        pilot_daemon_types::PermissionMonitorMode::Standard
                    }
                    PermissionMonitorMode::Bypass => {
                        pilot_daemon_types::PermissionMonitorMode::Bypass
                    }
                    PermissionMonitorMode::BypassPlus => {
                        pilot_daemon_types::PermissionMonitorMode::BypassPlus
                    }
                    PermissionMonitorMode::Autonomous => {
                        pilot_daemon_types::PermissionMonitorMode::Autonomous
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

#[cfg(test)]
mod tests {
    use super::*;
    use pilot_protocol::wire::LoginEnvStatus;

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
                "/home/user/.pilot/sessions/2025-01-15T10-30-00-my-task/session.json"
            ),
            Some("2025-01-15T10-30-00-my-task".to_string())
        );

        // Windows-style backslash paths should work too.
        assert_eq!(
            PolytokenInner::session_id_from_path(
                "C:\\Users\\timo\\.pilot\\sessions\\2025-01-15T10-30-00-my-task\\session.json"
            ),
            Some("2025-01-15T10-30-00-my-task".to_string())
        );

        // Trailing slash should not confuse the split.
        assert_eq!(
            PolytokenInner::session_id_from_path(
                "/home/user/.pilot/sessions/2025-01-15T10-30-00-my-task/session.json/"
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
}
