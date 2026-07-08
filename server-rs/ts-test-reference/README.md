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
