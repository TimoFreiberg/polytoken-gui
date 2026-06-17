# Pilot — TODO

Persistent task list. Items grouped by priority; checkboxes for tracking.
See `docs/` siblings for context: `STATUS.md` (what's built), `DECISIONS.md`
(settled calls), `OPEN-QUESTIONS.md` (resolved discussions).

---

## 🔴 Next (urgent / blocking)

_(clear — nothing blocking; pull the next item up from Important)_

## 🟡 Important

- [ ] **Settings panel** — provider config, API keys, auth token, model
      defaults, theme toggle, notification prefs. Inspired by pi-gui's
      settings panel.

## 🟢 Polish / fast-follow

- [ ] **Suppress notifications when app focused** — if feasible, silence push/toast
      notifications while the browser tab/window has focus
- [ ] **Project sidebar hierarchy polish** — larger expand/collapse arrows for
      project groups; indent sessions under their project header to make the
      parent-child relationship visually obvious
- [ ] **Session status indicators** — icons/dots to the left of session titles
      distinguishing running (active turn), unread (new messages since last viewed),
      and read (idle). Unread/read is GUI-only state; can be in-memory only with
      old sessions defaulting to read on restore
- [ ] **Local session inventory + active/archived filter** — maintain a
      pilot-local store enumerating known projects and sessions (an allowlist).
      Auto-discovered sessions default to archived. Add a filter toggle to show
      only active (unarchived) sessions. Hide projects whose only sessions are
      archived and whose last activity (max of its sessions' latest edit timestamp)
      is >1 week old. For projects with many sessions, make the list internally
      scrollable with a visible limit of ~10, scroll within the project group
- [ ] **Tool call results popup: drop description, add hover tooltip** — the tool
      description doesn't need to be listed inline in the popup; move it to a
      mouseover tooltip on the tool name instead
- [ ] **Edit tool output: collapsed diff counts + expanded diff view** — instead of
      "Successfully replaced N block(s) in /path", show a collapsed view with
      `+N, -M` line counts, expandable to a nice side-by-side or unified diff.
      Use `bun i @pierre/diffs` for the diff rendering
- [ ] **Desktop notifications conflict with terminal pi extension** — on desktop
      browser, pilot's notification triggers the user's terminal pi notification
      extension (which links back to the terminal). Needs investigation: either
      suppress Web Notifications when pilot is the focused browser tab, or find a
      way to avoid double-firing through the extension.
- [ ] **Message timestamps** — small relative timestamp at the bottom of each
      agent and user text box (e.g. "5m ago"), with mouseover revealing the exact
      timestamp
- [ ] **Copy-to-clipboard button on agent messages** — a button at the bottom of
      each agent text area; hidden until hover, copies message content
- [ ] **Worktree checkbox in new-session form** — like the Claude app's "worktree"
      toggle; creates and passes a jj/git worktree path as the session cwd so the
      agent works in an isolated copy, leaving the main tree clean
- [ ] **Session context indicator** — a small color-coded circle (or similar badge)
      in the session list / header showing how much context the session has consumed,
      analogous to the Claude app's colored circle (green → yellow → red as the
      context window fills). Color could map to token-budget thresholds from the
      snapshot's `config`/usage fields; exact threshold values TBD
- [ ] **Stray caret span in agent text** — a naked `<span class="caret svelte-1rd1h7a"></span>`
      is appended to the end of agent output, looks like a client rendering bug.
      Needs investigation and fix

- [ ] **Jump-to-last-prompt hotkey** (OP8)
- [ ] **Type-to-focus prompt field** — basic typable characters focus the
      text field before typing them (or a dedicated hotkey)
- [ ] **Beautiful font rendering** — prose readability pass (OP8)
- [ ] **Tool card inspection polish** — unobtrusive expand/collapse (OP8)
- [ ] **Stray iOS zoom fix** — composer `font-size: ≥16px` to stop iOS
      auto-zoom; `overflow-x: hidden` on root
- [ ] **Live markdown rendering in prompt edit box** — preview formatting
      as you type, if straightforward
- [ ] **Slash-command autocompletion** + inline help text describing each
      command
- [ ] **PNG / maskable icons** — proper app icons for installed PWA
- [ ] **Virtualized transcript list** (>80 rows)
- [ ] **Binary 2-option select → Yes/No card**
- [ ] **Countdown for timeout-bearing dialogs**
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

---

## ✅ Done (for reference)

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
