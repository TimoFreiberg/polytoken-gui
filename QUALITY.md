# Pantoken — Quality Gate

Stable product invariants that every change must respect. These are the
hard rules agents build and review against; they complement automated
tests (which cover some but not all cases, and can't anticipate every new
code path). The project-specific `quality-review` skill checks the
applicable subset of these criteria on every diff.

Each criterion has an **applicability tag** so reviewers only check what
matters for the change at hand:

- `[UI]` — client-side UI / Svelte / CSS / DOM
- `[server]` — Rust server (`server-rs/`)
- `[proto]` — protocol / wire types (`protocol/`)
- `[cross]` — applies regardless of layer

Open product questions that haven't been settled live in `docs/TODO.md`
(marked "discussion needed"), not here. This file is only for invariants
we've committed to.

---

## UI & client

### Q1 — TUI feature parity (desktop) `[UI]`
The desktop GUI must faithfully implement every feature the polytoken TUI
has. Extra features are welcome; missing TUI features are a gap.

### Q2 — Mobile feature availability `[UI]`
The mobile GUI can adapt to the form factor, but all core features must
be available in some way.

### Q3 — No silent data loss `[UI] [cross]`
User-entered data should never be lost by the GUI. This primarily covers
the prompt composer, but also: model selection in the new-session draft,
effort level, facet — any user-set value must survive navigation and
reload.

### Q4 — No surprising state changes `[UI] [cross]`
GUI state should not change without user input. The only exceptions are
agent-driven overlays that show the user something (question/answer form,
proposed plan). Background session activity must never interfere with the
rest of the app state, with two allowed exceptions:
- A subtle visual cue in the sidebar (yellow notification dot next to the
  session title, possibly a subtle flash).
- Desktop notifications for incoming questions (must be configurable).
- Being in the new-session draft view counts as not having any session
  focused.

### Q5 — Overlays must not block ongoing work `[UI]`
Permission pop-ups, question/answer forms, and plan pop-ups must never
prevent the user from continuing what they were doing. It must always be
possible to, e.g., minimize the question/answer form and keep typing in
the composer.

### Q6 — Persist GUI-local state `[UI]`
Anything set in the GUI that isn't persisted by the agent backend (sidebar
expand/collapse, archived sessions, new-session composer draft, etc.) must
be persisted to localStorage on a best-effort basis. This is not a
transactional database, but losing work erodes trust.

### Q7 — Un-brickable `[UI]`
It must not be possible to brick the installation and require manual
editing of config files. E.g., the sidebar must not be draggable to a
width where the resize handle becomes unreachable.

### Q8 — Bound displayed data `[UI]`
When displaying data of unknown size (error messages, stack traces, raw
daemon output), always bound it. No multi-screen pop-ups. Show a
hardcoded summary message ("Error communicating with agent daemon") and
put the full detail in the server log.

### Q9 — Show everything the daemon emits `[UI] [cross]`
Make a strong attempt to show everything the daemon SSE events expose.
Default approach for unknown or large data: a shortened title with the
full data available on hover or in a click-pop-up.

### Q10 — Overlays above, not on top `[UI]`
Prefer displaying overlays (question/answer form, etc.) above the
composer rather than directly on top of it, so a user typing isn't
completely interrupted. *(This is a settled default; if a concrete
drawback emerges, revisit via `docs/TODO.md`.)*

---

## Server (Rust)

### Q11 — Reliability over performance `[server]`
The server must always work. Never panic if avoidable — prefer complex
error handling over panics that cause random crashes. Startup crash on
truly invalid config is acceptable; runtime panics are not.

### Q12 — Daemon disappearance is visible `[server] [UI]`
If the polytoken binary disappears while the server is running, the user
should see it in the GUI (not silent dead buttons).

### Q13 — No `unsafe` `[server]`
No `unsafe` if at all possible. Reliability is more important than the
performance `unsafe` might buy.

### Q14 — Avoid unnecessary large clones `[server]`
Reasonably high performance Rust. No raw-pointer micro-optimization, but
avoid wildly unnecessary clones of large strings and buffers.

### Q15 — Thorough, classified error handling `[server]`
Errors we've built support for must be displayed nicely in the UI. Most
errors in normal operations should be shown clearly. Unexpected errors
handled by a fallback path must always be displayed in a way the user
notices something is going on.

### Q16 — Bounded memory `[server]`
Keep as little data in memory as necessary for smooth and correct
operation. Evict data that's no longer needed. Keeping session contents
warm for fast back-and-forth switching is fine, but the number of warm
sessions must be bounded.

### Q17 — No Tokio Mutexes `[server]`
Do not use Tokio Mutexes. No exceptions. (See `docs/DECISIONS.md`.)

### Q18 — Tracing discipline `[server]`
The operator won't look at the logs for informational stuff, so don't
log informational output via tracing. Do log what helps diagnose error
cases. This is a developer tool — logs are expected when diagnosing
problems.

---

## Cross-cutting

### Q19 — Forward compatibility `[cross]`
Newer versions of polytoken arrive frequently. Be forward-compatible if
reasonably possible. Maintain a workflow to update the API based on the
self-describing CLI methods of the polytoken binary.

### Q20 — Visual direction: follow Codex Desktop `[UI]`
Wherever possible, follow the lead of the Codex Desktop app. Not a 100%
copy; 80–90% is fine.

### Q21 — Agent-built quality `[cross]`
This repo is fully agent-built and reviewed only by agents. All quality
comes from agent tooling and the quality of feature descriptions. When
reviewing, hold the line on these criteria — there is no human backstop.
