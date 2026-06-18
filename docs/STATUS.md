# Pilot — overnight status (morning of 2026-06-17)

> ## Update — 2026-06-18 (supersedes the snapshots below)
>
> **Overnight Polish/feature batch — landed and rebased linearly onto `main`.** A sweep
> over the 🟢 Polish backlog plus one brainstorm item, all green on the integrated tree:
> `bun run test` = **97** unit, `bun run test:e2e` = **55** (desktop + mobile),
> `tsc -p protocol` + `svelte-check` clean.
> - **Composer / turns:** Enter steers / **Alt+Enter** queues a follow-up (inline hint);
>   **run-failed error card** with Retry (re-sends the last prompt) + Copy.
> - **Sidebar:** **session search** (name / preview / path), a **plain (un-capped)
>   per-project list** (the whole sidebar scrolls; archiving manages length),
>   **autofocus** on the new-session input, and a **worktree
>   toggle** that runs the session in an isolated jj/git worktree of the chosen dir
>   (`newSession.worktree` → both drivers; `server/src/pi/worktree.ts`).
> - **Header / Settings:** **⌘/Ctrl+,** toggles Settings; **model search** in the picker
>   and the favorites list; **tab title** mirrors the active session title.
> - **Server:** **warm-session LRU eviction** (`PILOT_WARM_CAP`, default 8) — pure
>   `evictionPlan` unit-tested; eviction disposes the session (aborts any in-flight run)
>   and clears it from the running set (review-pass fix + regression test).
> - **PWA:** refresh prompt when a new service worker installs.
> - **Cross-cutting:** hotkey + **tooltip audit** — every clickable carries a descriptive
>   `title`. Plus the **slash-command typeahead** (composer `/` menu) and a review pass
>   (running-set-on-eviction fix, honest SW-push comment, `~/` cwd expansion, fav tooltip).
>
> Infra: Playwright ports are env-overridable (`PILOT_E2E_*`) so two checkouts can run e2e
> concurrently. The **worktree-creation and LRU-eviction pi paths are typechecked +
> unit-tested but not yet exercised live** (consistent with the rest of the pi driver).
> Known debt: `tsc -p server` reports **7 pre-existing strict-mode errors in test files**
> (`hub.test.ts`, `trust.test.ts`); `bun test` is green, so they sit outside the working gate.

> ## Update — 2026-06-17, evening (supersedes the snapshots below)
>
> **Interactive project-trust card (D12) — landed.** The last 🔴. An untrusted cwd now
> prompts the operator to grant/deny instead of silently denying. Trust travels an
> **out-of-band channel** (`trustRequest`/`trustResolved` server msgs + `trustResponse`
> client msg; `subscribeTrust`/`respondTrust` on `PilotDriver`), *not* the session event
> stream — because trust resolves inside `warmUp`'s service creation, before the
> session/UI-bridge exist and while the hub suppresses session events mid-swap
> (`switching`). The pi resolver (`trust.ts`) keeps its non-interactive fast paths
> (moot / saved / launch-cwd) and only escalates an undecided non-launch cwd to the
> card, **blocking the swap** on the answer (pi awaits `resolveProjectTrust`); the chosen
> option persists via `ProjectTrustStore` (CLI-compatible), session-only persists
> nothing, deny-safe on timeout / no client / dismiss. New `TrustCard.svelte`; the hub
> gained a single-flight switch guard (the card can hold a swap on human input for
> minutes); the mock drives the card via the `trust` dev button (the old select-fixture
> is gone). Green: `bun test protocol server` = **55**, `bun run test:e2e` = **23**
> (desktop + mobile, incl. card render-w/-cwd + dismiss-on-click), `tsc` + `svelte-check`
> clean; visually confirmed (dark). The full WS round-trip is e2e-proven (the
> `Claude_Preview` browser couldn't establish the WS through its proxy — a harness quirk,
> not the app; Playwright hits the same server fine).

> ## Update — 2026-06-17, afternoon (supersedes the snapshots below)
>
> Landed + committed (`9069d223`; tree clean; `bun test protocol server` = **47**,
> `bun run test:e2e` = **22** across desktop + mobile, `tsc` + `svelte-check` clean):
> - **Session/project sidebar** — replaced the header session dropdown
>   (`SessionPicker` deleted) with a collapsible left rail (desktop) / slide-over
>   drawer with scrim (mobile), grouping sessions by project directory. Open/collapse
>   is per-client view state (D5), persisted per-device in localStorage. `listSessions`
>   now spans every project (`SessionManager.listAll()`) so the sidebar is a
>   cross-project navigator, not just the launch cwd's sessions.
> - **New session in an arbitrary directory** (D12 GUI affordance) — the `newSession`
>   wire message carries an optional `cwd`; the sidebar's "New session in a directory…"
>   input takes a typed absolute path (prefilled with the active session's cwd), and a
>   per-project `+` starts a session in that group's dir. The pi driver expands `~`,
>   resolves, and **fails loudly** on a non-directory; session-switch errors now surface
>   in the sidebar instead of only the console.
> - **Per-session model + thinking-level picker** — provider-grouped model menu +
>   thinking-level menu in the header (`setModel`/`setThinking` over the wire,
>   `modelList` broadcast). This was pre-existing uncommitted work; committed alongside
>   the sidebar at the owner's call (the two were entangled across shared files).
>
> Verification note: the e2e suite was run against an **isolated mock stack on alt
> ports** (8799/5199) so the owner's live `PILOT_DRIVER=pi` dev server on 5173/8787
> stayed untouched. Still open: the interactive trust card (TODO 🔴) and a real model
> turn (Live pi bring-up).

> ## Update — 2026-06-17, midday (supersedes the morning snapshot below)
>
> Since the morning snapshot, landed + committed (tree clean; `bun run test` =
> **45** unit/integration, `bun run test:e2e` = **19** Playwright, `tsc` +
> `svelte-check` clean):
> - **Stale-ctx swap crash fixed** — switching/creating a session could crash the
>   server when a TUI extension's fire-and-forget `session_start` work touched a
>   disposed ctx. Added a loud `unhandledRejection` guard (`server/src/index.ts`)
>   so a stray extension async error can't kill the host; the offending extension
>   (`prompt-editor`) is fixed in `~/dotfiles` (committed there, **not pushed**).
> - **D13 persistence** — confirmed functionally complete and verified live
>   (resume-across-restart + new↔existing switching replay the full transcript).
> - **D12 trust gate (MVP)** — closed a **live auto-trust hole**: pi auto-trusts
>   every project unless the host resolves trust. `server/src/pi/trust.ts` now
>   honors trust.json, trusts the launch cwd, denies other untrusted paths.
> - **D8 increment 1** — the hub is session-focused (folds/broadcasts the focused
>   session, routes commands by `sessionId`; background sessions still notify).
>
> **The real pi driver has now been run live** for session ops (list / switch /
> new / resume / project-trust) via `scripts/live-switch.ts` against a real agent.
> Still pending: a real model **turn** (Live pi bring-up — needs provider creds;
> `~/.pi` is set to deepseek), so the "not yet run live" framing below is stale
> for session ops but accurate for a model turn.
>
> **D8 increment 2 — done.** The pi-driver now keeps N independent sessions warm in
> a `Map<sessionId, WarmSession>` (no more runtime swap+dispose); `openSession`/
> `newSession` warm-and-focus and dedup by session file, `prompt`/`abort`/`respondUi`
> dispatch by `sessionId`. Verified live against the real agent
> (`scripts/live-warm-toggle.ts`): two sessions warm at once, instant refocus with
> full history, no stale-ctx crash. Background *streaming* across a switch still
> needs a real model turn (the Live pi bring-up task / provider creds).
>
> **Next:** the D12 interactive trust card. After the warm rework, trust resolves
> inside `warmUp` (service creation) before that session's UI bridge exists, and the
> hub still runs `openSession`/`newSession` under `switching = true` — both need
> addressing so a trust `hostUiRequest` can reach clients. See `TODO.md` +
> `DECISIONS.md` (D8/D12/D13).

## TL;DR
A working, test-covered remote-control web UI for pi — running against a
deterministic mock, with the **real pi driver implemented** (typechecked against
the SDK, unit-tested) but not yet run live. Look/feel mirrors the Claude app.
Remote infra (serve + auth + Tailscale + deploy) is built. **Your input is wanted
on `OPEN-QUESTIONS.md`** — mainly the live-pi bring-up choices (provider, workspace,
approval posture). Everything that didn't need your input is done and committed.

## What's built, verified, and committed
Eight feature commits on top of the design docs. All of this is green
(`bun test` = 30 unit/integration, `bun run test:e2e` = 17 Playwright across
desktop + mobile, `svelte-check` + `tsc` clean):

- **Transcript & turn UI** — streaming text, separate collapsible thinking, tool
  cards (running/ok/error, expandable), XSS-safe markdown, user bubbles, notices.
  Composer with Enter-to-send, Stop, steer/follow-up gating. Status header.
  Verified light + dark, desktop + mobile.
- **Approvals** — confirm / select / input / editor bottom-sheet cards, the
  5-option project-trust gate, binary yes/no, generic JSON fallback.
- **Agent-legible verification harness** — deterministic mock-pi fixtures, a `/?dev`
  state-driver bar, `/debug/state` + `/debug/reset` introspection endpoints, and a
  committed **Playwright** suite (the automated feedback loop you asked for).
- **Multi-client** — server-authoritative broadcast, snapshot-on-(re)connect,
  **first-responder-wins** approvals (unit + 2-page e2e verified).
- **remote-pilot infra** — server serves the built client (one process), app-level
  **auth token** gate (WS + `/debug`), binds to loopback, `tailscale serve` + a
  `launchd` plist + `deploy/run.sh` + `deploy/DEPLOY.md`. Token gate verified.
- **Real pi driver** (`server/src/pi/`) — `PILOT_DRIVER=pi`. Maps pi's
  AgentSessionEvent stream → pilot events (`event-map.ts`), bridges pi's
  ExtensionUIContext → approval/ambient events (`ui-bridge.ts`), wires
  `createAgentSession` + commands (`pi-driver.ts`). Mock stays the default; the SDK
  loads only in pi mode (dynamic import). The two pure cores are unit-tested; the
  whole thing typechecks against the real SDK.
- **PWA** — installable (manifest, icon, SW). **Tab-open Web Notifications** for
  run-done + approval-needed. (PNG icons + Web Push deferred — OQ5.)

## Risks retired overnight
- **pi SDK under Bun** — installs + imports clean (`@earendil-works/pi-coding-agent
  @0.79.5`); full API present.
- **pi driver correctness (static)** — `event-map`, `ui-bridge`, `pi-driver` all
  typecheck against the real SDK types and the pure pieces pass unit tests.

## NOT done — needs you (the genuine stop points)
1. **Live pi bring-up.** The driver has never executed a real turn (needs provider
   credentials, and running a live coding agent on your machine is side-effecting —
   I didn't do that autonomously). See "To go live" below.
2. The decisions in `OPEN-QUESTIONS.md` — especially **OQ3 approval posture**
   (pi auto-runs tools incl. bash; do we gate?), **OQ6 workspace allowlist** (which
   dirs may a phone open?), and confirming **OQ1** (TS-embed — now built out).
3. Web Push for a fully-closed phone (OQ5), proper PNG/maskable icons, styling
   fidelity (OQ8).

## To go live (first thing, once OQ1/OQ3/OQ6 are settled)
```bash
# uses your existing ~/.pi model + credentials; runs in the given workspace
PILOT_DRIVER=pi PILOT_CWD=/path/to/a/repo bun run dev
# open http://localhost:5173 and send a prompt
```
Expect rough edges on the first real turn (it's untested live) — they'll fail
loudly and be quick to fix. Known follow-up in the driver: richer tool labels.
(History replay for resumed sessions is now implemented + verified live — D13.)

## How to look around
- `docs/DESIGN.md` — architecture + the full feature roadmap (tiers).
- `docs/DECISIONS.md` — what I settled and why.
- `docs/OPEN-QUESTIONS.md` — what's waiting on you.
- `AGENTS.md` — how to run, test, and verify the repo.
- `jj log` — 8 feature commits, each green and reviewable.
