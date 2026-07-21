//! Shared remote layout + semver primitives + release manifest contract.
//!
//! Path-derivation functions, semver parsing/comparison, and release manifest
//! types used by both the desktop provisioning layer and the remote runtime.
//! The manifest types depend on `pantoken_protocol::wire::PROTOCOL_VERSION` and
//! `serde`, both of which are workspace deps.
//!
//! Both `pantoken-server` (remote runtime) and `desktop` (provisioning) depend
//! on this crate so they agree on where releases, tools, sockets, and metadata
//! live on the remote host — and on what a valid release manifest looks like.

pub mod layout;
pub mod manifest;
pub mod semver;
