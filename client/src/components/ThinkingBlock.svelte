<script lang="ts">
  // Rendered only when thinking blocks are NOT hidden (Transcript gates on the toggle),
  // so there's a single expandable variant — no minimal/placeholder mode.
  import { reveal } from "../lib/transitions.js";
  import Chevron from "./ui/Chevron.svelte";
  let { text, streaming }: { text: string; streaming: boolean } = $props();
  let open = $state(false);
</script>

<div class="think" class:open>
  <button class="head" onclick={() => (open = !open)}>
    <Chevron {open} size={10} />
    <span class="label">{streaming ? "Thinking…" : "Thought process"}</span>
  </button>
  {#if open}
    <div class="body" transition:reveal>{text}</div>
  {/if}
</div>

<style>
  .think {
    border-left: 2px solid var(--border-strong);
    padding-left: 10px;
  }
  .head {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: none;
    padding: 2px 0;
    color: var(--text-muted);
    font-size: 13px;
  }
  .head:hover :global(.chevron),
  .head:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  .label {
    font-style: italic;
  }
  .body {
    margin-top: 6px;
    font-size: 13.5px;
    color: var(--text-muted);
    white-space: pre-wrap;
    line-height: 1.55;
  }
</style>
