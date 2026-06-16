# Pilot — overnight status (morning of 2026-06-17)

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
loudly and be quick to fix. Known follow-ups in the driver: history replay for
resumed sessions (currently starts fresh), and richer tool labels.

## How to look around
- `docs/DESIGN.md` — architecture + the full feature roadmap (tiers).
- `docs/DECISIONS.md` — what I settled and why.
- `docs/OPEN-QUESTIONS.md` — what's waiting on you.
- `AGENTS.md` — how to run, test, and verify the repo.
- `jj log` — 8 feature commits, each green and reviewable.
