# Pantoken — Decisions

Settled architectural calls. Each is reversible unless noted. Numbers kept
for cross-reference with git history.

## Monorepo: GUI + remote infra in one repo

`protocol/` (shared types + fold reducer, no runtime deps) · `server-rs/` (Rust
WS hub + drivers) · `client/` (Svelte 5 PWA) · `deploy/`. The server _is_ the
protocol contract — WS schema, server-side fold, and client reducer must evolve
together, so splitting now forces premature version coordination.

## State model: server-authoritative, split durable vs per-client

**Durable shared** (server-owned, broadcast): sessions, transcripts, statuses,
pending approvals. **Per-client view** (client-local, never shared): selected
session, composer draft, sidebar collapse. This split is load-bearing at the
protocol level — broadcasting one whole-state blob makes two tabs fight over
the composer. The server owns pending approvals, the transcript snapshot, and
ambient status/widgets because the daemon can't replay them on reconnect.

## Verification = deterministic mock + screenshot loop

A mock driver replays scripted event sequences so every UI state is
reproducible without a live daemon. `/debug/state` + `/debug/reset` (mock-only)
let an agent assert on server state directly. `/?dev` drives the mock to any
state. This is the dev/test surface; the live polytoken driver is for real use.

## Concurrency = multiple concurrent warm sessions

N sessions run/stream concurrently server-side, each a separate polytoken
daemon process (one daemon = one session = one port). The hub keeps a
`Map<sessionId, WarmSession>`; all clients share one focused session (per-
client focus is overkill for single-user). Nothing is disposed on a focus-
change, so a backgrounded session keeps streaming and re-focuses instantly.

## Polytoken feature parity

We want to support any feature that the polytoken tui supports.
Having extra features is fine, like git/jj workspace management.

## Workspace = arbitrary GUI paths, trust as safety net

No allowlist — open any path from the UI. polytoken daemons have a permission/approval system which we support.
The operator is responsible for checking what directory they're working in.

## Draft persistence

Everything settable in the new-session draft UI is persisted per-project (keyed
`n:<cwd>` in localStorage) and survives a session switch + reload. Losing a
half-configured draft erodes trust in the tool. Default for any new draft
control: persist it, unless it's inherently ephemeral. Add an e2e round-trip
in `e2e/drafts.e2e.ts` for each persisted field.

## Phone attention views may cover the composer when visibly minimizable

Desktop Q&A remains inline above the composer. On phones, Q&A and approvals use
one readable full-screen attention view because the narrow viewport makes an
inline card compete with both transcript and composer. Every such view has a
visible 44px Minimize action and Back-gesture support; minimizing returns to the
transcript and exposes a persistent shelf immediately above the composer. This
satisfies the non-blocking intent of Q5/Q10 while preserving phone readability.

## Phone composer settings use one summary control

On phones, permission mode, facet, model, and thinking level remain visible in
their familiar order in the composer's footer, but the footer is one 44px-or-taller
button rather than four cramped tap targets. It opens a full-screen Session controls
view with readable option rows, context-window details, and Back-gesture support.
Desktop retains the individual popup controls. The image-attachment action is a bare
paperclip with a transparent 44px hit area; Send remains the composer's emphasized
gold action.

## Tech stack

The desktop GUI is a Tauri app. As much as is reasonable is written in Rust (good language).
There are good architectural reasons for keeping the gui and the server separate, mostly the ability for remote gui sessions to connect to a local hub to be able to start agent sessions on the local machine.
Otherwise, keep architecture simple and straightforward.

## Rust best practices

Async where necessary, sync where possible.
Anything that can reasonably block should not be a gui bottleneck, gui snappiness is paramount.
Panics should be avoided, prefer complex error handling over simple panics that cause random crashes.
The operator won't look at the logs, so don't log informational stuff via tracing. Do log stuff to tracing that can help diagnose error cases.
Do not use Tokio Mutexes. No exceptions.
Actors and channels are good when work can be done in the background. But for things in the user action bottleneck path, it is likely to cause visible latency. So we might want to look for different solutions.

## Daemon→pantoken accumulator stays server-side in Rust (A′)

The event accumulator (`event_map` + `ui_bridge`: `DaemonEvent` → `SessionDriverEvent`)
stays server-side, ported to Rust — it is NOT moved client-side. The client is
Svelte/TS and stays thin on the stable pantoken WS wire. Moving the accumulator
client-side would relocate logic out of Rust into TS and duplicate it across
desktop + the imminent mobile app, losing the server's version-shield against
daemon churn (polytoken moves ~daily). The daemon owning more state
(`/history.emitted_at`, `/prompt` auto-queue) _shrinks_ the accumulator but does
not change where it lives. Single authority = one place to adapt on a daemon bump,
which is decisive now that mobile is the next build target after desktop.

## Pin the golden corpus, not the daemon binary

The live path runs against the ambient `polytoken` binary (daemon head, upgraded
~daily); there is no pin mechanism. Deterministic tests instead replay a committed
golden SSE corpus captured from a tagged version
(`server-rs/tests/corpus/<version>/`), canonicalized for stable ids/timestamps. A
daily daemon bump that breaks behavior turns a corpus test red with a precise diff
instead of silently corrupting the GUI. Re-capturing the corpus
(`scripts/capture-daemon-corpus.ts`) is a deliberate, separate step taken on
conscious adoption. Supersedes the earlier "pin the daemon version" standing
invariant (PROGRESS.md #3).

## Invariant: sidebar running indicator and transcript in-progress display must agree

Both the sidebar listing the sessions and the currently open session transcript have in-progress indicators.
The sidebar has a spinner on the right of the session title and the session transcript has an elapsed timer, a running token display, and a stop button at the bottom that allows stopping the running agent turn.
These should always agree with each other. If one is visible, all of them must be visible.
## Submenu close always restores composer focus

Whenever a composer-chrome submenu closes — facet/permission/branch pickers
(`MenuBadge`), the model picker, or the draft directory picker — focus returns
to the composer textarea, regardless of how the menu was opened or closed
(Enter, Esc, click-select, click-outside, phone back-gesture). This supersedes
the earlier `openedViaKeyboard`-gated design in the model picker, which only
refocused on hotkey-opened flows. That gate was an over-strict interpretation
of a loose requirement; issue #54 settles the intended behavior. The badge
pickers (facet/permission/model/branch) are `display:none` under 859px
(replaced by `MobileSessionControls`), so the soft-keyboard concern that
motivated the gate does not apply to them. The draft directory picker is the
one exception: its trigger (the project chip) is touch-tappable and visible on
mobile, so on a phone its close focuses the project chip rather than the
textarea to avoid popping the soft keyboard. Contextual inline menus (slash,
@-mention, arg menus, prompt history) keep focus in the textarea throughout
and need no change.

## Remote deployment: version source = codegen-time `polytoken --version` (Option A)

The remote deployment plan needed a polytoken compatibility-target constant —
a version stamp embedded at codegen time that later provisioning phases check
against an installed daemon. The question was: where does the authoritative
version come from?

**Decision: Option A — codegen-time daemon version.** Run `polytoken --version`
at codegen, parse the semver (with prerelease), and embed as
`POLYTOKEN_DAEMON_TARGET_VERSION` in `pantoken-daemon-types`.

**Rationale:** `polytoken openapi` exposes `info.version = "0.1.0"` — a static
string that has never tracked daemon releases (installed daemon is
`0.5.0-unstable.9`). The `GET /version` endpoint returns the *runtime* daemon
version, which cannot be captured at codegen time. `polytoken --version` is the
only source that tracks real releases with honest naming and parses cleanly as
semver with prerelease.

**Known limitation, accepted:** a same-CLI-version daemon with a silently
changed spec passes the floor check. The live corpus tests (the frozen golden
SSE corpus, deliberately pinned and bumped explicitly via
`scripts/capture-daemon-corpus.ts`) remain the true spec-drift gate.

**No CI freshness gate:** the `rust-server` CI job lacks `bun` and `polytoken`,
and polytoken's installers fetch latest-unstable (not pinned), so a
regenerate-in-CI gate is fragile against version skew. Freshness is a
documented local discipline: after bumping polytoken, run
`bun run scripts/codegen-polytoken-rs.ts` and commit the regenerated `lib.rs`.

## Remote deployment: envelope-vs-raw wire format (Option A)

**Decision:** the `WireEnvelope`/frame codec is a **stdio-only** wire concern.
The WebSocket path (server + `ws.svelte.ts`) speaks raw `ClientMessage`/
`ServerMessage` JSON directly (`{"type":"hello",...}`), with no
`{"message":{...}}` wrapping. The stdio adapter wraps in `WireEnvelope` +
length-prefixed frame; the bridge wraps/unwraps at the WS↔stdio boundary.

**Rationale:** the existing WebSocket path is a working, tested local
protocol. Adopting the envelope on WS would be a breaking change to the
browser client for no functional benefit — the envelope exists to give
future per-transport metadata (correlation ids, tracing) a home, and that
metadata is only needed on the stdio transport (SSH relay), not on the
loopback WS path.

**Invariant:** neither the bridge nor the proxy ever emits a
`ClientMessage::Hello` — the browser is the sole originator. The proxy's
identity probe is a separate framed message type, not a Hello.

## Remote deployment: serve-mode selection via env-var (not clap)

**Decision:** `PANTOKEN_SERVE_MODE` env-var selects the server's mode
(`remote-runtime`, `stdio-proxy`, default unset = local server). No clap
dependency was added.

**Rationale:** the server is already pure env-var driven (`config.rs` is all
env). Adding clap for two modes would introduce a new dependency and a
different config style for no gain. The env-var approach matches the existing
config style and keeps the binary small.

## Remote deployment Phase 2: bridge WS-only (hub serves assets)

**Decision:** the bridge serves **only** WebSocket connections on its loopback
port; the existing local hub continues to serve the bundled client assets. The
browser connects to
`http://127.0.0.1:{hub_port}/?ws=ws://127.0.0.1:{bridge_port}` — the `?ws=`
param overrides the WS target.

**Rationale:** building an HTTP file server into the bridge would duplicate the
hub's asset-serving logic for no functional benefit. The hub is already running
(its supervisor keeps it alive), and the client only needs its WS target
pointed at the bridge. The `?ws=` override is a 3-line client change
(`resolveWsUrl()` in `client/src/lib/ws-url.ts`) vs. a full HTTP+WS server in
the bridge. The tradeoff: a fatal hub means remote connections can't work —
acceptable, since a fatal hub means the app is unusable anyway.

## Remote deployment Phase 2: BatchMode=yes for SSH

**Decision:** SSH is invoked with `-o BatchMode=yes`, disabling interactive
prompts (password, host-key acceptance, passphrase). Auth/host-key failures
exit fast with code 255 + a stderr message, which the bridge classifies as
actionable (not retried).

**Rationale:** interactive prompt handling would require a pty + a UI for
accepting host keys and entering passphrases — a substantial subsystem for a
Phase 2 that targets pre-provisioned hosts. `BatchMode=yes` is fail-fast: the
user pre-accepts host keys (via manual SSH) and unlocks their key in the agent,
and the bridge surfaces a specific, actionable error if auth fails. The known
UX gap: if the user expects in-app host-key acceptance, that's deferred to a
future phase.

## Remote deployment Phase 2: full state machine model with partial wiring

**Decision:** the connection state machine models **all** phases (including
provisioning ones: `Provisioning`, `ProvisioningFailed`), but only Phase-2-
reachable transitions are wired (`Disconnected → TestingSsh → Connecting →
Starting → Ready → Reconnecting → Ready`, plus failure states). Provisioning
transitions are defined but unreachable.

**Rationale:** modeling only Phase-2 states would require reworking the enum +
UI when Phase 3 (auto-provisioning) lands. The full model lets Phase 3 plug in
the provisioning actions and wire `Connecting → Provisioning → Starting` without
changing the state machine's shape or the overlay's rendering. The cost is two
enum variants that are dead code until Phase 3 — a small price for a stable
contract.

## Remote deployment Phase 3: XDG isolation — isolated by default

**Decision:** a Pantoken-managed polytoken on the remote host uses
**isolated** XDG roots under the remote root
(`~/.local/share/pantoken/tools/polytoken/xdg/{config,data,cache}`) by
default. Sharing the user's existing polytoken XDG roots requires explicit
user confirmation (`xdg_mode: Shared` on the profile).

**Rationale:** never silently share production state. A Pantoken-managed
polytoken could interfere with the user's existing polytoken sessions,
configuration, or cache. Isolated roots under the remote root keep
Pantoken's polytoken state fully self-contained and removable. The XDG
override paths are derived from the remote root via the shared
`pantoken-remote-layout` crate, ensuring both the desktop provisioning layer
and the remote runtime agree on the layout.

## Remote deployment Phase 3: channel derivation from version string

**Decision:** the download channel (stable vs. unstable) is derived from
`POLYTOKEN_DAEMON_TARGET_VERSION`: if the version has a prerelease tag
(contains `-`), use the unstable channel URL prefix
(`https://dl.polytoken.dev/unstable/<version>/`); otherwise use the stable
prefix (`https://dl.polytoken.dev/<version>/`).

**Rationale:** the target version is the exact version to install — not
"latest in channel." Deriving the channel from the version string avoids a
separate channel configuration and ensures the downloaded artifact matches
the codegen'd compatibility floor. The prerelease tag is a reliable signal:
stable releases never have one, unstable builds always do.

## Remote deployment Phase 3: shared layout crate (`pantoken-remote-layout`)

**Decision:** path-derivation functions and semver parsing/comparison live in
a new zero-dependency shared crate `pantoken-remote-layout`, depended on by
both `pantoken-server` (remote runtime) and `desktop` (provisioning).

**Rationale:** `pantoken-server` is binary-heavy (axum, tower, web-push,
jwt-simple…). The desktop crate cannot depend on it. Both sides must agree on
path layout (where polytoken binaries, XDG roots, install metadata live).
Extracting the pure functions into a tiny shared crate is the single source
of truth — no risk of two copies drifting.
**Update:** the crate now also hosts the release manifest contract types
(`PantokenReleaseManifest`, `ReleaseTarget`, `ArchiveFormat`, `ManifestError`,
`validate`). These were moved from `pantoken-server` so the desktop crate can
construct an embedded manifest without depending on the server's heavy
dependency tree. The crate is no longer zero-dep — it depends on `serde` and
`pantoken-protocol` (for `PROTOCOL_VERSION`).

## Remote deployment Phase 3: embedded server release manifest

**Decision:** the desktop binary embeds a `PantokenReleaseManifest` at compile
time, constructed from `CARGO_PKG_VERSION`, `PANTOKEN_BUILD_SHA`, and a
build-time-computed SHA256 of the headless release artifact. No remote manifest
fetching.

**Rationale:** an embedded manifest avoids requiring a live manifest URL and
keeps the provisioning change self-contained. The manifest points at the
existing GitHub release artifacts. A `build.rs` script in the desktop crate
computes the SHA256 of the local headless artifact
(`target/release/headless/pantoken-headless-macos-aarch64.tar.gz`); in local
dev and CI gate builds where the artifact doesn't exist, a placeholder digest
(64 zeros) is used — dev builds don't provision real hosts.

**macOS-arm64-only initial scope:** CI currently builds only
`pantoken-headless-macos-aarch64.tar.gz`. The server-install module targets
macOS arm64 only and rejects other targets with `UnsupportedTarget`. Cross-
target builds (Linux amd64/arm64, macOS x86_64) require a CI matrix expansion
— follow-up.

**CI ordering:** the `release-prepare` job builds the headless artifact before
the desktop bundle, so `build.rs` can find the artifact and embed its real
SHA256. Both steps share `CARGO_TARGET_DIR`.

## Remote deployment Phase 4: start-token identity checks for daemon cleanup

**Decision:** daemon cleanup uses a two-layer identity check to never signal
an unrelated process (AC.10):

1. **Spawned-daemon path (Layer A+C):** when a `Child` handle is available
   (the daemon was spawned by this process), guard `child.kill()` with
   `try_wait()` — if the child already exited, skip the kill entirely (the
   PID may have been recycled). After killing via the `Child` handle, use
   `close_without_kill()` (releases lease + HTTP terminate, but no SIGTERM
   fallback) to avoid signaling the dead PID again.

2. **Resume/wedged-daemon path (Layer B):** when no `Child` handle is
   available (the daemon was attached to, not spawned), `kill()` verifies
   process identity via start-time before signaling. The start time is
   captured at health-check time and re-read before `kill()` — if it changed
   (PID recycled) or the PID doesn't exist, the kill is skipped.

**Rationale:** `libc::kill(pid, SIGTERM)` uses a bare PID. If the daemon died
and the OS recycled that PID to an unrelated process, signaling it would kill
the wrong process. The `Child` handle is the OS-level start-token for spawned
daemons; process start-time verification is the start-token for attached
daemons. The two mechanisms are complementary: `try_wait()` is sufficient
when we own the process, start-time verification covers the attach path.

## Stage 4: Native multi-host manager

**Decision:** Replace the exclusive single-remote-session model
(`AppState.remote: Mutex<Option<Arc<RemoteSession>>>`) with a collection
keyed by remote profile id (`Mutex<HashMap<String, Arc<RemoteSession>>>`),
so multiple remote computers can hold live bridge sessions simultaneously.
Split "ensure this remote bridge exists" from "navigate/select this host in
the WebView" — the native command returns a loopback WebSocket URL once the
bridge is ready and does NOT navigate the whole WebView.

### Keyed collection

Multiple remote computers hold live bridge sessions simultaneously. Starting
profile B does NOT stop profile A. Disconnecting B stops only B. Teardown
stops all. The local computer is NOT in this map — it's the `Supervisor`.

### Ensure-vs-navigate split

The old `connect_to_remote_impl` started the bridge, navigated the WebView to
`?ws=ws://127.0.0.1:{bridge_port}`, raised a native overlay, and spawned an
overlay poller that showed native dialogs on failure. The new
`ensure_remote_host_impl` starts the bridge + provisioning and returns a
`HostStateSnapshot` with the loopback WS URL. It does NOT navigate the
WebView, raise the overlay, or show dialogs. This is a compile-time
guarantee: the new impl functions take no `&AppHandle` parameter, so they
physically cannot call `shell::navigate_main`.

The client (`TauriHostProvider.connectHost`) polls `host_state(id)` until the
bridge is ready (state `ready`) or fails (state `failed`). The coordinator
creates a `WsClient` pointed at the returned `wsUrl` (loopback only).

### Background connection lifetime

Each `ensure_remote_host_impl` call spawns its own bridge task on the
dedicated `remote_handle` runtime. The task holds its own `RemoteConnection`
`Arc`. Multiple tasks run concurrently on the multi-thread runtime with no
shared mutable state between sessions.

### Local-label rule

The native `list_hosts`/`host_state` returns `label: ""` and `subtitle: ""`
for the local host (the Rust side doesn't speak the WS protocol). The
client's `TauriHostProvider` fills in the label from `store.serverLabel`
(which it has after `hello`) and sets `subtitle: "This computer"`. This
avoids the Rust side needing to speak the protocol.

### Tray removal

The tray's "Connect to Remote…" / "Disconnect Remote" items are removed —
they drove the exclusive navigate-the-WebView flow, which is incompatible
with the multi-host model. The in-app host picker (stage 5) + Settings
"Computers" section (stage 6) replace the tray as the primary management
surface.

## Docker Target Extension: running-only lifecycle

**Decision:** Pantoken accepts only currently running containers. It never
creates, starts, stops, restarts, rebuilds, pulls, or deletes a container.

**Rationale:** container lifecycle is owned by the user or orchestrator
(Compose, devcontainer, k8s). Pantoken is a guest inside an existing
container; managing its lifecycle would blur responsibility and risk
disrupting the user's environment. A stopped container is surfaced as an
actionable error ("container is not running") rather than silently started.

## Docker Target Extension: container-as-Computer identity

**Decision:** a Docker target profile appears as its own top-level Pantoken
Computer, not a project or sub-entry under the SSH host. Primary identity is
the editable profile/container label; secondary context identifies the exact
container name and redacted SSH host (e.g. `work-api via dev-server`).

**Rationale:** the user's mental model is "I have a computer running inside a
container on dev-server." Treating it as a top-level Computer matches that
model and reuses the existing multi-host manager for background
connection/activity behavior. Server hello identity must not overwrite the saved
label.

## Docker Target Extension: root execution acknowledgement

**Decision:** effective root (UID 0) inside a container is allowed only after an
explicit acknowledgement whose fingerprint covers the resolved container ID,
requested user, effective UID, and effective GID. There is no silent fallback
to root and no blanket `allowRoot` boolean.

**Rationale:** container root is a real privilege boundary. Docker access by the
SSH account is itself a high-privilege host boundary. The user must knowingly
accept root execution for the specific container+identity combination. If the
container is replaced or the effective identity changes, the fingerprint no
longer matches and re-acknowledgement is required.

## Docker Target Extension: persistence warning and acknowledgement

**Decision:** ephemeral storage (tmpfs, writable layer with no covering mount)
is allowed only after an explicit acknowledgement whose fingerprint covers the
resolved container ID, normalized Pantoken root, persistence classification,
deepest covering mount destination, mount type, read/write mode, and a
privacy-preserving hash of the backing identity.

**Rationale:** container recreation, rebuild, or `docker rm` can silently lose
Pantoken runtime state, session journals, and polytoken XDG data. The user must
understand that `docker stop`/`start` normally retains the writable layer, but
removal/recreation does not. Bind mounts and named volumes are persistent; the
warning accurately distinguishes the cases. A same-container stop/start with
unchanged fingerprints does not re-prompt.

## Docker Target Extension: host-mode migration default

**Decision:** existing profile JSON without execution-target fields deserializes
as `Host` mode (the serde default). Saving an old profile does not silently
convert it to Docker or lose advanced fields.

**Rationale:** backward compatibility is load-bearing. Users with existing SSH
profiles must see no behavior change. The `ExecutionTargetProfile` enum uses
`#[default] Host` so missing fields are safe.

## Docker Target Extension: no host-hub split

**Decision:** the Pantoken remote runtime and polytoken daemon both run inside
the selected container. There is no host-side Pantoken hub or container-only
daemon split.

**Rationale:** keeping everything inside the container simplifies the trust
model and avoids a host-side process that could outlive or conflict with the
container. The SSH host is merely the transport and Docker discovery layer.
