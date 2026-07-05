//! The polytoken daemon driver: implements `PilotDriver` by composing
//! `DaemonClient` (HTTP+SSE), `event_map` (daemon→pilot mapping),
//! and `history_seed` (history→seed conversion).
//!
//! Port of `server/src/polytoken/polytoken-driver.ts` (1953 LOC).
//!

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use pilot_daemon_types::*;
use pilot_protocol::session_driver::{
    CommandInfo, DirListing, FileInfo, HostUiResponse, ImageContent, ModelDefaults, ModelOption,
    PathStat, PermissionMonitorMode, SessionDriverEvent, SessionId, SessionListEntry, SessionRef,
    SessionSnapshot, SessionStatus, WorkspaceId, WorkspaceRef,
};
use pilot_protocol::wire::{DeliveryMode, McpAction};
use tokio::sync::mpsc;
use tracing::{error, warn};

use async_trait::async_trait;

use crate::driver::{BranchResult, ClearQueueResult, NewSessionOptsData, PilotDriver};
use crate::polytoken::daemon_client::{DaemonClient, SpawnDaemonOpts, SseSubscription};
use crate::polytoken::event_map::{self, DaemonEffect, FoldAccumulator, FoldResult, MapCtx};
use crate::polytoken::history_seed::{self, HistoryMapCtx};
use crate::polytoken::models::parse_models;
use crate::polytoken::sessions_registry;
use crate::polytoken::ui_bridge::{PendingInterrogative, build_interrogative_response};

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
}

impl WarmSession {
    /// Check if the daemon is healthy.
    #[expect(
        dead_code,
        reason = "warm-session health checks are unused until warm_cap/lifecycle enforcement is wired in Phase 2"
    )]
    async fn is_healthy(&self) -> bool {
        let res = self.client.health().await;
        res.status == 200
    }
}

type SessionViewed = dyn Fn(SessionId) -> bool + Send + Sync;

/// The polytoken daemon driver.
pub struct PolytokenDriver {
    sessions_dir: PathBuf,
    bin_path: String,
    is_fake: bool,
    warm: RwLock<HashMap<SessionId, Arc<WarmSession>>>,
    subscribers: Mutex<Vec<(usize, mpsc::Sender<SessionDriverEvent>)>>,
    next_sub_id: Mutex<usize>,
    is_viewed: RwLock<Option<Box<SessionViewed>>>,
    command_cache: Mutex<HashMap<String, Vec<CommandInfo>>>,
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

impl MapCtx for DriverMapCtx {
    fn r#ref(&self) -> &SessionRef {
        &self.session_ref
    }

    fn workspace(&self) -> &WorkspaceRef {
        &self.workspace
    }

    fn now(&self) -> String {
        // ISO 8601 timestamp (simplified — matches the daemon's date-time format)
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("2025-01-01T00:00:{:02}Z", secs % 60)
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

impl PolytokenDriver {
    pub fn new(sessions_dir: PathBuf, bin_path: String, is_fake: bool) -> Self {
        Self {
            sessions_dir,
            bin_path,
            is_fake,
            warm: RwLock::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            next_sub_id: Mutex::new(0),
            is_viewed: RwLock::new(None),
            command_cache: Mutex::new(HashMap::new()),
        }
    }

    fn emit(&self, ev: SessionDriverEvent) {
        let subs = self.subscribers.lock();
        for (_, tx) in subs.iter() {
            let _ = tx.try_send(ev.clone());
        }
    }

    fn get_warm(&self, session_id: &SessionId) -> Option<Arc<WarmSession>> {
        self.warm.read().get(session_id).cloned()
    }

    /// Warm up a session by spawning/resuming the daemon and subscribing to SSE.
    #[expect(
        dead_code,
        reason = "BUG: live sessions bypass warm_session today; warm_cap/lifecycle/SSE wiring lands in Phase 2"
    )]
    async fn warm_session(
        self: &Arc<Self>,
        session_id: SessionId,
        session_ref: SessionRef,
        workspace: WorkspaceRef,
    ) -> Result<Arc<WarmSession>, String> {
        if let Some(ws) = self.get_warm(&session_id) {
            return Ok(ws);
        }

        // Real daemon: spawn or resume
        let opts = SpawnDaemonOpts {
            cwd: Some(workspace.path.clone()),
            session_id: Some(session_id.clone()),
            sessions_dir: Some(self.sessions_dir.to_string_lossy().to_string()),
            global_config_dir: Some(
                crate::polytoken::daemon_client::default_global_config_dir()
                    .to_string_lossy()
                    .to_string(),
            ),
            login_env: None,
        };

        let (spawned, _child) =
            crate::polytoken::daemon_client::spawn_daemon(&self.bin_path, opts).await?;

        let port = spawned.port;
        let client = Arc::new(DaemonClient::new(
            session_id.clone(),
            port,
            std::process::id() as i32,
        ));

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
            owned_process: Mutex::new(None), // set below for real daemon path
        });

        // Subscribe to SSE events
        let warm_clone = warm.clone();
        let self_clone = self.clone();
        let sub = client
            .subscribe(move |envelope: SseEnvelope| {
                let warm = warm_clone.clone();
                let driver = self_clone.clone();
                // Process the daemon event — spawn a task to avoid blocking the SSE loop
                tokio::spawn(async move {
                    driver.handle_sse_event(warm, envelope).await;
                });
            })
            .await;

        *warm.sse_subscription.lock() = Some(sub);

        self.warm.write().insert(session_id, warm.clone());
        Ok(warm)
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
            #[expect(
                unused_variables,
                reason = "BUG: FetchState emit/prompt_id ignored; post-fetch event emission is Phase 2"
            )]
            DaemonEffect::FetchState { emit, prompt_id } => {
                let res = ws.client.state().await;
                if let Some(state) = res.data {
                    *ws.last_state.write() = Some(state);
                }
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
                let _res = ws.client.turn_input_snapshot().await;
                // TODO: map snapshot to queueUpdated event (Phase 2)
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
        let id = {
            let mut next = self.next_sub_id.lock();
            let id = *next;
            *next += 1;
            id
        };
        let (tx, mut rx) = mpsc::channel(256);
        self.subscribers.lock().push((id, tx));
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                listener(ev);
            }
        });
        id
    }

    fn unsubscribe(&self, id: usize) {
        self.subscribers.lock().retain(|(sid, _)| *sid != id);
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
        let Some(ws) = self.get_warm(&sid) else {
            return Err("no warm polytoken session to prompt".into());
        };
        if let Err(e) = ws.client.prompt(&text, None).await {
            return Err(format!("prompt failed: {e}"));
        }
        Ok(())
    }

    fn abort(&self, session_id: Option<SessionId>) {
        if let Some(sid) = session_id {
            if let Some(ws) = self.get_warm(&sid) {
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
            if let Some(ws) = self.get_warm(&sid) {
                let _ = ws.client.turn_input_snapshot().await;
                let _ = ws.client.dequeue_newest_input().await;
            }
        }
        ClearQueueResult::default()
    }

    fn respond_ui(&self, response: HostUiResponse, session_id: Option<SessionId>) {
        let Some(sid) = session_id else { return };
        if let Some(ws) = self.get_warm(&sid) {
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
        sessions_registry::list_cold_sessions(
            &self.sessions_dir,
            sessions_registry::ListColdSessionsOpts {
                archived_for: Box::new(
                    #[expect(
                        unused_variables,
                        reason = "BUG: archive store unported; list_sessions hardcodes archived=false until Phase 2"
                    )]
                    |session_id| false,
                ),
                worktree_for: Some(Box::new(
                    #[expect(
                        unused_variables,
                        reason = "BUG: worktree store unported; list_sessions hardcodes worktree=None until Phase 2"
                    )]
                    |session_id| None,
                )),
            },
        )
    }

    async fn open_session(&self, path: String) -> Vec<SessionDriverEvent> {
        let session_id = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let session_ref = SessionRef {
            workspace_id: WorkspaceId::default(),
            session_id: session_id.clone(),
        };
        #[expect(
            unused_variables,
            reason = "BUG: open_session workspace still fabricated from HOME until session-registry/worktree path is ported in Phase 2"
        )]
        let workspace = {
            #[expect(
                unused_variables,
                reason = "BUG: open_session ignores session registry/worktree workspace path and fabricates HOME until Phase 2"
            )]
            let ignored_registry_workspace_path = ();
            let fabricated_home = std::env::var("HOME").unwrap_or_default();
            WorkspaceRef {
                workspace_id: WorkspaceId::default(),
                path: fabricated_home,
                display_name: None,
            }
        };

        // Try to warm the session
        #[expect(
            unused_variables,
            reason = "BUG: spawned daemon child is not retained/enforced until warm-session lifecycle is ported in Phase 2"
        )]
        let self_arc = Arc::new(PolytokenDriver::new(
            self.sessions_dir.clone(),
            self.bin_path.clone(),
            self.is_fake,
        ));
        // For now, use a simpler approach: just fetch history directly
        // The full warm_session needs Arc<Self> which we can't easily get from &self
        // TODO: restructure to hold Arc<Self> or use a different pattern

        // Try to find the port from startup.json
        let session_dir = self.sessions_dir.join(&session_id);
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
            let client = DaemonClient::new(session_id.clone(), port, std::process::id() as i32);
            let history_res = client.history(None, None).await;
            if let Some(history) = history_res.data {
                return history_seed::history_to_seed_events(
                    &history.items,
                    &HistoryMapCtx { r#ref: session_ref },
                );
            }
        }

        Vec::new()
    }

    async fn reload_session(&self, path: String) -> Vec<SessionDriverEvent> {
        let session_id = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        // Dispose existing warm session (extract before await to avoid holding the lock)
        let removed = self.warm.write().remove(&session_id);
        if let Some(ws) = removed {
            let sub = ws.sse_subscription.lock().take();
            if let Some(sub) = sub {
                sub.stop().await;
            }
            ws.client.close().await;
        }
        self.open_session(path).await
    }

    async fn new_session(&self, opts: NewSessionOptsData) -> Vec<SessionDriverEvent> {
        #[expect(
            unused_variables,
            reason = "BUG: opts.worktree ignored; worktree module unported until Phase 2"
        )]
        let ignored_worktree = &opts.worktree;
        let cwd = opts
            .cwd
            .clone()
            .unwrap_or_else(|| std::env::var("HOME").unwrap_or_default());

        // Spawn a new daemon
        let spawn_opts = SpawnDaemonOpts {
            cwd: Some(cwd.clone()),
            session_id: None,
            sessions_dir: None,
            global_config_dir: None,
            login_env: {
                #[expect(
                    unused_variables,
                    reason = "BUG: login_env forced None; login-env module unported until Phase 2"
                )]
                let ignored_login_env = ();
                None
            },
        };

        match crate::polytoken::daemon_client::spawn_daemon(&self.bin_path, spawn_opts).await {
            Ok((spawned, _child)) => {
                let session_id = spawned.session_id;
                let port = spawned.port;
                let client = Arc::new(DaemonClient::new(
                    session_id.clone(),
                    port,
                    std::process::id() as i32,
                ));

                // Wait for health
                let healthy = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    loop {
                        if client.health().await.status == 200 {
                            return true;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                })
                .await
                .unwrap_or(false);

                if !healthy {
                    error!("new_session: daemon health probe timed out");
                    return Vec::new();
                }

                // Claim lease
                let _ = client.claim_lease("pilot").await;

                // Apply model/thinking/facet if specified
                if let Some(model) = &opts.model {
                    let model_str = format!("{}/{}", model.provider, model.model_id);
                    let _ = client.set_model(&model_str, opts.thinking.as_deref()).await;
                }
                if let Some(facet) = &opts.facet {
                    let _ = client.set_facet(facet).await;
                }
                if let Some(mode) = opts.permission_monitor {
                    let daemon_mode = match mode {
                        pilot_protocol::session_driver::PermissionMonitorMode::Standard => {
                            pilot_daemon_types::PermissionMonitorMode::Standard
                        }
                        pilot_protocol::session_driver::PermissionMonitorMode::Bypass => {
                            pilot_daemon_types::PermissionMonitorMode::Bypass
                        }
                        pilot_protocol::session_driver::PermissionMonitorMode::BypassPlus => {
                            pilot_daemon_types::PermissionMonitorMode::BypassPlus
                        }
                        pilot_protocol::session_driver::PermissionMonitorMode::Autonomous => {
                            pilot_daemon_types::PermissionMonitorMode::Autonomous
                        }
                    };
                    let _ = client.set_permission_mode(daemon_mode).await;
                }

                // Build seed from history
                let history_res = client.history(None, None).await;
                let session_ref = SessionRef {
                    workspace_id: WorkspaceId::default(),
                    session_id: session_id.clone(),
                };
                let _workspace = WorkspaceRef {
                    workspace_id: WorkspaceId::default(),
                    path: cwd,
                    display_name: None,
                };

                if let Some(history) = history_res.data {
                    return history_seed::history_to_seed_events(
                        &history.items,
                        &HistoryMapCtx { r#ref: session_ref },
                    );
                }
                Vec::new()
            }
            Err(e) => {
                error!("new_session spawn failed: {e}");
                Vec::new()
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
            if let Some(ws) = self.get_warm(sid) {
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
        let output = tokio::process::Command::new(&self.bin_path)
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
        let output = tokio::process::Command::new(&self.bin_path)
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
        if let Some(cached) = self.command_cache.lock().get(&cache_key) {
            return cached.clone();
        }
        let output = tokio::process::Command::new(&self.bin_path)
            .args(["print-slash-commands", "--format", "json"])
            .output()
            .await;
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let commands = crate::polytoken::commands::parse_slash_commands(&stdout);
                self.command_cache
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
        let output = tokio::process::Command::new(&self.bin_path)
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
            if let Some(ws) = self.get_warm(sid) {
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
        let mut cmd = tokio::process::Command::new(&self.bin_path);
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
            if let Some(ws) = self.get_warm(sid) {
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
            if let Some(ws) = self.get_warm(sid) {
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
            if let Some(ws) = self.get_warm(sid) {
                let ws = ws.clone();
                tokio::spawn(async move {
                    let _ = ws.client.set_facet(&facet).await;
                });
            }
        }
    }

    fn set_permission_monitor(&self, mode: PermissionMonitorMode, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.get_warm(sid) {
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
            if let Some(ws) = self.get_warm(sid) {
                let _ = ws.client.toggle_adventurous_handoff().await;
            }
        }
    }

    async fn set_notification_autodrain(&self, enabled: bool, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.get_warm(sid) {
                let _ = ws.client.set_notification_autodrain(enabled).await;
            }
        }
    }

    async fn compact(&self, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.get_warm(sid) {
                let _ = ws.client.compact(None).await;
            }
        }
    }

    async fn clear_context(&self, session_id: Option<SessionId>) {
        if let Some(sid) = &session_id {
            if let Some(ws) = self.get_warm(sid) {
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
            if let Some(ws) = self.get_warm(sid) {
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
        *self.is_viewed.write() = Some(is_viewed);
    }

    async fn shutdown(&self) {
        // Extract all warm sessions before awaiting (avoid holding the lock across .await)
        let warm: Vec<Arc<WarmSession>> = self.warm.write().drain().map(|(_, v)| v).collect();
        for ws in warm {
            let sub = ws.sse_subscription.lock().take();
            if let Some(sub) = sub {
                sub.stop().await;
            }
            ws.client.close().await;
        }
    }

    fn run_script(&self, name: String) {
        if self.is_fake {
            warn!("run_script({name}) on fake daemon — not yet wired");
        }
    }

    fn reset(&self, bootstrap: bool) {
        if self.is_fake {
            warn!("reset({bootstrap}) on fake daemon — not yet wired");
        }
    }
}
