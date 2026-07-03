//! Supporting modules for the polytoken driver (Phase 4 of the Rust server rewrite).
//!
//! Each module is a thin adapter over daemon HTTP responses. These are ported
//! from the TS `server/src/polytoken/*.ts` files. The HTTP-calling functions are
//! stubbed with `todo!()` since the daemon-client isn't ported yet; the pure parser
//! and builder functions are fully ported.

#![allow(dead_code)]

pub mod commands;
pub mod config_notify;
pub mod facets;
pub mod file_catalog;
pub mod models;
pub mod sessions_registry;
pub mod ui_bridge;
