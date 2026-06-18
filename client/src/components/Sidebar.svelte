<script lang="ts">
  import type { SessionListEntry } from "@pilot/protocol";
  import { tick } from "svelte";
  import { store } from "../lib/store.svelte.js";
  import { filterSessions } from "../lib/session-filter.js";

  // A new-session-in-a-directory disclosure (D12: arbitrary GUI-controlled paths).
  let showNewDir = $state(false);
  let newDir = $state("");
  let dirInput = $state<HTMLInputElement | null>(null);
  let useWorktree = $state(false);

  function basename(p: string): string {
    const parts = p.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || p;
  }

  // The cwd of the currently-active session, used to prefill the new-dir input so
  // "new session near where I am" is one keystroke, not a full path retype.
  const activeCwd = $derived(
    store.sessions.find((s) => s.sessionId === store.activeSessionId)?.cwd ?? "",
  );

  // Filter-as-you-type search over the session list (name, preview, path). Grouping +
  // the active-only filter (hide archived/stale) live in the pure `filterSessions`
  // helper. `Date.now()` is read on each recompute (sessions/query/showArchived deps);
  // re-opening the sidebar re-scans the list, so staleness re-evaluates in practice.
  let query = $state("");
  const filtered = $derived(
    filterSessions(store.sessions, {
      query,
      showArchived: store.showArchived,
      now: Date.now(),
    }),
  );
  const filteredGroups = $derived(filtered.groups);
  const hiddenCount = $derived(filtered.hiddenCount);

  // Per-row actions menu (the ⋯ overflow). Holds the path of the session whose menu is
  // open, or null. One open at a time.
  let menuFor = $state<string | null>(null);
  function toggleMenu(path: string): void {
    menuFor = menuFor === path ? null : path;
  }
  function closeMenu(): void {
    menuFor = null;
  }
  function toggleArchive(s: SessionListEntry): void {
    store.setArchived(s.path, !s.archived);
    closeMenu();
  }
  // Dismiss the row menu on an outside click or Escape. Deferred so the opening click
  // doesn't immediately re-close it.
  $effect(() => {
    if (!menuFor) return;
    const onClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (!t.closest(".menu") && !t.closest(".row-menu")) closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeMenu();
    };
    const id = setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  });

  // Per-project collapse state, keyed by cwd. Empty = everything expanded.
  let collapsed = $state<Record<string, boolean>>({});
  function toggleGroup(cwd: string): void {
    collapsed = { ...collapsed, [cwd]: !collapsed[cwd] };
  }

  // Re-scan disk whenever the sidebar opens, so a session another client created
  // (or the agent itself) shows up without a reload.
  $effect(() => {
    if (store.sidebarOpen) store.refreshSessions();
  });

  function isPhone(): boolean {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 859px)").matches
    );
  }
  // On a phone the sidebar is an overlay drawer — close it after navigating so the
  // transcript is visible. On desktop it stays pinned open.
  function afterNavigate(): void {
    if (isPhone()) store.closeSidebar();
  }

  function pick(s: SessionListEntry): void {
    store.openSession(s.path);
    afterNavigate();
  }
  function newInDir(cwd: string): void {
    store.newSession(cwd);
    afterNavigate();
  }
  async function openNewDir(): Promise<void> {
    newDir = activeCwd;
    showNewDir = true;
    // The `autofocus` attr is unreliable when the input mounts via {#if}; focus it
    // explicitly once the DOM updates. Select the prefilled cwd so typing replaces it.
    await tick();
    dirInput?.focus();
    dirInput?.select();
  }
  function submitNewDir(): void {
    const dir = newDir.trim();
    if (!dir) return;
    store.newSession(dir, useWorktree);
    closeNewDir();
    afterNavigate();
  }
  function closeNewDir(): void {
    showNewDir = false;
    useWorktree = false;
  }
</script>

<!-- Backdrop only matters on the phone overlay; harmless (transparent, behind) on desktop. -->
{#if store.sidebarOpen}
  <button
    class="scrim"
    aria-label="Close sidebar"
    onclick={() => store.closeSidebar()}
  ></button>
{/if}

<aside class="sidebar" data-testid="sidebar" data-open={store.sidebarOpen}>
  <div class="top">
    <span class="brand">pilot</span>
    <button
      class="icon"
      title="Collapse sidebar"
      aria-label="Collapse sidebar"
      onclick={() => store.closeSidebar()}
    >
      ‹
    </button>
  </div>

  <div class="new">
    {#if showNewDir}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          submitNewDir();
        }}
      >
        <input
          class="dir-input"
          type="text"
          bind:this={dirInput}
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          placeholder="/absolute/path/to/project"
          bind:value={newDir}
          onkeydown={(e) => {
            if (e.key === "Escape") closeNewDir();
          }}
        />
        <label
          class="worktree-toggle"
          title="Run the session in an isolated jj/git worktree of this directory, leaving the main tree clean"
        >
          <input type="checkbox" bind:checked={useWorktree} />
          <span>Isolate in a worktree</span>
        </label>
        <div class="dir-actions">
          <button class="ghost" type="button" title="Cancel and close this form (Esc)" onclick={closeNewDir}>
            Cancel
          </button>
          <button class="primary" type="submit" title="Start a new session in this directory" disabled={!newDir.trim()}>
            Start
          </button>
        </div>
      </form>
    {:else}
      <button class="new-btn" title="Start a new session in a directory you choose" onclick={openNewDir}>
        <span class="plus">+</span> New session in a directory…
      </button>
    {/if}
    {#if store.lastError}
      <div class="err" role="alert">
        {store.lastError}
        <button class="err-x" title="Dismiss this error" aria-label="Dismiss" onclick={() => store.clearError()}
          >×</button
        >
      </div>
    {/if}
  </div>

  {#if store.sessions.length > 0}
    <div class="search">
      <input
        class="search-input"
        type="text"
        placeholder="Search sessions…"
        title="Search sessions by name, preview, or path"
        aria-label="Search sessions"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        bind:value={query}
      />
    </div>
    <div class="filter">
      <button
        class="filter-toggle"
        data-testid="filter-toggle"
        aria-pressed={store.showArchived}
        title={store.showArchived
          ? "Showing all sessions incl. archived and inactive — click for active only"
          : "Showing active sessions only — click to also show archived and inactive"}
        onclick={() => store.toggleShowArchived()}
      >
        {store.showArchived ? "Showing all" : "Active only"}
      </button>
      {#if !store.showArchived && hiddenCount > 0}
        <span class="hidden-count">{hiddenCount} hidden</span>
      {/if}
    </div>
  {/if}

  <nav class="list">
    {#if filteredGroups.length === 0}
      <div class="empty">
        {query.trim()
          ? "No sessions match your search."
          : hiddenCount > 0
            ? "Nothing active — switch to “Showing all” to see archived or inactive sessions."
            : "No sessions yet."}
      </div>
    {:else}
      {#each filteredGroups as g (g.cwd)}
        <section class="group">
          <div class="group-head">
            <button
              class="group-toggle"
              title={g.cwd}
              onclick={() => toggleGroup(g.cwd)}
            >
              <span class="caret" class:collapsed={collapsed[g.cwd]}>▾</span>
              <span class="proj">{basename(g.cwd)}</span>
              <span class="count">{g.items.length}</span>
              {#if collapsed[g.cwd] && store.groupRunning(g.items.map((i) => i.sessionId))}
                <span class="group-running" aria-label="a session is running"></span>
              {/if}
            </button>
            <button
              class="icon add"
              title={`New session in ${g.cwd}`}
              aria-label={`New session in ${basename(g.cwd)}`}
              onclick={() => newInDir(g.cwd)}>+</button
            >
          </div>
          {#if !collapsed[g.cwd]}
            <ul>
              {#each g.items as s (s.path)}
                {@const st = store.sessionStatus(s.sessionId)}
                <li class="row-wrap">
                  <div class="row-line">
                    <button
                      class="row"
                      class:active={s.sessionId === store.activeSessionId}
                      title={`Open session: ${s.displayName || s.preview || "(untitled)"}`}
                      onclick={() => pick(s)}
                    >
                      <span
                        class="status"
                        data-state={st}
                        data-testid="session-status"
                        title={st}
                        aria-label={`status: ${st}`}
                      >
                        {#if st === "running"}
                          <i class="dot"></i><i class="dot"></i><i class="dot"></i>
                        {:else}
                          <i class="dot"></i>
                        {/if}
                      </span>
                      <span class="row-body">
                        <span class="name"
                          >{s.displayName || s.preview || "(untitled)"}</span
                        >
                        <span class="meta"
                          >{s.messageCount} msg{#if s.archived} · archived{/if}</span
                        >
                      </span>
                    </button>
                    <button
                      class="row-menu"
                      data-testid="session-menu"
                      title="Session actions"
                      aria-label={`Actions for ${s.displayName || s.preview || "session"}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === s.path}
                      onclick={() => toggleMenu(s.path)}>⋯</button
                    >
                  </div>
                  {#if menuFor === s.path}
                    <div class="menu" role="menu">
                      <button
                        class="menu-item"
                        role="menuitem"
                        title={s.archived
                          ? "Restore this session to the active list"
                          : "Hide this session from the active list"}
                        onclick={() => toggleArchive(s)}
                        >{s.archived ? "Unarchive" : "Archive"}</button
                      >
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </nav>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 264px;
    flex-shrink: 0;
    height: 100%;
    height: 100dvh;
    background: var(--surface-sunken);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  /* Collapsed on desktop: removed from the flex flow entirely. */
  .sidebar[data-open="false"] {
    display: none;
  }
  .scrim {
    display: none;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
  }
  .brand {
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.01em;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    font-size: 17px;
    line-height: 1;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
  }
  .icon:hover {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }

  .new {
    padding: 0 10px 8px;
  }
  .new-btn {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    text-align: left;
    font-size: 13px;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .new-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .plus {
    color: var(--accent);
    font-weight: 700;
  }
  .dir-input {
    width: 100%;
    font-family: var(--font-mono);
    font-size: 13px; /* ≥16px would dodge iOS zoom, but this input only shows on desktop-ish widths; keep compact */
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .dir-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .dir-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  .worktree-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .worktree-toggle input {
    margin: 0;
  }
  .ghost,
  .primary {
    font-size: 12.5px;
    border-radius: var(--radius-xs);
    padding: 5px 11px;
    border: 1px solid var(--border);
  }
  .ghost {
    color: var(--text-muted);
    background: transparent;
  }
  .primary {
    color: var(--accent-text);
    background: var(--accent);
    border-color: var(--accent);
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .err {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--danger);
    background: var(--danger-soft);
    border-radius: var(--radius-xs);
    padding: 6px 8px;
  }
  .err-x {
    margin-left: auto;
    background: transparent;
    border: none;
    color: var(--danger);
    font-size: 14px;
    line-height: 1;
  }

  .search {
    padding: 0 10px 8px;
  }
  .search-input {
    width: 100%;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px 10px;
  }
  .search-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .search-input::placeholder {
    color: var(--text-faint);
  }

  .filter {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 8px;
  }
  .filter-toggle {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 4px 10px;
  }
  .filter-toggle:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .filter-toggle[aria-pressed="true"] {
    color: var(--accent);
    border-color: var(--accent);
  }
  .hidden-count {
    font-size: 11px;
    color: var(--text-faint);
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 6px 14px;
  }
  .empty {
    padding: 16px 10px;
    font-size: 13px;
    color: var(--text-muted);
    text-align: center;
  }
  .group {
    margin-bottom: 2px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
  }
  .group-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 7px 6px;
    color: var(--text-muted);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .caret {
    font-size: 13px;
    width: 13px;
    text-align: center;
    color: var(--text-muted);
    transition: transform 0.12s ease;
  }
  .caret.collapsed {
    transform: rotate(-90deg);
  }
  /* A single pulsing dot beside a collapsed project that has a running session. */
  .group-running {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: dotPulse 1.1s ease-in-out infinite;
  }
  .proj {
    font-weight: 600;
    color: var(--text);
    text-transform: none;
    letter-spacing: -0.01em;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    color: var(--text-faint);
    font-size: 11px;
  }
  .add {
    width: 24px;
    height: 24px;
    font-size: 15px;
    flex-shrink: 0;
  }
  ul {
    list-style: none;
    /* Indent the whole session list under its project header so the parent-child
       relationship reads at a glance (no tree rail — indentation only). */
    margin: 0 0 2px;
    padding: 0 0 0 12px;
  }
  /* A row + its overflow (⋯) button on one line; the inline actions menu drops below. */
  .row-line {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 10px;
  }
  .row:hover {
    background: var(--surface);
  }
  .row.active {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  /* Overflow (⋯) trigger: hover-revealed on desktop, always shown on touch. */
  .row-menu {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    font-size: 16px;
    line-height: 1;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    opacity: 0;
    transition: opacity 0.1s ease;
  }
  .row-wrap:hover .row-menu,
  .row-menu[aria-expanded="true"] {
    opacity: 1;
  }
  .row-menu:hover {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }
  .menu {
    display: flex;
    flex-direction: column;
    margin: 2px 0 4px 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }
  .menu-item {
    text-align: left;
    padding: 8px 12px;
    font-size: 13px;
    color: var(--text);
    background: transparent;
    border: none;
  }
  .menu-item:hover {
    background: var(--surface-sunken);
  }
  .row-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }
  /* Status indicator gutter (running / unread / read), left of the title. */
  .status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 18px;
    flex-shrink: 0;
  }
  .status .dot {
    border-radius: 50%;
  }
  /* read / idle — a hollow ring. */
  .status[data-state="read"] .dot {
    width: 7px;
    height: 7px;
    background: transparent;
    border: 1.5px solid var(--text-faint);
  }
  /* unread — a filled dot (new content since last viewed). */
  .status[data-state="unread"] .dot {
    width: 8px;
    height: 8px;
    background: var(--unread);
  }
  /* running — three dots in a left-to-right pulse, echoing the mockup's "···". */
  .status[data-state="running"] .dot {
    width: 4px;
    height: 4px;
    background: var(--text-muted);
    animation: dotPulse 1.1s ease-in-out infinite;
  }
  .status[data-state="running"] .dot:nth-child(2) {
    animation-delay: 0.18s;
  }
  .status[data-state="running"] .dot:nth-child(3) {
    animation-delay: 0.36s;
  }
  @keyframes dotPulse {
    0%,
    75%,
    100% {
      opacity: 0.3;
    }
    35% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .status[data-state="running"] .dot,
    .group-running {
      animation: none;
      opacity: 0.7;
    }
  }
  .name {
    font-size: 13.5px;
    letter-spacing: -0.01em;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.active .name {
    color: var(--accent);
    font-weight: 600;
  }
  .meta {
    font-size: 11px;
    color: var(--text-faint);
    font-family: var(--font-mono);
  }

  /* Phone: the sidebar becomes a slide-over drawer above the transcript. */
  @media (max-width: 859px) {
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 60;
      width: min(82vw, 320px);
      box-shadow: var(--shadow-pop);
      transition: transform 0.18s ease;
    }
    .sidebar[data-open="false"] {
      display: flex; /* keep it mounted; slide it off-screen instead of unmounting */
      transform: translateX(-100%);
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 55;
      background: rgba(0, 0, 0, 0.34);
      border: none;
    }
    /* No hover on touch — keep the ⋯ trigger visible so it's reachable. */
    .row-menu {
      opacity: 1;
    }
  }
</style>
