# Plan — Self-contained pilot extensions

> Status: **draft for review** (grilled 2026-06-26). Decisions below are settled
> unless marked **[OPEN]**. This file is the input to the outer/inner loop work
> in a follow-up session — it is not a TODO list yet.

## Goal

Pilot should ship the pi extensions its UX depends on, instead of depending on
the operator's `~/dotfiles/agents/extensions` (reached via the
`~/.pi/agent/extensions` symlink). "Self-contained" = a stock `pi` install +
pilot reproduces the polished UX; the dotfiles extensions become optional
personal extras, not load-bearing.

## Scope — settled

Move **three** extensions into pilot (owned + shipped):

| Extension | Coupling that justifies owning it |
|---|---|
| **answer.ts** | Calls `ctx.ui.qna(...)`, pilot's bespoke host-UI method (not in pi's typed `ExtensionUIContext` — the D2 tracked risk). Pilot has `QnaInline`/`QnaForm`/`QnaResult` + the `qna` wire kind co-designed with it. |
| **tasklist.ts** | Pilot's client (`client/src/lib/tasklist.ts`) parses this extension's `setWidget("tasklist", lines)` wire format (header + `○ #id: desc` line regex). |
| **session-namer.ts** | Pilot *defers* session naming to it (`docs/TODO.md:489`). Uses only public pi API (`setSessionName`), so any namer would do — but pilot currently assumes one exists. |

**Explicitly NOT moving:**

- **journal-nudge.ts** — confirmed *not* pilot-coupled. Its only "coupling" is the
  `<journal-nudge>…</journal-nudge>` wrapper tag, and pilot's `injectText()`
  strips *any* single outer tag generically (`<([\w-]+)>…</\1>`). It runs in any
  pi host (TUI or pilot) and is a personal-workflow nudge, not a UX dependency.
- **The broader "polish UX" set** (notify, statusline, timestamps,
  prompt-timestamp, preview-serve, compact-output, context, files, review,
  session-breakdown, session-search, prompt-editor, loop, autoformat,
  thinking-preset, local-context, strip-pi-docs, block-find-root, bedrock-retry,
  aws-sso, btw, turn-diagnostics, structured-output, todos). These are either
  TUI-only (pilot already replaces their affordances with its own UI) or
  fully host-agnostic. Moving them would inherit dead TUI code or force forking
  each into remote-only variants. Low payoff, high cost.

## Settled decisions

### D1 — Registration: `additionalExtensionPaths` (file-based, toggleable)
Pilot bundles the three extensions as `.ts` files in-repo (proposed:
`pilot/extensions/{answer,tasklist,session-namer}.ts`) and passes their resolved
paths to `DefaultResourceLoader` via
`DefaultResourceLoaderOptions.additionalExtensionPaths`.

Why not `extensionFactories` (direct function injection): factories may not
surface in `getExtensions()` the same way, and the enable/disable toggle keys on
`resolvedPath` — so the owned extensions might become un-toggleable, breaking
the "dedicated enable/disable toggles" goal. File-based keeps the toggle story
uniform with user extensions.

Verified mechanics (`pi-coding-agent@0.80.2`):
- `additionalExtensionPaths` route through `resolveExtensionSources`, tagged
  `source:"cli", scope:"temporary", origin:"top-level"`.
- Force-exclude overrides (`-<resolvedPath>` in pi settings) **do** apply to
  them — so pilot's enable/disable toggle works on the owned extensions too.
- **No path dedup.** If pilot registers `…/pilot/extensions/answer.ts` AND the
  dotfiles `~/.pi/agent/extensions/answer.ts` is still discoverable via the
  symlink, **both load → tool/command name collisions** (the `answer` tool
  registered twice). **Therefore moving an extension requires the dotfiles copy
  to be removed (or disabled), not coexisted.** This is a hard constraint the
  plan accounts for (see chunk "Migration").
- `source:"cli"` origin will need a small server-side projection tweak so the
  Settings list badges these as "Pilot" rather than "cli"/"temporary". See D3.

### D2 — Cheap-model resolution: a pilot Settings entry (with optional script hook)
answer.ts + session-namer.ts need a cheap model (the `text-summary` and
`structured-extraction` roles). They currently get it via
`~/dotfiles/agents/_lib/roles.mjs`'s `resolveRoleModel()`, which reads the
per-machine `~/.pi/agent/roles.json` + `PI_ROLE_*` env + a built-in fallback
table.

**Settled:** replace the `roles.mjs` dependency with a new pilot Settings entry:
- **Default:** a pi model spec field (e.g. `anthropic/claude-haiku-4-5:low`) —
  "background model" for the cheap tasks pilot's extensions run.
- **Optional escape hatch:** the field can alternatively be a path to a script
  that prints a model spec to stdout (so the operator can keep using
  `roles.mjs`, or any resolver). Pilot runs it, parses the spec.
- **Result:** no `roles.mjs` vendoring, no per-extension inlining, no coupling
  to the dotfiles resolver. The dependency disappears — the extensions read
  pilot's setting.

This is net-new (no existing "background model" concept; `ModelDefaults` only
covers the default session model + favorites). It becomes a new field in
`PilotSettings` (+ wire round-trip + Settings UI control), parallel to the
existing default-model.

### D3 — UI: unified Extensions list, grouped under collapsible origin headers
Not a separate "pilot extensions" list. One list (same toggle mechanism for
all — the force-exclude-by-resolvedPath override is identical), but rows group
under collapsible headers by origin:
- **Pilot** (the 3 owned, badged, with descriptions)
- **User ~/.pi** (the operator's user-scope extensions)
- **Project** (cwd `.pi/extensions`)

Collapse gives the "see only mine" affordance. This mirrors the existing
collapsible-header pattern already used for Providers and Favorites.

**Descriptions are a new convention we define** (pi's `Extension` type carries
no description; pi-gui only infers `displayName` from `package.json`/folder
name, and that's for *skills*, not extensions). Proposed source: a frontmatter
block at the top of each pilot-owned extension file, e.g.:

```ts
/** @pilot
 * name: Answer (Q&A)
 * description: Interactive Q&A widget — the agent asks questions via a structured form.
 */
```

…or simpler: a leading doc-comment line we parse. The exact convention is a
small per-chunk design point, not a blocker. Applies only to pilot-owned
extensions initially (user/project extensions stay description-less unless pi
grows the field).

### D4 — Process: `dev-review-loop` skill as the inner loop
Each chunk ships through the `dev-review-loop` skill: implement → fresh
`review-subagent` → fix, 3-round cap, pauses on DECISIONS_NEEDED. Commit
between rounds so each reviewer sees the cumulative diff. The outer loop
(kick off in the next session) picks chunks off the list below and runs each
through the inner loop until "review passes."

## Chunk breakdown (outer loop)

Ordered by dependency + risk (cheapest, most-de-risking first). Each chunk is
one inner-loop run. Every chunk carries its own verification target — either
an existing e2e spec or a new one.

### Chunk 0 — Spike: register a no-op extension via `additionalExtensionPaths`  ✅ KEPT
**De-risk the core mechanism before porting anything real.** Add a tiny
throwaway extension under `pilot/extensions/_spike.ts` (registers a
`/pilot-spike` command), wire it into the `DefaultResourceLoader` options in
`server/src/pi/pi-driver.ts`, and verify:
1. It loads and the command appears in the composer typeahead.
2. It shows up in `getExtensions()` and the Settings Extensions list.
3. The enable/disable toggle (force-exclude) works on it.
4. The `source:"cli"` origin surfaces — confirm whether the D3 "Pilot" badge
   needs a projection tweak or falls out for free.
5. Double-registration: confirm the collision if the same file is also in
   `~/.pi/agent/extensions` (to validate the D1 "must remove from dotfiles"
   constraint empirically, not just from the loader source).

Throw the spike away after; it exists only to retire the mechanism risk. No
migration, no UI changes.

**Verify:** manual `/pilot-spike` in a mock-driver session + `GET /debug/state`
shows the extension.

### Chunk 0.5 — Settings navigation refactor  ✅ ADDED (per [OPEN C] resolution)
Break the single long Settings panel into submenus / nested navigation so its
longer lists (Providers, Models+Favorites, Extensions) don't crowd one scroll.
Touches every section's affordance, so run it through the inner loop on its own,
*before* the Extensions UI work — so the origin-grouped list (Chunk 2–4) lands
inside the new nav rather than being retrofitted.

Scope to nail down in-round: the nav primitive (a left-rail of section tabs?
collapsible top-level groups like the Providers/Favorites pattern, promoted to
the whole panel?), mobile behavior (the panel is a bottom-sheet on phones), and
hotkey/escape semantics across nested views. Keep the existing testids stable
where possible — the e2e suite (`e2e/settings.e2e.ts`) keys off them.

**Verify:** full `e2e/settings.e2e.ts` stays green (it exercises every section);
add a case for the nav itself (open a deep section directly, escape back).

### Chunk 1 — Settings: "background model" entry (D2)
The dependency D2 removes is shared by answer + session-namer, so land it
first — neither can be ported cleanly without it.

- New `backgroundModel` field in `PilotSettings` (value: a pi model spec string,
  OR a `script:`-prefixed path).
- Wire round-trip (`PilotSettings` already broadcasts; add the field + UI).
- Settings panel control (under a new or existing section — see **[OPEN A]**).
- Server-side resolver: given the setting, return a `Model` (spec parse →
  `modelRegistry.find`, or run script → parse stdout). Fail loud on bad specs.
- Mock-driver fixture for the setting so e2e can exercise it.

**Verify:** new `e2e/settings.e2e.ts` case — set a spec, confirm it's read
back; set a bad spec, confirm a loud error.

### Chunk 2 — Port session-namer.ts (simplest of the 3)
Smallest, softest coupling (only `setSessionName`, no host-UI bespoke methods).
Good first real port — proves the porting pattern (copy file → swap roles.mjs
for the D2 setting → drop realpath-cross-symlink scaffolding → register via
D1).

- Copy `session-namer.ts` → `pilot/extensions/session-namer.ts`.
- Replace `getResolveRoleModel()` / `resolveRoleModel(ROLE, …)` with a read of
  the D2 background-model setting (role `text-summary` → the setting).
- Remove the `realpath`/`pathToFileURL` roles.mjs import dance (no longer
  needed — local file now).
- Register via `additionalExtensionPaths`.
- Add a frontmatter/description per D3.

**Verify:** existing `e2e/settings.e2e.ts` Extensions-section tests already
reference `answer.ts`/`tasklist.ts` mocks — extend with a session-namer mock +
assert it appears under the "Pilot" origin group with its description.

### Chunk 3 — Port tasklist.ts
Medium coupling: the `setWidget("tasklist", lines)` wire format + pilot's
`client/src/lib/tasklist.ts` line-regex parser.

- Copy `tasklist.ts` → `pilot/extensions/tasklist.ts`.
- Register via `additionalExtensionPaths`. No roles.mjs dep (tasklist doesn't
  use a model).
- **Per-chunk decision [OPEN B]:** keep the string-line wire format (parser
  unchanged, behavior identical) OR switch to a structured payload
  (`{tasks:[{id,description}…]}`) and simplify the parser. The "shared with pi's
  TUI" constraint that forced the string format **goes away** once pilot owns
  it — so the structured option is newly viable. Lean: structured, since the
  comment in `tasklist.ts` explicitly calls the string recovery a workaround.
- Add frontmatter/description per D3.

**Verify:** existing tasklist rendering in the transcript; add an e2e case that
pushes a tasklist widget and asserts structured rendering. If going structured,
update `client/src/lib/tasklist.ts` + its `.test.ts`.

### Chunk 4 — Port answer.ts (hardest; saved for last)
The hard coupling: `ctx.ui.qna(...)`, the D2 `structured-extraction` role, the
`/answer` command, the `answer` tool, TUI component (`QnAComponent`), and the
realpath-cross-symlink roles.mjs dance.

- Copy `answer.ts` → `pilot/extensions/answer.ts`.
- Replace the `structured-extraction` role resolution with the D2 setting.
- Replace the `text-summary` usage (if any — answer uses structured-extraction
  for the command path) with the D2 setting.
- Remove the realpath/pathToFileURL roles.mjs scaffolding.
- Register via `additionalExtensionPaths`.
- Add frontmatter/description per D3.
- **Audit the `qna` coupling (D2 tracked risk):** the `as unknown as
  ExtensionUIContext` cast at `server/src/pi/pi-driver.ts` bindExtensions is
  the seam. Owning answer.ts doesn't change this — pi still hands extensions the
  raw bridge — but document that pilot now owns *both* sides of the seam, which
  makes the coupling intentional rather than incidental. Consider adding a
  canary assert (the existing `ui-bridge-coupling.test.ts`).
- The TUI `QnAComponent` path stays (answer.ts is shared with pi's TUI) — but
  confirm the `ctx.mode !== "tui"` branch (the pilot `qna` call) is the one that
  fires under pilot and the TUI path is inert.

**Verify:** existing `e2e/answer-card.e2e.ts` covers the qna card UI; extend to
confirm the ported extension drives it. Run `ui-bridge-coupling.test.ts`.

### Chunk 5 — Migration: remove the 3 from dotfiles + update docs
After all three are ported and pilot-side verified:

- Delete `answer.ts`, `tasklist.ts`, `session-namer.ts` from
  `~/dotfiles/agents/extensions/` (the `~/.pi/agent/extensions` symlink will
  stop resolving them). **This is mandatory** — D1's no-dedup constraint means
  leaving them causes double-registration collisions.
- Update `docs/AGENTS.md` / `docs/DECISIONS.md`: record that pilot now ships
  its own UX extensions and the dotfiles set is personal-extras-only.
- Update the `docs/TODO.md` references that assume the dotfiles namer
  (`docs/TODO.md:489`).
- Smoke-test the full flow: stock pi + pilot, no dotfiles extensions → answer
  qna, tasklist widget, session auto-naming all work.

**Verify:** end-to-end manual + the full `bun run test:e2e` suite green.

## Open questions

### [OPEN A] — Does the "background model" setting get its own Settings section, or ride an existing one?
The Settings panel is already long (Appearance, Notifications, Providers,
Models+Favorites, Extensions, Environment, Access token). The D2 control could:
(a) live under "Models" (it's a model picker, thematically adjacent), or
(b) get its own small section, or
(c) be deferred into the **separate "settings submenus" refactor** the owner
    flagged (see [OPEN C]).

Lean: (a) under Models — it's a model picker, keeps related controls together,
no new section.

### [OPEN B] — tasklist wire format: keep string lines or go structured?
See Chunk 3. The structured option is newly viable once pilot owns the
extension (the "shared with pi's TUI" constraint lifts). Lean: structured.

### [OPEN C] — RESOLVED: the "Settings submenus" refactor IS part of this work
The owner flagged that the Settings view is getting large enough to warrant
submenus for its longer lists, and confirmed it folds into this project as
**Chunk 0.5** (see chunk breakdown). It's a UI-navigation refactor that touches
every section, run through the inner loop independently, and precedes the
Extensions UI work so the new origin-grouped list lands inside the new nav.

### [OPEN D] — Should pilot-owned extensions be toggleable at all?
D1 says yes (uniform toggle). But disabling `answer.ts` breaks the qna UI
(pilot has components that assume `qna` exists), and disabling `tasklist.ts`
silently degrades the tasklist widget. Options:
(a) toggleable but with a warning in the UI ("Disabling this breaks the Q&A
    feature"), or
(b) non-toggleable for the 3 pilot-owned ones (always on, no toggle), or
(c) toggleable, no warning, and let it break (operator's choice).

Lean: (a) — toggleable (consistency) but with an inline warning for the
load-bearing ones. Defer until Chunk 2–4 reveal how the toggle actually feels.

## Non-goals

- Moving any non-coupled extension (the "polish UX" set — see Scope).
- Vendoring `roles.mjs` into pilot (D2 removes the need).
- Bundling the per-machine `roles.json` map (stays in `~/.pi/agent/`).
- Changing pi's extension discovery for user/project extensions (unchanged).
- The iOS keyboard accessory bar (OQ9, tabled).
- Settings navigation refactor (unless [OPEN C] resolves to yes).

## Verification summary

- `bun test` — unit tests (no driver).
- `bunx tsc --noEmit -p protocol/tsconfig.json` — server/protocol typecheck.
- `bun run --cwd client check` — svelte-check.
- `bun run test:e2e` — Playwright (mock driver, desktop + mobile).
- Per-chunk e2e targets noted above.
- `server/src/pi/ui-bridge-coupling.test.ts` — the qna-seam canary (Chunk 4).
