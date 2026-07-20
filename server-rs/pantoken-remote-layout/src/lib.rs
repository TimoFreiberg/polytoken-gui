//! Shared remote layout + semver primitives.
//!
//! Pure path-derivation functions and semver parsing/comparison used by both
//! the desktop provisioning layer and the remote runtime. Zero runtime
//! dependencies — no I/O, no process spawning, no serde.
//!
//! Both `pantoken-server` (remote runtime) and `desktop` (provisioning) depend
//! on this crate so they agree on where releases, tools, sockets, and metadata
//! live on the remote host.

pub mod layout;
pub mod semver;
