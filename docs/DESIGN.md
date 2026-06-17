# Pilot — Design & Feature Catalog

A personal, single-user remote-control web UI for the **pi** coding agent. pi runs
on a Mac Mini; you drive it from a work MacBook browser and a phone over Tailscale.
Default look/feel mirrors the Claude app; pi extensions stay at least visible.

> Decisions are in `DECISIONS.md`; questions awaiting your input in `OPEN-QUESTIONS.md`.
> This file is the architecture + the long feature roadmap.

## Architecture

```
                         Mac Mini  (server: Bun + TS, embeds pi SDK)
  ┌───────────────────────────────────────────────────────────────┐
  │  pi-sdk-driver (forked from pi-gui)                            │
  │    └─ AgentSession (in-process)  ──subscribe()──┐             │
  │         · prompt / steer / followUp / abort      │            │
  │         · ExtensionUIContext (pilot-supplied)    ▼            │
  │                                          ┌───────────────────┐ │
  │  SERVER-AUTHORITATIVE STATE  ◄───fold────┤ event → transcript│ │
  │   · transcript[] per session             │  reducer (shared) │ │
  │   · live flags (isStreaming, model…)     └───────────────────┘ │
  │   · pendingApprovals: Map<id, HostUiRequest>                  │
  │   · ambient: statuses{}, widgets{}, title  (keyed maps)       │
  │                          │                                     │
  │             broadcast events + snapshot-on-connect            │
  │                          │   (fan-out; never block the agent   │
  │                          ▼    on a slow client)                │
  │            WebSocket server  +  /debug/state  +  auth-token    │
  └──────────────────────────┼────────────────────────────────────┘
                             │  Tailscale (tailscale serve, TLS)
            ┌────────────────┴───────────────┐
            ▼                                ▼
     MacBook browser                    Phone (PWA)
   THIN CLIENT (Svelte 5)            THIN CLIENT (Svelte 5)
   · folds same events locally       · same; per-client view state
   · renders transcript + deltas       (selection, composer draft,
   · taps answer approvals             sidebar) stays LOCAL, not shared
```

**Load-bearing principle:** split **durable shared state** (sessions, transcripts,
statuses, pending approvals — server-owned, broadcast) from **per-client view
state** (selection, composer draft, sidebar — client-local). At the protocol level.

**Three things the server must own** because pi can't replay them:
1. **Pending approvals** — `hostUiRequest` dialogs are not re-emitted; cache id+payload,
   re-push on reconnect, send `cancelled` on disconnect/timeout (deny = safe default).
2. **Snapshot** — authoritative in-memory transcript (seed from `get_messages`), never
   tail the live `.jsonl` (racy).
3. **Ambient UI** — `setStatus`/`setWidget` as keyed maps that survive across turns.

## Protocol (the WS contract)

Vendored from pi-gui's `session-driver`:
- `SessionDriverEvent` — `sessionOpened`, `sessionUpdated`, `assistantDelta`,
  `queuedMessageStarted`, `toolStarted`, `toolUpdated`, `toolFinished`,
  `runCompleted`, `runFailed`, `hostUiRequest`, `extensionCompatibilityIssue`,
  `sessionClosed`.
- `HostUiRequest` — `confirm` · `input` · `select` · `editor` (BLOCKING dialogs) ·
  `notify` · `status` · `widget` · `title` · `editorText` · `reset` (fire-and-forget).
- `HostUiResponse` — `{value}` | `{confirmed}` | `{cancelled}`.

Wrapped in a pilot envelope: `ServerMessage` (`hello`, `snapshot`, `event`,
`error`) and `ClientMessage` (`subscribe`, `prompt`, `steer`, `followUp`, `abort`,
`respondUi`, …). A shared `foldEvent(state, event)` reducer lives in `protocol/`
and runs identically on server (authoritative) and client (incremental render).

## Feature catalog

Tiers: **MUST** (MVP) · **SHOULD** (fast-follow) · **LATER**.

### Transcript & rendering
- Stream assistant text deltas incrementally; render markdown + code highlight — MUST
- Render thinking deltas separately, collapsible — MUST
- Tool-call cards keyed by `callId`; overwrite body on each update; done/error on end — MUST
- Server-side event→transcript fold → one consistent assembled transcript — MUST
- Virtualized transcript list (>80 rows) — SHOULD
- Activity / summary / compaction rows — SHOULD

### Prompt / turn control
- Send prompt when idle (`prompt()` 1:1) — MUST
- Gate on `isStreaming`: route mid-stream input as `steer` / `followUp` — MUST
- Steer-vs-followUp affordance in composer — MUST
- Drive turn UI from lifecycle events; prompt success = "accepted" not "complete" — MUST
- Abort current run — MUST
- Queued-messages editing (replace queued) — SHOULD
- Slash-command menu (`get_commands`) + @-file mention menu — SHOULD
- Image / file attachments (browser file input) — LATER
- `bash` affordance (result in response, enters next-turn context) — LATER

### Approvals & interaction
- Render `confirm`/`select`/`input`/`editor` as first-class mobile cards — MUST
- Generic fallback card (method + JSON dump + Cancel) for unknown methods — MUST
- Project-trust select rendered distinctly (the one first-run gate) — MUST
- Always send `cancelled` for dismissed/abandoned dialog ids — MUST
- Binary 2-option select → Yes/No card — SHOULD
- Countdown for dialogs carrying a timeout — SHOULD
- ~~Per-tool / per-dangerous-command approval gate~~ — DROPPED (D9: no tool gating; isolation via containers, D10)
- Wire pi's `project_trust` event → trust card (replaces the mock-only card) — MUST (D12)

### Status & notifications
- Working spinner derived from lifecycle events — MUST
- Ambient maps: `status`→strip, `widget`→above/below composer, `notify`→toast — MUST
- `title`→tab title; `editorText`→prefill composer — SHOULD
- Notification API when tab open + approval pending / run done — SHOULD
- Web Push (SW + VAPID + subscription store) for backgrounded phone — NEXT (D11; spike on a real iPhone first)

### Sessions & history
- Bootstrap snapshot via `get_state` + `get_messages` — MUST
- Snapshot-on-reconnect: transcript + live flags + pending approvals — MUST
- Session list/picker grouped by cwd — MUST
- Create / open / rename / archive / unarchive — SHOULD
- Read idle sessions from `.jsonl` directly — SHOULD
- Session tree navigation / fork / clone / compaction — LATER
- Scheduled / recurring runs — LATER

### Extensions visibility
- Attach tool label+description from in-process `getAllTools()` to tool events — MUST
- Render tool results from content text + details JSON, strip ANSI — MUST
- Extensions enable/disable view + compatibility-issue surfacing — SHOULD
- Skills enable/disable view — LATER

### Multi-client / sync
- Split durable shared vs per-client view state — MUST
- Fan-out: one internal `subscribe()` per session → broadcast channel — MUST
- First-responder-wins approvals (accept only if id still pending) — MUST
- Re-subscribe after every newSession/switchSession/fork/import — MUST
- Drain agent events into in-memory buffer; never backpressure the agent — MUST
- Multiple concurrent live sessions streaming — MUST (D8; hub keyed per session, `sessionRef` on client→server msgs)

### Remote / transport / deploy
- WS server + reconnecting client (backoff, visibility pause/resume) — MUST
- Tagged-enum protocol mirrored as TS discriminated union — MUST
- `tailscale serve` TLS WS at root; bind to tailnet iface not 0.0.0.0 — MUST
- launchd / brew-services auto-start (native arm64) — SHOULD
- Raise/chunk 64KB WS frame cap for snapshots — SHOULD

### Security / isolation
- App-level auth token (Tailscale is network ACL, not auth) — MUST
- Explicit trust policy in non-interactive mode — MUST
- Honest boundary copy ("sandboxed" ≠ working-tree safe) — MUST
- ~~Host-side sandbox extension + `sandbox.json`~~ — DROPPED (D10: no host-side sandbox-exec)
- Interim isolation: run autonomous sessions under a limited-permission Mac Mini user account — MUST (D10)
- gondolin micro-VM via the pi-gondolin extension (egress allowlist + scoped secrets; preserves TS-embed) — LATER spike (D10)

### PWA / mobile
- PWA bundle (manifest, SW, wakelock) — MUST
- Mobile-first approval cards + composer (thumb-reachable) — MUST
- Install-to-home-screen (prereq for iOS Web Push) — SHOULD

### Diffs (deferred)
- Inline tool-diff rendering — LATER
- Workspace git changed-files/diff/stage panel (server-side git) — LATER

### Verification / testing harness
- Browser-screenshot verification loop (Claude_Preview) — MUST (M0)
- Mock-pi fixture: deterministic event sequences per UI state — MUST
- Integration harness: real WS clients on ephemeral port — SHOULD
- E2E scenarios (parallel no-event-bleed, steer/followUp, dialogs, reopen) — SHOULD

## Build sequence (each milestone = a running, screenshot-verifiable app)

- **M0** Skeleton + verification harness. Bun WS server emits canned events from
  the **mock-pi fixture** (no real pi). Svelte client folds + renders a static
  transcript. Screenshot loop stood up. *Verifies the rendering pipeline before pi.*
- **M1** Real pi, read-only. Embed forked `pi-sdk-driver`; bootstrap snapshot;
  stream live deltas + tool cards. No sending yet.
- **M2** Prompt + turn control. Composer, `prompt`/steer/followUp gating, abort.
- **M3** Approvals. `ExtensionUIContext`; dialog cards + fallback + trust card;
  pendingApprovals map; first-responder-wins.
- **M4** Multi-client + reconnect hardening. Durable vs per-client split; snapshot
  replay; two clients stay consistent.
- **M5** Sessions & history. List, open/create/rename/archive, idle file reads.
- **M6** Security hardening. Auth token, tailscale serve, launchd, sandbox.
- **M7** Notifications + extension-visibility polish.
- **LATER** diffs, session tree/fork, scheduled runs, attachments.

## Revised next steps (2026-06-17, after OQ resolutions D7–D14)

M0–M5 are largely built (see `STATUS.md`). The owner's review re-prioritized the
remaining work. New ordering:

1. **iOS Web Push spike** (D11) — SW `push`/`notificationclick` handlers, VAPID
   keys, subscription endpoint + store, server push sender, a test trigger. The
   real test is *on the owner's iPhone* (installed PWA). Validate early because
   it's the most-differentiating + most-likely-to-fail feature.
2. **Persistence rework** (D13) — swap the driver onto a persistent
   `SessionManager.create(cwd)`; discover existing sessions
   (`list`/`listAll`); resume (`open`/`switchSession`); rebuild pilot's
   in-memory state from pi's session files on load.
3. **Multi-session** (D8) — hub keyed per session; add `sessionRef` to
   client→server messages; session list/picker drives N live sessions.
4. **Wire real project-trust** (D12) — `project_trust` handler → trust card,
   replacing the mock-only fixture; this is the safety net for arbitrary-path
   opening (D12) given no tool gating (D9).
5. **Live pi bring-up** — first real turn against provider credentials.
6. *(later lane)* gondolin egress containment for the autonomous account (D10).
