# Implementation task: Docker container remote connection UI

Implement the Docker-container remote-connection UX described below. Treat this
document as the complete task brief; do not rely on prior chat context. Read
`AGENTS.md`, `QUALITY.md`, `docs/ui-conventions.md`, `docs/DESIGN.md`,
`docs/DECISIONS.md`, `docs/remote-connection-ui-task.md` (the base host-scoped
connection brief this feature layers on), `docs/docker-target-guide.md`, and
`docs/mockups/container-setup/` (the HTML mockups accompanying this brief)
before editing.

This brief records **UI decisions only**. The container backend (Rust container
commands, `RemoteProfile` model, `RemoteExecutor` trait, `docker_target.rs`
inspection/persistence) landed in commit `skwtwosy` and is in the working tree.
The backend architecture decisions were already added to `docs/DESIGN.md` and
`docs/DECISIONS.md` by that commit; this document does not modify either.

## Outcome

A Docker container is presented as a **top-level computer profile** — a peer of
the local computer and SSH-host computers, not a nested child of an SSH server.
The user configures an SSH destination and selects a running container on that
host; Pantoken provisions the remote runtime inside the container and presents
it as its own computer in the host switcher.

The setup flow is a progressive two-stage dialog (not a wizard): the user
enters SSH details and an execution environment, tests the SSH connection to
discover running containers, picks one (or enters an exact name), optionally
customizes the container user and Pantoken root, and clicks a single **Use this
container** action that inspects, verifies, saves the profile, and starts
provisioning. The common case is two clicks after the SSH test.

This feature **builds on** `docs/remote-connection-ui-task.md`. The base brief
defines the host-scoped connection UX (computer switcher, Settings → Computers,
connection/provisioning sheet, multi-host coordinator, per-computer WebSocket).
This brief layers Docker-specific behavior on those surfaces. Where a surface is
shared (switcher rows, Settings list, connection sheet), this document specifies
only the Docker-specific additions; the base doc's rules still apply.

## Settled product decisions

These are requirements, not questions to revisit during implementation.

### Profile model

1. A Docker container is a **top-level computer profile**, a peer of the local
   computer and SSH-host computers. There is no "SSH server → containers"
   nesting; the SSH destination is configuration inside each profile. Users
   repeat the SSH destination across container profiles that share a host.
2. Picker/switcher identity: primary label = the user's profile label;
   secondary = `container-name via ssh-host` (e.g. `work-api-dev via
   dev-server`). Container targets get a distinct container glyph (▣) vs the
   server/machine icon (⌂) used for host and local targets.

### Setup dialog

3. One **dedicated setup dialog** above Settings on desktop; full-screen,
   back-integrated flow on phone (use `client/src/lib/overlay-history.ts`
   conventions, 44px targets). Opened from Settings → Computers (Add/Edit) and
   from the host switcher's Add computer — one component, one state machine.
   Closing returns to whatever launched it; dirty fields require a **Discard
   changes?** confirmation.
4. Progressive two-stage flow, not a wizard:
   - Stage 1: **Name** (optional, deferred — must not block testing), **SSH
     destination**, optional port, **Execution environment** segmented control:
     Host | Docker container.
   - Explicit **Test SSH & find containers** button. Requires only SSH
     destination + environment — Name must not block testing. SSH errors attach
     to that action, never appear while typing.
   - On success the same sheet expands: running-container picker, exact-name
     fallback, Customize target disclosure. Entered SSH values stay visible and
     editable.
5. **Container picker**: running containers only, sorted by name; search field
   only when more than six are returned. Row shows: name, image, running status,
   configured user (or `Image default`), optional Compose project/service
   metadata. **Enter exact container name instead** below the list switches to a
   text field. The saved selector is always the exact container name; discovery
   is only a convenience.
6. Exact-name fallback may save a profile for a container that is **not
   currently running**: it becomes a disconnected computer in `Container not
   running` state with a Retry affordance; it cannot provision until the
   container exists and runs.
7. Selected row exposes a compact **Customize target** disclosure containing
   **Container user** and **Pantoken root**, pre-filled from inspection. Most
   users never open it.
8. **Container user**: always persisted explicitly (username or numeric UID).
   Pre-fill from the container's configured user; if the image has none, resolve
   and display `root (UID 0)`. Show resolved identity after verification, e.g.
   `dev · UID 1000`. Never silently substitute a "safer" user.
9. **Pantoken root**: a visible field in the Docker section (not hidden under
   Advanced). Default = selected user's resolved home + `/.local/share/pantoken`;
   display the resolved absolute path, never persist `~`. Recompute the
   suggestion when the container user changes unless the user edited the path.
   After verification show backing: `Persistent · volume <name>` /
   `Persistent · bind mount <path>` / `Ephemeral · container writable layer`.
   Server binary path and XDG overrides stay under the existing Advanced
   disclosure.
10. **Use this container** is a single action: inspect + verify (user exists,
    UID/home resolution, workspace/root writability, mount backing,
    root/socket/ephemeral risk detection) + save profile + start provisioning.
    It pauses only when a decision is required. No separate Inspect/Verify
    buttons, no final review screen — the common case is two clicks after the
    SSH test.
11. **Naming**: after selection, suggest a humanized container name
    (`work-api-dev` → `Work API Dev`); for host targets suggest the SSH
    alias/hostname after a successful test. Never overwrite a user-edited name;
    if untouched, the suggestion becomes the saved label.

### Risk acknowledgement

12. Verification detects all risks together and presents one **Review risks**
    panel containing only the applicable items, with a single **Accept risks &
    continue** button — no per-risk checkboxes, one click total:
    - **Agent runs as root**: "Agent commands will run as root. Files in
      bind-mounted workspaces may become root-owned. Mounted host paths or a
      Docker socket can expose broader host access; container root is not
      necessarily isolated from the host."
    - **Ephemeral Pantoken root**: "Pantoken data will be lost when this
      container is replaced. Sessions, runtime files, and Pantoken-managed agent
      data stored here exist only in this container's writable layer."
      (Alternative primary action when this is the only risk context: **Choose
      another path**.)
    - **Docker socket exposed**: "This container can control Docker on the
      host. The mounted Docker socket may let agent commands create privileged
      containers, mount host paths, or otherwise gain host-level access."
13. Persist each accepted risk **separately**, keyed to the profile's resolved
    environment; re-prompt only for newly introduced or invalidated risks.
    Invalidation: root ack → any new immutable container ID; ephemeral waiver →
    root path or mount backing change; socket ack → container replacement /
    socket mount change.
14. The SSH user's host-side Docker permission is stated in setup details as
    information; it gets no checkbox.

### Provisioning

15. Four user-facing phases for Docker targets (same count as host targets):
    **SSH & Docker · Container · Polytoken · Pantoken runtime**. Docker
    availability is host-side preflight inside phase 1; the Container phase
    covers locate-by-name, immutable identity, OS/arch, user, writability,
    persistence. Completed-step detail example: `work-api-dev · dev (UID 1000)
    · linux/arm64 · persistent volume`.
16. After **Use this container** the profile is saved and provisioning continues
    in the background: the close control becomes **Run in background** (not
    Cancel); the computer appears immediately in switcher/Settings as
    `Provisioning…`; if the dialog is still open at success it auto-closes and
    selects the new computer; if backgrounded, success must not switch
    computers — show a ready/unseen indicator instead. Control coexistence:
    before provisioning starts, the dialog has Close (with dirty-check) and a
    true **Cancel setup** action; once provisioning starts, Close is relabeled
    **Run in background** and Cancel setup appears only while the current phase
    is safely cancellable — cancelling then leaves the saved profile
    disconnected. Safely cancellable phases: **SSH & Docker** and **Container**
    (preflight/inspection only — no remote state has been written). Once
    **Polytoken** begins (download/upload/install), cancellation is unsafe: the
    Cancel setup action is hidden, leaving only Run in background.

### Replacement & recovery

17. A new immutable container ID under the saved exact name needs **no
    confirmation**: reprobe all checks; if compatible and no acknowledgement is
    newly required, reprovision/reconnect automatically; show a transient
    `Container replaced · Reconnecting` status; the resolved ID lives in
    details/diagnostics, never in normal chrome. If an acknowledgement or
    repair is needed, open the focused sheet at the Container phase. Rationale:
    dev containers are rebuilt routinely.
18. Missing/stopped container: **Retry** + **Choose another container** actions
    with guidance to start/recreate it outside Pantoken. No lifecycle controls.
19. **Execution environment is immutable after creation.** Edit shows a
    read-only line `Execution environment: Docker container`; switching types
    means adding a new profile. Container selection/user/root edits follow the
    base doc's existing Reconnect now / Later rule (save new profile, keep old
    live connection until the user chooses).

### Native contract

20. The doc documents the **actual implemented** serializable surface from
    `skwtwosy`, and identifies gaps where the UI's requirements exceed what the
    backend currently provides. The implemented contract is documented in the
    [Required architecture](#required-architecture) section below. The doc must
    NOT redesign the profile model, risk fingerprinting, or connection state
    machine — these are implemented and settled. The doc documents them as-is
    and layers UI requirements on top.
21. Dev-provider (`?dev` only) and test-fake hooks must be able to drive every
    state deterministically: picker populations, each risk combination, each
    failure state, replacement, backgrounded provisioning completion. The
    `FakeHostProvider` in `provider.ts` already has `setPendingRisks` +
    `setPreflightPhase`; the `?dev` dev-provider (`dev-provider.ts`) does not
    model Docker states (its `acknowledgeRisk` is a no-op). The doc must specify
    the dev-provider hooks needed and flag this as an implementation gap.
22. The doc must state the Rust implementation of these commands is a non-goal
    owned by the backend architecture track, the contract is the UI-side
    expectation to reconcile with that track, and the UI must degrade gracefully
    when a command is unavailable. **Degradation spec (concrete):** when
    container commands are unavailable on the current platform (browser/PWA, or
    a desktop build without them), the **Docker container** option in the
    Execution environment segmented control is disabled with an explanatory
    hint (e.g. `Docker targets require the Pantoken desktop app`); the Host
    option is unaffected. An already-saved docker profile whose commands are
    unavailable renders as a failed computer (`Container support unavailable on
    this device`) with no destructive action. The UI never partially renders
    container UI it cannot back.

## Required architecture

This section documents the implemented contract and the additional shapes the
UI needs. The Rust implementation of new commands is a **non-goal** owned by the
backend architecture track; the contract here is the UI-side expectation to
reconcile with that track.

### Implemented profile model

**TypeScript** (`client/src/lib/hosts/types.ts`):

```ts
export interface HostExecutionTarget {
  kind: "host";
}

export interface DockerExecutionTarget {
  kind: "dockerContainer";
  containerName: string;
  user: string;
  workdir?: string;
  pantokenRoot: string;
}

export type ExecutionTargetProfile = HostExecutionTarget | DockerExecutionTarget;

export interface RiskAcknowledgements {
  rootFingerprint?: string;      // lowercase SHA-256 hex (64 chars)
  ephemeralFingerprint?: string; // lowercase SHA-256 hex (64 chars)
}

export interface RemoteProfile {
  id: string;
  label: string;
  sshDestination: string;
  port?: number;
  polytokenPolicy: "requireExisting" | "offerInstall";
  remoteRootOverride?: string;
  serverPath?: string;
  xdgMode: "isolated" | "shared";
  executionTarget: ExecutionTargetProfile;  // defaults to { kind: "host" }
  riskAcknowledgements: RiskAcknowledgements;
}
```

**Rust** (`desktop/src/remote_profile.rs`): the `ExecutionTargetProfile` enum is
serde-tagged on `kind` (`"host"` / `"dockerContainer"`), camelCase-renamed.
Existing profiles without execution-target fields deserialize as `Host` (serde
default). `RiskAcknowledgements` carries `root_fingerprint` + `ephemeral_fingerprint`
as `Option<String>`. Fingerprint computation uses SHA-256 over canonical field
lists (see `root_risk_fingerprint` and `ephemeral_risk_fingerprint` functions).

The discriminant is `executionTarget.kind`, not a top-level
`executionEnvironment` field — but the UI behavior is identical to the plan's
profile-model requirement (item 1).

### Implemented host descriptor

**TypeScript** (`NativeHostDescriptor` in `types.ts`):

```ts
export interface NativeHostDescriptor {
  id: string;
  kind: "local" | "remote";
  label: string;
  subtitle: string;
  state: HostConnectionState;
  wsUrl?: string;
  failureLabel?: string;
  failureAction?: string;
  failureDetail?: string;
  preflightPhase?: PreflightPhase;     // only during preflight/awaitingAcknowledgement
  pendingRisks?: PendingRisk[];        // only during awaitingAcknowledgement
}
```

**Rust** (`HostStateSnapshot` in `remote_commands.rs`): the snapshot carries
`redacted_ssh_host` + `container_name` for Docker targets. The Tauri provider
builds the subtitle as `<containerName> via <redactedSshHost>`. This matches the
subtitle requirement (item 2).

`NativeHostDescriptor` gains `preflightPhase` + `pendingRisks` fields for
preflight/acknowledgement states.

### Implemented connection commands

The `HostProvider` interface (`provider.ts`) exposes:

- `listHosts()` → `NativeHostDescriptor[]`
- `connectHost(id)` → starts connection (calls `ensure_remote_host` → preflight
  runs automatically)
- `disconnectHost(id)`
- `listProfiles()` / `getProfile(id)` / `addProfile(profile)` /
  `updateProfile(profile)` / `deleteProfile(id)`
- `acknowledgeRisk(id, riskId, fingerprint)` — validates fingerprint natively
- `cancelConnection(id)`
- `resumeConnection(id)`

Tauri commands (`remote_commands.rs`): `ensure_remote_host`, `host_state`,
`list_hosts`, `disconnect_host`, `acknowledge_risk`, `cancel_connection`,
`resume_connection`. Profile CRUD: `list_remote_profiles`, `add_remote_profile`,
`update_remote_profile`, `delete_remote_profile`.

### Implemented preflight phases

`PreflightPhase` (in `types.ts` + `remote_connection.rs`):

```ts
export type PreflightPhase =
  | "checkingDockerAccess"
  | "locatingContainer"
  | "inspectingIdentity"
  | "checkingUserPermissions"
  | "checkingPersistence";
```

These are sub-phases within the `preflight` / `awaitingAcknowledgement`
connection states.

### Implemented risk kinds

`RiskKind` (in `types.ts` + `remote_connection.rs`):

```ts
export type RiskKind = "rootExecution" | "ephemeralData";
```

**Two kinds, not three.** The plan requires a third `DockerSocket` risk (item 12);
the backend does not implement it. This is a UI-side gap (see gap c below).

### PendingRisk shape

```ts
export interface PendingRisk {
  id: string;
  kind: RiskKind;
  fingerprint: string;       // SHA-256 hex, opaque equality token
  title: string;
  explanation: string;
  consequences: string;
  continueLabel: string;
}
```

### Backend gaps (UI-side expectations the backend track must reconcile)

The following are requirements the UI has that the implemented backend does not
yet satisfy. The UI implementer does NOT build the Rust for these — they are
flagged as expectations the backend architecture track must reconcile. The UI
must degrade gracefully when a command is unavailable (see item 22).

**(a) No standalone "test SSH + list containers" command.** The implemented
flow is: save profile → `ensure_remote_host` → preflight runs automatically. The
setup dialog (items 4–5) needs a "Test SSH & find containers" action that lists
running containers *before* saving a profile. Required command shape:

```ts
// New HostProvider method (or equivalent):
testSshAndListContainers(
  sshDestination: string,
  port?: number,
): Promise<{
  sshOk: boolean;
  dockerPermission: "granted" | "denied" | "unknown";
  containers: ContainerSummary[];
}>;

interface ContainerSummary {
  name: string;
  image: string;
  state: string;           // "running" | "exited" | ...
  configuredUser: string;  // from Config.User, or "" if image default
  composeProject?: string;
  composeService?: string;
}
```

**Gap status: not yet implemented in the backend.** The UI must handle the
absence of this command by falling back to the save-then-ensure flow, or by
disabling the Test button with a hint.

**(b) No "inspect one container" command for the picker.** The picker (item 5)
needs container details (image, configured user, compose metadata) before
selection. The `testSshAndListContainers` result (gap a) may carry enough for
the list rows, but the Customize target disclosure (items 7–9) needs resolved
user/UID, home directory, and mount backing — which require a per-container
inspect. Required command shape:

```ts
inspectContainer(
  sshDestination: string,
  port: number | undefined,
  containerName: string,
): Promise<ContainerInspection>;

interface ContainerInspection {
  name: string;
  containerId: string;
  image: string;
  running: boolean;
  configuredUser: string;
  resolvedUser: string;     // e.g. "dev" or "root"
  resolvedUid: number;
  resolvedGid: number;
  resolvedHome: string;
  os?: string;              // e.g. "linux" — NOT currently parsed by DockerInspect
  arch?: string;            // e.g. "arm64" — NOT currently parsed by DockerInspect
  mounts: MountSummary[];
  pantokenRootSuggestion: string;  // resolvedHome + /.local/share/pantoken
}

interface MountSummary {
  type: "bind" | "volume" | "tmpfs" | "writableLayer";
  source?: string;
  destination: string;
  readOnly: boolean;
  name?: string;            // for named volumes
}
```

**Gap status: not yet implemented.** `DockerInspect` does not parse OS/arch.

**(c) No Docker socket risk detection.** The `DockerMount` struct does not
detect socket mounts; `RiskKind` has no `DockerSocket` variant. The doc
specifies socket detection as a requirement (item 12) and flags it as
not-yet-implemented. Required additions:

- `RiskKind` gains a `"dockerSocket"` variant.
- `DockerMount` detection identifies socket mounts (mount type `bind` with a
  source path ending in `/docker.sock` or matching a known socket pattern).
- `preflight_docker` pushes a `PendingRisk` with `kind: "dockerSocket"` when a
  socket mount is detected and no valid acknowledgement exists.

**Gap status: not yet implemented.** The UI must render the socket risk panel
when the backend surfaces it, and must not crash if the backend never sends it.

**(d) Dev-provider does not model Docker states.** `dev-provider.ts` has
`acknowledgeRisk` as a no-op and no Docker preflight/picker modeling. The
`FakeHostProvider` in `provider.ts` does have `setPendingRisks` +
`setPreflightPhase`, but the `?dev` dev-provider does not. Required dev-provider
hooks:

```ts
// Additions to DevHostControls:
setPendingRisks(id: string, risks: PendingRisk[]): void;
setPreflightPhase(id: string, phase: PreflightPhase): void;
setContainerPicker(id: string, containers: ContainerSummary[]): void;
driveProvisioningPhase(id: string, phase: number): void;  // 1-4
driveReplacement(id: string): void;  // simulate container ID change
acknowledgeRisk(id: string, riskId: string, fingerprint: string): Promise<void>;
```

**Gap status: not yet implemented in `dev-provider.ts`.** The `FakeHostProvider`
already has the first two; the `?dev` provider needs all of them.

**(e) No capability detection for degradation.** The `HostProvider` interface
does not expose whether container commands are available. Required addition:

```ts
// New HostProvider method:
supportsContainerTargets(): boolean;
```

The Tauri provider returns `true`; the single-host browser provider returns
`false`; the dev provider returns `true`. The UI uses this to disable the
Docker container option in the segmented control (item 22).

**Gap status: not yet implemented.**

**(f) No resolved-detail exposure in HostStateSnapshot.** The `preflight_docker`
function computes UID, persistence classification, and container identity, but
`HostStateSnapshot` only carries `preflightPhase` and `pendingRisks` — not the
resolved details the UI needs for:

- Completed-step detail (item 15: container name, user/UID, OS/arch,
  persistence).
- Post-verification display (items 8–9: resolved identity, backing).

Additionally, `DockerInspect` does not parse OS/arch. Required: either new
`HostStateSnapshot` fields or a new command that returns resolved details:

```ts
// Option A: new HostStateSnapshot fields:
interface ResolvedDockerDetails {
  containerName: string;
  containerId: string;
  resolvedUser: string;
  resolvedUid: number;
  os: string;
  arch: string;
  persistenceBacking: "persistentVolume" | "persistentBind" | "ephemeralTmpfs" | "ephemeralWritableLayer";
  backingName?: string;   // volume name or bind source path
}

// Option B: new command:
getResolvedDockerDetails(id: string): Promise<ResolvedDockerDetails>;
```

**Gap status: not yet implemented.** The UI must handle the absence by showing
generic phase labels without the completed-step detail line.

### What the doc must NOT do

Redesign the profile model, risk fingerprinting, or connection state machine —
these are implemented and settled. The doc documents them as-is and layers UI
requirements on top.

## Per-surface specs

Each surface below includes an ASCII wireframe mirroring its HTML mockup, plus
exact UI copy for labels, buttons, warnings, and failures. Mockup filenames
refer to `docs/mockups/container-setup/`.

### Setup dialog — Stage 1 (SSH fields + segmented control)

**Mockup:** `01-setup-stage1.html` (desktop + phone framings)

```text
┌─ Add computer ────────────────────────────── Close ─┐
│                                                      │
│  Name (optional)                                    │
│  ┌──────────────────────────────────────────────┐   │
│  │ e.g. Work API Dev                             │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  SSH destination                                    │
│  ┌──────────────────────────┐ ┌────────────┐       │
│  │ user@host or SSH alias    │ │ Port       │       │
│  └──────────────────────────┘ └────────────┘       │
│  Pantoken uses your existing SSH config, agent,     │
│  and keychain. No passwords stored.                 │
│                                                      │
│  Execution environment                              │
│  ┌──────────┬─────────────────┐                     │
│  │  Host    │ Docker container│ ← selected          │
│  └──────────┴─────────────────┘                     │
│  Run the agent directly on the SSH host, or         │
│  inside a Docker container on that host.            │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │           Test SSH & find containers          │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ▸ Advanced                                          │
│                                                      │
├──────────────────────────────────────────────────────┤
│  Cancel setup                                        │
└──────────────────────────────────────────────────────┘
```

**Copy:**
- Dialog title: `Add computer` (new) or `Edit computer` (editing).
- Name field placeholder: `e.g. Work API Dev`. Label includes `(optional)`.
- SSH destination placeholder: `user@host or SSH config alias`.
- Port placeholder: `Port`, default value `22`.
- SSH hint: `Pantoken uses your existing SSH config, agent, and keychain. No
  passwords stored.`
- Segmented control: `Host` | `Docker container`.
- Environment hint: `Run the agent directly on the SSH host, or inside a Docker
  container on that host.`
- Test button: `Test SSH & find containers`. Disabled until SSH destination is
  non-empty. When Docker container is selected but `supportsContainerTargets()`
  is false, the Docker option is disabled with hint `Docker targets require the
  Pantoken desktop app`.
- Advanced disclosure: `Advanced` — contains Server binary path, XDG mode
  (Isolated | Shared). Same as base doc.
- Footer: `Cancel setup` (before provisioning starts).

**Phone:** Full-screen overlay with `‹ Back` button (44px), same fields, 44px
minimum touch targets on all inputs and buttons. Back gesture closes via
`overlay-history.ts`.

### Testing SSH & finding containers (in-progress)

**Mockup:** `02-testing-ssh.html`

```text
┌─ Add computer ────────────────────────────── Close ─┐
│  ...fields as above...                               │
│  ┌──────────────────────────────────────────────┐   │
│  │  ◌ Testing SSH & finding containers…          │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │  • Connecting to dev-server via SSH…          │   │
│  └──────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────┤
│  Cancel setup                                        │
└──────────────────────────────────────────────────────┘
```

**Copy:**
- Test button becomes disabled with spinner: `Testing SSH & finding
  containers…`
- Status box shows the current sub-step: `Connecting to <host> via SSH…` →
  `Checking Docker access…` → `Listing running containers…`

### SSH failure attached to the test action

**Mockup:** `03-ssh-failure.html`

```text
┌─ Add computer ────────────────────────────── Close ─┐
│  ...fields as above...                               │
│  ┌──────────────────────────────────────────────┐   │
│  │           Test SSH & find containers          │   │
│  └──────────────────────────────────────────────┘   │
│  ┌─ ⚠ SSH authentication failed ─────────────────┐  │
│  │  Check your SSH key is loaded in the agent,   │  │
│  │  or that the key/passphrase is correct.        │  │
│  │  [ Retry ]  [ Edit ]                          │  │
│  └────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────┤
│  Cancel setup                                        │
└──────────────────────────────────────────────────────┘
```

**Copy:**
- Error title: `SSH authentication failed` (or `Can't reach the host`, `Host
  key unknown` — matching the base doc's failure classifications).
- Error message: the base doc's `suggested_action()` text.
- Actions: `Retry` (primary, re-runs the test), `Edit` (focuses the SSH
  destination field).
- SSH errors attach to the Test button action, never appear while typing.

### Container picker — few containers (no search)

**Mockup:** `04-picker-few.html`

```text
┌─ Add computer ────────────────────────────── Close ─┐
│  ┌──────────────────────────────────────────────┐   │
│  │  ● SSH connected to dev-server · Docker       │   │
│  │    permission: granted                        │   │
│  └──────────────────────────────────────────────┘   │
│  Name (optional)                                    │
│  ┌──────────────────────────────────────────────┐   │
│  │ Work API Dev                                  │   │
│  └──────────────────────────────────────────────┘   │
│  RUNNING CONTAINERS (3)                              │
│  ┌──────────────────────────────────────────────┐   │
│  │ ▣  work-api-dev              running         │   │
│  │    node:20-alpine · dev      ← selected      │   │
│  ├──────────────────────────────────────────────┤   │
│  │ ▣  postgres-dev               running         │   │
│  │    postgres:16 · Image default                │   │
│  ├──────────────────────────────────────────────┤   │
│  │ ▣  redis-cache                running         │   │
│  │    redis:7-alpine · Image default             │   │
│  └──────────────────────────────────────────────┘   │
│  Enter exact container name instead                  │
│  ┌──────────────────────────────────────────────┐   │
│  │           Use this container                  │   │
│  └──────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────┤
│  Cancel setup     SSH: dev@dev-server:22 · Docker   │
└──────────────────────────────────────────────────────┘
```

**Copy:**
- SSH summary: `● SSH connected to <host> · Docker permission: <granted|denied>`.
- Section label: `Running containers (N)`.
- Row: container name (bold), image (mono), configured user or `Image default`,
  optional Compose metadata (`compose: <project>/<service>`), `running` status.
- `Enter exact container name instead` — link below the list.
- `Use this container` — gold primary button.
- Footer right: `SSH: <destination>:<port> · Docker container`.

### Container picker — many containers (search visible)

**Mockup:** `05-picker-many.html`

Same as above, but with a search field above the list when >6 containers are
returned:

```text
│  ┌──────────────────────────────────────────────┐   │
│  │ 🔍 Search containers…                        │   │
│  └──────────────────────────────────────────────┘   │
```

Search filters by name (exact or substring). The list scrolls if it overflows.

### Exact-name entry for a non-running container

**Mockup:** `06-exact-name-disconnected.html`

```text
│  Enter exact container name instead                  │
│  ‹ Back to container list                            │
│  Exact container name                               │
│  ┌──────────────────────────────────────────────┐   │
│  │ nightly-runner                                │   │
│  └──────────────────────────────────────────────┘   │
│  The saved selector is always the exact container   │
│  name. Discovery is only a convenience.              │
│  ┌─ ⚠ Container not currently running ──────────┐  │
│  │  This container is not running right now. You  │  │
│  │  can still save this profile — it will appear  │  │
│  │  as a disconnected computer in Container not   │  │
│  │  running state. It cannot provision until the  │  │
│  │  container exists and runs. Start or recreate  │  │
│  │  the container outside Pantoken, then retry.   │  │
│  └────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐   │
│  │           Save & connect later                 │   │
│  └──────────────────────────────────────────────┘   │
```

**Copy:**
- `‹ Back to container list` — returns to the picker.
- Field label: `Exact container name`.
- Hint: `The saved selector is always the exact container name. Discovery is
  only a convenience.`
- Warning box title: `Container not currently running`.
- Warning body: `This container is not running right now. You can still save
  this profile — it will appear as a disconnected computer in Container not
  running state. It cannot provision until the container exists and runs. Start
  or recreate the container outside Pantoken, then retry.`
- Button: `Save & connect later` (saves the profile without provisioning).

### Selected container — Customize target disclosure

**Mockup:** `07-customize-target.html`

```text
│  ▾ Customize target                                  │
│    Container user                                    │
│    ┌──────────────────────────────────────────────┐ │
│    │ dev                                           │ │
│    └──────────────────────────────────────────────┘ │
│    dev · UID 1000                                    │
│    Always persisted explicitly. Pre-filled from the  │
│    container's configured user.                       │
│                                                      │
│    Pantoken root                                     │
│    ┌──────────────────────────────────────────────┐ │
│    │ /home/dev/.local/share/pantoken              │ │
│    └──────────────────────────────────────────────┘ │
│    Default = selected user's home +                 │
│    /.local/share/pantoken. Never persists ~.        │
│    Persistent · volume pantoken-data                │
```

**Copy:**
- Disclosure summary: `Customize target`.
- Container user field: pre-filled from inspection. Resolved identity shown
  below: `<user> · UID <uid>`.
- User hint: `Always persisted explicitly. Pre-filled from the container's
  configured user.`
- Pantoken root field: pre-filled with resolved absolute path. Hint: `Default =
  selected user's home + /.local/share/pantoken. Never persists ~.`
- Backing line (after verification): `Persistent · volume <name>` /
  `Persistent · bind mount <path>` / `Ephemeral · container writable layer`.
- Root suggestion recomputes when the container user changes, unless the user
  edited the path manually.

### Review risks panel — all three risks

**Mockup:** `08-risks-all-three.html`

```text
┌─ Review risks ─────────────────────── Run in background ─┐
│                                                            │
│  Review risks before connecting                            │
│  The following risks were detected for work-api-dev via    │
│  dev-server. Review each item, then accept to continue.    │
│                                                            │
│  ┌─ ⚠ Agent runs as root ──────────────────────────────┐  │
│  │  Agent commands will run as root. Files in bind-    │  │
│  │  mounted workspaces may become root-owned. Mounted  │  │
│  │  host paths or a Docker socket can expose broader   │  │
│  │  host access; container root is not necessarily     │  │
│  │  isolated from the host.                           │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─ ⚠ Ephemeral Pantoken root ─────────────────────────┐  │
│  │  Pantoken data will be lost when this container is  │  │
│  │  replaced. Sessions, runtime files, and Pantoken-    │  │
│  │  managed agent data stored here exist only in this  │  │
│  │  container's writable layer.                       │  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌─ ⚠ Docker socket exposed ───────────────────────────┐  │
│  │  This container can control Docker on the host. The │  │
│  │  mounted Docker socket may let agent commands       │  │
│  │  create privileged containers, mount host paths, or │  │
│  │  otherwise gain host-level access.                 │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │            Accept risks & continue                    │ │
│  └──────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Cancel setup       3 risks detected · one click to accept  │
└──────────────────────────────────────────────────────────────┘
```

**Copy:**
- Panel title: `Review risks before connecting`.
- Panel sub: `The following risks were detected for <container> via <host>.
  Review each item, then accept to continue.`
- Risk titles and bodies: exact text from item 12.
- Single button: `Accept risks & continue` (gold primary).
- Footer right: `N risks detected · one click to accept all`.
- Close control: `Run in background` (provisioning has started).

### Review risks panel — ephemeral-root-only variant

**Mockup:** `08b-risks-ephemeral-only.html`

When ephemeral root is the only risk, the primary action becomes **Choose
another path** (which returns to the Customize target disclosure to pick a
persistent path), and **Accept risks & continue** is secondary:

```text
│  ┌──────────────────────────────────────────────────────┐ │
│  │              Choose another path                      │ │
│  └──────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐ │
│  │           Accept risks & continue                      │ │
│  └──────────────────────────────────────────────────────┘ │
```

**Copy:**
- Footer right: `1 risk detected · ephemeral root only`.

### Provisioning — four Docker phases

**Mockup:** `09-provisioning.html`

```text
┌─ Connecting to Work API Dev ──────────── Run in background ─┐
│                                                              │
│  Setting up Docker target                                    │
│  work-api-dev via dev-server                                 │
│                                                              │
│  ✓  SSH & Docker                                             │
│     SSH connected · Docker CLI available · permission granted│
│                                                              │
│  2  Container ◌                                              │
│     Locating container by name · inspecting identity…        │
│                                                              │
│  3  Polytoken                                                │
│     Checking compatibility                                   │
│                                                              │
│  4  Pantoken runtime                                         │
│     Starting runtime                                         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Cancel setup              Phase 2 of 4 · Container           │
└──────────────────────────────────────────────────────────────┘
```

**Copy:**
- Dialog title: `Connecting to <profile label>`.
- Sub-title: `Setting up Docker target`.
- Sub-line: `<container> via <host>`.
- Phase labels: `SSH & Docker`, `Container`, `Polytoken`, `Pantoken runtime`.
- Completed phase: green ✓ marker + detail line.
- Active phase: bronze number marker + spinner + detail line.
- Pending phase: muted number marker + label only.
- Completed-step detail example: `work-api-dev · dev (UID 1000) · linux/arm64
  · persistent volume`.
- Footer right: `Phase N of 4 · <phase name>`.
- Close control: `Run in background`.
- Cancel setup: visible only during safely cancellable phases (SSH & Docker,
  Container).

### Provisioning failure at Container phase

**Mockup:** `10-provisioning-failure.html`

```text
│  ✓  SSH & Docker                                             │
│     SSH connected · Docker CLI available · permission granted│
│                                                              │
│  ✕  Container                                                │
│     work-api-dev · dev (UID 1000) · linux/arm64 · persistent │
│     volume                                                   │
│                                                              │
│  3  Polytoken                                                │
│  4  Pantoken runtime                                         │
│                                                              │
│  ┌─ ✕ Configured container user missing ────────────────┐  │
│  │  The user dev does not exist in container            │  │
│  │  work-api-dev. Update the container user in the      │  │
│  │  profile to match a user that exists in the          │  │
│  │  container.                                           │  │
│  │  [ Edit container user ]  [ Retry ]                  │  │
│  │  ▸ Show technical details                             │  │
│  └───────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  Cancel setup       Failed at phase 2 of 4 · Container       │
└──────────────────────────────────────────────────────────────┘
```

**Copy:**
- Failed phase: red ✕ marker.
- Error box: red border, title + message + actions + collapsible technical
  details.
- Technical details: redacted, behind a `Show technical details` disclosure.
  Bounded to 500 chars (matching `redact_detail` in `remote_commands.rs`).

### Run-in-background state

**Mockup:** `11-run-in-background.html`

The dialog stays open with `Run in background` as the close control. The
switcher shows the computer row as `Provisioning…`:

```text
Switcher:
  ⌂  This computer          Ready
  ▣  Work API Dev           Provisioning…
     work-api-dev via dev-server
```

**Copy:**
- Switcher row status: `Provisioning…` with bronze running indicator.
- Dialog close control: `Run in background` (not Cancel).
- If backgrounded, success shows a ready/unseen indicator (gold dot) — does not
  switch computers.

### Host switcher — Docker computer row

**Mockup:** `12-switcher-row.html`

```text
┌─ Computers ──────────────────────────── Close ─┐
│                                                  │
│  ⌂  This computer              ● Ready           │
│     Dev computer                                 │
│                                                  │
│  ▣  Work API Dev               ● Running         │
│     work-api-dev via dev-server  ← selected      │
│                                                  │
│  ▣  Build Server                ● Unseen         │
│     build-server                                 │
│                                                  │
│  ──────────────────────────────────────────────  │
│  Add computer                                    │
│  Manage computers                                │
└──────────────────────────────────────────────────┘
```

**Copy:**
- Container targets use ▣ glyph; host/local targets use ⌂.
- Subtitle: `<containerName> via <redactedSshHost>`.
- Indicators follow the base doc's precedence: offline > failed > waiting >
  reconnecting > unseen > running > quiet.

### Settings → Computers list

**Mockup:** `13-settings-computers.html`

```text
┌─ Computers ──────────────────────────────────── Close ─┐
│                                                          │
│  THIS COMPUTER                                          │
│  ⌂  Timo's MacBook                       Ready          │
│     This computer                                        │
│                                                          │
│  REMOTE COMPUTERS                                       │
│  ▣  Work API Dev                         Ready          │
│     dev@dev-server:22                                    │
│     Docker container · work-api-dev                     │
│                              [ Edit ]  [ Disconnect ]   │
│                                                          │
│  ▣  Build Server                    Disconnected        │
│     ci@build-server                                      │
│     Host                                                 │
│                              [ Connect ]  [ Edit ]      │
│                                                          │
│  ▣  Nightly Build Runner     Container not running      │
│     dev@dev-server:22                                    │
│     Docker container · nightly-runner                   │
│                              [ Retry ]  [ Edit ]        │
│                                                          │
│  + Add computer                                         │
└──────────────────────────────────────────────────────────┘
```

**Copy:**
- Each remote computer card shows: name, SSH destination, environment tag
  (`Docker container · <containerName>` or `Host`), state, actions.
- Container not running state: `Container not running` with Retry + Edit.
- Actions vary by state: Ready → Edit, Disconnect; Disconnected → Connect,
  Edit; Container not running → Retry, Edit.
- `+ Add computer` primary action at the bottom.

### Edit dialog — read-only execution environment

**Mockup:** `14-edit-dialog.html`

```text
┌─ Edit computer ──────────────────────────────── Close ─┐
│                                                          │
│  Name                                                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Work API Dev                                       │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  SSH destination                                        │
│  ┌──────────────────────────┐ ┌────────────┐           │
│  │ dev@dev-server            │ │ 22         │           │
│  └──────────────────────────┘ └────────────┘           │
│                                                          │
│  Execution environment                                  │
│  🔒 Docker container — immutable after creation         │
│  To switch to Host execution, add a new computer        │
│  profile.                                                │
│                                                          │
│  ┌─ Docker target ─────────────────────────────────┐    │
│  │  Container name                                 │    │
│  │  work-api-dev                                   │    │
│  │  Container user                                 │    │
│  │  dev                                             │    │
│  │  dev · UID 1000                                 │    │
│  │  Pantoken root                                  │    │
│  │  /home/dev/.local/share/pantoken                │    │
│  │  Persistent · volume pantoken-data              │    │
│  └─────────────────────────────────────────────────┘    │
│  ▸ Advanced                                              │
│                                                          │
│  ⚠ Reconnection required. Changing container selection, │
│  user, or root saves a new profile and keeps the old    │
│  connection live until you reconnect.                   │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Reconnect later              [ Reconnect now ]         │
└──────────────────────────────────────────────────────────┘
```

**Copy:**
- Read-only field: `🔒 Docker container — immutable after creation`.
- Read-only hint: `To switch to Host execution, add a new computer profile.`
- Docker target section: editable container name, user, root (with resolved
  identity + backing lines).
- Reconnect notice: `Reconnection required. Changing container selection, user,
  or root saves a new profile and keeps the old connection live until you
  reconnect.`
- Footer: `Reconnect later` (secondary) | `Reconnect now` (primary).

### Replacement & recovery

**Mockup:** `15-replacement-recovery.html`

**Container replaced · Reconnecting (transient):**

```text
Switcher:
  ⌂  This computer          Ready
  ▣  Work API Dev           Reconnecting…
     work-api-dev via dev-server
     [Container replaced · Reconnecting]
```

**Copy:**
- Transient badge: `Container replaced · Reconnecting` (appears briefly during
  automatic reprobe/reconnect).
- The resolved container ID lives in details/diagnostics, never in normal chrome.
- If an acknowledgement or repair is needed, the focused sheet opens at the
  Container phase.

**Container not running (recovery):**

```text
Settings card:
  ▣  Nightly Build Runner     Container not running
     dev@dev-server:22
     Docker container · nightly-runner
                    [ Retry ]  [ Choose another ]

  Container not running. Start or recreate the container
  nightly-runner outside Pantoken, then click Retry.
  Pantoken does not manage container lifecycle.
```

**Copy:**
- State: `Container not running`.
- Actions: `Retry` + `Choose another`.
- Guidance: `Container not running. Start or recreate the container
  <containerName> outside Pantoken, then click Retry. Pantoken does not manage
  container lifecycle.`

### Phone full-screen flow

**Mockup:** `16-phone-flow.html` (two 375px frames: picker + risks)

Phone replaces the dialog with a full-screen, back-integrated overlay of the
same component. Phone mockups cover the flow-defining states (picker, risks)
rather than repeating every desktop state. Desktop states not given phone frames
are the same component responsively adapted and are covered by e2e
touch-target/back-gesture tests.

## Failure-state table

Nine failure families. Each has plain-language copy, one concrete next action,
and redacted details behind a disclosure.

**State mapping note:** `Container not running` and all nine failure families
render as `state: "failed"` in `HostConnectionState`, with `failureLabel` set to
the user-facing copy and `failureAction` set to the primary action label (e.g.
`"Retry"`, `"Edit container user"`). The `Container not running` state is not a
distinct `HostConnectionState` variant — it is `failed` with a specific
`failureLabel: "Container not running"` and `failureAction: "Retry"`. An
already-saved docker profile whose container commands are unavailable renders as
`failed` with `failureLabel: "Container support unavailable on this device"`.

| # | State | User copy | Next action | Redacted detail behavior |
|---|-------|-----------|-------------|--------------------------|
| 1 | Docker unavailable or permission denied on the host | `Docker CLI is not available on the SSH host, or the SSH account doesn't have permission to use it.` | `Install Docker on the host, or fix the SSH account's Docker group membership.` | Redacted stderr from `docker version`, behind `Show technical details`. |
| 2 | Container not found under the saved exact name | `No running container matches the exact name <name>.` | `Check the container name spelling, or start the container outside Pantoken.` | Redacted `docker container ls` output, behind disclosure. |
| 3 | Container exists but is stopped | `Container <name> exists but is not running (state: <state>).` | `Start the container outside Pantoken, then click Retry.` | Container state string, behind disclosure. |
| 4 | Ambiguous match for the saved name | `Multiple containers have the exact name <name>. Use a unique container name.` | `Rename the container outside Pantoken to make it unique.` | Count of matches, behind disclosure. |
| 5 | Configured container user missing in the container | `The user <user> does not exist in container <name>.` | `Edit the container user in the profile to match a user that exists in the container.` | Redacted identity probe output, behind disclosure. |
| 6 | Risk acknowledgement required | Presented via the Review risks panel (item 12). One family for pending-decision states: root not yet acknowledged, ephemeral not yet waived, or socket not yet acknowledged. | `Accept risks & continue` (or `Choose another path` for ephemeral-only). | Risk fingerprints are opaque tokens; no raw detail shown. |
| 7 | Workspace or Pantoken root not writable by the selected user | `The Pantoken root <path> is not writable by user <user> (UID <uid>).` | `Fix directory permissions in the container, or choose a different Pantoken root.` | Redacted write-probe output, behind disclosure. |
| 8 | Pantoken root not mounted (waivable via the risk panel) | `The Pantoken root <path> is on the container's writable layer (no persistent mount).` | `Choose another path` (primary) or `Accept risks & continue` (secondary). | Mount classification + backing identity hash, behind disclosure. |
| 9 | Replacement mismatch | `The container <name> was replaced with a new container that has incompatible architecture/environment, or the expected mount is missing.` | `Choose another container` or `Edit the profile` to update the target.` | New vs old container ID (redacted), arch mismatch detail, behind disclosure. |

## Implementation sequence

Work in these reviewable stages. Keep tests green after each stage. This
sequence depends on the base task's Settings → Computers and connection sheet
surfaces being implemented first (or in parallel — the container brief layers on
them).

1. **Types and contract parsing**
   - Extend the TS types for any new `PendingRisk` kinds, `ContainerSummary`,
     `ContainerInspection`, `ResolvedDockerDetails` shapes.
   - Add `supportsContainerTargets()` to the `HostProvider` interface.
   - Add `testSshAndListContainers()` and `inspectContainer()` to the interface
     (with no-op/throwing defaults in the single-host provider).
   - Unit tests for contract parsing, risk invalidation keys, name suggestion,
     backing formatting.

2. **Provider + dev-fake hooks**
   - Implement `supportsContainerTargets()` in all three providers.
   - Add Docker-state hooks to the dev-provider (`setPendingRisks`,
     `setPreflightPhase`, `setContainerPicker`, `driveProvisioningPhase`,
     `driveReplacement`, real `acknowledgeRisk`).
   - Extend `FakeHostProvider` with container picker populations and failure
     state injection.

3. **Setup dialog flow**
   - Stage 1: SSH fields + segmented control + Test button.
   - Stage 2: container picker, exact-name fallback, Customize target
     disclosure.
   - Name suggestion logic (humanize container name, never overwrite
     user-edited).
   - Dirty-check confirmation on close.

4. **Risk/verification UX**
   - Review risks panel with all three risk kinds.
   - Ephemeral-only variant with Choose another path primary.
   - Single Accept risks & continue action.
   - Per-risk acknowledgement persistence + invalidation logic.

5. **Provisioning presentation**
   - Four Docker phases with completed-step detail.
   - Run in background / Cancel setup coexistence.
   - Failure states with actions + redacted details.

6. **Switcher / Settings integration**
   - Docker computer rows (glyph, subtitle, indicators).
   - Settings → Computers list with container profile rows.
   - Edit dialog with read-only execution environment.
   - Replacement & recovery states.

7. **E2E tests**
   - Playwright e2e via the dev provider: every picker/risk/failure/
     replacement state, phone targets, back-gesture.
   - Ensure base-doc suites stay green.

## Required tests

### TypeScript/unit

- Risk invalidation keys: root ack invalidated by new container ID; ephemeral
  waiver invalidated by root path or mount backing change; socket ack
  invalidated by container replacement / socket mount change.
- Name suggestion: `work-api-dev` → `Work API Dev`; never overwrites a
  user-edited name; host targets suggest SSH alias/hostname after successful
  test.
- Backing formatting: `Persistent · volume <name>`,
  `Persistent · bind mount <path>`, `Ephemeral · container writable layer`.
- Contract parsing: `ExecutionTargetProfile` discriminated union round-trip;
  legacy profiles without execution-target fields deserialize as `Host`;
  `PendingRisk` DTO round-trip; `RiskKind` parsing.
- Degradation: `supportsContainerTargets()` returns false in browser provider;
  Docker option disabled; saved docker profile renders as failed computer.
- Pantoken root suggestion: recomputes when container user changes unless
  user-edited; never persists `~`.

### Playwright/client scenarios

- Setup dialog stage 1: SSH fields + segmented control; Test button disabled
  until SSH destination non-empty; Name does not block testing.
- Testing SSH in-progress state renders spinner + phase label.
- SSH failure attached to test action with Retry/Edit.
- Container picker: few containers (no search); many containers (search
  visible); row shows name, image, user, status, compose metadata.
- Exact-name entry for non-running container: warning box + Save & connect
  later.
- Customize target disclosure: user + root pre-filled; resolved identity +
  backing line shown.
- Review risks panel: all three risks; single Accept risks & continue.
- Review risks panel: ephemeral-only variant; Choose another path primary.
- Provisioning: four Docker phases; completed-step detail; active phase
  spinner.
- Provisioning failure at Container phase: error box + actions + technical
  details disclosure.
- Run in background: close control = Run in background; switcher row shows
  Provisioning….
- Host switcher: Docker computer row with ▣ glyph + `name via host` subtitle.
- Settings → Computers: container profile row with environment tag + state +
  actions.
- Edit dialog: read-only execution environment; Docker target fields editable;
  Reconnect now / Later.
- Container replaced · Reconnecting transient status.
- Container not running: Retry + Choose another + guidance.
- Phone: picker and risks panel at 375px; 44px targets; Back closes overlay.
- Degradation: Docker option disabled when `supportsContainerTargets()` is
  false; saved docker profile renders as failed computer.

### Base-doc suites that must stay green

- All existing connection banner, reconnect, per-client focus, drafts, and
  notification tests.
- All existing host switcher, Settings, and connection sheet tests from the
  base brief.
- All existing protocol, Rust, and e2e gates.

## Acceptance criteria

The task is complete only when all are true:

1. A Docker container appears as a top-level computer profile in the host
   switcher and Settings, with a distinct glyph and `container-name via
   ssh-host` subtitle.
2. The setup dialog's two-stage flow works: SSH test → container picker →
   Customize target → Use this container → provisioning. The common case is
   two clicks after the SSH test.
3. The Review risks panel presents all applicable risks with a single Accept
   risks & continue button; the ephemeral-only variant shows Choose another
   path as primary.
4. Risk acknowledgements are persisted separately and re-prompted only for
   newly introduced or invalidated risks.
5. Provisioning shows four Docker phases with completed-step detail; Run in
   background and Cancel setup coexist correctly; safely cancellable phases are
   documented.
6. Container replacement triggers automatic reprobe/reconnect with a transient
   status; missing/stopped containers show Retry + Choose another with
   guidance.
7. Execution environment is immutable after creation; the edit dialog shows a
   read-only line.
8. The UI degrades gracefully when container commands are unavailable: Docker
   option disabled, saved profiles render as failed computers.
9. Desktop and phone layouts follow `docs/ui-conventions.md`, including shared
   controls, focus behavior, touch targets (44px), and overlay history.
10. The logical Pantoken protocol remains unchanged.

### AC → test mapping

| AC | Test(s) |
|----|---------|
| 1 | `switcher_docker_row_glyph_and_subtitle`, `settings_container_profile_row` |
| 2 | `setup_dialog_two_stage_flow`, `use_this_container_starts_provisioning` |
| 3 | `review_risks_all_three_single_accept`, `review_risks_ephemeral_only_choose_path` |
| 4 | `risk_ack_persisted_separately`, `risk_invalidation_on_container_replacement`, `risk_invalidation_on_root_path_change` |
| 5 | `provisioning_four_docker_phases`, `provisioning_completed_step_detail`, `run_in_background_coexistence`, `cancel_setup_only_in_safe_phases` |
| 6 | `container_replaced_reconnecting_transient`, `container_not_running_retry_choose_another` |
| 7 | `edit_dialog_read_only_execution_environment`, `edit_reconnect_now_later` |
| 8 | `degradation_docker_option_disabled`, `degradation_saved_profile_failed_computer` |
| 9 | `phone_picker_44px_targets`, `phone_risks_back_gesture`, `phone_overlay_history_integration` |
| 10 | `protocol_unchanged_regression` |

## Non-goals

- Container lifecycle controls (start/stop/rebuild/delete) anywhere in the UI.
- Rust implementation of the new backend commands (test-SSH/list-containers,
  inspect-one-container, socket risk detection, resolved-detail exposure) —
  owned by the backend architecture track.
- Mobile native SSH transport.
- Auto-connect of container profiles at launch (follows the base doc's lazy-
  connect rule).
- Per-risk checkboxes (one Accept risks & continue button for all).
- Redesigning the profile model, risk fingerprinting, or connection state
  machine — these are implemented and settled.
- Changes to `docs/DESIGN.md` or `docs/DECISIONS.md` — container backend
  decisions were already added to both by commit `skwtwosy`.

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

Use the mock preview and the deterministic dev provider to inspect desktop,
phone, light, dark, ready, reconnecting, waiting, and failure states. Check
browser console errors. Review the final diff with `jj diff --git`, run the
repository `quality-review` skill, fix all critical/high findings, and commit
with an imperative subject no longer than 72 characters.

Mockups in `docs/mockups/container-setup/` approximate the theme with inline
CSS; `docs/ui-conventions.md` and `client/src/app.css` are authoritative, the
mockups are not pixel specs.
