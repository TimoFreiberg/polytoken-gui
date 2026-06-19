# Design-system pass — what shipped, what's left bespoke

_Completed 2026-06-18. This is the record of the button-primitive consolidation
(the "Design-system consistency pass" TODO item) and the handoff for the separate
visual-polish session the owner is driving._

The pass was a **pure refactor**: structure/styling only, no functional behavior
change. Every migrated surface keeps its `onclick`/`disabled`/`bind`/keyboard
wiring, `data-testid`s, and accessible names. Verified by the full e2e suite,
`svelte-check`, unit tests (174), a prod build, and per-surface screenshots
(desktop-light + mobile-dark on the heavy surfaces).

## The three primitives (`client/src/components/ui/`)

| Primitive | API | Promoted from |
|-----------|-----|---------------|
| `Button` | `variant` primary\|secondary\|danger · `size` sm\|md\|lg · `block` | Settings' `.btn`/`.ghost`/`.danger` (pre-existing) |
| `IconButton` | icon-only, **required `title`** · `size` sm\|md\|lg · `variant` default\|danger · `active` (toggle, sets `aria-pressed`) · 44px tap target under `@media (pointer:coarse)` | Sidebar's `.icon` |
| `SegmentedControl` | generic-over-value radiogroup of radios · data-driven `options` (`value`,`label`,`title?`,`icon?`,`testid?`) · `bind:value` · `size` sm\|md | Settings' `.seg`/`.seg-btn` |

`Button` + ApprovalLayer landed in the prior session; this pass added `IconButton`,
`SegmentedControl`, and migrated the consumers below.

## Migrated

- **Sidebar** — collapse `‹`, per-group `+`, error-dismiss `×` (danger), row-menu `⋯` → IconButton; rename Cancel/Save → Button. (Session rows + project headers are the **layout-primitive fast-follow**, left alone.)
- **Composer** — steer/follow-up switch → SegmentedControl (controlled; the Enter/Alt+Enter wiring stays in Composer and just binds `value`); attach paperclip → IconButton.
- **Settings** — theme switch → SegmentedControl; every `.btn`/`.ghost`/`.danger` (push, providers, key form, token) → Button; close `✕` → IconButton.
- **StatusHeader** — hamburger + settings gear → IconButton.
- **App** — update-toast dismiss `×` → IconButton.
- **TokenGate** — "Connect" → Button (primary, lg).
- **NewSession** — "Cancel" → Button (secondary, sm).

## Deliberately left bespoke — candidates for the visual session

These didn't fit the three primitives cleanly. Each is a real pattern; grouped,
they're the strongest signal for **future primitives** (a `Toggle`, a `Chip`, and a
`Menu`/dropdown family). Listed so the visual session can decide intent before shape.

- **Single _labeled_ toggles** (`.filter-toggle` in Sidebar, the hide-thinking switch in Settings) — a 2-state pill with a changing label + `aria-pressed`. Not IconButton (has a label), not SegmentedControl (single, not a set). **→ candidate `Toggle` primitive.**
- **Chips** (Composer `.chip` project opener, `.toggle-chip` worktree) — small labeled pills, one a menu-opener and one a toggle. **→ candidate `Chip` primitive.**
- **Dropdown/menu family** — ModelPicker's `.badge` triggers + `.item` menu rows + `.backdrop`, and Sidebar's `.row-menu` popover + `.menu-item`s. A 3+-use pattern. **→ candidate `Menu`/`Dropdown` primitive.** (ModelPicker has *no* clean Button/IconButton/SegmentedControl targets — it's entirely this family.)
- **Disclosure rows** (`ToolCard .head`, `ThinkingBlock .head`) — accordion headers (status/label + chevron). **→ candidate `Disclosure` primitive.**
- **List options** (`TrustCard .opt`, ApprovalLayer `.opt`) — full-width selectable rows. Tied to the layout-primitive fast-follow (`SlashMenu .row` is the same shape).
- **Special-identity buttons**, intentionally one-off: Composer send circle (`.send`), Stop pill (`.stop`), composer drag-handle (`.expand`), StatusHeader status bell (`.bell`), Transcript copy (bordered hover-reveal w/ copied-confirm — note IconButton's default is *ghost*, so copy doesn't fit), Transcript `.naction` (currentColor-tinted notice pills) + `.new-pill` (floating FAB), App update-toast Refresh pill.

## Latent issues found (and fixed by migrating)

- **Sidebar rename Cancel/Save** were effectively **unstyled** — they used bare `class="ghost"`/`class="primary"`, but no such CSS exists (only a global `button{}` reset). Migrating to `Button` gives them real styling.
- **Settings close `✕`** had **no `title`** (only `aria-label`) — IconButton's required `title` closed that gap (the repo's "every clickable carries a title" rule, now type-enforced).

## Decisions worth a second look (visual session)

- **IconButton hover shade** is one value (`--surface`, from Sidebar's `.icon`). Header/composer icons previously hovered to `--surface-sunken`; they now converge to `--surface`. Pick the canonical shade.
- **IconButton sizes** converge some buttons (header 30px → md 26px, attach 30px → md 26px, group-add 24px → sm 22px). Confirm the md/sm steps feel right per context.
- **44px coarse-pointer tap target** is invisible at rest (transparent box) — it widens the touch area + layout gap on mobile without painting a chip. Verified it doesn't crowd the (dense) composer toolbar or sidebar header. Re-check on a real device.
- **SegmentedControl** uses `role="radio"`/`aria-checked` (Settings' proven pattern). The composer steer/follow-up switch moved from plain buttons to this — an intended a11y upgrade; the streaming e2e now selects by `role="radio"`.
- **NewSession "Cancel"** converged from a pill to a standard secondary Button (rounded-rect). If the pill shape was intentional, revert just that one.

## Verification

- `svelte-check` 0 errors/warnings · protocol+server `tsc` clean · 174 unit tests pass · prod build OK.
- Full Playwright suite green (desktop + Pixel-7), incl. the two reselected specs. The two transient failures seen in one run were CPU contention from a concurrent e2e run on the box — confirmed by re-running in isolation (all pass); they touch ThinkingBlock / Transcript-scroll, untouched here.
- A 9-agent adversarial review (one per migrated file, each finding then independently verified) returned **0 confirmed issues**: behavior preserved, all clickables labelled, no dead CSS, idiomatic primitive use across all surfaces.
- **One known cosmetic nit (left as-is):** Settings' standalone "Forget" danger button dropped `flex-shrink: 0` in the convergence. Harmless in practice — its `.row` sibling `.rinfo` has `min-width: 0` and absorbs all shrink, and the label is short — so it can't actually compress. Re-add only if the visual session wants belt-and-suspenders.

## e2e note

The TODO's pre-audit said only `.actions.two` + `.keyform` could break. Two more
structural selectors actually did — `.composer-wrap .attach` and `.composer-wrap .modes`
— now reselected by accessible name / role. `.keyform` and `.chips .chip` were
preserved (those surfaces stayed bespoke), so their specs were untouched.
