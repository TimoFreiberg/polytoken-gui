# Pilot — TODO

Backlog. Items marked [ ] are open; ~~[x]~~ notes are kept only where the
resolution is non-obvious or likely to bite again. Otherwise see `jj log`.

## 🔴 Open bugs

- [ ] **Medium-tier (5 remaining):** optimistic userMessage before POST leaves
      ghost rows on failure (reduced: may be fixed); renaming a cold session
      hijacks activeSessionId (and spawns a daemon); phone-wake half-open sockets
      show a green "live" LED over a dead link; ⌘F can't search collapsed
      "Worked for Ns" bodies (DOM-only search); reloaded transcripts show
      "56y ago" (synthetic epoch timestamps — daemon gap, see
      `polytoken-upstream-feature-asks.md` #1); e2e suite asserts mock behaviors
      the live driver never produces.

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
      Tunable at runtime via **`PILOT_DELTA_FLUSH_MS`** (config `deltaFlushMs`):
      default **50**, **0 disables** (every delta ships immediately — the exact
      pre-N1 behavior, and the default the unit tests construct with). The knob
      exists precisely because "chunkier reveal vs token-smooth" was the feel
      question that got N1 deferred — now it's a live dial, not a rebuild.
      Buffering lives in `SessionHub.ingest` (wrapping the un-buffered
      `ingestNow`); see `server/src/hub.ts` + the "assistantDelta coalescing (N1)"
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
- [ ] **Virtualize the transcript + memoize per-turn grouping (C2).**
      `Transcript.svelte` recomputes grouping over the whole item list on every
      structural event. Memoize per-turn so only the active turn recomputes;
      real windowing after that.

## 🏗️ Architecture

- **ADR-desktop-shell.md** — accepted; spike complete 2026-07-03, all five exit
  criteria green. The Tauri shell lives in `desktop-tauri/` (see its README). The
  "📐 Architecture direction" note that lived here (Rust hub end-state, distribution
  model) is superseded by that ADR; the Rust-hub target stays gated by the criteria
  in it. Remaining to fully retire `desktop/` (Swift):
  - [ ] Dogfood `desktop-tauri/` (tray, close-to-tray, titlebar/traffic-light fit,
        update overlay — the visual bits an agent can't eyeball).
  - [x] **Bundled mode shipped (2026-07-03):** compiled hub as `externalBin` + client
        as a bundle resource; packaged .apps are self-contained (no clone, no bun) and
        the shell's updater loop replaces the TS watcher there — same defer policy and
        sidebar card via `/update/state`, verified E2E against a local manifest
        server. Clone mode stays as the dev loop.
  - [ ] Set up updater-artifact hosting (ADR "Owner decisions" #2; owner lean: a
        separate public GitHub releases repo — note the artifact now contains the
        whole app, hub+client included): create the repo, run the first
        `bun scripts/desktop/publish.ts --repo <owner/releases-repo>`, configure the
        endpoint on installed apps, then drop `dangerousInsecureTransportProtocol`.
  - [ ] Then delete `desktop/` + its watcher desktop-sha plumbing, and point
        docs/DESIGN.md at the Tauri shell.
- [ ] **Decompose the hub (god object).** `server/src/hub.ts` owns the per-session
      journals, running/attention maps, clients map, live ticker, OAuth pending,
      prompt-results ledger; `handleClient` is one giant switch. Extract
      collaborators the hub delegates to. Deferred — touches the app's central
      nervous system; wants its own change with the full e2e suite as the net.
- [ ] **Flatten the per-feature fan-out (the CAUSE of hub/driver growth).** A
      simple daemon toggle costs six touches: wire variant → hub case →
      `PilotDriver` method (~30 methods, half optional behind `?.`) → two driver
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
- [ ] `maybeNotify` (hub.ts) re-implements the blocking-dialog kind list by hand
      instead of using `isDialogRequest` — the two drift when a new dialog kind
      lands.
- [ ] Journal epochs are `Date.now()`-seeded per process; a fast restart could in
      principle re-mint an epoch a stale resume token still holds (needs more
      epoch bumps than elapsed ms — effectively unreachable). Revisit only if
      phantom-resume bugs ever show up.
- [ ] `bun run check` has no enforcement — a red server typecheck sat on main
      unnoticed (fixed in 204d3361) and the chain short-circuits, so everything
      after it had stopped gating too. Decide: pre-push hook vs CI.
- [ ] Settings.svelte carries ~10 unused CSS selectors (svelte-check warnings)
      left behind by a refactor — sweep them.

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
- [ ] Collapse-all / expand-all tool calls
- [ ] Per-code-block copy + language label
- [ ] Copy-on-hover for code blocks
- [ ] "New since you left" divider (marker at first message while unfocused)
- [ ] Inline image rendering (markdown image / screenshot path → inline)
- [ ] Merge sequential read calls visually (contiguous ranges → one card)

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
- [ ] **Rename: Pilot → Polyscope** (2025-07-03 candidate). "Polyscope" is a
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
