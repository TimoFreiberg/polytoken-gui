<script lang="ts">
  // Rendered only when thinking blocks are NOT hidden (Transcript gates on the toggle),
  // so there's a single expandable variant — no minimal/placeholder mode.
  let { text, streaming }: { text: string; streaming: boolean } = $props();
  let open = $state(false);
</script>

<div class="think" class:open>
  <button class="head" title={open ? "Collapse thinking" : "Expand thinking"} onclick={() => (open = !open)}>
    <span class="chev">{open ? "▾" : "▸"}</span>
    <span class="label">{streaming ? "Thinking…" : "Thought process"}</span>
    {#if streaming}<span class="shimmer"></span>{/if}
  </button>
  {#if open}
    <div class="body">{text}</div>
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
  .chev {
    font-size: 10px;
    color: var(--text-faint);
  }
  .label {
    font-style: italic;
  }
  .shimmer {
    width: 28px;
    height: 6px;
    border-radius: 99px;
    background: linear-gradient(90deg, var(--border) 25%, var(--text-faint) 50%, var(--border) 75%);
    background-size: 200% 100%;
    animation: slide 1.3s linear infinite;
  }
  @keyframes slide {
    to {
      background-position: -200% 0;
    }
  }
  .body {
    margin-top: 6px;
    font-size: 13.5px;
    color: var(--text-muted);
    white-space: pre-wrap;
    line-height: 1.55;
  }
</style>
