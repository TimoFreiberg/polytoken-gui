# UI Conventions & Implementation Patterns

Read this file when working on UI (`client/`). It collects the shared
primitives and conventions every UI change must follow. General repo
conventions (autoformatter, VCS, protocol purity, driver trait) stay in
`AGENTS.md`.

## Shared primitives

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
