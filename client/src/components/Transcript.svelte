<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/store.svelte.js";
  import {
    type DisplayItem,
    groupTurns,
    mergeTools,
    type TurnGroup,
    workedLabel,
  } from "../lib/transcript-view.js";
  import Markdown from "./Markdown.svelte";
  import ToolCard from "./ToolCard.svelte";
  import ToolSummary from "./ToolSummary.svelte";
  import ThinkingBlock from "./ThinkingBlock.svelte";

  const items = $derived(store.session.items);

  // Touch devices have no hover, so the copy footer (hover-revealed on desktop) would be
  // unreachable. Pin it visible on touch-primary devices. Gate on a JS capability check
  // (maxTouchPoints), NOT `@media (hover: none)` — headless Chromium reports hover:none
  // and would force the button visible on desktop too, breaking the desktop fade-out spec.
  const isTouch =
    typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;

  // Two view-model passes (pure, unit-tested in transcript-view.test.ts):
  //   1. mergeTools — uninterrupted runs of every tool except write/edit fold into
  //      one summary card.
  //   2. groupTurns — each turn (user → next user) splits into a collapsible "work"
  //      portion (tools + intermediate narration) and the turn-final response that
  //      stays visible. That's the "Worked for Ns" block below.
  const displayItems = $derived(mergeTools(items));
  // While the last turn is active, its trailing text is only a candidate final
  // response — another tool can still follow. Keep the whole turn inline until the
  // lifecycle says it settled, then expose the collapse affordance.
  const turns = $derived(groupTurns(displayItems, store.turnActive));
  const lastTurnId = $derived(turns[turns.length - 1]?.id);
  function turnDone(turn: TurnGroup): boolean {
    return turn.id !== lastTurnId || !store.turnActive;
  }

  // Per-turn open/close for the work block. Default: collapsed once the turn settles,
  // expanded while it's still in flight. An explicit user toggle overrides the default.
  let workOpen = $state<Record<string, boolean>>({});
  function toggleWork(id: string) {
    const turn = turns.find((t) => t.id === id);
    const current = workOpen[id] ?? (turn ? !turnDone(turn) : false);
    workOpen = { ...workOpen, [id]: !current };
  }
  function workShown(turn: TurnGroup): boolean {
    return workOpen[turn.id] ?? !turnDone(turn);
  }

  // Per-turn aggregation for the assistant footer (copy + timestamp). Only the LAST
  // assistant paragraph of a turn carries the footer: paragraphs interleaved between
  // tool calls omit it (less visual noise), and its copy grabs ALL of the turn's
  // assistant text (every paragraph joined), excluding tool + thinking blocks. A turn
  // runs from one user message to the next; the map is keyed by the turn-final
  // text-bearing assistant item's id, with the joined turn text as its value.
  const turnText = $derived.by(() => {
    const map = new Map<string, string>();
    let buf: string[] = [];
    let lastId: string | null = null;
    const flush = () => {
      if (lastId !== null) map.set(lastId, buf.join("\n\n"));
      buf = [];
      lastId = null;
    };
    for (const it of displayItems) {
      if (it.kind === "user") {
        flush();
      } else if (it.kind === "assistant" && it.text) {
        buf.push(it.text);
        lastId = it.id;
      }
    }
    flush();
    return map;
  });

  // Keep summary expansion outside ToolSummary so transcript refreshes cannot
  // remount a live card and collapse it between the outer and inner clicks.
  // The first call id is stable as more calls append to the same summarized run.
  let mergedOpen = $state<Record<string, boolean>>({});
  function toggleMerged(id: string) {
    mergedOpen = { ...mergedOpen, [id]: !mergedOpen[id] };
  }

  let scroller = $state<HTMLDivElement>();
  // Reactive so `showNewPill` ($derived) re-evaluates when scrolling flips it.
  let pinned = $state(true);

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
    // `iso` may be an ISO 8601 string or epoch milliseconds as a string.
    // Number(iso) handles the epoch-ms case; Date.parse handles ISO strings.
    const then = new Date(Number(iso) || iso).getTime();
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
    const d = new Date(Number(iso) || iso);
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

  // A scalar that grows whenever the transcript gains content: item count plus the
  // streaming length of the last item. Reactive — the grow-detector effect reads it.
  const contentSize = $derived.by(() => {
    const last = items[items.length - 1];
    const tick =
      last && last.kind === "assistant"
        ? last.text.length + last.thinking.length
        : 0;
    return items.length * 1_000_000 + tick;
  });
  // The previous content size, to tell "the transcript grew" from "it re-rendered".
  // Starts at -1 so the first measurement never reads as growth.
  let prevSize = -1;

  function onScroll() {
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    pinned = gap < 80;
    // Reaching the bottom clears the active-session unread flag (you've seen it all).
    if (pinned) store.clearActiveUnread();
  }

  // keep pinned to the bottom while streaming, unless the user scrolled up
  $effect(() => {
    const size = contentSize;
    const grew = size > prevSize && prevSize !== -1;
    prevSize = size;
    if (pinned && scroller) {
      queueMicrotask(
        () => scroller && scroller.scrollTo({ top: scroller.scrollHeight }),
      );
      // Pinned + caught up: nothing is below the fold.
      store.clearActiveUnread();
    } else if (grew) {
      // New content landed while scrolled up — it's below the viewport. Flag the active
      // session unread (the "new messages ↓" signal); the pill below offers a jump.
      store.markActiveUnread();
    }
  });

  /** Jump to the newest content and clear the unread flag (the "new messages ↓" pill). */
  function scrollToBottom(): void {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    pinned = true;
    store.clearActiveUnread();
  }

  // True when the active session has content below the viewport (drives the pill).
  const showNewPill = $derived(!pinned && store.activeUnread);

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

<div class="transcript-wrap">
<div class="scroller" class:touch={isTouch} bind:this={scroller} onscroll={onScroll}>
  <div class="col">
    <!-- One transcript item, rendered the same whether it sits in a turn's collapsible
         work block or as the visible final response. -->
    {#snippet itemView(item: DisplayItem)}
      {#if item.kind === "user"}
        <div class="row user">
          <div class="bubble">{item.text}</div>
          {#if item.ts}
            <time class="ts" datetime={item.ts} title={exactTime(item.ts)}>{relativeTime(item.ts)}</time>
          {/if}
        </div>
      {:else if item.kind === "assistant"}
        <div class="row assistant">
          <!-- Thinking blocks are hidden entirely when the Settings toggle is on (the
               default) — no collapsed stub, nothing. The composer's "Thinking…" indicator
               carries the feedback instead. -->
          {#if item.thinking && !store.hideThinking}
            <ThinkingBlock text={item.thinking} streaming={item.streaming && !item.text} />
          {/if}
          {#if item.text}
            <Markdown
              content={item.text}
              final={!(item.streaming && store.turnActive)}
            />
          {/if}
          <!-- "Still working" lives in the bottom WorkingIndicator now, not as an
               inline caret on the streaming paragraph. The copy + timestamp footer
               shows ONLY on the turn-final paragraph (turnText holds its id), once the
               turn settles — interleaved mid-turn paragraphs stay bare. -->
          {#if turnText.has(item.id) && (!item.streaming || !store.turnActive)}
            <div class="meta">
              <button
                class="copy"
                class:copied={copiedId === item.id}
                type="button"
                onclick={(e) => {
                  // Copy the WHOLE turn's assistant text (all paragraphs joined), not
                  // just this final block.
                  copyText(item.id, turnText.get(item.id) ?? item.text);
                  // Drop focus so a mouse click doesn't leave the button pinned
                  // visible via :focus-visible after the pointer leaves the row.
                  e.currentTarget.blur();
                }}
                title={copiedId === item.id ? "Copied" : "Copy message"}
                aria-label="Copy message"
              >
                {#if copiedId === item.id}
                  <svg
                    class="ico"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                {:else}
                  <svg
                    class="ico"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                {/if}
              </button>
              {#if item.ts}
                <time class="ts" datetime={item.ts} title={exactTime(item.ts)}>{relativeTime(item.ts)}</time>
              {/if}
            </div>
          {/if}
        </div>
      {:else if item.kind === "mergedTools"}
        <ToolSummary
          {item}
          open={mergedOpen[item.id] ?? false}
          ontoggle={() => toggleMerged(item.id)}
        />
      {:else if item.kind === "tool"}
        <ToolCard {item} />
      {:else if item.kind === "notice"}
        <div class="row notice {item.level}">
          <span class="ico">{item.level === "error" ? "✕" : item.level === "warning" ? "⚠" : "ℹ"}</span>
          <span class="ntext">{item.text}</span>
          {#if item.level === "error"}
            <span class="nactions">
              {#if store.lastPrompt}
                <button
                  class="naction"
                  title="Re-send the last prompt"
                  onclick={() => store.retryLast()}>Retry</button
                >
              {/if}
              <button
                class="naction"
                title="Copy the error message"
                onclick={() => copyText(item.id, item.text)}
                >{copiedId === item.id ? "Copied" : "Copy"}</button
              >
            </span>
          {/if}
        </div>
      {/if}
    {/snippet}

    {#each turns as turn (turn.id)}
      {#if turn.user}
        {@render itemView(turn.user)}
      {/if}
      {#if turn.collapsible}
        <!-- Codex-style working block: the turn's tools + intermediate narration
             collapse behind a "Worked for Ns" header only once the turn settles; the
             final response (rendered after) stays visible. -->
        <div class="turn-work" class:open={workShown(turn)}>
          <button
            class="work-head"
            data-testid="work-toggle"
            onclick={() => toggleWork(turn.id)}
            aria-expanded={workShown(turn)}
            title={workShown(turn)
              ? "Collapse the agent's working steps for this turn"
              : "Expand the agent's working steps for this turn"}
          >
            <span class="chevron" class:open={workShown(turn)}>▸</span>
            <span class="work-label">{turnDone(turn) ? workedLabel(turn) : "Working…"}</span>
          </button>
          {#if workShown(turn)}
            <div class="work-body" data-testid="work-body">
              {#each turn.work as it (it.id)}
                {@render itemView(it)}
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        {#each turn.work as it (it.id)}
          {@render itemView(it)}
        {/each}
      {/if}
      {#each turn.response as it (it.id)}
        {@render itemView(it)}
      {/each}
    {/each}
    {#if turns.length === 0}
      <div class="empty">No messages yet. Say something below to start a turn.</div>
    {/if}
  </div>
</div>
{#if showNewPill}
  <button
    class="new-pill"
    data-testid="new-messages-pill"
    title="Jump to the newest messages"
    aria-label="New messages below — jump to newest"
    onclick={scrollToBottom}
  >
    New messages ↓
  </button>
{/if}
</div>

<style>
  .transcript-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .scroller {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  /* "New messages ↓" pill — floats over the transcript when content lands below the
     fold while scrolled up. Centered near the bottom, above the composer. */
  .new-pill {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12.5px;
    font-weight: 550;
    color: var(--accent-text);
    background: var(--accent);
    border: none;
    border-radius: 999px;
    padding: 7px 14px;
    box-shadow: var(--shadow-pop);
    cursor: pointer;
    animation: pillIn 0.16s ease;
  }
  .new-pill:hover {
    background: var(--accent-hover);
  }
  @keyframes pillIn {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .new-pill {
      animation: none;
    }
  }
  .col {
    max-width: var(--maxw);
    margin: 0 auto;
    padding: 22px 18px 28px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .row, :global(.tool) {
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    padding: 4px;
    border-radius: var(--radius-xs);
    opacity: 0;
    transition:
      opacity 0.12s ease,
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .copy .ico {
    display: block;
    width: 13px;
    height: 13px;
  }
  .assistant:hover .copy,
  .copy:focus-visible {
    opacity: 1;
  }
  /* Touch devices have no hover; pin the copy button visible so it stays reachable. */
  .scroller.touch .copy {
    opacity: 1;
  }
  .copy:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  /* brief post-copy confirmation — the check icon picks up the accent tint */
  .copy.copied {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
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
  .nactions {
    display: inline-flex;
    gap: 6px;
    margin-left: 2px;
  }
  .naction {
    font-size: 12px;
    color: inherit;
    background: color-mix(in srgb, currentColor 12%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 999px;
    padding: 2px 9px;
    cursor: pointer;
  }
  .naction:hover {
    background: color-mix(in srgb, currentColor 20%, transparent);
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
  /* ── Per-turn "Worked for Ns" block (Codex-style collapsed working section) ── */
  .turn-work {
    content-visibility: auto;
    contain-intrinsic-size: auto 44px;
  }
  .work-head {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: none;
    padding: 2px 0;
    color: var(--text-muted);
    font-size: 12.5px;
    cursor: pointer;
  }
  .work-head:hover {
    color: var(--text);
  }
  .work-head .chevron {
    font-size: 10px;
    width: 12px;
    text-align: center;
    color: var(--text-faint);
    transition: transform 0.12s;
    flex-shrink: 0;
  }
  .work-head .chevron.open {
    transform: rotate(90deg);
  }
  .work-head .work-label {
    font-weight: 550;
  }
  /* When expanded, the work items indent under the header with a thread line. */
  .work-body {
    margin-top: 10px;
    margin-left: 5px;
    padding-left: 13px;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
</style>
