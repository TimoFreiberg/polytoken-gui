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
// `#![allow(dead_code)]`: the `corpus` test binary also compiles `support`
// (because `corpus.rs` declares `mod support;`), but it doesn't use the fake
// daemon — only `live_path.rs` does. Without this, every fake-daemon item warns
// as dead in the corpus binary. The live_path binary uses them all.
#![allow(dead_code)]

use std::collections::BTreeSet;
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
use tokio_stream::wrappers::ReceiverStream;

use pilot_server::polytoken::daemon_client::{
    SpawnDaemonOpts, SpawnedDaemon, clear_spawn_override, set_spawn_override,
};

use super::corpus::ScenarioFile;

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
    /// Per `(METHOD, path)` → index into the scenario's matching `http[]`
    /// entries (so repeated calls advance through the recordings).
    cursors: std::collections::HashMap<(String, String), usize>,
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

    /// True iff the driver made a call matching `method` + `path`.
    pub fn called(&self, method: &str, path: &str) -> bool {
        self.state
            .lock()
            .calls
            .iter()
            .any(|(m, p)| m == method && p == path)
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
    rest: std::collections::HashMap<String, String>,
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
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let port = listener.local_addr().expect("local_addr").port();
    let state = Arc::new(Mutex::new(FakeState::default()));
    let scenario = Arc::new(scenario);

    let app = build_router(state.clone(), scenario.clone(), inter_frame_delay_ms);

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
                Ok((SpawnedDaemon { session_id, port }, None))
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
    inter_frame_delay_ms: u64,
) -> Router {
    Router::new()
        .route("/events", get(sse_handler))
        .fallback(any(http_handler))
        .with_state(AppState {
            state,
            scenario,
            inter_frame_delay_ms,
        })
}

#[derive(Clone)]
struct AppState {
    state: Arc<Mutex<FakeState>>,
    scenario: Arc<ScenarioFile>,
    inter_frame_delay_ms: u64,
}

/// The SSE handler: stream the scenario's frames as `id:`/`data:` lines, with
/// an optional inter-frame delay. The frames are cloned up front (the stream
/// owns them) so the scenario `Arc` can be read concurrently.
async fn sse_handler(
    State(app): State<AppState>,
) -> Sse<ReceiverStream<Result<Event, std::convert::Infallible>>> {
    let frames = app.scenario.sse.clone();
    let delay = app.inter_frame_delay_ms;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, std::convert::Infallible>>(64);
    tokio::spawn(async move {
        for frame in frames {
            let mut event =
                Event::default().data(serde_json::to_string(&frame).expect("serialize sse frame"));
            if let Some(seq) = frame.seq {
                event = event.id(seq.to_string());
            }
            // A send failure means the client disconnected — stop streaming.
            if tx.send(Ok(event)).await.is_err() {
                break;
            }
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
    });
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

    // Record the call (lock held only for the push + cursor advance).
    let (status, body) = {
        let mut st = app.state.lock();
        st.calls.push((method.clone(), path.clone()));
        // Canned lifecycle endpoints win over recordings (the corpus never
        // records them, and a recording would be stale/malformed for them).
        if let Some((code, val)) = canned(&method, &path) {
            st.cursors.insert((method.clone(), path.clone()), 0);
            (code, Some(val))
        } else {
            // Advance the cursor for this endpoint + return the recording.
            let key = (method.clone(), path.clone());
            let idx = st.cursors.get(&key).copied().unwrap_or(0);
            let recording = app
                .scenario
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
