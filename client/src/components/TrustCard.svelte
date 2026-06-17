<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  // The interactive project-trust card (D12). Out-of-band from session dialogs —
  // it gates whether pi may load this folder's .pi resources, decided per-cwd before
  // a session's transcript exists. Dismissing (scrim / Escape) denies, deny-safe.
  const req = $derived(store.trustRequest);

  function choose(i: number) {
    store.respondTrust(i);
  }
  function deny() {
    store.respondTrust(null);
  }
</script>

{#if req}
  <div class="scrim" onclick={deny} role="presentation"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={req.title}>
    <div class="grip"></div>
    <h2>{req.title}</h2>
    <p class="path" title={req.cwd}>{req.cwd}</p>
    <p class="msg">
      Trusting lets pi load this folder's <code>.pi</code> settings, skills, and
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
