<script lang="ts">
  // Rendered only when thinking blocks are NOT hidden (Transcript gates on the toggle),
  // so there's a single expandable variant — no minimal/placeholder mode.
  import { reveal } from "../lib/transitions.js";
  import Chevron from "./ui/Chevron.svelte";
  import CollapseFooter from "./ui/CollapseFooter.svelte";
  let { text, streaming }: { text: string; streaming: boolean } = $props();
  let open = $state(false);
</script>

<div class="think" class:open>
  <button
    class="head"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span class="label">{streaming ? "Thinking…" : "Thought process"}</span>
    <Chevron {open} size={10} />
  </button>
  {#if open}
    <div class="body" transition:reveal>{text}<CollapseFooter onCollapse={() => (open = false)} /></div>
  {/if}
</div>

<style>
  .think {
    min-width: 0;
  }
  .head {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    margin-left: -5px;
    padding: 3px 5px;
    border-radius: 6px;
    color: var(--text-muted);
    font-size: 13px;
  }
  /* The pinned (sticky) header was removed per issue #81 — the sticky header was
     hard to see when the block was tall. A bottom collapse chevron (CollapseFooter)
     replaces it. The header stays in normal flow as a label + top toggle. */
  .head:hover,
  .head:focus-visible {
    color: color-mix(in srgb, var(--text) 35%, var(--text-muted));
  }
  .head:hover :global(.chevron),
  .head:focus-visible :global(.chevron) {
    color: color-mix(in srgb, var(--text-muted) 65%, var(--text-faint));
  }
  .label {
    font-style: italic;
  }
  .body {
    margin-top: 6px;
    padding-left: 5px;
    font-size: 13.5px;
    color: var(--text-muted);
    white-space: pre-wrap;
    line-height: 1.55;
  }
  @media (max-width: 859px) {
    .head {
      min-height: 44px;
    }
  }
</style>
