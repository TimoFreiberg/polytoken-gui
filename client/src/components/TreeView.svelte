<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";
  import {
    buildTreeRows,
    gutterKind,
    TREE_FILTER_MODES,
    type TreeFilterMode,
    type TreeRow,
  } from "../lib/tree-view.js";

  // The session-tree (/tree) view: a browsable visualization of the whole session DAG so
  // you can jump to / branch from ANY node, not just the always-visible prompts + turn-final
  // answers. Renders the daemon's tree as a flattened indented list with continuous CSS rails (no
  // per-character gutter gaps). Selecting a node reuses the existing `branch` flow — no new
  // driver surface. Filter + search are client-side over the server-projected nodes.

  const open = $derived(store.treeOpen);

  let mode = $state<TreeFilterMode>("default");
  let query = $state("");
  // Selection is tracked by node id (stable across filter/search changes), not row index.
  let selectedId = $state<string | null>(null);
  let listEl = $state<HTMLDivElement>();
  let searchEl = $state<HTMLInputElement>();

  const tree = $derived(store.tree);
  // A tree that arrived for a session we've since switched away from is stale — show a
  // loading state rather than another session's branches.
  const stale = $derived(
    !tree ||
      (tree.sessionId !== null &&
        store.activeSessionId !== null &&
        tree.sessionId !== store.activeSessionId),
  );
  const rows = $derived.by<TreeRow[]>(() =>
    tree && !stale ? buildTreeRows(tree.nodes, tree.leafId, mode, query) : [],
  );
  const selectedRow = $derived(
    rows.find((r) => r.node.id === selectedId) ?? null,
  );

  // On open (and whenever the selection falls out of the filtered rows), snap to the
  // current leaf so the active position is where you start.
  $effect(() => {
    if (!open || rows.length === 0) return;
    if (!rows.some((r) => r.node.id === selectedId)) {
      const target = rows.find((r) => r.isLeaf) ?? rows[0];
      if (target) selectedId = target.node.id;
    }
  });

  // Keep the selected row in view as you arrow past the fold.
  $effect(() => {
    if (!open) return;
    listEl
      ?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });

  // Desktop: focus search on open so type-to-search works and keystrokes don't leak to the
  // composer behind the scrim. Skip on touch so the soft keyboard doesn't pop unbidden.
  $effect(() => {
    if (!open) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    queueMicrotask(() => searchEl?.focus());
  });

  function move(delta: number): void {
    if (rows.length === 0) return;
    const i = rows.findIndex((r) => r.node.id === selectedId);
    const next = Math.min(rows.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
    selectedId = rows[next]!.node.id;
  }
  function jump(id: string): void {
    // No-op server-side if it's already the leaf; otherwise navigateTree rewinds + (for a
    // user prompt) prefills the composer. Close so the re-seeded transcript is in view.
    store.branch(id);
    store.closeTree();
  }
  function close(): void {
    store.closeTree();
  }
  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) query = "";
      else close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedRow && !selectedRow.isLeaf) jump(selectedRow.node.id);
    }
  }

  function roleOf(row: TreeRow): { text: string; cls: string } | null {
    switch (row.node.kind) {
      case "user":
        return { text: "user", cls: "u" };
      case "assistant":
        return { text: "assistant", cls: "a" };
      case "branch-summary":
        return { text: "branch summary", cls: "s" };
      default:
        return null;
    }
  }
  function branchTitle(row: TreeRow): string {
    return row.node.kind === "user"
      ? "Rewind to this prompt — edit & resend"
      : "Rewind from here — continue on a new path";
  }
</script>

<svelte:window onkeydown={onKey} />

{#snippet branchIcon()}
  <svg
    class="ico"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="6" cy="5" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="9" r="2.2" />
    <path d="M6 7.2v9.6" />
    <path d="M18 11.2v.6a4 4 0 0 1-4 4H6" />
  </svg>
{/snippet}

{#if open}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Session tree"
    data-testid="tree-panel"
  >
    <header class="phead">
      <h2>Session tree</h2>
      <span class="cmd">/tree</span>
      <IconButton
        title="Close session tree (Esc)"
        aria-label="Close session tree"
        onclick={close}>✕</IconButton
      >
    </header>

    <div class="controls">
      <div class="filters" role="group" aria-label="Filter the tree">
        {#each TREE_FILTER_MODES as f (f.mode)}
          <button
            class="pill"
            class:on={mode === f.mode}
            title={f.title}
            data-testid={`tree-filter-${f.mode}`}
            onclick={() => (mode = f.mode)}>{f.label}</button
          >
        {/each}
      </div>
      <input
        class="search"
        type="search"
        placeholder="Search the tree…"
        bind:value={query}
        bind:this={searchEl}
        aria-label="Search the tree"
        title="Filter entries by text"
        data-testid="tree-search"
      />
    </div>

    <div
      class="list"
      bind:this={listEl}
      role="listbox"
      aria-label="Session tree nodes"
      data-testid="tree-list"
    >
      {#if stale}
        <div class="empty">Loading tree…</div>
      {:else if tree && tree.nodes.length === 0}
        <div class="empty">No history in this session yet.</div>
      {:else if rows.length === 0}
        <div class="empty">No entries match this filter.</div>
      {:else}
        {#each rows as row (row.node.id)}
          {@const role = roleOf(row)}
          {@const sel = row.node.id === selectedId}
          <div
            class="row"
            class:sel
            data-id={row.node.id}
            role="option"
            aria-selected={sel}
            data-testid="tree-row"
            data-kind={row.node.kind}
            data-active={row.onActivePath ? "1" : undefined}
            data-leaf={row.isLeaf ? "1" : undefined}
            tabindex={-1}
            onclick={() => (selectedId = row.node.id)}
            ondblclick={() => {
              if (!row.isLeaf) jump(row.node.id);
            }}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                selectedId = row.node.id;
                if (!row.isLeaf) jump(row.node.id);
              }
            }}
          >
            {#each row.rails as _, c (c)}
              <span class={`g ${gutterKind(row, c)}`} aria-hidden="true"></span>
            {/each}
            <span class="content">
              <span class="dot" class:active={row.onActivePath} aria-hidden="true"
                >{row.onActivePath ? "•" : ""}</span
              >
              {#if row.node.label}<span class="label">{row.node.label}</span
                >{/if}
              <span class="text">
                {#if role}<span class={`role ${role.cls}`}>{role.text}:</span>
                {/if}<span class="preview" class:mono={!role}
                  >{row.node.preview ||
                    (row.node.kind === "assistant" ? "(tool calls)" : "")}</span
                >
              </span>
              {#if row.isLeaf}
                <span class="cur" title="Current position (the active leaf)"
                  >current</span
                >
              {:else if sel}
                <button
                  class="jump"
                  title={branchTitle(row)}
                  data-testid="tree-branch"
                  onclick={(e) => {
                    e.stopPropagation();
                    jump(row.node.id);
                  }}
                >
                  {@render branchIcon()}<span>Rewind here</span>
                </button>
              {/if}
            </span>
          </div>
        {/each}
      {/if}
    </div>

    <footer class="legend">
      <span><span class="dot active">•</span> active path</span>
      <span>├ rewind</span>
      <span>↑↓ move</span>
      <span>↵ jump</span>
    </footer>
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
    width: min(620px, 100%);
    max-height: 88dvh;
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
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px 12px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .phead h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    flex: 1;
  }
  .cmd {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-faint);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .filters {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .pill {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 11px;
  }
  .pill.on {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  }
  .search {
    flex: 1;
    min-width: 140px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
  }
  .search:focus {
    outline: none;
    border-color: var(--accent);
  }
  .list {
    overflow-y: auto;
    padding: 8px 12px calc(10px + env(safe-area-inset-bottom));
    min-height: 120px;
  }
  .empty {
    padding: 28px 12px;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
  }
  .row {
    display: flex;
    align-items: stretch;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface-sunken);
  }
  .row.sel {
    background: var(--select-bg);
    box-shadow: inset 0 0 0 1px var(--select-border);
  }
  /* One gutter column. Rails are drawn as full-height left borders so adjacent rows'
     segments touch into a CONTINUOUS line — no per-character gaps. */
  .g {
    position: relative;
    width: 22px;
    flex: none;
    align-self: stretch;
  }
  .g.rail::before,
  .g.tee::before {
    content: "";
    position: absolute;
    left: 11px;
    top: 0;
    bottom: 0;
    border-left: 1.5px solid var(--border-strong);
  }
  /* Corner (last child): the rail comes down from above and stops at the connector. */
  .g.corner::before {
    content: "";
    position: absolute;
    left: 11px;
    top: 0;
    height: 50%;
    border-left: 1.5px solid var(--border-strong);
  }
  .g.tee::after,
  .g.corner::after {
    content: "";
    position: absolute;
    left: 11px;
    top: 50%;
    width: 9px;
    border-top: 1.5px solid var(--border-strong);
  }
  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px 5px 2px;
    min-height: 30px;
  }
  .dot {
    flex: none;
    width: 9px;
    text-align: center;
    color: var(--accent);
    font-size: 13px;
    line-height: 1;
  }
  .dot.active {
    color: var(--accent);
  }
  .label {
    flex: none;
    font-size: 11px;
    color: var(--warning);
    background: var(--warning-soft);
    border-radius: var(--radius-xs);
    padding: 0 6px;
  }
  .text {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }
  .role {
    font-weight: 550;
  }
  .role.u {
    color: var(--accent);
  }
  .role.a {
    color: var(--ok);
  }
  .role.s {
    color: var(--warning);
  }
  .preview.mono {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .cur {
    flex: none;
    font-size: 11px;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 999px;
    padding: 1px 9px;
  }
  .jump {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 9px;
  }
  .jump:hover {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .jump .ico {
    width: 13px;
    height: 13px;
  }
  .legend {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    padding: 9px 16px calc(9px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .legend .dot {
    width: auto;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      transform: translateX(-50%) translateY(12px);
      opacity: 0;
    }
  }
  @media (min-width: 600px) {
    @keyframes rise {
      from {
        transform: translate(-50%, -46%);
        opacity: 0;
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
