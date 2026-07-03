# Pilot desktop shell (Tauri)

The macOS desktop app: a Tauri v2 shell that supervises a **local pilot hub** as a
sidecar and hosts the hub-served web client in a chromeless window. It replaces the
hand-rolled Swift/AppKit shell in `desktop/` (kept until this one has dogfood mileage —
see `docs/ADR-desktop-shell.md` for the decision and the spike results).

Like the Swift shell, the app is nearly stateless: server, web client, and
update-watcher live in a **dedicated clone** (default `~/pilot-app`) that tracks
`origin/main` and keeps itself current. What's new over Swift:

- **Shell self-update** via `tauri-plugin-updater` (minisign-signed artifacts, our key,
  no Apple involvement) — the Swift shell could only nag you to rebuild by hand.
- **Tray-resident lifetime**: closing the window keeps the process — and therefore the
  hub and any phone connection — alive. The tray menu has Open / Copy App URL /
  Restart Hub / Check for Shell Updates / Quit.
- **Single-instance**: a second launch focuses the running app.
- **Supervision in Rust**: health-gated boot, KeepAlive respawn, liveness probe
  (restart a hung-but-running hub), crash-loop breaker, SIGTERM-safe teardown
  (a signal routes through the same cleanup as Cmd+Q — no orphaned bun processes).

## How it works

On launch:

1. Picks a free loopback port.
2. Resolves config (clone dir, data dir, absolute `bun` path — a Finder-launched app
   has a minimal PATH).
3. Shows the bundled "Starting Pilot…" page, spawns the hub
   (`bun run src/index.ts` in `<clone>/server`, `PILOT_HOST=127.0.0.1`), and gates
   on `GET /health`.
4. Navigates the webview to `http://127.0.0.1:<port>/` and starts the update-watcher
   (`scripts/desktop/update-watcher.ts` in the clone).
5. Checks for a **shell** update (silent unless one exists; see Updates).

The supervisor loop respawns the hub on exit (a crash, or the watcher restarting it to
apply a TS update) and re-navigates the webview so fresh client assets show. Rapid
exits (<5s uptime) count toward a 6-strike crash-loop breaker that surfaces a fatal
dialog instead of spinning. A healthy hub that stops answering /health for ~30s is
SIGTERM'd and respawned. On quit — window Quit, Cmd+Q, SIGTERM, logout — both children
are SIGTERM'd (SIGKILL after 5s if ignored).

## Build & run

```bash
cd desktop-tauri
bun run dev     # tauri dev — debug build, spawns the real supervisor against ~/pilot-app
bun run build   # tauri build — release .app under target/release/bundle/macos/
```

Rust toolchain required (`rustup`); everything else comes through the Bun workspace.
`cargo check` / `cargo clippy` in this directory for fast iteration.

Release builds want the updater signing key in the environment, or they can't produce
updater artifacts:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pilot-shell.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
bun run build
```

The bundle is **ad-hoc signed, not notarized** (personal tool posture, same as the
Swift shell): first launch on a new machine is right-click → Open once.

### Test/dev launches

The shell honors two override vars the server never exports (so a launch from inside
a pilot-spawned agent shell can't be hijacked by inherited config):

- `PILOT_APP_CLONE` — the checkout to run from (default `~/pilot-app`)
- `PILOT_APP_DATA_DIR` — the data dir (default `~/Library/Application Support/Pilot`)

Everything else in the environment passes through to the spawned hub/watcher, so
`PILOT_DRIVER=mock PILOT_UPDATE_DRY_RUN=1` gives a fully hermetic instance:

```bash
PILOT_APP_CLONE=~/pilot-app PILOT_APP_DATA_DIR=$(mktemp -d) \
PILOT_DRIVER=mock PILOT_UPDATE_DRY_RUN=1 ./target/debug/pilot-desktop
```

Agent-legible probes: stderr logs `pilot: hub healthy <N>ms after launch` and
`pilot: fatal: …`; the hub's `/health` + `/debug/state` work as always.

## Updates (two layers)

**TS payload (server + client + watcher):** unchanged from the Swift shell — the
watcher polls `origin/main` in the clone, applies when idle, defers with a
notification + sidebar update card otherwise, and restarts the hub via `pilot.pid`;
the supervisor respawns it and reloads the webview. During an apply the shell paints a
frosted "Updating Pilot…" scrim over the (frozen, mid-restart) page, torn down by the
post-restart reload — with a 5-minute failsafe so it can't strand the window.

**The shell itself:** `tauri-plugin-updater` against a static manifest. The endpoint is
resolved at runtime, in order:

1. `PILOT_SHELL_UPDATE_URL` env var
2. a `shell-update-url` file in the data dir (one URL on a line)
3. neither → checks stay dormant (the tray item explains how to enable)

Checks run at startup (asks before installing; set `PILOT_SHELL_UPDATE_AUTO=1` for the
unattended install-and-relaunch posture) and on demand from the tray. Where the
manifest + artifacts live is still an open decision (the git remote is tangled, so
GitHub releases are out; a Tailscale-served static dir is the likely home —
`docs/ADR-desktop-shell.md`, "Owner decisions needed").

Publishing a shell release is manual for now:

```bash
# in desktop-tauri/, after bumping "version" in tauri.conf.json
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pilot-shell.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun run build
# upload target/release/bundle/macos/Pilot.app.tar.gz (+ .sig) and a latest.json:
#   { "version": "x.y.z", "pub_date": "…", "platforms": { "darwin-aarch64": {
#       "url": "https://…/Pilot.app.tar.gz", "signature": "<contents of .sig>" } } }
```

**The manifest's `version` must be the version baked into the artifact** (i.e. what
you built) — a higher manifest version over an older artifact makes every relaunch
"update" again, an infinite loop under `PILOT_SHELL_UPDATE_AUTO=1`. The future publish
script should derive the manifest from the bundle rather than trust a hand-typed value.

Plain-http endpoints are allowed (`dangerousInsecureTransportProtocol` in
`tauri.conf.json`) — deliberate: update integrity comes from the minisign signature,
not the transport, and the expected endpoint lives inside the tailnet. If the posture
ever changes, `tailscale serve` provides https for free.

**Keys:** the minisign keypair lives at `~/.tauri/pilot-shell.key` (+`.pub`),
passwordless — it never leaves this machine. The public key is baked into
`tauri.conf.json`. Losing the private key means shipping one manual reinstall with a
new keypair; **regenerating it invalidates every installed app's update path**, so
don't.

## Webview host capabilities

The Tauri webview is still WKWebView, but the bridge coverage differs from the Swift
shell (`desktop/README.md` has the original checklist):

| Web behavior | How it's handled | Status |
|---|---|---|
| `<input type=file>` | wry implements the open panel natively | ✅ built-in |
| External link click | `on_navigation` → system browser (off-origin is cancelled) | ✅ wired |
| `target=_blank` / `window.open` | not used by the client (no handler wired) | ⬜ add if the client ever emits them |
| Downloads | `on_download` → auto-save to ~/Downloads + notification (no save panel: the hook runs on the main thread, and Chrome-style auto-save is the better default anyway) | ✅ wired |
| Web Notifications / Push | native, via the watcher events + notification plugin | — |
| `pilotUpdate` JS bridge (early overlay raise) | not wired — the overlay raises on the watcher's first `apply` event instead, ≤5s after the click | ⬜ optional follow-up |

## Coexistence with the Swift shell

Different bundle id (`dev.pilot.app` vs `dev.pilot.desktop`), so both apps can be
installed. **Same data dir and same clone**, so it's one logical Pilot — which also
means: don't run both at once. The second hub refuses the pidlock and that shell
declares a crash-loop after ~15s. Quit one first.

## Not done yet

- Artifact hosting + a publish script (the open owner decision above).
- Shell-stale awareness in clone mode: the Swift shell's `PILOT_APP_DESKTOP_SHA`
  stamp/notify path is deliberately not wired — the updater replaces it once hosting
  exists. Until then a `desktop-tauri/` change on main means: build + reinstall by
  hand, like every pre-updater build.
- Window frame persistence across launches (tauri-plugin-window-state, config'd to
  ignore visibility so close-to-tray doesn't restore hidden).
- The early-overlay JS bridge (table above).
- Tailnet binding (the hub stays loopback-only here, exactly like the Swift shell;
  serving the phone from the desktop app is a separate decision with an auth story).
