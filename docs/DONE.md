# Pilot — Done

Archive of completed items from `TODO.md`. Each entry includes the original checkbox
and its resolution note. Latest completions first.

---

- [x] **Drop the steer/follow-up toggle + investigate steer behavior (BUG).** The
      composer exposes a `steer` ↔ `follow-up` SegmentedControl
      (`client/src/components/Composer.svelte:30,37–48`) whose chosen `deliverAs` is passed
      into `store.sendPrompt` → `PilotDriver.prompt(text, deliverAs, …)`. But polytoken's
      daemon has **no steer/follow-up distinction**: the driver receives it as `_deliverAs`
      (underscore-prefixed, unused) and ALWAYS calls `POST /prompt`; the queue endpoint
      `POST /turn/input` takes only `{content}`. Every queued message is labelled
      `mode: "steer"` regardless. So the toggle was cosmetic noise. BUT: the user reports
      steer messages are currently buggy — the toggle's no-op-ness was masking a real
      mid-turn-queueing bug (the driver routes mid-turn sends to `/prompt` instead of
      `/turn/input`).
      → Done 2026-07-01 (full fix — scope A, operator-confirmed): (1) **wired mid-turn
      queueing** — `polytoken-driver.ts` `prompt` now branches on
      `ws.lastState?.turn_in_flight`: in-flight → `queueTurnInput` (POST /turn/input,
      queue); idle → `prompt` (POST /prompt, new turn). The bug (mid-turn sends wrongly
      starting a new turn) is fixed. (2) **removed the cosmetic toggle** — dropped the
      SegmentedControl + `deliverAs`/`altHeld`/`deliverModes`/`deliverDisplay` state +
      the Alt-hold preview + the onAltSync/onWindowBlur listeners from `Composer.svelte`.
      `submit()` now takes no mode arg; Enter always sends (the driver routes queue vs.
      new-turn). Toolbar hint: "Enter queues a follow-up". The wire `deliverAs` field
      stays (mock/hub/driver accept it, unused) to minimize churn — a follow-up can drop
      it end-to-end. Deleted the 2 toggle-specific streaming tests; added a hint-visibility
      + Enter-clears assertion to `stop-turn.e2e.ts` (cheap coverage for the composer-side
      behavior the deleted tests covered). The "Esc after send submits the next message"
      report was clarified as TUI-only behavior (not a pilot bug). Staleness window
      acknowledged: `turn_in_flight` may read stale between turn-start + the next
      session_state_changed; a misroute surfaces as a 409 (rejected promptResult), not a
      silent second turn. Commit `05fe0960`.

- [x] **Show + edit the agent's permission level in the UI.** The polytoken daemon exposes
      the runtime permission monitor — `GET/POST /permission-monitor`
      (`server/src/polytoken/wire-types.ts:389`, `:1996–2021`), with `PermissionMonitorMode`
      `standard` | `bypass` | `autonomous` (the autonomous variant carries a classifier model,
      rules, and `max_consecutive_denials`), and emits a `permission_monitor_switch` event
      (`from_monitor`→`to_monitor`, `wire-types.ts:1078–1082`) when it changes. None of this
      reaches pilot today. Needs: a `PilotDriver` seam to read/switch the monitor, the hub to
      relay state + switch event, `foldEvent` to land it on `SessionState` (overwrite-guarded
      like `facet`), and a UI control (beside the facet badge in `StatusHeader.svelte` or in
      Settings) to display the current mode and switch it. Mirror the `setFacet` wire shape
      (`protocol/src/wire.ts:346`) for the change request. 2026-06-30.
      permission should be a UI element in the bottom bar, next to model and effort level!
      → Done 2026-06-30: landed the per-session permission monitor end-to-end, mirroring
      `setFacet`. Added `PermissionMonitorMode` (protocol/session-driver.ts, mirrors the
      daemon OpenAPI source) + `permissionMonitor?` on `SessionState`/`SessionSnapshot`
      (overwrite-guarded fold like `facet`) + `setPermissionMonitor` wire. Required
      `PilotDriver.setPermissionMonitor` seam + hub handler. Mock: `setPermissionMonitor`
      emits a snapshot; `snapshot()` base seeds `"standard"`. Polytoken: `getPermissionMonitor()`
      (GET) seeds `ws.monitorMode` once at warm-up (one extra request, not per-snapshot);
      `setMonitorMode` effect + the `permission_monitor_switch` event (was a toast → now a
      `sessionUpdated` snapshot carrying the new mode + cache update) keep it in sync;
      `setPermissionMonitor` POSTs `/permission-monitor` (optimistic cache update). Threaded
      `monitorMode` through all 4 `snapshotFromState` call sites. New `PermissionBadge.svelte`
      chip (mirrors ModelPicker: badge + 3-item panel-up, accent-tinted when non-standard,
      keyboard-navigable) in `.toolbar-right` left of FacetBadge. 3 new e2e + 2 new fold unit
      tests; the toast unit test rewritten. Follow-up (not done): a global hotkey to open the
      badge (hotkey choice needs discussion). Commit `a8bf7ee6`.

- [x] **Facet badge: show the current facet value, and reclaim Shift+Tab as a focus move.**
      `StatusHeader.svelte:141` renders the badge as the literal strings `"Plan"` (when
      execute/unknown) or `"Plan mode"` (when plan) — it never shows "Execute", so the control
      reads as a static label, not state. Show the actual current facet ("Execute" / "Plan").
      Separately, the facet-cycle hotkey is **Shift+Tab** (`App.svelte:155–171`, gated on no
      form field focused) — but Shift+Tab is the browser's reverse-focus traversal and should
      stay that way in a GUI. Replacement candidates (must fit macOS, Linux, and Windows):
      `⌥/Alt+F` is clean on macOS but `Alt+F` opens the File menu on Win/Linux; `⌘/Ctrl+Shift+F`
      is cross-platform and free in the installed PWA, but clashes with the near-universal
      "Find in Files" muscle memory (VS Code et al.). Pick one and handle the Shift-modifier
      special-case — the global keydown early-returns on `e.shiftKey` at `App.svelte:173`, so
      any Shift combo must be matched *before* that line, like Ctrl+Tab already is. 2026-06-30.
      i think the facet should be displayed at the bottom near model/effort
      hotkey choice needs discussion
      → Done 2026-06-30 (partial — value display + relocation only; hotkey replacement deferred):
      extracted `FacetBadge.svelte` — a chip showing the ACTUAL current facet ("Execute" /
      "Plan", accent-tinted when plan) — and mounted it in the composer's footer toolbar
      (`.toolbar-right`, immediately left of `ModelPicker`), where model/effort already live.
      Removed the old badge button + dead `.facet-toggle`/`.facet-badge`/`.facet-dormant` CSS
      from `StatusHeader`. The badge is now a state readout (always visible), not an
      affordance label. `Shift+Tab` toggling is UNCHANGED (the hotkey-replacement sub-part is
      marked "needs discussion" and was skipped per the goal). Also fixed a stale pre-existing
      mobile e2e failure (`toBeHidden()` → `toBeVisible()`, predating the always-visible
      change). New DOM-order test guards the toolbar placement. Commit `5e0f2810`.

- [x] **cmd+= / cmd+- (font size changes) aren't applied to the question widget, they should**
      → Done 2026-06-30: the Q&A question widget (`QnaInline` → `QnaForm`) renders outside
      the Transcript's scaled `.col` and used hardcoded px font sizes, so `--font-scale`
      never reached it. Added a single scaled base `font-size: calc(15px * var(--font-scale,
      1))` on `.qna-inline` (mirroring the Transcript's `.col` pattern) and converted
      QnaForm's 8 text-bearing px rules to `em` relative to that base (`.q`, `.opt`,
      `.field` → 1em; `h2` → 1.0667em; `.ctx` → 0.8667em; `.progress`/`.lbl-desc`/`.check`
      → 0.8em). Controls stay unscaled per the "zoom what you read, not the controls"
      convention (`.min` minimize, `.dot` marker, `.actions .btn` — Button.svelte keeps its
      own `lg`=15px). At scale=1 every value resolves to the exact original px. New e2e
      test verifies `.q` ≈ 15px at default, grows with the Settings stepper, and the Submit
      button stays unchanged. Commit `zvurnour`.

- [x] **e2e: dir-picker `.row.up` "go up" button times out (pre-existing flake).** Surfaced
      during the Chunk 0.5 Settings-nav verification (2026-06-26): 5 `e2e/sessions.e2e.ts`
      worktree/dir-picker tests (`started in a directory chosen via the browser`, `worktree
      chip creates…`, `worktree session shows a path indicator`, `archiving a worktree session
      reaps…`, `archiving a dirty worktree session…`) all fail with a 30s timeout waiting for
      `dir-picker`'s `.row.up`. VERIFIED to fail at the clean base commit `b3c98cac` (no
      Settings changes) — NOT a regression from the nav refactor. Likely environmental
      (the `chooseProjectDir` helper's `.row.up` click never resolves). Not blocking the
      extensions plan, but it's noisy in the suite and should be diagnosed separately.
      → Done 2026-06-30: already fixed by commit `58b09695` ("Fix dir-picker nav race in
      worktree e2e helper", 2026-06-26 — same day the flake was filed, an ancestor of HEAD).
      That commit added a readiness wait to `chooseProjectDir` —
      `await expect(picker.locator(".bc")).toContainText("src")` before pressing Backspace —
      closing the race where `up()` read `showing.parent` before the opening `queryDir` reply
      arrived (no-op → test hangs). The TODO description was stale in two ways: it referenced
      a `.row.up` *click* the helper never performs (it presses Backspace on the filter
      input), and no `.row.up` class exists in `DirPicker.svelte`. Verified green: ran the 5
      named tests 3× in a row, all pass (5/5 each run, ~4.4s). No flake reproduces.

- [x] **polytoken: plan-mode plan display overlay.**
      Surfaced 2026-06-29 (second dogfood): when running in the `plan` facet, there
      should be a plan display overlay in the Pilot UI — a persistent, visible
      rendering of the current plan (the structured handoff doc the plan facet
      produces). Currently there's no way to view the plan from the GUI; it's
      TUI-only. Needs a design for how the plan renders (inline in transcript?
      sidebar panel? floating overlay?) and where it lives in the layout.
      → Done 2026-06-30: added `activePlan?: string` to `SessionSnapshot` (protocol)
      + overwrite-guarded fold propagation (mirroring `facet`). The event-map
      threads `state.active_plan` → `snapshot.activePlan`. A `PlanView.svelte`
      modal (scrim + dialog + Markdown render, the TreeView pattern) renders the
      plan markdown read-only. Triggered by a StatusHeader "Plan" IconButton
      (gated on `activePlan` truthiness — no button when no plan exists) and the
      `⌘P` hotkey. A `planview` mock fixture exercises the full path in e2e.

- [x] **polytoken: facet switching has no GUI affordance.**
      Surfaced 2026-06-29 (second dogfood): the TUI cycles facets with Shift+Tab,
      but that doesn't map cleanly to a GUI. Pilot needs a hotkey (TBD) and/or a
      visible UI control to switch facets (e.g. execute ↔ plan). Until this lands,
      facet switching is TUI-only and inaccessible from the Pilot UI. Decide on a
      hotkey (Shift+Tab is the TUI convention but may conflict with focus
      traversal in a web context) and surface the active facet somewhere visible.
      → Done 2026-06-30: wired `setFacet` end-to-end (mirroring `setModel`): a new
      `setFacet` ClientMessage (wire.ts) → hub handler → PilotDriver method →
      mock (emits `snapshot({ facet })`) + polytoken (POSTs `/facet`) impls. The
      StatusHeader facet badge is now a clickable toggle — always visible (dormant
      "Plan" button in execute mode, accent-tinted "Plan mode" pill in plan mode).
      Shift+Tab (the TUI convention) also toggles, guarded to not fire when a form
      field is focused (preserving browser focus-traversal) and not collide with
      Ctrl+Shift+Tab (session cycling). The daemon's `facet_switch` SSE → event-map
      → sessionUpdated round-trip was already handled; this just adds the driver
      seam + wire message + UI control.

- [x] **polytoken: retry button re-sends the last prompt instead of resuming.**
      Surfaced 2026-06-29 (second dogfood): the "retry" button re-sends the last
      user prompt verbatim. Mid-flow (e.g. after a tool was cancelled/denied) this
      restarts the whole turn instead of nudging the agent to proceed. If retry is
      meant to resume, it should send a fixed minimal signal — "continue" or an
      empty string — rather than replaying the full prior message. If both
      "resume after interruption" and "retry the whole turn" are wanted, give them
      separate buttons with distinct semantics.
      → Done 2026-06-30: the error-notice card's "Retry" button (shown on `runFailed`)
      is renamed to "Resume" and now sends `"continue"` via `this.prompt("continue")`
      instead of re-sending `lastPrompt` verbatim. Key insight: `runFailed` only fires
      after the prompt was already accepted by the daemon (the turn started via
      `message_start`, then failed at `message_complete` with a turn error) — so the
      prompt text is already in the daemon's history and re-sending it is wasteful.
      The rejected-prompt row (`promptResult` with `accepted: false`) keeps its
      existing "Retry" button (`retryPending`) — that path re-sends prompts that were
      never accepted (409 turn-in-flight, 422 hook denied, etc.). The dead `lastPrompt`
      field + its two writes are removed. No wire protocol or daemon changes — Resume
      is just a `POST /prompt` with content `"continue"`.

- [x] **polytoken: opening a session that's live in the TUI causes a 409 lease conflict.**
      Surfaced 2026-06-29 (first dogfood): a session with an active TUI attachment rejects
      pilot's lease claim with 409 (the lease is exclusive, spike §2). The error is now
      readable (names the TUI holder + lease expiry), but the UX is still a hard failure —
      the operator has to `/detach` in the TUI or wait ~30s. A clean fix would detect the
      409 at `openSession` and surface a "this session is open in the TUI — force-attach?"
      affordance, or retry-with-backoff until the lease lapses. The deeper product question:
      should pilot preemptively detach (or refuse to open) a session the TUI is actively
      driving? Related jank: opening the same session in pilot that the TUI is viewing makes
      the TUI error briefly then detach (the TUI's own lease-loss handling) — need a clean
      protocol for coexistence. (Readable error + connection-race fix landed in `69585952`.)
      → Done 2026-06-30: `claimLeaseWithRetry` (daemon-client.ts) retries the claim up to 3×
      with 3s backoff, parsing each 409's `expires_at` to stop early when the lease won't
      lapse within the retry window (active TUI) — catching stale-lease cases transparently.
      The final error message includes the computed time-to-lapse (replacing the hardcoded
      "~30s"). `retryClaim` is a pure exported function (unit-tested with a mock claim fn).
      The client (store.svelte.ts) detects lease-conflict messages via a regex pattern and
      renders a sticky "Retry" toast that re-sends `openSession(path)`. A `failsession` mock
      script exercises the full toast + retry path in e2e. Does NOT add a force-attach
      mechanism (operator chose A — never kill the user's process).

- [x] **polytoken: new-session draft doesn't default to the dynamic (umans) model.**
      Surfaced 2026-06-29: `polytoken models` lists `deepseek/deepseek-v4-*` (static config)
      + `umans/umans-*` (dynamic, discovered at runtime). The new-session draft's model
      picker shows the static list but doesn't surface the dynamic default the way the TUI
      does on a fresh session. Likely needs `listModels` to also surface the daemon's
      runtime-resolved default model (not just `config.yaml`'s `default_model`), or the
      new-session flow to query the daemon's effective default after spawn. May be a
      polytoken-side gap (whether dynamic models surface via `polytoken models` at all).
      → Done 2026-06-29: the polytoken driver now implements `getModelDefaults()` (it
      was missing entirely — `broadcastModelDefaults()` silently no-opped), seeding the
      draft from the `default_model` marker; `listModels()` synthesizes pickable
      `ModelOption` entries for catalog defaults not in the `models:` section; and the
      pre-existing `${provider}/${modelId}` join bug in `setModel`/`newSession` (which
      doubled the prefix and broke picking *any* model from the draft) is fixed to POST
      the full registry name directly via `modelPostKey()`. Part 2 (the synthesis) is a
      TEMPORARY workaround pending an upstream `polytoken models` feature to list
      catalog-provider models as `models:` blocks — remove once native.
- [x] **polytoken: event-map bare modelId shows bare id on active-session badge.**
      Surfaced 2026-06-29 while resolving catalog models: `event-map.ts`
      (`snapshotFromState` + the `model_switch` handler) splits `active_model` on `/`
      and takes `[1]` as the **bare** modelId for `SessionSnapshot.config`, while
      `ModelOption.modelId` (from `parseModels`) is the **full** `provider/id`. So after
      a model switch, the active-session badge shows the bare id (e.g. `umans-glm-5.2`)
      instead of the friendly label — `ModelPicker.svelte`'s `store.models.find()`
      matches against the full form and misses, falling back to the raw bare id. This is
      display-only (switching itself works — the client POSTs the full `ModelOption`
      modelId, never the bare `session.config` one). Fix: use the full `active_model` as
      `config.modelId` in both sites. Has its own test surface in `event-map.test.ts`.
      Flagged with `// NOTE:` comments at the two split sites.
      **Done (2026-06-29):** aligned polytoken config to the full registry name by reusing
      `defaultModelRef` (mirroring `parseModels`/`defaultModelRef`) at both split sites,
      and de-duplicated the picker tooltip so a full-form modelId renders unqualified.
      Scoped to the polytoken driver only — pi driver untouched.
- [x] **Plan-mode handoff card + facet indicator** → done 2026-06-29. Stopped
      discarding plan-mode data the daemon already streams: the `plan_handoff`
      interrogative now renders as a dedicated approval card showing the plan
      markdown (`plan_text`) in a scrollable region + the 3 action buttons
      (Implement new context / Implement current context / Cancel), instead of a
      blind generic `select`. Added a `plan` `HostUiRequest` variant + `facet?` on
      `SessionSnapshot`, threaded `active_facet` through `snapshotFromState` and the
      `foldEvent` reducer (the critical fold step that was dropping the field), and
      rendered a "Plan mode" badge in `StatusHeader` when the facet isn't the default
      `execute`. Response mechanism unchanged — the card replies `{value: label}`,
      and the reverse mapping (`ui-bridge.ts`) maps it to the `plan_handoff_answer`
      decision via the already-captured labels. **Deferred:** the live plan overlay
      (B — watching the plan doc update as the agent authors it; content-source
      unknown) and per-facet accent-color theming.
- [x] **Don't collapse the lead-up paragraph when an agent asks via the `answer` tool.**
      Repro (session `019ef8d7-35a9-7738-afac-e718fdbaccc2`, Opus 4.8): the agent wrote a
      final-response-looking paragraph, then immediately fired the `answer` tool to ask a
      question, then kept working after the user's reply. That lead-up paragraph was the
      trailing assistant item of the pre-answer work run, so it folded into "Worked for
      Ns" — hiding the question's context directly above the Q&A card. Fix (2026-06-26):
      in `buildTurn`, peel the trailing assistant paragraph(s) of the work run
      immediately preceding a pinned `answer` card into pinned visible lanes, so they
      sit visibly between the (now shorter) collapsible tool run and the Q&A. Scoped to
      the `answer` tool only — image-bearing tools and HostUi dialogs (confirm/input/
      select/qna) are out of scope (no repros). The case-2 "prose question with no
      `answer` tool" variant remains unhandled (would need heuristic detection).
- [x] **New-session dir input validation + always-typing fuzzy input** → done 2026-06-22.
      The old two-mode design (edit/navigate toggle) is replaced with an always-visible
      filter input that fuzzy-matches subdirectories by subsequence. Typing filters the
      current dir's children; Backspace when empty goes up. Path mode (input starts with
      `/` or `~`) still lets you jump to any directory directly. A debounced `statPath`
      round-trip shows an inline ✓/✗ validation hint for typed paths. `e2e/dir-picker.e2e.ts`
      covers filtering, path jumping, Escape clear-vs-close, and the project pick flow.
- [x] **Sidebar visuals → match Codex** → checked off 2026-06-22 (owner: "we're at a good
      state now"). The sidebar look is settled; no Codex-screenshot redesign pass needed.
- [x] **Collapse the Settings providers + favorites lists** → done 2026-06-22. The Settings
      panel had grown into a long scroll, so two lists now collapse (`Settings.svelte`): the
      **Providers** section header is a disclosure (collapsed by default, shows a `N/M connected`
      summary), and the **favorites checklist** gets per-provider collapse mirroring the header
      `ModelPicker` (chevron + model count, `aria-expanded`) — groups start collapsed, a non-empty
      search auto-expands matches, and providers that already hold a favorite are seeded open on
      each panel-open so existing curation stays visible (re-seed gated to the open transition via
      a plain `prevOpen` guard, so toggling a favorite mid-session doesn't re-collapse). Default
      model + thinking selects stay always-visible (compact, primary controls). `e2e/settings.e2e.ts`
      gains collapse-default/expand-on-click, search-auto-expand, and seeded-open-on-reopen specs;
      the existing provider + favorites specs expand first. _(Scoped to the two long lists; the
      whole Models section was deliberately not put behind one toggle — the selects are the
      most-used controls. Reframe if a single Models toggle was the intent.)_
- [x] ~~**Session context indicator**~~ → won't-build (owner, 2026-06-22 — "i think the
      current state is good"; the earlier "is good imo" meant the current state, not "keep the
      idea"). The shipped surfaces — the meter ring + the 85%-full composer cue — cover the need;
      no separate green→yellow→red sidebar/header dot. _(Reopen if an at-a-glance per-row dot is
      wanted later; the token-budget thresholds from snapshot usage are the data source.)_
- [x] **`/tree` command → open the native tree modal** → already built; verified 2026-06-22.
      `Composer.svelte:275` intercepts `text.trim() === "/tree"` in `submit()` before send: it
      clears the box, calls `store.openTree()`, and early-returns so it never forwards to pi.
      Exactly the spec. Covered by `e2e/tree.e2e.ts` ("typing /tree opens the view instead of
      sending it"). Backlog item was stale — no build needed.
- [x] **Extensions enable/disable view** + compatibility-issue surfacing → done 2026-06-22.
      New collapsible "Extensions" section in the Settings panel lists the focused session's
      pi extensions (name, source scope, tool/command counts) from `resourceLoader.getExtensions()`,
      surfaces each one's load error inline (the compat-issue half), and offers a per-extension
      On/Off toggle. Toggling writes a `-<resolvedPath>` force-exclude override to pi's user
      settings (`SettingsManager.getExtensionPaths`/`setExtensionPaths`) — so it **applies on the
      session's next start** (pi loads extensions at start; the section says so), and disabled
      rows are reconstructed from those overrides so they stay re-enableable. New protocol
      `ExtensionInfo` + `queryExtensions`/`extensionList`/`setExtensionEnabled` wire messages,
      `PilotDriver.listExtensions`/`setExtensionEnabled` in both drivers, hub routing, store
      state, `MOCK_EXTENSIONS` fixtures. Covered by `e2e/settings.e2e.ts` (collapse-default,
      list+counts+error, toggle+reconcile) + a hub unit test. _(Known limit: a user-scope
      override reliably toggles user-scope extensions; project-scope ones depend on pi applying
      user patterns across scopes — see the `setExtensionEnabled` comment. A truly LIVE toggle
      is still out — see the toggle item in 🔵 Later, now narrowed to just that.)_
- [x] **Unarchive action in the sidebar** → already built; verified 2026-06-22. The session
      row's `⋯` menu item already toggles on `s.archived`: it reads "Unarchive"/"Archive"
      (`Sidebar.svelte:695`), the `A` hotkey + tooltip flip with it, and `toggleArchive` calls
      `store.setArchived(s.path, !s.archived)`. Archived rows surface once you toggle the sidebar
      to "Showing all". Covered by `e2e/archive.e2e.ts`. Backlog item was stale — no build needed.
      _(If the gap you felt was *discoverability* — hard to reach an archived row to unarchive —
      say so and I'll add a more direct affordance; the toggle logic itself is done.)_
- [x] ~~**Live activity status line**~~ → won't-build (owner, 2026-06-22). The derived
      verbose one-liner ("Reading foo.ts", "Running tests", "Editing bar.rs") was shipped once
      and **reverted as too noisy** — owner doesn't want it anywhere (sidebar rows, tab title,
      or notifications). The coarse cross-session attention state (running / waiting / failed /
      done) stays; this is specifically the chatty per-action line that's out. _(Doc note: the
      earlier text here claimed the one-liners were live in sidebar rows — that was stale;
      they were removed. Flag me if any verbose-activity remnant is still rendering in code.)_
- [x] **In-transcript search (⌘F)** → done 2026-06-22. Claude-style floating "Find in
      transcript" box pinned top-right of the transcript pane, opened with ⌘/Ctrl+F.
      Find-as-you-type over the rendered transcript with match highlighting (CSS Custom
      Highlight API — `Range`s registered in `CSS.highlights`, no DOM mutation, so it
      survives stream deltas/re-renders; degrades to scroll-only where unsupported), a
      `current/total` counter, next/prev (⏎ / ⇧⏎ or the ↑↓ buttons, wrapping), and Esc to
      close. A `MutationObserver` keeps matches fresh while a turn streams. Distinct from
      the sidebar session search. New `TranscriptSearch.svelte`; `e2e/transcript-search.e2e.ts`.
- [x] **Bump Vite 6 → 8 + @sveltejs/vite-plugin-svelte 5 → 7** → done 2026-06-21.
      Resolved to Vite 8.0.16 + vite-plugin-svelte 7.1.2; the lockfile now uses Rolldown
      instead of esbuild+Rollup, and the old inspector package disappeared with the v5
      plugin dependency chain. No config changes were needed: the custom build-sha plugin,
      dev proxy (including WebSockets), and production bundle all work unchanged. Verified
      with the production build, Svelte check, protocol typecheck, 349 unit tests, and all
      172 desktop/mobile Playwright tests.
- [x] **Archive is instant + irreversible** → done 2026-06-21. Built the **toast/snackbar
      system** the app lacked: client-only `store.toasts` + `toast(msg, {action, durationMs})`
      + `dismissToast`, rendered by a new `Toast.svelte` (bottom-center stack, auto-dismiss,
      per-toast Undo + ×) mounted in `App`. `setArchived(…, true)` now pushes an `Archived "…"`
      toast whose **Undo** un-archives. `e2e/archive.e2e.ts` covers archive→toast→undo→restored.
- [x] **No "resolved on another device" notice** → done 2026-06-21. Reuses the toast system.
      `respondUi` records requestIds this client answered; when a `hostUiResolved` arrives for a
      dialog still showing locally that this client did NOT answer (first-responder-wins on
      another device), the store pushes a transient "Resolved on another device" — so the sheet
      no longer just silently vanishes. `e2e/multiclient.e2e.ts` asserts the non-answering client
      gets the notice and the answering one doesn't. (Outcome-direction still omitted — the event
      carries no outcome, matching the original note.)
- [x] **Tool output trapped in a 320px scrollbox** → done 2026-06-21. The result block in
      `ToolCard.svelte` now carries a compact action bar: **Copy** (clipboard, with a "Copied"
      flash) and an **Expand/Collapse** toggle that drops the 320px cap so a long log reads
      top-to-bottom instead of trapping a nested scroll. The expand affordance only appears when
      the collapsed output actually overflows (measured `scrollHeight > clientHeight`), so short
      results stay clean. New `longoutput` mock script/fixture (40-line bash log) + dev-bar button
      drive it; `e2e/tool-output.e2e.ts` proves the cap-drop and the clipboard round-trip. (The
      diff's 420px cap and the args `<pre>` were left as-is — the scroll-trap complaint was the
      text output; revisit if a diff proves as trapping.)
- [x] **Sidebar search has no focus-on-open / Enter / Esc** → done 2026-06-21. Enter opens the
      top match (first session of the first group — the visual top); Esc clears a non-empty query
      (and `stopPropagation`s so it doesn't also trip the app-wide Esc handlers), else blurs.
      Focus-on-open is gated to desktop and fires only on a closed→open transition (`prev` seeded
      to the current state) so it never steals focus from the composer on initial load or pops
      the soft keyboard on a phone. `e2e/sessions.e2e.ts` covers Enter-opens, Esc-clears, and
      desktop reopen-focuses.
- [x] **"N hidden" count isn't clickable** → done 2026-06-21. The "{N} hidden" hint is now a
      button that toggles to show-all on click (it then vanishes, and the adjacent toggle reads
      "Showing all"), with a count-aware tooltip and a focus ring. `e2e/archive.e2e.ts` covers
      the click revealing archived + stale. _(Deferred the optional "skip the 7d cutoff when the
      list is short" — it changes filter semantics as the count crosses a threshold; the clickable
      count already addresses the stated friction, so it's parked rather than half-baked.)_
- [x] **Stop button no-ops silently while offline** → done 2026-06-21. Both halves: the Stop
      pill is now `disabled` while `connection !== "connected"` (inert + a "can't stop while
      offline — the agent keeps running" tooltip), and `abort()` mirrors `restoreQueue` — a
      dropped send sets `lastError`, so the Esc-abort path still gives feedback offline.
      `e2e/stop-turn.e2e.ts` drives a streaming turn, drops the socket, and asserts the pill
      goes disabled with the explanatory title.
- [x] **Optimistic prompt reads "Queued offline" while merely connecting** → done 2026-06-21.
      The delivery label now keys off the live socket, not the outbox sub-state (which sits at
      "queued" for both a dead socket AND one mid-reconnect — the actual root cause). New pure
      `deliveryState(promptState, connection)` helper (`client/src/lib/delivery.ts`): connected →
      "Sending…", connecting/reconnecting → "Sending when reconnected…", disconnected → "Queued
      offline", rejected overrides. Unit test covers the full matrix; a new `pilot:test-reconnecting`
      DEV hook freezes the socket in "reconnecting" so `e2e/prompt-delivery.e2e.ts` proves the
      mid-reconnect label appears and "Queued offline" does not.
- [x] **Backdrop tap discards a dirty input/editor dialog** → done 2026-06-21. `scrimClick` now
      no-ops when an input/editor dialog is dirty (live value differs from `initialValue`) — the
      buttons are the deliberate dismissal there. A clean dialog still dismisses on tap.
      `e2e/approvals.e2e.ts` covers both: typing then a backdrop tap keeps the text, restoring the
      initial value re-enables tap-to-dismiss.
- [x] **Non-binary select dialog lacks arrow-key roving** → done 2026-06-21. The 3+ option select
      is now a `radiogroup` of `role="radio"` options with roving tabindex: ↑/↓ move focus
      (wrapping), Home/End jump to ends, the focused option marks itself `aria-checked`, and
      Enter/Space/click submits it. New `selectmany` mock script/fixture + dev-bar button drive a
      3-option select; `e2e/approvals.e2e.ts` covers arrow roving, the checked state, and submit.
- [x] **Background "done" reads too like plain "unread"** → done 2026-06-21. A finished-while-away
      row now renders a check (✓) badge in an accent pill — same badge language as waiting/failed,
      a clear step up from plain unread's neutral dot (which it used to share). The "Done" activity
      line gets matching `data-state="done"` accent styling. `e2e/status-indicators.e2e.ts` asserts
      the check badge appears on the done row.
- [x] **Overflowing tables/code give no at-rest scroll hint on touch** → done 2026-06-21.
      `markstream-theme.css` now applies Lea Verou's pure-CSS "scrolling shadows" to `pre` and
      `table` under `@media (pointer: coarse)`: edge covers (`background-attachment: local`) hide
      the shadows at each end, and the shadows (`scroll`) reveal whenever there's more content
      that way — so cut-off columns/code show a fade at rest instead of nothing. Cover colors
      match each container's background (`--surface-sunken` for `pre`, `--bg` for tables). Desktop
      keeps its persistent styled scrollbar (the rule is coarse-only). `e2e/responsive.mobile.e2e.ts`
      asserts the 4 gradient layers + `local` attachment land on the Pixel 7 (coarse) project.
      _(Both-edge shadows, slightly beyond the right-edge-only ask — same technique, better cue.)_
- [x] **`content-visibility` code/doc mismatch** → done 2026-06-21. **Re-documented as intentional**
      (vs finishing the revert). I first removed the rules to honor the documented no-drift
      invariant — but the e2e caught that they're **load-bearing for the autoscroll pin**: without
      `content-visibility` the just-sent prompt's pinned scroll settles ~150px short of the bottom
      (`e2e/polish.e2e.ts`). The autoscroll feature was built on top of the (reintroduced) rules, so
      removing them is a real regression, not a clean perf revert. Kept them and rewrote the
      `store.svelte.ts` comment + DONE.md to say so explicitly: intentional, load-bearing, with a
      residual scroll-up drift tradeoff accepted; real JS windowing (preserve scroll on prepend) is
      the proper fix when item counts climb. Code and design log now agree. _(Surfacing the tradeoff
      for the owner: the drift the original revert chased is still theoretically possible scrolling
      up past tall not-yet-painted rows — not observed in tests; revisit if it bites.)_
- [x] **Safe-area insets** → done 2026-06-21. Verified `viewport-fit=cover` is set and the
      composer/sidebar/sheets already pad `env(safe-area-inset-bottom)`. The one gap was the
      header top — added `padding-top: env(safe-area-inset-top)` to `.hdr` so it clears the
      notch/status bar in PWA standalone (0 in a normal tab, so a no-op there).
- [x] **Wake lock during a run** → done 2026-06-21. New `lib/wake-lock.ts` (testable core +
      browser-wired default) holds a `navigator.wakeLock` while `store.turnActive`, releases on
      settle, and re-acquires on visibility regain (the OS drops the lock when the tab hides).
      A progressive enhancement — silent no-op where unsupported/denied. `wake-lock.test.ts`
      covers acquire/release, the toggle-off-mid-request race, reacquire-only-while-wanted, and
      the unsupported no-op.
- [x] **Tap-target audit (≥44px)** → done 2026-06-21. On coarse pointers, the `Button` component
      (dialog/action buttons, ~42px before), the non-binary select `.opt` rows, and the Composer
      config `.chip`s now get `min-height: 44px` (sidebar rows + IconButton were already fine).
      `e2e/tap-targets.mobile.e2e.ts` asserts dialog actions + select options clear 44px on Pixel 7.
- [x] **PWA status-bar / theme-color chrome** → done 2026-06-21. The `theme-color` meta was a
      static light value; now `lib/theme.ts` syncs it to the resolved palette's computed `--bg`
      on every theme change (+ the inline pre-paint script sets it from the two inlined `--bg`
      hexes before the bundle loads, no flash). Android/browser chrome tracks light↔dark; iOS
      standalone still uses the static apple status-bar meta (can't be set live). `settings.e2e.ts`
      asserts the meta flips to `#242522`/`#f7f6f2` on toggle and survives a reload.
- [x] **"New session" draft stays visible in sidebar while draft exists** + **groups
      under its project** → done 2026-06-21 (both, settled per-project after discussion).
      Sidebar draft rows are now derived from the persisted `draftMap` (`store.pendingDrafts`,
      `n:<cwd>`-keyed, made `$state` so the rows react): the active draft plus any project's
      stashed draft with text. Each nests under its target project's group (rendered in the
      group `<ul>` like a session row, so it hides when the group collapses); a draft whose
      cwd isn't a known project yet floats at the very top (the `$HOME` default case). Each
      row carries an × to discard. Retargeting via `setDraftCwd` migrates the stash key
      (drops the old `n:<old>`), so the row moves to the new project without ghosting under
      the old one. `e2e/sidebar-drafts.e2e.ts` covers nest+persist, discard, retarget-no-ghost,
      and collapse-hides. _(Scoped to display + grouping per the discussion; the finicky
      composer project-switcher redesign was left out of scope. Known limitation: only
      text + cwd persist across navigation — model/worktree picks re-seed to defaults on
      return, unchanged from before. During an active sidebar search a draft whose group is
      filtered out falls to the top row.)_
- [x] **Model list: collapsible provider headers, collapsed by default** → done 2026-06-21.
      The header model dropdown (`ModelPicker`) now has collapsible provider headers (chevron +
      model count, `aria-expanded`): groups start collapsed except the active model's provider
      (seeded open so your current pick stays visible), a non-empty search auto-expands every
      matching group, and arrow-key nav only walks VISIBLE rows. Favorites-filtered or
      single-provider lists expand fully (already short — collapsing would hide the curated set
      or leave a lone header). `e2e/models.e2e.ts` covers collapse-default, expand-to-pick, and
      search-auto-expand. (Subtle fix found via the thinking-picker test: the shared `sel` clamp
      had to be gated to the model menu, since the model list can now be empty.) _(Scoped to the
      header dropdown at the time; the **Settings favorites checklist** later got the same
      treatment — see "Collapse the Settings providers + favorites lists" below, done 2026-06-22.)_
- [x] **Smooth collapse animation for turn-ending autocollapse** → done 2026-06-21. The
      per-turn work block's body now uses a Svelte `transition:slide` (180ms, `cubicOut`), so
      the autocollapse at turn end (and the manual toggle) glides height+opacity instead of
      snapping and jumping the content below. Svelte skips the intro on initial mount, so
      already-settled turns on page load don't animate. `working-block` + `polish` (autoscroll)
      e2e still green.
- [x] **Mobile: Enter should insert newline, not send** → done 2026-06-21. On a touch
      device (`navigator.maxTouchPoints > 0`, matching Transcript/Sidebar) a bare Enter now
      falls through to the textarea as a newline; send is the button or a hardware ⌘/Ctrl+Enter
      (`Composer.svelte` keydown). The slash/file typeaheads still consume their own Enter
      first, and desktop Enter-to-send is unchanged. The send tooltip names the touch shortcut.
      `e2e/composer.mobile.e2e.ts` (Pixel 7) covers newline-not-send + button-still-sends.
- [x] **Mobile: sending a prompt resets view to default new-draft session** → done 2026-06-21.
      Root cause was **connectivity, not the send** (owner's instinct): a dropped socket (a
      Tailscale flap on a phone) reconnects as a brand-new WS, and `hub.addClient` registers
      every connection focused on the empty landing (`defaultFocusId`) — connections are
      anonymous, so the server can't know it's the same client. Client-side nothing re-asserted
      focus on reconnect (`maybeOpenBootDraft` is gated by `bootDraftHandled`), so the view
      snapped to a blank pane mid-session; the send itself was incidental (the prompt carries
      its own `sessionId` and lands fine). Fix: the store captures the viewed session on each
      reconnect `hello` (before the bootstrap snapshot overwrites it) and re-opens it once the
      session list lands (`reconnectFocusId` + `maybeRestoreFocus`). A draft survives a reconnect
      on its own (client state rendered ahead of the snapshot), so it's left alone.
      `e2e/reconnect-focus.e2e.ts` opens a non-landing session, drops the socket, reconnects, and
      asserts we land back on it (verified it fails without the fix — the view snaps to the
      greeting). _(Broader mobile connectivity hardening — flaky-link queue behavior etc. — is a
      separate thread; this fixes the specific focus-loss symptom.)_
- [x] **Mobile: composer should be pinned above the keyboard** → done 2026-06-21. New
      `lib/keyboard-inset.ts` reads the on-screen keyboard's overlap from the `visualViewport`
      (`innerHeight − visualViewport.height − offsetTop`, clamped ≥0) and publishes it as a
      `--keyboard-inset` CSS var on `<html>`, updated on viewport resize/scroll. On touch
      (`@media (pointer: coarse)`) the app shrinks by it (`height: calc(100dvh − var(...))`), so
      the bottom-anchored composer rides just above the keyboard instead of sliding behind it /
      scrolling off. Desktop (fine pointer) is untouched — trackpad pinch-zoom never shrinks the
      layout — and the var defaults to 0 where `visualViewport` is absent (progressive
      enhancement). Also added `interactive-widget=resizes-content` to the viewport meta so
      Chrome Android resizes the layout for the keyboard natively; iOS Safari ignores it and
      uses the tracker. `keyboard-inset.test.ts` covers the inset math + tracker subscribe/reset;
      `e2e/keyboard-inset.mobile.e2e.ts` (Pixel 7) drives the var and asserts the app shrinks +
      the composer lifts + restores. _(The actual visualViewport→keyboard step can't be driven by
      Playwright — no real soft keyboard — so real-device iOS confirmation is still owner's.)_
- [x] **Active session unread when new text lands below the viewport** → already implemented;
      verified + covered 2026-06-21. The chain was already wired (it landed folded into the
      status-indicators work, the checkbox just wasn't ticked): `Transcript.svelte` calls
      `store.markActiveUnread()` when content grew while not pinned to the bottom, clears it on
      scroll-to-bottom/switch/send; `store.activeUnread` + `sessionStatus()` return "unread" for
      the active session (the exception to active-is-read); the sidebar row renders the dot from
      `sessionStatus`. The one real gap was a dedicated test — added `e2e/active-unread.e2e.ts`:
      build a tall transcript, scroll up, drive a new turn, assert the "New messages ↓" pill
      appears AND the active row flips to `data-state="unread"`, then jump-to-bottom clears both.
      _(Owner asked to weigh in: verified working against the mock; if you saw it stay stubbornly
      "read" in practice — e.g. a mobile-specific timing — flag it and I'll chase that case.)_
- [x] ~~**(discussion needed) Auto session titling via cheapest model**~~ → resolved
      2026-06-21 as **won't-build (pi already owns it)**. pi's `session-namer.ts`
      extension already does exactly this: on the first prompt of an unnamed session it
      asks the cheap `text-summary` role for a ≤40-char title and sets it fire-and-forget
      (zero first-token latency), riding `session_info_changed` → `sessionUpdated` into the
      sidebar live. Pilot already runs pi as `mode: "rpc"` with `hasUI` true
      (`pi-driver.ts:617`), which is exactly the condition the namer needs to fire — same
      seam that made the `answer`/qna tool work. Building a pilot-side titler would
      duplicate and fight pi, against the pi-only/deep-SDK lane (cf. the line-197 call to
      _(Update 2026-06-26: the session-namer extension is now PILOT-OWNED — ported into
      `pilot/extensions/session-namer.ts` per `docs/PLAN-self-contained-extensions.md`
      Chunk 2, reading pilot's `backgroundModel` setting instead of the dotfiles roles.mjs.
      The won't-build conclusion still holds — pilot owns the namer, so a separate
      pilot-side titler would duplicate ITSELF.)_
      leave auto-title cleanup to the namer extension, not pilot). A live session that
      isn't named yet shows its first prompt as preview, not "New session" — that label is
      only the unsent-draft placeholder. _(Loose end: not re-verified against a live
      real-pi run this session — if titles ever sit stuck on the raw prompt, that's a
      broken `text-summary` role / missing auth on the Mac Mini, i.e. a pi-seam debug, not
      a pilot build.)_
- [x] **@-completion in new-session draft uses wrong cwd** → done 2026-06-21. The `@`
      typeahead used the pushed file index, which is the previously-focused session's cwd — so
      a draft showed the wrong project's files. Now while drafting the composer suppresses that
      stale local index and routes every `@` query through the server `fd` fallback, scoped to
      the draft's target cwd (typed path, or $HOME when blank). Threaded a `cwd?` through the
      `queryFiles` wire message → `PilotDriver.listFiles(query, sessionId?, cwd?)` → both drivers
      (pi uses it as the `fd` root; the mock surfaces a cwd-derived marker for testing). Hub unit
      tests cover the cwd forwarding (explicit + omitted); `e2e/file-mention.e2e.ts` proves a
      draft's menu fills from the cwd-scoped fallback while a real session doesn't.
- [x] **Session metadata header** → done 2026-06-21 (minimal, owner's call). The mobile
      crowding that gated this was already resolved (model/thinking moved out of the header);
      the only live wart was the subtitle reading the hardcoded literal `pilot` for every
      session. `StatusHeader` now derives the subtitle from the active session's list entry
      (the folded snapshot carries no cwd): the project name (cwd basename), and
      `project · worktree` when the session runs in a pilot-created worktree (cwd ≠ parent
      repo). Pure `lib/session-subtitle.ts` helper (unit-tested incl. the worktree + degenerate
      cases); `e2e/sessions.e2e.ts` proves it tracks cwd (switch project → subtitle changes).
      Hover shows the full path. _(Scoped down from the wishlist strip: git branch stays its
      own item below; model/thinking deliberately not re-added to the header; count/started-at
      parked unless dogfooding asks.)_
- [x] **Pull-to-refresh → force reconnect + snapshot** → done 2026-06-21. Pulling the
      **transcript** or the **sidebar session list** down from the top (touch only) fires
      `store.reconnect()` → `forceReconnect()`, which drops + re-establishes the WS; the
      reconnect re-runs the hello→snapshot flow, so the "+ snapshot" half comes free.
      Gesture math is a DOM-free `PullTracker` (`lib/pull-to-refresh.ts`, unit-tested:
      arm threshold, resistance, top-edge-only, upward/lost-edge collapse); a Svelte
      action wires touch events (non-passive `touchmove` so it preventDefaults the native
      pull), and a reactive controller (`lib/pull-to-refresh.svelte.ts`) holds the spinner
      until connected with a min-visible floor so a fast reconnect never flashes. A
      minimal `PullIndicator.svelte` (arrow → flips to "release" when armed → spinner)
      overlays each surface. Touch-gated via `maxTouchPoints`; desktop keeps Reconnect
      (Alt+R). `e2e/pull-to-refresh.mobile.e2e.ts` (Pixel 7) covers past-threshold →
      reconnect and a sub-threshold no-op. _(Eyeballed in the desktop preview for layout
      + zero console errors; the touch gesture itself is covered by the Pixel 7 e2e, not
      yet finger-tested on a real phone.)_
- [x] **Reliable prompt delivery across disconnects** → done 2026-06-20. Every normal
      or create+first prompt gets a client UUID and is saved to an IndexedDB outbox before
      the composer clears. Pending rows render optimistically as Sending/Queued offline;
      authenticated reconnect hydrates + resends them. Pi's `preflightResult` now drives a
      targeted `promptResult` ACK, and the hub memoizes prompt ids (bounded at 2,048) so
      reconnect races cannot invoke pi or create a session twice. Rejections stay in the
      transcript with Retry/Edit (including attached images); accepted rows reconcile by
      sharing the prompt id with the authoritative `userMessage`. E2E covers offline tab
      eviction → reopen → exactly-once delivery and rejection → edit recovery; hub tests
      cover duplicate normal/create requests and rejection.
- [x] **Cross-session attention state** → done 2026-06-20. The hub now retains and
      broadcasts compact `running`/`waiting`/`failed`/`done` metadata for every warm
      session, including derived tool/response activity plus pending-request count/title.
      Sidebar rows show the live activity or blocking request; collapsed project groups
      surface their highest-priority state. Background completions become a distinct done
      marker until read. Tab and Web Push notifications name the target session and carry
      a `?session=` deep-link; notification clicks focus/open that session, whose retained
      approval is immediately actionable. Unit tests cover activity/wait/failure/reconnect
      state; E2E covers background approval → project indicator → one-tap focus, deep-link
      boot routing, and running → done → read.
- [x] **Queued-message tray + restore/edit flow** → done 2026-06-20. Pi's complete
      `queue_update {steering, followUp}` now replaces shared folded queue state, and live
      snapshots seed the current queue on reconnect/refocus. A compact tray above the
      composer preserves Steer vs Follow-up labels. “Edit all” / `Alt+Up` calls pi's
      atomic `clearQueue()`, clears every client through the shared event, and restores
      steering-then-follow-up text only into the requesting editor (matching pi's `\n\n`
      join behavior); an empty restore is a no-op. Unit tests cover mapping/folding and
      targeted restore. E2E covers labels, delivery/removal, reload, refocus, hotkey
      restore, and two-client synchronization.
- [x] **Per-client session focus** → done 2026-06-20. The hub no longer owns one
      server-global `focusedId` + folded `state`: it holds a `Map<sessionId, SessionState>`
      (folded only for sessions someone is viewing, plus the bootstrap landing) and each
      connection carries its own `focusedId` + single-flight switch lock. Live events fold
      into the shared per-session state and route ONLY to the connections focused there;
      snapshots, `sessionList.activeSessionId`, cwd-scoped command lists, and `@`-mention
      file results are now per-connection (targeted), while attention/running, the session
      list CONTENT, models/providers/defaults, trust, OAuth, and update status stay global.
      `switchTo` moves one connection's focus (branch reseeds + re-snapshots every viewer,
      since navigateTree mutates the shared session); approval resolution stays
      first-responder-wins on the targeted session's shared pending list. The driver needed
      no change — it already streams every warm session concurrently — beyond a synchronous
      `defaultSeed()` for the landing a fresh connection adopts (the mock's bootstrap is now
      seed-based, not a live replay, so two clients adopt it without racing). The client is
      unchanged: the wire shapes were the same, only the routing went from broadcast to
      targeted. Unit tests cover per-connection focus, independent switching, and
      session-scoped approval; `e2e/per-client-focus.e2e.ts` proves (two browser contexts)
      that one client switching sessions doesn't move another. **Known limitation:** the
      driver's warm-cap LRU eviction is global, not viewer-aware — with more than
      `PILOT_WARM_CAP` (default 8) sessions open across clients, a session one client is
      actively viewing could be evicted by another client's opens; benign for 1–2 devices.
- [x] **Paste/drop image attachments + hardening** → done 2026-06-20. Screenshots can
      now be pasted into the textarea or dropped anywhere on the composer (with a visible
      drop target), sharing the file picker's removable previews. Validation rejects
      unsupported/empty/oversized files before base64 work; count, source-file/batch, and
      processed-file/total byte limits are enforced with visible errors. Oversized raster
      images are downscaled to 2,048 px and quality-stepped where browser decoding permits;
      HEIC/HEIF camera inputs must convert to JPEG rather than leaking an unsupported MIME
      downstream. Image-only sends remain enabled, attachments are copied out of Svelte
      proxies before IndexedDB persistence, and sent images now render in the transcript
      instead of becoming an empty bubble. Unit/E2E cover validation, paste, drop/rejection,
      limits, image-only send, and the mobile picker. **Known pi limitation:** queued-image
      restore is still text-only because `queue_update`/`clearQueue()` omit attachment data;
      preserving it would require Pilot-side queue metadata.
- [x] **No "running low on context" cue** → done 2026-06-20. Once the focused session's
      context window is ≥85% full, the composer surfaces a one-line `role="status"` cue above
      the input ("Context N% full — consider /compact or a fresh session"), reusing the
      attachment-status row pattern. Tone tracks the meter ring (accent 85–89%, danger 90%+) so
      the words and the ring agree; drafts carry no usage, so it stays hidden there. New
      `contextfull` dev-bar script (→ `MOCK_USAGE_FULL` 91%) drives it deterministically;
      `e2e/context-meter.e2e.ts` asserts it's absent at the 24% baseline and appears (with the
      danger tone + 91% ring) once driven.
- [x] **Attach button does nothing** → fixed 2026-06-20. Real bug, NOT stale — but the web
      code was never the problem: the paperclip is correctly wired (`Composer.svelte`
      `IconButton` → `openFilePicker` → hidden `<input type="file">`), which is why it works
      in a browser and in the e2e/DOM checks. Root cause was the **desktop shell**: the
      `WKWebView` in `desktop/Sources/Pilot/AppDelegate.swift` had no `WKUIDelegate`, and
      WKWebView silently swallows every `<input type="file">` click unless the host presents
      the picker itself. Fix: conform to `WKUIDelegate`, set `wv.uiDelegate = self`, and
      implement `runOpenPanelWith` to drive a native `NSOpenPanel` (sheet on the window,
      restricted to image content types to mirror the input's `accept="image/*"`). Verified
      with `swiftc -typecheck`; behavioral confirmation is a desktop rebuild + click (owner).
- [x] **Desktop WKWebView host-bridge hardening (links + downloads)** → done 2026-06-20.
      Same root-cause class as the attach bug: any web behavior that hands off to the OS is a
      silent no-op in the packaged app until the shell bridges it. Found while preparing for
      it: **external links in agent output were already dead** (`target=_blank` →
      `createWebViewWith`, which we didn't implement). Now `AppDelegate.swift` adds a
      `WKNavigationDelegate` (off-origin link clicks → system browser via `NSWorkspace`;
      un-renderable responses + `<a download>` → downloads) and a `WKDownloadDelegate` (generic
      `NSSavePanel` save for ALL downloads, ahead of any in-app download feature), plus
      `createWebViewWith` → system browser. `desktop/README.md` now carries a "WKWebView host
      capabilities" checklist (status per surface + the rule of thumb) so the next
      host-mediated feature gets bridged on purpose. `swiftc -typecheck` clean; behavioral
      confirmation is a desktop rebuild (owner).
- [x] **Hide "Branch from here" on the current leaf** → done 2026-06-20. `Transcript`
      derives `leafEntryId` (the entry id of the active path's tip — the last user/assistant
      item carrying one) and suppresses the turn-final assistant's "Branch from here" when it
      matches, since branching from the tip is a no-op (it's already where the next message
      appends). "Last item with an entry id, any kind" — not "last assistant" — so a committed
      prompt with no answer yet shifts the tip off the prior answer, keeping that earlier turn
      branchable. Brings the inline button to parity with the tree modal, which already gates
      no-op jumps on `isLeaf`. The mock's `promptReply` now backfills `userEntryId`/
      `assistantEntryId` on every settled turn (mirroring real pi, which always does) so the
      tip detection holds across both drivers — previously sent-prompt turns had no branch
      handles at all. `branch.e2e.ts` covers leaf-hides + an earlier non-leaf turn showing the
      button (with a position assertion that defeats an inverted gate).
- [x] **Autoscroll to transcript bottom on prompt submit** → done 2026-06-20. Sending a
      prompt while scrolled up reading scrollback used to leave the just-sent bubble below
      the fold behind the "New messages ↓" pill — the pinned-scroll effect only follows new
      content when you're already near the bottom. Now the single `enqueuePrompt` chokepoint
      (covers normal sends, the new-session draft, and Retry) bumps a `store.promptSentN`
      counter; `Transcript` watches it, re-pins, and jumps to the bottom so your message +
      the incoming reply land in view. Standard chat behavior (Claude/Codex/ChatGPT all do
      it). Covered by `e2e/polish.e2e.ts` (build a tall transcript → scroll to top → send →
      assert pinned-to-bottom + no catch-up pill); verified it fails without the bump.
- [x] **Offline prompt queue** → done 2026-06-20 as part of reliable prompt delivery;
      IndexedDB persistence survives disconnects, reloads, and tab eviction.
- [x] **Optimistic user-message echo** → done 2026-06-20 as part of reliable prompt
      delivery, including explicit acceptance/rejection ACK reconciliation.
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
- [x] ~~**Stop default-new-session-in-server-cwd for production usage**~~ → done
      2026-06-19. The server's cwd no longer feeds any logic: it's not a trust anchor
      (no dir is implicitly trusted — every cwd goes through pi's built-in trust:
      trust.json → interactive card → deny-safe), not the boot session (the server boots
      to an empty landing; the client opens a new-session draft at $HOME), and not the
      new-session default (`newSession()` with no cwd defaults to $HOME). `PILOT_CWD` is
      gone. **Fast-follow resolved:** the per-client persistence item below now restores
      the last-focused session from that empty landing.
- [x] **Per-client UI state persistence** → done 2026-06-19. The active session is now
      remembered in localStorage per stable Pilot server id and restored from the empty
      startup landing; missing/archived/failed-to-open targets clear themselves and fall
      back to the $HOME draft. Sidebar visibility, theme, archive filter, thinking
      visibility, and per-session composer drafts were already persisted per client.
      E2E covers valid restoration + stale-session fallback.
- [x] **Per-session prompt draft persistence (pilot-level, not pi state)** → done 2026-06-19.
      Store holds a `draftMap` persisted in localStorage (`pilot.composerDrafts`), keyed
      `s:<sessionId>` for an existing session and `n:<cwd>` for a pending new-session draft
      (one per project). Stashed on every switch (`openSession`/`startDraft`/`cancelDraft`),
      on a 400ms debounced keystroke, and on `pagehide`; restored on switch + on boot
      (`maybeOpenBootDraft` loads the active session's draft). Sending clears the stored
      copy. All three key behaviors covered — (a) needed `openSession` to exit a draft when
      you navigate to a session (it now stashes + clears the draft), (b)/(c) by the keyed map
      + pagehide/boot restore. `e2e/drafts.e2e.ts` (switch-away-and-back, reload, new-session
      draft, send-clears).
- [x] **Pi `answer` tool doesn't work via pilot** → verified working 2026-06-19 against a
      live real-pi instance (deepseek-v4-flash). Root cause was a timing one, not a missing
      feature: the bug predates the qna host-UI bridge (`Add qna host-UI form…` + `Keep
      answer dialogs navigable across chats`) AND the pi `answer` extension's `ctx.ui.qna`
      remote-fallback branch (`~/.pi/agent/extensions/answer.ts:1005-1019`). With both sides
      now in place the tool works end-to-end. Tested live: single multiple-choice, multiSelect
      checkboxes, free-text, and a 2-question paginated form — each rendered correctly and the
      answers round-tripped back to pi (it acknowledged the picks). The contract matches
      (pilot exposes `qna(questions, opts?)`; the extension feature-detects exactly that name +
      shape). **Residual hardening (optional fast-follow):** no test exercises the *real* seam
      (only the mock fixture + `e2e/qna.e2e.ts`); the bridge survives solely because pi hands
      extensions the raw, un-proxied `uiContext` — a runtime assert that `typeof ctx.ui.qna
      === "function"` at bind time would catch a silent pi-version regression. Also: the
      extension calls `qna(questions)` with no opts, so no timeout/abort is armed — a form
      opened while no client is connected awaits forever (it does replay on refocus).
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
- [x] **Wide markdown tables overflowed the mobile viewport** → fixed 2026-06-19
      (`Scroll wide markdown tables horizontally on mobile`). A 7-column table rendered
      654px wide inside a 375px phone with no way to reach the right columns; tables now
      scroll horizontally like code blocks (`client/src/markstream-theme.css`). Covered by
      a Pixel 7 spec in `e2e/responsive.mobile.e2e.ts`.
- [x] **Copy button is invisible/unreachable on touch** → done 2026-06-19.
      `Transcript.svelte` gates the persistent footer on `navigator.maxTouchPoints > 0`,
      avoiding the headless-Chromium `hover: none` false positive while keeping copy
      reachable on touch-primary devices.
- [x] **Attach-tag tooltip lies** → fixed 2026-06-19. Dropped the unimplemented
      "right-click to clear" claim from the attached-images count badge's tooltip
      (`Composer.svelte`); per-image removal already works via the thumb-chips next to it
      (each `Click to remove this image`), so no bulk-clear affordance was wired (owner's
      call: drop the claim, don't build right-click-clear-all).
- [x] **Stop button has no hotkey** → fixed 2026-06-19. **Escape** now aborts a running
      turn (parity with pi TUI / Claude app); Stop's tooltip names it (`Stop the agent
      (Esc)`). Composer-scoped (textarea-focused) to avoid racing the 5 other Esc handlers.
      Bonus per owner: if the agent hasn't produced output yet AND the composer is empty,
      Esc pulls the just-sent prompt back into the box to edit/resend (`store.abortRestoreText`
      — gated on no assistant text + no tool call since the last user message). History is
      left alone: the orphaned user message stays, duplicate prompts on resend accepted.
- [x] **QnA form header says "A few questions" for a single question** → fixed 2026-06-19.
      Dropped the `?? "A few questions"` fallback in `QnaForm.svelte`; the `<h2>` renders
      only when the request carries an explicit title, otherwise the question itself is the
      header (owner's call). Multi-question forms still show the `Question N of M` progress.
      _(Session auto-title keeping a literal markdown `#` was triaged out: it's the
      session-namer extension's gap, not pilot's to defend against — owner declined a
      pilot-side strip. The session-namer extension is now PILOT-OWNED, ported in
      `docs/PLAN-self-contained-extensions.md` Chunk 2 — so this gap is now in pilot's
      own `pilot/extensions/session-namer.ts`.)_
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
- [x] **Image attachments via browser file input** → done 2026-06-19. Up to ten selected
      images render as removable thumbnail chips and travel through the protocol into pi's
      prompt options. Paste/drop, byte limits, and compression are tracked in the Important
      hardening item above. Arbitrary file attachments are not supported by pi's prompt
      attachment contract.
- [x] **Edit-and-resubmit a prior prompt** → done 2026-06-19 as session-tree T1.
      “Branch from this prompt” rewinds to the prompt's parent and prefills the composer;
      `⌘/Ctrl+⇧+↑` applies it to the most recent prompt.
- [x] **@-file mention autocomplete** — done 2026-06-19. Type `@` in the composer
      followed by a filename/path prefix → server searches the session's cwd via `fd`
      (fast, .gitignore-aware), results appear in a popup menu. Arrow/Enter/Tab to
      select, Esc to dismiss; directories get a trailing `/`. See the TODO in
      `Composer.svelte` re: per-query RPC latency tradeoff.
- [x] **Inline tool-diff rendering** → done 2026-06-18. Edit tool cards show collapsed
      `+N/−M` counts and lazily render the full unified diff with `@pierre/diffs`.
- [x] **Connection-status banner** → done 2026-06-18. `ConnectionBanner.svelte` shows
      connecting/reconnecting/offline state, explains that the agent keeps running, and
      offers manual reconnect (`Alt+R`).
- [x] **Theme: follow system + explicit toggle** → done 2026-06-18. Settings offers
      System/Light/Dark, persists the override, and follows live
      `prefers-color-scheme` changes in System mode.
- [x] **WebSocket `perMessageDeflate`** → `server/src/index.ts`. Bun defaults it off;
   assistant markdown, fenced code, and full reconnect snapshots are highly compressible,
   so this trims per-frame overhead on Tailscale-over-spotty-wifi and buys down the
   reconnect-resend cost (partially mitigates the snapshot-on-reconnect item below).
   Cost is per-connection deflate memory + CPU on the Mac Mini — negligible for a
   single-user app.
- [x] **ThinkingBlock shimmer honours `prefers-reduced-motion`** →
   `client/src/components/ThinkingBlock.svelte`. The shimmer animates `background-position`
   (a paint, not a composited transform) and was the one animation in the app with no
   reduced-motion guard — unlike WorkingIndicator's orbit and the markstream fade.
   Cosmetic/contract fix; no behavior change.
- [x] **Queued-messages editing** → whole-queue restore/edit shipped in the urgent item
      above. Individual replacement remains intentionally unbuilt unless dogfooding shows
      it is worth a second queue mutation API.
- [x] **Deduped the copy-pasted "scroll selected row into view" effect** → `lib/scroll-into-view.ts`
      exports a `scrollIndexIntoView` Svelte **action** (Svelte docs: prefer an action over
      `$effect` for DOM side effects). It replaced three byte-identical
      `$effect` + `querySelector('[data-i=...]').scrollIntoView()` copies in `SlashMenu`,
      `FileMenu`, and `DirPicker` (the latter no longer needs its `bind:this={root}`).
      Three identical copies is the "copied shortcut becomes the pattern" smell — one shared
      action stops a fourth slightly-different variant appearing. Verified: svelte-check clean,
      387 unit + the slash/file-mention/dir-picker e2e (12) green.
- [x] **Removed a dead ternary in `ApprovalLayer.svelte`** — `c.kind === "input" ? c.initialValue : c.initialValue`
      (both branches identical) → `c.initialValue ?? ""`. A copy-paste fossil; both `input` and
      `editor` requests carry `initialValue`.
- [x] **Per-session prompt draft persistence** _(superseded — completed in 🟡 Important;
      retained here only as historical brainstorm context)_.

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

- [x] **Permission popup: show request content + prune invalid options** —
  Added a dedicated `permission` HostUiRequest kind that surfaces the tool
  name + a JSON preview of the tool's input (from the daemon's
  `permission_tool_call`), and prunes the 7 approval choices down to those
  whose persistence target the daemon's `keep_targets` rule allows (Deny +
  Allow once always kept). A shared `pruneApprovalOptions` helper is the
  single source of truth, used by both the forward mapping (event-map.ts)
  and the mock fixture (fixtures.ts) so the logic can't drift. The reverse
  mapping (ui-bridge.ts) resolves the chosen label via the full labels
  index (stable), then accepts it via reference equality against the
  captured pruned subset — a stale/raced response to a pruned-out option
  returns null. Verified by 4 unit tests (event-map) + 4 reverse-mapping
  tests (ui-bridge, incl. the backward-compat fallback) + 6 desktop +
  2 mobile e2e specs.

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
