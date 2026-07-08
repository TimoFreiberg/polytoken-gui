# AGENTS.md — working in the pilot repo

Pilot is a personal, single-user remote-control GUI for a coding agent.
The agent is a separate codebase, maintained by a separate author, we only build a GUI for an existing product here.
Pilot is (/ aims to be) a desktop GUI and a mobile app.
The UI/UX mirror the Claude app or Codex desktop, but with focused features.
See `docs/DESIGN.md` for architecture, `docs/DECISIONS.md` for settled calls, `docs/TODO.md` for the backlog.

> **This branch is polytoken-only.** The live driver is the **polytoken** daemon,
> with a **mock** driver for dev/e2e. `PILOT_DRIVER=pi` is a hard error.

## Facts that save you a wrong turn

- **The live driver is `polytoken`** — an out-of-process daemon pilot talks to over a
  local socket/HTTP. The server's `PilotDriver` seam has two implementors: `mock`
  (deterministic, for dev/e2e) and `polytoken` (the live daemon). There is no in-process
  agent SDK on this branch; `PILOT_DRIVER=pi` is a hard error.
- **Ports 8787 (WS backend) and 5173 (Vite proxy) are the agent harness's own dev
  server.** Never `kill` or `lsof -ti:8787 | xargs kill` them — that nukes the
  harness you're talking through, and the session dies. If `EADDRINUSE` on 8787,
  something else is holding the port; find and stop it, not the harness's process.

## Stack & layout

Monorepo, Bun workspaces.
- `protocol/` — shared, JSON-serializable WS contract + the `foldEvent` reducer that
  runs identically on server & client.
- `server-rs/` — the Rust server. Axum-based WS bridge + HTTP routes + static file
  serving. Three crates: `pilot-protocol` (WS types + fold),
  `pilot-daemon-types` (auto-generated from OpenAPI), `pilot-server` (the binary).
  The `PilotDriver` seam has two implementors: `mock` (deterministic, for dev/e2e)
  and `polytoken` (the live daemon). **The installed daemon is
  `0.5.0-unstable.1`** (bearer-token auth). See `server-rs/PROGRESS.md` for the
  live-path validation status before building on it. Archived TS tests are in
  `server-rs/ts-test-reference/` for reference when porting cases to Rust.
- `client/` — Svelte 5 + Vite PWA. Reconnecting WS singleton, the same fold reducer,
  Claude-app theming in `src/app.css` (warm paper, light + dark).

## Commands

```bash
bun install
PILOT_DRIVER=mock bun run dev   # server + client, using mock driver (no daemon needed)
bun run dev                     # default: polytoken driver (needs a running daemon)
bun test                        # unit tests — protocol, client, scripts
bun run test:e2e                # Playwright — sets PILOT_DRIVER=mock automatically
bunx tsc --noEmit -p protocol/tsconfig.json   # typecheck protocol
bunx tsc --noEmit -p tsconfig.scripts.json   # typecheck scripts/ (dev tooling)
bunx tsc --noEmit -p tsconfig.e2e.json       # typecheck e2e/ (Playwright doesn't, by default)
bun run --cwd client check                    # svelte-check
bun run --cwd client build                    # prod bundle
cd server-rs && cargo build       # build the Rust server
cd server-rs && cargo test        # run all Rust tests
cd server-rs && cargo run         # run the Rust server (reads PILOT_PORT, PILOT_DATA_DIR, etc.)
```

`bun run check` runs protocol + scripts + e2e + client typechecks end to end.
`tsconfig.scripts.json` and `tsconfig.e2e.json` close the typecheck gap for the
dev-tooling and Playwright trees. Keep it green. **server-rs has its own CI
gate** (`rust-server` job in `.github/workflows/ci.yml`: `cargo fmt --check` +
`cargo clippy --locked --all-targets -- -D warnings` + `cargo test`); run
`bun run check:rs` locally for the same three checks.

**Driver note:** the server defaults to the polytoken daemon driver. Set
`PILOT_DRIVER=mock` to use the deterministic mock instead — you want this for UI dev
without a running daemon and for the dev-bar (`/?dev`). The e2e suite sets it
automatically; unit tests don't touch the driver at all. `PILOT_DRIVER=pi` is a hard
error (the driver was removed on this branch).

A third mode, **`PILOT_DRIVER=fake`**, runs the real `PolytokenDriver` over an
*in-process, corpus-backed fake daemon*: deterministic like the mock, but it
exercises the live driver stack (`daemon_client → event_map → driver`)
end-to-end. It reads the frozen corpus (`server-rs/tests/corpus`) and fails loud
if it's absent, so it's dev/e2e-only (never shipped). The corpus-backed **live e2e
tier** drives it: `bun run test:e2e:live` (separate `playwright.live.config.ts`
over `e2e/live/`; the default `bun run test:e2e` mock tier — `desktop`/`mobile` —
is unchanged). It's a deliberate subset over the frozen corpus flows, not the full
mock suite (see `docs/DECISIONS.md` D21).

**Worktree note:** if you're spawned in an isolated worktree, work there — don't
fall back to `~/src/pilot` (a concurrent session may be committing there; two
agents on one working copy scramble each other's commits). A fresh worktree
starts without `node_modules` (gitignored), so run `bun install` in it before
building/testing. The e2e suite runs fully inside one checkout — it boots its own
dev server — so a worktree can run it standalone.

**Auto-port self-isolation (why `bun run test:e2e` and the preview "just work"):**
the e2e suite (`PILOT_AUTO_PORT=1`) and the mock preview (`scripts/dev.ts` with
`$PORT` set) run in **auto-port mode**, which deliberately **ignores any inherited
`PILOT_PORT` / `PILOT_DATA_DIR`** and grabs its own OS-assigned free backend port +
a per-port data dir. This matters because the live pilot **desktop app exports both
vars into every shell it spawns** (so an agent session running inside it inherits
`PILOT_PORT=<app port>` and the app's data dir). Auto-port mode means a run launched
from inside the app never aims at — nor fights the PID lock of — the running app's
backend/data dir, and two concurrent agent sessions never collide either. So just run
`bun run test:e2e` / launch the preview as-is; **no `env -u` or `PILOT_DATA_DIR=$(mktemp -d)`
scrubbing needed.** (Only Vite stays on a fixed port — Playwright health-checks it as a
known URL and re-evaluates the config per worker, so it can't be a random free port;
override `PILOT_E2E_VITE_PORT` to run two e2e suites at literally the same time.)
Bare, non-auto `bun run dev` still honors an explicit `PILOT_PORT` (default 8787) —
but note it would *also* inherit the app's, so prefer the auto-port preview for UI work.

## Verifying the UI (agent-legible introspection)

This is set up so you can verify autonomously — use it.
- **Launch + screenshot:** the `Claude_Preview` config named `pilot` runs the
  **mock driver** on an **auto-assigned free port** (`autoPort`, so parallel worktree
  sessions never fight over one hardcoded port — `scripts/dev.ts` takes the harness's
  `$PORT` for Vite and grabs its own free backend port). It boots deterministic fixture
  sessions + the `/?dev` dev bar, which is what you want for UI work (no running daemon
  needed). `preview_start("pilot")` → `preview_screenshot`; the call's returned `port`
  is where it landed. Use `preview_resize` for mobile/light/dark. Verify text/structure
  with `preview_snapshot`, errors with `preview_console_logs`. (`pilot-real`, port 5173,
  runs the real daemon driver for eyeballing live output — rarely what you want from an
  agent.) `scripts/dev.ts` gates Vite on the server's `/health`, so the page is
  connected on first load — no "Offline" warmup window to wait through.
- **Drive any UI state deterministically:** open `/?dev` to get a dev bar with
  buttons (`reply`, `confirm`, `input`, `ambient`) that push the mock to
  that state. Or send a `{type:"mock", script}` WS message.
- **Inspect server state directly:** `GET /debug/state` returns the full
  authoritative `SessionState` as JSON. `curl localhost:8787/debug/state | …`.
- Fixtures + scripts live in the Rust server's `mock_driver.rs`. Add a script there to get a
  new reproducible UI state.
- **Committed regression suite:** `bun run test:e2e` (Playwright, in `e2e/`). It
  reuses a running `bun run dev` (or starts one), resets the mock via `/debug/reset`
  in `beforeEach`, and asserts DOM across desktop + a mobile (Pixel 7) project. Add a
  spec when you add UI. This is the repeatable feedback loop; `Claude_Preview` is for
  live eyeballing.

## Conventions

- A formatter runs automatically on every file write (biome/prettier-style). Don't
  fight it; re-Read before an Edit if a region was reformatted.
- VCS is **jj** (see the `jj` skill). Commit when done; review with `jj diff --git`;
  imperative subject ≤72 chars.
- Keep `protocol/` free of runtime/DOM deps — it's imported by both halves
  (the Rust server and the Svelte client).
- The `PilotDriver` trait is the contract for swapping mock ↔ polytoken. Add
  capabilities there, implement in both drivers.
- **Collapse/disclosure affordances share two primitives.** The glyph is
  `client/src/components/ui/Chevron.svelte` (stroked SVG; `variant="disclosure"`
  for inline sections, `variant="menu"` for dropdown badges) — don't hand-roll a
  `▸`/`▾` triangle. The open/close animation is `transition:reveal` from
  `client/src/lib/transitions.js` (a `slide` wrapper that honours
  `prefers-reduced-motion`) — don't call `slide` directly. The chevron inherits a
  faint `currentColor`; brighten it on header hover with a scoped rule on the
  parent's own header class — e.g. `.group-head:hover :global(.chevron)` in the
  sidebar (a parent's plain class can't reach a child component's scoped element
  without `:global`). Reference design: the sidebar project caret.
- **Every UI action needs a hotkey and a tooltip.** Any clickable element — buttons,
  toggles, menu items, approval actions, settings controls — must have a `title`
  attribute naming the action (and its keyboard shortcut if one exists). Reviewers:
  flag missing tooltips/hotkeys the same way you'd flag missing error handling.
