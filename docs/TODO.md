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
- [ ] **Trust-wiring skip rests on an unverified rationale.** `subscribeTrust`/
      `respondTrust` were skipped on the claim that the daemon's `capability`
      interrogative covers untrusted-dir prompts via `respondUi`. Nobody has run
      a live untrusted-dir test to confirm. Settle it: open a session in an
      untrusted dir against the real daemon; if the capability path covers it,
      *remove* the dead `TrustCard` + hub trust channel scaffolding rather than
      leaving it permanently dangling; if it doesn't, wire the trust methods.

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
- [ ] **Scope the copy-code `MutationObserver` (C4).** Observes
      `{childList:true, subtree:true}` and runs `scan()` on every mutation batch
      while streaming. Fix: only re-scan when an added node is/contains a `<pre>`.

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
