<script lang="ts">
  import type { Snippet } from "svelte";
  import Chevron from "./Chevron.svelte";
  import { reveal } from "../../lib/transitions.js";
  import { overlayHistory } from "../../lib/overlay-history.js";
  import { onDestroy } from "svelte";
  import { store } from "../../lib/store.svelte.js";

  // Shared dropdown primitive for the badge-style pickers in the composer chrome
  // (FacetBadge, PermissionBadge, BranchPicker). Owns the open/close state,
  // keyboard navigation (Esc/↑↓/↵/⇧Tab), the click-away backdrop, and the
  // panel/badge/group-title chrome. The caller passes the panel body (option
  // buttons + any extras like FacetBadge's handoff toggle / reload) as a snippet,
  // receiving the current keyboard-highlight index `sel` and a `close()` callback.
  // An optional key callback receives only keys not consumed by the primitive,
  // allowing a picker-specific modifier (e.g. FacetBadge's ArrowRight/ArrowLeft
  // adventurous-handoff toggle) without duplicating listbox navigation.
  //
  // `count` may arrive async (e.g. the branch list loads after the panel opens):
  // an $effect clamps `sel` back into range when the list grows/shrinks so a
  // stale highlight never points past the end. `maxWidth` constrains wide panels
  // (long branch names); `overlayId` wires phone back-gesture close via
  // overlayHistory (mirrors the standalone overlays — sessions drawer etc.).
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
    maxWidth = "",
    closeLabel = "Close menu",
    openExternal = 0,
    overlayId,
    onSelect,
    onKeydown: onUnhandledKeydown,
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
    maxWidth?: string;
    closeLabel?: string;
    openExternal?: number;
    overlayId?: string;
    onSelect?: (index: number) => void;
    onKeydown?: (event: KeyboardEvent, sel: number) => void;
    body: Snippet<[{ sel: number; close: () => void }]>;
  } = $props();

  let open = $state(false);
  let sel = $state(0);
  let panelEl = $state<HTMLElement>();

  // Clamp sel into [0, count-1] when the option list changes (async arrival).
  // FacetBadge/PermissionBadge pass a static count, so this is a no-op for them.
  $effect(() => {
    if (count > 0 && sel > count - 1) sel = count - 1;
    else if (count <= 0) sel = 0;
  });

  // Keep the highlighted option scrolled into view during keyboard navigation
  // (long lists overflow the panel's max-height). Mirrors BranchPicker's
  // scrollHighlight(). Runs after sel updates + the DOM reflects it.
  $effect(() => {
    if (!open || !panelEl) return;
    void sel;
    queueMicrotask(() =>
      panelEl
        ?.querySelector<HTMLElement>(`[data-i="${sel}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  });

  // External open trigger (e.g. Shift+Tab open-menu). A counter so each
  // request re-fires even if the menu was already open — re-opening resets sel
  // + focuses the panel.
  //
  // `lastOpenN` starts null so the first effect run after a (re)mount syncs to
  // the current counter value WITHOUT opening: openExternal (e.g. store.
  // facetMenuOpenN) is monotonic and never reset, so a remount — caused by
  // opening then closing a new-session draft (App.svelte `{#if !store.draft}`
  // unmounts Composer and its badge children) — must not re-fire open=true on
  // a stale-but-high counter. This is safe for PermissionBadge too, which
  // passes no openExternal (defaults to 0): lastOpenN becomes 0 on mount and
  // `0 > 0` never fires — unchanged behavior.
  let lastOpenN: number | null = null;
  $effect(() => {
    if (lastOpenN === null) {
      // First observation after (re)mount: sync without opening.
      lastOpenN = openExternal;
      return;
    }
    if (openExternal > lastOpenN) {
      lastOpenN = openExternal;
      sel = initialSel;
      openMenu();
    }
  });

  // Move focus into the panel when it opens so keyboard nav (arrows, number
  // keys, Enter, Esc) reaches the panel's onKeydown — not the composer textarea.
  $effect(() => {
    if (open && panelEl) {
      queueMicrotask(() => panelEl?.focus());
    }
  });

  // Phone back-gesture integration: when overlayId is set, opening pushes a
  // history entry so the OS back gesture closes the panel (mirrors standalone
  // overlays). No-op on desktop (overlayHistory.opened is phone-only) and when
  // overlayId is unset (PermissionBadge/FacetBadge — tiny desktop pickers).
  let overlayCloseHandled = false;
  function openMenu() {
    open = true;
    if (overlayId) {
      overlayCloseHandled = false;
      overlayHistory.opened(overlayId, () => {
        overlayCloseHandled = true;
        close();
      });
    }
  }
  function closeOverlayHistory() {
    if (overlayId && !overlayCloseHandled) {
      overlayCloseHandled = true;
      overlayHistory.closed(overlayId);
    }
  }
  function toggle() {
    if (open) {
      close();
    } else {
      sel = initialSel;
      openMenu();
    }
  }
  function close() {
    closeOverlayHistory();
    open = false;
    // Issue #54: every close path returns focus to the composer textarea, so
    // the next Shift+Tab re-opens the menu (facet/permission/branch flow). This
    // is the single exit point — Esc, Enter, click-select, click-outside,
    // number-key quick-select, and the phone overlay-history close all funnel
    // through here. Mobile is unaffected: these badges are display:none under
    // 859px (replaced by MobileSessionControls), so the soft-keyboard concern
    // does not apply.
    store.focusComposer();
  }
  onDestroy(() => {
    // Intentionally NOT close(): unmount should not refocus the composer. The
    // textarea may be tearing down (e.g. a new-session draft opens via
    // App.svelte's `{#if !store.draft}`, unmounting Composer and its badges).
    closeOverlayHistory();
  });
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
      // Shift+Tab: move the highlight to the next entry (wrapping), mirroring
      // ArrowDown's direction. Do NOT commit — Enter commits, Escape aborts.
      e.preventDefault();
      sel = count > 0 ? (sel + 1) % count : 0;
    } else {
      // Number keys 1–9: quick-select the Nth option.
      const num = parseInt(e.key, 10);
      if (!isNaN(num) && num >= 1 && num <= count) {
        e.preventDefault();
        onSelect?.(num - 1);
        close();
      } else {
        onUnhandledKeydown?.(e, sel);
        // If the picker-specific handler didn't consume it (no preventDefault),
        // prevent browser focus traversal (e.g. plain Tab moves focus away).
        // Single printable letters fall through here and are effectively
        // ignored (prevented, not inserted) — a noop, as required.
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
      style:max-width={maxWidth || null}
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
    /* Cap height so long option lists (up to 100 branches) scroll instead of
       overflowing the viewport. Short pickers (facet/permission) never hit it. */
    max-height: 240px;
    overflow-y: auto;
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
