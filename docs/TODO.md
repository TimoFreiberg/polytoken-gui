# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
See `docs/` siblings for context: `STATUS.md` (what's built), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

_(clear — nothing blocking; pull the next item up from Important)_

## 🟡 Important

_(clear — pull the next item up from Polish)_

- [ ] desktop app packaging. i know nothing about running a web app like a desktop app, so proposals welcome. i'd like to have a .app in macos that i can click in my dock. so far only macos necessary

## 🟢 Polish / fast-follow

- [x] **Suppress notifications when app focused** — if feasible, silence push/toast
      notifications while the browser tab/window has focus
      _(done: client toast now gates on `document.hasFocus()`, not visibility — fires
      whenever pilot isn't the focused window. Committed in worktree, not yet merged.)_
- [x] **Project sidebar hierarchy polish** — larger expand/collapse arrows for
      project groups; indent sessions under their project header to make the
      parent-child relationship visually obvious
      _(done: bigger carets, indented rows, indicator gutter — shipped with the
      status indicators below.)_
- [x] **Session status indicators** — icons/dots to the left of session titles
      distinguishing running (active turn), unread (new messages since last viewed),
      and read (idle). Unread/read is GUI-only state; can be in-memory only with
      old sessions defaulting to read on restore
      _(done: new `sessionStatus` server msg broadcasts the per-session running set
      across ALL sessions — the hub only streams the focused one, so this is what
      makes a background row's running/done legible; pi driver unchanged. Client
      tracks `runningIds` + in-memory `unread` (running→done on a non-focused session
      marks it unread, viewing clears it; active session treated as read). Three CSS
      states: pulsing dots / amber filled dot / hollow ring, with reduced-motion
      fallback + a collapsed-group running dot. `bgrun` dev script + hub unit tests +
      `e2e/status-indicators.spec.ts`.)_
- [ ] **Active session unread when new text lands below the viewport** — builds on
      the status indicators above. Today the active (focused) session is always
      "read". Refine: if the agent appends content while you're scrolled up (content
      exists below the visible transcript), mark the active session unread too;
      clear it when you scroll to the bottom. Needs the transcript scroll container
      to report "not at bottom + grew" back to the store (the classic "new messages ↓"
      pill signal), and an exception to the active-session-is-read rule in
      `store.svelte.ts`'s `sessionStatus`/`markRead` paths. Low priority.
- [x] **Session archive + staleness filter** — store an archived flag, hide archived
      OR stale (>7d) sessions behind an active-only/all toggle, with an archive action
      in the sidebar.
      _(done: chose the index over `appendCustomEntry` after reading pi —
      `SessionManager.listAll()` parses messages + the session name and DROPS custom
      entries, so a JSONL-stored flag would be write-only and force a per-session scan
      on every list, on top of the full read listAll already does. Instead an
      `ArchiveStore` (pilot's source of truth, option B) keeps a path-keyed set in
      `archived.json`, read at list time as an in-memory lookup — zero extra file reads.
      `archived` rides `SessionListEntry` (cleaner than exposing raw `getEntries()` over
      the wire — same intent, keeps `protocol/` pi-free); `setArchived` is a new
      `PilotDriver` method + wire message, hub re-broadcasts the list on change. Client:
      pure `filterSessions` helper (group + search + active-only hide), `showArchived`
      toggle persisted per-device (default active-only), staleness is client-side
      `Date.now() - updatedAt > 7d` (NaN-safe). Archive/unarchive via a per-row ⋯
      overflow menu (hover-reveal on desktop, always shown on touch; outside-click/Esc
      dismiss). A project group drops out once all its sessions are hidden — note: I
      did NOT keep an empty group-header for an all-archived-but-recently-touched
      project (the TODO's "+ newest >1 week" nuance); an empty header reads worse than
      just hiding it. Easy to revisit. Covered: `archive-store.test.ts`,
      `session-filter.test.ts`, a hub routing test, `e2e/archive.e2e.ts`; full unit +
      e2e suites green. The pi-driver path is typechecked, exercised via the mock, not
      yet run live.
      Drive-by: flipped `config.dataDir`'s default from `.pilot-data/` (repo root) to
      the XDG state dir (`$XDG_STATE_HOME/pilot` || `~/.local/state/pilot`) so all
      server state — VAPID, push subs, archive index — sits in one XDG-correct place.
      ⚠️ relocates the VAPID keypair: on first boot at the new path pilot regenerates
      it, invalidating existing phone push subscriptions unless you `mv` the old
      `.pilot-data/{vapid,push-subscriptions}.json` into `~/.local/state/pilot/` first.)_
- [x] **Session search bar** — filter-as-you-type search over session display name,
      preview, and path in the sidebar
      _(done: sidebar search filters groups by name/preview/cwd, hides empty groups;
      `sessions.spec.ts` covers name + path matches.)_
- [x] **Session list scroll cap** — for projects with many sessions, make the list
      internally scrollable with a visible limit of ~10, scroll within the project
      group
      _(done: per-group `<ul>` `max-height: 21rem` (~10 rows) + `overflow-y: auto`.)_
- [x] **Tool call results popup: drop description, add hover tooltip** — the tool
      description doesn't need to be listed inline in the popup; move it to a
      mouseover tooltip on the tool name instead
      _(done: inline `.desc` removed, `item.description` now a `title=` tooltip on
      the tool name.)_
- [x] **Edit tool output: collapsed diff counts + expanded diff view** — instead of
      "Successfully replaced N block(s) in /path", show a collapsed view with
      `+N, -M` line counts, expandable to a nice side-by-side or unified diff.
      Use `bun i @pierre/diffs` for the diff rendering
      _(done: `@pierre/diffs/ssr` `preloadDiffHTML` renders a syntax-highlighted diff
      to an HTML string — no React (peer-only) — mounted in a shadow root (its CSS is
      `:host`-scoped), lazy `import()`ed so shiki stays out of the initial bundle, and
      re-rendered on light/dark toggle. Collapsed `+N/−M` from a dependency-free line
      diff. Detects pi's edit shape `{path, edits:[{oldText,newText}]}` + legacy.)_
- [x] **Desktop notifications conflict with terminal pi extension** — on desktop
      browser, pilot's notification triggers the user's terminal pi notification
      extension (which links back to the terminal). Needs investigation: either
      suppress Web Notifications when pilot is the focused browser tab, or find a
      way to avoid double-firing through the extension.
      _(investigated: the terminal notifier is pi's example extension
      `examples/extensions/notify.ts` — it writes an OSC 777/99 escape on `agent_end`;
      pi core emits no OS notifications. The double-fire is one logical event driving
      two independent notifiers (terminal OSC + pilot Web Push). Pilot's actionable
      fix shipped: `notifyIfUnfocused` (tab-open) + the sw.js push handler now skips
      the OS notification when a pilot window is focused. Cross-process dedup with the
      terminal extension is out of pilot's control — run one notifier per machine.)_
- [x] **Message timestamps** — small relative timestamp at the bottom of each
      agent and user text box (e.g. "5m ago"), with mouseover revealing the exact
      timestamp
      _(done: `ts` added to user/assistant items in `foldEvent` from the event
      timestamp; `<time>` with a relative label + exact-time `title`, refreshed on a
      30s tick.)_
- [x] **Copy-to-clipboard button on agent messages** — a button at the bottom of
      each agent text area; hidden until hover, copies message content
      _(done: hover-revealed Copy button, `navigator.clipboard.writeText`, "Copied"
      feedback.)_
- [x] **Worktree checkbox in new-session form** — like the Claude app's "worktree"
      toggle; creates and passes a jj/git worktree path as the session cwd so the
      agent works in an isolated copy, leaving the main tree clean
      _(done: `newSession` carries `worktree` through protocol→hub→both drivers; pi
      creates a jj (git-fallback) worktree via `server/src/pi/worktree.ts` — pure
      planner unit-tested; mock simulates a `-worktree` sibling dir; e2e covers the
      toggle. The pi creation path is typechecked but not yet run live.)_
- [ ] **Session context indicator** — a small color-coded circle (or similar badge)
      in the session list / header showing how much context the session has consumed,
      analogous to the Claude app's colored circle (green → yellow → red as the
      context window fills). Color could map to token-budget thresholds from the
      snapshot's `config`/usage fields; exact threshold values TBD
- [x] **Stray caret span in agent text** — a naked `<span class="caret svelte-1rd1h7a"></span>`
      is appended to the end of agent output, looks like a client rendering bug.
      Needs investigation and fix
      _(done: root cause was `foldEvent` only closing the open assistant on
      `runCompleted`; a turn that goes idle via `sessionUpdated` left `streaming:true`.
      Fixed at the source (close on any non-running snapshot) + a defensive caret guard
      on `store.streaming`. e2e repro via the `idle` fixture.)_
- [x] **Model list search bar** — filter-as-you-type search in the model picker (top bar)
      and the model list in the Settings panel; model lists grow quickly, and the
      current flat menus become unwieldy with many providers connected
      _(done: search input in the header ModelPicker panel + the Settings favorites
      list; both filter by label/id/provider with a no-match state. e2e for each.)_
- [x] **Autofocus after tapping `+` in the sidebar** — when creating a new session,
      focus the cwd input field immediately so you can type a path without an extra
      click. (An `autofocus` attribute exists already but is unreliable with Svelte's
      `{#if}` conditional mount — needs a `tick()` + `input.focus()` approach.)
      _(done: `tick()` + `input.focus()`/`select()` on open; e2e asserts focus.)_
- [x] **PWA update prompt** — when a new service worker is available, show a
      toast/banner asking the user to refresh for the latest version (standard PWA
      lifecycle UX)
      _(done: `lib/sw.ts` flags an update when a new SW reaches "installed" while one
      already controls the page → refresh toast (Refresh/Dismiss); `?dev` "update"
      button + e2e.)_
- [x] **Tab title mirrors session title** — update `document.title` from the ambient
      `title` so the browser tab reflects the session name instead of always showing
      "pilot" (DESIGN.md SHOULD)
      _(done: `$effect` in App.svelte sets `document.title` to "<title> · pilot",
      falls back to "pilot"; e2e in polish.spec.)_
- [x] **Warm-session eviction cap** — `pi-driver.ts` currently keeps every session
      warm forever with no upper bound; add a configurable cap with LRU eviction
      _(done: `PILOT_WARM_CAP` (default 8, ≤0 = unbounded); focus-recency LRU via Map
      re-insertion; pure `evictionPlan` helper unit-tested; evicts via
      `session.dispose()` (also aborts an in-flight run). pi path not yet run live.)_
- [x] **Keyboard shortcut for Settings (⌘+,)** — open the settings panel with the
      standard web app keyboard shortcut
      _(done: ⌘/Ctrl+, toggles the panel; gear tooltip names the hotkey; e2e.)_
- [ ] **(discussion needed) Auto session titling via cheapest model** — run a
      lightweight model on session start to generate a title from the first user
      prompt, instead of showing "New Session" indefinitely
- [x] **Enter/Alt+Enter hint for steer vs follow-up** — add an inline hint near the
      composer or a tooltip explaining that pressing Enter while the agent is running
      steers, and Alt+Enter queues a follow-up message (and implement both hotkeys)
      _(done: Enter steers / Alt+Enter queues a follow-up (reflected in the toggle);
      hint line + hotkey-named tooltips; new `streamhold` fixture holds a running
      state for the e2e.)_
- [x] **Hotkey + tooltip audit for every UI action** — go through every clickable
      element (sidebar toggle, header buttons, stop, send, approval actions, trust
      options, settings controls, model picker items, etc.) and add a keyboard
      shortcut or a `title` tooltip naming the action + its hotkey if one exists
      _(done: every clickable across all components now carries a descriptive `title`
      (icon-only buttons especially); full suite stays green.)_
- [ ] **Realistic mock tool-event timestamps** — the mock's `ts()` is a sequential
      counter, so any duration derived from `toolStarted`→`toolFinished` timestamps
      renders as a meaningless ~1ms in the dev/preview UI. Stamp tool fixtures with a
      realistic ms gap (without breaking fold determinism) so the brainstorm
      "tool-call duration badges" item can ship and be screenshot-verified.

- [x] **Jump-to-last-prompt hotkey** (OP8)
- [x] **Type-to-focus prompt field** — basic typable characters focus the
      text field before typing them (or a dedicated hotkey)
      _(done: window keydown focuses the composer on a printable key when no input is
      focused; doesn't steal from dialog/sidebar inputs.)_
- [x] **Beautiful font rendering** — prose readability pass (OP8)
      _(done: refined system font stack + smoothing/feature-settings; `.prose` rhythm,
      code/pre, link styling tuned. No palette change.)_
- [x] **Tool card inspection polish** — unobtrusive expand/collapse (OP8)
      _(done: chevron rotation transition, hover/focus ring, gentle body reveal,
      `aria-expanded`.)_
- [x] **Stray iOS zoom fix** — composer `font-size: ≥16px` to stop iOS
      auto-zoom; `overflow-x: hidden` on root
      _(done: textarea 16px; `overflow-x: hidden` on `.shell`.)_
- [x] **Live markdown rendering in prompt edit box** — preview formatting
      as you type, if straightforward
      _(done: Edit/Preview toggle renders the draft via `renderMarkdown`; appears only
      with a non-empty draft, Enter-to-send preserved.)_
- [x] **Slash-command autocompletion** + inline help text describing each
      command
      _(done: `CommandInfo` + `commandList`/`listCommands` wire messages mirror the
      model-list path; the pi driver reads `get_commands`' three sources (extension
      commands + prompt templates + skills), the mock serves `MOCK_COMMANDS`. Composer
      shows a typeahead on a leading `/` — filter helper in `lib/slash.ts`, popup in
      `SlashMenu.svelte`, ↑↓/↵/Tab/Esc nav, click-to-insert, each row carries the
      command's description + source. Execution is free: `/name args` is a normal
      prompt and pi's `prompt()` runs the command / expands the template. TUI builtins
      (/model, /settings, …) intentionally omitted — pilot has native UI. Unit test for
      the filter + `e2e/slash.spec.ts`.)_
- [ ] **`/tree` command (native pi command)** — pi's builtin `/tree` command shows
      the directory tree. Currently TUI builtins are intentionally omitted from the
      client command list. `/tree` should be passed through so typing `/tree` in the
      composer sends it as a prompt for pi to execute, even if pilot doesn't render
      the tree natively.
- [x] **PNG / maskable icons** — proper app icons for installed PWA
      _(done: 192/512 + maskable-512 (safe-zone padded) + 180 apple-touch, rasterized
      from `icon.svg`; manifest + `<link apple-touch-icon>` wired.)_
- [x] **Virtualized transcript list** (>80 rows)
      _(done: CSS `content-visibility: auto` + `contain-intrinsic-size` on `.row`
      and `.tool` — browser skips rendering off-screen rows, remembers actual sizes
      after first render. Zero JS, progressive enhancement.)_
- [x] **Binary 2-option select → Yes/No card**
      _(done: affirmative option detected + promoted to the primary/right button
      regardless of array order, mirroring the confirm dialog.)_
- [x] **Countdown for timeout-bearing dialogs**
      _(done: shrinking bar + "Auto-dismiss in Ns" for dialogs with `timeoutMs`,
      deny-safe auto-resolve at zero, timers cleaned per dialog.)_
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
- [x] **Run-failed error card + retry** — `runFailed` currently has no first-class UI.
      Render a distinct error card (message + stack/cause if present) with a "Retry"
      button that re-sends the last prompt, and a "Copy error" affordance.
      _(done: error notices now carry a Retry (re-sends `store.lastPrompt`) + Copy
      button; `store.lastPrompt` tracks the last sent prompt; the `error` fixture is
      wired into the `?dev` bar + mock `runScript`; `streaming.spec.ts` covers it.
      Stack/cause rendering deferred — the driver only surfaces `error.message` today.)_
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

## ✅ Done (for reference)

- [x] **Settings panel** — finished the panel with the server-side pieces (theme,
      token, notifications already shipped): provider/API-key management, global model
      defaults, and a favorites subset. The pi driver now shares one `AuthStorage` +
      `ModelRegistry` across all warm sessions, so a key saved in the panel updates
      every session's model availability after a `refresh()`; a launch-cwd
      `SettingsManager` holds the global defaults/favorites. New `PilotDriver`
      capabilities (`listProviders`, `set/removeProviderApiKey`, `getModelDefaults`,
      `setDefaultModel`/`setDefaultThinking`, `setFavoriteModels`) with mock + pi
      implementations, and new wire messages (`providerList`, `modelDefaults` + client
      commands). Provider list = pi's curated key-capable set + already-connected; no
      secret ever crosses the wire (only auth presence/source); keys write pi's
      `auth.json` (shared with terminal pi). Favorites map to pi's `enabledModels`
      patterns — the GUI writes explicit `provider:modelId` refs; CLI-set globs are
      preserved unless they resolve to an available model (then flattened). The header
      `ModelPicker` filters to favorites, always keeping the active model visible
      ("active · not favorited"). OAuth login deferred (see Polish). Covered:
      model-config unit tests, hub routing/broadcast tests, e2e (key flip, default
      persist, favorites filter); verified visually (dark + mobile).
- [x] **Interactive project-trust card** (D12) — an untrusted cwd now prompts the
      operator to grant/deny instead of silently denying. Trust travels an **out-of-band
      channel** (`trustRequest`/`trustResolved` server msgs + `trustResponse` client msg;
      `subscribeTrust`/`respondTrust` on `PilotDriver`), *not* the session event stream —
      because trust resolves inside `warmUp`'s service creation, before the session/UI
      bridge exist and while the hub suppresses session events mid-swap (`switching`). The
      resolver (`trust.ts`) keeps its non-interactive fast paths (moot / saved / launch-cwd)
      and only escalates an undecided non-launch cwd to the card, blocking the swap on the
      answer (pi awaits `resolveProjectTrust`, exactly as its TUI blocks on `ui.select`). A
      chosen option's trust.json updates persist via `ProjectTrustStore` (CLI-compatible);
      session-only persists nothing; timeout / no client / dismiss denies deny-safe. Five
      pi-parity options; new `TrustCard.svelte`; the hub gained a single-flight switch
      guard (the card can hold a swap on human input for minutes). Mock drives it via the
      `trust` dev button. Covered: trust unit tests, hub relay + single-flight tests, e2e
      (render w/ cwd + 5 options, dismiss-on-click) desktop + mobile. Verified visually
      (dark). Closes the last 🔴.
- [x] **Live pi bring-up** — first real turn against provider credentials.
      `PILOT_DRIVER=pi PILOT_CWD=/some/repo bun run dev`. Working; rough edges
      are filed as separate todos.
- [x] **Session/project sidebar** — replaced the header session dropdown
      (`SessionPicker` deleted) with a collapsible left rail (desktop) / slide-over
      drawer (mobile) that groups sessions by project directory. `listSessions` now
      spans every project (`SessionManager.listAll`), so it's a cross-project
      navigator. New sessions can target an arbitrary typed cwd (`newSession` carries
      `cwd` → `SessionManager.create`; `~`-expanded, resolved, rejects a non-directory
      loudly — the D12 GUI affordance), plus a per-project `+`. Switch errors surface
      in the sidebar. Open/collapse is per-client + localStorage-persisted. e2e-covered
      (`sessions.spec.ts`: grouping/switch, per-project `+`, arbitrary typed dir).
      (rename/archive/unarchive still open — see Polish.)
- [x] **Per-session model + thinking-level picker** — provider-grouped model menu +
      thinking-level menu in the header (`setModel`/`setThinking` over the wire,
      `modelList` broadcast; selection rides each session's snapshot `config`).
      e2e-covered (`models.spec.ts`).
- [x] **Multi-session — keep N warm** (D8 increment 2) — the pi-driver now holds a
      `Map<sessionId, WarmSession>` of fully-independent sessions instead of a
      single `AgentSessionRuntime` that disposed the old session on every switch.
      `openSession`/`newSession` warm-and-focus (create on first touch, dedup by
      session file and refocus after); `prompt`/`abort`/`respondUi` dispatch by
      `sessionId`; each session gets its own services (trust resolver per cwd), UI
      bridge, and subscription, all streaming into one `emit`. Nothing is disposed
      on a switch — a backgrounded session stays warm and is instantly re-focusable
      with full history. Verified live (`scripts/live-warm-toggle.ts`): open A →
      open B (`2 warm`) → re-open A returns A's transcript intact via the refocus
      path, no re-create, no stale-ctx crash. (No eviction cap yet — fast-follow.)
      Live background *streaming* across a focus-switch still awaits provider creds
      (the Live pi bring-up task) since it needs a real model turn.
- [x] **Multi-session hub** (D8 increment 1) — the hub tracks a focused session:
      folds + broadcasts only the focused one, routes `prompt`/`abort`/`respondUi`
      by `sessionId`; background sessions still notify a closed phone. Behavior
      unchanged for a single active session.
- [x] **Project-trust gate MVP** (D12) — non-interactive `resolveProjectTrust`
      (`server/src/pi/trust.ts`) closed a live auto-trust hole (pi auto-trusts
      every project unless the host resolves trust). Honors trust.json
      (parent-aware), trusts the launch cwd, denies other untrusted paths.
      Interactive card still open above.
- [x] **Persistence rework** (D13) — driver resumes via
      `SessionManager.continueRecent(cwd)`, discovers via `list`, switches via
      `runtime.switchSession`, rebuilds state from session files on load
      (`historyToEvents`). Verified live: resume-across-restart + new↔existing
      switching replay the full transcript. (Stale-ctx swap crash fixed en route.)
- [x] iOS Web Push spike (D11) — SW handlers, VAPID keypair + subscription
      store, server fan-out, header bell. Verified buzzing closed iPhone.
      Gotchas banked: `PILOT_VAPID_SUBJECT` must be real https/mailto.
- [x] M0–M5 built + green — mock driver, transcript/turn UI, approvals,
      multi-client, remote infra, real pi driver (typechecked, unit-tested),
      PWA, Playwright suite (19 specs, desktop + mobile)
- [x] Open questions resolved (OQ1–OQ8 → D7–D14) — TS-embed confirmed,
      no tool gating, multiple concurrent sessions, arbitrary paths,
      dark-first styling, etc.
