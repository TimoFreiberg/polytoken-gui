<script lang="ts">
  import { reveal } from "../lib/transitions.js";
  import type { MergedToolsItem } from "../lib/transcript-view.js";
  import { mergedSummary } from "../lib/transcript-view.js";
  import ToolCard from "./ToolCard.svelte";
  import Chevron from "./ui/Chevron.svelte";

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
  // A quiet status dot only when it carries signal — an error in the run. A sealed run's
  // tools have all finished (the model moved on, or the turn settled), so it never shows
  // a running dot; the common settled-ok run shows nothing, keeping the row as subdued as
  // the reference Codex/Claude transcripts (just grey prose + a chevron).
  const dot = $derived(status === "error" ? "✕" : null);
</script>

<!-- Deliberately the OPPOSITE of ToolCard's shell: a sealed run is ambient noise, so it
     renders as a borderless grey disclosure row (matching the "Worked for Ns" header and
     the nudge pill), not a highlighted card. The high-signal tools (write/edit) stay as
     standalone bordered cards; everything else recedes into this collapsed prose line.

     Only SEALED runs reach this component — a still-streaming run renders as a bare flat
     list in Transcript (no folder) and only folds in here once it seals. -->
<div class="tool summary {status}">
  <button
    class="head"
    title={`${open ? "Collapse" : "Expand"} — ${summary} (Enter)`}
    onclick={ontoggle}
    aria-expanded={open}
  >
    <Chevron {open} size={10} />
    {#if dot}<span class="status" aria-hidden="true">{dot}</span>{/if}
    <span class="label">{summary}</span>
  </button>
  {#if open}
    <div class="body" transition:reveal>
      {#each item.tools as tool (tool.id)}
        <ToolCard item={tool} flat />
      {/each}
    </div>
  {/if}
</div>

<style>
  .summary {
    /* no box of its own — the summary card is a bare header + optional body. */
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
  .head:hover :global(.chevron),
  .head:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  .head:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs);
  }
  /* Status dot only renders for an errored run (see `dot`). */
  .status {
    font-size: 9px;
    line-height: 1;
    flex-shrink: 0;
  }
  .summary.error .status {
    color: var(--danger);
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
    /* Flat child rows carry their own header padding for vertical rhythm, so the inter-row
       gap is tight — a tight list, not spaced-out cards. */
    gap: 1px;
  }
</style>
