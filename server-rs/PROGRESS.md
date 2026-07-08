# Rust Server Port — Status & Resumption Plan

**Status (2026-07-08):** Phase 5 complete. 498 Rust tests green (5 daemon-types,
64 protocol, 396 lib [5 `#[ignore]`], 8 corpus, 25 live_path), 761 TS tests
green, 298/298 Rust-server e2e (0 deterministic failures). `cargo clippy
--all-targets -- -D warnings` + `cargo fmt --check` clean. Mock-e2e burn-down
complete (Phase 1); live-path validation parts 1–2 complete (Phases 2, 2.5, 5);
6 live-path `BUG:` markers resolved (Phase A). Phase 3 `/health` real counts +
`build_sha` env + web push delivery (VAPID keygen + `/push/*` + hub `notify`)
done; `sessions-registry` (15) + `lease-retry` (11) tests ported. Remaining:
daemon-client.test.ts subset (needs an HTTP mock seam for setModel/subscribe;
the spawn-seam + pure-helper + waitForDaemonStartup parts are tractable now);
Phase 3 cutover mechanics (live smoke, default flip).

## Goal

Replace the Bun/TS server (`server/`) with a Rust server implementing the same
WS protocol, HTTP endpoints, and driver behavior — validated against the e2e
suite AND the ported unit-test suite. Delete the TS server only after both
validation legs are green plus a live-daemon smoke test.

## Where the port actually stands

**Ground truth (2026-07-07, full suite, one machine — Phase 5 done):**

- `cargo test`: **430/430 pass** (5 daemon-types, 64 protocol, 334 server lib
  [5 `#[ignore]`], 8 corpus, 19 live-path integration).
- `cargo clippy --all-targets -- -D warnings`: 0 warnings.
- `bun test` (TS side): 761/761 pass.
- e2e vs Bun server (control): 320/321 pass (1 load-induced flake:
  `sidebar-drafts`; passes in isolation, flakes identically vs Bun).
- e2e vs Rust server (`PILOT_SERVER_IMPL=rust`): 298/0 (3.0 min,
  `--project=desktop`). 2 known load-induced flakes (dir-picker, sidebar-drafts)
  pass in isolation.
- server-rs is in CI: `rust-server` job runs fmt + clippy (`-D warnings`) +
  test. `bun run check:rs` runs the same locally.

**Phase 1 (mock-e2e cluster burn-down) — COMPLETE:** failures 33 → 0
deterministic across 7 clusters (models, queue, new-session-failure,
context-meter, reload-session, update-card, singletons), each test-first and
review-approved.

### What is done and trustworthy

- `pilot-protocol` — wire types, fold reducer, session-driver types; ported with
  tests (36 vs TS's 38).
- `journal.rs` (17 tests), `pidlock.rs` (18), `history_seed.rs` (21 vs TS 18),
  `settings_store`, `static_serve`, `config` — ported with tests. ⚠
  `history_seed`: the ported timestamp fabrication is deletable on the next
  daemon bump (unstable.6 ships `emitted_at`); don't extend it. Also note the
  known TS bug that only 3 of 12 history kinds are replayed.
- `pilot-daemon-types` — codegen from `polytoken openapi` (161 types).
- `daemon_client.rs` — 1:1 method-surface port including lease retry.
  **Untested** — dedicated test ports still open (Phase 2 item 4). SSE liveness
  is heartbeat-based (Phase 2.0).
- `event_map.rs` / `ui_bridge.rs` — accumulator model ported + tested
  (event-map 124 active + 5 `#[ignore]`, ui-bridge 38/38). The 5 `#[ignore]`s
  are generated-type gaps (4: closed enums reject unknown variants the TS
  forward-compat cases construct; `ProviderError::Transport` lacks a `kind`
  field) + 1 daemon-type collapse (`current_goal` single-Option can't
  distinguish present-but-omitted from null). All phase-named; want richer
  generated types (Phase 4).
- `hub.rs` — all 35 ClientMessage types handled; mock-e2e-validated + ~37 ported
  unit tests. I/O-shaped live-path handlers (SSE, daemon effects) covered by
  `live_path` integration tests (Phase 2).
- `background_model.rs` — port of `resolveBackgroundModel`; 10 tests. `script:`
  path is a fail-loud stub. Only `.warning` is wired into `pilot_settings_msg`;
  background-model *application* to turns is separate follow-up.
- `mock_driver.rs` — direct port of TS MockDriver; all fixture scripts present;
  e2e wiring works end-to-end.
- `shared/` modules — `worktree_name` (2), `warm_cap` (10), `session_list` (4),
  `login_env` (11 pure + impure wired), `worktree` (8+1 git), `archive_store`
  (5), `worktree_store` (10) — all ported with tests and wired into the live
  `PolytokenDriver` (Phase 5). `set_archived` + `login_env_status` also wired
  (2026-07-07 "leg 1" cleanup).
- `fake_daemon.rs` — runtime-controllable in-process fake daemon
  (`PILOT_DRIVER=fake`); corpus-backed dev surface (`/debug/reset` + `mock` WS
  message); `e2e/live` Playwright tier (5 specs, corpus subset — D21).

**The load-bearing caveat:** test-porting stopped where the code became
I/O-shaped. The remaining gap is the I/O-shaped daemon/hub integration tests:

| TS test file | cases | Rust counterpart |
|---|---|---|
| `hub.test.ts` | 64 | 0 |
| `hub-journal.test.ts` | 14 | 0 (journal unit ≠ hub integration) |
| `daemon-client.test.ts` | 14 | 0 (subset tractable: pure helpers + spawn seam + waitForDaemonStartup; `setModel` 409 + `subscribe` liveness need an HTTP mock seam in `DaemonClient`, not yet introduced) |
| `lease-retry.test.ts` | 11 | ✅ 11 + 2 extra (ported 2026-07-08; sleep seam added) |
| `sessions-registry.test.ts` | 15 | ✅ 15 (ported 2026-07-08) |

The e2e suite runs the **mock driver only** (plus the `e2e/live` corpus-subset
tier). "e2e passes" must not be read as "the live path is validated" — the mock
tier validates hub + protocol + client; the `e2e/live` tier validates the driver
stack over a corpus-backed fake daemon.

## Live corpus capture — FROZEN (2026-07-06)

5/6 scenarios captured from a real deepseek daemon (`0.4.0-unstable.7`),
canonicalized + `/state`-redacted, no machine-specific data. Corpus is the
protocol-change canary for every polytoken bump / codegen regen.

| scenario | frames |
|---|---|
| `streaming-turn` | 22 |
| `queue-while-in-flight` | 65 |
| `abort` | 7 |
| `ask-user-question` | 291 |
| `tool-call-approval` | 74 |

**NOT captured:** `reconnect-stream-discontinuity` (requires forcing a
`stream_discontinuity`; SSE resume is an upstream no-op). Stays a seed fixture;
improved-stub the driver.

**Key findings (encoded in capture script / code, kept for re-capture reference):**
- Permission gating needs `standard` matcher + a version-2 `permissions.yaml`
  with `ask` rules (`standard` alone doesn't prompt).
- Real `/state` has **no top-level `turn_in_flight`** field.
- Real event types the seeds lacked: `notification_autodrain_switch`,
  `permission_monitor_switch`, `system_reminder`, `content_block{thinking}` +
  `signature_delta`, `session_state_changed{domains}`.
- Model thinking/text content is irreducibly non-deterministic — the corpus is a
  human-reviewed drift canary, not a byte-exact oracle.

**Grow-the-corpus path:** capture a new scenario
(`scripts/capture-daemon-corpus.ts`, operator + `$DEEPSEEK_API_KEY`), add a
`run_script` match arm + an `e2e/live` spec.

## Phase 2 live-path validation — COMPLETE

The live path (`daemon_client` → `event_map` → `driver`, ~5.7k lines) had zero
coverage. This phase built the fake-daemon harness (axum router replaying the
corpus over an ephemeral port + `spawn_override` seam), wired the warm-session
lifecycle (was entirely dead-code — `#[expect(dead_code)]`), fixed SSE ordering
(one per-session mpsc consumer task), and implemented the FetchState/RefetchQueue
effects. The `Arc<PolytokenInner>` split resolved the `&self`-vs-`Arc<Self>`
structural knot. 19 live-path integration tests cover the ACs.

## Wrong turns to undo

1. **Fake-daemon architecture — resolved.** The original fake daemon was buried
   (Phase 0.1), rebuilt in Phase 2 as a corpus-replaying axum router speaking
   real `DaemonEvent`s, and promoted in Phase 2.5 to a runtime-controllable dev
   surface (`PILOT_DRIVER=fake`, `src/polytoken/fake_daemon.rs`) + `e2e/live`
   Playwright tier (D21).

2. **Live-path bugs — all resolved.** SSE per-event spawning, FetchState/
   RefetchQueue no-ops, `$HOME` workspace fabrication, `opts.worktree`/
   `login_env` drops, `list_sessions` hardcoded closures, `warm_cap` unenforced,
   `set_archived`/`login_env_status` unwired — all fixed and tested (Phases 2,
   5, A). One out-of-scope gap remains: the reload re-warm-via-attach path
   needs `startup.json` (session-registry/worktree port); the harness asserts
   disposal + no-deadlock, not re-warm emission.

3. **Silent-degradation — mostly resolved.** Remaining open spots:
   - ✅ `/push/*` endpoints wired (Phase 3, 2026-07-07): VAPID keygen +
     `send_to_all` delivery + hub `notify`. On-device delivery validation
     still manual (same as TS).
   - ✅ `/health` returns real client/running/initializing/busy counts
     (Phase 3, 2026-07-07).
   - ✅ `build_sha` reads `PILOT_BUILD_SHA` via `option_env!` (Phase 3,
     2026-07-07); still needs a build step to set the var.
   - ✅ `POST /update/state`, error-message parity, `OpenDataDir` spawn error,
     blanket `#![allow]` — all fixed.

4. **Concurrency model — partly standing.** Hub is
   `Arc<parking_lot::Mutex<SessionHub>>`; Phase 1's completion-queue (bounded
   mpsc + single applier task, FIFO dispatch order) killed the connect-time
   fan-out races. **Still standing:** the Rust queue serializes in *dispatch*
   order (stricter than TS, which fires concurrently and applies in completion
   order) — accepted for this single-user tool but noted.

5. **CI enforcement — resolved.** server-rs is in CI (Phase 0.2).

## Resumption plan

Three standing invariants while you work:

1. **The Bun control must stay green.** `bun run test:e2e` (against the TS
   server) is the oracle for "is this failure mine or the suite's". If it goes
   red, stop and fix that first.
2. **jj discipline**: review with `jj diff --git`, commit per completed task,
   imperative subject ≤72 chars, only the files you touched.
3. **Pin the corpus, not the daemon** (D20). Determinism comes from the
   committed golden SSE corpus (`server-rs/tests/corpus/<version>/`). On a bump:
   re-run codegen, replay the corpus as the drift canary, adopt newly
   daemon-owned fields, re-capture only on conscious adoption.

The cutover gate is **four legs**: ported unit tests green, mock e2e green,
fake-daemon e2e green (Phase 2.5 ✓), live smoke (Phase 3).

### Daemon-owned first — check the changelog (standing)

Before porting, fixing, or testing any daemon-facing workaround, check
<https://docs.polytoken.dev/changelog/> and diff a fresh `polytoken openapi`
dump — prefer deleting a workaround the daemon now owns over porting it
faithfully.

> **Version status (2026-07-07):** installed **0.5.0-unstable.1**. Bearer-token
> auth (PT-235) is **adopted**: `DaemonClient` reads the credential file and
> sends `Authorization: Bearer <token>` on every HTTP request (including SSE
> and the lease heartbeat). `spawn_resume_daemon` passes `--credential-file`.
> `open_session` now cold-starts a resume daemon when no running daemon is found
> (matching the TS server). Codegen re-run against 0.5.0 (new `UnauthorizedResponse`,
> `credential_file_path` on `SessionRecord`; removed `Subsession*` event variants).
> The TS server (`server/`) was NOT updated — cutover to Rust-only.
> Re-check only on the *next* bump: re-run codegen, replay the corpus as the
> drift canary, adopt newly daemon-owned fields, re-capture only on conscious
> adoption.

**Confirmed still daemon-gaps (probed live, 2026-07-04):**
- SSE resume is a silent no-op — `Last-Event-ID: 100` replays nothing. Reconnect
  recovery stays reseed-on-`stream_discontinuity` until upstream implements
  resume (ask #4, reframed in `docs/polytoken-upstream-feature-asks.md`).
- `GET /events` streams with no TUI lease claimed — read-only observing may
  already exist (ask #12).

### Phase 0 — truth & guardrails — COMPLETE

- [x] Deleted as-built mock-mode remnants (`Passthrough` variant,
      `fake_daemon_url` plumbing); codegen re-run clean.
- [x] Added server-rs to CI (`rust-server` job: fmt + clippy `-D warnings` +
      test); `check:rs` script; `Cargo.lock` tracked.
- [x] Removed blanket `#![allow(dead_code)]` / `#![allow(unused_variables)]`;
      survivors converted to item-level `#[expect]`.
- [x] Progress claims made reproducible (per-spec failure table).

### Phase 1 — mock-mode e2e to green — COMPLETE

- [x] Hub completion queue landed (bounded mpsc + single applier, FIFO dispatch
      order). Note: serializes in dispatch order (stricter than TS's completion
      order); accepted for single-user tool.
- [x] All 7 failure clusters cleared test-first, review-approved: models,
      queue, new-session-failure, context-meter, reload-session, update-card,
      singletons. Failures 33 → 0 deterministic.
- [x] Error-message parity restored (the "~17 vs ~6" gap was mostly illusory;
      one real silent spot — `OpenDataDir` — fixed).

### Phase 2 — live-path validation, part 1 — MOSTLY COMPLETE

- [x] Accumulator stays server-side Rust (D19).
- [x] `event-map.test.ts` (124+5) + `ui-bridge.test.ts` (38) ported; fixed
      `goal_driver_update` proposed-blank bug.
- [x] SSE ordering fixed (per-session mpsc consumer; 250 ordered deltas).
- [x] `FetchState` emit + `RefetchQueue` → `queueUpdated` implemented.
- [~] Corpus: 5/6 real captures FROZEN (see "Live corpus capture" above).
- [x] Fake-daemon harness built (axum router + `spawn_override`; 19 integration
      tests).
- [~] **Port `daemon-client.test.ts` + `lease-retry.test.ts` (25).** ✅
      `lease-retry.test.ts` (11) ported (2026-07-08) + a sleep seam
      (`retry_claim_with_sleep`). Spawn seam already exists
      (`spawn_override`/`set_spawn_override`). `daemon-client.test.ts` (14)
      partially tractable: pure helpers (`parse_spawn_output`,
      `parse_lease_held_error`) + the spawn seam + `waitForDaemonStartup` (file
      polling) port directly; the `setModel` 409 + `subscribe` liveness tests
      need an HTTP mock seam in `DaemonClient` (it uses `reqwest::Client`
      directly — no trait seam yet). **Open follow-ups surfaced during the
      lease-retry port:** (a) `retry_claim` retries on ANY `Err` (TS re-throws
      non-lease errors immediately) — `claim_lease` models non-409s as
      `LeaseConflictError { held: None }`, so a 500 retries 4×; fix needs a
      `LeaseError { Conflict, Other }` enum. (b) `claim_lease_with_retry`
      inlines its own retry loop and doesn't call `retry_claim` — the sleep seam
      covers the standalone fn, not the production path; dedupe to close the gap.
- [x] `shared/` modules ported with tests and wired into live driver (Phase 5).
      ✅ `sessions-registry` (15 tests) ported (2026-07-08): the Rust module
      had no tests; all 15 TS cases now mirrored (mtime sort, cold-entry
      fallbacks, archive/worktree merge).
- [x] `open_session` `$HOME` fabrication fixed (reads real cwd from
      `session.json`).

### Phase 2.5 — fake-daemon e2e tier — COMPLETE

- [x] Dev surface: `PILOT_DRIVER=fake` boots the real `PolytokenDriver` over an
      in-process, corpus-backed fake daemon. `/debug/reset` → `driver.reset`
      (keeps bootstrap warm for synchronous `seed_default`); `mock` WS message →
      `driver.run_script(name)` (maps script → corpus scenario, pushes SSE
      frames). Integration tests cover boot, reset, and script-push.
- [x] Playwright live tier: separate `playwright.live.config.ts` runs
      `e2e/live/*.e2e.ts` (5 specs) against `PILOT_DRIVER=fake` via
      `bun run test:e2e:live`. Corpus SUBSET (D21), not the full mock suite.
      First run found + fixed a bootstrap bug (idle scenario synthesized;
      `run_script` arms HTTP override). All 5 pass locally. CI job `web-live`
      is gated to `workflow_dispatch`; next step is a CI dispatch run, then
      promote to PR gate.
- [ ] Revisit after cutover: if fake-daemon tier is green and comparably fast,
      consolidate to one mock (delete MockDriver) rather than carrying both.

### Phase 3 — cutover mechanics

- [~] **Bump polytoken** — mostly absorbed (unstable.6/5 work done). What
      remains: the mechanical bump ritual for the *next* release (re-run
      codegen, replay corpus as drift canary, adopt daemon-owned fields,
      re-capture on conscious adoption). TS server needs the same adaptation
      while it remains the escape hatch.
- [ ] **Live smoke** as the final gate: drive a real daemon session through the
      GUI (new session, prompt, stream, approve a tool, switch model/facet,
      abort, archive); diff `/debug/state` against the Bun server where feasible.
- [x] `/health`: real client/running/initializing/busy counts. (2026-07-07)
      `client_count()` mirrors TS `clientCount()`; the handler returns
      `{ok, clients, running, initializing, busy}` matching the TS shape.
- [~] Push: VAPID keygen + web-push delivery + `/push/*` endpoints + hub
      `notify` wired (2026-07-07). VAPID keypair via `jwt-simple` `pure-rust`
      (no BoringSSL/cmake); `send_to_all` fans out concurrently via
      `join_all`; 404/410 → prune. **Still manual:** on-device delivery
      validation (same as TS — the crypto/HTTP path can't be unit-tested
      without a mock push service; `is_dead_status`/`classify_send_result`
      are the tested pure helpers).
- [~] `build_sha` from the dist marker — reads `PILOT_BUILD_SHA` at compile
      time via `option_env!` (empty in dev). Still needs a build step (CI /
      `build.rs`) to actually set the var; the read path is wired.
- [ ] Flip the default server impl; keep `server/` for one release as the escape
      hatch; update AGENTS.md, docs/DECISIONS.md, docs/TODO.md, package.json
      scripts, CI.

### Non-goals (explicitly)

- Don't rebase the existing e2e suite off MockDriver during the burn-down — the
  fake-daemon tier is **added**, not swapped in.
- No Passthrough-style shortcuts in the fake daemon: if it doesn't speak real
  `DaemonEvent`s end to end, it validates nothing.
- Don't rewrite the hub as a full actor; the completion-queue-over-mutex
  discipline is the chosen middle ground.
- Don't chase individual e2e specs with special-cased fixes; every fix lands
  with its ported unit tests.

## How to verify current state

```bash
cd server-rs && cargo test                      # 430 tests, green
cd server-rs && cargo clippy --all-targets -- -D warnings   # 0 warnings
bun run check:rs                                # fmt + clippy + test locally (CI gate)
bun test                                        # 761 tests, green
bun run test:e2e                                # control vs Bun server (320/321; 1 suite-level flake)
bun run test:e2e:live                           # corpus-subset live tier vs fake daemon (5 specs)
PILOT_SERVER_IMPL=rust bunx playwright test --project=desktop   # vs Rust server: 298/298
```
