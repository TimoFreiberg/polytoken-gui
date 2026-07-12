# Legacy Cleanup Inventory

**IMPORTANT:** Cleanup happens ONLY after all preflight gates pass and the new
service is verified healthy. This is a checklist, not a script — the operator
runs each step manually. Do NOT execute any removal command before verifying
the new `com.pantoken.server` LaunchDaemon is running and healthy.

## Prerequisites

Before starting cleanup, verify:

- [ ] `launchctl print system/com.pantoken.server` shows the service is running
- [ ] `curl -fsS http://127.0.0.1:8787/health` returns `{"ok":true}`
- [ ] `readlink ~/pantoken-live` points to the expected version
- [ ] `tailscale serve status` shows `/` proxying to `http://127.0.0.1:8787`
- [ ] The new service has been running stably for at least 15 minutes

---

## 1. Legacy service definitions

Any old LaunchAgent/LaunchDaemon plists that ran the source-checkout server or
poller — anything matching `*pantoken*` that isn't `com.pantoken.server.plist`.

- [ ] **Check:** `ls ~/Library/LaunchAgents/*pantoken* /Library/LaunchDaemons/*pantoken* /Library/LaunchAgents/*pantoken* 2>/dev/null`
- [ ] **Verify:** each found plist is NOT `com.pantoken.server.plist`
- [ ] **Remove:**
  ```bash
  sudo launchctl bootout system/<old-label> 2>/dev/null || true
  sudo launchctl bootout gui/$(id -u)/<old-label> 2>/dev/null || true
  sudo rm -f /Library/LaunchDaemons/<old-plist>
  rm -f ~/Library/LaunchAgents/<old-plist>
  ```

## 2. Source checkout / poller

The old git checkout that was deployed from (likely `~/src/pantoken` or similar),
and the old source-poller script if one existed.

- [ ] **Check:** `ls -d ~/src/pantoken ~/src/pantoken-* 2>/dev/null`
- [ ] **Check for poller:** `crontab -l 2>/dev/null | grep -i pantoken`; `launchctl list | grep -i poller`
- [ ] **Stop poller:** `launchctl unload ~/Library/LaunchAgents/*poller* 2>/dev/null || true`
- [ ] **Remove poller job:** `rm -f ~/Library/LaunchAgents/*poller*`
- [ ] **Archive (don't delete yet):** `mv ~/src/pantoken ~/src/pantoken.archived.$(date +%Y%m%d)`

## 3. Old process

Any running `pantoken-server` process from the source checkout (different binary
path than `~/pantoken-live/bin/pantoken-server`).

- [ ] **Check:** `ps aux | grep '[p]antoken-server' | grep -v "$(readlink ~/pantoken-live)"`
- [ ] **Verify:** the process path is NOT inside `~/pantoken-versions/`
- [ ] **Remove:** `kill <pid>` (graceful), then `kill -9 <pid>` if needed

## 4. Old data directories

Any `~/.local/state/pantoken` data from the source-checkout era that might
conflict. **Caution:** the new service uses the same data dir — this is about
identifying stale data, not removing the dir.

- [ ] **Check:** `ls -la ~/.local/state/pantoken/`
- [ ] **Inspect:** look for old lock files, stale journals, or data from a previous driver
- [ ] **Remove stale lock:** `rm -f ~/.local/state/pantoken/.update.lock`
- [ ] **Retain:** the journal (`update-journal.jsonl`) for audit purposes

## 5. Old logs

`~/Library/Logs/pantoken/` from the source-checkout era.

- [ ] **Check:** `ls -la ~/Library/Logs/pantoken/ 2>/dev/null`
- [ ] **Verify:** logs are from the old deployment, not the new service
- [ ] **Archive:** `tar czf ~/pantoken-old-logs-$(date +%Y%m%d).tar.gz ~/Library/Logs/pantoken/ && rm -rf ~/Library/Logs/pantoken/old-*`

## 6. Old binaries

Any `pantoken-server` binary in `~/src/pantoken/target/` or installed elsewhere
that isn't `~/pantoken-live/bin/pantoken-server`.

- [ ] **Check:** `find ~/src ~/usr/local/bin /opt/homebrew/bin -name 'pantoken-server' 2>/dev/null`
- [ ] **Verify:** found binary is NOT inside `~/pantoken-versions/`
- [ ] **Remove:** `rm -f <old-binary-path>`

## 7. Tailscale Serve verification

Verify it still routes to `127.0.0.1:8787` (shouldn't need changes, but verify
post-cutover).

- [ ] **Check:** `tailscale serve status`
- [ ] **Verify:** `/` proxies to `http://127.0.0.1:8787`
- [ ] **If broken:** `tailscale serve --bg 8787` (do NOT change if working)

## 8. Cron jobs

Any `crontab -l` entries related to pantoken auto-update or polling.

- [ ] **Check:** `crontab -l 2>/dev/null | grep -i pantoken`
- [ ] **Remove:** `crontab -l | grep -v pantoken | crontab -` (removes only pantoken entries)

## 9. Privileged sudoers fragments

Any `/etc/sudoers.d/*pantoken*` entries that authorized the old deployment's
commands. Verify and remove only the old entries; the new `com.pantoken.server`
kickstart sudoers entry must remain.

- [ ] **Check:** `sudo ls /etc/sudoers.d/*pantoken* 2>/dev/null`
- [ ] **Check current:** `sudo cat /etc/sudoers.d/pantoken 2>/dev/null`
- [ ] **Verify:** the entry for `kickstart -k system/com.pantoken.server` remains
- [ ] **Remove old:** `sudo rm /etc/sudoers.d/<old-pantoken-fragment>`

## 10. Generated plist/config copies

Any rendered plist copies in temp locations, old config files from the
source-checkout era, or stale plist templates that aren't
`deploy/com.pantoken.server.plist`.

- [ ] **Check:** `find /tmp /var/tmp ~/Library -name '*pantoken*.plist' 2>/dev/null`
- [ ] **Verify:** found plists are NOT the canonical `deploy/com.pantoken.server.plist`
- [ ] **Remove:** `rm -f <stale-plist>`

## 11. Updater state, locks, and journals

`~/.local/state/pantoken/.update.lock` (stale lock from a crashed update) and
`~/.local/state/pantoken/update-journal.jsonl` (old transaction records).

- [ ] **Check:** `ls -la ~/.local/state/pantoken/.update.lock 2>/dev/null`
- [ ] **Remove stale lock:** `rm -f ~/.local/state/pantoken/.update.lock`
- [ ] **Inspect journal:** `cat ~/.local/state/pantoken/update-journal.jsonl | tail -20`
- [ ] **Retain journal** for audit — do NOT delete

## 12. Launchd stdout/stderr logs

`~/Library/Logs/pantoken/pantoken.out.log` and `pantoken.err.log` from the
source-checkout era (if they existed under a different path or label).

- [ ] **Check:** `ls -la ~/Library/Logs/pantoken/pantoken.*.log 2>/dev/null`
- [ ] **Verify:** logs are from the old label, not `com.pantoken.server`
- [ ] **Archive:** `mv ~/Library/Logs/pantoken/pantoken.out.log ~/Library/Logs/pantoken/pantoken.out.log.old 2>/dev/null || true`

## 13. Legacy env/token files

Any old environment files or token files from the source-checkout deployment.
**Caution:** do not blindly delete — inspect and revoke/rotate any exposed
tokens. The new `~/.local/state/pantoken/pantoken.env` must remain.

- [ ] **Check:** `find ~ -maxdepth 3 \( -name '*pantoken*env*' -o -name '*pantoken*token*' \) -print 2>/dev/null`
- [ ] **Verify:** found file is NOT `~/.local/state/pantoken/pantoken.env`
- [ ] **Inspect:** check for exposed tokens
- [ ] **Revoke/rotate:** any exposed tokens in the old files
- [ ] **Remove:** `rm -f <old-env-file>`

## 14. Homebrew/service-manager entries

Any `brew services` entries or other service-manager registrations for pantoken
from the source-checkout era.

- [ ] **Check:** `brew services list 2>/dev/null | grep pantoken`
- [ ] **Remove:** `brew services stop pantoken 2>/dev/null || true`

## 15. Final verification

After all cleanup steps:

- [ ] `launchctl print system/com.pantoken.server` — service still running
- [ ] `curl -fsS http://127.0.0.1:8787/health` — still healthy
- [ ] `readlink ~/pantoken-live` — points to correct version
- [ ] `ps aux | grep '[p]antoken-server'` — only one process, inside `~/pantoken-versions/`
- [ ] `tailscale serve status` — still proxying to `127.0.0.1:8787`
- [ ] No old pantoken processes, plists, or cron jobs remain
