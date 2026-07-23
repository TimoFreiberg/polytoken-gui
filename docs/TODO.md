# Pantoken — TODO

Backlog. Items marked [ ] are open; ~~[x]~~ notes are kept only where the
resolution is non-obvious or likely to bite again. Otherwise see `jj log`.

## 💬 Discussion needed (open product decisions)

Items moved here from the original `docs/quality-gate.md` — these are
unsettled product questions, not hard invariants. Each needs a critical
discussion before becoming a gate (or being rejected).

- [ ] **Visuals expansion: extra niceties beyond TUI parity.** In
      addition to faithfully implementing all polytoken TUI features
      (Q1/Q2), we want extras: searching across all discovered sessions,
      showing all sessions on the machine grouped by project, archiving
      all sessions, mostly-automatic Git/JJ workspace handling. These are
      aspirational — scope, priority, and which are blocking vs. nice-to-
      have need discussion.
- [ ] **Notification configurability detail.** Q4 allows desktop
      notifications for incoming questions, but requires them to be
      configurable. The exact configuration surface (per-session mute?
      quiet hours? distinct alert patterns?) is open — see also the
      Notifications brainstorm items below.

## 🔴 Open bugs

- ~~[x]~~ pantoken supports all the `@` references like polytoken does (files,
  `@~/`/`@/`/`@../` external paths, `@skill:`, `@subagent:`,
  `@model:p/m(level)` with `[`/`]` reasoning, Shift+Tab ignore toggle,
  resolved-ref chips + missing-ref warnings). Known limits, accepted:
  chips don't survive history replay (daemon `.jsonl` doesn't persist
  `resolved_references`); external paths with spaces can't be referenced
  (mention token ends at whitespace — TUI parity).
- ~~[x]~~ tops of both sidebars are now window-drag surfaces
  (`data-tauri-drag-region="deep"`, same contract as StatusHeader).
- ~~[x]~~ sidebar build stamp now leads with the nearest release tag
  (`v0.2.15 · <hash> · <date>`); tag resolves via `git describe` with a
  jj fallback, hides when unresolvable.
- ~~[x]~~ Subagent-completion notice dumped the whole report as a giant
  ellipse-shaped pill. Fixed at both ends: `notification_message` in
  `event_map.rs` builds a short label from `notification_type`
  (summary passes through only for `HookResult`/`ExtensionMessage`/
  `Unknown`), and `.notice` CSS is hardened (`--radius-sm`, `flex-start`,
  `pre-wrap`) so any future long notice wraps instead of ellipsing.
- [ ] **e2e live-tier coverage gap** (was "e2e suite asserts mock behaviors the
      live driver never produces"): the corpus-backed live tier exists
      (`e2e/live/`, 5 spec files vs `PANTOKEN_DRIVER=fake`, real recorded
      daemon traffic) and passes, but it's gated to manual `workflow_dispatch`
      in CI — not a blocking gate yet — and covers 5 of ~80 spec files,
      structurally not textually. The rest of the suite still has no
      live-driver corroboration. (The old "see DECISIONS.md D21" pointer is
      dead — that entry was deleted in the docs cleanup; the tier summary
      lives in `server-rs/PROGRESS.md` Phase 2.5.) **2026-07-10 note:** the
      tier ran green locally 3× during the overnight session (5/5 each time,
      including after the sessionAction refactor) — one green
      `workflow_dispatch` run in CI is all that's left before promoting it to
      a blocking gate (drop the `if:` per the comment in ci.yml).
- [x] move "archived" popups elsewhere (top of sidebar? still middle of transcript but top instead of bottom? discuss first) — resolved: archive-undo notice is now a top-of-sidebar overlay (position: absolute, anchored below the header); it doesn't displace session rows and only one exists at a time (issue #60).
- ~~[x]~~ The "new session" view leaked the previous session's state:
  ApprovalLayer/QnaInline dialogs, PlanView, the right context panel
  (+ its edge tab), and the composer's context-pressure cue all read
  `store.session` (still the old session while drafting). All now gate on
  `!store.draft` — the pattern QueueTray already used. If a NEW surface
  reads `store.session`, it must decide what drafting means for it.
- [ ] **Branch (`/rewind`) live-path gaps** (found 2026-07-10 by the frontend→daemon
      trace; the request shape + entry-id→prompt_id mapping are correct, these are
      error-handling/coverage holes): (a) `branch_from` returns a bare
      `BranchResult` so a daemon `/rewind` rejection can't propagate — it collapses
      to the generic "session switch returned no session" client error, real reason
      only in server logs; give branch its own error surface. (b) The LIVE driver
      hardcodes `editor_text: None`, so the "edit & resend" gesture (click-twice
      rewind → `store.branch()`) destroys the prompt text on the live path — prefill is
      mock-only. Needs confirming whether polytoken `/rewind` returns the dropped
      prompt's text (the daemon source isn't in-repo). (c) Zero live-path coverage:
      the fake daemon has no `/rewind` route, so a branch under `PANTOKEN_DRIVER=fake`
      404s into the generic-error path. (d) Doc drift: `protocol/src/wire.ts` still
      describes branch as the daemon's `/tree`+navigateTree; it's a destructive POST
      `/rewind`.
- [ ] **clear_queue + SessionAction live-driver test gaps** (found 2026-07-10):
      the `clear_queue_drains_daemon_queue` test uses a 1-item fake `/turn/input`
      fixture, so its `deletes == 1` assertion can't tell "one DELETE per item" from
      "exactly one dequeue" (the historical bug shape) — needs a 2+ item fixture,
      which needs a fake-daemon knob (canned `/turn/input` + always-200 DELETE win
      over `scenario.http`). And 8/9 `SessionAction` arms + `report_action_error`
      have no live-driver test (mock e2e covers wire agreement, not the polytoken
      PermissionMonitorMode/McpAction mappings or the error-surfacing notice).

## 🎨 UI explorations

- [ ] **Implement exploration 2a: composer chrome and status row.** Add the facet
      control as a small tab on the composer's top border; keep upload on the left
      edge of the composer; put permissions at the bottom-left; combine model and
      effort into one quiet, text-looking button at the bottom-right; and place a
      context-usage circle immediately to its right with no percentage text. Keep
      the exact context value available through the control's tooltip/popover and
      preserve keyboard and touch labels/hit targets.
- [x] **Implement exploration 2c: sidebar top-row controls.** Keep New session as
      the primary button, turn Search and Filter into icon buttons in the top row,
      and pin Collapse to the left-side position it occupies in the collapsed
      layout from exploration 1f so the collapse target does not move between
      states. Preserve the search expansion behavior, filter-active indicator,
      hotkeys, tooltips, and mobile-sized labeled controls.
- [ ] **Implement exploration 1g: quieter transcript/sidebar chrome.** Minimize
      the transcript header to a single-line session title with a muted project
      tag (omit the tag when redundant), move Settings to the bottom-left sidebar
      footer, and hide the connection LED while the connection is healthy; show
      connection state only for reconnecting/offline/error states. Target the
      compact 48px header and retain accessible labels and the existing settings
      shortcut.

## 🔵 Corpus capture follow-ups (from the 2026-07-06 live-capture session)

Full detail in `server-rs/PROGRESS.md` → "Live corpus capture (2026-07-06)". The
4 committed captures (streaming-turn, queue-while-in-flight, abort, ask-user-question)
are REAL but **provisional** — they embed local `/Users/timo/...` paths from the
`/state` body. Ordered by value:

- [ ] **Canon "before freezing" pass (zero model spend — canon is re-appliable):**
      (a) rewrite inner event `emitted_at` (not just `timestamp`) in
      `canonicalize_frame`; (b) DECIDE the `/state` redaction scope (recommend
      `env`→`{}`, `used_tokens`→`0`, absolute paths normalized) in `canonicalize_http`.
      Mirror BOTH `server-rs/pantoken-server/tests/corpus.rs` AND
      `scripts/capture-daemon-corpus.ts`, then re-canonicalize the committed captures
      and re-run `cargo test --test corpus`. THEN the captures are freezable.
- [ ] **Capture `tool-call-approval`:** regenerate the isolated parity config with
      `default_permission_matcher: standard` (runtime `/permission-monitor` switch does
      NOT gate execution — verified). The driver is already written + ready in
      `capture-daemon-corpus.ts`; it fails loud until the config prompts.
- [ ] **Verify the accumulator handles the real event types** the seeds lacked:
      `notification_autodrain_switch`, `permission_monitor_switch`, `system_reminder`,
      thinking blocks + `signature_delta`, `session_state_changed{domains}` (Phase 2.1).
- [ ] **`/state` has no top-level `turn_in_flight` in unstable.7** — verify nothing in
      the reseed path depends on it.
- [ ] (lower) Script + capture `reconnect-stream-discontinuity` (needs forcing a
      `stream_discontinuity`; SSE resume is a documented upstream no-op).

## ⚡ Performance

- ~~[x]~~ **Server-side coalescing of streamed `assistantDelta`s (N1).** Done.
  The hub buffers at most one pending merged `assistantDelta` per session and
  flushes it as ONE journal append + one WS frame on a timer, reusing the
  journal's `tryMerge` rule so the frame is byte-identical to what coalescing
  would have produced (no wire change, fold unaffected). Any non-delta event
  flushes the session's pending delta first (the per-session ordering
  invariant the fold depends on); a channel switch flushes then re-buffers;
  journal-identity changes (reseed/reload, `sessionClosed` deletion,
  `reset()`) DROP the pending delta rather than leak it into a new epoch.
  Tunable at runtime via **`PANTOKEN_DELTA_FLUSH_MS`** (config `deltaFlushMs`):
  default **50**, **0 disables** (every delta ships immediately — the exact
  pre-N1 behavior, and the default the unit tests construct with). The knob
  exists precisely because "chunkier reveal vs token-smooth" was the feel
  question that got N1 deferred — now it's a live dial, not a rebuild.
  Buffering lives in `SessionHub.ingest` (wrapping the un-buffered
  `ingestNow`); see `server-rs/pantoken-server/src/hub.rs` + the "assistantDelta coalescing (N1)"
  block in `hub.test.ts`.
- [ ] **Client markdown re-parse is O(n²) per streamed message (C1) — measured
      2026-07-09, verdict: acceptable, revisit only for ≥50KB messages.**
      Numbers (scripts/perf-streaming*.ts, now working again): full re-parse per
      content commit at ~0.15ms/KB (≈1.6ms at 10KB), super-linear over a stream
      (10.5KB message ≈ 915ms total parse CPU at per-token cadence). But the
      real cadence is bounded twice: N1 coalesces flushes to ≤20/s, and
      markstream's smooth-stream reveal commits at ≤30fps (`maxCommitFps`
      default 30; NB smooth streaming IS active in our usage — 'auto' resolves
      true since we pass no `typewriter`/`maxLiveNodes`, so re-parses follow
      reveal commits, not just flushes). Typical ≤10KB message ⇒ ≤~50ms parse
      CPU per streamed second on desktop, ~3× on phone — fine. At 50KB+ it's
      ~8ms/commit × 30fps ⇒ jank; if such messages become real, the fix is
      app-level: split settled blocks from the streaming tail (pre-parsed
      `nodes` mode) — incremental parsing inside the parser is not needed.
- [ ] **Virtualize the transcript when measurements justify it (C2).**
      Per-turn grouping is memoized (`createTurnGrouper`), so settled turns reuse
      their view models while the active tail streams. Real JS windowing remains
      the next step only once `?dev` transcript render timings show thousands of
      items causing perceptible paint cost.
- [ ] **Re-enable WS compression (permessage-deflate) when safe.** Disabled
      2026-07-03 (`perMessageDeflate: false`, `server-rs/pantoken-server/src/main.rs`) because it
      killed the desktop app: Bun's WS compressor emits a BFINAL-terminated
      deflate stream whenever a message's compressed output is small (observed
      ≤ ~1.6KB; bigger output gets the normal open-ended sync-flush form), and
      WKWebView (macOS 26.5) fails the whole connection — 1006 in JS, 1002 on
      the wire — the moment an _uncompressed_ frame follows such a message.
      The greeting is a guaranteed trigger (sessionList ≈30KB compressed-big →
      modelList ≈2.5KB compressed-small/BFINAL → small status frames follow),
      so the Tauri webview died ~10ms after every connect, in a reconnect
      flap. Bun 1.3.11 and 1.3.14 both affected; Chrome and Bun's own WS
      client tolerate the framing, which is why Vite dev and the phone PWA
      never showed it. `sendOrClose` still passes the per-send compress flag
      (inert without negotiation), so flipping the config back is the whole
      re-enable. Preconditions: a Bun release that emits spec-shaped
      sync-flush endings (file/track the upstream issue — a ~20-line repro
      exists from the 2026-07-03 investigation), then re-verify with a
      WKWebView probe before shipping. The win is 4-40x on seeds/markdown for
      the tailscale/LTE phone path.

## 🏗️ Architecture

- [ ] **WS → HTTP+SSE transport migration — assessed 2026-07-09, recommended
      as its own project.** The transport seam is thin: ~120 lines of WS
      handler (`main.rs`), 343 lines of reconnecting client singleton
      (`ws.svelte.ts`); the whole seed/event/epoch/seq resume machinery is
      transport-agnostic and would carry over unchanged (SSE `Last-Event-ID`
      even maps onto it naturally). Client→server becomes one `POST /msg`
      route dispatching the same `ClientMessage` enum. **Why do it:** (1) it
      deletes the WKWebView permessage-deflate bug class entirely — standard
      HTTP compression on the SSE stream is the 4–40× phone-path win the
      compression TODO below wants, without waiting on a Bun/WKWebView fix;
      (2) symmetry with the daemon's own HTTP+SSE protocol; (3) curl-able
      debugging. **Costs/warts:** net LOC ≈ a wash (custom reconnect stays —
      EventSource can't send auth headers, so it's a fetch-stream reader);
      PWA service worker must bypass `/events`; migration risk on the most
      load-bearing seam; multiclient + resume e2e re-validation. **Not a
      one-night change** — wants its own branch with the full e2e suite as
      the net, and obsoletes the permessage-deflate re-enable item if done.

- **ADR-desktop-shell.md** — accepted; spike complete 2026-07-03, all five exit
  criteria green. The Tauri shell lives in `desktop/` (see its README). The
  "📐 Architecture direction" note that lived here (Rust hub end-state, distribution
  model) is superseded by that ADR; the Rust-hub target stays gated by the criteria
  in it.
  - [x] Dogfood `desktop/` (tray, close-to-tray, titlebar/traffic-light fit,
        update overlay — the visual bits an agent can't eyeball).
  - [x] **Bundled mode shipped (2026-07-03):** compiled hub as `externalBin` + client
        as a bundle resource; packaged .apps are self-contained (no clone, no bun) and
        the shell's updater loop owns updates — same defer policy and sidebar card via
        `/update/state`, verified E2E against a local manifest server. Clone mode stays
        as the dev loop.
  - [x] **Updater hosting live (2026-07-03):** public releases repo
        `TimoFreiberg/pantoken`, v0.2.0 published; endpoint baked into the shell
        as the default (env/file overrides remain, `PANTOKEN_SHELL_UPDATE_URL=off`
        disables), `dangerousInsecureTransportProtocol` dropped. First installs use
        `curl … | tar xz -C /Applications` — browser downloads of ad-hoc apps hit
        Gatekeeper's "damaged" refusal (see desktop/README.md "Installing a
        release").
- [ ] **Decompose the hub (god object).** `server-rs/pantoken-server/src/hub.rs` owns the per-session
      journals, running/attention maps, clients map, live ticker, OAuth pending,
      prompt-results ledger; `handleClient` is one giant switch. Extract
      collaborators the hub delegates to. Deferred — touches the app's central
      nervous system; wants its own change with the full e2e suite as the net.
- [ ] **Flatten the per-feature fan-out (the CAUSE of hub/driver growth).**
      **Phases 1+2 landed (2026-07-10):** all nine pass-throughs (compact,
      clearContext, setMcpServer, toggleAdventurousHandoff,
      setNotificationAutodrain, setModel, setThinking, setFacet,
      setPermissionMonitor) now ride ONE `sessionAction` wire envelope →
      one hub case → one `session_action(SessionAction)` driver method with a
      match arm per driver (net −169 lines across both phases). Adding such an
      action is a `SessionAction` variant + one arm per driver + a store
      one-liner. The client-side draft branches (⌘⇧C etc.) stay in the store
      methods, untouched. **Remaining:** the hub decomposition proper.
- [ ] **Decompose the client store (the client-side god object).**
      `client/src/lib/store.svelte.ts` (~2.5k lines) mixes protocol fold/resume
      machinery, outbox durability, draft persistence, nav history, toasts,
      theme/font, push, and settings. The seams are half-cut already
      (prompt-outbox.ts, delivery.ts, session-filter.ts) — extract
      connection/seed/resume, outbox, and drafts modules. Same caveat as the
      hub: its own change, e2e as the net.

## 🤖 Automation

- [ ] **Per-issue autopilot** (`just implement-issue <url>`) — spawns one
      polytoken TUI agent per GitHub issue in a new zellij tab, seeded with
      bypass_plus permissions, plan facet, and adventurous handoff. The agent
      runs the full plan→review→execute→review loop using the `quality-review`
      skill, then calls `just integrate-into-main` which acquires a repo-local
      lock, rebases onto `main@origin`, runs tests, advances the main bookmark,
      and pushes. Conflict resolution is delegated back to the agent (hybrid
      lock model). The operator picks issues manually — no auto-triage. See
      `scripts/README.md`.

## 🧹 Minor

- [ ] add `x` delete button on queued prompts (if not there already)
      **Blocked by a daemon constraint (checked 2026-07-09):** the daemon's only
      removal primitive is `DELETE /turn/input/newest` — no delete-by-id. A ✕ on
      an arbitrary item would need clear-all + re-queue, which races the daemon's
      turn-end drain. Honest options: ✕ on the newest item only, or keep the
      existing "Edit all (⌥↑)" restore-to-composer flow. Product call needed.

- ~~[x]~~ The two perf scripts work again under Bun isolated `node_modules`
  (two-hop `Bun.resolveSync` through the store — Bun ignores
  `require.resolve`'s `paths` option, which is what broke them).
- ~~[x]~~ `maybe_notify` (hub.rs) re-implemented the blocking-dialog kind list by
  hand — and had already drifted (missed `plan` + `permission` pushes; the
  hub's local `is_dialog_request` also missed `plan`, so plan proposals
  never registered attention). All three copies now unified on
  `pantoken_protocol::session_driver::is_dialog_request`.
- [ ] Journal epochs are `Date.now()`-seeded per process; a fast restart could in
      principle re-mint an epoch a stale resume token still holds (needs more
      epoch bumps than elapsed ms — effectively unreachable). Revisit only if
      phantom-resume bugs ever show up.
- ~~[x]~~ `bun run check` enforcement — resolved in favor of CI: the `web-check`
  job runs `bun run check` + `bun test` on every PR and push to main
  (`.github/workflows/ci.yml`).
- [ ] `sse_loop` retries forever even on permanent failures (401 included) —
      its own comment admits it. Post-warm liveness needs a "this session
      died" client signal before fail-fast is honest there (the restore path
      is classified now; see `polytoken/restore_error.rs`).
- [ ] **Vite plugin timings in CI build output.** The headless release build
      (`scripts/headless/build.ts`) spends significant time in Vite plugins
      (vite:css-post 28%, vite-plugin-svelte:load-custom 15%, compile 14%,
      build-import-analysis 11%, terser 9%). Investigate whether the build can
      be restructured to reduce these — e.g. pre-building CSS, reducing Svelte
      compilation overhead, or switching minifiers. Keep the timings report
      visible so improvements can be measured.
- ~~[x]~~ `spawn_new_daemon`/`spawn_resume_daemon` flattened `io::Error` into
  bare OS strings — a missing binary read as "No such file or directory".
  `spawn_error_message` now names the binary path while the `ErrorKind` is
  in hand. (Full structured errors across the `Result<_, String>` driver
  seam judged not worth it: classify() is already centralized + tested,
  and MissingCwd has a pre-flight `is_dir()` guard.)
- [ ] Restore fail-fast treats an unmounted volume as permanent `MissingCwd`
      (deliberate: the toast says move it back; re-clicking re-checks).
      Revisit only if external-volume projects become a real workflow.
- [ ] `sessions_registry` fabricates `1970-01-01` for a cold session whose
      `session.json` lacks `created_at` — render-hidden by `relative-time`'s
      2020 plausibility floor. Make the wire timestamp nullable instead if it
      ever matters.
- [ ] The bottom working indicator no longer announces any state to screen readers
      (all text labels were removed — the stop button moved in here from the composer
      and its own visible text/title is the only state carry; timer/tokens are
      aria-hidden). The `aria-live="polite"` region now announces nothing. Add sr-only
      text if a11y ever matters here.
- [ ] Warm-rename durability leans on the daemon flushing `overridden_title`
      to `session.json` on its own cadence (empirically true; not
      contractual).

## 💡 Brainstorm (unfiltered — triage into the lanes above)

### Agent interaction

- [ ] Per-turn token + cost readout
- [ ] Compaction / summary / activity rows
- [ ] Files-changed-this-turn rollup (collapsed card, expandable to per-file diffs)
- [ ] One-off bash affordance (run a shell command whose result enters context)
- [ ] Retry-on-error with "continue" semantics (only on error cards, not a general
      idle-session affordance)

### Composer & input

- [ ] Voice dictation on mobile (Web Speech API mic button)

### Transcript reading

- [ ] code-block language label
- [ ] "New since you left" divider (marker at first message while unfocused)
- [ ] Inline image rendering (markdown image / screenshot path → inline)

### Sessions & navigation

- [ ] Command palette (⌘K) — fuzzy switcher over sessions + actions
- [ ] Pinned / favorite sessions
- [ ] Session emoji / color label
- [ ] Git branch indicator per session
- [ ] "Open in editor" deep link (vscode:// / cursor://)
- [ ] Keyboard shortcut cheat-sheet (`?` overlay)

### Mobile / PWA

- [ ] Swipe-to-close for the drawer + context view (edge-swipe OPEN exists; a
      rightward swipe on the open drawer / context view should close it, mirroring
      the back gesture that already works via lib/overlay-history.ts)
- [x] App-icon unread badge (Badging API) — server sends an attention count in
      every push payload; SW sets/clears, app clears on foreground (2026-07-11)
- ~~Haptic feedback~~ — **iOS platform ceiling**: Safari never implemented
  navigator.vibrate and the checkbox Taptic hack was patched out in 26.5.
  Web has no haptics on iPhone; revisit only for Android or a paid-account
  Capacitor wrapper (docs/PLAN-mobile.md).
- [ ] Declarative Web Push (iOS 18.4+): `app_badge` + `navigate` without SW
      execution, no permission-revocation penalty for unshown notifications.
      NOT adoptable autonomously — it is iOS-Safari-only and can't be exercised
      by Playwright/Chromium or the mock driver; needs a real-device test plan
      (docs/PLAN-mobile.md D8).

### Notifications

- [ ] Actionable push notifications (Approve/Deny on the notification itself)
      — **iOS ceiling**: web push ignores `Notification.actions` through 26.5,
      so this is Android/desktop-only; on iPhone the shipped flow is
      tap-notification → deep-link to the approval card (works today)
- [ ] Per-session notification mute
- [ ] Distinct alert patterns (approval-needed vs turn-complete)
- [ ] Quiet hours / DND schedule

### Observability & debug

- [ ] In-UI raw event drawer (dev-only, streams raw SessionDriverEvents)
- [ ] Font-size / density control

## 🎒 Patterns to steal (from paseo.sh)

- [ ] Follow-on UI primitives — Toggle · Chip · Menu/Dropdown · Disclosure
      (promote only once a pattern recurs cleanly, don't pre-build)
- [ ] Shared layout primitives (session row, section header)
- [ ] Big-snapshot pagination + tool-update frame coalescing
