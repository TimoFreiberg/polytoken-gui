<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import type { PermissionMonitorMode } from "@pantoken/protocol";
  import MenuBadge from "./ui/MenuBadge.svelte";

  // Permission-monitor mode indicator in the composer toolbar (next to facet/
  // model/effort). Shows the ACTUAL current mode; clicking opens a 4-item panel
  // (Standard/Bypass/Bypass+/Autonomous) to switch. Non-standard modes get an
  // state class while retaining the same neutral chrome. Mirrors FacetBadge's
  // badge+panel pattern. Reads the draft's pick while drafting
  // (composerPermissionMonitor), else the active session's live mode.
  //
  // The dropdown chrome (badge, open/close, keyboard nav, backdrop, panel CSS)
  // lives in MenuBadge; this component supplies the mode items as the panel body
  // snippet.
  const mode = $derived(store.composerPermissionMonitor);
  const MODES: { id: PermissionMonitorMode; label: string; desc: string }[] = [
    { id: "standard", label: "Standard", desc: "Prompt for each permission" },
    { id: "bypass", label: "Bypass", desc: "Auto-approve all permissions" },
    {
      id: "bypass_plus",
      label: "Bypass+",
      desc: "Auto-approve except deny rules",
    },
    {
      id: "autonomous",
      label: "Autonomous",
      desc: "Classifier-driven auto-approval",
    },
  ];
  const activeOpt = $derived(MODES.find((m) => m.id === mode) ?? MODES[0]!);
  const isStandard = $derived(mode === "standard");
</script>

<MenuBadge
  label={activeOpt.label}
  title={`Permission mode: ${mode} — click to switch (⌘⇧P)`}
  testid="permission-badge"
  ariaLabel="Permission mode"
  groupTitle="Permission mode"
  count={MODES.length}
  initialSel={MODES.findIndex((m) => m.id === mode)}
  badgeClass={isStandard ? "" : "nonstandard"}
  minWidth="200px"
  closeLabel="Close permission menu"
  onSelect={(i) => store.setPermissionMonitor(MODES[i]!.id)}
>
  {#snippet body({ sel, close })}
    {#each MODES as opt, i (opt.id)}
      <button
        class="item"
        class:active={opt.id === mode}
        class:hl={sel === i}
        role="option"
        aria-selected={sel === i}
        title={opt.id === mode
          ? `Permission: ${opt.label} (current)`
          : `Set permission mode to ${opt.label}`}
        onclick={() => {
          store.setPermissionMonitor(opt.id);
          close();
        }}
      >
        <span class="item-label">{opt.label}</span>
        <span class="item-desc">{opt.desc}</span>
      </button>
    {/each}
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
  }
  .item-desc {
    font-size: 11px;
    color: var(--text-muted);
  }
  .item.hl {
    background: var(--surface-sunken);
  }
  .item.active .item-label {
    font-weight: 600;
  }
</style>
