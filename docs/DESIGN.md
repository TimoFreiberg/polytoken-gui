# Pilot — Design

A personal, single-user remote-control web UI for a **polytoken** coding agent.
polytoken runs as out-of-process daemons (one per session); pilot drives it
from a browser/phone over Tailscale. Default look/feel mirrors the Claude app.

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
   │  · transcript[] per session └───────────────────┘           │
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

`PilotDriver` is the contract for swapping mock ↔ polytoken. The hub never
changes between them:

- **`mock`** — deterministic fixture driver for dev/e2e. No daemon needed.
- **`polytoken`** — the live driver. HTTP+SSE client that maps the daemon's
  event vocabulary onto pilot's. One child daemon per warm session.

`PILOT_DRIVER=pi` is a hard error (the in-process agent SDK driver was removed;
polytoken replaced it).

## Protocol (the WS contract)

A shared `foldEvent(state, event)` reducer lives in `protocol/` and runs
identically on server (authoritative) and client (incremental render).
Protocol v2: connect/switch sends a `{type:"seed", events, epoch, seq}`
journal (clients fold from zero); `hello.resume` tail-replays the gap on
reconnect; `requestSeed` covers client-detected gaps. No server-side fold is
client-visible — a future Rust hub becomes a journaling router, no foldEvent
port needed.

## Feature status

Built and green (`bun test` unit + `bun run test:e2e` Playwright across
desktop + mobile):

- **Transcript** — streaming text, collapsible thinking, tool cards
  (running/ok/error, expandable), XSS-safe markdown, user bubbles, notices.
- **Composer** — Enter-to-send, steer/follow-up queueing, slash-command
  typeahead, `@`-file mention, image attach, model + thinking + facet pickers,
  permission-mode + adventurous-handoff toggles, Ctrl+R prompt history.
- **Approvals** — confirm/select/input/editor cards, goal proposals,
  unknown-type dismiss, binary yes/no, generic JSON fallback.
- **Sessions** — project-grouped sidebar (collapsible rail / mobile drawer),
  create/open/rename/archive, arbitrary-cwd new sessions, ⌘↑/⌘↓ prompt nav,
  rewind (click-twice confirmed), context meter with compact/clear.
- **Right sidebar** — flagged files + todos (polytoken parity).
- **Multi-client** — server-authoritative broadcast, snapshot-on-(re)connect,
  first-responder-wins approvals.
- **Notifications** — Web Push (SW + VAPID) for backgrounded phone; verified
  on iPhone. Requires real `PILOT_VAPID_SUBJECT`.
- **Remote infra** — single-process server serves the built client, app-level
  auth token gate (WS + `/debug`), loopback bind, `tailscale serve` + deploy.
- **PWA** — installable (manifest, SW), tab-title mirroring, build-sha
  update prompt, WS compression, auto-port self-isolation for e2e/preview.

Open work and backlog live in `TODO.md`. Architecture direction (Tauri
desktop shell, Rust hub) lives in `ADR-desktop-shell.md`.
