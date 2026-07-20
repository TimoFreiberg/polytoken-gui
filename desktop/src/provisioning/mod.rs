//! Remote provisioning layer (Phase 3).
//!
//! Sits between SSH connect and runtime start. The desktop orchestrates:
//! probe the remote host → check polytoken compatibility → (optionally)
//! install polytoken → configure XDG isolation → reconcile/recover from
//! interrupted installs → drive the connection state machine through
//! `Provisioning`.
//!
//! ## Module layout
//!
//! - [`probe`] — step 1: probe the remote host (OS, arch, tools, polytoken version)
//! - [`polytoken_compat`] — step 2: check polytoken version compatibility
//! - [`polytoken_install`] — step 3: download, verify, and install polytoken
//! - [`reconcile`] — step 5: idempotent reconciliation orchestrator
//! - [`fake`] — step 7: test harness (in-memory fake SSH + remote FS)

pub mod polytoken_compat;
pub mod polytoken_install;
pub mod probe;
pub mod reconcile;

#[cfg(test)]
pub mod fake;
