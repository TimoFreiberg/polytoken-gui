<script lang="ts">
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { store } from "../lib/store.svelte.js";
  import {
    type DisplayItem,
    groupTurns,
    injectText,
    mergeTools,
    type TurnGroup,
    workedLabel,
  } from "../lib/transcript-view.js";
  import Markdown from "./Markdown.svelte";
  import ToolCard from "./ToolCard.svelte";
  import ToolSummary from "./ToolSummary.svelte";
  import ThinkingBlock from "./ThinkingBlock.svelte";
  import QnaResult from "./QnaResult.svelte";

  const items = $derived(store.transcriptItems);

  // Touch devices have no hover, so the copy footer (hover-revealed on desktop) would be
  // unreachable. Pin it visible on touch-primary devices. Gate on a JS capability check
  // (maxTouchPoints), NOT `@media (hover: none)` — headless Chromium reports hover:none
  // and would force the button visible on desktop too, breaking the desktop fade-out spec.
  const isTouch =
    typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;

  // The branch handle of the most recent user prompt — the target of the
  // Cmd/Ctrl+Shift+↑ "branch from last prompt" hotkey, so its button can advertise the
  // shortcut. undefined when no prompt carries an entry id yet.
  const lastUserEntryId = $derived.by(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.kind === "user" && it.entryId) return it.entryId;
    }
    return undefined;
  });
  // The entry id of the active path's TIP — the last transcript item that carries one.
  // Branching "from here" on the tip is a no-op (it's already where the next message
  // appends), so the turn-final assistant footer suppresses its branch button there.
  // "Last item with an entry id" (any kind) — not "last assistant" — so a committed user
  // prompt with no answer yet correctly shifts the tip off the prior assistant, keeping
  // that earlier turn genuinely branchable. (Real pi backfills an entry id on every
  // settled turn; the mock now matches so this holds across both drivers.)
  const leafEntryId = $derived.by(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      // Only user/assistant items carry an entry id (tool items never do), so the tip is
      // the last of those — a trailing tool item is part of its turn, not a fork point.
      if (it && (it.kind === "user" || it.kind === "assistant") && it.entryId)
        return it.entryId;
    }
    return undefined;
  });
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
      if (it.kind === "user" || it.kind === "inject") {
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

  // Per-inject expand state — a nudge note renders as a tiny collapsed pill by
  // default; clicking reveals its text. Keyed by item id, default collapsed.
  let injectOpen = $state<Record<string, boolean>>({});
  function toggleInject(id: string) {
    injectOpen = { ...injectOpen, [id]: !injectOpen[id] };
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
    let tick = 0;
    if (last?.kind === "assistant") {
      tick = last.text.length + last.thinking.length;
    } else if (last?.kind === "tool") {
      // A running tool streams its output into `text` (and ticks `progress`) via
      // toolUpdated. Count it too, so the pinned-scroll effect re-runs and keeps
      // following a long command's output — not just assistant deltas.
      tick = (last.text?.length ?? 0) + (last.progress ?? 0);
    }
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

  // Jump to the bottom whenever the user sends a prompt. Sending is a strong "show me
  // what I just said and the reply" signal, so we re-pin and scroll even if they'd
  // scrolled up reading scrollback — otherwise the just-sent bubble lands below the fold
  // behind the "New messages ↓" pill. Tracked via a store counter so each send re-fires;
  // initialized to the current value so a remount never scroll-jumps on its own.
  let lastSendN = store.promptSentN;
  $effect(() => {
    const n = store.promptSentN;
    if (n === lastSendN) return;
    lastSendN = n;
    pinned = true;
    store.clearActiveUnread();
    // Defer so the optimistic user bubble is in the DOM before we measure scrollHeight.
    queueMicrotask(
      () => scroller && scroller.scrollTo({ top: scroller.scrollHeight }),
    );
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
        // Shift = act on the last prompt (branch/re-edit); plain = just scroll to it.
        if (e.shiftKey) store.branchLastPrompt();
        else jumpToLastPrompt();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "ArrowDown") {
        // The inverse of ⌘↑: return to the live bottom from anywhere in scrollback.
        e.preventDefault();
        scrollToBottom();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="transcript-wrap">
<div class="scroller" class:touch={isTouch} bind:this={scroller} onscroll={onScroll}>
  <div class="col">
    <!-- Branch ("jump here") affordance — a git-fork glyph. Reused on user prompts and
         turn-final assistant paragraphs. -->
    {#snippet branchIcon()}
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
        <circle cx="6" cy="5" r="2.2" />
        <circle cx="6" cy="19" r="2.2" />
        <circle cx="18" cy="9" r="2.2" />
        <path d="M6 7.2v9.6" />
        <path d="M18 11.2v.6a4 4 0 0 1-4 4H6" />
      </svg>
    {/snippet}

    <!-- One transcript item, rendered the same whether it sits in a turn's collapsible
         work block or as the visible final response. -->
    {#snippet itemView(item: DisplayItem)}
      {#if item.kind === "user"}
        <div class="row user" class:pending={item.delivery && item.delivery !== "rejected"} class:rejected={item.delivery === "rejected"}>
          {#if item.images && item.images.length > 0}
            <div class="user-images">
              {#each item.images as image, index (index)}
                <img
                  class="att-img"
                  src="data:{image.mimeType};base64,{image.data}"
                  alt={`Attached image ${index + 1}`}
                  title="Image you attached to this message"
                  data-testid="sent-image"
                />
              {/each}
            </div>
          {/if}
          {#if item.text}
            <div class="bubble">{item.text}</div>
          {/if}
          {#if item.delivery}
            <div class="delivery {item.delivery}" role={item.delivery === "rejected" ? "alert" : "status"}>
              <span>
                {item.delivery === "sending"
                  ? "Sending…"
                  : item.delivery === "connecting"
                    ? "Sending when reconnected…"
                    : item.delivery === "offline"
                      ? "Queued offline"
                      : `Not sent${item.deliveryError ? ` — ${item.deliveryError}` : ""}`}
              </span>
              {#if item.delivery === "rejected"}
                <button
                  type="button"
                  title="Try sending this prompt again"
                  onclick={() => store.retryPending(item.id)}>Retry</button
                >
                <button
                  type="button"
                  title="Return this prompt and its images to the composer"
                  onclick={() => store.editPending(item.id)}>Edit</button
                >
              {/if}
            </div>
          {/if}
          {#if item.entryId || (item.ts && !item.delivery)}
            <div class="umeta">
              {#if item.entryId}
                <button
                  class="branch"
                  type="button"
                  onclick={(e) => {
                    if (item.entryId) store.branch(item.entryId);
                    e.currentTarget.blur();
                  }}
                  title={item.entryId === lastUserEntryId
                    ? "Branch from this prompt — edit & resend (⌘⇧↑)"
                    : "Branch from this prompt — edit & resend"}
                  aria-label="Branch from this prompt"
                >
                  {@render branchIcon()}
                </button>
              {/if}
              {#if item.ts}
                <time class="ts" datetime={item.ts} title={exactTime(item.ts)}>{relativeTime(item.ts)}</time>
              {/if}
            </div>
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
              {#if item.entryId && item.entryId !== leafEntryId}
                <button
                  class="branch"
                  type="button"
                  onclick={(e) => {
                    if (item.entryId) store.branch(item.entryId);
                    e.currentTarget.blur();
                  }}
                  title="Branch from here — continue on a new path"
                  aria-label="Branch from here"
                >
                  {@render branchIcon()}
                </button>
              {/if}
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
      {:else if item.kind === "tool" && item.name === "answer"}
        <!-- The user's Q&A answers, surfaced visibly instead of buried in a tool card. -->
        <QnaResult {item} />
      {:else if item.kind === "tool"}
        <ToolCard {item} />
      {:else if item.kind === "inject"}
        <!-- An extension-injected custom message (e.g. a journal nudge). `display:false`
             ones are turn-boundary markers only — render nothing. The rest show a tiny
             collapsed pill that expands to the (de-wrapped) note text. -->
        {#if item.display}
          <div class="row inject">
            <button
              class="inject-pill"
              class:open={injectOpen[item.id] ?? false}
              type="button"
              onclick={() => toggleInject(item.id)}
              aria-expanded={injectOpen[item.id] ?? false}
              title={(injectOpen[item.id] ?? false)
                ? `Collapse the injected ${item.customType} note`
                : `Expand the injected ${item.customType} note`}
            >
              <span class="chevron" class:open={injectOpen[item.id] ?? false}>▸</span>
              <span class="inject-label">{item.customType}</span>
            </button>
            {#if injectOpen[item.id] ?? false}
              <div class="inject-body">{injectText(item)}</div>
            {/if}
          </div>
        {/if}
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
            <!-- Slide the working steps closed instead of snapping: when a turn finishes
                 its closing paragraph the early work autocollapses, and an instant removal
                 jumped the content below. A short height/opacity glide smooths it (and the
                 manual toggle). Intro is skipped on initial mount, so settled turns on load
                 don't animate. -->
            <div
              class="work-body"
              data-testid="work-body"
              transition:slide={{ duration: 180, easing: cubicOut }}
            >
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
      <!-- Always-visible items (the answer Q&A) sit after the collapsed work and
           before the turn-final response. -->
      {#each turn.visible as it (it.id)}
        {@render itemView(it)}
      {/each}
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
    title="Jump to the newest messages (⌘↓) · ⌘↑ jumps to your last prompt"
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
  /* Echo of the image attachments the user sent with this prompt. Right-aligned
     thumbnails under the bubble (the row is flex-end); the same data-URL the
     composer sent, so no extra fetch. */
  .user-images {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 180px));
    gap: 6px;
    max-width: min(86%, 366px);
    margin-bottom: 5px;
  }
  .user-images img,
  .att-img {
    display: block;
    width: 100%;
    max-height: 240px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    object-fit: cover;
  }
  .user-images img:only-child {
    grid-column: 1 / -1;
    max-width: 300px;
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
  /* user prompt footer: branch button + timestamp, right-aligned under the bubble */
  .row.user .umeta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .row.user .umeta .ts {
    margin-top: 0;
  }
  /* branch ("jump here") button — same quiet, hover-revealed treatment as copy */
  .branch {
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
    cursor: pointer;
    transition:
      opacity 0.12s ease,
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .branch .ico {
    display: block;
    width: 13px;
    height: 13px;
  }
  .assistant:hover .branch,
  .row.user:hover .branch,
  .branch:focus-visible {
    opacity: 1;
  }
  .branch:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .branch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* Touch devices have no hover — keep branch reachable (phone is the primary target). */
  @media (max-width: 859px) {
    .branch {
      opacity: 1;
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
  .row.user.pending .bubble {
    opacity: 0.72;
  }
  .row.user.pending .user-images {
    opacity: 0.72;
  }
  .row.user.rejected .bubble {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }
  .row.user.rejected .user-images img {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }
  .delivery {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .delivery.rejected {
    color: var(--danger);
  }
  .delivery button {
    border: 0;
    border-radius: 999px;
    padding: 2px 7px;
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
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

  /* ── Injected custom-message (nudge) pill ── */
  .row.inject {
    align-items: flex-start;
    gap: 5px;
  }
  .inject-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    background: transparent;
    border: none;
    padding: 1px 0;
    color: var(--text-faint);
    font-size: 11.5px;
    font-weight: 550;
    letter-spacing: 0.02em;
    cursor: pointer;
  }
  .inject-pill:hover {
    color: var(--text-muted);
  }
  .inject-pill .chevron {
    font-size: 9px;
    width: 9px;
    text-align: center;
    transition: transform 0.12s;
    flex-shrink: 0;
  }
  .inject-pill .chevron.open {
    transform: rotate(90deg);
  }
  .inject-label {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .inject-body {
    margin-top: 5px;
    margin-left: 14px;
    padding-left: 11px;
    border-left: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 86%;
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
