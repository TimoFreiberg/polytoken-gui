# ADR — Desktop shell: Tauri now, Bun hub as supervised sidecar, Rust hub behind go/no-go

Status: **proposed, awaiting owner sign-off** (2026-07-02, from the design-dossier track).
Supersedes the shell part of the "📐 Architecture direction" note in `docs/TODO.md`
(2026-07-01) — the Rust-hub end-state there stays a valid *target*, gated by the criteria
below. Companion: `desktop/README.md` (the Swift shell this replaces).

## Decision

1. **Adopt Tauri v2 as the desktop shell now**, replacing the hand-rolled Swift/AppKit
   WKWebView app in `desktop/`. Justified today by exactly the things the Swift shell
   lacks and we keep paying for: a real updater for the *shell itself* (the Swift app
   can't self-replace — `desktop/README.md` "rebuild by hand"), tray-resident lifetime,
   single-instance, native pickers/menus later, and one codebase if a non-mac host ever
   matters.
2. **The hub stays Bun and runs as a Tauri-supervised sidecar.** No hub rewrite rides
   this migration — near-zero change to `server/`.
3. **The Rust-hub port is deferred behind explicit go/no-go criteria** evaluated after
   protocol v2 lands. Tauri-the-shell and Rust-the-hub are independent decisions; this
   ADR commits only to the first.

## Reconciling the reliability push-back

The owner's position: a long-running Rust daemon is attractive because "error handling is
just more reliable usually." This ADR agrees — and locates the Rust where that argument
actually bites. The component that must never die is the *supervisor*: the thing that
picks the port, spawns the hub, health-checks it, restarts it on crash, and tears it down
on quit. Under this decision that component **is Rust** (the Tauri/Tokio process), owning:

- spawn with explicit env (`PILOT_PORT`, resolved `PATH` — a Finder-launched app has a
  minimal one, same lesson the Swift shell learned),
- readiness gate on `GET /health` (already exists, `index.ts:185-194`),
- liveness loop (poll `/health`; restart on N consecutive failures),
- exponential-backoff restart with a crash-loop breaker (stop after M restarts/minute,
  surface a native dialog instead of spinning),
- SIGTERM-then-SIGKILL teardown on quit (the hub already handles SIGTERM cleanup of
  daemons, `polytoken-driver.ts` shutdown paths).

The part that changes weekly — hub logic, drivers, the fold — stays in TS where its 103
hub tests, the e2e suite, and the shared reducer live. Rewriting *that* in Rust buys
reliability-by-assertion while discarding the tests that provide reliability-by-evidence.
Note Tauri has **no official sidecar-lifecycle plugin** (only a community feature request,
plugins-workspace #3062) — the supervision loop is ~50 lines of our own Rust and is a
first-class deliverable of the spike, not an assumed freebie.

## Sidecar mechanics

Two modes, adopted in sequence:

- **Clone mode (transition, spike target):** the sidecar is `bun run src/index.ts` in the
  dedicated clone, exactly what the Swift shell spawns today — via the shell plugin's
  process spawning (not `externalBin`). The existing TS auto-update model (update-watcher
  + clone pull + supervised restart) keeps working unchanged. Tauri replaces only the
  Swift layer; day-one risk is minimal.
- **Bundled mode (target):** `bun build --compile` produces a single hub binary shipped
  as `bundle.externalBin` (target-triple naming, e.g. `pilot-hub-aarch64-apple-darwin`),
  spawned via `ShellExt::shell().sidecar("pilot-hub")`. The client `dist/` ships as
  bundle resources served by the hub (see below). App + hub + client update **atomically**
  through one updater artifact — the clone on disk disappears.

## Auto-update

`tauri-plugin-updater`: each release = signed bundle + minisign signature + a static JSON
manifest (`version`, `platforms.<target>.url`/`signature`); the app polls the manifest
URL (template vars `{{current_version}}`/`{{target}}`/`{{arch}}`). Two facts that shape
the posture:

- **Minisign signing is mandatory and ours** — an Ed25519 keypair we generate; no Apple
  involvement. The manifest + artifacts are static files; host them wherever the Mac can
  reach (a Tailscale-served directory, or GitHub releases).
- **Notarization stays skipped.** Ad-hoc signing (the Swift shell's current posture)
  remains right for a personal tool: right-click → Open once per machine. The $99/y
  Apple Developer question only reopens if pilot is ever distributed to non-technical
  users. The updater is orthogonal to Gatekeeper — self-applied updates don't re-acquire
  the quarantine attribute (spike verifies this on macOS 15+).

In clone mode, the existing update-watcher keeps updating the TS payload beneath a stable
shell; the Tauri updater covers only the shell (which is exactly the gap the Swift shell
has today — inverted). In bundled mode the updater covers everything.

## Single-instance, tray, window

- `tauri-plugin-single-instance`: second launch focuses the existing window (and can
  forward a deep link later, e.g. `pilot://session/<id>`).
- Tray (core `tray-icon` feature): closing the window keeps the process — and therefore
  the hub and every phone connection — alive. Tray menu: Open, Copy tailnet URL,
  Restart hub, Quit (real shutdown). macOS: activation policy → Accessory while the
  window is closed so no zombie Dock icon.
- The webview loads `http://127.0.0.1:<port>/` exactly like the Swift shell. We
  deliberately do NOT serve the client through Tauri's asset protocol: the hub serves
  identical bundles to the desktop webview and the phone, so there is one client build,
  one cache story (see the solidity plan's asset-delivery item), one origin for the WS.

## Mobile-remote preservation

Unchanged by construction: the hub binds the Tailscale interface regardless of what
spawned it. The phone keeps talking WS to the same server; nothing in this ADR touches
`protocol/` or the PWA. The tray-resident lifetime *improves* the phone story (closing
the desktop window no longer requires the window to stay open for remote use — today's
Swift shell dies with its window unless left running).

## SSH-to-remote-host sessions (sketch, not committed)

Remote sessions are a **hub/driver concern, not a shell concern** — the polytoken daemon
already speaks HTTP/SSE over a socket. Sketch: the driver's spawn seam grows a remote
variant (`ssh host polytoken serve --socket …` + a forwarded local socket/port;
`daemon-client.ts` just gets a different `baseUrl`), sessions carry a `host` field in the
session list. The Tauri shell needs zero changes for this — which is evidence the
shell/hub split is drawn correctly. File under protocol-v2-adjacent future work.

## Rust-hub go/no-go criteria (evaluate after protocol v2 ships)

GO only when **all** hold:

1. **Protocol v2 landed** — the hub is a journaling router with no server-side fold
   (the protocol v2 work shipped 2026-07-02). Porting before this means reimplementing
   `foldEvent` in Rust (reviving the dual-fold drift the shared reducer exists to
   prevent) or embedding JS. Hard blocker.
2. **Hub churn has flattened** — the `PilotDriver` seam and hub.ts have stopped growing
   weekly (this week alone added MCP management, SSE reconnect, sessionReset, queue
   methods). A rewrite freezes iteration on the most active surface in the repo.
3. **A concrete Bun deficiency exists** — measured hub RSS/CPU on the Mini that matters,
   or a distribution need for one runtime-free binary, or in-process Tauri integration
   worth having. "Rust would be nicer" does not qualify (per the direction note itself:
   no performance motivation today).
4. **The port is small** — at that point the hub is: WS fan-out + journal + HTTP/SSE
   client + process spawn. The fold stays TS on clients either way.

If GO: port incrementally behind the same wire contract, phone/PWA unaffected. If never
GO: the sidecar model is a perfectly stable end-state — supervision is already Rust.

## Walking-skeleton spike (1 day, exit criteria explicit)

1. Scaffold Tauri v2 app; tray + single-instance wired.
2. Supervisor: pick free port → spawn `bun run src/index.ts` (clone mode) with
   `PILOT_PORT` + resolved PATH → gate on `/health` → load webview.
3. Kill test: `kill -9` the hub → auto-restart + webview reload within 5s; crash-loop
   breaker demonstrably stops after M rapid failures.
4. Updater: local static `latest.json` + a version-bumped dummy build → in-place update
   applies and relaunches, ad-hoc signed, no quarantine prompt.
5. Measure vs Swift shell: cold launch to first paint, idle RSS of shell process.

Exit: all five green → schedule `desktop/` replacement as a normal task. Any red →
document it in this ADR and stay on the Swift shell (which keeps working meanwhile —
nothing in this ADR breaks it).

## Consequences

Gained: shell self-update, tray-resident phone serving, single-instance, a supervised-in-
Rust hub, a path to one-artifact distribution, cross-platform option. Paid: a Rust
toolchain in the repo, tauri.conf + signing keys to manage, ~1 day spike + a few days
replacement, and the Swift shell's simplicity (600 lines, zero deps) retired.

## Owner decisions needed

1. Sign off on sequence: spike in clone mode first, bundled mode later? (Alternative:
   jump straight to bundled — cleaner end-state, but couples the migration to building
   the compile+sign+manifest pipeline in week one.)
2. Where do updater artifacts live — Tailscale-served static dir on the Mini, or GitHub
   releases?
3. Keep the headless launchd path (Mini with no window) documented as a supported
   variant of the sidecar-free hub, or fold the Mini onto the tray-resident app too?

## References

- Tauri v2 sidecar/externalBin: <https://v2.tauri.app/develop/sidecar/>
- Shell plugin: <https://v2.tauri.app/plugin/shell/>
- Updater plugin (minisign, manifest, endpoints): <https://v2.tauri.app/plugin/updater/>
- Sidecar lifecycle-management gap (community request):
  <https://github.com/tauri-apps/plugins-workspace/issues/3062>
