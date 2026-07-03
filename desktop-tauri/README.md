# Pilot desktop shell (Tauri)

The macOS desktop app: a Tauri v2 shell that supervises a **local pilot hub** as a
sidecar and hosts the hub-served web client in a chromeless window. It replaces the
hand-rolled Swift/AppKit shell in `desktop/` (kept until this one has dogfood mileage —
see `docs/ADR-desktop-shell.md` for the decision and the spike results).

The app runs the hub in one of **two modes** (docs/ADR-desktop-shell.md "Sidecar
mechanics"; resolution lives in `src/config.rs`):

- **Bundled** — the packaged .app is fully self-contained: a compiled hub binary
  (`bun build --compile`, shipped as `Contents/MacOS/pilot-hub`) serving the bundled
  client (`Contents/Resources/client-dist`). No clone, no `bun` on the machine, no TS
  update-watcher; the updater swaps shell + hub + client **atomically**. This is what
  running from a .app resolves to.
- **Clone** — `bun run src/index.ts` in a dedicated checkout (default `~/pilot-app`)
  kept current by the TS update-watcher: the pre-bundled posture, now the dev loop.
  `tauri dev` and bare `target/*/pilot-desktop` binaries resolve here.

`PILOT_HUB_MODE=bundled|clone` overrides the default either way; a .app missing its
hub/client payload fails with a fatal dialog, never a silent clone fallback. What's
new over Swift:

- **Whole-app self-update** via `tauri-plugin-updater` (minisign-signed artifacts, our
  key, no Apple involvement) — the Swift shell could only nag you to rebuild by hand.
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
2. Resolves config: hub mode (bundled vs clone, above), data dir, and for clone mode
   the checkout + absolute `bun` path (a Finder-launched app has a minimal PATH).
3. Shows the bundled "Starting Pilot…" page, spawns the hub — the `pilot-hub` sidecar
   with `PILOT_CLIENT_DIST` pointing at the bundled client (bundled), or
   `bun run src/index.ts` in `<clone>/server` (clone) — and gates on `GET /health`.
4. Navigates the webview to `http://127.0.0.1:<port>/`, then starts the mode's update
   machinery: the shell's own periodic update loop (bundled; see Updates) or the TS
   update-watcher + a one-shot shell check (clone).

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

Both commands first compile the hub sidecar (`scripts/desktop/build-hub.ts` →
`binaries/pilot-hub-<triple>`, gitignored) because tauri-build stages `externalBin`
next to the binary and errors when it's missing; `bun run build` additionally builds
the client (bundled as the `client-dist` resource). Dev runs stay in clone mode and
never spawn that sidecar — set `PILOT_HUB_MODE=bundled` on a debug binary to exercise
the bundled path without a packaged .app.

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

The shell honors three override vars the server never exports (so a launch from inside
a pilot-spawned agent shell can't be hijacked by inherited config):

- `PILOT_HUB_MODE` — `bundled` or `clone`, overriding the am-I-in-a-.app default
- `PILOT_APP_CLONE` — the checkout for clone mode (default `~/pilot-app`)
- `PILOT_APP_DATA_DIR` — the data dir (default `~/Library/Application Support/Pilot`)

Everything else in the environment passes through to the spawned hub/watcher, so
`PILOT_DRIVER=mock PILOT_UPDATE_DRY_RUN=1` gives a fully hermetic instance:

```bash
PILOT_APP_CLONE=~/pilot-app PILOT_APP_DATA_DIR=$(mktemp -d) \
PILOT_DRIVER=mock PILOT_UPDATE_DRY_RUN=1 ./target/debug/pilot-desktop
```

Agent-legible probes: stderr logs `pilot: hub healthy <N>ms after launch` and
`pilot: fatal: …`; the hub's `/health` + `/debug/state` work as always.

## Updates

**Bundled mode — one atomic layer.** One updater artifact is the whole app (shell +
hub + client), so the shell's own periodic loop (`src/updater.rs`) inherits the TS
watcher's job *and* its policy, checked every minute
(`PILOT_SHELL_UPDATE_INTERVAL_MS`):

- unattended & idle (no client connected, no turn running per `/health`) → install +
  relaunch silently;
- anything else → defer: POST `/update/state` to the hub — the same wire the watcher
  drove — which raises the sidebar's "Update available" card, plus one notification
  per version. The click ("Update now", or force-update from the build-stamp menu)
  comes back on the next 5s poll and triggers the install.

An install swaps the .app in place, relaunches, and the fresh hub serves the fresh
client — the never-restart-mid-turn guarantee carries over from the watcher. Install
failures un-stick the card (`applyFailed`) so it offers retry.

**Clone mode — two layers, unchanged.** The TS update-watcher polls `origin/main`,
pull/build/restarts the hub beneath a stable shell (frosted "Updating Pilot…" scrim,
5-minute failsafe), and the Tauri updater covers only the shell via a one-shot startup
check (`PILOT_SHELL_UPDATE_AUTO=1` installs it unasked) + the tray item.

**Endpoint** (both modes), resolved at runtime, re-checked every cycle:

1. `PILOT_SHELL_UPDATE_URL` env var
2. a `shell-update-url` file in the data dir (one URL on a line)
3. neither → checks stay dormant (the tray item explains how to enable)

With a GitHub releases repo the stable endpoint is
`https://github.com/<owner>/<releases-repo>/releases/latest/download/latest.json`.

## Publishing a release

```bash
# after bumping "version" in tauri.conf.json (keep Cargo.toml in step):
bun scripts/desktop/publish.ts --repo <owner/releases-repo>   # --dry-run to inspect
```

The script builds signed (key from `TAURI_SIGNING_PRIVATE_KEY` or
`~/.tauri/pilot-shell.key`), **derives `latest.json` from the built bundle's
Info.plist** — a hand-typed manifest version over an older artifact makes every
relaunch "update" again, an infinite install loop under the unattended policy — and
publishes tar.gz + sig + manifest as a GitHub release via `gh` (refusing to reuse an
existing tag). The releases repo is public so installed apps download without
credentials; it does not have to be the code remote.

Plain-http endpoints are currently allowed (`dangerousInsecureTransportProtocol` in
`tauri.conf.json`) — tolerable because update integrity comes from the minisign
signature, not the transport. **Remove the flag once hosting lands on https** (GitHub
releases would do it): the plugin's https-only rule is release-builds-only, so local
updater testing on debug builds keeps working either way.

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
installed. **Same data dir** (and, in clone mode, same clone), so it's one logical
Pilot — which also means: don't run both at once. The second hub refuses the pidlock
and that shell declares a crash-loop after ~15s. Quit one first.

## Not done yet

- Artifact hosting: create the public releases repo and publish the first release
  (`scripts/desktop/publish.ts` is ready); then drop
  `dangerousInsecureTransportProtocol` from tauri.conf.json (GitHub is https; the
  https-only rule is release-builds-only, so local http updater testing keeps working).
- Shell-stale awareness in clone mode: the Swift shell's `PILOT_APP_DESKTOP_SHA`
  stamp/notify path is deliberately not wired — in bundled mode the updater makes it
  moot. Until the first release ships, a `desktop-tauri/` change on main means: build +
  reinstall by hand.
- Window frame persistence across launches (tauri-plugin-window-state, config'd to
  ignore visibility so close-to-tray doesn't restore hidden).
- The early-overlay JS bridge (table above).
- Tailnet binding (the hub stays loopback-only here, exactly like the Swift shell;
  serving the phone from the desktop app is a separate decision with an auth story).
