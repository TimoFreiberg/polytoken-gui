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
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use pilot_daemon_types::*;
use pilot_protocol::session_driver::{
    CommandInfo, DirListing, FileInfo, HostUiResponse, ImageContent, ModelDefaults, ModelOption,
    PathStat, PermissionMonitorMode, SessionClosedReason, SessionDriverEvent, SessionEventBase,
    SessionId, SessionListEntry, SessionRef, SessionSnapshot, SessionStatus, SessionUsage,
    WorkspaceId, WorkspaceRef, WorktreeInfo,
};
use pilot_protocol::wire::{DeliveryMode, LoginEnvStatus, McpAction};
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use async_trait::async_trait;

use crate::archive_store::ArchiveStore;
use crate::driver::{
    BranchResult, ClearQueueResult, NewSessionOptsData, PilotDriver, WorktreeCleanupResult,
};
use crate::polytoken::daemon_client::{DaemonClient, SpawnDaemonOpts, SseSubscription};
use crate::polytoken::event_map::{self, DaemonEffect, FoldAccumulator, FoldResult, MapCtx};
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
    #[expect(
        dead_code,
        reason = "BUG: spawned daemon child is not retained/enforced until warm session lifecycle is fixed in Phase 2"
    )]
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

/// The shared inner driver state. All fields that were on `PolytokenDriver`
/// live here; `PolytokenDriver` is a thin `Arc<PolytokenInner>` wrapper so the
/// trait methods (which take `&self`) can reach the `self: &Arc<Self>` methods
/// that spawn background SSE tasks.
struct PolytokenInner {
    sessions_dir: PathBuf,
    bin_path: String,
    is_fake: bool,
    warm_cap: i64,
    /// The captured login-shell env, threaded into every daemon spawn so the
    /// daemon gets the user's real PATH + tool env. `None` only when capture
    /// ran but produced no env (a degraded state — spawn gets the inherited env).
    login_env: Mutex<Option<HashMap<String, String>>>,
    /// The status of the login-env capture, stored for the Settings panel.
    /// NOTE: the hub does NOT yet read this — `pilot_settings_msg` still sends
    /// a hardcoded stub `LoginEnvStatus { ok: false, .. }`. This is the ready
    /// read side for when the Settings-panel wiring is implemented.
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
        let sessions_dir = data_dir.join("sessions");
        let captured = login_env::capture_login_env(login_shell.as_deref()).await;
        let CapturedLoginEnv { env, status } = captured;
        let login_env = if env.is_empty() { None } else { Some(env) };

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
            }),
        }
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
            }),
        }
    }

    /// The login-env status, exposed for the Settings panel. NOTE: the hub
    /// does NOT yet call this — `pilot_settings_msg` still sends a hardcoded
    /// stub `LoginEnvStatus { ok: false, .. }`. This is the ready read side
    /// for when the Settings-panel wiring is implemented.
    pub fn login_env_status(&self) -> LoginEnvStatus {
        self.inner.login_env_status.read().clone()
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

    /// Resolve a session's project cwd from its on-disk `session.json`, falling
    /// back to `None` when the metadata is missing/unreadable (the caller then
    /// falls back to the sessions dir, mirroring `polytoken-driver.ts:1138`).
    fn cwd_for_session(sessions_dir: &Path, session_id: &str) -> Option<String> {
        let session_dir = sessions_dir.join(session_id);
        sessions_registry::read_session_json(&session_dir)
            .filter(|meta| !meta.project_path.is_empty())
            .map(|meta| meta.project_path)
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
    ) -> Result<Arc<WarmSession>, String> {
        // Wait for health (poll up to 10s)
        let healthy = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let res = client.health().await;
                if res.status == 200 {
                    return true;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap_or(false);

        if !healthy {
            return Err("daemon health probe timed out".into());
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
            owned_process: Mutex::new(None),
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
            sessions_dir: None,
            global_config_dir: None,
            // Thread the captured login-shell env into the spawn so the daemon
            // gets the user's real PATH + tool env (pilot launched from the .app
            // bundle inherits launchd's minimal PATH). Mirrors
            // `polytoken-driver.ts:175-178` + the spawn's login-env merge.
            login_env: self.login_env.lock().clone(),
        };

        let (spawned, _child) =
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
        ));

        self.install_warm(client, session_id, session_ref, workspace)
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
    ) -> Result<Arc<WarmSession>, String> {
        if let Some(ws) = self.get_warm(&session_id) {
            return Ok(ws);
        }

        let client = Arc::new(DaemonClient::new(
            session_id.clone(),
            port,
            std::process::id() as i32,
        ));

        self.install_warm(client, session_id, session_ref, workspace)
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

    #[expect(
        unused_variables,
        reason = "BUG: deliver_as/images/prompt_id ignored; prompt routing parity is Phase 2"
    )]
    async fn prompt(
        &self,
        text: String,
        deliver_as: Option<DeliveryMode>,
        session_id: Option<SessionId>,
        images: Vec<ImageContent>,
        prompt_id: Option<String>,
    ) -> Result<(), String> {
        // Ports TS `polytoken-driver.ts:882` which throws on no warm session /
        // POST failure. Returns `Err` so the hub surfaces `promptResult { accepted:
        // false }` to the client rather than silently dropping the prompt.
        let Some(sid) = session_id else {
            return Err("no session to prompt".into());
        };
        let Some(ws) = self.inner.get_warm(&sid) else {
            return Err("no warm polytoken session to prompt".into());
        };
        if let Err(e) = ws.client.prompt(&text, None).await {
            return Err(format!("prompt failed: {e}"));
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
                // NOTE: the archive WRITE side (`set_archived`) is still the
                // trait-default no-op in the live PolytokenDriver (only the mock
                // overrides it), so `archived` is always false on the live path
                // until `set_archived` is wired — out of Phase 5 scope.
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
        let meta = {
            let store = self.inner.worktree_store.lock();
            store.live(&path).cloned()
        };
        let Some(meta) = meta else {
            return WorktreeCleanupResult {
                removed: false,
                reason: Some("no pilot worktree at this path".to_string()),
            };
        };
        match worktree::remove(&meta, force).await {
            Ok(res) => {
                if res.removed {
                    self.inner.worktree_store.lock().mark_reaped(&path);
                }
                WorktreeCleanupResult {
                    removed: res.removed,
                    reason: res.reason,
                }
            }
            Err(e) => WorktreeCleanupResult {
                removed: false,
                reason: Some(e),
            },
        }
    }

    async fn open_session(&self, path: String) -> Result<Vec<SessionDriverEvent>, String> {
        let session_id = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
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
            path: cwd,
            display_name: None,
        };

        // Resolve the daemon port from startup.json (the daemon is ALREADY running
        // on that port — we just attach, we don't re-spawn). This mirrors the TS
        // resume path where warmSession reuses the existing port.
        let session_dir = self.inner.sessions_dir.join(&session_id);
        let startup_path = session_dir.join("startup.json");
        let port = if startup_path.exists() {
            if let Ok(raw) = std::fs::read_to_string(&startup_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    json.get("port").and_then(|v| v.as_u64()).map(|p| p as u16)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        if let Some(port) = port {
            // Attach to the running daemon: claim lease, fetch state, subscribe SSE,
            // insert into the warm pool. If attach fails, fall through to an empty
            // seed rather than a hard error (the TS path throws, but the hub expects
            // open_session to surface a seed; an empty seed keeps the session
            // visible while the daemon is unreachable).
            match self
                .inner
                .warm_session_attach(session_id.clone(), session_ref.clone(), workspace, port)
                .await
            {
                Ok(ws) => {
                    // Refocus the warm session (most-recently focused) — mirrors
                    // TS `focus(existing.ref.sessionId)` on the instant-switch path.
                    let real_id = ws.client.session_id.clone();
                    self.inner.focus(&real_id);
                    // Build the seed from the warm client's /history.
                    let history_res = ws.client.history(None, None).await;
                    if let Some(history) = history_res.data {
                        return Ok(history_seed::history_to_seed_events(
                            &history.items,
                            &HistoryMapCtx { r#ref: session_ref },
                        ));
                    }
                }
                Err(e) => {
                    warn!("open_session: warm attach failed for {session_id}: {e}");
                }
            }
        }

        Ok(Vec::new())
    }

    async fn reload_session(&self, path: String) -> Result<Vec<SessionDriverEvent>, String> {
        let session_id = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
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
                let session_id = ws.client.session_id.clone();
                let session_ref = SessionRef {
                    workspace_id: WorkspaceId::default(),
                    session_id: session_id.clone(),
                };

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

                // Build seed from history
                let history_res = ws.client.history(None, None).await;
                if let Some(history) = history_res.data {
                    return Ok(history_seed::history_to_seed_events(
                        &history.items,
                        &HistoryMapCtx { r#ref: session_ref },
                    ));
                }
                // A successful spawn with empty history is a valid empty seed —
                // the session exists. Mirrors the TS path.
                Ok(Vec::new())
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

    #[expect(
        unused_variables,
        reason = "BUG: branch summarize option ignored; branch parity is Phase 2"
    )]
    async fn branch_from(
        &self,
        entry_id: String,
        summarize: bool,
        session_id: Option<SessionId>,
    ) -> BranchResult {
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
                let history_res = ws.client.history(None, None).await;
                if let Some(history) = history_res.data {
                    return BranchResult {
                        seed: history_seed::history_to_seed_events(
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

    #[expect(
        unused_variables,
        reason = "BUG: session-scoped command discovery ignored; live command parity is Phase 2"
    )]
    async fn list_commands(&self, session_id: Option<SessionId>) -> Vec<CommandInfo> {
        let cache_key = std::env::var("HOME").unwrap_or_default();
        if let Some(cached) = self.inner.command_cache.lock().get(&cache_key) {
            return cached.clone();
        }
        let bin_path = self.inner.bin_path.clone();
        let output = tokio::process::Command::new(&bin_path)
            .args(["print-slash-commands", "--format", "json"])
            .output()
            .await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let commands = crate::polytoken::commands::parse_slash_commands(&stdout);
                self.inner
                    .command_cache
                    .lock()
                    .insert(cache_key, commands.clone());
                commands
            }
            Err(e) => {
                error!("list_commands failed: {e}");
                Vec::new()
            }
        }
    }

    #[expect(
        unused_variables,
        reason = "BUG: session-scoped facet discovery ignored; live facet parity is Phase 2"
    )]
    async fn list_facets(&self, session_id: Option<SessionId>) -> Vec<String> {
        let bin_path = self.inner.bin_path.clone();
        let output = tokio::process::Command::new(&bin_path)
            .args(["vfs", "ls", "polytoken://facets"])
            .output()
            .await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                stdout
                    .lines()
                    .filter_map(|line| {
                        let content = std::fs::read_to_string(line.trim()).ok()?;
                        crate::polytoken::facets::parse_facet_name(&content)
                    })
                    .collect()
            }
            Err(e) => {
                error!("list_facets failed: {e}");
                Vec::new()
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

    #[expect(
        unused_variables,
        reason = "BUG: session_id ignored for live file lookup; file index parity is Phase 2"
    )]
    async fn list_files(
        &self,
        query: String,
        session_id: Option<SessionId>,
        cwd: Option<String>,
    ) -> Vec<FileInfo> {
        let bin_path = self.inner.bin_path.clone();
        let mut cmd = tokio::process::Command::new(&bin_path);
        cmd.args(["files", "--format", "json"]);
        if !query.is_empty() {
            cmd.args(["--query", &query]);
        }
        if let Some(cwd) = &cwd {
            cmd.args(["--cwd", cwd]);
        }
        match cmd.output().await {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                if let Ok(paths) = serde_json::from_str::<Vec<String>>(&stdout) {
                    return crate::polytoken::file_catalog::parse_file_catalog(&paths);
                }
                Vec::new()
            }
            Err(e) => {
                error!("list_files failed: {e}");
                Vec::new()
            }
        }
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
            // Extract handles before awaiting (avoid holding guards across .await).
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
            ws.client.close().await;
        }
    }

    fn run_script(&self, name: String) {
        if self.inner.is_fake {
            warn!("run_script({name}) on fake daemon — not yet wired");
        }
    }

    fn reset(&self, bootstrap: bool) {
        if self.inner.is_fake {
            warn!("reset({bootstrap}) on fake daemon — not yet wired");
        }
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
}
