# Pantoken — TODO

Backlog. Items marked [ ] are open; ~~[x]~~ notes are kept only where the
resolution is non-obvious or likely to bite again. Otherwise see `jj log`.

## 🔴 Open bugs

- ~~[x]~~ pantoken supports all the `@` references like polytoken does (files,
      `@~/`/`@/`/`@../` external paths, `@skill:`, `@subagent:`,
      `@model:p/m(level)` with `[`/`]` reasoning, Shift+Tab ignore toggle,
      resolved-ref chips + missing-ref warnings). Known limits, accepted:
      chips don't survive history replay (daemon `.jsonl` doesn't persist
      `resolved_references`); external paths with spaces can't be referenced
      (mention token ends at whitespace — TUI parity).
- [ ] currently only top of transcript is draggable, top of both sidebars should be too
- [ ] add version git tag to bottom of sidebar next to git hash
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
      lives in `server-rs/PROGRESS.md` Phase 2.5.)
- [ ] move "archived" popups elsewhere (top of sidebar? still middle of transcript but top instead of bottom? discuss first)
- ~~[x]~~ The "new session" view leaked the previous session's state:
      ApprovalLayer/QnaInline dialogs, PlanView, the right context panel
      (+ its edge tab), and the composer's context-pressure cue all read
      `store.session` (still the old session while drafting). All now gate on
      `!store.draft` — the pattern QueueTray already used. If a NEW surface
      reads `store.session`, it must decide what drafting means for it.


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
- [ ] **Client markdown re-parse is O(n²) per streamed message (C1).**
      `Markdown.svelte` re-parses full content on every content change; the
      parser has no incremental/prefix caching. **Re-measure now that N1 landed:**
      N1 collapses a token burst into one frame, so it cuts the *number* of
      re-parses (was one per token, now one per ~50ms flush) but not the per-parse
      O(n) cost — a long message still re-parses its full length on each flush, so
      the O(n²)-over-a-message shape may persist at lower constant factor. Profile
      a long streamed message under the 50ms default before deciding if incremental
      parsing is still worth it.
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
      the wire — the moment an *uncompressed* frame follows such a message.
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
        `TimoFreiberg/polytoken-gui`, v0.2.0 published; endpoint baked into the shell
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
- [ ] **Flatten the per-feature fan-out (the CAUSE of hub/driver growth).** A
      simple daemon toggle costs six touches: wire variant → hub case →
      `PantokenDriver` method (~30 methods, half optional behind `?.`) → two driver
      impls → store method → component. The pass-through class (compact,
      clearContext, setMcpServer, toggleAdventurousHandoff,
      setNotificationAutodrain, …) shares one shape — POST → refresh → snapshot;
      the polytoken driver already unified them behind `refreshAndEmit` — so a
      data-driven `sessionAction(kind, payload)` seam would collapse roughly a
      third of the hub switch and driver interface. Do it before/with the hub
      decomposition; it shrinks the thing being decomposed.
- [ ] **Decompose the client store (the client-side god object).**
      `client/src/lib/store.svelte.ts` (~2.5k lines) mixes protocol fold/resume
      machinery, outbox durability, draft persistence, nav history, toasts,
      theme/font, push, and settings. The seams are half-cut already
      (prompt-outbox.ts, delivery.ts, session-filter.ts) — extract
      connection/seed/resume, outbox, and drafts modules. Same caveat as the
      hub: its own change, e2e as the net.

## 🧹 Minor

- [ ] add `x` delete button on queued prompts (if not there already)

- [ ] Fix the two perf scripts (broken under Bun isolated `node_modules`) so the
      C1 measurements stay reproducible.
- ~~[x]~~ `maybe_notify` (hub.rs) re-implemented the blocking-dialog kind list by
      hand — and had already drifted (missed `plan` + `permission` pushes; the
      hub's local `is_dialog_request` also missed `plan`, so plan proposals
      never registered attention). All three copies now unified on
      `pantoken_protocol::session_driver::is_dialog_request`.
- [ ] Journal epochs are `Date.now()`-seeded per process; a fast restart could in
      principle re-mint an epoch a stale resume token still holds (needs more
      epoch bumps than elapsed ms — effectively unreachable). Revisit only if
      phantom-resume bugs ever show up.
- [ ] `bun run check` has no enforcement — a red server typecheck sat on main
      unnoticed (fixed in 204d3361) and the chain short-circuits, so everything
      after it had stopped gating too. Decide: pre-push hook vs CI.
- [ ] `sse_loop` retries forever even on permanent failures (401 included) —
      its own comment admits it. Post-warm liveness needs a "this session
      died" client signal before fail-fast is honest there (the restore path
      is classified now; see `polytoken/restore_error.rs`).
- [ ] `spawn_new_daemon`/`spawn_resume_daemon` flatten `io::Error` into
      strings — binary-missing vs dir-missing both read "No such file or
      directory". Preserve `ErrorKind` so `restore_error::classify` can stop
      string-sniffing.
- [ ] Restore fail-fast treats an unmounted volume as permanent `MissingCwd`
      (deliberate: the toast says move it back; re-clicking re-checks).
      Revisit only if external-volume projects become a real workflow.
- [ ] `sessions_registry` fabricates `1970-01-01` for a cold session whose
      `session.json` lacks `created_at` — render-hidden by `relative-time`'s
      2020 plausibility floor. Make the wire timestamp nullable instead if it
      ever matters.
- [ ] The bottom working indicator no longer announces the thinking phase to
      screen readers (label removed for dedupe; timer/tokens are aria-hidden;
      the ThinkingBlock label isn't in a live region). Add sr-only text if
      a11y ever matters here.
- [ ] Warm-rename durability leans on the daemon flushing `overridden_title`
      to `session.json` on its own cadence (empirically true; not
      contractual).
- [ ] Composer `expanded` is the one sticky-looking UI state left
      unpersisted — by design (auto-resets on send). Product call before
      persisting.

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
- [ ] Swipe gestures (edge-swipe to open/close sidebar)
- [ ] Haptic feedback (navigator.vibrate on approval-needed / turn-complete)
- [ ] App-icon unread badge (Badging API)

### Notifications
- [ ] Actionable push notifications (Approve/Deny on the notification itself)
- [ ] Per-session notification mute
- [ ] Distinct alert patterns (approval-needed vs turn-complete)
- [ ] Quiet hours / DND schedule

### Observability & debug
- [ ] In-UI raw event drawer (dev-only, streams raw SessionDriverEvents)
- [ ] Font-size / density control

### Branding
- [ ] **Rename: Pantoken → Polyscope** (2025-07-03 candidate). "Polyscope" is a
      real word — an optical instrument that magnifies / shows many colors —
      and contains "poly" as a nod to the polytoken driver. Rename touches:
      project name, docs, app icon, spinner/loading visuals, PWA manifest,
      and any user-facing strings. Hold for now; digest the name before
      committing.

## 🎒 Patterns to steal (from paseo.sh)

- [ ] Follow-on UI primitives — Toggle · Chip · Menu/Dropdown · Disclosure
      (promote only once a pattern recurs cleanly, don't pre-build)
- [ ] Shared layout primitives (session row, section header)
- [ ] Big-snapshot pagination + tool-update frame coalescing
