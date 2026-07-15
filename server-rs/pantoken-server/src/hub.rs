//! The session hub: owns the per-session seq/epoch-stamped event journal — the
//! single authoritative per-session store — and fans stamped events out to all
//! connected WS clients. New clients get hello + a seed of journal events they
//! fold from zero; a reconnect with a valid resume token gets just the tail
//! replayed instead. The hub keeps no folded SessionState of its own: the rare
//! paths that need one (respondUi's pending gate, branch's running gate,
//! /debug/state) fold the journal on demand.
//!
//! Port of `server/src/hub.ts` (1967 lines).
//!
//! ## Async driver completion queue
//!
//! The TypeScript hub starts fire-and-forget driver promises from synchronous
//! handlers; those driver calls run concurrently and their continuations mutate
//! the hub in completion order. Rust deliberately uses a stricter model: every
//! async driver completion that needs to affect hub state is funneled through one
//! bounded `mpsc` queue. Synchronous WS handling still locks the hub directly for
//! immediate work (hello/seed/local state), but it enqueues a `HubOp` for async
//! driver work. A single long-lived applier task owns the receiver, awaits each
//! op's driver future, then briefly locks the hub to apply the result and send
//! any `ServerMessage`s. This serializes async driver I/O in dispatch order, so
//! six concurrent TS connect-time calls become six sequential Rust daemon
//! round-trips, and each session swap adds four more queued refreshes.
//!
//! That throughput/latency tradeoff is intentional for this single-user local
//! tool: daemon RTT is low, `driver.prompt().await` resolves at daemon acceptance
//! rather than turn completion, abort/set_model control-plane calls bypass the
//! queue and remain responsive, and the client fold reducer is order-independent
//! across message types. The queue gives deterministic hub mutation without
//! relying on racy task re-locking; it is a documented divergence from TS rather
//! than an exact ordering match.
//!
//! The queue is bounded (256). Enqueue uses `try_send` because the hub dispatch
//! path is deliberately synchronous; a full queue is treated as a fail-loud
//! canary instead of silently dropping a completion. Phase 2 reuses this same
//! queue-over-bare-mutex idiom for sequential SSE event folding.
//!
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::FutureExt;
use pantoken_protocol::session_driver::{
    HostUiRequest, HostUiResponse, ModelOption, SessionDriverEvent, SessionDriverEvent as E,
    SessionEventBase, SessionId, SessionRef, SessionStatus, SessionUsage, is_dialog_request,
};
use pantoken_protocol::state::{SessionState, fold_all, fold_event, initial_session_state};
use pantoken_protocol::wire::{
    ClientMessage, PROTOCOL_VERSION, ResumeToken, ServerMessage, SessionAttention,
    SessionAttentionPhase,
};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tracing::error;

use crate::driver::{NewSessionOptsData, PantokenDriver, TodoDeleteError};
use crate::journal::{
    SessionJournal, append_event, build_seed, bump_epoch, create_journal, meta_seed_events,
    tail_covers, try_merge,
};

pub const HUB_COMPLETION_QUEUE_CAPACITY: usize = 256;

type HubApplyFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

type HubOp = Box<dyn FnOnce(Arc<Mutex<SessionHub>>) -> HubApplyFuture + Send + 'static>;

#[derive(Clone)]
pub struct HubOpSender {
    tx: mpsc::Sender<HubOp>,
}

pub struct HubOpReceiver {
    rx: mpsc::Receiver<HubOp>,
}

pub fn hub_op_channel() -> (HubOpSender, HubOpReceiver) {
    let (tx, rx) = mpsc::channel(HUB_COMPLETION_QUEUE_CAPACITY);
    (HubOpSender { tx }, HubOpReceiver { rx })
}

impl HubOpSender {
    fn enqueue(&self, label: &'static str, op: HubOp) {
        // `Full` is intentionally process-fatal: overflowing the single hub
        // completion queue would otherwise silently corrupt all clients, not just
        // the connection that happened to enqueue. Do not "fix" this by changing
        // to blocking `send().await`: the applier is the sole receiver and some
        // ops enqueue more work re-entrantly (for example, `finish_switch` queues
        // four refreshes), so waiting for capacity from inside the applier would
        // self-deadlock on a full channel. If `Full` is ever observed in practice,
        // use an unbounded channel or a much larger bound instead. For this
        // single-user tool, 256 requires roughly 43 simultaneous reconnects (or a
        // wedged applier), so panic-as-canary is reasonable today.
        match self.tx.try_send(op) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                panic!("hub completion queue is full while enqueuing {label}");
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                tracing::debug!(
                    "hub completion queue is closed while enqueuing {label}; dropping op during shutdown"
                );
            }
        }
    }
}

pub async fn run_hub_op_applier(hub: Arc<Mutex<SessionHub>>, mut receiver: HubOpReceiver) {
    while let Some(op) = receiver.rx.recv().await {
        // Catch panics while polling the async op so one bad daemon response or
        // unwrap cannot kill the sole drain loop and wedge every later enqueue.
        // `AssertUnwindSafe` is acceptable here: the captured hub is an
        // `Arc<parking_lot::Mutex<SessionHub>>` (`Send + Sync`), and the remaining
        // risk is only a partially-applied hub mutation. `parking_lot::Mutex` does
        // not poison; continuing after logging is strictly better than wedging the
        // queue, which was already the failure mode without containment.
        if let Err(panic) = AssertUnwindSafe(op(hub.clone())).catch_unwind().await {
            error!("hub op panicked: {panic:?}");
        }
    }
    error!("hub completion queue applier exited because all senders were dropped");
}

/// A boxed, pinned, Send future — the return type of swap closures. `Err(message)`
/// surfaces a swap failure (e.g. the mock's one-shot `failsession` 409 lease
/// conflict) so `switch_to` can classify + send a client-visible `Error` rather
/// than an empty-seed "no session" — ports the TS `switchTo` try/catch +
/// `classifySwitchError` (hub.ts:1333).
type SwapFuture =
    Pin<Box<dyn Future<Output = Result<Vec<SessionDriverEvent>, String>> + Send + 'static>>;

/// What the hub hands to a notifier (e.g. the Web Push sender) for notable events.
#[derive(Debug, Clone)]
pub struct HubNotification {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
    pub url: Option<String>,
    /// App-icon badge: how many sessions currently need the operator (pending
    /// dialog or failed run). Always set by the hub so a push self-corrects the
    /// badge; the service worker maps 0 to clearAppBadge().
    pub badge: Option<u32>,
}

/// Compact metadata for every warm session. Background transcripts stay private to the
/// driver; this map carries only enough state to route the operator's attention.
#[derive(Debug, Clone)]
struct AttentionRecord {
    phase: AttentionPhase,
    activity: Option<String>,
    updated_at: String,
    pending: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttentionPhase {
    Running,
    Failed,
    Done,
}

impl AttentionPhase {}

/// One connected client (WS connection). Focus is per-connection.
struct ClientConn {
    send: mpsc::Sender<ServerMessage>,
    /// The session this connection is viewing (None = the empty landing).
    focused_id: Option<SessionId>,
    /// Single-flight per connection: a swap can block, so only one runs at a time.
    switch_in_flight: bool,
    /// The latest switch queued behind an in-flight one.
    pending_switch: Option<PendingSwitch>,
}

/// A queued switch waiting for an in-flight one to finish.
struct PendingSwitch {
    /// The swap closure to run when the in-flight swap finishes.
    swap: Box<dyn FnOnce(Arc<Mutex<SessionHub>>) -> SwapFuture + Send>,
    /// Whether this is a reseed (branch/reload) or first attach.
    reseed: bool,
    /// Whether to retry on raced events (idempotent swaps only).
    retry_on_raced_events: bool,
    /// Resolve the awaiting caller with the eventual session id (or None).
    resolve: tokio::sync::oneshot::Sender<Option<SessionId>>,
}

/// A pending assistantDelta being coalesced (N1).
struct PendingDelta {
    ev: SessionDriverEvent,
    /// Abort handle for the flush timer.
    timer_abort: tokio::sync::oneshot::Sender<()>,
}

/// A buffered swap-window event (attach-window race fix).
struct BufferedSwapEvent {
    at_ms: u128,
    ev: SessionDriverEvent,
}

const SWAP_BUFFER_CAP: usize = 256;
const SWAP_BUFFER_TTL_MS: u128 = 5000;

/// The injectable file-manager spawn seam (see `SessionHub::open_in_file_manager`).
type OpenInFileManager = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Stable, operator-readable identity for the machine whose filesystem the picker
/// browses. Deployments may override it; the command fallback works on macOS and Linux
/// without unsafe platform APIs. The final fallback is intentionally generic but useful.
fn server_label() -> String {
    if let Ok(label) = std::env::var("PANTOKEN_SERVER_LABEL") {
        let label = label.trim();
        if !label.is_empty() {
            return label.to_string();
        }
    }
    if matches!(
        std::env::var("PANTOKEN_DRIVER").as_deref(),
        Ok("mock" | "fake")
    ) {
        return "Pantoken test server".to_string();
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "Pantoken server".to_string())
}

/// The session hub. Owns journals, client map, running/attention tracking,
/// and orchestrates the driver.
pub struct SessionHub {
    driver: Arc<dyn PantokenDriver>,
    hub_ops: HubOpSender,
    notify: Option<Arc<dyn Fn(HubNotification) + Send + Sync>>,
    #[expect(
        dead_code,
        reason = "live refresh timer is not wired until Phase 1 hub parity"
    )]
    live_refresh_ms: u64,
    server_id: String,
    server_label: String,
    data_dir: Option<PathBuf>,
    build_sha: String,
    delta_flush_ms: u64,

    /// Injectable seam for opening the data dir in the platform file manager.
    /// Defaults to the real spawn; tests override it to exercise the failure
    /// path (mirrors TS's injected `openInFileManager`).
    open_in_file_manager: OpenInFileManager,

    // ── Per-session state ────────────────────────────────────────────────
    journals: HashMap<SessionId, SessionJournal>,
    pending_deltas: HashMap<SessionId, PendingDelta>,
    swap_buffer: HashMap<SessionId, Vec<BufferedSwapEvent>>,
    swaps_in_flight: u32,

    // ── Cross-session tracking ────────────────────────────────────────────
    running: HashSet<SessionId>,
    initializing: HashSet<SessionId>,
    attention: HashMap<SessionId, AttentionRecord>,
    session_titles: HashMap<SessionId, String>,
    default_focus_id: Option<SessionId>,
    ever_connected: bool,
    session_list_dirty: bool,
    last_usage_emitted: HashMap<String, SessionUsage>,

    // ── Desktop update state ──────────────────────────────────────────────
    update_sha: Option<String>,
    applying: bool,
    desktop_stale: bool,
    force_requested: bool,

    // ── Model cache ───────────────────────────────────────────────────────
    available_models: Vec<ModelOption>,

    // ── Prompt idempotency ledger ─────────────────────────────────────────
    // Maps promptId → cached PromptResult. A retried promptId replays the
    // cached result instead of re-running the prompt. Capped at 2048 entries
    // (oldest evicted, matching the TS PROMPT_RESULT_CAP).
    prompt_results: HashMap<String, ServerMessage>,
    prompt_result_order: std::collections::VecDeque<String>,

    // ── Client management ──────────────────────────────────────────────────
    clients: HashMap<u64, ClientConn>,
    next_client_key: u64,

    // ── Epoch counter ─────────────────────────────────────────────────────
    epoch_counter: u64,
}

/// Open `dir` in the platform file manager (Finder / xdg-open). The default
/// `open_in_file_manager` seam; overridable in tests. Returns `Err` when the
/// spawn fails so the hub can surface it instead of silently discarding it.
fn default_open_in_file_manager(dir: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        let cmd = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(cmd)
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

impl SessionHub {
    #[expect(
        clippy::too_many_arguments,
        reason = "constructor mirrors the TS hub dependencies; Phase 1 only adds the completion queue"
    )]
    pub fn new(
        driver: Arc<dyn PantokenDriver>,
        hub_ops: HubOpSender,
        notify: Option<Arc<dyn Fn(HubNotification) + Send + Sync>>,
        live_refresh_ms: u64,
        server_id: String,
        data_dir: Option<PathBuf>,
        build_sha: String,
        delta_flush_ms: u64,
    ) -> Arc<Mutex<Self>> {
        let hub = Arc::new(Mutex::new(Self {
            driver,
            hub_ops,
            notify,
            live_refresh_ms,
            server_id,
            server_label: server_label(),
            data_dir,
            build_sha,
            delta_flush_ms,
            open_in_file_manager: Box::new(default_open_in_file_manager),
            journals: HashMap::new(),
            pending_deltas: HashMap::new(),
            swap_buffer: HashMap::new(),
            swaps_in_flight: 0,
            running: HashSet::new(),
            initializing: HashSet::new(),
            attention: HashMap::new(),
            session_titles: HashMap::new(),
            default_focus_id: None,
            ever_connected: false,
            session_list_dirty: true,
            last_usage_emitted: HashMap::new(),
            update_sha: None,
            applying: false,
            desktop_stale: false,
            force_requested: false,
            available_models: Vec::new(),
            prompt_results: HashMap::new(),
            prompt_result_order: std::collections::VecDeque::new(),
            clients: HashMap::new(),
            next_client_key: 0,
            epoch_counter: now_ms() as u64,
        }));

        // Seed the landing default
        {
            let mut h = hub.lock();
            h.seed_default();
        }

        hub
    }

    fn next_epoch(&mut self) -> u64 {
        self.epoch_counter += 1;
        self.epoch_counter
    }

    /// Override the file-manager spawn seam. Production keeps the real
    /// `default_open_in_file_manager`; debug drivers (mock/fake) inject a no-op
    /// so the e2e Reveal button never spawns a real Finder/xdg-open window.
    pub fn set_open_in_file_manager(
        &mut self,
        f: impl Fn(&str) -> Result<(), String> + Send + Sync + 'static,
    ) {
        self.open_in_file_manager = Box::new(f);
    }

    /// Establish the landing session a fresh client adopts.
    fn seed_default(&mut self) {
        if let Some(seed) = self.driver.default_seed() {
            if seed.is_empty() {
                return;
            }
            if let Some(sid) = seed.first().map(|e| e.session_ref().session_id.clone()) {
                for e in &seed {
                    let sid = e.session_ref().session_id.clone();
                    self.track_running(&sid, e);
                    self.track_attention(&sid, e);
                }
                let epoch = self.next_epoch();
                self.journals
                    .insert(sid.clone(), create_journal(epoch, &seed));
                self.default_focus_id = Some(sid);
            }
        }
    }

    /// The seed source for one session: the journal's events, delta-coalesced,
    /// plus the {epoch, seq} watermark.
    pub fn seed_of(&self, sid: Option<&SessionId>) -> Option<(u64, u64, Vec<SessionDriverEvent>)> {
        let j = sid.and_then(|s| self.journals.get(s))?;
        Some(build_seed(j))
    }

    /// Fold one session's journal into its authoritative SessionState, on demand.
    pub fn folded_state(&self, sid: Option<&SessionId>) -> Option<SessionState> {
        let (_, _, events) = self.seed_of(sid)?;
        Some(fold_all(&events))
    }

    /// Build the seed message for one session.
    fn seed_msg(&self, sid: Option<&SessionId>) -> ServerMessage {
        match self.seed_of(sid) {
            Some((epoch, seq, events)) => ServerMessage::Seed {
                session_id: sid.cloned(),
                epoch,
                seq,
                events,
            },
            None => {
                if let Some(sid) = sid {
                    error!("[hub] no journal for session {sid} — sending an empty seed");
                }
                ServerMessage::Seed {
                    session_id: sid.cloned(),
                    epoch: 0,
                    seq: 0,
                    events: Vec::new(),
                }
            }
        }
    }

    /// The single immediate append path: stamp the journal, route to viewers.
    fn ingest_now(&mut self, ev: &SessionDriverEvent) {
        let sid = ev.session_ref().session_id.clone();

        if ev.type_discriminator() == "sessionReset" {
            // Transcript identity changed: restart the journal under a new epoch.
            // We need to: fold the old journal, compute the meta, then bump_epoch.
            // Split to avoid double-mutable-borrow of self.
            let old_events = {
                let Some(j) = self.journals.get(&sid) else {
                    return;
                };
                let (_, _, events) = build_seed(j);
                events
            };
            let mut st = fold_all(&old_events);
            fold_event(&mut st, ev);
            let meta = meta_seed_events(&st, ev.session_ref(), ev.timestamp());
            let epoch = self.next_epoch();
            if let Some(j) = self.journals.get_mut(&sid) {
                bump_epoch(j, epoch, &meta);
            }

            // Viewers get the fresh seed.
            let msg = self.seed_msg(Some(&sid));
            let focused: Vec<_> = self.clients_focused(&sid);
            for send in focused {
                let _ = send.try_send(msg.clone());
            }
            return;
        }

        let (seq, epoch) = {
            let Some(j) = self.journals.get_mut(&sid) else {
                return;
            };
            let seq = append_event(j, ev.clone());
            (seq, j.epoch)
        };
        let msg = ServerMessage::Event {
            event: ev.clone(),
            epoch,
            seq,
        };
        let focused: Vec<_> = self.clients_focused(&sid);
        for send in focused {
            let _ = send.try_send(msg.clone());
        }
    }

    /// The buffered append path (N1 coalescing). Every event enters the journal
    /// through here; assistantDeltas are coalesced per session behind the
    /// deltaFlushMs flush window.
    fn ingest(&mut self, ev: &SessionDriverEvent) {
        let sid = ev.session_ref().session_id.clone();
        if self.delta_flush_ms == 0 || !self.journals.contains_key(&sid) {
            self.ingest_now(ev);
            return;
        }
        if ev.type_discriminator() != "assistantDelta" {
            self.flush_pending(&sid);
            self.ingest_now(ev);
            return;
        }
        // Try to merge with existing pending delta
        if let Some(pending) = self.pending_deltas.get_mut(&sid) {
            if let Some(merged) = try_merge(&pending.ev, ev) {
                pending.ev = merged;
                return;
            }
            // Channel switch: flush the held run, start a new one
            self.flush_pending(&sid);
        }
        // Start a new pending run with a flush timer: without one, a held delta
        // run only reaches viewers when the NEXT non-delta event happens to
        // arrive (tool start, channel switch, run end) — i.e. streaming text
        // lumps at block boundaries instead of flowing every delta_flush_ms.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            // No runtime to host the timer (sync caller): skip coalescing rather
            // than park the delta with no flush deadline.
            self.ingest_now(ev);
            return;
        };
        let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
        let hub_ops = self.hub_ops.clone();
        let flush_sid = sid.clone();
        let flush_ms = self.delta_flush_ms;
        runtime.spawn(async move {
            tokio::select! {
                // Flushed or dropped by another path — timer cancelled.
                _ = abort_rx => {}
                _ = tokio::time::sleep(std::time::Duration::from_millis(flush_ms)) => {
                    hub_ops.enqueue(
                        "delta_flush",
                        Box::new(move |hub| {
                            Box::pin(async move {
                                hub.lock().flush_pending(&flush_sid);
                            })
                        }),
                    );
                }
            }
        });
        self.pending_deltas.insert(
            sid.clone(),
            PendingDelta {
                ev: ev.clone(),
                timer_abort: abort_tx,
            },
        );
    }

    /// Commit one session's pending merged delta to the journal.
    fn flush_pending(&mut self, sid: &SessionId) {
        if let Some(pending) = self.pending_deltas.remove(sid) {
            let _ = pending.timer_abort.send(()); // abort the timer if armed
            self.ingest_now(&pending.ev);
        }
    }

    /// DROP one session's pending merged delta without committing it.
    fn drop_pending(&mut self, sid: &SessionId) {
        if let Some(pending) = self.pending_deltas.remove(sid) {
            let _ = pending.timer_abort.send(());
        }
    }

    /// Whether any connected client is currently focused on a session.
    fn has_viewer(&self, sid: &SessionId) -> bool {
        self.clients
            .values()
            .any(|c| c.focused_id.as_ref() == Some(sid))
    }

    /// Get all send channels focused on a session.
    fn clients_focused(&self, sid: &SessionId) -> Vec<mpsc::Sender<ServerMessage>> {
        self.clients
            .values()
            .filter(|c| c.focused_id.as_ref() == Some(sid))
            .map(|c| c.send.clone())
            .collect()
    }

    /// The main event ingestion path — called by the driver's event stream.
    pub fn on_event(&mut self, ev: SessionDriverEvent) {
        let sid = ev.session_ref().session_id.clone();

        // Cross-session tracking is GLOBAL
        let status_changed = self.track_running(&sid, &ev);
        let attention_changed = self.track_attention(&sid, &ev);
        if status_changed || attention_changed {
            self.broadcast_session_status();
        }

        // Mark session list dirty for events that change sidebar content
        let disc = ev.type_discriminator();
        if matches!(
            disc.as_str(),
            "userMessage"
                | "runCompleted"
                | "runFailed"
                | "sessionOpened"
                | "sessionClosed"
                | "sessionUpdated"
        ) {
            self.session_list_dirty = true;
        }

        // Attach-window race: buffer events for journal-less sessions during swaps
        if self.swaps_in_flight > 0 && !self.journals.contains_key(&sid) {
            self.buffer_swap_event(&sid, &ev);
        }

        // Journal + route for viewed sessions
        self.ingest(&ev);

        // Closed/evicted session drops its journal once nobody is viewing it
        if disc == "sessionClosed"
            && self.default_focus_id.as_ref() != Some(&sid)
            && !self.has_viewer(&sid)
        {
            self.drop_pending(&sid);
            self.journals.remove(&sid);
        }

        // On snapshot refresh (sessionUpdated/runCompleted), re-fetch jobs and
        // broadcast to all clients viewing this session. The hub owns the
        // broadcast because the driver can only emit SessionDriverEvents.
        if disc == "sessionUpdated" || disc == "runCompleted" {
            let driver = self.driver.clone();
            let session_id = sid.clone();
            self.hub_ops.enqueue(
                "fetch_jobs_on_update",
                Box::new(move |hub| {
                    Box::pin(async move {
                        let jobs = driver.list_jobs(Some(session_id.clone())).await;
                        let h = hub.lock();
                        let senders = h.clients_focused(&session_id);
                        for send in senders {
                            let _ = send.try_send(ServerMessage::JobsList { jobs: jobs.clone() });
                        }
                    })
                }),
            );
        }

        self.maybe_notify(&ev);
    }

    /// Buffer one attach-window event.
    fn buffer_swap_event(&mut self, sid: &SessionId, ev: &SessionDriverEvent) {
        let now = now_ms();
        // Prune stale entries
        let stale_keys: Vec<_> = self
            .swap_buffer
            .iter()
            .filter(|(_, list)| list.iter().all(|f| now - f.at_ms > SWAP_BUFFER_TTL_MS))
            .map(|(k, _)| k.clone())
            .collect();
        for k in stale_keys {
            self.swap_buffer.remove(&k);
        }

        let list = self.swap_buffer.entry(sid.clone()).or_default();
        if list.len() < SWAP_BUFFER_CAP {
            list.push(BufferedSwapEvent {
                at_ms: now,
                ev: ev.clone(),
            });
        }
    }

    /// Consume (and clear) the attach-window buffer for one session.
    #[expect(
        dead_code,
        reason = "attach-window race replay is not wired until Phase 1 hub parity"
    )]
    fn take_swap_buffer(&mut self, sid: &SessionId, since: u128) -> Vec<SessionDriverEvent> {
        let Some(list) = self.swap_buffer.remove(sid) else {
            return Vec::new();
        };
        let now = now_ms();
        list.into_iter()
            .filter(|f| now - f.at_ms <= SWAP_BUFFER_TTL_MS && f.at_ms >= since)
            .map(|f| f.ev)
            .collect()
    }

    // ── Running/initializing tracking ──────────────────────────────────────

    /// Update the running set from one event and report whether it changed.
    fn track_running(&mut self, sid: &SessionId, ev: &SessionDriverEvent) -> bool {
        let before = self.running.contains(sid);
        let before_init = self.initializing.contains(sid);
        let disc = ev.type_discriminator();
        match disc.as_str() {
            "sessionOpened" | "sessionUpdated" | "runCompleted" => {
                let status = ev.snapshot_status();
                self.set_running(sid, status == Some(SessionStatus::Running));
                self.set_initializing(sid, status == Some(SessionStatus::Initializing));
            }
            "assistantDelta"
            | "toolStarted"
            | "toolUpdated"
            | "userMessage"
            | "queuedMessageStarted" => {
                self.set_running(sid, true);
            }
            "runFailed" | "sessionClosed" => {
                self.set_running(sid, false);
                self.set_initializing(sid, false);
            }
            _ => {}
        }
        self.running.contains(sid) != before || self.initializing.contains(sid) != before_init
    }

    fn set_running(&mut self, sid: &SessionId, on: bool) {
        if on {
            self.running.insert(sid.clone());
            self.initializing.remove(sid);
        } else {
            self.running.remove(sid);
        }
    }

    fn set_initializing(&mut self, sid: &SessionId, on: bool) {
        if on {
            self.initializing.insert(sid.clone());
            self.running.remove(sid);
        } else {
            self.initializing.remove(sid);
        }
    }

    // ── Attention tracking ────────────────────────────────────────────────

    fn attention_for(&self, sid: &SessionId) -> Option<SessionAttention> {
        let record = self.attention.get(sid)?;
        let pending: Vec<String> = record.pending.values().cloned().collect();
        if !pending.is_empty() {
            return Some(SessionAttention {
                session_id: sid.clone(),
                phase: SessionAttentionPhase::Waiting,
                activity: Some("Waiting on you".into()),
                pending_count: Some(pending.len() as i64),
                pending_title: Some(pending[0].clone()),
                updated_at: record.updated_at.clone(),
            });
        }
        Some(SessionAttention {
            session_id: sid.clone(),
            phase: match record.phase {
                AttentionPhase::Running => SessionAttentionPhase::Running,
                AttentionPhase::Failed => SessionAttentionPhase::Failed,
                AttentionPhase::Done => SessionAttentionPhase::Done,
            },
            activity: record.activity.clone(),
            pending_count: None,
            pending_title: None,
            updated_at: record.updated_at.clone(),
        })
    }

    fn track_attention(&mut self, sid: &SessionId, ev: &SessionDriverEvent) -> bool {
        let before = self.attention_for(sid);

        let disc = ev.type_discriminator();
        let timestamp = ev.timestamp();

        match disc.as_str() {
            "sessionOpened" | "sessionUpdated" => {
                if let Some(title) = ev.snapshot_title() {
                    self.session_titles.insert(sid.clone(), title);
                }
                let status = ev.snapshot_status();
                match status {
                    Some(SessionStatus::Running) => self.set_attention_base(
                        sid,
                        AttentionPhase::Running,
                        Some("Working"),
                        timestamp,
                    ),
                    Some(SessionStatus::Initializing) => self.set_attention_base(
                        sid,
                        AttentionPhase::Running,
                        Some("Starting session"),
                        timestamp,
                    ),
                    Some(SessionStatus::Failed) => self.set_attention_base(
                        sid,
                        AttentionPhase::Failed,
                        Some("Run failed"),
                        timestamp,
                    ),
                    Some(SessionStatus::Idle) => {
                        // An authoritative idle snapshot settles a stuck "Running"
                        // attention phase, exactly as `track_running` clears the running
                        // set on idle above. A replayed transcript ends on an
                        // assistantDelta/toolFinished (phase Running, e.g. "Responding"),
                        // and the trailing idle re-assert `build_branch_seed` appends must
                        // settle attention too — otherwise a freshly OPENED cold idle
                        // session shows "Responding" in the sidebar forever (regression
                        // `050hrk-cheek`: runningIds is empty and the transcript is closed,
                        // but the attention record stays Running). Only downgrade an
                        // EXISTING Running record with no pending approval → Done; never
                        // CREATE a record (a bare sessionOpened(idle) on a fresh session
                        // has no activity to settle) and never clobber Waiting/Failed/Done.
                        let stuck_running = self
                            .attention
                            .get(sid)
                            .map(|r| r.phase == AttentionPhase::Running && r.pending.is_empty())
                            .unwrap_or(false);
                        if stuck_running {
                            self.set_attention_base(
                                sid,
                                AttentionPhase::Done,
                                Some("Done"),
                                timestamp,
                            );
                        }
                    }
                    _ => {}
                }
            }
            "userMessage" => {
                self.set_attention_base(sid, AttentionPhase::Running, Some("Starting"), timestamp)
            }
            "queuedMessageStarted" => self.set_attention_base(
                sid,
                AttentionPhase::Running,
                Some("Queued a follow-up"),
                timestamp,
            ),
            "assistantDelta" => {
                let channel = ev.assistant_delta_channel();
                let activity = if channel.as_deref() == Some("thinking") {
                    "Thinking"
                } else {
                    "Responding"
                };
                self.set_attention_base(sid, AttentionPhase::Running, Some(activity), timestamp);
            }
            "toolStarted" => {
                let activity = tool_activity(ev);
                self.set_attention_base(sid, AttentionPhase::Running, Some(&activity), timestamp);
            }
            "toolFinished" => {
                if self
                    .attention
                    .get(sid)
                    .map(|r| r.phase == AttentionPhase::Running)
                    .unwrap_or(false)
                {
                    self.set_attention_base(
                        sid,
                        AttentionPhase::Running,
                        Some("Working"),
                        timestamp,
                    );
                }
            }
            "runCompleted" => {
                if let Some(title) = ev.snapshot_title() {
                    self.session_titles.insert(sid.clone(), title);
                }
                self.set_attention_base(sid, AttentionPhase::Done, Some("Done"), timestamp);
            }
            "runFailed" => {
                self.ensure_attention(sid, timestamp);
                if let Some(record) = self.attention.get_mut(sid) {
                    record.pending.clear();
                }
                let msg = ev.error_message().unwrap_or_default();
                self.set_attention_base(
                    sid,
                    AttentionPhase::Failed,
                    Some(&clipped(&msg, 72)),
                    timestamp,
                );
            }
            "hostUiRequest" => {
                if let E::HostUiRequest { request, .. } = ev {
                    if is_dialog_request(request) {
                        let title = request_title(request);
                        self.ensure_attention(sid, timestamp);
                        if let Some(record) = self.attention.get_mut(sid) {
                            record
                                .pending
                                .insert(request.request_id().to_string(), title);
                            record.updated_at = timestamp.clone();
                        }
                    } else if let HostUiRequest::Status { text, .. } = request {
                        if let Some(t) = text {
                            if self
                                .attention
                                .get(sid)
                                .map(|r| r.phase == AttentionPhase::Running)
                                .unwrap_or(false)
                            {
                                self.set_attention_base(
                                    sid,
                                    AttentionPhase::Running,
                                    Some(&clipped(t, 72)),
                                    timestamp,
                                );
                            }
                        }
                    } else if let HostUiRequest::Title { title, .. } = request {
                        self.session_titles.insert(sid.clone(), title.clone());
                    }
                }
            }
            "hostUiResolved" => {
                if let E::HostUiResolved { request_id, .. } = ev {
                    if let Some(record) = self.attention.get_mut(sid) {
                        if record.pending.remove(request_id).is_some() {
                            record.updated_at = timestamp.clone();
                        }
                    }
                }
            }
            "sessionClosed" => {
                self.attention.remove(sid);
                self.session_titles.remove(sid);
            }
            _ => {}
        }

        let after = self.attention_for(sid);
        before != after
    }

    fn ensure_attention(&mut self, sid: &SessionId, timestamp: &str) {
        if !self.attention.contains_key(sid) {
            self.attention.insert(
                sid.clone(),
                AttentionRecord {
                    phase: AttentionPhase::Running,
                    activity: Some("Working".into()),
                    updated_at: timestamp.into(),
                    pending: HashMap::new(),
                },
            );
        }
    }

    fn set_attention_base(
        &mut self,
        sid: &SessionId,
        phase: AttentionPhase,
        activity: Option<&str>,
        timestamp: &str,
    ) {
        self.ensure_attention(sid, timestamp);
        if let Some(record) = self.attention.get_mut(sid) {
            let changed = record.phase != phase || record.activity.as_deref() != activity;
            record.phase = phase;
            record.activity = activity.map(|s| s.to_string());
            if changed {
                record.updated_at = timestamp.into();
            }
        }
    }

    // ── Session status broadcast ──────────────────────────────────────────

    fn session_status_msg(&self) -> ServerMessage {
        let attention: Vec<SessionAttention> = self
            .attention
            .keys()
            .filter_map(|sid| self.attention_for(sid))
            .collect();
        ServerMessage::SessionStatus {
            running_ids: self.running.iter().cloned().collect(),
            initializing_ids: Some(self.initializing.iter().cloned().collect()),
            attention: Some(attention),
        }
    }

    fn broadcast_session_status(&mut self) {
        // Broadcast the current sessionStatus (running/initializing/attention) to
        // every connected client — faithful port of TS hub.broadcastSessionStatus,
        // which calls this.broadcast(this.sessionStatusMsg()). The TS version also
        // calls syncLiveRefresh() here; the Rust server reconciles the live-refresh
        // ticker separately from the main loop (sync_live_refresh/needs_live_refresh).
        self.broadcast(self.session_status_msg());
    }

    // ── Notification ───────────────────────────────────────────────────────

    /// Sessions currently needing the operator: a pending dialog/approval or a
    /// failed run. Feeds the push payload's app-icon badge (runs AFTER
    /// track_attention in the event path, so the triggering event is counted).
    fn attention_badge_count(&self) -> u32 {
        self.attention
            .values()
            .filter(|r| !r.pending.is_empty() || r.phase == AttentionPhase::Failed)
            .count() as u32
    }

    fn maybe_notify(&self, ev: &SessionDriverEvent) {
        let Some(notify) = &self.notify else { return };
        // Push only when someone has been here and then left
        if self.ever_connected && self.client_count() == 0 {
            let sid = ev.session_ref().session_id.clone();
            let session = self
                .session_titles
                .get(&sid)
                .cloned()
                .unwrap_or_else(|| sid.clone());
            let url = format!("/?session={}", urlencoding::encode(&sid));
            let badge = Some(self.attention_badge_count());
            let disc = ev.type_discriminator();
            if disc == "runCompleted" {
                notify(HubNotification {
                    title: "pantoken".into(),
                    body: format!("{session} finished its turn"),
                    tag: Some(format!("pantoken-run-{sid}")),
                    url: Some(url),
                    badge,
                });
            } else if disc == "runFailed" {
                let msg = ev.error_message().unwrap_or_default();
                notify(HubNotification {
                    title: "pantoken".into(),
                    body: format!("{session} failed: {}", clipped(&msg, 72)),
                    tag: Some(format!("pantoken-run-{sid}")),
                    url: Some(url),
                    badge,
                });
            } else if disc == "hostUiRequest" {
                if let E::HostUiRequest { request, .. } = ev {
                    if is_dialog_request(request) {
                        let title = request.title().unwrap_or("Waiting on you");
                        notify(HubNotification {
                            title: "Approval needed".into(),
                            body: format!("{session}: {title}"),
                            tag: Some(format!("pantoken-approval-{sid}")),
                            url: Some(url),
                            badge,
                        });
                    }
                }
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────

    pub fn client_count(&self) -> usize {
        self.clients.len()
    }

    pub fn snapshot(&self) -> serde_json::Value {
        // Fold the default session's journal for /debug/state
        let sid = self.default_focus_id.as_ref();
        match self.folded_state(sid) {
            Some(state) => serde_json::to_value(&state).unwrap_or(serde_json::json!({})),
            None => serde_json::json!({}),
        }
    }

    pub fn activity(&self) -> serde_json::Value {
        serde_json::json!({
            "running": self.running.len(),
            "initializing": self.initializing.len(),
            "busy": !self.running.is_empty() || !self.initializing.is_empty(),
        })
    }

    pub fn report_update(
        &mut self,
        sha: Option<String>,
        apply_failed: bool,
        desktop_stale: Option<bool>,
    ) -> serde_json::Value {
        // Ports TS `reportUpdate` (server/src/hub.ts:1929). Broadcasts
        // `updateStatus` only when something actually changed, and hands back
        // `{applying, force}` so the shell updater learns on this same poll
        // whether the user clicked "update now" / "force-update". `force` is
        // read-once — handed to this caller and cleared — so a force triggers
        // exactly one check-and-apply.
        let mut changed = false;
        if sha != self.update_sha {
            self.update_sha = sha;
            if self.update_sha.is_none() {
                self.applying = false; // applied/gone — drop any apply flag
            }
            changed = true;
        }
        if apply_failed && self.applying {
            self.applying = false;
            changed = true;
        }
        if apply_failed {
            self.force_requested = false; // a failed force shouldn't re-fire
        }
        // `desktop_stale` is a Rust-only knob (TS has no equivalent); apply it
        // without affecting `changed` so it never spuriously broadcasts.
        if let Some(stale) = desktop_stale {
            self.desktop_stale = stale;
        }
        if changed {
            self.broadcast(self.update_status_msg());
        }
        let force = self.force_requested;
        self.force_requested = false; // read-once: this poll owns the force
        serde_json::json!({
            "applying": self.applying,
            "force": force,
        })
    }

    pub fn reset(&mut self, bootstrap: bool) {
        // Clear all state
        self.journals.clear();
        self.pending_deltas.clear();
        self.swap_buffer.clear();
        self.running.clear();
        self.initializing.clear();
        self.attention.clear();
        self.session_titles.clear();
        self.last_usage_emitted.clear();
        self.default_focus_id = None;
        self.session_list_dirty = true;
        self.swaps_in_flight = 0;
        self.prompt_results.clear();
        self.prompt_result_order.clear();

        // Restore pantoken-local settings to defaults so a test's setLoginShell/
        // setBackgroundModel mutation doesn't leak into sibling specs (the persisted
        // file is shared across the per-port data dir for the whole e2e run).
        if let Some(dir) = &self.data_dir {
            let _ = crate::settings_store::write_pantoken_settings(
                dir,
                &crate::settings_store::PartialSettings {
                    login_shell: Some(None),
                    background_model: Some(None),
                    enabled_extensions: None,
                },
            );
        }

        self.driver.reset(bootstrap);
        if bootstrap {
            self.seed_default();
        }

        // Re-seed all connected clients: reset their focus + send fresh seeds.
        // Mirrors the TS hub's reset() which iterates clients and sends seedMsg.
        let default_focus = self.default_focus_id.clone();
        let client_keys: Vec<u64> = self.clients.keys().cloned().collect();
        for ck in client_keys {
            // Reset the client's focus to the new default (if any)
            if let Some(ref sid) = default_focus {
                self.set_client_focus(ck, sid.clone());
            } else {
                // No default session — clear the client's focus
                if let Some(conn) = self.clients.get_mut(&ck) {
                    conn.focused_id = None;
                }
            }
            let msg = self.seed_msg(default_focus.as_ref());
            self.send_to_client(ck, msg);
        }

        // Broadcast the cleared running/attention state + refreshed session list.
        // Mirrors TS `reset()` tail (hub.ts:1888-1892): `broadcastSessionStatus()`
        // + `broadcastSessionList()`. Without the session-status broadcast, a
        // client's stale "done" attention never clears after reset (the
        // sidebar-row unread test fails here — `data-state` stays "done").
        self.broadcast_session_status();
        let driver = self.driver.clone();
        self.hub_ops.enqueue(
            "reset_session_list",
            Box::new(move |hub| {
                Box::pin(async move {
                    let sessions = driver.list_sessions().await;
                    let default_cwd = std::env::var("HOME").unwrap_or_default();
                    hub.lock()
                        .broadcast_session_list_with(sessions, default_cwd);
                })
            }),
        );
    }

    // ── Client management ──────────────────────────────────────────────────

    /// Register a client. Returns the client key + send channel for the client's messages.
    /// The caller spawns a task that reads from the channel and sends over WS.
    pub fn add_client(
        &mut self,
        resume: Option<ResumeToken>,
    ) -> (
        u64,
        mpsc::Sender<ServerMessage>,
        mpsc::Receiver<ServerMessage>,
    ) {
        let (tx, rx) = mpsc::channel(128);

        let focused_id = match &resume {
            Some(r) => {
                // Resume: adopt the resumed session if the journal matches
                if let Some(j) = self.journals.get(&r.session_id) {
                    if j.epoch == r.epoch && tail_covers(j, r.seq) {
                        Some(r.session_id.clone())
                    } else {
                        self.default_focus_id.clone()
                    }
                } else {
                    self.default_focus_id.clone()
                }
            }
            None => self.default_focus_id.clone(),
        };

        let conn = ClientConn {
            send: tx.clone(),
            focused_id: focused_id.clone(),
            switch_in_flight: false,
            pending_switch: None,
        };

        // Use a unique key for this client — we use the channel's address as a proxy.
        // In the TS version, the `send` closure is the key. Here we use a counter.
        let client_key = self.next_client_key;
        self.next_client_key += 1;
        self.clients.insert(client_key, conn);
        self.ever_connected = true;

        // Send hello synchronously. Use the shared constant so the greeting can
        // never drift from the client's compiled-in version (the mismatch guard
        // is the whole point of bumping it).
        let _ = tx.try_send(ServerMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            server_id: self.server_id.clone(),
            server_label: self.server_label.clone(),
            data_dir: self
                .data_dir
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            build_sha: Some(self.build_sha.clone()),
        });

        // Resume: replay missed tail, or full seed
        if let Some(r) = &resume {
            if let Some(j) = self.journals.get(&r.session_id) {
                if j.epoch == r.epoch && tail_covers(j, r.seq) {
                    for f in &j.tail {
                        if f.seq > r.seq {
                            let _ = tx.try_send(ServerMessage::Event {
                                event: f.ev.clone(),
                                epoch: j.epoch,
                                seq: f.seq,
                            });
                        }
                    }
                } else {
                    let _ = tx.try_send(self.seed_msg(Some(&r.session_id)));
                }
            } else {
                let _ = tx.try_send(self.seed_msg(focused_id.as_ref()));
            }
        } else {
            let _ = tx.try_send(self.seed_msg(focused_id.as_ref()));
        }

        // Send session status + update status + pantoken settings synchronously
        let _ = tx.try_send(self.session_status_msg());
        let _ = tx.try_send(self.update_status_msg());
        let _ = tx.try_send(self.pantoken_settings_msg());

        // Return the channel — the caller will spawn async work for the lists
        (client_key, tx, rx)
    }

    /// Get the last client key assigned (for backward compat with main.rs hack).
    pub fn last_client_key(&self) -> u64 {
        self.next_client_key - 1
    }

    /// Remove a client by key.
    pub fn remove_client(&mut self, client_key: u64) {
        if let Some(conn) = self.clients.remove(&client_key) {
            if let Some(pending) = conn.pending_switch {
                let _ = pending.resolve.send(None);
            }
        }
    }

    fn update_status_msg(&self) -> ServerMessage {
        ServerMessage::UpdateStatus {
            available: self.update_sha.is_some(),
            sha: self.update_sha.clone(),
            applying: self.applying,
            desktop_stale: Some(self.desktop_stale),
        }
    }

    /// Broadcast a message to all connected clients.
    fn broadcast(&self, msg: ServerMessage) {
        for conn in self.clients.values() {
            let _ = conn.send.try_send(msg.clone());
        }
    }

    // ── handleClient dispatch ──────────────────────────────────────────────

    /// Handle a client message. This is the main WS dispatch — the ~35 case
    /// switch from hub.ts. Synchronous (no await) — async driver completions are
    /// enqueued as `HubOp`s, so the hub lock is never held across an await point.
    pub fn handle_client(&mut self, client_key: u64, msg: ClientMessage) {
        // Get the focused session id for this connection
        let focused_id = self
            .clients
            .get(&client_key)
            .and_then(|c| c.focused_id.clone());

        match &msg {
            ClientMessage::Hello { .. } => {}
            // Heartbeat: reply immediately so the client ws layer's watchdog sees
            // inbound traffic and knows the transport is still alive. No session
            // targeting, no journal/fold involvement — this client_key only.
            ClientMessage::Ping => self.send_to_client(client_key, ServerMessage::Pong),
            ClientMessage::Prompt {
                text,
                deliver_as,
                images,
                prompt_id,
                session_id,
                ..
            } => {
                // C3 fix: check the prompt idempotency ledger before running.
                // A retried promptId replays the cached result instead of re-running.
                if let Some(cached) = self.check_prompt_idempotency(prompt_id) {
                    self.send_to_client(client_key, cached);
                    return;
                }
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                let text = text.clone();
                let deliver_as = *deliver_as;
                let images = images.clone().unwrap_or_default();
                let prompt_id_clone = prompt_id.clone();
                let client_key_clone = client_key;
                let pid = prompt_id.clone();
                self.hub_ops.enqueue(
                    "prompt",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            // Run the prompt; an Err (driver rejection, e.g. the
                            // mock `__pantoken_reject_prompt__` sentinel) surfaces as
                            // `promptResult { accepted: false }` so the client shows
                            // the rejected/delivery-error state. Ports TS
                            // `acceptPrompt`'s `.catch` (hub.ts:1026).
                            let prompt_outcome = driver
                                .prompt(text, deliver_as, target.clone(), images, prompt_id_clone)
                                .await;

                            let msg = match (prompt_outcome, &target) {
                                (Ok(()), Some(sid)) => ServerMessage::PromptResult {
                                    prompt_id: pid.clone().unwrap_or_default(),
                                    accepted: true,
                                    session_id: Some(sid.clone()),
                                    error: None,
                                },
                                (Ok(()), None) => ServerMessage::PromptResult {
                                    prompt_id: pid.clone().unwrap_or_default(),
                                    accepted: true,
                                    session_id: None,
                                    error: None,
                                },
                                (Err(e), _) => ServerMessage::PromptResult {
                                    prompt_id: pid.clone().unwrap_or_default(),
                                    accepted: false,
                                    session_id: None,
                                    error: Some(e),
                                },
                            };
                            let mut h = hub.lock();
                            // Cache the result for idempotent replay
                            if let Some(ref pid_str) = pid {
                                h.cache_prompt_result(pid_str.clone(), msg.clone());
                            }
                            h.send_to_client(client_key_clone, msg);
                        })
                    }),
                );
            }
            ClientMessage::Abort {
                request_id,
                session_id,
            } => {
                let target = session_id.clone().or(focused_id);
                let request_id = request_id.clone();
                let driver = self.driver.clone();
                let client = self.clients.get(&client_key).map(|conn| conn.send.clone());
                // Stop is a control-plane escape hatch: it must not wait behind a
                // serialized prompt, session switch, or refresh in the hub-op queue.
                // The completion only sends a client-private result, so it needs no
                // hub lock and cannot reorder the shared event journal.
                if let Some(client) = client {
                    tokio::spawn(async move {
                        let result = driver.abort(target).await;
                        let msg = match result {
                            Ok(()) => ServerMessage::AbortResult {
                                request_id,
                                accepted: true,
                                error: None,
                            },
                            Err(error) => ServerMessage::AbortResult {
                                request_id,
                                accepted: false,
                                error: Some(error),
                            },
                        };
                        let _ = client.send(msg).await;
                    });
                }
            }
            ClientMessage::SessionAction { action, session_id } => {
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                let action = action.clone();
                self.hub_ops.enqueue(
                    "session_action",
                    Box::new(move |_hub| {
                        Box::pin(async move { driver.session_action(action, target).await })
                    }),
                );
            }
            ClientMessage::ListSessions => {
                let driver = self.driver.clone();
                self.hub_ops.enqueue(
                    "list_sessions",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let sessions = driver.list_sessions().await;
                            let default_cwd = std::env::var("HOME").unwrap_or_default();
                            let mut h = hub.lock();
                            h.broadcast_session_list_with(sessions, default_cwd);
                        })
                    }),
                );
            }
            ClientMessage::RequestSeed { session_id } => {
                let target = session_id.clone().or(focused_id);
                let msg = self.seed_msg(target.as_ref());
                self.send_to_client(client_key, msg);
            }
            ClientMessage::Mock { script } => {
                self.driver.run_script(script.clone());
            }
            ClientMessage::OpenSession { path } => {
                let driver = self.driver.clone();
                let path = path.clone();
                self.hub_ops.enqueue(
                    "open_session",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let swap = Box::new(move |_hub: Arc<Mutex<SessionHub>>| {
                                let driver = driver.clone();
                                let path = path.clone();
                                Box::pin(async move { driver.open_session(path).await })
                                    as SwapFuture
                            });
                            switch_to(hub, client_key, swap, false, true).await;
                        })
                    }),
                );
            }
            ClientMessage::ReloadSession { path } => {
                let driver = self.driver.clone();
                let path = path.clone();
                self.hub_ops.enqueue(
                    "reload_session",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let swap = Box::new(move |_hub: Arc<Mutex<SessionHub>>| {
                                let driver = driver.clone();
                                let path = path.clone();
                                Box::pin(async move { driver.reload_session(path).await })
                                    as SwapFuture
                            });
                            switch_to(hub, client_key, swap, true, true).await;
                        })
                    }),
                );
            }
            ClientMessage::RespondUi {
                response,
                session_id,
            } => {
                let sid = session_id.clone().or(focused_id);
                // First-responder-wins: only answer if the dialog is still pending.
                let st = self.folded_state(sid.as_ref());
                let response_rid = response_request_id(response);
                let should_respond = st
                    .as_ref()
                    .map(|s| {
                        s.pending_approvals
                            .iter()
                            .any(|p| p.request_id() == response_rid)
                    })
                    .unwrap_or(false);
                if should_respond {
                    self.driver.respond_ui(response.clone(), sid);
                }
            }
            ClientMessage::RestoreQueue { session_id } => {
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                self.hub_ops.enqueue(
                    "restore_queue",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let restored = driver.clear_queue(target).await;
                            let h = hub.lock();
                            h.send_to_client(
                                client_key,
                                ServerMessage::QueueRestored {
                                    steering: restored.steering,
                                    follow_up: restored.follow_up,
                                },
                            );
                        })
                    }),
                );
            }
            ClientMessage::Branch {
                entry_id,
                summarize,
                session_id,
                ..
            } => {
                let target_id = session_id.clone().or(focused_id);
                // Gate: can't branch while a turn is running
                let target_state = self.folded_state(target_id.as_ref());
                if target_state
                    .as_ref()
                    .map(|s| {
                        s.status == SessionStatus::Running
                            || s.status == SessionStatus::Initializing
                    })
                    .unwrap_or(false)
                {
                    self.send_to_client(
                        client_key,
                        ServerMessage::Error {
                            message: "Can't branch while a turn is running — stop it first.".into(),
                            kind: None,
                        },
                    );
                    return;
                }
                let driver = self.driver.clone();
                let entry_id = entry_id.clone();
                let summarize = *summarize;
                self.hub_ops.enqueue(
                    "branch",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            // The editorText (a user-prompt branch's re-editable text) is
                            // per-client, so it goes ONLY to the requester after the swap lands.
                            let prefill: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
                            let prefill_clone = prefill.clone();
                            let swap = Box::new(move |_hub: Arc<Mutex<SessionHub>>| {
                                let driver = driver.clone();
                                let entry_id = entry_id.clone();
                                let prefill_clone = prefill_clone.clone();
                                Box::pin(async move {
                                    let result = driver
                                        .branch_from(
                                            entry_id,
                                            summarize.unwrap_or(false),
                                            target_id,
                                        )
                                        .await;
                                    if let Some(text) = result.editor_text {
                                        *prefill_clone.lock() = Some(text);
                                    }
                                    Ok(result.seed)
                                }) as SwapFuture
                            });
                            let sid = switch_to(hub.clone(), client_key, swap, true, false).await;
                            if sid.is_some() {
                                if let Some(text) = prefill.lock().take() {
                                    let h = hub.lock();
                                    h.send_to_client(
                                        client_key,
                                        ServerMessage::EditorPrefill { text },
                                    );
                                }
                            }
                        })
                    }),
                );
            }
            ClientMessage::NewSession {
                cwd,
                worktree,
                model,
                thinking,
                facet,
                permission_monitor,
                prompt,
                images,
                prompt_id,
                ..
            } => {
                // C3 fix: check the prompt idempotency ledger before running.
                if let Some(cached) = self.check_prompt_idempotency(prompt_id) {
                    self.send_to_client(client_key, cached);
                    return;
                }
                let first_prompt = prompt.as_ref().map(|p| p.trim()).filter(|p| !p.is_empty());
                let has_images = images.as_ref().map(|i| !i.is_empty()).unwrap_or(false);
                let has_first_prompt = first_prompt.is_some() || has_images;
                let driver = self.driver.clone();
                let opts = NewSessionOptsData {
                    cwd: cwd.clone(),
                    worktree: *worktree,
                    model: model.as_ref().map(|m| crate::driver::NewSessionModel {
                        provider: m.provider.clone(),
                        model_id: m.model_id.clone(),
                    }),
                    thinking: thinking.clone(),
                    facet: facet.clone(),
                    permission_monitor: *permission_monitor,
                };
                let prompt_text = first_prompt.map(|s| s.to_string());
                let first_images = images.clone().unwrap_or_default();
                let prompt_id_clone = prompt_id.clone();
                self.hub_ops.enqueue(
                    "new_session",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let driver_for_prompt = driver.clone();
                            let swap = Box::new(move |_hub: Arc<Mutex<SessionHub>>| {
                                let driver = driver.clone();
                                let opts = opts.clone();
                                Box::pin(async move { driver.new_session(opts).await })
                                    as SwapFuture
                            });
                            let sid = switch_to(hub.clone(), client_key, swap, false, false).await;
                            if let Some(sid) = sid {
                                if has_first_prompt {
                                    let pid = prompt_id_clone.clone();
                                    let pid_for_cache = prompt_id_clone.clone();
                                    let prompt_outcome = driver_for_prompt
                                        .prompt(
                                            prompt_text.unwrap_or_default(),
                                            None,
                                            Some(sid.clone()),
                                            first_images,
                                            pid.clone(),
                                        )
                                        .await;
                                    // A rejected first prompt (e.g. the mock's
                                    // `__pantoken_reject_prompt__` sentinel) surfaces as
                                    // `promptResult { accepted: false }` — ports TS
                                    // `createAndPrompt` throwing inside `acceptPrompt`.
                                    let msg = match prompt_outcome {
                                        Ok(()) => ServerMessage::PromptResult {
                                            prompt_id: pid.unwrap_or_default(),
                                            accepted: true,
                                            session_id: Some(sid),
                                            error: None,
                                        },
                                        Err(e) => ServerMessage::PromptResult {
                                            prompt_id: pid.unwrap_or_default(),
                                            accepted: false,
                                            session_id: None,
                                            error: Some(e),
                                        },
                                    };
                                    let mut h = hub.lock();
                                    // C3: cache the result for idempotent replay
                                    if let Some(ref pid_str) = pid_for_cache {
                                        h.cache_prompt_result(pid_str.clone(), msg.clone());
                                    }
                                    h.send_to_client(client_key, msg);
                                }
                            } else {
                                // C5 fix: when create fails and the client is awaiting a prompt ACK
                                // by promptId, send PromptResult (not just Error) so the client
                                // unblocks. Mirrors TS createAndPrompt throwing inside acceptPrompt.
                                let mut h = hub.lock();
                                if has_first_prompt {
                                    let msg = ServerMessage::PromptResult {
                                        prompt_id: prompt_id_clone.clone().unwrap_or_default(),
                                        accepted: false,
                                        session_id: None,
                                        error: Some("Could not create the new session".into()),
                                    };
                                    // C3: cache the failure for idempotent replay
                                    if let Some(ref pid_str) = prompt_id_clone {
                                        h.cache_prompt_result(pid_str.clone(), msg.clone());
                                    }
                                    h.send_to_client(client_key, msg);
                                } else {
                                    h.send_to_client(
                                        client_key,
                                        ServerMessage::Error {
                                            message: "Could not create the new session".into(),
                                            kind: None,
                                        },
                                    );
                                }
                            }
                        })
                    }),
                );
            }
            ClientMessage::SetArchived { path, archived } => {
                let driver = self.driver.clone();
                let path = path.clone();
                let archived = *archived;
                self.hub_ops.enqueue(
                    "set_archived",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            match driver.set_archived(path, archived).await {
                                result if result.worktree_retained.is_some() => {
                                    let wr = result.worktree_retained.unwrap();
                                    let h = hub.lock();
                                    h.send_to_client(
                                        client_key,
                                        ServerMessage::WorktreeRetained {
                                            path: wr.path,
                                            reason: wr.reason,
                                        },
                                    );
                                }
                                _ => {
                                    // Re-broadcast the session list
                                    let sessions = driver.list_sessions().await;
                                    let default_cwd = std::env::var("HOME").unwrap_or_default();
                                    let mut h = hub.lock();
                                    h.broadcast_session_list_with(sessions, default_cwd);
                                }
                            }
                        })
                    }),
                );
            }
            ClientMessage::RenameSession { path, name } => {
                if name.trim().is_empty() {
                    return;
                }
                let driver = self.driver.clone();
                let path = path.clone();
                let name = name.trim().to_string();
                self.hub_ops.enqueue(
                    "rename_session",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            driver.rename_session(path, name).await;
                            // Re-broadcast the session list
                            let sessions = driver.list_sessions().await;
                            let default_cwd = std::env::var("HOME").unwrap_or_default();
                            let mut h = hub.lock();
                            h.broadcast_session_list_with(sessions, default_cwd);
                        })
                    }),
                );
            }
            ClientMessage::CleanupWorktree { path, force } => {
                let driver = self.driver.clone();
                let path = path.clone();
                let force = force.unwrap_or(false);
                self.hub_ops.enqueue(
                    "cleanup_worktree",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let result = driver.cleanup_worktree(path, force).await;
                            if !result.removed {
                                let h = hub.lock();
                                h.send_to_client(
                                    client_key,
                                    ServerMessage::Error {
                                        message: format!(
                                            "worktree not removed: {}",
                                            result.reason.unwrap_or("unknown reason".into())
                                        ),
                                        kind: None,
                                    },
                                );
                            }
                            // Re-broadcast the session list either way
                            let sessions = driver.list_sessions().await;
                            let default_cwd = std::env::var("HOME").unwrap_or_default();
                            let mut h = hub.lock();
                            h.broadcast_session_list_with(sessions, default_cwd);
                        })
                    }),
                );
            }
            ClientMessage::DetachSession { path } => {
                let driver = self.driver.clone();
                let path = path.clone();
                self.hub_ops.enqueue(
                    "detach_session",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let result = driver.detach_session(path).await;
                            if let Err(msg) = result {
                                let h = hub.lock();
                                h.send_to_client(
                                    client_key,
                                    ServerMessage::Error {
                                        message: msg,
                                        kind: None,
                                    },
                                );
                            } else {
                                // Success: re-broadcast the session list so the
                                // UI reflects the now-detached (idle) session.
                                let sessions = driver.list_sessions().await;
                                let default_cwd = std::env::var("HOME").unwrap_or_default();
                                let mut h = hub.lock();
                                h.broadcast_session_list_with(sessions, default_cwd);
                            }
                        })
                    }),
                );
            }
            ClientMessage::ListCommands => {
                let driver = self.driver.clone();
                let focused = focused_id.clone();
                self.hub_ops.enqueue(
                    "list_commands",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let commands = driver.list_commands(focused).await;
                            let h = hub.lock();
                            h.send_to_client(client_key, ServerMessage::CommandList { commands });
                        })
                    }),
                );
            }
            ClientMessage::ListFacets => {
                let driver = self.driver.clone();
                let focused = focused_id.clone();
                self.hub_ops.enqueue(
                    "list_facets",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let facets = driver.list_facets(focused).await;
                            let h = hub.lock();
                            h.send_to_client(client_key, ServerMessage::FacetList { facets });
                        })
                    }),
                );
            }
            ClientMessage::FetchJobs => {
                let driver = self.driver.clone();
                let focused = focused_id.clone();
                self.hub_ops.enqueue(
                    "fetch_jobs",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let jobs = driver.list_jobs(focused).await;
                            let h = hub.lock();
                            h.send_to_client(client_key, ServerMessage::JobsList { jobs });
                        })
                    }),
                );
            }
            ClientMessage::DeleteTodo { id } => {
                let driver = self.driver.clone();
                let focused = focused_id.clone();
                let id = *id;
                self.hub_ops.enqueue(
                    "delete_todo",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            match driver.delete_todo(focused, id).await {
                                Ok(()) => {
                                    // The daemon emits SessionStateChanged { domains: ["todos"] }
                                    // after a delete, which triggers a FetchState → snapshot
                                    // refresh. No hub-side action needed — the todo list
                                    // updates through the event stream.
                                }
                                Err(TodoDeleteError::NotFound) => {
                                    let h = hub.lock();
                                    h.send_to_client(
                                        client_key,
                                        ServerMessage::Error {
                                            message: format!("Todo #{} not found", id),
                                            kind: None,
                                        },
                                    );
                                }
                                Err(TodoDeleteError::DependentsExist(deps)) => {
                                    let titles: Vec<&str> =
                                        deps.iter().map(|d| d.title.as_str()).collect();
                                    let h = hub.lock();
                                    h.send_to_client(
                                        client_key,
                                        ServerMessage::Error {
                                            message: format!(
                                                "Cannot delete todo #{}: {} todo(s) depend on it ({})",
                                                id,
                                                deps.len(),
                                                titles.join(", ")
                                            ),
                                            kind: None,
                                        },
                                    );
                                }
                                Err(TodoDeleteError::TurnInFlight) => {
                                    let h = hub.lock();
                                    h.send_to_client(
                                        client_key,
                                        ServerMessage::Error {
                                            message: format!(
                                                "Cannot delete todo #{}: a turn is in flight",
                                                id
                                            ),
                                            kind: None,
                                        },
                                    );
                                }
                                Err(TodoDeleteError::Other(msg)) => {
                                    let h = hub.lock();
                                    h.send_to_client(
                                        client_key,
                                        ServerMessage::Error {
                                            message: msg,
                                            kind: None,
                                        },
                                    );
                                }
                            }
                        })
                    }),
                );
            }
            ClientMessage::QueryFiles {
                query,
                cwd,
                include_ignored,
            } => {
                let driver = self.driver.clone();
                let focused = focused_id.clone();
                let query = query.clone();
                let cwd = cwd.clone();
                let include_ignored = include_ignored.unwrap_or(false);
                self.hub_ops.enqueue(
                    "query_files",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let files = driver
                                .list_files(query.clone(), focused, cwd, include_ignored)
                                .await;
                            let h = hub.lock();
                            h.send_to_client(
                                client_key,
                                ServerMessage::FileList {
                                    query,
                                    files,
                                    include_ignored: Some(include_ignored),
                                },
                            );
                        })
                    }),
                );
            }
            ClientMessage::QueryDir { path, request_id } => {
                let driver = self.driver.clone();
                let path = path.clone();
                let request_id = *request_id;
                self.hub_ops.enqueue(
                    "query_dir",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let listing = driver.list_dir(path.clone()).await;
                            let h = hub.lock();
                            h.send_to_client(
                                client_key,
                                ServerMessage::DirListing {
                                    listing,
                                    request_id,
                                },
                            );
                        })
                    }),
                );
            }
            ClientMessage::StatPath { path, request_id } => {
                let driver = self.driver.clone();
                let path = path.clone();
                let request_id = *request_id;
                self.hub_ops.enqueue(
                    "stat_path",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let stat = driver.stat_path(path.clone()).await;
                            let h = hub.lock();
                            h.send_to_client(
                                client_key,
                                ServerMessage::PathStat { stat, request_id },
                            );
                        })
                    }),
                );
            }
            ClientMessage::SetLoginShell { path } => {
                let shell = path
                    .as_ref()
                    .map(|p| p.trim())
                    .filter(|p| !p.is_empty())
                    .map(|s| s.to_string());
                if let Some(dir) = &self.data_dir {
                    let _ = crate::settings_store::write_pantoken_settings(
                        dir,
                        &crate::settings_store::PartialSettings {
                            login_shell: Some(shell),
                            background_model: None,
                            enabled_extensions: None,
                        },
                    );
                }
                self.broadcast(self.pantoken_settings_msg());
            }
            ClientMessage::SetBackgroundModel { spec } => {
                let model_spec = spec
                    .as_ref()
                    .map(|p| p.trim())
                    .filter(|p| !p.is_empty())
                    .map(|s| s.to_string());
                if let Some(dir) = &self.data_dir {
                    let _ = crate::settings_store::write_pantoken_settings(
                        dir,
                        &crate::settings_store::PartialSettings {
                            login_shell: None,
                            background_model: Some(model_spec),
                            enabled_extensions: None,
                        },
                    );
                }
                self.broadcast(self.pantoken_settings_msg());
            }
            ClientMessage::ApplyUpdate => {
                if self.update_sha.is_some() && !self.applying {
                    self.applying = true;
                    self.broadcast(self.update_status_msg());
                }
            }
            ClientMessage::ForceUpdate => {
                self.force_requested = true;
                if self.update_sha.is_some() && !self.applying {
                    self.applying = true;
                    self.broadcast(self.update_status_msg());
                }
            }
            ClientMessage::OpenDataDir => {
                let dir_str = self.data_dir.as_ref().map(|d| d.display().to_string());
                if let Some(dir_str) = dir_str {
                    // Open via the injectable seam so the failure path is
                    // deterministically testable; surface spawn failures to the
                    // client instead of silently discarding them (fail-loud).
                    if let Err(e) = (self.open_in_file_manager)(&dir_str) {
                        self.send_to_client(
                            client_key,
                            ServerMessage::Error {
                                message: format!("couldn't open the data directory: {e}"),
                                kind: None,
                            },
                        );
                    }
                } else {
                    self.send_to_client(
                        client_key,
                        ServerMessage::Error {
                            message: "data directory is not configured on this server".into(),
                            kind: None,
                        },
                    );
                }
            }
            _ => {
                // TrustResponse and any future variants — the TS hub has no
                // handler for these (trust is handled by the driver, not the hub).
            }
        }
    }

    /// Send a message to a specific client by key.
    pub fn send_to_client(&self, client_key: u64, msg: ServerMessage) {
        if let Some(conn) = self.clients.get(&client_key) {
            let _ = conn.send.try_send(msg);
        }
    }

    /// Broadcast a session list with pre-fetched data (avoids re-locking).
    fn broadcast_session_list_with(
        &mut self,
        sessions: Vec<pantoken_protocol::session_driver::SessionListEntry>,
        default_cwd: String,
    ) {
        for conn in self.clients.values() {
            let _ = conn.send.try_send(ServerMessage::SessionList {
                sessions: sessions.clone(),
                active_session_id: conn.focused_id.clone(),
                default_new_session_cwd: default_cwd.clone(),
            });
        }
        self.session_list_dirty = false;
    }

    // ── Prompt idempotency ────────────────────────────────────────────────

    /// Check the prompt idempotency ledger. If a result is already cached for
    /// this promptId, return it for replay. Otherwise return None — the caller
    /// runs the prompt and calls `cache_prompt_result` when done.
    ///
    /// Mirrors TS `acceptPrompt`: a retried promptId replays the cached result
    /// instead of re-running the prompt. The cache is capped at 2048 entries.
    fn check_prompt_idempotency(&self, prompt_id: &Option<String>) -> Option<ServerMessage> {
        let pid = prompt_id.as_ref()?;
        self.prompt_results.get(pid).cloned()
    }

    /// Cache a completed prompt result and evict the oldest entry if over cap.
    fn cache_prompt_result(&mut self, prompt_id: String, msg: ServerMessage) {
        const PROMPT_RESULT_CAP: usize = 2048;
        // If this pid is already cached (update), remove from order queue
        if self.prompt_results.contains_key(&prompt_id) {
            self.prompt_result_order.retain(|p| p != &prompt_id);
        }
        self.prompt_results.insert(prompt_id.clone(), msg);
        self.prompt_result_order.push_back(prompt_id);
        while self.prompt_result_order.len() > PROMPT_RESULT_CAP {
            if let Some(oldest) = self.prompt_result_order.pop_front() {
                self.prompt_results.remove(&oldest);
            }
        }
    }

    // ── Broadcast helpers ──────────────────────────────────────────────────

    pub async fn broadcast_session_list(&mut self) {
        let sessions = self.driver.list_sessions().await;
        let default_new_session_cwd = std::env::var("HOME").unwrap_or_default();
        for conn in self.clients.values() {
            let _ = conn.send.try_send(ServerMessage::SessionList {
                sessions: sessions.clone(),
                active_session_id: conn.focused_id.clone(),
                default_new_session_cwd: default_new_session_cwd.clone(),
            });
        }
        self.session_list_dirty = false;
    }

    pub async fn broadcast_model_list(&mut self) {
        let models = self.driver.list_models().await;
        let diagnostic = self.driver.model_catalog_diagnostic();
        self.available_models = models.clone();
        self.broadcast(ServerMessage::ModelList { models, diagnostic });
    }

    #[expect(
        dead_code,
        reason = "connect-time command list fan-out is incomplete until Phase 1 hub parity"
    )]
    async fn send_command_list(&self, client_key: u64) {
        let focused = self
            .clients
            .get(&client_key)
            .and_then(|c| c.focused_id.clone());
        let commands = self.driver.list_commands(focused).await;
        if let Some(conn) = self.clients.get(&client_key) {
            let _ = conn.send.try_send(ServerMessage::CommandList { commands });
        }
    }

    #[expect(
        dead_code,
        reason = "connect-time facet list fan-out is incomplete until Phase 1 hub parity"
    )]
    async fn send_facet_list(&self, client_key: u64) {
        let focused = self
            .clients
            .get(&client_key)
            .and_then(|c| c.focused_id.clone());
        let facets = self.driver.list_facets(focused).await;
        if let Some(conn) = self.clients.get(&client_key) {
            let _ = conn.send.try_send(ServerMessage::FacetList { facets });
        }
    }

    #[expect(
        dead_code,
        reason = "connect-time file index fan-out is incomplete until Phase 1 hub parity"
    )]
    async fn send_file_index(&self, client_key: u64) {
        let focused = self
            .clients
            .get(&client_key)
            .and_then(|c| c.focused_id.clone());
        let (files, truncated) = self.driver.list_file_index(focused).await;
        if let Some(conn) = self.clients.get(&client_key) {
            let _ = conn
                .send
                .try_send(ServerMessage::FileIndex { files, truncated });
        }
    }

    // ── liveTick / refreshUsage ────────────────────────────────────────────

    /// Start or stop the live-refresh interval based on whether there are running
    /// sessions + connected clients. Mirrors the TS hub's `syncLiveRefresh`.
    /// Returns true if a ticker should be started, false if it should stop.
    pub fn sync_live_refresh(&self) -> bool {
        !self.running.is_empty() && !self.clients.is_empty()
    }

    /// Enqueue the async follow-up list sends that the TS addClient fires after
    /// hello+seed: sessionList, modelList, commandList, facetList, fileIndex,
    /// modelDefaults. Mirrors the source order of the `void this.*()` calls in
    /// hub.ts; the single applier awaits and applies them FIFO.
    pub fn spawn_connect_lists(&self, client_key: u64) {
        let focused = self
            .clients
            .get(&client_key)
            .and_then(|c| c.focused_id.clone());

        let driver = self.driver.clone();
        let active_session_id = focused.clone();
        self.hub_ops.enqueue(
            "connect_session_list",
            Box::new(move |hub| {
                Box::pin(async move {
                    let sessions = driver.list_sessions().await;
                    let default_new_session_cwd = std::env::var("HOME").unwrap_or_default();
                    let h = hub.lock();
                    h.send_to_client(
                        client_key,
                        ServerMessage::SessionList {
                            sessions,
                            active_session_id,
                            default_new_session_cwd,
                        },
                    );
                })
            }),
        );

        let driver = self.driver.clone();
        self.hub_ops.enqueue(
            "connect_model_list",
            Box::new(move |hub| {
                Box::pin(async move {
                    let models = driver.list_models().await;
                    let diagnostic = driver.model_catalog_diagnostic();
                    let mut h = hub.lock();
                    h.available_models = models.clone();
                    h.broadcast(ServerMessage::ModelList { models, diagnostic });
                })
            }),
        );

        let driver = self.driver.clone();
        let focused_for_commands = focused.clone();
        self.hub_ops.enqueue(
            "connect_command_list",
            Box::new(move |hub| {
                Box::pin(async move {
                    let commands = driver.list_commands(focused_for_commands).await;
                    let h = hub.lock();
                    h.send_to_client(client_key, ServerMessage::CommandList { commands });
                })
            }),
        );

        let driver = self.driver.clone();
        let focused_for_facets = focused.clone();
        self.hub_ops.enqueue(
            "connect_facet_list",
            Box::new(move |hub| {
                Box::pin(async move {
                    let facets = driver.list_facets(focused_for_facets).await;
                    let h = hub.lock();
                    h.send_to_client(client_key, ServerMessage::FacetList { facets });
                })
            }),
        );

        let driver = self.driver.clone();
        let focused_for_files = focused.clone();
        self.hub_ops.enqueue(
            "connect_file_index",
            Box::new(move |hub| {
                Box::pin(async move {
                    let (files, truncated) = driver.list_file_index(focused_for_files).await;
                    let h = hub.lock();
                    h.send_to_client(client_key, ServerMessage::FileIndex { files, truncated });
                })
            }),
        );

        let driver = self.driver.clone();
        let focused_for_at_refs = focused.clone();
        self.hub_ops.enqueue(
            "connect_at_refs",
            Box::new(move |hub| {
                Box::pin(async move {
                    let refs = driver.list_at_refs(focused_for_at_refs).await;
                    let h = hub.lock();
                    h.send_to_client(client_key, ServerMessage::AtRefs { refs });
                })
            }),
        );

        let driver = self.driver.clone();
        self.hub_ops.enqueue(
            "connect_model_defaults",
            Box::new(move |hub| {
                Box::pin(async move {
                    let defaults = driver.get_model_defaults().await;
                    let h = hub.lock();
                    h.broadcast(ServerMessage::ModelDefaults { defaults });
                })
            }),
        );
    }

    /// One live-refresh pass: fresh session list + context usage.
    pub async fn live_tick(&mut self) {
        if self.session_list_dirty {
            self.broadcast_session_list().await;
        }
        self.refresh_usage();
    }

    /// Whether the session list needs rebroadcast (title change, etc.).
    /// Used by the periodic ticker to decide whether to run `live_tick` even
    /// when no sessions are running (e.g. an inferred title landing while idle).
    pub fn session_list_dirty(&self) -> bool {
        self.session_list_dirty
    }

    /// Enqueue a live-refresh pass: rebroadcast the session list if dirty, then
    /// refresh usage for running sessions. Called by the periodic ticker in
    /// main.rs. Follows the same hub_ops pattern as `spawn_connect_lists` and
    /// `switch_to` — fetches `list_sessions().await` BEFORE acquiring the lock,
    /// then calls the sync `broadcast_session_list_with()` under it.
    /// (parking_lot::Mutex is blocking — never hold its guard across .await.)
    pub fn enqueue_live_refresh(&self) {
        let dirty = self.session_list_dirty;
        let refresh_usage = self.sync_live_refresh();
        if !dirty && !refresh_usage {
            return;
        }
        let driver = self.driver.clone();
        self.hub_ops.enqueue(
            "live_refresh",
            Box::new(move |hub| {
                Box::pin(async move {
                    if dirty {
                        let sessions = driver.list_sessions().await;
                        let default_cwd = std::env::var("HOME").unwrap_or_default();
                        let mut h = hub.lock();
                        h.broadcast_session_list_with(sessions, default_cwd);
                    }
                    if refresh_usage {
                        let mut h = hub.lock();
                        h.refresh_usage();
                    }
                })
            }),
        );
    }

    pub fn refresh_usage(&mut self) {
        let running_sessions: Vec<SessionId> = self
            .journals
            .keys()
            .filter(|sid| self.running.contains(*sid))
            .cloned()
            .collect();

        for sid in running_sessions {
            let usage = self.driver.get_usage(Some(sid.clone()));
            let Some(usage) = usage else { continue };
            if self
                .last_usage_emitted
                .get(&sid)
                .map(|last| last == &usage)
                .unwrap_or(false)
            {
                continue;
            }
            self.last_usage_emitted.insert(sid.clone(), usage.clone());

            // Get the session ref from the journal's first event
            let session_ref = self
                .journals
                .get(&sid)
                .and_then(|j| {
                    let (_, _, events) = build_seed(j);
                    events.first().map(|e| e.session_ref().clone())
                })
                .unwrap_or(SessionRef {
                    workspace_id: sid.clone(),
                    session_id: sid.clone(),
                });

            let ev = SessionDriverEvent::UsageUpdated {
                base: SessionEventBase {
                    session_ref,
                    timestamp: now_iso(),
                    run_id: None,
                },
                usage,
            };
            self.ingest(&ev);
        }
    }

    /// Sync the live-refresh ticker — should be called when running set or
    /// client count changes. In the Rust port, the ticker is managed by the
    /// server's main loop, not inside the hub.
    pub fn needs_live_refresh(&self) -> bool {
        !self.running.is_empty() && !self.clients.is_empty()
    }

    /// Whether the hub has a journal for a session.
    fn has_journal(&self, sid: &SessionId) -> bool {
        self.journals.contains_key(sid)
    }

    /// Set/replace a journal for a session.
    fn set_journal(&mut self, sid: SessionId, journal: SessionJournal) {
        self.journals.insert(sid, journal);
    }

    /// Set a client's focused session.
    fn set_client_focus(&mut self, client_key: u64, sid: SessionId) {
        if let Some(conn) = self.clients.get_mut(&client_key) {
            conn.focused_id = Some(sid);
        }
    }

    /// Build the pantoken-local-settings message: persisted settings + login-env
    /// status + background-model warning.
    fn pantoken_settings_msg(&self) -> ServerMessage {
        let settings = self
            .data_dir
            .as_ref()
            .map(|dir| crate::settings_store::read_pantoken_settings(dir))
            .unwrap_or_default();
        // Login-env status comes from the active driver (the live PolytokenDriver
        // captures it at spawn; mock/default drivers report `{ok:false}`).
        let env = self.driver.login_env_status();
        ServerMessage::PantokenSettings {
            // Resolve the background-model warning from the cached model list
            // (ports TS `pantokenSettingsMsg` → `resolveBackgroundModel`,
            // hub.ts:1176). An empty pre-list cache suppresses the warning until
            // the next modelList broadcast (the TS hub re-broadcasts settings
            // after listModels for exactly this reason — see broadcastModelList).
            background_model_warning: crate::background_model::resolve_background_model(
                settings.background_model.as_deref(),
                &self.available_models,
            )
            .warning,
            settings,
            env,
            pending_restart: false,
        }
    }

    /// Fold a swap's seed into a scratch state to learn the authoritative session id,
    /// accumulating running/attention changes on the way.
    fn fold_swap_seed(&mut self, seed: &[SessionDriverEvent]) -> (bool, Option<SessionId>) {
        let mut st = initial_session_state();
        let mut meta_changed = false;

        for e in seed {
            fold_event(&mut st, e);
            let e_sid = e.session_ref().session_id.clone();
            meta_changed = self.track_running(&e_sid, e) || meta_changed;
            meta_changed = self.track_attention(&e_sid, e) || meta_changed;
        }
        let sid: Option<SessionId> = st
            .session_ref
            .as_ref()
            .map(|r| r.session_id.clone())
            .or_else(|| seed.first().map(|e| e.session_ref().session_id.clone()));
        (meta_changed, sid)
    }
}

// ── switch_to free function ──────────────────────────────────────────────

/// A boxed, pinned, Send future — the return type of switch_to.
type SwitchFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Option<SessionId>> + Send + 'static>>;

/// Classify a raw session-switch error into a client-facing `{message, kind}`.
/// Ports TS `classifySwitchError` (`server/src/hub.ts:129-184`): recognizes the
/// daemon-failed, startup-timeout, lease-conflict (409), connection-refused, and
/// unresolved-path patterns, prettifying each with `kind: "session-switch"`; an
/// unrecognized error falls back to a generic banner with no `kind`.
fn classify_switch_error(raw: &str) -> (String, Option<String>) {
    let session_switch = || Some("session-switch".to_string());
    // The session's project directory no longer exists on disk (docs/TODO.md:
    // restoring a session run in a now-deleted directory "can't ever
    // succeed"). Permanent — deliberately does NOT match the client's
    // LEASE_CONFLICT_RE, so no "Retry" action is offered for it (see
    // store.svelte.ts), only the plain dismissible toast.
    if let Some((_, tail)) = raw.split_once("session directory no longer exists:") {
        let dir = tail.trim();
        return (
            format!(
                "Couldn't restore this session — its directory no longer exists ({dir}). Move the project back to that path, or archive this session."
            ),
            session_switch(),
        );
    }
    // Daemon failed to start (startup.json state:"failed") — the message already
    // names the config/parse error; surface it plainly (TS captures the tail).
    if let Some((_, tail)) = raw.split_once("polytoken daemon failed to start:") {
        let detail = tail.trim().split(['\n', '\r']).next().unwrap_or("").trim();
        return (
            format!(
                "Couldn't open this session — the daemon failed to start ({}). Try again, or open it in the TUI to diagnose.",
                detail
            ),
            session_switch(),
        );
    }
    // The daemon process exited before it ever wrote a ready startup.json
    // (e.g. a CLI parse error) — distinct from the state:"failed" case above
    // (which the daemon reported cleanly) but equally not worth retrying
    // as-is.
    if raw.contains("polytoken daemon exited early") {
        return (
            "Couldn't open this session — the daemon exited immediately. Try again, or open it in the TUI to diagnose.".into(),
            session_switch(),
        );
    }
    // Daemon didn't bind its port in time (spawn or health timeout).
    if raw.contains("did not become ready within") || raw.contains("did not become healthy within")
    {
        return (
            "Couldn't open this session — the daemon took too long to start. Try again.".into(),
            session_switch(),
        );
    }
    // Lease conflict (409) — claimLease already formatted a readable message.
    if raw.contains("another TUI is attached") || raw.contains("lease claim failed (409)") {
        let message = if raw.contains("another TUI is attached") {
            raw.to_string()
        } else {
            "This session is open in the TUI. Detach it there (/detach) or wait ~30s for its lease to lapse.".into()
        };
        return (message, session_switch());
    }
    // Connection refused / timed out reaching the daemon.
    if raw.contains("lease claim failed (0)")
        || raw.contains("request timed out")
        || raw.contains("fetch failed")
        || raw.contains("ECONNREFUSED")
        || raw.contains("daemon health probe failed")
    {
        return (
            "Couldn't reach the session daemon. Try again — if it persists, the daemon may be wedged.".into(),
            session_switch(),
        );
    }
    // 401 — auth failure (daemon 0.5.0+ bearer token mismatch). The token is
    // read from the credential file; a 401 means the file is stale, missing,
    // or the daemon is a different version than expected.
    if raw.contains("lease claim failed (401)") || raw.contains("unauthorized") {
        return (
            "Couldn't authenticate to the session daemon. The daemon may be a different version than expected.".into(),
            session_switch(),
        );
    }
    // Could not resolve session id from path.
    if raw.contains("could not resolve session id from path") {
        return (
            "Couldn't open this session — its path wasn't recognized.".into(),
            session_switch(),
        );
    }
    // Fallback: unknown error → keep the generic banner.
    (format!("session switch failed: {raw}"), None)
}

/// The atomic session-swap state machine. Implements single-flight per connection:
/// if a swap is already in-flight on this connection, the latest request coalesces
/// into `pending_switch` (depth 1, latest wins) and runs when the in-flight one
/// finishes. The caller gets a oneshot that resolves with the eventual session id.
///
/// `swap`: a closure that fetches the seed events (driver call).
/// `reseed`: restart the journal even if the session is already live.
/// `retry_on_raced_events`: re-run the swap if live events raced the seed fetch.
fn switch_to(
    hub: Arc<Mutex<SessionHub>>,
    client_key: u64,
    swap: Box<dyn FnOnce(Arc<Mutex<SessionHub>>) -> SwapFuture + Send>,
    reseed: bool,
    retry_on_raced_events: bool,
) -> SwitchFuture {
    Box::pin(async move {
        // ── Single-flight check: if a swap is already in-flight on this connection,
        // coalesce this one as the latest pending (depth 1, latest wins). Resolve
        // any previously-queued request with None so its awaiter unblocks.
        // Dormant under the single-applier model: switch calls are serialized, so
        // this TS-mirroring insurance should not be load-bearing (or deadlocking).
        let mut swap = Some(swap);
        let pending_rx: Option<tokio::sync::oneshot::Receiver<Option<SessionId>>> = {
            let mut h = hub.lock();
            let conn = h.clients.get_mut(&client_key);
            if let Some(conn) = conn {
                if conn.switch_in_flight {
                    // Supersede a previously-queued request
                    if let Some(prev) = conn.pending_switch.take() {
                        let _ = prev.resolve.send(None);
                    }
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    conn.pending_switch = Some(PendingSwitch {
                        swap: swap.take().unwrap(),
                        reseed,
                        retry_on_raced_events,
                        resolve: tx,
                    });
                    Some(rx)
                } else {
                    conn.switch_in_flight = true;
                    None
                }
            } else {
                None
            }
        }; // guard dropped here
        if let Some(rx) = pending_rx {
            return rx.await.ok().flatten();
        }

        // ── Run the swap. We wrap the fetch in swaps_in_flight++/-- so on_event
        // buffers live events for journal-less sessions during the fetch.
        hub.lock().swaps_in_flight += 1;
        let swap = swap.take().unwrap();
        let seed_result = swap(hub.clone()).await;
        {
            let mut h = hub.lock();
            h.swaps_in_flight = h.swaps_in_flight.saturating_sub(1);
        }

        // A swap failure (e.g. the mock's one-shot `failsession` 409 lease
        // conflict) surfaces as a client-visible `Error` — ports TS `switchTo`'s
        // catch → `classifySwitchError` (hub.ts:1333-1341). A newer switch queued
        // while this one was warming suppresses the error (the operator already
        // moved on) — mirrors TS `if (!conn.pendingSwitch)`.
        let seed: Option<Vec<SessionDriverEvent>> = match seed_result {
            Ok(seed) => Some(seed),
            Err(raw) => {
                let pending = {
                    let h = hub.lock();
                    h.clients
                        .get(&client_key)
                        .map(|c| c.pending_switch.is_some())
                        .unwrap_or(false)
                };
                if !pending {
                    let (message, kind) = classify_switch_error(&raw);
                    let h = hub.lock();
                    h.send_to_client(client_key, ServerMessage::Error { message, kind });
                }
                None
            }
        };

        // ── Fold the seed + set up journal/focus. On swap failure, fall through
        // to the cleanup below so queued switches are never stranded; this mirrors
        // TS `switchTo`'s `try/finally`.
        let sid = if let Some(seed) = seed {
            finish_switch(&hub, client_key, seed, reseed, retry_on_raced_events).await
        } else {
            None
        };

        // ── Finally: clear switch_in_flight and dispatch any queued swap.
        let queued = {
            let mut h = hub.lock();
            let conn = h.clients.get_mut(&client_key);
            if let Some(conn) = conn {
                conn.switch_in_flight = false;
                conn.pending_switch.take()
            } else {
                None
            }
        };
        if let Some(next) = queued {
            let PendingSwitch {
                swap,
                reseed,
                retry_on_raced_events,
                resolve,
            } = next;
            let sid = switch_to(hub.clone(), client_key, swap, reseed, retry_on_raced_events).await;
            let _ = resolve.send(sid);
        }

        sid
    })
}

/// The post-fetch half of switch_to: fold the seed, set up the journal, move
/// focus, reseed co-viewers, and spawn the session-list/commands/facets/files
/// refresh. Returns the session id (or None on failure).
async fn finish_switch(
    hub: &Arc<Mutex<SessionHub>>,
    client_key: u64,
    seed: Vec<SessionDriverEvent>,
    reseed: bool,
    _retry_on_raced_events: bool,
) -> Option<SessionId> {
    // Fold the seed to get the session id + track running/attention
    let (meta_changed, sid) = {
        let mut h = hub.lock();
        if seed.is_empty() {
            h.send_to_client(
                client_key,
                ServerMessage::Error {
                    message: "session switch returned no session".into(),
                    kind: None,
                },
            );
            return None;
        }
        h.fold_swap_seed(&seed)
    };

    let Some(sid) = sid else {
        let h = hub.lock();
        h.send_to_client(
            client_key,
            ServerMessage::Error {
                message: "session switch returned no session".into(),
                kind: None,
            },
        );
        return None;
    };

    // Start/restart the journal from the authoritative seed
    let superseded = {
        let mut h = hub.lock();
        if reseed || !h.has_journal(&sid) {
            h.drop_pending(&sid);
            let epoch = h.next_epoch();
            h.set_journal(sid.clone(), create_journal(epoch, &seed));
            if meta_changed {
                h.broadcast_session_status();
            }
        }
        // S2 fix: if a newer switch queued up while this one was warming, skip
        // the focus-move + seed-send — the queued switch will send the
        // authoritative view. (Mirrors TS `if (conn.pendingSwitch) return sid;`)
        let superseded = h
            .clients
            .get(&client_key)
            .map(|c| c.pending_switch.is_some())
            .unwrap_or(false);
        if !superseded {
            h.set_client_focus(client_key, sid.clone());
            let msg = h.seed_msg(Some(&sid));
            h.send_to_client(client_key, msg);
        }
        superseded
    };

    // S2: if superseded by a queued switch, skip co-viewer reseed + refresh
    // (the queued switch will handle all of this when it runs)
    if superseded {
        return Some(sid);
    }

    // C6 fix: on a reseed (branch/reload), re-seed ALL viewers focused on this
    // session EXCEPT the requester (who was already seeded above) — a second
    // client viewing the same session needs the fresh seed to recover from its
    // now-wedged journal.
    if reseed {
        let msg = {
            let h = hub.lock();
            h.seed_msg(Some(&sid))
        };
        // Re-seed co-viewers (excluding the requester, already seeded above)
        let viewers: Vec<mpsc::Sender<ServerMessage>> = {
            let h = hub.lock();
            h.clients
                .iter()
                .filter(|(k, _)| **k != client_key)
                .filter(|(_, c)| c.focused_id.as_ref() == Some(&sid))
                .map(|(_, c)| c.send.clone())
                .collect()
        };
        for send in viewers {
            let _ = send.try_send(msg.clone());
        }
    }

    // Enqueue async work: session list, commands, facets, file index.
    // C7 fix: also send facet list + file index (TS sends all four after a swap).
    let hub_ops = { hub.lock().hub_ops.clone() };
    let driver = { hub.lock().driver.clone() };
    hub_ops.enqueue(
        "switch_session_list",
        Box::new(move |hub| {
            Box::pin(async move {
                let sessions = driver.list_sessions().await;
                let default_cwd = std::env::var("HOME").unwrap_or_default();
                let mut h = hub.lock();
                h.broadcast_session_list_with(sessions, default_cwd);
            })
        }),
    );

    let hub_ops = { hub.lock().hub_ops.clone() };
    let driver = { hub.lock().driver.clone() };
    let focused = Some(sid.clone());
    hub_ops.enqueue(
        "switch_command_list",
        Box::new(move |hub| {
            Box::pin(async move {
                let commands = driver.list_commands(focused).await;
                let h = hub.lock();
                h.send_to_client(client_key, ServerMessage::CommandList { commands });
            })
        }),
    );

    // C7: facet list
    let hub_ops = { hub.lock().hub_ops.clone() };
    let driver = { hub.lock().driver.clone() };
    let focused = Some(sid.clone());
    hub_ops.enqueue(
        "switch_facet_list",
        Box::new(move |hub| {
            Box::pin(async move {
                let facets = driver.list_facets(focused).await;
                let h = hub.lock();
                h.send_to_client(client_key, ServerMessage::FacetList { facets });
            })
        }),
    );

    // C7: file index (session-scoped file tree, NOT the search variant)
    let hub_ops = { hub.lock().hub_ops.clone() };
    let driver = { hub.lock().driver.clone() };
    let focused = Some(sid.clone());
    hub_ops.enqueue(
        "switch_file_index",
        Box::new(move |hub| {
            Box::pin(async move {
                let (files, truncated) = driver.list_file_index(focused).await;
                let h = hub.lock();
                h.send_to_client(client_key, ServerMessage::FileIndex { files, truncated });
            })
        }),
    );

    // atRefs (skills/subagents): session/cwd-scoped like file index, so
    // re-pushed on every switch.
    let hub_ops = { hub.lock().hub_ops.clone() };
    let driver = { hub.lock().driver.clone() };
    let focused = Some(sid.clone());
    hub_ops.enqueue(
        "switch_at_refs",
        Box::new(move |hub| {
            Box::pin(async move {
                let refs = driver.list_at_refs(focused).await;
                let h = hub.lock();
                h.send_to_client(client_key, ServerMessage::AtRefs { refs });
            })
        }),
    );

    // Re-broadcast model defaults so the draft view picks up the daemon's
    // config_default permission mode once a warm daemon is available. On a
    // cold start, the connect-time ModelDefaults had default_permission_monitor
    // = None; after this session switch warmed a daemon, the re-fetch discovers
    // the real default. The client's reseedDraftFromDefaults fills undefined
    // draft fields, so an open draft updates without clobbering an explicit pick.
    let hub_ops = { hub.lock().hub_ops.clone() };
    let driver = { hub.lock().driver.clone() };
    hub_ops.enqueue(
        "switch_model_defaults",
        Box::new(move |hub| {
            Box::pin(async move {
                let defaults = driver.get_model_defaults().await;
                let h = hub.lock();
                h.broadcast(ServerMessage::ModelDefaults { defaults });
            })
        }),
    );

    Some(sid)
}

// ── Free functions (port of hub.ts helpers) ─────────────────────────────

/// Coerce a caught value into a human-readable string.
pub fn err_msg(e: &dyn std::error::Error) -> String {
    e.to_string()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_iso() -> String {
    // Simple ISO-8601 timestamp. The TS version uses `new Date().toISOString()`.
    // We don't need exact format parity for internal usage events — the
    // timestamp is informational, not compared by the fold.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}ms", now.as_millis())
}

fn clipped(value: &str, max: usize) -> String {
    let one_line: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.len() > max {
        format!("{}…", &one_line[..max.saturating_sub(1)])
    } else {
        one_line
    }
}

/// Generate a human-readable activity string for a tool event.
fn tool_activity(ev: &SessionDriverEvent) -> String {
    if let E::ToolStarted {
        tool_name,
        input,
        label,
        description,
        ..
    } = ev
    {
        let name = tool_name.to_lowercase();
        let path = input_string(input, &["path", "filePath", "file_path"]);
        if name.contains("read") {
            return path
                .map(|p| format!("Reading {p}"))
                .unwrap_or_else(|| "Reading files".into());
        }
        if name.contains("edit") || name.contains("write") {
            return path
                .map(|p| format!("Editing {p}"))
                .unwrap_or_else(|| "Editing files".into());
        }
        if name.contains("search") || name.contains("grep") || name == "rg" {
            return "Searching the workspace".into();
        }
        if name == "bash" || name == "shell" || name == "exec" {
            let command = input_string(input, &["command", "cmd"]);
            return command
                .map(|c| format!("Running {c}"))
                .unwrap_or_else(|| "Running a command".into());
        }
        return clipped(
            label
                .as_deref()
                .or(description.as_deref())
                .unwrap_or(tool_name),
            72,
        );
    }
    "Working".into()
}

fn input_string(input: &Option<serde_json::Value>, keys: &[&str]) -> Option<String> {
    let obj = input.as_ref()?.as_object()?;
    for key in keys {
        if let Some(value) = obj.get(*key) {
            if let Some(s) = value.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return Some(clipped(trimmed, 72));
                }
            }
        }
    }
    None
}

fn request_title(request: &HostUiRequest) -> String {
    if let Some(title) = request.title() {
        if !title.is_empty() {
            return clipped(title, 72);
        }
    }
    if let Some(msg) = request.message() {
        if !msg.is_empty() {
            return clipped(msg, 72);
        }
    }
    if request.kind() == "qna" {
        "Questions need answers".into()
    } else {
        "Waiting on you".into()
    }
}

/// Extract the request_id from a HostUiResponse (all variants carry it).
fn response_request_id(response: &HostUiResponse) -> &str {
    match response {
        HostUiResponse::Value { request_id, .. } => request_id,
        HostUiResponse::Confirmed { request_id, .. } => request_id,
        HostUiResponse::Answers { request_id, .. } => request_id,
        HostUiResponse::Cancelled { request_id, .. } => request_id,
    }
}

// ── Trait extensions for ergonomic access to SessionDriverEvent fields ───

/// Helper trait to access common fields on SessionDriverEvent without
/// destructuring every variant.
trait SessionDriverEventExt {
    #[expect(
        dead_code,
        reason = "extension helpers are retained for parity with TS event access patterns during Phase 1 hub work"
    )]
    fn session_ref(&self) -> &SessionRef;
    #[expect(
        dead_code,
        reason = "extension helpers are retained for parity with TS event access patterns during Phase 1 hub work"
    )]
    fn timestamp(&self) -> &str;
    fn type_discriminator(&self) -> String;
    fn snapshot_status(&self) -> Option<SessionStatus>;
    fn snapshot_title(&self) -> Option<String>;
    fn assistant_delta_channel(&self) -> Option<String>;
    fn error_message(&self) -> Option<String>;
}

impl SessionDriverEventExt for SessionDriverEvent {
    fn session_ref(&self) -> &SessionRef {
        match self {
            E::SessionOpened { base, .. } => &base.session_ref,
            E::SessionUpdated { base, .. } => &base.session_ref,
            E::SessionClosed { base, .. } => &base.session_ref,
            E::AssistantDelta { base, .. } => &base.session_ref,
            E::ToolStarted { base, .. } => &base.session_ref,
            E::ToolUpdated { base, .. } => &base.session_ref,
            E::ToolFinished { base, .. } => &base.session_ref,
            E::UserMessage { base, .. } => &base.session_ref,
            E::RunCompleted { base, .. } => &base.session_ref,
            E::RunFailed { base, .. } => &base.session_ref,
            E::UsageUpdated { base, .. } => &base.session_ref,
            E::HostUiRequest { base, .. } => &base.session_ref,
            E::HostUiResolved { base, .. } => &base.session_ref,
            E::QueueUpdated { base, .. } => &base.session_ref,
            E::QueuedMessageStarted { base, .. } => &base.session_ref,
            E::CustomMessage { base, .. } => &base.session_ref,
            E::ExtensionCompatibilityIssue { base, .. } => &base.session_ref,
            E::SessionReset { base, .. } => &base.session_ref,
        }
    }

    fn timestamp(&self) -> &str {
        match self {
            E::SessionOpened { base, .. } => &base.timestamp,
            E::SessionUpdated { base, .. } => &base.timestamp,
            E::SessionClosed { base, .. } => &base.timestamp,
            E::AssistantDelta { base, .. } => &base.timestamp,
            E::ToolStarted { base, .. } => &base.timestamp,
            E::ToolUpdated { base, .. } => &base.timestamp,
            E::ToolFinished { base, .. } => &base.timestamp,
            E::UserMessage { base, .. } => &base.timestamp,
            E::RunCompleted { base, .. } => &base.timestamp,
            E::RunFailed { base, .. } => &base.timestamp,
            E::UsageUpdated { base, .. } => &base.timestamp,
            E::HostUiRequest { base, .. } => &base.timestamp,
            E::HostUiResolved { base, .. } => &base.timestamp,
            E::QueueUpdated { base, .. } => &base.timestamp,
            E::QueuedMessageStarted { base, .. } => &base.timestamp,
            E::CustomMessage { base, .. } => &base.timestamp,
            E::ExtensionCompatibilityIssue { base, .. } => &base.timestamp,
            E::SessionReset { base, .. } => &base.timestamp,
        }
    }

    fn type_discriminator(&self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| {
                v.get("type")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default()
    }

    fn snapshot_status(&self) -> Option<SessionStatus> {
        match self {
            E::SessionOpened { snapshot, .. }
            | E::SessionUpdated { snapshot, .. }
            | E::RunCompleted { snapshot, .. } => Some(snapshot.status),
            _ => None,
        }
    }

    fn snapshot_title(&self) -> Option<String> {
        match self {
            E::SessionOpened { snapshot, .. }
            | E::SessionUpdated { snapshot, .. }
            | E::RunCompleted { snapshot, .. } => Some(snapshot.title.clone()),
            _ => None,
        }
    }

    fn assistant_delta_channel(&self) -> Option<String> {
        match self {
            E::AssistantDelta { channel, .. } => channel.as_ref().map(|c| {
                serde_json::to_value(c)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_default()
            }),
            _ => None,
        }
    }

    fn error_message(&self) -> Option<String> {
        match self {
            E::RunFailed { error, .. } => Some(error.message.clone()),
            _ => None,
        }
    }
}

/// Helper trait for accessing HostUiRequest fields.
trait HostUiRequestExt {
    fn kind(&self) -> &str;
    fn request_id(&self) -> &str;
    fn title(&self) -> Option<&str>;
    fn message(&self) -> Option<&str>;
}

impl HostUiRequestExt for HostUiRequest {
    fn kind(&self) -> &str {
        match self {
            HostUiRequest::Confirm { .. } => "confirm",
            HostUiRequest::Select { .. } => "select",
            HostUiRequest::Input { .. } => "input",
            HostUiRequest::Editor { .. } => "editor",
            HostUiRequest::Qna { .. } => "qna",
            HostUiRequest::Permission { .. } => "permission",
            HostUiRequest::Plan { .. } => "planHandoff",
            HostUiRequest::Notify { .. } => "notify",
            HostUiRequest::Status { .. } => "status",
            HostUiRequest::Widget { .. } => "widget",
            HostUiRequest::Title { .. } => "title",
            HostUiRequest::EditorText { .. } => "editorText",
            HostUiRequest::Reset { .. } => "reset",
        }
    }

    fn request_id(&self) -> &str {
        match self {
            HostUiRequest::Confirm { request_id, .. } => request_id,
            HostUiRequest::Select { request_id, .. } => request_id,
            HostUiRequest::Input { request_id, .. } => request_id,
            HostUiRequest::Editor { request_id, .. } => request_id,
            HostUiRequest::Qna { request_id, .. } => request_id,
            HostUiRequest::Permission { request_id, .. } => request_id,
            HostUiRequest::Plan { request_id, .. } => request_id,
            HostUiRequest::Notify { request_id, .. } => request_id,
            HostUiRequest::Status { request_id, .. } => request_id,
            HostUiRequest::Widget { request_id, .. } => request_id,
            HostUiRequest::Title { request_id, .. } => request_id,
            HostUiRequest::EditorText { request_id, .. } => request_id,
            HostUiRequest::Reset { request_id, .. } => request_id,
        }
    }

    fn title(&self) -> Option<&str> {
        match self {
            HostUiRequest::Confirm { title, .. } => Some(title),
            HostUiRequest::Input { title, .. } => Some(title),
            HostUiRequest::Select { title, .. } => Some(title),
            HostUiRequest::Editor { title, .. } => Some(title),
            HostUiRequest::Qna { title, .. } => title.as_deref(),
            HostUiRequest::Permission { title, .. } => Some(title),
            HostUiRequest::Plan { title, .. } => Some(title),
            HostUiRequest::Title { title, .. } => Some(title),
            _ => None,
        }
    }

    fn message(&self) -> Option<&str> {
        match self {
            HostUiRequest::Confirm { message, .. } => Some(message),
            HostUiRequest::Notify { message, .. } => Some(message),
            _ => None,
        }
    }
}

#[cfg(test)]
mod hub_models_tests {
    use super::*;
    use crate::mock_driver::{GREETING_PROMPT, MockDriver, session_ref_for, ts};
    use pantoken_protocol::session_driver::{
        SessionConfig, SessionEventBase, SessionMessageDeliveryMode,
    };
    use pantoken_protocol::state::TranscriptItem;
    use std::sync::Arc;
    use tokio::time::{Duration, timeout};

    fn test_hub() -> (Arc<MockDriver>, Arc<Mutex<SessionHub>>, HubOpReceiver) {
        let driver = Arc::new(MockDriver::new());
        let (tx, rx) = hub_op_channel();
        let hub = SessionHub::new(
            driver.clone(),
            tx,
            None,
            250,
            "test-server".into(),
            None,
            "test-sha".into(),
            10,
        );
        let hub_for_events = hub.clone();
        driver.subscribe(Box::new(move |ev| hub_for_events.lock().on_event(ev)));
        (driver, hub, rx)
    }

    #[tokio::test]
    async fn pantoken_settings_defaults_login_env_when_unsupported() {
        let (_driver, hub, _ops) = test_hub();
        match hub.lock().pantoken_settings_msg() {
            ServerMessage::PantokenSettings { env, .. } => {
                assert!(!env.ok, "default login-env status should report ok:false");
                assert_eq!(env.active_shell, None);
                assert_eq!(env.detail, None);
            }
            other => panic!("expected PantokenSettings, got {other:?}"),
        }
    }

    #[test]
    fn pantoken_settings_reports_driver_login_env() {
        let driver: Arc<dyn PantokenDriver> =
            Arc::new(crate::stub_driver::StubDriver::new().with_login_env_status(
                pantoken_protocol::wire::LoginEnvStatus {
                    active_shell: Some("zsh".into()),
                    ok: true,
                    detail: Some("captured 42 vars".into()),
                },
            ));
        let (tx, _rx) = hub_op_channel();
        let hub = SessionHub::new(
            driver,
            tx,
            None,
            250,
            "test-server".into(),
            None,
            "test-sha".into(),
            10,
        );
        match hub.lock().pantoken_settings_msg() {
            ServerMessage::PantokenSettings { env, .. } => {
                assert_eq!(env.active_shell.as_deref(), Some("zsh"));
                assert!(env.ok);
                assert_eq!(env.detail.as_deref(), Some("captured 42 vars"));
            }
            other => panic!("expected PantokenSettings, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn open_data_dir_surfaces_spawn_failure() {
        let driver: Arc<dyn PantokenDriver> = Arc::new(MockDriver::new());
        let (tx, _ops) = hub_op_channel();
        let tmp = tempfile::tempdir().expect("tempdir");
        let hub = SessionHub::new(
            driver,
            tx,
            None,
            250,
            "test-server".into(),
            Some(tmp.path().to_path_buf()),
            "test-sha".into(),
            10,
        );
        hub.lock().set_open_in_file_manager(|_| Err("boom".into()));

        let (client_key, _tx2, mut rx) = hub.lock().add_client(None);
        hub.lock()
            .handle_client(client_key, ClientMessage::OpenDataDir);

        let msg = drain_until(&mut rx, |m| matches!(m, ServerMessage::Error { .. })).await;
        match msg {
            ServerMessage::Error { message, .. } => assert!(
                message.starts_with("couldn't open the data directory:"),
                "unexpected error message: {message}"
            ),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn abort_failure_surfaces_as_a_correlated_result() {
        let driver: Arc<dyn PantokenDriver> = Arc::new(
            crate::stub_driver::StubDriver::new().with_abort_error("daemon did not receive stop"),
        );
        let (tx, _ops) = hub_op_channel();
        let hub = SessionHub::new(
            driver,
            tx,
            None,
            250,
            "test-server".into(),
            None,
            "test-sha".into(),
            10,
        );

        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock().handle_client(
            client_key,
            ClientMessage::Abort {
                request_id: Some("stop-1".into()),
                session_id: None,
            },
        );

        let msg = drain_until(&mut rx, |m| matches!(m, ServerMessage::AbortResult { .. })).await;
        match msg {
            ServerMessage::AbortResult {
                request_id,
                accepted,
                error,
            } => {
                assert_eq!(request_id.as_deref(), Some("stop-1"));
                assert!(!accepted);
                assert_eq!(error.as_deref(), Some("daemon did not receive stop"));
            }
            other => panic!("expected AbortResult, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn open_data_dir_errors_when_unconfigured() {
        let (_driver, hub, _ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock()
            .handle_client(client_key, ClientMessage::OpenDataDir);

        let msg = drain_until(&mut rx, |m| matches!(m, ServerMessage::Error { .. })).await;
        match msg {
            ServerMessage::Error { message, .. } => {
                assert_eq!(message, "data directory is not configured on this server")
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// Heartbeat: a client `Ping` gets an immediate `Pong` reply, so the ws layer's
    /// watchdog sees inbound traffic and knows the transport is still alive.
    #[tokio::test]
    async fn ping_replies_with_pong() {
        let (_driver, hub, _ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock().handle_client(client_key, ClientMessage::Ping);

        let msg = drain_until(&mut rx, |m| matches!(m, ServerMessage::Pong)).await;
        assert!(matches!(msg, ServerMessage::Pong));
    }

    async fn drain_one(rx: &mut mpsc::Receiver<ServerMessage>) -> ServerMessage {
        timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("timed out waiting for server message")
            .expect("client channel closed")
    }

    async fn drain_until<F>(rx: &mut mpsc::Receiver<ServerMessage>, pred: F) -> ServerMessage
    where
        F: Fn(&ServerMessage) -> bool,
    {
        for _ in 0..32 {
            let msg = drain_one(rx).await;
            if pred(&msg) {
                return msg;
            }
        }
        panic!("did not receive expected server message");
    }

    async fn apply_one(hub: Arc<Mutex<SessionHub>>, receiver: &mut HubOpReceiver) {
        let op = timeout(Duration::from_secs(1), receiver.rx.recv())
            .await
            .expect("timed out waiting for hub op")
            .expect("hub op channel closed");
        op(hub).await;
    }

    /// A coalesced assistantDelta run must reach viewers once delta_flush_ms
    /// elapses, with no non-delta event required to force it out.
    #[tokio::test]
    async fn coalesced_deltas_flush_on_the_timer_without_a_following_event() {
        let (_driver, hub, mut ops) = test_hub(); // delta_flush_ms = 10
        let (_client_key, _tx, mut rx) = hub.lock().add_client(None);

        let delta = |text: &str| SessionDriverEvent::AssistantDelta {
            base: SessionEventBase {
                session_ref: session_ref_for("demo-session"),
                timestamp: ts(),
                run_id: None,
            },
            text: text.into(),
            channel: Some(pantoken_protocol::session_driver::AssistantDeltaChannel::Text),
            entry_id: None,
        };
        hub.lock().on_event(delta("hel"));
        hub.lock().on_event(delta("lo"));

        // The timer enqueues a delta_flush op after ~10ms; apply it.
        apply_one(hub.clone(), &mut ops).await;

        let msg = drain_until(&mut rx, |msg| {
            matches!(
                msg,
                ServerMessage::Event {
                    event: SessionDriverEvent::AssistantDelta { .. },
                    ..
                }
            )
        })
        .await;
        match msg {
            ServerMessage::Event {
                event: SessionDriverEvent::AssistantDelta { text, .. },
                ..
            } => assert_eq!(text, "hello", "run should flush merged"),
            other => panic!("expected assistantDelta, got {other:?}"),
        }
    }

    async fn receive_session_config(rx: &mut mpsc::Receiver<ServerMessage>) -> SessionConfig {
        let msg = drain_until(rx, |msg| {
            matches!(
                msg,
                ServerMessage::Event {
                    event: SessionDriverEvent::SessionUpdated { .. },
                    ..
                }
            )
        })
        .await;
        match msg {
            ServerMessage::Event {
                event: SessionDriverEvent::SessionUpdated { snapshot, .. },
                ..
            } => snapshot.config.expect("sessionUpdated should carry config"),
            other => panic!("expected sessionUpdated event, got {other:?}"),
        }
    }

    async fn receive_queue_update(
        rx: &mut mpsc::Receiver<ServerMessage>,
    ) -> Vec<pantoken_protocol::session_driver::SessionQueuedMessage> {
        let msg = drain_until(rx, |msg| {
            matches!(
                msg,
                ServerMessage::Event {
                    event: SessionDriverEvent::QueueUpdated { .. },
                    ..
                }
            )
        })
        .await;
        match msg {
            ServerMessage::Event {
                event: SessionDriverEvent::QueueUpdated { messages, .. },
                ..
            } => messages,
            other => panic!("expected queueUpdated event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn failed_new_session_with_first_prompt_sends_rejected_prompt_result() {
        // Ports the TS create-and-prompt failure contract from
        // `server/src/hub.ts:1703-1734` plus the `failnewsession` mock control from
        // `server/src/mock-driver.ts:681-689,977-980`: a creation failure for a
        // new-session first prompt must surface as `promptResult { accepted:false,
        // sessionId: undefined }`, not as a silent successful creation. The client
        // uses that rejected result to restore the submitted draft text.
        let (driver, hub, mut hub_ops) = test_hub();
        driver.run_script("failnewsession".into());

        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock().handle_client(
            client_key,
            ClientMessage::NewSession {
                cwd: Some("/workspace".into()),
                worktree: None,
                model: None,
                thinking: None,
                facet: None,
                permission_monitor: None,
                prompt: Some("the doomed session".into()),
                images: None,
                prompt_id: Some("client-new-fails".into()),
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;

        let result = drain_until(&mut rx, |msg| {
            matches!(
                msg,
                ServerMessage::PromptResult {
                    prompt_id,
                    accepted: false,
                    session_id: None,
                    ..
                } if prompt_id == "client-new-fails"
            )
        })
        .await;
        match result {
            ServerMessage::PromptResult {
                prompt_id,
                accepted,
                session_id,
                error,
            } => {
                assert_eq!(prompt_id, "client-new-fails");
                assert!(!accepted);
                assert_eq!(session_id, None);
                assert_eq!(error.as_deref(), Some("Could not create the new session"));
            }
            other => panic!("expected rejected promptResult, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn failed_new_session_without_prompt_sends_error() {
        // When a plain `NewSession` (no first prompt) fails, the creation error
        // must reach the client as `ServerMessage::Error` — the path that
        // `switch_to`'s Err arm → `classify_switch_error` takes
        // (hub.rs ~2338-2352), plus the `has_first_prompt == false` fallback
        // (hub.rs ~1600-1608). Without a prompt there is no `PromptResult` to
        // restore a draft from, so `Error` is the only client-visible signal.
        let (driver, hub, mut hub_ops) = test_hub();
        driver.run_script("failnewsession".into());

        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock().handle_client(
            client_key,
            ClientMessage::NewSession {
                cwd: Some("/workspace".into()),
                worktree: None,
                model: None,
                thinking: None,
                facet: None,
                permission_monitor: None,
                prompt: None,
                images: None,
                prompt_id: None,
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;

        let result = drain_until(&mut rx, |msg| matches!(msg, ServerMessage::Error { .. })).await;
        match result {
            ServerMessage::Error { message, kind } => {
                // The first `Error` delivered comes from `switch_to`'s Err arm
                // (classify_switch_error's fallback): it wraps the raw driver
                // error. The mock's `failnewsession` script yields
                // "new session failed (failnewsession)".
                assert!(
                    message.contains("session switch failed") && message.contains("failnewsession"),
                    "expected switch-failure message, got: {message}"
                );
                assert_eq!(kind, None);
            }
            other => panic!("expected ServerMessage::Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn failnewsession_is_one_shot_and_does_not_mutate_before_failure() {
        // Ports TS `MockDriver.failNextNewSession`: the first creation after
        // `runScript("failnewsession")` fails before adding a session row; the next
        // creation succeeds normally.
        let driver = MockDriver::new();
        let before = driver.list_sessions().await;
        driver.run_script("failnewsession".into());

        let failed = driver
            .new_session(NewSessionOptsData {
                cwd: Some("/first".into()),
                ..Default::default()
            })
            .await;
        assert!(failed.is_err());
        assert_eq!(driver.list_sessions().await.len(), before.len());

        let succeeded = driver
            .new_session(NewSessionOptsData {
                cwd: Some("/second".into()),
                ..Default::default()
            })
            .await
            .expect("second new_session succeeds");
        assert!(!succeeded.is_empty());
        assert!(
            driver
                .list_sessions()
                .await
                .iter()
                .any(|entry| entry.session_id == "new-/second")
        );
    }

    #[tokio::test]
    async fn restore_queue_clears_target_once_and_replies_only_to_requester() {
        // Ported from TS `server/src/hub.test.ts:341`.
        let (driver, hub, mut hub_ops) = test_hub();
        driver.run_script("queue".into());

        let (a_key, _a_tx, mut a_rx) = hub.lock().add_client(None);
        let (_b_key, _b_tx, mut b_rx) = hub.lock().add_client(None);
        let _ = receive_queue_update(&mut a_rx).await;
        let _ = receive_queue_update(&mut b_rx).await;

        hub.lock().handle_client(
            a_key,
            ClientMessage::RestoreQueue {
                session_id: Some("demo-session".into()),
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;

        let restored = drain_until(&mut a_rx, |msg| {
            matches!(msg, ServerMessage::QueueRestored { .. })
        })
        .await;
        match restored {
            ServerMessage::QueueRestored {
                steering,
                follow_up,
            } => {
                assert_eq!(steering, vec!["Please inspect the failing test first."]);
                assert_eq!(
                    follow_up,
                    vec!["Then summarize the fix and remaining risks."]
                );
            }
            other => panic!("expected queueRestored, got {other:?}"),
        }
        let cleared = receive_queue_update(&mut a_rx).await;
        assert!(cleared.is_empty());
        assert!(
            timeout(Duration::from_millis(50), async {
                while let Some(msg) = b_rx.recv().await {
                    if matches!(msg, ServerMessage::QueueRestored { .. }) {
                        return true;
                    }
                }
                false
            })
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn restore_queue_returns_empty_result_without_changing_editor_contract() {
        // Ported from TS `server/src/hub.test.ts:365`.
        let (_driver, hub, mut hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);

        hub.lock().handle_client(
            client_key,
            ClientMessage::RestoreQueue {
                session_id: Some("demo-session".into()),
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;

        let restored = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::QueueRestored { .. })
        })
        .await;
        match restored {
            ServerMessage::QueueRestored {
                steering,
                follow_up,
            } => {
                assert!(steering.is_empty());
                assert!(follow_up.is_empty());
            }
            other => panic!("expected queueRestored, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn mock_queue_scripts_broadcast_deliver_and_overlay_open_session_seed() {
        // Back-fills TS MockDriver queue semantics from
        // `server/src/mock-driver.ts:270`, `:444`, `:622`, and `:987`.
        let (driver, hub, _hub_ops) = test_hub();
        let (_client_key, _tx, mut rx) = hub.lock().add_client(None);

        driver.run_script("queue".into());
        let queued = receive_queue_update(&mut rx).await;
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0].id, "queue-steer-fixture");
        assert_eq!(queued[0].mode, SessionMessageDeliveryMode::Steer);
        assert_eq!(queued[0].text, "Please inspect the failing test first.");
        assert_eq!(queued[1].id, "queue-followup-fixture");
        assert_eq!(queued[1].mode, SessionMessageDeliveryMode::FollowUp);
        assert_eq!(
            queued[1].text,
            "Then summarize the fix and remaining risks."
        );

        let seed = driver
            .open_session("/sessions/demo-session.jsonl".into())
            .await
            .expect("open_session should succeed in the mock");
        let opened_queue = seed.iter().find_map(|event| match event {
            SessionDriverEvent::SessionOpened { snapshot, .. } => snapshot.queued_messages.clone(),
            _ => None,
        });
        assert_eq!(
            opened_queue
                .expect("sessionOpened should overlay queuedMessages")
                .len(),
            2
        );

        driver.run_script("deliverqueue".into());
        let started = drain_until(&mut rx, |msg| {
            matches!(
                msg,
                ServerMessage::Event {
                    event: SessionDriverEvent::QueuedMessageStarted { .. },
                    ..
                }
            )
        })
        .await;
        match started {
            ServerMessage::Event {
                event: SessionDriverEvent::QueuedMessageStarted { message, .. },
                ..
            } => assert_eq!(message.id, "queue-steer-fixture"),
            other => panic!("expected queuedMessageStarted, got {other:?}"),
        }
        let remaining = receive_queue_update(&mut rx).await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "queue-followup-fixture");
    }

    #[tokio::test]
    async fn connecting_client_receives_model_list_and_defaults() {
        // Ported from TS `server/src/hub.test.ts:1127` and the adjacent
        // getModelDefaults fake at `server/src/hub.test.ts:226`.
        let (_driver, hub, mut hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock().spawn_connect_lists(client_key);

        // connect_session_list, connect_model_list, connect_command_list,
        // connect_facet_list, connect_file_index, connect_at_refs,
        // connect_model_defaults.
        for _ in 0..7 {
            apply_one(hub.clone(), &mut hub_ops).await;
        }

        let model_list = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::ModelList { .. })
        })
        .await;
        match model_list {
            ServerMessage::ModelList { models, .. } => {
                assert!(models.iter().any(|m| m.model_id == "deepseek-v4-flash"));
            }
            other => panic!("expected modelList, got {other:?}"),
        }

        let defaults = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::ModelDefaults { .. })
        })
        .await;
        match defaults {
            ServerMessage::ModelDefaults { defaults } => {
                assert_eq!(defaults.provider.as_deref(), Some("anthropic"));
                assert_eq!(defaults.model_id.as_deref(), Some("claude-opus-4-8"));
                assert_eq!(defaults.thinking_level.as_deref(), Some("medium"));
            }
            other => panic!("expected modelDefaults, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn connecting_client_receives_at_refs() {
        // Sibling of `connecting_client_receives_model_list_and_defaults`: a
        // connecting client gets the mock driver's skill/subagent fixtures via
        // the new `connect_at_refs` fan-out.
        let (_driver, hub, mut hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock().spawn_connect_lists(client_key);

        for _ in 0..7 {
            apply_one(hub.clone(), &mut hub_ops).await;
        }

        let at_refs = drain_until(&mut rx, |msg| matches!(msg, ServerMessage::AtRefs { .. })).await;
        match at_refs {
            ServerMessage::AtRefs { refs } => {
                assert_eq!(
                    refs.skills,
                    vec!["debug".to_string(), "journal".to_string()]
                );
                assert_eq!(
                    refs.subagents,
                    vec!["reviewer".to_string(), "explorer".to_string()]
                );
            }
            other => panic!("expected atRefs, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn set_model_and_thinking_emit_config_snapshots() {
        // Back-fills TS MockDriver semantics from `server/src/mock-driver.ts:810`:
        // setModel/setThinking (as sessionAction arms) mutate current config and
        // emit sessionUpdated. Runs the real ops applier instead of hand-stepping
        // apply_one: the first sessionUpdated also enqueues a session-list refresh
        // op, which single-stepping would consume in place of the second action.
        let (_driver, hub, hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        let applier = tokio::spawn(run_hub_op_applier(hub.clone(), hub_ops));

        hub.lock().handle_client(
            client_key,
            ClientMessage::SessionAction {
                action: pantoken_protocol::wire::SessionAction::SetModel {
                    provider: "deepseek".into(),
                    model_id: "deepseek-v4-flash".into(),
                },
                session_id: None,
            },
        );
        let config = receive_session_config(&mut rx).await;
        assert_eq!(config.provider.as_deref(), Some("deepseek"));
        assert_eq!(config.model_id.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(config.thinking_level.as_deref(), Some("medium"));

        hub.lock().handle_client(
            client_key,
            ClientMessage::SessionAction {
                action: pantoken_protocol::wire::SessionAction::SetThinking {
                    level: "high".into(),
                },
                session_id: None,
            },
        );
        let config = receive_session_config(&mut rx).await;
        assert_eq!(config.provider.as_deref(), Some("deepseek"));
        assert_eq!(config.model_id.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(config.thinking_level.as_deref(), Some("high"));
        applier.abort();
    }

    #[tokio::test]
    async fn compact_and_clear_context_route_to_driver() {
        // Routing net for `sessionAction` in `hub.rs:handle_client`: the hub
        // enqueues one `session_action` hub op that calls the driver method,
        // and the MockDriver's arms emit a `usageUpdated` we can observe on
        // the wire. (The mock behavior itself is covered by the e2e suite;
        // this is only the routing assertion.)
        let (_driver, hub, mut hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);

        // compact → driver.session_action → usageUpdated { tokens: 8000, percent: 4 }
        hub.lock().handle_client(
            client_key,
            ClientMessage::SessionAction {
                action: pantoken_protocol::wire::SessionAction::Compact,
                session_id: Some("demo-session".into()),
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;
        let usage = drain_until(&mut rx, |msg| {
            matches!(
                msg,
                ServerMessage::Event {
                    event: SessionDriverEvent::UsageUpdated { .. },
                    ..
                }
            )
        })
        .await;
        match usage {
            ServerMessage::Event {
                event: SessionDriverEvent::UsageUpdated { usage, .. },
                ..
            } => {
                assert_eq!(usage.tokens, Some(8000));
                assert_eq!(usage.context_window, 200000);
                assert_eq!(usage.percent, Some(4.0));
            }
            other => panic!("expected usageUpdated from compact, got {other:?}"),
        }

        // clearContext → driver.session_action → usageUpdated { tokens: 0, percent: 0 }
        hub.lock().handle_client(
            client_key,
            ClientMessage::SessionAction {
                action: pantoken_protocol::wire::SessionAction::ClearContext,
                session_id: Some("demo-session".into()),
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;
        let usage = drain_until(&mut rx, |msg| {
            matches!(
                msg,
                ServerMessage::Event {
                    event: SessionDriverEvent::UsageUpdated { .. },
                    ..
                }
            )
        })
        .await;
        match usage {
            ServerMessage::Event {
                event: SessionDriverEvent::UsageUpdated { usage, .. },
                ..
            } => {
                assert_eq!(usage.tokens, Some(0));
                assert_eq!(usage.context_window, 200000);
                assert_eq!(usage.percent, Some(0.0));
            }
            other => panic!("expected usageUpdated from clearContext, got {other:?}"),
        }
    }

    // ── reload-session cluster (Phase 1.6) ─────────────────────────────────
    // Ported from TS `server/src/hub.test.ts:544` ("reloadSession rebuilds a
    // wedged session from a fresh seed for every viewer") and `:569` ("reloadSession
    // reports an error when the driver doesn't support it"). The mock has no warm
    // session to throw away, so its reloadSession reseeds the same transcript
    // openSession would — enough to prove the menu → WS → reseed round-trip and
    // that a reseed re-snapshots EVERY viewer, not just the requester.

    /// Fold the events carried by a `Seed` message into a `SessionState`, mirroring
    /// the TS `seedState(received)` test helper.
    fn seed_state_of(msg: &ServerMessage) -> Option<SessionState> {
        match msg {
            ServerMessage::Seed { events, .. } => Some(fold_all(events)),
            _ => None,
        }
    }

    #[tokio::test]
    async fn reload_session_reseeds_a_wedged_session_for_every_viewer() {
        // Ports TS `server/src/hub.test.ts:544`. The default focus both clients
        // adopt is the greeting session ("demo-session"); wedge it with a stale
        // userMessage, then reload it. The reloaded seed is authoritative for
        // EVERY viewer focused on it, so a second client also recovers.
        let (driver, hub, mut hub_ops) = test_hub();

        // Wedge the greeting session SYNCHRONOUSLY before anyone connects, so the
        // connect seeds actually carry the stale transcript (mirrors TS
        // `d.emit(ev({ type: "userMessage", ... }))`, which is synchronous). We call
        // on_event directly rather than `driver.emit` because `emit` forwards through
        // a spawned task that can't run before the synchronous `add_client` calls.
        let wedge = SessionDriverEvent::UserMessage {
            base: SessionEventBase {
                session_ref: session_ref_for("demo-session"),
                timestamp: ts(),
                run_id: None,
            },
            id: "u-wedge".into(),
            text: "wedged msg".into(),
            images: None,
            entry_id: None,
            references: None,
        };
        hub.lock().on_event(wedge);

        let (a_key, _a_tx, mut a_rx) = hub.lock().add_client(None);
        let (_b_key, _b_tx, mut b_rx) = hub.lock().add_client(None);

        // Sanity: the connect seeds carry the wedge (proves it landed in the
        // journal before the reload). If this fails, the assertions below would be
        // vacuous — exactly the bug the first review pass caught.
        for rx in [&mut a_rx, &mut b_rx] {
            let connect_seed =
                drain_until(rx, |msg| matches!(msg, ServerMessage::Seed { .. })).await;
            let st = seed_state_of(&connect_seed).expect("connect seed should fold");
            assert!(
                st.items.iter().any(|i| match i {
                    TranscriptItem::User(u) => u.text.contains("wedged msg"),
                    _ => false,
                }),
                "connect seed must carry the wedge before reload"
            );
        }

        hub.lock().handle_client(
            a_key,
            ClientMessage::ReloadSession {
                path: "/sessions/demo-session.jsonl".into(),
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;

        // Both clients receive a FRESH post-reload seed (the reseed broadcasts to
        // every viewer, not just the requester) whose transcript does NOT contain
        // the wedged message but DOES contain the greeting prompt — proving the
        // reload ran openSession's seed, not an empty one.
        for rx in [&mut a_rx, &mut b_rx] {
            let reloaded = drain_until(rx, |msg| matches!(msg, ServerMessage::Seed { .. })).await;
            let st = seed_state_of(&reloaded).expect("reloaded seed should fold into a state");
            assert!(
                !st.items.iter().any(|i| match i {
                    TranscriptItem::User(u) => u.text.contains("wedged msg"),
                    _ => false,
                }),
                "reloaded seed must not carry the wedged transcript"
            );
            assert!(
                st.items.iter().any(|i| match i {
                    TranscriptItem::User(u) => u.text == GREETING_PROMPT,
                    _ => false,
                }),
                "reloaded seed should carry the greeting prompt"
            );
        }

        // The reload actually delegated to open_session (not the trait default that
        // returns an empty Vec): an empty seed would have surfaced as an Error, not
        // a reseed. Drain confirms no error was sent to either viewer.
        for rx in [&mut a_rx, &mut b_rx] {
            assert!(
                timeout(Duration::from_millis(50), async {
                    while let Some(msg) = rx.recv().await {
                        if matches!(msg, ServerMessage::Error { .. }) {
                            return true;
                        }
                    }
                    false
                })
                .await
                .is_err(),
                "reload must not surface an error"
            );
        }
        let _ = driver;
    }

    #[tokio::test]
    async fn reload_session_with_empty_seed_reports_an_error() {
        // Ports the contract behind TS `server/src/hub.test.ts:569` ("reloadSession
        // reports an error when the driver doesn't support it"). The Rust
        // `PantokenDriver` trait gives `reload_session` a default impl returning an
        // empty Vec (there is no `Option<fn>` analogue to TS's optional method), so
        // "unsupported" is expressed as an empty seed. An empty seed must surface as
        // a client-visible `Error` rather than silently no-op'ing — the reload
        // affordance must not appear to succeed when nothing was reseeded.
        //
        // We exercise the empty-seed path directly via `finish_switch` (the
        // post-fetch half of switch_to): an empty seed must send an Error and
        // resolve to no session, which is exactly what a driver that doesn't
        // override reload_session produces.
        let (_driver, hub, _hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        let _ = drain_until(&mut rx, |msg| matches!(msg, ServerMessage::Seed { .. })).await;

        let result = finish_switch(&hub, client_key, Vec::new(), true, true).await;
        assert!(
            result.is_none(),
            "an empty seed must not resolve to a session"
        );

        let err = drain_until(&mut rx, |msg| matches!(msg, ServerMessage::Error { .. })).await;
        match err {
            ServerMessage::Error { message, .. } => {
                assert_eq!(
                    message, "session switch returned no session",
                    "an empty reload seed must surface the no-session error"
                );
            }
            other => panic!("expected an Error for an unsupported reload, got {other:?}"),
        }
    }

    // ── desktop update relay ───────────────────────────────────────────────
    // Ports TS `server/src/hub.test.ts:1773` ("desktop update relay"). The hub
    // relays the shell updater's staged-update report to clients via
    // `updateStatus`, and hands back `{applying, force}` so the updater learns
    // on the same poll whether the user clicked "update now" / "force-update".

    /// Drain `rx` and return the last `UpdateStatus` message seen (mirrors the
    /// TS `lastUpdate` helper, which scans `c.received` for the most recent
    /// `updateStatus`). Panics if none arrived within the drain window.
    async fn last_update(rx: &mut mpsc::Receiver<ServerMessage>) -> ServerMessage {
        let mut last: Option<ServerMessage> = None;
        for _ in 0..64 {
            match timeout(Duration::from_millis(50), rx.recv()).await {
                Ok(Some(msg)) => {
                    if matches!(msg, ServerMessage::UpdateStatus { .. }) {
                        last = Some(msg);
                    }
                }
                _ => break,
            }
        }
        last.expect("expected at least one updateStatus message")
    }

    #[tokio::test]
    async fn report_update_broadcasts_availability_to_clients() {
        // Ports TS "reportUpdate broadcasts availability to clients".
        let (_driver, hub, _hub_ops) = test_hub();
        let (_a_key, _a_tx, mut a_rx) = hub.lock().add_client(None);
        // Connect sends a baseline updateStatus (nothing staged).
        let baseline = last_update(&mut a_rx).await;
        match baseline {
            ServerMessage::UpdateStatus {
                available,
                applying,
                ..
            } => {
                assert!(!available, "nothing staged on a fresh connect");
                assert!(!applying);
            }
            other => panic!("expected UpdateStatus on connect, got {other:?}"),
        }

        hub.lock().report_update(Some("abc123".into()), false, None);
        let upd = last_update(&mut a_rx).await;
        match upd {
            ServerMessage::UpdateStatus {
                available,
                sha,
                applying,
                ..
            } => {
                assert!(available, "update should be available after report");
                assert_eq!(sha.as_deref(), Some("abc123"));
                assert!(!applying);
            }
            other => panic!("expected UpdateStatus after report, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn late_client_sees_staged_update_immediately() {
        // Ports TS "a client connecting after an update is staged sees the card
        // immediately". Stage the update BEFORE the client connects; the connect
        // seed must include the staged updateStatus.
        let (_driver, hub, _hub_ops) = test_hub();
        hub.lock().report_update(Some("def456".into()), false, None);
        let (_late_key, _late_tx, mut late_rx) = hub.lock().add_client(None);
        let upd = last_update(&mut late_rx).await;
        match upd {
            ServerMessage::UpdateStatus { available, sha, .. } => {
                assert!(available, "late client should see the staged update");
                assert_eq!(sha.as_deref(), Some("def456"));
            }
            other => panic!("expected UpdateStatus in connect seed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn apply_update_flips_applying_and_updater_learns_it() {
        // Ports TS "applyUpdate flips applying + the updater learns it on its next
        // report". After applyUpdate, the next reportUpdate returns applying=true.
        let (_driver, hub, _hub_ops) = test_hub();
        let (a_key, _a_tx, mut a_rx) = hub.lock().add_client(None);
        let _ = last_update(&mut a_rx).await; // drain baseline
        hub.lock().report_update(Some("abc123".into()), false, None);
        let _ = last_update(&mut a_rx).await; // drain the staged broadcast

        hub.lock().handle_client(a_key, ClientMessage::ApplyUpdate);
        let upd = last_update(&mut a_rx).await;
        match upd {
            ServerMessage::UpdateStatus {
                available,
                applying,
                ..
            } => {
                assert!(available);
                assert!(applying, "applyUpdate should flip applying to true");
            }
            other => panic!("expected UpdateStatus after apply, got {other:?}"),
        }

        // The updater's next poll (any sha report) returns applying=true.
        let result = hub.lock().report_update(Some("abc123".into()), false, None);
        assert_eq!(
            result["applying"], true,
            "updater should learn applying=true"
        );
        assert_eq!(result["force"], false);
    }

    #[tokio::test]
    async fn apply_update_is_a_noop_when_nothing_staged() {
        // Ports TS "applyUpdate is a no-op when nothing is staged". With no update
        // staged, applyUpdate must not change the updateStatus.
        let (_driver, hub, _hub_ops) = test_hub();
        let (a_key, _a_tx, mut a_rx) = hub.lock().add_client(None);
        let baseline = last_update(&mut a_rx).await;
        let (base_available, base_applying) = match baseline {
            ServerMessage::UpdateStatus {
                available,
                applying,
                ..
            } => (available, applying),
            other => panic!("expected UpdateStatus on connect, got {other:?}"),
        };

        hub.lock().handle_client(a_key, ClientMessage::ApplyUpdate);
        // No new updateStatus should be broadcast — the channel stays empty.
        if let Ok(Some(msg)) = timeout(Duration::from_millis(50), a_rx.recv()).await {
            panic!("applyUpdate with nothing staged should not broadcast, got {msg:?}");
        }
        assert!(!base_available);
        assert!(!base_applying);
    }

    #[tokio::test]
    async fn report_update_null_clears_availability_and_applying_flag() {
        // Ports TS "reportUpdate(null) clears availability and any applying flag".
        let (_driver, hub, _hub_ops) = test_hub();
        let (a_key, _a_tx, mut a_rx) = hub.lock().add_client(None);
        let _ = last_update(&mut a_rx).await; // drain baseline
        hub.lock().report_update(Some("abc123".into()), false, None);
        let _ = last_update(&mut a_rx).await; // drain staged broadcast
        hub.lock().handle_client(a_key, ClientMessage::ApplyUpdate);
        let _ = last_update(&mut a_rx).await; // drain applying broadcast

        let result = hub.lock().report_update(None, false, None);
        assert_eq!(result["applying"], false, "null report clears applying");
        assert_eq!(result["force"], false);

        let upd = last_update(&mut a_rx).await;
        match upd {
            ServerMessage::UpdateStatus {
                available,
                applying,
                ..
            } => {
                assert!(!available, "null report clears availability");
                assert!(!applying);
            }
            other => panic!("expected UpdateStatus after null report, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn apply_failed_unsticks_a_stuck_applying_card() {
        // Ports TS "applyFailed un-sticks a stuck applying card (offer retry)".
        let (_driver, hub, _hub_ops) = test_hub();
        let (a_key, _a_tx, mut a_rx) = hub.lock().add_client(None);
        let _ = last_update(&mut a_rx).await; // drain baseline
        hub.lock().report_update(Some("abc123".into()), false, None);
        let _ = last_update(&mut a_rx).await; // drain staged broadcast
        hub.lock().handle_client(a_key, ClientMessage::ApplyUpdate);
        let applying = last_update(&mut a_rx).await;
        match applying {
            ServerMessage::UpdateStatus { applying, .. } => assert!(applying),
            other => panic!("expected applying UpdateStatus, got {other:?}"),
        }

        // A failed apply reports back applyFailed → card returns to "update now".
        let result = hub.lock().report_update(Some("abc123".into()), true, None);
        assert_eq!(result["applying"], false, "applyFailed clears applying");
        assert_eq!(result["force"], false);

        let upd = last_update(&mut a_rx).await;
        match upd {
            ServerMessage::UpdateStatus {
                available,
                applying,
                ..
            } => {
                assert!(available, "update still staged after a failed apply");
                assert!(!applying, "applying cleared after applyFailed");
            }
            other => panic!("expected UpdateStatus after applyFailed, got {other:?}"),
        }
    }

    // ── classify_switch_error table tests (Phase 1.8 lease-conflict) ────────
    // Ports the six branches of TS `classifySwitchError` (hub.ts:129-184).
    // `classify_switch_error` is a pure function — the cheapest, highest-value
    // guard for the lease-conflict routing the e2e singleton exercises.

    #[test]
    fn classify_lease_conflict_passes_message_and_session_switch_kind() {
        let (message, kind) = classify_switch_error(
            "another TUI is attached to this session (\"tui\" pid 99999, lease expires in 30s). Detach it there (/detach) or wait 30s for its lease to lapse.",
        );
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("another TUI is attached"));
    }

    #[test]
    fn classify_lease_claim_409_falls_back_to_detach_message() {
        let (message, kind) = classify_switch_error("lease claim failed (409): held by other");
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("Detach it there"));
    }

    #[test]
    fn classify_missing_cwd_names_the_directory_and_is_permanent_shaped() {
        // The concrete docs/TODO.md case: a cold session whose project cwd no
        // longer exists. `open_session` (polytoken/driver.rs) produces this
        // exact message before ever attempting a spawn.
        let (message, kind) =
            classify_switch_error("session directory no longer exists: /tmp/gone-project");
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(
            message.contains("/tmp/gone-project"),
            "message must name the missing directory: {message}"
        );
        assert!(message.contains("no longer exists"));
        // Client-side note (store.svelte.ts LEASE_CONFLICT_RE): this message
        // must NOT read as a lease conflict, or the client would wrongly
        // offer a "Retry" action for a failure that can never succeed.
        assert!(!message.contains("another TUI is attached"));
        assert!(!message.contains("lease to lapse"));
    }

    #[test]
    fn classify_daemon_exited_early_is_session_switch_kind() {
        let (message, kind) = classify_switch_error(
            "polytoken daemon exited early (status exit status: 1):\nstderr: bad args",
        );
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("exited immediately"));
    }

    #[test]
    fn classify_daemon_health_probe_failed_reads_as_unreachable() {
        let (message, kind) = classify_switch_error("daemon health probe failed");
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("Couldn't reach the session daemon"));
    }

    #[test]
    fn classify_daemon_failed_to_start_surfaces_detail() {
        let (message, kind) = classify_switch_error(
            "polytoken daemon failed to start: config parse error near line 12",
        );
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("config parse error near line 12"));
        assert!(message.contains("daemon failed to start"));
    }

    #[test]
    fn classify_daemon_timeout_to_start() {
        let (message, kind) = classify_switch_error("daemon did not become healthy within 10s");
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("took too long to start"));
    }

    #[test]
    fn classify_connection_refused() {
        let (message, kind) = classify_switch_error("request timed out reaching daemon");
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("Couldn't reach the session daemon"));
    }

    #[test]
    fn classify_unresolved_path() {
        let (message, kind) =
            classify_switch_error("could not resolve session id from path /x.jsonl");
        assert_eq!(kind.as_deref(), Some("session-switch"));
        assert!(message.contains("path wasn't recognized"));
    }

    #[test]
    fn classify_unknown_error_falls_back_to_generic_no_kind() {
        let (message, kind) = classify_switch_error("something totally unexpected");
        assert!(
            kind.is_none(),
            "unknown errors must not get a session-switch kind"
        );
        assert!(message.contains("session switch failed: something totally unexpected"));
    }

    /// `client_count()` mirrors TS `clientCount()` — 0 on a fresh hub, increments
    /// after `add_client`, decrements after `remove_client`.
    #[tokio::test]
    async fn client_count_tracks_add_remove() {
        let (_driver, hub, _ops) = test_hub();

        assert_eq!(hub.lock().client_count(), 0, "fresh hub has no clients");

        let (a, _tx_a, _rx_a) = hub.lock().add_client(None);
        assert_eq!(hub.lock().client_count(), 1, "one client connected");

        let (b, _tx_b, _rx_b) = hub.lock().add_client(None);
        assert_eq!(hub.lock().client_count(), 2, "two clients connected");

        hub.lock().remove_client(a);
        assert_eq!(hub.lock().client_count(), 1, "one client removed");

        hub.lock().remove_client(b);
        assert_eq!(hub.lock().client_count(), 0, "all clients removed");
    }

    /// Push payloads carry an app-icon badge = sessions currently needing the
    /// operator (pending dialog or failed run). `maybe_notify` runs after
    /// `track_attention`, so the triggering event itself is counted; a later
    /// turn-complete push for another session still reports the total.
    #[tokio::test]
    async fn push_notification_badge_counts_attention_sessions() {
        use pantoken_protocol::session_driver::HostUiRequest;
        use std::sync::Mutex as StdMutex;

        let captured: Arc<StdMutex<Vec<HubNotification>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = captured.clone();
        let driver = Arc::new(MockDriver::new());
        let (tx, _ops) = hub_op_channel();
        let hub = SessionHub::new(
            driver.clone(),
            tx,
            Some(Arc::new(move |n: HubNotification| {
                sink.lock().unwrap().push(n);
            })),
            250,
            "test-server".into(),
            None,
            "test-sha".into(),
            10,
        );

        // Notifications only fire once someone has connected and then left.
        let (key, _ctx, _crx) = hub.lock().add_client(None);
        hub.lock().remove_client(key);

        // An approval dialog arrives → that session is pending → badge 1.
        let sref = session_ref_for("badge-1");
        hub.lock().on_event(SessionDriverEvent::HostUiRequest {
            base: SessionEventBase {
                session_ref: sref.clone(),
                timestamp: ts(),
                run_id: None,
            },
            request: HostUiRequest::Confirm {
                request_id: "req-1".into(),
                title: "Run command?".into(),
                message: "ls".into(),
                default_value: None,
                timeout_ms: None,
            },
        });

        // A second session fails its run → its push counts BOTH attention
        // sessions (the pending approval + the fresh failure).
        let sref2 = session_ref_for("badge-2");
        hub.lock().on_event(SessionDriverEvent::RunFailed {
            base: SessionEventBase {
                session_ref: sref2.clone(),
                timestamp: ts(),
                run_id: None,
            },
            error: pantoken_protocol::session_driver::SessionErrorInfo {
                message: "boom".into(),
                code: None,
                details: None,
            },
        });

        let got = captured.lock().unwrap();
        assert_eq!(got.len(), 2, "approval + run-failed pushes");
        assert_eq!(got[0].title, "Approval needed");
        assert_eq!(got[0].badge, Some(1), "the pending approval is counted");
        assert_eq!(got[1].badge, Some(2), "pending approval + failed run");
        assert!(
            got[1].url.as_deref().unwrap_or("").contains("badge-2"),
            "deep-link targets the failing session"
        );
    }

    /// `activity()` + `client_count()` together produce the exact `/health` shape
    /// (`{running, initializing, busy}` + `clients`) when a session is running.
    /// A `userMessage` event drives `track_running` → `set_running(sid, true)`,
    /// so `activity()` must report `running: 1, busy: true`.
    #[tokio::test]
    async fn activity_and_client_count_with_running_session() {
        let (_driver, hub, _ops) = test_hub();

        // Before any activity: nothing running, no clients.
        let activity = hub.lock().activity();
        assert_eq!(activity["running"], 0);
        assert_eq!(activity["initializing"], 0);
        assert_eq!(activity["busy"], false);
        assert_eq!(hub.lock().client_count(), 0);

        // A userMessage event flips the session to running (track_running →
        // set_running(sid, true)).
        let ev = SessionDriverEvent::UserMessage {
            base: SessionEventBase {
                session_ref: session_ref_for("demo-session"),
                timestamp: ts(),
                run_id: None,
            },
            id: "u1".into(),
            text: "hello".into(),
            images: None,
            entry_id: None,
            references: None,
        };
        hub.lock().on_event(ev);

        let activity = hub.lock().activity();
        assert_eq!(activity["running"], 1, "session should be running");
        assert_eq!(activity["initializing"], 0);
        assert_eq!(activity["busy"], true, "busy when a session is running");

        // A connected client should be reflected in client_count.
        let (_key, _tx, _rx) = hub.lock().add_client(None);
        assert_eq!(hub.lock().client_count(), 1);
    }

    /// Regression (`050hrk-cheek`): opening a cold, idle session must not leave it
    /// showing "Responding" in the sidebar. The replayed transcript ends on an
    /// `assistantDelta` (attention phase Running, activity "Responding"), and any
    /// trailing `session-resumed` reminder is an inert `customMessage`. The idle
    /// `sessionUpdated` that `build_branch_seed` appends must settle that stuck
    /// phase — mirroring how it clears the running set — so `sessionActivity` stops
    /// reporting "Responding". Before the fix the attention record stayed Running
    /// forever even though `runningIds` was empty and the transcript was closed.
    #[tokio::test]
    async fn idle_session_updated_settles_stuck_responding_attention() {
        use pantoken_protocol::session_driver::{
            AssistantDeltaChannel, SessionStatus, WorkspaceRef,
        };

        let (_driver, hub, _ops) = test_hub();
        let sref = session_ref_for("cold-1");
        let workspace = WorkspaceRef {
            workspace_id: sref.workspace_id.clone(),
            path: "/repo".into(),
            display_name: None,
        };

        // A text delta from the last (completed) turn leaves attention Running "Responding".
        hub.lock().on_event(SessionDriverEvent::AssistantDelta {
            base: SessionEventBase {
                session_ref: sref.clone(),
                timestamp: ts(),
                run_id: None,
            },
            text: "All done!".into(),
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        });
        let att = hub
            .lock()
            .attention_for(&sref.session_id)
            .expect("attention record after delta");
        assert_eq!(att.phase, SessionAttentionPhase::Running);
        assert_eq!(att.activity.as_deref(), Some("Responding"));

        // A trailing session-resumed reminder (customMessage) must NOT settle it.
        hub.lock().on_event(SessionDriverEvent::CustomMessage {
            base: SessionEventBase {
                session_ref: sref.clone(),
                timestamp: ts(),
                run_id: None,
            },
            id: "reminder-session-resumed-0".into(),
            custom_type: "session-resumed".into(),
            text: "This session has been resumed from saved history.".into(),
            display: false,
            turn_boundary: false,
        });
        assert_eq!(
            hub.lock()
                .attention_for(&sref.session_id)
                .and_then(|a| a.activity)
                .as_deref(),
            Some("Responding"),
            "a customMessage must not settle attention"
        );

        // The authoritative idle re-assert settles the stuck Running phase.
        let idle_snap = crate::polytoken::event_map::snapshot_from_state(
            None,
            &sref,
            &workspace,
            SessionStatus::Idle,
            &ts(),
            None,
            None,
        );
        hub.lock().on_event(SessionDriverEvent::SessionUpdated {
            base: SessionEventBase {
                session_ref: sref.clone(),
                timestamp: ts(),
                run_id: None,
            },
            snapshot: idle_snap,
        });

        let settled = hub
            .lock()
            .attention_for(&sref.session_id)
            .expect("attention record still present after settle");
        assert_ne!(
            settled.phase,
            SessionAttentionPhase::Running,
            "idle re-assert must clear the Running phase"
        );
        assert_ne!(
            settled.activity.as_deref(),
            Some("Responding"),
            "a freshly opened idle session must stop showing 'Responding'"
        );
    }

    /// A bare `sessionOpened(idle)` on a session with NO prior activity must NOT
    /// synthesize an attention record — the idle-settle path only downgrades an
    /// existing stuck Running record, it never creates one (else every opened
    /// empty session would flash a spurious "Done").
    #[tokio::test]
    async fn idle_session_opened_does_not_create_attention_record() {
        use pantoken_protocol::session_driver::{SessionStatus, WorkspaceRef};

        let (_driver, hub, _ops) = test_hub();
        let sref = session_ref_for("fresh-1");
        let workspace = WorkspaceRef {
            workspace_id: sref.workspace_id.clone(),
            path: "/repo".into(),
            display_name: None,
        };
        let idle_snap = crate::polytoken::event_map::snapshot_from_state(
            None,
            &sref,
            &workspace,
            SessionStatus::Idle,
            &ts(),
            None,
            None,
        );
        hub.lock().on_event(SessionDriverEvent::SessionOpened {
            base: SessionEventBase {
                session_ref: sref.clone(),
                timestamp: ts(),
                run_id: None,
            },
            snapshot: idle_snap,
        });
        assert!(
            hub.lock().attention_for(&sref.session_id).is_none(),
            "an idle sessionOpened with no activity must not create an attention record"
        );
    }

    /// Blocked: the attach-window buffer (`take_swap_buffer`) is
    /// `#[expect(dead_code)]` and not wired. These tests document the gap.
    #[tokio::test]
    #[ignore = "blocked: take_swap_buffer / buffer_swap_event not wired (hub.rs:576,601)"]
    async fn events_racing_cold_open_trigger_one_seed_rebuild() {
        // Ported from TS hub.test.ts — verifies that events arriving during a
        // cold open (before the seed is delivered) are folded into the seed
        // rather than sent as separate live events. Blocked on wiring the
        // swap buffer.
        let _ = ("take_swap_buffer blocker",);
    }

    /// Blocked: same as above — the swap buffer is not wired.
    #[tokio::test]
    #[ignore = "blocked: take_swap_buffer / buffer_swap_event not wired (hub.rs:576,601)"]
    async fn raced_events_never_re_run_non_retryable_swap() {
        // Ported from TS hub.test.ts — verifies that a newSession swap
        // triggered by raced events is not re-run. Blocked on wiring the
        // swap buffer.
        let _ = ("take_swap_buffer blocker",);
    }

    #[tokio::test]
    async fn handle_client_detach_session_calls_driver_and_broadcasts() {
        let (_driver, hub, mut hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);

        hub.lock().handle_client(
            client_key,
            ClientMessage::DetachSession {
                path: "/sessions/test/session.json".into(),
            },
        );
        apply_one(hub.clone(), &mut hub_ops).await;

        // Success path: no Error message, just a session list broadcast.
        let result = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::SessionList { .. })
        })
        .await;
        match result {
            ServerMessage::SessionList { .. } => {}
            other => panic!("expected SessionList after detach, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn session_switch_rebroadcasts_model_defaults() {
        use pantoken_protocol::session_driver::PermissionMonitorMode;

        let (_driver, hub, mut hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);
        hub.lock().spawn_connect_lists(client_key);

        // Drain connect-time messages (7 tasks), matching
        // connecting_client_receives_model_list_and_defaults.
        for _ in 0..7 {
            apply_one(hub.clone(), &mut hub_ops).await;
        }
        // Clear the connect-time ModelDefaults from the receiver.
        let _ = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::ModelDefaults { .. })
        })
        .await;

        // Trigger a session switch (open_session on the mock).
        hub.lock().handle_client(
            client_key,
            ClientMessage::OpenSession {
                path: "/sessions/demo-session.jsonl".into(),
            },
        );
        // handle_client(OpenSession) enqueues an open_session task; applying
        // it runs switch_to → finish_switch, which enqueues the follow-up
        // switch_* tasks (switch_session_list, switch_command_list,
        // switch_facet_list, switch_file_index, switch_at_refs,
        // switch_model_defaults). Drain them all with a short timeout so the
        // test doesn't break if tasks are added/removed. When the queue is
        // empty or the poll times out, the `while let` simply exits.
        while let Ok(Some(op)) = timeout(Duration::from_millis(100), hub_ops.rx.recv()).await {
            op(hub.clone()).await;
        }

        // Verify a ModelDefaults was rebroadcast after the switch.
        let defaults = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::ModelDefaults { .. })
        })
        .await;
        match defaults {
            ServerMessage::ModelDefaults { defaults } => {
                // The mock now returns Some(BypassPlus) for
                // default_permission_monitor.
                assert_eq!(
                    defaults.default_permission_monitor,
                    Some(PermissionMonitorMode::BypassPlus)
                );
            }
            other => panic!("expected ModelDefaults after switch, got {other:?}"),
        }
    }

    /// AC.1: emitting a `SessionUpdated` event marks `session_list_dirty`.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn session_updated_marks_session_list_dirty() {
        use pantoken_protocol::session_driver::{SessionStatus, WorkspaceRef};

        let (_driver, hub, _ops) = test_hub();
        let sref = session_ref_for("title-test");
        let workspace = WorkspaceRef {
            workspace_id: sref.workspace_id.clone(),
            path: "/repo".into(),
            display_name: None,
        };
        let snap = crate::polytoken::event_map::snapshot_from_state(
            None,
            &sref,
            &workspace,
            SessionStatus::Idle,
            &ts(),
            None,
            None,
        );

        // Clear the initial dirty flag (set true by SessionHub::new) by
        // calling live_tick once — it broadcasts + clears.
        hub.lock().live_tick().await;
        assert!(
            !hub.lock().session_list_dirty(),
            "dirty flag should be clear after live_tick"
        );

        // Emit SessionUpdated — should set the dirty flag.
        hub.lock().on_event(SessionDriverEvent::SessionUpdated {
            base: SessionEventBase {
                session_ref: sref.clone(),
                timestamp: ts(),
                run_id: None,
            },
            snapshot: snap,
        });

        assert!(
            hub.lock().session_list_dirty(),
            "SessionUpdated must mark session_list_dirty"
        );
    }

    /// AC.2: `live_tick` rebroadcasts the session list when dirty and clears the flag.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn live_tick_rebroadcasts_and_clears_dirty_flag() {
        use pantoken_protocol::session_driver::{SessionStatus, WorkspaceRef};

        let (_driver, hub, _ops) = test_hub();
        let (_client_key, _tx, mut rx) = hub.lock().add_client(None);

        // Drain the Hello message sent by add_client.
        let _ = drain_until(&mut rx, |msg| matches!(msg, ServerMessage::Hello { .. })).await;

        // The hub starts with session_list_dirty = true (from new()).
        // Call live_tick once to broadcast + clear it, then drain that SessionList.
        hub.lock().live_tick().await;
        let _ = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::SessionList { .. })
        })
        .await;
        assert!(
            !hub.lock().session_list_dirty(),
            "dirty flag should be clear after initial live_tick"
        );

        // Now mark it dirty again via a SessionUpdated event.
        let sref = session_ref_for("title-test");
        let workspace = WorkspaceRef {
            workspace_id: sref.workspace_id.clone(),
            path: "/repo".into(),
            display_name: None,
        };
        let snap = crate::polytoken::event_map::snapshot_from_state(
            None,
            &sref,
            &workspace,
            SessionStatus::Idle,
            &ts(),
            None,
            None,
        );
        hub.lock().on_event(SessionDriverEvent::SessionUpdated {
            base: SessionEventBase {
                session_ref: sref.clone(),
                timestamp: ts(),
                run_id: None,
            },
            snapshot: snap,
        });
        assert!(
            hub.lock().session_list_dirty(),
            "dirty flag should be set after SessionUpdated"
        );

        // live_tick should rebroadcast the session list and clear the flag.
        hub.lock().live_tick().await;

        let msg = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::SessionList { .. })
        })
        .await;
        assert!(
            matches!(msg, ServerMessage::SessionList { .. }),
            "expected a SessionList broadcast after live_tick"
        );
        assert!(
            !hub.lock().session_list_dirty(),
            "dirty flag should be clear after live_tick rebroadcast"
        );
    }
}
