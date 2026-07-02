<script lang="ts">
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  // Presentational popup for the Ctrl+R prompt-history recall. Mirrors SlashMenu:
  // the Composer owns the open/selection state machine + key handling. We render
  // the list and report pick/hover intent back up.
  let {
    items,
    selected,
    onpick,
    onhover,
  }: {
    items: string[];
    selected: number;
    onpick: (text: string) => void;
    onhover: (index: number) => void;
  } = $props();
</script>

<div
  id="prompt-history-menu"
  class="history-menu"
  role="listbox"
  aria-label="Prompt history"
  data-testid="prompt-history-menu"
  use:scrollIndexIntoView={selected}
>
  {#each items as text, i (text + i)}
    <button
      type="button"
      class="row"
      class:sel={i === selected}
      data-i={i}
      role="option"
      aria-selected={i === selected}
      title={`Fill the composer with this prompt (↑↓ to move, ↵ to select, Esc to dismiss)`}
      onmousedown={(e) => {
        e.preventDefault();
        onpick(text);
      }}
      onmouseenter={() => onhover(i)}
    >
      <span class="text">{text}</span>
    </button>
  {/each}
</div>

<style>
  .history-menu {
    max-height: 240px;
    overflow-y: auto;
    margin: 0 12px 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 4px;
  }
  .row {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    cursor: pointer;
    color: var(--text);
    font-size: 13px;
    line-height: 1.4;
  }
  .row.sel {
    background: var(--surface-sunken);
  }
  .text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
