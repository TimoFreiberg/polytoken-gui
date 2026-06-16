<script lang="ts">
  import type { TranscriptItem } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import { renderMarkdown } from "../lib/markdown.js";
  import ToolCard from "./ToolCard.svelte";
  import ThinkingBlock from "./ThinkingBlock.svelte";

  const items = $derived(store.session.items);

  let scroller = $state<HTMLDivElement>();
  let pinned = true;

  function onScroll() {
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    pinned = gap < 80;
  }

  // keep pinned to the bottom while streaming, unless the user scrolled up
  $effect(() => {
    // touch the things that should trigger a re-scroll
    const _len = items.length;
    const _last = items[items.length - 1];
    const _tick = _last && _last.kind === "assistant" ? _last.text.length + _last.thinking.length : 0;
    void _len;
    void _tick;
    if (pinned && scroller) {
      queueMicrotask(() => scroller && scroller.scrollTo({ top: scroller.scrollHeight }));
    }
  });

  function isToolItem(i: TranscriptItem) {
    return i.kind === "tool";
  }
</script>

<div class="scroller" bind:this={scroller} onscroll={onScroll}>
  <div class="col">
    {#each items as item (item.id)}
      {#if item.kind === "user"}
        <div class="row user">
          <div class="bubble">{item.text}</div>
        </div>
      {:else if item.kind === "assistant"}
        <div class="row assistant">
          {#if item.thinking}
            <ThinkingBlock text={item.thinking} streaming={item.streaming && !item.text} />
          {/if}
          {#if item.text}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="prose">{@html renderMarkdown(item.text)}</div>
          {/if}
          {#if item.streaming}<span class="caret"></span>{/if}
        </div>
      {:else if isToolItem(item)}
        <ToolCard {item} />
      {:else if item.kind === "notice"}
        <div class="row notice {item.level}">
          <span class="ico">{item.level === "error" ? "✕" : item.level === "warning" ? "⚠" : "ℹ"}</span>
          <span>{item.text}</span>
        </div>
      {/if}
    {/each}
    {#if items.length === 0}
      <div class="empty">No messages yet. Say something below to start a turn.</div>
    {/if}
  </div>
</div>

<style>
  .scroller {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .col {
    max-width: var(--maxw);
    margin: 0 auto;
    padding: 22px 18px 28px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .row {
    display: flex;
    flex-direction: column;
  }
  .row.user {
    align-items: flex-end;
  }
  .user .bubble {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 10px 14px;
    border-radius: var(--radius);
    border-bottom-right-radius: 4px;
    max-width: 86%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .assistant {
    gap: 8px;
  }
  .caret {
    display: inline-block;
    width: 8px;
    height: 1.1em;
    background: var(--accent);
    border-radius: 1px;
    animation: blink 1s steps(2) infinite;
    vertical-align: text-bottom;
    margin-top: 2px;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .notice {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-muted);
    align-self: center;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: 999px;
  }
  .notice.error {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .notice.warning {
    color: var(--warning);
    background: var(--warning-soft);
    border-color: color-mix(in srgb, var(--warning) 30%, transparent);
  }
  .empty {
    color: var(--text-faint);
    text-align: center;
    padding: 60px 0;
    font-size: 14px;
  }

  /* prose */
  .prose :global(p) {
    margin: 0 0 10px;
  }
  .prose :global(p:last-child) {
    margin-bottom: 0;
  }
  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.88em;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: var(--radius-xs);
  }
  .prose :global(pre) {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    overflow-x: auto;
    margin: 10px 0;
  }
  .prose :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.86em;
    line-height: 1.55;
  }
</style>
