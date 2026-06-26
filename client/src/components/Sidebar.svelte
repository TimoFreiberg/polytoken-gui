<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { SessionListEntry } from "@pilot/protocol";
  import { reveal } from "../lib/transitions.js";
  import { store } from "../lib/store.svelte.js";
  import { filterSessions } from "../lib/session-filter.js";
  import { compactTime, relativeTime } from "../lib/relative-time.js";
  import { buildHash, buildDate, buildLabel } from "../lib/build-info.js";
  import ContextRing from "./ContextRing.svelte";
  import Button from "./ui/Button.svelte";

  // Above this context-fill %, a session's row shows the gauge ring — a quiet "this one's
  // getting full" cue. Below it the ring is noise on a single line, so it stays hidden.
  const RING_THRESHOLD = 66;
  import IconButton from "./ui/IconButton.svelte";
  import Chevron from "./ui/Chevron.svelte";
  import PullIndicator from "./PullIndicator.svelte";
  import { pullToRefresh } from "../lib/pull-to-refresh.js";
  import { createPullRefresh } from "../lib/pull-to-refresh.svelte.js";
  import type { EdgeSwipe } from "../lib/edge-swipe.svelte.js";

  // Pull-to-refresh (touch only): pulling the session list down from the top forces a
  // reconnect + re-snapshot, same gesture as the transcript.
  const pull = createPullRefresh();
  onDestroy(() => pull.dispose());

  // Left-edge swipe live-follow: while a phone drawer-open swipe is in flight, the
  // controller's snapshot drives this sidebar's translateX so it tracks the finger;
  // .edge-drag disables the open/close transition so the follow is frame-accurate.
  // Passed in from App.svelte (the swipe surface is the main pane), so the one
  // controller owns both the action's callbacks and the snapshot we read here.
  const { edge }: { edge: EdgeSwipe } = $props();
  const edgeDragging = $derived(edge.snap.phase !== "idle");
  const sidebarTransform = $derived(
    edgeDragging
      ? `translateX(calc(-100% + ${edge.snap.distance}px))`
      : undefined,
  );

  // Touch-primary devices only — desktop has the Reconnect button (Alt+R).
  const isTouch =
    typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;

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
      pinnedIds: store.pinnedSidebarIds,
    }),
  );
  const filteredGroups = $derived(filtered.groups);
  const hiddenCount = $derived(filtered.hiddenCount);

  // New-session drafts as sidebar rows. Each pending draft nests under its target
  // project's group; a draft whose cwd isn't a known project yet floats at the very
  // top. A draft under a collapsed group hides with the group (the `<ul>` is gated on
  // expansion). The set reacts to typing / discard / retarget via `store.pendingDrafts`.
  const pendingDrafts = $derived(store.pendingDrafts);
  const groupCwds = $derived(new Set(filteredGroups.map((g) => g.cwd)));
  const topDrafts = $derived(
    pendingDrafts.filter((d) => !groupCwds.has(d.cwd)),
  );
  const groupDraftsFor = (cwd: string) =>
    pendingDrafts.filter((d) => d.cwd === cwd);

  // Search-box keyboard: Enter opens the top match (first session of the first group —
  // the visual top of the list), Esc clears a non-empty query (else blurs). The ref also
  // lets us focus the box when the drawer opens.
  let searchInput = $state<HTMLInputElement | null>(null);
  const topMatch = $derived(filteredGroups[0]?.items[0] ?? null);
  function onSearchKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      if (query.trim() && topMatch) {
        e.preventDefault();
        pick(topMatch);
      }
    } else if (e.key === "Escape") {
      if (query) {
        // Clear the filter first; don't also trip the app-wide Esc handlers.
        e.preventDefault();
        e.stopPropagation();
        query = "";
      } else {
        searchInput?.blur();
      }
    }
  }

  // Focus the search box on a closed→open transition so a keyboard user lands ready to
  // filter. Desktop only — on a phone this pops the soft keyboard on every open, an
  // unwanted surprise. `prev` seeds to the current state so this never fires on initial
  // mount (where the desktop sidebar starts open) and steals focus from the composer.
  let prevSidebarOpen = store.sidebarOpen;
  $effect(() => {
    const open = store.sidebarOpen;
    if (open && !prevSidebarOpen && !isPhone())
      void tick().then(() => searchInput?.focus());
    prevSidebarOpen = open;
  });

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
  // Reload a wedged session: the server throws out the warm pi session and rebuilds it
  // from disk with fresh config + extensions. The recovery move after fixing an extension
  // bug in another session. Closes the menu; the reseeded transcript arrives over the WS.
  function reloadSession(s: SessionListEntry): void {
    store.reloadSession(s.path);
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
  // immediately re-close it. While open, `a` archives/unarchives, `r` renames, and `l`
  // reloads the targeted session — unless focus is in a text field, where they should type.
  async function copyWorktreePath(s: SessionListEntry): Promise<void> {
    if (s.worktree) await store.copyToClipboard(s.worktree.path);
    closeMenu();
  }
  async function copySessionId(s: SessionListEntry): Promise<void> {
    await store.copyToClipboard(s.sessionId);
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
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
          return;
        const k = e.key.toLowerCase();
        if (k === "a" && menuSession) {
          e.preventDefault();
          toggleArchive(menuSession);
        } else if (k === "r" && menuSession) {
          e.preventDefault();
          startRename(menuSession);
        } else if (k === "l" && menuSession) {
          e.preventDefault();
          reloadSession(menuSession);
        }
      }
    };
    // Only a scroll that can move the popover's anchor closes it: something INSIDE the
    // sidebar scrolling (the session list), caught via capture since scroll doesn't bubble.
    // NOT an unrelated pane — the transcript auto-scrolling mid-stream would otherwise slam
    // the menu shut the instant you open it on a freshly-created, still-streaming session
    // (the worktree cleanup e2e flaked on exactly this). Resize always detaches it.
    const onScroll = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(".sidebar"))
        closeMenu();
    };
    const onResize = (): void => closeMenu();
    const id = setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  });

  // Build-stamp context menu (the bottom-left version text). Right-click to copy the build
  // hash or force an app update — reuses the .menu/.menu-item popover styling. A desktop
  // affordance: right-click only, so it's keyboard-reachable via the menu's own C/U hotkeys
  // once open, but there's no touch long-press (the stamp is a desktop sidebar footer).
  let buildMenuPos = $state<MenuPos | null>(null);
  let buildMenuEl = $state<HTMLDivElement | null>(null);
  let buildClamped = false;
  function openBuildMenu(e: MouseEvent): void {
    e.preventDefault();
    buildClamped = false;
    buildMenuPos = { top: e.clientY, left: e.clientX };
  }
  function closeBuildMenu(): void {
    buildMenuPos = null;
  }
  async function copyBuildHash(): Promise<void> {
    await store.copyToClipboard(buildHash);
    closeBuildMenu();
  }
  function forceUpdate(): void {
    store.requestForceUpdate();
    closeBuildMenu();
  }

  // Pull the build menu back inside the viewport once mounted: it opens at the cursor near
  // the bottom-left edge, so it almost always needs lifting up. One-shot per open (buildClamped
  // resets in openBuildMenu) so this self-write doesn't loop.
  $effect(() => {
    const el = buildMenuEl;
    if (!buildMenuPos || !el || buildClamped) return;
    const m = 8;
    const r = el.getBoundingClientRect();
    const next: MenuPos = { ...buildMenuPos };
    if (next.top + r.height > window.innerHeight - m)
      next.top = Math.max(m, window.innerHeight - m - r.height);
    if (next.left != null && next.left + r.width > window.innerWidth - m)
      next.left = Math.max(m, window.innerWidth - m - r.width);
    buildClamped = true;
    if (next.top !== buildMenuPos.top || next.left !== buildMenuPos.left)
      buildMenuPos = next;
  });

  // Dismiss the build menu on an outside click, Escape, or scroll/resize (which would
  // detach the fixed popover). The click listener is deferred so the opening interaction
  // doesn't immediately re-close it. While open, C copies the hash and U forces an update
  // (mirroring the kbd hints) — unless focus is in a text field, where they should type.
  $effect(() => {
    if (!buildMenuPos) return;
    const onClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (!t.isConnected) return;
      if (!t.closest(".menu") && !t.closest(".version")) closeBuildMenu();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        closeBuildMenu();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable
      )
        return;
      // Case-insensitive: the kbd badges show uppercase C/U, and CapsLock makes e.key
      // uppercase too — match both so the advertised shortcut never silently no-ops.
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        void copyBuildHash();
      } else if (k === "u") {
        e.preventDefault();
        forceUpdate();
      }
    };
    // Same scoping as the session menu: only a sidebar-internal scroll detaches the
    // anchored popover, not the transcript auto-scrolling in the other pane.
    const onScroll = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(".sidebar"))
        closeBuildMenu();
    };
    const onResize = (): void => closeBuildMenu();
    const id = setTimeout(() => document.addEventListener("click", onClick), 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
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

<aside
  class="sidebar"
  class:edge-drag={edgeDragging}
  data-testid="sidebar"
  data-open={store.sidebarOpen}
  style={sidebarTransform ? `transform: ${sidebarTransform}` : undefined}
>
  <div class="top">
    <IconButton
      title="Collapse sidebar (⌘B)"
      aria-label="Collapse sidebar"
      onclick={() => store.closeSidebar()}>‹</IconButton
    >
  </div>

  <div class="new">
    <button
      class="new-btn"
      title="Start a new session (⌘N) — pick the project, worktree, and model in the composer (creation is deferred until you send)"
      onclick={() => startDraft(activeCwd)}
    >
      <span class="plus">+</span> New session…
    </button>
    {#if store.lastError}
      <div class="err" role="alert">
        {store.lastError}
        <IconButton
          class="err-x"
          variant="danger"
          size="sm"
          title="Dismiss this error"
          aria-label="Dismiss"
          onclick={() => store.clearError()}>×</IconButton
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
        title="Search sessions by name, preview, or path (Enter opens the top match, Esc clears)"
        aria-label="Search sessions"
        spellcheck="false"
        autocapitalize="off"
        autocorrect="off"
        bind:this={searchInput}
        bind:value={query}
        onkeydown={onSearchKeydown}
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
        <button
          class="hidden-count"
          data-testid="hidden-count"
          title="{hiddenCount} archived or inactive session{hiddenCount === 1
            ? ''
            : 's'} hidden — click to show all"
          onclick={() => store.toggleShowArchived()}>{hiddenCount} hidden</button
        >
      {/if}
    </div>
  {/if}

  <div class="list-wrap">
  <PullIndicator snap={pull.snap} refreshing={pull.refreshing} testid="ptr-sidebar" />
  <nav
    class="list"
    use:pullToRefresh={{
      enabled: isTouch && !pull.refreshing,
      onRefresh: pull.trigger,
      onChange: pull.onChange,
    }}
  >
    {#snippet draftRow(d: (typeof pendingDrafts)[number], showTag: boolean)}
      <div class="row-line">
        <button
          class="row"
          class:active={d.active}
          data-testid="draft-row"
          title={d.active
            ? `New session in ${d.cwd || "home"} — current draft`
            : `Resume new-session draft in ${d.cwd || "home"}`}
          onclick={() => startDraft(d.cwd)}
        >
          <span class="lead">
            <span class="draft-marker" aria-label="draft">+</span>
          </span>
          <span class="name">New session</span>
          <span class="meta">
            {#if showTag}
              <span class="tag">{d.cwd ? basename(d.cwd) : "home"}</span>
            {/if}
          </span>
        </button>
        <IconButton
          class="row-menu"
          title="Discard this draft"
          aria-label="Discard this new-session draft"
          onclick={() => store.discardDraft(d.key)}>×</IconButton
        >
      </div>
    {/snippet}
    {#if topDrafts.length}
      <div class="draft-top">
        {#each topDrafts as d (d.key)}
          <div class="row-wrap">{@render draftRow(d, true)}</div>
        {/each}
      </div>
    {/if}
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
        {@const groupState = store.groupAttention(g.items.map((i) => i.sessionId))}
        <section class="group">
          <div class="group-head">
            <button
              class="group-toggle"
              title={g.cwd}
              onclick={() => toggleGroup(g.cwd)}
            >
              <span class="proj">{basename(g.cwd)}</span>
              <Chevron open={!collapsed[g.cwd]} />
              {#if collapsed[g.cwd]}
                <span class="count">{g.items.length}</span>
              {/if}
              {#if collapsed[g.cwd] && groupState}
                <span
                  class="group-attention"
                  data-state={groupState}
                  title={`${groupState} session in this project`}
                  aria-label={`${groupState} session in this project`}
                ></span>
              {/if}
            </button>
            <IconButton
              size="sm"
              title={`New session in ${g.cwd}`}
              aria-label={`New session in ${basename(g.cwd)}`}
              onclick={() => startDraft(g.cwd)}>+</IconButton
            >
          </div>
          {#if !collapsed[g.cwd]}
            <ul transition:reveal>
              {#each groupDraftsFor(g.cwd) as d (d.key)}
                <li class="row-wrap">{@render draftRow(d, false)}</li>
              {/each}
              {#each g.items as s (s.path)}
                {@const st = store.sessionStatus(s.sessionId)}
                {@const activity = store.sessionActivity(s.sessionId)}
                {@const rel = compactTime(s.updatedAt, now)}
                {@const relLong = relativeTime(s.updatedAt, now)}
                {@const idle = st === "read" || st === "unread"}
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
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          title="Cancel rename (Esc)"
                          onclick={cancelRename}>Cancel</Button
                        >
                        <Button
                          variant="primary"
                          size="sm"
                          type="submit"
                          title="Save the new session name (Enter)"
                          disabled={!renameValue.trim()}>Save</Button
                        >
                      </div>
                    </form>
                  {:else}
                  <div class="row-line">
                    <button
                      class="row"
                      class:active={s.sessionId === store.activeSessionId}
                      title={activity
                        ? `${s.displayName || s.preview || "Session"} — ${activity}`
                        : `Open ${s.displayName || s.preview || "session"}`}
                      onclick={() => pick(s)}
                      oncontextmenu={(e) => openMenu(e, s.path)}
                    >
                      <!-- Leading gutter: the session indent, and the home of the row's
                           standing markers. Unread (a new-activity dot) takes priority;
                           otherwise a session over the context-fill threshold shows its
                           gauge ring. Empty (but reserved) when neither, so titles align. -->
                      <span class="lead">
                        {#if st === "unread"}
                          <i
                            class="unread-dot"
                            title="Unread — new activity since you last looked"
                            aria-label="unread"
                          ></i>
                        {:else if s.usage && s.usage.percent !== null && s.usage.percent >= RING_THRESHOLD}
                          <ContextRing
                            usage={s.usage}
                            size={12}
                            showLabel={false}
                          />
                        {/if}
                      </span>
                      <span
                        class="name"
                        data-tip-single
                        title={s.displayName ?? (s.preview ? s.preview.split('\n')[0] : '(untitled)')}
                        >{s.displayName || s.preview || "(untitled)"}</span
                      >
                      <span class="meta">
                        {#if s.archived}
                          <span class="tag">archived</span>
                        {/if}
                        {#if s.worktree && !s.worktree.reaped}
                          <span
                            class="wt"
                            title={`Worktree: ${s.worktree.path}`}
                            aria-label="worktree"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              width="12"
                              height="12"
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
                          </span>
                        {/if}
                        <!-- Unified right-edge slot: attention badge, in-progress spinner,
                             or — when idle/read/unread — the last-activity timestamp. The
                             unread cue itself lives in the left gutter, so an unread row
                             keeps its timestamp here. One slot, so the title gets the width. -->
                        <span
                          class="status"
                          data-state={st}
                          data-testid="session-status"
                          title={st === "initializing"
                            ? "initializing — warming up"
                            : (activity ??
                              (idle && relLong ? `Last activity ${relLong}` : st))}
                          aria-label={idle
                            ? `last activity ${relLong || "unknown"}`
                            : `status: ${st}`}
                        >
                          {#if st === "waiting"}
                            <i class="attention-symbol">!</i>
                          {:else if st === "failed"}
                            <i class="attention-symbol">×</i>
                          {:else if st === "running" || st === "initializing"}
                            <i class="spinner"></i>
                          {:else if st === "done"}
                            <i class="attention-symbol">✓</i>
                          {:else if rel}
                            <span class="time">{rel}</span>
                          {/if}
                        </span>
                      </span>
                    </button>
                    <IconButton
                      class="row-menu"
                      data-testid="session-menu"
                      title="Session actions"
                      aria-label={`Actions for ${s.displayName || s.preview || "session"}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === s.path}
                      onclick={(e) => toggleMenu(e, s.path)}>⋯</IconButton
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

  <!-- Session actions menu. Rendered ONCE (outside the {#each sessions} list) and keyed
       on `menuFor` (the stable user-intent signal), NOT on `menuSession`: that lookup is
       $derived from store.sessions.find(...), and when the server pushes a new session list
       (every sessionList / attention / live-count tick) the derived re-runs and can briefly
       resolve to null mid-update — keying the menu's mount on it unmounts+remounts the
       DOM, detaching buttons mid-click-action (the worktree cleanup tests hit this
       deterministically: "element was detached from the DOM, retrying" → 30s timeout).
       `menuFor` only changes on explicit open/close, so the menu stays mounted across
       list pushes. Position is `fixed` (viewport-relative), so lifting it out of the
       row's DOM tree doesn't change where it appears. -->
  {#if menuFor && menuPos}
    <div
      class="menu"
      role="menu"
      bind:this={menuEl}
      style={`top:${menuPos.top}px;${menuPos.left != null ? `left:${menuPos.left}px` : `right:${menuPos.right}px`}`}
    >
      {#if menuSession}
        {#if menuSession.worktree && !menuSession.worktree.reaped}
          <button
            class="menu-item"
            role="menuitem"
            title={`Copy the worktree path to the clipboard: ${menuSession.worktree.path}`}
            onclick={() => copyWorktreePath(menuSession)}
            >Copy worktree path</button
          >
          {#if confirmCleanup === menuSession.path}
            <button
              class="menu-item danger"
              role="menuitem"
              data-testid="confirm-cleanup-worktree"
              title="Permanently remove the worktree from disk — discards any uncommitted changes"
              onclick={() => cleanupWorktree(menuSession)}
              >Confirm: delete worktree</button
            >
          {:else}
            <button
              class="menu-item"
              role="menuitem"
              data-testid="cleanup-worktree"
              title="Remove this worktree from disk, freeing the isolated copy (asks to confirm)"
              onclick={() => (confirmCleanup = menuSession.path)}
              >Clean up worktree…</button
            >
          {/if}
        {/if}
        <button
          class="menu-item"
          role="menuitem"
          data-testid="copy-session-id"
          title={`Copy the pi session id to the clipboard: ${menuSession.sessionId}`}
          onclick={() => copySessionId(menuSession)}
          >Copy session ID</button
        >
        <button
          class="menu-item"
          role="menuitem"
          title="Rename this session (R)"
          onclick={() => startRename(menuSession)}>
          <span>Rename</span>
          <kbd class="hotkey" aria-hidden="true">R</kbd>
        </button
        >
        <button
          class="menu-item"
          role="menuitem"
          data-testid="reload-session"
          title="Reload pi context from scratch (config + extensions reloaded) and restore the transcript — recovery for a session a buggy extension wedged (L)"
          onclick={() => reloadSession(menuSession)}>
          <span>Reload pi session</span>
          <kbd class="hotkey" aria-hidden="true">L</kbd>
        </button>
        <button
          class="menu-item"
          role="menuitem"
          title={menuSession.archived
            ? "Restore this session to the active list (A)"
            : "Hide this session from the active list (A)"}
          onclick={() => toggleArchive(menuSession)}
        >
          <span>{menuSession.archived ? "Unarchive" : "Archive"}</span>
          <kbd class="hotkey" aria-hidden="true">A</kbd>
        </button>
      {/if}
    </div>
  {/if}
  </div>

  <!-- Desktop auto-update card: shown when a new origin/main is staged but deferred
       because we're connected (server pushes `updateStatus`). One action, no dismiss —
       leave it sitting until you choose to apply. Distinct from the PWA refresh toast. -->
  {#if store.appUpdate}
    <div class="app-update" data-testid="update-card">
      <span class="app-update-label">Update available</span>
      <Button
        variant="primary"
        size="sm"
        title="Pull the latest main, rebuild, and restart Pilot"
        disabled={store.appUpdate.applying}
        onclick={() => store.requestAppUpdate()}
      >
        {store.appUpdate.applying ? "Updating…" : "Update now"}
      </Button>
    </div>
  {/if}

  <!-- Build stamp: last commit hash + date, baked in at build time. Quiet footer so
       you can tell which version is live without it competing with the session list.
       Right-click for build actions (copy hash / force-update). -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="version"
    class:stale={store.desktopStale}
    data-testid="version"
    title={(buildDate
      ? `pilot build ${buildHash} · committed ${buildDate}`
      : `pilot build ${buildHash}`) +
      (store.desktopStale
        ? " — app shell changed; quit Pilot and run desktop/build-app.sh to rebuild"
        : " — right-click for build actions")}
    oncontextmenu={openBuildMenu}
  >
    {#if store.desktopStale}
      <!-- Durable "this binary is stale" dot: the running Pilot.app's native shell differs
           from the checked-out desktop/ source, so the .app needs a manual build-app.sh
           rebuild (the TS auto-update can't replace the bundle). Informational only — the
           rebuild happens in a shell, not here. -->
      <span
        class="stale-dot"
        data-testid="desktop-stale-dot"
        title="The Pilot.app shell is out of date with its source. Quit Pilot and run desktop/build-app.sh in the clone to rebuild."
        aria-label="App shell out of date — rebuild needed"
      ></span>
    {/if}
    {buildLabel}
  </div>
  {#if buildMenuPos}
    <div
      class="menu"
      role="menu"
      data-testid="build-menu"
      bind:this={buildMenuEl}
      style={`top:${buildMenuPos.top}px;${buildMenuPos.left != null ? `left:${buildMenuPos.left}px` : `right:${buildMenuPos.right}px`}`}
    >
      <button
        class="menu-item"
        role="menuitem"
        data-testid="copy-build-hash"
        title={`Copy the build commit hash to the clipboard: ${buildHash}`}
        onclick={copyBuildHash}
      >
        <span>Copy build hash</span>
        <kbd class="hotkey" aria-hidden="true">C</kbd>
      </button>
      <button
        class="menu-item"
        role="menuitem"
        data-testid="force-update"
        title="Force the app to pull the latest main, rebuild, and restart now — for clicking right after a push"
        onclick={forceUpdate}
      >
        <span>Force-update</span>
        <kbd class="hotkey" aria-hidden="true">U</kbd>
      </button>
    </div>
  {/if}
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 288px;
    flex-shrink: 0;
    height: 100%;
    height: 100dvh;
    background: var(--sidebar-bg);
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
    /* No brand wordmark — leave the top-left clear for the macOS traffic
       lights and keep the collapse control on the right. */
    justify-content: flex-end;
    padding: 12px 14px 10px;
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
  /* IconButton owns the look; this only nudges it to the row's end (it's a child
     component root, so the rule has to pierce the scope boundary). */
  .err :global(.err-x) {
    margin-left: auto;
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
    background: none;
    border: 0;
    padding: 2px 4px;
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  .hidden-count:hover {
    color: var(--text-muted);
  }
  .hidden-count:focus-visible {
    outline: none;
    color: var(--text);
    border-radius: var(--radius-xs);
    box-shadow: 0 0 0 1.5px var(--accent);
  }

  .list-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 6px 14px 2px;
  }
  /* Quiet build stamp pinned at the bottom of the sidebar. */
  .app-update {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0 10px 8px;
    padding: 8px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .app-update-label {
    font-size: 12px;
    color: var(--text);
    white-space: nowrap;
  }
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
  /* When the running .app is stale, lift the stamp out of the faint footer color so the
     amber dot beside it reads as a real signal rather than disabled chrome. */
  .version.stale {
    color: var(--text-muted);
  }
  .stale-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--warning);
    vertical-align: middle;
    /* nudge up a hair so it optically centers on the lowercase mono stamp */
    margin-bottom: 1px;
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
    /* Flush left: the project title anchors the very edge; the small right pad just
       keeps the + button off the scrollbar. */
    padding: 0 4px 0 0;
  }
  .group-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 7px 4px;
    color: var(--text-muted);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  /* Collapse/expand chevron (shared <Chevron>) — sits just to the right of the project
     name (codex-style), faint at rest, brightening when the group head is hovered/focused. */
  .group-head:hover :global(.chevron),
  .group-toggle:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  /* Highest-priority state beside a collapsed project. */
  .group-attention {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .group-attention[data-state="running"] {
    animation: dotPulse 1.1s ease-in-out infinite;
  }
  .group-attention[data-state="waiting"] {
    width: 8px;
    height: 8px;
    background: var(--warning);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 18%, transparent);
  }
  .group-attention[data-state="failed"] {
    background: var(--danger);
  }
  .group-attention[data-state="done"] {
    background: var(--unread);
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
    /* Collapsed-only badge: pushed to the right end of the toggle, away from the
       left-anchored project name + chevron. */
    margin-left: auto;
    color: var(--text-faint);
    font-size: 11px;
  }
  ul {
    list-style: none;
    /* No list indent — each row's leading gutter (.lead) supplies the nesting offset, so
       the project title stays flush left while session titles sit slightly inset. */
    margin: 0 0 2px;
    padding: 0;
  }
  /* A row plus its overflow (⋯) trigger. The ⋯ overlays the row's right edge on hover
     rather than reserving a column, so the title keeps the full width. */
  .row-line {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 0;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 8px 6px 4px;
  }
  .row:hover {
    background: var(--surface);
  }
  .row.active {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  /* Leading gutter: the session indent, and the home of the row's standing markers —
     the unread dot (priority) or the high-context ring. Empty (but reserved) otherwise,
     so titles align. */
  .lead {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    flex-shrink: 0;
  }
  /* Unread — a filled amber dot at the row's head, flagging new activity since you last
     looked (the timestamp stays in the right slot). */
  .lead .unread-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--unread);
  }
  /* Overflow (⋯) trigger (IconButton): absolutely pinned to the row's right edge, hidden
     until the row is hovered (or the menu is open). It floats ON TOP of the status/time
     slot — which fades out on hover — so nothing shifts and the title keeps its width.
     Always shown on touch (mobile block below). :global pierces onto the component root. */
  :global(.row-menu) {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 2;
    opacity: 0;
    transition: opacity 0.1s ease;
  }
  .row-wrap:hover :global(.row-menu),
  :global(.row-menu[aria-expanded="true"]) {
    opacity: 1;
  }
  /* When the menu is open without a hover, give the ⋯ a backdrop so it masks the
     timestamp it sits over (on hover the slot is already faded out below). */
  :global(.row-menu[aria-expanded="true"]) {
    background: var(--surface);
  }
  /* Only the status/time slot yields to the ⋯ overlay on hover — the worktree glyph (and
     any tag) stay put so they remain visible and hoverable while the menu trigger shows. */
  .row-wrap:hover .status {
    opacity: 0;
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
  /* Unified status/time slot at the row's right edge: an attention badge, the in-progress
     spinner, the unread dot, or — at rest — the last-activity timestamp. One at a time, so
     the title gets the rest of the row. Sizes to content (the timestamp is the widest). */
  .status {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    min-width: 14px;
    flex-shrink: 0;
    transition: opacity 0.1s ease;
  }
  .status .attention-symbol {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    font-size: 10px;
    font-style: normal;
    font-weight: 750;
    line-height: 1;
  }
  .status[data-state="waiting"] .attention-symbol {
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  }
  .status[data-state="failed"] .attention-symbol {
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 38%, transparent);
  }
  /* done — a finished-while-away run. A check badge in the accent reads "ready for
     you", a clear step up from plain unread's neutral dot (which it used to share). */
  .status[data-state="done"] .attention-symbol {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  }
  /* Top-level draft rows — pending new sessions whose cwd isn't a known project yet,
     pinned above the project groups. Project-targeted drafts nest inside their group's
     <ul> instead and need no wrapper. Each draft row reuses .row + .row.active; only the
     leading marker is custom. */
  .draft-top {
    margin-bottom: 6px;
    padding: 0 6px;
  }
  .draft-marker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    line-height: 1;
  }
  /* in-progress — a small rotating ring in the timestamp slot, for both a warming-up
     session and a live turn. Same glyph for both phases; the tooltip carries the detail. */
  .status[data-state="running"] .spinner,
  .status[data-state="initializing"] .spinner {
    width: 11px;
    height: 11px;
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
    .group-attention[data-state="running"] {
      animation: none;
      opacity: 0.7;
    }
    .status[data-state="running"] .spinner,
    .status[data-state="initializing"] .spinner {
      animation: none;
    }
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    line-height: 1.3;
    letter-spacing: -0.006em;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.active .name {
    color: var(--accent);
    font-weight: 600;
  }
  /* Right-edge cluster: worktree glyph, optional tag, and the status/time slot. Shrinks
     to its content so the title takes the rest of the line. */
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  /* Last-activity timestamp ("2d"), the resting state of the status slot. */
  .time {
    flex-shrink: 0;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  /* Faint label chip — the "archived" marker and the draft row's target dir. */
  .tag {
    flex-shrink: 0;
    max-width: 96px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
  }
  /* Worktree marker — a compact tinted git-branch glyph (the title carries the full
     path; aria-label names it for screen readers). */
  .wt {
    display: inline-flex;
    align-items: center;
    color: var(--accent);
    cursor: help;
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
    /* While a left-edge swipe is in flight, the component sets an inline translateX that
       follows the finger. Disable the open/close transition so the follow is frame-accurate
       (the transform snaps to rest via the transition the moment the drag ends). */
    .sidebar.edge-drag {
      transition: none;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 55;
      background: rgba(0, 0, 0, 0.34);
      border: none;
    }
    /* No hover on touch — keep the ⋯ trigger in the flow (a reserved column rather than
       a hover overlay) and always visible, so the timestamp stays readable beside it. */
    :global(.row-menu) {
      position: static;
      transform: none;
      opacity: 1;
    }
  }
</style>
