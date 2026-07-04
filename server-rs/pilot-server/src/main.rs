//! Pilot server binary (Rust port of `server/src/index.ts`).
//!
//! Axum-based WS bridge + HTTP routes + static serving.

pub mod config;
pub mod driver;
pub mod fake_daemon;
pub mod hub;
pub mod journal;
pub mod pidlock;
pub mod mock_driver;
pub mod polytoken;
pub mod push;
pub mod settings_store;
pub mod static_serve;
pub mod stub_driver;
pub mod ws_send;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use tracing::{error, info, warn};

use crate::driver::PilotDriver;
use crate::hub::SessionHub;
use crate::stub_driver::StubDriver;

/// Shared app state.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub static_server: Arc<static_serve::StaticServer>,
    pub hub: Arc<Mutex<SessionHub>>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = config::load();

    // Mint stable per-data-dir identity before anything else touches the data dir.
    let server_id = match pidlock::mint_or_read_server_id(&cfg.data_dir) {
        Ok(id) => id,
        Err(e) => {
            error!("failed to mint server id: {e}");
            std::process::exit(1);
        }
    };

    // Acquire the single-server lock BEFORE any store opens the data dir.
    let _pid_lock =
        match pidlock::acquire_pid_lock(&cfg.data_dir, &server_id, std::process::id() as i64) {
            Ok(lock) => lock,
            Err(e) => {
                error!(
                    "startup aborted — data dir already locked: pid={} dir={} path={}",
                    e.pid,
                    e.data_dir.display(),
                    e.lock_path.display()
                );
                error!("{}", e);
                std::process::exit(1);
            }
        };

    // Driver selection: PILOT_DRIVER=mock uses the fake daemon (in-process axum
    // router); PILOT_DRIVER=polytoken uses the real polytoken daemon driver.
    let driver: Arc<dyn PilotDriver> = {
        let driver_mode = std::env::var("PILOT_DRIVER").unwrap_or_else(|_| "polytoken".into());
        match driver_mode.as_str() {
            "mock" => {
                // Use the MockDriver directly — it serves fixture data as SessionDriverEvent[],
                // matching the TS MockDriver for e2e parity.
                Arc::new(crate::mock_driver::MockDriver::new())
            }
            _ => {
                Arc::new(crate::polytoken::driver::PolytokenDriver::new(
                    cfg.data_dir.join("sessions"),
                    std::env::var("PILOT_POLYTOKEN_BIN").unwrap_or_else(|_| "polytoken".into()),
                    false, // not fake — real daemon
                ))
            }
        }
    };

    // Clone the driver Arc before it's moved into the hub — we need it for subscribe below.
    let driver_for_sub = driver.clone();

    let hub = SessionHub::new(
        driver,
        None, // notify — wired in Phase 6 (push)
        cfg.live_refresh_ms,
        server_id.clone(),
        Some(cfg.data_dir.clone()),
        String::new(), // build_sha — read from dist marker
        cfg.delta_flush_ms,
    );

    let static_server = Arc::new(static_serve::StaticServer::new(cfg.client_dist.clone()));
    let state = AppState {
        config: Arc::new(cfg.clone()),
        static_server,
        hub,
    };

    let app = build_router(state.clone());

    // Wire the driver's event stream to the hub's on_event. The hub subscribes
    // to the driver; each emitted SessionDriverEvent is folded + broadcast to WS clients.
    {
        let hub = state.hub.clone();
        let _sub_id = driver_for_sub.subscribe(Box::new(move |ev: pilot_protocol::session_driver::SessionDriverEvent| {
            let mut h = hub.lock();
            h.on_event(ev);
        }));
    }

    let addr = format!("{}:{}", cfg.host, cfg.port);
    let addr: SocketAddr = addr
        .parse()
        .unwrap_or_else(|e| panic!("failed to parse bind address {addr}: {e}"));

    info!("pilot server (rust) listening on {addr}");
    info!(
        "data dir: {}, driver: {}, token: {}, debug: {}",
        cfg.data_dir.display(),
        std::env::var("PILOT_DRIVER").unwrap_or_else(|_| "polytoken".into()),
        if cfg.token.is_some() { "required" } else { "off" },
        cfg.debug,
    );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health))
        .route("/push/vapid", get(push_vapid))
        .route("/push/subscribe", post(push_subscribe))
        .route("/push/unsubscribe", post(push_unsubscribe))
        .route("/push/test", post(push_test))
        .route("/update/state", post(update_state))
        .route("/debug/state", get(debug_state))
        .route("/debug/reset", get(debug_reset).post(debug_reset))
        .fallback(static_fallback)
        .with_state(state)
}

// ── /health ─────────────────────────────────────────────────────────────

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let _hub = state.hub.lock();
    Json(json!({
        "ok": true,
        "clients": 0, // TODO: track client count in hub
        "running": 0,
        "initializing": 0,
        "busy": false,
    }))
}

// ── /ws ─────────────────────────────────────────────────────────────────

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(ws: WebSocket, state: AppState) {
    use futures_util::{SinkExt, StreamExt};

    let (ws_sink, mut ws_stream) = ws.split();

    // Wait for the hello message before registering the client.
    let (client_key, rx) = loop {
        match ws_stream.next().await {
            Some(Ok(Message::Text(text))) => {
                let parsed: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => {
                        // Can't send errors yet — no sink access in this loop.
                        return;
                    }
                };
                if parsed.get("type").and_then(|t| t.as_str()) != Some("hello") {
                    return;
                }

                // Check auth token
                let auth = parsed.get("auth").and_then(|a| a.as_str());
                if !config::token_ok(auth, &state.config) {
                    return;
                }

                // Parse resume token if present
                let resume = parsed.get("resume").and_then(|r| {
                    serde_json::from_value::<pilot_protocol::wire::ResumeToken>(r.clone()).ok()
                });

                // Register the client with the hub.
                // add_client returns (client_key, tx, rx) — tx is a clone of what's
                // stored in the ClientConn; we drop it. rx goes to the pump task.
                let (client_key, _tx, rx) = {
                    let mut hub = state.hub.lock();
                    let result = hub.add_client(resume);
                    // Spawn the async follow-up lists (sessionList, modelList,
                    // commandList, facetList, fileIndex) — mirrors TS addClient.
                    hub.spawn_connect_lists(result.0, state.hub.clone());
                    result
                };

                break (client_key, rx);
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => {
                warn!("ws error before hello: {e}");
                return;
            }
            None => return,
        }
    };

    // Pump task: owns the sink, reads from the hub channel, writes to WS.
    // Clear ownership: this task is the sole writer to the WebSocket.
    let mut ws_sink = ws_sink;
    let pump = tokio::spawn(async move {
        let mut rx = rx;
        while let Some(msg) = rx.recv().await {
            let json = serde_json::to_string(&msg).unwrap_or_default();
            if ws_sink.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
        // Channel closed (client removed from hub) — close the WebSocket.
        let _ = ws_sink.send(Message::Close(None)).await;
    });

    // Main loop: owns the stream, reads from WS, dispatches to hub.
    while let Some(msg) = ws_stream.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                let parsed: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                // Skip hello (already authed)
                if parsed.get("type").and_then(|t| t.as_str()) == Some("hello") {
                    continue;
                }

                // Parse as ClientMessage and dispatch to hub
                let client_msg = match serde_json::from_value::<
                    pilot_protocol::wire::ClientMessage,
                >(parsed)
                {
                    Ok(m) => m,
                    Err(e) => {
                        warn!("failed to parse client message: {e}");
                        continue;
                    }
                };

                // Dispatch to the hub (lock briefly — handle_client is sync,
                // driver calls are spawned as separate tasks)
                {
                    let mut hub = state.hub.lock();
                    hub.handle_client(client_key, client_msg, state.hub.clone());
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    // Clean up: remove the client from the hub (drops the tx, closing the pump).
    {
        let mut hub = state.hub.lock();
        hub.remove_client(client_key);
    }
    // pump task will exit when rx returns None (tx dropped).
    let _ = pump.await;
}

// ── /push/* ─────────────────────────────────────────────────────────────

fn check_token(state: &AppState, headers: &HeaderMap, query: &PushQuery) -> bool {
    let auth_header = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let provided = config::token_from_request(auth_header, query.token.as_deref());
    config::token_ok(provided.as_deref(), &state.config)
}

#[derive(Deserialize)]
struct PushQuery {
    token: Option<String>,
}

async fn push_vapid(State(_state): State<AppState>, Query(_q): Query<PushQuery>) -> Response {
    Json(json!({ "publicKey": "" })).into_response()
}

async fn push_subscribe(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Json(json!({ "ok": true })).into_response()
}

async fn push_unsubscribe(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Json(json!({ "ok": true })).into_response()
}

async fn push_test(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    Json(json!({ "ok": true, "subscriptions": 0, "sent": 0 })).into_response()
}

// ── /update/state ────────────────────────────────────────────────────────

async fn update_state(
    State(state): State<AppState>,
    Query(q): Query<PushQuery>,
) -> Response {
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let mut hub = state.hub.lock();
    let result = hub.report_update(None, false, None);
    Json(result).into_response()
}

// ── /debug/* ────────────────────────────────────────────────────────────

async fn debug_state(State(state): State<AppState>, Query(q): Query<PushQuery>) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let hub = state.hub.lock();
    Json(hub.snapshot()).into_response()
}

async fn debug_reset(
    State(state): State<AppState>,
    Query(q): Query<PushQuery>,
) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &HeaderMap::new(), &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let mut hub = state.hub.lock();
    hub.reset(true);
    Json(json!({ "ok": true })).into_response()
}

// ── static fallback ─────────────────────────────────────────────────────

async fn static_fallback(
    State(state): State<AppState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
) -> Response {
    match state.static_server.serve(uri.path(), &headers).await {
        Ok(resp) => resp,
        Err(()) => (StatusCode::OK, "pilot server — no client build (run `bun run dev`)")
            .into_response(),
    }
}

// ── shutdown ────────────────────────────────────────────────────────────

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("shutdown signal received");
}
