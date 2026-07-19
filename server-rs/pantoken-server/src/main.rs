//! Pantoken server binary (Rust port of `server/src/index.ts`).
//!
//! Axum-based WS bridge + HTTP routes + static serving.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::serve::ListenerExt;
use axum::{Json, Router};
use parking_lot::Mutex as ParkingMutex;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;
use tracing::{error, info, warn};

// The module tree lives in `lib.rs` (so integration tests can reach the driver
// stack as `pantoken_server::…`). Re-import it here for the route handlers.
use pantoken_server::{
    config, hub::SessionHub, hub::hub_op_channel, hub::run_hub_op_applier, pidlock,
    polytoken::driver::PolytokenDriver, push::PushNotification, push::PushService,
    push::PushSubscription, static_serve,
};

use pantoken_server::driver::PantokenDriver;

/// Shared app state.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<config::Config>,
    pub static_server: Arc<pantoken_server::static_serve::StaticServer>,
    pub hub: Arc<ParkingMutex<SessionHub>>,
    pub push: Arc<AsyncMutex<PushService>>,
    pub is_debug_driver: bool,
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

    // Driver selection: `mock` = deterministic MockDriver; `fake` = the real
    // PolytokenDriver over an in-process corpus-backed fake daemon (dev/e2e only);
    // `polytoken` (default) = the real PolytokenDriver over a spawned daemon.
    let driver_mode = std::env::var("PANTOKEN_DRIVER").unwrap_or_else(|_| "polytoken".into());
    // `is_debug_driver` gates the /debug/reset dev endpoint. Both the
    // deterministic mock and the corpus-backed fake driver expose it.
    let is_debug_driver = driver_mode == "mock" || driver_mode == "fake";
    let driver: Arc<dyn PantokenDriver> = {
        match driver_mode.as_str() {
            "mock" => {
                // Use the MockDriver directly — it serves fixture data as SessionDriverEvent[],
                // matching the TS MockDriver for e2e parity.
                Arc::new(pantoken_server::mock_driver::MockDriver::new())
            }
            "fake" => {
                // The real PolytokenDriver driving an in-process, corpus-backed
                // fake daemon. `FakeControlHub::load_default` reads the frozen
                // corpus from the source tree and FAILS LOUD (panics) if it's
                // absent — the shipped binary won't carry tests/corpus, so fake
                // mode is dev/e2e only. The spawn-override must be installed
                // BEFORE the driver's constructor warms its bootstrap session.
                let control =
                    pantoken_server::polytoken::fake_daemon::FakeControlHub::load_default();
                pantoken_server::polytoken::fake_daemon::install_fake_spawn(control.clone());
                let login_shell =
                    pantoken_server::settings_store::read_pantoken_settings(&cfg.data_dir)
                        .login_shell;
                Arc::new(
                    PolytokenDriver::new_with_fake_control(
                        cfg.data_dir.clone(),
                        std::env::var("PANTOKEN_POLYTOKEN_BIN")
                            .unwrap_or_else(|_| "polytoken".into()),
                        true, // fake
                        cfg.warm_cap,
                        login_shell,
                        Some(control),
                    )
                    .await,
                )
            }
            _ => {
                // Read the pantoken-local settings for the configured login-shell
                // override (None = auto-resolve from $SHELL/passwd). The driver
                // captures the login env once at construction so daemon spawns
                // get the user's real PATH.
                let login_shell =
                    pantoken_server::settings_store::read_pantoken_settings(&cfg.data_dir)
                        .login_shell;
                Arc::new(
                    PolytokenDriver::new(
                        cfg.data_dir.clone(),
                        std::env::var("PANTOKEN_POLYTOKEN_BIN")
                            .unwrap_or_else(|_| "polytoken".into()),
                        false, // not fake — real daemon
                        cfg.warm_cap,
                        login_shell,
                    )
                    .await,
                )
            }
        }
    };

    // Clone the driver Arc before it's moved into the hub — we need it for subscribe below.
    let driver_for_sub = driver.clone();

    let (hub_ops, hub_op_rx) = hub_op_channel();

    let static_server = Arc::new(static_serve::StaticServer::new(cfg.client_dist.clone()));

    // Web Push service: owns the VAPID keypair + subscription store.
    let push_service = Arc::new(AsyncMutex::new(PushService::new(
        &cfg.data_dir,
        cfg.vapid_subject.clone(),
    )));

    // Wire the hub's notify closure: when no clients are connected and a notable
    // event fires (run completed/failed, approval needed), fan out a Web Push
    // notification to all subscribed devices. The closure is sync (Fn), so the
    // async send is spawned fire-and-forget onto the tokio runtime.
    let push_for_notify = push_service.clone();
    let notify: Arc<dyn Fn(pantoken_server::hub::HubNotification) + Send + Sync> =
        Arc::new(move |n: pantoken_server::hub::HubNotification| {
            let push = push_for_notify.clone();
            let notification = pantoken_server::push::PushNotification {
                title: n.title,
                body: n.body,
                tag: n.tag,
                url: n.url,
                badge: n.badge,
            };
            tokio::spawn(async move {
                let mut svc = push.lock().await;
                svc.send_to_all(&notification).await;
            });
        });

    let hub = SessionHub::new(
        driver,
        hub_ops,
        Some(notify),
        cfg.live_refresh_ms,
        server_id.clone(),
        Some(cfg.data_dir.clone()),
        option_env!("PANTOKEN_BUILD_SHA").unwrap_or("").to_string(),
        cfg.delta_flush_ms,
    );

    // Debug drivers (mock/fake) must never spawn a real file-manager window —
    // the e2e settings spec clicks Reveal, which would pop Finder on macOS.
    // Inject a no-op opener (mirrors the TS hub's mock-mode no-op).
    if is_debug_driver {
        hub.lock().set_open_in_file_manager(|_| Ok(()));
    }

    tokio::spawn(run_hub_op_applier(hub.clone(), hub_op_rx));

    let state = AppState {
        config: Arc::new(cfg.clone()),
        static_server,
        hub,
        push: push_service,
        is_debug_driver,
    };

    let app = build_router(state.clone());

    // Wire the driver's event stream to the hub's on_event. The hub subscribes
    // to the driver; each emitted SessionDriverEvent is folded + broadcast to WS clients.
    {
        let hub = state.hub.clone();
        let _sub_id = driver_for_sub.subscribe(Box::new(
            move |ev: pantoken_protocol::session_driver::SessionDriverEvent| {
                let mut h = hub.lock();
                h.on_event(ev);
            },
        ));
    }

    let addr = format!("{}:{}", cfg.host, cfg.port);
    let addr: SocketAddr = addr
        .parse()
        .unwrap_or_else(|e| panic!("failed to parse bind address {addr}: {e}"));

    info!("pantoken server (rust) listening on {addr}");
    info!(
        "data dir: {}, driver: {}, token: {}, debug: {}",
        cfg.data_dir.display(),
        driver_mode,
        if cfg.token.is_some() {
            "required"
        } else {
            "off"
        },
        cfg.debug,
    );

    // TCP_NODELAY on every accepted connection: the WS path pushes many small
    // frames (deltas, status) and Nagle would batch them behind unacked data —
    // imperceptible on localhost, but adds up to an RTT of lag per burst for a
    // phone/remote client. Nothing this server sends benefits from batching.
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"))
        .tap_io(|tcp_stream| {
            if let Err(err) = tcp_stream.set_nodelay(true) {
                warn!("failed to set TCP_NODELAY on incoming connection: {err}");
            }
        });

    // Live-refresh ticker: polls running sessions' usage every PANTOKEN_LIVE_REFRESH_MS,
    // mirroring the TS hub's syncLiveRefresh interval. Also rebroadcasts the
    // session list when dirty (e.g. an inferred title landing while idle).
    let hub_clone = state.hub.clone();
    let refresh_ms = cfg.live_refresh_ms;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(refresh_ms));
        loop {
            interval.tick().await;
            // enqueue_live_refresh checks both sync_live_refresh (running sessions)
            // and session_list_dirty (e.g. an inferred title landing while idle).
            // It enqueues a hub_ops closure only when there's work to do; the
            // closure fetches .await BEFORE locking.
            hub_clone.lock().enqueue_live_refresh();
        }
    });

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
    let hub = state.hub.lock();
    let activity = hub.activity();
    Json(json!({
        "ok": true,
        "clients": hub.client_count(),
        "running": activity["running"],
        "initializing": activity["initializing"],
        "busy": activity["busy"],
    }))
}

// ── /ws ─────────────────────────────────────────────────────────────────

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(ws: WebSocket, state: AppState) {
    use pantoken_server::connection::{ConnectionSession, SessionEnv, ws::WsAdapter};

    let env = SessionEnv {
        hub: state.hub.clone(),
        config: state.config.clone(),
    };
    let adapter = WsAdapter::new(ws);
    ConnectionSession::new(adapter, env).run().await;
}

// ── /push/* ─────────────────────────────────────────────────────────────

fn check_token(state: &AppState, headers: &HeaderMap, query: &PushQuery) -> bool {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let provided = config::token_from_request(auth_header, query.token.as_deref());
    config::token_ok(provided.as_deref(), &state.config)
}

#[derive(Deserialize)]
struct PushQuery {
    token: Option<String>,
    bootstrap: Option<String>,
}

/// Body of POST /push/unsubscribe — just the endpoint to drop.
#[derive(Deserialize)]
struct UnsubscribeBody {
    endpoint: Option<String>,
}

async fn push_vapid(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let push = state.push.lock().await;
    Json(json!({ "publicKey": push.public_key() })).into_response()
}

async fn push_subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
    body: String,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // C3: parse the body manually so a malformed JSON body returns 400 (matching
    // TS `bad request`) rather than axum's default 422 from the `Json` extractor.
    let sub: PushSubscription = match serde_json::from_str(&body) {
        Ok(s) => s,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };
    let mut push = state.push.lock().await;
    push.add(sub);
    Json(json!({ "ok": true })).into_response()
}

async fn push_unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
    body: String,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // C3: manual parse → 400 on malformed body (not axum's 422).
    let parsed: UnsubscribeBody = match serde_json::from_str(&body) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad request").into_response(),
    };
    let mut push = state.push.lock().await;
    if let Some(endpoint) = parsed.endpoint {
        push.remove(&endpoint);
    }
    Json(json!({ "ok": true })).into_response()
}

async fn push_test(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    // C4: capture `count` inside the same lock scope as `send_to_all` so the
    // returned `subscriptions` reflects the count at send time (a separate
    // lock could observe a different count if a (un)subscribe raced in between).
    let (sent, count) = {
        let mut push = state.push.lock().await;
        let sent = push
            .send_to_all(&PushNotification {
                title: "pantoken".into(),
                body: "Test push ✅ — if you see this on a closed phone, it works.".into(),
                tag: Some("pantoken-test".into()),
                url: None,
                // A visible non-zero badge, so the test push also proves the
                // Badging API path on-device (cleared on next app focus).
                badge: Some(1),
            })
            .await;
        (sent, push.count())
    };
    Json(json!({ "ok": true, "subscriptions": count, "sent": sent })).into_response()
}

// ── /update/state ────────────────────────────────────────────────────────

/// Body of POST /update/state — the shell updater's staged-update report.
/// Mirrors the TS handler (server/src/index.ts:303): `available` gates whether
/// `sha` is honored; `applyFailed` resets a stuck "applying" card.
#[derive(Deserialize)]
struct UpdateStateBody {
    available: Option<bool>,
    sha: Option<String>,
    #[serde(rename = "applyFailed")]
    apply_failed: Option<bool>,
}

async fn update_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
    Json(body): Json<UpdateStateBody>,
) -> Response {
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let sha = if body.available.unwrap_or(false) {
        body.sha
    } else {
        None
    };
    let apply_failed = body.apply_failed.unwrap_or(false);
    let mut hub = state.hub.lock();
    let result = hub.report_update(sha, apply_failed, None);
    Json(result).into_response()
}

// ── /debug/* ────────────────────────────────────────────────────────────

async fn debug_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let hub = state.hub.lock();
    Json(hub.snapshot()).into_response()
}

async fn debug_reset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PushQuery>,
) -> Response {
    if !state.config.debug {
        return (StatusCode::NOT_FOUND, "debug disabled").into_response();
    }
    if !check_token(&state, &headers, &q) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    if !state.is_debug_driver {
        return (StatusCode::FORBIDDEN, "debug reset is dev-driver-only").into_response();
    }
    let bootstrap = q.bootstrap.as_deref() != Some("0");
    let mut hub = state.hub.lock();
    hub.reset(bootstrap);
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
        Err(()) => (
            StatusCode::OK,
            "pantoken server — no client build (run `bun run dev`)",
        )
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Query, State};
    use axum::http::{HeaderMap, StatusCode, header};

    // A tokened AppState whose push service has an on-disk VAPID key. The hub is a
    // real MockDriver-backed hub (the push handlers never touch it, but AppState
    // requires the field).
    fn tokened_state(token: &str) -> AppState {
        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = config::Config {
            port: 0,
            data_dir: dir.path().to_path_buf(),
            vapid_subject: "mailto:test@example.com".into(),
            host: "127.0.0.1".into(),
            token: Some(token.to_string()),
            debug: true,
            client_dist: dir.path().join("dist"),
            warm_cap: 8,
            idle_reap_ms: 0,
            live_refresh_ms: 1000,
            delta_flush_ms: 0,
        };
        let (hub_ops, _rx) = hub_op_channel();
        let driver: Arc<dyn PantokenDriver> =
            Arc::new(pantoken_server::mock_driver::MockDriver::new());
        let hub = SessionHub::new(
            driver,
            hub_ops,
            None,
            1000,
            "test-server".into(),
            Some(dir.path().to_path_buf()),
            String::new(),
            0,
        );
        let push = PushService::new(dir.path(), "mailto:test@example.com".into());
        // Keep the tempdir alive for the process lifetime — the push service and hub
        // hold paths into it. Leaking is fine in a unit test.
        std::mem::forget(dir);
        AppState {
            config: Arc::new(cfg),
            static_server: Arc::new(static_serve::StaticServer::new(std::path::PathBuf::from(
                "/nonexistent",
            ))),
            hub,
            push: Arc::new(AsyncMutex::new(push)),
            is_debug_driver: true,
        }
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        h
    }

    #[tokio::test]
    async fn push_vapid_accepts_bearer_header_and_rejects_missing() {
        let state = tokened_state("secret-tok");
        let q = Query(PushQuery {
            token: None,
            bootstrap: None,
        });

        let ok = push_vapid(State(state.clone()), bearer("secret-tok"), q).await;
        assert_eq!(
            ok.status(),
            StatusCode::OK,
            "Bearer-header auth must be accepted"
        );

        let missing = push_vapid(
            State(state.clone()),
            HeaderMap::new(),
            Query(PushQuery {
                token: None,
                bootstrap: None,
            }),
        )
        .await;
        assert_eq!(
            missing.status(),
            StatusCode::UNAUTHORIZED,
            "no token must be rejected"
        );

        let wrong = push_vapid(
            State(state),
            bearer("wrong-tok"),
            Query(PushQuery {
                token: None,
                bootstrap: None,
            }),
        )
        .await;
        assert_eq!(
            wrong.status(),
            StatusCode::UNAUTHORIZED,
            "a bad token must be rejected"
        );
    }

    #[tokio::test]
    async fn push_subscribe_reads_bearer_header() {
        let state = tokened_state("tok2");
        let body =
            r#"{"endpoint":"https://example.com/x","keys":{"p256dh":"a","auth":"b"}}"#.to_string();
        let resp = push_subscribe(
            State(state),
            bearer("tok2"),
            Query(PushQuery {
                token: None,
                bootstrap: None,
            }),
            body,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
