# Pantoken Mac Mini deployment

The Mini runs the headless Rust `pantoken-server` directly as one system
LaunchDaemon. It does not host a desktop `.app`, a Git checkout, Bun, Cargo, a
source poller, or an automatic release fetcher.

## Runtime layout

```text
~/pantoken-live -> ~/pantoken-versions/<version>/
~/pantoken-versions/<version>/{VERSION,BUILD_SHA,run.sh,update.sh}
~/pantoken-versions/<version>/bin/pantoken-server
~/pantoken-versions/<version>/client-dist/
~/.local/share/pantoken/pantoken.env   # user-owned, mode 0600
~/.local/libexec/pantoken-tar-validate # trusted root-owned validator
```

The rendered `/Library/LaunchDaemons/com.pantoken.server.plist` runs
`~/pantoken-live/run.sh` as the target user with `KeepAlive` and `RunAtLoad`.
It fixes `PANTOKEN_DATA_DIR` to `~/.local/share/pantoken`, binds `127.0.0.1:8787`,
and sets `PANTOKEN_CLIENT_DIST` to the active release. Tailscale Serve remains
unchanged and must proxy `/` to `http://127.0.0.1:8787`.

## One-time bootstrap

Build the checked-in tar validator on the trusted macOS arm64 host. Install it
with the operator-supplied digest; the bootstrap computes the digest itself:

```bash
sudo deploy/bootstrap-tar-validator.sh \
  --binary /path/to/pantoken-tar-validate \
  --sha256 <64-lowercase-hex-digest>
```

Verify production state and set up the new-infra layout using the canonical
preflight script (read-only checks + optional `--setup` to create the
versioned layout + env file + rendered plist without installing the daemon):

```bash
bash deploy/mac-mini-preflight.sh                           # read-only checks
bash deploy/mac-mini-preflight.sh --setup \
  --version <version> --archive /path/to/extracted-payload   # create layout
```

Prepare a signed, validated headless payload, then bootstrap the version as the
runtime user. The bootstrap renders/lints the plist and uses sudo only for the
system plist and launchctl bootstrap:

```bash
bash deploy/bootstrap-headless.sh <version> /path/to/extracted-payload --skip-daemon
# review the rendered plist and env file, then:
bash deploy/bootstrap-headless.sh <version> /path/to/extracted-payload
```

Create `~/.local/share/pantoken/pantoken.env` with only strict unquoted records,
for example:

```text
PANTOKEN_TOKEN=<bearer-token>
PANTOKEN_VAPID_SUBJECT=mailto:you@example.com
PANTOKEN_POLYTOKEN_BIN=/absolute/path/to/polytoken
XDG_CONFIG_HOME=/Users/timo/.config
XDG_DATA_HOME=/Users/timo/.local/share
```

The file must be user-readable only (`0600`). `PANTOKEN_DATA_DIR` is not an
allowed env-file setting; production state is always the fixed path above.
The live driver requires the installed `polytoken` daemon version 0.5.0+ and
its bearer-token credential/config contract. Verify that prerequisite and run a
controlled live-driver interaction before removing any legacy state.

Install the narrowly scoped restart authorization only through the reviewed
privileged bootstrap path. The updater must be able to pass:

```bash
sudo -n -l /bin/launchctl kickstart -k system/com.pantoken.server
```

## Release preparation and updates

Desktop and headless artifacts share signed `vMAJOR.MINOR.PATCH` tags hosted at
`TimoFreiberg/pantoken`.
The headless release is
`pantoken-headless-macos-aarch64.tar.gz` plus its minisign `.sig`.

Updates are manual and signed. Run the updater from the active release:

```bash
~/pantoken-live/update.sh
~/pantoken-live/update.sh v1.2.3   # explicit recovery tag
```

The updater acquires an atomic lock, downloads fixed canonical URLs, verifies
minisign before extraction, validates tar headers with the separately trusted
validator, stages and mock-smokes the payload, atomically flips the live link,
and restarts only through the exact launchd kickstart command. It requires a
fresh process identity/path plus healthy `/health` and HTML. A failure after the
flip restores the prior release, restarts it, and requires health before
returning. It retains the active and previous releases and prunes only older
known version directories after a successful commit. The journal in
`~/.local/share/pantoken/update-journal.jsonl` records transaction and rollback
states.

## Verification and platform gate

Before enabling updates, run the real macOS gate with disposable labels and
retain its evidence:

```bash
bash deploy/launchd-platform-gate.sh --evidence ~/pantoken-launchd-gate
```

It must pass on macOS arm64; fake controllers are not evidence for the launchd
acceptance criteria. After bootstrap, inspect:

```bash
launchctl print system/com.pantoken.server
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/
readlink ~/pantoken-live
```

Capture read-only Tailscale Serve status before and after cutover and abort
without mutation if `/` is not exactly proxied to `127.0.0.1:8787`. Verify the
real polytoken driver, authenticated WebSocket/session discovery, and one
bounded non-destructive interaction before deleting old production state.

After cutover is verified healthy, use the legacy cleanup inventory to
systematically remove old state:

```bash
# Follow the checklist in:
deploy/legacy-cleanup-inventory.md
```

## Rollback

Use the retained prior version or an explicit known-good tag:

```bash
~/pantoken-live/update.sh v1.2.2
```

Never kill the server by PID and never run the updater as root. If an update or
rollback fails, preserve the journal and both release directories for diagnosis;
repair launchd authorization or restore a known-good tag manually before cleanup.

## App-provisioned Linux container helper artifacts

In addition to the standalone macOS headless deployment above, tagged releases
now publish and validate an `x86_64-unknown-linux-gnu` Pantoken helper artifact.
This artifact is **not** deployed via the launchd/headless update mechanism.
Instead, the desktop app provisions it automatically inside a Docker container
during the connection preflight flow.

The release matrix is exactly two targets:

| Target triple | Archive | Use |
|---|---|---|
| `aarch64-apple-darwin` | `pantoken-headless-macos-aarch64.tar.gz` | Standalone macOS deployment (above) + desktop app provisioning |
| `x86_64-unknown-linux-gnu` | `pantoken-headless-linux-x86_64.tar.gz` | App-provisioned inside Docker containers |

Both artifacts are signed/checksummed. The desktop app embeds their SHA-256
digests in its release manifest and verifies them before execution. Linux arm64,
macOS x86_64, and musl targets are explicitly unsupported — they are not
advertised in the manifest and no artifacts are published for them.

For the user-facing guide to Docker target connections, see
[`docs/docker-target-guide.md`](../docs/docker-target-guide.md).
