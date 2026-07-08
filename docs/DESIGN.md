# Pantoken — Design

A personal, single-user remote-control GUI for a **polytoken** coding agent.
polytoken runs as out-of-process daemons (one per session); pantoken drives it
from a desktop GUI/browser/phone over Tailscale. Default look/feel mirrors Codex desktop/Claude app.

## Architecture

```
   Mac Mini (server: Bun + TS)
   ┌─────────────────────────────────────────────────────────────┐
   │  PolytokenDriver ── HTTP+SSE ──┐   polytoken daemon(s)      │
   │    per-session daemon proc      │   (one per session/port)  │
   │    · open/new/resume/abort      │                           │
   │    · event-map (fold)           ▼                           │
   │                          ┌───────────────────┐              │
   │  SERVER-AUTHORITATIVE ───┤ event → transcript│              │
   │  STATE                   │  reducer (shared) │              │
   │  · event journal per session└───────────────────┘           │
   │  · pendingApprovals: Map<id, HostUiRequest>                 │
   │  · ambient: statuses{}, widgets{}, title                     │
   │              │                                               │
   │  WebSocket server  +  /debug/state  +  auth-token            │
   └──────────────┼──────────────────────────────────────────────┘
                  │  Tailscale (tailscale serve, TLS)
   ┌──────────────┴──────────────┐
   ▼                             ▼
 MacBook browser             Phone (PWA)
 THIN CLIENT (Svelte 5)      THIN CLIENT (Svelte 5)
 · folds same events locally · same; per-client view state
 · renders transcript+deltas   (selection, composer draft,
 · taps approvals              sidebar) stays LOCAL
```

**Load-bearing principle:** split **durable shared state** (sessions,
transcripts, statuses, pending approvals — server-owned, broadcast) from
**per-client view state** (selection, composer draft, sidebar — client-local).
At the protocol level.

## The driver seam

`PantokenDriver` is the contract for swapping mock ↔ polytoken. The hub never
changes between them:

- **`mock`** — deterministic fixture driver for dev/e2e. No daemon needed.
- **`polytoken`** — the live driver. HTTP+SSE client that maps the daemon's
  event vocabulary onto pantoken's. One child daemon per warm session.

`PANTOKEN_DRIVER=pi` is a hard error (the in-process agent SDK driver was removed;
polytoken replaced it).

## Protocol (the WS contract)

A shared `foldEvent(state, event)` reducer lives in `protocol/` and runs
identically on server (authoritative) and client (incremental render).
Protocol v2: connect/switch sends a `{type:"seed", events, epoch, seq}`
journal (clients fold from zero); `hello.resume` tail-replays the gap on
reconnect; `requestSeed` covers client-detected gaps. No server-side fold is
client-visible — a future Rust hub becomes a journaling router, no foldEvent
port needed.

Open work and backlog live in `TODO.md`. Architecture direction (Tauri
desktop shell, Rust hub) lives in `ADR-desktop-shell.md`.
