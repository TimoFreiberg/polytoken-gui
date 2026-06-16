<script lang="ts">
  import { isDialogRequest } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";

  // Show one dialog at a time — the oldest pending. Resolving it reveals the next.
  const current = $derived(store.session.pendingApprovals[0] ?? null);

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
    if (current) store.respondUi({ requestId: current.requestId, cancelled: true });
  }
  function confirm(value: boolean) {
    if (current) store.respondUi({ requestId: current.requestId, confirmed: value });
  }
  function submitValue(v: string) {
    if (current) store.respondUi({ requestId: current.requestId, value: v });
  }

  // detect a binary yes/no select to render as two big buttons
  const binarySelect = $derived(
    current?.kind === "select" && current.options.length === 2
      ? { primary: current.options[0] as string, secondary: current.options[1] as string }
      : null,
  );
</script>

{#if current}
  <div class="scrim" onclick={cancel} role="presentation"></div>
  <div class="sheet" role="dialog" aria-modal="true">
    <div class="grip"></div>

    {#if current.kind === "confirm"}
      <h2>{current.title}</h2>
      <p class="msg">{current.message}</p>
      <div class="actions two">
        <button class="ghost" onclick={() => confirm(false)}>Deny</button>
        <button class="primary" onclick={() => confirm(true)}>Allow</button>
      </div>
    {:else if current.kind === "select"}
      <h2>{current.title}</h2>
      {#if binarySelect}
        <div class="actions two">
          <button class="ghost" onclick={() => submitValue(binarySelect.secondary)}>{binarySelect.secondary}</button>
          <button class="primary" onclick={() => submitValue(binarySelect.primary)}>{binarySelect.primary}</button>
        </div>
      {:else}
        <div class="options">
          {#each current.options as opt (opt)}
            <button class="opt" class:sel={selectedOption === opt} onclick={() => submitValue(opt)}>{opt}</button>
          {/each}
        </div>
        <div class="actions"><button class="ghost wide" onclick={cancel}>Cancel</button></div>
      {/if}
    {:else if current.kind === "input"}
      <h2>{current.title}</h2>
      <input class="field" bind:value={inputValue} placeholder={current.placeholder ?? ""} />
      <div class="actions two">
        <button class="ghost" onclick={cancel}>Cancel</button>
        <button class="primary" onclick={() => submitValue(inputValue)}>Submit</button>
      </div>
    {:else if current.kind === "editor"}
      <h2>{current.title}</h2>
      <textarea class="editor" bind:value={inputValue} rows="6"></textarea>
      <div class="actions two">
        <button class="ghost" onclick={cancel}>Cancel</button>
        <button class="primary" onclick={() => submitValue(inputValue)}>Save</button>
      </div>
    {:else if isDialogRequest(current)}
      <!-- unreachable: all dialog kinds handled above -->
    {:else}
      <!-- generic fallback for any unknown/unhandled method -->
      <h2>Agent request: {current.kind}</h2>
      <pre class="raw">{JSON.stringify(current, null, 2)}</pre>
      <div class="actions"><button class="ghost wide" onclick={cancel}>Dismiss</button></div>
    {/if}

    {#if store.session.pendingApprovals.length > 1}
      <div class="queued">+{store.session.pendingApprovals.length - 1} more pending</div>
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 40;
    animation: fade 0.15s ease;
  }
  .sheet {
    position: fixed;
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
  .actions.two button {
    flex: 1;
  }
  button.primary {
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: var(--radius-sm);
    padding: 12px;
    font-size: 15px;
    font-weight: 550;
  }
  button.ghost {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 12px;
    font-size: 15px;
  }
  button.wide {
    flex: 1;
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
