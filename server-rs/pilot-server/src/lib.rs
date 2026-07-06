//! Library facade for the pilot server.
//!
//! The crate is primarily a binary (`main.rs` — the axum WS bridge + HTTP
//! routes), but the live-path integration tests under `tests/` need to reach
//! the driver stack (`polytoken::driver`, `polytoken::daemon_client`,
//! `polytoken::event_map`) directly. Declaring the module tree here exposes it
//! as `pilot_server::…` for both the binary and the integration tests, so the
//! tests don't have to re-implement or duplicate driver internals.
//!
//! `main.rs` re-imports these via `use pilot_server::{…}` and adds only
//! `fn main` + the axum route handlers.

pub mod archive_store;
pub mod background_model;
pub mod config;
pub mod driver;
pub mod hub;
pub mod journal;
pub mod mock_driver;
pub mod pidlock;
pub mod polytoken;
pub mod push;
pub mod settings_store;
pub mod shared;
pub mod static_serve;
pub mod stub_driver;
pub mod worktree_store;
pub mod ws_send;
