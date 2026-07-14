<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import MenuBadge from "./ui/MenuBadge.svelte";

  // Facet picker in the composer chrome. Shows the ACTUAL current facet — the
  // draft's pick while drafting a new session, else the active session's live
  // facet (composerFacet unifies the two, mirroring composerConfig); clicking
  // opens a dropdown listing all available facets. ⌘⇧C opens this dropdown
  // (number keys 1-9 quick-select inside it).
  //
  // Adventurous handoff is a compact Plan-only modifier for an existing live
  // session. Right/Left act on the highlighted Plan row without selecting it;
  // the folded session flag remains authoritative, so repeated desired-state
  // presses are no-ops once the snapshot matches.
  //
  // The dropdown chrome (badge, open/close, keyboard nav, backdrop, panel CSS)
  // lives in MenuBadge; this component supplies the facet items + modifier +
  // reload button as the panel body snippet.
  const facet = $derived(store.composerFacet);
  const isPlan = $derived(facet?.toLowerCase() === "plan");
  const label = $derived(isPlan ? "Plan" : facet.charAt(0).toUpperCase() + facet.slice(1));
  const facets = $derived(store.facets);
  // Adventurous handoff lives in this menu because it's a plan-mode modifier
  // in spirit: it lets plan mode hand off to implementation autonomously. It's
  // a live per-session daemon flag, so it hides while drafting (no session yet).
  const handoff = $derived(store.session.adventurousHandoff ?? false);

  function onUnhandledKeydown(e: KeyboardEvent, sel: number): void {
    if (
      (e.key !== "ArrowRight" && e.key !== "ArrowLeft") ||
      store.draft ||
      !isPlan ||
      sel !== facets.indexOf("plan")
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const desired = e.key === "ArrowRight";
    // The protocol exposes toggle-only handoff state. Idempotence is therefore
    // authoritative-snapshot based; a rapid opposite press before that snapshot
    // arrives remains subject to the existing toggle round trip.
    if (handoff !== desired) store.toggleAdventurousHandoff();
  }
</script>

<MenuBadge
  {label}
  title={`Facet: ${facet} — ⇧Tab rotates, ⌘⇧C opens this menu`}
  testid="facet-badge"
  ariaLabel="Facet"
  groupTitle="Facet"
  count={facets.length}
  initialSel={Math.max(0, facets.indexOf(facet))}
  badgeClass={isPlan ? "facet-badge plan" : "facet-badge"}
  minWidth="160px"
  closeLabel="Close facet menu"
  openExternal={store.facetMenuOpenN}
  onSelect={(i) => store.setFacet(facets[i] ?? "execute")}
  onKeydown={onUnhandledKeydown}
>
  {#snippet body({ sel, close })}
    {#each facets as opt, i (opt)}
      <button
        class="item"
        class:active={opt === facet}
        class:hl={sel === i}
        role="option"
        aria-selected={sel === i}
        title={opt === facet ? `Facet: ${opt} (current)` : `Switch to ${opt} facet`}
        onclick={() => {
          store.setFacet(opt);
          close();
        }}
      >
        <span class="item-label">
          <span class="item-num">{i + 1}</span>
          {opt.charAt(0).toUpperCase() + opt.slice(1)}
        </span>
      </button>
    {/each}
    {#if !store.draft && isPlan}
      <button
        class="handoff"
        role="switch"
        aria-checked={handoff}
        data-testid="adventurous-handoff"
        title={handoff
          ? "Disable adventurous handoff — plan mode waits for your approval (Left)"
          : "Enable adventurous handoff — plan mode may start implementing autonomously (Right)"}
        onclick={() => store.toggleAdventurousHandoff()}
      >
        <span class="item-label">Handoff</span>
        <span class="pill" class:on={handoff}>{handoff ? "On" : "Off"}</span>
      </button>
    {/if}
    <button
      class="reload"
      title="Reload the facet list from disk"
      onclick={() => {
        store.refreshFacets();
        close();
      }}
    >
      ↻ Reload facets
    </button>
  {/snippet}
</MenuBadge>

<style>
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
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .item-num {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    min-width: 10px;
  }
  .item.hl {
    background: var(--surface-sunken);
  }
  .item.active .item-label {
    font-weight: 600;
  }
  .handoff {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: calc(100% - 4px);
    text-align: left;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 5px 7px;
    margin: 4px 2px 2px;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .handoff:hover {
    background: var(--surface-sunken);
  }
  .handoff .pill {
    font-size: 11px;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .handoff .pill.on {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
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
</style>
