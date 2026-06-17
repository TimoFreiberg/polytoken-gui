<script lang="ts">
  import { onMount } from "svelte";
  import type { TranscriptItem } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import { renderMarkdown } from "../lib/markdown.js";
  import ToolCard from "./ToolCard.svelte";
  import ThinkingBlock from "./ThinkingBlock.svelte";

  const items = $derived(store.session.items);

  let scroller = $state<HTMLDivElement>();
  let pinned = true;

  // A monotonically-bumped tick that forces relative timestamps to re-evaluate
  // on a coarse cadence. Cheap: one timer, no per-item state.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  /** Human-friendly relative time. Reads `now` so callers re-run on each tick. */
  function relativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const diff = now - then;
    if (diff < 45_000) return "just now";
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(diff / 3_600_000);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(diff / 86_400_000);
    return `${days}d ago`;
  }

  /** Exact local timestamp for the `title=` hover tooltip. */
  function exactTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // Per-item "Copied" feedback, keyed by item id. Cleared after a short delay.
  let copiedId = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyText(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedId = id;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copiedId = null;
      }, 1500);
    } catch {
      // Clipboard can reject (permissions / insecure context); leave UI as-is.
    }
  }

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

  /** Scroll so the most recent user prompt sits at the top of the viewport (your
   *  message + the response below it) — for re-reading what you last asked after
   *  scrolling through a long turn. Bound to Cmd/Ctrl+↑. */
  function jumpToLastPrompt(): void {
    if (!scroller) return;
    const prompts = scroller.querySelectorAll<HTMLElement>(".row.user");
    const last = prompts[prompts.length - 1];
    last?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // Global hotkey. Cmd/Ctrl modifier keeps it clear of the composer's type-to-focus
  // (which only grabs unmodified printable keys). Fires regardless of focus so it
  // works while reading scrollback.
  onMount(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === "ArrowUp") {
        e.preventDefault();
        jumpToLastPrompt();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="scroller" bind:this={scroller} onscroll={onScroll}>
  <div class="col">
    {#each items as item (item.id)}
      {#if item.kind === "user"}
        <div class="row user">
          <div class="bubble">{item.text}</div>
          {#if item.ts}
            <time class="ts" datetime={item.ts} title={exactTime(item.ts)}>{relativeTime(item.ts)}</time>
          {/if}
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
          <!-- Caret only while this item is streaming AND the session is actually
               running — guards against a stale streaming:true leaving a blinking
               caret after an idle transition that arrived only as sessionUpdated. -->
          {#if item.streaming && store.streaming}<span class="caret"></span>{/if}
          {#if item.text && (!item.streaming || !store.streaming)}
            <div class="meta">
              <button
                class="copy"
                type="button"
                onclick={() => copyText(item.id, item.text)}
                title="Copy message"
                aria-label="Copy message"
              >
                {copiedId === item.id ? "Copied" : "Copy"}
              </button>
              {#if item.ts}
                <time class="ts" datetime={item.ts} title={exactTime(item.ts)}>{relativeTime(item.ts)}</time>
              {/if}
            </div>
          {/if}
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
  /* tiny relative timestamp under each turn */
  .ts {
    font-size: 11px;
    line-height: 1;
    color: var(--text-faint);
    user-select: none;
    cursor: default;
  }
  .row.user .ts {
    margin-top: 4px;
    padding-right: 2px;
  }
  /* assistant footer: copy button + timestamp, revealed on row hover */
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: -2px;
    min-height: 18px;
  }
  .copy {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    font-size: 11px;
    line-height: 1;
    padding: 3px 8px;
    border-radius: var(--radius-xs);
    opacity: 0;
    transition:
      opacity 0.12s ease,
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .assistant:hover .copy,
  .copy:focus-visible {
    opacity: 1;
  }
  .copy:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .copy:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
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

  /* prose — readability pass (OP8). Only typography/spacing; palette untouched.
     The markdown renderer only emits p / strong / em / a / code / pre. */
  .prose {
    line-height: 1.66;
    overflow-wrap: anywhere;
    /* opt into proportional/contextual numerals + ligatures where available */
    font-variant-numeric: proportional-nums;
  }
  .prose :global(p) {
    margin: 0 0 0.7em;
  }
  .prose :global(p:last-child) {
    margin-bottom: 0;
  }
  .prose :global(strong) {
    font-weight: 600;
  }
  .prose :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.15em;
    overflow-wrap: anywhere;
  }
  .prose :global(a:hover) {
    color: var(--accent-hover);
  }
  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.86em;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 0.1em 0.36em;
    border-radius: var(--radius-xs);
    /* keep inline code from inflating line box height */
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .prose :global(pre) {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    overflow-x: auto;
    margin: 0.85em 0;
    -webkit-overflow-scrolling: touch;
  }
  .prose :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.85em;
    line-height: 1.6;
    /* code blocks scroll horizontally rather than wrap */
    overflow-wrap: normal;
    tab-size: 2;
  }
</style>
