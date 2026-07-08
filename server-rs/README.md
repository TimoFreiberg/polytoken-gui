# Pilot Rust Server

The pilot server, in Rust. Same WS protocol, HTTP endpoints, and driver behavior.
Axum-based WS bridge + HTTP routes + static file serving.

## Crate structure

```
server-rs/
├── Cargo.toml                # workspace
├── pilot-protocol/           # WS protocol types + fold reducer (shared logic)
│   └── src/
│       ├── lib.rs
│       ├── wire.rs           # ClientMessage, ServerMessage
│       ├── state.rs          # SessionState, foldEvent, foldAll
│       └── session_driver.rs # SessionDriverEvent, SessionSnapshot
├── pilot-daemon-types/       # Daemon wire types (generated from OpenAPI)
│   └── src/
│       └── lib.rs            # generated via scripts/codegen-polytoken-rs.ts
├── pilot-server/             # The server binary
│   └── src/
│       ├── main.rs           # entrypoint (axum router)
│       ├── config.rs         # env-based config
│       ├── hub.rs            # SessionHub (WS fan-out + journal + handleClient)
│       ├── journal.rs        # per-session append-only event journal
│       ├── push.rs           # Web Push (VAPID, subscription store)
│       ├── pidlock.rs        # PID lock + server identity
│       ├── settings_store.rs # pilot-settings.json read/write
│       ├── static_serve.rs   # gzip-cached static file serving
│       ├── ws_send.rs        # backpressure-aware WS send
│       └── polytoken/        # polytoken driver modules
│           ├── daemon_client.rs  # HTTP+SSE+process-lifecycle client
│           ├── event_map.rs      # daemon→pilot event mapping
│           ├── history_seed.rs   # history→seed conversion
│           ├── driver.rs         # DaemonDriver (implements PilotDriver)
│           ├── ui_bridge.rs      # interrogative response builder
│           ├── models.rs         # model registry
│           ├── commands.rs       # slash command parsing
│           ├── facets.rs        # facet list parsing
│           ├── sessions_registry.rs  # session list scanning
│           ├── config_notify.rs # notification config
│           └── file_catalog.rs   # file index handling
└── ts-test-reference/        # Archived TS tests (see its README.md)
```

## Commands

```bash
cargo build       # build the server
cargo test        # run all tests
cargo run         # run the server (reads PILOT_PORT, PILOT_DATA_DIR, etc.)
```

CI enforces `cargo fmt --check` + `cargo clippy --locked --all-targets -- -D
warnings` + `cargo test` (the `rust-server` job in `.github/workflows/ci.yml`);
run `bun run check:rs` from the repo root for the same locally.

## Codegen

Daemon wire types are auto-generated from the polytoken binary's OpenAPI spec:

```bash
bun run scripts/codegen-polytoken-rs.ts
```

This runs `polytoken openapi` and generates `pilot-daemon-types/src/lib.rs` with
161 serde types including the 60-variant `DaemonEvent` discriminated union.

## E2E integration

The Rust server is the only server — `bun run dev` and `bun run test:e2e` spawn
it directly via `cargo run` in `server-rs/`. No env var needed.

Mock mode (`PILOT_DRIVER=mock`) uses `mock_driver.rs` — a deterministic fixture
driver serving `SessionDriverEvent`s, used for dev and the e2e suite.

A third mode, `PILOT_DRIVER=fake`, runs the real `PolytokenDriver` over an
in-process, corpus-backed fake daemon: deterministic like the mock, but it
exercises the live driver stack end-to-end. Run it with `bun run test:e2e:live`.

## TS test reference

`ts-test-reference/` contains the TypeScript server's test files, preserved as
reference for porting cases to Rust. See its `README.md` for the file→domain map.
