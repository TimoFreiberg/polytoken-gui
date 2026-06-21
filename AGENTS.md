# AGENTS.md — working in the pilot repo

Pilot is a personal, single-user remote-control web UI for the **pi** coding agent.
pi runs on a Mac Mini; you drive it from a browser/phone over Tailscale. The UI
mirrors the Claude app. See `docs/DESIGN.md` for architecture + the feature
roadmap, `docs/DECISIONS.md` for settled calls, `docs/OPEN-QUESTIONS.md` for what's
awaiting the owner's input.

## Facts that save you a wrong turn

- **`@earendil-works/pi-*` ≡ `@mariozechner/pi-*`** — same project. Mario was
  acquired by Earendil and the repo moved to the org scope. Depend on the published
  `@earendil-works/pi-coding-agent`. (Confirmed importable under Bun, v0.79.5.)
- pi source is at `~/src/pi`; its docs/examples are the contract — read them, don't
  guess (`extend-pi` skill points at them). Prior art studied, not forked:
  `~/src/pi-gui` (Electron React shell; its `session-driver` types we vendored, its
  extension-visibility UI is worth mining) and `~/src/kellercomm` (the Axum+Svelte+WS
  template whose *patterns* we ported to TS).
- **Ports 8787 (WS backend) and 5173 (Vite proxy) are the agent harness's own dev
  server.** Never `kill` or `lsof -ti:8787 | xargs kill` them — that nukes the
  harness you're talking through, and the session dies. If `EADDRINUSE` on 8787,
  something else is holding the port; find and stop it, not the harness's process.

## Stack & layout

Monorepo, Bun workspaces.
- `protocol/` — shared, JSON-serializable WS contract (vendored from pi-gui's
  `session-driver`) + the `foldEvent` reducer that runs identically on server & client.
- `server/` — Bun (`Bun.serve`) WS bridge + `/debug/state`. Embeds a `PilotDriver`
  (the seam). M0 = `MockDriver` (deterministic fixtures); M5 swaps in the real
  pi-sdk driver behind the same interface — the hub never changes.
- `client/` — Svelte 5 + Vite PWA. Reconnecting WS singleton, the same fold reducer,
  Claude-app theming in `src/app.css` (warm paper, light + dark).

## Commands

```bash
bun install
PILOT_DRIVER=mock bun run dev   # server + client, using mock driver (no pi needed)
bun run dev                     # same, but uses real pi driver (needs pi running)
bun test                        # unit tests — no driver needed, no mock required
bun run test:e2e                # Playwright — sets PILOT_DRIVER=mock automatically
bunx tsc --noEmit -p protocol/tsconfig.json   # typecheck server/protocol the same way
bun run --cwd client check                    # svelte-check
bun run --cwd client build                    # prod bundle
```

**Driver note:** the server defaults to the real pi SDK driver. Set `PILOT_DRIVER=mock`
to use the deterministic mock instead — you want this for UI dev without a running
pi instance and for the dev-bar (`/?dev`). The e2e suite sets it automatically;
unit tests don't touch the driver at all.

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
  sessions + the `/?dev` dev bar, which is what you want for UI work (no running pi
  needed). `preview_start("pilot")` → `preview_screenshot`; the call's returned `port`
  is where it landed. Use `preview_resize` for mobile/light/dark. Verify text/structure
  with `preview_snapshot`, errors with `preview_console_logs`. (`pilot-real`, port 5173,
  runs the real pi driver for eyeballing live output — rarely what you want from an
  agent.) `scripts/dev.ts` gates Vite on the server's `/health`, so the page is
  connected on first load — no "Offline" warmup window to wait through.
- **Drive any UI state deterministically:** open `/?dev` to get a dev bar with
  buttons (`reply`, `confirm`, `trust`, `input`, `ambient`) that push the mock to
  that state. Or send a `{type:"mock", script}` WS message.
- **Inspect server state directly:** `GET /debug/state` returns the full
  authoritative `SessionState` as JSON. `curl localhost:8787/debug/state | …`.
- Fixtures + scripts live in `server/src/fixtures.ts`. Add a script there to get a
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
- Keep `protocol/` free of runtime/DOM deps — it's imported by both halves.
- The `PilotDriver` interface is the contract for swapping mock ↔ real pi. Add
  capabilities there, implement in both drivers.
- **Every UI action needs a hotkey and a tooltip.** Any clickable element — buttons,
  toggles, menu items, approval actions, settings controls — must have a `title`
  attribute naming the action (and its keyboard shortcut if one exists). Reviewers:
  flag missing tooltips/hotkeys the same way you'd flag missing error handling.
