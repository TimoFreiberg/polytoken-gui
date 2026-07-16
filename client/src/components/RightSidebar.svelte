<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { effectiveWidths, maxWidthFor, MIN_RIGHT_SIDEBAR_WIDTH } from "../lib/sidebar-width.js";
  import SidebarResizeHandle from "./SidebarResizeHandle.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import Chevron from "./ui/Chevron.svelte";
  import TodoDetail from "./TodoDetail.svelte";
  import JobDetail from "./JobDetail.svelte";

  // The right context panel: flagged files, background jobs, and todos from
  // the active session (in that order — matches the polytoken TUI).
  // Desktop: a fixed column with no title label (the left sidebar doesn't have
  // one either) — just the collapse control, symmetric with the left sidebar's
  // '‹'. While collapsed it's reopened by ⌘⇧J or the header's expand chevron
  // (StatusHeader), which sits at the same pixel as this collapse control.
  // Phone (≤859px): a FULL-SCREEN context view (not a drawer) — back arrow +
  // "Context" title up top, opened from the header's badged entry, closed by
  // the back arrow or the OS back gesture (lib/overlay-history.ts).

  const s = $derived(store.session);
  const flags = $derived(s.flags);
  const todos = $derived(s.todos);
  const jobs = $derived(store.jobs);
  const open = $derived(store.rightSidebarOpen);
  let viewportWidth = $state(typeof window === "undefined" ? 1100 : window.innerWidth);
  const widths = $derived(
    effectiveWidths(
      store.sidebarWidth,
      store.rightSidebarWidth,
      viewportWidth,
      store.sidebarOpen && !store.rightSidebarOverlay,
      store.rightSidebarOpen,
    ),
  );
  $effect(() => {
    const onResize = () => (viewportWidth = window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });
  function setRightSidebarWidth(width: number): void {
    store.setRightSidebarWidth(width);
  }

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

  const JOB_KIND_ICON: Record<string, string> = {
    subagent: "◇",
    shell: "□",
  };
  const JOB_STATUS_ICON: Record<string, string> = {
    reserved: "◌",
    running: "◐",
    completed: "●",
    failed: "✕",
    cancelled: "⊘",
  };

  function copyPath(path: string): void {
    void store.copyToClipboard(path);
  }
</script>

<aside
  class="right-sidebar"
  data-testid="right-sidebar"
  data-open={open}
  data-overlay={store.rightSidebarOverlay}
  style={`--desktop-sidebar-width: ${widths.right}px`}
>
  <!-- data-tauri-drag-region="deep": desktop-shell window drag, same contract as
       StatusHeader (real buttons stay clickable; needs the window-drag IPC grant). -->
  <div class="top" data-tauri-drag-region="deep">
    <IconButton
      title="Collapse context panel (⌘⇧J)"
      aria-label="Collapse context panel"
      onclick={() => store.closeRightSidebar()}
    >
      <!-- Desktop: '›' pointing at the edge it collapses to. Phone: mirrored to a
           '‹' back arrow (the view is full-screen; leading edge, iOS-style). -->
      <span class="collapse-glyph"><Chevron open={false} /></span>
    </IconButton>
    <!-- Phone-only (display gated in CSS): full-screen views need a name; the
         desktop column stays title-less to mirror the left sidebar. -->
    <span class="panel-title">Context</span>
  </div>

  <SidebarResizeHandle
    side="right"
    value={widths.right}
    min={MIN_RIGHT_SIDEBAR_WIDTH}
    max={maxWidthFor("right", viewportWidth, store.sidebarOpen && !store.rightSidebarOverlay)}
    label="Resize context panel"
    onChange={setRightSidebarWidth}
  />

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
              <button
                class="copy-btn"
                title="Copy path to clipboard"
                aria-label="Copy {f.path} to clipboard"
                data-testid="copy-path-{f.path}"
                onclick={() => copyPath(f.path)}
              >⎘</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Background jobs -->
    <section class="section" data-testid="background-jobs">
      <div class="section-head">
        <span class="section-title">Background jobs</span>
        {#if jobs.length > 0}
          <span class="section-count">{jobs.length}</span>
        {/if}
      </div>
      {#if jobs.length === 0}
        <p class="empty">No background jobs</p>
      {:else}
        <ul class="job-list">
          {#each jobs as j (j.handle)}
            <li class="job-item {j.status}">
              <button
                class="job-btn"
                onclick={() => (store.selectedJobHandle = j.handle)}
              >
                <span class="job-kind-icon">{JOB_KIND_ICON[j.kind] ?? "?"}</span>
                <div class="job-body">
                  <div class="job-head">
                    <span class="job-name">{j.subagentType ?? j.toolName}</span>
                    <span class="job-status-icon">{JOB_STATUS_ICON[j.status] ?? "?"}</span>
                  </div>
                  {#if j.outputTail}
                    <span class="job-tail">{j.outputTail}</span>
                  {/if}
                </div>
              </button>
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
            <li class="todo-item {t.status}">
              <button
                class="todo-btn"
                onclick={() => (store.selectedTodoId = t.id)}
              >
                <span class="todo-icon">{STATUS_ICON[t.status] ?? "?"}</span>
                <div class="todo-body">
                  <span class="todo-title">{t.title}</span>
                  {#if t.description}
                    <span class="todo-desc">{t.description}</span>
                  {/if}
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</aside>

<TodoDetail />
<JobDetail />

<style>
  .right-sidebar {
    position: relative;
    display: none;
    flex-direction: column;
    width: var(--desktop-sidebar-width, 280px);
    flex-shrink: 0;
    background: var(--sidebar-bg);
    overflow: hidden;
  }
  .right-sidebar[data-open="true"] {
    display: flex;
  }
  .right-sidebar[data-overlay="true"] {
    position: fixed;
    inset: 0 0 0 auto;
    z-index: 80;
    box-shadow: var(--shadow-pop);
    border-left: 1px solid var(--border);
  }
  .top {
    display: flex;
    align-items: center;
    /* Desktop: no title label (mirrors the left Sidebar's .top) — just the
       collapse control, pinned to the trailing edge. */
    justify-content: flex-end;
    /* Same box as StatusHeader (height, 16px trailing gutter, centered contents), so
       this collapse chevron and the header's expand chevron occupy the same pixel:
       click, click, click. */
    min-height: calc(var(--header-h) + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) 16px 0;
  }
  .collapse-glyph {
    display: inline-flex;
  }
  .panel-title {
    display: none;
    font-size: 14.5px;
    font-weight: 600;
    color: var(--text);
  }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0 12px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--accent) 45%, transparent) transparent;
  }
  .content::-webkit-scrollbar {
    width: 6px;
  }
  .content::-webkit-scrollbar-track {
    background: transparent;
  }
  .content::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--accent) 42%, transparent);
    border-radius: 999px;
  }
  .content::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--accent) 62%, transparent);
  }
  .section {
    padding: 10px 16px 12px;
  }
  .section + .section {
    border-top: 1px solid color-mix(in srgb, var(--border) 52%, transparent);
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
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
    color: color-mix(in srgb, var(--text-muted) 82%, var(--text-faint));
    padding: 3px 0 2px;
    margin: 0;
  }
  .file-list,
  .todo-list,
  .job-list {
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
    flex: 1;
    min-width: 0;
  }
  .copy-btn {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--text-faint);
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    opacity: 0;
    transition: opacity 0.1s ease, color 0.1s ease;
  }
  .file-item:hover .copy-btn {
    opacity: 1;
  }
  .copy-btn:hover {
    color: var(--accent);
    background: var(--surface-sunken);
  }
  .todo-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 0;
    font-size: 12px;
  }
  .todo-btn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 6px;
    font-size: 12px;
    width: 100%;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    color: inherit;
    border-radius: 6px;
    transition: background 0.1s ease;
  }
  .todo-btn:hover {
    background: var(--surface-sunken);
  }
  .todo-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
  .job-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 0;
    font-size: 12px;
  }
  .job-btn {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 6px;
    font-size: 12px;
    width: 100%;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    color: inherit;
    border-radius: 6px;
    transition: background 0.1s ease;
  }
  .job-btn:hover {
    background: var(--surface-sunken);
  }
  .job-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .job-kind-icon {
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1.3;
    color: var(--text-muted);
  }
  .job-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .job-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }
  .job-name {
    color: var(--text);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-status-icon {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .job-item.running .job-status-icon {
    color: var(--accent);
  }
  .job-item.completed .job-status-icon {
    color: var(--ok);
  }
  .job-item.failed .job-status-icon {
    color: var(--danger);
  }
  .job-tail {
    color: var(--text-muted);
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Phone: a full-screen context view that slides in from the right (an iOS
     "push", not a drawer — no scrim, nothing peeks out behind it). Stays mounted
     while closed (translated off-screen) so the slide can animate. */
  @media (max-width: 859px) {
    .right-sidebar {
      display: flex;
      position: fixed;
      inset: 0;
      /* Above the app header (z 70) — unlike the left drawer, this is a full-screen
         view with its own nav bar, so nothing behind it may stay on top. */
      z-index: 80;
      width: auto;
      border-left: none;
      transform: translateX(100%);
      transition: transform 0.22s ease;
    }
    .right-sidebar[data-open="true"] {
      transform: translateX(0);
    }
    .right-sidebar[data-open="false"] {
      display: flex;
    }
    /* Full-screen nav bar: back arrow at the leading edge, title beside it. */
    .top {
      justify-content: flex-start;
      gap: 2px;
      padding-left: 8px;
    }
    .collapse-glyph {
      transform: scaleX(-1);
    }
    .panel-title {
      display: block;
    }
    .content {
      /* Clear the home indicator; the top inset rides on .top's padding. */
      padding-bottom: calc(8px + env(safe-area-inset-bottom));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .right-sidebar {
      transition: none;
    }
  }
</style>
