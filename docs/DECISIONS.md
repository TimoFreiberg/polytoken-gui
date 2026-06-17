# Pilot — Decisions knocked down (2026-06-16, overnight session)

These are the calls I made autonomously so the build could proceed. Each is
**reversible** unless noted, and the one genuinely contentious one (backend
language) is flagged at the top of `OPEN-QUESTIONS.md` for your veto.

## D1. Repo scope: GUI + remote infra in **one monorepo**
Matches your "lean both." The server *is* the protocol contract — the WS schema,
the server-side transcript folding, and the client reducer that consumes them
must evolve together. Splitting them now forces a published protocol package and
version coordination before the protocol is stable. `pods` (model-serving infra)
is explicitly **out** — it's datacenter-GPU/vLLM/SSH, zero Apple-Silicon fit;
pointing pi at an open-weights endpoint later is a config concern, not this repo.

Layout: `protocol/` (shared types + fold reducer) · `server/` (Bun, embeds pi
SDK, WS, state) · `client/` (Svelte 5 PWA) · `mock/` (deterministic pi fixture,
lives in server for now) · `deploy/` · `docs/`.

## D2. Backend: **TypeScript embedding the pi SDK** (runtime: Bun) — CONTENTIOUS, see OQ1
Not Rust-spawn-RPC. Deciding factors:
- **Type reuse**: import pi's `AgentEvent`/`AgentMessage`/`Model` verbatim instead
  of re-declaring 30 commands + the full event union in Rust and tracking drift.
- **Existing driver**: pi-gui's `pi-sdk-driver` is Electron-free and was designed
  as the exact seam we'd swap into — runs in a Node/Bun server today.
- **No JSONL framing footgun**: embedding means no stdout pipe to frame (the
  LF-only / U+2028 trap that bites a hand-written Rust splitter).
- **Extension visibility** (you care about this): in-process `getAllTools()` gives
  tool labels + descriptions that the RPC wire never serializes.
- KellerComm's value was its *patterns* (reconnect, snapshot, first-responder-wins,
  PWA, Tailscale deploy), not Rust. Those port to a Bun server unchanged.
- Door stays open: the WS schema mirrors the RPC event shape, so heavy/untrusted
  sessions can later be pushed to a `pi --mode rpc` subprocess for crash isolation
  without a redesign.

Runtime = **Bun** (native `Bun.serve` WS, built-in test runner, your ecosystem
fit). Risk: pi SDK under Bun is unproven here — validated at M1; trivial fallback
to Node+tsx since it's all TS.

## D3. Frontend: **fresh Svelte 5 + Vite + Tailwind v4**
Not forking pi-gui's React (Electron/IPC-coupled, single-window/single-session —
the exact multi-client model we must discard). Not pi's `web-ui` (Lit, runs the
agent in-browser — opposite of server-authoritative). We *study* both as a
feature/layout spec. KellerComm's Svelte WS singleton + reducer + PWA bundle are
the highest-ROI steal and are already Svelte 5.

## D4. Protocol: **vendor pi-gui's `session-driver` types** as the WS contract
`SessionDriverEvent` (12 variants) and `HostUiRequest`/`HostUiResponse` are a
clean, JSON-serializable, already-normalized surface — almost 1:1 with what we
need. We wrap them in a small `ClientMessage`/`ServerMessage` envelope with
snapshot-on-connect. Vendored (copied) because the package is `private:0.0.0`.

## D5. State model: server-authoritative, split durable vs per-client view state
**Durable shared** (server-owned, broadcast): sessions, transcripts, statuses,
pending approvals. **Per-client view** (client-local, never shared): selected
session, composer draft, sidebar collapse. Doing this at the protocol level is
load-bearing — broadcasting one whole-state blob (pi-gui's model) makes two tabs
fight over the composer. Three things the server must own because pi can't replay
them: pending approvals, the transcript snapshot, ambient `setStatus`/`setWidget`.

## D6. Verification = deterministic mock-pi fixture + Claude_Preview screenshot loop
The "agent-legible introspection infrastructure" you asked for first. A mock
driver replays scripted `SessionDriverEvent` sequences so every UI state is
reproducible without a live model or API keys — same script → same pixels →
diffable screenshots. Plus a `/debug/state` HTTP endpoint and structured event
log so an agent can assert on server state directly. This is M0 and gates
everything else.

## 2026-06-17 — Open questions resolved (owner review)

The owner reviewed all eight items in `OPEN-QUESTIONS.md` and we settled them.
Resolutions below; the `<review>` blocks in that file hold the owner's own words.

### D7. Backend = TS-embed (OQ1, ratified)
Confirmed on the merits, not on sunk cost. KellerComm is reference material, not
a north star (it was vibecoded and has never run in production).

### D8. Concurrency = multiple concurrent in-process sessions (OQ2)
**Reverses the single-session default.** The owner wants several agent sessions
running at once. The SDK supports N independent `AgentSession`s directly (one
`createAgentSession` per session). Work: the hub becomes multi-session (state +
driver keyed per session) and client→server messages carry a `sessionRef` for
dispatch; the event side already carries `sessionRef`. Crash isolation is
deprioritized because persistence (D13) makes a crash a recoverable nuisance.

Status (2026-06-17): chose the **"global active, N kept warm"** interim — N
sessions run/stream concurrently server-side, but all clients share one focused
session (per-client focus deferred as overkill for a single-user tool). Done
(increment 1): the hub is session-focused — folds + broadcasts only the focused
session, routes commands by `sessionId` (`server/src/hub.ts`); client messages
carry optional `sessionId`. Pending (increment 2): the pi-driver still uses the
runtime-swap (disposes the old session on switch), so it only ever has one live
session — keeping N warm needs it reworked to a `Map` of independent
`AgentSession`s (no dispose on focus-change). Needs live 2-session verification.

### D9. Approval posture = no tool gating (OQ3)
No per-tool / per-command approval extension. Autonomous background work is the
point. The only human gate is the first-run project-trust prompt (D12).

### D10. Sandbox = deferred; isolation comes only from containerization (OQ4)
No host-side `sandbox-exec` / `@anthropic-ai/sandbox-runtime` (also dodges the
deprecated-`sandbox-exec` risk). When isolation is wanted it comes from a
container/micro-VM. Preferred: **gondolin** via the **pi-gondolin** extension,
which routes pi's bash/read/write/edit through a micro-VM while keeping pi
in-process — so it preserves TS-embed (D7). `pi-docker` stays an option but, if
it wraps the whole pi process, it reintroduces a pilot↔pi boundary and is the
worse fit.

Interim posture (accepted by owner): autonomous async work runs on a
limited-permission user account on the Mac Mini; supervised local runs use
capable models, watched more closely. Honest gap: a limited account caps
filesystem blast radius + privilege escalation but **not network egress /
exfiltration**. gondolin's egress allowlist + scoped secret injection is what
closes that, and is the durable answer per pi's own security guidance
("unattended automation → run contained", `pi …/docs/security.md`). Treated as
its own later spike, not a blocker.

### D11. Notifications = build Web Push now (OQ5)
Promoted from LATER. Validated first on the owner's actual iPhone, because iOS
Web Push only works for an *installed* PWA and is historically flaky — finding
out early is the point. Not a hard blocker if it fails.

### D12. Workspace = arbitrary GUI-controlled paths, no allowlist (OQ6)
Drop the fixed allowlist; the owner opens any path from the UI. The safety net
is the project-trust gate, now wired as a non-interactive MVP (see corrections) —
it gates auto-loading/execution of a repo's `.pi/extensions`, `.pi/settings.json`,
project packages, etc. No file explorer for MVP.

### D13. Persistence = pi session files are authoritative (OQ7)
**Inverts D5.** Instead of "in-memory transcript authoritative, JSONL backup,"
pilot treats pi's own `~/.pi/agent/sessions/*.jsonl` as the source of truth and
rebuilds in-memory state from them on load. Goal: behave like a peer to a CLI
`pi` over SSH — discover existing sessions (`SessionManager.list/listAll`),
resume (`open`/`switchSession`), and leave up-to-date session files for new
sessions (`SessionManager.create(cwd)`). This gives ~≤1s crash loss for free (pi
appends as the turn runs). pilot still separately persists only what pi can't
replay (pending approvals, ambient status/widgets); losing those on crash is a
deny-safe nuisance. Status (2026-06-17): implemented and verified live — the
driver resumes the most recent session via `SessionManager.continueRecent(cwd)`,
discovers via `list`, switches via `runtime.switchSession`, and rebuilds state
from the session's messages on load (`historyToEvents`). Resume-across-restart
and new↔existing switching both replay the full transcript.

### D14. Styling = same-family, dark-first (OQ8)
Not pixel-faithful. Polish lane for later: beautiful prose/font rendering,
inspectable-but-unobtrusive tool cards, jump-to-last-prompt hotkey, maybe a
right-side minimap. Diverge from Claude where dogfooding suggests better.

### Corrections discovered during review (pi behavior, verified in pi source)
- **Trust on the SDK path AUTO-TRUSTS unless the host resolves it** (corrected
  2026-06-17 — the earlier note here, "SDK path shows no prompt so resources are
  ignored," was backwards). pi only gates project resources when the host hands
  the ResourceLoader a `resolveProjectTrust` callback; pass none and
  `SettingsManager.projectTrusted` defaults to TRUE, so every project's
  `.pi/extensions|settings.json`/packages load unconditionally (verified: an
  untrusted repo's `.pi/extensions` loaded with no prompt and no saved decision).
  The fix is the host-level `resolveProjectTrust` callback — NOT the `project_trust`
  *event* (that's for extensions to participate in the decision). Status:
  non-interactive MVP wired (`server/src/pi/trust.ts`) — honors trust.json
  (parent-aware via `ProjectTrustStore`), trusts the operator-launched cwd, denies
  other untrusted paths. An in-app trust *card* is deferred: trust resolves inside
  `runtime.switchSession`, which the hub runs under `switching=true`, so surfacing
  an interactive `hostUiRequest` mid-switch needs the swap-guard reworked first.
- **Trust does NOT gate `AGENTS.md`/`CLAUDE.md`** — those load regardless. Trust
  gates `.pi/settings.json`, `.pi/extensions|skills|prompts|themes`,
  `.pi/SYSTEM.md`, and project packages. Because the agent does nothing until the
  owner sends a prompt, the prompt still works as a human checkpoint to eyeball
  BOTH AGENTS.md and `.pi` config first — but its actual security function is
  blocking auto-exec of repo `.pi/extensions`, which matters more given no tool
  gating (D9).
