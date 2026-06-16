# Pilot — overnight status (morning of 2026-06-17)

## TL;DR
Research → decisions → a **working, screenshot-verified app** running against a
deterministic mock of pi. M0–M3 are done. The agent-legible verification harness you
asked for first is built and proven. Real-pi wiring is the next step and its #1 risk
is already retired (see below). **Your input is wanted on `OPEN-QUESTIONS.md` —
especially OQ1 (backend language).**

## What's built & verified
- **Monorepo**: `protocol/` (shared contract + fold reducer), `server/` (Bun WS +
  `/debug/state`), `client/` (Svelte 5 PWA). Typechecks clean; 10 reducer unit tests
  pass; client builds.
- **Verification harness (M0)** — the "agent-legible introspection infra":
  - `Claude_Preview` launch config `pilot`; an agent boots the stack and screenshots.
  - `/?dev` dev bar drives the mock to any UI state; `/debug/state` dumps server state.
  - Deterministic mock-pi fixtures (`server/src/fixtures.ts`) → same script, same pixels.
- **Transcript & turn UI (M2)** — streaming text + separate collapsible thinking,
  tool-call cards (running/ok/error, expandable), markdown (escape-first, XSS-safe),
  user bubbles, notices. Composer with Enter-to-send, Stop, and steer/follow-up
  affordance while streaming. Status header (title, model, live/working/connection).
  Verified in **light + dark, desktop + mobile**.
- **Approvals (M3)** — bottom-sheet cards for confirm / select / input / editor, the
  5-option **project-trust** gate, binary yes/no, and a generic JSON fallback for any
  unknown method. (Screenshots in the session.)
- **Reconnect** — reconnecting WS singleton; reload pulls a fresh snapshot incl.
  pending approvals (observed working — a stronger M6 will harden sequencing).
- **PWA** — manifest, SVG icon, minimal service worker, installable. (Proper
  PNG/maskable icons + the push handler are noted follow-ups.)

## Decisions I made (full reasoning in `DECISIONS.md`)
1. **One monorepo** (GUI + remote infra), `pods` out of scope.
2. **Backend = TypeScript embedding the pi SDK, runtime Bun** — *contentious vs the
   handoff's Rust lean; this is OQ1, please confirm.*
3. **Frontend = fresh Svelte 5 + Vite**, study (not fork) pi-gui/web-ui.
4. **Protocol = vendored pi-gui `session-driver` types** + a thin envelope.
5. **Server-authoritative state**, durable-shared split from per-client-view.

## Risk retired overnight
**Does the pi SDK run under Bun?** (the core bet behind decision 2). Yes — spiked it:
`@earendil-works/pi-coding-agent@0.79.5` installs and imports cleanly under Bun, with
`createAgentSession`, `AgentSessionRuntime`, `createAgentSessionRuntime`,
`SessionManager`, tool factories, and `createExtensionRuntime` all available. So M5 is
a known, mechanical mapping rather than a leap.

## Your move (in priority order)
1. **OQ1** — confirm TS-embed (what I built) vs Rust. Everything else carries over if
   you switch; only the server skeleton is at stake.
2. Skim **OQ2–OQ8** (concurrency, approval posture, sandbox, notifications reach,
   workspace allowlist, persistence, styling fidelity) — each has a recommended default.

## Next steps (M5 onward)
- **M5 (real pi):** implement `server/src/pi-driver.ts` against `PilotDriver`, mapping
  pi's `AgentSessionEvent`s → our `SessionDriverEvent`s (taxonomy in the research /
  `docs/DESIGN.md`); attach tool labels from in-process `getAllTools()`. Keep the mock
  for tests. Gated on OQ1 + your provider/model choice.
- **M6:** harden multi-client (snapshot sequencing, first-responder-wins approvals).
- **M7:** `tailscale serve` deploy to the Mac Mini + auth token + launchd.
- Then notifications, extensions view, diffs.

## How to look at it yourself
```bash
bun install && bun run dev   # then open http://localhost:5173  (/?dev for the dev bar)
```
