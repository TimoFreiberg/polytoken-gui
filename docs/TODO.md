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
- [x] **Trust-wiring skip rests on an unverified rationale.** `subscribeTrust`/
      `respondTrust` were skipped on the claim that the daemon's `capability`
      interrogative covers untrusted-dir prompts via `respondUi`. Nobody has run
      a live untrusted-dir test to confirm. Settle it: open a session in an
      untrusted dir against the real daemon; if the capability path covers it,
      *remove* the dead `TrustCard` + hub trust channel scaffolding rather than
      leaving it permanently dangling; if it doesn't, wire the trust methods.
      **human:** nah, polytoken doesn't have this. remove the TrustCard etc
      **done:** removed — polytoken handles trust daemon-side; the mock-only
      pipeline (TrustCard, wire messages, driver methods, fixtures, e2e) is
      deleted.
- [ ] the following findings by a fable agent:
      2. Dead code (delete or consciously keep) — ~~[x] done~~
      ~~PilotSettings.enabledExtensions is write-only.~~ Removed — was a pi-era
      concept with no read site on this polytoken-only branch.
      ~~setClientPresence/hasClients is dead by its own admission.~~ Removed —
      the hub wiring, driver closure, and interface method are gone; trivial to
      re-add when a real read site exists.
      ~~The interactive trust pipeline can't fire in production.~~ Removed —
      subscribeTrust/respondTrust were mock-only; the full chain (TrustEvent,
      three PilotDriver methods, hub relay, three wire messages, client-store
      handling, TrustCard.svelte, fixture, dev-bar button, e2e) is deleted.
      polytoken handles project trust daemon-side; D12 updated.
      3. Mechanical duplication (low-risk, ~600–700 lines)
      Polytoken driver (~150 lines). ~~Done: snapshotFor(ws, status?) closure collapses 7 call sites; refreshAndEmit(ws, label, action) collapses 5 daemon-action methods; usageFromState wrapper deleted; queueMsg(item, ts) helper collapses 2 of 3 queue mapping sites (the 3rd is in event-map.ts with a different shape).~~
      
      Event map (~120 lines). ~~Done: notify(meta, requestId, message, level) builder collapses all 14 hostUiRequest{kind:"notify"} constructions into 2-liners.~~
      
      Hub handleClient (~100 lines). ~~Done: target(msg) (15 sites), errMsg(e) (7 sites), callOptional(fn, label, run) (5 fire-and-forget cases + restoreQueue), plus sessionStatusMsg() and updateStatusMsg() builders.~~
      
      Daemon client (~70 lines). ~~Done: raw-fetch timeout bug fixed (safeFetch); post/get merged into request() core (delegating wrappers kept for readability + error-derivation difference); 4 MCP methods collapsed into mcpServerAction(name, action); driver-side switch collapsed.~~
      
      Trivial: ~~parseClientMessage/parseServerMessage in wire.ts are byte-identical — merged into one generic parseMessage.~~ openSession/reloadSession in the driver share their resolve-id→cwd→warm→seed skeleton — consciously kept inline: the shared tail is 4 lines, and the two methods diverge meaningfully before it (openSession refocuses a warm session; reloadSession disposes first). Extracting a helper would obscure the control flow for negligible savings.
      
      4. Client: one dropdown primitive instead of four hand-rolled ones (~300–400 lines)
      FacetBadge.svelte (267 lines) and PermissionBadge.svelte (215) are structurally identical: badge button + open/sel state + the same Escape/Arrow/Enter onKeydown + backdrop button + ~120 lines of near-identical panel CSS each; ModelPicker.svelte (506) is the bigger sibling. The repo already has the right convention for exactly this situation — Chevron and transition:reveal are mandated shared primitives — this is the same move one level up: a ui/MenuBadge.svelte owning the open/keyboard/backdrop/panel chrome, with items passed as snippets. Besides the LOC, it guarantees the pickers can't drift behaviorally (they already drift slightly: only some have the kbd-hint footer).
      **done (partial):** ui/MenuBadge.svelte owns the badge button, open/close, Esc/↑↓/↵ keyboard nav, backdrop, and panel/group-title/kbd-hint CSS; FacetBadge (267→~120) and PermissionBadge (215→~90) now pass their items as a `{#snippet body({sel, close})}` snippet. ModelPicker.svelte (506) is intentionally left hand-rolled — it has two menus sharing one open/sel state, a filter-as-you-type search input, per-provider collapsible groups, wrapping (not clamped) arrow nav with Ctrl-n/Ctrl-p, composer-refocus-on-close-when-hotkey-opened, hotkey integration via store.hotkeyAction, Space-to-select, scroll-into-view, an empty-match state, and a disabled badge. Forcing those into the shared primitive would need so many config props it would defeat the dedup; the comment at the top of ModelPicker documents this. Net: ~220 lines removed, and the two simple pickers can no longer drift behaviorally.
      
      Related but softer: the big components are 40–55% scoped CSS (Settings 718/1305, Transcript 649/1724, Sidebar 598/1540). Most of that is legitimately component-specific; I'd only extract the genuinely repeated menu/panel/row classes into app.css as part of the primitive above, not chase CSS dedup broadly.
      
    

## ⚡ Performance

- [ ] **Server-side coalescing of streamed `assistantDelta`s (N1).** Highest-
      leverage fix for CPU + network. Today every `text_delta` becomes its own
      WS frame, each driving a full client markdown re-parse. Fix: buffer deltas
      in the hub keyed by `(sessionId, channel)`, flush on ~50ms timer. Fold is
      additive so folding N deltas vs one concatenation yields byte-identical
      state; no wire change. **Deferred** — needs a live interactive session to
      watch chunkier reveal vs token-smooth before committing. Subsumes C1/C3.
- [ ] **Client markdown re-parse is O(n²) per streamed message (C1).**
      `Markdown.svelte` re-parses full content on every content change; the
      parser has no incremental/prefix caching. Mostly fixed by N1. **Needs
      doublechecking whether this changed with the polytoken migration.**
- [ ] **Full-state resend on every reconnect (N3).** `addClient` sends a full
      snapshot on every connect. No "I have up to event N" resume. Protocol v2
      seeded seq/epoch + `requestSeed`, but full resume not built.
- [ ] **Virtualize the transcript + memoize per-turn grouping (C2).**
      `Transcript.svelte` recomputes grouping over the whole item list on every
      structural event. Memoize per-turn so only the active turn recomputes;
      real windowing after that.
- [x] **Scope the copy-code `MutationObserver` (C4).** Observes
      `{childList:true, subtree:true}` and runs `scan()` on every mutation batch
      while streaming. Fix: only re-scan when an added node is/contains a `<pre>`.
      **done:** the observer callback now inspects mutation records for added `<pre>`
      nodes (or containers holding them) before calling `scan()`, skipping the
      full-subtree `querySelectorAll` on text-delta batches that never add code blocks.

## If fable doesn't do it first

- [ ] 1. Architecture: the hub double-bookkeeps every session (biggest conceptual win)
      The comment at hub.ts:222 says the journal "runs dark alongside the legacy fold" until the wire flips to seeds — but the wire flipped: seeds and resumes are already journal-built. So today ingest (hub.ts:473) does dual writes — folds every event into sessionStates and appends it to journals — and there's a "journal must exist iff state exists" lifecycle invariant with its own error-recovery path for when the two maps drift.
      
      The folded copy is only read in four rare places: the first-responder-wins check in respondUi (hub.ts:1491), the running-check in branch (hub.ts:1650), refreshUsage's ref lookup, and existence checks in switchTo. All of those can fold the journal on demand (foldAll(buildSeed(j).events) — exactly what snapshot() already does for /debug/state), or read the journal's first event for the ref. The property tests in hub-journal.test.ts already machine-check that the two representations are equivalent, which is precisely what de-risks deleting one.
      
      Payoff: the hot streaming path becomes append-only, the dual-write invariant and its error path disappear, and a whole class of drift bugs becomes unrepresentable. Cost: respondUi/branch pay an O(transcript) fold on a user click — negligible. This is medium-effort, medium-risk; everything else below is safer.
      
    ## 🏗️ Architecture

- **ADR-desktop-shell.md** — Tauri v2 desktop shell proposal (proposed, awaiting
  owner sign-off). The "📐 Architecture direction" note that lived here
  (Rust hub end-state, distribution model) is superseded by that ADR; the
  Rust-hub target stays gated by the criteria in it.
- [ ] **Decompose the hub (god object).** `server/src/hub.ts` owns folded session
      states, running/attention maps, clients map, live ticker, OAuth pending,
      prompt-results ledger; `handleClient` is one giant switch. Extract
      collaborators the hub delegates to. Deferred — touches the app's central
      nervous system; wants its own change with the full e2e suite as the net.
- [ ] **Replace `structuredClone` snapshots with structural sharing.** Full
      deep-clone fires on every snapshot send (connect/switch/reconnect/branch
      re-seed). Before revisiting, add a measurement of actual clone time on a
      realistic long session.

## 🧹 Minor

- [ ] `snapshotOf` (`hub.ts`): return state directly / stringify once at send;
      clone only in test capture. (Measured: micro.)
- [ ] Fix the two perf scripts (broken under Bun isolated `node_modules`) so the
      C1 measurements stay reproducible.

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

## 🎒 Patterns to steal (from paseo.sh)

- [ ] Follow-on UI primitives — Toggle · Chip · Menu/Dropdown · Disclosure
      (promote only once a pattern recurs cleanly, don't pre-build)
- [ ] Shared layout primitives (session row, section header)
- [ ] Big-snapshot pagination + tool-update frame coalescing
