# Pilot desktop shell (Tauri)

The macOS desktop app: a Tauri v2 shell that supervises a **local pilot hub** as a
sidecar and hosts the hub-served web client in a chromeless window. It replaced the
hand-rolled Swift/AppKit shell (now deleted — see `docs/ADR-desktop-shell.md` for the
decision and the spike results).

The app runs the hub in one of **two modes** (docs/ADR-desktop-shell.md "Sidecar
mechanics"; resolution lives in `src/config.rs`):

- **Bundled** — the packaged .app is fully self-contained: a compiled hub binary
  (`bun build --compile`, shipped as `Contents/MacOS/pilot-hub`) serving the bundled
  client (`Contents/Resources/client-dist`). No clone, no `bun` on the machine; the
  updater swaps shell + hub + client **atomically**. This is what running from a .app
  resolves to.
- **Clone** — `bun run src/index.ts` in a dedicated checkout (default `~/pilot-app`).
  The dev loop — no payload auto-update; restart the hub (tray) after editing it.
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
   machinery: the shell's own periodic update loop (bundled; see Updates) or a one-shot
   shell check (clone).

The supervisor loop respawns the hub on exit (a crash) and re-navigates the webview so
fresh client assets show. Rapid
exits (<5s uptime) count toward a 6-strike crash-loop breaker that surfaces a fatal
dialog instead of spinning. A healthy hub that stops answering /health for ~30s is
SIGTERM'd and respawned. On quit — window Quit, Cmd+Q, SIGTERM, logout — both children
are SIGTERM'd (SIGKILL after 5s if ignored).

## Build & run

```bash
cd desktop
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

### Installing a release

The bundle is **ad-hoc signed, not notarized** (personal tool posture, same as the
Swift shell). That means a **browser-downloaded** copy carries the quarantine xattr
and Gatekeeper refuses it outright — the misleading *"Pilot.app is damaged and can't
be opened"* dialog, with no Open-Anyway path on current macOS (the right-click → Open
bypass no longer applies to ad-hoc apps). Install without a browser instead:

```bash
curl -sSL https://github.com/TimoFreiberg/polytoken-gui/releases/latest/download/Pilot.app.tar.gz \
  | tar xz -C /Applications
```

curl sets no quarantine attribute, so the app opens normally. Already downloaded a
"damaged" copy? Un-quarantine it: `xattr -cr /path/to/Pilot.app`. After the first
launch the app updates itself (self-applied updates never re-acquire quarantine —
verified in the ADR spike).

### Test/dev launches

The shell honors three override vars the server never exports (so a launch from inside
a pilot-spawned agent shell can't be hijacked by inherited config):

- `PILOT_HUB_MODE` — `bundled` or `clone`, overriding the am-I-in-a-.app default
- `PILOT_APP_CLONE` — the checkout for clone mode (default `~/pilot-app`)
- `PILOT_APP_DATA_DIR` — the data dir (default `~/Library/Application Support/Pilot`)

Everything else in the environment passes through to the spawned hub, so
`PILOT_DRIVER=mock PILOT_UPDATE_DRY_RUN=1` gives a fully hermetic instance:

```bash
PILOT_APP_CLONE=~/pilot-app PILOT_APP_DATA_DIR=$(mktemp -d) \
PILOT_DRIVER=mock PILOT_UPDATE_DRY_RUN=1 ./target/debug/pilot-desktop
```

Agent-legible probes: stderr logs `pilot: hub healthy <N>ms after launch` and
`pilot: fatal: …`; the hub's `/health` + `/debug/state` work as always.

## Updates

**Bundled mode — one atomic layer.** One updater artifact is the whole app (shell +
hub + client), so the shell's own periodic loop (`src/updater.rs`) owns updates, checked
every minute (`PILOT_SHELL_UPDATE_INTERVAL_MS`):

- unattended & idle (no client connected, no turn running per `/health`) → install +
  relaunch silently;
- anything else → defer: POST `/update/state` to the hub — which raises the sidebar's
  "Update available" card, plus one notification per version. The click ("Update now",
  or force-update from the build-stamp menu) comes back on the next 5s poll and triggers
  the install.

An install swaps the .app in place, relaunches, and the fresh hub serves the fresh
client — the never-restart-mid-turn guarantee holds. Install failures un-stick the
card (`applyFailed`) so it offers retry.

**Clone mode — shell only.** No payload auto-update (you're editing that checkout).
The Tauri updater covers the shell via a one-shot startup check
(`PILOT_SHELL_UPDATE_AUTO=1` installs it unasked) + the tray item.

**Endpoint** (both modes), resolved at runtime, re-checked every cycle:

1. `PILOT_SHELL_UPDATE_URL` env var — the literal `off` disables checks (hermetic runs)
2. a `shell-update-url` file in the data dir (one URL on a line)
3. the baked-in default: the public releases repo,
   `https://github.com/TimoFreiberg/polytoken-gui/releases/latest/download/latest.json`

So installed apps update out of the box; the overrides exist for tests and for
pointing a machine at alternative hosting (e.g. a tailnet static dir).

## Publishing a release

The normal path is one command; CI does the heavy lifting:

```bash
bun scripts/desktop/release.ts            # --patch (default), --minor, --major, --version X.Y.Z
```

It bumps the version (tauri.conf.json + Cargo.toml + lock), commits `Release vX.Y.Z`,
tags it (via the colocated `.git` — jj can't create tags), moves `main`, and pushes.
The tag triggers ci.yml's `release` job, which — only after the web + desktop test
jobs pass — builds signed on a macOS runner and publishes via `publish.ts`. Running
apps pick the release up within a minute. One-time setup: the minisign key as an
Actions secret —

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/pilot-shell.key
```

(Owner call, 2026-07-03: the key lives in Actions secrets. Fork PRs never see
secrets, so the exposure is the GitHub account itself — accepted for a single-user
tool, and it doubles as a key backup.)

`publish.ts` also works standalone from this machine (`--repo
TimoFreiberg/polytoken-gui`, `--dry-run` to inspect): it builds signed (key from
`TAURI_SIGNING_PRIVATE_KEY` or `~/.tauri/pilot-shell.key`), **derives `latest.json`
from the built bundle's Info.plist** — a hand-typed manifest version over an older
artifact makes every relaunch "update" again, an infinite install loop under the
unattended policy — and publishes tar.gz + sig + manifest as a GitHub release,
refusing to reuse an existing tag. In CI it additionally gets `--tag-must-match` so a
manifest can never disagree with the pushed tag.

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
| Web Notifications / Push | native, via the notification plugin | ✅ wired |
| `pilotUpdate` JS bridge (early overlay raise) | not wired — the overlay raises on the updater's first apply event instead, ≤5s after the click | ⬜ optional follow-up |

## Not done yet

- Window frame persistence across launches (tauri-plugin-window-state, config'd to
  ignore visibility so close-to-tray doesn't restore hidden).
- The early-overlay JS bridge (table above).
- Tailnet binding (the hub stays loopback-only; serving the phone from the desktop app
  is a separate decision with an auth story).
