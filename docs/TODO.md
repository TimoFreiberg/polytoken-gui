# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
Completed items are archived to [`DONE.md`](DONE.md).
See `docs/` siblings for context: `DESIGN.md` (architecture + roadmap), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

- [x] **Missing stop-turn interface when a session is running** → done 2026-06-19. Root
      cause: the stop pill + working indicator derived solely from the folded
      `session.status === "running"`, which only changes on snapshot events. An out-of-band
      re-snapshot mid-turn (rename / model change / pi auto-title via `session_info_changed`,
      taken when pi's `isStreaming` momentarily reads false during a tool gap) flips the
      folded status to `idle` AND clears the hub's running set, even though the run continues
      — and on reconnect that corrupted status rides the snapshot. Fix: a robust
      `store.turnActive` that ORs four independent in-flight signals a single glitch can't all
      clear at once — folded `running`, the server-authoritative running set, an open
      streaming assistant bubble, and any still-running tool (a `failed` run is terminal).
      The stop pill, working indicator, and composer steer/queue mode now use it. Regression
      fixture `staleidle` + `e2e/stop-turn.e2e.ts` reproduce the stray-idle case. (Also made
      the mock's `abort()` settle in-flight tools, mirroring pi's `tool_execution_end`.)

## 🟡 Important

- [x] ~~**Stop default-new-session-in-server-cwd for production usage**~~ → done
      2026-06-19. The server's cwd no longer feeds any logic: it's not a trust anchor
      (no dir is implicitly trusted — every cwd goes through pi's built-in trust:
      trust.json → interactive card → deny-safe), not the boot session (the server boots
      to an empty landing; the client opens a new-session draft at $HOME), and not the
      new-session default (`newSession()` with no cwd defaults to $HOME). `PILOT_CWD` is
      gone. **Remaining fast-follow:** restore the last-focused session on launch (today
      the landing is always the $HOME draft) — separate item below.
- [ ] **Per-client UI state persistence** — store the active session, sidebar visibility,
      theme, and other UI state per-client (e.g. localStorage) so that a mobile PWA reload
      doesn't reset to the default session. The user should land exactly where they left off.
- [ ] **Per-session prompt draft persistence (pilot-level, not pi state)** — save the
      unsent prompt text per session in client-side state (localStorage) so switching
      between sessions preserves whatever you were typing. Key behaviors: (a) starting a
      prompt in the new-session view, switching to a running session, and coming back
      restores the draft text. (b) switching away from a running session and back restores
      its draft. (c) as durable as possible — prefer storing up to one pending new-session
      draft per project rather than losing paragraphs on a reload. Pure client state, no
      protocol change needed (supersedes the brainstorm item).
- [ ] **Agent turn cancelled when client disconnects?** — observed behavior on the Mac Mini:
      firing off a prompt, then fully exiting the phone view (closing the PWA / navigating
      away), the existing turn appeared to be cancelled before completing. This must NOT
      happen: the server-side agent turn should finish regardless of whether any client is
      connected. **Hedging:** this could be a different pi bug or model API issue, not pilot.
      Needs investigation — reproduce deliberately (send prompt → close client → check if
      the turn completes server-side) to either confirm a pilot bug or rule it out. If
      pilot is the cause, the likeliest path is the WS disconnect handler cancelling the
      in-flight turn.
- [ ] **Pi `answer` tool doesn't work via pilot** — the pi answer tool (which prompts the
      user with questions while an agent is running) appears broken when driven through
      pilot. Investigate why and fix if possible. This is critical for any agent flow that
      needs to ask the human mid-turn (e.g. approval, clarification, choices). May involve
      the web-socket bridge not forwarding the `answer`-style interaction, or the
      `PilotDriver` not translating it to a client-facing event.
- [x] ~~**Desktop app (macOS .app), local-first**~~ → done 2026-06-19, archived to
      `docs/DONE.md`. Swift/AppKit + `WKWebView` shell that runs a local pilot server from a
      dedicated clone and supervises it; auto-updater ships with it (unattended-apply /
      deferred + in-app update card). See `desktop/README.md`. (The `launchCwd`/trust
      blocker flagged here when this item was open is **now resolved** — see the sibling
      item above, done the same day.)

## 🟢 Polish / fast-follow

- [x] **Workspace icon instead of text label in sidebar** — replace the "WORKSPACE: …" label on
      session rows with a compact icon (no text), matching the Claude app's visual density.
- [x] **Sort projects alphabetically in sidebar** — projects grouped by name A→Z;
      sessions within each project stay sorted by last-used (most recent on top).
- [x] **Remove hover tooltip on session titles in the sidebar** — intentional: it's visually
      noisy and doesn't add information beyond what's already visible in the title itself.
- [x] **Thinking-blocks refinement: default to hidden, full invisibility, thinking spinner** →
      done 2026-06-19. (1) `initialHideThinking()` now defaults to hiding (a stored pref still
      wins). (2) Transcript gates the `ThinkingBlock` render on `!hideThinking`, so hidden
      thinking renders nothing at all — no stub; removed the now-dead `minimal` placeholder
      mode from `ThinkingBlock`. (3) The bottom `WorkingIndicator` (animated π/dot, already in
      the activity area) now reads "Thinking…" while the turn is in its thinking phase (open
      assistant accumulating reasoning, no answer text yet), "Working…" otherwise.
- [x] **Timestamp only on last paragraph of an agent turn** → done 2026-06-19. Transcript
      derives `turnText` (a per-turn map keyed by the turn-final text-bearing assistant id);
      only that paragraph renders the timestamp footer. Interleaved mid-turn paragraphs are
      bare. (Shares the footer with the copy button below.)
- [x] **Copy button only at end of agent turn, copies all text** → done 2026-06-19. The copy
      button now renders only on the turn-final paragraph (same `turnText` gate as the
      timestamp), and copies the WHOLE turn's assistant text — every paragraph joined,
      excluding tool + thinking blocks. Covered by `e2e/polish.e2e.ts`.
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
- [x] **Group workspace-spawned sessions under their parent** → done 2026-06-19,
      resolved as "group pilot-created worktree sessions under their parent PROJECT"
      (owner-scoped down from "parent session"). Ship `base` on
      `SessionListEntry.worktree` and re-key the sidebar grouping by
      `worktree.base ?? cwd`, so worktree sessions interleave by recency under their
      parent repo instead of forming their own worktree-basename group. Hand-made
      workspaces (no `worktree` field) keep their own group, by design. The visual
      indent/nesting variant was dropped — the existing per-row worktree badge is the
      sole distinguisher. _(Not done: parent-session linkage — worktrees fork from a
      repo, not a session, and pilot doesn't record a spawning session; parked.)_
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
- [ ] **Per-session prompt draft persistence** _(superseded — promoted to 🟡 Important with
      owner's detailed requirements, see above)_.
      Persist the unsent draft per session in localStorage so a phone reload / tab eviction
      doesn't lose a half-typed prompt. (Per-client state, so no protocol change.)
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
