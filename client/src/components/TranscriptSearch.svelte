<script lang="ts">
  import { tick } from "svelte";
  import { store } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";

  // Find-in-transcript (⌘F). Claude-style floating box pinned top-right of the transcript.
  // Matching uses the CSS Custom Highlight API (Range objects registered in CSS.highlights)
  // rather than wrapping matches in <mark> — so we never mutate the transcript DOM, which
  // would fight Svelte's rendering and shatter on the next stream delta / re-render. Where
  // the API is unsupported it degrades to scroll-to-match with no tint.
  let { scroller }: { scroller: HTMLElement | undefined } = $props();

  let input = $state<HTMLInputElement | null>(null);
  let query = $state("");
  let matches = $state<Range[]>([]);
  let current = $state(0);

  const HL_ALL = "pantoken-find";
  const HL_CURRENT = "pantoken-find-current";
  const supported =
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined";

  // Focus + select on open, and again on every ⌘F while open (searchFocusN bumps) so a
  // repeat press re-selects the query, mirroring the browser's native find.
  $effect(() => {
    store.searchFocusN;
    if (store.searchOpen)
      void tick().then(() => {
        input?.focus();
        input?.select();
      });
  });

  // Recompute on open / query change / session switch (scroller content swaps). Scrolls to
  // the first match. Closing clears everything.
  $effect(() => {
    store.searchOpen;
    query;
    scroller;
    if (!store.searchOpen) {
      clearHighlights();
      matches = [];
      current = 0;
      return;
    }
    current = 0;
    scheduleSearch(true);
  });

  // While open, keep matches fresh as the agent streams new content (or a turn re-renders).
  // A MutationObserver catches DOM the reactive query-effect won't; debounced, no auto-scroll
  // (recomputing mid-stream must not yank the viewport — only typing / next-prev scrolls).
  $effect(() => {
    if (!store.searchOpen || !scroller) return;
    const mo = new MutationObserver(() => scheduleSearch(false));
    mo.observe(scroller, { subtree: true, childList: true, characterData: true });
    return () => mo.disconnect();
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingScroll = false;
  function scheduleSearch(scroll: boolean): void {
    pendingScroll ||= scroll;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const s = pendingScroll;
      pendingScroll = false;
      runSearch(s);
    }, 110);
  }

  function runSearch(scroll: boolean): void {
    if (!store.searchOpen || !scroller) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      matches = [];
      current = 0;
      applyHighlights();
      return;
    }
    const found: Range[] = [];
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue!.toLowerCase();
      let from = 0;
      for (;;) {
        const i = text.indexOf(q, from);
        if (i === -1) break;
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + q.length);
        found.push(r);
        from = i + q.length;
      }
    }
    matches = found;
    if (current >= found.length) current = found.length ? found.length - 1 : 0;
    applyHighlights();
    if (scroll && found.length) scrollToCurrent();
  }

  function applyHighlights(): void {
    if (!supported) return;
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CURRENT);
    if (!matches.length) return;
    const cur = matches[current];
    const rest = matches.filter((_, i) => i !== current);
    if (rest.length) CSS.highlights.set(HL_ALL, new Highlight(...rest));
    if (cur) CSS.highlights.set(HL_CURRENT, new Highlight(cur));
  }

  function clearHighlights(): void {
    if (!supported) return;
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CURRENT);
  }

  function scrollToCurrent(): void {
    const r = matches[current];
    if (!r) return;
    // Signal the transcript to un-pin BEFORE scrollIntoView: the searchScrollN effect
    // sets pinned=false + marks a prog scroll window so the smooth scrollIntoView's
    // animation (which passes through the bottom zone where gap < 80 would re-pin) holds
    // the un-pinned state.
    store.searchScrollN++;
    const node = r.startContainer;
    const el =
      node.nodeType === Node.TEXT_NODE
        ? node.parentElement
        : (node as Element);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Step to the next/prev match, wrapping. Only navigation (and a fresh query) scrolls.
  function go(delta: number): void {
    if (!matches.length) return;
    current = (current + delta + matches.length) % matches.length;
    applyHighlights();
    scrollToCurrent();
  }

  function onInputKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      store.closeSearch();
    }
  }

  const countLabel = $derived(
    matches.length
      ? `${current + 1}/${matches.length}`
      : query.trim()
        ? "0/0"
        : "",
  );
</script>

{#if store.searchOpen}
  <div class="find" role="search" data-testid="transcript-search">
    <input
      bind:this={input}
      bind:value={query}
      class="find-input"
      type="text"
      placeholder="Find in transcript"
      aria-label="Find in transcript"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      onkeydown={onInputKey}
    />
    <span class="find-count" data-testid="find-count" aria-live="polite">{countLabel}</span>
    <IconButton
      size="sm"
      title="Previous match (⇧⏎)"
      aria-label="Previous match"
      disabled={!matches.length}
      onclick={() => go(-1)}>↑</IconButton
    >
    <IconButton
      size="sm"
      title="Next match (⏎)"
      aria-label="Next match"
      disabled={!matches.length}
      onclick={() => go(1)}>↓</IconButton
    >
    <IconButton
      size="sm"
      title="Close find (Esc)"
      aria-label="Close find"
      onclick={() => store.closeSearch()}>×</IconButton
    >
  </div>
{/if}

<style>
  /* Floating find box — pinned top-right of the transcript pane (.transcript-wrap is
     position: relative), overlaying scrollback like the "New messages ↓" pill. */
  .find {
    position: absolute;
    top: 10px;
    right: 14px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 5px 4px 12px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    box-shadow: var(--shadow-pop);
  }
  .find-input {
    width: 190px;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 13.5px;
    outline: none;
  }
  .find-input::placeholder {
    color: var(--text-faint);
  }
  .find-count {
    flex-shrink: 0;
    min-width: 34px;
    padding-right: 2px;
    text-align: right;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Phone: the transcript is the full width, so keep the box from overflowing the edge. */
  @media (max-width: 480px) {
    .find {
      left: 10px;
      right: 10px;
    }
    .find-input {
      width: auto;
      flex: 1;
      min-width: 0;
    }
  }
</style>
