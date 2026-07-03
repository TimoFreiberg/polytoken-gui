# Pilot — Decisions

Settled architectural calls. Each is reversible unless noted. Numbers kept
for cross-reference with git history.

## D1. Monorepo: GUI + remote infra in one repo
`protocol/` (shared types + fold reducer, no runtime deps) · `server/` (Bun
WS hub + drivers) · `client/` (Svelte 5 PWA) · `deploy/`. The server *is* the
protocol contract — WS schema, server-side fold, and client reducer must evolve
together, so splitting now forces premature version coordination.

## D5. State model: server-authoritative, split durable vs per-client
**Durable shared** (server-owned, broadcast): sessions, transcripts, statuses,
pending approvals. **Per-client view** (client-local, never shared): selected
session, composer draft, sidebar collapse. This split is load-bearing at the
protocol level — broadcasting one whole-state blob makes two tabs fight over
the composer. The server owns pending approvals, the transcript snapshot, and
ambient status/widgets because the daemon can't replay them on reconnect.

## D6. Verification = deterministic mock + screenshot loop
A mock driver replays scripted event sequences so every UI state is
reproducible without a live daemon. `/debug/state` + `/debug/reset` (mock-only)
let an agent assert on server state directly. `/?dev` drives the mock to any
state. This is the dev/test surface; the live polytoken driver is for real use.

## D8. Concurrency = multiple concurrent warm sessions
N sessions run/stream concurrently server-side, each a separate polytoken
daemon process (one daemon = one session = one port). The hub keeps a
`Map<sessionId, WarmSession>`; all clients share one focused session (per-
client focus is overkill for single-user). Nothing is disposed on a focus-
change, so a backgrounded session keeps streaming and re-focuses instantly.

## D9. Approval posture = no tool gating
No per-tool / per-command approval extension. Autonomous background work is the
point. The only human gate is the project-trust gate (D12), handled daemon-side.

## D12. Workspace = arbitrary GUI paths, trust as safety net
No allowlist — open any path from the UI. The safety net is the trust gate,
which the polytoken daemon handles entirely on its side. The pilot-side
out-of-band trust channel (`trustRequest`/`trustResolved`/`trustResponse` +
`subscribeTrust`/`respondTrust` + `TrustCard.svelte`) was removed — it was
mock-only demo code that could never fire under the polytoken daemon.
**Resolved:** the daemon's `capability` interrogative covers untrusted-dir
prompts; the pilot UI no longer renders a trust card.

## D17. Draft persistence
Everything settable in the new-session draft UI is persisted per-project (keyed
`n:<cwd>` in localStorage) and survives a session switch + reload. Losing a
half-configured draft erodes trust in the tool. Default for any new draft
control: persist it, unless it's inherently ephemeral. Add an e2e round-trip
in `e2e/drafts.e2e.ts` for each persisted field.

## D18. Desktop shell = Tauri v2, hub stays a Bun sidecar
The Swift/AppKit shell is replaced by a Tauri v2 app (`desktop/`): Rust
owns exactly the part that must never die (port pick, spawn, /health gate,
liveness, crash-loop breaker, signal-safe teardown), while hub logic stays TS
where its tests live. Shell self-updates via tauri-plugin-updater (minisign,
our key, no Apple involvement — ad-hoc self-update verified quarantine- and
TCC-prompt-free, even in /Applications). The Rust-hub rewrite remains a
separate, criteria-gated decision. Full rationale, spike results, and the open
artifact-hosting decision: `docs/ADR-desktop-shell.md`.
