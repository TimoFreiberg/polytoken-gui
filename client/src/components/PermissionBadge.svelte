<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import type { PermissionMonitorMode } from "@pilot/protocol";
  import Chevron from "./ui/Chevron.svelte";

  // Permission-monitor mode indicator in the composer toolbar (next to facet/
  // model/effort). Shows the ACTUAL current mode; clicking opens a 4-item panel
  // (Standard/Bypass/Bypass+/Autonomous) to switch. Non-standard modes get an
  // accent tint to signal "you are not in the default safe mode". Mirrors
  // ModelPicker's badge+panel-up pattern.
  const mode = $derived(store.session.permissionMonitor ?? "standard");
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

  let open = $state(false);
  let panelEl: HTMLDivElement | undefined = $state();
  let sel = $state(0);

  function toggle() {
    if (open) {
      close();
    } else {
      sel = MODES.findIndex((m) => m.id === mode);
      open = true;
    }
  }
  function close() {
    open = false;
  }
  function pick(m: PermissionMonitorMode) {
    store.setPermissionMonitor(m);
    close();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(sel + 1, MODES.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(MODES[sel]!.id);
    }
  }
</script>

<div class="pb">
  <div class="anchor">
    <button
      class="badge"
      class:nonstandard={!isStandard}
      data-testid="permission-badge"
      title={`Permission mode: ${mode} — click to switch (⌘⇧M)`}
      aria-haspopup="listbox"
      aria-expanded={open}
      onclick={toggle}
    >
      <span class="badge-text">{activeOpt.label}</span>
      <Chevron open={open} variant="menu" size={10} />
    </button>
    {#if open}
      <div
        class="panel"
        role="listbox"
        aria-label="Permission mode"
        tabindex="-1"
        bind:this={panelEl}
        onkeydown={onKeydown}
      >
        <div class="group-title">Permission mode</div>
        {#each MODES as opt, i (opt.id)}
          <button
            class="item"
            class:active={opt.id === mode}
            class:hl={sel === i}
            role="option"
            aria-selected={sel === i}
            title={opt.id === mode ? `Permission: ${opt.label} (current)` : `Set permission mode to ${opt.label}`}
            onclick={() => pick(opt.id)}
      >
            <span class="item-label">{opt.label}</span>
            <span class="item-desc">{opt.desc}</span>
          </button>
        {/each}
        <div class="kbd-hint">↑↓ move · ↵ select · esc cancel</div>
      </div>
    {/if}
  </div>

  {#if open}
    <button class="backdrop" aria-label="Close permission menu" onclick={close}></button>
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
  /* Non-standard modes (bypass/bypass+/autonomous) get an accent tint to signal
     "you are not in the default safe mode". */
  .badge.nonstandard {
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
    /* Opens UPWARD: the picker lives in the composer footer at the bottom of the
       viewport, so a downward panel would fall off-screen. */
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 50;
    min-width: 200px;
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
