<script lang="ts">
  import type { Snippet } from "svelte";
  import Chevron from "./Chevron.svelte";
  import { reveal } from "../../lib/transitions.js";

  // Shared dropdown primitive for the badge-style pickers in the composer chrome
  // (FacetBadge, PermissionBadge). Owns the open/close state, keyboard navigation
  // (Esc/↑↓/↵), the click-away backdrop, and the panel/badge/group-title chrome.
  // The caller passes the panel body (option buttons + any extras like FacetBadge's
  // handoff toggle / reload) as a snippet, receiving the current keyboard-highlight
  // index `sel` and a `close()` callback. An optional key callback receives only keys
  // not consumed by the primitive, allowing a picker-specific modifier without
  // duplicating listbox navigation.
  //
  // Conventions (AGENTS.md): <Chevron variant="menu"> for the glyph,
  // transition:reveal for the open/close animation. Every clickable element carries
  // a title; the backdrop is the one exception (invisible click-away — aria-label
  // only, matching the prior pickers).
  let {
    label,
    title,
    testid,
    ariaLabel,
    groupTitle,
    count = 0,
    initialSel = 0,
    badgeClass = "",
    minWidth = "200px",
    closeLabel = "Close menu",
    openExternal = 0,
    forwardUnknownKeys = false,
    onSelect,
    onKeydown: onUnhandledKeydown,
    onForwardKey,
    body,
  }: {
    label: string;
    title: string;
    testid?: string;
    ariaLabel: string;
    groupTitle: string;
    count?: number;
    initialSel?: number;
    badgeClass?: string;
    minWidth?: string;
    closeLabel?: string;
    openExternal?: number;
    /** When true, a single printable character (no modifiers except Shift)
     *  dismisses the panel and is forwarded via onForwardKey — e.g. the facet
     *  menu returns the keystroke to the composer. Default false preserves
     *  PermissionBadge's existing behavior. */
    forwardUnknownKeys?: boolean;
    onSelect?: (index: number) => void;
    onKeydown?: (event: KeyboardEvent, sel: number) => void;
    /** Called with the forwarded KeyboardEvent when forwardUnknownKeys fires. */
    onForwardKey?: (event: KeyboardEvent) => void;
    body: Snippet<[{ sel: number; close: () => void }]>;
  } = $props();

  let open = $state(false);
  let sel = $state(0);
  let panelEl = $state<HTMLElement>();

  // External open trigger (e.g. Shift+Tab rotate-and-open). A counter so each
  // request re-fires even if the menu was already open — re-opening resets sel
  // + focuses the panel.
  let lastOpenN = 0;
  $effect(() => {
    if (openExternal > lastOpenN) {
      lastOpenN = openExternal;
      sel = initialSel;
      open = true;
    }
  });

  // Move focus into the panel when it opens so keyboard nav (arrows, number
  // keys, Enter, Esc) reaches the panel's onKeydown — not the composer textarea.
  $effect(() => {
    if (open && panelEl) {
      queueMicrotask(() => panelEl?.focus());
    }
  });

  function toggle() {
    if (open) {
      close();
    } else {
      sel = initialSel;
      open = true;
    }
  }
  function close() {
    open = false;
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(sel + 1, count - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(sel - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onSelect?.(sel);
      close();
    } else if (
      e.key === "Tab" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      // Shift+Tab: forward to the picker-specific handler (FacetBadge cycles
      // facets while keeping the menu open + focused). Do NOT close here.
      e.preventDefault();
      onUnhandledKeydown?.(e, sel);
    } else {
      // Number keys 1–9: quick-select the Nth option.
      const num = parseInt(e.key, 10);
      if (!isNaN(num) && num >= 1 && num <= count) {
        e.preventDefault();
        onSelect?.(num - 1);
        close();
      } else if (
        forwardUnknownKeys &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        // Single printable char (no modifiers except Shift): dismiss the panel
        // and forward the keystroke to the caller — e.g. FacetBadge replays it
        // into the composer textarea.
        e.preventDefault();
        close();
        onForwardKey?.(e);
      } else {
        onUnhandledKeydown?.(e, sel);
        // If the picker-specific handler didn't consume it (no preventDefault),
        // prevent browser focus traversal (e.g. plain Tab moves focus away).
        if (!e.defaultPrevented) e.preventDefault();
      }
    }
  }
</script>

<div class="anchor">
  <button
    class="badge {badgeClass}"
    data-testid={testid}
    {title}
    aria-label={ariaLabel}
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
      aria-label={ariaLabel}
      tabindex="-1"
      bind:this={panelEl}
      transition:reveal
      style:min-width={minWidth}
      onkeydown={onKeydown}
    >
      <div class="group-title">{groupTitle}</div>
      {@render body({ sel, close })}
    </div>
  {/if}
</div>

{#if open}
  <button class="backdrop" aria-label={closeLabel} onclick={close}></button>
{/if}

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
    background: transparent;
    border: 1px solid transparent;
    padding: 6px 8px;
    min-height: 36px;
    border-radius: var(--radius-xs);
    cursor: pointer;
  }
  .badge-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The plan/nonstandard marker classes remain available for state assertions, but
     all composer selectors deliberately share this calm, neutral treatment. */
  .badge:hover {
    color: var(--text);
    background: var(--surface-sunken);
  }
  @media (pointer: coarse) {
    .badge {
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
    }
  }
  .badge:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .panel {
    position: absolute;
    /* Opens UPWARD: the picker lives in the composer footer at the bottom of the
       viewport, so a downward panel would fall off-screen.
       LEFT-anchored (not right): the badge's left edge is stable when its label
       width changes (e.g. facet rotation via Shift+Tab), so the panel stays put.
       Both badges live on the left side of the footer, so left-anchoring also
       keeps the panel on-screen. */
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 50;
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
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 40;
    cursor: default;
  }
</style>
