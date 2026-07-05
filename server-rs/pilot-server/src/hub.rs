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
use parking_lot::Mutex;
use pilot_protocol::session_driver::{
    HostUiRequest, HostUiResponse, ModelOption, SessionDriverEvent, SessionDriverEvent as E,
    SessionEventBase, SessionId, SessionRef, SessionStatus,
};
use pilot_protocol::state::{SessionState, fold_all, fold_event, initial_session_state};
use pilot_protocol::wire::{
    ClientMessage, ResumeToken, ServerMessage, SessionAttention, SessionAttentionPhase,
};
use tokio::sync::mpsc;
use tracing::error;

use crate::driver::{NewSessionOptsData, PilotDriver};
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

/// A boxed, pinned, Send future — the return type of swap closures.
type SwapFuture = Pin<Box<dyn Future<Output = Vec<SessionDriverEvent>> + Send + 'static>>;

/// What the hub hands to a notifier (e.g. the Web Push sender) for notable events.
#[derive(Debug, Clone)]
pub struct HubNotification {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
    pub url: Option<String>,
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

impl AttentionPhase {
    #[expect(
        dead_code,
        reason = "attention notification formatting is unwired until Phase 3 push/notify integration"
    )]
    fn as_str(&self) -> &'static str {
        match self {
            AttentionPhase::Running => "running",
            AttentionPhase::Failed => "failed",
            AttentionPhase::Done => "done",
        }
    }
}

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

/// The session hub. Owns journals, client map, running/attention tracking,
/// and orchestrates the driver.
pub struct SessionHub {
    driver: Arc<dyn PilotDriver>,
    hub_ops: HubOpSender,
    notify: Option<Arc<dyn Fn(HubNotification) + Send + Sync>>,
    #[expect(
        dead_code,
        reason = "live refresh timer is not wired until Phase 1 hub parity"
    )]
    live_refresh_ms: u64,
    server_id: String,
    data_dir: Option<PathBuf>,
    build_sha: String,
    delta_flush_ms: u64,

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
    last_usage_emitted: HashMap<String, String>,

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

impl SessionHub {
    #[expect(
        clippy::too_many_arguments,
        reason = "constructor mirrors the TS hub dependencies; Phase 1 only adds the completion queue"
    )]
    pub fn new(
        driver: Arc<dyn PilotDriver>,
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
            data_dir,
            build_sha,
            delta_flush_ms,
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
        // Start a new pending run with a flush timer
        let (abort_tx, abort_rx) = tokio::sync::oneshot::channel();
        drop(abort_rx); // would be awaited by the timer task
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
            "userMessage" | "runCompleted" | "runFailed" | "sessionOpened" | "sessionClosed"
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
        let before = self
            .attention_for(sid)
            .map(|a| serde_json::to_string(&a).unwrap_or_default());

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

        let after = self
            .attention_for(sid)
            .map(|a| serde_json::to_string(&a).unwrap_or_default());
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
            let disc = ev.type_discriminator();
            if disc == "runCompleted" {
                notify(HubNotification {
                    title: "pilot".into(),
                    body: format!("{session} finished its turn"),
                    tag: Some(format!("pilot-run-{sid}")),
                    url: Some(url),
                });
            } else if disc == "runFailed" {
                let msg = ev.error_message().unwrap_or_default();
                notify(HubNotification {
                    title: "pilot".into(),
                    body: format!("{session} failed: {}", clipped(&msg, 72)),
                    tag: Some(format!("pilot-run-{sid}")),
                    url: Some(url),
                });
            } else if disc == "hostUiRequest" {
                if let E::HostUiRequest { request, .. } = ev {
                    let kind = request.kind();
                    if matches!(kind, "confirm" | "select" | "input" | "editor" | "qna") {
                        let title = request.title().unwrap_or("Waiting on you");
                        notify(HubNotification {
                            title: "Approval needed".into(),
                            body: format!("{session}: {title}"),
                            tag: Some(format!("pilot-approval-{sid}")),
                            url: Some(url),
                        });
                    }
                }
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────

    pub fn client_count(&self) -> usize {
        // Will be wired when client management is in the hub
        0
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
        self.update_sha = sha;
        if apply_failed {
            self.applying = false;
        }
        if let Some(stale) = desktop_stale {
            self.desktop_stale = stale;
        }
        let force = self.force_requested;
        self.force_requested = false;
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

        // Restore pilot-local settings to defaults so a test's setLoginShell/
        // setBackgroundModel mutation doesn't leak into sibling specs (the persisted
        // file is shared across the per-port data dir for the whole e2e run).
        if let Some(dir) = &self.data_dir {
            let _ = crate::settings_store::write_pilot_settings(
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

        // Send hello synchronously
        let _ = tx.try_send(ServerMessage::Hello {
            protocol_version: 2,
            server_id: self.server_id.clone(),
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

        // Send session status + update status + pilot settings synchronously
        let _ = tx.try_send(self.session_status_msg());
        let _ = tx.try_send(self.update_status_msg());
        let _ = tx.try_send(self.pilot_settings_msg());

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
            ClientMessage::Hello { .. } | ClientMessage::Ping => {}
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
                            let result = async {
                                driver
                                    .prompt(
                                        text,
                                        deliver_as,
                                        target.clone(),
                                        images,
                                        prompt_id_clone,
                                    )
                                    .await;
                                target
                            }
                            .await;

                            let msg = match &result {
                                Some(sid) => ServerMessage::PromptResult {
                                    prompt_id: pid.clone().unwrap_or_default(),
                                    accepted: true,
                                    session_id: Some(sid.clone()),
                                    error: None,
                                },
                                None => ServerMessage::PromptResult {
                                    prompt_id: pid.clone().unwrap_or_default(),
                                    accepted: false,
                                    session_id: None,
                                    error: Some("prompt failed".into()),
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
            ClientMessage::Abort { session_id } => {
                let target = session_id.clone().or(focused_id);
                self.driver.abort(target);
            }
            ClientMessage::SetModel {
                provider,
                model_id,
                session_id,
            } => {
                let target = session_id.clone().or(focused_id);
                self.driver
                    .set_model(provider.clone(), model_id.clone(), target);
            }
            ClientMessage::SetThinking { level, session_id } => {
                let target = session_id.clone().or(focused_id);
                self.driver.set_thinking(level.clone(), target);
            }
            ClientMessage::SetFacet { facet, session_id } => {
                let target = session_id.clone().or(focused_id);
                self.driver.set_facet(facet.clone(), target);
            }
            ClientMessage::SetPermissionMonitor { mode, session_id } => {
                let target = session_id.clone().or(focused_id);
                self.driver.set_permission_monitor(*mode, target);
            }
            ClientMessage::ToggleAdventurousHandoff { session_id } => {
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                self.hub_ops.enqueue(
                    "toggle_adventurous_handoff",
                    Box::new(move |_hub| {
                        Box::pin(async move { driver.toggle_adventurous_handoff(target).await })
                    }),
                );
            }
            ClientMessage::SetNotificationAutodrain {
                enabled,
                session_id,
            } => {
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                let enabled = *enabled;
                self.hub_ops.enqueue(
                    "set_notification_autodrain",
                    Box::new(move |_hub| {
                        Box::pin(
                            async move { driver.set_notification_autodrain(enabled, target).await },
                        )
                    }),
                );
            }
            ClientMessage::Compact { session_id } => {
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                self.hub_ops.enqueue(
                    "compact",
                    Box::new(move |_hub| Box::pin(async move { driver.compact(target).await })),
                );
            }
            ClientMessage::ClearContext { session_id } => {
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                self.hub_ops.enqueue(
                    "clear_context",
                    Box::new(move |_hub| {
                        Box::pin(async move { driver.clear_context(target).await })
                    }),
                );
            }
            ClientMessage::SetMcpServer {
                server_name,
                action,
                session_id,
            } => {
                let target = session_id.clone().or(focused_id);
                let driver = self.driver.clone();
                let server_name = server_name.clone();
                let action = *action;
                self.hub_ops.enqueue(
                    "set_mcp_server",
                    Box::new(move |_hub| {
                        Box::pin(
                            async move { driver.set_mcp_server(server_name, action, target).await },
                        )
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
                                    result.seed
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
                                    driver_for_prompt
                                        .prompt(
                                            prompt_text.unwrap_or_default(),
                                            None,
                                            Some(sid.clone()),
                                            first_images,
                                            pid.clone(),
                                        )
                                        .await;
                                    let msg = ServerMessage::PromptResult {
                                        prompt_id: pid.unwrap_or_default(),
                                        accepted: true,
                                        session_id: Some(sid),
                                        error: None,
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
            ClientMessage::QueryFiles { query, cwd } => {
                let driver = self.driver.clone();
                let focused = focused_id.clone();
                let query = query.clone();
                let cwd = cwd.clone();
                self.hub_ops.enqueue(
                    "query_files",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let files = driver.list_files(query.clone(), focused, cwd).await;
                            let h = hub.lock();
                            h.send_to_client(client_key, ServerMessage::FileList { query, files });
                        })
                    }),
                );
            }
            ClientMessage::QueryDir { path } => {
                let driver = self.driver.clone();
                let path = path.clone();
                self.hub_ops.enqueue(
                    "query_dir",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let listing = driver.list_dir(path.clone()).await;
                            let h = hub.lock();
                            h.send_to_client(client_key, ServerMessage::DirListing { listing });
                        })
                    }),
                );
            }
            ClientMessage::StatPath { path } => {
                let driver = self.driver.clone();
                let path = path.clone();
                self.hub_ops.enqueue(
                    "stat_path",
                    Box::new(move |hub| {
                        Box::pin(async move {
                            let stat = driver.stat_path(path.clone()).await;
                            let h = hub.lock();
                            h.send_to_client(client_key, ServerMessage::PathStat { stat });
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
                    let _ = crate::settings_store::write_pilot_settings(
                        dir,
                        &crate::settings_store::PartialSettings {
                            login_shell: Some(shell),
                            background_model: None,
                            enabled_extensions: None,
                        },
                    );
                }
                self.broadcast(self.pilot_settings_msg());
            }
            ClientMessage::SetBackgroundModel { spec } => {
                let model_spec = spec
                    .as_ref()
                    .map(|p| p.trim())
                    .filter(|p| !p.is_empty())
                    .map(|s| s.to_string());
                if let Some(dir) = &self.data_dir {
                    let _ = crate::settings_store::write_pilot_settings(
                        dir,
                        &crate::settings_store::PartialSettings {
                            login_shell: None,
                            background_model: Some(model_spec),
                            enabled_extensions: None,
                        },
                    );
                }
                self.broadcast(self.pilot_settings_msg());
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
                if let Some(dir) = &self.data_dir {
                    // Spawn the platform file manager (Finder/xdg-open/explorer)
                    let dir_str = dir.display().to_string();
                    #[cfg(unix)]
                    {
                        let cmd = if cfg!(target_os = "macos") {
                            "open"
                        } else {
                            "xdg-open"
                        };
                        let _ = std::process::Command::new(cmd).arg(&dir_str).spawn();
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
        sessions: Vec<pilot_protocol::session_driver::SessionListEntry>,
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
        self.available_models = models.clone();
        self.broadcast(ServerMessage::ModelList { models });
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
                    let mut h = hub.lock();
                    h.available_models = models.clone();
                    h.broadcast(ServerMessage::ModelList { models });
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
            let key = serde_json::to_string(&usage).unwrap_or_default();
            if self
                .last_usage_emitted
                .get(&sid)
                .map(|k| k == &key)
                .unwrap_or(false)
            {
                continue;
            }
            self.last_usage_emitted.insert(sid.clone(), key);

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

    /// Build the pilot-local-settings message: persisted settings + login-env
    /// status + background-model warning.
    fn pilot_settings_msg(&self) -> ServerMessage {
        let settings = self
            .data_dir
            .as_ref()
            .map(|dir| crate::settings_store::read_pilot_settings(dir))
            .unwrap_or_default();
        // Login env status is a stub for now — the real implementation needs
        // the login-env shared module (Phase 5).
        let env = pilot_protocol::wire::LoginEnvStatus {
            active_shell: None,
            ok: false,
            detail: None,
        };
        ServerMessage::PilotSettings {
            settings,
            env,
            pending_restart: false,
            background_model_warning: None,
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
        let seed = swap(hub.clone()).await;
        {
            let mut h = hub.lock();
            h.swaps_in_flight = h.swaps_in_flight.saturating_sub(1);
        }

        // ── Fold the seed + set up journal/focus
        let sid = finish_switch(&hub, client_key, seed, reseed, retry_on_raced_events).await;

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

fn is_dialog_request(request: &HostUiRequest) -> bool {
    matches!(
        request.kind(),
        "confirm" | "select" | "input" | "editor" | "qna" | "permission"
    )
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
    use pilot_protocol::session_driver::{
        SessionConfig, SessionEventBase, SessionMessageDeliveryMode,
    };
    use pilot_protocol::state::TranscriptItem;
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
    ) -> Vec<pilot_protocol::session_driver::SessionQueuedMessage> {
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
        assert!(failed.is_empty());
        assert_eq!(driver.list_sessions().await.len(), before.len());

        let succeeded = driver
            .new_session(NewSessionOptsData {
                cwd: Some("/second".into()),
                ..Default::default()
            })
            .await;
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
            .await;
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
        // connect_facet_list, connect_file_index, connect_model_defaults.
        for _ in 0..6 {
            apply_one(hub.clone(), &mut hub_ops).await;
        }

        let model_list = drain_until(&mut rx, |msg| {
            matches!(msg, ServerMessage::ModelList { .. })
        })
        .await;
        match model_list {
            ServerMessage::ModelList { models } => {
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
    async fn set_model_and_thinking_emit_config_snapshots() {
        // Back-fills TS MockDriver semantics from `server/src/mock-driver.ts:810`:
        // setModel/setThinking mutate current config and emit sessionUpdated.
        let (_driver, hub, _hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);

        hub.lock().handle_client(
            client_key,
            ClientMessage::SetModel {
                provider: "deepseek".into(),
                model_id: "deepseek-v4-flash".into(),
                session_id: None,
            },
        );
        let config = receive_session_config(&mut rx).await;
        assert_eq!(config.provider.as_deref(), Some("deepseek"));
        assert_eq!(config.model_id.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(config.thinking_level.as_deref(), Some("medium"));

        hub.lock().handle_client(
            client_key,
            ClientMessage::SetThinking {
                level: "high".into(),
                session_id: None,
            },
        );
        let config = receive_session_config(&mut rx).await;
        assert_eq!(config.provider.as_deref(), Some("deepseek"));
        assert_eq!(config.model_id.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(config.thinking_level.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn compact_and_clear_context_route_to_driver() {
        // There is no TS hub test asserting that a `compact`/`clearContext`
        // ClientMessage reaches `driver.compact`/`driver.clear_context` (the TS
        // hub tests cover unrelated attention/ring paths). This is the test-first
        // net for the routing path in `hub.rs:handle_client`: the hub enqueues a
        // `compact`/`clear_context` hub op that calls the driver method, and the
        // MockDriver overrides emit a `usageUpdated` we can observe on the wire.
        // (The mock-override behavior itself is covered by the e2e suite; this is
        // only the routing assertion.)
        let (_driver, hub, mut hub_ops) = test_hub();
        let (client_key, _tx, mut rx) = hub.lock().add_client(None);

        // compact → driver.compact → usageUpdated { tokens: 8000, percent: 4 }
        hub.lock().handle_client(
            client_key,
            ClientMessage::Compact {
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

        // clearContext → driver.clear_context → usageUpdated { tokens: 0, percent: 0 }
        hub.lock().handle_client(
            client_key,
            ClientMessage::ClearContext {
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
        // `PilotDriver` trait gives `reload_session` a default impl returning an
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
}
