<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { sessionSubtitle } from "../lib/session-subtitle.js";
  import GoalBadge from "./GoalBadge.svelte";
  import IconButton from "./ui/IconButton.svelte";

  let hotkeyN = $state(0);

  function onWindowKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !e.shiftKey) return;
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      store.hotkeyAction = { which: "model", n: ++hotkeyN };
    } else if (e.key === "e" || e.key === "E") {
      // ⌘⇧E — thinking/effort level. (T was freed up for the tree, below.)
      e.preventDefault();
      store.hotkeyAction = { which: "thinking", n: ++hotkeyN };
    } else if (e.key === "t" || e.key === "T") {
      // ⌘⇧T — the session tree (/tree).
      e.preventDefault();
      store.toggleTree();
    }
  }

  const conn = $derived(store.connection);
  const s = $derived(store.session);
  const statuses = $derived(Object.entries(s.ambient.statuses));
  // A just-submitted new session, warming up server-side before its first snapshot. The
  // session slot was reset to empty on submit, so without special-casing this the header
  // would flash "pilot" / "no session" until the snapshot lands. Treat it like the draft.
  const creating = $derived(store.creatingSession !== null);
  // The focused session is warming up (created/opened, pre-stream) — show a small
  // spinner beside the title. Also during a deferred new session's creation gap.
  const initializing = $derived(
    creating || (!store.draft && s.status === "initializing"),
  );

  // While drafting a new session there's no folded session yet — the header reflects
  // the draft so it doesn't read as the (now-backgrounded) previously-active one.
  const drafting = $derived(store.draft != null);
  const draftDir = $derived.by(() => {
    const c = store.draft?.cwd?.replace(/\/+$/, "") ?? "";
    return c ? (c.split("/").pop() ?? c) : "";
  });

  // The active session's title (folded snapshot is authoritative; ambient title wins).
  const title = $derived(
    drafting || creating
      ? "New session"
      : s.ambient.title || s.title || "pilot",
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

  const push = $derived(store.pushState);
  const pushLabel: Record<string, string> = {
    working: "…",
    idle: "Notify",
    subscribed: "Notify on",
    denied: "Blocked",
    "needs-install": "Install",
    error: "Retry",
    unsupported: "",
  };
  const pushTitle: Record<string, string> = {
    working: "Subscribing…",
    idle: "Enable push notifications on this device",
    subscribed: "Push on — tap to re-check / re-subscribe",
    denied: "Notifications are blocked — enable them in your browser/iOS settings",
    "needs-install":
      "On iOS, Add to Home Screen first, then open the app from there and tap again",
    error: "Couldn't subscribe — tap to retry (see console for details)",
    unsupported: "",
  };

  const connLabel: Record<string, string> = {
    connected: "live",
    connecting: "connecting…",
    reconnecting: "reconnecting…",
    disconnected: "offline",
  };
</script>

<svelte:window onkeydown={onWindowKeydown} />
<header class="hdr">
  <IconButton
    data-testid="sidebar-toggle"
    title="Toggle sessions (⌘B)"
    aria-label="Toggle sessions"
    onclick={() => store.toggleSidebar()}
  >
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  </IconButton>
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
      {#if s.goal}
        <span class="dot-sep">·</span>
        <GoalBadge />
      {/if}
      {#each statuses as [key, text] (key)}
        <span class="dot-sep">·</span>
        <span class="amb">{text}</span>
      {/each}
    </div>
  </div>

  <div class="right">
    {#if push !== "unsupported"}
      <button
        class="bell {push}"
        title={pushTitle[push]}
        disabled={push === "working"}
        onclick={() => store.enablePush()}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span class="bell-label">{pushLabel[push]}</span>
      </button>
    {/if}
    {#if s.activePlan}
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
    <IconButton
      data-testid="tree-toggle"
      title="Session tree — branches & jump (⌘⇧T or /tree)"
      aria-label="Session tree"
      onclick={() => store.toggleTree()}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="6" cy="5" r="2.2" />
        <circle cx="6" cy="19" r="2.2" />
        <circle cx="18" cy="9" r="2.2" />
        <path d="M6 7.2v9.6" />
        <path d="M18 11.2v.6a4 4 0 0 1-4 4H6" />
      </svg>
    </IconButton>
    <IconButton
      data-testid="settings-toggle"
      title="Settings (⌘,)"
      aria-label="Settings"
      onclick={() => store.openSettings()}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </IconButton>
    <span class="conn {conn}" title={conn}>
      <span class="led"></span><span class="conn-label">{connLabel[conn]}</span>
    </span>
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
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
    position: sticky;
    top: 0;
    z-index: 10;
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
  }
  .title {
    display: block;
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
  .right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
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
  /* On a phone the header gets crowded (sidebar toggle + title + bell + model +
     thinking + gear + connection). Drop the text labels whose icon/LED already
     conveys their state, so the row fits the viewport instead of overflowing
     horizontally (which also shifts fixed overlays like the approval sheet). */
  @media (max-width: 480px) {
    .right {
      gap: 8px;
    }
    .bell {
      padding: 4px 7px;
    }
    .bell-label,
    .conn-label {
      display: none;
    }
  }
</style>
