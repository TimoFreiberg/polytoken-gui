# Plan — Strip pi from the polytoken-only branch

> **Status: prepared, not started.** Awaiting operator's "go" (a parallel implementor
> is still working; starting now would conflict). This branch keeps `main` as the
> home of the pi driver — deletion here is cheap to restore via `jj`.
>
> Scope intent (operator): *"full deletion of any remnants of pi"* to *explore
> polytoken viability quickly.* This plan favors a **clean, fast viability path**:
> relocate the handful of agent-agnostic utilities the polytoken driver already
> depends on, then delete everything truly pi-coupled. Two cross-cutting pi-features
> (login-env, background-model) that live in the hub/protocol wire are flagged as a
> **decision** — fast-stub vs. rip-from-wire — because ripping them touches the
> client and the WS contract (bigger, riskier for a "quick" spike).

## Goal

Remove every pi (the `@earendil-works/pi-*` / `@mariozechner/pi-*` SDK) coupling from
this branch so the workspace runs **polytoken-only** (plus the existing mock driver
for dev/e2e): no pi dependency, no pi driver, no pi extensions, no pi-SDK type imports,
`bun install` / `bun run check` / `bun test` / `bun run test:e2e` all green with pi gone.

## Implementation Summary

The pilot driver seam (`server/src/driver.ts` → `PilotDriver`) already has two clean
implementors — `mock` and `polytoken` — that import **zero** pi-SDK packages. The
blocker to "delete pi" is that `server/src/pi/` is not purely pi-coupled: it also holds
~4 agent-agnostic utility modules the polytoken driver and the hub import today.

So the work is: **(A)** relocate those shared utilities out of `pi/`, **(B)** delete the
genuinely pi-coupled code, **(C)** sever the pi driver-selection branch + pi deps +
build config, **(D)** decide the hub's two pi-features, **(E)** light doc touch.

### Affected touch points

| Area | Action |
|---|---|
| `server/src/pi/` (49 files) | Delete entirely *after* relocating the 4 shared modules it contains |
| `server/src/shared/` (new) | Home for relocated agent-agnostic utils |
| `server/src/polytoken/polytoken-driver.ts` | Update 3 imports (`../pi/` → `../shared/`) |
| `server/src/hub.ts` | Update 2 imports; gate the 2 pi-features per the decision |
| `server/src/index.ts` | Remove the pi driver branch; `PILOT_DRIVER=pi` → hard error; default to polytoken |
| `server/src/worktree-store.ts` + test | Update `WorktreeMeta` import path |
| `server/package.json`, root `package.json` | Drop `@earendil-works/pi-coding-agent` dep + patched patch |
| `bunfig.toml` | Drop pi cooldown-exclude list |
| `tsconfig.extensions.json` | Delete (typechecks the now-deleted `pilot/extensions/`) |
| `pilot/extensions/` (answer, tasklist, session-namer) | Delete (pi-SDK-coupled, dead under polytoken per design D-C) |
| `patches/@earendil-works%2Fpi-ai@0.80.2.patch` | Delete |
| `bun.lock` | Regenerate via `bun install` |
| `scripts/live-switch.ts`, `live-warm-toggle.ts`, `live-prompt.ts` | Delete (pi-driver live-check tools; assume `PILOT_DRIVER=pi` + `~/.pi`) |
| `AGENTS.md` | Update the pi-specific "Facts" + "Stack" sections for polytoken-only |

### Non-goals (flagged follow-ups, NOT this spike)

- Rewriting `docs/{DECISIONS,DONE,TODO,STATUS,PLAN-*,OPEN-QUESTIONS}.md` and
  `initial-handoff.md` — these are historical records; leaving as-is with a note.
- Re-basing the mock driver's extension simulation on polytoken's reality (it still
  models pi-era `answer`/`tasklist`/`session-namer` extensions; harmless for dev/e2e,
  pi-import-free).
- Removing `protocol/src/pilot-extensions.ts` (the `PILOT_OWNED_EXTENSION_NAMES` list) —
  the mock driver + hub still reference it; it's a plain string list, agent-agnostic.

## Implementation Plan

### Phase 0 — Classify `server/src/pi/` (reference, already done in planning)

The 49 files in `server/src/pi/` split into three buckets:

**Bucket 1 — agent-agnostic utilities the polytoken path needs (RELOCATE):**
- `worktree.ts` — VCS worktree create/remove (imports: node only). Used by
  `polytoken-driver.ts` + `worktree-store.ts`.
- `worktree-name.ts` — `randomWorktreeName` (pure). Used by `worktree.ts`.
- `warm-cap.ts` — `evictionPlan` (pure). Used by `polytoken-driver.ts`.
- `session-list.ts` — `mergeSessionLists` (pure, deps only `@pilot/protocol`). Used by
  `polytoken-driver.ts`. **Note:** the same file also exports `firstUserPreview`, which
  depends on `history-map.ts` (`contentToText`/`HistoryMessage`) and is used **only by
  `pi-driver.ts`** → drop `firstUserPreview`, keep only `mergeSessionLists`.

**Bucket 2 — pi-feature code the hub imports unconditionally (DECISION D-1):**
- `login-env.ts` — reconstructs interactive-shell env for the in-process pi agent
  (polytoken daemons are out-of-process; irrelevant under polytoken). Hub's
  `pilotSettingsMsg` calls `getLoginEnvStatus`/`resolveLoginShell`.
- `background-model.ts` — resolves a model spec for pilot's **own pi extensions**'
  out-of-band LLM calls. Under polytoken, pilot loads no pi extensions (design D-C) and
  the daemon auto-names natively (D-C1), so this is entirely dead. Hub's `pilotSettingsMsg`
  calls `resolveBackgroundModel`.

**Bucket 3 — genuinely pi-SDK-coupled (DELETE):**
- `pi-driver.ts` (the 1880-line driver; imports `@earendil-works/pi-coding-agent`)
- `event-map.ts` + test (maps `AgentSessionEvent`)
- `tree-map.ts` + test (maps `SessionEntry`; note: `/tree` branch view is cut under
  polytoken — design D-B — so polytoken has no tree-map equivalent)
- `history-map.ts` + tests (pi history replay; polytoken has its own `history-seed.ts`)
- `trust.ts`, `ui-bridge.ts` (+ coupling test) (import pi's `ExtensionUIContext`/trust types)
- `model-config.ts` + test (pi's curated provider set)
- `mcp-cwd-workaround.ts` + test (pi MCP config override)
- `queue-map.ts` + test, `queued-delivery.ts` + test, `branch-ids.ts` + test,
  `user-message-count.ts` + test, `unsupported-host-ui.ts` + test,
  `content.ts` + test (pi-specific replay helpers; polytoken has its own)
- `background-model-warmup.test.ts`, `history-map-shape.test.ts` (pi-shape guards)

### Phase 1 — Relocate shared utilities (do this FIRST, before any deletion)

1. Create `server/src/shared/`.
2. Move + lightly edit:
   - `server/src/pi/worktree.ts` → `server/src/shared/worktree.ts`
     (fix internal import `./worktree-name.js` — stays same dir).
   - `server/src/pi/worktree-name.ts` → `server/src/shared/worktree-name.ts`.
   - `server/src/pi/warm-cap.ts` → `server/src/shared/warm-cap.ts`.
   - Extract **only `mergeSessionLists`** from `server/src/pi/session-list.ts` into
     `server/src/shared/session-list.ts`. Drop `firstUserPreview` (pi-only). Move the
     `mergeSessionLists` tests from `session-list.test.ts`; drop the `firstUserPreview`
     tests.
3. Move the corresponding tests for worktree/worktree-name/warm-cap to `shared/`.
4. Update consumers:
   - `server/src/polytoken/polytoken-driver.ts`: `../pi/worktree.js` → `../shared/worktree.js`;
     `../pi/warm-cap.js` → `../shared/warm-cap.js`; `../pi/session-list.js` → `../shared/session-list.js`.
   - `server/src/worktree-store.ts` + `worktree-store.test.ts`: `./pi/worktree.js` → `./shared/worktree.js`.
5. **Verify Phase 1 in isolation:** `bunx tsc --noEmit -p server/tsconfig.json && bun test server/src/shared`.
   This de-risks deletion — once these recompile and pass, the polytoken path no longer
   touches `pi/`.

### Phase 2 — Handle the hub's two pi-features (per decision D-1)

**Recommended (fast viability):** relocate `login-env.ts` and `background-model.ts` to
`server/src/shared/` too (they are pi-SDK-import-free — only node + `@pilot/protocol` +
`settings-store`). The hub keeps calling them; under polytoken they return inert defaults
(login-env: `activeShell:null` → no pending-restart flag; background-model: null spec →
no warning). The client Settings sections for "login shell" and "background model" stay
present but dormant. Update hub imports to `../shared/`.

**Alternative (clean, bigger):** remove both from `hub.ts`'s `pilotSettingsMsg`, drop
the `env`/`pendingRestart`/`backgroundModelWarning` fields from the `pilotSettings` wire
message (`protocol/`), and rip the corresponding Settings.svelte + store sections. This is
a cross-cutting protocol change — higher risk, better suited as its own focused change.

→ **See Risks: D-1.** Implementor follows whichever the operator confirmed.

### Phase 3 — Delete `server/src/pi/` (and its tests)

After Phase 1 (+ Phase 2 if relocate) confirms nothing imports from `pi/`:
1. `rm -r server/src/pi/`.
2. Confirm `server/tsconfig.json` `include` no longer references it (it uses `src` glob,
   so just drops out).
3. Grep the whole repo for any lingering `./pi/` or `../pi/` import — must be zero.

### Phase 4 — Sever the pi driver-selection branch + remove deps

1. `server/src/index.ts`: replace the driver-selection block. New default = polytoken:
   ```ts
   if (process.env.PILOT_DRIVER === "mock") {
     mock = new MockDriver(); driver = mock;
   } else {
     if (process.env.PILOT_DRIVER === "pi")
       throw new Error("pi driver removed on this branch — use 'mock' or 'polytoken' (default)");
     const { createPolytokenDriver } = await import("./polytoken/polytoken-driver.js");
     driver = await createPolytokenDriver();
   }
   ```
   (Loud failure, per the repo's crash-don't-swallow philosophy.)
2. Update the startup log's driver label to drop the `"pi"` case.
3. `server/package.json`: remove `"@earendil-works/pi-coding-agent"`.
4. Root `package.json`: remove `patchedDependencies` (the pi-ai patch).
5. `bunfig.toml`: remove the `minimumReleaseAgeExcludes` pi list (leave the cooldown itself).
6. Delete `tsconfig.extensions.json`; remove it from the `check` script in root `package.json`.
7. Delete `patches/@earendil-works%2Fpi-ai@0.80.2.patch` (and `patches/` if empty).
8. `bun install` to regenerate `bun.lock` (drops all `@earendil-works/pi-*` + transitive
   `@mariozechner/clipboard*` native bins + typebox).

### Phase 5 — Delete pi-owned extensions + pi live-check scripts

1. `rm -r pilot/extensions/` (answer.ts, tasklist.ts, session-namer.ts — all pi-SDK-coupled,
   dead under polytoken per design D-C).
2. Delete `scripts/live-switch.ts`, `scripts/live-warm-toggle.ts`, `scripts/live-prompt.ts`
   (pi-driver live-check tools; they document `PILOT_DRIVER=pi` + `~/.pi/agent/sessions`).
3. `protocol/src/pilot-extensions.ts`: **keep** (mock + hub still use it; it's a harmless
   string list). Optionally add a TODO comment that the names are pi-era and unused under
   polytoken.

### Phase 6 — Light documentation touch

1. `AGENTS.md`: rewrite the "Facts that save you a wrong turn" section (currently entirely
   about the pi SDK identity + `~/src/pi`) and the "Stack & layout" driver bullets to
   describe the polytoken daemon as the live driver, mock for dev/e2e. Drop the
   `tsconfig.extensions.json` line from Commands.
2. Add a one-line note atop `docs/DECISIONS.md` / `docs/DESIGN.md`: *"This branch is
   polytoken-only; pi-coupled decisions are historical."* (Do NOT rewrite the bodies.)
3. Leave `initial-handoff.md`, `docs/{DONE,TODO,STATUS,PLAN-*,OPEN-QUESTIONS,polytoken-spike}.md`
   as historical record.
4. `protocol/src/session-driver.ts` header comment: drop the "Vendored from pi-gui"
   framing (it is now pilot's own WS contract) — optional, cosmetic.

### Phase 7 — Verify end to end

Run the full green-suite (see Test Strategy). Fix any stragglers (likely: a stray import,
a fixture string, an e2e spec that asserted on the now-removed pi driver label).

## Acceptance Criteria

- **AC.1** `grep -r "@earendil-works\|@mariozechner/pi-\|pi-coding-agent\|pi-ai\|pi-agent-core\|pi-tui" --include=*.ts --include=*.svelte --include=*.js --include=*.json --include=*.toml .` returns **zero** hits in source/config (historical `docs/*.md` and `bun.lock` excluded — though `bun.lock` should also be clean after regenerate).
- **AC.2** `grep -rn "from \"\./pi/\|from \"\.\./pi/" server/src client/src protocol/src` returns **zero**.
- **AC.3** `server/src/pi/` does not exist; `pilot/extensions/` does not exist; `patches/` is empty or absent; `tsconfig.extensions.json` absent.
- **AC.4** `bun install` succeeds and `bun.lock` contains no `@earendil-works/pi-*` or `@mariozechner/clipboard*` entries.
- **AC.5** `bun run check` is green (protocol + server + scripts + e2e + client typechecks; the extensions step is gone).
- **AC.6** `bun test` is green (relocated shared-module tests pass; pi-coupled tests are gone).
- **AC.7** `PILOT_DRIVER=mock bun run dev` boots and serves the client (mock path unaffected).
- **AC.8** `bun run test:e2e` is green (Playwright, mock driver, desktop + mobile projects).
- **AC.9** `PILOT_DRIVER=pi bun run --cwd server start` **fails loud** with the removed-driver error (not a silent fallthrough).
- **AC.10** Default `bun run dev` (no `PILOT_DRIVER`) selects polytoken and the server starts (connects to a polytoken daemon when one is available; this is the viability check — confirm it at least boots the driver constructor without importing pi).

## Test Strategy

Mirrors the acceptance criteria. The repo's existing harness is the validation:

- **Type safety:** `bun run check` is the primary gate — it typechecks protocol, server,
  scripts, e2e, and client. The `tsconfig.extensions.json` step is removed. This is what
  catches lingering pi-SDK type imports.
- **Unit:** `bun test` — relocated `shared/` tests must pass; all deleted pi tests are gone
  (so a pass means no orphaned references). `bun test server/src/shared` in isolation
  after Phase 1 de-risks the deletion.
- **E2E:** `bun run test:e2e` (Playwright, auto-port, mock driver, desktop + Pixel 7).
  This is the repeatable UI/behavior loop and must stay green — it proves the hub +
  client + mock path is intact after the pi removal.
- **Live viability (manual):** boot with default driver = polytoken against a running
  `polytoken daemon`; confirm a prompt round-trips. This is the *point* of the spike —
  if polytoken isn't dogfoodable end-to-end, that's the finding to report back.
- **Source audit:** the AC.1/AC.2 greps are the "no remnants" proof.

If automated testing can't cover the polytoken live path (no daemon on the build
machine), document the manual check as the validation for AC.10.

## Review Strategy

**Plan-mode review (now):** run `plan-reviewer` on this plan before handoff. Fix/rebut
all critical/high findings; re-run until clean or operator overrides.

**Implementation review (after execute):** the repo has no dedicated review guidance, so
the execute agent dispatches a `general-purpose` subagent to review the completed diff
with focus on: (1) no lingering `pi/` import paths, (2) the relocated shared modules
kept their tests + behavior, (3) the driver-selection change is loud on `PILOT_DRIVER=pi`,
(4) `bun.lock` is clean. All critical findings fixed or rebutted; re-review if any
critical remains.

## Documentation Strategy

- `AGENTS.md`: updated (Phase 6) — it is the load-bearing operator-facing doc; the
  pi-specific "Facts" section would actively mislead on this branch.
- Historical docs (`DECISIONS`, `DESIGN`, `DONE`, `TODO`, `STATUS`, `PLAN-*`,
  `OPEN-QUESTIONS`, `initial-handoff`): left as historical record with a one-line
  polytoken-only banner. Rewriting them is low-value for a viability spike and risks
  losing the rationale that still applies on `main`.
- No user-facing docs beyond the app itself (single-user internal tool).

## Risks, Blockers, and Required Decisions

### D-1 (REQUIRED DECISION — operator) — how to handle the hub's two pi-features

`login-env.ts` and `background-model.ts` are pi-SDK-import-free but conceptually pi
features, and the hub calls them unconditionally in `pilotSettingsMsg` (broadcasting
`env`/`pendingRestart`/`backgroundModelWarning` over the WS wire). Under polytoken they
produce inert defaults but the code + client UI sections remain.

- **Option A — Relocate + dormant (RECOMMENDED for this spike):** move both to
  `server/src/shared/`, hub keeps calling them, client Settings sections stay present but
  show inert values. Minimal churn, fastest to viability. Leaves dormant UI cruft.
- **Option B — Rip from wire:** remove from `hub.ts`, drop fields from the `pilotSettings`
  protocol message, remove Settings.svelte + store sections. Cleaner ("no remnants") but
  cross-cuts protocol + client — higher risk, better as a separate focused change.

→ The plan above assumes **Option A** unless the operator says otherwise. This is the
single decision that changes the plan's size; confirm before "go".

### R-1 — Mock driver's extension simulation is now vestigial (accepted)

The mock driver (pi-import-free) still simulates the pi-era `answer`/`tasklist`/
`session-namer` extensions via `PILOT_OWNED_EXTENSION_NAMES`. Under polytoken these are
daemon built-ins, so the mock models the wrong reality. **Accepted for the spike** —
it's dev/e2e tooling, pi-free, and ripping it touches the huge `fixtures.ts` + multiple
e2e specs. Flagged as follow-up: re-base the mock on polytoken's reality.

### R-2 — `protocol/src/pilot-extensions.ts` retained (accepted)

A plain `readonly string[]` + predicate the mock + hub import. Harmless, agent-agnostic.
Kept to avoid breaking the mock; the names are pi-era but unused under polytoken.

### R-3 — Polytoken live-path validation needs a running daemon

AC.10 (default driver boots polytoken) can be type/construct checked anywhere, but the
true end-to-end prompt round-trip needs `polytoken daemon` running on the mini. If the
implementor's environment lacks it, document the manual check and report whether
polytoken is dogfoodable — that *is* the viability answer the spike is after.

### R-4 — Parallel implementor still active (external blocker)

The operator stated a parallel implementor is working. **Do not start execution until the
operator says "go"** — concurrent edits on one working copy scramble commits. This plan
is prepared only.

### No unresolved implementation unknowns

All file paths, import edges, and the relocate-vs-delete classification were verified by
grep + file inspection during planning (see Phase 0). The shared-utility set is tight
(4 modules); the pi-SDK-importing set is enumerated (Bucket 3). The only open input is
**D-1** (operator choice).
