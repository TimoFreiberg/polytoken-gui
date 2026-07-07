# Rust Server Port — Status & Resumption Plan

**Phase 2.0 COMPLETE (2026-07-05):** daemon truth + drift guardrails landed
(6 commits, pending dual review). Codegen re-synced to 0.4.0-unstable.7;
`emitted_at` adopted schema-driven across all 12 history kinds (Rust + TS);
`/prompt` TOCTOU collapsed onto the daemon auto-queue; SSE liveness rewritten to
a heartbeat timeout (health-probe machinery deleted); golden corpus + Rust loader
(2 tests, AC.5) + capture harness added. Phase-2 vocabulary gate resolved as A′
(accumulator stays server-side Rust; DECISIONS.md D19); version discipline now
"pin the corpus, not the binary" (D20, supersedes standing invariant #3). Phase 2.1 (event_map/ui_bridge unit-test
port) COMPLETE 2026-07-06 — event-map 124 active + 5 `#[ignore]` = 129/129,
ui-bridge 38/38, dual-reviewed (Opus); surfaced + fixed a real live-path bug
(`goal_driver_update{transition:"proposed"}` was blanking the goal badge).
**Phase 2 (items 1–3) COMPLETE (2026-07-06):** the harness +
spawn-override seam are live, the warm-session lifecycle is wired (was entirely
dead — `#[expect(dead_code)]`), and both effect bugs are fixed. See "Phase 2
live-path validation" below for the findings + the `Arc<Inner>` refactor. Items
4–5 (daemon-client/lease-retry test ports) + Phases 2.5/3
remain. **Phase 5 (item 5 — shared modules + fs stores + worktree + live-driver
wiring) COMPLETE (2026-07-07):** new_session (cwd validation + worktree +
login-env threading, now `Result`), open_session (real `cwd_for_session`),
list_sessions (real archive/worktree resolvers + warm merge + live-usage
overlay), warm-cap eviction, and cleanup_worktree are all wired into the live
`PolytokenDriver`; the 4 wired-path `#[expect]` markers removed. 430 Rust tests
green (334 lib + 8 corpus + 19 live_path), fmt+clippy clean. The two gaps Phase
5 left out of scope are now closed (2026-07-07 "leg 1" cleanup): `set_archived`
is wired in the live `PolytokenDriver` (flips the flag + reaps a live worktree),
and `pilot_settings_msg` now calls `driver.login_env_status()` via a new
`PilotDriver` trait method. LIVE CORPUS CAPTURE DONE (2026-07-06, 5/6 scenarios,
deepseek): found+fixed a canonicalization bug (+regression test), 2 seed/reality
mismatches, and RESOLVED the tool-call-approval permission gating (needs the
`standard` matcher PLUS a version-2 `ask` permissions rule — `standard` alone
does not prompt). Corpus now FROZEN: inner `event.emitted_at` canon + `/state`
redaction landed, cross-language parity test added — see "Live corpus capture" below.

> **Doc-consistency note (2026-07-07).** The test count in this header was
> written when Phase 2.0 landed (180 tests); it is now **430** (5 daemon-types
> + 64 protocol + 334 lib + 8 corpus + 19 live_path, 5 `#[ignore]`). The
> authoritative counts live in "Where the port actually stands" below and the
> "How to verify" block at the end. Several checklist items in Phase 2/3 and
> bullets in "Wrong turns to undo" predate later phases and have been
> reconciled in-place; where a bullet now reads "RESOLVED / DONE" the earlier
> tense is the historical record, not the current state.

Last updated: 2026-07-07 (Phase 5 — shared modules + fs stores + worktree +
live-driver wiring COMPLETE + review-approved: 0 deterministic Rust e2e
failures; 430 Rust tests green, 761 TS tests green, 298/298 Rust-server e2e).
The 2026-07-04 full review + plan revision stands (fake-daemon e2e tier
reinstated as Phase 2.5, hub completion queue made deliberate in Phase 1,
daemon-owned items folded in from the polytoken changelog (unstable.6), the
"Daemon-owned first" standing section, the Phase-2 event-vocabulary gate, and
the Phase-3 daemon-bump step). This update reflects the Phase 1.5–1.8 cluster
burn-down that cleared failures 13 → 0 deterministic, plus Phase 2 (items 1–3)
live-path coverage and Phase 5 driver wiring. **Doc-consistency pass
(2026-07-07):** reconciled stale open-work prose against the code — Phase 2
SSE/FetchState/RefetchQueue/fake-daemon-harness checkboxes, the Phase 3
`/update/state` and daemon-bump items, and Wrong-turns #1/#3/#4/#5 now reflect
that the work landed in Phases 1–2/5; the "Daemon-owned first" version framing
updated to unstable.7 with unstable.6 features marked adopted. Test counts
re-verified live: 430 Rust / 761 TS, both 0 fail.

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

## Phase 2 live-path validation (2026-07-06, items 1–3 COMPLETE)

The live path (`daemon_client` → `event_map` → `driver`, ~5.7k lines) had **zero
coverage of any kind** before this — the e2e suite runs the mock driver only.
This phase built the missing test infrastructure and wired + fixed the three
named live-path bugs. All reviewer-approved (Phase B: no critical/high; Phase D
pending).

**The crux (verified by inspection):** the live path was non-functional past
seeding. `warm_session` (the only SSE subscriber) was `#[expect(dead_code)]` and
nothing called it — `open_session`/`new_session` seeded from `/history` then
DROPPED the client, so every post-seed method (`prompt`, `abort`, streaming)
did `get_warm(sid)` → `None` → silent no-op against a real daemon.

**The structural knot:** `warm_session`/`handle_sse_event`/`execute_effect`
take `self: &Arc<Self>` (cloned into spawned SSE tasks), but the hub owns
`Box<dyn PilotDriver>` with `&self` trait methods — `open_session` literally
couldn't call `warm_session` from `&self`. Resolved by an `Arc<PolytokenInner>`
split: `PolytokenDriver { inner: Arc<PolytokenInner> }` is a thin wrapper whose
trait impls delegate. Lock-across-await audited clean (reviewer-confirmed):
all `parking_lot` guards dropped before `.await`; the extract-then-await
patterns in `reload_session`/`shutdown` survived.

**What landed (4 commits, one per phase):**
- **Phase A — fake-daemon harness + spawn-override seam.** axum router replaying
  the frozen corpus over an ephemeral port (HTTP replay + `GET /events` SSE
  stream); `daemon_client::set_spawn_override` swaps the process launch so
  `PolytokenDriver` reaches the fake end-to-end. AC.1 smoke test passes.
- **Phase B — `Arc<Inner>` + warm-session wiring.** `open_session` (attach to a
  known port) / `new_session` (spawn path) / `reload_session` (dispose + re-open)
  now route through `install_warm` (health→lease→state→SSE→insert). The SSE fold
  is LIVE end-to-end (AC.2: a `SessionUpdated` arrives after `new_session`).
- **Phase C — SSE per-event ordering.** Replaced the per-event `tokio::spawn`
  with ONE per-session unbounded-mpsc consumer task (sequential fold = TS parity).
  Deliberate divergence from the hub's bounded+panic queue (SSE is push-only;
  bursts up to 291 frames; dropping corrupts the transcript). `debug_assert`
  single-consumer is the primary regression protection. AC.3: 250 ordered
  deltas fold in order.
- **Phase D — FetchState emit + RefetchQueue→queueUpdated.** Both were TODOs in
  `execute_effect`. FetchState now emits `build_post_fetch_event` against the
  refreshed cache with the threaded `prompt_id`; RefetchQueue maps the snapshot
  → `QueueUpdated` via `queue_messages_from_snapshot` (pure, unit-tested).
  AC.4 + AC.5.

**Scope kept (now resolved — Phase 5, 2026-07-07):** the `$HOME`
workspace fabrication, `opts.worktree`, `login_env`, `warm_cap` enforcement,
and `list_sessions` hardcoded closures were all deferred here as Phase-2 item-5
work. **Phase 5 wired all of them** (see "What is genuinely done and
trustworthy" above); the 4 wired-path `#[expect]` BUG markers were removed.
Still out of scope: `owned_process` retention. The reload
re-warm-via-attach path needs `startup.json` (session-registry/worktree port —
Phase 2 item 5); the harness can't exercise it, so the reload test asserts
disposal + no-deadlock (the in-scope half) rather than re-warm emission.

**Test-vehicle notes:** `pilot-server` was bin-only (integration tests couldn't
reach driver internals); added `src/lib.rs` so tests import
`pilot_server::polytoken::{driver,daemon_client,event_map}`. The corpus records
no `/history` items and no `/turn/input` for the effect scenarios, so the
harness serves canned responses for those lifecycle endpoints.

## Goal (unchanged)

Replace the Bun/TS server (`server/`) with a Rust server implementing the same
WS protocol, HTTP endpoints, and driver behavior — validated against the e2e
suite AND the ported unit-test suite. Delete the TS server only after both
validation legs are green plus a live-daemon smoke test.

## Where the port actually stands

**Ground truth (2026-07-07, full suite, one machine — Phase 5 done):**

- `cargo test`: **430/430 pass** (5 daemon-types, 64 protocol, 334 server lib
  [5 `#[ignore]`], 8 corpus, 19 live-path integration under `tests/live_path.rs`).
  Phase 5 (items 4–5) wired the shared modules + fs stores + worktree planners
  into the live `PolytokenDriver`: `new_session` (cwd validation + worktree
  creation + login-env threading, now `Result`), `open_session` (real
  `cwd_for_session` from `session.json`), `list_sessions` (real archive/worktree
  resolvers + warm merge + live-usage overlay), warm-cap eviction, and
  `cleanup_worktree`. The 4 wired-path `#[expect]` markers were removed.
- `cargo clippy --all-targets -- -D warnings`: 0 warnings (Phase 0.2).
- `bun test` (TS side): 761/761 pass.
- e2e vs Bun server (control): **320/321 pass** (the 1 is `sidebar-drafts` "retargeting
  a draft" — a load-induced flake that passes in isolation; confirmed suite-level,
  not Rust-port: it flakes identically vs the Bun server).
- e2e vs Rust server (`PILOT_SERVER_IMPL=rust`): **298 passed / 0 failed** (3.0 min,
  `--project=desktop`, 2026-07-07). The two known load-induced flakes
  (`dir-picker` "Escape clears the filter", `sidebar-drafts` "retargeting a
  draft") did NOT fire this run — both passed. They remain documented as
  load-induced (pass in isolation) and are not regressions.
  **Phase 1 (mock-e2e cluster burn-down) is COMPLETE and review-approved:
  failures 33 → 0 deterministic.** Reproduce:
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
  lease retry; compiles, looks careful. **Untested** (the dedicated
  `daemon-client.test.ts` + `lease-retry.test.ts` ports are still open —
  Phase 2 item 4). The liveness simplification that used to gate them is
  **already done**: SSE liveness was rewritten to a heartbeat timeout in
  Phase 2.0 (`heartbeat_timeout_ms` folded into the `stream.next()` read; the
  silence-vs-dead `/health`-probe machinery was deleted). So porting those
  test files no longer needs a "simplify first" preamble.
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

**Phase 5 — shared modules + fs stores + worktree + live-driver wiring
(2026-07-07, DONE + dual-review-approved).** The "item 5" shared work is ported
AND wired (not just ported):
- `shared/worktree_name.rs` (2 tests), `shared/warm_cap.rs` (10),
  `shared/session_list.rs` (4), `shared/login_env.rs` (11 pure; the impure
  `capture_login_env` shell-spawn is now wired into the driver), and
  `background_model.rs` (10, ported earlier in Phase 1.8) — all pure ports.
- `shared/worktree.rs` — `WorktreeMeta`/`Vcs`, `detect_vcs`, the pure
  `plan_worktree`/`plan_worktree_removal`/`plan_fresh_worktree` planners, and
  async `create`/`remove`/`is_clean` jj/git helpers. 8 planner/detect unit
  tests + 1 real git integration test.
- `archive_store.rs` (5 tests) + `worktree_store.rs` (10 tests) — fs-backed
  stores, tempdir round-trip tested.
- The live `PolytokenDriver` now uses all of it: `new_session` → `Result` with
  cwd validation + worktree creation + login-env threading (trait sig rippled to
  mock/stub/hub/8 call-sites); `open_session` reads the real project cwd via
  `cwd_for_session`; `list_sessions` uses real `archived_for`/`worktree_for`
  resolvers backed by the stores + warm merge + live-usage overlay; warm-cap
  eviction hooked into `install_warm`; `cleanup_worktree` wired to
  `removeWorktree` + `mark_reaped`. The 4 wired-path `#[expect]` BUG markers
  were removed. 19 live-path integration tests cover the ACs (see
  `tests/live_path.rs`).
- **Two gaps Phase 5 surfaced are now closed** (2026-07-07 "leg 1" cleanup):
  (a) `set_archived` is wired in the live `PolytokenDriver` — it flips the
  archive flag and reaps a live worktree (dirty → retained via the shared
  `reap_worktree` helper), covered by three `live_path` tests; (b) the hub's
  `pilot_settings_msg` now calls `driver.login_env_status()` through a new
  `PilotDriver` trait method (mock/default drivers still report `{ok:false}`),
  covered by two hub tests.

**The load-bearing caveat:** test-porting stopped where the code became
I/O-shaped. The pure modules + fs stores + worktree planners now have Rust
counterparts (Phases 1–3) and are wired into the live driver (Phase 5); the
remaining gap is the I/O-shaped daemon/hub integration tests. TS test cases
with no (or partial) Rust counterpart:

| TS test file                        | cases | Rust counterpart tests |
| ----------------------------------- | ----- | ---------------------- |
| hub.test.ts                         | 64    | 0                      |
| hub-journal.test.ts                 | 14    | 0 (journal unit ≠ hub integration) |
| polytoken/event-map.test.ts         | 129   | 124 (+5 `#[ignore]`, see below) |
| polytoken/ui-bridge.test.ts        | 38    | 38 (ported)            |
| polytoken/daemon-client.test.ts    | 14    | 0                      |
| polytoken/lease-retry.test.ts      | 11    | 0                      |
| polytoken/sessions-registry.test.ts | 15    | 0                      |
| shared/worktree-name.test.ts       | 2     | 2 (`worktree_name.rs`) |
| shared/warm-cap.test.ts            | 10    | 10 (`warm_cap.rs`)     |
| shared/session-list.test.ts        | 4     | 4 (`session_list.rs`)  |
| shared/login-env.test.ts (pure)     | 11    | 11 (`login_env.rs`, pure parts; impure `capture_login_env` is wired into the driver + covered by `live_path::new_session_passes_captured_login_env_to_spawn`) |
| shared/worktree.test.ts            | 8     | 8 planner/detect + 1 git integration (`worktree.rs` = 9) |
| shared/archive-store.test.ts       | 5     | 5 (`archive_store.rs`) |
| shared/worktree-store.test.ts      | 10    | 10 (`worktree_store.rs`) |
| shared/background-model.test.ts    | 16    | 10 (`background_model.rs`, ported Phase 1.8) |
| live-path ACs (new, no TS file)     | —     | 16 (`tests/live_path.rs`: 10 Phase-2 harness/warm/effect tests + 6 Phase-5 driver-wiring AC tests: cwd validation, worktree isolation, login-env threading, list_sessions flag overlay, warm-cap eviction, etc.) |

And the e2e suite runs the **mock driver only**, so the live path
(`daemon_client` → `event_map` → `driver`, ~5.7k lines) currently has **zero
coverage of any kind**. "e2e passes" must not be read as "the port is
validated" — it validates hub + protocol + mock.

## Wrong turns to undo (ranked)

1. **The fake-daemon architecture — rebuilt (was buried).**
   Phase 5 built `fake_daemon.rs` (mock = in-process daemon behind the real
   driver). The e2e work then pivoted to a direct `MockDriver` port ("simpler,
   matches TS architecture" — a defensible call). Phase 0.1 removed the stale
   skeleton and regen landmine: the old `fake_daemon.rs`,
   `DaemonEvent::Passthrough`, the `Passthrough` event_map arm, and
   fake-daemon driver plumbing are gone; codegen is clean again.
   **The rebuild landed in Phase 2 / Phase A (2026-07-06):**
   `tests/support/fake_daemon.rs` is a real axum router replaying the frozen
   corpus over an ephemeral port, speaking real `DaemonEvent`s end to end;
   `daemon_client::set_spawn_override` routes `PolytokenDriver` to it. 16
   live-path integration tests exercise it. **Phase 2.5 (2026-07-07) added the
   *dev surface*** — `/debug/reset` + the `mock` WS message now route to the fake
   daemon (`PILOT_DRIVER=fake`, promoted from a test-only harness into
   `src/polytoken/fake_daemon.rs`), and a corpus-SUBSET `e2e/live` Playwright tier
   runs through it as a second backend (D21) — a beachhead over the frozen corpus
   flows, not the full mock suite. (The dev surface uses the real `/debug/reset` +
   `mock` message, not the earlier-planned `/dev/reset`/`/dev/script` naming.)

2. **Live-path bugs visible by inspection** (no test existed to catch them —
   that's the point). **FIXED 2026-07-06 (Phase 2, items 1–3)** — the three
   below now have integration coverage via the fake-daemon harness. **The
   remaining item-5 wiring bugs are FIXED 2026-07-07 (Phase 5)** — wired into
   the live `PolytokenDriver` + covered by 6 driver-wiring AC tests in
   `tests/live_path.rs`. Only the genuinely-out-of-scope gaps remain:
   - ✅ `driver.rs` SSE handling spawned a task **per event** → unordered fold
     under bursts. FIXED: one per-session unbounded-mpsc consumer task
     (`debug_assert` single-consumer). See driver.rs header.
   - ✅ `DaemonEffect::FetchState { emit, prompt_id }` ignored both fields.
     FIXED: emits `build_post_fetch_event` against the refreshed cache.
   - ✅ `DaemonEffect::RefetchQueue` was a TODO. FIXED: maps the snapshot →
     `QueueUpdated` via `queue_messages_from_snapshot` (pure, unit-tested).
   - ✅ RESOLVED (Phase 5): `new_session` ignores `opts.worktree` and passes
     `login_env: None` — FIXED: `new_session` is now `Result`-returning, creates
     the worktree via `worktree::plan_fresh_worktree`, and threads captured
     login-env into the spawn (covered by `new_session_worktree_isolates_cwd`
     + `new_session_passes_captured_login_env_to_spawn`).
   - ✅ RESOLVED (Phase 5): `open_session` fabricates the workspace path from
     `$HOME` — FIXED: `cwd_for_session` reads the real project cwd from the
     on-disk `session.json`. (The reload re-warm-via-attach path still wants
     `startup.json` session-registry/worktree port — see Phase 2 item 5; the
     harness asserts disposal + no-deadlock, not re-warm emission.)
   - ✅ RESOLVED (Phase 5): `list_sessions` hardcodes `archived_for: |_|
     false` / `worktree_for: |_| None` — FIXED: real resolvers backed by
     `archive_store`/`worktree_store` + warm-merge via `merge_session_lists` +
     live-usage overlay (covered by `list_sessions_overlays_archive_and_worktree_flags`).
   - ✅ RESOLVED (Phase 5): `warm_cap` enforced nowhere — FIXED: eviction
     hooked into `install_warm` after insert with a recency-order structure +
     `focus` operation; emits synthetic `sessionClosed` before disposing each
     LRU victim, skipping any with `turn_in_flight` (covered by
     `warm_cap_evicts_lru_idle_session` + `warm_cap_never_evicts_in_flight`).
   - ✅ RESOLVED (2026-07-07 "leg 1" cleanup): `set_archived` is wired in the
     live `PolytokenDriver` (flips the archive flag + reaps a live worktree,
     dirty → retained; a shared `reap_worktree` helper backs both it and
     `cleanup_worktree`). The hub's `pilot_settings_msg` now calls
     `driver.login_env_status()` via a new synchronous `PilotDriver` trait
     method (mock/default report `{ok:false}`). Covered by three `live_path`
     tests + two hub tests. (The earlier "hub never sends `modelDefaults`"
     bullet was wrong — `connect_model_defaults` broadcasts it, with a test.)

3. **Silent-degradation idiom.** Repo philosophy is fail-loud; the port
   has residual spots that still do the opposite. Status as of 2026-07-07:
   - ✅ `POST /update/state` — FIXED (Phase 1.7). `UpdateStateBody` parses the
     body; `available` gates `sha`, `applyFailed` resets a stuck applying card.
   - `/push/*` endpoints still return hardcoded `{ok:true}`; `push.rs` (store
     + service shell) exists but is unwired; VAPID keygen + delivery are TODO;
     the hub's `notify` is `None`. (Still open — Phase 3.)
   - `/health` still returns hardcoded zeros for clients/running/busy. (Still
     open — Phase 3.)
   - ✅ RESOLVED (2026-07-07 "leg 1" cleanup): an audit of every TS
     `{type:"error"}` site vs Rust found the raw "~17 vs ~6" count was not a
     list of real gaps — most TS error sites are capability guards dissolved by
     Rust's trait defaults, catches on infallible Rust methods, HTTP-layer auth
     (401 at upgrade vs an in-band message), or intentional empty-list
     degradation shared by both. The one real silent spot was `OpenDataDir`
     discarding the file-manager spawn error; it now surfaces `"couldn't open
     the data directory: {e}"` through an injectable spawn seam (covered by
     `open_data_dir_surfaces_spawn_failure`).
   - ✅ Blanket `#![allow(dead_code)]` / `#![allow(unused_variables)]` —
     FIXED (Phase 0.2). All hand-written module-level allows removed; only 3
     justified `#![allow(dead_code)]` remain (generated `pilot-daemon-types`
     crate + the two `tests/support/` files compiled by both the `corpus` and
     `live_path` binaries), and the old `driver.rs` `unused_variables` blanket
     is gone — which is precisely what had hidden the ignored `opts.worktree`
     / `emit` / `prompt_id` parameters. Survivors converted to item-level
     `#[expect(dead_code, reason="...")]`, 16 tagged `BUG:`. **The 6 live-path
   `BUG:` `#[expect]` markers in `driver.rs` are RESOLVED (Phase A, 2026-07-07):
   `prompt` (deliver_as/images/prompt_id + focus-before-POST), `branch_from`
   (seed begins with the `sessionOpened` snapshot), `list_commands`/`list_facets`/
   `list_files` (targeted-session cwd + cache key; `list_facets` reads facet names
   through the daemon VFS and falls back to `["execute","plan"]`), and spawned-child
   retention (`owned_process` retained + killed on dispose). `-D warnings` now
   enforces that no silently-ignored parameter remains.** (The bullet above
     in this list previously claimed "nine modules carry blanket allows";
     that was pre-Phase-0.2 and is no longer true.)
   - `build_sha` is still hardcoded empty. (Still open — Phase 3.)

4. **Concurrency model divergence — partly addressed, partly standing.** The
   hub is a global `Arc<parking_lot::Mutex<SessionHub>>`; async driver calls
   are fire-and-forget `tokio::spawn`s that re-lock to deliver. That's a
   workable transplant of the single-threaded TS model. The worst symptoms
   were fixed by **Phase 1's completion-queue** (bounded `mpsc` (256) + one
   long-lived applier task (`run_hub_op_applier`) that locks and applies in
   FIFO dispatch order), which killed the connect-time
   sessionList/modelList/commandList/facetList/fileIndex fan-out races and
   restored TS-deterministic ordering. One deadlock happened earlier (fixed
   in review); reset races needed a generation-counter band-aid. **Still
   standing:** the documented divergence that the Rust queue serializes in
   *dispatch* order (stricter than TS, which fires connect follow-ups
   concurrently and applies in completion order) — accepted for this
   single-user tool but noted. Every new handler still re-derives locking
   rules from folklore; the hub.rs header documents the one-pattern
   discipline.

5. **No enforcement — RESOLVED.** server-rs is in CI (Phase 0.2): the
   `rust-server` job in `.github/workflows/ci.yml` runs `cargo fmt --check`
   + `cargo clippy --locked --all-targets -- -D warnings` + `cargo test` on
   ubuntu-latest. `bun run check:rs` runs the same three locally and is
   wired into the root `package.json`. `server-rs/Cargo.lock` is tracked so
   `--locked` works on a clean checkout. (The bullet previously claimed
   "absent from CI and `bun run check`"; that was pre-Phase-0.2 and is no
   longer true.)

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

Polytoken is moving underneath this plan. Before porting, fixing, or testing
any daemon-facing workaround, check <https://docs.polytoken.dev/changelog/>
and diff a fresh `polytoken openapi` dump — prefer deleting a workaround the
daemon now owns over porting it faithfully. Shortest path to a clean Rust
server = the daemon owns everything it can.

> **Version status (2026-07-07):** installed here **0.4.0-unstable.7**. The
> unstable.6 items below (`/history` `emitted_at`, `POST /prompt` auto-queue)
> have already been **adopted** in Phase 2.0 — `emitted_at` is read
> schema-driven in `history_seed.rs` (with a deterministic synthetic fallback
> for pre-.6 replay), and the prompt-or-queue TOCTOU was collapsed onto the
> daemon auto-queue. SSE heartbeats (unstable.5) are the liveness basis
> (heartbeat timeout in `daemon_client.rs`). The bullets below are kept as
> the rationale record; treat the "become deletable / verify on the bump"
> guidance as **done for unstable.6**, and re-check only on the *next* bump.

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
- [x] Restore error-message parity: audited all TS `{type:"error"}` sends vs
      Rust (2026-07-07 "leg 1"). The "~17 vs ~6" gap was mostly illusory —
      trait-default-dissolved capability guards, catches on infallible methods,
      HTTP-layer auth, and intentional empty-list degradation. The one real
      silent spot, `OpenDataDir`'s discarded spawn error, now surfaces to the
      client (`open_data_dir_surfaces_spawn_failure`).

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
- [x] Port `event-map.test.ts` (129 cases; pure functions, mechanical,
      highest bug-yield per hour) and `ui-bridge.test.ts` (38). **DONE
      (2026-07-06):** event-map 124 active + 5 `#[ignore]` (generated-type gaps +
      1 daemon-collapse, all phase-named) = 129/129; ui-bridge 38/38. Dual-reviewed
      (Opus): fixed the `goal_driver_update` proposed-blank source bug (gate the
      emit on `transition`, not goal-presence) and strengthened the permission
      tests to assert choice content. See the `event_map.rs`/`ui_bridge.rs` bullet
      under "What is genuinely done and trustworthy".
- [x] Fix the SSE ordering bug with the Phase-1 idiom: per-warm-session
      `mpsc` + one consumer task. Never per-event `tokio::spawn`. **DONE
      (Phase 2 / Phase C, 2026-07-06):** one per-session unbounded-mpsc
      consumer task (`mpsc::unbounded_channel` in `driver.rs`); `debug_assert`
      single-consumer is the primary regression guard. AC.3: 250 ordered deltas
      fold in order. See "Phase 2 live-path validation" → Phase C.
- [x] Implement `DaemonEffect::FetchState`'s emit path (`emit`/`prompt_id`)
      and `RefetchQueue` → `queueUpdated`; port the TS tests that cover them.
      **DONE (Phase 2 / Phase D, 2026-07-06):** `FetchState` now emits
      `build_post_fetch_event` against the refreshed cache with the threaded
      `prompt_id`; `RefetchQueue` maps the snapshot → `QueueUpdated` via
      `queue_messages_from_snapshot` (pure, unit-tested). AC.4 + AC.5. See
      "Phase 2 live-path validation" → Phase D. (`RefetchQueue`'s interaction
      with unstable.6's `/prompt` auto-queue is moot — the TOCTOU was
      collapsed onto the daemon auto-queue in Phase 2.0; see "Daemon-owned
      first".)
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
- [x] Integration tests: rebuild the fake daemon as a test axum router
      speaking the **real** wire protocol, driven by the corpus; bind an
      ephemeral port, point `PolytokenDriver` at it, assert emitted
      `SessionDriverEvent`s and the effect HTTP calls. This covers the
      composition MockDriver e2e can never see: SSE loop → accumulator →
      effects → HTTP back. **DONE (Phase 2 / Phase A, 2026-07-06):**
      `tests/support/fake_daemon.rs` replays the frozen corpus over an
      ephemeral port; `daemon_client::set_spawn_override` routes
      `PolytokenDriver` to it end-to-end. 19 live-path integration tests in
      `tests/live_path.rs` cover the ACs. (The dev *surface* — `/dev/reset`
      and `/dev/script` driving the full e2e suite through it — is Phase 2.5;
      the harness itself is live and test-only.)
- [ ] Port `daemon-client.test.ts` + `lease-retry.test.ts` (25) — but first
      simplify liveness against unstable.5's SSE heartbeats ("Daemon-owned
      first") so the ported tests pin the new design, not the probe dance.
      Introduce a
      spawn seam equivalent to TS's `_setSpawnForTesting` — needed regardless
      of the fake daemon: spawn failure / process death can't be expressed on
      the wire (in fake mode nothing spawns). Lease conflicts and
      daemon-death-mid-session CAN be wire-expressed (claim rejection, SSE
      drop) — cover those in the fake-daemon integration tests.
- [x] Port the `shared/` modules **with their tests** and wire them:
      `worktree` (+name, 8 tests) into `new_session`; `login-env` (15) into
      daemon spawn; `warm-cap` (10) into pool eviction; `background-model`
      (16) into settings/modelDefaults; `sessions-registry` tests (15).
      Port `archive-store` + `worktree-store` and wire `list_sessions`.
      **DONE (Phase 5, 2026-07-07):** pure modules ported in Phase 1
      (worktree_name 2, warm_cap 10, session_list 4, login_env 11 pure),
      fs stores in Phase 2 (archive_store 5, worktree_store 10), worktree
      planners + jj/git helpers in Phase 3 (8 + 1 git), all wired into the
      live `PolytokenDriver` (new_session→Result + worktree + login_env;
      open_session cwd; list_sessions real resolvers + warm merge;
      warm-cap eviction; cleanup_worktree). `background-model` was ported
      + wired in Phase 1.8. **Still 0 Rust counterpart:** `sessions-registry`
      (15) — its `read_session_json` is consumed by `cwd_for_session` but the
      dedicated test file is not ported.
- [x] Fix `open_session`'s `$HOME` workspace fabrication (read the session's
      real project path). **DONE (Phase 5):** `cwd_for_session` reads the
      project cwd from the on-disk `session.json`.

### Phase 2.5 — live-path validation, part 2: fake-daemon e2e tier

The point: reuse the whole existing e2e suite as continuous live-path
coverage. Flakes in this tier are product bugs (ordering, races) — the
fail-loud philosophy applied to tests — not noise to be waited away.

- [x] **DONE (Phase 2.5, 2026-07-07):** the fake daemon's dev surface — the real
      `PolytokenDriver` over an in-process, corpus-backed fake daemon
      (`PILOT_DRIVER=fake`, `src/polytoken/fake_daemon.rs::FakeControlHub`). Wire:
      `/debug/reset` → `hub.reset` → `driver.reset` (keeps the bootstrap session
      warm so the *synchronous* `seed_default` reseeds — a deliberate divergence
      from the plan's "dispose" wording, since re-warming is async) and the `mock`
      WS message → `driver.run_script(name)` (maps a script name → corpus scenario,
      pushes its SSE frames onto the held-open per-session stream). The runtime
      controllable stream replaced the one-shot scenario drain; the single-consumer
      ordering guarantee the `live_path` tests assert is preserved. Integration
      tests: `live_path::{fake_mode_boots_and_bootstraps, dev_surface_reset_reseeds,
      dev_surface_run_script_pushes_scenario}`. (The earlier `/dev/reset`·`/dev/script`
      naming was never used — the real wire is `/debug/reset` + the `mock` message.)
- [x] **Playwright live tier — landed as a corpus SUBSET (Phase 2.5, 2026-07-07;
      D21); FIRST GREEN RUN + bootstrap bug fix (2026-07-07).** A SEPARATE
      `playwright.live.config.ts` runs `e2e/live/*.e2e.ts` (streaming, queue,
      abort, ask-user-question, tool-approval) against `PILOT_DRIVER=fake` via
      `bun run test:e2e:live`; the default `test:e2e` mock tier
      (`desktop`/`mobile`) is unchanged. This is a deliberate BEACHHEAD over the
      frozen corpus flows, NOT the full ~298-spec suite (D21) — widening needs
      conscious live captures. The specs assert structural DOM (roles/testids),
      not the mock's fixture strings (the corpus content differs). **First
      browser run found + fixed a real fake-daemon bug:** the bootstrap session
      reused the `reconnect-stream-discontinuity` corpus, whose first `/state`
      reports `turn_in_flight:true`, seeding a Running snapshot that stuck the
      composer on "Working…" (all 5 specs failed at `gotoFreshLive`). Fixed by
      synthesizing an idle bootstrap scenario (`turn_in_flight:false`, empty
      transcript) in `fake_daemon.rs`; `run_script` now arms the chosen flow's
      HTTP recordings as an override (so in-turn `FetchState`/`RefetchQueue`
      calls serve that flow's responses, not 500 on cursor exhaustion), `reset`
      drops it back to idle, and a small inter-frame delay on the controlled SSE
      push makes transient mid-flow UI (the queue tray, drained before the turn
      ends) observable — the queue spec asserts it via a bounded `expect.poll`.
      All 5 specs pass locally (twice, stable). CI job `web-live` is still gated to
      `workflow_dispatch`; next step is a CI dispatch run to confirm green on the
      runner, then drop the `if:` to promote it to the PR gate. GROW-THE-CORPUS
      PATH: capture a new scenario
      (`scripts/capture-daemon-corpus.ts`, operator + `$DEEPSEEK_API_KEY`),
      add a `run_script` match arm + an `e2e/live` spec.
- [ ] Keep the MockDriver project as the fast deterministic tier for UI dev
      (dev bar, Claude_Preview) and triage. Revisit after cutover: if the
      fake-daemon tier is green and comparably fast, consolidate to one mock
      (delete MockDriver) rather than carrying both out of inertia.

### Phase 3 — cutover mechanics

- [~] **Bump polytoken to current before the live smoke** — *mostly absorbed.*
      The ambient daemon is already **0.4.0-unstable.7**, and the unstable.6
      work this step was meant to do has landed: `emitted_at` is adopted in
      `history_seed.rs` (schema-driven read + synthetic fallback), the
      `/prompt` auto-queue TOCTOU is collapsed onto the daemon, and SSE
      liveness is heartbeat-based. What remains of this item is the
      **mechanical bump ritual for the *next* daemon release**: re-run
      codegen, replay the golden corpus as the drift canary, adopt any newly
      daemon-owned fields, and re-capture the corpus only on conscious
      adoption. The TS server needs the same adaptation while it remains the
      escape hatch.
- [ ] Live smoke as the final gate: drive a real daemon session through the
      GUI via the parity harness (new session, prompt, stream, approve a
      tool, switch model/facet, abort, archive); diff `/debug/state` against
      the Bun server where feasible.
- [ ] `/health`: real client/running/initializing/busy counts.
- [x] `POST /update/state`: parse `{available, sha, applyFailed}`. **DONE
      (Phase 1.7, 2026-07-05):** `UpdateStateBody` struct in `main.rs` parses
      the body; `available` gates `sha`, `applyFailed` resets a stuck
      "applying" card. Ported hub unit tests cover it. (Was originally
      scoped as Phase 3 but landed during the update-card cluster burn-down;
      retained here only to record the move.)
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
cd server-rs && cargo test                      # 430 tests, green (5 daemon-types, 64 protocol, 334 lib, 8 corpus, 19 live_path)
cd server-rs && cargo clippy --all-targets -- -D warnings   # 0 warnings (Phase 0.2)
bun run check:rs                                # fmt + clippy + test locally (CI gate)
bun test                                        # 761 tests, green
bun run test:e2e                                # control vs Bun server: deterministic-core green (320/321; the 1 is the suite-level sidebar-drafts flake, passes in isolation)
PILOT_SERVER_IMPL=rust bunx playwright test --project=desktop   # vs Rust server: 298/298 (0 det failures; 2 known load-induced flakes pass in isolation)
```
