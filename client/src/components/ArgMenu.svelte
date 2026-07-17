<script lang="ts" generics="T extends { name: string; description?: string }">
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  // Presentational only: the Composer owns the open/filter/selection state machine
  // and all key handling. We render the list and report intent (pick / hover) back
  // up. Mirrors McpArgMenu's shape — the only difference is generic { name, description? }
  // rows instead of MCP-specific server/action rows. Used by `/facet` and `/goal`.
  // Generic over T so the onpick callback preserves the concrete item type
  // (e.g. GoalSubcommand) rather than widening to the base shape.
  let {
    id = "arg-menu",
    label = "Arguments",
    items,
    selected,
    onpick,
    onhover,
  }: {
    id?: string;
    label?: string;
    items: T[];
    selected: number;
    onpick: (item: T) => void;
    onhover: (index: number) => void;
  } = $props();
</script>

<div
  {id}
  class="arg-menu"
  role="listbox"
  aria-label={label}
  data-testid="arg-menu"
  use:scrollIndexIntoView={selected}
>
  {#each items as item, i (item.name)}
    <button
      type="button"
      class="row"
      class:sel={i === selected}
      data-i={i}
      data-name={item.name}
      role="option"
      aria-selected={i === selected}
      title={`Select ${item.name} (↑↓ to move, ↵/Tab to select, Esc to dismiss)`}
      onmousedown={(e) => {
        e.preventDefault();
        onpick(item);
      }}
      onmouseenter={() => onhover(i)}
    >
      <span class="name">{item.name}</span>
      {#if item.description}
        <span class="desc">{item.description}</span>
      {/if}
    </button>
  {/each}
  <div class="footer">↑↓ navigate · ↵ select · esc dismiss</div>
</div>

<style>
  .arg-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    z-index: 50;
    max-height: min(46vh, 320px);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 4px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 9px;
    cursor: pointer;
    color: var(--text);
  }
  /* Selection is keyboard-driven; hover mirrors it via onhover, so we only style .sel. */
  .row.sel {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .name {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
  }
  .desc {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .footer {
    padding: 6px 9px 3px;
    font-size: 11px;
    color: var(--text-faint);
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }
</style>
