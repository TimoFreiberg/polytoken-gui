# Pilot.app — the macOS desktop shell

A thin native macOS app: an AppKit window hosting a `WKWebView`, wrapped around a
**local** pilot server it runs and supervises. This is the default, local-first way to
use pilot — the everyday coding-agent GUI. (Connecting to a remote pilot, e.g. the Mac
Mini, is a separate future feature.)

The app is deliberately almost stateless. All the real pilot code — server, web client,
update-watcher — lives in a **dedicated clone** that tracks `origin/main` and keeps
itself current (see "Updates"). The TS layer updates underneath the running `.app`; when
the **native shell itself** (`desktop/`) changes, Pilot notifies you to rebuild the `.app`
by hand (it can't safely self-replace without an Apple Developer ID — see "Updates → Native
shell").

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
- **Force-update on demand**: right-click the build stamp (sidebar footer) → **Force-update**
  for clicking right after you push to `main` — it applies even before the watcher's next
  fetch has noticed the commit (the same menu also copies the build hash). The watcher polls
  the server every few seconds so the force is picked up promptly.

### Native shell (rebuilding the `.app` itself)

The apply path rebuilds the TS and restarts the *server* — it never touches the running Swift
binary. So a change under `desktop/` (the AppKit shell, `Info.plist`, `build-app.sh`, the
icon) leaves the running `.app` stale. Pilot **detects** this and **notifies you to rebuild
by hand** — it does *not* swap the bundle itself:

- `build-app.sh` stamps the **`desktop/` tree sha** into the bundle
  (`Contents/Resources/.pilot-desktop-sha`). The app hands it to the watcher as
  `PILOT_APP_DESKTOP_SHA`.
- When that stamp differs from `origin/main:desktop`, the watcher emits
  `desktop-update-available` and the app posts a native notification: *"The app shell
  changed — quit Pilot and run desktop/build-app.sh."* You rebuild it in your own shell:

  ```bash
  cd <clone>/desktop && ./build-app.sh && open Pilot.app   # quit the running one first
  ```

- Detection uses the `desktop/` **tree sha** (not git HEAD), so a TS-only commit doesn't
  trigger it. The notification is deduped on the sha (the watcher re-emits each tick while
  the shell is stale; the app buzzes once per new sha).
- The notification is transient; for a **durable** reminder the watcher also reports
  `desktopStale` on every `/update/state` poll (the stamped sha vs the clone's checked-out
  `HEAD:desktop`), which lights a small **amber dot on the sidebar build stamp** until you
  rebuild. Note the references differ on purpose: the *notification* fires off
  `origin/main:desktop` (news from upstream, possibly before the clone has pulled it), while
  the *dot* tracks `HEAD:desktop` — i.e. it's lit exactly when a `build-app.sh` run right now
  would produce a different binary, so a rebuild always clears it. The dot only ever shows
  under the desktop app (the watcher knows the running bundle's stamp); it stays dark in a
  plain browser.

**Why not swap + relaunch the `.app` automatically?** Replacing an installed app bundle in
place trips macOS **App Management** (`kTCCServiceSystemPolicyAppBundles`). The OS only
exempts an *in-place self-update* when the new and old bundles share an **Apple Developer ID
Team** — ad-hoc / self-signed builds (this app) don't qualify and would prompt the user to
"allow Pilot.app to update or delete other applications." Self-signing makes the identity
stable but still doesn't satisfy the exemption. Having the user run `build-app.sh` in their
own shell sidesteps the permission entirely. The fully-automatic path would need a paid
Apple Developer ID + notarization (see "Not done yet"); the detect-and-notify approach keeps
it free and permission-free.

Needs the **Command Line Tools** (`swiftc`/`sips`/`iconutil`/`codesign`) to rebuild — the
same toolchain that built the app in the first place. A git-less build can't compute the
stamp, so it's skipped and the watcher simply never flags a native update (TS auto-update is
unaffected).

While a (TS) update applies (build + restart), the app raises a native **"Updating Pilot…"**
overlay over the webview — a frosted scrim + indeterminate spinner + a phase label
(`Building…`, `Restarting…`). It's driven by the watcher's `apply` events (one per phase on
its stdout machine channel, alongside `update-deferred` / `restart-requested` /
`desktop-update-available`) and torn down once the rebuilt server is healthy and the webview
has reloaded the fresh build. Native, not web, because the web client is exactly what's
restarting — it can't paint its own progress, and the restart leaves it showing a stale,
offline page.

"Current" means the *served bundle*, not git HEAD: the watcher compares the sha vite stamps
into `client/dist/.pilot-built-sha` against `origin/main`, so a state where HEAD advanced but
the bundle didn't (a manual `git pull`, an apply interrupted before its build, a build that
failed after the pull) is detected and self-heals on the next tick — a plain HEAD-vs-remote
check would call that "up to date" forever and leave you on stale code.

Notifications are owned by the app (`UNUserNotificationCenter`), so clicking one focuses
Pilot. The app sets `PILOT_UPDATE_NATIVE_NOTIFY=0` for the watcher to disable its standalone
`osascript` fallback — those notifications are attributed to Script Editor, so clicking one
opens Script Editor instead of Pilot.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PILOT_APP_CLONE` | `~/pilot-app` | The checkout the app runs from |
| `PILOT_DATA_DIR`  | `~/Library/Application Support/Pilot` | Server state (set in-app) |
| `PILOT_UPDATE_INTERVAL_MS` | `60000` | Watcher poll cadence |
| `PILOT_UPDATE_NATIVE_NOTIFY` | on (app forces **off**) | watcher's own `osascript` notification on defer; the app disables it and notifies itself |

(GUI apps don't inherit your shell env, so setting these for the launched app means a
`launchctl setenv` / `LSEnvironment` entry — they're mainly here for running the pieces
by hand.)

## WKWebView host capabilities (the web ↔ native bridge)

`WKWebView` gives the web client the whole web platform for free (DOM, fetch, WS,
IndexedDB, `localStorage`, clipboard on `localhost`, drag/drop, paste). But anything that
**hands off to the OS** is gated behind a delegate the host app must implement — and if it
doesn't, the behavior is *silently a no-op*. It works in a browser (the OS surface is
native there) and passes the headless-Chromium e2e, then does nothing in the packaged app.
That's how the image-attach button shipped broken.

There's no blanket switch, but the set is short and enumerable. **Rule of thumb: if a web
feature opens an OS surface (a panel, a new window, a permission prompt, a saved file) and
it "works in a browser but does nothing in `Pilot.app`", the bridge is missing here, not in
the web code.** All current bridges live in `AppDelegate.swift`'s delegate extensions.

| Web behavior | Native hook | Status |
|---|---|---|
| `<input type=file>` | `WKUIDelegate.runOpenPanelWith` → `NSOpenPanel` | ✅ wired (image-only filter) |
| `target=_blank` / `window.open` | `WKUIDelegate.createWebViewWith` → `NSWorkspace.open` | ✅ wired (→ system browser) |
| External link click | `WKNavigationDelegate.decidePolicyFor(navigationAction)` | ✅ wired (off-origin → system browser) |
| Downloads (`<a download>`, attachment, un-renderable MIME) | `WKNavigationDelegate` `.download` + `WKDownloadDelegate` → `NSSavePanel` | ✅ wired (generic, all downloads) |
| Camera / mic (`getUserMedia`, e.g. voice dictation) | `WKUIDelegate.requestMediaCapturePermissionFor` + `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` in `Info.plist` | ⬜ add when needed |
| JS `alert` / `confirm` / `prompt` | `WKUIDelegate.runJavaScript*Panel` | ⬜ not used (app has its own dialogs) |
| Web Notifications / Push | n/a — handled natively via `UNUserNotificationCenter` + the watcher | — |

Downloads and links are **generic-once**: the delegate doesn't care which feature triggers
it, so one implementation covers every future use. File-pick and media permissions are
per-surface. Downloads are wired ahead of any in-app download feature so the first one that
ships just works; if you serve a real download from the pilot server, give it a
non-renderable content type (or trigger it via `<a download>`) so it routes to the save
panel instead of rendering inline.

## Not done yet

- **Developer ID signing + notarization** — the prerequisite for *automatic* in-place native
  self-update (the macOS App Management self-update exemption needs an Apple Team ID; ad-hoc
  and self-signed don't qualify). Today native-shell changes are detect-and-notify + manual
  `build-app.sh`. It would also give frictionless double-click installs.
- A release/CI step to publish a built `.app`.

## Known caveat (resolved)

The app spawns the pilot server from an arbitrary directory. Previously that dir
became the server's `launchCwd`, which both defaulted a new session's cwd *and* was
implicitly trusted (D12) — so the app's launch dir silently became a trusted default.
**Resolved 2026-06-19:** the server's cwd no longer feeds any logic. No dir is
implicitly trusted (every cwd goes through pi's built-in trust: trust.json →
interactive card → deny-safe); the server boots to an empty landing (the client opens
a new-session draft at $HOME); and a bare new session defaults to $HOME. See
`docs/DONE.md`.
