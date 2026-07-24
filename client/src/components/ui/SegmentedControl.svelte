<script lang="ts" generics="T extends string">
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";

  // Pill toggle for picking one of a small set — Settings' theme switcher and the
  // composer's steer/follow-up switch, promoted from Settings' proven `.seg`/`.seg-btn`.
  // Data-driven and two-way bindable: pass `options` and `bind:value`. It's a controlled
  // component — it owns the visuals and the radiogroup semantics; the consumer owns any
  // side effects (e.g. the composer keeps its Enter / Alt+Enter wiring and just binds
  // `value`). Distinct from a single on/off <IconButton active> — use this when there are
  // two or more named choices laid out side by side.
  //
  // Generic over the value type so a consumer with a union (`"steer" | "followUp"`) keeps
  // that type through `bind:value` instead of widening to bare `string`.
  type Option = {
    value: T;
    label: string;
    title?: string; // tooltip; falls back to the label
    icon?: Snippet; // optional leading glyph / inline SVG
    testid?: string; // optional data-testid hook for e2e
    disabled?: boolean; // optional: disable this option (e.g. unsupported Docker)
  };

  interface Props {
    options: Option[];
    value: T;
    ariaLabel: string;
    size?: "sm" | "md";
    onchange?: (value: T) => void;
    /** Position the sliding thumb (and the `active` styling) on a value OTHER than the
     *  committed `value`, without changing what a click commits. Used for a transient
     *  preview — e.g. the composer slides to "follow-up" while ⌥ is held — that snaps back
     *  to `value` on release. Falls back to `value` when undefined. */
    displayValue?: T;
  }

  let {
    options,
    value = $bindable(),
    ariaLabel,
    size = "md",
    onchange,
    displayValue,
  }: Props = $props();

  // What the thumb sits under right now: the preview if one's supplied, else the real value.
  const shown = $derived(displayValue ?? value);

  function select(v: T) {
    value = v;
    onchange?.(v);
  }

  // The sliding thumb is a single element measured against the active button's box, so it
  // can translate/grow smoothly between segments of unequal width ("steer" vs "follow-up")
  // — a per-button background can't slide, it can only pop. `ready` gates the CSS transition
  // off for the very first measurement so the thumb appears in place instead of sliding in
  // from x=0 on mount.
  let container = $state<HTMLDivElement>();
  const btns: HTMLButtonElement[] = [];
  let thumb = $state<{ x: number; w: number; visible: boolean }>({
    x: 0,
    w: 0,
    visible: false,
  });
  let ready = $state(false);

  function measure(): void {
    const i = options.findIndex((o) => o.value === shown);
    const el = btns[i];
    if (!el) {
      thumb = { ...thumb, visible: false };
      return;
    }
    thumb = { x: el.offsetLeft, w: el.offsetWidth, visible: true };
  }

  // Re-measure whenever the shown segment, the option set, or the size variant changes.
  $effect(() => {
    void shown;
    void options.length;
    void size;
    measure();
  });

  onMount(() => {
    measure();
    // Enable the slide animation only after the initial in-place placement (next frame).
    const raf = requestAnimationFrame(() => (ready = true));
    // Labels reflow on container resize (font-scale, viewport) — keep the thumb aligned.
    const ro = new ResizeObserver(() => measure());
    if (container) ro.observe(container);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  });
</script>

<div
  class="seg {size}"
  class:ready
  role="radiogroup"
  aria-label={ariaLabel}
  bind:this={container}
>
  {#if thumb.visible}
    <span
      class="seg-thumb"
      aria-hidden="true"
      style="transform: translateX({thumb.x}px); width: {thumb.w}px;"
    ></span>
  {/if}
  {#each options as opt, i (opt.value)}
    <button
      bind:this={btns[i]}
      class="seg-btn"
      class:active={shown === opt.value}
      type="button"
      role="radio"
      aria-checked={shown === opt.value}
      data-testid={opt.testid}
      title={opt.title ?? opt.label}
      disabled={opt.disabled}
      onclick={() => select(opt.value)}
    >
      {#if opt.icon}<span class="seg-ico">{@render opt.icon()}</span>{/if}
      {opt.label}
    </button>
  {/each}
</div>

<style>
  .seg {
    position: relative;
    display: inline-flex;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 2px;
    flex-shrink: 0;
  }
  /* The single sliding highlight behind the buttons. A per-button background can only
     pop between segments; one shared, absolutely-positioned thumb can glide. Measured
     in JS (transform x + width), so it tracks segments of unequal width exactly. */
  .seg-thumb {
    position: absolute;
    top: 2px;
    bottom: 2px;
    left: 0;
    background: var(--surface);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-card);
    pointer-events: none;
    z-index: 0;
  }
  .seg.ready .seg-thumb {
    transition:
      transform 200ms cubic-bezier(0.22, 1, 0.36, 1),
      width 200ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    .seg.ready .seg-thumb {
      transition: none;
    }
  }
  .seg-btn {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--radius-pill);
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition: color 150ms ease;
  }
  .seg-btn.active {
    color: var(--text);
  }
  .seg-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .seg-ico {
    display: inline-flex;
  }

  /* md = Settings' theme switcher; sm = the composer's tighter mode switch. */
  .md .seg-btn {
    font-size: 12.5px;
    padding: 5px 12px;
  }
  .sm .seg-btn {
    font-size: 12px;
    padding: 3px 11px;
  }
</style>
