# Plan — A PolytokenDriver for pilot

> Status: **draft, design questions settled** (2026-06-28). This explores wiring
> pilot to drive **polytoken** (a daemon-first coding agent, `v0.3.3`) instead of /
> alongside pi. Decisions D-A…D-D below are settled with Timo; next step is the
> Chunk 0 spike. A design input, not a TODO list.
>
> **Confidence caveat — read first.** Most of this is reverse-engineered from the
> polytoken *binary's* self-describing contracts (`polytoken --help`,
> `polytoken openapi`, `polytoken event-schema`) — NOT from running the daemon and
> NOT from the docs prose (docs.polytoken.dev returns 403 to automated fetches).
> polytoken is installed on the mini (`brew`, `/opt/homebrew/bin/polytoken`) but
> **not yet configured** (no `~/.config/polytoken`), so nothing here has been
> exercised against a live daemon. Everything tagged **[VERIFY]** is an inference
> from the schemas that a Chunk 0 spike must confirm before building on it.

## TL;DR

Pilot already proves its core thesis: *a driver seam (`PilotDriver`) folds an
agent's event stream into an authoritative `SessionState` and broadcasts it; the
hub and clients never change when you swap the agent.* Today there are two
drivers behind that seam — `mock` and the real pi-SDK driver.

**Polytoken is unusually well-suited to a third driver, because it already _is_
the server pilot's pi-driver had to build by hand.** pi is a library pilot embeds
in-process (1880-line `pi-driver.ts` managing warm sessions, fd file indexing,
worktrees, OAuth, extensions). polytoken is a **daemon with a versioned OpenAPI
3.1 HTTP surface + an SSE event stream**; the TUI is just one client of it. So a
`PolytokenDriver` is mostly *an HTTP+SSE client that maps one event vocabulary
onto another* — much of pi-driver's in-process machinery moves server-side into
the daemon and disappears from pilot.

The bulk of the real work is the **event-fold**: polytoken's stream is *lower
level* than pi's (Anthropic-style `content_block_*` / `message_*` frames), so the
new `event-map` carries a small accumulator. The rest is daemon process
lifecycle and filling pilot's `PilotDriver` methods from daemon endpoints.

## Why this is attractive (the architectural fit)

| Concern | pi (today, via `pi-driver.ts`) | polytoken (proposed) |
|---|---|---|
| Process model | pi SDK embedded **in pilot's process**; one warm `AgentSession` swapped on switch | **out-of-process daemon(s)** pilot talks to over HTTP; pilot can't crash the agent and vice-versa |
| Authoritative state | pilot reconstructs `SessionState` from pi events | daemon owns session state; `GET /state` + `GET /history` are snapshots pilot folds |
| Event stream | in-process callback (`session.subscribe`) | `GET /events` SSE, `Envelope<DaemonEvent>` (seq'd, `emitted_at`, `session_id`) |
| Contract stability | pinned to `@earendil-works/pi-coding-agent` types (breaks on SDK bumps) | `polytoken openapi` + `polytoken event-schema` are **published JSON Schemas** — codegen-able, version-checkable |
| Multi-client | pilot is the sole consumer of the in-process session | `tui-attachment` lease + heartbeat → a local TUI and pilot can **co-attach the same live session** **[VERIFY]** |
| Multi-provider | pi's provider set | "poly" = provider-agnostic auth (`polytoken auth provider`), Anthropic + OpenAI/Codex profiles visible in the schema |

The seam pilot already designed for the mock↔pi swap is exactly the seam this
needs. `driver.ts`'s own header: *"The mock driver and the real pi-sdk driver
both implement this, so the hub never changes when we swap the fixture for a live
agent."* A third implementor is the intended extension point.

## What I verified vs. assumed

**Verified from the binary (reproducible on the mini):**
- `polytoken openapi` → OpenAPI 3.1, `~50` daemon endpoints (list below).
- `polytoken event-schema` → `DaemonEvent`, **56 variants** (full list mapped below).
- `GET /events` response doc: *"SSE stream of `Envelope<DaemonEvent>` values. Each
  frame is a single `data:` line … top-level `seq`, `emitted_at`, `session_id`,
  and `event` fields; the `type` discriminator for dispatch lives at `event.type`."*
- `polytoken daemon` flags: `--listen` (default `127.0.0.1:0`), `--project-dir`,
  `--session-id`, `--parent-session-id`, `--listener-fd`, `--resume`,
  `--sessions-dir`, `--todo-dir`. **No auth flag** → localhost-only, single-user.
- `polytoken new --no-attach` → *"Spawn the daemon and print its session id and
  port without attaching."* (the headless-spawn entry point a driver wants).
- **Daemon auto-names sessions.** `TitleChangeSource = "operator" | "inferred"`,
  `inferred` = *"the daemon inferred the title automatically"* → pilot needs no
  session-namer (D-C1).
- pilot is plain git on `main`, remote `tangled.org/timofreiberg.bsky.social/pilot`.

**Assumed / [VERIFY] in a spike:**
- **One daemon process = one session = one port** (vs. one daemon hosting many).
  Strong read: endpoints are flat (`/prompt`, `/events`, `/state` — no
  `/session/{id}/…`), `--session-id` is singular, `new` = "a new daemon session",
  `sessions` lists+stale-cleans live ones (a registry of processes). **[VERIFY]**
- The exact `PromptRequest` / steering shape, the `interrogative` & `permission`
  request/response payloads, whether `/history` exposes a **branch DAG** (pi's
  `/tree`) or only a linear log, and whether the `tui-attachment` lease truly
  permits a second concurrent client. All **[VERIFY]**.
- Provider/model auth is **CLI/config-level** (`polytoken auth`, `config`), not a
  daemon endpoint — so pilot's Settings "providers" panel would shell out / edit
  config rather than hit the daemon. **[VERIFY]**

## Architecture

### Where it sits

```
clients (browser/phone) ──WS── hub ──┬── mock-driver
                                      ├── pi-driver        (embeds pi SDK)
                                      └── polytoken-driver  ← new
                                            │ HTTP + SSE
                                            ▼
                                 polytoken daemon(s)  (one per warm session)
```

The hub, `SessionState` reducer, protocol, and every client stay **unchanged**.
`PILOT_DRIVER=polytoken` selects it (mirrors the existing `mock` switch in
`README.md` / `config.ts`).

### Daemon process lifecycle (the part pi-driver doesn't need)

pi-driver holds one in-process warm session. PolytokenDriver instead **supervises
child daemon processes**:

1. **Open/warm a session** → spawn `polytoken daemon --project-dir <cwd>
   [--resume --session-id <id>]` (or `polytoken new --no-attach`), capture the
   printed `{session_id, port}`. **[VERIFY]** which entry point is cleanest for a
   supervisor.
2. **Attach** → `POST /tui-attachment/claim` for a lease; heartbeat on a timer
   (`POST /tui-attachment/heartbeat`); release on close
   (`DELETE /tui-attachment/{lease_id}`). *(Mind the harness turn-hygiene lesson:
   a heartbeat timer is a long-lived child — own its lifecycle, clear it on
   session close and on driver shutdown.)*
3. **Subscribe** → open `GET /events` SSE, fan every frame through the event-fold
   into the hub's listener, tagged with this session's `SessionRef`.
4. **Route** → `prompt/abort/model/compact/…` POST to *this session's port*. The
   driver keeps a `Map<SessionId, { port, lease, sse, heartbeat }>`.
5. **Pool policy (D-A — warm pool, decided).** Keep **several** sessions warm at
   once with a default cap + idle reaper, rather than pi-driver's single-warm-
   session swap. polytoken's out-of-process model makes this its natural advantage
   (instant switch, background turns keep running), at the cost of N processes.
   Cap value lands in Chunk 4.

Cold (not-spawned) sessions: list + preview them straight from the sessions
registry / `--sessions-dir` on disk, exactly as pi-driver lists `.jsonl` files
today — no daemon needed until opened.

### Networking — matches pilot's existing Tailscale story

Daemon binds `127.0.0.1` with **no auth**. pilot's own server already terminates
on the mini and is reached over Tailscale; the daemons stay loopback-only and
pilot is their sole network-facing front. **Do not bind daemons to `0.0.0.0`.**
`--listener-fd` means pilot (or a LaunchDaemon, like `com.thiania.remote-control`)
can socket-activate them.

### The event-fold (the real work)

pi's stream is already semantic (`text_delta`, `thinking_delta`,
`tool_execution_{start,update,end}`, `agent_start/agent_end` as turn boundaries),
so `event-map.ts` is a near-stateless 1:1. **polytoken's stream is lower level**
— Anthropic Messages-API-shaped: `message_start` → `content_block_start`
(`ContentBlockKind`: text / thinking / tool_use) → `content_block_delta`
(`BlockDeltaPayload`) → `content_block_stop` → `message_complete`. So the new
mapper is a **small accumulator** in front of the same pure-function pattern:

- Track the current block's `ContentBlockKind` (from `content_block_start`).
- `content_block_delta` on a `text`/`thinking` block → `assistantDelta`
  (`channel` set accordingly) — directly analogous to `event-map.ts:143-157`.
- `content_block_delta` on a `tool_use` block → accumulate the partial JSON input;
  emit `toolStarted` at `content_block_stop` (or on `tool_call`, **[VERIFY]** which
  fires first / authoritatively).
- `message_complete` → `runCompleted` (+ usage snapshot) — the turn-boundary
  choke point, like pi's `agent_end`.

Same testing discipline as `event-map.ts`: a pure `mapDaemonEvent(ev, acc, ctx)`
with a table-driven test per variant (the 56 are enumerated below, so the test
matrix writes itself).

## Mapping A — `PilotDriver` methods → polytoken

| `PilotDriver` | polytoken | Notes |
|---|---|---|
| `subscribe` | `GET /events` (SSE), per daemon, fanned-in | the heart |
| `prompt(text, deliverAs, …, images)` | `POST /prompt`; steering/follow-up via `/turn/input` | `deliverAs: steer\|followUp` ↔ turn-input queue **[VERIFY]**; images ↔ `PromptRequest` content blocks |
| `abort` | `POST /turn/cancel` | |
| `clearQueue` | `DELETE /turn/input/newest` (×n) / `GET /turn/input` then delete | confirm atomic-clear semantics **[VERIFY]** |
| `respondUi` | `POST /interrogative/{id}/respond` (qna/confirm/input/select); `POST /permission-monitor` (approvals) | the Host-UI bridge — see Mapping B |
| `listSessions` | `polytoken sessions` / read `--sessions-dir` | pilot keeps its own archive + worktree index on top |
| `openSession` | spawn `daemon --resume --session-id`; seed from `GET /history` + `GET /state` | seed = the atomic re-broadcast path |
| `reloadSession` | `POST /reload` (or respawn) | |
| `newSession` | `polytoken new --no-attach` / `daemon` (no `--resume`) | worktree creation stays pilot-side |
| `branchFrom` / re-edit | `POST /rewind` → `session_rewound` → re-seed | **D-B**: does `/history` expose a branch DAG (pi's `/tree`) or only linear history? `getTree`/the tree view depends on this — Timo verifies via the polytoken TUI |
| `getTree` | `GET /history` projected | gated on D-B |
| `getUsage` / context meter | `GET /state` | usage in the state snapshot |
| `listModels` / `setModel` | `polytoken models` / `POST /model` | |
| `setThinking` | `POST /model` (reasoning variant) | polytoken models carry "selectable reasoning variants" |
| `compact` | `POST /compact`, `POST /compact/{id}/cancel` | |
| `listCommands` | `polytoken print-slash-commands` (JSON) | CLI dump, cache per cwd |
| `listFileIndex` / `listFiles` | `GET /files` (daemon-native!) or keep pilot's `fd` | daemon has a file index endpoint — may replace pilot's fd index |
| `listDir` / `statPath` | pilot server fs (unchanged) | new-session picker browses the *server* fs; not a daemon concern |
| `renameSession` | `POST /title` (warm) / registry write (cold) | |
| providers / `oauthLogin` | `polytoken auth provider …` + `config` | likely CLI/config, not daemon **[VERIFY]**; MCP OAuth *is* on the daemon (`/mcp/{}/oauth/*`) |
| `listExtensions` / `setExtensionEnabled` | n/a (driver skips pi extensions) | **D-C**: this driver loads no pi extensions — tasklist + ask-user-question are polytoken built-ins; auto-naming is daemon-native (D-C1) |
| (no analog yet) | `POST /facet`, `GET/POST /jobs`, `/subagent/{}/history` | new polytoken concepts — out of scope for v1, candidates later |

## Mapping B — `DaemonEvent` (56) → `SessionDriverEvent` (17)

| polytoken `event.type` | pilot event | Notes |
|---|---|---|
| `session_state_changed` | re-read `GET /state` → `sessionUpdated` | carries an invalidation *domain* string (re-fetch that slice), not the value itself — status itself comes from message/turn events + `/state` |
| `message_start` | — (accumulator: begin msg) | turn start handled via state-change |
| `content_block_start` | — (accumulator: set kind) | `ContentBlockKind` |
| `content_block_delta` | `assistantDelta {channel}` **or** tool-input accrue | text/thinking → delta; tool_use → accrue |
| `content_block_stop` | finalize block → maybe `toolStarted` | |
| `message_complete` | `runCompleted` (+usage) | turn boundary |
| `tool_call` | `toolStarted` | input from accrued block / call args |
| `tool_result` | `toolFinished` | `ToolResultContent`; lift images like `splitToolResult` |
| `tool_reveal`, `tool_exposure_changed` | — (v1 ignore) | tool-visibility metadata |
| `pending_turn_input_*` (queued/dequeued/drained/discarded) | `queueUpdated` / `queuedMessageStarted` | the steer/follow-up queue |
| `turn_cancelled` | `sessionUpdated(idle)` | abort ack |
| `model_error`, `stream_discontinuity`, `retry_wait` | `runFailed` / `hostUiRequest{notify}` | mirror pi's error+auto-retry handling (`event-map.ts:227`) |
| `session_title_changed` | `sessionUpdated(title)` | `source: operator\|inferred` → daemon auto-names natively; `inferred` drives the "auto-named" one-time hint (D-C1) — pilot needs no namer |
| `model_switch` | `sessionUpdated(config)` | |
| `context_cleared` | re-seed / `sessionUpdated` | `/clear` |
| `session_rewound` | re-seed (openSession-style reset) | drives `branchFrom` |
| `compaction_*` (started/complete/cancelled/failed) | `hostUiRequest{notify}` + `usageUpdated` | like pi's `compaction_start` |
| `subagent_compaction_notice` | `hostUiRequest{notify}` | |
| `interrogative`, `ask_user_question` | `hostUiRequest` (input/select/confirm; qna) | `AskUserQuestionPayload`/`ClarificationOption` → pilot's `qna`/`select` cards |
| `permission_monitor_switch` (+ `/permission-monitor`) | pilot **approval cards** (`hostUiRequest{confirm}` / trust channel) | `PermissionToolCallContext`/`PermissionCandidateRuleContext` → pilot's mobile approval UX |
| `notification_queued`, `notifications_drained`, `notification_autodrain_switch` | `hostUiRequest{notify}` / push | feeds pilot's push (`push.ts`) |
| `system_reminder` | `customMessage(display:false)` or ignore | turn-split robustness |
| `hook_fired` | — (v1 ignore) | `HookOutcome` ambient |
| `context_loaded` | `sessionUpdated` / `usageUpdated` | |
| `subagent_started`, `subagent_completed` | `toolStarted`/`toolFinished` (nested) | or a dedicated subagent view (`/subagent/{}/history`) |
| `subsession_*` (created/stopped/terminated/interrogative/message) | session-list updates / nested | polytoken swarm orchestration; v1 surface minimally |
| `mcp_server_*` (connected/disconnected/reconnecting/disabled) | Settings MCP status | new ambient channel or reuse `extensionCompatibilityIssue` |
| `image_reference_resolved` | (feeds `images` on messages/tools) | |
| `extension_registered` | refresh `listExtensions` | |
| `facet_switch`, `classifier_decision`, `job_*` | — (v1 ignore) | new concepts, later |
| `heartbeat` | — (liveness only) | also confirms SSE alive |

17 pilot event types are comfortably covered; the unmapped polytoken variants are
either new concepts (facets, jobs) or ambient metadata safely ignored in v1.

## Settled decisions (2026-06-28, with Timo)

- **D-A — Warm pool. ✅** Keep several polytoken daemons warm (default cap + idle
  reaper) rather than pi-driver's single-warm-session swap. polytoken's
  out-of-process model makes this its natural advantage: instant session switch,
  background turns keep running. Cap value lands in Chunk 4.
- **D-B — Adapt to polytoken's history model. ✅ (constraint, not a choice)** Pilot
  bends to whatever `GET /history` actually exposes. Branch DAG → the `/tree` view +
  `branchFrom` re-edit port over; linear-only → `POST /rewind` still gives
  jump-back / re-edit, and the tree *view* is cut from v1. **Timo verifies the
  history model directly via the polytoken TUI**; the driver is written to the
  confirmed shape once known. (See [HISTORY-MODEL] in Risks.)
- **D-C — Skip pi extensions entirely. ✅** The PolytokenDriver loads **no** pi
  extensions. Two of pilot's three owned extensions are **polytoken built-ins** —
  the task list and `ask_user_question`/`interrogative` are native daemon events,
  which pilot maps onto its existing tasklist widget + `qna`/`select` cards (no
  bespoke `ctx.ui.qna` bridge needed). This *advances* the self-contained goal:
  `PLAN-self-contained-extensions.md` becomes pi-driver-only.
- **D-C1 — Auto session naming: daemon-native, pilot does nothing. ✅** The one
  extension with no built-in twin was `session-namer` — but polytoken **auto-names
  natively**. `TitleChangeSource` is `"operator" | "inferred"`, where `inferred`
  is *"the daemon inferred the title automatically."* pilot just consumes
  `session_title_changed`; the `source` discriminator drives the one-time
  "auto-named" hint the enum is explicitly designed for. pilot's
  `background-model.ts` namer path is simply unused under this driver. **[VERIFY]**
  inferred-naming is on by default (not gated behind config).
- **D-D — Prototype first, evaluate when dogfoodable. ✅** Build toward a
  *dogfoodable* prototype and let Timo live on it before judging; don't chase full
  pi-parity up front. Parity gaps that don't block dogfooding (tree view if D-B
  says linear, jobs, facets, subagent drill-down) wait.

## Risks & unknowns

- **Reverse-engineered contracts.** Built from schemas, not a running daemon or
  docs. Chunk 0 must de-risk before any real code. (Loud-failure principle: the
  spike should *assert* the inferred shapes and crash on mismatch, not paper over.)
- **Process supervision surface.** N child daemons = lifecycle, zombie reaping,
  port tracking, lease heartbeats, crash-restart. New failure modes pi-driver's
  in-process model doesn't have (offset by isolation: a daemon crash can't take
  pilot down).
- **Contract drift.** polytoken `v0.3.3`, daemon API `0.1.0` — early, will move.
  Mitigation: codegen pilot's polytoken types from `polytoken openapi` /
  `event-schema` and pin a version check in `doctor`.
- **Two-driver maintenance.** Keeping both pi and polytoken drivers behind the seam
  doubles surface. Decide early whether this is additive or a migration.
- **`tui-attachment` semantics.** If the lease is single-holder, "TUI + pilot at
  once" doesn't hold and pilot must be the exclusive attacher.
- **[HISTORY-MODEL] (D-B).** Whether `GET /history` is a branch DAG or a linear log
  decides if the tree view ships in v1. Timo confirms via the polytoken TUI; until
  then the driver targets the linear subset (open/rewind/re-edit), and the tree
  view is additive once the shape is known.

## Phased plan

- **Chunk 0 — Spike (no pilot code).** Configure polytoken on the mini
  (`polytoken config ui`), spawn a daemon, drive it with `curl`: claim a lease,
  `POST /prompt`, read the `/events` SSE by hand, `POST /turn/cancel`. **Assert**
  every **[VERIFY]** above (process-per-session, prompt/steer shape, interrogative
  + permission payloads, history-is-DAG?, lease multi-client). Output: a short
  `docs/polytoken-spike.md` of confirmed shapes. *Gate: nothing below starts until
  this lands.*
- **Chunk 1 — Codegen + skeleton.** Generate TS types from `polytoken openapi` +
  `event-schema`. `PolytokenDriver implements PilotDriver` with a one-session
  happy path: spawn, attach+heartbeat, subscribe, `prompt`, `abort`. `PILOT_DRIVER=
  polytoken` switch.
- **Chunk 2 — The event-fold.** `mapDaemonEvent` accumulator + a table-driven test
  per variant (model `event-map.test.ts`). Streaming text/thinking, tools,
  turn boundaries, queue, errors/retries green against the mock-equivalent.
- **Chunk 3 — Host UI + permissions.** `interrogative`/`ask_user_question` →
  pilot's `qna`/dialog cards; `permission-monitor` → approval cards. This is what
  makes phone-driving usable.
- **Chunk 4 — Sessions & lifecycle.** list/open/new/reload/rename, the warm pool
  ([OPEN A]), cold-session previews from the registry, worktree integration
  (pilot-side).
- **Chunk 5 — Settings & polish.** models/thinking, providers (CLI/config), MCP
  status, compaction, context meter, `branchFrom`/tree if [OPEN B] allows.

## Effort read

Smaller than the original pi integration, despite the new process-supervision
layer — because the daemon owns server-side everything pi-driver hand-rolls in
~1880 lines (session warm-up, history, todos, compaction, MCP). The honest cost
centers are **(1)** the event-fold accumulator (Chunk 2) and **(2)** child-daemon
supervision (Chunk 4). Net: a credible "thin client over a documented daemon,"
which is the whole reason polytoken is interesting here.

## Status: ready for Chunk 0

Design questions resolved (D-A…D-D). Next step is the **Chunk 0 spike**: drive a
live daemon by hand and assert the remaining **[VERIFY]** shapes (process-per-
session, prompt/steer payloads, interrogative + permission shapes, default-on
auto-naming, lease multi-client). Timo verifies the **history model** (D-B) in
parallel via the polytoken TUI. Findings land in `docs/polytoken-spike.md` before
any `PolytokenDriver` code.

**Gating dependency:** Chunk 0 needs polytoken *configured* (provider auth). That
step is partly Timo's — `polytoken config ui` is interactive and provider
credentials are his. Path: Timo runs `polytoken config ui` (or I scaffold a config
non-interactively from `polytoken schemas` + `config edit --user` and he adds
auth), then the curl-spike is fully automatable.

---

*Sibling docs: `DESIGN.md` (pilot architecture), `PLAN-self-contained-extensions.md`
(the pi-extension dependency this would sidestep), `DECISIONS.md`.*
