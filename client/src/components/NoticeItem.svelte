<script lang="ts">
  import type { Toast } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";

  let { toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void } =
    $props();
</script>

<div class="notice" role="status" data-testid="toast">
  <span class="msg">{toast.message}</span>
  {#if toast.action}
    <button
      class="action"
      title={toast.action.label}
      onclick={async () => {
        // Await the action before dismissing so an async copy/write completes before the
        // toast disappears — otherwise a `copyTrace` that writes to the clipboard
        // race-loses against the immediate onDismiss.
        await toast.action?.run();
        onDismiss(toast.id);
      }}>{toast.action.label}</button
    >
  {/if}
  <IconButton
    size="sm"
    title="Dismiss this notification"
    aria-label="Dismiss notification"
    onclick={() => onDismiss(toast.id)}>×</IconButton
  >
</div>

<style>
  .notice {
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
    animation: notice-rise 0.18s ease;
  }
  .msg {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    flex-shrink: 0;
    background: var(--highlight);
    color: var(--highlight-text);
    border: none;
    border-radius: 999px;
    padding: 5px 13px;
    font-size: 12.5px;
    font-weight: 550;
    cursor: pointer;
  }
  .action:hover {
    background: var(--highlight-hover);
  }
  @keyframes notice-rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .notice {
      animation: none;
    }
  }
</style>
