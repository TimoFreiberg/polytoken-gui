<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";
</script>

{#if store.toasts.length > 0}
  <div class="toasts" role="region" aria-label="Notifications">
    {#each store.toasts as t (t.id)}
      <div class="toast" role="status" data-testid="toast">
        <span class="msg">{t.message}</span>
        {#if t.action}
          <button
            class="action"
            title={t.action.label}
            onclick={() => {
              t.action?.run();
              store.dismissToast(t.id);
            }}>{t.action.label}</button
          >
        {/if}
        <IconButton
          size="sm"
          title="Dismiss this notification"
          aria-label="Dismiss notification"
          onclick={() => store.dismissToast(t.id)}>×</IconButton
        >
      </div>
    {/each}
  </div>
{/if}

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(16px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    z-index: 90;
    display: flex;
    flex-direction: column-reverse;
    align-items: center;
    gap: 8px;
    max-width: calc(100vw - 24px);
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    padding: 9px 10px 9px 14px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    box-shadow: var(--shadow-pop);
    font-size: 13px;
    color: var(--text);
    animation: toast-rise 0.18s ease;
  }
  .msg {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    flex-shrink: 0;
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: 999px;
    padding: 5px 13px;
    font-size: 12.5px;
    font-weight: 550;
    cursor: pointer;
  }
  @keyframes toast-rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
