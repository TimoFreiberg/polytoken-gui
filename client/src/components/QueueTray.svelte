<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  const queued = $derived(store.session.queued);

  // Steer aborts the current turn (same path as the Stop button) so the daemon
  // drains queued prompts into the next turn. Inert when no turn is active,
  // offline, or a stop is already in flight.
  const steerDisabled = $derived(
    store.connection !== "connected" ||
      store.stopState === "stopping" ||
      !store.turnActive,
  );
</script>

{#if !store.draft && queued.length > 0}
  <section class="tray" aria-label="Queued messages" data-testid="queue-tray">
    <div class="head">
      <span class="title">Queued · {queued.length}</span>
      <div class="actions">
        <button
          type="button"
          class="steer"
          data-testid="steer-button"
          onclick={() => store.abort()}
          disabled={steerDisabled}
          aria-label="Steer: stop the turn and send queued prompts now"
          title="Stop the current turn and send all queued prompts now"
        >
          ↪ Steer
        </button>
        <button
          type="button"
          class="restore"
          title="Restore all queued messages to the composer (Alt+Up)"
          aria-label="Restore all queued messages to the composer"
          onclick={() => store.restoreQueue()}
        >
          Edit all <kbd>⌥↑</kbd>
        </button>
      </div>
    </div>
    <div class="items">
      {#each queued as message (message.id)}
        <div class="item" data-mode={message.mode} title={message.text}>
          <span class="mode"
            >{message.mode === "steer" ? "Steer" : "Follow-up"}</span
          >
          <span class="text">{message.text}</span>
          <button
            type="button"
            class="edit"
            data-testid="edit-queued"
            onclick={() => store.restoreQueue()}
            disabled={store.connection !== "connected"}
            aria-label="Edit queued prompts"
            title="Edit queued prompts (↑)"
          >
            ✎
          </button>
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
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .steer {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 999px;
    flex-shrink: 0;
  }
  .steer:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 12%, var(--danger-soft));
  }
  .steer:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
  @media (pointer: coarse) {
    .restore {
      min-height: 44px;
    }
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
    grid-template-columns: 62px minmax(0, 1fr) auto;
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
    /* Show up to two lines so a queued prompt is readable at a glance; the full
       text is in the row's title for hover. (Phone is a primary client and has
       no hover, so two lines + Edit-all is the readable path there.) */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .edit {
    border: 0;
    padding: 2px 4px;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
    align-self: center;
  }
  .edit:hover:not(:disabled) {
    color: var(--accent);
  }
  .edit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  @media (pointer: coarse) {
    .steer {
      min-height: 44px;
    }
    .edit {
      min-width: 44px;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  }
</style>
