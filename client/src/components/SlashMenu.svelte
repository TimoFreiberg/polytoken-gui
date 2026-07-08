<script lang="ts">
  import type { CommandInfo } from "@pantoken/protocol";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  // Presentational only: the Composer owns the open/filter/selection state machine and
  // all key handling. We render the list and report intent (pick / hover) back up.
  let {
    items,
    selected,
    onpick,
    onhover,
  }: {
    items: CommandInfo[];
    selected: number;
    onpick: (cmd: CommandInfo) => void;
    onhover: (index: number) => void;
  } = $props();
</script>

<!-- use:scrollIndexIntoView keeps the keyboard-selected row in view as you arrow past the fold. -->
<div id="slash-menu" class="slash-menu" role="listbox" aria-label="Slash commands" data-testid="slash-menu" use:scrollIndexIntoView={selected}>
  {#each items as cmd, i (cmd.name)}
    <button
      type="button"
      class="row"
      class:sel={i === selected}
      data-i={i}
      data-cmd={cmd.name}
      role="option"
      aria-selected={i === selected}
      title={`Insert /${cmd.name} (↑↓ to move, ↵/Tab to select, Esc to dismiss)`}
      onmousedown={(e) => {
        // mousedown + preventDefault so the textarea keeps focus through the click.
        e.preventDefault();
        onpick(cmd);
      }}
      onmouseenter={() => onhover(i)}
    >
      <span class="name"
        >/{cmd.name}{#if cmd.argumentHint}<span class="hint"> {cmd.argumentHint}</span>{/if}</span
      >
      {#if cmd.description}<span class="desc">{cmd.description}</span>{/if}
      <span class="src">{cmd.source}</span>
    </button>
  {/each}
  <div class="footer">↑↓ navigate · ↵ select · esc dismiss</div>
</div>

<style>
  .slash-menu {
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
  .hint {
    color: var(--text-faint);
    font-weight: 400;
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
  .src {
    flex-shrink: 0;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .footer {
    padding: 6px 9px 3px;
    font-size: 11px;
    color: var(--text-faint);
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }
</style>
