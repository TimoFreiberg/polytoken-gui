//! The fake daemon: an in-process axum router that implements the daemon wire
//! protocol using fixture data. Runs when `PILOT_DRIVER=mock`.
//!
//! Uses the "passthrough" approach: emits `DaemonEvent::Passthrough` carrying
//! a pre-mapped `SessionDriverEvent`. The event_map recognizes this and emits
//! the pilot event directly, bypassing the accumulator.

#![allow(dead_code)]

use std::sync::Arc;

use axum::{extract::State, response::{IntoResponse, Response}, routing::{get, post, delete}, Json, Router, http::StatusCode};
use parking_lot::Mutex;
use pilot_daemon_types as dt;
use pilot_protocol::session_driver::{self as psd, SessionSnapshot};
use serde_json::json;
use tokio::sync::broadcast;
use tracing::warn;
use tokio_stream::StreamExt;

pub const MOCK_SESSION_ID: &str = "mock-session";

// ── Fixture data ───────────────────────────────────────────────────────

pub fn mock_models() -> Vec<psd::ModelOption> {
    vec![
        psd::ModelOption { provider: "anthropic".into(), model_id: "anthropic/claude-sonnet-4-6".into(), label: "Claude Sonnet 4.6".into(), thinking_levels: None },
        psd::ModelOption { provider: "anthropic".into(), model_id: "anthropic/claude-haiku-4-0".into(), label: "Claude Haiku 4.0".into(), thinking_levels: None },
        psd::ModelOption { provider: "openai".into(), model_id: "openai/o3".into(), label: "o3".into(), thinking_levels: None },
        psd::ModelOption { provider: "openai".into(), model_id: "openai/gpt-4.1".into(), label: "GPT-4.1".into(), thinking_levels: None },
    ]
}

pub fn mock_files() -> Vec<psd::FileInfo> {
    vec![
        psd::FileInfo { path: "src/main.rs".into(), is_directory: false },
        psd::FileInfo { path: "src/lib.rs".into(), is_directory: false },
        psd::FileInfo { path: "Cargo.toml".into(), is_directory: false },
        psd::FileInfo { path: "README.md".into(), is_directory: false },
        psd::FileInfo { path: "tests/".into(), is_directory: true },
    ]
}

pub fn mock_health_response() -> dt::HealthResponse {
    dt::HealthResponse {
        pid: std::process::id() as i32,
        port: 0,
        session_id: MOCK_SESSION_ID.into(),
        session_title: Some("Mock Session".into()),
        project_path: "/home/user/project".into(),
        started_at: "2025-01-01T00:00:00Z".into(),
        last_heartbeat_at: "2025-01-01T00:00:00Z".into(),
        parent_session_id: dt::SessionRef::Standalone,
        process_start_token: None,
    }
}

pub fn mock_state_snapshot() -> dt::SessionStateSnapshot {
    dt::SessionStateSnapshot {
        active_facet: "code".into(),
        active_model: Some("anthropic/claude-sonnet-4-6".into()),
        active_plan: None,
        active_reasoning_effort: None,
        adventurous_handoff_active: Some(false),
        available_models: None,
        available_skills: None,
        available_subagents: None,
        context_usage: None,
        current_goal: None,
        cwd: None,
        cwd_stack_depth: None,
        env: std::collections::HashMap::new(),
        flags: Vec::new(),
        latest_compaction_summary: None,
        mcp_servers: None,
        most_recent_assistant_text: None,
        pending_interrogatives: None,
        plugin_config: serde_json::Value::Null,
        project_cwd: None,
        session_title: Some("Mock Session".into()),
        source_control: None,
        symlink_warnings: None,
        todos: Vec::new(),
        turn_in_flight: None,
    }
}

// ── Fake daemon state ──────────────────────────────────────────────────

#[derive(Clone)]
struct FakeDaemonState {
    event_tx: broadcast::Sender<dt::SseEnvelope>,
    state: Arc<Mutex<dt::SessionStateSnapshot>>,
    next_seq: Arc<Mutex<i64>>,
}

impl FakeDaemonState {
    fn new() -> Self {
        let (event_tx, _) = broadcast::channel(256);
        Self {
            event_tx,
            state: Arc::new(Mutex::new(mock_state_snapshot())),
            next_seq: Arc::new(Mutex::new(0)),
        }
    }

    fn next_seq(&self) -> Option<i64> {
        let mut seq = self.next_seq.lock();
        *seq += 1;
        Some(*seq)
    }

    fn emit_passthrough(&self, event: psd::SessionDriverEvent) {
        let envelope = dt::SseEnvelope {
            seq: self.next_seq(),
            emitted_at: "2025-01-01T00:00:00Z".into(),
            session_id: MOCK_SESSION_ID.into(),
            event: dt::DaemonEvent::Passthrough { pilot_event: event },
        };
        let _ = self.event_tx.send(envelope);
    }
}

// ── Axum router ────────────────────────────────────────────────────────

pub fn fake_daemon_router() -> Router {
    let state = Arc::new(FakeDaemonState::new());

    Router::new()
        .route("/health", get(health))
        .route("/terminate", post(terminate))
        .route("/tui-attachment/claim", post(claim_lease))
        .route("/tui-attachment/heartbeat", post(heartbeat))
        .route("/tui-attachment/{id}", delete(release_lease))
        .route("/prompt", post(prompt))
        .route("/turn/cancel", post(cancel_turn))
        .route("/state", get(get_state))
        .route("/history", get(get_history))
        .route("/files", get(get_files))
        .route("/model", post(set_model))
        .route("/title", post(set_title))
        .route("/facet", post(set_facet))
        .route("/clear", post(clear_context))
        .route("/reload", post(reload))
        .route("/rewind", post(rewind))
        .route("/interrogative/{id}/respond", post(respond_interrogative))
        .route("/permission-monitor", get(get_permission_monitor).post(set_permission_monitor))
        .route("/notification-autodrain", get(get_notification_autodrain).post(set_notification_autodrain))
        .route("/adventurous-handoff", get(get_adventurous_handoff).post(toggle_adventurous_handoff))
        .route("/compact", post(compact))
        .route("/mcp/{server}/{action}", post(mcp_action))
        .route("/events", get(events))
        .route("/dev/reset", post(dev_reset))
        .route("/dev/script", post(dev_script))
        .route("/dev/state", get(dev_state))
        .with_state(state)
}

// ── Handlers ───────────────────────────────────────────────────────────

async fn health(State(_s): State<Arc<FakeDaemonState>>) -> Json<dt::HealthResponse> {
    Json(mock_health_response())
}

async fn terminate(State(_s): State<Arc<FakeDaemonState>>) -> StatusCode { StatusCode::OK }

async fn claim_lease(State(_s): State<Arc<FakeDaemonState>>) -> impl IntoResponse {
    Json(json!({ "lease_id": "mock-lease", "heartbeat_interval_ms": 5000, "expires_after_ms": 30000 }))
}

async fn heartbeat(State(_s): State<Arc<FakeDaemonState>>) -> StatusCode { StatusCode::OK }
async fn release_lease(State(_s): State<Arc<FakeDaemonState>>) -> StatusCode { StatusCode::NO_CONTENT }

async fn prompt(State(state): State<Arc<FakeDaemonState>>, Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let prompt_id = body.get("prompt_id").and_then(|v| v.as_str()).unwrap_or("mock-prompt").to_string();
    // Emit a sessionUpdated via passthrough
    let session_ref = psd::SessionRef {
        workspace_id: psd::WorkspaceId::default(),
        session_id: MOCK_SESSION_ID.into(),
    };
    let base = psd::SessionEventBase {
        session_ref: session_ref.clone(),
        timestamp: "2025-01-01T00:00:00Z".into(),
        run_id: None,
    };
    let snap = SessionSnapshot {
        r#ref: session_ref,
        workspace: psd::WorkspaceRef { workspace_id: psd::WorkspaceId::default(), path: "/home/user/project".into(), display_name: None },
        title: "Mock Session".into(),
        status: psd::SessionStatus::Running,
        updated_at: "2025-01-01T00:00:00Z".into(),
        archived_at: None,
        preview: None,
        config: None, usage: None, running_run_id: None, queued_messages: None,
        facet: Some("code".into()),
        permission_monitor: None, adventurous_handoff: None,
        notification_autodrain: None, active_plan: None, goal: None,
        flags: None, todos: None, mcp_servers: None,
    };
    state.emit_passthrough(psd::SessionDriverEvent::SessionUpdated { base, snapshot: snap });
    Json(json!({ "prompt_id": prompt_id, "session_id": MOCK_SESSION_ID }))
}

async fn cancel_turn(State(_s): State<Arc<FakeDaemonState>>) -> StatusCode { StatusCode::ACCEPTED }

async fn get_state(State(state): State<Arc<FakeDaemonState>>) -> Json<dt::SessionStateSnapshot> {
    Json(state.state.lock().clone())
}

async fn get_history(State(_s): State<Arc<FakeDaemonState>>) -> Json<dt::SessionHistorySnapshot> {
    Json(dt::SessionHistorySnapshot {
        history_revision: 0, items: Vec::new(),
        limit: None, offset: 0,
        session_id: MOCK_SESSION_ID.into(),
        total_projected_items: 0,
    })
}

async fn get_files(State(_s): State<Arc<FakeDaemonState>>) -> Json<dt::FileCatalogResponse> {
    Json(dt::FileCatalogResponse { files: mock_files().iter().map(|f| f.path.clone()).collect() })
}

async fn set_model(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::OK }
async fn set_title(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::OK }
async fn set_facet(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::OK }
async fn clear_context(State(_s): State<Arc<FakeDaemonState>>) -> StatusCode { StatusCode::OK }
async fn reload(State(_s): State<Arc<FakeDaemonState>>) -> StatusCode { StatusCode::OK }
async fn rewind(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::OK }
async fn respond_interrogative(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::OK }

async fn get_permission_monitor(State(_s): State<Arc<FakeDaemonState>>) -> impl IntoResponse {
    Json(json!({ "monitor": { "type": "standard" } }))
}
async fn set_permission_monitor(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::OK }
async fn get_notification_autodrain(State(_s): State<Arc<FakeDaemonState>>) -> impl IntoResponse {
    Json(json!({ "enabled": false }))
}
async fn set_notification_autodrain(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::OK }
async fn get_adventurous_handoff(State(_s): State<Arc<FakeDaemonState>>) -> impl IntoResponse {
    Json(json!({ "active": false }))
}
async fn toggle_adventurous_handoff(State(_s): State<Arc<FakeDaemonState>>) -> impl IntoResponse {
    Json(json!({ "active": true }))
}
async fn compact(State(_s): State<Arc<FakeDaemonState>>, Json(_b): Json<serde_json::Value>) -> StatusCode { StatusCode::ACCEPTED }
async fn mcp_action(State(_s): State<Arc<FakeDaemonState>>) -> StatusCode { StatusCode::OK }

async fn events(State(state): State<Arc<FakeDaemonState>>) -> Response {
    let rx = state.event_tx.subscribe();
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx)
        .filter_map(|result| {
            match result {
                Ok(envelope) => {
                    let json = serde_json::to_string(&envelope).ok()?;
                    Some(Ok::<_, std::convert::Infallible>(format!("data: {json}\n\n")))
                }
                Err(_) => None,
            }
        });
    Response::builder()
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

async fn dev_reset(State(state): State<Arc<FakeDaemonState>>) -> StatusCode {
    *state.state.lock() = mock_state_snapshot();
    *state.next_seq.lock() = 0;
    StatusCode::OK
}

async fn dev_script(State(_s): State<Arc<FakeDaemonState>>, Json(body): Json<serde_json::Value>) -> StatusCode {
    let script = body.get("script").and_then(|v| v.as_str()).unwrap_or("");
    warn!("[fake-daemon] dev/script: {script} (not yet implemented)");
    StatusCode::OK
}

async fn dev_state(State(state): State<Arc<FakeDaemonState>>) -> Json<dt::SessionStateSnapshot> {
    Json(state.state.lock().clone())
}
