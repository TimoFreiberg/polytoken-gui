# Pilot.app — the macOS desktop shell

A thin native macOS app: an AppKit window hosting a `WKWebView`, wrapped around a
**local** pilot server it runs and supervises. This is the default, local-first way to
use pilot — the everyday coding-agent GUI. (Connecting to a remote pilot, e.g. the Mac
Mini, is a separate future feature.)

The app is deliberately almost stateless. All the real pilot code — server, web client,
update-watcher — lives in a **dedicated clone** that tracks `origin/main` and keeps
itself current (see "Updates"). So the `.app` itself rarely needs rebuilding; the clone
updates underneath it.

## How it works

On launch the app:

1. Picks a free loopback port.
2. Resolves config (clone dir, data dir, the absolute path to `bun` — a Finder-launched
   app has a minimal `PATH`, so we locate `bun` and hand spawned processes a usable PATH).
3. Spawns the pilot server (`bun run src/index.ts` in `<clone>/server`) bound to
   `127.0.0.1:<port>`, with no auth token (loopback + single-user), and gates on
   `/health`.
4. Loads `http://127.0.0.1:<port>/` in a chromeless window (transparent titlebar — the
   app's own header reads as the title bar).
5. Starts the update-watcher (`scripts/desktop/update-watcher.ts` in the clone).

It **supervises** both processes: if the server exits — a crash, or the watcher
restarting it to apply an update — it's respawned (KeepAlive), and the webview reloads so
new client assets show. On quit, both are SIGTERM'd.

## One-time setup

Create the dedicated clone the app boots from (anything but your dev tree, so
`git pull --ff-only` never fights uncommitted work):

```bash
git clone <pilot-repo-url> ~/pilot-app
cd ~/pilot-app && bun install && bun run build
```

(Set `PILOT_APP_CLONE` if you want it somewhere other than `~/pilot-app`.)

## Build & run

```bash
cd desktop
./build-app.sh            # compiles with swiftc → desktop/Pilot.app
open Pilot.app            # or move it to /Applications
```

`build-app.sh` calls `swiftc` directly (no SwiftPM/Xcode project) — the app has no
third-party deps, just AppKit/WebKit from the SDK, so it builds with only the Command
Line Tools installed. The app is **ad-hoc signed, not notarized** (it's a personal tool). First launch:
right-click → **Open** once to get past Gatekeeper. Notarizing (Apple Developer account)
would make double-click installs clean across machines, if you ever want that.

## Updates

The watcher polls `origin/main` in the clone and keeps it current without stomping live
work (full policy in `scripts/desktop/update-watcher.ts`):

- **No client connected and nothing running** → apply immediately (pull → install if the
  lock moved → build → restart the server; the app respawns it and reloads).
- **Otherwise** → defer. With the app open you get a native "update ready"
  notification **and** an in-app **update card** (sidebar) with an "update now"
  button — clicking it asks the watcher to apply on demand. Closing the app lets the
  next poll auto-apply.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PILOT_APP_CLONE` | `~/pilot-app` | The checkout the app runs from |
| `PILOT_DATA_DIR`  | `~/Library/Application Support/Pilot` | Server state (set in-app) |
| `PILOT_UPDATE_INTERVAL_MS` | `60000` | Watcher poll cadence |
| `PILOT_UPDATE_NATIVE_NOTIFY` | on | macOS notification when an update is deferred |

(GUI apps don't inherit your shell env, so setting these for the launched app means a
`launchctl setenv` / `LSEnvironment` entry — they're mainly here for running the pieces
by hand.)

## Not done yet

- **Code-signing/notarization** for frictionless installs.
- **App icon** (`Resources/`), and a release/CI step to publish a built `.app`.

## Known caveat (resolved)

The app spawns the pilot server from an arbitrary directory. Previously that dir
became the server's `launchCwd`, which both defaulted a new session's cwd *and* was
implicitly trusted (D12) — so the app's launch dir silently became a trusted default.
**Resolved 2026-06-19:** the server's cwd no longer feeds any logic. No dir is
implicitly trusted (every cwd goes through pi's built-in trust: trust.json →
interactive card → deny-safe); the server boots to an empty landing (the client opens
a new-session draft at $HOME); and a bare new session defaults to $HOME. See
`docs/DONE.md`.
