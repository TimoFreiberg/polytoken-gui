<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import Button from "./ui/Button.svelte";

  const conn = $derived(store.connection);
  const show = $derived(conn !== "connected");
  const showReconnect = $derived(conn !== "connecting");

  function reconnect() {
    store.reconnect();
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (!showReconnect) return;
    if (
      e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      (e.key === "r" || e.key === "R")
    ) {
      e.preventDefault();
      reconnect();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if show}
  <div class="banner {conn}" role="status">
    <span class="msg">
      {#if conn === "connecting"}
        Connecting…
      {:else if conn === "reconnecting"}
        <span class="spin"></span> Reconnecting to the agent…
      {:else}
        Offline — the agent keeps running; you'll catch up on reconnect.
      {/if}
    </span>
    {#if showReconnect}
      <Button
        size="sm"
        title="Reconnect now (Alt+R)"
        onclick={reconnect}>Reconnect</Button
      >
    {/if}
  </div>
{/if}

<style>
  .banner {
    text-align: center;
    font-size: 12.5px;
    padding: 5px 12px;
    color: var(--warning);
    background: var(--warning-soft);
    border-bottom: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    flex-wrap: wrap;
  }
  .msg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-width: 0;
  }
  .banner.disconnected {
    color: var(--danger);
    background: var(--danger-soft);
    border-bottom-color: color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .spin {
    width: 10px;
    height: 10px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
