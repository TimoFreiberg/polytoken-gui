<script lang="ts">
  import type { SessionUsage } from "@pilot/protocol";
  import { contextTone } from "../lib/context-tone.js";

  // A color-coded context-window gauge: a fill ring + optional % label. Shared by the
  // composer meter and the sidebar rows so the scale + colors stay identical. The host
  // decides whether `usage` exists; this just renders the gauge for a given one.
  let {
    usage,
    size = 18,
    showLabel = true,
    testid,
  }: {
    usage: SessionUsage;
    size?: number;
    showLabel?: boolean;
    testid?: string;
  } = $props();

  // pct drives the ring; clamp the ARC to 100 (an overflow still reads the real % in
  // the label/tooltip). null tokens = window known but count pending (post-compaction).
  const pct = $derived(usage.percent);
  const arc = $derived(pct === null ? 0 : Math.max(0, Math.min(100, pct)));
  const pctLabel = $derived(
    pct === null ? "—" : pct < 1 && pct > 0 ? "<1%" : `${Math.round(pct)}%`,
  );
  const tone = $derived(contextTone(pct));

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
  const title = $derived.by(() => {
    const win = `${fmt(usage.contextWindow)} token window`;
    if (usage.tokens === null)
      return `Context size pending — recomputed after the next response · ${win}`;
    return `${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens in context · ${pctLabel} of the window`;
  });
</script>

<div class="meter {tone}" {title} data-testid={testid}>
  <svg
    class="ring"
    viewBox="0 0 36 36"
    width={size}
    height={size}
    aria-hidden="true"
  >
    <circle class="track" cx="18" cy="18" r="15.9155" />
    {#if arc > 0}
      <circle
        class="arc"
        cx="18"
        cy="18"
        r="15.9155"
        stroke-dasharray="{arc} 100"
        transform="rotate(-90 18 18)"
      />
    {/if}
  </svg>
  {#if showLabel}
    <span class="label">{pctLabel}</span>
  {/if}
</div>

<style>
  .meter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-sans);
    font-size: 12.5px;
    letter-spacing: -0.01em;
    color: var(--text-muted);
    /* Display-only — no pointer affordance; the tooltip carries the detail. */
    cursor: default;
    user-select: none;
  }
  .ring {
    flex-shrink: 0;
    overflow: visible;
  }
  .track {
    fill: none;
    stroke: var(--border-strong);
    stroke-width: 3.4;
  }
  .arc {
    fill: none;
    stroke-width: 3.4;
    stroke-linecap: round;
    transition:
      stroke-dasharray 0.3s ease,
      stroke 0.2s ease;
  }
  .ok .arc {
    stroke: var(--ok);
  }
  .warning .arc {
    stroke: var(--warning);
  }
  .accent .arc {
    stroke: var(--accent);
  }
  .danger .arc {
    stroke: var(--danger);
  }
  /* Escalating attention: the label picks up the band color once it matters; the
     calm green stays muted so a healthy window doesn't shout. */
  .warning .label {
    color: var(--warning);
  }
  .accent .label {
    color: var(--accent);
  }
  .danger .label {
    color: var(--danger);
  }
  .label {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
</style>
