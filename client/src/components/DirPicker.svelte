<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  // A server-side directory browser for the new-session project picker. The server
  // resolves + reads paths on ITS filesystem (pi runs server-side), so this browses the
  // server regardless of which device the client is on — a native browser file picker
  // would see the wrong machine and never yield a real path. Tap a folder to descend, the
  // breadcrumb to jump up, "Use this folder" to pick the one you're in. Recents (projects
  // you've already opened) sit on top as a one-tap shortcut.
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

  // Keyboard selection over the folder rows; reset whenever we land in a new directory.
  let sel = $state(0);
  let lastPath = $state("");
  let root = $state<HTMLDivElement>();

  // "Go to path" escape hatch: the breadcrumb swaps to a text input you can type/paste a
  // path into (server-resolved, incl. `~`), for dirs that are tedious to click to. Enter
  // navigates there; the listing then renders like any other (a bad path shows the error
  // hint). Mouse: the ✎ button. Keyboard: "/".
  let editing = $state(false);
  let pathInput = $state("");

  $effect(() => {
    if (showing && showing.path !== lastPath) {
      lastPath = showing.path;
      sel = 0;
    }
  });

  function go(path: string) {
    editing = false; // any navigation leaves the path-edit box
    store.queryDir(path);
    refocus();
  }

  function refocus() {
    queueMicrotask(() => root?.focus());
  }

  function startEdit() {
    pathInput = showing?.path ?? "";
    editing = true;
  }

  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function onPathKeydown(e: KeyboardEvent) {
    // Keep input keystrokes (arrows/Backspace/Enter) from bubbling to the picker's nav.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      go(pathInput);
    } else if (e.key === "Escape") {
      e.preventDefault();
      editing = false;
      refocus();
    }
  }

  function descend(name: string) {
    if (!showing) return;
    const base = showing.path === "/" ? "" : showing.path;
    go(`${base}/${name}`);
  }

  function up() {
    if (showing?.parent) go(showing.parent);
  }

  function use() {
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
  const recentShortcuts = $derived(recents.filter((r) => r !== showing?.path).slice(0, 6));

  function baseOf(p: string): string {
    return p === "/" ? "/" : (p.split("/").pop() ?? p);
  }

  function onkeydown(e: KeyboardEvent) {
    // While the path box is open it owns the keyboard (its own handler stops propagation);
    // this is just belt-and-suspenders so nav never fires underneath it.
    if (editing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      startEdit();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      use();
      return;
    }
    const n = entries.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      if (n) sel = (sel + 1) % n;
      return;
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      if (n) sel = (sel - 1 + n) % n;
      return;
    }
    if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      const name = entries[sel];
      if (name) descend(name);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "Backspace") {
      e.preventDefault();
      up();
      return;
    }
  }

  // Keep the keyboard-selected row in view.
  $effect(() => {
    const el = root?.querySelector<HTMLElement>(`[data-i="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });

  // Open at the draft's current dir (or home), and grab the keyboard.
  $effect(() => {
    go(current.trim() || defaultCwd);
  });
</script>

<div
  class="picker"
  role="dialog"
  aria-label="Choose project directory"
  data-testid="dir-picker"
  tabindex="-1"
  bind:this={root}
  {onkeydown}
>
  <div class="bc" aria-label="Current path">
    {#if editing}
      <input
        class="path-input"
        type="text"
        value={pathInput}
        placeholder="/absolute/path  (~ = home)"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        aria-label="Go to path"
        title="Type or paste a path, then Enter to go (Esc to cancel)"
        oninput={(e) => (pathInput = e.currentTarget.value)}
        onkeydown={onPathKeydown}
        onblur={() => (editing = false)}
        use:focusSelect
      />
    {:else}
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
        class="edit-path"
        title="Type or paste a path (press /)"
        aria-label="Type or paste a path"
        onmousedown={(e) => {
          e.preventDefault();
          startEdit();
        }}>✎</button
      >
      <button
        class="home-btn"
        title={`Go to home (${defaultCwd})`}
        onmousedown={(e) => {
          e.preventDefault();
          go(defaultCwd);
        }}>⌂ home</button
      >
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
      <div class="hint err">Can't read this folder. Use the breadcrumb to go back.</div>
    {:else if showing}
      {#if showing.parent}
        <button
          class="row up"
          title="Up to parent (← / Backspace)"
          onmousedown={(e) => {
            e.preventDefault();
            up();
          }}
        >
          <span class="ico" aria-hidden="true">↰</span>
          <span class="name">..</span>
        </button>
      {/if}
      {#each entries as name, i (name)}
        <button
          class="row"
          class:sel={i === sel}
          data-i={i}
          role="option"
          aria-selected={i === sel}
          title={`Open ${name}/ (↵ / →)`}
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
      {#if !entries.length && !showing.error}
        <div class="hint">No subfolders here.</div>
      {/if}
    {/if}
  </div>

  <div class="foot">
    <button class="use" title="Use this folder for the new session (⌘/Ctrl+↵)" onmousedown={(e) => { e.preventDefault(); use(); }}>
      Use “{baseName}”
    </button>
    <button class="cancel" title="Close without changing the project (Esc)" onmousedown={(e) => { e.preventDefault(); onclose(); }}>
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
  .path-input {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-family: var(--font-mono);
    color: var(--text);
    background: var(--surface-sunken);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 4px 12px;
    outline: none;
  }
  .edit-path {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .edit-path:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .home-btn {
    margin-left: 4px;
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
  .row.up .name {
    color: var(--text-muted);
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
