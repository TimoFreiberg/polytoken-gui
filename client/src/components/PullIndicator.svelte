<script lang="ts">
  import type { PullSnapshot } from "../lib/pull-to-refresh.js";

  let {
    snap,
    refreshing = false,
    testid,
  }: {
    snap: PullSnapshot;
    refreshing?: boolean;
    testid?: string;
  } = $props();

  // Where the badge rests while the refresh runs (just below the top edge).
  const REST = 48;
  const y = $derived(refreshing ? REST : snap.distance);
  const shown = $derived(refreshing || snap.distance > 0);
  const opacity = $derived(refreshing ? 1 : Math.min(snap.progress * 1.25, 1));
  // Arrow points down while pulling, flips up ("release to refresh") once armed.
  const rot = $derived(snap.phase === "armed" ? 180 : snap.progress * 180);
  const armed = $derived(refreshing || snap.phase === "armed");
  const label = $derived(
    refreshing
      ? "Refreshing…"
      : snap.phase === "armed"
        ? "Release to refresh"
        : "Pull to refresh",
  );
</script>

{#if shown}
  <div
    class="ptr"
    class:refreshing
    class:armed
    data-testid={testid}
    data-phase={refreshing ? "refreshing" : snap.phase}
    style="transform: translate(-50%, {y}px); opacity: {opacity};"
    role="status"
    aria-live="polite"
    title={label}
  >
    <span class="badge" class:spin={refreshing}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {#if refreshing}
          <path
            d="M21 12a9 9 0 1 1-6.22-8.56"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
          />
        {:else}
          <g style="transform: rotate({rot}deg); transform-origin: 12px 12px;">
            <path
              d="M12 5v13M6 12l6 6 6-6"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </g>
        {/if}
      </svg>
    </span>
    <span class="sr-only">{label}</span>
  </div>
{/if}

<style>
  .ptr {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 6;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* Fade tracks the drag instantly; the settle-back when refreshing eases. */
    transition: opacity 120ms ease;
  }
  .ptr.refreshing {
    transition:
      transform 180ms ease,
      opacity 180ms ease;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 999px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--text-muted);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14);
    transition: color 120ms ease;
  }
  .ptr.armed .badge {
    color: var(--accent);
    border-color: var(--accent);
  }
  .badge.spin {
    animation: ptr-spin 0.8s linear infinite;
  }
  @keyframes ptr-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
