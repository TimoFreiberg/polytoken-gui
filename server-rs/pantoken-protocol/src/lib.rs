//! Pantoken WS protocol types + fold reducer.
//!
//! This is a Rust port of `protocol/src/` — the shared, JSON-serializable
//! contract between the pantoken server and the Svelte client. The TS `protocol/`
//! package stays as the client's import; this crate is validated by byte-
//! compatibility (the e2e suite fails if a Rust-produced `ServerMessage` JSON
//! doesn't match what the TS client expects).

pub mod session_driver;
pub mod state;
pub mod wire;
