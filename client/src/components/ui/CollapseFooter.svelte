<script lang="ts">
  // A centered collapse chevron that renders at the bottom of a tall expanded
  // element (.body / .work-body) so a user who opened something very long can
  // collapse it without scrolling all the way back to the top header. Mirrors
  // the existing `.prompt-expand` "Show less" pattern — a muted pill that
  // brightens on hover, using the shared Chevron disclosure primitive.
  //
  // Visibility is conditional: the footer only appears when the parent
  // container exceeds ~50% of the viewport height. It measures its own
  // parentElement (so it MUST be a direct child of the container it guards —
  // no intermediate wrapper) via a ResizeObserver + a window resize listener.
  //
  // The button is ALWAYS in the DOM (toggled via a CSS class, not {#if}) so
  // the ResizeObserver can attach and measure from first paint. When hidden it
  // collapses to zero height so it doesn't inflate the parent's measurement.
  import Chevron from "./Chevron.svelte";

  let { onCollapse }: { onCollapse: () => void } = $props();

  let visible = $state(false);
  let footer = $state<HTMLElement>();

  $effect(() => {
    const el = footer?.parentElement;
    if (!el) return;
    const measure = () => {
      visible = el.offsetHeight > window.innerHeight * 0.5;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
</script>

<button
  bind:this={footer}
  class="collapse-footer"
  class:hidden={!visible}
  type="button"
  aria-label="Collapse"
  aria-expanded="true"
  aria-hidden={!visible}
  tabindex={visible ? 0 : -1}
  onclick={onCollapse}
>
  <Chevron open={true} variant="disclosure" size={11} />
</button>

<style>
  .collapse-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    margin-top: 4px;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 999px;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.12s ease, background 0.12s ease;
  }
  /* When the parent is short, collapse the footer to zero so it doesn't
     inflate the parent's offsetHeight (which would keep it just over the
     threshold — a one-way latch, no oscillation). Also removed from the a11y
     tree via aria-hidden + tabindex -1 so it's not focusable when invisible. */
  .collapse-footer.hidden {
    height: 0;
    margin: 0;
    padding: 0;
    overflow: hidden;
    visibility: hidden;
  }
  .collapse-footer:hover,
  .collapse-footer:focus-visible {
    color: var(--text);
    background: var(--surface-sunken);
  }
  .collapse-footer:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  /* Mobile: the footer's tap target must meet the 44px minimum. */
  @media (max-width: 859px) {
    .collapse-footer {
      min-height: 44px;
    }
  }
</style>
