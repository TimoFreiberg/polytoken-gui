# Remote Deployment Validation Checklist

Manual validation checks for the remote deployment feature. These are
supplementary to the automated hermetic tests — not replacements.

## SSH host setup

- [ ] Disposable localhost/container/VM SSH host with a clean home directory.
- [ ] Host-key confirmation prompt (manual SSH first to accept).
- [ ] Key-passphrase prompt (key loaded in agent).

## Artifact transfer

- [ ] No remote outbound HTTPS (polytoken uploaded from local device).
- [ ] Real target artifact install (polytoken install on a real Linux/macOS host).
- [ ] Existing compatible polytoken (pre-installed, accepted).
- [ ] Old polytoken (pre-installed 0.4.x, upgrade offered).
- [ ] Missing polytoken (not installed, install offered + accepted/declined).

## Connection resilience

- [ ] Active-turn disconnect/reconnect (start a turn, drop SSH, reconnect,
      verify turn survives).
- [ ] Idle cleanup (disconnect, wait for grace period, verify warm session
      reaped, reconnect + resume).

## Desktop Rust validation

- [ ] `cargo check --manifest-path desktop/Cargo.toml`
- [ ] `cargo clippy --manifest-path desktop/Cargo.toml --all-targets -- -D warnings`
