# Rust Server Port — Status & Resumption Plan

Last updated: 2026-07-04 (full review of the port; supersedes the previous
progress report, which overstated verification. Plan revised same day after
design discussion: fake-daemon e2e tier reinstated as Phase 2.5, hub
completion queue made deliberate in Phase 1. Later the same day: folded in
daemon-owned items from the polytoken changelog (unstable.6) + live-daemon
probe results, added the "Daemon-owned first" standing section, the Phase-2
event-vocabulary gate, and the Phase-3 daemon-bump step.)

Chunk A (mock fixture text/lifecycle parity) is complete and reviewer-approved
(32/32 e2e specs pass, 1 flake confirmed), cutting failures 72 → 33 (~90%).
Chunk F (polish/prompt-nav + scroll) resolved (0 failures, no action needed).

## Goal (unchanged)

Replace the Bun/TS server (`server/`) with a Rust server implementing the same
WS protocol, HTTP endpoints, and driver behavior — validated against the e2e
suite AND the ported unit-test suite. Delete the TS server only after both
validation legs are green plus a live-daemon smoke test.

## Where the port actually stands

**Ground truth (2026-07-05, full suite, one machine, commit mzwoqyrt
"Rust server: add CI gate + clippy-clean (Phase 0.2)"):**

- `cargo test`: 143/143 pass (5 daemon-types, 64 protocol, 74 server).
- `cargo clippy --all-targets -- -D warnings`: 0 warnings (Phase 0.2).
- `bun test` (TS side): 760/760 pass.
- e2e vs Bun server (control): **321/321 pass** (3.6 min).
- e2e vs Rust server (`PILOT_SERVER_IMPL=rust`): **273 passed / 25 failed / 0
  flaky** (6.0 min, `--project=desktop`). Was 288/33 at the 2026-07-04
  baseline; Chunks B+C (sessions/drafts/branch/dir-picker parity) cut it to
  25. The per-spec failure table is below (reproducible: `PILOT_SERVER_IMPL=rust
  bunx playwright test --project=desktop --reporter=json`).
- server-rs is now in CI (Phase 0.2): the `rust-server` job runs
  `cargo fmt --check` + `cargo clippy --locked --all-targets -- -D warnings` +
  `cargo test` on ubuntu-latest. `bun run check:rs` runs the same locally.

### Rust-server e2e failure table (2026-07-05, 25 failures)

| spec file | failing test | status |
|-----------|--------------|--------|
| abort-restore | Escape aborts a pending turn and restores the sent prompt to the composer | failed |
| context-meter | the Clear context button uses a click-twice confirm gate | failed |
| context-meter | the Compact button uses a click-twice confirm gate | failed |
| file-mention | a draft's @-mention searches the draft cwd via the server; a real session doesn't | failed |
| images | pasting a screenshot attaches it and image-only send stays visible | failed |
| lease-conflict | a lease conflict surfaces a sticky Retry toast; retrying opens the session | failed |
| lease-conflict | a non-lease session-switch error does NOT get a Retry button | failed |
| models | the model picker lists models and switches the active one | failed |
| models | the thinking picker switches the level | failed |
| models | ⌘⇧E focuses the thinking menu; arrow+enter selects and returns focus | failed |
| models | ⌘⇧M focuses the model search; keyboard select returns focus to composer | failed |
| new-session-failure | a failed new session offers a restore toast when another draft is in progress | failed |
| new-session-failure | a failed new session overwrites an empty competing draft without a toast | failed |
| notification-autodrain | notification autodrain toggle flips in Settings | failed |
| prompt-delivery | a rejected prompt stays visible and can be returned to the composer | failed |
| queue | Alt+Up restores all text to one editor and clears every client | failed |
| queue | delivery removes one queued row and starts its user turn | failed |
| queue | queued modes survive reconnect and session refocus | failed |
| reload-session | the L hotkey reloads the menu's targeted session | failed |
| reload-session | the overflow menu reloads a session, reseeding its transcript | failed |
| settings | the background-model spec round-trips and warns loud on a bad spec | failed |
| sidebar-row | an unread session marks the left gutter and keeps its timestamp on the right | failed |
| slash | clicking a command inserts it | timedOut |
| update-card | clears when the update is no longer available | failed |
| update-card | shows when an update is staged and reflects applying on click | failed |

Cluster view: models (4), queue (3), new-session-failure (2), context-meter
(2), lease-conflict (2), reload-session (2), update-card (2), abort-restore
(1), file-mention (1), images (1), notification-autodrain (1), prompt-delivery
(1), settings (1), sidebar-row (1), slash (1). The dir-picker / sessions /
drafts / branch / archive clusters are now green (Chunks B+C).

Observed failure clusters: see the per-spec table above (2026-07-05, 25
failures). The dir-picker / sessions / drafts / branch / archive clusters
are green (Chunks B+C). Remaining clusters: models (4), queue (3),
new-session-failure (2), context-meter (2), lease-conflict (2),
reload-session (2), update-card (2), plus 7 singletons.

**What is genuinely done and trustworthy:**

- `pilot-protocol` (wire types, fold reducer, session-driver types) — ported
  *with* tests (36 vs TS's 38) and survived a parity review pass.
- `journal.rs` (17 tests), `pidlock.rs` (18), `history_seed.rs` (21 vs TS 18),
  `settings_store`, `static_serve`, `config` — ported with tests.
  (REVISIT `history_seed`: unstable.6 ships `emitted_at` on `/history` items —
  the ported timestamp-fabrication behavior becomes deletable, see
  "Daemon-owned first" below. Don't extend it; also remember the known TS bug
  that only 3 of 12 history kinds are replayed.)
- `pilot-daemon-types` codegen from `polytoken openapi` (161 types) — real
  pipeline; the old hand-edited `Passthrough` landmine has been removed.
- `daemon_client.rs` — 1:1 method-surface port of daemon-client.ts including
  lease retry; compiles, looks careful. **Untested.** (REVISIT before testing:
  the ported silence-vs-dead `/health`-probe dance predates unstable.5's SSE
  heartbeats — see "Daemon-owned first". Simplify first, then test.)
- `event_map.rs` — structured port of the accumulator model. **Untested.**
  (Behind the Phase-2 vocabulary gate — don't invest here until that call is
  made.)
- `hub.rs` — all 35 ClientMessage types have handlers. **Untested.**
- `mock_driver.rs` — direct port of the TS MockDriver; all fixture scripts
  present; Chunk A byte-matches TS mock replies; e2e wiring via
  `scripts/dev.ts` works end to end.

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

1. **The fake-daemon architecture is now buried.**
   Phase 5 built `fake_daemon.rs` (mock = in-process daemon behind the real
   driver). The e2e work then pivoted to a direct `MockDriver` port ("simpler,
   matches TS architecture" — a defensible call). Phase 0.1 removed the stale
   skeleton and regen landmine: `fake_daemon.rs`, `DaemonEvent::Passthrough`,
   the `Passthrough` event_map arm, and fake-daemon driver plumbing are gone;
   codegen is clean again. The fake-daemon *concept* can return in Phase 2.5,
   rebuilt to speak real `DaemonEvent`s end to end.

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

For the implementer: work the phases top-down; each gates the next. Three
standing invariants while you work:

1. **The Bun control must stay green.** `bun run test:e2e` (against the TS
   server) is the oracle for "is this failure mine or the suite's". If it
   goes red, stop and fix that first.
2. **jj discipline**: review with `jj diff --git`, commit per completed task,
   imperative subject ≤72 chars, only the files you touched.
3. **Pin the daemon.** All parity work runs against one pinned polytoken
   version (currently the installed 0.4.0-unstable.5). Upstream bumps are a
   deliberate, separate step (Phase 3) — never a mid-phase side effect. On
   every bump: re-run codegen, replay the golden corpus (Phase 2) as the
   drift canary, and re-check the changelog against the plan.

The cutover gate is **four legs**, not one: ported unit tests green, mock e2e
green, fake-daemon e2e green (Phase 2.5), live smoke (Phase 3). Mock-e2e alone
proves hub+protocol+client — it never touches the live driver stack.

### Daemon-owned first — check the changelog (standing)

Polytoken is moving underneath this plan (installed here: 0.4.0-unstable.5;
**unstable.6 is already released**). Before porting, fixing, or testing any
daemon-facing workaround, check <https://docs.polytoken.dev/changelog/> and
diff a fresh `polytoken openapi` dump — prefer deleting a workaround the
daemon now owns over porting it faithfully. Shortest path to a clean Rust
server = the daemon owns everything it can. Known as of 2026-07-04:

- **unstable.6: `/history` items now carry `emitted_at`** (upstream ask #1 —
  shipped). The TS timestamp fabrication ("56y ago" rows) and its ported
  twin in `history_seed.rs` become deletable on the bump. Don't extend
  either in the meantime.
- **unstable.6, BREAKING: `POST /prompt` auto-queues when a turn is in
  flight** (supersedes upstream ask #6 / the prompt-or-queue TOCTOU). The
  prompt-vs-queue routing on a cached `turn_in_flight` — in the TS driver
  and its Rust port — is affected; verify the exact semantics on the bump.
  Phase-1 queue work is hub/mock-level and unaffected, but do not harden
  live-driver queue routing before the bump lands.
- **unstable.5: the daemon SSE emits `heartbeat` events** (~10s cadence
  observed on an idle session, 2026-07-04). The daemon-client's
  silence-vs-dead `/health`-probe machinery — and its "SSE is push-only
  with no heartbeats" comment — predate this. Simplify liveness to a
  heartbeat timeout *before* porting `daemon-client.test.ts`; porting the
  probe tests as-is would cement an obsolete design.
- **Confirmed still daemon-gaps** (probed live on unstable.5, 2026-07-04):
  SSE resume is a silent no-op — connecting with `Last-Event-ID: 100`
  (~8,900 events behind) replays nothing. Reconnect recovery stays
  reseed-on-`stream_discontinuity` until upstream implements resume
  (ask #4, reframed in `docs/polytoken-upstream-feature-asks.md`). Also
  observed: `GET /events` streams with **no TUI lease claimed** — read-only
  observing may already exist (ask #12).

### Phase 0 — truth & guardrails (small, do first)

- [x] Delete the as-built mock-mode remnants: `fake_daemon.rs`, the
      `Passthrough` variant in `pilot-daemon-types`, the `Passthrough` arm in
      `event_map.rs`, and the `with_fake_daemon_url`/`fake_daemon_url`
      plumbing in `driver.rs`. Codegen has been re-run cleanly; jj history
      keeps the old skeleton for reference. (The fake-daemon *concept* returns
      in Phase 2.5, rebuilt to speak real `DaemonEvent`s.)
- [x] Add server-rs to CI: `cargo fmt --check`, `cargo clippy --locked
      --all-targets -- -D warnings`, `cargo test`, rust-cache with
      `workspaces: server-rs`, like the existing `desktop` job. Consider a
      `check:rs` script. **DONE (2026-07-05):** added `rust-server` job to
      `.github/workflows/ci.yml` (ubuntu-latest; same release-twin-skip `if:`
      as web/desktop). Clippy went ~61 warnings → 0: `cargo clippy --fix`
      auto-fixed mechanical lints across the workspace (all behavior-preserving
      per Opus review), plus item-level `#[allow(clippy::large_enum_variant)]`
      on `ServerMessage`/`DaemonEvent`/`StateDelta` (wire shapes; boxing would
      change serialization) and `#[allow(clippy::too_many_arguments)]` on two
      TS-parity helpers. Codegen now runs `rustfmt` on the generated file
      (fail-loud on rustfmt failure) so codegen + `fmt --check` stay consistent.
      `check:rs` script added to root `package.json`. `server-rs/Cargo.lock` is
      tracked so `--locked` works on clean checkout.
- [x] Remove the blanket `#![allow(dead_code)]` / `#![allow(unused_variables)]`;
      convert survivors to item-level `#[expect(dead_code, reason = "...")]`
      so the compiler enumerates remaining gaps and complains when they're
      done. **DONE (2026-07-05):** all hand-written module-level allows removed
      (`hub`, `mock_driver`, `daemon_client`, `driver`, `event_map`,
      `history_seed`, `polytoken/mod`, `push`); 47 surfaced warnings → 0.
      32 item-level `#[expect]`s added, 16 tagged `reason = "BUG: … (Phase N)"`
      and grep-able via `grep -rn 'BUG:' server-rs/`. The generated
      `pilot-daemon-types` keeps a justified crate-level `#![allow(dead_code)]`
      (exhaustive wire vocabulary), documented in the codegen header. Logic-silent
      gaps (`/health` zeros, `build_sha` empty, `/update/state` body discarded,
      error parity ~17 vs ~6) can't be `#[expect]`-annotated (no lint) — they're
      listed in "Wrong turns to undo" #2/#3 and remain Phase 1/3 work. Reviewer
      (Opus) verified zero behavior change + 0 warnings on a clean rebuild.
- [x] Keep progress claims reproducible: commit the full-suite line-reporter
      output (or a per-spec table) instead of prose percentages. **DONE
      (2026-07-05):** the "Where the port actually stands" section now carries
      a dated per-spec failure table (25 failures, reproducible via
      `PILOT_SERVER_IMPL=rust bunx playwright test --project=desktop
      --reporter=json`) instead of prose percentages. Re-capture after each
      chunk that moves the failure count.

### Phase 1 — mock-mode e2e to green, test-first (hub semantics)

Stay on `MockDriver` for this phase — the thin deterministic stack plus the
Bun control is what makes each of the 33 remaining failures attributable in
minutes.

- [x] **Land the hub completion queue first** (decided, not wait-for-pain):
      all fire-and-forget `tokio::spawn` driver completions funnel through
      one `mpsc` consumed by a single applier task that locks the hub and
      applies results in FIFO order. Keeps the Mutex; restores TS's
      deterministic ordering; kills the connect-time fan-out races
      (sessionList/modelList/commandList/facetList/fileIndex). The same
      queue-over-mutex idiom is reused for SSE in Phase 2 — one
      concurrency pattern everywhere, documented in the hub.rs header. **DONE
      (2026-07-05):** bounded `mpsc` (256) + single long-lived applier
      (`run_hub_op_applier`), `try_send` with `panic!` on `Full` (fail-loud
      canary) and benign debug-log on `Closed` (shutdown). 30 spawn sites
      converted (20 handleClient completions + 6 connect follow-ups + 4
      post-switch refreshes). Applier awaits driver future *before* locking
      (no lock-across-await); per-op `catch_unwind` contains panics so one
      bad op can't wedge the queue. **Documented divergence from TS:** the
      queue serializes async driver I/O in *dispatch order* — stricter than
      TS, which fires connect follow-ups concurrently (`void this.foo()`) and
      applies in completion order. Acceptable for this single-user tool (local
      daemon, low RTT, prompt resolves at acceptance, control-plane bypasses
      the queue). Reviewer (Opus) verified no deadlock + FIFO holds + no
      behavior change (e2e stayed 273/25). Note: the single-flight/pending-
      switch coalescing machinery is now dormant under the single applier
      (cheap TS-mirroring insurance; noted in `switch_to`).
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

- [ ] **Gate — decide the event vocabulary before the two porting items
      below.** A from-scratch design exercise (2026-07-04, blind-draft
      comparison) found the daemon now owns most of what the pilot event
      vocabulary was built for in the pi-driver era: `/state` carries
      pending_interrogatives/turn_in_flight/title/todos, `/history` is
      projected + revisioned (+ `emitted_at` in .6), and client types are
      codegen-able from `polytoken event-schema`. If the protocol goes
      daemon-native ("v3": hub journals/forwards raw daemon envelopes, the
      accumulator moves client-side), then `event_map.rs` + `ui_bridge` are
      never ported — their 129+38 TS tests keep running where the logic
      lands (client TS). Porting those tests to Rust first would be the
      longest path. Until the call is made, skip the two bullets below and
      work everything else in this phase (it survives either outcome).
- [ ] Port `event-map.test.ts` (129 cases; pure functions, mechanical,
      highest bug-yield per hour) and `ui-bridge.test.ts` (38).
      **(Behind the gate above — do not start before the vocabulary call.)**
- [ ] Fix the SSE ordering bug with the Phase-1 idiom: per-warm-session
      `mpsc` + one consumer task. Never per-event `tokio::spawn` — that's the
      current bug (two streaming deltas can fold out of order).
- [ ] Implement `DaemonEffect::FetchState`'s emit path (`emit`/`prompt_id`
      are currently ignored) and `RefetchQueue` → `queueUpdated`; port the
      TS tests that cover them. (Vocabulary-coupled — behind the gate above.
      Note `RefetchQueue` also interacts with unstable.6's `/prompt`
      auto-queue breaking change; see "Daemon-owned first".)
- [ ] Build the **daemon-fixture corpus**: hand-translate the mock fixture
      scripts into real daemon wire sequences (`DaemonEvent`s over SSE plus
      the matching HTTP responses). Ground it with **golden recordings**:
      capture a few real polytoken SSE transcripts via the parity harness
      (streaming turn, tool call + approval, interrogative, abort) and commit
      them, so the corpus can't drift from what the daemon actually sends.
      This corpus is also the protocol-change canary for every polytoken
      bump / codegen regen. (Survives the vocabulary gate either way — the
      corpus speaks raw `DaemonEvent`s, which is exactly what a daemon-native
      protocol would forward. Build it regardless of the gate's outcome.)
- [ ] Integration tests: rebuild the fake daemon as a test axum router
      speaking the **real** wire protocol, driven by the corpus; bind an
      ephemeral port, point `PolytokenDriver` at it, assert emitted
      `SessionDriverEvent`s and the effect HTTP calls. This covers the
      composition MockDriver e2e can never see: SSE loop → accumulator →
      effects → HTTP back.
- [ ] Port `daemon-client.test.ts` + `lease-retry.test.ts` (25) — but first
      simplify liveness against unstable.5's SSE heartbeats ("Daemon-owned
      first") so the ported tests pin the new design, not the probe dance.
      Introduce a
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

- [ ] **Bump polytoken to current (≥0.4.0-unstable.6) as an explicit step**
      before the live smoke: re-run codegen, replay the golden corpus
      (drift canary), adopt `emitted_at` (delete timestamp fabrication in
      history seeding, TS and Rust), and adapt prompt-vs-queue routing to
      the `/prompt` auto-queue breaking change. The TS server needs the
      same adaptation while it remains the escape hatch.
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
PILOT_SERVER_IMPL=rust bun run test:e2e         # vs Rust server: 33 failures (post-Chunk-A)
```
