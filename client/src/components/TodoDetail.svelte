<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";
  import type { TodoItem } from "@pantoken/protocol";

  const todo = $derived<TodoItem | null>(
    store.session.todos?.find((t) => t.id === store.selectedTodoId) ?? null,
  );

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

  function close(): void {
    store.closeTodoDetail();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function formatRelative(iso?: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
  }

  function depsLabel(t: TodoItem): string {
    if (t.dependencies.length === 0) return "";
    return t.dependencies.map((d) => `#${d}`).join(", ");
  }

  function deleteTodo(): void {
    if (todo) {
      store.deleteTodo(todo.id);
      close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if todo}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Todo detail"
    data-testid="todo-detail"
  >
    <header class="phead">
      <div class="phead-left">
        <span class="status-icon {todo.status}">{STATUS_ICON[todo.status] ?? "?"}</span>
        <h2>{todo.title}</h2>
      </div>
      <IconButton
        title="Close (Esc)"
        aria-label="Close todo detail"
        onclick={close}>✕</IconButton
      >
    </header>
    <div class="body" data-testid="todo-detail-body">
      {#if todo.description}
        <p class="desc">{todo.description}</p>
      {/if}
      <dl class="meta">
        <div class="meta-row">
          <dt>Status</dt>
          <dd>{STATUS_LABEL[todo.status] ?? todo.status}</dd>
        </div>
        {#if todo.createdAt}
          <div class="meta-row">
            <dt>Created</dt>
            <dd>{formatRelative(todo.createdAt)}</dd>
          </div>
        {/if}
        {#if todo.dependencies.length > 0}
          <div class="meta-row">
            <dt>Depends on</dt>
            <dd>{depsLabel(todo)}</dd>
          </div>
        {/if}
      </dl>
    </div>
    <footer class="footer">
      <button
        class="delete-btn"
        title="Delete this todo"
        onclick={deleteTodo}
        data-testid="todo-delete-btn"
      >
        Delete
      </button>
    </footer>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: var(--z-detail-scrim);
    animation: fade 0.15s ease;
  }
  @keyframes fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .panel {
    position: fixed;
    z-index: var(--z-detail);
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: 100%;
    max-height: calc(100dvh - 20px);
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
      width: min(440px, calc(100vw - 48px));
      max-height: calc(100dvh - 48px);
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  @keyframes rise {
    from { transform: translate(-50%, 100%); }
    to { transform: translate(-50%, 0); }
  }
  @media (min-width: 600px) {
    @keyframes rise {
      from { transform: translate(-50%, calc(-50% + 20px)); opacity: 0; }
      to { transform: translate(-50%, -50%); opacity: 1; }
    }
  }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .phead-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .status-icon {
    font-size: 15px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .status-icon.in_progress { color: var(--accent); }
  .status-icon.done { color: var(--ok); }
  .status-icon.blocked { color: var(--danger); }
  .phead h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .body {
    overflow-y: auto;
    padding: 16px;
    -webkit-overflow-scrolling: touch;
    flex: 1;
  }
  .desc {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text);
    margin: 0 0 16px;
  }
  .meta {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .meta-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .meta-row dt {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
    width: 80px;
  }
  .meta-row dd {
    font-size: 12px;
    color: var(--text);
    margin: 0;
  }
  .footer {
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .delete-btn {
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--border));
    background: color-mix(in srgb, var(--danger) 8%, var(--bg-elevated));
    color: var(--danger);
    cursor: pointer;
    font-weight: 500;
  }
  .delete-btn:hover {
    background: color-mix(in srgb, var(--danger) 14%, var(--bg-elevated));
  }
  .delete-btn:active {
    transform: scale(0.98);
  }
</style>
