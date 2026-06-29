# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
Completed items are archived to [`DONE.md`](DONE.md).
See `docs/` siblings for context: `DESIGN.md` (architecture + roadmap), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

- [ ] **polytoken: opening a session that's live in the TUI causes a 409 lease conflict.**
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
- [ ] **polytoken: event-map bare modelId shows bare id on active-session badge.**
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
- [ ] **e2e: dir-picker `.row.up` "go up" button times out (pre-existing flake).** Surfaced
      during the Chunk 0.5 Settings-nav verification (2026-06-26): 5 `e2e/sessions.e2e.ts`
      worktree/dir-picker tests (`started in a directory chosen via the browser`, `worktree
      chip creates…`, `worktree session shows a path indicator`, `archiving a worktree session
      reaps…`, `archiving a dirty worktree session…`) all fail with a 30s timeout waiting for
      `dir-picker`'s `.row.up`. VERIFIED to fail at the clean base commit `b3c98cac` (no
      Settings changes) — NOT a regression from the nav refactor. Likely environmental
      (the `chooseProjectDir` helper's `.row.up` click never resolves). Not blocking the
      extensions plan, but it's noisy in the suite and should be diagnosed separately.
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
- [ ] cmd+= / cmd+- (font size changes) aren't applied to the question widget, they should
- [ ] hotkey for hiding/showing the question widget?

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

- [x] **Bump Vite 6 → 8 + @sveltejs/vite-plugin-svelte 5 → 7** → done 2026-06-21.
      Resolved to Vite 8.0.16 + vite-plugin-svelte 7.1.2; the lockfile now uses Rolldown
      instead of esbuild+Rollup, and the old inspector package disappeared with the v5
      plugin dependency chain. No config changes were needed: the custom build-sha plugin,
      dev proxy (including WebSockets), and production bundle all work unchanged. Verified
      with the production build, Svelte check, protocol typecheck, 349 unit tests, and all
      172 desktop/mobile Playwright tests.

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

### Jank found in the 2026-06-19 live pass (real pi, deepseek-v4-flash)

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

### Jank / polish found in the 2026-06-20 UX survey

_Surfaced by a multi-dimension survey of the client, each finding verified against current
code. The high-value quick wins from this pass already shipped (approval a11y, iOS-zoom
prevention, eager reconnect, transcript/composer polish — see DONE 2026-06-20); these are
the remainder, roughly ordered by day-to-day leverage._

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
- [x] **No "running low on context" cue** → done 2026-06-20. Once the focused session's
      context window is ≥85% full, the composer surfaces a one-line `role="status"` cue above
      the input ("Context N% full — consider /compact or a fresh session"), reusing the
      attachment-status row pattern. Tone tracks the meter ring (accent 85–89%, danger 90%+) so
      the words and the ring agree; drafts carry no usage, so it stays hidden there. New
      `contextfull` dev-bar script (→ `MOCK_USAGE_FULL` 91%) drives it deterministically;
      `e2e/context-meter.e2e.ts` asserts it's absent at the 24% baseline and appears (with the
      danger tone + 91% ring) once driven.
- [x] **Sidebar search has no focus-on-open / Enter / Esc** → done 2026-06-21. Enter opens the
      top match (first session of the first group — the visual top); Esc clears a non-empty query
      (and `stopPropagation`s so it doesn't also trip the app-wide Esc handlers), else blurs.
      Focus-on-open is gated to desktop and fires only on a closed→open transition (`prev` seeded
      to the current state) so it never steals focus from the composer on initial load or pops
      the soft keyboard on a phone. `e2e/sessions.e2e.ts` covers Enter-opens, Esc-clears, and
      desktop reopen-focuses.
- [x] **New-session dir input validation + always-typing fuzzy input** → done 2026-06-22.
      The old two-mode design (edit/navigate toggle) is replaced with an always-visible
      filter input that fuzzy-matches subdirectories by subsequence. Typing filters the
      current dir's children; Backspace when empty goes up. Path mode (input starts with
      `/` or `~`) still lets you jump to any directory directly. A debounced `statPath`
      round-trip shows an inline ✓/✗ validation hint for typed paths. `e2e/dir-picker.e2e.ts`
      covers filtering, path jumping, Escape clear-vs-close, and the project pick flow.
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

**Mobile findings — surfaced but NOT yet verified** _(the survey's mobile + status dimensions
hit a session limit mid-verify; confirm each against the code before acting):_
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

### New polish (triaged 2026-06-20)

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
- [x] **Sidebar visuals → match Codex** → checked off 2026-06-22 (owner: "we're at a good
      state now"). The sidebar look is settled; no Codex-screenshot redesign pass needed.
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
- [x] **Smooth collapse animation for turn-ending autocollapse** → done 2026-06-21. The
      per-turn work block's body now uses a Svelte `transition:slide` (180ms, `cubicOut`), so
      the autocollapse at turn end (and the manual toggle) glides height+opacity instead of
      snapping and jumping the content below. Svelte skips the intro on initial mount, so
      already-settled turns on page load don't animate. `working-block` + `polish` (autoscroll)
      e2e still green.
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

### Mobile composer

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
- [x] ~~**Session context indicator**~~ → won't-build (owner, 2026-06-22 — "i think the
      current state is good"; the earlier "is good imo" meant the current state, not "keep the
      idea"). The shipped surfaces — the meter ring + the 85%-full composer cue — cover the need;
      no separate green→yellow→red sidebar/header dot. _(Reopen if an at-a-glance per-row dot is
      wanted later; the token-budget thresholds from snapshot usage are the data source.)_
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
- [x] **Realistic mock tool-event timestamps** → already satisfied (verified 2026-06-21).
      `server/src/fixtures.ts` already routes every *finished* tool fixture through `toolSpan`,
      which calls `advanceTs(durationMs)` between stamping the start/finish events so the gap is
      a deterministic 180ms–1.2s (not the raw ~1ms `ts()` step). The two remaining direct
      `toolStarted` events are intentionally-unfinished running tools (one blocked on approval,
      the `staleidle` regression), so they have no duration to render. `ToolCard.svelte` derives
      the badge from those `startedAt`/`finishedAt` timestamps. Checkbox was stale — no code
      change needed.
- [x] **`/tree` command → open the native tree modal** → already built; verified 2026-06-22.
      `Composer.svelte:275` intercepts `text.trim() === "/tree"` in `submit()` before send: it
      clears the box, calls `store.openTree()`, and early-returns so it never forwards to pi.
      Exactly the spec. Covered by `e2e/tree.e2e.ts` ("typing /tree opens the view instead of
      sending it"). Backlog item was stale — no build needed.
- [~] **Provider OAuth login** → ~done (owner, 2026-06-22 — "i'll get back to it if there's
      jank"). Sign-in / sign-out for OAuth-capable providers ships in the Settings panel via
      the remote paste-the-code flow (open the auth page, paste the code/redirect back — no
      Tailscale callback needed, which sidestepped the original cost). `oauth-dialog` +
      `e2e/settings.e2e.ts` cover sign-in/cancel/sign-out. Left partial pending real-world use;
      reopen if the flow shows jank.
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

## ⚡ Performance & network efficiency (2026-06-26 audit)

Goals: snappy UI, battery/thermal-friendly, reliable on spotty wifi. The agent runs on
the server; the UI should stay smooth even when text is slow to arrive. Measured with
`scripts/perf-streaming.ts` + `scripts/perf-streaming-scale.ts` (drive the real
`foldEvent` → `parseMarkdownToStructure` path in-process). Findings triaged below;
the trivial ones shipped inline this same day.

### Shipped inline (2026-06-26)

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
- [ ] **Client markdown re-parse is O(n²) per streamed message (C1).** `Markdown.svelte`
      feeds `content` into markstream's `NodeRenderer`, whose `parsedNodes = $derived.by`
      calls `parseMarkdownToStructure(FULL content)` on every content change
      (`markstream-svelte/dist/components/NodeRenderer.svelte`). `stream-markdown-parser`
      has **no incremental/prefix caching** (grepped the source). pilot's `Markdown.svelte`
      doesn't pass `smoothStreaming`, so it defaults to `'auto'` → `smoothStreamingEligible`
      is false → `renderContent = content` (raw) → re-parse per token. Mostly fixed by N1
      (fewer, larger deltas → fewer parses). A client-side rAF coalescer feeding `Markdown`
      is a fallback if N1 isn't enough; the deeper fix is upstream in the parser.

### 🟡 Correctness risk on spotty wifi — raise now, defer build

- [ ] **Backpressure drops can silently desync the client fold (N4).** `server/src/index.ts`
      `rawSend` discards the return value of `ws.send()`. Past Bun's `maxBackpressure`
      (default ~16MB) a slow socket drops messages (`send` returns 0). A dropped
      *incremental event* silently desyncs the client's folded transcript from the server
      with no recovery until a manual reconnect — exactly what a congested phone link can
      trigger. Aligns with the repo's crash-loud-don't-corrupt philosophy: this is a quiet
      corruption path. **Fix:** check `ws.send()`; on a dropped *event* mark the connection
      desynced and force a re-snapshot (or close→reconnect). N1 (coalescing) reduces the
      frame count that can be dropped, but doesn't remove the drop path itself.

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

- [x] **@-completion in new-session draft uses wrong cwd** → done 2026-06-21. The `@`
      typeahead used the pushed file index, which is the previously-focused session's cwd — so
      a draft showed the wrong project's files. Now while drafting the composer suppresses that
      stale local index and routes every `@` query through the server `fd` fallback, scoped to
      the draft's target cwd (typed path, or $HOME when blank). Threaded a `cwd?` through the
      `queryFiles` wire message → `PilotDriver.listFiles(query, sessionId?, cwd?)` → both drivers
      (pi uses it as the `fd` root; the mock surfaces a cwd-derived marker for testing). Hub unit
      tests cover the cwd forwarding (explicit + omitted); `e2e/file-mention.e2e.ts` proves a
      draft's menu fills from the cwd-scoped fallback while a real session doesn't.
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
  - [x] **T2 — full tree-view modal.** _Shipped 2026-06-20._ A browsable visualization of the
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
- [x] **Image attachments via browser file input** → done 2026-06-19. Up to ten selected
      images render as removable thumbnail chips and travel through the protocol into pi's
      prompt options. Paste/drop, byte limits, and compression are tracked in the Important
      hardening item above. Arbitrary file attachments are not supported by pi's prompt
      attachment contract.
- [x] **Inline tool-diff rendering** → done 2026-06-18. Edit tool cards show collapsed
      `+N/−M` counts and lazily render the full unified diff with `@pierre/diffs`.
- [ ] **Workspace git changed-files/diff/stage panel**
- [ ] **Skills enable/disable view**
- [ ] **Extensions enable/disable toggle** — split off from the compat-surfacing item
      (owner, 2026-06-19). Deferred: low frequency (extensions are set once, rarely toggled
      from a phone) and higher cost than it looks — pi loads extensions at session start
      (`packages/coding-agent/src/core/extensions/loader.ts`, no runtime disable), so a live
      toggle needs per-session load config or a session restart, not a flag.

- [ ] **Right-side session minimap** (nebulous, OP8)
- [x] **Queued-messages editing** → whole-queue restore/edit shipped in the urgent item
      above. Individual replacement remains intentionally unbuilt unless dogfooding shows
      it is worth a second queue mutation API.
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

- [ ] **Remove the MCP-cwd workaround once the `pi-mcp-adapter` fix ships** _(temporary;
      added 2026-06-23)_. Stdio MCP servers (e.g. the playwright browser) were spawned by
      `pi-mcp-adapter` (≤ 2.10.0) with `cwd = process.cwd()`, which in pilot is the shared
      host-process dir — so every session's server-written files (screenshots especially)
      landed in pilot's dir instead of the session's worktree, where the agent looks, and
      the agent resorted to scanning the filesystem to find them. Stopgap: `warmUp`
      (`server/src/pi/pi-driver.ts`) generates a per-session copy of the global `mcp.json`
      with `cwd` injected into each stdio server (`server/src/pi/mcp-cwd-workaround.ts`,
      `buildSessionMcpConfigOverride`) and passes it to the adapter via its `mcp-config`
      flag (`extensionFlagValues`). Upstream fix: local branch
      `feat/default-server-cwd-to-session` in `~/src/pi-mcp-adapter` defaults the stdio
      spawn cwd to `ctx.cwd` in `McpServerManager`; PR to
      https://github.com/nicobailon/pi-mcp-adapter not yet opened (open by hand). **When**
      the fix is released and the installed adapter version includes it: delete
      `mcp-cwd-workaround.ts`, its import in `pi-driver.ts`, and the `warmUp` call site +
      `extensionFlagValues` spread, then verify screenshots still land in the worktree.

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

### Done in this audit (✅ fixed inline)

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

### `store.svelte.ts` is a 1870-line god-object (🟡 worth doing, ⚠️ not a yolo rewrite)

The drift article's "state modules getting too large and mixed concern" applies squarely. The
`PilotStore` class owns ~40 `$state` fields spanning unrelated domains (session/transcript,
sessions list, attention/unread, models/providers, file index, dir/path picker, trust, OAuth,
composer draft + pending-prompt delivery, sidebar, search, tree, theme, font-scale, SW/app
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
  (~100), `Settings` expandedFavProviders (~118), `TreeView` valid-row (~45).

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
      _Discuss:_ worth the churn vs. living with a well-documented god object?

- [ ] **Replace `structuredClone` snapshots with structural sharing.** A full `SessionState`
      deep-clone fires on every snapshot send (`server/src/hub.ts`, fired on connect / switch /
      reconnect / branch re-seed) — O(n) per snapshot for long transcripts, broadcast to every
      viewer on a branch. Suggestion: structural sharing past a transcript-length threshold, or
      an incremental diff on branch re-seed instead of a full clone. Pairs with the
      already-planned JS-windowing work. _Discuss:_ premature until transcripts actually get
      long? (already flagged as a known future cliff, not unnoticed.)

- [ ] **Fix or gate the branch-durability gap.** A no-summary branch jump only moves the
      in-memory leaf; it isn't durable until the next prompt appends a child, so a cold reopen
      before prompting re-derives the pre-branch leaf — silent state loss in a shipped feature
      (`server/src/pi/pi-driver.ts`, `branchFrom`). GLM suggested forcing a persist on
      `navigateTree` **or** disabling the branch gesture until a child is appended. **Note:** a
      follow-up fix run found force-persist isn't reachable through pi's public API (the leaf id
      is in-memory only; a durable leaf change requires an appended entry), so this collapses to
      _gate the gesture_ or _document the limitation_. _Discuss:_ gate vs. document?

- [ ] **Track the `qna` unwrapped-bridge coupling with a pi-version canary.**
      `server/src/pi/ui-bridge.ts` relies on pi handing extensions the raw, unwrapped bridge as
      `ctx.ui`, so methods beyond the typed `ExtensionUIContext` stay callable — a dependency on
      undocumented pi-internal behavior. If pi ever wraps `ctx.ui`, `qna` degrades silently (the
      answer extension feature-detects and falls back, but a non-answer extension relying on it
      would break invisibly). Suggestion: a pi-version canary test so a bump fails loud.
      _Discuss:_ canary test vs. just a tracked-risk note?

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
- [x] **Edit-and-resubmit a prior prompt** → done 2026-06-19 as session-tree T1.
      “Branch from this prompt” rewinds to the prompt's parent and prefills the composer;
      `⌘/Ctrl+⇧+↑` applies it to the most recent prompt.
- [x] ~~**Live activity status line**~~ → won't-build (owner, 2026-06-22). The derived
      verbose one-liner ("Reading foo.ts", "Running tests", "Editing bar.rs") was shipped once
      and **reverted as too noisy** — owner doesn't want it anywhere (sidebar rows, tab title,
      or notifications). The coarse cross-session attention state (running / waiting / failed /
      done) stays; this is specifically the chatty per-action line that's out. _(Doc note: the
      earlier text here claimed the one-liners were live in sidebar rows — that was stale;
      they were removed. Flag me if any verbose-activity remnant is still rendering in code.)_
- [ ] **Files-changed-this-turn rollup** — at turn end, a collapsed card summarizing
      every file the agent wrote/edited this turn with `+N/−M` counts, expandable to
      the per-file diffs (reuses the `@pierre/diffs` work already landed).
- [ ] **One-off bash affordance** (DESIGN LATER) — a way to run a single shell command
      whose result lands in the transcript and enters next-turn context, without a full
      prompt. Useful for "what's the branch / git status" mid-session.
- [ ] **"Keep going" / continue button** ⚠️ _questionable — discuss before building_ —
      one-tap canned follow-up ("continue", "keep going") on an idle session, for the
      common case of nudging a paused agent from your phone without typing. _(2026-06-21:
      owner doesn't want this now and may never — don't pick it up on spec; revisit only
      if dogfooding surfaces a concrete need.)_

### Composer & input
- [x] **@-file mention autocomplete** — done 2026-06-19. Type `@` in the composer
      followed by a filename/path prefix → server searches the session's cwd via `fd`
      (fast, .gitignore-aware), results appear in a popup menu. Arrow/Enter/Tab to
      select, Esc to dismiss; directories get a trailing `/`. See the TODO in
      `Composer.svelte` re: per-query RPC latency tradeoff.
- [x] **Per-session prompt draft persistence** _(superseded — completed in 🟡 Important;
      retained here only as historical brainstorm context)_.
- [x] **Offline prompt queue** → done 2026-06-20 as part of reliable prompt delivery;
      IndexedDB persistence survives disconnects, reloads, and tab eviction.
- [ ] **Voice dictation on mobile** — Web Speech API mic button in the composer; talking
      a prompt into your phone beats thumb-typing a paragraph.
- [x] **Optimistic user-message echo** → done 2026-06-20 as part of reliable prompt
      delivery, including explicit acceptance/rejection ACK reconciliation.

### Transcript reading
- [x] **In-transcript search (⌘F)** → done 2026-06-22. Claude-style floating "Find in
      transcript" box pinned top-right of the transcript pane, opened with ⌘/Ctrl+F.
      Find-as-you-type over the rendered transcript with match highlighting (CSS Custom
      Highlight API — `Range`s registered in `CSS.highlights`, no DOM mutation, so it
      survives stream deltas/re-renders; degrades to scroll-only where unsupported), a
      `current/total` counter, next/prev (⏎ / ⇧⏎ or the ↑↓ buttons, wrapping), and Esc to
      close. A `MutationObserver` keeps matches fresh while a turn streams. Distinct from
      the sidebar session search. New `TranscriptSearch.svelte`; `e2e/transcript-search.e2e.ts`.
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
- [ ] **Haptic feedback** — `navigator.vibrate` on approval-needed and turn-complete so a
      pocketed phone signals without a sound.
- [ ] **App-icon unread badge** — Badging API (`navigator.setAppBadge`) to show an unread
      / approval-pending count on the installed PWA icon.
- [x] **Connection-status banner** → done 2026-06-18. `ConnectionBanner.svelte` shows
      connecting/reconnecting/offline state, explains that the agent keeps running, and
      offers manual reconnect (`Alt+R`).

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
- [x] **Theme: follow system + explicit toggle** → done 2026-06-18. Settings offers
      System/Light/Dark, persists the override, and follows live
      `prefers-color-scheme` changes in System mode.
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
