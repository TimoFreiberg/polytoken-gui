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

use pilot_daemon_types::SseEnvelope;
use pilot_protocol::session_driver::{SessionDriverEvent, SessionRef, WorkspaceRef};
use tokio::sync::Mutex;

use pilot_server::driver::{NewSessionOptsData, PilotDriver};
use pilot_server::polytoken::daemon_client::{
    SpawnDaemonOpts, SpawnedDaemon, clear_spawn_override, set_spawn_override,
};
use pilot_server::polytoken::driver::PolytokenDriver;
use pilot_server::polytoken::event_map::{self, DaemonEffect, MapCtx};

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
        status: pilot_protocol::session_driver::SessionStatus,
    ) -> pilot_protocol::session_driver::SessionSnapshot {
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
    fn live_status(&self) -> pilot_protocol::session_driver::SessionStatus {
        pilot_protocol::session_driver::SessionStatus::Idle
    }
}

// ===========================================================================
// Phase A — harness + spawn-seam smoke test (AC.1)
// ===========================================================================

/// AC.1: the fake-daemon harness serves a corpus scenario over a real ephemeral
/// axum port, and `PolytokenDriver` reaches it via the spawn seam. `new_session`
/// calls `spawn_daemon` (→ override → fake port) then health-poll → claim-lease
/// → `/history`. We assert all the lifecycle endpoints hit the fake (via its
/// recorded-call log), proving the spawn seam is exercised end-to-end.
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
// Phase B — warm-session lifecycle tests (AC.2)
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

    let image = pilot_protocol::session_driver::ImageContent::Image {
        data: "ZmFrZQ==".into(),
        mime_type: "image/png".into(),
    };
    driver
        .prompt(
            "hello with image".into(),
            Some(pilot_protocol::wire::DeliveryMode::FollowUp),
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
                    pilot_protocol::session_driver::HostUiRequest::Notify { message, level, .. },
                ..
            } if saw_user && message.contains("1 image was attached") => {
                assert_eq!(
                    level,
                    Some(pilot_protocol::session_driver::NotifyLevel::Warning)
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
            Ok((SpawnedDaemon { session_id, port }, Some(child)))
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

/// AC.2: after `new_session`, the warm session is SUBSCRIBED to daemon SSE and
/// FOLDING events — the thing that was entirely dead before Phase B. We stream
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
    // Small inter-frame delay so the SSE consumer has time to fold before the
    // stream ends (the driver's per-event spawn is still in place until Phase C;
    // a zero delay can race the consumer task shutdown).
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

/// AC.2: `reload_session` disposes the old warm session AND re-warms. We open a
/// session, observe one SSE-driven emission, call `reload_session`, then assert
/// the old warm was disposed (its SSE subscription stopped — no further
/// emissions from it) and the call returns without deadlock.
///
/// **Scope note:** the full re-warm (post-reload SSE flow) goes through
/// `open_session` → `warm_session_attach`, which resolves the daemon port from
/// `startup.json`. The harness doesn't write `startup.json` (that's the
/// session-registry/worktree port — Phase-2 item 5, explicitly out of scope),
/// so the attach path can't reach the fake after reload. This test therefore
/// asserts the in-scope half — disposal + no-deadlock — and leaves the
/// re-warm-via-attach emission assertion to when `startup.json` is wired. The
/// `warm_session_subscribes_and_folds_sse` test above already proves the warm +
/// fold path live; the reload disposal here proves the teardown half.
#[tokio::test]
async fn reload_session_disposes_old_warm_and_rewarms() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = corpus_loader::load_named(VERSION, "streaming-turn");
    let fake = Arc::new(fake_daemon::spawn(scenario.clone(), "reload-1".into(), 5).await);
    let _ovr = OverrideGuard::install(fake.clone());

    let (driver, _dir) = make_driver().await;
    let (sub_id, mut rx) = collect_events(&driver, 256);

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
    // client), then re-opens. The re-open goes through open_session →
    // warm_session_attach, which needs startup.json (out of scope), so it
    // returns an empty seed — but the disposal MUST happen first and MUST NOT
    // deadlock. The call completing (Ok or the documented empty-seed path)
    // proves disposal ran without hanging on the old SSE stop.
    let path = "reload-1.jsonl".to_string();
    let reseed = driver
        .reload_session(path)
        .await
        .expect("reload_session ok");
    // No startup.json → empty seed (the attach path falls through). This is the
    // documented out-of-scope gap, not a failure.
    assert!(
        reseed.is_empty(),
        "expected empty re-seed (startup.json not wired); got {} events",
        reseed.len()
    );

    // After disposal + a short drain window, no more emissions arrive from the
    // OLD warm (its SSE subscription was stopped). A fresh emission here would
    // mean the old consumer is still live — a leak. Give it a moment to settle.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let leaked = rx.try_recv().ok();
    assert!(
        leaked.is_none(),
        "old warm session still emitting after reload disposal (consumer leak): {:?}",
        leaked
    );

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
// Phase C — SSE ordering test (AC.3)
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
// in Phase 5 by the warm-cap in-flight-skip eviction test (AC.7 — a session
// whose /state reports turn_in_flight:true must never be evicted).
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
        let snapshot: pilot_daemon_types::SessionStateSnapshot = serde_json::from_value(state)
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

/// AC.3: SSE events fold sequentially through ONE per-session consumer (no
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
// Phase D — FetchState emit + RefetchQueue → queueUpdated (AC.4, AC.5)
// ===========================================================================

/// AC.4: a `FetchState` effect (from `message_complete`) emits the post-fetch
/// `RunCompleted` event with the threaded `prompt_id` as both entry ids, AND
/// the driver fetched fresh state (a `GET /state` hit the fake). The
/// streaming-turn scenario ends in `message_complete` → FetchState.
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

/// AC.5: a `RefetchQueue` effect (from `pending_turn_input_queued`) emits a
/// `QueueUpdated` carrying the full queue, AND the driver fetched it via `GET
/// /turn/input`. The queue-while-in-flight scenario carries
/// `pending_turn_input_queued`.
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

// ===========================================================================
// Phase 5 — new_session wiring: cwd resolution, worktree, login-env,
//           warm-cap eviction, invalid-cwd errors (AC.7, AC.8, AC.9, AC.12)
// ===========================================================================

/// AC.7: with `warm_cap = N`, warming `N+1` sessions via `new_session` evicts
/// exactly the least-recently-focused **idle** session. The synthetic idle
/// scenario serves `/state` with `turn_in_flight:false`, so every warmed
/// session is evictable. The most-recently-focused session (the N+1th, just
/// warmed) is protected; the LRU (the 1st, never re-focused) is the victim.
///
/// Eviction is observed two ways: (1) a `SessionClosed` event is emitted for
/// the victim, and (2) the victim is gone from the driver's warm pool —
/// observable via `list_sessions` (an evicted session with no on-disk
/// `session.json` disappears from the list, since `list_sessions` merges warm
/// + on-disk; the fake daemon writes no `session.json`).
///
/// **Warm-pool membership note:** there is no public `warm_session_ids()`
/// accessor on `PolytokenDriver`. The cleanest externally-observable proxy is
/// `list_sessions` (warm entries appear there until evicted; the fake daemon
/// writes no on-disk `session.json`, so only warm sessions surface). This is
/// documented here so a future refactor that adds a direct accessor can
/// sharpen the assertion.
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

/// AC.7 (in-flight skip): a session whose `/state` reports
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

/// AC.8: `new_session` with `worktree: Some(true)` creates an isolated git
/// worktree and runs the session in it. The resulting session's cwd is a
/// worktree path (a SIBLING of the repo, not the repo itself), and the
/// `WorktreeStore` records it.
///
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
            "user.email=pilot@example.test",
            "-c",
            "user.name=Pilot Test",
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

/// AC.9: a driver constructed with an injected `login_env` threads that env
/// into every daemon spawn. We build the driver via `new_with_login_env` with a
/// known env map, install the multi-spawn override, call `new_session`, and
/// assert the captured `SpawnDaemonOpts.login_env` equals the injected map
/// (not `None` — the default-driver regression that AC.11's `#[expect]`
/// removal guarded against).
#[tokio::test]
async fn new_session_passes_captured_login_env_to_spawn() {
    let _guard = OVERRIDE_MUTEX.lock().await;

    let scenario = synthetic_idle_scenario();
    let override_guard = fake_daemon::MultiSpawnOverrideGuard::install(scenario, "login-env");
    let handle = override_guard.handle();

    // A known, non-empty env map — distinct from the default (None).
    let mut known_env: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    known_env.insert("PATH".to_string(), "/test/bin:/usr/bin".to_string());
    known_env.insert("PILOT_TEST_VAR".to_string(), "threaded".to_string());

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

/// AC.12: `new_session` with a nonexistent cwd produces a **specific** error
/// that names the bad path — not the generic empty-seed "session switch
/// returned no session" message. The driver validates `cwd.exists()` before
/// spawning and returns `Err(format!("no such directory: {cwd}"))`.
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

/// AC.5: `list_sessions` surfaces the real `archived` flag + worktree
/// indicator from the `ArchiveStore`/`WorktreeStore` (not the old hardcoded
/// `false`/`None`). We seed a `session.json` on disk + populate both stores
/// (by writing their JSON files before constructing the driver — they load
/// from disk at construction), then assert the cold session's entry carries
/// the correct flags.
///
/// This is a pure driver-integration test (no daemon spawn): it exercises the
/// `list_sessions` → `list_cold_sessions` + store-overlay path only.
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
        "name": "pilot-archive-wt"
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

    // AC.5: the archived flag is the real store value (true), not hardcoded false.
    assert!(
        entry.archived,
        "archived flag should be true (sourced from ArchiveStore); got false"
    );

    // AC.5: the worktree indicator is the real store value (Some), not None.
    let wt = entry
        .worktree
        .as_ref()
        .expect("worktree indicator should be Some (sourced from WorktreeStore)");
    assert_eq!(
        wt.path, project_path,
        "worktree indicator path should match the session cwd"
    );
    assert_eq!(wt.name, "pilot-archive-wt");
}

/// AC.1: `set_archived` flips the archive flag on the live driver — a later
/// `list_sessions()` overlays `archived == true`, and `archived.json` on disk
/// records the session path. `set_archived(_, false)` clears both.
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
            "user.email=pilot@example.test",
            "-c",
            "user.name=Pilot Test",
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

/// AC.2 (clean): archiving a session whose cwd is a clean pilot worktree reaps
/// it — the worktree dir is removed from disk, the store tombstones it (surfaced
/// as `worktree.reaped`), and no `worktree_retained` is returned.
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

/// AC.2 (dirty): archiving a session whose worktree has uncommitted changes
/// retains it — `set_archived` returns `worktree_retained` with the cwd and the
/// concrete reason, and the worktree dir stays on disk.
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
