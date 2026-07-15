# Pantoken — Decisions

Settled architectural calls. Each is reversible unless noted. Numbers kept
for cross-reference with git history.

## Monorepo: GUI + remote infra in one repo

`protocol/` (shared types + fold reducer, no runtime deps) · `server-rs/` (Rust
WS hub + drivers) · `client/` (Svelte 5 PWA) · `deploy/`. The server _is_ the
protocol contract — WS schema, server-side fold, and client reducer must evolve
together, so splitting now forces premature version coordination.

## State model: server-authoritative, split durable vs per-client

**Durable shared** (server-owned, broadcast): sessions, transcripts, statuses,
pending approvals. **Per-client view** (client-local, never shared): selected
session, composer draft, sidebar collapse. This split is load-bearing at the
protocol level — broadcasting one whole-state blob makes two tabs fight over
the composer. The server owns pending approvals, the transcript snapshot, and
ambient status/widgets because the daemon can't replay them on reconnect.

## Verification = deterministic mock + screenshot loop

A mock driver replays scripted event sequences so every UI state is
reproducible without a live daemon. `/debug/state` + `/debug/reset` (mock-only)
let an agent assert on server state directly. `/?dev` drives the mock to any
state. This is the dev/test surface; the live polytoken driver is for real use.

## Concurrency = multiple concurrent warm sessions

N sessions run/stream concurrently server-side, each a separate polytoken
daemon process (one daemon = one session = one port). The hub keeps a
`Map<sessionId, WarmSession>`; all clients share one focused session (per-
client focus is overkill for single-user). Nothing is disposed on a focus-
change, so a backgrounded session keeps streaming and re-focuses instantly.

## Polytoken feature parity

We want to support any feature that the polytoken tui supports.
Having extra features is fine, like git/jj workspace management.

## Workspace = arbitrary GUI paths, trust as safety net

No allowlist — open any path from the UI. polytoken daemons have a permission/approval system which we support.
The operator is responsible for checking what directory they're working in.

## Draft persistence

Everything settable in the new-session draft UI is persisted per-project (keyed
`n:<cwd>` in localStorage) and survives a session switch + reload. Losing a
half-configured draft erodes trust in the tool. Default for any new draft
control: persist it, unless it's inherently ephemeral. Add an e2e round-trip
in `e2e/drafts.e2e.ts` for each persisted field.

## Phone attention views may cover the composer when visibly minimizable

Desktop Q&A remains inline above the composer. On phones, Q&A and approvals use
one readable full-screen attention view because the narrow viewport makes an
inline card compete with both transcript and composer. Every such view has a
visible 44px Minimize action and Back-gesture support; minimizing returns to the
transcript and exposes a persistent shelf immediately above the composer. This
satisfies the non-blocking intent of Q5/Q10 while preserving phone readability.

## Phone composer settings use one summary control

On phones, permission mode, facet, model, and thinking level remain visible in
their familiar order in the composer's footer, but the footer is one 44px-or-taller
button rather than four cramped tap targets. It opens a full-screen Session controls
view with readable option rows, context-window details, and Back-gesture support.
Desktop retains the individual popup controls. The image-attachment action is a bare
paperclip with a transparent 44px hit area; Send remains the composer's emphasized
gold action.

## Tech stack

The desktop GUI is a Tauri app. As much as is reasonable is written in Rust (good language).
There are good architectural reasons for keeping the gui and the server separate, mostly the ability for remote gui sessions to connect to a local hub to be able to start agent sessions on the local machine.
Otherwise, keep architecture simple and straightforward.

## Rust best practices

Async where necessary, sync where possible.
Anything that can reasonably block should not be a gui bottleneck, gui snappiness is paramount.
Panics should be avoided, prefer complex error handling over simple panics that cause random crashes.
The operator won't look at the logs, so don't log informational stuff via tracing. Do log stuff to tracing that can help diagnose error cases.
Do not use Tokio Mutexes. No exceptions.
Actors and channels are good when work can be done in the background. But for things in the user action bottleneck path, it is likely to cause visible latency. So we might want to look for different solutions.

## Daemon→pantoken accumulator stays server-side in Rust (A′)

The event accumulator (`event_map` + `ui_bridge`: `DaemonEvent` → `SessionDriverEvent`)
stays server-side, ported to Rust — it is NOT moved client-side. The client is
Svelte/TS and stays thin on the stable pantoken WS wire. Moving the accumulator
client-side would relocate logic out of Rust into TS and duplicate it across
desktop + the imminent mobile app, losing the server's version-shield against
daemon churn (polytoken moves ~daily). The daemon owning more state
(`/history.emitted_at`, `/prompt` auto-queue) _shrinks_ the accumulator but does
not change where it lives. Single authority = one place to adapt on a daemon bump,
which is decisive now that mobile is the next build target after desktop.

## Pin the golden corpus, not the daemon binary

The live path runs against the ambient `polytoken` binary (daemon head, upgraded
~daily); there is no pin mechanism. Deterministic tests instead replay a committed
golden SSE corpus captured from a tagged version
(`server-rs/tests/corpus/<version>/`), canonicalized for stable ids/timestamps. A
daily daemon bump that breaks behavior turns a corpus test red with a precise diff
instead of silently corrupting the GUI. Re-capturing the corpus
(`scripts/capture-daemon-corpus.ts`) is a deliberate, separate step taken on
conscious adoption. Supersedes the earlier "pin the daemon version" standing
invariant (PROGRESS.md #3).

## Invariant: sidebar running indicator and transcript in-progress display must agree

Both the sidebar listing the sessions and the currently open session transcript have in-progress indicators.
The sidebar has a spinner on the right of the session title and the session transcript has an elapsed timer, a running token display, and a stop button at the bottom that allows stopping the running agent turn.
These should always agree with each other. If one is visible, all of them must be visible.
