<script module lang="ts">
  export interface QnaDraftAnswer {
    selectedOptionIndices: number[];
    customText: string;
  }

  export interface QnaDraft {
    answers: QnaDraftAnswer[];
    current: number;
  }
</script>

<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { reveal } from "../lib/transitions.js";
  import type { HostUiRequest, QnaAnswer } from "@pantoken/protocol";
  import Button from "./ui/Button.svelte";
  import Chevron from "./ui/Chevron.svelte";
  import Markdown from "./Markdown.svelte";

  // The remote face of the answer extension's Q&A widget: one card per question,
  // a highlight-selected choice list (single) / checkbox list (multi) / free-text,
  // with prev-next + arrow/Esc/⌘↵
  // navigation. Each card produces a structured QnaAnswer (picked indices + a
  // free-text "something else" escape) so the extension's formatQnA renders the
  // transcript identically to the TUI path. The parent can seed/observe a local draft
  // so switching chats does not discard an unfinished form.
  interface Props {
    request: Extract<HostUiRequest, { kind: "qna" }>;
    onsubmit: (answers: QnaAnswer[]) => void;
    oncancel: () => void;
    initialDraft?: QnaDraft;
    onchange?: (draft: QnaDraft) => void;
    // When provided, render a minimize toggle in the header; `collapsed` hides the
    // body (card/dots/actions) so only the title bar shows. Owned by the parent so
    // the collapsed state survives this component remounting on request change.
    collapsed?: boolean;
    onMinimize?: () => void;
    fullScreen?: boolean;
  }
  let {
    request,
    onsubmit,
    oncancel,
    initialDraft,
    onchange,
    collapsed = false,
    onMinimize,
    fullScreen = false,
  }: Props = $props();

  const questions = $derived(request.questions);

  // One mutable answer per question. Plain objects under $state become deeply
  // reactive proxies, so per-field mutation re-renders the active card. Seeded
  // once from the prop (the parent keys this component by requestId, so request
  // never changes under us) — untrack keeps that intentional read non-reactive.
  let answers = $state<QnaDraftAnswer[]>(
    untrack(() => {
      const saved = initialDraft?.answers;
      return request.questions.map((_, i) => ({
        selectedOptionIndices: [...(saved?.[i]?.selectedOptionIndices ?? [])],
        customText: saved?.[i]?.customText ?? "",
      }));
    }),
  );
  let current = $state(
    untrack(() =>
      Math.min(
        Math.max(initialDraft?.current ?? 0, 0),
        Math.max(request.questions.length - 1, 0),
      ),
    ),
  );
  let root: HTMLDivElement | undefined = $state();
  let customField: HTMLTextAreaElement | undefined = $state();
  let cardEl: HTMLDivElement | undefined = $state();
  let ctxEl: HTMLDivElement | undefined = $state();
  let summaryEl: HTMLDivElement | undefined = $state();

  // Auto-grow: mirror the Composer pattern. Cap ~5 lines, grow a little with
  // the window, floor 60px so a scrollbar never shows below that.
  let winH = $state(typeof window !== "undefined" ? window.innerHeight : 800);
  const maxFieldH = $derived(Math.max(60, Math.min(winH * 0.2, 140)));

  function autosize(el: HTMLTextAreaElement | undefined) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxFieldH)}px`;
  }

  // "editing" walks the question cards; "summary" shows a review page before the
  // no-undo submit. Advancing from the last question → summary; advancing from
  // summary → submit.
  let phase: "editing" | "summary" = $state("editing");

  // current is always kept in [0, total) and answers has one slot per question,
  // so these indexed reads are present — assert past noUncheckedIndexedAccess.
  const q = $derived(questions[current]!);
  const a = $derived(answers[current]!);
  const total = $derived(questions.length);
  const hasOptions = $derived(
    Array.isArray(q.options) && q.options.length > 0,
  );
  const isMulti = $derived(hasOptions && !!q.multiSelect);

  function isAnswered(i: number): boolean {
    const ans = answers[i]!;
    return (
      ans.selectedOptionIndices.length > 0 ||
      ans.customText.trim().length > 0
    );
  }
  const answeredCount = $derived(answers.filter((_, i) => isAnswered(i)).length);

  function draftChanged(): void {
    onchange?.({
      current,
      answers: answers.map((x) => ({
        selectedOptionIndices: [...x.selectedOptionIndices],
        customText: x.customText,
      })),
    });
  }

  function pickSingle(j: number) {
    answers[current] = { ...a, selectedOptionIndices: [j] };
    draftChanged();
    root?.focus();
  }
  function toggleMulti(j: number) {
    const set = new Set(a.selectedOptionIndices);
    if (set.has(j)) set.delete(j);
    else set.add(j);
    answers[current] = {
      ...a,
      selectedOptionIndices: [...set].sort((x, y) => x - y),
    };
    draftChanged();
    root?.focus();
  }
  function setCustom(text: string) {
    answers[current] = { ...a, customText: text };
    draftChanged();
  }

  function advance() {
    if (phase === "summary") {
      submit();
      return;
    }
    if (current < total - 1) {
      current += 1;
      draftChanged();
    } else {
      phase = "summary";
    }
  }
  function back() {
    if (phase === "summary") {
      phase = "editing";
    } else if (current > 0) {
      current -= 1;
      draftChanged();
    }
  }
  function goto(i: number) {
    current = i;
    draftChanged();
    root?.focus();
  }
  function submit() {
    // Hand back plain data (not the $state proxy) for clean WS serialization.
    onsubmit(
      answers.map((x) => ({
        selectedOptionIndices: [...x.selectedOptionIndices],
        customText: x.customText,
      })),
    );
  }

  // Click-twice confirm gate for the Cancel button (mirrors ContextMeter.svelte).
  // First click arms the button (label → "Click again", danger-red); the second
  // click fires oncancel(). A 3s timer auto-disarms so a stale armed button
  // can't trap the user.
  const ARM_TIMEOUT = 3000;
  let cancelArmed = $state(false);
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  function disarmCancel(): void {
    cancelArmed = false;
    if (cancelTimer) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
  }
  function attemptCancel(): void {
    if (cancelArmed) {
      disarmCancel();
      oncancel();
    } else {
      cancelArmed = true;
      cancelTimer = setTimeout(disarmCancel, ARM_TIMEOUT);
    }
  }
  onDestroy(() => disarmCancel());
  const cancelLabel = $derived(cancelArmed ? "Click again" : "Cancel");
  const cancelTitle = $derived(
    cancelArmed ? "Click again to cancel" : "Cancel without answering (Esc)",
  );

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (cancelArmed) {
        disarmCancel();
        return;
      }
      oncancel();
      return;
    }
    if (e.key === "Enter") {
      // Shift+Enter → newline in a text field (let the browser handle it).
      if (e.shiftKey) return;
      // Enter on a focused button (radio/checkbox/dot/action) → let it activate.
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "BUTTON") return;
      e.preventDefault();
      advance();
      return;
    }
    // Arrow nav only when not typing — don't hijack cursor movement in a field.
    const t = e.target as HTMLElement | null;
    const typing = t && t.tagName === "TEXTAREA";
    if (!typing) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    }
  }

  // Focus the form on mount so Esc / arrows work before the first click.
  $effect(() => {
    root?.focus();
  });

  // Re-fit the textarea when its content changes or the cap moves (resize).
  $effect(() => {
    current;
    a?.customText;
    maxFieldH;
    autosize(customField);
  });

  // Re-focus the container on any phase change so Enter works in both
  // directions (entering summary unmounts the textarea → focus is lost;
  // Back from summary also needs to land somewhere focusable).
  $effect(() => {
    phase;
    root?.focus();
  });

  // Reset the cancel confirm gate when navigating between questions or
  // phases so a stale "Click again" label can't persist across cards.
  // Synchronous (no rAF deferral) — a deferred disarm could flash the armed
  // label during the next card's reveal transition.
  $effect(() => {
    current;
    phase;
    disarmCancel();
  });

  // Reset scroll to top on every page change so each question starts at the top.
  // Without this, the .ctx scroll position carries over between questions because
  // Svelte reuses the same DOM element across reactive content updates.
  $effect(() => {
    current;
    phase;
    // Defer to the next animation frame so the new content (rendered through
    // Markdown.svelte's MarkdownRender child component) has laid out before we
    // reset scroll. queueMicrotask would fire before browser layout, making
    // scrollTo(0, 0) a no-op if scrollHeight hasn't updated yet.
    requestAnimationFrame(() => {
      ctxEl?.scrollTo(0, 0);
      summaryEl?.scrollTo(0, 0);
      cardEl?.scrollTo(0, 0);
    });
  });

  // Track window height so maxFieldH re-derives on resize.
  $effect(() => {
    const onResize = () => {
      winH = window.innerHeight;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });
</script>

<!-- Form-level keyboard shortcuts (Esc / Enter / arrows) live on the container; the
     focusable controls inside still handle their own keys. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="qna"
  class:full-screen={fullScreen}
  bind:this={root}
  onkeydown={onkeydown}
  role="group"
  aria-label="Questions"
  tabindex="-1"
>
  <div class="head">
    {#if request.title}<h2>{request.title}</h2>{/if}
    <div class="head-right">
      {#if total > 1 && phase === "editing"}
        <span class="progress" aria-live="polite"
          >Question {current + 1} of {total} · {answeredCount} answered</span
        >
      {/if}
      {#if onMinimize}
        <button
          type="button"
          class="min"
          onclick={onMinimize}
          aria-expanded={!collapsed}
          aria-label={fullScreen ? "Minimize questions" : collapsed ? "Expand the questions" : "Minimize to the title"}
          title={fullScreen ? "Minimize questions" : collapsed ? "Expand the questions" : "Minimize to the title"}
        >
          <Chevron open={!collapsed} size={11} />
          {#if fullScreen}<span>Minimize</span>{/if}
        </button>
      {/if}
    </div>
  </div>

  {#if !collapsed}
  {#if phase === "summary"}
    <div class="summary" bind:this={summaryEl} transition:reveal>
      <p class="summary-head">Review your answers</p>
      {#each questions as question, i (i)}
        {@const ans = answers[i]!}
        <div class="summary-item">
          <p class="summary-q">{question.question}</p>
          {#if ans.selectedOptionIndices.length > 0}
            <ul class="summary-opts">
              {#each ans.selectedOptionIndices as idx (idx)}
                <li>{question.options?.[idx]?.label ?? `Option ${idx + 1}`}</li>
              {/each}
            </ul>
          {/if}
          {#if ans.customText.trim()}
            <p class="summary-text">{ans.customText}</p>
          {:else if ans.selectedOptionIndices.length === 0}
            <p class="summary-empty">(not answered)</p>
          {/if}
        </div>
      {/each}
    </div>
    <div class="actions">
      <Button
        variant="secondary"
        size="lg"
        title="Back to editing (←)"
        onclick={back}>Back</Button
      >
      <Button
        variant="primary"
        size="lg"
        title="Confirm and send (Enter)"
        onclick={submit}>Confirm</Button
      >
    </div>
  {:else}
  <div class="card" bind:this={cardEl} transition:reveal>
    <p class="q">{q.question}</p>
    {#if q.context}<div class="ctx" bind:this={ctxEl}><Markdown content={q.context} final /></div>{/if}

    {#if hasOptions}
      <div class="opts" role={isMulti ? "group" : "radiogroup"}>
        {#each q.options ?? [] as opt, j (j)}
          <button
            type="button"
            class="opt"
            class:sel={a.selectedOptionIndices.includes(j)}
            role={isMulti ? "checkbox" : "radio"}
            aria-checked={a.selectedOptionIndices.includes(j)}
            title={`${isMulti ? "Toggle" : "Choose"}: ${opt.label}`}
            onclick={() => (isMulti ? toggleMulti(j) : pickSingle(j))}
          >
            {#if isMulti}
              <span
                class="check"
                class:on={a.selectedOptionIndices.includes(j)}
                aria-hidden="true">{a.selectedOptionIndices.includes(j) ? "✓" : ""}</span
              >
            {:else}
              <span
                class="radio"
                class:on={a.selectedOptionIndices.includes(j)}
                aria-hidden="true"
              ></span>
            {/if}
            <span class="lbl">
              <span class="lbl-main">{opt.label}</span>
              {#if opt.description}<span class="lbl-desc">{opt.description}</span
                >{/if}
            </span>
          </button>
        {/each}
        {#if !isMulti}
          <textarea
            class="field"
            rows="1"
            bind:this={customField}
            placeholder="Something else…"
            value={a.customText}
            oninput={(e) => setCustom(e.currentTarget.value)}
            title="Add a free-text answer alongside the chosen option"
          ></textarea>
        {:else}
          <textarea
            class="field"
            rows="1"
            bind:this={customField}
            placeholder="Something else…"
            value={a.customText}
            oninput={(e) => setCustom(e.currentTarget.value)}
            title="Add a free-text answer alongside the selected options"
          ></textarea>
        {/if}
      </div>
    {:else}
      <textarea
        class="field area"
        rows="1"
        bind:this={customField}
        placeholder="Type your answer…"
        value={a.customText}
        oninput={(e) => setCustom(e.currentTarget.value)}
        title="Type your answer"
      ></textarea>
    {/if}
  </div>

  {#if total > 1}
    <div class="dots" role="tablist" aria-label="Jump to question">
      {#each questions as _, i (i)}
        <button
          type="button"
          class="dot"
          class:active={i === current}
          class:done={isAnswered(i)}
          role="tab"
          aria-selected={i === current}
          aria-label={`Question ${i + 1}${isAnswered(i) ? ", answered" : ""}`}
          title={`Go to question ${i + 1}${isAnswered(i) ? " (answered)" : ""}`}
          onclick={() => goto(i)}
        ></button>
      {/each}
    </div>
  {/if}

  <div class="actions">
    <Button
      variant="secondary"
      size="lg"
      class={cancelArmed ? "armed" : ""}
      title={cancelTitle}
      onclick={attemptCancel}>{cancelLabel}</Button
    >
    {#if total > 1}
      <Button
        variant="secondary"
        size="lg"
        title="Previous question (←)"
        disabled={current === 0}
        onclick={back}>Back</Button
      >
    {/if}
    {#if current < total - 1}
      <Button
        variant="primary"
        size="lg"
        title="Next question (→)"
        onclick={advance}>Next</Button
      >
    {:else}
      <Button
        variant="primary"
        size="lg"
        title="Review answers (→)"
        onclick={advance}>Review answers</Button
      >
    {/if}
  </div>
  {/if}
  {/if}
</div>

<style>
  .qna {
    outline: none;
    display: flex;
    flex-direction: column;
    flex: 1;       /* fill the capped .qna-inline */
    min-height: 0; /* allow shrinking so .ctx can absorb overflow */
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }
  h2 {
    font-size: 1.0667em;
    margin: 0;
    font-weight: 600;
  }
  .progress {
    color: var(--text-faint);
    font-size: 0.8em;
    white-space: nowrap;
  }
  .head-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }
  .min {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }
  .min span { display: none; }
  .min :global(.chevron) {
    color: inherit;
  }
  .min:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .card {
    /* Flex column so .ctx can shrink+scroll while .q and .opts stay pinned.
       overflow: hidden prevents double scrollbars; .ctx is the sole scroll
       region. */
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .q {
    font-size: 1em;
    font-weight: 550;
    margin: 0 0 6px;
    line-height: 1.4;
    flex-shrink: 0;
  }
  .ctx {
    color: var(--text-muted);
    font-size: 0.8667em;
    margin: 0 0 12px;
    line-height: 1.5;
    flex: 0 1 auto;    /* don't grow, can shrink to make room for options */
    min-height: 0;     /* allow shrinking below content size */
    overflow-y: auto;  /* scroll only the context, not the options */
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }
  .opt {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 13px;
    font-size: 1em;
    color: var(--text);
    cursor: pointer;
  }
  .opt.sel {
    border-color: var(--select-border);
    background: var(--select-bg);
  }
  .check {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xs);
    font-size: 0.8em;
    line-height: 1;
    color: var(--text);
  }
  .check.on {
    /* Monochrome filled checkbox — high contrast, no accent. */
    background: var(--text);
    border-color: var(--text);
    color: var(--bg);
  }
  .radio {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
  }
  .radio.on {
    border-color: var(--select-border);
  }
  .radio.on::after {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text);
  }
  .lbl {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .lbl-main {
    line-height: 1.4;
  }
  .lbl-desc {
    color: var(--text-muted);
    font-size: 0.8em;
    line-height: 1.4;
  }
  .field {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 13px;
    font-size: 1em;
    color: var(--text);
    font-family: inherit;
    outline: none;
    resize: none;        /* auto-grow handles height */
    overflow-y: auto;     /* scroll internally once capped */
    line-height: 1.5;
  }
  .field:focus {
    border-color: var(--accent);
  }
  .field.area {
    flex-shrink: 0;
  }
  .dots {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin: 14px 0 2px;
    flex-shrink: 0;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 99px;
    background: var(--surface-sunken);
    border: 1px solid var(--border-strong);
    cursor: pointer;
    padding: 0;
  }
  .dot.done {
    background: color-mix(in srgb, var(--text) 35%, var(--surface-sunken));
  }
  .dot.active {
    background: var(--text);
    border-color: var(--text);
    transform: scale(1.25);
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 16px;
    flex-shrink: 0;
  }
  .actions :global(.btn) {
    flex: 1 1 0;
  }
  /* Armed (click-twice confirm): destructive red so the operator sees the
     consequence of a second click. Mirrors ContextMeter's .action.armed. */
  .actions :global(.btn.armed) {
    color: var(--danger);
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .actions :global(.btn.armed:hover) {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
  }
  .summary {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .summary-head {
    font-size: 1em;
    font-weight: 600;
    margin: 0 0 12px;
  }
  .summary-item {
    margin: 0 0 14px;
  }
  .summary-item:last-child {
    margin-bottom: 0;
  }
  .summary-q {
    font-size: 0.9333em;
    font-weight: 550;
    margin: 0 0 4px;
    line-height: 1.4;
  }
  .summary-opts {
    margin: 0 0 0 4px;
    padding-left: 18px;
  }
  .summary-opts li {
    line-height: 1.4;
  }
  .summary-text {
    margin: 4px 0 0;
    font-size: 0.8667em;
    color: var(--text-muted);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .summary-empty {
    margin: 4px 0 0;
    font-size: 0.8667em;
    color: var(--text-faint);
    font-style: italic;
  }
  @media (max-width: 859px) {
    .qna.full-screen { height: 100%; min-height: 0; }
    .full-screen .head { align-items: flex-start; margin-bottom: 12px; }
    .full-screen .head-right { flex-direction: column-reverse; align-items: flex-end; }
    .full-screen .min { width: auto; min-width: 96px; height: 44px; gap: 8px; padding: 0 12px; }
    .full-screen .min span { display: inline; }
    .full-screen .card { flex: 1; min-height: 0; max-height: none; overflow-y: auto; }
    .full-screen .ctx { flex: none; min-height: 0; overflow: visible; }
    .full-screen .summary { overflow-y: auto; }
    .full-screen .dot { width: 44px; height: 44px; background: transparent; border: 0; position: relative; }
    .full-screen .dot::after { content: ""; position: absolute; width: 9px; height: 9px; border-radius: 99px; background: var(--surface-sunken); border: 1px solid var(--border-strong); inset: 50% auto auto 50%; transform: translate(-50%, -50%); }
    .full-screen .dot.done::after { background: color-mix(in srgb, var(--text) 35%, var(--surface-sunken)); }
    .full-screen .dot.active::after { background: var(--text); border-color: var(--text); transform: translate(-50%, -50%) scale(1.25); }
    .full-screen .actions { padding-bottom: env(safe-area-inset-bottom); flex-shrink: 0; }
  }
</style>
