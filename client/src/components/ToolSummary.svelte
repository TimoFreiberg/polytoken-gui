<script lang="ts">
  import type { MergedToolsItem } from "../lib/transcript-view.js";
  import { mergedSummary } from "../lib/transcript-view.js";
  import ToolCard from "./ToolCard.svelte";

  let {
    item,
    open,
    ontoggle,
  }: {
    item: MergedToolsItem;
    open: boolean;
    ontoggle: () => void;
  } = $props();

  const status = $derived.by(() => {
    if (item.tools.some((tool) => tool.status === "error")) return "error";
    if (item.tools.some((tool) => tool.status === "running")) return "running";
    return "ok";
  });
  const summary = $derived(mergedSummary(item));
  // A quiet status dot only when it carries signal — running (live) or error. The
  // common settled-ok run shows nothing, keeping the row as subdued as the reference
  // Codex/Claude transcripts (just grey prose + a chevron).
  const dot = $derived(
    status === "running" ? "○" : status === "error" ? "✕" : null,
  );
</script>

<!-- Deliberately the OPPOSITE of ToolCard's shell: a merged run is ambient noise, so it
     renders as a borderless grey disclosure row (matching the "Worked for Ns" header and
     the nudge pill), not a highlighted card. The high-signal tools (write/edit) stay as
     standalone bordered cards; everything else recedes into this line. -->
<div class="tool summary {status}">
  <button
    class="head"
    title={`${open ? "Collapse" : "Expand"} — ${summary} (Enter)`}
    onclick={ontoggle}
    aria-expanded={open}
  >
    <span class="chev" class:open>▸</span>
    {#if dot}<span class="status" aria-hidden="true">{dot}</span>{/if}
    <span class="label">{summary}</span>
  </button>
  {#if open}
    <div class="body">
      {#each item.tools as tool (tool.id)}
        <ToolCard item={tool} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .summary {
    /* content-visibility win on long transcripts; no box of its own. Intentional — see the
       note on store.svelte.ts logRenderTiming; it's load-bearing for the autoscroll pin. */
    content-visibility: auto;
    contain-intrinsic-size: auto 24px;
  }
  .head {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: none;
    padding: 2px 0;
    text-align: left;
    color: var(--text-muted);
    font-size: 12.5px;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .head:hover {
    color: var(--text);
  }
  .head:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs);
  }
  .chev {
    font-size: 10px;
    width: 12px;
    text-align: center;
    color: var(--text-faint);
    flex-shrink: 0;
    transition: transform 0.12s ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  /* Status dot only renders for running/error (see `dot`). */
  .status {
    font-size: 9px;
    line-height: 1;
    flex-shrink: 0;
  }
  .summary.running .status {
    color: var(--accent);
    animation: blink 1s ease-in-out infinite;
  }
  .summary.error .status {
    color: var(--danger);
  }
  @keyframes blink {
    50% {
      opacity: 0.3;
    }
  }
  .label {
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  /* Expanded detail: the full tool cards, indented under the row with a thread line so
     they read as "the calls behind this summary" regardless of nesting context. */
  .body {
    margin-top: 9px;
    margin-left: 5px;
    padding-left: 13px;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: reveal 0.16s ease;
  }
  @keyframes reveal {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .body {
      animation: none;
    }
  }
</style>
