<script lang="ts">
  import { tick } from "svelte";
  import type { SessionListEntry } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import { filterSessions } from "../lib/session-filter.js";
  import { relativeTime } from "../lib/relative-time.js";
  import { buildHash, buildDate, buildLabel } from "../lib/build-info.js";
  import ContextRing from "./ContextRing.svelte";

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

  // Per-row actions menu (the ⋯ overflow) — a floating popover anchored under the ⋯ trigger
  // (right-aligned to it) or at the cursor on right-click. Positioned in viewport coords so
  // it overlays the list instead of shoving rows down. `menuFor` holds the open session's
  // path (one at a time); `menuPos` is where to paint it.
  type MenuPos = { top: number; left?: number; right?: number };
  let menuFor = $state<string | null>(null);
  // Worktree cleanup is destructive, so it's a two-step: the first click arms it (this
  // holds the session path being confirmed), the second actually removes.
  let confirmCleanup = $state<string | null>(null);
  let menuPos = $state<MenuPos | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  // The open session entry, resolved fresh from the store so the menu reflects the current
  // archived state (drives Archive vs Unarchive, and the `a` hotkey below).
  const menuSession = $derived(
    menuFor ? (store.sessions.find((s) => s.path === menuFor) ?? null) : null,
  );

  function openAt(path: string, pos: MenuPos): void {
    menuFor = path;
    menuPos = pos;
    clampedFor = null;
  }
  // ⋯ trigger: toggle; when opening, hang the menu just under the button, right-aligned to it.
  function toggleMenu(e: MouseEvent, path: string): void {
    if (menuFor === path) {
      closeMenu();
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openAt(path, { top: r.bottom + 4, right: window.innerWidth - r.right });
  }
  // Right-clicking a row opens its menu at the cursor (and suppresses the native context
  // menu), mirroring the desktop expectation. Always opens — never toggles closed — so a
  // second right-click re-targets rather than dismissing.
  function openMenu(e: MouseEvent, path: string): void {
    e.preventDefault();
    openAt(path, { top: e.clientY, left: e.clientX });
  }
  function closeMenu(): void {
    menuFor = null;
    menuPos = null;
    confirmCleanup = null;
  }
  function toggleArchive(s: SessionListEntry): void {
    store.setArchived(s.path, !s.archived);
    closeMenu();
  }
  // Inline rename. Holds the path of the session being renamed (one at a time), the
  // working text, and the input ref so we can focus+select on open.
  let renamingFor = $state<string | null>(null);
  let renameValue = $state("");
  let renameInput = $state<HTMLInputElement | null>(null);
  async function startRename(s: SessionListEntry): Promise<void> {
    closeMenu();
    renamingFor = s.path;
    // Prefill the current name (not the preview/path fallback) — renaming starts from
    // what's actually set, blank if unnamed.
    renameValue = s.displayName ?? "";
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }
  function submitRename(): void {
    if (!renamingFor) return;
    store.renameSession(renamingFor, renameValue);
    renamingFor = null;
  }
  function cancelRename(): void {
    renamingFor = null;
  }

  // Keep the popover on-screen: once mounted, measure it and pull it back inside the viewport
  // if it would spill off the bottom or right edge. `clampedFor` keys the one-shot self-write
  // to the open path (reset in openAt) so we adjust each open exactly once, no feedback loop.
  let clampedFor: string | null = null;
  $effect(() => {
    const el = menuEl;
    if (!menuFor || !menuPos || !el || clampedFor === menuFor) return;
    const m = 8;
    const r = el.getBoundingClientRect();
    const next: MenuPos = { ...menuPos };
    if (next.top + r.height > window.innerHeight - m)
      next.top = Math.max(m, window.innerHeight - m - r.height);
    if (next.left != null && next.left + r.width > window.innerWidth - m)
      next.left = Math.max(m, window.innerWidth - m - r.width);
    clampedFor = menuFor;
    if (next.top !== menuPos.top || next.left !== menuPos.left) menuPos = next;
  });

  // Dismiss the menu on an outside click, Escape, or scroll/resize (which would detach the
  // fixed popover from its row). The click listener is deferred so the opening click doesn't
  // immediately re-close it. While open, `a` archives/unarchives the targeted session —
  // unless focus is in a text field, where `a` should type.
  async function copyWorktreePath(s: SessionListEntry): Promise<void> {
    if (s.worktree) await store.copyWorktreePath(s.worktree.path);
    closeMenu();
  }
  function cleanupWorktree(s: SessionListEntry): void {
    // Second click confirms; force-removes (the menu label warns it discards changes).
    if (s.worktree) store.cleanupWorktree(s.worktree.path, true);
    closeMenu();
  }
  $effect(() => {
    if (!menuFor) return;
    const onClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      // An in-menu item that re-renders (e.g. arming the cleanup confirm) detaches the
      // clicked node before this fires; a detached target has no ancestors, so `closest`
      // would wrongly read as an outside click and close the menu. Ignore those.
      if (!t.isConnected) return;
      if (!t.closest(".menu") && !t.closest(".row-menu")) closeMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        closeMenu();
        return;
      }
      if (e.key === "a" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
          return;
        if (menuSession) {
          e.preventDefault();
          toggleArchive(menuSession);
        }
      }
    };
    const onDetach = (): void => closeMenu();
    const id = setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onDetach, true);
    window.addEventListener("resize", onDetach);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onDetach, true);
      window.removeEventListener("resize", onDetach);
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

  // A reactive clock for the relative row timestamps ("7m ago"). Minute-resolution
  // labels go stale as the minute rolls over, so re-stamp `now` once a minute. Gated
  // on the sidebar being open (no point re-rendering a hidden drawer) and refreshed
  // immediately on (re)open so a long-closed sidebar isn't showing a frozen time.
  let now = $state(Date.now());
  $effect(() => {
    if (!store.sidebarOpen) return;
    now = Date.now();
    const id = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(id);
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
  // Open the new-session draft (config chips + first prompt live in the main pane's
  // composer; creation is deferred until send). `cwd` prefills the project: the group's
  // dir from a project "+" header, or the active session's dir from the top button.
  function startDraft(cwd: string): void {
    store.startDraft(cwd);
    afterNavigate();
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
    <button
      class="new-btn"
      title="Start a new session — pick the project, worktree, and model in the composer (creation is deferred until you send)"
      onclick={() => startDraft(activeCwd)}
    >
      <span class="plus">+</span> New session…
    </button>
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
              {#if collapsed[g.cwd]}
                <span class="count">{g.items.length}</span>
              {/if}
              {#if collapsed[g.cwd] && store.groupRunning(g.items.map((i) => i.sessionId))}
                <span class="group-running" aria-label="a session is running"></span>
              {/if}
            </button>
            <button
              class="icon add"
              title={`New session in ${g.cwd}`}
              aria-label={`New session in ${basename(g.cwd)}`}
              onclick={() => startDraft(g.cwd)}>+</button
            >
          </div>
          {#if !collapsed[g.cwd]}
            <ul>
              {#each g.items as s (s.path)}
                {@const st = store.sessionStatus(s.sessionId)}
                {@const rel = relativeTime(s.updatedAt, now)}
                <li class="row-wrap">
                  {#if renamingFor === s.path}
                    <form
                      class="rename"
                      onsubmit={(e) => {
                        e.preventDefault();
                        submitRename();
                      }}
                    >
                      <input
                        class="rename-input"
                        type="text"
                        bind:this={renameInput}
                        bind:value={renameValue}
                        spellcheck="false"
                        autocapitalize="off"
                        autocorrect="off"
                        placeholder="Session name"
                        title="New session name — Enter to save, Esc to cancel"
                        aria-label="New session name"
                        onkeydown={(e) => {
                          if (e.key === "Escape") cancelRename();
                        }}
                      />
                      <div class="rename-actions">
                        <button
                          class="ghost"
                          type="button"
                          title="Cancel rename (Esc)"
                          onclick={cancelRename}>Cancel</button
                        >
                        <button
                          class="primary"
                          type="submit"
                          title="Save the new session name (Enter)"
                          disabled={!renameValue.trim()}>Save</button
                        >
                      </div>
                    </form>
                  {:else}
                  <div class="row-line">
                    <button
                      class="row"
                      class:active={s.sessionId === store.activeSessionId}
                      onclick={() => pick(s)}
                      oncontextmenu={(e) => openMenu(e, s.path)}
                    >
                      <span
                        class="status"
                        data-state={st}
                        data-testid="session-status"
                        title={st === "initializing" ? "initializing — warming up" : st}
                        aria-label={`status: ${st}`}
                      >
                        {#if st === "running"}
                          <i class="dot"></i><i class="dot"></i><i class="dot"></i>
                        {:else if st === "initializing"}
                          <i class="spinner"></i>
                        {:else}
                          <i class="dot"></i>
                        {/if}
                      </span>
                      <span class="row-body">
                        <span class="name"
                          >{s.displayName || s.preview || "(untitled)"}</span
                        >
                        <span class="meta">
                          <span class="msg-count"
                            >{s.userMessageCount} msg{#if s.archived} ·
                              archived{/if}{#if s.worktree}
                              ·
                              <span
                                class="wt"
                                title={`Worktree: ${s.worktree.path}`}
                                aria-label="worktree"
                              >
                                <svg
                                  viewBox="0 0 24 24"
                                  width="11"
                                  height="11"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="2"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  aria-hidden="true"
                                >
                                  <line x1="6" y1="3" x2="6" y2="15" />
                                  <circle cx="18" cy="6" r="3" />
                                  <circle cx="6" cy="18" r="3" />
                                  <path d="M18 9a9 9 0 0 1-9 9" />
                                </svg>
                              </span>{/if}</span
                          >
                          <span class="meta-end">
                            {#if s.usage}
                              <ContextRing
                                usage={s.usage}
                                size={12}
                                showLabel={false}
                              />
                            {/if}
                            {#if rel}
                              <span class="time" title={`Last activity ${rel}`}
                                >{rel}</span
                              >
                            {/if}
                          </span>
                        </span>
                      </span>
                    </button>
                    <button
                      class="row-menu"
                      data-testid="session-menu"
                      title="Session actions"
                      aria-label={`Actions for ${s.displayName || s.preview || "session"}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === s.path}
                      onclick={(e) => toggleMenu(e, s.path)}>⋯</button
                    >
                  </div>
                  {#if menuFor === s.path && menuPos}
                    <div
                      class="menu"
                      role="menu"
                      bind:this={menuEl}
                      style={`top:${menuPos.top}px;${menuPos.left != null ? `left:${menuPos.left}px` : `right:${menuPos.right}px`}`}
                    >
                      {#if s.worktree}
                        <button
                          class="menu-item"
                          role="menuitem"
                          title={`Copy the worktree path to the clipboard: ${s.worktree.path}`}
                          onclick={() => copyWorktreePath(s)}
                          >Copy worktree path</button
                        >
                        {#if confirmCleanup === s.path}
                          <button
                            class="menu-item danger"
                            role="menuitem"
                            data-testid="confirm-cleanup-worktree"
                            title="Permanently remove the worktree from disk — discards any uncommitted changes"
                            onclick={() => cleanupWorktree(s)}
                            >Confirm: delete worktree</button
                          >
                        {:else}
                          <button
                            class="menu-item"
                            role="menuitem"
                            data-testid="cleanup-worktree"
                            title="Remove this worktree from disk, freeing the isolated copy (asks to confirm)"
                            onclick={() => (confirmCleanup = s.path)}
                            >Clean up worktree…</button
                          >
                        {/if}
                      {/if}
                      <button
                        class="menu-item"
                        role="menuitem"
                        title="Rename this session"
                        onclick={() => startRename(s)}>Rename</button
                      >
                      <button
                        class="menu-item"
                        role="menuitem"
                        title={s.archived
                          ? "Restore this session to the active list (A)"
                          : "Hide this session from the active list (A)"}
                        onclick={() => toggleArchive(s)}
                      >
                        <span>{s.archived ? "Unarchive" : "Archive"}</span>
                        <kbd class="hotkey" aria-hidden="true">A</kbd>
                      </button>
                    </div>
                  {/if}
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </nav>

  <!-- Build stamp: last commit hash + date, baked in at build time. Quiet footer so
       you can tell which version is live without it competing with the session list. -->
  <div
    class="version"
    data-testid="version"
    title={buildDate
      ? `pilot build ${buildHash} · committed ${buildDate}`
      : `pilot build ${buildHash}`}
  >
    {buildLabel}
  </div>
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
  /* Quiet build stamp pinned at the bottom of the sidebar. */
  .version {
    flex-shrink: 0;
    padding: 8px 14px calc(8px + env(safe-area-inset-bottom));
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
    user-select: none;
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
  /* Collapse/expand affordance: revealed only on hover (the row width is reserved so
     nothing shifts). The count badge stands in for state when a group is collapsed. */
  .caret {
    font-size: 13px;
    width: 13px;
    text-align: center;
    color: var(--text-muted);
    opacity: 0;
    transition:
      transform 0.12s ease,
      opacity 0.1s ease;
  }
  .group-head:hover .caret,
  .group-toggle:focus-visible .caret {
    opacity: 1;
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
  /* Floating popover: pinned in viewport coords (set inline) so it overlays the list
     rather than displacing rows. position: fixed escapes the list's overflow clip. */
  .menu {
    position: fixed;
    z-index: 70;
    min-width: 160px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-pop);
  }
  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    text-align: left;
    padding: 8px 10px;
    font-size: 13px;
    color: var(--text);
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
  }
  .menu-item:hover {
    background: var(--surface-sunken);
  }
  /* Inline rename: replaces the row in place while editing. */
  .rename {
    padding: 4px 6px 6px;
  }
  .rename-input {
    width: 100%;
    font-size: 13.5px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 7px 10px;
  }
  .rename-input:focus {
    outline: none;
  }
  .rename-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  /* Decorative shortcut hint (aria-hidden — kept out of the button's accessible name). */
  .hotkey {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1;
    color: var(--text-faint);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 2px 5px;
  }
  .menu-item.danger {
    color: var(--danger);
  }
  .menu-item.danger:hover {
    background: var(--danger-soft);
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
  /* initializing — a small rotating ring (a session warming up, pre-stream). Distinct
     from the running pulse so the two phases read apart at a glance. */
  .status[data-state="initializing"] .spinner {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--accent);
    animation: statusSpin 0.7s linear infinite;
  }
  @keyframes statusSpin {
    to {
      transform: rotate(360deg);
    }
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
    .status[data-state="initializing"] .spinner {
      animation: none;
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
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--text-faint);
    font-family: var(--font-mono);
  }
  .msg-count {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Right side of the meta line: the optional context-fill ring + the timestamp. */
  .meta-end {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  /* Last-activity timestamp ("15m ago"), right-aligned under the name. */
  .time {
    flex-shrink: 0;
  }
  /* Worktree marker in the meta line — a compact tinted git-branch glyph (the title
     carries the full path; aria-label names it for screen readers). */
  .wt {
    display: inline-flex;
    align-items: center;
    color: var(--accent);
    cursor: help;
    vertical-align: middle;
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
    /* No hover on touch — keep the ⋯ trigger and the collapse caret visible. */
    .row-menu,
    .caret {
      opacity: 1;
    }
  }
</style>

