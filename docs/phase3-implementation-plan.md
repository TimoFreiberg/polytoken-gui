# Phase 3 — Remote provisioning and polytoken compatibility/install

## Context

Phases 0–2 are implemented. The transport-neutral wire layer, framed stdio
codec, persistent remote runtime, lifecycle manager, desktop bridge (real WS
upgrade + reconnect backoff + exit classification), persisted remote profiles,
and the connection state machine all exist and are wired into the desktop.

Phase 3 adds the **provisioning logic**: probing the remote host, checking
polytoken compatibility, optionally installing polytoken, configuring the XDG
isolation boundary, and making provisioning idempotent. It drives the existing
`ConnectionState::Provisioning` state that Phase 2 defined but left
unreachable.

### Scope decisions (resolved)

- **Phase 2 is done.** The bridge, state machine, and profile model exist in
  the codebase. Phase 3 builds on them; it does not re-implement them.
- **Pantoken artifact transfer is deferred.** No release pipeline produces
  cross-compiled `pantoken-server` binaries. The remote runtime's
  `connect_with_bootstrap` already uses `std::env::current_exe()` — it assumes
  the binary is already on the remote host. Phase 3 keeps this assumption.
  Steps 19–20 (resolve/verify/upload Pantoken artifacts) are out of scope.
- **Polytoken install channel is derived from `POLYTOKEN_DAEMON_TARGET_VERSION`.**
  If the target version has a prerelease tag (e.g. `0.5.0-unstable.9`), the
  installer uses the unstable channel; otherwise it uses stable. No extra
  profile field.
- **Start-token identity checks remain deferred.** The lifecycle manager does
  not kill polytoken daemon PIDs — it calls `dispose_idle_warm` (tears down
  SSE, preserves durable state) and signals the hub to exit. Start-tokens are
  needed only when per-session daemon PID management is wired, which is not
  part of any Phase 3 step.

### What exists (built on)

| Component | Location | Phase 3 uses it for |
|---|---|---|
| Remote layout | `server-rs/.../remote/layout.rs` | Path derivation for polytoken install |
| Release manifest types | `server-rs/.../remote/manifest.rs` | (Not used — artifact transfer deferred) |
| Remote runtime + proxy | `server-rs/.../remote/runtime.rs` | `PANTOKEN_POLYTOKEN_BIN` env threading |
| Lifecycle manager | `server-rs/.../remote/lifecycle.rs` | (Unchanged — no start-token) |
| `POLYTOKEN_DAEMON_TARGET_VERSION` | `pantoken-daemon-types/src/lib.rs` | Compatibility floor constant |
| Bridge + `SshTransport` trait | `desktop/src/bridge.rs` | Running remote commands via SSH |
| `RemoteProfile` + `PolytokenPolicy` | `desktop/src/remote_profile.rs` | `OfferInstall` policy gate |
| Connection state machine | `desktop/src/remote_connection.rs` | Driving `Provisioning` state |
| `FakeSshTransport` | `desktop/src/bridge/fake.rs` | Test seam for provisioning |

### Polytoken download URLs (verified)

```
Stable:   https://dl.polytoken.dev/<version>/{linux,macos}-{amd64,arm64}/polytoken.{tar.gz,zip}
Unstable: https://dl.polytoken.dev/unstable/<version>/{linux,macos}-{amd64,arm64}/polytoken.{tar.gz,zip}
Checksums: https://dl.polytoken.dev/[unstable/]<version>/SHA256SUMS.{linux,macos}
```

The checksum file is a standard `SHA256SUMS` format: `<64-hex>  <filename>`
lines. No signature files exist — provenance is checksum-only.

---

## Steps

### Step 1 — Remote probe

Implement a dependency-light remote probe executed through SSH. It reports:
OS, architecture, bitness, libc/runtime info, home directory, writable +
executable locations, available tools (`mkdir`, `chmod`, `mv`, `sha256sum`/
`shasum`, archive extraction tools), and the result of `polytoken --version`.

**Design:**

- The probe is a single SSH command that emits one structured JSON record on
  the last line of stdout. Parse the last line, not arbitrary login-shell
  output.
- Use a controlled non-interactive invocation: `ssh -T <dest> '<probe-script>'`.
  The probe script is a POSIX-sh heredoc that avoids sourcing startup files.
- The probe script collects:
  - `uname -s` → OS (`linux` / `darwin`)
  - `uname -m` → arch (`x86_64` / `aarch64` / `arm64`)
  - `getconf LONG_BIT` → bitness
  - `ldd --version` or `/lib/ld-musl*` → libc (glibc / musl / darwin)
  - `$HOME` → home directory
  - `mktemp -d` + test write → writable temp
  - `command -v mkdir chmod mv tar unzip sha256sum shasum` → tool availability
  - `polytoken --version` (from PATH + any previously recorded path) → version
  - Emit a single JSON line: `{"os":"linux","arch":"x86_64",...,"polytokenVersion":"0.5.0-unstable.9"}`
- **Target normalization:** map probe output to a Rust target triple:
  - `linux` + `x86_64` → `x86_64-unknown-linux-gnu`
  - `linux` + `aarch64` → `aarch64-unknown-linux-gnu`
  - `darwin` + `x86_64` → `x86_64-apple-darwin`
  - `darwin` + `aarch64`/`arm64` → `aarch64-apple-darwin`
  - Anything else → `UnsupportedTarget` error (fail before transfer).
- **Shell noise handling:** if the last line isn't valid JSON, return a
  `ProbeParseError` with the raw tail so the UI can tell the user shell
  initialization is likely the cause.

**Location:** `desktop/src/provisioning/probe.rs` (new module). The probe
runs SSH commands via the existing `SshTransport` trait — add a `run_command`
method to `SshTransport` that captures stdout/stderr/exit-code for a single
command (distinct from `spawn_proxy` which starts a streaming relay).

**Named validations:**
- `probe_parses_structured_json` — valid probe output → `ProbeResult`
- `probe_rejects_shell_noise` — garbage before the JSON line is ignored;
  last-line-is-JSON wins
- `probe_normalizes_target_triples` — `linux/x86_64` → `x86_64-unknown-linux-gnu`, etc.
- `probe_rejects_unsupported_target` — e.g. `freebsd/amd64` → `UnsupportedTarget`
- `probe_reports_missing_polytoken` — no `polytoken` on PATH →
  `polytoken_version: None`

### Step 2 — Polytoken compatibility check

Probe polytoken independently from the helper. Search the configured remote
PATH and any previously recorded path (from `install.json` metadata), run
`polytoken --version`, parse stable and prerelease semver, and compare against
`POLYTOKEN_DAEMON_TARGET_VERSION`.

**Policy:**

| Remote version | State | Action |
|---|---|---|
| Missing | `PolytokenMissing` | Show "Polytoken is required" + install action (if profile allows `OfferInstall`) |
| Lower than target | `PolytokenTooOld { found, target }` | Warn/block; offer install/upgrade |
| Equal or newer | `PolytokenCompatible { found, target, newer_than_target }` | Accept; record observed version |
| Unparseable / command failure | `PolytokenUnparseable { raw }` | Actionable compatibility failure |

**Semver comparison:** implement prerelease-aware comparison (prerelease <
release; `0.5.0-unstable.9` < `0.5.0`). The manifest module already has
`parse_semver`; extend it with a `compare_semver` function or add a small
`semver` module. Do not pull in the `semver` crate — the comparison is
straightforward and avoids a workspace dependency.

**Newer-than-target notice:** if `found > target`, record it but still accept.
The live corpus tests remain the true compatibility gate; a newer version may
still change behavior.

**Location:** `desktop/src/provisioning/polytoken_compat.rs` (new module).

**Named validations:**
- `polytoken_compatibility_matrix` — table test: missing / too-old / equal /
  newer / unparseable → correct `PolytokenCompat` state
- `semver_comparison_handles_prerelease` — `0.5.0-unstable.9` < `0.5.0` <
  `0.5.1`; `0.5.0-unstable.9` < `0.5.0-unstable.10`
- `polytoken_compat_records_observed_version` — compatible case stores the
  found version for `install.json`

### Step 3 — Polytoken installer

Add the optional polytoken installer using the official artifact matrix
(`linux`/`macos` × `amd64`/`arm64`, `tar.gz` or `zip`) and checksum manifest
at the documented release URL.

**Flow:**

1. **Resolve channel + version.** Derive from `POLYTOKEN_DAEMON_TARGET_VERSION`:
   if it has a prerelease tag, use the unstable channel URL prefix
   (`https://dl.polytoken.dev/unstable/<version>/...`); otherwise use stable
   (`https://dl.polytoken.dev/<version>/...`). Install the exact target
   version, not "latest in channel" — most deterministic.
2. **Download locally** (on the device running Pantoken, not the remote).
   Fetch the archive for the probed target. Prefer `.tar.gz` on Linux,
   `.zip` on macOS (matching the platform's native tools).
3. **Verify SHA256.** Fetch the platform's `SHA256SUMS.{linux,macos}` file,
   find the line matching the downloaded filename, compare digests. Reject on
   mismatch. Label trust level as checksum-only (no signature).
4. **Upload over SSH.** Transfer the verified archive to the remote via SSH
   stdin (`ssh -T <dest> 'cat > <tmp>'`) or SFTP. Remote outbound HTTPS is
   not required.
5. **Extract on remote.** Run `tar xzf` or `unzip` into a staging directory
   under `~/.local/share/pantoken/tools/polytoken/<version>/<target>/`.
6. **Atomic install.** Verify the extracted binary's executable bit, then
   atomic-rename the staging directory into the final path
   (`layout::polytoken_binary(root, version, target)`). Never replace a
   currently working version in place.
7. **Write provenance metadata.** Record the version, target, source URL,
   SHA256, install timestamp, and channel in `install.json` (or a per-tool
   metadata file under the install directory).

**Archive format selection:** the polytoken archive contains a single
`polytoken` binary at the root. Extract to staging, verify, rename.

**Rollback:** retain at least one previous polytoken version. Garbage-collect
only unreferenced versions (not the currently-configured or
last-known-good).

**Location:** `desktop/src/provisioning/polytoken_install.rs` (new module).
HTTP download uses `reqwest` (already a dependency in the workspace for the
polytoken driver). SSH upload uses the `SshTransport::run_command` seam from
step 1.

**Named validations:**
- `polytoken_install_artifact_matrix` — for each
  `{linux,macos}×{amd64,arm64}`, the correct URL + checksum file is resolved
- `polytoken_checksum_failure_is_atomic` — a bad SHA256 leaves no binary at
  the final path; the staging dir is cleaned up
- `polytoken_install_preserves_previous_version` — installing a new version
  doesn't delete the old one; both coexist under `tools/polytoken/`
- `polytoken_install_records_provenance` — `install.json` contains version,
  target, sha256, source URL, channel, timestamp

### Step 4 — XDG isolation + runtime configuration

Configure the remote Pantoken runtime to use the selected existing or
downloaded polytoken path without overwriting the user's PATH or global
polytoken installation.

**Two modes:**

1. **Pantoken-managed** (downloaded/installed under the remote root):
   - Isolated `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` roots
     below the remote Pantoken root are **mandatory**:
     - `~/.local/share/pantoken/tools/polytoken/xdg/config`
     - `~/.local/share/pantoken/tools/polytoken/xdg/data`
     - `~/.local/share/pantoken/tools/polytoken/xdg/cache`
   - Pass these as env vars when the proxy starts the persistent server.
   - The polytoken binary path is passed as `PANTOKEN_POLYTOKEN_BIN`.
2. **User-provided/existing** (found on PATH or at a recorded path):
   - Sharing the user's existing polytoken XDG roots requires **explicit
     user-facing confirmation** and a persisted profile choice.
   - If the user confirms sharing: do not set XDG override env vars; polytoken
     uses its default roots (the user's `~/.config`, `~/.local/share`, etc.).
   - If the user does not confirm: fall back to isolated roots (same as
     Pantoken-managed), pointing at the user-provided binary.
   - Pantoken must **never silently redirect** an existing installation or
     silently share production state.

**Persistence:** the resolved binary path + XDG mode (isolated vs. shared) is
persisted in `install.json` (or a dedicated `runtime.json` under `run/`).
The proxy reads this when bootstrapping the runtime.

**Wiring:** `connect_with_bootstrap` in `runtime.rs` already threads
`PANTOKEN_POLYTOKEN_BIN` through to the spawned runtime. Extend it to also
thread the XDG env vars when the polytoken is Pantoken-managed.

**Location:**
- XDG path derivation: `server-rs/.../remote/layout.rs` (add
  `polytoken_xdg_config`, `polytoken_xdg_data`, `polytoken_xdg_cache`).
- Runtime config: `server-rs/.../remote/runtime.rs` (extend
  `connect_with_bootstrap` to read resolved config + set XDG env vars).
- Profile choice: `desktop/src/remote_profile.rs` (add
  `xdg_mode: XdgMode` field, default `Isolated`).

**Named validations:**
- `xdg_isolation_pantoken_managed_sets_override_roots` — managed mode sets
  all three XDG vars to paths under the remote root
- `xdg_isolation_user_provided_default_is_isolated` — user-provided without
  explicit confirmation defaults to isolated roots
- `xdg_isolation_user_provided_confirmed_shares_existing` — confirmed sharing
  does not set XDG override vars
- `xdg_paths_stay_under_remote_root` — all derived XDG paths are under the
  remote root (path-safety, same as existing `sanitize_or_err` checks)
- `runtime_config_persists_resolved_binary_path` — `install.json` /
  `runtime.json` round-trips the resolved path + XDG mode

### Step 5 — Idempotent provisioning reconciliation

Reconnecting to an already-provisioned host should only run lightweight probes
and version checks. Interrupted uploads/installations must leave no executable
at the final path until verification succeeds. Failed upgrades must preserve
the last-known-good helper and polytoken binary.

**Reconciliation logic:**

1. **Probe** (step 1) — always runs; cheap.
2. **Check polytoken compat** (step 2) — always runs; cheap.
3. **Check install state** — read `install.json` / `runtime.json`:
   - If a compatible polytoken is recorded and the binary exists at the
     recorded path → skip install, proceed to connect.
   - If the recorded binary is missing but a compatible one exists elsewhere
     → update the recorded path, proceed.
   - If no compatible polytoken is recorded → offer install (if profile allows)
     or fail with `PolytokenMissing`.
4. **Interrupted install recovery:**
   - Staging directories (`tools/polytoken/<version>/<target>/.staging-*`)
     are cleaned up at the start of reconciliation.
   - No binary appears at the final path until the atomic rename (step 3.6)
     succeeds.
   - If a previous install left a `.staging-*` dir, remove it before probing.
5. **Failed upgrade preservation:**
   - The current version's directory is never modified in place.
   - A new version installs to a new directory; the old one is retained.
   - Garbage collection removes only unreferenced versions (not the
     currently-configured or last-known-good).

**Location:** `desktop/src/provisioning/reconcile.rs` (new module). Orchestrates
steps 1–4. Drives the `ConnectionState::Provisioning` state via the existing
`ConnectionStateSink` trait.

**Named validations:**
- `reconcile_skips_install_when_compatible_exists` — already-provisioned host
  → no install, straight to connect
- `reconcile_cleans_stale_staging_dirs` — leftover `.staging-*` dirs are
  removed before probing
- `reconcile_preserves_last_known_good_on_failure` — a failed install leaves
  the existing binary intact
- `reconcile_offers_install_when_missing_and_policy_allows` —
  `OfferInstall` + missing polytoken → install proceeds
- `reconcile_fails_when_missing_and_policy_requires_existing` —
  `RequireExisting` + missing polytoken → `PolytokenMissing` failure state

### Step 6 — Wire provisioning into the connection state machine

Drive the existing `ConnectionState::Provisioning` state from the desktop's
`connect_to_remote` flow. When the profile's policy is `OfferInstall` (or
when the probe discovers a missing/incompatible polytoken), the connection
enters `Provisioning` before `Starting`.

**Flow:**

```
TestingSsh → Connecting → [probe + compat check]
  → if compatible: Starting → Ready
  → if needs provisioning + policy allows: Provisioning → Starting → Ready
  → if needs provisioning + policy requires existing: Failed(ProvisioningFailed)
  → if provisioning fails: Failed(ProvisioningFailed)
```

**State sink:** the provisioning orchestrator calls
`ConnectionStateSink::on_state(Provisioning)` when it starts, and
`on_state(Starting)` or `on_state(Failed { kind: ProvisioningFailed, .. })`
when it finishes.

**UI:** the existing overlay already renders `Provisioning…` and
`Provisioning failed` labels (defined in Phase 2). No new UI work needed —
just drive the states.

**Location:** `desktop/src/remote_commands.rs` (extend `connect_to_remote` to
run the provisioning reconciliation between SSH connect and bridge start).

**Named validations:**
- `provisioning_drives_state_machine` — `Connecting → Provisioning → Starting`
  is reachable when provisioning runs
- `provisioning_failure_drives_failed_state` — a provisioning error produces
  `Failed { kind: ProvisioningFailed }`
- `provisioning_skipped_when_compatible` — compatible polytoken → no
  `Provisioning` state, straight to `Starting`

### Step 7 — Provisioning test harness (minimal)

Build a minimal fake-SSH provisioning harness so the provisioning logic can be
tested deterministically without a real SSH process. This is a subset of the
full Phase 4 harness — enough to test steps 1–6.

**Components:**

- **`FakeSshSession`**: extends the existing `FakeSshTransport` with a
  `run_command` implementation that returns canned probe responses, file
  transfer sinks, and command execution results. Configurable per-scenario.
- **`FakeRemoteFs`**: an in-memory model of the remote filesystem. Tracks
  files written via SSH stdin, directories created, binary paths, and
  `install.json` contents. Supports `sha256sum` simulation.
- **Scenario presets:**
  - `healthy` — compatible polytoken on PATH
  - `missing_polytoken` — no polytoken, install succeeds
  - `missing_polytoken_declined` — no polytoken, `RequireExisting` policy
  - `too_old_polytoken` — `0.4.2` on PATH, target is `0.5.0-unstable.9`
  - `unsupported_target` — `freebsd/amd64`
  - `checksum_mismatch` — download succeeds, SHA256 doesn't match
  - `interrupted_install` — staging dir left from a previous run
  - `already_provisioned` — compatible polytoken at recorded path

**Location:** `desktop/src/provisioning/fake.rs` (new module). Uses the
existing `FakeSshTransport` from `desktop/src/bridge/fake.rs` as a base.

**Named validations:**
- `fake_ssh_harness_drives_probe` — probe returns canned `ProbeResult`
- `fake_ssh_harness_drives_install` — install writes binary to fake FS,
  verifies checksum, atomic-renames
- `fake_ssh_harness_injects_checksum_failure` — mismatch → no binary at
  final path
- `fake_ssh_harness_persists_install_state` — `install.json` round-trips
  through the fake FS

---

## Acceptance criteria

| AC | Status | Named validation |
|---|---|---|
| AC.4 — Seamless provisioning (partial) | ⚠️ | `provision_clean_host_e2e` — polytoken install only; Pantoken artifact transfer deferred |
| AC.7 — Polytoken policy | ✅ | `polytoken_compatibility_matrix` |
| AC.8 — Optional polytoken installation | ✅ | `polytoken_install_artifact_matrix`, `polytoken_checksum_failure_is_atomic` |
| AC.10 — Lightweight cleanup | ⚠️ unchanged | No start-token (deferred); lifecycle manager unchanged |
| AC.12 — Regression safety | standing | `bun test`, `bun run check`, `bun run check:rs`, `bun run test:e2e`, desktop checks |

**AC.4 caveat:** "Seamless Pantoken provisioning" is partially met — the
polytoken install + compat + XDG isolation + reconciliation flow works
end-to-end, but the Pantoken helper binary transfer is deferred (no release
pipeline). The remote runtime assumes `pantoken-server` is already on the
remote host.

---

## Out of scope (deferred to later work)

- **Pantoken artifact transfer** (original steps 19–20): no release pipeline
  exists. The remote runtime uses `current_exe()` to spawn the server.
- **Start-token identity checks** (carried over from Phase 1 step 9): the
  lifecycle manager doesn't kill daemon PIDs. Deferred until per-session
  daemon PID management is wired.
- **Full fake-SSH/remote-filesystem harness** (Phase 4 step 25): Phase 3
  builds a minimal subset sufficient for provisioning tests. The full harness
  (failure injection for transfer/extraction/startup/concurrent-startup,
  persistent fake runtime state) is Phase 4.
- **Mobile native SSH transport** (Phase 2 step 16): the `MobileSshTransport`
  stub exists. Mobile provisioning uses the same logical state model but may
  use a native SSH library. Separately sequenced.
- **Connection-state UX with phase-specific progress sub-labels** (Phase 2
  step 15): the overlay renders `Provisioning…` / `Provisioning failed`.
  Fine-grained sub-phase labels ("downloading", "verifying", "installing")
  are a UI polish follow-up.

---

## File touch points

**New files:**
- `desktop/src/provisioning/mod.rs` — module root
- `desktop/src/provisioning/probe.rs` — step 1
- `desktop/src/provisioning/polytoken_compat.rs` — step 2
- `desktop/src/provisioning/polytoken_install.rs` — step 3
- `desktop/src/provisioning/reconcile.rs` — step 5
- `desktop/src/provisioning/fake.rs` — step 7

**Modified files:**
- `desktop/src/bridge.rs` — add `run_command` to `SshTransport` trait
- `desktop/src/bridge/fake.rs` — implement `run_command` for `FakeSshTransport`
- `desktop/src/remote_profile.rs` — add `xdg_mode: XdgMode` field
- `desktop/src/remote_connection.rs` — wire `Provisioning` state transitions
- `desktop/src/remote_commands.rs` — extend `connect_to_remote` with provisioning
- `desktop/src/main.rs` — register provisioning module
- `server-rs/pantoken-server/src/remote/layout.rs` — add XDG path derivation
- `server-rs/pantoken-server/src/remote/runtime.rs` — thread XDG env vars
- `server-rs/pantoken-server/src/remote/manifest.rs` — add `compare_semver` (or new `semver` module)

**Documentation:**
- `docs/DESIGN.md` — remote provisioning architecture
- `docs/DECISIONS.md` — XDG isolation decision, channel derivation decision
- User-facing remote connection guide (SSH prerequisites, polytoken install
  flow, default root, troubleshooting)

---

## Post-implementation: update the master plan

When Phase 3 is complete, update `docs/remote-deployment-plan.md` to reflect
the new current state:

- Mark Phase 3 steps (18, 21–24) with status markers (✅ / ⚠️ as appropriate).
- Note that steps 19–20 (Pantoken artifact transfer) are deferred — no release
  pipeline exists; the remote runtime uses `current_exe()`.
- Note that the start-token carry-over from Phase 1 step 9 remains deferred
  (the lifecycle manager still doesn't kill daemon PIDs).
- Update the acceptance criteria table: AC.7 and AC.8 → ✅; AC.4 → ⚠️ partial
  (polytoken install only, not Pantoken artifact transfer); AC.10 unchanged.
- Update the "Implementation Status" header to reflect that Phases 0–3 are
  implemented (Phase 2 was already done in the codebase despite the plan's
  stale ⬜ markers — correct those too).
- Add any caveats discovered during implementation to the Risks section.
