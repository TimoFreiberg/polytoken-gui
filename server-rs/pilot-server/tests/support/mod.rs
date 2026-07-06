//! Shared test-support modules.
//!
//! Integration tests under `tests/` each compile as a separate binary, so a
//! shared module is the standard way to give them common helpers. This module
//! re-exports the corpus loader (`support::corpus`) used by both `corpus.rs`
//! (canonicalization tests) and the fake-daemon harness (`live_path.rs`).

pub mod corpus;
pub mod fake_daemon;
