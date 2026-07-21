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
//! - [`pantoken_server_install`] — step 3b: download, verify, and install the Pantoken server binary
//! - [`embedded_manifest`] — the compiled-in release manifest describing available server artifacts
//! - [`reconcile`] — step 5: idempotent reconciliation orchestrator
//! - [`fake`] — step 7: test harness (in-memory fake SSH + remote FS)

pub mod embedded_manifest;
pub mod pantoken_server_install;
pub mod polytoken_compat;
pub mod polytoken_install;
pub mod probe;
pub mod reconcile;

#[cfg(test)]
pub mod fake;
