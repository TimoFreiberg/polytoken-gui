<script module lang="ts">
  export interface QnaDraftAnswer {
    selectedOptionIndices: number[];
    customText: string;
    customSelected: boolean;
  }

  export interface QnaDraft {
    answers: QnaDraftAnswer[];
    current: number;
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { reveal } from "../lib/transitions.js";
  import type { HostUiRequest, QnaAnswer } from "@pantoken/protocol";
  import Button from "./ui/Button.svelte";
  import Chevron from "./ui/Chevron.svelte";

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
  }
  let {
    request,
    onsubmit,
    oncancel,
    initialDraft,
    onchange,
    collapsed = false,
    onMinimize,
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
        customSelected: saved?.[i]?.customSelected ?? false,
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
  let customInput: HTMLInputElement | undefined = $state();

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
    const question = questions[i]!;
    const singleSelect =
      Array.isArray(question.options) &&
      question.options.length > 0 &&
      !question.multiSelect;
    return (
      ans.selectedOptionIndices.length > 0 ||
      ((!singleSelect || ans.customSelected) &&
        ans.customText.trim().length > 0)
    );
  }
  const answeredCount = $derived(answers.filter((_, i) => isAnswered(i)).length);

  function draftChanged(): void {
    onchange?.({
      current,
      answers: answers.map((x) => ({
        selectedOptionIndices: [...x.selectedOptionIndices],
        customText: x.customText,
        customSelected: x.customSelected,
      })),
    });
  }

  function pickSingle(j: number) {
    // Preserve the typed alternative as a draft when a preset wins. Submit sanitizes
    // the inactive text so the extension still receives exactly one single-select answer.
    answers[current] = {
      ...a,
      selectedOptionIndices: [j],
      customSelected: false,
    };
    draftChanged();
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
  }
  function chooseCustom(focus = true) {
    answers[current] = {
      ...a,
      selectedOptionIndices: [],
      customSelected: true,
    };
    draftChanged();
    if (focus) customInput?.focus();
  }
  function setCustom(text: string) {
    // Typing activates the custom radio on single-select cards. Multi-select and
    // free-text cards can carry custom text without an exclusive selection mode.
    if (hasOptions && !isMulti) {
      answers[current] = {
        selectedOptionIndices: [],
        customText: text,
        customSelected: true,
      };
    } else {
      answers[current] = { ...a, customText: text };
    }
    draftChanged();
  }

  function next() {
    if (current < total - 1) {
      current += 1;
      draftChanged();
    }
  }
  function prev() {
    if (current > 0) {
      current -= 1;
      draftChanged();
    }
  }
  function goto(i: number) {
    current = i;
    draftChanged();
  }
  function submit() {
    // Hand back plain data (not the $state proxy) for clean WS serialization.
    onsubmit(
      answers.map((x, i) => {
        const question = questions[i]!;
        const singleSelect =
          Array.isArray(question.options) &&
          question.options.length > 0 &&
          !question.multiSelect;
        return {
          selectedOptionIndices: [...x.selectedOptionIndices],
          customText:
            singleSelect &&
            x.selectedOptionIndices.length > 0 &&
            !x.customSelected
              ? ""
              : x.customText,
        };
      }),
    );
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    // Arrow nav only when not typing — don't hijack cursor movement in a field.
    const t = e.target as HTMLElement | null;
    const typing =
      t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    if (!typing) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    }
  }

  // Focus the form on mount so Esc / arrows work before the first click.
  $effect(() => {
    root?.focus();
  });
</script>

<!-- Form-level keyboard shortcuts (Esc / ⌘↵ / arrows) live on the container; the
     focusable controls inside still handle their own keys. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="qna"
  bind:this={root}
  onkeydown={onkeydown}
  role="group"
  aria-label="Questions"
  tabindex="-1"
>
  <div class="head">
    {#if request.title}<h2>{request.title}</h2>{/if}
    <div class="head-right">
      {#if total > 1}
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
          aria-label={collapsed ? "Expand the questions" : "Minimize to the title"}
          title={collapsed ? "Expand the questions" : "Minimize to the title"}
        >
          <Chevron open={!collapsed} size={11} />
        </button>
      {/if}
    </div>
  </div>

  {#if !collapsed}
  <div class="card" transition:reveal>
    <p class="q">{q.question}</p>
    {#if q.context}<p class="ctx">{q.context}</p>{/if}

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
          <input
            class="field"
            class:sel={a.customSelected}
            bind:this={customInput}
            placeholder="Something else…"
            value={a.customText}
            onfocus={() => chooseCustom(false)}
            oninput={(e) => setCustom(e.currentTarget.value)}
            title="Type a free-text answer instead of choosing an option"
          />
        {:else}
          <input
            class="field"
            placeholder="Something else…"
            value={a.customText}
            oninput={(e) => setCustom(e.currentTarget.value)}
            title="Add a free-text answer alongside the selected options"
          />
        {/if}
      </div>
    {:else}
      <textarea
        class="field area"
        rows="4"
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
      title="Cancel without answering (Esc)"
      onclick={oncancel}>Cancel</Button
    >
    {#if total > 1}
      <Button
        variant="secondary"
        size="lg"
        title="Previous question (←)"
        disabled={current === 0}
        onclick={prev}>Back</Button
      >
    {/if}
    {#if current < total - 1}
      <Button
        variant="primary"
        size="lg"
        title="Next question (→)"
        onclick={next}>Next</Button
      >
    {:else}
      <Button
        variant="primary"
        size="lg"
        title="Submit all answers (⌘/Ctrl+Enter)"
        onclick={submit}>Submit</Button
      >
    {/if}
  </div>
  {/if}
</div>

<style>
  .qna {
    outline: none;
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
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
  .min :global(.chevron) {
    color: inherit;
  }
  .min:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .card {
    max-height: min(48vh, 420px);
    overflow-y: auto;
  }
  .q {
    font-size: 1em;
    font-weight: 550;
    margin: 0 0 6px;
    line-height: 1.4;
  }
  .ctx {
    color: var(--text-muted);
    font-size: 0.8667em;
    margin: 0 0 12px;
    line-height: 1.5;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  }
  .field:focus {
    border-color: var(--accent);
  }
  .field.sel {
    border-color: var(--select-border);
  }
  .field.area {
    resize: vertical;
    line-height: 1.5;
  }
  .dots {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin: 14px 0 2px;
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
  }
  .actions :global(.btn) {
    flex: 1 1 0;
  }
</style>
