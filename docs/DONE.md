# Pilot — Done

Archive of completed items from `TODO.md`. Each entry includes the original checkbox
and its resolution note. Latest completions first.

---

- [x] **UX-survey polish batch — approval a11y, iOS zoom, eager reconnect, transcript/composer
  polish** → done 2026-06-20. A multi-dimension survey of the client (each finding verified
  against current code) drove a sweep of high-value quick wins; the remainder is filed under
  TODO's "Jank / polish found in the 2026-06-20 UX survey". Landed in five focused commits:
  - **Approval dialogs are now keyboard- and screen-reader-operable** (`ApprovalLayer.svelte`):
    Esc cancels (deny-safe), ⌘/Ctrl+Enter submits (bare Enter in a single-line input too),
    focus moves into the sheet on open (the input/editor field, else the sheet root — never an
    affirmative button, so a stray Enter can't approve a destructive command), Tab is trapped,
    and the sheet carries `aria-modal` + an `aria-labelledby` accessible name. Previously it had
    none of these — the most-frequent blocking interaction was mouse-only.
  - **Prevent iOS focus-zoom** (`app.css`): a global `@media (pointer: coarse)` rule forces every
    `input`/`textarea`/`select` to 16px (`!important`, to beat Svelte scoped styles). iOS
    auto-zooms on focusing a sub-16px control and offers no way back; nearly every input
    (model-picker / sidebar search, cwd input, settings, …) was 12–13.5px. Prevention over
    restoration — there's no API to read/set visual zoom, and `maximum-scale` would kill
    pinch-zoom (D14). Guarded by a Playwright mobile-project assertion that an input computes ≥16px.
  - **Eager reconnect** (`ws.svelte.ts`): tab-refocus and the window `online` event now reset the
    backoff and reconnect immediately instead of routing through `scheduleReconnect` (up to ~15s)
    — the felt lag on a waking phone / cell↔wifi flap.
  - **Transcript** (`Transcript.svelte`): autoscroll now follows a streaming tool's output
    (`contentSize` counted only assistant deltas before — invisible vs the mock, real vs pi);
    `⌘/Ctrl+↓` jumps to the live bottom (inverse of the existing `⌘↑`), advertised in the pill tooltip.
  - **Quick wins**: focus-visible accent rings on the `Button`/`IconButton` primitives;
    queued-message rows show a hover tooltip + two readable lines (was one clipped line); the
    token gate distinguishes a mid-session expiry ("rejected or expired") from a cold first-run
    prompt (`store.unauthorizedReason`).

  Gate: `tsc` + `svelte-check` clean, 334 unit + 154 e2e green (4 new specs: approval
  aria-modal / Esc-cancel / keyboard-submit, mobile inputs ≥16px), plus a live preview drive of
  the dialogs/queue. Note: the streaming-tool autoscroll fix isn't e2e-covered (the mock doesn't
  stream tool text) — verified by code reasoning.

- [x] **Agent turn cancelled when client disconnects?** — closed 2026-06-19, **not
  reproduced**; kept here as a watch-item for context if the owner sees it again. Original
  report: firing off a prompt on the Mac Mini, then fully exiting the phone view (closing
  the PWA / navigating away), the existing turn appeared to be cancelled before completing.
  The server-side turn must finish regardless of whether any client is connected.
  _(investigated 2026-06-19: both code and a live repro clear pilot. `close(ws)`
  (`server/src/index.ts`) only calls `ws.data.unsub()` → `clients.delete` +
  `syncLiveRefresh` (`server/src/hub.ts`); it never calls `driver.abort()`. Live test
  (real pi, deepseek-v4-flash): sent a multi-step turn, navigated the only active client
  away mid-run, polled `/debug/state` while disconnected — the turn ran to completion
  server-side (all steps + summary), and reconnect restored the full transcript. The only
  abort vector is warm-cap eviction (disposing a session), triggered by warming a new
  session, not by client loss. If it recurs on the Mac Mini with a real phone-PWA close,
  the cause is almost certainly downstream of pilot — pi turn loop, model API, or Tailscale
  drop — not the WS handler.)_

- [x] **Stop default-new-session-in-server-cwd (the `launchCwd` blocker)** — the server's
  own cwd no longer feeds any logic; boot to an empty landing + $HOME new-session draft.
  _(done 2026-06-19: the server cwd carries no operator intent — a Finder-launched
  desktop app starts in `/`, and even `bun run dev` is run from the repo, not the
  project you want to work in — so it must not be a trust anchor, the boot session, or
  the new-session default. `server/src/pi/pi-driver.ts`: removed `launchCwd` entirely;
  `makeTrustResolver(cwd, ask)` drops the `isLaunchCwd` param (no dir is implicitly
  trusted — every cwd goes through pi's built-in trust: trust.json → interactive card
  → deny-safe, D12); `SettingsManager.create(homedir(), agentDir, { projectTrusted:
  false })` makes the global-settings manager cwd-independent (project-scope settings
  file never loaded); the boot `warmUp(continueRecent(launchCwd))` is gone — the server
  boots with `focusedId=null` and no warm session; `newSession()` with no cwd defaults
  to `homedir()`. `PILOT_CWD` is dropped (`PiDriverOptions.cwd`, `index.ts`, all
  docs/scripts). Client: on boot, if no session is active the store auto-opens a
  new-session draft at $HOME (`maybeOpenBootDraft`, fires once per store instance so
  reconnects don't re-open a dismissed draft); $HOME is surfaced via a new
  `defaultNewSessionCwd` field on the `sessionList` protocol message. Stale "launch
  dir" copy fixed in `NewSession`/`Composer`. The mock driver still seeds its greeting
  fixture on boot (so e2e/dev keep their transcript), so the empty-landing path is
  verified by code inspection + a live drive of the store, NOT by e2e — a gap to close
  if the mock should model empty-boot too. Gate: canonical `tsc` clean, `svelte-check`
  clean, 206 unit + 88 e2e pass.)_ Remaining fast-follow: restore the last-focused
  session on launch (today the landing is always the $HOME draft).

- [x] **Desktop app (macOS .app), local-first** — a clickable, dockable Swift/AppKit
  shell that runs pi agents locally by default.
  _(done 2026-06-19: `desktop/` — a thin `WKWebView` wrapper (`Sources/Pilot/*.swift`,
  `build-app.sh`, `Info.plist`) that spawns the pilot server from a **dedicated clone**
  (`PILOT_APP_CLONE`, default `~/pilot-app`) on a free loopback port, gates on `/health`,
  supervises it (respawn on exit → reload the webview so new client assets show), and
  SIGTERMs both server + watcher on quit. Built with `swiftc` directly (no Xcode project);
  ad-hoc signed, so first launch is right-click → Open. Local-first by design: loopback +
  single-user means auth off, no token. Connecting to a remote pilot stays a future
  option.)_
  **Auto-updater ships with it** — `scripts/desktop/update-watcher.ts` polls
  `origin/main` in the clone and keeps it current without stomping live work:
  unattended & idle (no client connected, no turn running) → apply immediately
  (pull → `bun install` if `bun.lock` moved → `bun run build` → SIGTERM the server's
  recorded pid, the supervisor respawns it); otherwise → defer, with a native macOS
  notification **and** an in-app **update card** (sidebar, "update now" button) that
  triggers an explicit apply. The relay is wired through the server: `/health` reports
  `clients` + `busy`, `/update/state` carries the staged sha (token-gated, off locally),
  and an `applyUpdate` WS message lets the card's button request the apply. Pure decision
  logic (`decideAction`/`lockfileChanged`/`isBusyFromHealth`/`shouldNotify`/`parseServerPid`)
  is exported and unit-tested (`scripts/desktop/update-watcher.test.ts`, 21 tests).
  ⚠️ **The `launchCwd`/trust blocker flagged in the original TODO item was resolved
  2026-06-19** (same-day follow-up) — see the dedicated DONE entry below. Still missing:
  code-signing/notarization, app icon, and a release/CI step to publish a built `.app`._

- [x] **Extension compatibility-issue surfacing** — surface when an extension uses a
  terminal-only capability against pilot's non-tui host.
  _(done 2026-06-19: wired the missing emit half — the rendering was already there
  (`state.ts` folds `extensionCompatibilityIssue` → a warning notice). Followed pi-gui's
  reference emit path: `PiUiBridge.custom()` now throws a typed error
  (`server/src/pi/unsupported-host-ui.ts`, vendored from pi-gui) whose message carries a
  serialized `ExtensionCompatibilityIssue`; pi's `ExtensionRunner` catches the throw, tags
  it with extensionPath/event, and routes it to the `bindExtensions({ onError })` listener
  pilot now passes in `pi-driver.ts`. onError parses the typed error → emits the compat
  event (enriched with extensionPath/eventName), and surfaces any OTHER extension error as
  an error notice instead of swallowing it — pilot previously passed no onError, so pi
  dropped all extension errors silently. **Scope (matches the reference):** only `custom()`
  throws; the fire-and-forget TUI setters (`setFooter`/`setHeader`/`setWorking*`) stay
  silent no-ops — throwing from those would crash extensions that fire them without a catch,
  and emitting per-call would spam (some fire per-token). `custom()` is the one capability
  where the extension awaited a result it can't get. Added a `compat` mock fixture +
  dev-bar button for reproducible UI; unit tests (helper round-trip, bridge throw, state
  fold) + an e2e spec in `transcript.e2e.ts`.)_

- [x] **Provider OAuth login** — sign-in / sign-out for OAuth-capable providers (Anthropic
  Claude Pro/Max, OpenAI Codex, GitHub Copilot) from the Settings panel, for subscription
  billing instead of per-token API.
  _(done 2026-06-19: provider-generic, driven off pi's OAuth registry. New global +
  interactive wire channel modeled on the trust flow — `oauthLogin`/`oauthRespond`/
  `oauthLogout` client msgs, `oauthPrompt`/`oauthProgress`/`oauthDeviceCode`/`oauthResolved`/
  `oauthResult` server msgs — not the session-scoped Host UI, since login writes pi's global
  `auth.json`. `PilotDriver.oauthLogin(id, io)` + `oauthLogout(id)`; the pi-driver maps pi's
  `authStorage.login` callbacks (`onAuth`/`onManualCodeInput`/`onPrompt`/`onSelect`/
  `onDeviceCode`) onto the hub IO, so the **remote manual-paste path** works with no
  Tailscale callback (phone opens the authorize URL, pastes the code back; pi exchanges +
  auto-refreshes). `ProviderInfo.oauthSupported` added; `listProviders` now surfaces
  unauthed OAuth providers so a fresh Anthropic row shows a "Sign in" button. Hub is
  single-flight with a 5-min prompt timeout. Settings shows Sign in / Sign out per provider
  + an interactive sign-in modal. Mock driver + fixtures simulate the flow; hub unit tests
  (4) + e2e (sign-in / cancel / sign-out) cover it. ⚠️ ToS gray area noted: pi presents as
  Claude Code (`user:sessions:claude_code` scopes); owner confirmed it works today and the
  feature degrades to other providers if Anthropic tightens up.)_

- [x] **Tooltip survives element re-render under a resting pointer** _(2026-06-19)_
  _(done: the global `Tooltip` vanished whenever its tracked node was replaced by a
  re-render (e.g. tool progress in a warm session) — the removed node fired `mouseout`,
  `end()` hid the tip, and no `mouseover` fired for the replacement, stranding it. `onOut`
  now defers the close one frame and decides by what's actually under the pointer: if the
  node was detached and a same-`title` node still sits there it re-acquires the fresh node
  and keeps the tip up; a genuine pointer-leave still closes, as do Esc/click/scroll/blur.
  Regression test in `tooltip.e2e.ts`.)_

- [x] **Remove composer markdown preview/edit toggle** _(2026-06-19)_
  _(done: dropped the Preview/Edit toggle from the composer — the `preview`/`showPreview`
  state, `toggleEdit`, the `<Markdown>` preview branch + its scoped `.prose`/`.preview` CSS,
  and the `.toggle` button. The composer is textarea-only now; markdown still renders in the
  transcript. Removed the obsolete `polish.e2e.ts` preview test; updated the design-system
  follow-on notes that cited the now-gone `.toggle` Preview/Edit example.)_

- [x] **Hide thinking blocks behind a toggle** _(shipped 2026-06-18)_
  _(done: a "Hide thinking blocks" switch in Settings → Appearance, default off, persisted
  via `store.hideThinking`/`setHideThinking`. When on, `ThinkingBlock` collapses to a subtle,
  non-expandable placeholder ("Thinking…" while streaming, "Thought process" once done)
  instead of rendering the content. `mock-driver` replays were
  serialized so concurrent scripts don't interleave (fixed the flaky thinking-block e2e).)_

- [x] **Workspace icon instead of text label in sidebar** _(shipped 2026-06-18)_
  _(done: session rows show a compact worktree glyph with `aria-label="worktree"` +
  `title="Worktree: <path>"` instead of the "worktree" text label, matching the Claude
  app's density.)_

- [x] **Sort projects alphabetically in sidebar** _(shipped 2026-06-18)_
  _(done: projects grouped A→Z in `session-filter.ts`; sessions within each project stay
  sorted by last-used, most recent on top. Covered by `session-filter.test.ts`.)_

- [x] **Remove hover tooltip on session titles in the sidebar** _(shipped 2026-06-18)_
  _(done: dropped the per-row `title` tooltip on session rows — it was visually noisy and
  added nothing beyond the visible title. Row actions remain reachable via the ⋯ menu.)_

- [x] **Design-system consistency pass — button primitives** _(scoped + reshaped with owner
  2026-06-18; shipped 2026-06-18)_
  _(done: three interactive primitives in `client/src/components/ui/` —
  `IconButton` (icon-only, required `title`, sizes, `danger` variant, `active` toggle, 44px
  coarse-pointer tap target), `SegmentedControl` (generic radiogroup, data-driven options
  with optional `testid`), alongside the pre-existing `Button`. Standard chrome migrated to
  them: Sidebar (collapse/group-add/error-x/row-menu → IconButton, rename → Button), Composer
  (steer/follow-up → SegmentedControl controlled, attach → IconButton), Settings (theme →
  SegmentedControl, all btn/ghost/danger → Button, close → IconButton), StatusHeader
  (hamburger + gear → IconButton), App (update-toast x → IconButton), TokenGate (Connect →
  Button), NewSession (Cancel → Button). Pure refactor — full e2e + svelte-check + 174 unit
  tests + prod build green; a 9-agent adversarial review confirmed behavior preserved, all
  clickables labelled, no dead CSS, 0 real issues. Fixed two latent gaps in passing (Sidebar
  rename buttons were unstyled; Settings close ✕ had no title). What didn't fit the three
  primitives is catalogued as future-primitive candidates in `docs/design-system-pass.md`
  and a follow-on TODO; the layout-primitive fast-follow + type-hierarchy polish stay
  separate. Per-surface commits on a stack above `main`, left for owner review.)_
- [x] **Server PID lock + stable server identity** _(paseo-inspired)_
  _(done: `server/src/pidlock.ts` — lock at `dataDir/pilot.pid`; a LIVE second server
  aborts startup loud (names pid + data dir; guards the archive/push stores + VAPID
  keypair), a STALE lock is reclaimed; stable per-data-dir `server-id`. Pure helpers
  unit-tested (`pidlock.test.ts`), wired before any store opens in `index.ts`, released
  on exit/SIGINT/SIGTERM. Surfaced a workflow conflict — the lock blocked the multi-
  instance dev/preview/e2e setup that shared the default data dir — fixed by keying
  `PILOT_DATA_DIR` off the port in `scripts/dev.ts` so dev instances coexist and the
  lock only guards the production server.)_

- [x] **Structured logging + rotation for the daemon** _(paseo-inspired)_
  _(done: `server/src/log.ts` — dependency-free JSON-lines logger to `dataDir/pilot.log`
  with size-based rotation (rotation policy unit-tested), mirrors readable lines to the
  console, stamps the server-id, fails safe. Wired at `index.ts` startup/error points;
  `/health` left as-is.)_

- [x] **Agent lifecycle `initializing` state** _(paseo-inspired)_
  _(done: `SessionStatus` gains `initializing`; the hub tracks/broadcasts an
  `initializingIds` set in `sessionStatus` (wire field optional for old clients); the
  store exposes it and the sidebar row + header render a warming-up spinner. Mock
  `initializingSession` fixture + `?dev` button + hub test. Reduced-motion fallback.)_

- [x] **Tool-call duration badges** + **realistic mock tool-event timestamps**
  _(done: `ToolItem` gains `startedAt`/`finishedAt` (stamped from `ev.timestamp` in the
  fold); `ToolCard` renders an elapsed badge ("345ms", "1.2s"), hidden when unknown. The
  mock's `ts()` became an ms-clock with a `toolSpan()` helper giving each tool a realistic
  deterministic duration so the badge is legible + screenshot-verifiable.)_

- [x] **Session context indicator (sidebar context rings)**
  _(done: sidebar rows reuse `ContextRing` per session from the entry's `usage`, sharing
  the composer meter's tones; warm sessions show a green→orange ring, cold rows none.
  `sidebar-context.e2e` covers it.)_

- [x] **Active session unread when content lands below the viewport**
  _(done: `store.activeUnread` + `markActiveUnread`/`clearActiveUnread`; `Transcript`
  reports "grew while not at bottom" and shows a "new messages ↓" pill that clears on
  scroll-to-bottom; `sessionStatus` returns "unread" for the active row when set. Caught
  a `$derived` reactivity bug on the pill mid-build.)_

- [x] **Session rename** _(the remaining half of rename / archive / unarchive)_
  _(done: was already wired end-to-end (protocol message, both drivers, store, sidebar
  inline-rename UI); this pass added the missing hub test coverage — rename routes +
  rebroadcasts the list, blank-name no-op.)_

- [~] **`/tree` passthrough** — _(investigated, not shipped: pi's `/tree` is a
  TUI-interactive builtin (`BUILTIN_SLASH_COMMANDS`, the session-tree navigator), not a
  headless-executable command. The SDK `prompt()` path only expands templates/skills/
  extension commands, so surfacing `/tree` would send literal text to the model rather
  than run anything — misleading. Dropped rather than ship a fake-functional command;
  would need pi to add headless builtin execution.)_

- [x] **Slash-command autocompletion** + inline help text describing each command
  _(done: `CommandInfo` + `commandList`/`listCommands` wire messages mirror the
  model-list path; the pi driver reads `get_commands`' three sources (extension
  commands + prompt templates + skills), the mock serves `MOCK_COMMANDS`. Composer
  shows a typeahead on a leading `/` — filter helper in `lib/slash.ts`, popup in
  `SlashMenu.svelte`, ↑↓/↵/Tab/Esc nav, click-to-insert, each row carries the
  command's description + source. Execution is free: `/name args` is a normal
  prompt and pi's `prompt()` runs the command / expands the template. TUI builtins
  (/model, /settings, …) intentionally omitted — pilot has native UI. Unit test for
  the filter + `e2e/slash.spec.ts`.)_

- [x] **Live markdown rendering in prompt edit box** — preview formatting as you type, if straightforward
  _(done: Edit/Preview toggle rendered the draft via `<Markdown>`; appeared only
  with a non-empty draft, Enter-to-send preserved. **Superseded 2026-06-19 — the toggle was
  removed; see "Remove composer markdown preview/edit toggle" at the top of this file.**)_

- [x] **Run-failed error card + retry** — `runFailed` currently has no first-class UI.
  Render a distinct error card (message + stack/cause if present) with a "Retry"
  button that re-sends the last prompt, and a "Copy error" affordance.
  _(done: error notices now carry a Retry (re-sends `store.lastPrompt`) + Copy
  button; `store.lastPrompt` tracks the last sent prompt; the `error` fixture is
  wired into the `?dev` bar + mock `runScript`; `streaming.spec.ts` covers it.
  Stack/cause rendering deferred — the driver only surfaces `error.message` today.)_

- [x] **Countdown for timeout-bearing dialogs**
  _(done: shrinking bar + "Auto-dismiss in Ns" for dialogs with `timeoutMs`,
  deny-safe auto-resolve at zero, timers cleaned per dialog.)_

- [x] **Binary 2-option select → Yes/No card**
  _(done: affirmative option detected + promoted to the primary/right button
  regardless of array order, mirroring the confirm dialog.)_

- [x] **Virtualized transcript list** (>80 rows)
  _(done, then reverted: CSS `content-visibility: auto` + `contain-intrinsic-size`
  on `.row`/`.tool`/`.merged-reads` skipped off-screen rows — but the estimated
  intrinsic size meant rows snapped from a 120px placeholder to their real height as
  you scrolled up, injecting height above the viewport and drifting it downward (the
  "viewport must never move on its own" rule). Removed; the transcript now renders
  every row at true height up front (no virtualization). A dev-only `[pilot] transcript
  render` log (gated behind `?dev`, `store.logRenderTiming`) reports item count +
  paint time so the trend is visible; real JS windowing — render last N turns +
  "load older", which can preserve scroll on prepend — is the proper fix when that
  number grows. Regression pinned in `e2e/transcript.e2e.ts`. **2026-06-21:** the
  `content-visibility` rules came back onto `.row`/`.tool`/`.turn-work`/`.summary` in a later
  refactor — and an autoscroll feature was since built on top of them: removing them leaves the
  pinned scroll ~150px short of the bottom (`e2e/polish.e2e.ts`). So they're now **kept
  intentionally** and re-documented as such (load-bearing, with a residual scroll-up drift
  tradeoff), rather than reverted. The `store.logRenderTiming` comment carries the rationale.)_

- [x] **PNG / maskable icons** — proper app icons for installed PWA
  _(done: 192/512 + maskable-512 (safe-zone padded) + 180 apple-touch, rasterized
  from `icon.svg`; manifest + `<link apple-touch-icon>` wired.)_

- [x] **Tool card inspection polish** — unobtrusive expand/collapse (OP8)
  _(done: chevron rotation transition, hover/focus ring, gentle body reveal,
  `aria-expanded`.)_

- [x] **Beautiful font rendering** — prose readability pass (OP8)
  _(done: refined system font stack + smoothing/feature-settings; `.prose` rhythm,
  code/pre, link styling tuned. No palette change.)_

- [x] **Type-to-focus prompt field** — basic typable characters focus the
  text field before typing them (or a dedicated hotkey)
  _(done: window keydown focuses the composer on a printable key when no input is
  focused; doesn't steal from dialog/sidebar inputs.)_

- [x] **Jump-to-last-prompt hotkey** (OP8)

- [x] **Stray iOS zoom fix** — composer `font-size: ≥16px` to stop iOS
  auto-zoom; `overflow-x: hidden` on root
  _(done: textarea 16px; `overflow-x: hidden` on `.shell`.)_

- [x] **Hotkey + tooltip audit for every UI action** — go through every clickable
  element (sidebar toggle, header buttons, stop, send, approval actions, trust
  options, settings controls, model picker items, etc.) and add a keyboard
  shortcut or a `title` tooltip naming the action + its hotkey if one exists
  _(done: every clickable across all components now carries a descriptive `title`
  (icon-only buttons especially); full suite stays green.)_

- [x] **Enter/Alt+Enter hint for steer vs follow-up** — add an inline hint near the
  composer or a tooltip explaining that pressing Enter while the agent is running
  steers, and Alt+Enter queues a follow-up message (and implement both hotkeys)
  _(done: Enter steers / Alt+Enter queues a follow-up (reflected in the toggle);
  hint line + hotkey-named tooltips; new `streamhold` fixture holds a running
  state for the e2e.)_

- [x] **Keyboard shortcut for Settings (⌘+,)** — open the settings panel with the
  standard web app keyboard shortcut
  _(done: ⌘/Ctrl+, toggles the panel; gear tooltip names the hotkey; e2e.)_

- [x] **Warm-session eviction cap** — `pi-driver.ts` currently keeps every session
  warm forever with no upper bound; add a configurable cap with LRU eviction
  _(done: `PILOT_WARM_CAP` (default 8, ≤0 = unbounded); focus-recency LRU via Map
  re-insertion; pure `evictionPlan` helper unit-tested; evicts via
  `session.dispose()` (also aborts an in-flight run). pi path not yet run live.)_

- [x] **Tab title mirrors session title** — update `document.title` from the ambient
  `title` so the browser tab reflects the session name instead of always showing
  "pilot" (DESIGN.md SHOULD)
  _(done: `$effect` in App.svelte sets `document.title` to "<title> · pilot",
  falls back to "pilot"; e2e in polish.spec.)_

- [x] **PWA update prompt** — when a new service worker is available, show a
  toast/banner asking the user to refresh for the latest version (standard PWA
  lifecycle UX)
  _(done: `lib/sw.ts` flags an update when a new SW reaches "installed" while one
  already controls the page → refresh toast (Refresh/Dismiss); `?dev` "update"
  button + e2e.)_

- [x] **Autofocus after tapping `+` in the sidebar** — when creating a new session,
  focus the cwd input field immediately so you can type a path without an extra
  click. (An `autofocus` attribute exists already but is unreliable with Svelte's
  `{#if}` conditional mount — needs a `tick()` + `input.focus()` approach.)
  _(done: `tick()` + `input.focus()`/`select()` on open; e2e asserts focus.)_

- [x] **Model list search bar** — filter-as-you-type search in the model picker (top bar)
  and the model list in the Settings panel; model lists grow quickly, and the
  current flat menus become unwieldy with many providers connected
  _(done: search input in the header ModelPicker panel + the Settings favorites
  list; both filter by label/id/provider with a no-match state. e2e for each.)_

- [x] **Stray caret span in agent text** — a naked `<span class="caret svelte-1rd1h7a"></span>`
  is appended to the end of agent output, looks like a client rendering bug.
  Needs investigation and fix
  _(done: root cause was `foldEvent` only closing the open assistant on
  `runCompleted`; a turn that goes idle via `sessionUpdated` left `streaming:true`.
  Fixed at the source (close on any non-running snapshot) + a defensive caret guard
  on `store.streaming`. e2e repro via the `idle` fixture.)_

- [x] **Worktree checkbox in new-session form** — like the Claude app's "worktree"
  toggle; creates and passes a jj/git worktree path as the session cwd so the
  agent works in an isolated copy, leaving the main tree clean
  _(done: `newSession` carries `worktree` through protocol→hub→both drivers; pi
  creates a jj (git-fallback) worktree via `server/src/pi/worktree.ts` — pure
  planner unit-tested; mock simulates a `-worktree` sibling dir; e2e covers the
  toggle. The pi creation path is typechecked but not yet run live.)_

- [x] **Copy-to-clipboard button on agent messages** — a button at the bottom of
  each agent text area; hidden until hover, copies message content
  _(done: hover-revealed Copy button, `navigator.clipboard.writeText`, "Copied"
  feedback.)_

- [x] **Message timestamps** — small relative timestamp at the bottom of each
  agent and user text box (e.g. "5m ago"), with mouseover revealing the exact
  timestamp
  _(done: `ts` added to user/assistant items in `foldEvent` from the event
  timestamp; `<time>` with a relative label + exact-time `title`, refreshed on a
  30s tick.)_

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

- [x] **Edit tool output: collapsed diff counts + expanded diff view** — instead of
  "Successfully replaced N block(s) in /path", show a collapsed view with
  `+N, -M` line counts, expandable to a nice side-by-side or unified diff.
  Use `bun i @pierre/diffs` for the diff rendering
  _(done: `@pierre/diffs/ssr` `preloadDiffHTML` renders a syntax-highlighted diff
  to an HTML string — no React (peer-only) — mounted in a shadow root (its CSS is
  `:host`-scoped), lazy `import()`ed so shiki stays out of the initial bundle, and
  re-rendered on light/dark toggle. Collapsed `+N/−M` from a dependency-free line
  diff. Detects pi's edit shape `{path, edits:[{oldText,newText}]}` + legacy.)_

- [x] **Tool call results popup: drop description, add hover tooltip** — the tool
  description doesn't need to be listed inline in the popup; move it to a
  mouseover tooltip on the tool name instead
  _(done: inline `.desc` removed, `item.description` now a `title=` tooltip on
  the tool name.)_

- [x] **Session search bar** — filter-as-you-type search over session display name,
  preview, and path in the sidebar
  _(done: sidebar search filters groups by name/preview/cwd, hides empty groups;
  `sessions.spec.ts` covers name + path matches.)_

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

- [x] **Project sidebar hierarchy polish** — larger expand/collapse arrows for
  project groups; indent sessions under their project header to make the
  parent-child relationship visually obvious
  _(done: bigger carets, indented rows, indicator gutter — shipped with the
  status indicators below.)_

- [x] **Suppress notifications when app focused** — if feasible, silence push/toast
  notifications while the browser tab/window has focus
  _(done: client toast now gates on `document.hasFocus()`, not visibility — fires
  whenever pilot isn't the focused window. Committed in worktree, not yet merged.)_

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
  `PILOT_DRIVER=pi bun run dev`, then open a project from the sidebar (the server
  boots to an empty landing, no `PILOT_CWD`). Working; rough edges
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
