# Deploying pilot to the Mac Mini ("remote-pilot")

Push `main` → it's live on the Mac Mini within ~60s, and the service self-restarts on
crash or (headless) reboot. Pilot runs as one loopback-bound process, reached over your
tailnet via `tailscale serve` (which terminates TLS). No public exposure.

```
  laptop: jj git push ─▶ tangled.org ─(git fetch ~60s)─▶ com.pilot.deploy (poller)
                                                              │ build + smoke + flip
  phone/laptop ─tailnet(TLS)─▶ tailscale serve ─▶ 127.0.0.1:8787 ◀── com.pilot.server
```

## How it works

- **Blue-green slots.** `~/pilot-blue` and `~/pilot-green` are git clones; `~/pilot-live`
  is a symlink to whichever is active. Each deploy builds + smoke-tests the *inactive*
  slot and only flips the symlink if smoke passes — a bad build never touches the
  running slot. The post-flip `/health` check rolls back automatically if the new slot
  won't come up.
- **Two system LaunchDaemons** (in `/Library/LaunchDaemons`, running as your user via
  `UserName`): `com.pilot.server` (`KeepAlive`) and `com.pilot.deploy` (`StartInterval`
  60). Daemons, not per-user LaunchAgents, so both start at boot with **nobody logged
  in** — the Mini runs and reboots headlessly.
- **Sudo-free deploys.** Because the server runs as *your* user, the poller restarts it
  with a plain `kill` (pid recorded by `run.sh`) and `KeepAlive` respawns it from the
  flipped slot. Only the one-time install and rare plist edits need sudo.
- **Secrets** live in `~/.local/state/pilot/pilot.env` (chmod 600), outside both slots,
  alongside pilot's existing VAPID key. `run.sh` sources it. Nothing secret is committed.

## One-time setup on the Mac Mini

```bash
# 0. SSH: a passphraseless deploy key authorized on tangled.org, wired in ~/.ssh/config
#    for the tangled host. A boot-time daemon has no ssh-agent/keychain, so the key
#    must be usable non-interactively. Confirm:  GIT_SSH_COMMAND='ssh -o BatchMode=yes' \
#      git -C ~/src/pilot fetch origin main

# 1. Create the slots + symlink and build blue (run as you, from any pilot checkout):
scripts/deploy-ctl.sh setup-live

# 2. Secrets file:
mkdir -p ~/.local/state/pilot
cat > ~/.local/state/pilot/pilot.env <<'EOF'
PILOT_TOKEN=__paste_openssl_rand_hex_16__
PILOT_VAPID_SUBJECT=https://<mac-mini>.<tailnet>.ts.net
# ANTHROPIC_API_KEY=...        # any creds pi needs at runtime (no login keychain in a daemon)
# PILOT_VERIFY_SIGNATURES=true # opt in to commit-signature checks (see scripts/allowed-signers)
EOF
chmod 600 ~/.local/state/pilot/pilot.env
openssl rand -hex 16   # paste into PILOT_TOKEN above

# 3. Install both daemons (asks for sudo for the launchctl/cp bits only — do NOT run
#    the whole command under sudo):
scripts/deploy-ctl.sh install

# 4. Expose over the tailnet (proxies WebSocket upgrades, so /ws works):
tailscale serve --bg 8787
tailscale serve status
```

## Day-to-day

```bash
# Just push. The poller picks it up within ~60s.
jj bookmark set main -r @- && jj git push

# Want it now instead of waiting for the timer (run from your laptop):
PILOT_DEPLOY_HOST=<mac-mini>.<tailnet>.ts.net bun run deploy:now
```

## Connect from a device

Open once with the token; it's saved to localStorage and scrubbed from the URL:
```
https://<mac-mini>.<tailnet>.ts.net/?token=<your-token>
```
Then "Add to Home Screen" to install the PWA. Subsequent visits need no token.

## Operations (`scripts/deploy-ctl.sh …`, run as you)

| Command      | What it does                                               |
|--------------|------------------------------------------------------------|
| `status`     | daemons loaded? `/health` up? live slot + recent deploys   |
| `logs`       | tail server (`pilot.{out,err}.log`) + `pilot-deploy.log`   |
| `restart`    | kill the server so `KeepAlive` respawns it (no sudo)       |
| `reinstall`  | re-render + re-bootstrap after editing a **plist** (sudo)  |
| `uninstall`  | bootout + remove both daemons (sudo)                       |
| `render <server\|deploy>` | print a rendered plist (debug)                |

Deploy event log (machine-readable): `~/Library/Logs/pilot-deploy-events.jsonl`.
Force a redeploy of current `origin/main`: `~/pilot-live/scripts/auto-deploy.sh --force`.

## Known costs

- A deploy restarts the process → it drops live WS connections + in-memory warm pi
  sessions; an in-flight turn can be interrupted. The reconnecting client recovers and
  pi persists sessions to disk, but a mid-stream turn is the real cost. (No graceful
  drain yet.)
- The smoke test runs the **mock** driver, so a real-driver-only failure slips past it;
  the post-flip `/health` gate + auto-rollback is the backstop.

## Security notes (see also docs/OPEN-QUESTIONS.md)

- Tailscale is the network boundary (only your tailnet devices reach the box); the
  token is defense-in-depth on top of that.
- `PILOT_HOST` defaults to `127.0.0.1` — not `0.0.0.0`. Only bind `0.0.0.0` for bare-LAN
  use without Tailscale.
- `/debug/*` requires `?token=` when a token is set; `PILOT_DEBUG=0` disables it.
- pi runs with your user's permissions — sandboxing/approval posture is OQ3/OQ4.
