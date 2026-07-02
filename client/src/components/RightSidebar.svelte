<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";

  // The right context panel: flagged files + todos from the active session's
  // folded state. Mirrors the left Sidebar's drawer pattern (scrim on mobile,
  // fixed column on desktop). Toggled by the StatusHeader button or ⌘J.

  const s = $derived(store.session);
  const flags = $derived(s.flags);
  const todos = $derived(s.todos);
  const open = $derived(store.rightSidebarOpen);

  const STATUS_ICON: Record<string, string> = {
    pending: "○",
    in_progress: "◐",
    done: "●",
    blocked: "✕",
  };
  const STATUS_LABEL: Record<string, string> = {
    pending: "Pending",
    in_progress: "In progress",
    done: "Done",
    blocked: "Blocked",
  };
</script>

{#if open}
  <button
    class="scrim"
    aria-label="Close context panel"
    onclick={() => store.closeRightSidebar()}
  ></button>
{/if}

<aside
  class="right-sidebar"
  data-testid="right-sidebar"
  data-open={open}
>
  <div class="top">
    <span class="title">Context</span>
    <IconButton
      title="Close context panel (⌘⇧J)"
      aria-label="Close context panel"
      onclick={() => store.closeRightSidebar()}>›</IconButton
    >
  </div>

  <div class="content">
    <!-- Flagged files -->
    <section class="section" data-testid="flagged-files">
      <div class="section-head">
        <span class="section-title">Flagged files</span>
        {#if flags.length > 0}
          <span class="section-count">{flags.length}</span>
        {/if}
      </div>
      {#if flags.length === 0}
        <p class="empty">No flagged files</p>
      {:else}
        <ul class="file-list">
          {#each flags as f (f.path)}
            <li class="file-item" title={`${f.mode === "included" ? "Included in context" : "Referenced"}: ${f.path}`}>
              <span class="file-mode {f.mode}">{f.mode === "included" ? "I" : "R"}</span>
              <span class="file-path">{f.path}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Todos -->
    <section class="section" data-testid="todos">
      <div class="section-head">
        <span class="section-title">Todos</span>
        {#if todos.length > 0}
          <span class="section-count">{todos.length}</span>
        {/if}
      </div>
      {#if todos.length === 0}
        <p class="empty">No todos</p>
      {:else}
        <ul class="todo-list">
          {#each todos as t (t.id)}
            <li class="todo-item {t.status}" title={`${STATUS_LABEL[t.status] ?? t.status}${t.dependencies.length > 0 ? ` (depends on ${t.dependencies.length})` : ""}`}>
              <span class="todo-icon">{STATUS_ICON[t.status] ?? "?"}</span>
              <div class="todo-body">
                <span class="todo-title">{t.title}</span>
                {#if t.description}
                  <span class="todo-desc">{t.description}</span>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</aside>

<style>
  .right-sidebar {
    display: none;
    flex-direction: column;
    width: 280px;
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    background: var(--bg);
    overflow: hidden;
  }
  .right-sidebar[data-open="true"] {
    display: flex;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .section {
    padding: 8px 12px;
  }
  .section + .section {
    border-top: 1px solid var(--border);
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .section-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .section-count {
    font-size: 11px;
    color: var(--text-faint);
    background: var(--surface-sunken);
    border-radius: 999px;
    padding: 1px 6px;
  }
  .empty {
    font-size: 12px;
    color: var(--text-faint);
    padding: 4px 0;
  }
  .file-list,
  .todo-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px;
  }
  .file-mode {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .file-mode.included {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
  }
  .file-mode.referenced {
    color: var(--text-muted);
  }
  .file-path {
    color: var(--text);
    font-family: var(--font-mono, monospace);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .todo-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 0;
    font-size: 12px;
  }
  .todo-icon {
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1.3;
    color: var(--text-muted);
  }
  .todo-item.done .todo-icon {
    color: var(--ok);
  }
  .todo-item.blocked .todo-icon {
    color: var(--danger);
  }
  .todo-item.in_progress .todo-icon {
    color: var(--accent);
  }
  .todo-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .todo-title {
    color: var(--text);
    font-weight: 500;
  }
  .todo-item.done .todo-title {
    text-decoration: line-through;
    color: var(--text-muted);
  }
  .todo-desc {
    color: var(--text-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scrim {
    display: none;
  }

  /* Mobile: slide-in drawer from the right (mirrors left Sidebar's pattern). */
  @media (max-width: 859px) {
    .right-sidebar {
      display: flex;
      position: fixed;
      right: 0;
      top: 0;
      bottom: 0;
      z-index: 60;
      width: min(82vw, 320px);
      transform: translateX(100%);
      transition: transform 0.18s ease;
      box-shadow: -2px 0 12px rgba(0, 0, 0, 0.12);
    }
    .right-sidebar[data-open="true"] {
      transform: translateX(0);
    }
    .right-sidebar[data-open="false"] {
      display: flex;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 59;
      background: rgba(0, 0, 0, 0.34);
      border: none;
      cursor: pointer;
    }
  }
</style>
