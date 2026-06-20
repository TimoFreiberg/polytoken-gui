<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  const queued = $derived(store.session.queued);
</script>

{#if !store.draft && queued.length > 0}
  <section class="tray" aria-label="Queued messages" data-testid="queue-tray">
    <div class="head">
      <span class="title">Queued · {queued.length}</span>
      <button
        type="button"
        class="restore"
        title="Restore all queued messages to the composer (Alt+Up)"
        onclick={() => store.restoreQueue()}
      >
        Edit all <kbd>⌥↑</kbd>
      </button>
    </div>
    <div class="items">
      {#each queued as message (message.id)}
        <div class="item" data-mode={message.mode}>
          <span class="mode"
            >{message.mode === "steer" ? "Steer" : "Follow-up"}</span
          >
          <span class="text">{message.text}</span>
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .tray {
    margin-bottom: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 9px 5px;
  }
  .title {
    color: var(--text-muted);
    font-size: 11.5px;
    font-weight: 600;
  }
  .restore {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    padding: 2px 5px;
    background: transparent;
    color: var(--accent);
    font-size: 11.5px;
  }
  .restore:hover {
    text-decoration: underline;
  }
  kbd {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 4px;
    background: var(--surface);
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
    text-decoration: none;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 6px 6px;
  }
  .item {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    align-items: baseline;
    gap: 7px;
    border-radius: var(--radius-xs);
    padding: 5px 6px;
    background: var(--surface);
  }
  .mode {
    color: var(--text-faint);
    font-size: 10.5px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.035em;
  }
  .item[data-mode="followUp"] .mode {
    color: var(--warning);
  }
  .text {
    overflow: hidden;
    color: var(--text);
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
