<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import Chevron from "./ui/Chevron.svelte";

  // Facet picker in the composer toolbar. Shows the ACTUAL current facet; clicking
  // opens a dropdown listing all available facets (from `polytoken vfs ls
  // polytoken://facets`). The active facet gets an accent tint. Shift+Tab still
  // toggles execute ↔ plan (the common case) — the dropdown is for discovering
  // and switching to non-default facets.
  const facet = $derived(store.session.facet ?? "execute");
  const isPlan = $derived(facet === "plan");
  const label = $derived(facet === "plan" ? "Plan" : facet.charAt(0).toUpperCase() + facet.slice(1));

  let open = $state(false);
  let panelEl: HTMLDivElement | undefined = $state();
  let sel = $state(0);

  const facets = $derived(store.facets);

  function toggle() {
    if (open) {
      close();
    } else {
      sel = Math.max(0, facets.indexOf(facet));
      open = true;
    }
  }
  function close() {
    open = false;
  }
  function pick(f: string) {
    store.setFacet(f);
    close();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(sel + 1, facets.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(facets[sel] ?? "execute");
    }
  }
</script>

<div class="fb">
  <div class="anchor">
    <button
      class="badge facet-badge"
      class:plan={isPlan}
      data-testid="facet-badge"
      title={`Facet: ${facet} — click to switch (Shift+Tab toggles execute/plan)`}
      aria-haspopup="listbox"
      aria-expanded={open}
      onclick={toggle}
    >
      <span class="badge-text">{label}</span>
      <Chevron open={open} variant="menu" size={10} />
    </button>
    {#if open}
      <div
        class="panel"
        role="listbox"
        aria-label="Facet"
        tabindex="-1"
        bind:this={panelEl}
        onkeydown={onKeydown}
      >
        <div class="group-title">Facet</div>
        {#each facets as opt, i (opt)}
          <button
            class="item"
            class:active={opt === facet}
            class:hl={sel === i}
            role="option"
            aria-selected={sel === i}
            title={opt === facet ? `Facet: ${opt} (current)` : `Switch to ${opt} facet`}
            onclick={() => pick(opt)}
          >
            <span class="item-label">{opt.charAt(0).toUpperCase() + opt.slice(1)}</span>
          </button>
        {/each}
        <button
          class="reload"
          title="Reload the facet list from disk"
          onclick={() => { store.refreshFacets(); close(); }}
        >
          ↻ Reload facets
        </button>
        <div class="kbd-hint">↑↓ move · ↵ select · esc cancel</div>
      </div>
    {/if}
  </div>

  {#if open}
    <button class="backdrop" aria-label="Close facet menu" onclick={close}></button>
  {/if}
</div>

<style>
  .anchor {
    position: relative;
  }
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
    cursor: pointer;
  }
  .badge-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge.plan {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .badge:hover {
    border-color: var(--border-strong);
  }
  .badge:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .panel {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 50;
    min-width: 160px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 4px;
  }
  .group-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    padding: 4px 8px 2px;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    cursor: pointer;
    color: var(--text);
  }
  .item-label {
    font-size: 12.5px;
  }
  .item.hl {
    background: var(--surface-sunken);
  }
  .item.active .item-label {
    font-weight: 600;
  }
  .reload {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-top: 1px solid var(--border);
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    padding: 6px 8px;
    margin-top: 2px;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 11px;
  }
  .reload:hover {
    color: var(--text);
  }
  .kbd-hint {
    padding: 6px 8px 3px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
    text-align: center;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 40;
    cursor: default;
  }
</style>
