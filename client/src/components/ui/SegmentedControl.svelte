<script lang="ts" generics="T extends string">
  import type { Snippet } from "svelte";

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
  };

  interface Props {
    options: Option[];
    value: T;
    ariaLabel: string;
    size?: "sm" | "md";
    onchange?: (value: T) => void;
  }

  let {
    options,
    value = $bindable(),
    ariaLabel,
    size = "md",
    onchange,
  }: Props = $props();

  function select(v: T) {
    value = v;
    onchange?.(v);
  }
</script>

<div class="seg {size}" role="radiogroup" aria-label={ariaLabel}>
  {#each options as opt (opt.value)}
    <button
      class="seg-btn"
      class:active={value === opt.value}
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      title={opt.title ?? opt.label}
      onclick={() => select(opt.value)}
    >
      {#if opt.icon}<span class="seg-ico">{@render opt.icon()}</span>{/if}
      {opt.label}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px;
    flex-shrink: 0;
  }
  .seg-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 999px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }
  .seg-btn.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-card);
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
