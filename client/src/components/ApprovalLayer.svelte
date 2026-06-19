<script lang="ts">
  import { isDialogRequest } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import Button from "./ui/Button.svelte";

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
      inputValue = (c.kind === "input" ? c.initialValue : c.initialValue) ?? "";
    } else {
      inputValue = "";
    }
    selectedOption = null;
  });

  function cancel() {
    if (!current) return;
    store.respondUi({ requestId: current.requestId, cancelled: true });
  }
  // These dialogs are all cheap to reopen, so a backdrop tap dismisses.
  function scrimClick() {
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

  // Deny-safe auto-resolution: confirm → confirm(false); everything else → cancel().
  function autoResolve() {
    const c = current;
    if (!c) return;
    if (c.kind === "confirm") confirm(false);
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
</script>

{#if current}
  <div class="scrim" onclick={scrimClick} role="presentation"></div>
  <div class="sheet" role="dialog">
    <div class="grip"></div>

    {#if current.kind === "confirm"}
      <h2>{current.title}</h2>
      <p class="msg">{current.message}</p>
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Deny this request" onclick={() => confirm(false)}>Deny</Button>
        <Button variant="primary" size="lg" block title="Allow this request" onclick={() => confirm(true)}>Allow</Button>
      </div>
    {:else if current.kind === "select"}
      <h2>{current.title}</h2>
      {#if binarySelect}
        <div class="actions two">
          <Button variant="secondary" size="lg" block title={binarySelect.negative} onclick={() => submitValue(binarySelect.negative)}>{binarySelect.negative}</Button>
          <Button variant="primary" size="lg" block title={binarySelect.affirmative} onclick={() => submitValue(binarySelect.affirmative)}
            >{binarySelect.affirmative}</Button
          >
        </div>
      {:else}
        <div class="options">
          {#each current.options as opt (opt)}
            <button class="opt" class:sel={selectedOption === opt} title={`Choose: ${opt}`} onclick={() => submitValue(opt)}>{opt}</button>
          {/each}
        </div>
        <div class="actions"><Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button></div>
      {/if}
    {:else if current.kind === "input"}
      <h2>{current.title}</h2>
      <input class="field" bind:value={inputValue} placeholder={current.placeholder ?? ""} />
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button>
        <Button variant="primary" size="lg" block title="Submit your input" onclick={() => submitValue(inputValue)}>Submit</Button>
      </div>
    {:else if current.kind === "editor"}
      <h2>{current.title}</h2>
      <textarea class="editor" bind:value={inputValue} rows="6"></textarea>
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button>
        <Button variant="primary" size="lg" block title="Save your edits" onclick={() => submitValue(inputValue)}>Save</Button>
      </div>
    {:else if isDialogRequest(current)}
      <!-- unreachable: all dialog kinds handled above -->
    {:else}
      <!-- generic fallback for any unknown/unhandled method -->
      <h2>Agent request: {current.kind}</h2>
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
  .options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .opt {
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    font-size: 15px;
    color: var(--text);
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
</style>
