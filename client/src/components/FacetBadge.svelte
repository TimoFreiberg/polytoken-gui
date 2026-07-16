<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import MenuBadge from "./ui/MenuBadge.svelte";

  // Facet picker in the composer chrome. Shows the ACTUAL current facet — the
  // draft's pick while drafting a new session, else the active session's live
  // facet (composerFacet unifies the two, mirroring composerConfig); clicking
  // opens a dropdown listing all available facets. Shift+Tab rotates AND opens
  // the menu with focus in it — repeated Shift+Tab cycles through facets while
  // keeping the menu open; arrow keys navigate; Enter selects; Escape closes;
  // any other typed character dismisses the menu and types into the composer.
  //
  // Adventurous handoff is a slide-toggle on the right side of the Plan row.
  // Right/Left act on the highlighted Plan row without selecting it; the folded
  // session flag remains authoritative, so repeated desired-state presses are
  // no-ops once the snapshot matches.
  //
  // The dropdown chrome (badge, open/close, keyboard nav, backdrop, panel CSS)
  // lives in MenuBadge; this component supplies the facet items + modifier as
  // the panel body snippet, plus the forward-key handler that dismisses the
  // menu on a typed letter and inserts it into the composer.
  const facet = $derived(store.composerFacet);
  const isPlan = $derived(facet?.toLowerCase() === "plan");
  const label = $derived(isPlan ? "Plan" : facet.charAt(0).toUpperCase() + facet.slice(1));
  const facets = $derived(store.facets);
  // Adventurous handoff lives in this menu because it's a plan-mode modifier
  // in spirit: it lets plan mode hand off to implementation autonomously. It's
  // a live per-session daemon flag, so it hides while drafting (no session yet).
  const handoff = $derived(store.session.adventurousHandoff ?? false);

  // The badge + rows are colored by facet state: execute = amber, plan (handoff
  // off) = dusty blue, plan+auto = muted lavender. Unknown facets stay neutral.
  const facetColorClass = $derived(
    facet === "execute"
      ? "facet-execute"
      : isPlan
        ? handoff
          ? "facet-auto"
          : "facet-plan"
        : "",
  );

  function onUnhandledKeydown(e: KeyboardEvent, sel: number): void {
    // Shift+Tab while the menu is open: rotate to the next facet and keep the
    // menu open (re-opens via facetMenuOpenN bump). This mirrors the composer's
    // Shift+Tab handler so repeated rotation works from within the panel.
    if (
      e.key === "Tab" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      store.cycleFacet(1, { openMenu: true });
      return;
    }
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

  // A typed letter from the open facet menu: dismiss the menu, restore focus to
  // the composer textarea, and insert the character at the cursor position (not
  // at the end — honors QUALITY.md Q3 re: no silent data loss for selections).
  function onForwardKey(e: KeyboardEvent): void {
    const ch = e.key;
    const draft = store.composerDraft;
    const start = store.composerSelectionStart;
    const end = store.composerSelectionEnd;
    store.composerDraft = draft.slice(0, start) + ch + draft.slice(end);
    store.composerSelectionStart = store.composerSelectionEnd = start + ch.length;
    store.focusComposer();
  }
</script>

<MenuBadge
  {label}
  title={`Facets (⇧Tab)`}
  testid="facet-badge"
  ariaLabel="Facet"
  groupTitle="Facet"
  count={facets.length}
  initialSel={Math.max(0, facets.indexOf(facet))}
  badgeClass={`facet-badge ${facetColorClass}`}
  minWidth="160px"
  closeLabel="Close facet menu"
  openExternal={store.facetMenuOpenN}
  forwardUnknownKeys={true}
  onForwardKey={onForwardKey}
  onSelect={(i) => store.setFacet(facets[i] ?? "execute")}
  onKeydown={onUnhandledKeydown}
>
  {#snippet body({ sel, close })}
    {#each facets as opt, i (opt)}
      {#if opt === "plan" && isPlan && !store.draft}
        <!-- Plan row: a div (not button) so the inline slide-toggle button isn't
             nested inside the row's select button. role=option keeps listbox
             semantics; the select button covers the label area. -->
        <div
          class="item plan-row"
          class:active={opt === facet}
          class:hl={sel === i}
          role="option"
          aria-selected={sel === i}
          class:facet-plan={!handoff}
          class:facet-auto={handoff}
          title={opt === facet ? `Facet: ${opt} (current)` : `Switch to ${opt} facet`}
        >
          <button
            class="plan-select"
            type="button"
            title={opt === facet ? `Facet: ${opt} (current)` : `Switch to ${opt} facet`}
            onclick={() => {
              store.setFacet(opt);
              close();
            }}
          >
            <span class="item-label">{opt.charAt(0).toUpperCase() + opt.slice(1)}</span>
          </button>
          <button
            class="facet-toggle"
            class:on={handoff}
            role="switch"
            aria-checked={handoff}
            aria-label="Adventurous handoff"
            data-testid="adventurous-handoff"
            title={handoff
              ? "Disable adventurous handoff — plan mode waits for your approval (Left)"
              : "Enable adventurous handoff — plan mode may start implementing autonomously (Right)"}
            onclick={(e) => {
              e.stopPropagation();
              store.toggleAdventurousHandoff();
            }}
          >
            <span class="facet-toggle-knob" aria-hidden="true"></span>
          </button>
        </div>
      {:else}
        <button
          class="item"
          class:active={opt === facet}
          class:hl={sel === i}
          class:facet-execute={opt === "execute"}
          role="option"
          aria-selected={sel === i}
          title={opt === facet ? `Facet: ${opt} (current)` : `Switch to ${opt} facet`}
          onclick={() => {
            store.setFacet(opt);
            close();
          }}
        >
          <span class="item-label">
            {opt.charAt(0).toUpperCase() + opt.slice(1)}
          </span>
        </button>
      {/if}
    {/each}
  {/snippet}
</MenuBadge>

<style>
  /* Facet badge colors — applied via :global because the .badge element is
     rendered in MenuBadge's template, not here. Scoped to .facet-badge so
     PermissionBadge (which also uses MenuBadge) is unaffected. Only the text
     color is tinted; the background is transparent (matching the other
     composer badges), per issue #47. */
  :global(.facet-badge.facet-execute) {
    color: var(--facet-execute);
  }
  :global(.facet-badge.facet-plan) {
    color: var(--facet-plan);
  }
  :global(.facet-badge.facet-auto) {
    color: var(--facet-auto);
  }
  /* Preserve the facet text tint on hover — MenuBadge's .badge:hover sets
     color to neutral, so each facet hover rule re-declares only color. The
     background falls through to MenuBadge's neutral .badge:hover
     (--surface-sunken), same as the other composer badges. */
  :global(.facet-badge.facet-execute:hover) {
    color: var(--facet-execute);
  }
  :global(.facet-badge.facet-plan:hover) {
    color: var(--facet-plan);
  }
  :global(.facet-badge.facet-auto:hover) {
    color: var(--facet-auto);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    cursor: pointer;
    color: var(--text);
  }
  .item-label {
    font-size: 12.5px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .item.hl {
    background: var(--surface-sunken);
  }
  .item.active .item-label {
    font-weight: 600;
  }
  /* Color dropdown rows by facet state: execute = amber, plan = blue,
     plan+auto = lavender. */
  .item.facet-execute {
    color: var(--facet-execute);
  }
  .item.facet-plan {
    color: var(--facet-plan);
  }
  .item.facet-auto {
    color: var(--facet-auto);
  }
  /* Plan row: a div containing a select button + slide-toggle. Flex so the
     toggle sits on the right, the select button fills the rest. */
  .plan-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    cursor: pointer;
  }
  .plan-select {
    flex: 1;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    color: inherit;
    padding: 0;
  }
  /* Slide toggle: a pill track with a knob that slides left↔right. */
  .facet-toggle {
    flex-shrink: 0;
    width: 30px;
    height: 18px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border-strong);
    background: var(--surface-sunken);
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    transition: background 0.15s, border-color 0.15s;
  }
  .facet-toggle-knob {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-muted);
    margin: 0 2px;
    transition: transform 0.15s, background 0.15s;
    /* Knob starts on the left (off). */
    transform: translateX(0);
  }
  .facet-toggle.on {
    background: var(--facet-auto-soft);
    border-color: var(--facet-auto);
  }
  .facet-toggle.on .facet-toggle-knob {
    /* Knob slides to the right (on). */
    transform: translateX(12px);
    background: var(--facet-auto);
  }
  .facet-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  @media (pointer: coarse) {
    .facet-toggle {
      min-width: 44px;
      min-height: 44px;
    }
    .facet-toggle-knob {
      width: 16px;
      height: 16px;
    }
    .facet-toggle.on .facet-toggle-knob {
      transform: translateX(16px);
    }
  }
</style>
