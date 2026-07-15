# UI Conventions & Implementation Patterns

Read this file when working on UI (`client/`). It collects the shared
primitives and conventions every UI change must follow. General repo
conventions (autoformatter, VCS, protocol purity, driver trait) stay in
`AGENTS.md`.

## Shared primitives

### Color semantics

Pantoken has two brand-material roles. Keep them semantically distinct so gold remains
a useful highlight instead of becoming general decoration:

- **Warm nickel (`--accent*`) is structural:** links, focus rings, selected rows and
  choices, navigation, drag targets, running/progress indicators, and soft background
  tints.
- **Gold (`--highlight*`) is scarce emphasis:** enabled primary actions, the composer
  Send button, new/unread/ready-for-you activity, and small branded attention moments.
  Gold fills always use `--highlight-text` (dark ink), never white; the brand gold does
  not have enough contrast with white text.
- **Semantic status colors stay independent:** warning, danger, and success must not be
  remapped to either brand color. Warnings use copper so they do not resemble an
  affirmative gold action.

Prefer the shared `Button variant="primary"` for a gold call to action. Do not add a
generic `gold` variant or use `--highlight` for ordinary selected/active state. A useful
review question is: “does this ask the operator to act or look here?” If not, it is
probably structural warm nickel or a neutral surface. Display-only identity chips such
as the transcript goal badge stay nickel; they do not spend gold merely for being present.

### Collapse / disclosure affordances

Two primitives, shared everywhere — don't hand-roll alternatives.

- **Glyph:** `client/src/components/ui/Chevron.svelte` (stroked SVG).
  - `variant="disclosure"` for inline sections.
  - `variant="menu"` for dropdown badges.
  - The chevron inherits a faint `currentColor`; brighten it on header
    hover with a scoped rule on the parent's own header class — e.g.
    `.group-head:hover :global(.chevron)` in the sidebar. A parent's
    plain class can't reach a child component's scoped element without
    `:global`.
  - Reference design: the sidebar project caret.
- **Open/close animation:** `transition:reveal` from
  `client/src/lib/transitions.js` — a `slide` wrapper that honours
  `prefers-reduced-motion`. Don't call `slide` directly; always go
  through `reveal`.

### Hotkeys & tooltips

Every clickable element — buttons, toggles, menu items, approval actions,
settings controls — must have:

- A `title` attribute naming the action and its keyboard shortcut (if one
  exists).
- Reviewers flag missing tooltips/hotkeys the same way they flag missing
  error handling.

### Touch (phone, ≤859px)

`title` tooltips are inert and hotkeys don't exist on touch, so on
phone-reachable paths every action must ALSO be a visible, labeled control:

- `aria-label` naming the action.
- A ≥44px hit target (`tap-targets.mobile.e2e.ts` enforces the size).
- No hover-revealed or hotkey-only affordances on phone paths.
- Full-screen phone views must integrate with the back gesture via
  `client/src/lib/overlay-history.ts` — never leave a phone overlay that
  the OS back gesture can't close.
