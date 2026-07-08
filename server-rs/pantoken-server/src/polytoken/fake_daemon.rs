//! An in-process fake polytoken daemon, driven by the frozen corpus.
//!
//! Replays a `ScenarioFile` over a real ephemeral axum port speaking the same
//! wire protocol as the real daemon: HTTP endpoints return recorded responses,
//! and `GET /events` streams the scenario's SSE frames as `text/event-stream`.
//! The spawn-override seam (`daemon_client::set_spawn_override`) points
//! `PolytokenDriver` at this port instead of launching a process, so the live
//! driver stack (`warm_session` → `DaemonClient` → `event_map`) runs end-to-end
//! against deterministic fixtures.
//!
//! Endpoints the corpus records (`/state`, `/history`, `/prompt`, `/turn/input`)
//! are replayed from the `http[]` entries in first-match order. Endpoints the
//! driver calls but the corpus did NOT record (`/health`, `/tui-attachment/claim`,
//! `/terminate`, etc.) get a minimal canned OK response sufficient for
//! `warm_session` to reach "healthy + lease claimed". An UNMATCHED recorded-style
//! request fails loud (500 + logged) — a missing recording is a harness bug to
//! surface, not swallow.
//!
//! `recorded_calls()` exposes every `(method, path)` the driver made, so tests
//! can assert e.g. `GET /state` / `GET /turn/input` fired after an effect.
//
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::{
    Router,
    extract::{Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::{any, get},
};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::polytoken::corpus::{self, ScenarioFile};
use crate::polytoken::daemon_client::{
    SpawnDaemonOpts, SpawnedDaemon, clear_spawn_override, set_spawn_override,
};

/// Per-frame delay between SSE frames pushed by `FakeControlHub::run_script`
/// (controlled mode). Widens the window in which mid-flow UI (the queue tray,
/// a working indicator) is observable by the dev surface + e2e assertions. See
/// the push loop for rationale.
const CONTROLLED_INTER_FRAME_DELAY_MS: u64 = 8;

/// One canned response for a lifecycle endpoint the corpus doesn't record.
fn canned(method: &str, path: &str) -> Option<(StatusCode, Value)> {
    let (m, p) = (method, path);
    // GET /health — minimal healthy body. `HealthResponse` requires several
    // fields; we supply a valid-shaped record so `health()` returns status 200
    // with parseable data.
    if m == "GET" && p == "/health" {
        return Some((
            StatusCode::OK,
            serde_json::json!({
                "last_heartbeat_at": "1970-01-01T00:00:00.000Z",
                "parent_session_id": {"workspace_id": "ws", "session_id": "SESSION"},
                "pid": 1,
                "port": 0,
                "project_path": "/PROJECT",
                "session_id": "SESSION",
                "started_at": "1970-01-01T00:00:00.000Z",
            }),
        ));
    }
    // POST /tui-attachment/claim — `TuiAttachClaimResponse`.
    if m == "POST" && p == "/tui-attachment/claim" {
        return Some((
            StatusCode::OK,
            serde_json::json!({
                "expires_after_seconds": 300,
                "expires_at": "1970-01-01T00:05:00.000Z",
                "heartbeat_interval_seconds": 5,
                "lease_id": "lease-1",
            }),
        ));
    }
    // POST /tui-attachment/heartbeat — ack.
    if m == "POST" && p == "/tui-attachment/heartbeat" {
        return Some((StatusCode::OK, serde_json::json!({"ok": true})));
    }
    // POST /tui-attachment/release + /terminate — best-effort cleanup acks.
    if m == "POST" && (p == "/tui-attachment/release" || p == "/terminate") {
        return Some((StatusCode::OK, serde_json::json!({"ok": true})));
    }
    // POST /model — acknowledge model/thinking switches. Tests inspect the
    // recorded body to verify the driver sent the daemon's full registry key.
    if m == "POST" && p == "/model" {
        return Some((StatusCode::OK, serde_json::json!({"ok": true})));
    }
    // GET /turn/input — the RefetchQueue effect's snapshot fetch. The corpus
    // doesn't record /turn/input (the queue-while-in-flight scenario triggers
    // a RefetchQueue but the capture didn't snapshot it), so serve a canned
    // PendingTurnInputSnapshot with one queued item so the driver can build a
    // QueueUpdated. (Tests that assert on the real queue contents use a
    // synthetic scenario instead.)
    if m == "GET" && p == "/turn/input" {
        return Some((
            StatusCode::OK,
            serde_json::json!({
                "items": [
                    {"id": "q1", "content": "queued-turn-text", "admission_prompt_id": "PROMPT_0"}
                ],
                "queue_revision": 2
            }),
        ));
    }
    None
}

/// The mutable harness state: the recorded-call log + the per-endpoint replay
/// cursors (so a repeated `GET /state` returns the NEXT recording, not a stale
/// first one — the corpus records multiple `/state` snapshots across a turn).
#[derive(Default)]
struct FakeState {
    /// Every `(METHOD, path)` the driver called, in arrival order.
    calls: Vec<(String, String)>,
    /// Every `(METHOD, path, body)` the driver called, in arrival order.
    request_bodies: Vec<(String, String, String)>,
    /// Per `(METHOD, path)` → index into the scenario's matching `http[]`
    /// entries (so repeated calls advance through the recordings).
    cursors: HashMap<(String, String), usize>,
    /// Controlled-mode SSE sender. Present after GET /events connects; reset
    /// replaces it so a reset mid-stream cannot corrupt a later producer.
    sse_tx: Option<mpsc::Sender<Result<Event, std::convert::Infallible>>>,
    /// The active HTTP-replay scenario. In controlled (fake-mode) use this
    /// starts as the idle bootstrap scenario, then `run_script` swaps in the
    /// chosen flow's recordings (and resets cursors) so that flow's in-turn
    /// `FetchState`/`RefetchQueue` calls serve its own recorded responses
    /// (post-turn usage/title, the queue snapshot, etc.) rather than the
    /// bootstrap's idle body. `None` on the one-shot `spawn` path, which keeps
    /// reading the spawn-time `AppState.scenario`.
    scenario_override: Option<Arc<ScenarioFile>>,
}

/// The public handle returned by `spawn`. Owns the running server task + the
/// shared recorded-call log.
pub struct FakeDaemon {
    pub port: u16,
    pub session_id: String,
    state: Arc<Mutex<FakeState>>,
    /// Abort the server task on drop so the ephemeral port is released.
    _serve: tokio::task::JoinHandle<()>,
}

impl FakeDaemon {
    /// Every `(method, path)` the driver has made so far, in arrival order.
    pub fn recorded_calls(&self) -> Vec<(String, String)> {
        self.state.lock().calls.clone()
    }

    /// Every `(method, path, body)` the driver has made so far, in arrival order.
    pub fn recorded_request_bodies(&self) -> Vec<(String, String, String)> {
        self.state.lock().request_bodies.clone()
    }

    /// True iff the driver made a call matching `method` + `path`.
    pub fn called(&self, method: &str, path: &str) -> bool {
        self.state
            .lock()
            .calls
            .iter()
            .any(|(m, p)| m == method && p == path)
    }

    /// Swap the HTTP-replay scenario to `scenario` and reset the replay
    /// cursors + call log, so the chosen flow's in-turn HTTP fetches
    /// (`FetchState`→`/state`, `RefetchQueue`→`/turn/input`, a `Reseed`→
    /// `/history`) serve that flow's recorded responses. Used by
    /// `FakeControlHub::run_script` to arm a flow before pushing its SSE
    /// frames. Controlled-mode only (one-shot `spawn` does not swap).
    fn arm_scenario(&self, scenario: Arc<ScenarioFile>) {
        let mut st = self.state.lock();
        st.scenario_override = Some(scenario);
        st.cursors.clear();
        st.calls.clear();
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self._serve.abort();
    }
}

/// Query params captured for path matching (the corpus paths are query-free, so
/// we match on the path component only). Kept for future richer matching.
#[derive(Debug, serde::Deserialize)]
struct QueryParams {
    #[serde(default)]
    #[allow(dead_code)]
    rest: HashMap<String, String>,
}

#[derive(Clone)]
enum SseMode {
    OneShot { inter_frame_delay_ms: u64 },
    Controlled,
}

/// Spawn a fake daemon serving `scenario` on an ephemeral port.
///
/// `session_id` is what the spawn-override reports back to the driver (it
/// becomes the `PolytokenDriver`'s session id). The `inter_frame_delay_ms`
/// controls the SSE pacing — a tiny nonzero delay exercises the per-event
/// ordering invariant without slowing the common case.
pub async fn spawn(
    scenario: ScenarioFile,
    session_id: String,
    inter_frame_delay_ms: u64,
) -> FakeDaemon {
    spawn_with_mode(
        scenario,
        session_id,
        SseMode::OneShot {
            inter_frame_delay_ms,
        },
    )
    .await
}

async fn spawn_controlled(scenario: ScenarioFile, session_id: String) -> Arc<FakeDaemon> {
    Arc::new(spawn_with_mode(scenario, session_id, SseMode::Controlled).await)
}

/// The idle landing scenario for a fake-mode bootstrap session: an empty
/// transcript with `turn_in_flight:false`, so the seeded `sessionOpened`
/// snapshot is `Idle` and the composer renders its placeholder. No corpus
/// scenario represents this (they are all active-flow captures); this is the
/// only synthetic fixture the fake daemon needs. The SSE list is empty —
/// controlled mode holds the stream open for `run_script` to push a chosen
/// flow's frames. The version is threaded in only for the `ScenarioFile`
/// field; the body must deserialize as a full `SessionStateSnapshot`
/// (mirroring `synthetic_idle_scenario` in tests/live_path.rs).
fn bootstrap_scenario(version: &str) -> ScenarioFile {
    let json_str = serde_json::json!({
        "scenario": "bootstrap-idle",
        "version": version,
        "description": "idle empty landing session for fake-mode bootstrap",
        "canonicalization": {
            "session_id": "SESSION",
            "prompt_ids": {},
            "timestamps": "monotonic-from-T0"
        },
        "http": [
            { "method": "GET", "path": "/state", "status": 200,
              "response_body": {
                  "session_title": "fake",
                  "todos": [],
                  "flags": [],
                  "env": {},
                  "project_cwd": "/fake",
                  "active_facet": "execute",
                  "plugin_config": {},
                  "turn_in_flight": false
              } },
            { "method": "GET", "path": "/history", "status": 200,
              "response_body": {
                  "items": [], "offset": 0, "total_projected_items": 0,
                  "history_revision": 0, "session_id": "SESSION"
              } }
        ],
        "sse": [],
        "expected_driver_events": null
    })
    .to_string();
    serde_json::from_str::<ScenarioFile>(&json_str).expect("parse bootstrap scenario")
}

async fn spawn_with_mode(
    scenario: ScenarioFile,
    session_id: String,
    sse_mode: SseMode,
) -> FakeDaemon {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let port = listener.local_addr().expect("local_addr").port();
    let state = Arc::new(Mutex::new(FakeState::default()));
    let scenario = Arc::new(scenario);

    let app = build_router(state.clone(), scenario.clone(), sse_mode);

    let serve = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .expect("fake daemon serve");
    });

    FakeDaemon {
        port,
        session_id,
        state,
        _serve: serve,
    }
}

#[derive(Clone)]
pub struct FakeControlHub {
    inner: Arc<FakeControlInner>,
}

struct FakeControlInner {
    version: String,
    scenarios: HashMap<String, ScenarioFile>,
    sessions: Mutex<HashMap<String, Arc<FakeDaemon>>>,
    spawned: Mutex<Vec<Arc<FakeDaemon>>>,
}

impl FakeControlHub {
    pub fn load_default() -> Self {
        let version = corpus::sole_version();
        let mut scenarios = HashMap::new();
        for file in corpus::scenario_files(&version) {
            let scenario = corpus::load_scenario(&file);
            scenarios.insert(scenario.scenario.clone(), scenario);
        }
        Self {
            inner: Arc::new(FakeControlInner {
                version,
                scenarios,
                sessions: Mutex::new(HashMap::new()),
                spawned: Mutex::new(Vec::new()),
            }),
        }
    }

    pub async fn spawn_session(&self, session_prefix: &str) -> Arc<FakeDaemon> {
        let idx = self.inner.spawned.lock().len() + 1;
        let session_id = format!("{session_prefix}-{idx}");
        // The bootstrap session is the idle landing session the hub adopts at boot
        // and after each `/debug/reset`: an empty transcript with the composer
        // interactive (turn_in_flight:false). It must NOT reuse a corpus scenario —
        // every recorded scenario is an active-flow capture (streaming/abort/etc.),
        // and `reconnect-stream-discontinuity` even reports `turn_in_flight: true`
        // in its first /state recording, which would seed a Running snapshot and
        // leave the composer stuck on "Working…" (the dev surface drives a chosen
        // flow's SSE later via run_script, over this held-open idle stream).
        let scenario = bootstrap_scenario(&self.inner.version);
        let fake = spawn_controlled(scenario, session_id.clone()).await;
        self.inner
            .sessions
            .lock()
            .insert(session_id.clone(), fake.clone());
        self.inner.spawned.lock().push(fake.clone());
        fake
    }

    pub fn reset(&self) {
        // Clear the HTTP replay cursors + call log, but KEEP the held-open SSE
        // sender: the driver keeps its warm session (and SSE subscription) across
        // a dev-surface reset, so dropping the sender here would force a reconnect
        // a follow-up `run_script` would race. The driver-side accumulator reset
        // (PolytokenDriver::reset) is what clears stale fold state.
        //
        // Also drop any `run_script`-armed scenario override: a reset re-adopts
        // the idle bootstrap session, so the post-reset reseed's `GET /state`
        // must serve the idle body (not a previous flow's post-turn recording).
        for fake in self.inner.sessions.lock().values() {
            let mut state = fake.state.lock();
            state.calls.clear();
            state.cursors.clear();
            state.scenario_override = None;
        }
    }

    pub async fn run_script(&self, name: &str) -> Result<(), String> {
        let scenario_name = match name {
            "stream" | "reply" | "streaming-turn" => "streaming-turn",
            "queue" | "queue-while-in-flight" => "queue-while-in-flight",
            "abort" => "abort",
            "ask" | "ask-user-question" => "ask-user-question",
            "approve" | "tool" | "tool-call-approval" => "tool-call-approval",
            other => return Err(format!("unknown fake script: {other}")),
        };
        let scenario = self
            .inner
            .scenarios
            .get(scenario_name)
            .ok_or_else(|| format!("fake scenario missing: {scenario_name}"))?
            .clone();
        let fake = self
            .inner
            .spawned
            .lock()
            .last()
            .cloned()
            .ok_or_else(|| "no fake session spawned".to_string())?;
        // Arm this flow's HTTP recordings before pushing its SSE frames, so the
        // in-turn `FetchState`/`RefetchQueue`/`Reseed` effects the frames will
        // trigger serve the flow's own recorded responses (post-turn usage, the
        // queue snapshot, etc.) — not the bootstrap's idle body. Without this
        // the second `GET /state` (on `message_complete`) would 500 on cursor
        // exhaustion against the single-recording bootstrap scenario.
        fake.arm_scenario(Arc::new(scenario.clone()));
        // The driver's SSE subscription connects asynchronously, so a script
        // pushed right after boot/reset can arrive before `GET /events` has
        // registered its held-open sender. Poll briefly (up to ~2s) rather than
        // failing the push on that race.
        let tx = {
            let mut tx = None;
            for _ in 0..100 {
                if let Some(sender) = fake.state.lock().sse_tx.clone() {
                    tx = Some(sender);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            tx.ok_or_else(|| "fake SSE stream not connected".to_string())?
        };
        for frame in scenario.sse {
            tx.send(Ok(frame_to_event(&frame)))
                .await
                .map_err(|_| "fake SSE stream disconnected".to_string())?;
            // Pace the controlled push so intermediate states are observable:
            // the corpus flows are live captures that run to completion, and a
            // back-to-back push makes transient UI (e.g. the queue tray,
            // populated mid-flight then drained before the turn ends) appear
            // and vanish within a sub-millisecond window the client never
            // renders. A small inter-frame delay widens that window so the
            // dev surface (and a bounded `expect.poll` assertion) can observe
            // mid-flow DOM, and it exercises the live SSE fold path at a
            // realistic cadence rather than a zero-delay burst.
            tokio::time::sleep(std::time::Duration::from_millis(
                CONTROLLED_INTER_FRAME_DELAY_MS,
            ))
            .await;
        }
        Ok(())
    }
}

pub fn install_fake_spawn(control: FakeControlHub) {
    set_spawn_override(Arc::new(move |_bin: &str, _opts: SpawnDaemonOpts| {
        let control = control.clone();
        Box::pin(async move {
            let fake = control.spawn_session("fake").await;
            Ok((
                SpawnedDaemon {
                    session_id: fake.session_id.clone(),
                    port: fake.port,
                    auth_token: None,
                },
                None,
            ))
        })
    }));
}

/// A single fake spawned by [`MultiSpawnOverrideGuard`]. Kept inspectable so
/// warm-cap tests can compare ports/session ids and per-daemon call logs.
#[derive(Clone)]
pub struct SpawnedFakeDaemon {
    pub session_id: String,
    pub port: u16,
    fake: Arc<FakeDaemon>,
}

impl std::fmt::Debug for SpawnedFakeDaemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnedFakeDaemon")
            .field("session_id", &self.session_id)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl SpawnedFakeDaemon {
    /// Every `(method, path)` the driver made to this fake, in arrival order.
    pub fn recorded_calls(&self) -> Vec<(String, String)> {
        self.fake.recorded_calls()
    }

    /// True iff the driver made a call matching `method` + `path` to this fake.
    pub fn called(&self, method: &str, path: &str) -> bool {
        self.fake.called(method, path)
    }
}

#[derive(Default)]
struct MultiSpawnState {
    spawned: Vec<SpawnedFakeDaemon>,
    opts: Vec<SpawnDaemonOpts>,
    warm: BTreeSet<String>,
    closed: BTreeSet<String>,
}

/// Inspectable handle for a multi-spawn override. Clone it into the test body;
/// the guard owns override cleanup, while this handle exposes what happened.
#[derive(Clone)]
pub struct MultiSpawnHandle {
    state: Arc<Mutex<MultiSpawnState>>,
}

impl MultiSpawnHandle {
    /// Fakes spawned so far, in spawn/new-session order.
    pub fn spawned(&self) -> Vec<SpawnedFakeDaemon> {
        self.state.lock().spawned.clone()
    }

    /// `SpawnDaemonOpts` captured for each override invocation.
    pub fn captured_opts(&self) -> Vec<SpawnDaemonOpts> {
        self.state.lock().opts.clone()
    }

    /// Session ids the test observed as still warm. Phase 5 can feed this with
    /// the hub/driver-visible warm set after driving `cap+1` sessions.
    pub fn mark_warm_sessions<I>(&self, session_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.state.lock().warm = session_ids.into_iter().collect();
    }

    /// Last warm-set snapshot supplied through [`Self::mark_warm_sessions`].
    pub fn warm_sessions(&self) -> Vec<String> {
        self.state.lock().warm.iter().cloned().collect()
    }

    /// Record session ids whose `SessionClosed` event a test observed.
    pub fn mark_session_closed<I>(&self, session_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        self.state.lock().closed = session_ids.into_iter().collect();
    }

    /// Last `SessionClosed` snapshot supplied through [`Self::mark_session_closed`].
    pub fn session_closed(&self) -> Vec<String> {
        self.state.lock().closed.iter().cloned().collect()
    }
}

/// Multi-spawn override guard: every spawn invocation starts a fresh fake daemon
/// on a fresh ephemeral port and returns its minted session id to the driver.
pub struct MultiSpawnOverrideGuard {
    handle: MultiSpawnHandle,
}

impl MultiSpawnOverrideGuard {
    /// Install a multi-spawn override. The caller must hold the test binary's
    /// process-global override mutex for the full guard lifetime.
    pub fn install(scenario: ScenarioFile, session_prefix: impl Into<String>) -> Self {
        Self::install_with_delay(scenario, session_prefix, 0)
    }

    /// Same as [`Self::install`], with explicit SSE inter-frame delay.
    pub fn install_with_delay(
        scenario: ScenarioFile,
        session_prefix: impl Into<String>,
        inter_frame_delay_ms: u64,
    ) -> Self {
        let state = Arc::new(Mutex::new(MultiSpawnState::default()));
        let handle = MultiSpawnHandle {
            state: state.clone(),
        };
        let session_prefix = session_prefix.into();
        let scenario = Arc::new(scenario);

        set_spawn_override(Arc::new(move |_bin: &str, opts: SpawnDaemonOpts| {
            let state = state.clone();
            let scenario = scenario.clone();
            let session_prefix = session_prefix.clone();
            Box::pin(async move {
                let idx = {
                    let mut state = state.lock();
                    state.opts.push(opts.clone());
                    state.opts.len()
                };
                let session_id = format!("{session_prefix}-{idx}");
                let fake = Arc::new(
                    spawn(
                        (*scenario).clone(),
                        session_id.clone(),
                        inter_frame_delay_ms,
                    )
                    .await,
                );
                let port = fake.port;
                let spawned = SpawnedFakeDaemon {
                    session_id: session_id.clone(),
                    port,
                    fake,
                };
                state.lock().spawned.push(spawned);
                Ok((
                    SpawnedDaemon {
                        session_id,
                        port,
                        auth_token: None,
                    },
                    None,
                ))
            })
        }));

        Self { handle }
    }

    pub fn handle(&self) -> MultiSpawnHandle {
        self.handle.clone()
    }
}

impl Drop for MultiSpawnOverrideGuard {
    fn drop(&mut self) {
        clear_spawn_override();
    }
}

/// Build the axum router. One catch-all `any` handler dispatches recorded vs
/// canned vs unmatched; `GET /events` is a dedicated SSE route.
fn build_router(
    state: Arc<Mutex<FakeState>>,
    scenario: Arc<ScenarioFile>,
    sse_mode: SseMode,
) -> Router {
    Router::new()
        .route("/events", get(sse_handler))
        .fallback(any(http_handler))
        .with_state(AppState {
            state,
            scenario,
            sse_mode,
        })
}

#[derive(Clone)]
struct AppState {
    state: Arc<Mutex<FakeState>>,
    scenario: Arc<ScenarioFile>,
    sse_mode: SseMode,
}

fn frame_to_event(frame: &corpus::SseFrame) -> Event {
    let mut event =
        Event::default().data(serde_json::to_string(frame).expect("serialize sse frame"));
    if let Some(seq) = frame.seq {
        event = event.id(seq.to_string());
    }
    event
}

/// The SSE handler: one-shot test mode streams the spawn scenario immediately;
/// controlled fake mode holds the stream open and waits for `FakeControl` pushes.
async fn sse_handler(
    State(app): State<AppState>,
) -> Sse<ReceiverStream<Result<Event, std::convert::Infallible>>> {
    let (tx, rx) = mpsc::channel::<Result<Event, std::convert::Infallible>>(64);
    match app.sse_mode.clone() {
        SseMode::OneShot {
            inter_frame_delay_ms,
        } => {
            let frames = app.scenario.sse.clone();
            tokio::spawn(async move {
                for frame in frames {
                    if tx.send(Ok(frame_to_event(&frame))).await.is_err() {
                        break;
                    }
                    if inter_frame_delay_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(inter_frame_delay_ms))
                            .await;
                    }
                }
            });
        }
        SseMode::Controlled => {
            app.state.lock().sse_tx = Some(tx);
        }
    }
    Sse::new(ReceiverStream::new(rx))
}

/// The catch-all HTTP handler: record the call, then resolve a response from
/// the canned set, the recorded `http[]` entries, or fail loud (500).
async fn http_handler(
    State(app): State<AppState>,
    Query(_q): Query<QueryParams>,
    req: Request,
) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let request_body = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default();

    // Record the call (lock held only for the push + cursor advance).
    let (status, body) = {
        let mut st = app.state.lock();
        st.calls.push((method.clone(), path.clone()));
        st.request_bodies
            .push((method.clone(), path.clone(), request_body));
        // Canned lifecycle endpoints win over recordings (the corpus never
        // records them, and a recording would be stale/malformed for them).
        if let Some((code, val)) = canned(&method, &path) {
            st.cursors.insert((method.clone(), path.clone()), 0);
            (code, Some(val))
        } else {
            // Advance the cursor for this endpoint + return the recording.
            let key = (method.clone(), path.clone());
            let idx = st.cursors.get(&key).copied().unwrap_or(0);
            // Prefer a `run_script`-armed override (the active flow's
            // recordings); fall back to the spawn-time scenario (one-shot
            // `spawn`, or the idle bootstrap before any script is pushed).
            let scenario = st
                .scenario_override
                .clone()
                .unwrap_or_else(|| app.scenario.clone());
            let recording = scenario
                .http
                .iter()
                .filter(|e| e.method == method && e.path == path)
                .nth(idx)
                .cloned();
            if recording.is_some() {
                *st.cursors.entry(key).or_insert(0) = idx + 1;
            }
            let (code, body) = match recording {
                Some(e) => (
                    StatusCode::from_u16(e.status as u16)
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    e.response_body.clone(),
                ),
                None => {
                    // Unmatched — a missing recording is a harness bug.
                    tracing::error!(
                        "fake daemon: unmatched request {} {} (no canned + no recording)",
                        method,
                        path
                    );
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("unmatched request: {method} {path}"),
                    )
                        .into_response();
                }
            };
            (code, body)
        }
    };

    let mut resp = body
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".into()))
        .unwrap_or_default()
        .into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    *resp.status_mut() = status;
    resp
}
