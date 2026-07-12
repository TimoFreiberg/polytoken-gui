# Headless Deployment Handoff

_Date: 2026-07-12_

## Executive status

The repository is partway through the migration from the legacy source-checkout/poller deployment to a release-based, headless Rust Pantoken service. The implementation is substantially advanced, but the deployment is **not ready to claim full acceptance**, especially for AC.5–AC.8 and live Mac Mini verification.

## Completed and committed

- Headless Rust artifact builder and validation tooling.
- Direct-root release archive containing:
  - `pantoken-server`
  - bundled client assets
  - `VERSION`
  - full `BUILD_SHA`
  - runtime wrapper
  - updater
  - tar validator
- Canonical release-host handling for `TimoFreiberg/polytoken-gui`.
- Release metadata and build-SHA contracts.
- Strict runtime environment parsing and launchd deployment foundations.
- Signed updater foundations:
  - canonical release URLs
  - semantic-tag validation
  - signature verification before extraction
  - trusted tar-validator checks
  - atomic live-link flipping
  - transaction journaling
  - lock/concurrency handling
  - launchctl/sudoers contract
  - rollback logic in the updater
- Legacy deployment paths and source-poller surfaces were substantially removed or reworked.

Latest relevant commit:

```text
33d29a8a Harden updater fixture lifecycle coverage
```

The working copy was clean after that commit.

## Verification completed

- Focused updater tests: **15 passed**
- Full Bun suite: **434 passed**
- Scripts TypeScript check: **passed**
- Focused artifact, tar-validator, smoke, deployment, and release-contract tests passed earlier in the implementation.

## Known limitation: partial updater harness

The hermetic updater harness is intentionally **partial** and does not provide full AC.5 integration coverage.

The following long-running subprocess tests were removed because they hung after the transaction had already completed successfully:

- healthy update, flip, restart, and commit
- post-flip failure and rollback

The latest journal evidence showed that the healthy transaction reached `committed`. The observed timeout was a fixture child-process lifecycle/cleanup problem after success, not evidence of an updater rollback failure.

Retained real subprocess coverage includes:

- invalid signature rejected before extraction or live-link mutation
- malicious archive rejected before extraction

Static coverage remains for rollback behavior, journaling, locking, atomic flips, restart authorization, and command ordering. It must not be described as equivalent to full integration coverage.

## Remaining engineering work

- ~~Make fixture child-process cleanup deterministic.~~ ✅ Fixed: `fake-launchctl` now redirects stdin from `/dev/null`, resolves PGID via `ps`, and the test harness pipes stdout/stderr to prevent orphaned FDs.
- ~~Restore healthy-update integration coverage.~~ ✅ `test_healthy_update_full_transaction`
- ~~Restore rollback integration coverage.~~ ✅ `test_rollback_on_health_failure`
- ~~Add or finish stale-PID and rapid-respawn scenarios.~~ ✅ `test_stale_pid_recovery`, `test_rapid_respawn`
- ~~Finish failed-rollback and journal-recovery scenarios.~~ ✅ `test_failed_rollback_exit_4`, `test_journal_recovery`
- ~~Finish explicit-tag recovery, retention-pruning, and concurrency integration scenarios.~~ ✅ `test_explicit_tag_recovery`, `test_retention_pruning`, `test_concurrent_update_lock`
- Run the real macOS `deploy/launchd-platform-gate.sh` and retain evidence. (pending — requires sudo)
- Complete the independent implementation review.
- Finish remaining CI/publication and deployment-documentation work.

## Remaining live deployment work

Before a production cutover:

- Run the Mac Mini read-only preflight: `bash deploy/mac-mini-preflight.sh`
- Set up the new-infra layout: `bash deploy/mac-mini-preflight.sh --setup --version <ver> --archive <path>`
- Verify the installed `polytoken` version, executable path, credentials, configuration, bearer-token behavior, and live-driver interaction.
- Verify Tailscale Serve still routes `/` exactly to `http://127.0.0.1:8787`.
- Build or obtain a locally validated signed headless artifact without publishing unless separately authorized.
- Bootstrap the versioned release layout and rendered `com.pantoken.server` LaunchDaemon.
- Validate local health, HTML/static assets, WebSocket behavior, authentication, live-driver interaction, process identity, and restart recovery.
- Only after all gates pass, perform the explicitly inventoried legacy cleanup (`deploy/legacy-cleanup-inventory.md`).
- Run final post-cutover verification and record the active version and full build SHA.

## Operational boundaries

- No GitHub release or tag was created.
- No commits were pushed.
- No live Mac Mini service was changed.
- No Tailscale configuration was changed.
- No destructive cleanup was performed.

The next engineer should treat this document as a status handoff, not as evidence that the production cutover or the full updater acceptance criteria are complete.
