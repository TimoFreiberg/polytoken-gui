# pilot

A personal, single-user remote-control web UI for the [`pi`](https://github.com/earendil-works/pi)
coding agent. pi runs on a Mac Mini; you *pilot* it from a work-MacBook browser or
your phone over Tailscale. The look mirrors the Claude app.

The name: you **pilot** pi remotely (pi + lot).

## Status

Early. M0–M3 built and screenshot-verified against a deterministic mock of pi:
streaming transcript, tool cards, prompt/steer/stop, mobile approval cards (incl.
the project-trust gate) + generic fallback, ambient status/widgets, a reconnecting
PWA. Real pi wiring (M5) and remote deploy (M7) are next. See `docs/`.

## Quick start (dev)

```bash
bun install
bun run dev      # Bun WS server :8787 + Vite client :5173
open http://localhost:5173
```

`http://localhost:5173/?dev` adds a dev bar to drive the mock to any UI state.
`http://localhost:8787/debug/state` dumps the authoritative session state as JSON.

## Architecture (one paragraph)

A Bun/TS server embeds the pi SDK behind a `PilotDriver` seam, folds the agent's
event stream into an authoritative `SessionState`, and broadcasts it over WebSocket;
browser/phone clients are thin projections that fold the same events with the same
reducer and snapshot-on-reconnect. Shared durable state lives on the server;
per-client view state (selection, composer draft) stays local. Full design,
decisions, and the feature roadmap are in [`docs/`](docs/).
