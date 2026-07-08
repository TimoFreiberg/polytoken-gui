# TS test reference

These are the TypeScript server's test files, preserved as reference after the
TS server was deleted and the Rust server became the only server.

The Rust server (`server-rs/pantoken-server/`) has its own test suite (~150 tests
via `cargo test`), but it does not yet cover every case these TS tests did.
When adding Rust tests, consult the corresponding file here for cases worth
porting.

## Structure

```
ts-test-reference/
├── *.test.ts              — top-level server tests (hub, journal, config, etc.)
├── shared/*.test.ts       — shared utility tests (worktree, login-env, etc.)
└── polytoken/*.test.ts    — polytoken driver tests (event-map, daemon-client, etc.)
```

## File → domain map (top-level)

| TS test file              | Domain                          | Rust coverage |
|---------------------------|---------------------------------|---------------|
| `archive-store.test.ts`   | archive store (on-disk)         | partial       |
| `config.test.ts`          | config parsing / env vars       | partial       |
| `hub-journal.test.ts`     | hub + journal interaction       | partial       |
| `hub.test.ts`             | hub (god object: sessions, etc.)| partial       |
| `journal.test.ts`         | journal (append/rotate/replay)  | partial       |
| `log.test.ts`             | structured logging              | minimal       |
| `pidlock.test.ts`         | PID lock (single-instance)      | partial       |
| `push.test.ts`            | web push notifications           | partial       |
| `settings-store.test.ts`  | settings store (on-disk)        | partial       |
| `static.test.ts`          | static file serving             | partial       |
| `worktree-store.test.ts`  | worktree store (on-disk)        | partial       |
| `ws-send.test.ts`         | WS send (batching, backpressure)| partial       |

These tests import from the deleted `server/src/` and will not compile.
They are reference material, not a runnable suite. Files use a `.test.ts.bak`
extension so Bun's test discovery skips them.
