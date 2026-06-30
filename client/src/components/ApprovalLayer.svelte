<script lang="ts">
  import { isDialogRequest } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import Button from "./ui/Button.svelte";
  import Markdown from "./Markdown.svelte";

  // Show one dialog at a time — the oldest pending. `qna` is rendered inline in the
  // chat column by QnaInline, not as a floating sheet, so skip it here (the two can
  // coexist: a floating confirm over the inline form).
  const current = $derived(
    store.session.pendingApprovals.find((r) => r.kind !== "qna") ?? null,
  );

  let inputValue = $state("");
  let selectedOption = $state<string | null>(null);

  // reset local field state whenever the active dialog changes
  $effect(() => {
    const c = current;
    if (c && (c.kind === "input" || c.kind === "editor")) {
      inputValue = c.initialValue ?? "";
    } else {
      inputValue = "";
    }
    selectedOption = null;
  });

  function cancel() {
    if (!current) return;
    store.respondUi({ requestId: current.requestId, cancelled: true });
  }
  // An input/editor with unsaved edits — a stray backdrop tap shouldn't nuke typed text.
  const isDirty = $derived.by(() => {
    const c = current;
    if (!c || (c.kind !== "input" && c.kind !== "editor")) return false;
    return inputValue !== (c.initialValue ?? "");
  });
  // These dialogs are cheap to reopen, so a backdrop tap dismisses — EXCEPT a dirty
  // input/editor, where a stray tap (common on a phone) would lose what you typed; there
  // the buttons are the deliberate dismissal.
  function scrimClick() {
    if (isDirty) return;
    cancel();
  }
  function confirm(value: boolean) {
    if (current) store.respondUi({ requestId: current.requestId, confirmed: value });
  }
  function submitValue(v: string) {
    if (current) store.respondUi({ requestId: current.requestId, value: v });
  }

  // --- Binary 2-option select → Yes/No card ---
  // Classify an option label as affirmative / negative / neutral so we can
  // mirror the confirm dialog's ordering (negative ghost on the left,
  // affirmative accent on the right) instead of trusting the array order.
  const AFFIRMATIVE = /\b(yes|ok(ay)?|allow|confirm|continue|trust|enable|accept|approve|proceed)\b/i;
  const NEGATIVE = /\b(no|cancel|deny|don'?t|stop|disable|reject|decline|abort|never)\b/i;
  function optionPolarity(label: string): "affirmative" | "negative" | "neutral" {
    const aff = AFFIRMATIVE.test(label);
    const neg = NEGATIVE.test(label);
    // "don't allow" contains both — negative wins (it's a refusal phrasing).
    if (neg) return "negative";
    if (aff) return "affirmative";
    return "neutral";
  }

  // Resolve the two options into { affirmative (primary, right), negative
  // (ghost, left) }. If neither reads as affirmative, keep the given order:
  // options[0] → primary (right), options[1] → ghost (left), matching the
  // previous behaviour so non-yes/no binaries don't get reshuffled.
  const binarySelect = $derived.by(() => {
    if (current?.kind !== "select" || current.options.length !== 2) return null;
    const [a, b] = current.options as [string, string];
    const pa = optionPolarity(a);
    const pb = optionPolarity(b);
    // Prefer the clearly-affirmative option as primary, the other as ghost.
    if (pa === "affirmative" && pb !== "affirmative") return { affirmative: a, negative: b };
    if (pb === "affirmative" && pa !== "affirmative") return { affirmative: b, negative: a };
    // No clear affirmative (both/neither) → preserve original order.
    return { affirmative: a, negative: b };
  });

  // --- Countdown for timeout-bearing dialogs ---
  // confirm/input/select may carry timeoutMs (editor never does). The request
  // has no start timestamp, so we start the clock on first render and tick it
  // down; at zero we fire the deny-safe default for the kind.
  const timeoutMs = $derived(
    current && "timeoutMs" in current && typeof current.timeoutMs === "number"
      ? current.timeoutMs
      : null,
  );
  let remainingMs = $state(0);
  const remainingSec = $derived(Math.max(0, Math.ceil(remainingMs / 1000)));
  const progress = $derived(timeoutMs ? Math.max(0, Math.min(1, remainingMs / timeoutMs)) : 0);

  // Deny-safe auto-resolution: confirm → confirm(false); plan → the cancel label
  // (a typed plan_handoff_answer, matching the visible Cancel button's wire shape —
  // not the universal {cancelled} that other kinds use); everything else → cancel().
  function autoResolve() {
    const c = current;
    if (!c) return;
    if (c.kind === "confirm") confirm(false);
    else if (c.kind === "plan") submitValue(c.actionLabels[2]);
    else cancel();
  }

  // Keyed on requestId so the timer restarts for each new dialog and is torn
  // down on change/unmount. We tick every 250ms (smoother bar than 1s) and
  // clear the interval at zero before resolving to avoid a double-fire.
  $effect(() => {
    // track these so the effect re-runs when the active dialog changes
    const id = current?.requestId;
    const total = timeoutMs;
    if (!id || total === null) {
      remainingMs = 0;
      return;
    }
    const startedAt = Date.now();
    remainingMs = total;
    const tick = () => {
      const left = total - (Date.now() - startedAt);
      if (left <= 0) {
        remainingMs = 0;
        clearInterval(interval);
        autoResolve();
      } else {
        remainingMs = left;
      }
    };
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  });

  // --- Keyboard + focus for the blocking dialog (mirrors QnaForm) ---
  // The approval sheet is the app's only *agent-initiated* blocking modal, so it must
  // be perceivable and operable without a pointer: focus moves into it on open, Esc
  // cancels (deny-safe), ⌘/Ctrl+Enter submits the affirmative action, and Tab is
  // trapped inside. Keydown lives on the sheet (focus is inside it after open) to avoid
  // clashing with the global ⌘↑ / composer-Esc handlers.
  let sheetEl = $state<HTMLElement | null>(null);

  $effect(() => {
    const id = current?.requestId;
    if (!id || !sheetEl) return;
    const el = sheetEl;
    // Focus the field if there is one (input/editor → soft keyboard opens + immediate
    // typing); otherwise focus the sheet itself (tabindex=-1) so a screen reader
    // announces the dialog without pre-arming an affirmative button for an accidental
    // Enter. Approving is then deliberate: Tab/click, or ⌘/Ctrl+Enter. (Mirrors QnaForm.)
    queueMicrotask(() => {
      (el.querySelector<HTMLElement>(".field, .editor") ?? el).focus();
    });
  });

  // The affirmative action for the current kind. Non-binary selects have no single
  // primary (the user picks an option), so this is a no-op there.
  function primaryAction(): void {
    const c = current;
    if (!c) return;
    if (c.kind === "confirm") confirm(true);
    else if (c.kind === "input" || c.kind === "editor") submitValue(inputValue);
    else if (c.kind === "select" && binarySelect) submitValue(binarySelect.affirmative);
    else if (c.kind === "plan") submitValue(c.actionLabels[0]);
  }

  // Arrow-key roving for the non-binary select (a radiogroup). ↑/↓ move focus between
  // options (wrapping), Home/End jump to ends; the focused option's `onfocus` marks it
  // selected. Clicking or Enter/Space (native button activation) submits that option.
  function onOptionsKeydown(e: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const els = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".opt"),
    ];
    if (els.length === 0) return;
    const idx = els.findIndex((el) => el === document.activeElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? els.length - 1
          : e.key === "ArrowDown"
            ? idx < 0
              ? 0
              : (idx + 1) % els.length
            : idx < 0
              ? els.length - 1
              : (idx - 1 + els.length) % els.length;
    els[next]?.focus();
  }

  function onSheetKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === "Enter") {
      // ⌘/Ctrl+Enter submits from anywhere (incl. the editor, where bare Enter is a
      // newline). A single-line input also submits on bare Enter. Bare Enter for
      // confirm/select is left to native button activation (the primary is focused).
      const bareInputSubmit = current?.kind === "input" && !e.shiftKey;
      if (e.metaKey || e.ctrlKey || bareInputSubmit) {
        e.preventDefault();
        primaryAction();
      }
      return;
    }
    if (e.key === "Tab" && sheetEl) {
      const f = sheetEl.querySelectorAll<HTMLElement>(
        'button, input, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
</script>

{#if current}
  <div class="scrim" onclick={scrimClick} role="presentation"></div>
  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="approval-title"
    tabindex="-1"
    bind:this={sheetEl}
    onkeydown={onSheetKeydown}
  >
    <div class="grip"></div>

    {#if current.kind === "confirm"}
      <h2 id="approval-title">{current.title}</h2>
      <p class="msg">{current.message}</p>
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Deny this request" onclick={() => confirm(false)}>Deny</Button>
        <Button variant="primary" size="lg" block title="Allow this request" onclick={() => confirm(true)}>Allow</Button>
      </div>
    {:else if current.kind === "select"}
      <h2 id="approval-title">{current.title}</h2>
      {#if binarySelect}
        <div class="actions two">
          <Button variant="secondary" size="lg" block title={binarySelect.negative} onclick={() => submitValue(binarySelect.negative)}>{binarySelect.negative}</Button>
          <Button variant="primary" size="lg" block title={binarySelect.affirmative} onclick={() => submitValue(binarySelect.affirmative)}
            >{binarySelect.affirmative}</Button
          >
        </div>
      {:else}
        <div
          class="options"
          role="radiogroup"
          aria-labelledby="approval-title"
          tabindex="-1"
          onkeydown={onOptionsKeydown}
        >
          {#each current.options as opt (opt)}
            <button
              class="opt"
              class:sel={selectedOption === opt}
              role="radio"
              aria-checked={selectedOption === opt}
              tabindex={(selectedOption ?? current.options[0]) === opt ? 0 : -1}
              title={`Choose: ${opt}`}
              onclick={() => submitValue(opt)}
              onfocus={() => (selectedOption = opt)}>{opt}</button
            >
          {/each}
        </div>
        <div class="actions"><Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button></div>
      {/if}
    {:else if current.kind === "plan"}
      <h2 id="approval-title">{current.title}</h2>
      {#if current.displayPath}
        <p class="plan-path" title="Plan document path">{current.displayPath}</p>
      {/if}
      <div class="plan-body">
        <Markdown content={current.planText} final />
      </div>
      <div class="actions three">
        <Button variant="secondary" size="lg" block title={current.actionLabels[2]} onclick={() => submitValue(current.actionLabels[2])}>{current.actionLabels[2]}</Button>
        <Button variant="secondary" size="lg" block title={current.actionLabels[1]} onclick={() => submitValue(current.actionLabels[1])}>{current.actionLabels[1]}</Button>
        <Button variant="primary" size="lg" block title={current.actionLabels[0]} onclick={() => submitValue(current.actionLabels[0])}>{current.actionLabels[0]}</Button>
      </div>
    {:else if current.kind === "input"}
      <h2 id="approval-title">{current.title}</h2>
      <input class="field" bind:value={inputValue} placeholder={current.placeholder ?? ""} />
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button>
        <Button variant="primary" size="lg" block title="Submit your input" onclick={() => submitValue(inputValue)}>Submit</Button>
      </div>
    {:else if current.kind === "editor"}
      <h2 id="approval-title">{current.title}</h2>
      <textarea class="editor" bind:value={inputValue} rows="6"></textarea>
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button>
        <Button variant="primary" size="lg" block title="Save your edits" onclick={() => submitValue(inputValue)}>Save</Button>
      </div>
    {:else if current.kind === "permission"}
      <h2 id="approval-title">{current.title}</h2>
      {#if current.toolName}
        <p class="tool-name" title="The tool requesting approval">{current.toolName}</p>
      {/if}
      {#if current.toolInput}
        <pre class="tool-input" title="The tool's input (JSON)">{current.toolInput}</pre>
      {/if}
      <div
        class="options"
        role="radiogroup"
        aria-labelledby="approval-title"
        tabindex="-1"
        onkeydown={onOptionsKeydown}
      >
        {#each current.options as opt (opt)}
          <button
            class="opt"
            class:sel={selectedOption === opt}
            role="radio"
            aria-checked={selectedOption === opt}
            tabindex={(selectedOption ?? current.options[0]) === opt ? 0 : -1}
            title={`Choose: ${opt}`}
            onclick={() => submitValue(opt)}
            onfocus={() => (selectedOption = opt)}>{opt}</button
          >
        {/each}
      </div>
      <div class="actions"><Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button></div>
    {:else if isDialogRequest(current)}
      <!-- unreachable: all dialog kinds handled above -->
    {:else}
      <!-- generic fallback for any unknown/unhandled method -->
      <h2 id="approval-title">Agent request: {current.kind}</h2>
      <pre class="raw">{JSON.stringify(current, null, 2)}</pre>
      <div class="actions"><Button variant="secondary" size="lg" block title="Dismiss this request" onclick={cancel}>Dismiss</Button></div>
    {/if}

    {#if timeoutMs}
      <div class="countdown" role="timer" aria-live="off">
        <div class="track"><div class="bar" style:width={`${progress * 100}%`}></div></div>
        <span class="countdown-label">Auto-dismiss in {remainingSec}s</span>
      </div>
    {/if}

    {#if store.session.pendingApprovals.length > 1}
      <div class="queued">+{store.session.pendingApprovals.length - 1} more pending</div>
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 40;
    animation: fade 0.15s ease;
  }
  .sheet {
    position: absolute;
    z-index: 41;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(520px, 100%);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    box-shadow: var(--shadow-pop);
    padding: 14px 20px calc(22px + env(safe-area-inset-bottom));
    animation: rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @media (min-width: 600px) {
    .sheet {
      bottom: 28px;
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  .grip {
    width: 36px;
    height: 4px;
    border-radius: 99px;
    background: var(--border-strong);
    margin: 0 auto 12px;
  }
  h2 {
    font-size: 16px;
    margin: 0 0 8px;
    font-weight: 600;
  }
  .msg {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 16px;
    line-height: 1.5;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }
  .actions.two {
    flex-direction: row;
  }
  /* Plan handoff: 3 actions (Cancel | Implement here | Implement new). Stacks to
     a single column on narrow (phone) widths so each button is a full-width tap
     target rather than a cramped third. */
  .actions.three {
    flex-direction: column;
  }
  @media (min-width: 600px) {
    .actions.three {
      flex-direction: row;
    }
  }
  .plan-path {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 12px;
    margin: 0 0 12px;
    word-break: break-all;
  }
  .plan-body {
    max-height: 50vh;
    overflow-y: auto;
    /* Subtle scroll affordance without a heavy scrollbar on touch. */
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .tool-name {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 13px;
    margin: 0 0 8px;
  }
  .tool-input {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.45;
    color: var(--text);
    max-height: 180px;
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    margin: 0 0 4px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .opt {
    display: flex;
    align-items: center;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    font-size: 15px;
    color: var(--text);
  }
  /* Touch: a comfortable tap target for each blocking choice. */
  @media (pointer: coarse) {
    .opt {
      min-height: 44px;
    }
  }
  .opt:active,
  .opt.sel {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .field,
  .editor {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 13px;
    font-size: 15px;
    color: var(--text);
    font-family: inherit;
    outline: none;
  }
  .field:focus,
  .editor:focus {
    border-color: var(--accent);
  }
  .editor {
    resize: vertical;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .raw {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 11px;
    font-family: var(--font-mono);
    font-size: 12px;
    max-height: 240px;
    overflow: auto;
    margin: 0;
  }
  .queued {
    text-align: center;
    color: var(--text-faint);
    font-size: 12px;
    margin-top: 12px;
  }
  .countdown {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .track {
    width: 100%;
    height: 3px;
    border-radius: 99px;
    background: var(--surface-sunken);
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    border-radius: 99px;
    transition: width 0.25s linear;
  }
  .countdown-label {
    color: var(--text-faint);
    font-size: 12px;
  }
  @keyframes rise {
    from {
      transform: translate(-50%, 16px);
      opacity: 0;
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .scrim,
    .sheet {
      animation: none;
    }
  }
</style>
