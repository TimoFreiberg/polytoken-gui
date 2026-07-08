//! The golden-corpus loader was promoted into the library at
//! `pantoken_server::polytoken::corpus` (so the runtime-controllable fake daemon in
//! `src/` can share it). This is a thin re-export kept so the corpus
//! canonicalization test + the fake-daemon harness keep importing
//! `support::corpus::…` unchanged.
pub use pantoken_server::polytoken::corpus::*;
