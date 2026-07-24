<script lang="ts">
  import { tick } from "svelte";
  import { overlayHistory } from "../lib/overlay-history.js";
  import { store } from "../lib/store.svelte.js";
  import type { HostCoordinator } from "../lib/hosts.svelte.js";
  import type { HostSummary } from "../lib/hosts/types.js";
  import Chevron from "./ui/Chevron.svelte";

  const { coordinator }: { coordinator: HostCoordinator } = $props();
  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLElement | null>(null);
  let phone = $state(
    typeof window !== "undefined" && window.matchMedia("(max-width: 859px)").matches,
  );
  let failure = $state<{ id: string; label: string; action?: string } | null>(null);
  const selected = $derived(coordinator.summaries.find((s) => s.selected) ?? coordinator.summaries[0]);

  function isPhone(): boolean {
    return phone;
  }

  $effect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 859px)");
    const update = () => (phone = media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });

  function restoreFocus(): void {
    void tick().then(() => trigger?.isConnected && trigger.focus());
  }

  function close(fromHistory = false): void {
    if (!open) return;
    open = false;
    failure = null;
    if (!fromHistory) overlayHistory.closed("host-switcher");
    restoreFocus();
  }

  function toggle(): void {
    if (open) {
      close();
      return;
    }
    open = true;
    if (isPhone()) overlayHistory.openedNested("host-switcher", () => close(true));
    void tick().then(() => panel?.querySelector<HTMLElement>("button.host-option")?.focus());
  }

  async function choose(summary: HostSummary): Promise<void> {
    failure = null;
    if (summary.selected) {
      close();
      return;
    }
    const result = await coordinator.selectHost(summary.descriptor.id);
    if (result && !result.ok) {
      failure = { id: summary.descriptor.id, ...result.failure };
      return;
    }
    close();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab" || !isPhone() || !panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>("button:not(:disabled)")
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (isPhone()) return;
      const target = e.target as Node;
      if (!panel?.contains(target) && !trigger?.contains(target)) close();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });
</script>

<div class="host-switcher" data-testid="host-switcher">
  <button
    class="host-trigger"
    bind:this={trigger}
    data-testid="host-switcher-trigger"
    aria-label={selected ? `Selected computer: ${selected.descriptor.label}. ${selected.statusText}` : "Select computer"}
    aria-expanded={open}
    aria-controls="host-switcher-panel"
    onclick={toggle}
  >
    <span class="computer-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" />
      </svg>
    </span>
    <span class="host-copy">
      <strong>{selected?.descriptor.label ?? "Connecting…"}</strong>
      <span>{selected?.descriptor.subtitle || "This computer"}</span>
    </span>
    {#if selected}
      <span class="indicator {selected.indicator}" aria-label={selected.statusText}></span>
    {/if}
    <Chevron variant="menu" open={open} />
  </button>

  {#if open}
    <div
      class="host-panel"
      class:phone-sheet={isPhone()}
      id="host-switcher-panel"
      bind:this={panel}
      role="dialog"
      aria-modal="true"
      aria-label="Choose computer"
    >
      <div class="panel-head">
        <strong>Computers</strong>
        <button class="close" aria-label="Close computer picker" onclick={() => close()}>Close</button>
      </div>
      <div class="host-list" role="listbox" aria-label="Computers">
        {#each coordinator.summaries as summary (summary.descriptor.id)}
          <button
            class="host-option"
            class:selected={summary.selected}
            class:failed={summary.descriptor.state === "failed"}
            data-testid={`host-option-${summary.descriptor.id}`}
            role="option"
            aria-selected={summary.selected}
            aria-label={`${summary.descriptor.label}, ${summary.descriptor.subtitle || "This computer"}, ${summary.statusText}`}
            onclick={() => void choose(summary)}
          >
            <span class="option-icon" aria-hidden="true">{summary.descriptor.isDockerTarget ? "▣" : "⌂"}</span>
            <span class="host-copy"><strong>{summary.descriptor.label}</strong><span>{summary.descriptor.subtitle || "This computer"}</span></span>
            <span class="option-status">
              <span class="indicator {summary.indicator}" aria-hidden="true"></span>
              <span>{summary.statusText}</span>
            </span>
          </button>
          {#if failure?.id === summary.descriptor.id}
            <div class="failure" role="alert">
              <span>{failure.label}</span>
              <button onclick={() => void choose(summary)}>{failure.action || "Retry"}</button>
            </div>
          {/if}
        {/each}
      </div>
      {#if coordinator.multiHostCapable}
        <div class="management">
          <button data-testid="host-switcher-add" onclick={() => { close(); store.openComputerSetup("add"); }}>Add computer</button>
          <button data-testid="host-switcher-manage" onclick={() => { close(); store.openSettings("computers"); }}>Manage computers</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .host-switcher { position: relative; padding: 0 10px 8px; }
  .host-trigger, .host-option, .management button, .close {
    font: inherit; color: inherit; border: 0; background: none; cursor: pointer;
  }
  .host-trigger { width: 100%; min-height: 52px; display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; text-align: left; color: var(--text); }
  .host-trigger:hover, .host-trigger:focus-visible { border-color: var(--accent); background: var(--surface-hover); outline: none; }
  .computer-icon, .option-icon { color: var(--accent); flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; }
  .option-icon { width: 24px; font-size: 18px; }
  .host-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1; }
  .host-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
  .host-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-muted); }
  .indicator { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: transparent; }
  .indicator.offline { background: var(--muted); }
  .indicator.failed { background: var(--danger); }
  .indicator.waiting { background: var(--warning); }
  .indicator.reconnecting { background: var(--accent); }
  .indicator.running { background: var(--progress); }
  .indicator.unseen { background: var(--highlight); }
  .host-panel { position: absolute; z-index: 80; top: calc(100% - 2px); left: 10px; right: 10px; padding: 8px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg); box-shadow: 0 12px 32px color-mix(in srgb, var(--text) 18%, transparent); }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px 8px; color: var(--text-muted); font-size: 12px; }
  .close { display: none; color: var(--accent); }
  .host-list { display: grid; gap: 2px; }
  .host-option { min-height: 52px; display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 7px; text-align: left; }
  .host-option:hover, .host-option:focus-visible { background: var(--surface-hover); outline: none; }
  .host-option.selected { background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 3px 0 var(--accent); }
  .option-status { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 10px; white-space: nowrap; }
  .failure { display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px 6px 40px; color: var(--danger); font-size: 11px; }
  .failure button { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; font-weight: 650; }
  .management { display: grid; gap: 2px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .management button { min-height: 40px; text-align: left; padding: 0 8px; color: var(--text-muted); font-size: 12px; }
  .management button:disabled { opacity: .65; cursor: default; }
  @media (max-width: 859px) {
    .host-switcher { padding: 0 0 8px; }
    .host-trigger { min-height: 52px; }
    .host-panel.phone-sheet { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; border: 0; border-radius: 0; padding: calc(12px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom)); overflow-y: auto; }
    .phone-sheet .panel-head { min-height: 44px; font-size: 15px; }
    .phone-sheet .close { display: block; min-height: 44px; padding: 0 8px; }
    .phone-sheet .host-option { min-height: 56px; padding: 8px 4px; }
    .phone-sheet .option-status { font-size: 11px; }
    .phone-sheet .management button { min-height: 44px; }
  }
</style>
