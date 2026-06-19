# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
Completed items are archived to [`DONE.md`](DONE.md).
See `docs/` siblings for context: `DESIGN.md` (architecture + roadmap), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

_(clear — nothing blocking; pull the next item up from Important)_

## 🟡 Important

- [ ] **Desktop app (macOS .app), local-first** — deferred to a dedicated session.
      Direction (owner, 2026-06-18): the app should **run pi agents locally by default**
      and spawn the pilot server locally on launch, with connecting to a remote server as
      an *option*, not the default. Leaning toward a **mini Swift / WKWebView wrapper**
      around the local server URL — a clickable, dockable `.app`. macOS only for now.
      ⚠️ **Blocker to handle there:** pi spawning must **disregard the server's cwd**.
      `warmUp`'s `launchCwd = opts.cwd ?? process.cwd()` (`server/src/pi/pi-driver.ts`)
      both defaults a session's cwd *and* feeds the trust resolver (the launch cwd is
      implicitly trusted, D12). When the app spawns the server from an arbitrary dir, that
      dir must NOT silently become a trusted default. Audit every reader of `launchCwd`
      before changing it — it's a state-interpretation change, not a one-liner.

## 🟢 Polish / fast-follow

- [ ] **Workspace icon instead of text label in sidebar** — replace the "WORKSPACE: …" label on
      session rows with a compact icon (no text), matching the Claude app's visual density.
- [ ] **Sort projects alphabetically in sidebar** — projects grouped by name A→Z;
      sessions within each project stay sorted by last-used (most recent on top).
- [ ] **Remove hover tooltip on session titles in the sidebar** — intentional: it's visually
      noisy and doesn't add information beyond what's already visible in the title itself.
- [ ] **Hide thinking blocks behind a toggle** — thinking blocks are visually noisy and
      rarely useful to a human driver. Add a toggle (default off, tucked in Settings) that
      hides `<thinking>` content from the transcript; when off, the block is collapsed or
      replaced with a subtle "thinking…" placeholder.
- [ ] **Extension compatibility-issue surfacing** — surface when an extension uses a
      terminal-only capability against pilot's non-tui host. _Half already done (found
      2026-06-19 while building OAuth):_ the protocol has the `extensionCompatibilityIssue`
      event AND `state.ts` already folds it into a transcript `notice` (warning) that
      renders today — so **the rendering is wired; the only missing half is the pi-driver
      emitting the event.** That's the real cost: a pi-integration task — find how pi signals
      terminal-only capability use to a non-tui host (the type was vendored from pi-gui's
      `session-driver`, so pi-gui's emit path is the reference) and wire `PiUiBridge`
      (`server/src/pi/ui-bridge.ts`) to emit it. NOT the cheap render-a-banner job the
      earlier note assumed. _(Scoped down from "enable/disable view", owner 2026-06-19: the
      enable/disable toggle was split off to Later — see below.)_
- [ ] **Per-session system-prompt override** — let a new session start with a custom
      system prompt instead of pi's default (in the new-session draft, and/or a global
      default in Settings). Seam: `resourceLoaderOptions.systemPrompt` on
      `createAgentSessionServices` in `warmUp` (`server/src/pi/pi-driver.ts`) for a full
      replace, or `appendSystemPrompt` for additive. NOT needed for the pi-docs-pointer
      strip — that's handled globally by the `strip-pi-docs` pi extension
      (`~/.pi/agent/extensions/`); this is the broader "different prompt for this session."

## 🔵 Later

- [ ] **gondolin egress containment** (D10) — for the autonomous Mac Mini
      user account; preserves TS-embed via pi-gondolin extension
- [ ] **Group workspace-spawned sessions under their parent** — when a session is spawned
      inside a jj workspace, nest it visually under the parent session in the sidebar
      (or show them adjacent with an indent), so the relationship is visible at a glance.
      Nontrivial: the list is flat today; grouping needs either session metadata or
      workspace-path heuristics.
- [ ] **Session tree / fork / clone / compaction**
- [ ] **Scheduled / recurring runs**
- [ ] **Image / file attachments** (browser file input)
- [ ] **Inline tool-diff rendering**
- [ ] **Workspace git changed-files/diff/stage panel**
- [ ] **Skills enable/disable view**
- [ ] **Extensions enable/disable toggle** — split off from the compat-surfacing item
      (owner, 2026-06-19). Deferred: low frequency (extensions are set once, rarely toggled
      from a phone) and higher cost than it looks — pi loads extensions at session start
      (`packages/coding-agent/src/core/extensions/loader.ts`, no runtime disable), so a live
      toggle needs per-session load config or a session restart, not a flag.

- [ ] **Right-side session minimap** (nebulous, OP8)
- [ ] **Queued-messages editing** (replace queued)

- [ ] **Per-session system-prompt override** _(deprioritized 2026-06-18 — owner doesn't
      expect to need this soon; parked at the back of the backlog)_. Let a new session
      start with a custom system prompt instead of pi's default (in the new-session draft,
      and/or a global default in Settings). Seam: `resourceLoaderOptions.systemPrompt` on
      `createAgentSessionServices` in `warmUp` (`server/src/pi/pi-driver.ts`) for a full
      replace, or `appendSystemPrompt` for additive. NOT needed for the pi-docs-pointer
      strip — that's handled globally by the `strip-pi-docs` pi extension
      (`~/.pi/agent/extensions/`); this is the broader "different prompt for this session."

## 💡 Brainstorm (unfiltered — owner to triage into the lanes above)

_Generated 2026-06-17 on request. Cross-checked against existing items + DESIGN/DECISIONS;
these are net-new. Each is a candidate, not a commitment — promote the good ones, delete
the rest._

### Agent interaction & turn control
- [ ] **Per-turn token + cost readout** — small footer on each completed turn showing
      tokens in/out and an estimated cost (pi emits usage in the snapshot/run events).
      Distinct from the context-window fill indicator — this is "what did that turn cost."
- [ ] **Compaction / summary / activity rows** — DESIGN lists these as SHOULD but
      they're unfiled. When pi auto-compacts the context, render a collapsed
      "context compacted" row instead of letting history silently shift.
- [ ] **Edit-and-resubmit a prior prompt** — hover a past user message → "Edit & resend"
      re-runs from that point (relies on pi fork/branch if available, else just resends).
      Pairs with the jump-to-last-prompt hotkey.
- [ ] **Live activity status line** — derive a one-liner from the in-flight tool
      ("Reading foo.ts", "Running tests", "Editing bar.rs") and surface it in the
      sidebar row, the tab title, and optionally the push notification. Turns the
      pulsing dot into "what is it actually doing right now."
- [ ] **Files-changed-this-turn rollup** — at turn end, a collapsed card summarizing
      every file the agent wrote/edited this turn with `+N/−M` counts, expandable to
      the per-file diffs (reuses the `@pierre/diffs` work already landed).
- [ ] **One-off bash affordance** (DESIGN LATER) — a way to run a single shell command
      whose result lands in the transcript and enters next-turn context, without a full
      prompt. Useful for "what's the branch / git status" mid-session.
- [ ] **"Keep going" / continue button** — one-tap canned follow-up ("continue",
      "keep going") on an idle session, for the common case of nudging a paused agent
      from your phone without typing.

### Composer & input
- [ ] **@-file mention autocomplete** — DESIGN pairs this with the slash-command menu
      (already filed) but it's missing here. Fuzzy-complete repo paths into the prompt.
- [ ] **Per-session composer draft persistence** — persist the unsent draft per session
      in localStorage so a phone reload / tab eviction doesn't lose a half-typed prompt.
      (Per-client state, so no protocol change.)
- [ ] **Offline prompt queue** — if you hit send while the WS is reconnecting, queue the
      prompt locally and flush it on reconnect rather than dropping it or erroring.
- [ ] **Voice dictation on mobile** — Web Speech API mic button in the composer; talking
      a prompt into your phone beats thumb-typing a paragraph.
- [ ] **Optimistic user-message echo** — render the user's message immediately on send
      with a subtle "sending…" state, reconciling when the server echoes it back, so the
      composer feels instant over a high-latency Tailscale hop.

### Transcript reading
- [ ] **In-transcript search (⌘F)** — find-as-you-type across the rendered transcript
      with match highlighting + next/prev, distinct from the sidebar session search.
- [ ] **Collapse-all / expand-all tool calls** — one toggle to fold every tool card in a
      long transcript down to titles, for skimming a finished session.
- [ ] **Per-code-block copy + language label** — copy button and a language tag on each
      fenced code block (finer-grained than the whole-message copy already shipped); plus
      a soft-wrap toggle for wide code.
- [ ] **"New since you left" divider** — a horizontal marker in the transcript at the
      first message that arrived while the session was unfocused/backgrounded, so you can
      jump straight to what's new (complements the unread status work).
- [ ] **Inline image rendering** — if the agent emits a markdown image or a screenshot
      path, render it inline rather than as a raw link (handy for the preview-screenshot
      verification loop pi itself can drive).
- [ ] **Merge sequential read calls visually** — consecutive `read` tool calls to the
      same file (with contiguous or overlapping line ranges) should be collapsed into a
      single card showing the combined content range. Frontend-only; protocol/server
      unchanged.

### Sessions & navigation
- [ ] **Command palette (⌘K)** — fuzzy switcher over sessions + actions (new session,
      switch model, toggle theme, open settings). The single highest-leverage nav primitive
      for a many-session sidebar.
- [ ] **Pinned / favorite sessions** — pin the 2–3 you're actively driving to the top of
      the sidebar, above the project groups.
- [ ] **Session emoji / color label** — optional per-session glyph or accent color for
      fast visual ID in the list (stored via `appendCustomEntry`, like the archive flag).
- [ ] **Session metadata header** — a compact header on the active session showing model,
      cwd, git branch, message count, started-at — the "where am I" strip.
- [ ] **Git branch indicator per session** — read the cwd's current branch and show it in
      the row/header; pairs naturally with the worktree-checkbox item.
- [ ] **"Open in editor" deep link** — a button that opens the session's cwd in
      VS Code / Cursor via `vscode://file/…` / `cursor://…` (or copies the path), for the
      moment you want to drop from phone-driving into the desktop editor.
- [ ] **Keyboard shortcut cheat-sheet (`?`)** — an overlay listing every hotkey;
      the natural companion to the hotkey-audit item and a forcing function to keep it
      current.

### Mobile / PWA
- [ ] **Swipe gestures** — edge-swipe to open/close the sidebar drawer; optionally
      swipe-between-sessions. Native-feeling on the phone PWA.
- [ ] **Pull-to-refresh → force reconnect + snapshot** — the universal mobile gesture for
      "I think this is stale," wired to drop and re-establish the WS.
- [ ] **Haptic feedback** — `navigator.vibrate` on approval-needed and turn-complete so a
      pocketed phone signals without a sound.
- [ ] **App-icon unread badge** — Badging API (`navigator.setAppBadge`) to show an unread
      / approval-pending count on the installed PWA icon.
- [ ] **Connection-status banner** — a quiet indicator for connected / reconnecting /
      offline, with a manual reconnect button, so a dead WS isn't silent.

### Notifications
- [ ] **Actionable push notifications** — Approve / Deny buttons directly on the Web Push
      notification for a pending approval (Notification `actions`), handled in the SW so
      you can unblock the agent from the lock screen without opening the app.
- [ ] **Per-session notification mute** — silence a chatty session while keeping others
      live; a toggle in the session header.
- [ ] **Distinct alert patterns** — different vibration/sound for approval-needed (urgent,
      blocking the agent) vs turn-complete (informational).
- [ ] **Quiet hours / DND schedule** — suppress non-blocking notifications on a time
      window; still allow approval-needed through (configurable).

### Observability & debug
- [ ] **In-UI raw event drawer** — a dev-only side drawer streaming the raw
      `SessionDriverEvent`s for the focused session (the `/?dev` bar's natural sibling),
      so you can debug fold behavior without curling `/debug/state`.
- [ ] **Theme: follow system + explicit toggle** — an "auto" option that tracks
      `prefers-color-scheme` in addition to the manual light/dark choice.
- [ ] **Font-size / density control** — a reading-comfort setting (compact ↔ comfortable
      line height + base size), persisted per client.

---

## 🎒 Paseo-inspired (patterns to steal from [paseo.sh](https://paseo.sh))

_Added 2026-06-18 after a deep comparison of both codebases; triaged the same day.
Paseo is a multi-provider agent orchestration layer (daemon spawns agent CLIs as
subprocesses, Expo mobile app, Electron desktop, Docker-style CLI). Pilot's
differentiator is deep in-process pi SDK integration — things paseo structurally
can't do because it talks to pi via `--mode rpc` over stdio. The survivors below are
patterns pilot can adopt without changing its lane. Cut in triage: items pilot
already ships a different way (it has a `/health` endpoint, in-band WS-`hello` auth
instead of a header/subprotocol token, and settings-panel key reload), and items that
contradict a settled decision (Tailscale transport, pi-only, pi-owned session IDs —
see DECISIONS D15/D16). Items marked 🚫-PASEO below are things paseo already ships
that pilot should NOT build — they're paseo's domain, not pilot's differentiator._

### Worth adopting

- [ ] **Follow-on UI primitives — Toggle · Chip · Menu/Dropdown · Disclosure**
      _(surfaced by the 2026-06-18 design-system pass; full catalog +
      visual-session notes in `docs/design-system-pass.md`)_.
      The three interactive primitives (`Button`, `IconButton`, `SegmentedControl`) shipped
      and the standard chrome migrated to them (Sidebar, Composer, Settings, StatusHeader,
      App, TokenGate, NewSession — see DONE). What's left are four recurring patterns that
      didn't fit the three, each used 3+ times, so each is a real future primitive — promote
      only once it recurs cleanly, don't pre-build:
      (1) **single labeled toggle** — a 2-state pill (Sidebar `.filter-toggle`, `aria-pressed`;
      the Settings hide-thinking switch, `role="switch"`/`aria-checked` — a future primitive
      would reconcile the two ARIA patterns). Not IconButton (labeled), not SegmentedControl (single).
      (2) **chip** — small labeled pill (Composer project / worktree chips).
      (3) **menu / dropdown family** — highest-leverage: trigger + menu items + backdrop
      (ModelPicker is entirely this; Sidebar's row menu is the same shape).
      (4) **disclosure row** — accordion header with chevron (ToolCard / ThinkingBlock heads).
      Special-identity buttons stay one-off (send circle, Stop pill, status bell, copy,
      `.naction`, `.new-pill`, drag-handle, update-toast Refresh).
- [ ] **Shared layout primitives (session row, section header)** — fast-follow to the
      Button/IconButton/SegmentedControl pass above. The other 3+-use *structural* patterns
      (sidebar session row, section headers) pulled into components. Split out deliberately:
      it's a different kind of extraction (layout, not interactive primitives) — don't bundle.
- [ ] **Big-snapshot pagination + tool-update frame coalescing** — extends the
      existing "raise/chunk 64KB WS frame cap for snapshots" SHOULD in DESIGN. For a
      long session reconnecting over a flaky phone link, a paged/chunked catch-up beats
      one huge snapshot frame; paseo's `AgentStreamCoalescer` (merge rapid tool-call
      updates into fewer WS frames) is the other half. Skip paseo's full
      sequence-dedup'd paged-timeline machinery — overkill for a single user.

### 🚫 Out of scope (paseo does these already — not pilot's lane)

_These are features paseo ships that pilot should not build. They'd pull pilot
toward "generic agent platform" rather than "deepest pi remote UI." If you need
them, use paseo — or use paseo alongside pilot._

- **Terminal with PTY streaming** — Paseo's pipeline: `node-pty → headless xterm
  (worker) → coalescer → binary WS frames`. Highly optimized, battle-tested. Don't
  rebuild this in pilot; pi sessions on the Mac Mini can be explored via SSH or a
  separate terminal app.
- **Voice mode (STT + TTS)** — Paseo ships local Sherpa-ONNX models for dictation
  + real-time voice. Web Speech API dictation in the composer (which is in the
  brainstorm) is the minimal viable alternative — don't build a full voice pipeline.
- **Docker-style CLI (`paseo run/ls/attach/send`)** — Pilot's interface is the web
  UI. A CLI is useful for scripting but adds a whole new surface to maintain.
  Paseo's CLI already works with pi via `paseo run --provider pi ...`.
- **MCP server for agent-to-agent orchestration** — Paseo exposes `create_agent`,
  `send_agent_prompt`, schedules, worktrees via MCP. This is the orchestration
  layer pilot deliberately isn't building. If agents need to spawn other agents,
  use paseo's MCP server or pi's native sub-agent support.
- **Scheduled agents (cron)** — Paseo's `ScheduleTarget` discriminated union
  (send-to-existing vs create-new) with cron expressions. Useful but out of
  scope for pilot's "drive pi from your phone" mission.
- **Loop service (Ralph loops)** — Paseo's iterative agent loops with verifier
  agents. Powerful but paseo-specific. Pilot doesn't need this.
- **Service proxy** — Paseo reverse-proxies workspace scripts at
  `script--branch--project.localhost`. Neat, but pilot doesn't run workspace
  services.
- **File explorer + diff UI** — Paseo has a full right-sidebar with file tree,
  git diff, GitHub PR panel. Pilot's `@pierre/diffs` inline diff cards are the
  right scope — don't build a full file explorer or git management UI.
- **Chat rooms for agent-to-agent messaging** — Paseo has a chat system where
  agents can `@mention` each other. Not pilot's domain.
- **Multi-provider support** — Paseo supports 5+ agent CLIs under a unified
  abstraction. Pilot is pi-only by design; the deep SDK integration is the
  value proposition. Adding other providers would dilute this.
