<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import ModelPicker from "./ModelPicker.svelte";

  let hotkeyN = $state(0);

  function onWindowKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !e.shiftKey) return;
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      store.hotkeyAction = { which: "model", n: ++hotkeyN };
    } else if (e.key === "e" || e.key === "E" || e.key === "t" || e.key === "T") {
      e.preventDefault();
      store.hotkeyAction = { which: "thinking", n: ++hotkeyN };
    }
  }

  const conn = $derived(store.connection);
  const s = $derived(store.session);
  const statuses = $derived(Object.entries(s.ambient.statuses));

  // The active session's title (folded snapshot is authoritative; ambient title wins).
  const title = $derived(s.ambient.title || s.title || "pilot");

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
  <button
    class="menu"
    data-testid="sidebar-toggle"
    title="Toggle sessions"
    aria-label="Toggle sessions"
    onclick={() => store.toggleSidebar()}
  >
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  </button>
  <div class="left">
    <span class="title">{title}</span>
    <div class="sub">
      <span class="path">{s.ref?.workspaceId ? "pilot" : "no session"}</span>
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
    {#if store.streaming}
      <span class="working"><span class="pulse"></span>working</span>
    {/if}
    <ModelPicker />
    <button
      class="gear"
      data-testid="settings-toggle"
      title="Settings (⌘,)"
      aria-label="Settings"
      onclick={() => store.openSettings()}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
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
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
  }
  .menu:hover {
    background: var(--surface-sunken);
    border-color: var(--border);
    color: var(--text);
  }
  .left {
    min-width: 0;
    flex: 1;
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
  .gear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    cursor: pointer;
  }
  .gear:hover {
    background: var(--surface-sunken);
    border-color: var(--border);
    color: var(--text);
  }
  .working {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--accent);
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.1s ease-in-out infinite;
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
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }
</style>
