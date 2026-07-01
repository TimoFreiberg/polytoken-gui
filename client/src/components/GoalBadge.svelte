<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  // A display-only pill showing the active saved-session goal's summary in the
  // StatusHeader subtitle (the "where am I / what am I doing" bar). Mirrors
  // FacetBadge's visual language (rounded pill, surface-sunken bg, 12.5px font),
  // but is display-only — no click handler. Lifecycle-aware color tints the pill
  // so the goal's state is legible at a glance (active, paused, blocked, done).
  const goal = $derived(store.session.goal);
  const label = $derived(goal ? truncate(goal.summary, 30) : "");
  const lifecycleClass = $derived(goal?.lifecycle ?? "");

  function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }
</script>

{#if goal}
  <span
    class="badge goal-badge {lifecycleClass}"
    data-testid="goal-badge"
    title={`Goal: ${goal.summary} (${goal.lifecycle})`}
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
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
    <span class="badge-text">{label}</span>
  </span>
{/if}

<style>
  /* Mirrors FacetBadge's `.badge` visual language (rounded pill, surface-sunken
     bg) so it reads as a sibling chip. Lifecycle classes tint the pill so the
     goal's state is legible at a glance. */
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    letter-spacing: -0.01em;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 3px 9px;
    border-radius: 999px;
    max-width: 200px;
  }
  .badge-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Lifecycle tints — subtle, so the pill stays a quiet secondary readout. */
  .badge.paused {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 30%, var(--border));
  }
  .badge.blocked {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
  }
  .badge.complete {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 30%, var(--border));
  }
</style>
