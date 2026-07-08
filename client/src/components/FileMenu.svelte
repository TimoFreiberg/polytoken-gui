<script lang="ts">
  import type { FileInfo } from "@pantoken/protocol";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  // Presentational only: the Composer owns the open/filter/selection state machine and
  // all key handling. We render the list and report intent (pick / hover) back up.
  let {
    items,
    selected,
    onpick,
    onhover,
  }: {
    items: readonly FileInfo[];
    selected: number;
    onpick: (file: FileInfo) => void;
    onhover: (index: number) => void;
  } = $props();
</script>

<!-- use:scrollIndexIntoView keeps the keyboard-selected row in view as you arrow past the fold. -->
<div class="menu" id="file-menu" role="listbox" aria-label="File mentions" data-testid="file-menu" use:scrollIndexIntoView={selected}>
  {#each items as file, i (file.path)}
    <button
      type="button"
      class="row"
      class:sel={i === selected}
      data-i={i}
      role="option"
      aria-selected={i === selected}
      title={`Insert @${file.path}${file.isDirectory ? "/" : ""} (↑↓ to move, ↵/Tab to select, Esc to dismiss)`}
      onmousedown={(e) => {
        e.preventDefault();
        onpick(file);
      }}
      onmouseenter={() => onhover(i)}
    >
      <span class="icon" aria-hidden="true">{file.isDirectory ? "▸" : "▹"}</span>
      <span class="name"
        >{file.path}{#if file.isDirectory}<span class="sep">/</span>{/if}</span
      >
    </button>
  {/each}
  <div class="footer">↑↓ navigate · ↵ select · esc dismiss</div>
</div>

<style>
  .menu {
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
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 9px;
    cursor: pointer;
    color: var(--text);
  }
  .row.sel {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .icon {
    flex-shrink: 0;
    width: 14px;
    font-size: 11px;
    color: var(--text-faint);
    text-align: center;
  }
  .name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sep {
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
