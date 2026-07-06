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
                Ok(SpawnedDaemon {
                    session_id: session_id.clone(),
                    port,
                })
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

/// Build a driver pointed at a temp sessions dir (no real daemon needed).
fn make_driver() -> (PolytokenDriver, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let driver = PolytokenDriver::new(
        dir.path().to_path_buf(),
        "polytoken".into(), // never invoked — the override answers spawns
        false,
    );
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

    let (driver, _dir) = make_driver();
    let seed = driver.new_session(NewSessionOptsData::default()).await;

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

    let (driver, _dir) = make_driver();
    let (_sub_id, mut rx) = collect_events(&driver, 256);

    // new_session warms + subscribes SSE before returning the seed.
    let _seed = driver.new_session(NewSessionOptsData::default()).await;

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

    let (driver, _dir) = make_driver();
    let (sub_id, mut rx) = collect_events(&driver, 256);

    // Warm via new_session (spawn path) + subscribe SSE.
    let _seed = driver.new_session(NewSessionOptsData::default()).await;

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
