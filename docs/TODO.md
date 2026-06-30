# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
Completed items are archived to [`DONE.md`](DONE.md).
See `docs/` siblings for context: `DESIGN.md` (architecture + roadmap), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

- [ ] hotkey for hiding/showing the question widget? hotkey choice needs discussion
- [ ] **Show + edit the agent's permission level in the UI.** The polytoken daemon exposes
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
- [ ] **Drop the steer/follow-up toggle + investigate steer behavior (BUG).** The
      composer exposes a `steer` ↔ `follow-up` SegmentedControl
      (`client/src/components/Composer.svelte:30,37–48`) whose chosen `deliverAs` is passed
      into `store.sendPrompt` → `PilotDriver.prompt(text, deliverAs, …)`. But polytoken's
      daemon has **no steer/follow-up distinction**: the driver receives it as `_deliverAs`
      (underscore-prefixed, unused — `server/src/polytoken/polytoken-driver.ts:686`) and
      ALWAYS calls `POST /prompt` (`:707`); the queue endpoint `POST /turn/input` takes only
      `{content}` ("no steer/followUp discriminator — that distinction is pilot-side UX only",
      `server/src/polytoken/daemon-client.ts:699–700`). Every queued message is labelled
      `mode: "steer"` regardless of what the user picked (`event-map.ts:318`,
      `polytoken-driver.ts:373` "daemon doesn't distinguish steer/followUp"). So the toggle is
      cosmetic noise today — remove the SegmentedControl + `deliverAs` state from the composer
      (keep the Alt+Enter one-shot-queue hint if it's still meaningful). BUT: the user reports
      steer messages are currently buggy and wants investigation — likely the toggle's
      no-op-ness is masking a real mid-turn-queueing bug (the driver routes mid-turn sends to
      `/prompt` instead of `/turn/input`, per `polytoken-driver.ts:705–707`). Investigate the
      actual steer path end-to-end before deleting the toggle; confirm whether mid-turn sends
      even reach the queue or wrongly start a new turn. Also check the "press Esc after send
      submits the next message" behavior the user mentioned. 2026-06-30.
      investigate code and fix if the situation looks clear, otherwise explore an interactive test
- [ ] set up a test environment for automated testing using the actual polytoken backend, both interactive UI and tmux-driven tui polytoken (to compare features) - set up a tmp dir as a test project and run the agent sessions in there, configure the dir to either use umans-flash or deepseek-v4-flash as default agent and then ensure all agent features are testable by the dev agent in that dir
- [ ] add UI support for `goal` (polytoken shows the text "(goal)" next to the facet in the sidebar, we can find a nicer place but we should also show it, if the protocol exposes it)

## Full automated gui <-> tui parity testing via playwright + tmux

I'd like to set up affordances/infra for an agent to drive a real pilot gui using a real polytoken backend in a test project (tmp dir with prefilled config that sets the model to a cheap fast one, try both umans-flash (free) and deepseek-v4-flash (very cheap, likely more reliable - umans-flash had some ttft spikes recently)).
Then, enumerate all polytoken features that you get from the tui and run "manual" agent-driven test runs to explore those features and find divergences/jank/missing features

## 🟢 Polish / fast-follow


- [ ] **Stop merging subsequent tool calls into "Worked for Ns" (keep the early-turn collapse).**
      `client/src/lib/transcript-view.ts` `mergeTools` folds runs of "summarizable" tool calls
      (`isSummarizedTool`, `:100–107`) into a single collapsible `MergedToolsItem` rendered as
      "Worked for Ns" — today this applies across the whole turn (gated only by
      `mergeTrailing=false` while a turn streams, `Transcript.svelte:86`). The user finds this
      hurts readability now that polytoken enforces **≤4 tool calls before each agent text
      output** — tool groups are already small and self-bounded, so the merge is over-collapsing
      distinct steps into one opaque blob. Desired: keep the collapse for the early part of a
      DONE turn (so a long finished turn still summarizes to "Worked 5m23s"), but render
      post-boundary tool runs as individual cards. Concretely — only seal a run to prose when
      it's followed by an assistant text bubble AND the turn is complete; unsealed runs (the
      active/streaming tail, or runs between visible items) already render as a bare flat list,
      so the change is about not folding the *settled* middle either. Touches `mergeTools`'s
      `sealed` logic + the `mergeTrailing` call site. Update `transcript-view.test.ts`
      `mergeTools` suite (the `:158` `mergeTrailing=true` case expects sealing). 2026-06-30.
      **human comment:** this paragraph was written by an agent summarizing my short instructions.
      i think this might have been a misunderstanding - my intent was to _never_ merge single tool calls (e.g. 1 bash, 2 reads) into a single line, but keep merging the early part of a _turn_ into the "worked for <time>" summary.
- [ ] **Right-side sidebar: flagged files, todos, async jobs (polytoken TUI parity).** The
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


- [~] **Provider OAuth login** → ~done (owner, 2026-06-22 — "i'll get back to it if there's
      jank"). Sign-in / sign-out for OAuth-capable providers ships in the Settings panel via
      the remote paste-the-code flow (open the auth page, paste the code/redirect back — no
      Tailscale callback needed, which sidestepped the original cost). `oauth-dialog` +
      `e2e/settings.e2e.ts` cover sign-in/cancel/sign-out. Left partial pending real-world use;
      reopen if the flow shows jank.

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
