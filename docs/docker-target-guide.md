# Docker Target Guide

Pantoken can connect through an SSH-accessible development server to an
already-running Docker container, provision the Pantoken remote runtime and
polytoken daemon inside that container, and present the container as its own
top-level Pantoken Computer.

## How it works

```
Desktop app (macOS)
  │
  │ SSH (BatchMode, no TTY)
  ▼
Dev server (SSH host)
  │
  │ docker exec -i --user <user> <pinned-id> ...
  ▼
Docker container (Linux x86_64)
  ├── pantoken-server (remote runtime, stdio-proxy mode)
  ├── polytoken daemon (managed or existing)
  └── Pantoken data (releases, XDG, sessions, logs)
```

Pantoken's SSH connection to the server is separate from execution inside the
container. The SSH host is the transport and Docker discovery layer; all
provisioning, runtime, and polytoken daemon processes run inside the container.

## Prerequisites

### SSH access

- A working SSH destination (user@host or SSH config alias) reachable with
  `BatchMode=yes` (key-based auth, pre-accepted host keys).
- The SSH account must have permission to run `docker` commands on the host.

> **Security note:** an SSH user allowed to control Docker may effectively
> control the host. Docker access is a privileged host boundary. Container
> root, a mounted Docker socket, and broad bind mounts can weaken isolation.
> Pantoken does not manage Docker credentials or socket configuration.

### Container requirements

- The container must be **already running**. Pantoken does not create, start,
  stop, restart, rebuild, pull, or delete containers.
- A POSIX `sh` must be available in the container.
- Required tools (probed inside the container during preflight):
  - `cat` (or equivalent for file writing)
  - `mkdir`, `chmod`, `mv`
  - Checksum/archive support as selected by the probe
- **Supported target:** Linux x86_64 with glibc
  (`x86_64-unknown-linux-gnu`). Musl and Linux arm64 are **not supported**
  until matching artifacts are built and validated.

## Setting up a Docker target

1. In Pantoken's Computers settings, create a new remote profile.
2. Enter the SSH destination and port as you would for a normal SSH remote.
3. Select **Docker container** as the execution environment.
4. Enter the **exact container name** (not a substring — Docker's `--filter
   name=` uses substring matching, but Pantoken requires exact equality).
5. Enter the **container user** — a username or numeric `uid[:gid]`. This is
   verified in-container during preflight; there is no silent fallback.
6. Optionally enter a working directory and Pantoken root override (both must
   be absolute paths — `~` expansion is ambiguous across `docker exec`).

### Container user and permissions

The selected user is verified in-container for effective UID/GID, home
directory, and write access to the Pantoken root and workspace. The container's
`Config.User` is informational only — Pantoken probes the actual effective
identity rather than trusting it.

If the effective UID is 0 (root), Pantoken shows a specific warning and
requires explicit acknowledgement before proceeding. The acknowledgement is
fingerprinted to the resolved container ID and effective identity; if either
changes, re-acknowledgement is required.

## Persistent vs ephemeral storage

Pantoken classifies the storage backing the in-container Pantoken root:

| Mount type | Classification | Data survives recreation? |
|---|---|---|
| Writable bind mount | Persistent | Yes (if the host path is retained) |
| Named volume | Persistent | Yes (if the volume is retained) |
| tmpfs | Ephemeral | No |
| No covering mount (writable layer) | Ephemeral | No — `docker rm`/rebuild loses data |

### What this means

- **`docker stop` + `docker start`** normally retains the writable layer, so
  Pantoken data survives a stop/start cycle.
- **`docker rm` + `docker create`** (or rebuild, or `docker-compose up --force-recreate`)
  creates a new writable layer and loses any data that was not on a bind mount
  or named volume.

If the storage is ephemeral, Pantoken shows a warning explaining the risk and
requires explicit acknowledgement. The acknowledgement is fingerprinted to the
container ID, root path, persistence classification, and mount backing; if any
of these change, re-acknowledgement is required.

### Recommended setup

For persistent data, use a bind mount or named volume at the Pantoken root:

```bash
docker run -d \
  --name work-api \
  -v pantoken-data:/var/lib/pantoken \
  your-image
```

Then set the in-container Pantoken root to `/var/lib/pantoken` in the profile.

## Connection phases

When connecting to a Docker target, Pantoken progresses through these phases:

1. **Testing SSH** — verifies the SSH connection to the dev server.
2. **Checking Docker access** — verifies `docker` CLI is available and the SSH
   account can query it.
3. **Locating container** — enumerates containers and resolves the exact name.
4. **Inspecting identity** — captures the full container ID, running state,
   image, and mounts.
5. **Checking user/permissions** — probes effective UID/GID, home, workdir,
   and write access.
6. **Checking persistence** — classifies mount coverage and persistence.
7. **Awaiting acknowledgement** — if root or ephemeral risks are pending,
   waits for explicit user acknowledgement.
8. **Probing target** — runs the OS/architecture/libc/tools probe inside the
   container.
9. **Provisioning** — installs or reuses the Pantoken helper and polytoken.
10. **Starting** — launches the framed stdio proxy via `ssh → docker exec`.
11. **Ready** — connected and operational.
12. **Reconnecting** — on proxy drop, revalidates container identity before
    spawning a fresh exec.

## Failure modes

| Failure | Cause | Action |
|---|---|---|
| Docker unavailable | `docker` CLI missing or permission denied | Install Docker or fix SSH account permissions |
| Container not found | No exact name match | Check the container name spelling |
| Container stopped | Container exists but is not running | Start the container externally |
| Container replaced | Name resolves to a different ID | Update the profile or acknowledge the new container |
| Ambiguous container | Multiple exact name matches | Use a unique container name |
| User missing | The requested user does not exist in the container | Fix the user in the profile |
| Root not acknowledged | Effective UID is 0 and no valid acknowledgement | Acknowledge the root execution warning |
| Root/workspace unwritable | Write probe failed | Fix directory permissions in the container |
| Read-only mount | The covering mount is read-only | Use a writable mount |
| Unsupported target | Musl, Linux arm64, or other unsupported OS/arch/libc | Use a supported Linux x86_64 glibc image |
| Missing tools | Required shell/tools not found in container | Install them in the image |
| Provisioning failure | Checksum mismatch, interrupted install, etc. | See troubleshooting below |
| SSH failure | Auth, host-key, or network issues | Fix SSH configuration |

## Reconnect behavior

When the SSH proxy drops (network issue, SSH timeout, etc.), Pantoken:

1. Revalidates the container's name→ID mapping and running state.
2. If the container is still running with the same ID, spawns a fresh
   `docker exec` and reconnects with the existing resume token.
3. If the container was replaced or stopped, returns to the preflight/error
   state rather than silently attaching to a different container.

Processes launched by `docker exec` die when the container stops and are not
restarted automatically. Mounted state supports recovery after restart, but
Pantoken cannot guarantee in-flight turn survival across container lifecycle
events.

## Troubleshooting

### Provisioning failures

- **Checksum mismatch:** the downloaded artifact's SHA-256 does not match the
  embedded manifest. This indicates a corrupted download or a manifest/asset
  version mismatch. The previous working installation is preserved.
- **Interrupted install:** if provisioning is interrupted, no executable lands
  at the final path until verification succeeds. Reconnecting retries cleanly.
- **Unsupported target:** if the probe detects musl or an unsupported
  architecture, provisioning fails with a specific message. Use a supported
  glibc-based image.

### Container identity issues

- If a container is deleted and recreated with the same name, Pantoken detects
  the changed container ID and requires re-acknowledgement of any risk
  warnings.
- If a container stops between Pantoken's final inspection and the
  `docker exec` spawn, the error is classified as "container stopped" (not
  "Docker unavailable") and Pantoken returns to the reconnect/preflight loop.

## Cleanup and uninstall

To remove Pantoken's footprint from a container:

1. Delete the in-container Pantoken root directory (configured in the profile,
   e.g. `/var/lib/pantoken`). This removes:
   - Downloaded Pantoken helper releases
   - Managed polytoken binaries (if installed by Pantoken)
   - Isolated XDG data, config, and cache
   - Session state and logs
2. Delete the Pantoken profile from the Computers settings.

Pantoken does not modify the container image, Docker configuration, or any
host-side files beyond the SSH connection.

## Pantoken does not manage container lifecycle

Pantoken is a guest inside your container. It does not:

- Create, start, stop, restart, rebuild, pull, or delete containers
- Modify Docker configuration or Compose files
- Install or configure Docker Engine
- Forward or publish container ports

All container lifecycle management is owned by you or your orchestrator
(Compose, devcontainer, k8s, etc.).
