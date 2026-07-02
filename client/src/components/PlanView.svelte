<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";
  import Markdown from "./Markdown.svelte";

  const planText = $derived(store.session.activePlan ?? "");

  function close(): void {
    store.planViewOpen = false;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if store.planViewOpen && planText}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Active plan"
    data-testid="plan-view"
  >
    <header class="phead">
      <h2>Plan</h2>
      <IconButton
        title="Close the plan view (Esc)"
        aria-label="Close plan view"
        onclick={close}>✕</IconButton
      >
    </header>
    <div class="body" data-testid="plan-view-body">
      <Markdown content={planText} final />
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 60;
    animation: fade 0.15s ease;
  }
  .panel {
    position: fixed;
    z-index: 61;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    /* A plan is a full document — take nearly the whole viewport, leaving a
       sliver of scrim so it still reads as an overlay. */
    width: 100%;
    max-height: calc(100dvh - 20px);
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    box-shadow: var(--shadow-pop);
    animation: rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @media (min-width: 600px) {
    .panel {
      top: 50%;
      bottom: auto;
      transform: translate(-50%, -50%);
      width: calc(100vw - 48px);
      max-height: calc(100dvh - 48px);
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .phead h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
  }
  .body {
    overflow-y: auto;
    padding: 16px;
    -webkit-overflow-scrolling: touch;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
  @media (min-width: 600px) {
    @keyframes rise {
      from {
        opacity: 0;
        transform: translate(-50%, calc(-50% + 8px));
      }
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .scrim,
    .panel {
      animation: none;
    }
  }
</style>
