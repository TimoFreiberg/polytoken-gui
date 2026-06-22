<script lang="ts">
  import type { ParsedTask } from "../lib/tasklist.js";
  import Chevron from "./ui/Chevron.svelte";

  let { tasks }: { tasks: ParsedTask[] } = $props();

  // Hover (desktop) or keyboard focus peeks the list; a click pins it open so touch
  // users — who have no hover — and keyboard users get the same affordance. Escape
  // unpins. `open` is the union so a pinned list survives the pointer leaving.
  let hovered = $state(false);
  let pinned = $state(false);
  const open = $derived(hovered || pinned);
  const count = $derived(tasks.length);
  const label = $derived(`${count} task${count === 1 ? "" : "s"}`);
</script>

<!-- onmouseenter/leave + onfocusin/out live on the wrapper (not the pill) so the
     popover — a DOM descendant — counts as "inside"; the transparent .pop padding
     bridges the visual gap so crossing it never fires mouseleave. -->
<div
  class="tasklist"
  role="group"
  aria-label="Open tasks"
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
  onfocusin={() => (hovered = true)}
  onfocusout={() => (hovered = false)}
>
  {#if open}
    <div class="pop">
      <div class="pop-card">
        <div class="pop-head">Open tasks · {count}</div>
        <ul class="tasks">
          {#each tasks as t (t.id)}
            <li class="task">
              <span class="mark" aria-hidden="true">○</span>
              <span class="desc">{t.description}</span>
              <span class="id" title="Task id">#{t.id}</span>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  <button
    class="pill"
    class:open
    aria-expanded={open}
    title={`${label} open — hover or click to view`}
    onclick={() => (pinned = !pinned)}
    onkeydown={(e) => {
      if (e.key === "Escape" && pinned) {
        e.preventDefault();
        pinned = false;
      }
    }}
  >
    <span class="ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m3 17 2 2 4-4" />
        <path d="m3 7 2 2 4-4" />
        <path d="M13 6h8" />
        <path d="M13 12h8" />
        <path d="M13 18h8" />
      </svg>
    </span>
    <span class="count">{label}</span>
    <Chevron {open} variant="menu" size={10} />
  </button>
</div>

<style>
  .tasklist {
    position: relative;
    align-self: flex-start;
    max-width: 100%;
  }
  /* Compact chip — mirrors the composer's draft chips so it reads as session chrome. */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    max-width: 100%;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .pill:hover,
  .pill.open {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .pill:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .ico {
    display: inline-grid;
    place-items: center;
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .pill:hover .ico,
  .pill.open .ico {
    color: var(--accent);
  }
  .count {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Transparent positioner: sits flush against the pill's top edge and pads
     downward to bridge the gap to the card, so the hover region is continuous. */
  .pop {
    position: absolute;
    bottom: 100%;
    left: 0;
    padding-bottom: 7px;
    z-index: 30;
  }
  .pop-card {
    min-width: 240px;
    max-width: min(380px, calc(100vw - 40px));
    max-height: min(320px, 50vh);
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-pop);
    padding: 8px 10px;
    animation: pop-rise 0.14s ease;
  }
  @keyframes pop-rise {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pop-card {
      animation: none;
    }
  }
  .pop-head {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 2px 6px;
  }
  .tasks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .task {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 3px 2px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--text);
  }
  .mark {
    color: var(--text-faint);
    font-size: 11px;
    flex-shrink: 0;
    line-height: 1.4;
  }
  .desc {
    flex: 1;
    min-width: 0;
    word-break: break-word;
  }
  .id {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-faint);
    align-self: center;
  }
</style>
