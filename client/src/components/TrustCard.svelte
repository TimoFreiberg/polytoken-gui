<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { attention } from "../lib/attention-cycle.svelte.js";
  import { reveal } from "../lib/transitions.js";
  import Chevron from "./ui/Chevron.svelte";

  // The interactive project-trust card (D12). Out-of-band from session dialogs —
  // it gates whether the agent may load this folder's .pi resources, decided per-cwd before
  // a session's transcript exists. Dismissing (scrim) denies, deny-safe.
  const req = $derived(store.trustRequest);
  const minimized = $derived(attention.minimized.trust);

  let sheetEl = $state<HTMLElement | null>(null);

  function focusSheet(): void {
    if (!sheetEl) return;
    queueMicrotask(() => sheetEl?.focus());
  }

  // Focus the sheet on first render of each new trust request.
  $effect(() => {
    const id = req?.requestId;
    if (!id || !sheetEl) return;
    focusSheet();
  });
  // Re-focus when cycled back to via ⌘\.
  $effect(() => {
    if (attention.focused === "trust" && !attention.minimized.trust) {
      focusSheet();
    }
  });

  // Remote-resolution cleanup: when the trust request changes or becomes null
  // (resolved from any path), clear the controller's trust state so the pill
  // disappears. Uses a plain guard (not an effect teardown — teardowns fire on
  // every effect re-run, which would clear mid-cycle), mirroring ApprovalLayer.
  let lastTrustId: string | undefined;
  $effect(() => {
    const id = req?.requestId;
    if (id !== lastTrustId) {
      if (lastTrustId !== undefined) attention.clear("trust");
      lastTrustId = id;
    }
  });

  function choose(i: number) {
    attention.clear("trust");
    store.respondTrust(i);
  }
  function deny() {
    attention.clear("trust");
    store.respondTrust(null);
  }
</script>

{#if req}
  {#if !minimized}
    <div class="scrim" onclick={deny} role="presentation"></div>
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={req.title}
      tabindex="-1"
      bind:this={sheetEl}
    >
      <div class="grip"></div>
      <button
        type="button"
        class="min"
        onclick={() => attention.minimize("trust")}
        aria-expanded="true"
        aria-label="Minimize to pill"
        title="Minimize to pill (⌘\)"
      >
        <Chevron open={true} size={11} />
      </button>
      <h2>{req.title}</h2>
      <p class="path" title={req.cwd}>{req.cwd}</p>
      <p class="msg">
        Trusting lets the agent load this folder's <code>.pi</code> settings, skills, and
        extensions, and run its project packages. Only trust folders you know.
      </p>
      <div class="options">
        {#each req.options as opt, i (opt.label)}
          <button
            class="opt"
            class:deny={!opt.trusted}
            title={opt.trusted ? `Trust this folder: ${opt.label}` : `Don't trust this folder: ${opt.label}`}
            onclick={() => choose(i)}>{opt.label}</button
          >
        {/each}
      </div>
    </div>
  {:else}
    {#key req.requestId}
      <div transition:reveal>
        <button
          type="button"
          class="attention-pill"
          onclick={() => attention.restore("trust")}
          title="Trust decision pending — click or press ⌘\ to restore"
        >
          <span class="pill-label">Trust decision pending</span>
        </button>
      </div>
    {/key}
  {/if}
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 50;
    animation: fade 0.15s ease;
  }
  .sheet {
    position: fixed;
    z-index: 51;
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
    margin: 0 0 4px;
    font-weight: 600;
  }
  .path {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    margin: 0 0 10px;
    overflow-wrap: anywhere;
  }
  .msg {
    color: var(--text-muted);
    font-size: 13px;
    margin: 0 0 16px;
    line-height: 1.5;
  }
  .msg code {
    font-family: var(--font-mono);
    font-size: 12px;
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
  .opt:active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .opt.deny {
    color: var(--text-muted);
  }
  /* Minimize button in the sheet header — mirrors QnaForm's .min. */
  .min {
    position: absolute;
    top: 14px;
    right: 14px;
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
  /* Minimized pill — fixed-position overlay (TrustCard is position: fixed). */
  .attention-pill {
    position: fixed;
    z-index: 51;
    left: 50%;
    bottom: calc(28px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    max-width: calc(100vw - 24px);
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .attention-pill:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .attention-pill:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .pill-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
