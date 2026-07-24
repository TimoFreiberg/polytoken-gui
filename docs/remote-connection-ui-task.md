# Implementation task: host-scoped local and remote connections

Implement the host-scoped connection UX described below. Treat this document as the
complete task brief; do not rely on prior chat context. Read `AGENTS.md`, `QUALITY.md`,
`docs/ui-conventions.md`, `docs/DESIGN.md`, `docs/DECISIONS.md`, and
`docs/remote-deployment-plan.md` before editing.

## Outcome

Pantoken should present the machine running the agent as the top-level scope above
projects and sessions:

```text
Computer
└── Project
    └── Session
```

The user can switch computers from the top of the session sidebar. Switching computers
replaces the entire project/session list and makes all subsequent actions—including
“New session,” directory picking, paths, logs, and settings which describe the running
agent—apply to that computer.

Connections already opened during this app lifetime must remain open when their computer
is not selected. An inactive computer must therefore be able to report background work,
completion, failures, and requests for attention in the computer picker. Do not merge
projects or sessions from different computers into one list.

The feature must work with the existing local bundled server and the existing remote SSH
bridge/provisioning implementation. Do not change the logical `ClientMessage` /
`ServerMessage` protocol or tunnel WebSocket over SSH.

## Settled product decisions

These are requirements, not questions to revisit during implementation.

1. A computer is the app-wide scope. The sidebar displays projects and sessions for only
   the selected computer.
2. `New session` always targets the selected computer.
3. The selected computer is visible both in the sidebar selector and in the session
   header. A filesystem path is not sufficient host identity.
4. Once a computer has been connected during the current app lifetime, switching away
   does not disconnect it. Its connection continues receiving compact cross-session
   status and attention updates.
5. Do not connect every saved SSH profile automatically on cold launch. Start the bundled
   local connection normally. Connect a remote profile lazily when the user selects it;
   after the first successful connection, keep it connected until the user explicitly
   disconnects it or quits the app.
6. A cold background-status baseline is read. Do not mark every historical `done` item as
   new merely because a monitor connected.
7. Computer indicators mean:
   - no indicator: connected and quiet;
   - bronze motion indicator: at least one session is running or initializing;
   - gold dot: unseen completion or new non-blocking activity on an inactive computer;
   - warning/attention indicator: a session is waiting for input, failed, or the computer
     connection requires action;
   - muted/offline treatment: disconnected or unreachable.
   Color must follow `docs/ui-conventions.md`: warm nickel for structure, bronze for active
   motion, gold for ready-for-you/unseen activity, and semantic warning/danger colors for
   failures.
8. Selecting a computer clears its ordinary unseen-completion dot. A waiting approval,
   failed session, or connection failure remains indicated until the underlying condition
   is resolved.
9. Routine compatibility checks remain quiet. Only setup, trust/authentication,
   installation consent, and actionable repair should interrupt the user.
10. Advanced profile fields are collapsed by default.
11. Do not persist passwords, private keys, passphrases, tokens, or raw sensitive SSH
    diagnostics. Continue to rely on the system SSH configuration/agent/keychain.
12. The initial implementation is desktop-native. The Svelte layout must be responsive
    and have tested phone behavior, but implementing a mobile native SSH transport is out
    of scope.
13. Keep `BatchMode=yes` in this task. Authentication and host-key failures interrupt with
    actionable guidance, but Pantoken does not collect a password/passphrase or modify
    `known_hosts`. Interactive SSH askpass/host-trust UI is a separate security-sensitive
    follow-up. This resolves the current mismatch between the broader deployment plan and
    the implemented non-interactive `SystemSshTransport` without inventing a secret field.
14. Editing only a profile label updates the UI immediately. Editing connection-affecting
    fields while that computer is connected must not silently kill active work: save the
    new profile, mark it as requiring reconnection, and offer `Reconnect now` / `Later`.
    Continue using the old live connection until the user chooses to reconnect.

## Local-computer naming

Do not use `localhost` as the visible name. It is transport terminology and becomes
ambiguous when the client runs on another device.

For the bundled desktop server, display:

- primary label: the detected machine/server label already delivered by `hello.serverLabel`
  (for example, `Timo’s MacBook`);
- secondary label: `This computer`;
- stable UI id: `local` (do not use a hostname as identity).

Only call a machine “This computer” when the native shell confirms that it is the bundled
local runtime. A browser/PWA connected to a server over the network must not claim that
the server is the browser device. Outside the desktop shell, preserve the current
single-server behavior and hide the computer selector unless an equivalent native host
provider exists.

Remote profiles use their editable `RemoteProfile.label` as the primary label and a
redacted SSH destination as secondary text.

## Required architecture

The present implementation is exclusive: `AppState.remote` contains one
`RemoteSession`, and `connect_to_remote_impl` tears it down before starting another. The
client transport is also a module-level WebSocket singleton. Do not build the new UI on
top of page navigation that destroys the previous connection; that would violate the
background-connection requirement.

Use this architecture:

### Native host manager

- Replace the single remote-session slot with a collection keyed by remote profile id.
- Each connected remote profile owns one long-lived `RemoteSession`, loopback bridge port,
  cancellation token, task handle, and `RemoteConnection` state machine.
- Starting or switching to profile B must not stop profile A.
- Explicitly disconnecting B stops only B.
- App teardown stops every remote session before dropping the shared runtime.
- The bundled local server remains owned by `Supervisor`; represent it in the UI host list
  but do not wrap it in a `RemoteSession`.
- Split “ensure this remote bridge exists” from “select this host in the WebView.” The
  native command should return the loopback WebSocket URL once the bridge is available;
  it must not navigate the whole WebView to a new URL.
- Keep the loopback-only security invariant in `client/src/lib/ws-url.ts`. Never return or
  accept a non-loopback remote bridge URL.

Expose a small serializable native API. Exact Rust names may vary, but the client must be
able to perform these operations without native dialogs:

```ts
type NativeHostDescriptor = {
  id: string;                    // "local" or RemoteProfile.id
  kind: "local" | "remote";
  label: string;
  subtitle: string;
  state:
    | "disconnected"
    | "testingSsh"
    | "connecting"
    | "provisioning"
    | "starting"
    | "ready"
    | "reconnecting"
    | "failed";
  wsUrl?: string;               // loopback only; present when usable
  failureLabel?: string;
  failureAction?: string;
  failureDetail?: string;       // redacted
};
```

Required operations:

- list local + saved remote computer descriptors;
- ensure/connect one remote computer and obtain/poll its state and bridge URL;
- disconnect one remote computer;
- existing remote-profile CRUD.

Update the Tauri permission manifest and capability documentation to grant only the new
commands required by this UI. Keep the existing narrow remote-origin IPC boundary.

Native modal dialogs and the injected blocking overlay must no longer be the primary flow
for a WebView-initiated connection. The Svelte UI owns progress, retry, cancel, and failure
presentation. A tray fallback may remain, but it must call the same host-manager logic and
must not reintroduce exclusive teardown.

### One WebSocket connection per connected computer

Refactor `client/src/lib/ws.svelte.ts` so its reconnecting transport can be instantiated.
Each connected computer gets one `WsClient` instance with its own:

- URL/provider;
- connection state and reconnect attempt;
- socket, timers, heartbeat, and wake handling;
- listeners;
- resume provider.

Preserve compatibility exports for the rest of the application where practical:
`connectionState()`, `connect()`, `forceReconnect()`, `send()`, `disconnect()`,
`setResumeProvider()`, and `onMessage()` should delegate to the selected computer’s client
so existing feature components do not each learn about host routing.

Do not open a second “monitor” WebSocket to the selected computer. The same per-computer
connection serves both roles:

- every incoming message updates that computer’s compact host summary;
- only messages from the selected computer are forwarded into the existing
  `PantokenStore`;
- messages for inactive computers are not folded into the visible transcript;
- retain the latest `hello`, `sessionList`, `sessionStatus`, and other bootstrap/catalog
  messages needed to activate the computer later;
- when an inactive computer becomes selected, reset visible server-scoped state, replay
  its cached bootstrap metadata, request/open its last session, and request a fresh seed
  rather than replaying an unbounded inactive transcript buffer.

This preserves exactly one logical Pantoken client connection per connected computer,
keeps inactive computers alive, and avoids maintaining a full rendered store for every
computer.

Add a coordinator module such as `client/src/lib/hosts.svelte.ts` and keep the transport
mechanics out of Svelte components. The coordinator should own:

- all host descriptors;
- the selected host id;
- per-host connection state;
- cached bootstrap messages;
- aggregate running/attention state;
- unseen activity state;
- connect, select, retry, disconnect, add, edit, and delete operations;
- the active-message routing boundary into `PantokenStore`.

Define a provider interface so browser/e2e builds can use a single-host provider and tests
can inject multiple fake hosts without invoking Tauri. Do not scatter direct
`window.__TAURI_INTERNALS__.invoke` calls through components.

### Safe visible-store switching

Add one explicit `PantokenStore` host-switch/reset operation. Before changing hosts it
must stash the current composer draft and other pending per-client view state. During the
switch it must clear all server-scoped visible state so the previous host’s transcript,
paths, models, jobs, pending approvals, errors, and session list never appear under the
new host label.

The new host may then hydrate from cached bootstrap messages and a fresh seed. Show a
neutral connecting/switching state until its authoritative data arrives. Do not briefly
render host A’s transcript beneath host B’s identity.

Audit local persistence for host collisions. At minimum, namespace by `serverId`:

- composer drafts, including new-session drafts keyed by cwd;
- draft configuration;
- prompt history;
- last project cwd;
- transcript scroll positions;
- any session-id-keyed unread/view preference that is not guaranteed globally unique.

The existing last-session preference is already keyed by `serverId`; preserve that
behavior. Add a one-time, loss-averse migration for existing unnamespaced local data: once
the initial local server id is known, treat old entries as belonging to that server. Never
silently discard a user’s unsent draft during migration or host switching.

Pending outbox prompts are already server-aware. Verify that a host switch cannot send a
queued prompt to a different server and that retries remain routed by their recorded
`serverId`.

## Host summary and unread rules

Use `ServerMessage.sessionStatus` and its `attention` payload; do not inspect or fold
background transcript events merely to paint computer indicators.

For each computer track a compact summary:

```ts
type HostActivity = {
  running: boolean;
  unseen: boolean;
  waiting: boolean;
  failed: boolean;
};
```

Rules:

1. The first `sessionStatus` received for a newly connected computer establishes a
   baseline and cannot set `unseen` by itself.
2. While inactive, a transition into `done`, a new/updated attention item, or a
   running-to-idle transition associated with completed work sets `unseen`.
3. `waiting` and `failed` derive from current authoritative attention entries and do not
   clear merely because the computer becomes active.
4. Selecting the computer clears `unseen` after its bootstrap/seed is adopted.
5. `running` derives from non-empty `runningIds` or `initializingIds`.
6. Connection failure takes visual precedence over running/unseen; waiting/failed session
   attention takes precedence over ordinary unseen completion.
7. Do not persist `unseen` across app restarts in this first implementation. The initial
   baseline after launch is read.

Keep these rules in pure TypeScript helpers with unit tests. Components should receive an
already-derived visual state rather than reimplementing precedence.

## Sidebar computer selector

Add a `HostSwitcher.svelte` between the sidebar’s existing top toolbar and `New session`.
Use existing shared primitives and the rules in `docs/ui-conventions.md`.

Collapsed control:

- machine/server icon;
- primary computer label;
- secondary destination or `This computer`;
- menu chevron;
- compact activity/attention indicator, if any.

Expanded picker:

- local computer first;
- saved remote profiles in stable persisted order;
- selected computer marked structurally, not with gold;
- each row shows connection/activity state accessibly as text or an accessible label;
- `Add computer` and `Manage computers` actions at the bottom;
- clicking a ready computer switches immediately;
- clicking an unconnected computer starts the connection flow;
- clicking the selected computer closes the picker;
- Escape closes and returns focus to the trigger;
- clicking outside closes;
- do not add hover-only essential controls.

Desktop uses an anchored popover. On phone, use a full-width sheet or full-screen overlay
with at least 44px targets and integrate it with `client/src/lib/overlay-history.ts` so the
OS/browser back gesture closes it before navigating away.

When the sidebar is collapsed, include the active computer name in the header. When the
sidebar is open, still include a compact computer identity in the header subtitle, e.g.
`pantoken · Studio Mini`. The user must be able to identify the target machine without
opening a menu.

The existing `serverLabel` remains authoritative after hello. Reconcile it with the saved
profile label as follows:

- selector primary label: user’s profile label (remote) or detected `serverLabel` (local);
- header identity: same selector primary label;
- diagnostics/details may show the remote-reported `serverLabel` separately if it differs;
- never silently rewrite the user’s saved profile label from a remote hello.

## Settings: Computers section

Add `Computers` to the Settings section list. It is the durable management surface; the
host picker is for frequent switching.

The section shows:

- bundled local computer, read-only, with detected name and `This computer`;
- each saved remote profile with label, SSH destination, current state, and actions to
  connect/retry, edit, disconnect, or remove as appropriate;
- `Add computer` primary action.

Add/edit flow fields:

- Name;
- SSH destination (`user@host` or SSH config alias);
- optional port;
- polytoken policy: require an existing installation or offer a Pantoken-managed install;
- Advanced disclosure containing remote-root override, server-path override, and XDG mode.

Copy must explicitly say that Pantoken uses the existing SSH configuration, agent, and
system keychain and does not store passwords or private keys.

Deleting a connected profile requires an explicit confirmation, disconnects only that
host after confirmation, and then removes the profile. Deleting the selected host switches
to local before teardown. A failed add/edit must preserve entered form values.

Use inline validation for profile fields. Do not expose raw command lines or unredacted
stderr in the normal UI.

## Connection and provisioning presentation

Render first-time connect/provisioning in a focused Svelte sheet. Group the implementation
states into four user-facing steps:

1. SSH connection;
2. Remote system (target/architecture and writable root);
3. Polytoken compatibility;
4. Pantoken runtime.

Map detailed native phases such as testing, inspecting, downloading, uploading,
verifying, installing, starting, and reconnecting into these four steps. Completed steps
show concise results; the current step shows bronze progress; future steps stay neutral.
Provide Cancel while cancellation is safe.

Actionable states must distinguish at least:

- SSH authentication failure;
- unknown/changed host key;
- unreachable host;
- unsupported OS/architecture;
- no writable user directory;
- missing, unparseable, or too-old polytoken;
- install consent required;
- checksum mismatch;
- Pantoken artifact mismatch;
- runtime startup failure;
- protocol mismatch.

Each failure needs one plain-language explanation and a concrete next action. Prefer Retry,
Edit connection, Install/Upgrade, or Cancel over an undifferentiated OK dialog. Put
redacted technical details behind a disclosure/copy action.

After a computer has connected successfully once, ordinary reconnecting is non-modal:
show its status in the host selector and use the existing slim connection banner when it
is the selected computer. Escalate to a focused sheet only when user action is required.

## Browser and non-native behavior

The ordinary browser/PWA path must remain functional and unchanged in spirit:

- no Tauri API present: expose one current-server descriptor internally;
- do not show Add/Manage remote-computer controls;
- do not claim the server is `This computer`;
- keep the current WebSocket URL resolution, reconnect, heartbeat, resume, and auth
  behavior;
- all existing local mock-driver and PWA tests must continue to pass.

Add a deterministic dev/e2e host provider reachable only under `?dev`. It may expose
multiple logical host descriptors backed by the existing mock server, plus hooks to drive
ready, running, unseen, waiting, reconnecting, and failed states. It must never be enabled
in production.

## Implementation sequence

Work in these reviewable stages. Keep tests green after each stage.

1. **Pure models and tests**
   - host descriptors, aggregate activity precedence, unread transitions, provider
     interface, and persistence namespacing helpers;
   - no UI yet.
2. **Instantiable WebSocket transport**
   - extract `WsClient` without changing single-host behavior;
   - retain compatibility exports and existing reconnect/heartbeat tests.
3. **Client host coordinator**
   - one `WsClient` per connected host, active-message routing, cached bootstrap,
     reset/reseed switching, fake provider;
   - prove inactive traffic cannot mutate the visible store.
4. **Native multi-host manager**
   - replace exclusive remote state with a keyed collection;
   - add narrow commands, per-host teardown, and tests with `FakeSshTransport`;
   - no WebView navigation on host switch.
5. **Sidebar and header identity**
   - host selector, indicators, keyboard/touch behavior, host-scoped New session.
6. **Settings and connection sheet** ✅
   - CRUD, advanced options, progress, retry/cancel/failures, redaction.
   - Implemented: profile editor form, Settings Computers section, ConnectionSheet
     with 4-step progress, failure UI, Docker risk acknowledgement, reconnect-required
     detection, dev-provider phase simulation, unit + e2e tests.
7. **Regression and documentation**
   - e2e scenarios, responsive visual verification, docs/decision updates, full gates.

Do not combine stages 2–4 into an unreviewable rewrite. Preserve the working local path at
every stage.

## Required tests

Add focused tests with descriptive names. At minimum cover:

### TypeScript/unit

- initial background status establishes a read baseline;
- inactive running → done sets computer unseen;
- selecting a computer clears ordinary unseen;
- waiting/failed attention survives selection;
- precedence is connection failure > session attention > unseen > running > quiet;
- messages from an inactive `WsClient` do not mutate the visible `PantokenStore`;
- switching requests authoritative seed/bootstrap before showing the new transcript;
- host A data cannot render beneath host B identity during a slow switch;
- queued prompts remain bound to their original `serverId`;
- composer drafts, draft config, prompt history, last project, and scroll positions do not
  collide for identical session ids/cwds on two servers;
- legacy unnamespaced drafts migrate to the initial local server without data loss;
- WebSocket instances have independent heartbeat/reconnect timers and closing one host
  does not alter another host’s state;
- non-native provider retains the current one-server behavior.

### Rust/desktop

- two remote profiles can own live bridge sessions simultaneously;
- connecting B does not cancel A;
- disconnecting B leaves A alive;
- deleting a connected profile tears down only its own task after confirmation logic calls
  the core operation;
- teardown cancels and awaits all remote sessions;
- returned bridge URLs are loopback-only;
- state/failure snapshots are keyed by profile id and contain redacted diagnostics;
- profile validation and the structural no-secret test remain green;
- fake transport can drive different phases independently for two hosts.

### Playwright/client scenarios

- selector switches the visible project/session scope and header identity;
- `New session` uses the selected computer’s default cwd;
- inactive computer running/completion/waiting indicators render and clear correctly;
- a connecting computer shows grouped progress; ready closes it;
- actionable failure offers the correct retry/edit/cancel path;
- Settings add/edit/delete preserves advanced disclosure defaults and form values on error;
- desktop selector keyboard behavior;
- phone selector has 44px targets and Back closes the sheet;
- collapsed sidebar still leaves current computer identity visible;
- single-host browser mode does not expose unavailable native management controls;
- existing connection banner, reconnect, per-client focus, drafts, and notification tests
  remain green.

## Acceptance criteria

The task is complete only when all are true:

1. The selected computer is unambiguous in the sidebar and header.
2. Projects/sessions from different computers are never displayed in one list.
3. Switching computers never terminates an already-open host connection.
4. An inactive connected computer can surface working, unseen completion, waiting, failed,
   reconnecting, and offline states.
5. Selecting a computer adopts authoritative state without flashing the previous host’s
   transcript or sending work to the wrong host.
6. Local and remote drafts/view state cannot collide, and existing local drafts survive
   migration.
7. Remote profile management and connection/provisioning are available inside the app;
   normal operation does not depend on the tray picker or native OK dialogs.
8. Credentials and sensitive SSH output are neither persisted nor rendered/logged
   unredacted.
9. Browser/PWA single-server behavior remains supported.
10. Desktop and phone layouts follow `docs/ui-conventions.md`, including shared controls,
    focus behavior, touch targets, and overlay history.
11. The logical Pantoken protocol remains unchanged.
12. Relevant docs describe the host manager, background connection lifetime, activity
    semantics, and local-label rule.

## Non-goals

- Merging sessions from multiple computers into one sidebar list.
- Searching across computers.
- Automatically connecting every saved SSH host at launch.
- Persisting unseen computer dots across app restarts.
- Syncing remote profiles between desktop and mobile devices.
- Implementing the mobile native SSH transport.
- Collecting SSH passwords/key passphrases or accepting host keys inside Pantoken; this
  task keeps `BatchMode=yes` and surfaces remediation instead.
- Reordering/favoriting computers.
- Changing the Pantoken logical message protocol.
- Replacing the existing remote provisioning or persistent-runtime design.

## Verification

Run formatters and the smallest relevant tests while iterating, then run:

```bash
bun test
bun run check
bun run test:e2e
bun run check:rs
cargo check --manifest-path desktop/Cargo.toml
cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings
```

Use the mock preview and the deterministic multi-host dev provider to inspect desktop,
phone, light, dark, ready, reconnecting, waiting, and failure states. Check browser console
errors. Review the final diff with `jj diff --git`, run the repository `quality-review`
skill, fix all critical/high findings, and commit with an imperative subject no longer
than 72 characters.

If the instantiable WebSocket/client coordinator design proves incompatible with a
load-bearing existing invariant, stop and document the exact conflict before inventing a
protocol change or falling back to page-reload host switching.
