<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  // A server-side directory browser for the new-session project picker. The server
  // resolves + reads paths on ITS filesystem (pi runs server-side), so this browses the
  // server regardless of which device the client is on — a native browser file picker
  // would see the wrong machine and never yield a real path. Tap a folder to descend,
  // the breadcrumb to jump up, "Use this folder" to pick the one you're in.
  //
  // An always-visible filter input lets you fuzzy-match subdirectories: type `pi` to
  // narrow the list to entries whose names contain those characters in order. With a
  // filter, Enter (or Tab, shell-style autocomplete) descends into the selected match.
  // With the filter empty, Enter commits the directory you're standing in (same as
  // "Use this folder"). Type a path starting with / or ~ and Enter jumps there directly
  // (the old "go to path" escape hatch, now always available). Backspace when the filter
  // is empty goes up one directory (there's no ".." row — use Backspace/← or the breadcrumb).
  let {
    recents,
    current,
    defaultCwd,
    onpick,
    onclose,
  }: {
    recents: readonly string[];
    /** The draft's current cwd (where the picker opens), or "" for home. */
    current: string;
    /** The server's $HOME (the "home" shortcut + the fallback open path). */
    defaultCwd: string;
    onpick: (path: string) => void;
    onclose: () => void;
  } = $props();

  // The server echoes the resolved path, so we just render whatever listing it last sent
  // (only this picker ever drives `queryDir`). Replies are a local readdir away, so the
  // brief moment the prior directory shows between request and reply isn't worth gating on.
  const showing = $derived(store.dirListing);
  const entries = $derived(showing?.entries ?? []);

  // Filter text — always visible, always typed into. Empty = show all subdirs.
  let filterText = $state("");
  let filterRef = $state<HTMLInputElement>();
  // Keyboard selection index over the filtered subdirectory rows.
  let sel = $state(0);
  let lastPath = $state("");

  // Path mode: input starts with / or ~ → Enter navigates to the raw path (server-resolved).
  const isPathMode = $derived(
    filterText.trim().startsWith("/") || filterText.trim().startsWith("~"),
  );

  // Fuzzy-filtered subdirectory entries. In path mode we show everything (the user is
  // typing a path, not filtering); otherwise we filter by subsequence match.
  const filtered = $derived.by(() => {
    const q = filterText.trim();
    if (!q || isPathMode) return entries;
    return entries.filter((name) => fuzzyMatch(q, name));
  });

  const visibleCount = $derived(filtered.length);

  // Reset filter + selection whenever the directory changes.
  $effect(() => {
    if (showing && showing.path !== lastPath) {
      lastPath = showing.path;
      filterText = "";
      sel = 0;
    }
  });

  // Auto-select the top filtered match when the user starts typing.
  $effect(() => {
    if (filterText.trim() && !isPathMode) {
      sel = 0;
    }
  });

  // Clamp selection to visible rows.
  $effect(() => {
    if (visibleCount > 0 && sel >= visibleCount) sel = visibleCount - 1;
  });

  // Debounced path-existence check for the inline validation hint (path mode only).
  let statTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const q = filterText.trim();
    if (isPathMode && q) {
      clearTimeout(statTimer);
      statTimer = setTimeout(() => store.statPath(q), 300);
    }
    return () => clearTimeout(statTimer);
  });

  function refocus() {
    // requestAnimationFrame is more reliable than queueMicrotask: it runs after
    // the DOM has settled from any pending $state-driven re-renders.
    requestAnimationFrame(() => filterRef?.focus());
  }

  function go(path: string) {
    store.queryDir(path);
    refocus();
  }

  function descend(name: string) {
    if (!showing) return;
    const base = showing.path === "/" ? "" : showing.path;
    go(`${base}/${name}`);
    refocus();
  }

  function up() {
    if (showing?.parent) go(showing.parent);
  }

  function commit() {
    if (showing) onpick(showing.path);
  }

  // Breadcrumb: cumulative paths for each segment of the current dir.
  const crumbs = $derived.by(() => {
    const p = showing?.path ?? "";
    if (!p) return [] as { label: string; path: string }[];
    const segs = p.split("/").filter(Boolean);
    const out = [{ label: "/", path: "/" }];
    let acc = "";
    for (const s of segs) {
      acc += `/${s}`;
      out.push({ label: s, path: acc });
    }
    return out;
  });

  const baseName = $derived.by(() => {
    const p = showing?.path ?? "";
    return p === "/" ? "/" : (p.split("/").pop() ?? p);
  });

  // Recents worth showing as shortcuts: skip the dir we're already viewing.
  const recentShortcuts = $derived(
    recents.filter((r) => r !== showing?.path).slice(0, 6),
  );

  function baseOf(p: string): string {
    return p === "/" ? "/" : (p.split("/").pop() ?? p);
  }

  /** Subsequence match: every char of `query` must appear in order in `target`,
   *  case-insensitive. The standard fuzzy-finder predicate. */
  function fuzzyMatch(query: string, target: string): boolean {
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) qi++;
    }
    return qi === q.length;
  }

  function onkeydown(e: KeyboardEvent) {
    // The filter input's own handler stops propagation for navigation keys so they
    // don't bubble here. Printable characters already land in the input via normal
    // typing — the picker div doesn't need its own keydown handler anymore, but we
    // keep a catch-all so global keys (like the / shortcut or the old edit-mode nav)
    // don't fire while the picker is open.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (filterText) {
        filterText = "";
        refocus();
      } else {
        onclose();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "/") {
      // Typing / focuses the filter input so the user can start a path. Don't
      // prevent default — let the / land in the input as a normal character.
      refocus();
    }
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (filterText) {
        filterText = "";
      } else {
        onclose();
      }
      return;
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      if (visibleCount) sel = (sel + 1) % visibleCount;
      return;
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      if (visibleCount) sel = (sel - 1 + visibleCount) % visibleCount;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (isPathMode) {
        // Path mode: navigate to the typed path directly.
        go(filterText.trim());
      } else if (!filterText.trim()) {
        // No filter: Enter commits the directory we're standing in.
        commit();
      } else {
        // Filter mode: descend into the selected match.
        const name = filtered[sel];
        if (name) descend(name);
      }
      return;
    }
    if (e.key === "Tab") {
      // Shell-style autocomplete: descend into the highlighted entry. preventDefault
      // keeps Tab from moving focus out of the filter input.
      e.preventDefault();
      if (!isPathMode) {
        const name = filtered[sel];
        if (name) descend(name);
      }
      return;
    }
    if (e.key === "ArrowRight") {
      if (!isPathMode && filtered.length > 0) {
        e.preventDefault();
        const name = filtered[sel];
        if (name) descend(name);
      }
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "Backspace") {
      if (!filterText) {
        e.preventDefault();
        up();
      }
      // With text: let the browser handle cursor movement / deletion normally.
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
  }

  // (Keeping the keyboard-selected row in view is handled by use:scrollIndexIntoView on
  // the picker container below.)

  // Open at the draft's current dir (or home), and grab the keyboard.
  $effect(() => {
    go(current.trim() || defaultCwd);
  });

  // Path validation hint derived from the server's stat response.
  const statHint = $derived.by(() => {
    const ps = store.pathStat;
    if (!ps || !isPathMode) return null;
    // Only show when the query approximately matches (the server resolves ~/relative
    // paths, so we can't do a direct string compare — use endsWith as a heuristic).
    const q = filterText.trim();
    if (!q) return null;
    if (ps.exists && ps.isDir) return "ok" as const;
    if (ps.exists && !ps.isDir) return "file" as const;
    return "missing" as const;
  });

  function hintText(h: "ok" | "file" | "missing"): string {
    if (h === "ok") return "✓ directory";
    if (h === "file") return "✗ not a directory";
    return "✗ not found";
  }
</script>

<div
  class="picker"
  role="dialog"
  aria-label="Choose project directory"
  data-testid="dir-picker"
  tabindex="-1"
  use:scrollIndexIntoView={sel}
  {onkeydown}
>
  <!-- Path breadcrumb — clickable segments to jump to ancestors. -->
  <div class="bc" aria-label="Current path">
    {#each crumbs as c (c.path)}
      <button
        class="crumb"
        title={`Go to ${c.path}`}
        onmousedown={(e) => {
          e.preventDefault();
          go(c.path);
        }}>{c.label}</button
      >{#if c.path !== "/"}<span class="crumb-sep" aria-hidden="true">/</span>{/if}
    {/each}
    <button
      class="home-btn"
      title={`Go to home (${defaultCwd})`}
      onmousedown={(e) => {
        e.preventDefault();
        go(defaultCwd);
      }}>⌂ home</button
    >
  </div>

  <!-- Always-visible filter input. Type to narrow subdirs; start with / or ~ to jump to
       a path. Backspace when empty goes up. -->
  <div class="filter-row">
    <input
      class="filter-input"
      type="text"
      bind:value={filterText}
      bind:this={filterRef}
      placeholder={isPathMode ? "Type a path, Enter to go…" : "Filter subdirectories…"}
      autofocus
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      aria-label={isPathMode ? "Go to path" : "Filter subdirectories"}
      title={isPathMode
        ? "Type or paste a path, then Enter to go (Esc to clear)"
        : "Filter subdirs — Tab/→ enters the match, Enter (empty filter) uses this folder, Backspace goes up, Esc clears"}
      onkeydown={onInputKeydown}
    />
    {#if statHint}
      <span
        class="stat-hint"
        class:stat-ok={statHint === "ok"}
        class:stat-err={statHint !== "ok"}
        aria-live="polite"
      >
        {hintText(statHint)}
      </span>
    {/if}
  </div>

  {#if recentShortcuts.length}
    <div class="recents">
      <span class="recents-label">recent</span>
      {#each recentShortcuts as r (r)}
        <button
          class="recent-chip"
          title={`Use ${r}`}
          onmousedown={(e) => {
            e.preventDefault();
            onpick(r);
          }}>▸ {baseOf(r)}</button
        >
      {/each}
    </div>
  {/if}

  <div class="list" role="listbox" aria-label="Subdirectories">
    {#if store.dirLoading && !showing}
      <div class="hint">Loading…</div>
    {:else if showing?.error}
      <div class="hint err">Can't read this folder. Go up or type a different path.</div>
    {:else if showing}
      {#each filtered as name, i (name)}
        <button
          class="row"
          class:sel={i === sel}
          data-i={i}
          role="option"
          aria-selected={i === sel}
          title={`Open ${name}/ (Tab / →)`}
          onmousedown={(e) => {
            e.preventDefault();
            descend(name);
          }}
          onmouseenter={() => (sel = i)}
        >
          <span class="ico" aria-hidden="true">▸</span>
          <span class="name">{name}</span>
        </button>
      {/each}
      {#if !filtered.length && !showing.error && !isPathMode}
        <div class="hint">No matching subdirectories.</div>
      {/if}
    {/if}
  </div>

  <div class="foot">
    <button
      class="use"
      title="Use this folder for the new session (↵ with empty filter, or ⌘/Ctrl+↵)"
      onmousedown={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      Use “{baseName}”
    </button>
    <button
      class="cancel"
      title="Close without changing the project (Esc)"
      onmousedown={(e) => {
        e.preventDefault();
        onclose();
      }}
    >
      Cancel
    </button>
  </div>
</div>

<style>
  .picker {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    max-height: min(60vh, 420px);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    outline: none;
  }
  .bc {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 1px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  .crumb {
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    padding: 2px 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .crumb:hover {
    color: var(--text);
    background: var(--surface-sunken);
  }
  .crumb-sep {
    color: var(--text-faint);
    font-size: 11px;
  }
  .home-btn {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 11.5px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .home-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  .filter-input {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-family: var(--font-mono);
    color: var(--text);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 12px;
    outline: none;
  }
  .filter-input:focus {
    border-color: var(--accent);
  }
  .stat-hint {
    flex-shrink: 0;
    font-size: 11px;
    font-family: var(--font-mono);
    white-space: nowrap;
  }
  .stat-ok {
    color: var(--success, #2da44e);
  }
  .stat-err {
    color: var(--danger, #cf222e);
  }
  .recents {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
  }
  .recents-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .recent-chip {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    cursor: pointer;
  }
  .recent-chip:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .list {
    flex: 1;
    overflow-y: auto;
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
  @media (pointer: coarse) {
    .row {
      min-height: 44px;
    }
  }
  .ico {
    flex-shrink: 0;
    width: 14px;
    font-size: 11px;
    color: var(--text-faint);
    text-align: center;
  }
  .name {
    font-family: var(--font-mono);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    padding: 12px 10px;
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .hint.err {
    color: var(--danger, var(--text-muted));
  }
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
    border-top: 1px solid var(--border);
  }
  .use {
    flex: 1;
    background: var(--accent);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 7px 12px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cancel {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px 12px;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .cancel:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
</style>
