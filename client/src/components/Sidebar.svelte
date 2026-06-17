<script lang="ts">
  import type { SessionListEntry } from "@pilot/protocol";
  import { tick } from "svelte";
  import { store } from "../lib/store.svelte.js";

  // A new-session-in-a-directory disclosure (D12: arbitrary GUI-controlled paths).
  let showNewDir = $state(false);
  let newDir = $state("");
  let dirInput = $state<HTMLInputElement | null>(null);

  function basename(p: string): string {
    const parts = p.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || p;
  }

  // The cwd of the currently-active session, used to prefill the new-dir input so
  // "new session near where I am" is one keystroke, not a full path retype.
  const activeCwd = $derived(
    store.sessions.find((s) => s.sessionId === store.activeSessionId)?.cwd ?? "",
  );

  // Group sessions by project directory; sort sessions within a group and groups
  // themselves by recency (most recent first), so the active project floats up.
  const groups = $derived.by(() => {
    const m = new Map<string, SessionListEntry[]>();
    for (const s of store.sessions) {
      const arr = m.get(s.cwd);
      if (arr) arr.push(s);
      else m.set(s.cwd, [s]);
    }
    const out = [...m.entries()].map(([cwd, items]) => ({
      cwd,
      items: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
    out.sort((a, b) =>
      (b.items[0]?.updatedAt ?? "").localeCompare(a.items[0]?.updatedAt ?? ""),
    );
    return out;
  });

  // Filter-as-you-type search over the session list (name, preview, path). Empty =
  // show everything; groups with no matching session are dropped entirely.
  let query = $state("");
  const q = $derived(query.trim().toLowerCase());
  const filteredGroups = $derived.by(() => {
    if (!q) return groups;
    const out: { cwd: string; items: SessionListEntry[] }[] = [];
    for (const g of groups) {
      const items = g.items.filter(
        (s) =>
          (s.displayName ?? "").toLowerCase().includes(q) ||
          (s.preview ?? "").toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q),
      );
      if (items.length > 0) out.push({ ...g, items });
    }
    return out;
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
    store.newSession(dir);
    showNewDir = false;
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
            if (e.key === "Escape") showNewDir = false;
          }}
        />
        <div class="dir-actions">
          <button class="ghost" type="button" onclick={() => (showNewDir = false)}>
            Cancel
          </button>
          <button class="primary" type="submit" disabled={!newDir.trim()}>
            Start
          </button>
        </div>
      </form>
    {:else}
      <button class="new-btn" onclick={openNewDir}>
        <span class="plus">+</span> New session in a directory…
      </button>
    {/if}
    {#if store.lastError}
      <div class="err" role="alert">
        {store.lastError}
        <button class="err-x" aria-label="Dismiss" onclick={() => store.clearError()}
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
  {/if}

  <nav class="list">
    {#if filteredGroups.length === 0}
      <div class="empty">
        {q ? "No sessions match your search." : "No sessions yet."}
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
                <li>
                  <button
                    class="row"
                    class:active={s.sessionId === store.activeSessionId}
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
                      <span class="meta">{s.messageCount} msg</span>
                    </span>
                  </button>
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
    /* Cap a busy project at ~10 visible rows and scroll within the group, so a single
       large project can't push every other group off the screen. */
    max-height: 21rem;
    overflow-y: auto;
  }
  .row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    width: 100%;
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
  }
</style>
