<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  // Icon-only chrome button: a centered glyph or inline SVG, no text label. The icon
  // counterpart to <Button> — same surface vocabulary, different shape. Because there's
  // no visible label to name the action, `title` is the natural place to surface the
  // action name and hotkey — but it's no longer type-required. See the `title` prop's
  // JSDoc for when to include it.
  //
  // `active` drives a pressed/toggled look and sets `aria-pressed`, for the many single
  // on/off chrome toggles (expand, worktree, …). That's distinct from
  // <SegmentedControl>, which is for picking one of several. `danger` is the destructive
  // tint (e.g. the dismiss-error ✕). Sizes mirror Button's sm/md/lg so an icon and a text
  // button sit level in the same row; md is the proven Sidebar `.icon` (26px).
  type Size = "sm" | "md" | "lg";
  type Variant = "default" | "danger";

  interface Props extends Omit<HTMLButtonAttributes, "title"> {
    /**
     * Tooltip text shown on hover. Omit when the element is self-documenting
     * (visible text label, obvious icon) and no extra hover data exists — see
     * docs/ui-conventions.md "Hotkeys & tooltips". Omission is deliberate, not
     * a forgotten default.
     *
     * Icon-only buttons that omit `title` MUST provide an `aria-label` (or
     * visible text) so the button keeps an accessible name — an icon button
     * with neither `title` nor `aria-label` is invisible to assistive
     * technology.
     */
    title?: string;
    size?: Size;
    variant?: Variant;
    active?: boolean;
    children: Snippet;
  }

  let {
    title,
    size = "md",
    variant = "default",
    active = false,
    type = "button",
    class: extra = "",
    children,
    ...rest
  }: Props = $props();
</script>

<button
  class="icon-btn {size} {variant}{active ? ' active' : ''}{extra ? ' ' + extra : ''}"
  {type}
  {title}
  aria-pressed={active ? true : undefined}
  {...rest}
>
  {@render children()}
</button>

<style>
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    font-family: inherit;
    line-height: 1;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    cursor: pointer;
  }
  /* Callers provide different SVG icon sets. Normalize their occupied box here while
     leaving each icon's intentional stroke/fill styling intact. */
  .icon-btn > :global(svg) {
    display: block;
    width: 1em;
    height: 1em;
    flex: none;
  }
  .icon-btn:hover,
  .icon-btn.active {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }
  .icon-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .icon-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .icon-btn:disabled:hover {
    background: transparent;
    border-color: transparent;
    color: var(--text-muted);
  }

  /* Size — md = the proven Sidebar .icon (26px). */
  .sm {
    width: 22px;
    height: 22px;
    font-size: 14px;
  }
  .md {
    width: 26px;
    height: 26px;
    font-size: 16px;
  }
  .lg {
    width: 32px;
    height: 32px;
    font-size: 18px;
  }

  /* danger — destructive tint (dismiss/clear). */
  .danger {
    color: var(--danger);
  }
  .danger:hover,
  .danger.active {
    background: var(--danger-soft);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger);
  }

  /* Mobile keeps the glyph compact but guarantees a 44px tap target. The box stays
     transparent until hover/active, so on touch this just widens the clickable area
     (and the layout gap) without painting a 44px chip. */
  @media (pointer: coarse) {
    .icon-btn {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
