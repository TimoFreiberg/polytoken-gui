# Rust Server Port — Status & Resumption Plan

Last updated: 2026-07-04 (full review of the port; supersedes the previous
progress report, which overstated verification. Plan revised same day after
design discussion: fake-daemon e2e tier reinstated as Phase 2.5, hub
completion queue made deliberate in Phase 1.)

## Goal (unchanged)

Replace the Bun/TS server (`server/`) with a Rust server implementing the same
WS protocol, HTTP endpoints, and driver behavior — validated against the e2e
suite AND the ported unit-test suite. Delete the TS server only after both
validation legs are green plus a live-daemon smoke test.

## Where the port actually stands

**Ground truth (2026-07-04, full suite, one machine, same commit):**

- `cargo test`: 143/143 pass (5 daemon-types, 64 protocol, 74 server).
- `bun test` (TS side): 760/760 pass.
- e2e vs Bun server (control): **321/321 pass** (3.6 min).
- e2e vs Rust server (`PILOT_SERVER_IMPL=rust`): **250/321 pass, 71 fail**
  (~78%, not the previously claimed 85%; the run takes ~30 min because each
  failure burns 30 s timeouts × retries).
- server-rs is in **no CI job** (the cargo steps in ci.yml are for `desktop/`)
  and not in `bun run check`. Nothing enforces fmt/clippy/test for the port.

Observed failure clusters (from artifacts; a mid-run wipe made per-spec counts
approximate — re-run for exact numbers): sessions (~9, list/switching),
drafts + dir-picker (~10, the new-session flow: QueryDir/StatPath semantics),
models (~4, incl. missing `modelDefaults` broadcast), streaming, branch,
archive, lease-conflict, context-meter (liveTick/refreshUsage), reload-session,
new-session-failure (error propagation), update-card, transcript, slash
(command list content), status-indicators (background-run status), settings,
sidebar-*, rename, scroll-follow, resume-reconnect, images, file-mention,
adventurous-handoff, active-unread, notification-autodrain,
new-session-transition, cross-session-attention.

**What is genuinely done and trustworthy:**

- `pilot-protocol` (wire types, fold reducer, session-driver types) — ported
  *with* tests (36 vs TS's 38) and survived a parity review pass.
- `journal.rs` (17 tests), `pidlock.rs` (18), `history_seed.rs` (21 vs TS 18),
  `settings_store`, `static_serve`, `config` — ported with tests.
- `pilot-daemon-types` codegen from `polytoken openapi` (161 types) — real
  pipeline, minus one landmine (see Passthrough below).
- `daemon_client.rs` — 1:1 method-surface port of daemon-client.ts including
  lease retry; compiles, looks careful. **Untested.**
- `event_map.rs` — structured port of the accumulator model. **Untested.**
- `hub.rs` — all 35 ClientMessage types have handlers. **Untested.**
- `mock_driver.rs` — direct port of the TS MockDriver; all fixture scripts
  present; e2e wiring via `scripts/dev.ts` works end to end.

**The load-bearing caveat:** test-porting stopped exactly where the code became
I/O-shaped. TS has ~285 test cases with no Rust counterpart, concentrated on
the modules that matter most for cutover:

| TS test file                        | cases | Rust counterpart tests |
| ----------------------------------- | ----- | ---------------------- |
| hub.test.ts                         | 64    | 0                      |
| hub-journal.test.ts                 | 14    | 0 (journal unit ≠ hub integration) |
| polytoken/event-map.test.ts         | 129   | 0                      |
| polytoken/ui-bridge.test.ts         | 38    | 0                      |
| polytoken/daemon-client.test.ts     | 14    | 0                      |
| polytoken/lease-retry.test.ts       | 11    | 0                      |
| polytoken/sessions-registry.test.ts | 15    | 0                      |
| shared/* (worktree, login-env, warm-cap, background-model, session-list) | 53 | modules not ported |

And the e2e suite runs the **mock driver only**, so the live path
(`daemon_client` → `event_map` → `driver`, ~5.7k lines) currently has **zero
coverage of any kind**. "e2e passes" must not be read as "the port is
validated" — it validates hub + protocol + mock.

## Wrong turns to undo (ranked)

1. **The fake-daemon architecture was abandoned but not buried.**
   Phase 5 built `fake_daemon.rs` (mock = in-process daemon behind the real
   driver). The e2e work then pivoted to a direct `MockDriver` port ("simpler,
   matches TS architecture" — a defensible call). But the corpse remained:
   - `fake_daemon.rs` (281 lines) is dead code — `fake_daemon_router()` is
     mounted nowhere; most handlers are stubs.
   - `DaemonEvent::Passthrough` was **hand-inserted into the auto-generated**
     `pilot-daemon-types/src/lib.rs` (marked DO NOT EDIT). Re-running the
     codegen deletes it and breaks the build.
   - Passthrough tunnels pre-mapped pilot events, bypassing the event_map
     accumulator — so even revived, it validates nothing about the real
     mapping layer.
   - Docs described the dead design as live (AGENTS.md, this file's old goal,
     server-rs/README.md, main.rs's driver-selection comment — all fixed
     2026-07-04).

2. **Live-path bugs visible by inspection** (no test exists to catch them —
   that's the point):
   - `driver.rs` SSE handling spawns a task **per event**
     (`subscribe` callback → `tokio::spawn(handle_sse_event)`); tokio tasks are
     unordered, so two streaming deltas can fold out of order → garbled
     accumulator/transcript under bursts. TS processes SSE sequentially.
   - `DaemonEffect::FetchState { emit, prompt_id }` ignores both fields:
     refreshes the cached state but never emits, so clients never see it.
   - `DaemonEffect::RefetchQueue` is a TODO — `queueUpdated` never emitted.
   - `new_session` ignores `opts.worktree` (worktree module unported) and
     passes `login_env: None` (login-env unported).
   - `open_session` fabricates the workspace path from `$HOME`.
   - `list_sessions` hardcodes `archived_for: |_| false`,
     `worktree_for: |_| None` (archive-store/worktree-store unported).
   - `warm_cap` is parsed into config and **enforced nowhere** — the warm
     daemon pool grows without bound.
   - The hub never sends `modelDefaults` (TS broadcasts it).

3. **Silent-degradation idiom.** Repo philosophy is fail-loud; the port
   routinely does the opposite:
   - `POST /update/state` never parses the body — every call behaves as
     "no update available" and *clears* any pending update sha.
   - `/push/*` endpoints return hardcoded `{ok:true}`; `push.rs` (store +
     service shell) exists but is unwired; VAPID keygen + delivery are TODO;
     the hub's `notify` is `None`.
   - `/health` returns hardcoded zeros for clients/running/busy.
   - Driver failures return empty `Vec` — no `{type:"error"}` to the client
     (TS sends errors in ~17 places; Rust in ~6). The `new-session-failure`
     e2e cluster fails exactly here.
   - Nine modules carry blanket `#![allow(dead_code)]`; `driver.rs` adds
     `#![allow(unused_variables)]` — which is precisely what hid the ignored
     `opts.worktree` / `emit` / `prompt_id` parameters from the compiler.
   - `build_sha` is hardcoded empty.

4. **Concurrency model divergence, undocumented.** The hub is a global
   `Arc<parking_lot::Mutex<SessionHub>>`; async driver calls are fire-and-forget
   `tokio::spawn`s that re-lock to deliver. That's a workable transplant of the
   single-threaded TS model, but: one deadlock already happened (fixed in
   review), reset races needed a generation-counter band-aid, and completion
   *ordering* is racy where TS is deterministic (e.g. the connect-time
   sessionList/modelList/commandList/facetList/fileIndex fan-out). Every new
   handler re-derives the locking rules from folklore.

5. **No enforcement.** server-rs is absent from CI and from `bun run check`.

## Resumption plan

For the implementer: work the phases top-down; each gates the next. Two
standing invariants while you work:

1. **The Bun control must stay green.** `bun run test:e2e` (against the TS
   server) is the oracle for "is this failure mine or the suite's". If it
   goes red, stop and fix that first.
2. **jj discipline**: review with `jj diff --git`, commit per completed task,
   imperative subject ≤72 chars, only the files you touched.

The cutover gate is **four legs**, not one: ported unit tests green, mock e2e
green, fake-daemon e2e green (Phase 2.5), live smoke (Phase 3). Mock-e2e alone
proves hub+protocol+client — it never touches the live driver stack.

### Phase 0 — truth & guardrails (small, do first)

- [ ] Delete the as-built mock-mode remnants: `fake_daemon.rs`, the
      `Passthrough` variant in `pilot-daemon-types`, the `Passthrough` arm in
      `event_map.rs`, and the `with_fake_daemon_url`/`fake_daemon_url`
      plumbing in `driver.rs`. Re-run
      `bun run scripts/codegen-polytoken-rs.ts` and commit clean generated
      output. (The fake-daemon *concept* returns in Phase 2.5, rebuilt to
      speak real `DaemonEvent`s — the current skeleton validates nothing
      (Passthrough bypasses event_map) and the hand-edited generated file is
      a regen landmine. jj history keeps the old skeleton for reference.)
- [ ] Add server-rs to CI: `cargo fmt --check`, `cargo clippy --locked
      --all-targets -- -D warnings`, `cargo test`, rust-cache with
      `workspaces: server-rs`, like the existing `desktop/` job. Consider a
      `check:rs` script.
- [ ] Remove the blanket `#![allow(dead_code)]` / `#![allow(unused_variables)]`;
      convert survivors to item-level `#[expect(dead_code, reason = "...")]`
      so the compiler enumerates remaining gaps and complains when they're
      done. Expect this to surface every ignored parameter listed above.
- [ ] Keep progress claims reproducible: commit the full-suite line-reporter
      output (or a per-spec table) instead of prose percentages.

### Phase 1 — mock-mode e2e to green, test-first (hub semantics)

Stay on `MockDriver` for this phase — the thin deterministic stack plus the
Bun control is what makes each of the 71 failures attributable in minutes.

- [ ] **Land the hub completion queue first** (decided, not wait-for-pain):
      all fire-and-forget `tokio::spawn` driver completions funnel through
      one `mpsc` consumed by a single applier task that locks the hub and
      applies results in FIFO order. Keeps the Mutex; restores TS's
      deterministic ordering; kills the connect-time fan-out races
      (sessionList/modelList/commandList/facetList/fileIndex). The same
      queue-over-bare-mutex idiom is reused for SSE in Phase 2 — one
      concurrency pattern everywhere, documented in the hub.rs header.
- [ ] Work the failure clusters largest-first (see ground truth above). For
      each cluster, port the relevant `hub.test.ts` / `hub-journal.test.ts`
      cases *before* fixing, so hub coverage back-fills as the burn-down
      proceeds (target: all 64+14 cases ported by the end of this phase).
- [ ] Restore error-message parity: audit all TS `{type:"error"}` sends
      (~17 sites) and mirror them; driver failures must be client-visible —
      the `new-session-failure` cluster is this bug.

Rule: fix by porting TS semantics, never by teaching the mock what the spec
wants.

### Phase 2 — live-path validation, part 1: units + integration harness

- [ ] Port `event-map.test.ts` (129 cases; pure functions, mechanical,
      highest bug-yield per hour) and `ui-bridge.test.ts` (38).
- [ ] Fix the SSE ordering bug with the Phase-1 idiom: per-warm-session
      `mpsc` + one consumer task. Never per-event `tokio::spawn` — that's the
      current bug (two streaming deltas can fold out of order).
- [ ] Implement `DaemonEffect::FetchState`'s emit path (`emit`/`prompt_id`
      are currently ignored) and `RefetchQueue` → `queueUpdated`; port the
      TS tests that cover them.
- [ ] Build the **daemon-fixture corpus**: hand-translate the mock fixture
      scripts into real daemon wire sequences (`DaemonEvent`s over SSE plus
      the matching HTTP responses). Ground it with **golden recordings**:
      capture a few real polytoken SSE transcripts via the parity harness
      (streaming turn, tool call + approval, interrogative, abort) and commit
      them, so the corpus can't drift from what the daemon actually sends.
      This corpus is also the protocol-change canary for every polytoken
      bump / codegen regen.
- [ ] Integration tests: rebuild the fake daemon as a test axum router
      speaking the **real** wire protocol, driven by the corpus; bind an
      ephemeral port, point `PolytokenDriver` at it, assert emitted
      `SessionDriverEvent`s and the effect HTTP calls. This covers the
      composition MockDriver e2e can never see: SSE loop → accumulator →
      effects → HTTP back.
- [ ] Port `daemon-client.test.ts` + `lease-retry.test.ts` (25). Introduce a
      spawn seam equivalent to TS's `_setSpawnForTesting` — needed regardless
      of the fake daemon: spawn failure / process death can't be expressed on
      the wire (in fake mode nothing spawns). Lease conflicts and
      daemon-death-mid-session CAN be wire-expressed (claim rejection, SSE
      drop) — cover those in the fake-daemon integration tests.
- [ ] Port the `shared/` modules **with their tests** and wire them:
      `worktree` (+name, 8 tests) into `new_session`; `login-env` (15) into
      daemon spawn; `warm-cap` (10) into pool eviction; `background-model`
      (16) into settings/modelDefaults; `sessions-registry` tests (15).
      Port `archive-store` + `worktree-store` and wire `list_sessions`.
- [ ] Fix `open_session`'s `$HOME` workspace fabrication (read the session's
      real project path).

### Phase 2.5 — live-path validation, part 2: fake-daemon e2e tier

The point: reuse the whole existing e2e suite as continuous live-path
coverage. Flakes in this tier are product bugs (ordering, races) — the
fail-loud philosophy applied to tests — not noise to be waited away.

- [ ] Finish the rebuilt fake daemon's dev surface: `/dev/reset` and
      `/dev/script` replaying corpus sequences — this is what `/debug/reset`
      and the `mock` WS message hit when the server runs in fake-daemon mode
      (real `PolytokenDriver` → in-process fake daemon).
- [ ] Add a Playwright project (or env-gated CI job) running the FULL
      existing e2e suite in fake-daemon mode. Same specs, second backend.
- [ ] Keep the MockDriver project as the fast deterministic tier for UI dev
      (dev bar, Claude_Preview) and triage. Revisit after cutover: if the
      fake-daemon tier is green and comparably fast, consolidate to one mock
      (delete MockDriver) rather than carrying both out of inertia.

### Phase 3 — cutover mechanics

- [ ] Live smoke as the final gate: drive a real daemon session through the
      GUI via the parity harness (new session, prompt, stream, approve a
      tool, switch model/facet, abort, archive); diff `/debug/state` against
      the Bun server where feasible.
- [ ] `/health`: real client/running/initializing/busy counts.
- [ ] `POST /update/state`: parse `{available, sha, applyFailed}` (currently
      the body is discarded and the pending update sha is wiped).
- [ ] Push: VAPID keygen, web-push delivery, wire `push.rs` endpoints and the
      hub's `notify`.
- [ ] `build_sha` from the dist marker.
- [ ] Flip the default server impl; keep `server/` for one release as the
      escape hatch; update AGENTS.md, docs/DECISIONS.md, docs/TODO.md,
      package.json scripts, CI.

### Non-goals (explicitly)

- Don't rebase the existing e2e suite off MockDriver during the Phase-1
  burn-down — the thin stack and the Bun control are what make failures
  attributable. The fake-daemon tier is **added** (Phase 2.5), not swapped in.
- No Passthrough-style shortcuts in the rebuilt fake daemon: if it doesn't
  speak real `DaemonEvent`s end to end, it validates nothing — that is the
  exact mistake being undone.
- Don't rewrite the hub as a full actor; the completion-queue-over-mutex
  discipline (Phase 1) is the chosen middle ground.
- Don't chase individual e2e specs with special-cased fixes; every fix lands
  with its ported unit tests.

## How to verify current state

```bash
cd server-rs && cargo test                      # 143 tests, green
bun test                                        # 760 tests, green
bun run test:e2e                                # control vs Bun server: green
PILOT_SERVER_IMPL=rust bun run test:e2e         # vs Rust server: 71 failures
```
