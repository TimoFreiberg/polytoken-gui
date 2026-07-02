# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
Completed items are archived to [`DONE.md`](DONE.md).
See `docs/` siblings for context: `DESIGN.md` (architecture + roadmap), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

- [x] plan popup is too narrow, it should be closer to full screen (maybe a tiny bit smaller to make it a tiny bit visible that there's something behind it). also, plan popup buttons go out of the plan box, they should be bounded and their text should wrap / the buttons should scroll within the container if absolutely necessary
      **Fixed 2026-07-02:** both plan surfaces widened. The plan-handoff sheet
      (`ApprovalLayer` `.sheet.plan`) now takes the chat pane minus a 24px sliver
      (desktop) / near-full height (mobile), as a flex column — the markdown body
      gets the flexible height and scrolls, header + actions stay pinned. Action
      labels (daemon-provided, arbitrary length) wrap inside their buttons
      (overriding the Button primitive's `nowrap`) and the 3-action row wraps
      instead of overflowing. `PlanView` (⌘P) widened the same way
      (viewport minus 48px, content-sized when short). Screenshot-verified
      desktop + mobile; plan-handoff/plan-view e2e green.
- [x] user prompts longer than like 10 lines should be shown truncated to those 10 lines by default, with an expand / collapse back to the truncated view button
      **Fixed 2026-07-02:** user bubbles clamp to 10 rendered lines
      (CSS `line-clamp` on an unpadded inner element, so soft-wrapped lines count
      and nothing bleeds into the padding) when the text passes a cheap heuristic
      (>10 newlines or >1200 chars). A "Show full prompt" / "Show less" chevron
      toggle sits under the bubble; expansion is per-item view state. E2e:
      clamp + toggle round-trip and short-prompt-has-no-toggle in
      `transcript.e2e.ts`. Screenshot-verified.
- [x] in the new session draft view, pressing the cycle facet hotkey tries to change the facet of the last focused active session instead
      **Fixed 2026-07-02:** the draft now carries its own `facet` pick (mirroring the
      draft's model/thinking pattern end to end): `setFacet`/`composerFacet` branch on
      draft mode, the pick persists via draftConfigMap (D17), rides the `newSession`
      wire message, and both drivers apply it at creation (polytoken: `POST /facet`
      after warm-up; mock: seeds `snapshot.facet`). FacetBadge + ⌘⇧C now read/write
      the draft's facet while drafting. E2e: hotkey-in-draft + submit-carries-facet
      in `drafts.e2e.ts`.
- [x] adventurous-handoff is per-session, the toggle should be in the per-session config (near the prompt text box) - maybe in the facet menu? it's kiiinda a modifier of plan mode (in spirit - it is an independent toggle right now aiui)
      **Fixed 2026-07-02:** moved the toggle from Settings→Appearance into the
      FacetBadge picker panel (a switch row between the facet options and the
      reload button, with an On/Off pill) — per-session config next to the
      composer, grouped with the facets it modifies. Hidden while drafting a new
      session (no live daemon session to toggle yet). E2e rewritten to drive it
      from the facet menu + a hides-while-drafting spec.

- [x] **`⌘\` cycle through active attention surfaces (with minimize-to-pill).** A unified
      `⌘\` hotkey that cycles keyboard focus through agent-driven attention surfaces that are
      currently active: transcript/composer → qna (inline questions) → approvals (floating
      sheet) → trust card → back to transcript. Each surface gets a "minimize to pill" concept
      so cycling away from it collapses it to a small indicator (e.g. "1 question pending",
      "1 approval pending") rather than dismissing it — the user can always cycle back.
      Rationale: qna already has a minimize toggle (`QnaInline.svelte` `collapsed` state), but
      `ApprovalLayer` and `TrustCard` are modal scrim+sheets with no minimize — they need one
      added. The cycle makes the right thing easy: from the phone you tap `⌘\` to glance at the
      transcript behind a pending approval, then tap again to come back to the approval. Touches:
      add minimize state to `ApprovalLayer.svelte` + `TrustCard.svelte` (mirror `QnaInline`'s
      pattern), a new attention-cycle controller (tracks active surfaces, owns the cycle order +
      which is currently focused/minimized), and a global `⌘\` handler in `App.svelte`
      `onGlobalKeydown`. Every minimized pill needs a tooltip (repo rule). Phase 2 could extend
      the cycle to user-driven modals (Settings, PlanView) but those already have
      dedicated hotkeys so they stay out of the cycle.
- [x] add UI support for `goal` (polytoken shows the text "(goal)" next to the facet in the sidebar, we can find a nicer place but we should also show it, if the protocol exposes it)
- [x] use the updated `polytoken models` that loads dynamic models (from catalog providers) now - remove obsolete fallbacks that emulated this behavior
- [~] use `polytoken validate {skill,facet,subagent}` for gui config stuff —
      **investigated 2026-07-01.** `polytoken validate` is a CLI that parses +
      validates a skill/facet/subagent definition file using the daemon's startup
      logic, reporting errors + exiting non-zero on failure. Two intended uses:
      (1) **During config loading** — shell out to `polytoken validate` for each
      available skill/facet/subagent (read from `GET /state`'s `available_skills`/
      `available_subagents` fields) during warm-up, and surface any validation
      errors as a notice in the transcript (the daemon silently skips malformed
      definitions; this gives the operator actionable feedback). (2) **Future
      config UI** — if pilot grows a Skills/Facets/Subagents settings section,
      `polytoken validate <name>` is the validation hook for it. Deferred: the
      "run during config loading" path needs design (when to run — warm-up only
      or on every switch? how to surface — notice vs toast? how to avoid N shell
      calls per warm-up?). Revisit when a malformed definition is observed in
      practice.

## Full automated gui <-> tui parity testing via playwright + tmux

I'd like to set up affordances/infra for an agent to drive a real pilot gui using a real polytoken backend in a test project (tmp dir with prefilled config that sets the model to a cheap fast one, try both umans-flash (free) and deepseek-v4-flash (very cheap, likely more reliable - umans-flash had some ttft spikes recently)).
Then, enumerate all polytoken features that you get from the tui and run "manual" agent-driven test runs to explore those features and find divergences/jank/missing features

## 🔴 GUI⇄TUI parity gaps (2026-06-30/07-01 audit)

From the source-verified parity audit (`NEXT-SESSION.md` §B, cross-checked against current
source). Each item has exact fix sites + repro in the audit doc. Items already tracked
elsewhere in this file are not duplicated here.

- [x] **`goal_proposal` interrogative wedges the session (worst bug).** Daemon 0.4.x emits
      `interrogative{type:"goal_proposal"}` (from `/goal set` or an agent `propose_goal`).
      Pilot's vendored `InterrogativeType` (`wire-types.ts:1545`) is missing it, so it hits
      the `default:` arm in `buildInterrogativeMapping` (`event-map.ts:438-462`) — which emits
      a fire-and-forget `notify` and returns `pending:null`, POSTing no cancel/answer. The
      daemon's turn stays blocked, "Working…" stays lit permanently, and it survives a page
      reload (hub-authoritative state). **Fix (two parts):**
      1. **Add `goal_proposal` to the vendored `InterrogativeType`** (`wire-types.ts:1545`) +
         a real case in `buildInterrogativeMapping` (`event-map.ts:352`) — a proper card like
         the other interrogative types.
      2. **Make the `default:` arm actionable, not silent.** Instead of a fire-and-forget
         notify that leaves the daemon wedged, show an *error card* (like the approval cards):
         "⚠ Unknown request type: X" with a **Dismiss/Cancel** button that POSTs
         `{kind:"cancel"}` (`wire-types.ts:1511-1514`) to unblock the daemon's turn. Loud *and*
         actionable — the operator sees the error and can dismiss it, rather than a silent deny
         or a permanent wedge.
      Then add the goal *display* (open TODO in 🔴 Next above: polytoken shows "(goal)" by the
      facet).
      **Repro:** live driver → `/goal set anything` → notify card + permanent "Working".
      **Fixed 2026-07-01:** both parts implemented — `goal_proposal` is in the regenerated
      `InterrogativeType` enum, has a dedicated case in `buildInterrogativeMapping` (renders
      a confirm card → `goal_proposal_answer{accepted}`), and the `default:` arm emits a
      blocking confirm dialog (not a fire-and-forget notify) with a Dismiss that POSTs
      `{kind:"cancel"}`. E2e-tested in `e2e/goal-proposal.e2e.ts` (goal card + unknown type).
- [~] **Mock-only driver methods are dead against the live daemon.** The live
      `polytoken-driver.ts` omits 14 methods that exist in `mock-driver.ts`, so they pass e2e
      (mock) but are dead live: `getTree` (tree view hangs), `listProviders`/
      `setProviderApiKey`/`removeProviderApiKey` (Providers tab empty), `oauthLogin`/
      `oauthLogout` (OAuth dead), `listExtensions`/`setExtensionEnabled` (Extensions tab
      empty), `setDefaultModel`/`setDefaultThinking`/`setFavoriteModels` (can't write global
      defaults), `subscribeTrust`/`respondTrust`/`setClientPresence` (trust card never fires).
      The hub guards each with `?.`/early-return; most fail silently (tree hangs,
      Providers/Extensions show empty), except `clearQueue` (`hub.ts:1391`) and `oauthLogin`
      (`hub.ts:1006`) which send an error toast. `setClientPresence` is unimplemented
      *everywhere* (dangling optional), not mock-only — the polytoken driver's own trust-prompt
      doc needs it to deny-safe when no client is connected. **Fix:** implement the 14 methods
      against the daemon (auth.json/global-settings for providers/OAuth/defaults, extension
      loader for extensions, GET /history projection for tree).
      **Note 2026-07-01:** `getTree` is no longer in the count — the tree view was removed
      entirely (see "Remove tree view entirely" below). The remaining 13 methods still apply.
      **Investigated 2026-07-01:** 5 of 14 are implementable now (no daemon changes needed):
      `getTree` (project from GET /history), `listProviders` (parse from `polytoken models`),
      `subscribeTrust`/`respondTrust` (use existing interrogative SSE + POST
      /interrogative/{id}/respond), `setClientPresence` (trivial local callback). The other 9
      are **blocked** on missing daemon features: `setProviderApiKey`/`removeProviderApiKey`/
      `oauthLogin`/`oauthLogout` (no provider auth write API), `listExtensions`/
      `setExtensionEnabled` (no extension enumeration/toggle API), `setDefaultModel`/
      `setDefaultThinking`/`setFavoriteModels` (no global config write API, no favorites
      concept). These need daemon-side endpoints or CLI subcommands to be added first.
      **Updated 2026-07-01:** broken into specific actionable todos below — remove
      unsupported config methods, remove tree view, implement the 4 ready methods.
- [x] **Remove unsupported config methods from mock + UI.** The mock driver implements
      9 methods that have no daemon API and never will (or not soon): `listProviders`,
      `setProviderApiKey`, `removeProviderApiKey`, `oauthLogin`, `oauthLogout`,
      `listExtensions`, `setExtensionEnabled`, `setDefaultModel`, `setDefaultThinking`,
      `setFavoriteModels`. These fake features that pass e2e but are dead live (Providers
      tab empty, Extensions tab empty, OAuth dead, can't write global defaults). Remove
      them from `mock-driver.ts`, the `PilotDriver` interface (`driver.ts`), the hub call
      sites (guard with `?.` — already done), and the corresponding UI surfaces (Settings
      Providers/Extensions tabs, OAuth dialog, model-favorites editor). When the daemon
      grows real APIs for any of these, re-add them properly.
      **Done 2026-07-01:** removed all 10 methods (the 9 above + `getModelDefaults`
      stays as read-only since polytoken implements it). Removed: from protocol —
      `ExtensionInfo`, `ProviderInfo`, `OAuthLoginPrompt`, `OAuthDeviceInfo`,
      `OAuthSelectOption` types + all related wire messages (client + server). From
      driver.ts — the 10 method declarations + `OAuthLoginIO` interface. From hub —
      `broadcastProviderList`, `applyProviderKey`, `runOAuthLogin`, `applyModelDefaults`,
      `sendExtensionList`, `applyExtensionEnabled` + the `oauthPending`/`oauthInFlight`/
      `oauthSeq` state + `OAUTH_PROMPT_TIMEOUT_MS` + all dispatch cases. From mock —
      the methods + `providers`/`defaults`/`extensions` fields + fixture imports
      (`MOCK_PROVIDERS`/`MOCK_EXTENSIONS`/`MOCK_MODEL_DEFAULTS`). From store —
      `providers`/`extensions`/`oauthFlow` state + all provider/OAuth/default/favorites
      methods. From UI — the Providers tab, Extensions tab, OAuth dialog, favorites
      editor, default-model picker (`DefaultModelPicker.svelte` deleted), and
      default-thinking selector. The Models tab now shows only the background-model
      spec (which stays — it's pilot-local settings, not daemon config). E2e tests
      rewritten to remove all provider/OAuth/extension/favorites/default-model tests.
- [x] **Remove tree view entirely (daemon history is linear).** The daemon has no branch
      DAG — `POST /rewind` destructively truncates, it doesn't branch. The mock's `getTree`
      fakes a branching tree that can never exist live, so e2e tests exercise a fiction.
      Remove: `getTree` from the mock + `PilotDriver` interface, `TreeSnapshot`/`TreeNodeInfo`
      protocol types, `tree-view.ts` + its tests, `TreeView.svelte` modal, the `treeState`
      server message + `store.treeOpen` flag, the header IconButton + `⌘⇧T` hotkey, and the
      `/tree` WS message path in the hub. The `branchFrom`/rewind flow stays (it's a linear
      rewind, already relabeled). Replace the tree view's navigational value with fast
      ⌘↑/⌘↓ prompt navigation (see next two todos).
      **Decided 2026-07-01:** remove entirely — no bespoke linear-history navigator, just
      delete the tree view. The ⌘↑/⌘↓ prompt navigation stays (it's separate from the tree).
      **Done 2026-07-01:** removed `getTree` from the driver interface + mock, `TreeSnapshot`/
      `TreeNodeInfo`/`TreeNodeKind` protocol types, `treeState`/`queryTree` wire messages,
      `tree-view.ts` + tests, `TreeView.svelte`, `store.treeOpen`/`tree` state + `openTree`/
      `closeTree`/`toggleTree`, the `⌘⇧T` hotkey + header IconButton, the `/tree` slash-command
      interception, `e2e/tree.e2e.ts`, and `mockTree()` fixture. The inline rewind buttons +
      `⌘⇧↑` hotkey in Transcript.svelte are untouched.
- [x] **Implement the ready polytoken driver methods.** **Done 2026-07-02:** implemented
      `setClientPresence` (module-level `hasClients` predicate with deny-safe `() => true`
      default, updated by the hub at construction) and `clearQueue` (async: snapshots the
      pending queue via `GET /turn/input`, drains via repeated `DELETE /turn/input/newest`,
      returns all texts in `followUp` since the daemon has no steer/followUp discriminator,
      emits an empty `queueUpdated` so client trays clear). The `PilotDriver.clearQueue`
      interface was widened from sync to `Promise<{steering, followUp}>` and the hub's
      `restoreQueue` case now awaits it via a fire-and-forget async IIFE (matching the
      `acceptPrompt` pattern); the mock driver and hub test stub were made `async` to match.
      `subscribeTrust`/`respondTrust` were **skipped** — the daemon's `capability`
      interrogative is already fully wired through the `respondUi` path, and the mock's
      separate trust channel is D12 fiction with no daemon equivalent.
- [x] **⌘↑/⌘↓ prompt navigation should settle in ≤300ms.** The existing hotkeys that jump
      between user prompts in the transcript scroll too slowly — the target prompt should
      be visible and settled (no smooth-scroll animation still in flight) within 300ms.
      Likely needs swapping the smooth scroll for a faster animation duration or an instant
      jump with a brief highlight, rather than the default smooth-scroll behavior.
      **Done 2026-07-01:** replaced the `scrollIntoView({behavior:"smooth"})` in
      `stepPrompt` with an instant `scrollTo` computing the exact target scrollTop
      (clamped to max scroll, mirroring `block:"start"` behavior) — lands within a single
      frame. A brief accent-tinted flash animation (`nav-flash` class, ~600ms) on the
      landed row confirms the jump so the instant scroll isn't disorienting. The flash
      respects `prefers-reduced-motion`. The `progScrollUntil` window for prompt-stepping
      shrank from 800ms→120ms (scrolls are instant now); `settleScroll`/`scrollToBottom`
      keep their own longer windows. E2e polish suite (incl. the prompt-step + anchor
      tests) all green.
- [x] **Visible prev/next-prompt nav element (discoverability).** The ⌘↑/⌘↓ prompt
      navigation is invisible to a new user. Add a small floating prev/next control (↑↓
      arrows or chevrons) that fades in when the cursor/scroll position is in the transcript
      area, giving a visible affordance for jumping between user prompts. Should not be
      persistent (would clutter) — fade in on transcript focus/hover, fade out otherwise.
      Needs a tooltip (repo rule).
      **Done 2026-07-02:** added a floating prev/next nav control inside `transcript-wrap`
      in `Transcript.svelte` — two chevron buttons (↑ prev, ↓ next) positioned on the right
      edge, vertically centered. Always mounted with an opacity toggle (not `{#if}`) so the
      fade-out works symmetrically with the fade-in. Fades in on `transcript-wrap`
      hover/focus-in, fades out on mouse leave/focus-out. Also stays visible while actively
      stepping (`navIndex !== null`). On touch devices (`pointer: coarse`) the control is
      always visible (hover doesn't apply) with 44px touch targets. Each button has a
      tooltip naming the action + shortcut ("Previous prompt (⌘↑)" / "Next prompt (⌘↓)").
      E2e test in `polish.e2e.ts` verifies the buttons exist with correct tooltips and
      clicking them steps through prompts.
- [x] **Session-tree view hangs on "Loading tree…" forever.** `getTree` unimplemented →
      `hub.ts:882` (`sendTree`) early-returns with no `treeState`; the client only clears its
      loading state on `treeState` (`TreeView.svelte:193`). Same guard disables the
      post-branch tree refresh (`hub.ts:901`). **Note:** the daemon has no `/tree` HTTP
      endpoint — build it from `GET /history`. Defense-in-depth: have `sendTree` emit an
      explicit empty/"unsupported" `treeState` (or the client time out) so it degrades
      instead of hanging.
      **Fixed 2026-07-01 (defense-in-depth):** `sendTree` now emits an explicit empty
      `treeState` (nodes: [], leafId: null) when `getTree` isn't implemented, so the TreeView
      degrades to "No history in this session yet." instead of hanging on "Loading tree…".
      The `getTree` implementation (projecting from GET /history) is tracked under the
      mock-only-driver-methods TODO above — it's implementable but not yet done.
      **Moot 2026-07-01:** the entire tree view was removed (see "Remove tree view entirely"
      above). `getTree`, `sendTree`, `treeState`, and `TreeView.svelte` no longer exist.
- [x] **"Branch from this prompt" = irreversible history deletion, no guard.** `branchFrom` →
      `POST /rewind` (`polytoken-driver.ts:1051`: "NOT a branch — it's a destructive REWIND"),
      which drops the target prompt and everything after. The button says *Branch* and there
      is no confirmation anywhere on the path (`Transcript.svelte:698` → `store.branch`
      `store.svelte.ts:1464` → `/rewind`). **Fix (two parts):**
      1. **Relabel "Branch" → "Rewind"** everywhere it appears — tooltips, aria-labels, and
         visible text (`Transcript.svelte:702-704`, `TreeView.svelte:116`). The daemon does a
         destructive rewind, not a branch; the label should say so.
      2. **Click-twice confirm gate (no popup).** First click arms the button into a
         "Click again to rewind" state (with a visual change — e.g. color shift to
         destructive red + the armed label); second click within a timeout window (~3s) fires
         the rewind. No confirmation dialog/popup — this is a phone-first PWA.
      **Fixed 2026-07-01:** both parts implemented — relabeled "Branch" → "Rewind" in all
      tooltips/aria-labels/visible text (Transcript + TreeView), added click-twice confirm
      gate (first click arms with destructive-red styling + updated tooltip, second click
      within 3s fires, auto-disarms on timeout). The ⌘⇧↑ hotkey bypasses the gate (deliberate
      keyboard gesture). E2e tests updated + passing.
- [x] **Images are silently dropped by the live driver.** Client image pipeline is real
      (compress/paste/drag-drop/heic), but `polytoken-driver.ts:723` drops the `_images`
      param and the daemon `/prompt`/`PromptRequest` has no image channel — so attaching images
      is a silent no-op live. **Fix:** check whether the daemon protocol supports content
      blocks; if so, wire images through; if not, surface an "images not supported" hint
      instead of silently dropping.
      **Fixed 2026-07-01:** the daemon's `PromptRequest` still accepts only `content: string`
      (no image channel), so images can't be sent to the model yet. The driver now (a) echoes
      images into the `userMessage` event so the operator sees what they attached in the
      transcript, and (b) emits a warning notice ("N images attached but the daemon doesn't
      support images yet — only the text was sent") instead of silently dropping them. When
      the daemon grows image support, the notice can be removed and images threaded to
      `POST /prompt`.
- [x] **Plan-review signals are swallowed.** `plan_review_required`/`plan_mode_reinforcement`/
      `plan_verification` events (in `wire-types.ts:2590-2596`) have **no case** in
      `event-map.ts` — they hit the `default:` arm → `console.warn` + `EMPTY`. The operator
      gets no signal a review is required. The plan doc + `plan_handoff` approve are solid
      (tested). **Fix:** add visible cases for the plan-review slugs; consider a dedicated
      tool card for `write_plan`/`edit_plan` (currently generic).
      **Fixed:** the `system_reminder` case (`event-map.ts:1056-1073`) checks
      `PLAN_REVIEW_LABELS` for the three plan-review slugs and surfaces them as visible
      `customMessage` events (display:true) so the operator sees "Plan review required" /
      "Plan mode reminder" / "Plan verification" in the transcript.
- [x] **Spurious error on every new session.** `newSession` applies the model on create even
      when it equals the default → `POST /model` 409 `no_change` logged as error
      (`polytoken-driver.ts:993`). Fix in `daemon-client.ts` `setModel` (`:768-771`): treat
      409 whose body `code === "no_change"` as success — but note `post()` (`:525`) reads a
      nonexistent `error` field; must read parsed `data.code` (`ErrorBody` uses `code`/
      `message`). 409 also means `turn_in_flight`/`edit_format_locked`, so key on the **code**,
      not the status.
      **Fixed:** `setModel` (`daemon-client.ts:792-798`) already treats 409 `no_change` as
      success, and `post()` (`daemon-client.ts:523-551`) already reads `data.code`/`data.message`
      from parsed JSON (not a nonexistent `error` field).
- [x] **Login-shell env not propagated to daemon at spawn (real bug).** The daemon is
      spawned via `Bun.spawn` with **no `env` option** (`daemon-client.ts:188` for new,
      `:235` for resume), so it inherits pilot's own `process.env` directly. When pilot is
      launched by the desktop `.app` bundle, that env is the GUI launchd context — typically
      a minimal PATH (`/usr/bin:/bin`), no nvm/brew paths, etc. — so the daemon's `shell_exec`
      tool has a broken PATH. The `loginShell` setting in Settings was *designed* to fix this:
      the old in-process driver ran `<shell> -l -i -c env` to capture a login env and merged it
      into `process.env`. That reconstruction code is gone on this branch (`login-env.ts:6-8`
      documents it as dead); only the shell-resolution + status-surfacing fns survive, and
      `getLoginEnvStatus()` returns a static "not captured" forever (`login-env.ts:14`).
      Meanwhile the hub still warns when the configured shell differs from the active one
      (`hub.ts:944`) — a warning about a setting that does nothing.
      **Fix:** at daemon spawn time (`spawnNewDaemon`/`spawnResumeDaemon` in
      `daemon-client.ts`), if a `loginShell` is configured, run `<shell> -l -i -c 'env'`
      (reusing `resolveLoginShell` from `login-env.ts`) to capture the login env, then pass it
      as `env: {...process.env, ...capturedLoginEnv}` to `Bun.spawn`. Update
      `getLoginEnvStatus` to reflect the captured state. The `backgroundModel` setting is
      separate (which model the daemon uses for background tasks) and also not forwarded —
      that one is closer to genuinely dead-by-design and can be labeled or wired separately.
      **Fixed:** the full chain is implemented — `captureLoginEnv` runs at driver construction
      (`polytoken-driver.ts:171`), `setLoginEnvStatus` updates the live status (line 174),
      `loginEnv` is passed to `spawnDaemon` (line 428), and both `spawnNewDaemon`
      (`daemon-client.ts:201-203`) + `spawnResumeDaemon` (`daemon-client.ts:253-255`) merge it
      as `env: { ...process.env, ...opts.loginEnv }`.

Already addressed from the same audit (kept as record):

- [x] **Mid-turn steer/follow-up now queues correctly.** `prompt()` calls
      `ws.client.queueTurnInput(text)` when `turn_in_flight` is true instead of starting a
      fresh turn (`polytoken-driver.ts:745-746`). Addressed during the parity analysis run;
      not yet verified by a human. The `deliverAs` param is acknowledged as pilot-side UX
      only — the daemon's queue API has no steer/follow-up discriminator.
- [x] **Permission-monitor mode UI is code-complete.** Full round-trip wired:
      `PermissionBadge.svelte` (mounted in the Composer toolbar between image-attach and
      FacetBadge) → `store.setPermissionMonitor` → WS → hub → driver → `POST /permission-monitor`;
      daemon `permission_monitor_switch` SSE → `event-map.ts:1049` emits `sessionUpdated`
      with `snapshot.permissionMonitor` → `foldEvent` (`state.ts:246`) → badge. Initial mode
      seeded via `GET /permission-monitor` at warm-up (`polytoken-driver.ts:434`). Code-
      complete; not yet verified live by a human (the audit was done under `bypass_plus`).

## 🟢 Polytoken parity — new todos (2026-07-01)

New parity/UX items from the owner, grounded against current source.

- [x] **history-seed drops 9 of 12 history item kinds — reloaded transcripts lose
      reminders, compaction rows, model/facet switches.** `history-seed.ts` replays only
      `user`/`assistant`/`tool_result`; the other persisted kinds (`system_reminder`,
      `compaction_fencepost`, `model_switch`, `facet_switch`, `context_cleared`,
      `state_update`, `classifier_decision`, `image_reference`, `session_lifecycle`) are
      silently skipped. Live, `system_reminder` becomes a `customMessage` (turn-boundary
      marker + visible plan-review pills, `event-map.ts:1077`), so a reload degrades turn
      grouping and drops the pills; compaction fenceposts (a roadmap SHOULD: "compaction
      rows") and model/facet switches vanish too. Fix: map the missing kinds in
      `history-seed.ts` to the same driver events the live path emits (at minimum
      `system_reminder`→`customMessage`, `compaction_fencepost`→visible compaction row,
      `model_switch`/`facet_switch`→`sessionUpdated` metadata or a small notice row).
      Verified against unstable.4 openapi + vendored wire-types:1922 (kinds identical in
      both). _Replaces upstream ask #9 (withdrawn — the daemon persists these fine; the
      drop is ours). Fable, 2026-07-01._
      **Done 2026-07-02:** mapped 6 of 9 missing kinds in `history-seed.ts`:
      `system_reminder`→`customMessage` (same as live path, with `PLAN_REVIEW_LABELS`
      visibility), `model_switch`→`sessionUpdated` with `config` (using `defaultModelRef`),
      `facet_switch`→`sessionUpdated` with `facet`, `compaction_fencepost`→visible
      `customMessage`, `context_cleared`→visible `customMessage`, `session_lifecycle`→
      non-display `customMessage` (turn-boundary marker). The remaining 3
      (`state_update`, `classifier_decision`, `image_reference`) are metadata-only with no
      transcript representation in the live path either — they stay skipped. `PLAN_REVIEW_LABELS`
      exported from event-map for reuse. Test updated from "skipped" to "mapped to live
      equivalents".

- [x] **Thinking blocks: always collapsed-by-default + always expandable; re-scope
      `hideThinking` to control only superseded blocks.** Today `store.hideThinking`
      (default on) hides thinking blocks *entirely* — `Transcript.svelte:743` gates
      `{#if item.thinking && !store.hideThinking}`, and `filterHiddenThinking`
      (`transcript-view.ts:68-72`) drops thinking-only assistant items so they leave no
      stub at all. The `ThinkingBlock.svelte` component itself already starts collapsed
      (`open = $state(false)`) and is expandable via its header button — so the
      collapsed-default + expandable behavior is already correct *when a block renders
      at all*. The change is two-fold:
      1. **Always render thinking blocks** (collapsed, expandable) — remove the
         `&& !store.hideThinking` gate at `Transcript.svelte:743` and stop filtering
         thinking-only items out in `filterHiddenThinking` (`transcript-view.ts:72`).
         Every thinking block is visible as a collapsed stub by default; the user can
         always expand it.
      2. **Re-scope the setting's meaning.** `hideThinking` should control whether
         *older* thinking blocks — those that have had other output happen since — are
         displayed. The most recent / still-active thinking block always shows
         (collapsed); older ones are hidden when the setting is on. This replaces the
         current all-or-nothing hide. The setting label/tooltip in Settings.svelte
         (`:281`) should reflect the new semantics ("Hide older thinking blocks").
      Rationale: the current default silently discards all thinking, so the operator
      can never expand a past thought process. The new default shows everything as
      collapsed stubs (low visual cost) with on-demand expansion, and the setting
      only trims the stale ones that have been superseded by later output.
      **Done 2026-07-02:** `filterHiddenThinking` now only drops *superseded*
      thinking-only items (not the most recent) when `hideThinking` is on — the most
      recent thinking block always survives. The `Transcript.svelte` rendering gate now
      uses a `visibleThinkingIds` derived (null when thinking is visible = show all;
      otherwise a Set with the last thinking item's ID) instead of the blunt
      `!store.hideThinking` check. The Settings label changed to "Hide older thinking
      blocks" with updated tooltip/description. Unit tests updated (5 cases covering
      superseded drop, keep-most-recent, keep-with-text, no-op, no-thinking). E2e tests
      updated in `streaming.e2e.ts` (collapsed stub visible + expandable) and
      `transcript.e2e.ts` (1 of 3 thinking-only blocks survives as collapsed stub).

- [x] **Compaction: context-meter hover popup + pass-through `/compact` + clear-context
      button (both click-twice confirmed).** **Done 2026-07-02:** `ContextMeter.svelte` is
      now an interactive hover/tap popup (mirrors `TaskList.svelte`'s hover/pin pattern)
      showing token counts, a progress bar, and two destructive buttons — **Compact**
      (`POST /compact`) and **Clear context** (`POST /clear`) — each behind a
      click-twice confirm gate (mirrors `Transcript.svelte`'s rewind gate: first click
      arms with destructive red + "Click again" label, second click within 3s fires,
      auto-disarms on timeout). Full stack wired: `compact`/`clearContext` wire messages
      → `PilotDriver.compact?`/`clearContext?` → polytoken driver (calls daemon
      `POST /compact`/`POST /clear` + fetchState) + mock driver (emits `usageUpdated`)
      → hub fire-and-forget dispatch → store methods. The popup opens on hover (desktop)
      or tap (touch, pinned open so buttons are reachable). The `/compact` slash command
      stays as a power-user path. E2e tests cover popup content + both confirm gates.
      The `data-testid="context-meter"` stays on the inner `ContextRing` so existing
      meter tests remain green.

- [x] **Show all available facets** (`polytoken vfs ls polytoken://facets`). The session
      snapshot exposes `available_skills` and `available_subagents`
      (`wire-types.ts:2635-2636`) but **no `available_facets`**. The current `FacetBadge`
      (`FacetBadge.svelte`) hardcodes execute ↔ plan (toggling via `Shift+Tab` /
      `store.setFacet`). To show all available facets, shell out to
      `polytoken vfs ls polytoken://facets` and expose the list. The `FacetBadge` would
      then become a picker (dropdown/menu) listing all facets rather than a two-state
      toggle. The `setFacet` wire path (`store.svelte.ts:1924`) already passes an arbitrary
      string, so no protocol change is needed for the send side.
      **Decided 2026-07-01:** approach (a) — shell out to `polytoken vfs ls`. Call it
      once on each new session open (not just warm-up), and provide a daemon-reload
      affordance (see the dedicated todo below).
      **Done 2026-07-02:** `listFacets` method on `PilotDriver` (polytoken driver
      shells out to `polytoken vfs ls polytoken://facets`, cached per cwd like
      `commandsCache`; mock returns `["execute", "plan"]`). `facetList` wire event
      (server→client, pushed on connect + session switch) + `listFacets` wire message
      (client→server, for reload). `store.facets` state. FacetBadge converted from a
      toggle to a dropdown picker (badge + panel with keyboard nav, mirroring
      PermissionBadge). Shift+Tab still toggles execute/plan. E2e tests for picker +
      reload.
- [x] **Facets list reload affordance.** When facets are added/removed on disk (e.g. the
      operator edits a facet file while a session is open), the cached `available_facets`
      list goes stale. Add a reload button or menu action that re-runs
      `polytoken vfs ls polytoken://facets` and refreshes the FacetBadge picker. Pairs with
      the "show all available facets" todo above.
      **human input**: this could be in the settings tbh, or in the sidebar at the bottom. doesn't need to be prominent
      **Done 2026-07-02:** "↻ Reload facets" button at the bottom of the FacetBadge
      picker panel. Calls `store.refreshFacets()` which sends a `listFacets` wire
      message → hub calls `driver.listFacets()` (no cache — always re-shells-out) →
      `facetList` event refreshes the picker. E2e test verifies the button works.

- [x] **Ctrl+R prompt-history popup** (polytoken TUI parity — nice-to-have polish,
      bottom of parity work). The polytoken TUI offers a ctrl+r popup showing a few
      previous prompts above the text field; pressing enter fills the field with the
      selected text. Add the same: a ctrl+r handler in the composer that opens a small
      popup of recent prompts (from the transcript's user messages) above the textarea,
      arrow-key navigate, enter fills the composer. **Stretch:** also use this to jump
      to the selected prompt's position in the chat history (scroll the transcript to
      it + highlight). Both the popup-fill and the jump-to-history are polish; this is
      the lowest-priority item in the parity list — do it last.
      **Done 2026-07-02:** Ctrl+R opens a `PromptHistoryMenu` popup above the textarea
      showing recent prompts (from `store.currentPromptHistory`, newest first). Arrow
      keys navigate, Enter fills the composer, Escape closes. Repeated Ctrl+R cycles to
      the next entry (like the TUI). The popup mirrors `SlashMenu`'s pattern
      (presentational component, Composer owns the state machine). E2e tests verify
      the popup opens, fills on Enter, and closes on Escape. The jump-to-history
      stretch goal is deferred (would scroll the transcript to the selected prompt).

- [ ] **Full-featured config editor** (very late / stretch). `polytoken schemas
      [app-config, agents-frontmatter, facet-frontmatter, subagent-frontmatter,
      skill-frontmatter, permissions-config]` exposes the full JSON schema for each
      config domain. A future Settings surface could shell out to `polytoken schemas`
      to render a form-driven config editor with validation (pairing with `polytoken
      validate` from the existing config-validation todo above). This is a large,
      open-ended feature — defer until the rest of the parity work is done and the
      simpler per-domain surfaces (facets picker, skills/subagents views) have shipped.

- [x] **MCP server management UI.** **Done 2026-07-02:** added a new "MCP" tab to
      Settings (Alt+6) showing each server's name, status badge (colored dot),
      and tool count. Action buttons — Enable (if disabled), Disable + Disconnect
      (if connected), Reconnect (if disconnected/reconnecting) — are fire-and-forget
      calls to the daemon's `POST /mcp/{server}/{action}`. Full stack wired:
      `setMcpServer` wire message → `PilotDriver.setMcpServer?` → polytoken driver
      (calls daemon POST + fetchState) + mock driver (updates local state) → hub
      fire-and-forget dispatch → store method. The 4 lifecycle events
      (`mcp_server_connected/disconnected/reconnecting/disabled`) are un-swallowed
      from `return EMPTY` and mapped to `hostUiRequest{kind:"notify"}` notices
      (info/warning). Server status is threaded from the daemon state's
      `mcp_servers` into the snapshot via `snapshotFromState` and through the fold
      reducer's overwrite-guard. OAuth start/callback is deferred — only
      enable/disable/reconnect/disconnect are wired.

- [x] **`eager_fallback_activated` event is swallowed — operator sees model change but
      not why.** When the daemon auto-switches to a fallback model (e.g. the primary is
      down/rate-limited), `model_switch` fires (so the picker updates), but the companion
      `eager_fallback_activated` event (`wire-types.ts:3082`) has no case in `event-map.ts`
      and hits the `default:` → `console.warn`. The operator sees the model silently change
      with no explanation. Surface a notice ("⚠ Auto-switched to fallback model: …") so
      the reason is visible. Quick fix: add a case in `event-map.ts` that emits a warning
      `hostUiRequest{kind:"notify"}`.
      **Done 2026-07-02:** `eager_fallback_activated` is not a top-level `DaemonEvent` —
      it's a `ToolExposureReason` carried by the `tool_exposure_changed` event. Pulled
      `tool_exposure_changed` out of the `return EMPTY` group and added a check on
      `ev.reason.type`: when `eager_fallback_activated`, emits a warning notify
      ("Auto-switched to a fallback model — the primary may be down or rate-limited").
      Other reasons (model_changed, facet_changed, etc.) stay EMPTY. Tests added for both
      the fallback case and the non-fallback passthrough.

- [x] **`agent_block_violation` event is swallowed.** If the agent violates a block
      constraint, the operator gets no signal — the event (`event-map.ts:1209` in the
      `return EMPTY` group) is silently dropped. Should surface as a visible warning
      (notify card or transcript notice) so the operator knows a violation occurred.
      Low frequency but a safety signal worth surfacing loudly (crash-don't-corrupt
      philosophy).
      **Done 2026-07-02:** pulled `agent_block_violation` out of the `return EMPTY` group
      and added a case that emits a warning notify naming the blocked tool
      ("Blocked: the agent tried to use {tool_name}, which is blocked by a constraint").
      Test updated from `-> empty` to `-> warning notify naming the tool`.

- [x] **Notification autodrain toggle.** The daemon has `GET/POST /notification-autodrain`
      (`wire-types.ts:437`) + `notification_autodrain_switch` / `notifications_drained`
      events, all currently swallowed (`event-map.ts:1184–1185` → `EMPTY`). The TUI surfaces
      this as a toggle (autodrain non-blocking notifications). Minor but a real feature
      the daemon exposes that pilot doesn't surface — add a Settings toggle and wire the
      events to update the cached state (mirror `permission_monitor_switch`'s pattern).
      **Done 2026-07-02:** full stack wired — `getNotificationAutodrain` +
      `setNotificationAutodrain` daemon-client methods, `autodrainEnabled` cache field on
      `WarmSession` (seeded at warm-up like `monitorMode`), `notification_autodrain_switch`
      event pulled from the EMPTY group (now emits sessionUpdated + `setAutodrainEnabled`
      effect, mirroring `permission_monitor_switch`), `notificationAutodrain` on
      `SessionSnapshot` + `SessionState` (overwrite-guarded fold), `setNotificationAutodrain`
      wire message + hub handler + driver methods (polytoken + mock), Settings toggle in
      the Notifications section, and e2e test. `notifications_drained` stays EMPTY
      (informational — no UI action needed).

- [x] **Adventurous handoff.** `GET/POST /adventurous-handoff` exists
      (`wire-types.ts:7`), `adventurous_handoff_active` is on the snapshot
      (`wire-types.ts:2626`), pilot never reads it. Niche — only surface if dogfooding
      shows a need. Track so it's not forgotten.
      **human input**: yeah we need this. it allows plan mode to autonomously start implementing the plan, essential for hands-off work on tasks while still getting the benefits from organized plan->execute work
      **Done 2026-07-02:** full stack wired — `toggleAdventurousHandoff` daemon-client
      method (POST /adventurous-handoff), polytoken driver method (toggles then
      fetches state for the computed `adventurous_handoff_active`), mock driver method,
      `PilotDriver` interface, hub handler, `toggleAdventurousHandoff` wire message,
      `adventurousHandoff` on `SessionSnapshot` + `SessionState` (overwrite-guarded
      fold like `permissionMonitor`), `snapshotFromState` threading, Settings toggle in
      the Appearance section, and an e2e test verifying on/off cycle.


## 🟢 Polish / fast-follow


- [x] **Remove `mergeTools` — every tool call renders as its own card (keep turn-level "Worked for Ns").**
      `client/src/lib/transcript-view.ts` has two collapse layers: Pass-1 `mergeTools` folds runs
      of "summarizable" tools into a single `MergedToolsItem` (rendered as a prose `<ToolSummary>`
      card "Read 2 files, ran 3 commands"), and Pass-2 `groupTurns` folds a turn's early work behind
      the "Worked for Ns" header. The inner `mergeTools` layer is the one to **delete entirely** —
      no threshold, no special-casing. Each tool call stays as an individual `ToolItem`; polytoken's
      ≤4-calls-per-text-boundary already keeps groups small and self-bounded, so the prose merge
      just over-collapses distinct steps into one opaque line. The outer `groupTurns`/`WorkLane`
      collapse ("Worked for Ns") is **kept as-is**: `isWorkTool` already matches plain `tool` cards,
      so a finished turn's early work still folds behind the header and the final response stays
      visible. Concretely: delete `mergeTools`, `MergedToolsItem`, `isSummarizedTool`, `sealed`,
      `mergeTrailing`, `buildMerged`, and the `ToolSummary` rendering path; remove `mergeTools` from
      the `Transcript.svelte` pipeline (it currently calls `mergeTools` then `groupTurns`). Update
      `transcript-view.test.ts` — the `mergeTools` suite should be removed; `groupTurns` tests stay
      but must assert plain `ToolItem`s instead of `MergedToolsItem`s. 2026-07-01.
      **human comment:** this paragraph was written by an agent summarizing my short instructions.
      i think this might have been a misunderstanding - my intent was to _never_ merge single tool calls (e.g. 1 bash, 2 reads) into a single line, but keep merging the early part of a _turn_ into the "worked for <time>" summary.
      **Already done:** `mergeTools`, `MergedToolsItem`, `ToolSummary`, and `isSummarizedTool` are
      completely gone from the codebase. Only `groupTurns`/`WorkLane`/`isWorkTool` remain — exactly
      the behavior the human comment describes (individual tool cards, turn-level "Worked for Ns"
      summary preserved).
- [x] **Right-side sidebar: flagged files, todos, async jobs (polytoken TUI parity).** The
      polytoken TUI shows a right-hand sidebar with live session context the daemon already
      exposes over HTTP but pilot never surfaces. Sources (all in
      `server/src/polytoken/wire-types.ts`):
      - **Flagged files** — `SessionStateSnapshot.flags: FlagEntry[]` (`:2354`), each
        `{path, mode}` where `FlagMode = "included" | "referenced"` (`:1438`). Already carried
        on every `/state` fetch; pilot just doesn't read it.
      - **Todos** — `SessionStateSnapshot.todos: TodoSnapshot[]` (`:2364`), each with
        `{description, dependencies[], …}` (`:2655`), and live `todo_create/update/complete/
        deleted` + `todo_status_nudge` events (`:2457–2475,2587`).
      - **Async jobs (subagents etc.)** — `JobStatus` (`:1588`, statuses `reserved/running/…`)
        surfaced via the `top-level background jobs` field (`:3424`).
      Also possibly **session diffs** (stretch goal — the user said "leave that as a maybe"):
      `SourceControlSnapshot` (`:2363`) is on the session snapshot. Needs: read these off the
      daemon's `/state` (and the live events), project them onto `SessionState` (overwrite-
      guarded like `facet`/`queued`, `protocol/src/state.ts:235–245`), and a new right-drawer
      component (mirror the left `Sidebar.svelte` scrim+dialog pattern). Flagged-files + todos
      are the concrete ask; jobs + diffs are stretch. The `investigated and NOT changed` note
      on the old `Bulletproof queued-message delivery` item covers the queue plumbing this
      depends on. 2026-06-30.
      **Implemented 2026-07-01 (flagged files + todos):** full data path wired —
      `FlaggedFile`/`TodoItem` protocol types, `snapshotFromState` threading, overwrite-guarded
      `foldEvent`, `RightSidebar.svelte` drawer component (desktop column + mobile slide-in),
      `⌘⇧J` hotkey + StatusHeader toggle button, mock `context` script, 3 e2e tests. Jobs
      (stretch) deferred — no `jobs` field on `SessionStateSnapshot` (needs `GET /jobs` or
      event-fold). Live todo events (`StateDelta`, not `DaemonEvent`) also deferred — todos
      update on snapshot refresh only. Session diffs (`SourceControlSnapshot`) deferred.

- [x] **Hotkey for permission mode selector.** The permission monitor mode UI
      (`PermissionBadge.svelte`, mounted in the Composer toolbar) is clickable but
      has no keyboard shortcut — every UI action needs a hotkey (repo rule). Add a
      hotkey that cycles/cycles through permission modes, with a tooltip naming the
      shortcut.
      **Done 2026-07-02:** added `⌘⇧M` (Ctrl+Shift+M) global hotkey in `App.svelte`
      that cycles permission monitor mode: Standard → Bypass → Autonomous → Standard
      (wraps). The `PermissionBadge` tooltip now names the shortcut
      ("Permission mode: {mode} — click to switch (⌘⇧M)"). E2e test in
      `permission.e2e.ts` verifies the cycle wraps correctly.

- [x] **Find out where the effort toggle has gone.** The effort/thinking-level toggle
      (previously exposed in the pi driver era) is no longer visible in the UI.
      Investigate whether the polytoken daemon exposes an effort/thinking-level
      setting and whether pilot's UI surface for it was removed or just went missing.
      If the daemon supports it, re-add the UI control; if not, confirm it's gone
      for good and document why.
      **Investigated 2026-07-02:** the effort/thinking-level toggle IS present and
      working — it lives inside the ModelPicker component as a sub-picker (the
      "medium"/"high" badge next to the model badge in the composer toolbar). The
      daemon exposes `reasoning_effort` via `POST /model` (the `setModel` daemon-client
      method accepts an optional `reasoningEffort` parameter) and the session snapshot
      carries `active_reasoning_effort`. The `model_switch` event also carries
      `to_reasoning_effort`. The thinking picker is exercised by e2e tests
      (`models.e2e.ts:64` — "the thinking picker switches the level" + `models.e2e.ts:117`
      — "⌘⇧E focuses the thinking menu"). The TODO's "no longer visible" observation
      was outdated — the thinking picker was re-added during the polytoken migration.

- [x] **Queued/follow-up prompts added to transcript immediately but not actually
      submitted.** When a user sends a follow-up prompt mid-turn (while
      `turn_in_flight` is true), pilot immediately renders it as a user message
      bubble in the transcript — but the prompt may not actually be reaching the
      agent successfully. The prompt should instead be displayed **separately**
      (as a pending/queued indicator, the way the pi driver did it) and only
      folded into the transcript history once the agent actually receives/processes
      it. The polytoken TUI does exactly this: a queued prompt is held by the
      daemon and delivered cleanly once the previous turn finishes (confirmed by
      detach → reattach → prompt arrives after the turn completes). So the daemon
      API supports it; pilot just needs to mirror the TUI's queue display
      behavior. Fix: stop eagerly adding queued prompts to the transcript; show
      them as a separate pending state and merge them into history on actual
      delivery/acknowledgement by the daemon.
      **Done 2026-07-02:** added a `midTurn` flag to `PendingPrompt` — set when
      `turnActive` is true at send time. `transcriptItems` now filters out mid-turn
      prompts (they no longer render as transcript bubbles). The daemon's queue
      (`QueueTray`) shows them as pending instead. When the daemon dequeues and
      processes the prompt, the `userMessage` event arrives and the prompt joins the
      transcript naturally (the `existing.has(promptId)` reconciliation removes the
      optimistic placeholder). Queue e2e tests still pass.

## Bug reports (from claude fable, not human verified)

- [x] today's hub must fold server-side to serve snapshots — so a Rust hub either re-implements foldEvent (reviving the dual-fold drift the shared reducer exists to prevent) or embeds JS. The clean resolution: seed-events-on-connect — send {type:'seed', events} and let clients fold from zero. That deletes the server-side fold dependency, structurally fixes the live-vs-replay ID flicker on reconnect, and is the same machinery a seq/resume protocol needs.
      **Fixed 2026-07-02 (protocol v2, five commits):** per-session seq/epoch-stamped event journal in the hub (`server/src/journal.ts`) is now the seed source + resume ring; connect/switch send `{type:"seed", events, epoch, seq}` and clients fold from zero (PROTOCOL_VERSION 2 — the hello check catches stale PWAs); `hello.resume` tail-replays just the gap on reconnect (phone wake no longer re-ships the transcript); `requestSeed` covers client-detected gaps; `/debug/state` folds on read. The wire `snapshot` type is deleted — no server-side fold is client-visible anymore (Rust-hub blocker #1 cleared). Design + as-built deltas: `docs/PLAN-protocol-v2.md`.
- [x] Reseed is a silent no-op — polytoken-driver.ts:375 calls reseedFromHistory(ws, /*emitOpened*/ false), but the second param is actually emitEvents. The comment above says "Re-broadcast the FULL transcript" — it broadcasts nothing. So /clear, rewind, and stream_discontinuity recovery refresh the driver's cache but connected clients keep stale transcripts. The proper fix needs a driver→hub reset channel (naively passing true would duplicate the transcript, since the fold is additive).
      **Fixed 2026-07-02:** added a `sessionReset` `SessionDriverEvent` type that clears `state.items` in the fold (preserving metadata like ref/title/config). The reseed effect handler now calls `reseedFromHistory(ws, false)` to refresh the cache, then emits `sessionReset` followed by the fresh transcript events. The hub folds `sessionReset` normally (clears items), then the subsequent events rebuild the transcript into the empty state. No duplication, no stale transcripts. The `emitEvents` parameter (the "silent no-op" bug) is now irrelevant — the driver always emits the fresh events itself after the reset.
- [x] Pending interrogatives are never recovered — the daemon exposes pending_interrogatives on GET /state exactly so a reconnecting client can re-render blocked approvals; nothing in the repo reads it (only the generated type mentions it). An approval pending across a server restart or re-warm = permanently wedged "Working…" with no card.
      **Fixed 2026-07-02:** `seedFor` now calls `recoverPendingInterrogatives(ws)` after seeding the transcript. This reads `pending_interrogatives` from the cached `lastState` (from `GET /state`), passes each through `mapDaemonEvent` to produce the `hostUiRequest` card, and executes the `registerInterrogative` effect so `respondUi` can build the reverse response. The cards appear in the seed events alongside the transcript, so a reconnecting client re-renders blocked approvals immediately.
- [x] No SSE reconnect, no liveness, no daemon-exit watcher — the subscribe loop just ends on error; nobody re-subscribes or tells the hub. The id: SSE lines aren't even parsed. A warm session can die silently.
      **Fixed 2026-07-02:** rewrote `subscribe()` in `daemon-client.ts` with (1) automatic re-subscribe with exponential backoff (1s → 2s → 4s → … → 30s cap) on error or stream end, (2) a liveness watcher that aborts the current fetch if no SSE frame arrives for 60s (the daemon's SSE is push-only with no heartbeats on an idle daemon), (3) a synthetic `stream_discontinuity` envelope emitted on reconnect so the driver re-seeds via the existing event-map → reseed path, (4) `id:` line parsing for `Last-Event-ID` header on reconnect (daemon support unconfirmed — best-effort; the `stream_discontinuity` → reseed is the real recovery mechanism), and (5) abortable backoff sleep so unsubscribe exits within a microtask. The architecture uses a `stopped` flag + per-attempt AbortController (not controller-swapping) to cleanly separate "abort the current fetch to retry" from "stop the loop entirely."
- [x] N4 is worse than documented — rawSend discards ws.send()'s return and the hub's try/catch around broadcast is dead code (Bun signals drop by return code, not throw). Also: the switchTo window (two HTTP round-trips) loses deltas for a streaming background session you focus — an unlisted race.
      **Partial fix 2026-07-02:** `rawSend` now checks `ws.send()`'s return value via `sendOrClose()` (`server/src/ws-send.ts`) — on a `0` (dropped) it closes the socket (1011), forcing a reconnect + fresh snapshot. The hub's `broadcast` try/catch is kept as a safety net for unexpected synchronous throws, with a clarifying comment.
      **Completed 2026-07-02 (protocol v2):** the close-on-drop path now recovers via `hello.resume` (tail replay of exactly the dropped frames, not a full re-seed), with an explicit `backpressureLimit: 4MB`. The switchTo attach-window race is fixed hub-side: events racing a cold open/reload buffer as a signal and the swap re-runs once (the rebuilt seed contains them); a residual one-fetch-wide window needs the daemon `Last-Event-ID` watermark (upstream ask) — see PLAN-protocol-v2 "as-built deltas".
- [ ] Medium-tier: optimistic userMessage before the POST leaves ghost rows on failure; renaming a cold session hijacks activeSessionId (and spawns a daemon); the idle reaper can kill a session another client is viewing; phone-wake half-open sockets show a green "live" LED over a dead link; ⌘F can't search collapsed "Worked for Ns" bodies (DOM-only search); PROTOCOL_VERSION is sent but never checked (stale cached PWA misfolds silently); /debug/reset is exposed in prod behind only the app token and wipes real settings; reloaded transcripts show "56y ago" (synthetic epoch timestamps — a daemon gap, see ask #1); and the e2e suite asserts mock behaviors the live driver never produces.
      **Partial fix 2026-07-02:** PROTOCOL_VERSION is now checked on `hello` — the client sets `protocolMismatch` and shows a full-screen "Update required" error directing a hard-refresh, instead of silently folding events from an incompatible server. The other 8 issues remain open.

### Hand-backs from the 2026-07-02 overnight-batch review (verified against source 2026-07-02)

- [x] **clearQueue loses queued text on partial drain failure.** `clearQueue`
      (`polytoken-driver.ts:1607-1635`) snapshots the queue, then drains via repeated
      `dequeueNewestInput()` inside one try/catch. If a dequeue fails partway, the catch
      returns `{steering: [], followUp: []}` — the texts of items *already deleted from the
      daemon* are silently dropped instead of restored to the composer — and no
      `queueUpdated` is emitted, so trays keep showing the stale pre-drain queue over a
      partially-drained daemon. Fix: harvest each text as its dequeue succeeds; on partial
      failure return the harvested texts anyway; after any failure re-fetch
      `turnInputSnapshot()` and emit the *real* remaining queue instead of assuming
      empty/stale.
      **Fixed 2026-07-02:** the drain stops at the first failure, then re-fetches the
      daemon's real remaining queue — broadcast as the honest `queueUpdated` — and
      returns the drained texts reconciled **by id** against it (snapshot-vs-newest
      ordering is undocumented, so id-diffing beats counting). Only when the resync
      fetch itself also fails does it fall back to the dequeue-count guess; the texts
      still reach the composer in every path.
- [x] **`bypass_plus` is unreachable and mislabeled in the permission badge.**
      `PermissionMonitorMode` has 4 modes (`protocol/src/session-driver.ts:33`) but
      `PermissionBadge.MODES` lists 3 (`PermissionBadge.svelte:12-20`); in `bypass_plus` —
      the owner's actual daily mode — the badge displays "Standard" via the `?? MODES[0]`
      fallback (line 21), and neither the picker nor the `⌘⇧M` cycle can select it or
      return to it (`findIndex` → -1). Fix: add the 4th entry (check daemon docs for the
      bypass-vs-bypass_plus semantics for the desc) so display, picker, and cycle all
      cover it; e2e-test that the badge round-trips all 4 modes.
      **Fixed 2026-07-02:** added `bypass_plus` as the 4th entry in `PermissionBadge.MODES`
      (label "Bypass+", desc "Auto-approve except deny rules" — from the daemon's config
      schema: `bypass` = allow every call without asking; `bypass_plus` = allow every call
      *except* those your deny rules block). The `⌘⇧M` cycle in `App.svelte` now includes
      all 4 modes (Standard → Bypass → Bypass+ → Autonomous → Standard). Stale comments
      in `PermissionBadge.svelte`, `store.svelte.ts`, and `permission.e2e.ts` updated.
      New e2e test verifies the picker shows all 4 options and round-trips
      Standard → Bypass+ → Autonomous → Standard; the cycle test verifies all 4 steps.
- [ ] **Trust-wiring skip rests on an unverified rationale.** `subscribeTrust`/
      `respondTrust` were skipped on the claim that the daemon's `capability`
      interrogative covers untrusted-dir prompts via `respondUi` and the mock's trust
      channel is D12 fiction (see "Implement the ready polytoken driver methods" above).
      Nobody has run a live untrusted-dir test to confirm. Settle it: open a session in an
      untrusted dir against the real daemon; if the capability path covers it, *remove*
      the dead `TrustCard` + hub trust channel scaffolding rather than leaving it
      permanently dangling; if it doesn't, wire the trust methods after all.
- [x] **SSE liveness watcher reconnect-cycles every idle session (found reviewing the
      2026-07-02 SSE-reconnect commit).** The daemon's SSE is push-only with no idle
      heartbeats (`daemon-client.ts:11-12`), so the 60s no-frame watchdog
      (`daemon-client.ts:1107-1113`) fires on every *idle* session every ~60-120s:
      abort → reconnect → synthetic `stream_discontinuity` → full reseed + `sessionReset`
      re-broadcast to all viewers, forever. Fix: on liveness expiry probe `GET /health`
      (~5s timeout) first — if it answers, reset `lastFrameAt` and do nothing; only
      reconnect when the probe fails/hangs. Also: allocate the `TextDecoder` per attempt
      (split multi-byte chars can corrupt the first frame after a retry). Full review +
      remaining robustness design: `docs/PLAN-driver-robustness.md`.
      **Fixed 2026-07-02 (PLAN-driver-robustness A1):** the watcher now probes
      `GET /health` (bounded by `livenessProbeTimeoutMs`, 5s) on expiry — an
      answering daemon resets `lastFrameAt` and the stream is left alone; only a
      failed/hung probe aborts + reconnects. A `probing` flag prevents stacked
      probes. `TextDecoder` is now allocated per attempt. The windows are
      public knobs (`livenessIntervalMs`/`livenessProbeTimeoutMs`) so the two new
      unit tests run in milliseconds: idle+healthy → exactly 1 `/events` fetch
      across 6 periods, zero discontinuities; idle+hung-probe → reconnect +
      `stream_discontinuity` emitted.
- [x] **Minor: `hasClients` comment mislabels fail-open as deny-safe.** The default
      `() => true` (`polytoken-driver.ts:208`) means "assume someone can answer" — that is
      fail-open; the comment calls it "deny-safe = don't block". Reword when the first
      read site lands (the inline TODO already tracks that no read site exists).
      **Fixed 2026-07-02:** comment reworded to name the default fail-open and say why
      (never auto-deny just because the hub hasn't registered the real predicate yet).

### Fix-chips converted to TODO entries (2026-07-02, owner request)

- [x] **`Alt+1..5 jump between section tabs` e2e fails on trunk.**
      `e2e/settings.e2e.ts:216` fails with `expect(locator).toHaveAttribute` (repro:
      `bun run test:e2e settings`; 11 of 13 pass, this is the only failure). It's the
      last survivor of the 3-failure fix-chip from the 2026-07-02 batch — the two facet
      ones (`facet-switch.e2e.ts:15`, `plan-handoff.e2e.ts:65`) were fixed by the
      facet-picker commit `lopxtlxq`, verified green 2026-07-02. Probable cause: the
      Settings section tabs changed since the test was written (the MCP tab landed with
      an Alt+6 binding), so the expected tab list/attribute is stale. Decide whether the
      UI or the test expectation is right, update the spec, and extend coverage to Alt+6
      if six tabs is the new reality.
      **Fixed 2026-07-02:** the UI was right (six tabs: appearance, notifications,
      models, environment, mcp, token) — the spec was stale. Renamed the test to
      "Alt+1..6", asserts Alt+5 → MCP tab and Alt+6 → Access token. 12/12 green.
- [x] **Non-reactive `$state` warnings: Transcript `navIndex` + Composer
      `historyItems`.** svelte-check reports `non_reactive_update` for both
      (`Transcript.svelte:261`, `Composer.svelte:145`): plain `let` declarations that
      templates read reactively — `class:visible={navHovered || navIndex !== null}`
      (`Transcript.svelte:984`, the prompt-nav control's stays-visible-while-stepping
      behavior) and the Ctrl+R prompt-history popup's items. In Svelte 5 runes mode a
      plain `let` isn't reactive, so those bindings may silently not update. Verify the
      actual misbehavior (mock preview or e2e), convert to `$state(...)` where the
      reactive read is real, and add a regression assertion (`polish.e2e.ts` covers the
      prompt-nav control; a Ctrl+R spec exists). Fixing both drops the svelte-check
      warning count 12 → 10. Predates the 2026-07-02 facet/hotkey commits (verified via
      `jj file show` at base `zwqsxmky`).
      **Fixed 2026-07-02:** both converted to `$state` with comments naming the
      reactive read each serves. svelte-check 12 → 10 warnings confirmed; the
      existing polish + prompt-history-popup e2e suites stay green (they are the
      regression net — both reads are template-driven).



## 🛡️ Solidity / jank / perf plan (2026-07-02 six-lens review, synthesized)

Source: 42 findings from a six-lens review; 13 adversarially verified, 4 kept-unverified
(verifier died at the usage limit — marked ⚠️), 1 refuted, 24 low-stakes. Full details with
measurements live in the review artifact
(`~/.claude/projects/-Users-timo-src-pilot/31915849-*/tool-results/solidity-review-findings.json`);
titles below match its `findings[]` entries. Ranked by felt-quality-per-effort.

### Top 10 (ranked)

1. **[x] Turn on WS compression for real — one line.** `perMessageDeflate: true` is negotiated
   but Bun only compresses when the per-send flag is passed; measured 0/501 frames
   compressed, 1,277KB shipped byte-identical (`index.ts:285-292`, rawSend `index.ts:154-155`).
   Fix: `const s = JSON.stringify(msg); ws.send(s, s.length > 512)`; fix the stale comment;
   consider explicit `maxBackpressure`. Measured 4x on synthetic, snapshots gzip 7-40x.
   Effort: hours. Risk: minimal (browsers all negotiate deflate; Bun falls back per-client).
   **Fixed 2026-07-02:** `sendOrClose` (ws-send.ts — the single chokepoint every
   server send goes through) now passes `data.length > COMPRESS_MIN_BYTES` (512)
   as Bun's per-send compress flag; stale `perMessageDeflate` comment rewritten to
   name the per-send requirement. Two unit tests pin the flag (small→false,
   large→true) so a refactor can't regress to 0-compressed again. `maxBackpressure`
   was already handled by protocol v2's explicit `backpressureLimit: 4MB`.
   On-wire ratio not re-measured (needs a frame sniffer); streaming/reconnect e2e
   green over real browser sockets.
2. **Make touch scrolling compositor-threaded again.** `edge-swipe.ts:154` and
   `pull-to-refresh.ts:134` register permanent `{passive:false}` touchmove listeners on
   `.app`, the transcript scroller, and the sidebar — every phone scroll flick waits on the
   busy main thread (C1 parse) before moving. Fix: register touchstart passive; add the
   non-passive touchmove only when the gesture engages (edge `clientX<=24` / `scrollTop<=0`),
   remove on touchend/cancel/destroy — symmetric in both files. Test: existing tracker unit
   tests + DevTools "Scrolling: threaded" check. Effort: hours. Risk: low (mechanical
   listener-lifetime refactor).
3. **Asset delivery: cache headers + gzip + SW cache** (merges two findings). `static.ts:7-18`
   serves bare `Bun.file` — no Cache-Control/ETag, no gzip, and the SPA fallback serves
   index.html for missing hashed assets (stale-deploy white-screen). Every launch re-downloads
   ~860KB raw over Tailscale. Fix: (a) `/assets/*` → `max-age=31536000, immutable`;
   index.html/sw.js → `no-cache` + ETag/304; (b) in-memory gzip cache (Bun.gzipSync, text
   types); (c) sw.js: cache-first for `/assets/*`, network-first-with-fallback for
   navigations (~30 lines, cap the cache); (d) 404 for missing `/assets/*` instead of SPA
   fallback. Test: e2e asserting header presence; manual offline open. Effort: day. Risk:
   low-medium (SW caching bugs are annoying — keep sw.js `no-cache` so it's always refetchable).
4. **[x] Warm-cap eviction kills running background turns.** `evictionPlan` is recency-only;
   eviction disposes victims mid-turn and the synthetic `sessionClosed` clears the running
   indicator + attention record, so the killed turn *looks finished*
   (`polytoken-driver.ts:478-496`, `warm-cap.ts:7-21`; contrast the reaper's
   `turn_in_flight` guard at `polytoken-driver.ts:645`). Fix: give `evictionPlan` an
   `evictable(id)` predicate (stays pure, extend `warm-cap.test.ts`), pass
   `!lastState?.turn_in_flight`, allow temporary over-cap with a loud log when all
   candidates are running. Effort: hours. Risk: low.
   **Fixed 2026-07-02:** added an `evictable(id)` predicate (default `() => true`) to
   `evictionPlan` in `warm-cap.ts` — sessions where `evictable` returns `false` are
   skipped in the LRU loop. The polytoken driver passes
   `(id) => !warm.get(id)?.lastState?.turn_in_flight` so mid-turn sessions are never
   evicted. When not enough sessions are evictable (all candidates running), the
   returned list is shorter than needed and the driver logs a `console.warn` about
   being over-cap, deferring eviction until turns finish. 5 new unit tests cover skip,
   multi-skip, all-running over-cap, partial over-cap, and backward-compat default.
5. **Config setters + abort are fail-dangerous.** setModel/setThinking/setFacet/
   setPermissionMonitor `.catch(console.error)` only; abort has no catch at all;
   setPermissionMonitor poisons its cache optimistically so the badge can claim a safer
   mode than the daemon is in (`polytoken-driver.ts:1320-1354, 781-785`). Fix: copy
   respondUi's existing failure pattern (`polytoken-driver.ts:878-888`) — emit
   `hostUiRequest{kind:'notify', level:'error'}` per catch; restore `prev` monitor mode on
   failure; notify the silent `!data?.active_model` early-return. Test: fetch-mock unit
   tests per setter. Effort: hours. Risk: low.
   **Fixed 2026-07-02:** extracted `errorNotify` + `withErrorNotify` into a new
   `config-notify.ts` module (the same error-notify pattern `respondUi` uses inline).
   All 5 setters + `abort` now emit a visible `hostUiRequest{kind:"notify", level:"error"}`
   on failure instead of `.catch(console.error)` only. `abort` now has a catch at all.
   `setPermissionMonitor` saves `prevMode` before the optimistic update and restores it
   via `withErrorNotify`'s rollback callback on failure. `setThinking`'s silent
   `!data?.active_model` early-return now emits a notify, and its outer `.state()` promise
   now has a `.catch` (previously had no catch at all). 7 unit tests in
   `config-notify.test.ts` cover success (no emit), rejection with Error/non-Error,
   rollback on failure, and no rollback on success.
6. **[x] WS connect watchdog.** A blackholed handshake leaves the socket CONNECTING for
   minutes with *no retry timer armed* — "Reconnecting…" lies (`ws.svelte.ts:51-60, 72-77,
   110-114`). Fix: 8s watchdog after `new WebSocket(url)`: if still CONNECTING → detach
   onclose, close, `scheduleReconnect()`; clear in onopen/onclose/cleanupSocket; don't
   reset the backoff counter. Effort: hours. Risk: low (guard against firing after
   forceReconnect swapped the socket).
   **Fixed 2026-07-02:** implemented exactly as specced — 8s watchdog armed per
   socket with an identity guard (`ws !== armed` no-ops after a swap),
   `cleanupSocket` clears it on every discard path, timeout path detaches
   handlers before `close()` so onclose can't double-schedule, and the backoff
   counter deliberately keeps growing. Reconnect/resume e2e suites green
   (a deterministic blackholed-handshake e2e isn't feasible with the mock —
   watchdog covered by review + the normal-path suites).
7. ⚠️ **Push notifications never fire in the real topology.** `maybeNotify` mutes Web Push
   whenever ANY client is connected (`hub.ts:629`) — the desktop WKWebView is always
   connected, so the phone never buzzes; half-open phone sockets extend the mute window.
   Fix: drop the `clients.size > 0` gate (SW-side foreground suppression already exists,
   `sw.js:55-67`); unify notification tags (`pilot-${phase}-${sid}`) between hub and
   App.svelte so devices aren't double-buzzed. Needs a live push test. Effort: day.
   Risk: medium (double-notification edge cases; verify on real iOS).
8. **[x] App updates never reach clients.** The only reload path is a new SW install, but
   sw.js is byte-identical across builds — `updatefound` never fires; after desktop
   auto-update every device keeps the old bundle (`sw.ts:12-23`, `store.svelte.ts:1742-1748`).
   Fix: server sends build sha in `hello` (plumb like `serverId`; extend `wire.ts:136-141`),
   client compares against `__BUILD_FULL_HASH__` (vite define) → existing
   markUpdateReady toast. Effort: hours. Risk: low. (Pairs with #3's `no-cache` on
   index.html.)
   **Fixed 2026-07-02:** implemented as specced — `index.ts` reads
   `dist/.pilot-built-sha` once at startup → `hello.buildSha`; the client bakes
   `__BUILD_FULL_HASH__` (same sha by construction, verified byte-identical in a
   prod build) and compares on every hello → existing refresh toast. PROD-gated
   (a Vite dev serve can disagree with a stale dist marker harmlessly) and
   raised once per served sha so a dismissed toast doesn't nag on reconnects.
   Hub unit tests cover both the empty default and the pass-through.
9. ⚠️ **Morning pickup can't see finished-overnight runs.** `unread` is in-memory only;
   'done ✓' requires observing the running→idle transition live, so iOS PWA eviction
   erases it (`store.svelte.ts:135-139, 817-830, 1501-1502`). Fix: persist
   `lastSeen: Record<sid, ISO>` in localStorage per server (mirror `pilot.lastSession.*`),
   derive done/unread from `attention.updatedAt > lastSeen[sid]` with the
   `lastUserMessageAt` fallback for server restarts. Test: e2e reload-then-assert-badge.
   Effort: day. Risk: low.
10. **Context meter frozen mid-turn + no-op 1s broadcast.** On the live driver `getUsage`
    reads `lastState`, which only refreshes at turn boundaries — the meter shows
    turn-start values all turn; meanwhile the 1s ticker folds+broadcasts identical values
    to every viewer (`hub.ts:595-620`, `polytoken-driver.ts:1110-1117`). Fix: throttled
    single-flight `GET /state` (3-5s) while `turn_in_flight` for viewed sessions;
    change-gate `refreshUsage` (skip emit when tokens/contextWindow/percent unchanged);
    align the mock so e2e stops asserting behavior prod doesn't have. Effort: day.
    Risk: low.

### Quick wins (hours-sized, low-risk checklist)

- [x] Delete `will-change: opacity` (`markstream-theme.css:236`) — layer-per-paragraph
      explosion during streaming; browsers self-promote for one-shot animations.
      **Done 2026-07-02** (comment left in place explaining why it must not return).
- [~] ⚠️ Call `disableD2()` once at startup — every finalized markdown block currently fires
      an unhandled rejection (missing optional `@terrastruct/d2`) that also aborts footnote/
      tooltip enhancement. Also fix upstream in markstream: check for d2 blocks *before*
      `getD2()`, catch enhancement rejections.
      **Pilot side done 2026-07-02:** `disableD2()` called once in `main.ts` —
      verified live (markdown-heavy mock script: 0 page errors, previously one
      rejection on first render). The upstream markstream fix (probe-before-getD2,
      catch enhancement rejections) remains open.
- [ ] `snapshotOf` (`hub.ts:331-334`): return state directly / stringify once at send;
      clone only in test capture. (Measured: micro — do NOT build server delta-coalescing.)
- [ ] Fix the two committed perf scripts (broken under Bun isolated node_modules) so the
      C1 measurements stay reproducible.
- [x] Right-sidebar tooltip advertises ⌘J but the hotkey is ⌘⇧J.
      **Done 2026-07-02** (close-button tooltip now says ⌘⇧J, matching the
      StatusHeader binding + toggle tooltip).
- [x] Surface clipboard-copy failures (three silent sites; the store's own copy path
      already does it right).
      **Done 2026-07-02:** Transcript `copyText`, ToolCard `copyOut`, and the
      code-block copy button all route through `store.copyToClipboard`, which
      sets `lastError` ("needs a secure context") on rejection — no more silent
      no-op copies.
- [ ] Move the per-send `POST /push/subscribe` round-trip off the prompt-send hot path
      (subscribe once per session/page instead).

### Needs owner decision

- **⌘⇧↑ in a focused composer fires an UNCONFIRMED destructive rewind** and clobbers the
  typed draft (high-severity, unverified). Options: confirm dialog, require empty composer,
  or drop the binding. Cheap to decide, ugly to hit.
- **Queued-message granularity** (⚠️ unverified finding): per-item × on the newest row is
  implementable today (`DELETE /turn/input/newest`); per-arbitrary-item delete needs a
  daemon ask. Also: should Edit-all keep message boundaries (composer gets last item,
  rest → prompt history) instead of join('\n\n')? Changes visible behavior.
- **fileIndex pull vs push**: making the ~150KB index pull-based (first @-mention) halves
  reconnect payload but adds first-keystroke latency. Alternatively just dedupe the
  double-push on reconnect (`hub.ts:1057-1060, 1079-1127`) and keep push.
- **Notification-tap routing** (`sw.js:80-96`): postMessage focus-session into an open
  window instead of navigating every window (full reload each). Straightforward, but
  changes tap behavior; pairs with #7.

### Explicitly not worth it (dropped, with reasons)

- Server-side send-path micro-optimizations beyond the `snapshotOf` clone (measured
  0.1-0.5ms; the felt cost is client C1 markdown reparse at ~936ms/long answer).
- "clearQueue is a dead affordance" — refuted; it landed 2026-07-02. (The narrower
  partial-drain bug is tracked above under hand-backs.)
- "Trunk typecheck gate is red" — already fixed (commit `mqmukvnp`).
- ToolCard's duplicate isDark MutationObserver, find-in-transcript 110ms rescan,
  scrollbar-gutter rewrap, composer double-autosize, `listColdSessions` double-parse —
  real but low; batch opportunistically when touching those files.

## ⚡ Performance & network efficiency (2026-06-26 audit)

Goals: snappy UI, battery/thermal-friendly, reliable on spotty wifi. The agent runs on
the server; the UI should stay smooth even when text is slow to arrive. Measured with
`scripts/perf-streaming.ts` + `scripts/perf-streaming-scale.ts` (drive the real
`foldEvent` → `parseMarkdownToStructure` path in-process). Findings triaged below;
the trivial ones shipped inline this same day.

### 🟡 High-leverage — plan it (the headline)

- [ ] **Server-side coalescing of streamed `assistantDelta`s (N1).** The highest-leverage
      fix for both CPU and network. Today every pi `text_delta` becomes its own
      `assistantDelta` WS frame (`server/src/pi/event-map.ts`) and is forwarded one-by-one
      (`server/src/hub.ts` `onEvent`). One model response = hundreds of tiny frames, each
      driving a full client markdown re-parse (see C1).
      _Measured (perf-streaming.ts, 930-char / 101-token answer):_
      - fold only (no parse): 0.3ms total (0.05ms/stream)
      - fold + re-parse whole bubble per token (today): **56.8ms total (11.36ms/stream)**
      - coalesced x5 (parse every 5th token): 15.4ms (**73% saved**)
      - coalesced x10: 6.2ms (**89% saved**)
      _Scaling (perf-streaming-scale.ts) confirms super-linear (O(n²)) cost:_ ms-per-1k-chars-
      streamed climbs 11.9 → 94.4 as the answer grows 5× (324→10.5k chars). A 10KB answer
      costs ~1s of pure main-thread parse work today.
      **Fix:** buffer deltas in the hub keyed by `(sessionId, channel)`, flush on a ~50ms
      timer (or any non-`assistantDelta` event for that sid — toolStarted/userMessage/
      runCompleted/runFailed/sessionClosed/usageUpdated/channel switch — keep the flush
      rule dumb and total). Fold the *coalesced* delta into `st` so authoritative state and
      broadcast stay in lockstep. Coalescing is **not** a wire contract change: the
      reducer does `target.text += ev.text`, so folding N deltas vs. one concatenation
      yields a byte-identical `SessionState`; client untouched, fold stays identical.
      **Window:** ~50ms, drop the char cap (or set it ≥512 as a burst guard only). A pure
      time window scales the batch with token rate automatically. Bonus polish: emit the
      first delta of each new bubble immediately, then window the rest, so every response
      feels like it starts instantly.
      **UX tradeoff to confirm before building:** slightly chunkier text reveal vs.
      token-smooth. markstream's per-block fade animation masks it, and it's the right call
      for the spotty-wifi target — but it's a visible UX change, not a pure optimization.
      Note: with `hideThinking` on (the default), thinking deltas never reach markstream,
      so coalescing the thinking channel buys only network, not CPU. Subsumes most of C1
      and C3 for free.
      **Decided 2026-07-01:** defer. Need a live interactive session where the owner can
      watch the chunkier reveal vs. token-smooth tradeoff before committing to the change.
- [ ] **Client markdown re-parse is O(n²) per streamed message (C1).** `Markdown.svelte`
      feeds `content` into markstream's `NodeRenderer`, whose `parsedNodes = $derived.by`
      calls `parseMarkdownToStructure(FULL content)` on every content change
      (`markstream-svelte/dist/components/NodeRenderer.svelte`). `stream-markdown-parser`
      has **no incremental/prefix caching** (grepped the source). pilot's `Markdown.svelte`
      doesn't pass `smoothStreaming`, so it defaults to `'auto'` → `smoothStreamingEligible`
      is false → `renderContent = content` (raw) → re-parse per token. Mostly fixed by N1
      (fewer, larger deltas → fewer parses). A client-side rAF coalescer feeding `Markdown`
      is a fallback if N1 isn't enough; the deeper fix is upstream in the parser.
      **needs doublechecking if this changed with the move to polytoken!**

### 🟡 Correctness risk on spotty wifi — raise now, defer build

- [x] **Backpressure drops can silently desync the client fold (N4).** `server/src/index.ts`
      `rawSend` discards the return value of `ws.send()`. Past Bun's `maxBackpressure`
      (default ~16MB) a slow socket drops messages (`send` returns 0). A dropped
      *incremental event* silently desyncs the client's folded transcript from the server
      with no recovery until a manual reconnect — exactly what a congested phone link can
      trigger. Aligns with the repo's crash-loud-don't-corrupt philosophy: this is a quiet
      corruption path. **Fix:** check `ws.send()`; on a dropped *event* mark the connection
      desynced and force a re-snapshot (or close→reconnect). N1 (coalescing) reduces the
      frame count that can be dropped, but doesn't remove the drop path itself.
      **Fixed 2026-07-02:** `rawSend` now delegates to `sendJson()` (`server/src/ws-send.ts`),
      which calls `sendOrClose()` — on a `0` return (dropped) it closes the socket with
      code 1011 and logs a warning. The client's existing reconnect machinery (exponential
      backoff → `addClient` → fresh snapshot) handles recovery. The `switchTo` race
      (deltas lost during `seedFor`'s HTTP round-trips) is **not** fixed — it needs N3
      (sequence/resume protocol) and remains open.

### 🟢 Later / when it bites

- [ ] **Full-state resend on every reconnect (N3).** `hub.ts` `addClient` sends a full
      `structuredClone` snapshot on every connect. Spotty wifi means frequent reconnects,
      each re-shipping the entire transcript. No "I have up to event N" resume. `perMessageDeflate`
      (shipped) compresses the resend and buys down urgency. **Fix (nontrivial):**
      sequence-number events; client sends `lastSeq` on `hello`; server replays only the
      tail, falling back to a full snapshot when the gap is too large.
- [ ] **Stable transcript IDs across live and replay (reconnect quality cliff).** The live
      fold assigns `id = a-${ev.timestamp}-${items.length}` (`protocol/src/state.ts`), while
      replay assigns `u-${seq}` and uses pi's persisted message timestamp
      (`server/src/pi/history-map.ts`). `turn.id` derives from these, so a reconnect that
      reseeds from history (when the session was evicted from the warm cache — the pi
      driver's LRU warm-cap emits a synthetic `sessionClosed` → `sessionStates.delete`)
      re-keys every turn → `{#each turns (turn.id)}` tears down + rebuilds the entire
      transcript, re-parses every markdown block, re-fires fade animations, resets scroll.
      On spotty wifi under multi-session churn that's a flicker-on-every-reconnect quality
      bug. The common case is fine: `hub.switchTo` reuses warm state (same IDs) and
      markstream skips the re-parse when `content` is `===`. **Fix:** derive item ids from
      pi's message id / `entryId` on both paths (fiddly — `entryId` is undefined mid-turn
      on the live path, backfilled at `runCompleted`, so a synthetic-but-deterministic
      scheme both paths reproduce is needed). Elevate the moment a reconnect flicker is
      observed under session switching — it's a visual-quality regression, not just a
      benchmark number, which is exactly the "stay pretty on spotty wifi" mandate.
- [ ] **Virtualize the transcript + memoize per-turn grouping (C2).** `Transcript.svelte`
      recomputes `mergeTools` then `groupTurns` over the whole item list on every structural
      event (every tool start/finish, new bubble, user message) — O(n) per event, and it
      rebuilds *all* turn objects, not just the active one. `content-visibility:auto` skips
      off-screen paint/layout but not these JS passes or the DOM node count. The roadmap
      already lists "Virtualized transcript >80 rows — SHOULD" (`docs/DESIGN.md`). **Fix:**
      memoize per-turn grouping so only the last/active turn recomputes during streaming;
      real windowing after that.
- [ ] **Scope the copy-code `MutationObserver` (C4).** `client/src/lib/copy-code.ts` observes
      `{childList:true, subtree:true}` and runs `scan()` (`querySelectorAll` over the whole
      `.md-host` subtree) on every mutation batch while markstream streams. The
      `:not([data-copy-decorated])` selector keeps the follow-up small, but the subtree walk
      recurs per batch, per streaming bubble. **Fix:** only re-scan when an added node is /
      contains a `<pre>`, and/or disconnect the observer once `final`.

### Investigated and intentionally NOT changed (2026-06-26)

- [ ] **rAF-coalescing the per-token pinned-scroll write (C3) — reverted.** The streaming-pin
      `$effect` ran `queueMicrotask(() => scroller.scrollTo(...))` per token. An rAF-coalesced
      version (one write per frame) is theoretically more efficient and the fold/bookkeeping
      was kept synchronous. But it **broke `e2e/active-unread` + `e2e/polish` reproducibly**:
      the per-token microtask re-fire is load-bearing for `content-visibility` row heights
      to firm up across frames (a single rAF can't chase multi-frame convergence the way
      per-token re-firing did), so the scroll lands short, `onScroll` unpins, and a later
      delta spuriously flags the session unread. The code is visibly battle-scarred (multiple
      comments, e2e guards). Decision: drop C3, defer to N1 — once deltas drop to ~1 per 50ms
      the per-token scroll storm is 5–10× thinner and this path likely needs no change.
      Re-measure after N1 before revisiting.

## 🔵 Later

- [ ] **gondolin egress containment** (D10) — for the autonomous Mac Mini
      user account; preserves TS-embed via pi-gondolin extension
- [~] **Session tree / fork / clone / compaction** — _T0+T1 shipped 2026-06-19; T2 shipped 2026-06-20._
  - [x] **T0 — entry-id plumbing.** pi keeps each tree node's id on the `SessionEntry`
        wrapper, never on the `AgentMessage`, so transcript items couldn't name a node.
        Threaded pi's entry id through to `UserItem.entryId` / `AssistantItem.entryId` via
        two paths: REPLAY stamps it per-message in `history-map` (driver correlates
        `session.messages` ↔ `sessionManager.getBranch()` tail-anchored + compaction-safe,
        `server/src/pi/branch-ids.ts`), LIVE backfills it at the turn boundary
        (`RunCompletedEvent.{userEntryId,assistantEntryId}` from `getBranch()` at
        `agent_end`, reducer `stampLastEntryId`). The id is the handle navigateTree wants.
  - [x] **T1 — inline branch buttons (the 90% of /tree).** "Branch from this prompt"
        (re-edit: navigateTree rewinds the leaf to the prompt's parent and prefills the
        composer via a per-client `editorPrefill`) on user bubbles; "Branch from here"
        (continue on a new path) on turn-final assistant footers. Global `⌘/Ctrl+⇧+↑`
        branches from the last prompt. Driver seam `PilotDriver.branchFrom(entryId, {summarize})`
        → `session.navigateTree` (pi) / deterministic fixture (mock); the hub re-seeds every
        client through the same atomic path as `openSession`. Gated on `!turnActive` (a
        mid-turn navigate would interleave the run into the new branch). `e2e/branch*.e2e.ts`.
  - [x] **T2 — full tree-view modal.** _Shipped 2026-06-20. **Removed 2026-07-01** — the
        daemon's history is linear (`POST /rewind` destructively truncates), so the branching
        tree was fiction live. All tree-view code, protocol types, and tests deleted. The
        inline rewind buttons (T1) stay._ A browsable visualization of the
        whole session DAG so you can jump to / fork from *any* node, not just the always-visible
        prompts + turn-final answers (e.g. an abandoned branch, a mid-turn assistant step).
        As built: a new on-demand `treeState` server msg projects `getTree()`+`getLeafId()` into
        a JSON-safe `TreeNodeInfo[]` (`server/src/pi/tree-map.ts`); `client/src/lib/tree-view.ts`
        flattens it (single-child chains flat, branch points indent with continuous CSS rails,
        nearest-visible-ancestor reparenting under filters); `TreeView.svelte` is a Settings-style
        modal with filters (default skeleton / all / prompts / labeled) + text search + ↑↓/↵ nav;
        triggered by a header IconButton, `⌘⇧T`, or typing `/tree`. Node selection reuses the
        existing `branch` wire message (no new driver nav surface). `e2e/tree.e2e.ts` +
        `client/src/lib/tree-view.test.ts`. NOT done: branch+summarize UI (flag still plumbed,
        no affordance) and the leaf-durability follow-up below. Original spec:
        - **Data:** serialize `sessionManager.getTree()` (`SessionTreeNode[]` — `{entry,
          children, label?}`) + `getLeafId()` over a new server message (e.g. `treeState`),
          requested on demand when the modal opens. Keep the wire shape JSON-safe; don't
          ship pi's `SessionEntry` raw — project to `{id, parentId, kind, preview, role?,
          ts?, label?}` so `protocol/` stays DOM/runtime-free.
        - **Render:** mirror pi's `/tree` — a FLATTENED INDENTED LIST, *not* a 2D graph
          (single-child chains stay flat; only true branch points indent with `├─`/`└─` +
          carried `│` gutters; active root→leaf path marked; current leaf flagged). See
          `~/src/pi/.../components/tree-selector.ts` for the exact flatten/connector rules
          and per-entry-type preview labels (`getEntryDisplayText`). A web list is far
          easier than the terminal's gutter math — an indented `<ul>` with a left rail works.
        - **Modal:** reuse the `Settings.svelte` scrim+dialog pattern (a `store.treeOpen`
          flag, `role="dialog" aria-modal`, Escape-to-close, mounted in `App.svelte`); add a
          header trigger IconButton + a hotkey, both with tooltips (repo rule). Mobile-first
          layout (the list scrolls; rows are tappable).
        - **Action:** selecting a node sends the EXISTING `branch` wire message with that
          node's id — `branchFrom` already accepts any entry id, so no new driver surface.
        - **Fast-follows already seamed:** (a) **branch + summarize** — the `summarize` flag
          is plumbed end-to-end (`branch` msg → `branchFrom` → `navigateTree({summarize})`),
          just no UI yet; add a "summarize abandoned branch" affordance (it's a blocking LLM
          call — needs a "summarizing…" / abort state via `isCompacting`/`abortBranchSummary`).
          (b) **leaf durability** — a no-summary `branch()` only moves the in-memory leaf; it
          isn't persisted until the next prompt appends a child, so a cold reopen (warm-cap
          eviction / server restart) before prompting re-derives the leaf to the file tail.
          Benign for the warm jump-then-prompt flow; if it bites, navigate with a label or
          summary (those persist an entry) or have pilot persist the leaf explicitly.
- [ ] **Branch (leaf) durability — tracked risk (D13).** A no-summary `branchFrom`
      moves the session's in-memory `leafId` only (`navigateTree`); it is NOT durable
      until the next prompt appends a child entry. A server restart or LRU cold-eviction
      before the user prompts on the new branch re-derives the leaf to the file tail, so
      the user lands on the pre-branch state and the jump is silently lost. **No clean
      code fix via pi's public API** — `branch(id)` is in-memory only; the durable
      leaf-changing paths append entries (`branchWithSummary` needs an LLM call,
      `appendLabelChange` adds a visible node). Tracked under D13, not patched. User
      mitigations: navigate with a label/summary (persists an entry) or prompt on the
      new branch before reloading. Follow-up: have pilot persist the leaf explicitly
      if/when pi grows the capability. See `branchFrom` in `server/src/pi/pi-driver.ts`.
- [ ] **Scheduled / recurring runs**
- [ ] **Workspace git changed-files/diff/stage panel**
- [ ] **Skills enable/disable view**
- [ ] **Extensions enable/disable toggle** — split off from the compat-surfacing item
      (owner, 2026-06-19). Deferred: low frequency (extensions are set once, rarely toggled
      from a phone) and higher cost than it looks — pi loads extensions at session start
      (`packages/coding-agent/src/core/extensions/loader.ts`, no runtime disable), so a live
      toggle needs per-session load config or a session restart, not a flag.

- [ ] **Bulletproof queued-message delivery position** _(optional; pick up only if
      “jankiness with queued messages” bites)_. The live transcript now places queued
      (steer/follow-up) messages at their real delivery point via a per-session counter
      (`QueuedDeliveryTracker` in `server/src/pi/pi-driver.ts`, reset on abort/clearQueue/
      agent_end). Two residual edges can drop/misplace a queued bubble **live** — an
      error-stranded follow-up, and an `Alt+Up` clearQueue racing a drain — both self-heal
      on reload (pi's on-disk history has the true position). Full fix: identity-correlation
      via `queue_update` snapshot diffing (drain vs clear) instead of counting. Wrinkles:
      pi's queue snapshot is text-only (a queued image would need content re-read from
      `message_start`), and there's no pi-driver integration test harness, so the real-driver
      path isn't covered by the mock e2e. _(From the 2026-06-23 follow-up position bug fix;
      tdo `d10a`.)_

- [ ] **Per-session system-prompt override** _(deprioritized 2026-06-18 — owner doesn't
      expect to need this soon; parked at the back of the backlog)_. Let a new session
      start with a custom system prompt instead of pi's default (in the new-session draft,
      and/or a global default in Settings). Seam: `resourceLoaderOptions.systemPrompt` on
      `createAgentSessionServices` in `warmUp` (`server/src/pi/pi-driver.ts`) for a full
      replace, or `appendSystemPrompt` for additive. NOT needed for the pi-docs-pointer
      strip — that's handled globally by the `strip-pi-docs` pi extension
      (`~/.pi/agent/extensions/`); this is the broader "different prompt for this session."

## 📐 Architecture direction (Tauri + Rust hub)

_Direction note, not a commitment. Brainstormed 2026-07-01 while waiting for
polytoken feature-parity work to complete. Revisit when that work is done._

> **2026-07-02:** formalized as `docs/ADR-desktop-shell.md` (Tauri shell now, Bun hub as
> Rust-supervised sidecar, Rust-hub port behind explicit go/no-go criteria) — the ADR
> supersedes the shell parts of this note; the Rust-hub end-state below stays the gated
> target. Companion designs: `docs/PLAN-protocol-v2.md`, `docs/PLAN-driver-robustness.md`.

Pilot is moving away from the Bun WS hub: agent sessions now run as standalone
polytoken daemon processes, and mid-term UX goals (native file pickers, local
agent spawning, SSH-to-remote-host sessions in the same window) push the desktop
app toward being a real native application rather than a web page. A separate
mobile variant (remote-only, no local spawning) is already anticipated.

**Current working plan:**

- **Rust hub runs inside the Tauri app (tray-resident), not as a separate
  launchd daemon.** Tauri's system-tray feature keeps the Rust backend (Tokio)
  alive when the window is closed — the `.app` *is* the background service.
  Close window → tray icon stays → hub keeps serving mobile clients over the
  network; click tray → window reopens. This is the Claude/Codex model (desktop
  app must keep running for remote control) and avoids asking users to install a
  launchd/systemd service. Tauri's single-instance plugin prevents duplicate
  launches. A headless launchd/systemd path remains a valid *option* for a
  always-on Mac Mini that never opens a window, but it's not the default
  distribution story.
- **The Tauri app IS the hub + the desktop frontend** — the Rust backend serves
  both the local webview (via Tauri IPC) and remote mobile clients (via
  HTTP/WS), so there's one process, not two. Svelte frontend (kept as-is) in a
  system webview, with native OS affordances (file pickers, menus, tray) via
  Tauri IPC.
- **Mobile app** — separate variant, remote-only. Talks to the same Rust hub
  over the network (Tailscale). Tech stack TBD (could be a PWA, a native
  wrapper, or whatever fits). No local spawning, no native OS integration
  needed — just the remote-control surface.
- **Svelte + foldEvent reducer stay in TS** — the frontend is the only consumer
  of folded state; no reason to reimplement in Rust. The reducer stays shared
  between desktop and mobile frontends.
- **polytoken daemon stays out-of-process and language-agnostic** — the Rust hub
  is the glue (process lifecycle, SSH, socket management), not the brain.

**Design guidance for the Rust hub:**
- Keep it a **thin transport/coordination layer** — just IPC + process spawning
  + SSH + session aggregation. Don't port orchestration logic or state machines
  into Rust; let polytoken stay the brain and Svelte stay the UI. This matches
  the existing "daemon is out-of-process and language-agnostic" design and keeps
  the rewrite surface small.
- The Rust hub replaces the current `server/` Bun bridge (hub.ts + driver seam).
  The `PilotDriver` interface is the contract boundary.

**What this does NOT mean (yet):**
- No immediate rewrite. The Bun stack stays until polytoken feature parity work
  is complete. This is the target architecture, not a today task.
- No performance-driven motivation — the current stack isn't CPU-bound. The move
  is justified by UX direction (native desktop features, process management,
  SSH), not by runtime performance gains.
- The mobile variant is a separate concern and doesn't constrain the desktop
  choice. The phone-over-Tailscale property is preserved by the Rust hub being a
  persistent networked service.

**Distribution & auto-update:**
- Tauri ships a built-in updater (`tauri-plugin-updater`): each release produces
  a signed bundle (`.dmg`/`.app`) + signature file + JSON manifest; the running
  app fetches the manifest, downloads the bundle, verifies the signature, and
  applies it in-place — no App Store, no git checkout on the user's machine.
  This replaces the current "run from git checkout + `git fetch`" auto-update
  model for the `.app` distribution.
- **macOS notarization (Gatekeeper) is the $99/y Apple Developer Program
  question, and it's orthogonal to Tauri's updater.** Without it: the `.app`
  works and auto-updates, but first launch for *other* users shows "unidentified
  developer" — they must right-click → Open or `xattr -cr` once, then updates are
  smooth. With it: you submit each release to Apple's notary service, Gatekeeper
  lets it through, everyone gets a clean double-click install. Verdict:
  - Just you / technical friends → skip the $99/y, ad-hoc signing is fine.
  - Sharing with non-technical users → $99/y + notarytool is the standard path
    for dev tools distributed outside the App Store.

## 🧹 Code health & drift (2026-06-22 audit)

_Audit lens: Svelte's ["When not to use `$effect`"](https://svelte.dev/docs/svelte/$effect#When-not-to-use-$effect)
and Scott Spence's ["How I Stop LLMs Drifting In Production Codebases"](https://scottspence.com/posts/how-i-stop-llms-drifting-in-production-codebases).
The theme is **drift**: a plausible shortcut gets copied until the next session treats it as
how the app works. Findings below; the cheap/safe ones were fixed in the audit commit, the
rest are recorded here with rationale for why they weren't done inline._

**Headline: the `$effect` hygiene is already good.** 143 `$derived` vs 46 `$effect` across
the client, and ~90% of those effects are legitimate escape hatches (direct DOM: focus /
scrollIntoView / autosize; observers: Resize/Mutation; timers/clocks; browser APIs:
wakeLock / `document.title` / notifications; outside-click listeners). Crucially nearly
every effect carries an explaining comment — which is exactly the "require-effect-explanation"
discipline the drift article recommends. There is **no** `$effect` doing textbook state
sync (`doubled = count * 2`); those are all `$derived`. So this is maintenance of a healthy
path, not a cleanup of a bad one.

### `store.svelte.ts` is a 1870-line god-object (🟡 worth doing, ⚠️ not a yolo rewrite)

The drift article's "state modules getting too large and mixed concern" applies squarely. The
`PilotStore` class owns ~40 `$state` fields spanning unrelated domains (session/transcript,
sessions list, attention/unread, models/providers, file index, dir/path picker, trust, OAuth,
composer draft + pending-prompt delivery, sidebar, search, theme, font-scale, SW/app
update, push, toasts) **and** the transport orchestration: a ~210-line `onServer(msg)` switch
over ~30 server-message types (lines ~537–768), plus `start` / `authenticate` / `reconnect`.

Good news — the *socket* layer is already cleanly separated in `ws.svelte.ts` (backoff,
visibility/online reconnect, e2e hooks). The seam to cut next is the **message dispatch**: lift
`onServer` into an `applyServerMessage(store, msg)` reducer module (or a few per-domain handlers),
so the store stops being both the wire decoder and the view-state bag. After that, the
view-state itself could split into cohesive sub-stores (e.g. `composer`, `picker`, `models`,
`attention`) that the root store composes.

**Why not done inline:** this touches the app's central nervous system, and the delivery /
reconnect / per-client-focus logic was hard-won (see the 🔴/🟡 done items above — exactly-once
prompt delivery, stale-idle stop-turn, per-client focus). A mechanical move is *plausible* but
not *obviously safe*; it wants its own change with the full e2e suite as the net, not a
side-effect of an `$effect` audit. Recommend the `dev-review-loop` skill for it.

### Oversized components (🟢 opportunistic extractions)

`Sidebar` (1329), `Composer` (1293), `Settings` (1221), `Transcript` (1164) are all >1100 lines
with mixed concerns — the article's "route component complexity" advisory. None is urgent;
extract when next editing them rather than in a big-bang pass. Concrete candidates:
- **Composer**: the `@`-mention + slash autocomplete state machines (query parsing, ranking,
  debounced server fallback) could move to a `lib/` module unit-testable without the DOM.
- **Sidebar**: the row-actions overflow popover (open/position/clamp/outside-click, ~120 lines)
  is a self-contained component.
- **Settings**: the model-favorites editor is a distinct surface from app preferences.

### Gray-area state-writing effects (👀 watch-list, not a mandate)

These write `$state` inside an `$effect` to **reset/clamp/seed** local UI state on an identity or
list change. Not the forbidden `doubled = count*2` sync, but the Svelte docs nudge toward
deriving an effective value at read time or remounting via `{#key}`. All are individually
benign and well-commented; listed so the pattern stays visible instead of multiplying:
- **Index clamps** (closest to the antipattern; most mechanically convertible to a clamped
  `$derived` if ever desired): `Composer` slashSel (~140) & fileSel (~196), `DirPicker` sel (~79),
  `ModelPicker` sel (~115).
- **Reset-on-change**: `Composer` pickingCwd (~102), `DirPicker` filter/sel on path change (~63),
  `ModelPicker` modelQuery on close (~94), `ApprovalLayer` field reset (~17), `QnaInline`
  collapsed (~33).
- **Seed-on-open / auto-select**: `DirPicker` top-match (~72), `ModelPicker` expandedProviders
  (~100), `Settings` expandedFavProviders (~118).

### Optional: make the effect discipline a guardrail, not a habit (💡 article's actual thesis)

The drift article's point is that good patterns should be *enforced*, not *hoped for*. The repo
currently has no lint layer at all (the auto-formatter is harness-level; there's no biome/eslint
config). If effect-creep ever starts, the lightest guardrail matching the article would be a
`require-effect-explanation`-style check (an `$effect` in a `.svelte` write must have a nearby
explaining comment) — the project already follows the convention, so a rule would just hold the
line. Bigger lift, only worth it if drift actually appears; noted so the option is on record.

## 🤖 LLM suggestion — discuss before implementing

_From a GLM-5.2 architectural review of pilot (read-only pass, 2026-06-25). These are the
review's recommendations that were **not** implemented — parked here for discussion, **not
endorsed**. Treat as an outside model's opinion: verify the reasoning against the code before
acting. (The two contained fixes from the same review — a runtime shape guard at the
pi-history boundary, and throttling the live-tick `listSessions` disk scan — were prototyped
separately on branch `task/glm-fix-pilot`, not included here.)_

- [ ] **Decompose the hub (god object).** `server/src/hub.ts` (~1439 lines) owns folded
      session states, the running/initializing/attention maps, titles, the clients map, the
      live ticker, desktop-update state, the OAuth pending map + single-flight flag, and the
      prompt-results ledger; `handleClient` is one giant switch, and tests reach into privates
      via `(hub as unknown as …)` (`hub.test.ts`). Suggestion: extract `OAuthFlow`,
      `UpdateRelay`, `LiveTicker`, `PromptLedger` as collaborators the hub delegates to — the
      hub orchestrates rather than owning eight unrelated state machines, which would also drop
      the private-method test hacks. GLM ranked this the highest-leverage maintainability change.
      **Decided 2026-07-01:** defer (lower priority than the coalescing perf work).

- [ ] **Replace `structuredClone` snapshots with structural sharing.** A full `SessionState`
      deep-clone fires on every snapshot send (`server/src/hub.ts`, fired on connect / switch /
      reconnect / branch re-seed) — O(n) per snapshot for long transcripts, broadcast to every
      viewer on a branch. Suggestion: structural sharing past a transcript-length threshold, or
      an incremental diff on branch re-seed instead of a full clone. Pairs with the
      already-planned JS-windowing work.
      **Decided 2026-07-01:** defer. Priority sits between the coalescing perf work (higher)
      and the hub decomposition (lower). Before revisiting, add a measurement that shows how
      much time the clone actually takes on a realistic long session (connect/switch/reconnect)
      so the cost is visible, not assumed.


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
- [ ] **Files-changed-this-turn rollup** — at turn end, a collapsed card summarizing
      every file the agent wrote/edited this turn with `+N/−M` counts, expandable to
      the per-file diffs (reuses the `@pierre/diffs` work already landed).
- [ ] **One-off bash affordance** (DESIGN LATER) — a way to run a single shell command
      whose result lands in the transcript and enters next-turn context, without a full
      prompt. Useful for "what's the branch / git status" mid-session.
- [ ] **Retry-on-error with "continue" semantics.** Error cards in the transcript should
      offer a retry button that sends "continue" (not a re-send of the last prompt) when
      pilot can confirm the original prompt was delivered to the session. If delivery is
      uncertain, fall back to re-sending the prompt. No dedicated "continue" button outside
      of error cards. _(Replaces the deleted "Keep going" / continue button brainstorm item —
      owner decision 2026-07-01: continue-button is only wanted on error cards, not as a
      general idle-session affordance.)_

### Composer & input
- [ ] **Voice dictation on mobile** — Web Speech API mic button in the composer; talking
      a prompt into your phone beats thumb-typing a paragraph.

### Transcript reading
- [ ] **Collapse-all / expand-all tool calls** — one toggle to fold every tool card in a
      long transcript down to titles, for skimming a finished session.
- [ ] **Per-code-block copy + language label** — copy button and a language tag on each
      fenced code block (finer-grained than the whole-message copy already shipped); plus
      a soft-wrap toggle for wide code.
- [ ] **Copy-on-hover for code blocks** — each fenced code block gets a copy-to-clipboard
      button at its top-right edge, hidden by default and visible on mouseover (desktop)
      or always visible on touch. The existing per-turn footer copy covers the whole
      assistant message; this is a finer-grained affordance for grabbing just one snippet
      without selecting text.
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
- [ ] **Haptic feedback** — `navigator.vibrate` on approval-needed and turn-complete so a
      pocketed phone signals without a sound.
- [ ] **App-icon unread badge** — Badging API (`navigator.setAppBadge`) to show an unread
      / approval-pending count on the installed PWA icon.

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
