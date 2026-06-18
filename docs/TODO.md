# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
Completed items are archived to [`DONE.md`](DONE.md).
See `docs/` siblings for context: `DESIGN.md` (architecture + roadmap), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

_(clear — nothing blocking; pull the next item up from Important)_

## 🟡 Important

- [ ] desktop app packaging. i know nothing about running a web app like a desktop app, so proposals welcome. i'd like to have a .app in macos that i can click in my dock. so far only macos necessary

## 🟢 Polish / fast-follow

- [ ] **Active session unread when new text lands below the viewport** — builds on
      the status indicators. Today the active (focused) session is always
      "read". Refine: if the agent appends content while you're scrolled up (content
      exists below the visible transcript), mark the active session unread too;
      clear it when you scroll to the bottom. Needs the transcript scroll container
      to report "not at bottom + grew" back to the store (the classic "new messages ↓"
      pill signal), and an exception to the active-session-is-read rule in
      `store.svelte.ts`'s `sessionStatus`/`markRead` paths. Low priority.
- [ ] **Session context indicator** — a small color-coded circle (or similar badge)
      in the session list / header showing how much context the session has consumed,
      analogous to the Claude app's colored circle (green → yellow → red as the
      context window fills). Color could map to token-budget thresholds from the
      snapshot's `config`/usage fields; exact threshold values TBD
- [ ] **(discussion needed) Auto session titling via cheapest model** — run a
      lightweight model on session start to generate a title from the first user
      prompt, instead of showing "New Session" indefinitely
- [ ] **Realistic mock tool-event timestamps** — the mock's `ts()` is a sequential
      counter, so any duration derived from `toolStarted`→`toolFinished` timestamps
      renders as a meaningless ~1ms in the dev/preview UI. Stamp tool fixtures with a
      realistic ms gap (without breaking fold determinism) so the brainstorm
      "tool-call duration badges" item can ship and be screenshot-verified.
- [ ] **`/tree` command (native pi command)** — pi's builtin `/tree` command shows
      the directory tree. Currently TUI builtins are intentionally omitted from the
      client command list. `/tree` should be passed through so typing `/tree` in the
      composer sends it as a prompt for pi to execute, even if pilot doesn't render
      the tree natively.
- [ ] **Provider OAuth login** — sign-in / sign-out for OAuth-capable providers
      (Anthropic, OpenAI, …) from the Settings panel. Deferred from the settings-panel
      work (API-key entry shipped); needs a server-side OAuth callback reachable over
      Tailscale, which is the bulk of the cost.
- [ ] **Extensions enable/disable view** + compatibility-issue surfacing
- [ ] **Session rename / archive / unarchive** — from the sidebar (the create/open
      half landed; this is the remaining SHOULD from DESIGN's "Sessions & history")

## 🔵 Later

- [ ] **gondolin egress containment** (D10) — for the autonomous Mac Mini
      user account; preserves TS-embed via pi-gondolin extension
- [ ] **Session tree / fork / clone / compaction**
- [ ] **Scheduled / recurring runs**
- [ ] **Image / file attachments** (browser file input)
- [ ] **Inline tool-diff rendering**
- [ ] **Workspace git changed-files/diff/stage panel**
- [ ] **Skills enable/disable view**

- [ ] **Right-side session minimap** (nebulous, OP8)
- [ ] **Queued-messages editing** (replace queued)

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
- [ ] **Tool-call duration badges** — show elapsed time on each tool card
      (`toolStarted`→`toolFinished`); makes slow tools (test runs, big greps) legible
      at a glance.
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

_Added 2026-06-18 after a deep comparison of both codebases. Paseo is a multi-provider
agent orchestration layer (daemon spawns agent CLIs as subprocesses, Expo mobile app,
Electron desktop, Docker-style CLI). Pilot's differentiator is deep in-process pi SDK
integration — things paseo structurally can't do because it talks to pi via
`--mode rpc` over stdio. These items are patterns paseo does well that pilot can adopt
without changing its lane. Items marked 🚫-PASEO are things paseo already ships that
pilot should NOT build — they're paseo's domain, not pilot's differentiator._

### ⚡ High payoff, low effort

- [ ] **Capability flags for feature gating** — Paseo's `AgentClient` carries a
      `capabilities` flags object (`supportsStreaming`, `supportsSessionPersistence`,
      `supportsDynamicModes`, etc.). UI gates features on `capabilities.supportsX`,
      not `provider === "pi"`. Even for a single-provider tool, this makes the UI
      self-documenting about what depends on what, and keeps the mock/real driver
      split clean. Add a `Capabilities` flags type to `PilotDriver` + `ServerMessage.hello`,
      gate UI features on slices of it rather than scattered conditionals.
- [ ] **Design system: "3+ uses → primitive" rule** — Paseo enforces that any
      semantic element used in three or more places must be a primitive in
      `components/ui/`. A `<Pressable>` styled as a button is wrong — the only
      button is `<Button>`. A bare `<Text>` styled as a section header is wrong.
      Pilot's Svelte components would benefit from the same rigor: audit common
      patterns, pull them into shared primitives, stop re-implementing the same
      row/button/header across components.
- [ ] **Button variants with single jobs** — Paseo has exactly 5 button variants,
      each with one job: `default` (one CTA per surface), `secondary` (paired
      equal-weight), `outline` (row-level action), `ghost` (chrome/structural),
      `destructive` (confirm dialog only). Adopt the same variant discipline in
      pilot's button classes — right now buttons don't have a clear variant taxonomy.
- [ ] **Hierarchy via weight/color, not font-size** — Paseo keeps most text at
      `fontSize.base`. Distinction between primary and secondary lines is
      `foreground` vs `foregroundMuted`. Weight tiers: screen titles (light),
      structural labels (medium), content (normal). Pilot uses varying font sizes
      for hierarchy; switch to the weight+color approach for a calmer visual rhythm.
- [ ] **Directory-backed vs workspace-owned state boundary** — Paseo splits
      right-sidebar state cleanly: git status/diff keyed by `(serverId, cwd)` so
      same-directory workspaces share it; tabs/agents/drafts keyed by opaque
      `workspaceId` so they don't leak. Pilot's current flat "sessions grouped by
      cwd" doesn't have this distinction. Formalize what state is directory-scoped
      vs session-scoped, and enforce it through the key shape in the protocol +
      client stores.
- [ ] **Agent lifecycle as explicit state machine** — Paseo's `ManagedAgent` is a
      discriminated union: `initializing → idle ⇄ running → error → closed`. The
      `initializing` state (session being created, not ready) lets the UI show a
      spinner. Pilot's mock fixture currently has no `initializing` phase. Add it
      so the UI handles "session created but not yet streaming" gracefully.
- [ ] **Opaque session/workspace IDs — never parse into paths** — Paseo's
      `workspaceId` is opaque (`wks_<hex>`). Code reads `cwd` for the filesystem
      path. Pilot's session IDs are pi's session file paths by convention — adopt
      a stable opaque ID for pilot sessions, keep the path as a separate field, and
      never parse the ID.

### ⚡ High payoff, medium effort

- [ ] **E2E encrypted relay with QR pairing** — Paseo's relay is zero-knowledge:
      daemon holds a persistent Curve25519 keypair, phone generates ephemeral one
      per connection, ECDH + XSalsa20-Poly1305 (NaCl `box`). The QR code embeds
      the daemon's public key in a URL fragment (never sent to the relay server).
      Pilot currently depends on Tailscale for network ACL + an app-level auth
      token. A relay option would make mobile connectivity zero-config and remove
      the Tailscale dependency for external access. Paseo's `@getpaseo/relay`
      package is AGPL-3.0 and could be reused or studied as a reference.
- [ ] **Timeline sync: live stream + authoritative paged fetch** — Paseo's event
      delivery has two paths: `agent_stream` (live, for immediacy) and
      `fetch_agent_timeline` (authoritative, paged to completion). The invariant:
      every connected client eventually displays every committed timeline row.
      Pilot's snapshot-on-reconnect works but doesn't handle the case where a
      client was disconnected during a long run and the full snapshot is huge.
      Paged catch-up with sequence-based dedup would be more robust over flaky
      mobile connections. Also worth stealing: the `AgentStreamCoalescer` pattern
      for reducing WS frame churn during rapid tool-call updates.
- [ ] **Password auth for direct-TCP exposure** — Paseo supports optional bcrypt
      password auth: `Authorization: Bearer <token>` on HTTP, and the token rides
      in the `Sec-WebSocket-Protocol` subprotocol for browser WS (browsers can't
      set custom headers on upgrade). Health + CORS preflight are exempt. Pilot
      has no auth besides network ACL — add password auth as a defense-in-depth
      layer for direct exposure even within the tailnet.
- [ ] **PID lock file + daemon identity** — Paseo writes `paseo.pid` / `server-id`
      to prevent two daemons sharing one `$PASEO_HOME`. Pilot currently has no
      PID lock — two server processes would fight over the same archive store +
      VAPID keypair. Add a PID lock file + a stable server ID per data dir.
- [ ] **Config hot-reload** — Paseo watches `config.json` for changes and applies
      them at runtime. Pilot reads config once at startup. Hot-reload would make
      "add API key in Settings" feel instant rather than requiring a restart
      (or the current workaround of driver re-initialization).

### 📐 Medium payoff, medium effort

- [ ] **Workspace model: projects + workspaces + worktrees** — Paseo's abstraction
      layers: Project (logical group, keyed by git remote) → Workspace (one `cwd`,
      git state, kind = `directory|local_checkout|worktree`) → Isolation (create-time
      choice: reuse vs new git worktree). Pilot's "sessions grouped by directory"
      is a simpler version of this. Consider formalizing the project/workspace
      concepts so multi-repo workflows and worktree-based isolation are first-class
      in the UI rather than ad-hoc path conventions.
- [ ] **Subagent track UI pattern** — Paseo has a collapsible lane above the composer
      showing running child agents with live status. Closing a tab on a subagent is
      layout-only (stays in the track); closing a root's tab archives it. If pilot
      adds multi-agent orchestration (pi sub-agents), the track pattern is better
      than burying children in a sidebar.
- [ ] **Daemon as infrastructure: log rotation, startup health** — Paseo's daemon
      writes `daemon.log` with pino + rotation, and has a `/api/health` endpoint.
      Pilot has no structured logging or health endpoint. Add both for
      production-readiness.

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
