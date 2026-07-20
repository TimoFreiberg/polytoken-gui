//! Remote deployment support — provisioning, layout, and manifest contracts.
//!
//! Phase 0 scope: **types and contracts only**. The stdio adapter, remote
//! runtime, provisioning logic, and SSH transport are later phases that will
//! consume these frozen contracts. Nothing in this module performs I/O or
//! process spawning.

pub use pantoken_remote_layout::layout;
pub use pantoken_remote_layout::semver;
pub mod lifecycle;
pub mod manifest;
pub mod runtime;
