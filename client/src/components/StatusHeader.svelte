<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { sessionSubtitle } from "../lib/session-subtitle.js";
  import { imageViewer } from "../lib/image-viewer.svelte.js";
  import GoalBadge from "./GoalBadge.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import SidebarPanelIcon from "./ui/SidebarPanelIcon.svelte";
  import type { HostCoordinator } from "../lib/hosts.svelte.js";

  const { coordinator }: { coordinator: HostCoordinator } = $props();
  let hotkeyN = $state(0);

  function onWindowKeydown(e: KeyboardEvent) {
    // While a user-driven modal owns the keyboard (Settings, PlanView, ImageLightbox),
    // suppress ⌘⇧M (model picker) and ⌘⇧J (context panel) — they'd open/toggle invisibly
    // behind the scrim. Mirrors the guard ⌘K/⌘\ use in App.svelte.
    if (
      store.settingsOpen ||
      store.planViewOpen ||
      imageViewer.index !== null
    )
      return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !e.shiftKey) return;
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      store.hotkeyAction = { n: ++hotkeyN };
    } else if (e.key === "j" || e.key === "J") {
      // ⌘⇧J — the right context panel (todos, jobs, flagged files). Inert while
      // drafting: the panel shows the ACTIVE session's context and is unmounted
      // in the draft view, so a toggle here would only flip persisted state
      // invisibly (and surprise you when the draft closes).
      if (store.draft) return;
      e.preventDefault();
      store.toggleRightSidebar();
    }
  }

  const conn = $derived(store.connection);
  const s = $derived(store.session);
  const statuses = $derived(Object.entries(s.ambient.statuses));
  // A just-submitted new session, warming up server-side before its first snapshot. The
  // session slot was reset to empty on submit, so without special-casing this the header
  // would flash "pantoken" / "no session" until the snapshot lands. Treat it like the draft.
  const creating = $derived(store.creatingSession !== null);
  // An existing-session switch whose seed hasn't landed yet — show the target's
  // title immediately instead of the prior session's.
  const opening = $derived(store.openingSession !== null);
  // The focused session is warming up (created/opened, pre-stream) — show a small
  // spinner beside the title. Also during a deferred new session's creation gap.
  const initializing = $derived(
    creating || opening || (!store.draft && s.status === "initializing"),
  );

  // While drafting a new session there's no folded session yet — the header reflects
  // the draft so it doesn't read as the (now-backgrounded) previously-active one.
  const drafting = $derived(store.draft != null);
  const draftDir = $derived.by(() => {
    const c = store.draft?.cwd?.replace(/\/+$/, "") ?? "";
    return c ? (c.split("/").pop() ?? c) : "";
  });

  // The active session's title (folded snapshot is authoritative; ambient title wins).
  // During an opening-session switch, show a neutral label — the list entry's
  // displayName/preview can differ from the seed's title and would flicker.
  const title = $derived(
    drafting || creating
      ? "New session"
      : opening
        ? "Opening session"
        : s.ambient.title || s.title || "pantoken",
  );

  // The "where am I" subtitle. The folded snapshot carries no cwd/worktree, so we
  // read the active session's list entry (same lookup the sidebar uses) — its cwd
  // is the project, its worktree.base the parent repo for worktree sessions.
  const entry = $derived(
    store.sessions.find((e) => e.sessionId === s.ref?.sessionId),
  );
  const subtitle = $derived(
    drafting
      ? draftDir || "new session"
      : creating
        ? "starting…"
        : opening
          ? "opening…"
          : sessionSubtitle({ cwd: entry?.cwd, worktreeBase: entry?.worktree?.base }),
  );
  // Hover reveals the full path(s) the basename(s) elide.
  const subtitleTitle = $derived(
    drafting || !entry?.cwd
      ? undefined
      : entry.worktree
        ? `Worktree ${entry.cwd} (of ${entry.worktree.base})`
        : entry.cwd,
  );
  const selectedHost = $derived(
    coordinator.multiHostCapable
      ? coordinator.summaries.find((summary) => summary.selected)
      : undefined,
  );
  const hostIdentity = $derived(selectedHost?.descriptor.label ?? "");

  const push = $derived(store.pushState);
  const pushTitle: Record<string, string> = {
    denied: "Notifications are blocked — enable them in your browser/iOS settings",
    error: "Couldn't subscribe — tap to retry (see console for details)",
  };

  const connLabel: Record<string, string> = {
    connected: "live",
    connecting: "connecting…",
    reconnecting: "reconnecting…",
    disconnected: "offline",
  };

  // Total items behind the context entry (flagged files + jobs + todos) — the
  // phone shows it as a count bubble on the entry button. Plain totals by design:
  // no unseen/unread tracking (see docs/PLAN-mobile.md D3); approvals are
  // deliberately not counted here (they surface in the transcript + bell).
  const contextCount = $derived(
    s.flags.length + store.jobs.length + s.todos.length,
  );
</script>

<svelte:window onkeydown={onWindowKeydown} />
<!-- data-tauri-drag-region="deep": Tauri v2 only treats an element as a drag surface
     when the mousedown TARGET itself carries the attribute (or is inside a "deep"-tagged
     ancestor) — a bare attribute on just <header> never fires for clicks on its children
     (the title, subtitle, spacer…), which is nearly the whole header. "deep" extends the
     drag surface to the entire subtree while still respecting Tauri's own built-in
     clickable-element exclusion (real <button>/<a>/<input>… without their own override
     always block dragging first) — the bell/plan/settings/etc. IconButtons stay clickable
     with no per-element opt-out needed. This ALSO needs an IPC grant to actually fire:
     this page is served over http://127.0.0.1:<port>, not the tauri:// asset protocol,
     so it gets no Tauri IPC by default (see desktop/capabilities/default.json) — the
     start_dragging command is explicitly re-granted to this origin in
     desktop/capabilities/window-drag.json. -->
<header class="hdr" data-tauri-drag-region="deep">
  <!-- Reopen the collapsed sessions sidebar, from the header's leading edge — the top-left
       corner the sidebar occupied. Unlike the context panel's toggle this can't land on the
       exact pixel of the control that collapsed it: the sidebar keeps its own collapse
       toggle at its trailing edge (its top-left is reserved for the macOS traffic lights),
       ~200px right of here. Same top row, though, so it's still a click-back-and-forth. -->
  {#if !store.sidebarOpen}
    <div class="sidebar-open-wrap">
      <IconButton
        class="sidebar-open"
        data-testid="sidebar-open"
        title="Show sessions (⌘B)"
        aria-label="Show sessions"
        onclick={() => store.openSidebar()}
      >
        <SidebarPanelIcon side="left" />
        <span class="sidebar-open-label">Show sessions</span>
      </IconButton>
      {#if store.sidebarNoticeCount > 0}
        <span
          class="notice-badge"
          data-testid="sidebar-notice-badge"
          aria-label="{store.sidebarNoticeCount} unread notification{store.sidebarNoticeCount === 1 ? '' : 's'} in sidebar"
        >{store.sidebarNoticeCount}</span>
      {/if}
    </div>
  {/if}
  <div class="left">
    <span class="title-row">
      {#if initializing}
        <span
          class="init-spinner"
          data-testid="header-initializing"
          title="Session initializing — warming up"
          aria-label="session initializing"
        ></span>
      {/if}
      <span class="title">{title}</span>
    </span>
    <div class="sub">
      <span class="path" title={subtitleTitle}>{subtitle}</span>
      {#if selectedHost}
        <span class="dot-sep host-sep">·</span>
        <span class="host-identity" data-testid="header-host-identity" title={selectedHost.descriptor.subtitle || "This computer"}>
          pantoken · {hostIdentity}
        </span>
      {/if}
      {#if !drafting && s.goal}
        <span class="dot-sep">·</span>
        <GoalBadge />
      {/if}
      {#if !drafting}
        {#each statuses as [key, text] (key)}
          <span class="dot-sep">·</span>
          <span class="amb">{text}</span>
        {/each}
      {/if}
    </div>
  </div>

  <div class="right">
    <!-- Healthy/unconfigured notification state is deliberately silent. A blocked or
         failed subscription remains visible and actionable; complete status and setup
         controls live in Settings. -->
    {#if push === "denied" || push === "error"}
      <button
        class="bell {push}"
        title={pushTitle[push]}
        aria-label={push === "denied" ? "Notifications blocked" : "Retry notifications"}
        onclick={() => store.enablePush()}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span class="bell-label">{push === "denied" ? "Blocked" : "Retry"}</span>
      </button>
    {/if}
    {#if s.activePlan && !drafting}
      <IconButton
        data-testid="plan-view-toggle"
        title="View the active plan (⌘P)"
        aria-label="View the active plan"
        onclick={() => store.togglePlanView()}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </IconButton>
    {/if}
    {#if conn !== "connected"}
    <span class="conn {conn}" role="status">
      <span class="led"></span><span class="conn-label">{connLabel[conn]}</span>
    </span>
    {/if}
    <!-- Reopen the collapsed context panel. Lives flush at the header's trailing
         edge — i.e. exactly where the panel's own collapse control sits once it's
         open — so collapse/expand is the same pixel, clickable back and forth.
         Hidden while drafting: the panel itself is unmounted there. The
         panel-right icon faces the panel it summons. -->
    {#if !store.rightSidebarOpen && !drafting}
      <IconButton
        class="context-entry"
        data-testid="context-open"
        data-context-count={contextCount}
        title="Show context panel (⌘⇧J)"
        aria-label="Show context panel"
        onclick={() => store.openRightSidebar()}
      >
        <!-- Desktop: the trailing-edge panel icon, same pixel as the panel's collapse
             control. Phone: a panel glyph + count bubble — the badge is the whole
             point of the entry. CSS swaps them on the 859px breakpoint. -->
        <span class="chevron-desktop"><SidebarPanelIcon side="right" /></span>
        <span class="ctx-glyph">
          <SidebarPanelIcon side="right" />
          {#if contextCount > 0}
            <span class="ctx-badge" data-testid="context-badge">{contextCount}</span>
          {/if}
        </span>
      </IconButton>
    {/if}
  </div>
</header>

<style>
  .hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    /* Clear the notch/status bar in PWA standalone (viewport-fit=cover). The top inset is
       0 in a normal browser tab, so this is a no-op there. */
    padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
    /* Pinned (not content-sized) so the context panel's top bar can match it. */
    min-height: calc(var(--header-h) + env(safe-area-inset-top));
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
    position: sticky;
    top: 0;
    /* Keep the header controls above mobile drawer scrims so either drawer can be
       opened while the other one remains visible. The drawers themselves use z 60. */
    z-index: 70;
  }
  .sidebar-open {
    margin-left: var(--shell-leading-inset);
    gap: 6px;
  }
  .sidebar-open-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .notice-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    pointer-events: none;
  }
  .sidebar-open-label {
    display: none;
  }
  .left {
    min-width: 0;
    flex: 1;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    overflow: hidden;
  }
  .title {
    display: block;
    min-width: 0;
    font-weight: 600;
    font-size: 14.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A small rotating ring beside the title while the focused session warms up. */
  .init-spinner {
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1.6px solid var(--border-strong);
    border-top-color: var(--accent);
    animation: hdrSpin 0.7s linear infinite;
  }
  @keyframes hdrSpin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .init-spinner {
      animation: none;
    }
  }
  .sub {
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot-sep {
    color: var(--text-faint);
  }
  .host-identity {
    color: var(--text-muted);
    font-weight: 600;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .chevron-desktop {
    display: inline-flex;
  }
  /* Context entry: panel icon on desktop (no badge), panel glyph + count bubble on phone. */
  .ctx-glyph {
    display: none;
    position: relative;
  }
  .ctx-badge {
    position: absolute;
    top: -7px;
    right: -9px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 650;
    line-height: 1;
    color: var(--accent-text);
    background: var(--accent);
    border-radius: 999px;
    pointer-events: none;
  }
  @media (max-width: 859px) {
    .hdr {
      gap: 4px;
      padding: calc(2px + env(safe-area-inset-top)) 8px 2px;
      min-height: calc(48px + env(safe-area-inset-top));
    }
    .sub {
      display: none;
    }
    .sidebar-open {
      width: 44px;
      min-width: 44px;
      height: 44px;
      min-height: 44px;
      margin-left: 0;
    }
    .bell {
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
    }
    .chevron-desktop {
      display: none;
    }
    .ctx-glyph {
      display: inline-flex;
    }
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .led {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .conn.connected .led {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
  }
  .conn.reconnecting .led,
  .conn.connecting .led {
    background: var(--warning);
  }
  .conn.disconnected .led {
    background: var(--danger);
  }
  .bell {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 9px 3px 8px;
    cursor: pointer;
  }
  .bell:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .bell.subscribed {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 40%, var(--border));
  }
  .bell.denied {
    color: var(--danger);
  }
  .bell.needs-install,
  .bell.error {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
  }
  @media (max-width: 480px) {
    .right {
      gap: 8px;
    }
    .bell {
      padding: 4px 7px;
    }
    .bell-label {
      display: none;
    }
  }
</style>
