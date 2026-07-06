# Rust Server Port — Status & Resumption Plan

**Phase 2.0 COMPLETE (2026-07-05):** daemon truth + drift guardrails landed
(6 commits, pending dual review). Codegen re-synced to 0.4.0-unstable.7;
`emitted_at` adopted schema-driven across all 12 history kinds (Rust + TS);
`/prompt` TOCTOU collapsed onto the daemon auto-queue; SSE liveness rewritten to
a heartbeat timeout (health-probe machinery deleted); golden corpus + Rust loader
(2 tests, AC.5) + capture harness added. Phase-2 vocabulary gate resolved as A′
(accumulator stays server-side Rust; DECISIONS.md D19); version discipline now
"pin the corpus, not the binary" (D20, supersedes standing invariant #3). 180
Rust tests green, fmt+clippy clean. NEXT: Phase 2.1 (port event_map/ui_bridge +
their unit tests, shrunk). LIVE CORPUS CAPTURE DONE (2026-07-06, 5/6 scenarios,
deepseek): found+fixed a canonicalization bug (+regression test), 2 seed/reality
mismatches, and RESOLVED the tool-call-approval permission gating (needs the
`standard` matcher PLUS a version-2 `ask` permissions rule — `standard` alone
does not prompt). Corpus now FROZEN: inner `event.emitted_at` canon + `/state`
redaction landed, cross-language parity test added — see "Live corpus capture" below.

Last updated: 2026-07-05 (Phase 1 mock-e2e burn-down COMPLETE + review-approved:
0 deterministic Rust e2e failures; 176 Rust tests green). The 2026-07-04 full
review + plan revision stands (fake-daemon e2e tier reinstated as Phase 2.5, hub
completion queue made deliberate in Phase 1, daemon-owned items folded in from
the polytoken changelog (unstable.6), the "Daemon-owned first" standing section,
the Phase-2 event-vocabulary gate, and the Phase-3 daemon-bump step). This update
reflects the Phase 1.5–1.8 cluster burn-down that cleared failures 13 → 0
deterministic.

Chunk A (mock fixture text/lifecycle parity) is complete and reviewer-approved
(32/32 e2e specs pass, 1 flake confirmed), cutting failures 72 → 33 (~90%).
Chunk F (polish/prompt-nav + scroll) resolved (0 failures, no action needed).

## Live corpus capture (2026-07-06) — real deepseek daemon, 5/6 scenarios

Ran `scripts/capture-daemon-corpus.ts` against a **real** isolated polytoken
daemon (`0.4.0-unstable.7`, deepseek/deepseek-v4-pro full via the parity harness,
`$DEEPSEEK_API_KEY`). The seed fixtures were hand-authored-from-schema; these are
now grounded in what the daemon actually emits. **All captures deserialize into the
real `DaemonEvent` enum and canonicalize idempotently — `cargo test --test corpus`
green (8 tests).**

### Captured (real, committed, FROZEN — `/state` redacted, no machine-specific data)
| scenario | frames | notes |
|---|---|---|
| `streaming-turn` | 22 | real turn has a **thinking block + signature_delta** BEFORE the text block; seed had only a plain text block |
| `queue-while-in-flight` | 65 | **AC.3 auto-queue VALIDATED live** — 2nd `/prompt` → 202 + `queued_item{admission_prompt_id,content,id}`, NOT 409; full queue→drain lifecycle |
| `abort` | 7 | `POST /turn/cancel` → `{status:"cancel_requested"}` → `turn_cancelled{reason:"user_cancelled"}` |
| `ask-user-question` | 291 | `ask_user_question` interrogative + `/interrogative/{id}/respond {kind:"ask_user_question_answers",answers:[{question_id,selected_option_ids}]}` → 200. Verbose (model chatty); could trim the prompt further |
| `tool-call-approval` | 74 | **permission gating RESOLVED (2026-07-06)** — needs `standard` matcher + a version-2 `ask` shell rule (`standard` alone does not prompt). Real `interrogative` → `/interrogative/{id}/respond {kind:"permission_answer",granted:true}` → `tool_call{name:"shell_exec",input:{command}}` → `tool_result{content,content_full}` (no `is_error`) |

### NOT captured (still the seed fixture)
- `reconnect-stream-discontinuity` — not attempted. Requires forcing a
  `stream_discontinuity` (SSE resume is a documented upstream no-op) — hard to
  reproduce deterministically against a live model. Improved-stub the driver.

### FIXED this session (committed)
1. **Capture-script session id** — `spawnFreshDaemon` minted `crypto.randomUUID()`
   as `--session-id`; the daemon REJECTS it ("timestamp segment must be exactly 6
   Crockford base32 chars"). ⇒ the capture harness had never been run end-to-end
   against the real daemon. Fixed with `freshSessionId()` (`<6 crockford>-corpus`).
2. **Canonicalization bug — plural `*_prompt_ids` arrays left RAW** (both
   `corpus.rs::canonicalize_value` AND `capture-daemon-corpus.ts::canonicalizeValue`).
   The prompt-id arm recursed into arrays, where string elements lost their key
   context and hit the bare-scalar branch un-mapped. Real `pending_turn_input_drained`
   leaked `admission_prompt_ids:["<raw-uuid>"]` while the singular field for the same
   id showed `PROMPT_1` — inconsistent + non-deterministic. Fixed in BOTH files (map
   each string element directly); added regression test `canon_maps_plural_prompt_id_arrays`
   (fails against the old code). Seeds never had a plural array of real uuids, so it was latent.

### Findings to ACT ON (teed up for tomorrow)
- **Permission gating for `tool-call-approval` — RESOLVED (2026-07-06).** The prior
  hypothesis ("regenerate with `default_permission_matcher: standard`") was WRONG on
  its own: `standard` only means "apply your allow/ask/deny rules", and with no rule
  file a `shell_exec` matches nothing and runs unprompted (verified live: `echo
  hello-corpus` ran straight through under `standard` too, tool_call→tool_result, no
  interrogative). The real mechanism: per-tool allow/ask/deny rules live in a SEPARATE
  version-2 `permissions.{yml,yaml}` file (loaded from the global config dir + project
  dir), NOT in `config.yaml`. `bypass_plus` ignores `ask` entirely; only `standard`
  honors it. Fix (in `spawnFreshDaemon`): for this scenario write BOTH a `standard`
  config AND a `permissions.yaml` = `{version:2, ask:[{tool:shell_exec},{tool:shell_monitor}]}`
  into an isolated per-scenario config dir. Captured cleanly (74 frames). See `polytoken
  schemas permissions-config` / docs.polytoken.dev/reference/permissions-config.
- **Two seed/reality mismatches in `tool-call-approval`** (seed is wrong vs the daemon):
  - respond body: seed `{response:{kind:"permission",decision:"allow"}}` is INVALID.
    Real shape is the flat `oneOf` `{kind:"permission_answer",granted:true}`.
  - `tool_call`/`tool_result`: real is `tool_call{name:"shell_exec",input:{command}}`
    and `tool_result{content, content_full:{text}}` with **no `is_error`** field;
    seed had `read_file`/`input:{path}` and `tool_result{content,is_error}`.
- **Real event types the seeds never had** (matters for the Phase 2.1 accumulator /
  `event_map` — make sure it handles them): `notification_autodrain_switch`,
  `permission_monitor_switch`, `system_reminder{slug,reason:{type:"session_start"},...}`,
  `content_block{block_type:{type:"thinking"}}` + `delta:{type:"signature_delta"}`,
  `session_state_changed{domains:[...]}`.
- **`/state` shape drift**: the real `/state` body has **no top-level `turn_in_flight`**
  field (seed asserted it true→false). It carries `context_usage{used_tokens,limit_tokens}`,
  `most_recent_assistant_text`, `source_control`, `active_model/facet`, a full `env`, etc.
  ⚠ If the reseed path reads `turn_in_flight` from `/state`, verify it against unstable.7.

### Canon freeze — DONE (2026-07-06, committed)
- **Inner event `emitted_at`**: `canonicalize_frame` now rewrites `event.emitted_at`
  (next to the existing `event.timestamp` rewrite) to a monotonic epoch, idempotently,
  in BOTH `corpus.rs` and `capture-daemon-corpus.ts`. Test: `canon_rewrites_inner_emitted_at`.
- **`/state` HTTP body redaction**: type-preserving key-driven redaction in
  `canonicalize_value` (mirrored both files): `env`→`{}`, `most_recent_assistant_text`→`""`,
  `used_tokens`→`0` (keeps `limit_tokens`), `project_cwd`→`/PROJECT`, `source_control`
  leaves (`label`/`dirty`/commit-like)→fixed placeholders (keeps `kind`/shape for typed
  replay). Re-canonicalized all committed captures via a new `--recanon` mode (zero model
  spend). Gates: `corpus_has_no_machine_specific_data` (no `/Users/`|`/home/`, `env=={}`,
  `used_tokens==0`, `most_recent_assistant_text==""`) + cross-language parity test
  `canon_matches_ts_golden` (plus a TS-side `bun test` guard) against a committed
  non-canonical fixture exercising every redacted field.
- Model **thinking/text content is irreducibly non-deterministic** — the corpus is a
  human-reviewed drift canary, not a byte-exact oracle. Content churn on re-capture is
  expected; the idempotency test only pins that canon-of-canon is stable.

## Goal (unchanged)

Replace the Bun/TS server (`server/`) with a Rust server implementing the same
WS protocol, HTTP endpoints, and driver behavior — validated against the e2e
suite AND the ported unit-test suite. Delete the TS server only after both
validation legs are green plus a live-daemon smoke test.

## Where the port actually stands

**Ground truth (2026-07-05, full suite, one machine, post-Phase-1.8 —
mock-e2e burn-down COMPLETE):**

- `cargo test`: **176/176 pass** (5 daemon-types, 64 protocol, 107 server).
- `cargo clippy --all-targets -- -D warnings`: 0 warnings (Phase 0.2).
- `bun test` (TS side): 760/760 pass.
- e2e vs Bun server (control): **320/321 pass** (the 1 is `sidebar-drafts` "retargeting
  a draft" — a load-induced flake that passes in isolation; confirmed suite-level,
  not Rust-port: it flakes identically vs the Bun server).
- e2e vs Rust server (`PILOT_SERVER_IMPL=rust`): **298 passed / 2 failed / 0
  deterministic** (4.5 min, `--project=desktop`). The 2 are load-induced flakes
  that pass in isolation: `dir-picker` "Escape clears the filter" (known since
  Phase 1.4) + `sidebar-drafts` "retargeting a draft" (same flake that hits the
  Bun control). **Phase 1 (mock-e2e cluster burn-down) is COMPLETE and
  review-approved: failures 33 → 0 deterministic.** Reproduce:
  `PILOT_SERVER_IMPL=rust bunx playwright test --project=desktop`.
- server-rs is now in CI (Phase 0.2): the `rust-server` job runs
  `cargo fmt --check` + `cargo clippy --locked --all-targets -- -D warnings` +
  `cargo test` on ubuntu-latest. `bun run check:rs` runs the same locally.

### Rust-server e2e failure table (2026-07-05, 0 deterministic failures)

context-meter cluster cleared (Phase 1.5): the Rust `MockDriver` did not override
`compact`/`clear_context` (inherited no-op trait defaults), so the click-twice
confirm-gate tests stalled at 91%. Ported the TS overrides
(`server/src/mock-driver.ts:860-911`) — `usageUpdated` (compact→4%, clear→0%)
plus a `notify` hostUiRequest — +1 hub routing unit test. Reviewer-approved
(Opus + gpt-5.5, no critical/high). 151 Rust tests, all context-meter e2e green.

reload-session cluster cleared (Phase 1.6): the Rust `MockDriver` did not override
`reload_session` (inherited the trait default returning `Vec::new()`), so a reload
hit `finish_switch`'s empty-seed branch and sent `Error { "session switch returned
no session" }` instead of reseeding the transcript — both reload-session e2e tests
timed out waiting for the reseeded transcript text. Ported the TS override
(`server/src/mock-driver.ts:649-651`, `reloadSession` → `openSession`) + 2 ported
hub unit tests (reseed-every-viewer, empty-seed→Error). Reviewer-approved (Opus +
gpt-5.5; the first pass found a high — the reseed test passed with the fix
reverted, proven empirically — fixed by wedging synchronously via `on_event` and
asserting on the post-reload seed; re-review clean, no critical/high). 153 Rust
tests, both reload-session e2e green.

update-card cluster cleared (Phase 1.7): two compounding bugs. (1) The Rust
`/update/state` handler (`main.rs`) never parsed the POST body — it hardcoded
`hub.report_update(None, false, None)`, always reporting "no update available"
and clearing the pending sha. (2) `hub.rs` `report_update` never broadcast an
`updateStatus` message (it just set `update_sha` and returned), so even with the
body parsed the card wouldn't appear client-side; it also diverged from TS
`reportUpdate` (`server/src/hub.ts:1929-1948`) which tracks `changed` and
broadcasts only on change. Ported both: `UpdateStateBody` struct +
`sha = available ? sha : None` in the handler; `changed`-tracking + broadcast +
`sha===null → applying=false` in `report_update`. +6 ported hub unit tests (the
"desktop update relay" block from `hub.test.ts:1773-1846`). Reviewer-approved
(Opus + gpt-5.5, no critical/high; the medium finding was a pre-existing
codebase-wide auth-ordering pattern at 6 handler sites — out of scope for this
cluster, noted for a future auth-parity pass). 159 Rust tests, both update-card
e2e green.

### Rust-server e2e failure table (2026-07-05, 0 deterministic failures)

**Phase 1.8 singletons batch — COMPLETE + REVIEW-APPROVED (2026-07-05): all 9
singletons cleared.** Dual review (Opus + gpt-5.5): 0 critical/high on the code;
the two medium test-coverage gaps (classify_switch_error + background-model
alias/dated logic had no Rust units) were addressed with +9 table tests
(`vvtxoryr`).
The remaining full-suite failures are two load-induced flakes (both pass in
isolation), not deterministic:
- `dir-picker` "Escape clears the filter without closing the browser" — known
  flake (documented since Phase 1.4; passes in isolation).
- `sidebar-drafts` "retargeting a draft moves its row…" — 30s timeout under
  full-suite concurrent load; passes in isolation. Confirmed suite-level, NOT
  Rust-port: it flakes identically against the **Bun (TS) control** too (Bun
  control: 320/321, the 1 being this same test; passes in isolation vs Bun).
  New observation this run; unrelated to the singletons (touches draft-retarget,
  not the cleared paths).

The 9 singletons + their fixes (each a faithful TS-semantics port):
- **slash** — `mock_commands()` had `skill:polish`; TS has `skill:journal`. Fixed
  the fixture drift.
- **file-mention** — `mock_files()` was missing most of TS `MOCK_FILES` (the
  `client/src/components/*`, `e2e/*`, `protocol/src/*` subtrees); `list_files`
  didn't surface the `<cwd>/DRAFT-CWD.md` fallback. Ported the full fixture list
  + the cwd fallback.
- **notification-autodrain** — `MockDriver` didn't override
  `set_notification_autodrain` (no-op trait default). Ported the override
  (emits `sessionUpdated` with `notification_autodrain`).
- **settings (background-model)** — `pilot_settings_msg` hardcoded
  `background_model_warning: None`; no `resolve_background_model` ported. Added
  `background_model.rs` (port of `shared/background-model.ts`) + wired the
  warning into `pilot_settings_msg`. +8 unit tests.
- **prompt-delivery (rejected prompt)** — `PilotDriver::prompt` returned `()`
  (infallible), so the mock's `__pilot_reject_prompt__` sentinel couldn't reject.
  Changed `prompt` → `Result<(), String>` across the trait + 3 driver impls + both
  hub call sites; the mock rejects, the hub surfaces `promptResult { accepted:
  false }`.
- **sidebar-row (unread)** — `reset()` cleared `attention` but never broadcast
  `sessionStatus` after (TS reset's tail at hub.ts:1888). Added the
  `broadcast_session_status()` + session-list enqueue.
- **abort-restore** — `MockDriver::abort()` didn't `cancel_timers()` first, so a
  `pendinghold` scheduled delta fired after abort and re-opened the turn (Stop
  pill never cleared). Ported the `cancel_timers()` call.
- **lease-conflict** — three-part port: (1) `PilotDriver::open_session` →
  `Result<Vec, String>` across the trait + 3 driver impls + 4 hub swap closures;
  (2) `SwapFuture` → `Result`; `switch_to` classifies the Err via a port of TS
  `classifySwitchError` → `Error { kind: "session-switch" }`; the mock arms a
  one-shot `fail_next_session` 409 via `run_script("failsession")`; (3) **the
  load-bearing fix:** `switch_to`'s Err path early-returned `None` BEFORE the
  finally-style cleanup, leaving `switch_in_flight` set so the Retry's openSession
  was coalesced into `pending_switch` and never ran — restructured to fall
  through to the shared cleanup (mirrors TS `switchTo`'s `try/finally`).
- **images (echo prompt images)** — `prompt_reply_script` emitted the userMessage
  echo with `images: None`, dropping the pasted image. Threaded `images` through
  so the echo carries them (TS `promptReply`, fixtures.ts:486).

Reviewer-approved pattern held across sub-batches (Opus + gpt-5.5, no
critical/high on the committed chunks). 176 Rust tests green, clippy/fmt clean.

Note: the historical Phase 1.5 re-run captured 284/14 (13 deterministic + the
dir-picker flake); the burn-down has since cleared all 13 → 0 deterministic
post-Phase-1.8 (298 passed, 2 load-induced flakes). See the ground-truth block
above for the current numbers.

| spec file | failing test | status |
|-----------|--------------|--------|
| (none — all deterministic failures cleared through Phase 1.8) | | |

Cluster view: (all clusters green through Phase 1.8). The context-meter (2),
new-session-failure (2), queue (3), models (4), reload-session (2), update-card
(2), abort-restore (1), file-mention (1), images (1), lease-conflict (1),
notification-autodrain (1), prompt-delivery (1), settings (1), sidebar-row (1),
slash (1), sessions, drafts, branch, archive clusters are now green
(Chunks B+C + Phase 1.2/1.3/1.4/1.5/1.6/1.7/1.8).
Note: `abort-restore` had TWO failing tests in isolation ("Escape aborts a
pending turn…" and "Escape while typing a follow-up…"); both are now green.
Both remaining full-suite failures are load-induced flakes (dir-picker,
sidebar-drafts) that pass in isolation — 0 deterministic.

Observed failure clusters: see the per-spec table above (2026-07-05, 0
deterministic). All clusters are green through Phase 1.8
(Chunks B+C + Phase 1.2/1.3/1.4/1.5/1.6/1.7/1.8). Remaining: two load-induced
flakes (dir-picker, sidebar-drafts) that pass in isolation — not deterministic.

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
- `event_map.rs` / `ui_bridge.rs` — structured port of the accumulator model.
  **Phase 2.1 test port COMPLETE (2026-07-06):** `event-map.test.ts` (124 active
  + 5 `#[ignore]` = 129/129) and `ui-bridge.test.ts` (38/38) ported to Rust
  `#[cfg(test)]` modules; `cargo test` green, fmt+clippy clean, dual-reviewed
  (Opus). Covers `map_daemon_event` (every DaemonEvent variant),
  `build_post_fetch_event`, `reset_accumulator`, `snapshot_from_state`, the
  streaming-pipeline integration turns, and the ui-bridge reverse builders +
  `PERMISSION_APPROVAL_*` constants. The port surfaced + FIXED a real source bug:
  `goal_driver_update{transition:"proposed"}` with no goal used to emit
  `sessionUpdated(goal:null)` (blanking the goal badge on a proposal); the handler
  now gates the emit on the required `transition` field (set→emit goal,
  cleared→emit null, otherwise→fetchState only), reproducing all three TS cases.
  The 5 `#[ignore]`s split into: (a) **generated-type gaps** (4) — the closed Rust
  `InterrogativeType`/`SystemReminderReason`/`DaemonEvent` enums reject unknown
  values at deserialization (so the TS "unknown variant → empty + warn"
  forward-compat cases can't be constructed) and `ProviderError::Transport` lacks
  the `kind` field the TS message format needs; and (b) **daemon-type collapse**
  (1) — `SessionStateSnapshot.current_goal` is a single `Option<T>`, so a present
  state that omits `current_goal` is indistinguishable from `null`; the snapshot
  path has no `transition` discriminator to recover the "preserve" case. All carry
  phase-named `reason` strings (Phase 4 / codegen). ⚠ Residual Phase-4 items: the
  Transport-error message degradation and the snapshot current_goal collapse both
  want the generated types to carry more (a `kind` field / a double-Option).
- `hub.rs` — all 35 ClientMessage types have handlers. **Mock-e2e-validated +
  ~28 ported unit tests** (Phase 1.2–1.8: models, queue, new-session-failure,
  context-meter, reload-session, update-card/desktop-update-relay,
  background-model resolution, classify_switch_error, singletons). The
  I/O-shaped live-path handlers (SSE, daemon effects) remain untested — see
  the load-bearing caveat below + Phase 2/3.
- `background_model.rs` — port of `shared/background-model.ts`
  `resolveBackgroundModel`; the `script:` path is a fail-loud stub (returns a
  "not yet ported" warning, never silently accepts). 10 unit tests. The
  resolved `model`/`thinking_level` are computed but only `.warning` is wired
  into `pilot_settings_msg` (the singleton asserts the warning channel;
  background-model *application* to turns is separate follow-up).
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
| polytoken/event-map.test.ts         | 129   | 123 (+6 `#[ignore]`, see below) |
| polytoken/ui-bridge.test.ts         | 38    | 38 (ported)            |
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
3. **Pin the corpus, not the daemon** (SUPERSEDES the old "pin the daemon"
   invariant; see docs/DECISIONS.md D20). The live path runs the ambient
   `polytoken` binary = daemon head (operator upgrades ~daily; installed here
   0.4.0-unstable.7). Determinism comes from a committed golden SSE corpus
   (`server-rs/tests/corpus/<version>/`), captured from a tagged version and
   canonicalized. On a bump: re-run codegen, replay the corpus as the drift
   canary, adopt newly daemon-owned fields, and re-capture only on conscious
   adoption (`scripts/capture-daemon-corpus.ts`). A bump that breaks behavior
   turns a corpus test red with a precise diff, not a silent GUI corruption.

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

### Phase 1 — mock-mode e2e to green, test-first (hub semantics) — COMPLETE

Stayed on `MockDriver` for this phase — the thin deterministic stack plus the
Bun control is what made each failure attributable in minutes. **DONE
(2026-07-05): failures 33 → 0 deterministic; all 7 clusters cleared +
review-approved.** See the per-spec failure table + ground-truth block above.

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
- [x] Work the failure clusters largest-first (see ground truth above). For
      each cluster, port the relevant `hub.test.ts` / `hub-journal.test.ts`
      cases *before* fixing, so hub coverage back-fills as the burn-down
      proceeds (target: all 64+14 cases ported by the end of this phase).
      **DONE (2026-07-05):** all 7 clusters cleared, test-first, each
      review-clean (Opus + gpt-5.5, no critical/high) + committed: models
      (Phase 1.2, 4→0, +2 tests), queue (Phase 1.3, 3→0, +3 tests),
      new-session-failure (Phase 1.4, 2→0, +2 tests), context-meter (Phase 1.5,
      2→0, +1 test), reload-session (Phase 1.6, 2→0, +2 tests), update-card
      (Phase 1.7, 2→0, +6 tests), singletons (Phase 1.8, 9→0, +8 background-model
      + 7 classify_switch_error + 2 alias/dated tests). Failures 33 → 0
      deterministic. ~37 ported hub/module tests added (target 64+14 by phase
      end — the remaining gap is the I/O-shaped live-path tests behind Phase 2/3).
      The standing rule "fix by porting TS semantics, never by teaching the
      mock" held across all 7.
- [ ] Restore error-message parity: audit all TS `{type:"error"}` sends
      (~17 sites) and mirror them; driver failures must be client-visible —
      the `new-session-failure` cluster is this bug.

Rule: fix by porting TS semantics, never by teaching the mock what the spec
wants.

### Phase 2 — live-path validation, part 1: units + integration harness

- [x] **Gate — RESOLVED as A′ (2026-07-05, operator-approved; see
      docs/DECISIONS.md D19).** The accumulator (`event_map` + `ui_bridge`)
      stays server-side, ported to Rust — NOT moved client-side. Rationale:
      the client is Svelte/TS and stays thin on the stable pilot wire; moving
      the accumulator client-side would relocate logic out of Rust into TS and
      duplicate it across desktop + the imminent mobile app, losing the
      server's version-shield against daemon churn. The daemon owning more
      state (`emitted_at`, `/prompt` auto-queue) shrinks the accumulator but
      doesn't change where it lives. So: proceed with the two porting items
      below (Phase 2.1), shrinking first against daemon-owned state.
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
- [~] Build the **daemon-fixture corpus** (5/6 real captures landed + FROZEN
      2026-07-06 — streaming-turn/queue-while-in-flight/abort/ask-user-question/
      tool-call-approval; reconnect-stream-discontinuity stays a seed (upstream
      no-op); captures canonicalized + `/state`-redacted, no machine-specific
      data — see "Live corpus
      capture" near the top): hand-translate the mock fixture
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
cd server-rs && cargo test                      # 176 tests, green
cd server-rs && cargo clippy --all-targets -- -D warnings   # 0 warnings (Phase 0.2)
bun run check:rs                                # fmt + clippy + test locally (CI gate)
bun test                                        # 760 tests, green
bun run test:e2e                                # control vs Bun server: deterministic-core green (320/321; the 1 is the suite-level sidebar-drafts flake, passes in isolation)
PILOT_SERVER_IMPL=rust bun run test:e2e         # vs Rust server: 0 det failures + 2 load-induced flakes (post-Phase-1.8)
```
