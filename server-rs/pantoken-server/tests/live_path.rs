//! Live-path integration tests for `PolytokenDriver`.
//!
//! These exercise the real driver stack (`warm_session` → `DaemonClient` →
//! `event_map`) against the in-process fake daemon (`support::fake_daemon`),
//! which replays the frozen corpus over a real ephemeral axum port. The
//! spawn-override seam (`daemon_client::set_spawn_override`) swaps the process
//! launch for the fake, so the *only* thing not real is the daemon binary.
//!
//! **Test isolation:** the spawn-override is process-global, so every test in
//! this file takes the same `OVERRIDE_MUTEX` before setting/clearing it. This
//! serializes the injecting tests within this binary (cargo runs test binaries
//! in separate processes, so there's no cross-binary bleed). Do not remove the
//! guard without replacing it with equivalent serialization.

mod support;

use std::sync::Arc;

use pantoken_daemon_types::SseEnvelope;
use pantoken_protocol::session_driver::{SessionDriverEvent, SessionRef, WorkspaceRef};
use tokio::sync::Mutex;

use pantoken_server::driver::{NewSessionModel, NewSessionOptsData, PantokenDriver};
use pantoken_server::polytoken::daemon_client::{
    SpawnDaemonOpts, SpawnedDaemon, clear_spawn_override, set_spawn_override,
};
use pantoken_server::polytoken::driver::PolytokenDriver;
use pantoken_server::polytoken::event_map::{self, DaemonEffect, MapCtx};

use support::corpus as corpus_loader;
use support::corpus::ScenarioFile;
use support::fake_daemon;

/// Serializes spawn-override use within this test binary (the override is
/// process-global). Every test below locks this before touching the override.
/// A `tokio::sync::Mutex` (not `parking_lot`) so the guard can be held across
/// the `.await` points inside each test — the override must remain installed
/// for the whole test body (set → drive → clear).
static OVERRIDE_MUTEX: Mutex<()> = Mutex::const_new(());

/// The corpus version the harness pins (single frozen version per "pin the
/// corpus" — see PROGRESS.md D20).
const VERSION: &str = "0.4.0-unstable.7";

/// Install a spawn-override pointing at `fake`, returning a guard that clears
/// it on drop. Panics if the override is already set (caller bug).
struct OverrideGuard;
impl OverrideGuard {
    fn install(fake: Arc<fake_daemon::FakeDaemon>) -> Self {
        let port = fake.port;
        let session_id = fake.session_id.clone();
        set_spawn_override(Arc::new(move |_bin: &str, _opts: SpawnDaemonOpts| {
            let session_id = session_id.clone();
            Box::pin(async move {
                Ok((
                    SpawnedDaemon {
                        session_id: session_id.clone(),
                        port,
                        auth_token: None,
                    },
                    None,
                ))
            })
        }));
        Self
    }
}
impl Drop for OverrideGuard {
    fn drop(&mut self) {
        clear_spawn_override();
    }
}

/// Build a driver pointed at a temp sessions dir (no real daemon needed). Uses
/// the test-only constructor with an injected (empty) login_env so no real shell
/// spawns in CI. `warm_cap` is large by default so existing tests don't trigger
/// eviction; warm-cap tests pass an explicit cap.
async fn make_driver() -> (PolytokenDriver, tempfile::TempDir) {
    make_driver_with_cap(64).await
}

/// Build a driver with an explicit warm cap (for the eviction tests).
async fn make_driver_with_cap(warm_cap: i64) -> (PolytokenDriver, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let driver = PolytokenDriver::new_with_login_env(
        dir.path().to_path_buf(),
        "polytoken".into(), // never invoked — the override answers spawns
        false,
        warm_cap,
        None,
    )
    .await;
    (driver, dir)
}

/// A minimal `MapCtx` for the pure-effect verification test (Phase A.5):
/// deserializes corpus SSE frames through `map_daemon_event` and asserts which
/// `DaemonEffect` they produce. Mirrors `event_map`'s own `TestCtx`.
struct PureCtx {
    r#ref: SessionRef,
    workspace: WorkspaceRef,
}
impl Default for PureCtx {
    fn default() -> Self {
        Self {
            r#ref: SessionRef {
                workspace_id: "w".to_string(),
                session_id: "s".to_string(),
            },
            workspace: WorkspaceRef {
                workspace_id: "w".to_string(),
                path: "/w".to_string(),
                display_name: None,
            },
        }
    }
}
impl MapCtx for PureCtx {
    fn r#ref(&self) -> &SessionRef {
        &self.r#ref
    }
    fn workspace(&self) -> &WorkspaceRef {
        &self.workspace
    }
    fn now(&self) -> String {
        "t".to_string()
    }
    fn snapshot(
        &self,
        status: pantoken_protocol::session_driver::SessionStatus,
    ) -> pantoken_protocol::session_driver::SessionSnapshot {
        // The effect-verification test only inspects `DaemonEffect`s, never the
        // emitted snapshot, so a default-shaped snapshot (built from no cached
        // state) suffices. Reuse the shared builder so we don't hand-roll the
        // many SessionSnapshot fields.
        event_map::snapshot_from_state(
            None,
            &self.r#ref,
            &self.workspace,
            status,
            &self.now(),
            None,
            None,
        )
    }
    fn live_status(&self) -> pantoken_protocol::session_driver::SessionStatus {
        pantoken_protocol::session_driver::SessionStatus::Idle
    }
}

// ===========================================================================
// harness + spawn-seam smoke test
// ===========================================================================

#[tokio::test]
async fn harness_smoke_opens_session_and_seeds() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "smoke-1".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    // The spawn seam ran: the driver made it through health → claim → history.
    assert!(
        fake.called("GET", "/health"),
        "spawn seam: GET /health not hit; calls: {:?}",
        fake.recorded_calls()
    );
    assert!(
        fake.called("POST", "/tui-attachment/claim"),
        "lease not claimed; calls: {:?}",
        fake.recorded_calls()
    );
    // The driver fetches /history to build the seed. The corpus doesn't record
    // /history for streaming-turn, so the harness returns a canned empty body —
    // the seed is therefore empty here, which is correct (no recorded history
    // items). The point of THIS test is the spawn seam, not the seed contents.
    assert!(
        fake.called("GET", "/history"),
        "GET /history not hit; calls: {:?}",
        fake.recorded_calls()
    );

    // The seed is whatever history_to_seed_events produces from the recorded
    // /history (empty for streaming-turn). Assert it's a valid Vec (not a panic).
    let _ = seed;
}

#[tokio::test]
async fn model_switches_post_full_registry_model_id() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "model-key-1".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    driver
        .new_session(NewSessionOptsData {
            model: Some(NewSessionModel {
                provider: "anthropic".into(),
                model_id: "anthropic/claude-sonnet-5".into(),
            }),
            ..NewSessionOptsData::default()
        })
        .await
        .expect("new_session");

    let created_body = fake
        .recorded_request_bodies()
        .into_iter()
        .find(|(method, path, _body)| method == "POST" && path == "/model")
        .map(|(_method, _path, body)| body)
        .expect("new_session should POST /model");
    let created_json: serde_json::Value =
        serde_json::from_str(&created_body).expect("model request body json");
    assert_eq!(
        created_json["model"], "anthropic/claude-sonnet-5",
        "new_session must not prefix provider onto the full registry model id"
    );

    let calls_before = fake.recorded_request_bodies().len();
    driver
        .session_action(
            pantoken_protocol::wire::SessionAction::SetModel {
                provider: "deepseek".into(),
                model_id: "deepseek/deepseek-v4-pro".into(),
                thinking_level: None,
            },
            Some(fake.session_id.clone()),
        )
        .await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    let live_body = loop {
        if let Some(body) = fake
            .recorded_request_bodies()
            .into_iter()
            .skip(calls_before)
            .find(|(method, path, _body)| method == "POST" && path == "/model")
            .map(|(_method, _path, body)| body)
        {
            break body;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "set_model should POST /model; calls: {:?}",
                fake.recorded_request_bodies()
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    let live_json: serde_json::Value =
        serde_json::from_str(&live_body).expect("live model request body json");
    assert_eq!(
        live_json["model"], "deepseek/deepseek-v4-pro",
        "live set_model must not prefix provider onto the full registry model id"
    );
}

/// A failed opts POST during new_session must SURFACE (a warning notice appended
/// to the seed — an emit would be dropped pre-journal) and must NOT poison the
/// permission-mode cache. Regression: the three opts POSTs were `let _ =`, and
/// the monitor_mode cache was written unconditionally, so a failed
/// /permission-monitor left the seed badge asserting a mode the daemon wasn't
/// running (the dangerous "badge says standard, daemon bypasses" direction).
/// `/permission-monitor` isn't a canned fake route, so a scenario.http entry
/// with status 500 injects the failure directly.
#[tokio::test]
async fn new_session_opts_failure_surfaces_notice_and_does_not_cache_mode() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let mut scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    scenario.http.push(support::corpus::HttpEntry {
        method: "POST".into(),
        path: "/permission-monitor".into(),
        request_body: None,
        status: 500,
        response_body: Some(serde_json::json!({"error": "boom"})),
    });
    let fake = Arc::new(fake_daemon::spawn(scenario, "opts-fail-1".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let seed = driver
        .new_session(NewSessionOptsData {
            permission_monitor: Some(
                pantoken_protocol::session_driver::PermissionMonitorMode::Bypass,
            ),
            ..NewSessionOptsData::default()
        })
        .await
        .expect("new_session still succeeds — the session is created, only the opt failed");

    // The seed carries a visible warning notice about the failed permission mode.
    let warned = seed.iter().any(|ev| {
        matches!(
            ev,
            SessionDriverEvent::HostUiRequest {
                request:
                    pantoken_protocol::session_driver::HostUiRequest::Notify { message, level, .. },
                ..
            } if message.to_lowercase().contains("permission mode")
                && *level == Some(pantoken_protocol::session_driver::NotifyLevel::Warning)
        )
    });
    assert!(
        warned,
        "a failed /permission-monitor POST must append a warning notice to the seed; seed: {seed:?}"
    );

    // The seed's SessionOpened/Updated snapshots must NOT claim the un-applied
    // mode — the cache was not poisoned, so the badge reflects the daemon default,
    // not "bypass".
    let claims_bypass = seed.iter().any(|ev| {
        let snap = match ev {
            SessionDriverEvent::SessionOpened { snapshot, .. } => Some(snapshot),
            SessionDriverEvent::SessionUpdated { snapshot, .. } => Some(snapshot),
            _ => None,
        };
        snap.and_then(|s| s.permission_monitor)
            == Some(pantoken_protocol::session_driver::PermissionMonitorMode::Bypass)
    });
    assert!(
        !claims_bypass,
        "a failed permission-mode POST must not leave the seed asserting the un-applied mode"
    );
}

/// Renaming a WARM session must reach the daemon's real `POST /title`, and
/// `list_sessions()` must reflect the new title IMMEDIATELY — not just once
/// the `SessionTitleChanged` SSE echo eventually lands (it arrives
/// asynchronously and, on its own, doesn't even refresh the cached
/// `last_state` — see `handle_sse_event`'s comment). `rename_session` awaits
/// the POST and patches `last_state` itself before returning, so no polling
/// loop is needed here (unlike `set_model` above, which fires the POST from a
/// detached `tokio::spawn`).
#[tokio::test]
async fn rename_session_warm_posts_title_and_updates_list_sessions_immediately() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "rename-warm-1".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    // Any `.../<session_id>/session.json`-shaped path resolves the session id;
    // it need not exist on disk — a WARM rename never touches the filesystem.
    let path = format!("/fake/sessions/{}/session.json", fake.session_id);
    driver
        .rename_session(path, "Renamed While Warm".to_string())
        .await;

    let title_body = fake
        .recorded_request_bodies()
        .into_iter()
        .find(|(method, path, _body)| method == "POST" && path == "/title")
        .map(|(_method, _path, body)| body)
        .expect("rename_session should POST /title for a warm session");
    let title_json: serde_json::Value =
        serde_json::from_str(&title_body).expect("title request body json");
    assert_eq!(title_json["title"], "Renamed While Warm");

    // No polling loop: rename_session awaits the POST and patches last_state
    // itself, so list_sessions() reflects it on the very next call.
    let sessions = driver.list_sessions().await;
    let entry = sessions
        .iter()
        .find(|s| s.session_id == fake.session_id)
        .expect("the warm session should still be listed");
    assert_eq!(
        entry.display_name.as_deref(),
        Some("Renamed While Warm"),
        "the sidebar row must reflect the new title immediately, before any \
         SessionTitleChanged SSE echo arrives"
    );
}

// ===========================================================================
// Phase A.5 — verify corpus scenario → effect mapping (pre-Phase-D insurance)
// ===========================================================================

/// Run a scenario's SSE frames through `map_daemon_event` and collect every
/// `DaemonEffect` produced. Used to confirm a scenario exercises the effect a
/// later Phase-D integration test will assert on.
fn effects_for_scenario(scenario: &ScenarioFile) -> Vec<DaemonEffect> {
    let ctx = PureCtx::default();
    let mut acc = event_map::create_accumulator();
    let mut effects = Vec::new();
    for frame in &scenario.sse {
        let envelope: SseEnvelope = frame
            .envelope()
            .unwrap_or_else(|e| panic!("frame deserialized: {e}"));
        let result = event_map::map_daemon_event(&envelope.event, &mut acc, &ctx);
        effects.extend(result.effects);
    }
    effects
}

/// streaming-turn ends in `message_complete` → a `FetchState` effect (per
/// event-map.test.ts:96). Confirms the scenario the Phase-D FetchState
/// integration test targets actually produces that effect.
#[tokio::test]
async fn streaming_turn_produces_fetch_state_effect() {
    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let effects = effects_for_scenario(&scenario);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, DaemonEffect::FetchState { .. })),
        "streaming-turn should produce a FetchState effect; got: {:?}",
        effects.iter().map(|e| format!("{e:?}")).collect::<Vec<_>>()
    );
}

/// queue-while-in-flight carries `pending_turn_input_queued` → a `RefetchQueue`
/// effect (per event-map.test.ts:416). Confirms the scenario the Phase-D
/// RefetchQueue integration test targets actually produces that effect.
#[tokio::test]
async fn queue_while_in_flight_produces_refetch_queue_effect() {
    let scenario = corpus_loader::load_named(VERSION, "queue-while-in-flight");
    let effects = effects_for_scenario(&scenario);
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, DaemonEffect::RefetchQueue)),
        "queue-while-in-flight should produce a RefetchQueue effect; got: {:?}",
        effects.iter().map(|e| format!("{e:?}")).collect::<Vec<_>>()
    );
}

// ===========================================================================
// warm-session lifecycle tests
// ===========================================================================

/// Subscribe to the driver and collect emitted events into a bounded channel.
/// Returns the subscription id (call `unsubscribe` to stop). The channel is
/// large enough to absorb a scenario's burst without blocking the emitter
/// (which uses `try_send` and would otherwise drop on a full channel).
fn collect_events(
    driver: &PolytokenDriver,
    cap: usize,
) -> (usize, tokio::sync::mpsc::Receiver<SessionDriverEvent>) {
    let (tx, rx) = tokio::sync::mpsc::channel(cap);
    let id = driver.subscribe(Box::new(move |ev| {
        // try_send: never block the emitter task (a dropped event fails the
        // test loudly via the receiver seeing too few events).
        let _ = tx.try_send(ev);
    }));
    (id, rx)
}

struct ClearOverrideOnDrop;
impl Drop for ClearOverrideOnDrop {
    fn drop(&mut self) {
        clear_spawn_override();
    }
}

#[tokio::test]
async fn prompt_echoes_images_and_warns_with_prompt_id() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario, "prompt-1".into(), 20).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    let image = pantoken_protocol::session_driver::ImageContent::Image {
        data: "ZmFrZQ==".into(),
        mime_type: "image/png".into(),
    };
    driver
        .prompt(
            "hello with image".into(),
            Some(pantoken_protocol::wire::DeliveryMode::FollowUp),
            Some(fake.session_id.clone()),
            vec![image],
            Some("custom-prompt-id".into()),
        )
        .await
        .expect("prompt");

    assert!(
        fake.called("POST", "/prompt"),
        "prompt POST not sent: {:?}",
        fake.recorded_calls()
    );

    let mut saw_user = false;
    let mut saw_warning_after_user = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        match ev {
            SessionDriverEvent::UserMessage {
                id, text, images, ..
            } if id == "custom-prompt-id" => {
                assert_eq!(text, "hello with image");
                assert_eq!(images.as_ref().map(Vec::len), Some(1));
                saw_user = true;
            }
            SessionDriverEvent::HostUiRequest {
                request:
                    pantoken_protocol::session_driver::HostUiRequest::Notify { message, level, .. },
                ..
            } if saw_user && message.contains("1 image was attached") => {
                assert_eq!(
                    level,
                    Some(pantoken_protocol::session_driver::NotifyLevel::Warning)
                );
                saw_warning_after_user = true;
                break;
            }
            _ => {}
        }
    }

    assert!(saw_user, "prompt did not emit userMessage echo");
    assert!(
        saw_warning_after_user,
        "prompt did not emit image warning after userMessage"
    );
}

#[tokio::test]
async fn queued_prompt_updates_queue_without_user_echo() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let mut scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    scenario.sse.clear();
    scenario
        .http
        .retain(|entry| !(entry.method == "POST" && entry.path == "/prompt"));
    scenario.http.push(support::corpus::HttpEntry {
        method: "POST".into(),
        path: "/prompt".into(),
        request_body: None,
        status: 202,
        response_body: Some(serde_json::json!({
            "prompt_id": "daemon-queued-prompt",
            "session_id": "SESSION",
            "queued_item": {
                "admission_prompt_id": "daemon-queued-prompt",
                "content": "queued from prompt",
                "id": "queued-from-prompt"
            }
        })),
    });
    let fake = Arc::new(fake_daemon::spawn(scenario, "prompt-queued".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    driver
        .prompt(
            "queued from prompt".into(),
            None,
            Some(fake.session_id.clone()),
            vec![],
            Some("client-queued-prompt-id".into()),
        )
        .await
        .expect("prompt");

    assert!(
        fake.called("POST", "/prompt"),
        "prompt POST not sent: {:?}",
        fake.recorded_calls()
    );
    assert!(
        fake.called("GET", "/turn/input"),
        "queued prompt should refetch the full queue: {:?}",
        fake.recorded_calls()
    );

    let mut saw_queue = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        match ev {
            SessionDriverEvent::UserMessage { id, .. } if id == "client-queued-prompt-id" => {
                panic!("queued prompt must not emit an immediate userMessage echo");
            }
            SessionDriverEvent::QueueUpdated { messages, .. }
                if messages.iter().any(|m| m.text == "queued-turn-text") =>
            {
                saw_queue = true;
                break;
            }
            _ => {}
        }
    }

    assert!(
        saw_queue,
        "queued prompt did not update the queue tray state"
    );
}

#[tokio::test]
async fn warm_child_killed_on_shutdown() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario, "child-1".into(), 20).await);
    let port = fake.port;
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .expect("spawn sleep child");
    let pid = child.id().expect("sleep pid");

    let child_holder = Arc::new(std::sync::Mutex::new(Some(child)));
    let child_holder_for_override = child_holder.clone();
    let session_id_for_override = fake.session_id.clone();
    set_spawn_override(Arc::new(move |_bin: &str, _opts: SpawnDaemonOpts| {
        let child_holder = child_holder_for_override.clone();
        let session_id = session_id_for_override.clone();
        Box::pin(async move {
            let child = child_holder
                .lock()
                .expect("child holder mutex")
                .take()
                .ok_or_else(|| "child already consumed".to_string())?;
            Ok((
                SpawnedDaemon {
                    session_id,
                    port,
                    auth_token: None,
                },
                Some(child),
            ))
        })
    }));
    let _clear = ClearOverrideOnDrop;

    let (driver, _dir) = make_driver().await;
    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    driver.shutdown().await;

    let status = tokio::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .await
        .expect("kill -0");
    assert!(
        !status.success(),
        "owned daemon child pid {pid} should be gone after driver shutdown"
    );
}

// ===========================================================================
// fake-mode boot + dev surface
// ===========================================================================

/// Build a fake-mode driver: install the corpus-backed spawn override, then
/// construct the real `PolytokenDriver` with `is_fake` + a `FakeControlHub`
/// (which warms a bootstrap session on construction). The returned tuple keeps
/// the tempdir + override-clear guard alive for the test body.
async fn make_fake_driver() -> (
    PolytokenDriver,
    pantoken_server::polytoken::fake_daemon::FakeControlHub,
    tempfile::TempDir,
    ClearOverrideOnDrop,
) {
    let control = pantoken_server::polytoken::fake_daemon::FakeControlHub::load_default();
    pantoken_server::polytoken::fake_daemon::install_fake_spawn(control.clone());
    let clear = ClearOverrideOnDrop;
    let dir = tempfile::tempdir().expect("tempdir");
    let driver = PolytokenDriver::new_with_fake_control(
        dir.path().to_path_buf(),
        "polytoken".into(),
        true,
        64,
        None,
        Some(control.clone()),
    )
    .await;
    (driver, control, dir, clear)
}

/// `PANTOKEN_DRIVER=fake` boots the real `PolytokenDriver` over an in-process
/// fake daemon — the constructor warms a bootstrap session, so `default_seed`
/// returns its `sessionOpened` (what the hub adopts as the landing session).
#[tokio::test]
async fn fake_mode_boots_and_bootstraps() {
    let _guard = OVERRIDE_MUTEX.lock().await;
    let (driver, _control, _dir, _clear) = make_fake_driver().await;

    let seed = driver
        .default_seed()
        .expect("fake mode default_seed should return the bootstrap session");
    assert!(
        matches!(seed.first(), Some(SessionDriverEvent::SessionOpened { .. })),
        "default_seed must begin with sessionOpened; got {:?}",
        seed.first()
    );
}

/// `/debug/reset` → `driver.reset` keeps the bootstrap session warm so the
/// hub's follow-up `seed_default` reseeds a `sessionOpened` deterministically.
#[tokio::test]
async fn dev_surface_reset_reseeds() {
    let _guard = OVERRIDE_MUTEX.lock().await;
    let (driver, _control, _dir, _clear) = make_fake_driver().await;

    driver.reset(true);

    let seed = driver
        .default_seed()
        .expect("reset must keep a warm session so seed_default reseeds");
    assert!(
        matches!(seed.first(), Some(SessionDriverEvent::SessionOpened { .. })),
        "post-reset default_seed must begin with sessionOpened"
    );
}

#[tokio::test]
async fn dev_surface_run_script_pushes_scenario() {
    let _guard = OVERRIDE_MUTEX.lock().await;
    let (driver, _control, _dir, _clear) = make_fake_driver().await;

    let (_sub, mut rx) = collect_events(&driver, 256);
    driver.run_script("stream".into());

    let mut got = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(
            ev,
            SessionDriverEvent::AssistantDelta { .. } | SessionDriverEvent::SessionUpdated { .. }
        ) {
            got = true;
            break;
        }
    }
    assert!(
        got,
        "run_script(\"stream\") should fold streaming-turn frames into driver events"
    );
}

/// after `new_session`, the warm session is SUBSCRIBED to daemon SSE and
/// FOLDING events. We stream
/// `streaming-turn` (whose 3rd SSE frame is `message_start`, which maps to a
/// `SessionUpdated { status: Running }`), subscribe to the driver, and assert a
/// `SessionUpdated` arrives from the SSE path (not from the seed).
///
/// This is the load-bearing proof that `warm_session` → `subscribe` →
/// `handle_sse_event` → `emit` is live end-to-end.
#[tokio::test]
async fn warm_session_subscribes_and_folds_sse() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    // Small inter-frame delay so the SSE consumer has time to fold before the stream ends.
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "warm-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    // new_session warms + subscribes SSE before returning the seed.
    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    // Wait for a SessionUpdated from the SSE path. `message_start` (frame 2)
    // emits one with status Running. Timeout so a dead SSE path fails the test
    // rather than hanging.
    let mut got_session_updated = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::SessionUpdated { .. }) {
            got_session_updated = true;
            break;
        }
    }
    assert!(
        got_session_updated,
        "warm session did not emit a SessionUpdated from SSE; the SSE fold is not live. \
         calls: {:?}",
        fake.recorded_calls()
    );
}

/// `reload_session` disposes the old warm session AND re-warms. We open a
/// session, observe one SSE-driven emission, call `reload_session`, then assert
/// the old warm was disposed (its SSE subscription stopped — no further
/// emissions from it) and the call returns without deadlock.
///
/// **Scope note:** `open_session` spawns a resume daemon via the
/// spawn-override seam when no `startup.json` is found. The fake daemon
/// answers the spawn, so the re-warm goes through
/// health → claim → history. The seed may be empty if the corpus has no
/// recorded /history items (streaming-turn doesn't). This test asserts the
/// cold-start spawn seam is hit after reload (the fake daemon's /health is
/// called again), proving the spawn-or-attach path works.
#[tokio::test]
async fn reload_session_disposes_old_warm_and_rewarms() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "reload-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, dir) = make_driver().await;
    let (sub_id, mut rx) = collect_events(&driver, 256);

    // Write a session.json for `reload-1` so the cold-start re-warm (fired by
    // reload_session) can resolve the project cwd. Production always sends the
    // `.../<id>/session.json` path; the session id is the parent dir name.
    // `project_path` must be a real, existing directory — `open_session`
    // fails fast (no spawn attempt) when the cwd is missing (docs/TODO.md).
    let reload_dir = dir.path().join("sessions").join("reload-1");
    std::fs::create_dir_all(&reload_dir).expect("mkdir reload-1 session dir");
    let project_dir = dir.path().join("project");
    std::fs::create_dir_all(&project_dir).expect("mkdir project dir");
    std::fs::write(
        reload_dir.join("session.json"),
        serde_json::json!({
            "session_id": "reload-1",
            "project_path": project_dir.to_string_lossy(),
            "created_at": "2025-01-01T00:00:00Z",
            "last_activity_at": "2025-01-01T00:00:00Z",
        })
        .to_string(),
    )
    .expect("write reload-1 session.json");

    // Warm via new_session (spawn path) + subscribe SSE.
    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    // Observe one SSE-driven emission (proves the first warm is live).
    let _first = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .expect("first warm produced no SSE emission")
        .expect("channel closed");

    // Reload — disposes the old warm (stops its SSE subscription, closes the
    // client), then re-opens. With the cold-start spawn (Phase 3b), open_session
    // now spawns a resume daemon via the spawn-override seam when no
    // startup.json is found. The fake daemon answers the spawn, so the
    // re-warm goes through health → claim → history (the spawn seam is hit
    // Snapshot the fake's cumulative call count BEFORE reload. The first warm
    // already hit /health (via install_warm), so a bare `fake.called(...)`
    // would be vacuously true even if reload's re-warm never ran. Asserting the
    // count strictly INCREASES proves the reload re-warm actually re-hit the
    // daemon's endpoints (the cold-start spawn seam fired again).
    let calls_before = fake.recorded_calls().len();
    let path = reload_dir.join("session.json");
    let path = path.to_string_lossy().to_string();
    let reseed = driver
        .reload_session(path)
        .await
        .expect("reload_session ok");
    // The cold-start spawn re-hit the fake daemon's endpoints.
    assert!(
        fake.recorded_calls().len() > calls_before,
        "cold-start spawn: no new daemon calls after reload; before={calls_before}, after={}, calls: {:?}",
        fake.recorded_calls().len(),
        fake.recorded_calls()
    );
    assert!(
        fake.called("GET", "/health"),
        "cold-start spawn: GET /health not hit after reload; calls: {:?}",
        fake.recorded_calls()
    );
    let _ = reseed;

    // After disposal + re-warm, the NEW warm session is live and may emit SSE
    // events. The old warm's consumer was stopped during disposal — any events
    // arriving here are from the new session, not a leak of the old one.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let _post_reload = rx.try_recv().ok(); // expected: new session emissions

    driver.unsubscribe(sub_id);
}

// ===========================================================================
// Phase 4 — multi-spawn fake-daemon harness
// ===========================================================================

#[tokio::test]
async fn multi_spawn_override_mints_fresh_fake_per_new_session() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "multi-smoke");
    let handle = override_guard.handle();

    let (driver, _dir) = make_driver().await;
    for _ in 0..3 {
        let _seed = driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("new_session");
    }

    let spawned = handle.spawned();
    assert_eq!(spawned.len(), 3, "expected one fake daemon per new_session");

    let session_ids: std::collections::BTreeSet<_> = spawned
        .iter()
        .map(|spawned| spawned.session_id.as_str())
        .collect();
    assert_eq!(
        session_ids.len(),
        3,
        "each new_session should receive a distinct minted session id: {spawned:?}"
    );

    let ports: std::collections::BTreeSet<_> = spawned.iter().map(|spawned| spawned.port).collect();
    assert_eq!(
        ports.len(),
        3,
        "each fake daemon should bind a distinct ephemeral port: {spawned:?}"
    );

    for spawned in &spawned {
        assert!(
            spawned.called("GET", "/health"),
            "{} never warmed through /health; calls: {:?}",
            spawned.session_id,
            spawned.recorded_calls()
        );
        assert!(
            spawned.called("GET", "/state"),
            "{} never fetched /state; calls: {:?}",
            spawned.session_id,
            spawned.recorded_calls()
        );
        assert!(
            spawned.called("GET", "/history"),
            "{} never built a seed from /history; calls: {:?}",
            spawned.session_id,
            spawned.recorded_calls()
        );
    }

    let captured_opts = handle.captured_opts();
    assert_eq!(
        captured_opts.len(),
        3,
        "capture one SpawnDaemonOpts per spawn"
    );
    assert!(
        captured_opts.iter().all(|opts| opts.login_env.is_none()),
        "default test driver passes login_env None (no injected env); captured opts: {captured_opts:?}"
    );
}

// ===========================================================================
// Phase 3b — cold-start spawn in open_session
// ===========================================================================

/// Clicking a cold session (no running daemon, no startup.json) spawns
/// a resume daemon via `spawn_daemon` → spawn-override seam. The fake daemon
/// answers the spawn, `install_warm` runs (health → lease → state → SSE), and
/// the cold-start path is exercised end-to-end. Asserts the spawn-override was
/// hit with resume-shaped opts (session_id: Some).
#[tokio::test]
async fn test_open_session_cold_start_spawns_daemon() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "cold-start");
    let handle = override_guard.handle();

    let (driver, dir) = make_driver().await;

    // Write a session.json so cwd_for_session resolves (open_session reads it
    // to find the project cwd for the resume spawn). No startup.json — the
    // cold-start path should fire. `project_path` must be a real, existing
    // directory — `open_session` fails fast (no spawn attempt) when the cwd
    // is missing (docs/TODO.md).
    let session_id = "cold-session-1";
    let sessions_dir = dir.path().join("sessions");
    let session_dir = sessions_dir.join(session_id);
    std::fs::create_dir_all(&session_dir).expect("mkdir session dir");
    let project_dir = dir.path().join("project");
    std::fs::create_dir_all(&project_dir).expect("mkdir project dir");
    let session_json = serde_json::json!({
        "session_id": session_id,
        "project_path": project_dir.to_string_lossy(),
        "created_at": "2025-01-01T00:00:00Z",
        "last_activity_at": "2025-01-01T00:00:00Z",
    });
    std::fs::write(
        session_dir.join("session.json"),
        serde_json::to_string(&session_json).unwrap(),
    )
    .expect("write session.json");

    // open_session on a cold session (no startup.json) should spawn via the
    // override seam. Pass the real `session.json` path (production always
    // sends `.../<id>/session.json`); the session id is the parent dir name.
    let path = session_dir.join("session.json");
    let path = path.to_string_lossy().to_string();
    let seed = driver
        .open_session(path)
        .await
        .expect("open_session should succeed via cold-start spawn");

    // The spawn-override was hit — a spawn was captured.
    let captured = handle.captured_opts();
    assert_eq!(
        captured.len(),
        1,
        "cold-start should trigger exactly one spawn; got {} captures",
        captured.len()
    );
    // The spawn was a RESUME (session_id: Some), not a new-session spawn.
    assert!(
        captured[0].session_id.is_some(),
        "cold-start spawn should be a resume (session_id: Some); got opts: {:?}",
        captured[0]
    );

    // The fake daemon was warmed through health → claim → history.
    let spawned = handle.spawned();
    assert_eq!(spawned.len(), 1, "one fake daemon should have been spawned");
    assert!(
        spawned[0].called("GET", "/health"),
        "cold-start spawn: /health not hit; calls: {:?}",
        spawned[0].recorded_calls()
    );

    // The seed is whatever the fake daemon's /history returns (may be empty
    // for synthetic-idle). The point is the spawn seam was hit, not the seed.
    let _ = seed;
}

/// Re-opening an already-warm session must NOT re-fetch GET /history. The first
/// open_session warms the session (spawn → health → claim → state → history);
/// the SSE consumer then live-folds events into the hub's journal. A second
/// open_session for the same session should short-circuit: return a minimal
/// [SessionOpened] seed from the cached snapshot, skipping the size-proportional
/// history fetch + map + fold — finish_switch won't reseed an existing journal,
/// so the full fetch is wasted work on the hottest path (A↔B switching).
#[tokio::test]
async fn open_session_warm_reopen_skips_history_fetch() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "warm-reopen");
    let handle = override_guard.handle();

    let (driver, dir) = make_driver().await;

    // Write a session.json so cwd_for_session resolves (same setup as the
    // cold-start test above). `project_path` must be a real, existing
    // directory — `open_session` fails fast (no spawn attempt) when the cwd
    // is missing (docs/TODO.md).
    let session_id = "warm-reopen-1";
    let sessions_dir = dir.path().join("sessions");
    let session_dir = sessions_dir.join(session_id);
    std::fs::create_dir_all(&session_dir).expect("mkdir session dir");
    let project_dir = dir.path().join("project");
    std::fs::create_dir_all(&project_dir).expect("mkdir project dir");
    std::fs::write(
        session_dir.join("session.json"),
        serde_json::json!({
            "session_id": session_id,
            "project_path": project_dir.to_string_lossy(),
            "created_at": "2025-01-01T00:00:00Z",
            "last_activity_at": "2025-01-01T00:00:00Z",
        })
        .to_string(),
    )
    .expect("write session.json");

    let path = session_dir.join("session.json");
    let path = path.to_string_lossy().to_string();

    // First open: cold-start spawn → warm → history fetch.
    let seed1 = driver
        .open_session(path.clone())
        .await
        .expect("first open_session should succeed");

    let spawned = handle.spawned();
    assert_eq!(spawned.len(), 1, "one fake daemon should have been spawned");
    assert!(
        spawned[0].called("GET", "/history"),
        "first open should fetch /history; calls: {:?}",
        spawned[0].recorded_calls()
    );
    let history_count_after_first = spawned[0]
        .recorded_calls()
        .iter()
        .filter(|(m, p)| m == "GET" && p == "/history")
        .count();
    assert_eq!(
        history_count_after_first, 1,
        "first open should hit /history exactly once"
    );

    // Second open: session is already warm — fast path, no history fetch.
    let seed2 = driver
        .open_session(path)
        .await
        .expect("second open_session should succeed");

    let history_count_after_second = spawned[0]
        .recorded_calls()
        .iter()
        .filter(|(m, p)| m == "GET" && p == "/history")
        .count();
    assert_eq!(
        history_count_after_second,
        1,
        "warm re-open must NOT fetch /history again; calls: {:?}",
        spawned[0].recorded_calls()
    );

    // The fast-path seed is a minimal [SessionOpened] (no replayed history).
    assert_eq!(
        seed2.len(),
        1,
        "warm re-open seed should be just SessionOpened; got {} events",
        seed2.len()
    );
    assert!(
        matches!(seed2[0], SessionDriverEvent::SessionOpened { .. }),
        "warm re-open seed must be a SessionOpened; got {:?}",
        seed2[0]
    );

    // The first seed may also be just SessionOpened (synthetic-idle has empty
    // /history), so we can't compare seed lengths. But we CAN assert the sid
    // matches — the fast path must return the same session identity.
    let sid1 = seed1
        .first()
        .map(|e| e.session_ref().session_id.clone())
        .expect("first seed has a session id");
    let sid2 = seed2
        .first()
        .map(|e| e.session_ref().session_id.clone())
        .expect("second seed has a session id");
    assert_eq!(sid1, sid2, "warm re-open must return the same session id");
}

// ===========================================================================
// SSE ordering test
// ===========================================================================

/// Build a minimal `/state` + `/history` scenario (empty SSE) for the
/// multi-spawn harness: just liveness plus a `turn_in_flight` flag readable
/// from `/state`. The `/state` body is a full `SessionStateSnapshot` (pinned by
/// `synthetic_state_scenarios_deserialize_as_session_state`).
fn minimal_state_scenario(name: &str, turn_in_flight: bool) -> ScenarioFile {
    use serde_json::json;
    let json_str = json!({
        "scenario": name,
        "version": "test",
        "description": "minimal state/history scenario for multi-spawn harness tests",
        "canonicalization": {
            "session_id": "SESSION",
            "prompt_ids": {},
            "timestamps": "monotonic-from-T0"
        },
        "http": [
            { "method": "GET", "path": "/state", "status": 200,
              "response_body": { "session_title": "t", "todos": [], "flags": [],
                                 "env": {}, "project_cwd": "/PROJECT", "active_facet": "execute",
                                 "plugin_config": {}, "turn_in_flight": turn_in_flight } },
            { "method": "GET", "path": "/history", "status": 200,
              "response_body": { "items": [], "offset": 0, "total_projected_items": 0,
                                 "history_revision": 0, "session_id": "SESSION" } }
        ],
        "sse": [],
        "expected_driver_events": null
    })
    .to_string();
    serde_json::from_str::<ScenarioFile>(&json_str).expect("parse minimal synthetic scenario")
}

// Consumed now by `synthetic_state_scenarios_deserialize_as_session_state`, and
// by the warm-cap in-flight-skip eviction test
fn synthetic_turn_in_flight_scenario() -> ScenarioFile {
    minimal_state_scenario("synthetic-turn-in-flight", true)
}

/// Guard the synthetic `/state` fixtures against `SessionStateSnapshot` drift.
/// The driver's warm path deserializes `/state` into that type and *swallows* a
/// parse failure (`DaemonClient::get` uses `.ok()`), so a body missing a required
/// field (e.g. `plugin_config`) would leave `last_state = None` and silently
/// hollow out every scenario that depends on it — including the turn_in_flight
/// eviction case. This pins that both synthetic bodies fully deserialize and that
/// `turn_in_flight` survives the round-trip into the driver's state type.
#[test]
fn synthetic_state_scenarios_deserialize_as_session_state() {
    for (scenario, expect_in_flight) in [
        (synthetic_idle_scenario(), false),
        (synthetic_turn_in_flight_scenario(), true),
        (synthetic_ordering_scenario(1), false),
    ] {
        let state = scenario
            .http
            .iter()
            .find(|entry| entry.method == "GET" && entry.path == "/state")
            .and_then(|entry| entry.response_body.clone())
            .expect("scenario serves a GET /state body");
        let snapshot: pantoken_daemon_types::SessionStateSnapshot = serde_json::from_value(state)
            .expect("synthetic /state must deserialize as a full SessionStateSnapshot");
        assert_eq!(
            snapshot.turn_in_flight.unwrap_or(false),
            expect_in_flight,
            "turn_in_flight must survive the round-trip into the driver's state type"
        );
    }
}

fn synthetic_idle_scenario() -> ScenarioFile {
    minimal_state_scenario("synthetic-idle", false)
}

/// Build a synthetic scenario whose SSE stream is: `message_start` →
/// `content_block_start` (text) → N `content_block_delta` (text, each carrying
/// its index as the delta text) → `content_block_stop` → `message_complete`.
/// Each delta maps to an `AssistantDelta { text: "<idx>" }`, so the receiver
/// can assert the emitted deltas arrive in the exact 0..N order — the
/// invariant the per-event `tokio::spawn` violated (probabilistically) and the
/// single per-session consumer now guarantees (deterministically).
fn synthetic_ordering_scenario(n: usize) -> ScenarioFile {
    use serde_json::json;
    let mut sse: Vec<serde_json::Value> = Vec::with_capacity(n + 4);
    sse.push(json!({
        "seq": 0, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
        "event": { "type": "message_start", "prompt_id": "PROMPT_0" }
    }));
    sse.push(json!({
        "seq": 1, "emitted_at": "1970-01-01T00:00:01.000Z", "session_id": "SESSION",
        "event": { "type": "content_block_start", "prompt_id": "PROMPT_0", "block_index": 0,
                   "block_type": { "type": "text" } }
    }));
    for i in 0..n {
        sse.push(json!({
            "seq": (i as i64) + 2, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
            "event": { "type": "content_block_delta", "prompt_id": "PROMPT_0", "block_index": 0,
                       "delta": { "type": "text", "text": i.to_string() } }
        }));
    }
    sse.push(json!({
        "seq": (n as i64) + 2, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
        "event": { "type": "content_block_stop", "prompt_id": "PROMPT_0", "block_index": 0 }
    }));
    sse.push(json!({
        "seq": (n as i64) + 3, "emitted_at": "1970-01-01T00:00:00.000Z", "session_id": "SESSION",
        "event": { "type": "message_complete", "prompt_id": "PROMPT_0" }
    }));
    let json_str = json!({
        "scenario": "synthetic-ordering",
        "version": "test",
        "description": "N ordered text deltas",
        "canonicalization": {
            "session_id": "SESSION",
            "prompt_ids": {},
            "timestamps": "monotonic-from-T0"
        },
        "http": [
            // The driver's lifecycle calls: health, claim, state, history.
            // The fake supplies canned /health + /claim; /state + /history
            // return minimal bodies so warm-up completes.
            { "method": "GET", "path": "/state", "status": 200,
              "response_body": { "session_title": "t", "todos": [], "flags": [],
                                 "env": {}, "project_cwd": "/PROJECT", "active_facet": "execute",
                                 "plugin_config": {} } },
            { "method": "GET", "path": "/history", "status": 200,
              "response_body": { "items": [], "offset": 0, "total_projected_items": 0,
                                 "history_revision": 0, "session_id": "SESSION" } }
        ],
        "sse": sse,
        "expected_driver_events": null
    })
    .to_string();
    serde_json::from_str::<ScenarioFile>(&json_str).expect("parse synthetic scenario")
}

/// SSE events fold sequentially through ONE per-session consumer (no
/// per-event `tokio::spawn`). A burst of 250 ordered text deltas yields
/// in-order emitted `AssistantDelta` events.
///
/// **Invariant guard, weakly discriminating pre-fix:** against the old per-event
/// `tokio::spawn` code, the failure was only probabilistic (unordered task
/// scheduling), so this test may pass even on the buggy code. It confirms the
/// fix WORKS post-fix; regression protection comes primarily from the
/// structural guard (`debug_assert` one-consumer-per-session in `install_warm`).
/// The burst is large (250) with a small inter-frame delay to give it what
/// discriminating power it can have.
#[tokio::test]
async fn sse_burst_folds_in_order() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    const N: usize = 250;
    let scenario = synthetic_ordering_scenario(N);
    // Tiny randomized-ish inter-frame delay (1ms) so the consumer tasks (in the
    // old design) would interleave; the single consumer processes sequentially.
    let fake = Arc::new(fake_daemon::spawn(scenario, "order-1".into(), 1).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 512);

    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    // Collect N AssistantDelta events (the text deltas). Other events
    // (SessionUpdated from message_start, etc.) are skipped. Timeout per recv
    // so a stall fails the test rather than hanging.
    let mut texts: Vec<String> = Vec::with_capacity(N);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while texts.len() < N {
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("timed out waiting for AssistantDelta burst")
            .expect("channel closed before all deltas arrived");
        if let SessionDriverEvent::AssistantDelta { text, .. } = ev {
            texts.push(text);
        }
    }

    // Assert exact order: "0","1",…,"249".
    let expected: Vec<String> = (0..N).map(|i| i.to_string()).collect();
    assert_eq!(
        texts, expected,
        "SSE deltas folded out of order (expected 0..{N} in sequence)"
    );
}

// ===========================================================================
// FetchState emit + RefetchQueue → queueUpdated
// ===========================================================================

#[tokio::test]
async fn fetch_state_emits_run_completed_with_prompt_id() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "fetch-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    // Wait for the RunCompleted (the message_complete → FetchState → emit).
    let mut got = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::RunCompleted { .. }) {
            got = Some(ev);
            break;
        }
    }
    let ev = got.expect("no RunCompleted emitted after message_complete");
    match ev {
        SessionDriverEvent::RunCompleted {
            user_entry_id,
            assistant_entry_id,
            ..
        } => {
            // streaming-turn's prompt_id canonicalizes to PROMPT_0.
            assert_eq!(
                user_entry_id.as_deref(),
                Some("PROMPT_0"),
                "RunCompleted user_entry_id should be the daemon prompt_id"
            );
            assert_eq!(
                assistant_entry_id.as_deref(),
                Some("PROMPT_0"),
                "RunCompleted assistant_entry_id should be the daemon prompt_id"
            );
        }
        _ => unreachable!(),
    }

    // The FetchState effect fetched GET /state (the corpus records /state; the
    // post-message_complete /state is the second recording). Assert the driver
    // made at least one /state call beyond the warm-up one.
    let state_calls = fake
        .recorded_calls()
        .iter()
        .filter(|(m, p)| m == "GET" && p == "/state")
        .count();
    assert!(
        state_calls >= 2,
        "FetchState should have fetched /state after message_complete; /state calls: {}",
        state_calls
    );
}

#[tokio::test]
async fn refetch_queue_emits_queue_updated() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "queue-while-in-flight");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "queue-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    // Wait for the QueueUpdated (the pending_turn_input_queued → RefetchQueue →
    // GET /turn/input → emit). Timeout so a missing emit fails fast.
    let mut got = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::QueueUpdated { .. }) {
            got = Some(ev);
            break;
        }
    }
    let ev = got.expect("no QueueUpdated emitted after pending_turn_input_queued");
    match ev {
        SessionDriverEvent::QueueUpdated { messages, .. } => {
            // The canned /turn/input serves one item (q1, "queued-turn-text").
            assert_eq!(
                messages.len(),
                1,
                "QueueUpdated should carry the full queue (1 item)"
            );
            assert_eq!(messages[0].id, "q1");
            assert_eq!(messages[0].text, "queued-turn-text");
        }
        _ => unreachable!(),
    }

    // The RefetchQueue effect fetched GET /turn/input.
    assert!(
        fake.called("GET", "/turn/input"),
        "RefetchQueue should have fetched GET /turn/input; calls: {:?}",
        fake.recorded_calls()
    );
}

/// clear_queue (the client's ⌥↑ "Edit all" restore) must return EVERY queued
/// text and drain the daemon's queue — the daemon's only removal primitive is
/// DELETE /turn/input/newest, so the driver snapshots first and deletes once
/// per item.
#[tokio::test]
async fn clear_queue_drains_daemon_queue_and_returns_texts() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario, "clear-queue-1".into(), 0).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;

    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    let restored = driver.clear_queue(Some(fake.session_id.clone())).await;

    // The canned GET /turn/input serves one item ("queued-turn-text") — its text
    // must come back for the composer, on the steering side (queue items surface
    // as mode:Steer; there is no daemon-side steer/follow-up split).
    assert_eq!(restored.steering, vec!["queued-turn-text".to_string()]);
    assert!(restored.follow_up.is_empty());

    // One DELETE per snapshotted item — the queue is actually drained.
    let deletes = fake
        .recorded_calls()
        .iter()
        .filter(|(m, p)| m == "DELETE" && p == "/turn/input/newest")
        .count();
    assert_eq!(
        deletes,
        1,
        "expected one dequeue per snapshotted item; calls: {:?}",
        fake.recorded_calls()
    );
}

// ===========================================================================
// new_session wiring: cwd resolution, worktree, login-env, warm-cap eviction, invalid-cwd errors
// ===========================================================================

#[tokio::test]
async fn warm_cap_evicts_lru_idle_session() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    const CAP: i64 = 2;
    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "evict-idle");
    let handle = override_guard.handle();

    let (driver, _dir) = make_driver_with_cap(CAP).await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    // Warm CAP+1 sessions. Each new_session focuses the just-warmed session
    // (most-recent), so the FIRST warmed session is the LRU and the victim.
    let mut session_ids: Vec<String> = Vec::new();
    for _ in 0..=(CAP as usize) {
        let seed = driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("new_session");
        let _ = seed;
        let spawned = handle.spawned();
        let last = spawned.last().expect("a spawn per new_session");
        session_ids.push(last.session_id.clone());
    }
    assert_eq!(session_ids.len(), (CAP as usize) + 1);

    let lru_id = session_ids[0].clone();
    let most_recent = session_ids.last().unwrap().clone();

    // Collect SessionClosed events (with a drain window for the async emit +
    // dispose). The victim should get a synthetic SessionClosed.
    let mut closed_ids: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if let SessionDriverEvent::SessionClosed { base, .. } = ev {
            closed_ids.push(base.session_ref.session_id.clone());
        }
    }

    assert!(
        closed_ids.contains(&lru_id),
        "LRU idle session {lru_id} should have been evicted (SessionClosed emitted); \
         closed ids: {closed_ids:?}"
    );
    assert!(
        !closed_ids.contains(&most_recent),
        "the most-recently-focused session {most_recent} must NOT be evicted; \
         closed ids: {closed_ids:?}"
    );

    // Confirm the LRU is gone from the warm pool via list_sessions. Only warm
    // sessions surface here (the fake writes no session.json), so the LRU
    // dropping out of the list == dropped from the warm pool.
    let listed: Vec<String> = driver
        .list_sessions()
        .await
        .into_iter()
        .map(|e| e.session_id)
        .collect();
    assert!(
        !listed.contains(&lru_id),
        "evicted LRU {lru_id} should be gone from list_sessions (warm pool); listed: {listed:?}"
    );
    assert!(
        listed.contains(&most_recent),
        "most-recent session {most_recent} should still be listed (in warm pool); listed: {listed:?}"
    );
}

/// a session whose `/state` reports
/// `turn_in_flight:true` is NEVER evicted, even when it's the LRU. We install
/// a multi-spawn override that serves the turn-in-flight scenario, so EVERY
/// warmed session reports in-flight. With `warm_cap = N`, warming N+1 sessions
/// cannot evict the LRU (it's in-flight), so the warm pool exceeds the cap and
/// the driver logs a deferral — but critically, no `SessionClosed` is emitted
/// for any session.
///
/// This is the discriminating case: the idle eviction test above proves the
/// eviction *fires* for idle sessions; this test proves it's *skipped* for
/// in-flight ones.
#[tokio::test]
async fn warm_cap_never_evicts_in_flight() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    const CAP: i64 = 2;
    let scenario = synthetic_turn_in_flight_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "evict-inflight");
    let handle = override_guard.handle();

    let (driver, _dir) = make_driver_with_cap(CAP).await;
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    // Warm CAP+1 sessions, all reporting turn_in_flight:true.
    let mut session_ids: Vec<String> = Vec::new();
    for _ in 0..=(CAP as usize) {
        let _seed = driver
            .new_session(NewSessionOptsData::default())
            .await
            .expect("new_session");
        let spawned = handle.spawned();
        session_ids.push(spawned.last().unwrap().session_id.clone());
    }
    let lru_id = session_ids[0].clone();

    // Drain any events for a short window. No SessionClosed should arrive —
    // the LRU is in-flight and must not be evicted.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(800);
    let mut saw_closed = false;
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if matches!(ev, SessionDriverEvent::SessionClosed { .. }) {
            saw_closed = true;
        }
    }
    assert!(
        !saw_closed,
        "no SessionClosed should be emitted — in-flight sessions are never evicted"
    );

    // The LRU in-flight session must still be in the warm pool (observable via
    // list_sessions: only warm sessions surface, no on-disk session.json).
    let listed: Vec<String> = driver
        .list_sessions()
        .await
        .into_iter()
        .map(|e| e.session_id)
        .collect();
    assert!(
        listed.contains(&lru_id),
        "in-flight LRU {lru_id} must NOT be evicted (still in warm pool); listed: {listed:?}"
    );
}

/// Uses a real `git init` tempdir repo (git, not jj, so it runs on CI where git
/// is present). Skipped (not failed) if git is unavailable, mirroring the
/// `worktree.rs` integration test convention.
#[tokio::test]
async fn new_session_worktree_isolates_cwd() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    // Skip if git isn't available (CI always has it, but be defensive).
    if tokio::process::Command::new("git")
        .arg("--version")
        .output()
        .await
        .is_err()
    {
        eprintln!("skipping worktree isolation test: git executable unavailable");
        return;
    }

    // Set up a real git repo in a tempdir.
    let repo_tmp = tempfile::tempdir().expect("tempdir");
    let repo = repo_tmp.path().join("repo");
    std::fs::create_dir(&repo).expect("mkdir repo");

    async fn git(repo: &std::path::Path, args: &[&str]) {
        let out = tokio::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .await
            .expect("git");
        assert!(
            out.status.success(),
            "git -C {} {} failed: {}",
            repo.display(),
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    // git init + an initial commit (a worktree needs at least one commit).
    git(&repo, &["init"]).await;
    std::fs::write(repo.join("README.md"), "hello\n").expect("write");
    git(&repo, &["add", "README.md"]).await;
    git(
        &repo,
        &[
            "-c",
            "user.email=pantoken@example.test",
            "-c",
            "user.name=Pantoken Test",
            "commit",
            "-m",
            "initial",
        ],
    )
    .await;

    // Install the multi-spawn override so the spawn goes to the fake daemon
    // (no real polytoken binary). The synthetic idle scenario suffices — we
    // only need the session to warm; the worktree is created by the driver
    // BEFORE the spawn.
    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "worktree-cwd");
    let handle = override_guard.handle();

    let (driver, _dir) = make_driver().await;

    let _seed = driver
        .new_session(NewSessionOptsData {
            cwd: Some(repo.to_string_lossy().to_string()),
            worktree: Some(true),
            ..Default::default()
        })
        .await
        .expect("new_session with worktree");

    // The spawned session's cwd should be a worktree path: a sibling of the
    // repo (not the repo itself). We get the cwd from the list_sessions warm
    // entry (the fake daemon writes no session.json, so only the warm entry
    // surfaces).
    let listed = driver.list_sessions().await;
    let entry = listed
        .into_iter()
        .find(|e| {
            handle
                .spawned()
                .iter()
                .any(|s| s.session_id == e.session_id)
        })
        .expect("the warmed session should appear in list_sessions");

    let session_cwd = &entry.cwd;
    assert_ne!(
        session_cwd,
        &repo.to_string_lossy().to_string(),
        "session cwd should be the worktree path, not the repo itself"
    );
    // The worktree is a sibling: it shares the repo's parent dir.
    let worktree_path = std::path::Path::new(session_cwd);
    assert!(
        worktree_path.starts_with(repo.parent().unwrap()),
        "worktree path {session_cwd} should be a sibling of the repo (under {})",
        repo.parent().unwrap().display()
    );
    assert!(
        worktree_path.is_dir(),
        "the worktree dir should exist on disk: {session_cwd}"
    );

    // The WorktreeStore should record the worktree for this cwd. We verify via
    // the worktree indicator on the list_sessions entry (it's surfaced from
    // the store via worktree_field_for).
    assert!(
        entry.worktree.is_some(),
        "list_sessions should surface the worktree indicator for a worktree session"
    );
    let wt = entry.worktree.as_ref().unwrap();
    assert_eq!(
        wt.path, *session_cwd,
        "worktree indicator path should match the session cwd"
    );
}

/// A driver constructed with an injected `login_env` threads that env into every
/// daemon spawn. We build the driver via `new_with_login_env` with a known env
/// map, install the multi-spawn override, call `new_session`, and assert the
/// captured `SpawnDaemonOpts.login_env` equals the injected map (not `None`).
#[tokio::test]
async fn new_session_passes_captured_login_env_to_spawn() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "login-env");
    let handle = override_guard.handle();

    // A known, non-empty env map — distinct from the default (None).
    let mut known_env: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    known_env.insert("PATH".to_string(), "/test/bin:/usr/bin".to_string());
    known_env.insert("PANTOKEN_TEST_VAR".to_string(), "threaded".to_string());

    let dir = tempfile::tempdir().expect("tempdir");
    let driver = PolytokenDriver::new_with_login_env(
        dir.path().to_path_buf(),
        "polytoken".into(),
        false,
        64,
        Some(known_env.clone()),
    )
    .await;

    let _seed = driver
        .new_session(NewSessionOptsData::default())
        .await
        .expect("new_session");

    let captured = handle.captured_opts();
    assert_eq!(captured.len(), 1, "one spawn per new_session");
    assert_eq!(
        captured[0].login_env,
        Some(known_env.clone()),
        "the driver should thread its captured login_env into the spawn opts \
         (not None); captured: {captured:?}"
    );
}

#[tokio::test]
async fn new_session_invalid_cwd_errors_specifically() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    // No override needed — the validation fires BEFORE the spawn. But the
    // mutex serializes against the other spawn-override tests, and we install
    // a benign override so a stray spawn (there shouldn't be one) is caught.
    let scenario = synthetic_idle_scenario();
    let _override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "invalid-cwd");
    let handle = _override_guard.handle();

    let (driver, _dir) = make_driver().await;

    let bad_cwd = "/no/such/directory";
    let err = driver
        .new_session(NewSessionOptsData {
            cwd: Some(bad_cwd.to_string()),
            ..Default::default()
        })
        .await
        .expect_err("new_session with a nonexistent cwd should error");

    assert!(
        err.contains(bad_cwd),
        "error should NAME the bad path ({bad_cwd}); got: {err}"
    );
    assert!(
        !err.is_empty(),
        "error should not be the generic empty-seed message"
    );

    // No spawn should have occurred (validation is before the spawn).
    assert!(
        handle.spawned().is_empty(),
        "no daemon should be spawned for an invalid cwd"
    );
}

#[tokio::test]
async fn list_sessions_overlays_archive_and_worktree_flags() {
    // No override mutex needed — no spawn override is installed, no daemon is
    // spawned. This test only exercises the cold-session listing path.
    let data_dir = tempfile::tempdir().expect("tempdir");
    let sessions_dir = data_dir.path().join("sessions");
    let session_id = "sess-archive-wt";
    let session_dir = sessions_dir.join(session_id);
    std::fs::create_dir_all(&session_dir).expect("mkdir session dir");

    let project_path = "/home/user/project-x";
    let session_json_path = session_dir.join("session.json");
    let session_json_path_str = session_json_path.to_string_lossy().to_string();

    // Write a session.json so the cold session surfaces in list_sessions.
    let json = serde_json::json!({
        "session_id": session_id,
        "project_path": project_path,
        "created_at": "2025-01-01T00:00:00Z",
        "last_activity_at": "2025-01-01T00:00:00Z",
    });
    std::fs::write(&session_json_path, serde_json::to_string(&json).unwrap())
        .expect("write session.json");

    // Seed the ArchiveStore on disk: it loads a JSON array of session paths.
    // The archive key is the session.json path (see list_sessions: it calls
    // `archive_store.has(session_json_path)`).
    let archive_file = data_dir.path().join("archived.json");
    std::fs::write(
        &archive_file,
        serde_json::to_string(&[&session_json_path_str]).unwrap(),
    )
    .expect("write archive index");

    // Seed the WorktreeStore on disk: it loads a JSON *array* of
    // `PersistedWorktree` objects (each flattens WorktreeMeta + an optional
    // `reaped` flag). The worktree key is the cwd (project_path) — see
    // list_sessions: it calls `worktree_field_for(cwd, &worktree_store)`.
    let worktree_file = data_dir.path().join("worktrees.json");
    let wt_seed = serde_json::json!([{
        "path": project_path,
        "base": "/home/user",
        "vcs": "git",
        "name": "pantoken-archive-wt"
    }]);
    std::fs::write(
        &worktree_file,
        serde_json::to_string_pretty(&wt_seed).unwrap(),
    )
    .expect("write worktree store");

    // Construct the driver — it loads both stores from disk on construction.
    let driver = PolytokenDriver::new_with_login_env(
        data_dir.path().to_path_buf(),
        "polytoken".into(),
        false,
        64,
        None,
    )
    .await;

    let listed = driver.list_sessions().await;
    let entry = listed
        .into_iter()
        .find(|e| e.session_id == session_id)
        .unwrap_or_else(|| panic!("cold session {session_id} should appear in list_sessions"));

    // The archived flag is the real store value (true).
    assert!(
        entry.archived,
        "archived flag should be true (sourced from ArchiveStore); got false"
    );

    // The worktree indicator is the real store value (Some).
    let wt = entry
        .worktree
        .as_ref()
        .expect("worktree indicator should be Some (sourced from WorktreeStore)");
    assert_eq!(
        wt.path, project_path,
        "worktree indicator path should match the session cwd"
    );
    assert_eq!(wt.name, "pantoken-archive-wt");
}

#[tokio::test]
async fn set_archived_persists_and_overlays() {
    // No override mutex needed — no spawn, cold-session path only.
    let data_dir = tempfile::tempdir().expect("tempdir");
    let sessions_dir = data_dir.path().join("sessions");
    let session_id = "sess-archive-write";
    let session_dir = sessions_dir.join(session_id);
    std::fs::create_dir_all(&session_dir).expect("mkdir session dir");
    let session_json_path = session_dir.join("session.json");
    let session_json_path_str = session_json_path.to_string_lossy().to_string();
    let json = serde_json::json!({
        "session_id": session_id,
        "project_path": "/home/user/project-x",
        "created_at": "2025-01-01T00:00:00Z",
        "last_activity_at": "2025-01-01T00:00:00Z",
    });
    std::fs::write(&session_json_path, serde_json::to_string(&json).unwrap())
        .expect("write session.json");

    let driver = PolytokenDriver::new_with_login_env(
        data_dir.path().to_path_buf(),
        "polytoken".into(),
        false,
        64,
        None,
    )
    .await;

    // Archive: the flag flips and archived.json records the path.
    driver
        .set_archived(session_json_path_str.clone(), true)
        .await;
    let entry = driver
        .list_sessions()
        .await
        .into_iter()
        .find(|e| e.session_id == session_id)
        .expect("session should be listed");
    assert!(
        entry.archived,
        "archived flag should be true after set_archived(true)"
    );
    let archive_file = data_dir.path().join("archived.json");
    let arr: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(&archive_file).expect("archived.json"))
            .expect("archived.json parses");
    assert!(
        arr.contains(&session_json_path_str),
        "archived.json should contain the session path after archiving"
    );

    // Unarchive: both clear.
    driver
        .set_archived(session_json_path_str.clone(), false)
        .await;
    let entry = driver
        .list_sessions()
        .await
        .into_iter()
        .find(|e| e.session_id == session_id)
        .expect("session should still be listed");
    assert!(
        !entry.archived,
        "archived flag should be false after set_archived(false)"
    );
    let arr: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(&archive_file).expect("archived.json"))
            .expect("archived.json parses");
    assert!(
        !arr.contains(&session_json_path_str),
        "archived.json should not contain the path after unarchiving"
    );
}

/// Shared fixture for the `set_archived` worktree-reap tests: a real git repo, a
/// worktree session created via `new_session(worktree: true)`, and a written
/// `session.json` so `set_archived` can resolve the session cwd (the fake daemon
/// writes none). All tempdirs, the spawn override, and the override-mutex guard
/// are kept alive in the returned struct for the whole test body. Returns `None`
/// when git is unavailable so the caller can skip (not fail).
struct WorktreeFixture {
    _repo_tmp: tempfile::TempDir,
    _data_dir: tempfile::TempDir,
    _override_guard: fake_daemon::MultiSpawnOverrideGuard,
    _mutex_guard: tokio::sync::MutexGuard<'static, ()>,
    driver: PolytokenDriver,
    /// The session.json path — the archive key passed to `set_archived`.
    archive_key: String,
    /// The worktree cwd (a sibling of the repo) registered in the store.
    cwd: String,
}

async fn setup_worktree_session(label: &'static str) -> Option<WorktreeFixture> {
    let mutex_guard = OVERRIDE_MUTEX.lock().await;

    if tokio::process::Command::new("git")
        .arg("--version")
        .output()
        .await
        .is_err()
    {
        eprintln!("skipping {label}: git executable unavailable");
        return None;
    }

    // Real git repo with one commit (a worktree needs at least one commit).
    let repo_tmp = tempfile::tempdir().expect("tempdir");
    let repo = repo_tmp.path().join("repo");
    std::fs::create_dir(&repo).expect("mkdir repo");
    async fn git(repo: &std::path::Path, args: &[&str]) {
        let out = tokio::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .await
            .expect("git");
        assert!(
            out.status.success(),
            "git -C {} {} failed: {}",
            repo.display(),
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    git(&repo, &["init"]).await;
    std::fs::write(repo.join("README.md"), "hello\n").expect("write");
    git(&repo, &["add", "README.md"]).await;
    git(
        &repo,
        &[
            "-c",
            "user.email=pantoken@example.test",
            "-c",
            "user.name=Pantoken Test",
            "commit",
            "-m",
            "initial",
        ],
    )
    .await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, label);
    let handle = override_guard.handle();

    let (driver, data_dir) = make_driver().await;

    driver
        .new_session(NewSessionOptsData {
            cwd: Some(repo.to_string_lossy().to_string()),
            worktree: Some(true),
            ..Default::default()
        })
        .await
        .expect("new_session with worktree");

    let entry = driver
        .list_sessions()
        .await
        .into_iter()
        .find(|e| {
            handle
                .spawned()
                .iter()
                .any(|s| s.session_id == e.session_id)
        })
        .expect("the warmed worktree session should appear in list_sessions");
    let cwd = entry.cwd.clone();
    let archive_key = entry.path.clone();

    // The fake daemon writes no session.json; write one so `set_archived` can
    // resolve the session cwd from the archive key (a real daemon writes this).
    let session_json_path = std::path::PathBuf::from(&archive_key);
    std::fs::create_dir_all(session_json_path.parent().unwrap()).expect("mkdir session dir");
    let json = serde_json::json!({
        "session_id": entry.session_id,
        "project_path": cwd,
        "created_at": "2025-01-01T00:00:00Z",
        "last_activity_at": "2025-01-01T00:00:00Z",
    });
    std::fs::write(&session_json_path, serde_json::to_string(&json).unwrap())
        .expect("write session.json");

    Some(WorktreeFixture {
        _repo_tmp: repo_tmp,
        _data_dir: data_dir,
        _override_guard: override_guard,
        _mutex_guard: mutex_guard,
        driver,
        archive_key,
        cwd,
    })
}

#[tokio::test]
async fn set_archived_reaps_clean_worktree() {
    let Some(fx) = setup_worktree_session("set_archived_reaps_clean_worktree").await else {
        return;
    };
    assert!(
        std::path::Path::new(&fx.cwd).is_dir(),
        "worktree should exist before archiving"
    );

    let result = fx.driver.set_archived(fx.archive_key.clone(), true).await;
    assert!(
        result.worktree_retained.is_none(),
        "a clean worktree should be reaped, not retained"
    );
    assert!(
        !std::path::Path::new(&fx.cwd).exists(),
        "the clean worktree dir should be removed from disk"
    );

    let entry = fx
        .driver
        .list_sessions()
        .await
        .into_iter()
        .find(|e| e.cwd == fx.cwd)
        .expect("session should still be listed after archiving");
    assert_eq!(
        entry.worktree.as_ref().and_then(|w| w.reaped),
        Some(true),
        "the store should tombstone the reaped worktree"
    );
}

#[tokio::test]
async fn set_archived_retains_dirty_worktree() {
    let Some(fx) = setup_worktree_session("set_archived_retains_dirty_worktree").await else {
        return;
    };
    // Dirty the worktree with an uncommitted (untracked) file.
    std::fs::write(
        std::path::Path::new(&fx.cwd).join("dirty.txt"),
        "uncommitted\n",
    )
    .expect("write dirty file");

    let result = fx.driver.set_archived(fx.archive_key.clone(), true).await;
    let retained = result
        .worktree_retained
        .expect("a dirty worktree should be retained");
    assert_eq!(retained.path, fx.cwd, "retained path should be the cwd");
    assert_eq!(
        retained.reason, "worktree has uncommitted changes",
        "retained reason should be the concrete reason from worktree::remove"
    );
    assert!(
        std::path::Path::new(&fx.cwd).is_dir(),
        "a retained (dirty) worktree should stay on disk"
    );
}

// ===========================================================================
// Detach session — release the TUI attachment lease without killing the daemon
// ===========================================================================

#[tokio::test]
async fn detach_session_releases_lease_without_terminating() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "detach");
    let handle = override_guard.handle();

    let (driver, dir) = make_driver().await;

    // Write a session.json with a real project dir so open_session can warm it
    // via the cold-start spawn path (same setup as the cold-start test).
    let session_id = "detach-session-1";
    let sessions_dir = dir.path().join("sessions");
    let session_dir = sessions_dir.join(session_id);
    std::fs::create_dir_all(&session_dir).expect("mkdir session dir");
    let project_dir = dir.path().join("project");
    std::fs::create_dir_all(&project_dir).expect("mkdir project dir");
    std::fs::write(
        session_dir.join("session.json"),
        serde_json::json!({
            "session_id": session_id,
            "project_path": project_dir.to_string_lossy(),
            "created_at": "2025-01-01T00:00:00Z",
            "last_activity_at": "2025-01-01T00:00:00Z",
        })
        .to_string(),
    )
    .expect("write session.json");

    let path = session_dir.join("session.json");
    let path = path.to_string_lossy().to_string();

    // Warm the session via open_session.
    let _seed = driver
        .open_session(path.clone())
        .await
        .expect("open_session should warm the session");

    let spawned = handle.spawned();
    assert_eq!(spawned.len(), 1, "one fake daemon should have been spawned");

    // Snapshot the claim count before detach — the initial open claimed once.
    let claim_count_before = spawned[0]
        .recorded_calls()
        .iter()
        .filter(|(m, p)| m == "POST" && p == "/tui-attachment/claim")
        .count();
    assert_eq!(
        claim_count_before, 1,
        "initial open should have claimed the lease exactly once"
    );

    // Detach.
    driver
        .detach_session(path.clone())
        .await
        .expect("detach_session should succeed");

    assert!(
        spawned[0].called("DELETE", "/tui-attachment/lease-1"),
        "detach should release the lease via DELETE /tui-attachment/lease-1; \
         calls: {:?}",
        spawned[0].recorded_calls()
    );

    assert!(
        !spawned[0].called("POST", "/terminate"),
        "detach must NOT terminate the daemon (no POST /terminate); \
         calls: {:?}",
        spawned[0].recorded_calls()
    );
}

#[tokio::test]
async fn detach_then_reopen_reclaims_lease() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "detach-reopen");
    let handle = override_guard.handle();

    let (driver, dir) = make_driver().await;

    let session_id = "detach-reopen-1";
    let sessions_dir = dir.path().join("sessions");
    let session_dir = sessions_dir.join(session_id);
    std::fs::create_dir_all(&session_dir).expect("mkdir session dir");
    let project_dir = dir.path().join("project");
    std::fs::create_dir_all(&project_dir).expect("mkdir project dir");
    std::fs::write(
        session_dir.join("session.json"),
        serde_json::json!({
            "session_id": session_id,
            "project_path": project_dir.to_string_lossy(),
            "created_at": "2025-01-01T00:00:00Z",
            "last_activity_at": "2025-01-01T00:00:00Z",
        })
        .to_string(),
    )
    .expect("write session.json");

    let path = session_dir.join("session.json");
    let path = path.to_string_lossy().to_string();

    // Warm the session.
    let _seed1 = driver
        .open_session(path.clone())
        .await
        .expect("first open_session should succeed");

    // Detach — releases the lease, removes from warm pool, daemon stays alive.
    driver
        .detach_session(path.clone())
        .await
        .expect("detach_session should succeed");

    let _seed2 = driver
        .open_session(path.clone())
        .await
        .expect("re-open after detach should re-claim the lease without error");

    // A second fake daemon was spawned (the cold-start re-open).
    let spawned = handle.spawned();
    assert_eq!(
        spawned.len(),
        2,
        "re-open after detach should spawn a second fake daemon (cold-start)"
    );

    // The second daemon's lease was claimed (proving re-attach succeeded).
    assert!(
        spawned[1].called("POST", "/tui-attachment/claim"),
        "re-open should re-claim the lease on the new daemon; calls: {:?}",
        spawned[1].recorded_calls()
    );

    // The first daemon was never terminated by the detach.
    assert!(
        !spawned[0].called("POST", "/terminate"),
        "detach must NOT terminate the first daemon; calls: {:?}",
        spawned[0].recorded_calls()
    );
}
