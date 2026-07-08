//! The in-process fake daemon was promoted into the library at
//! `pantoken_server::polytoken::fake_daemon` (so `PANTOKEN_DRIVER=fake` can host it as
//! a real server-binary driver mode). This is a thin re-export kept so the
//! existing `live_path` integration tests keep importing `support::fake_daemon::…`
//! (`spawn`, `MultiSpawnOverrideGuard`, `SpawnedFakeDaemon`, …) unchanged.
//!
//! `allow(unused_imports)`: `support` is shared by both integration test binaries
//! (`live_path` + `corpus`) via `mod support`, but only `live_path` uses the fake
//! daemon — so the re-export is "unused" when compiled into the `corpus` binary.
#[allow(unused_imports)]
pub use pantoken_server::polytoken::fake_daemon::*;
