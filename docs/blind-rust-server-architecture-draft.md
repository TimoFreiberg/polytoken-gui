# Polytoken Hub — Rust bridge server architecture (blind draft)

Status: draft for discussion. Written against `polytoken 0.4.0-unstable.5`.

## 1. Scope

A Rust server ("the hub") that sits between Polytoken session daemons on one
machine and three kinds of clients:

- a desktop GUI (Tauri + Svelte, Codex-desktop-style) running **on the same
  machine**,
- the **same desktop GUI running remotely** on another machine,
- a **mobile app** (stack undecided, Tauri 2 mobile is a candidate),

with all remote connectivity over Tailscale.

Decisions already made (and baked in below):

- **Per-machine hub.** Every machine that runs polytoken runs one hub; clients
  hold a list of hubs and connect directly. No federation.
- **Stateless event path.** In-memory ring buffer per session; no persistent
  event journal. The daemons and their on-disk session dirs remain the only
  source of truth for transcripts.
- **REST + one multiplexed WebSocket** per client.
- v1 includes **remote session spawning** and **mobile push notifications**.
- The hub will also grow machine-local conveniences (jj/git workspace
  create/cleanup, session archiving, misc filesystem ops). Those are
  deliberately *not* designed here — only their seams are.

Non-goals:

- Keeping daemons alive. Sessions outlive UIs by design; the hub supervises
  *records about* daemons, not the daemons themselves.
- Duplicating TUI business logic. Full TUI feature parity comes from proxying
  the daemon API, not from reimplementing it.
- App-level auth in v1. The tailnet is the auth boundary.
- Cross-machine aggregation. Clients aggregate multiple hubs client-side.

## 2. Verified facts about the daemon (the ground truth this leans on)

Gathered from `polytoken openapi`, `polytoken event-schema`, `--help` texts,
the live registry on this machine, and probing a running daemon.

**Process model**
- One daemon **per session**, HTTP + SSE on an ephemeral `127.0.0.1` port.
  Title of the OpenAPI doc: "Per-session daemon HTTP + SSE API".
- **No authentication** on the daemon API (`securitySchemes` absent) —
  loopback trust only.
- Registry: `$XDG_DATA_HOME/polytoken/sessions/{session_id}/` containing
  `record.json` (session_id, pid, process_start_token, port, project_path,
  parent_session_id, started_at, model, session_title), `session.json`,
  `startup.json`, `log.jsonl`.
- `polytoken sessions` lists live sessions and **stale-cleans dead entries as
  a side effect**. `polytoken new --no-attach` spawns a detached daemon and
  prints session id + port. `polytoken daemon` runs **foreground** (supports
  `--resume --session-id`, `--listener-fd` for socket activation).
  `polytoken continue <id>` resumes **but always attaches a TUI** — there is
  currently no `--no-attach` for resume.

**Event stream**
- `GET /events`: SSE, envelope `{seq, emitted_at, session_id, event}`, with
  the discriminator at `event.type`. SSE `id:` line carries the seq.
- **Pure live tail** (verified empirically): connecting mid-session starts at
  the current seq; `Last-Event-ID` and guessed query params produced no
  replay. There is a `stream_discontinuity` event (`missed` count) for
  subscriber-side overflow, and a **subscriber cap** (503 when exceeded).
- Recovery primitives: `GET /state` (rich `SessionStateSnapshot`: todos,
  pending_interrogatives, turn_in_flight, context_usage, models, MCP servers,
  active facet/plan/goal, source_control, …) and `GET /history`
  (offset/limit pagination over "projected items", plus a monotonic
  `history_revision` and `total_projected_items`).
- `heartbeat` events flow on the stream; `/health` returns the full record
  plus `last_heartbeat_at`.

**Control plane (per session)**
- `POST /prompt` (**text-only today** — "Layer-1 minimum", schema says
  structured content may be added additively), turn input queue
  (`GET/POST/DELETE /turn/input`, `queue_revision` on events),
  `POST /turn/cancel`.
- Interrogatives (agent-initiated questions): `interrogative` /
  `subsession_interrogative` / `ask_user_question` events carrying
  `interrogative_id`, `interrogative_type`, permission candidates,
  clarification options, plan handoffs; answered via
  `POST /interrogative/{id}/respond`.
- Notifications subsystem: `notification_queued`, `notifications_drained`
  events; `GET/POST /notification-autodrain` toggle.
- Plus: goal endpoints, model switch, facets, MCP server management (incl.
  OAuth), jobs, todos, rewind, compact, reload, reset-shell, title,
  terminate, `/files` (path *catalog* for @-mentions — not file contents).
- **TUI attachment lease**: `GET /tui-attachment`,
  `POST /tui-attachment/claim {pid, process_start_token, terminal_label}`,
  heartbeat, release; 409 when another live TUI owns it. Semantics are
  local-process-based (pid) — built for terminal TUIs, not remote GUIs.

**Subsessions**
- Subsessions run as separate daemons (spawn event carries a `port`), but
  their events are **forwarded into the parent's stream**
  (`subsession_message`, `subsession_interrogative`, …) and the parent serves
  `GET /subagent/{handle}/history`. The hub therefore only maintains links to
  top-level session daemons.

## 3. Design at a glance

```
              the machine (Mac or Linux)
┌───────────────────────────────────────────────────────────┐
│  polytoken daemons — one per session, loopback-only       │
│   :60352 sess A     :56742 sess B     :60452 sess C       │
│      ▲ 1 SSE link + proxied HTTP each                     │
│      └──────────┬──────────┴──────────────┘               │
│        ┌────────┴─────────┐      ┌──────────────────────┐ │
│        │  polytoken-hub   │─────▶│ hub metadata store   │ │
│        │  (axum, tokio)   │      │ (sqlite: archive     │ │
│        └───┬──────────┬───┘      │ flags, push tokens,  │ │
│   loopback │          │ tailscale│ workspace registry)  │ │
│    bind    │          │ IP bind  └──────────────────────┘ │
└────────────┼──────────┼───────────────────────────────────┘
             │          │ tailnet (WireGuard)         ┌────────────┐
     ┌───────┴───┐ ┌────┴───────┐ ┌──────────────┐    │ APNs/FCM/  │
     │ desktop   │ │ desktop    │ │ mobile app   │    │ ntfy       │◀─ push
     │ (local)   │ │ (remote)   │ │ (Tauri 2?)   │    └────────────┘
     └───────────┘ └────────────┘ └──────────────┘
        same REST + single-WebSocket protocol everywhere
```

Principles:

1. **Transparent proxy for the control plane.** The hub forwards daemon
   requests/responses as opaque JSON. It parses only what it must (envelope
   `seq` + `event.type`, record.json, a handful of state fields). Daemon API
   evolution doesn't break the hub; full TUI parity is free.
2. **One recovery path.** Every gap — daemon overflow, hub↔daemon SSE drop,
   hub restart, WS drop, mobile backgrounding — surfaces to clients as the
   same `gap` signal with the same answer: re-sync from snapshot, resume the
   tail by seq. This mirrors the daemon's own `stream_discontinuity` design.
3. **Daemons are never hub children.** The hub spawns them detached and can
   die without taking sessions down.
4. **Hub state is non-authoritative metadata only.** Losing the hub's sqlite
   loses archive flags and push registrations, never transcript data.
5. **Crash loudly.** On invariants breaking (seq regression, port mismatch,
   registry/health disagreement) the hub fails the affected session link and
   emits an error event to clients; it never papers over inconsistencies.

## 4. The hub's jobs

1. **Session directory** — merged view over the registry: `live` (record +
   healthy daemon), `resumable` (session dir exists, no live daemon),
   `archived` (hub-local flag). Pushed to clients as it changes.
2. **Lifecycle operator** — spawn (`polytoken new --no-attach`), resume
   (detached `polytoken daemon --resume`), terminate (proxy `POST
   /terminate`), archive (hub flag). Reconciles registry ⇄ reality.
3. **Event fan-out** — exactly one upstream SSE connection per live session
   (respecting the daemon's subscriber cap), ring buffer, per-client
   cursor-based resume, gap signaling.
4. **Command proxy** — authenticated-by-network REST passthrough to any
   daemon endpoint, plus hub-composed convenience endpoints (snapshot).
5. **Push dispatch** — classify interrogative/notification events, deliver
   via pluggable backends, dedupe against live client attention.
6. **Machine-local ops** *(seams only, not designed here)* — jj/git workspace
   create/cleanup around session spawn/archive, filesystem helpers. These
   hang off the same lifecycle hooks (`on_spawn`, `on_archive`) and store
   their records in the hub metadata store.

## 5. Process & deployment model

- Single binary `polytoken-hub`, run as a user service (launchd on macOS,
  systemd --user on Linux). Config file (TOML) + env overrides:
  - `bind`: list of addresses. Default: `127.0.0.1:7550` + the machine's
    Tailscale IP `:7550`. **Refuse to bind non-loopback, non-tailscale
    addresses** unless `allow_unsafe_bind = true`. Tailscale IP discovered at
    startup via `tailscale ip -4` / LocalAPI; if tailscaled is down, start
    loopback-only and retry binding in the background (local GUI keeps
    working, remote comes up when the tailnet does).
  - `project_roots`: directories under which remote spawning is allowed.
  - `sessions_dir` override (matches `--sessions-dir`), ring sizes, push
    backend config.
- The local desktop GUI talks to `127.0.0.1:7550` — same protocol as remote.
  One code path; no direct-to-daemon fallback. If the hub is down locally,
  that's a loud failure and launchd/systemd restarts it.
- Hub restart is cheap by design: rescan registry, redial SSE links, clients
  reconnect and re-sync.

## 6. Session lifecycle & supervision

**Discovery/reconciliation.** A reconcile task merges three inputs into the
authoritative in-hub session table:
- fs watch (notify crate) on the sessions registry dir, debounced,
- a periodic sweep (every ~5s) reading `record.json`s,
- liveness probes: `GET /health` on the recorded port, cross-checked against
  `record.json` (session_id and pid must match — a recycled port serving a
  different session is a loud error, not a match). `last_heartbeat_at` and
  SSE-link status feed a `health: ok | lagging | unreachable` field.

Dead records are marked `resumable` immediately; actual registry
stale-cleaning is done by invoking `polytoken sessions` (its documented side
effect) on demand rather than the hub deleting files it doesn't own.

**Spawn.** `POST /api/sessions` → validate `project_dir` against
`project_roots` → run `polytoken new --no-attach` (with `--working-dir`),
parse session id + port from stdout, wait for `/health`, insert as live.
Workspace pre-creation hooks go here later.

**Resume.** `POST /api/sessions/{id}/resume` → spawn a **detached**
`polytoken daemon --resume --session-id {id} --project-dir {recorded}`
(new session group / setsid, stdout+stderr to the hub log dir), wait for the
registry record to reappear with a port. This is the settled path (pantoken's TS
server does exactly this today). The one real caveat applies to `new
--no-attach` equally: under a service manager, detached grandchildren still
live in the service's cgroup/process group — systemd needs
`KillMode=process`, launchd `AbandonProcessGroup=true`, or daemons die with
the hub.

**Terminate/archive.** Terminate proxies `POST /terminate` and waits for the
record to go dead. Archive is a hub-metadata flag over a `resumable` session
(plus, later, workspace cleanup hooks); archived sessions are hidden from the
default list but remain resumable.

## 7. Event pipeline (the core)

Per live session the hub runs one **SessionLink** task:

```
daemon /events (SSE) ──▶ parse envelope minimally ──▶ RingBuffer(seq → raw frame)
                                   │
                                   ├──▶ per-subscriber mpsc queues (WS clients)
                                   └──▶ push classifier (internal subscriber)
```

- **Upstream:** `reqwest` streaming + `eventsource-stream`, reconnect with
  jittered backoff. Frames are kept as raw `Bytes`; the hub deserializes only
  `{seq, event.type}` (a 2-field partial struct). On reconnect after a drop,
  or on receiving `stream_discontinuity`, the link emits a synthetic
  **`gap`** to all subscribers — since the daemon cannot replay, no stitching
  is attempted upstream.
- **Ring buffer:** per session, bounded by count *and* bytes (defaults:
  8192 envelopes / 32 MiB). Holds `(seq, raw_frame)`.
- **Client resume:** a subscriber asks for `after_seq = S`. If `S+1` is still
  in the ring → replay from the ring, then live. Otherwise → `gap` (client
  re-syncs). Hub restart naturally lands everyone in the second path.
- **Backpressure:** each (client, session) subscription has a bounded queue
  (default 512 frames). Overflow drops that subscription's queued frames and
  replaces them with a single `gap` — one slow phone never blocks other
  clients or the upstream read loop.
- **Seq invariants:** seq must be strictly increasing per link connection; a
  regression kills the link with an error surfaced to clients (crash-loud).

**Snapshot & stitching.** Clients recover via a hub-composed snapshot:

`GET /api/sessions/{id}/snapshot?history_limit=K` →
```json
{
  "state": { …SessionStateSnapshot… },
  "history": { …SessionHistorySnapshot (last K projected items)… },
  "watermark_seq": 8931
}
```
where `watermark_seq` is the last seq the hub had relayed from that session
when composition finished. The recommended client algorithm:

1. subscribe on the WS with `after_seq: null` (live tail starts buffering
   client-side),
2. fetch the snapshot,
3. drop buffered events with `seq <= watermark_seq`, apply the rest,
4. apply subsequent events normally.

Because snapshot composition and event emission race inside the daemon, the
watermark is pragmatic rather than transactional: clients must apply events
**idempotently by id** (prompt_id / item_id / interrogative_id / block index
upserts), tolerating an occasional event already reflected in the snapshot.
⚠️ Before implementing, read how the TUI itself attaches to a live session —
it solves the identical problem and its reconciliation rules (e.g. any use of
`history_revision` to order snapshots vs events) should be copied, not
reinvented (§14 Q1).

## 8. Client-facing API

### REST

Hub-level:

| Method & path | Purpose |
|---|---|
| `GET  /api/machine` | hostname, hub version, project_roots, tailnet name |
| `GET  /api/sessions` | merged directory: live + resumable (+archived with `?archived=1`), each with status, title, model, project, last activity |
| `POST /api/sessions` | spawn `{project_dir, …}` (validated against roots) |
| `POST /api/sessions/{id}/resume` | resurrect a resumable session |
| `POST /api/sessions/{id}/archive` / `unarchive` | hub-local flag |
| `GET  /api/sessions/{id}/snapshot` | composed state + history tail + watermark_seq (§7) |
| `POST /api/push/registrations` | register a device/topic for push |
| `GET  /api/health` | hub self-health incl. per-link status |

Daemon passthrough — the parity workhorse:

```
{METHOD} /api/sessions/{id}/d/{daemon_path}   →   {METHOD} 127.0.0.1:{port}/{daemon_path}
```

- Route allowlist generated from the daemon OpenAPI paths (method + path
  pattern), so the hub can't be steered at arbitrary local ports/paths.
  `GET /events` is **excluded** (clients get events via the hub WS only —
  this is what protects the daemon's subscriber cap).
- Bodies and error responses pass through verbatim; daemon errors reach the
  client untouched.
- Idempotency: mobile retries on flaky links can double-submit. Hub honors an
  optional `Idempotency-Key` header on mutating passthrough calls (in-memory
  key → response cache, ~5 min TTL).

### WebSocket `/ws` (one per client)

JSON text frames. Client→server:

```jsonc
{"op":"sub",   "session":"0534g7-cupid", "after_seq": 8931}  // or after_seq: null
{"op":"unsub", "session":"0534g7-cupid"}
{"op":"sub_machine"}                     // session directory change feed
{"op":"attention", "session":"…", "foreground": true}   // push suppression hint
```

Server→client:

```jsonc
{"op":"event",  "session":"…", "seq":8932, "emitted_at":"…", "event":{…raw daemon event…}}
{"op":"subbed", "session":"…", "mode":"resumed"|"live"|"gap"}
{"op":"gap",    "session":"…", "reason":"ring_expired"|"upstream_reconnect"|"daemon_discontinuity"|"slow_client"}
{"op":"machine_event", "kind":"session_added"|"session_removed"|"session_status_changed", "session":{…}}
{"op":"error",  "session":"…", "message":"…"}            // crash-loud surface
```

- Daemon event payloads are forwarded **byte-identical** under `event`;
  clients codegen their TypeScript types straight from
  `polytoken event-schema` output, so hub and frontends can't drift apart.
- Commands stay on REST (plain request/response error semantics, curl-able);
  the WS carries only events + subscription control.
- WS ping/pong every ~25s; `attention` lets the push dispatcher know a human
  is already looking at a session.

## 9. Remote session spawning

- `POST /api/sessions {project_dir, title?, model?}` — `project_dir` must
  resolve (after canonicalization, symlink-safe) under a configured root.
- Anyone on the tailnet can start a coding agent in those roots. That is
  RCE-by-design; the mitigations are the tailnet boundary, the explicit root
  allowlist, and an append-only spawn audit log in the hub store. Fancier
  controls (per-device ACLs via tailscale whois) are a later hardening step.
- Workspace autocreation (spawn into a fresh jj workspace, clean up on
  archive) plugs into this endpoint's before/after hooks later — the endpoint
  shape should accept an optional `workspace` object from day one, even if v1
  ignores it.

## 10. Push notifications

- **Source signals** (from the internal subscriber on each SessionLink):
  - `interrogative` / `subsession_interrogative` / `ask_user_question` →
    high-priority "agent is blocked on you" push, typed by
    `interrogative_type` (permission / question / plan handoff / goal
    proposal).
  - `notification_queued` → the daemon already decided this is
    notification-worthy; forward its content. (Check interplay with
    `notification-autodrain` and TUI attachment — §14 Q4 — so pushes aren't
    duplicated or swallowed when a TUI is attached.)
  - Turn completion (`message_complete` when `turn_in_flight` clears) →
    low-priority optional "session went idle".
- **Dedupe/lifecycle:** key pushes by `(session_id, interrogative_id | notification id)`;
  suppress when any WS client has `attention.foreground == true` for that
  session; retract/mark-read (where the backend supports it) when the
  corresponding respond/drain event is observed.
- **Backends:** a small `Notifier` trait; v1 default **ntfy** (self-hostable,
  plain HTTP POST, has iOS/Android apps, can itself live on the tailnet —
  with the phone on always-on Tailscale VPN, push never leaves the tailnet).
  APNs/FCM as feature-flagged backends for a "real" store app later — they
  are the only components that would require non-tailnet egress and per-
  platform credentials.
- Device registrations live in the hub metadata store.

## 11. Security model

- **Bind discipline:** loopback + tailscale interface only (§5). The daemons
  themselves stay loopback-only; the hub is the single remote door.
- **Tailnet = authentication** in v1. Any peer the tailnet admits is fully
  trusted. WireGuard provides transport encryption; no TLS needed initially
  (add `tailscale cert`/Serve in front later if browser clients demand
  `wss://` with a real cert).
- **Proxy confinement:** the hub only dials ports read from `record.json`
  files in the sessions dir, only with allowlisted method+path patterns.
  It must never accept a host/port from a client.
- Later hardening (explicitly out of v1): tailscaled LocalAPI `whois` per
  connection for identity logging and per-user/device ACLs; embedding
  tsnet-style via libtailscale FFI is possible but not worth the build
  complexity for a personal service.

## 12. Hub metadata store

Sqlite (rusqlite, bundled) at `$XDG_STATE_HOME/polytoken-hub/hub.db`:

- `session_meta(session_id, archived_at, notes?, workspace_id?)`
- `workspaces(id, path, vcs, created_for_session, created_at, cleaned_at?)` — for the later jj/git ops
- `push_registrations(id, platform, token_or_topic, created_at, last_ok_at)`
- `spawn_audit(id, ts, remote_addr, project_dir, session_id, outcome)`

Nothing here is a second copy of transcript truth; `rm hub.db` loses
preferences, not history.

## 13. Failure matrix

| Failure | Blast radius | Recovery |
|---|---|---|
| Hub crash/restart | All client streams drop; daemons unaffected | Service manager restarts; registry rescan; clients reconnect → `gap` → snapshot re-sync |
| Daemon crash | One session live→resumable | Health/SSE detect → `machine_event(session_status_changed)`; user resumes |
| Hub↔daemon SSE drop | One session's tail | Backoff reconnect; `gap(upstream_reconnect)` to subscribers |
| Daemon emits `stream_discontinuity` | Events lost at source | Forwarded as `gap(daemon_discontinuity)` — same client path |
| Slow client | That client's one subscription | Queue overflow → `gap(slow_client)`, drop-oldest; others unaffected |
| Tailscale down | Remote clients only | Local GUI on loopback unaffected; hub rebinds when tailnet returns |
| Registry/health disagreement (pid/session mismatch, seq regression) | One session | Link failed **loudly**: `error` frame to clients, session marked suspect; no silent auto-repair |
| `hub.db` lost | Archive flags, push registrations | Re-register devices; re-archive; transcripts intact |

## 14. Open questions & upstream asks

1. **How does the TUI attach to a live session?** Its
   snapshot-vs-stream reconciliation (ordering, use of `history_revision`,
   delta handling for in-flight blocks) should be copied into §7's client
   algorithm. Read the TUI source before implementing.
2. **SSE replay: settled.** No replay on plain connect; `Last-Event-ID: 100`
   with ~8,900 events behind produced no replay burst (0.4.0-unstable.5) —
   the header is a silent no-op. Pantoken's upstream ask #4 should be reframed
   from "document resume" to "implement or document that it doesn't exist".
3. **Subscriber cap value** — the hub uses exactly one subscription per
   session, but knowing the cap informs whether a second (debug) tap is safe.
4. **`notification-autodrain` × TUI lease semantics** — does an attached TUI
   drain notifications automatically, and should the hub toggle autodrain
   when a GUI holds foreground attention? Affects push dedupe correctness.
5. **TUI attachment lease from remote GUIs:** pid-based semantics don't
   transfer. Proposal: hub/GUIs do **not** claim the lease (terminal TUIs
   keep working side-by-side); GUIs merely display who holds it. Observed:
   `GET /events` and other GETs work with **no lease claimed** — read-only
   observing appears lease-free already. Still to check: whether any
   *mutating* endpoint is gated on the lease.
6. ~~Upstream ask: `polytoken continue --no-attach`~~ — withdrawn;
   `polytoken daemon --resume --session-id` covers resume-without-TUI (§6),
   the remaining concern is service-manager detach hygiene, not a missing
   polytoken feature.
7. **Prompt attachments** (images from a phone): `PromptRequest` is text-only
   today, but media events exist. Hub should not invent multipart handling —
   track upstream and pass through when it lands.
8. **Subsession interrogatives:** confirm `POST /interrogative/{id}/respond`
   on the **parent** answers `subsession_interrogative`s, or whether the hub
   must dial the subsession's own port (it currently plans not to).

## 15. Rust stack & module layout

- **Runtime/HTTP:** tokio, axum 0.8 (native WS), tower / tower-http (trace,
  timeouts).
- **Upstream SSE:** reqwest (stream) + eventsource-stream (or
  reqwest-eventsource for its retry policy).
- **Data:** serde/serde_json (payloads stay `Bytes`/`RawValue` wherever
  possible), rusqlite (bundled).
- **FS/eventing:** notify (registry watch), tokio broadcast/mpsc.
- **Obs:** tracing + tracing-subscriber (env-filter), file appender.
- **Type sharing:** hub WS/REST frame types exported to TypeScript (ts-rs or
  schemars→JSON-Schema→codegen); daemon event/state types generated in the
  frontends directly from `polytoken event-schema` / `polytoken openapi`
  output at build time. The hub deliberately does *not* codegen the full
  daemon model — it types only the fields it inspects.

```
polytoken-hub/src/
  main.rs        startup, bind discipline, service wiring
  config.rs      TOML config, project_roots, limits
  registry.rs    record.json scan/watch, session table, reconcile
  supervisor.rs  spawn / resume (detached) / terminate / archive
  link.rs        SessionLink: SSE task, seq invariants, gap logic
  ring.rs        count+byte bounded ring buffer
  proxy.rs       allowlisted daemon passthrough (+ idempotency cache)
  api.rs         hub REST (sessions, snapshot, spawn, push reg)
  ws.rs          client protocol: sub/unsub/resume/attention
  push/          classifier + Notifier trait + ntfy (apns/fcm later)
  store.rs       sqlite metadata
  tailnet.rs     tailscale IP discovery (later: whois)
```

## 16. Frontend notes

- **Desktop (Tauri + Svelte):** connects to `http://127.0.0.1:7550` locally
  or `http://<machine>.<tailnet>.ts.net:7550` remotely — identical code path.
  Hub list is app config; "machines" sidebar = one entry per hub, populated
  from `GET /api/machine` + `sub_machine`.
- **Mobile:** Tauri 2 does target iOS/Android and could reuse the Svelte UI
  wholesale, which is the cheapest path to try first. Known risks to
  validate early: WS lifecycle under iOS backgrounding (expect the socket to
  die; the seq-cursor + snapshot design makes foreground re-sync cheap —
  that's deliberate), maturity of push-notification plugins in the Tauri 2
  ecosystem (ntfy's native apps sidestep this entirely), and store
  distribution. If Tauri mobile disappoints, the protocol is deliberately
  thin (REST + one JSON WS) so a native thin client stays viable.
- **Event rendering:** clients consume raw daemon events — the same types
  the TUI renders — so a "Codex-desktop-like" transcript view is a pure
  projection of `history items + event tail`, per session, with
  interrogatives rendered as answerable cards (`POST …/d/interrogative/{id}/respond`).

## 17. Build order

1. **M0 — directory:** config, bind discipline, registry scan + health,
   `GET /api/sessions`, `GET /api/machine`. (Useful CLI-free `sessions` view already.)
2. **M1 — parity core:** passthrough proxy + SessionLink + ring + WS
   sub/resume + snapshot endpoint. *A web page can now fully drive a live
   session remotely.* This is the milestone that proves §7's stitching.
3. **M2 — lifecycle:** spawn, resume (detached recipe), terminate, archive,
   `machine_event` feed.
4. **M3 — hardening:** backpressure/gap edge cases, idempotency keys,
   TS type export pipeline, multi-session soak test.
5. **M4 — push:** classifier + ntfy backend + attention suppression.
6. **M5 — machine-local ops:** workspace create/cleanup, archiving hooks,
   filesystem helpers (designed separately).
