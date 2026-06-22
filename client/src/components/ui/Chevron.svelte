<script lang="ts">
  // The one disclosure/collapse glyph for the whole app — a thin stroked chevron that
  // rotates with a short glide, mirroring the project-title caret in the sidebar (the
  // reference design). Replaces the scattered filled-triangle glyphs (▸ ▾) so every
  // collapse affordance reads the same.
  //
  //   variant="disclosure" (default): collapses an inline section. Points DOWN when
  //     open, rotates to point RIGHT when collapsed — exactly the sidebar project caret.
  //   variant="menu": triggers a floating dropdown/popover. Points DOWN at rest, flips
  //     UP when the menu is open — the conventional dropdown caret.
  //
  // Decorative (aria-hidden): the owning button carries the label + aria-expanded.
  // Color is inherited (currentColor) with a faint default; a parent can override by
  // setting `color` on a `:global(.chevron)` descendant (e.g. to brighten on hover).
  let {
    open = false,
    size = 11,
    strokeWidth = 1.7,
    variant = "disclosure",
  }: {
    open?: boolean;
    size?: number;
    strokeWidth?: number;
    variant?: "disclosure" | "menu";
  } = $props();
</script>

<span class="chevron {variant}" class:open aria-hidden="true">
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M4 6l4 4 4-4" />
  </svg>
</span>

<style>
  .chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--text-faint);
    transition:
      transform 0.16s ease,
      color 0.1s ease;
  }
  /* Disclosure: down when open, right when collapsed (the sidebar project caret). */
  .chevron.disclosure {
    transform: rotate(-90deg);
  }
  .chevron.disclosure.open {
    transform: rotate(0deg);
  }
  /* Menu/dropdown: down at rest, flips up when open. */
  .chevron.menu {
    transform: rotate(0deg);
  }
  .chevron.menu.open {
    transform: rotate(180deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
</style>
