<script lang="ts">
  import { tick } from "svelte";
  import type { ModelOption } from "@pantoken/protocol";
  import { store } from "../lib/store.svelte.js";
  import { reveal } from "../lib/transitions.js";
  import Chevron from "./ui/Chevron.svelte";
  import { rankModels, sortEfforts } from "../lib/model-picker-helpers.js";

  // Combined model+effort picker — one badge, one popup, one atomic action.
  // Replaces the former two-badge/two-menu structure (model ⌘⇧M + effort ⌘⇧E).
  // The picker shows a flat, fuzzy-filterable list of models, each with an inline
  // effort control (‹ medium ›) that cycles via ←/→ or [/]. Model and effort are
  // applied together in one setModel call.
  let open = $state(false);

  // Current config: the active session's folded config, or — while drafting a new
  // session — the draft's chosen model/effort (composerConfig unifies the two).
  const cfg = $derived(store.composerConfig);
  // Show the friendly label (e.g. "Claude Opus 4.8") in the badge, matching the Claude
  // app; fall back to the raw id before the model list arrives or if the active
  // model isn't in it. The raw provider:id stays available in the tooltip.
  const activeModel = $derived(
    store.models.find((m) => m.provider === cfg.provider && m.modelId === cfg.modelId),
  );
  const modelLabel = $derived(activeModel?.label ?? cfg.modelId ?? "model");
  const modelTitle = $derived(
    cfg.modelId
      ? cfg.modelId.includes("/")
        ? cfg.modelId
        : cfg.provider
          ? `${cfg.provider}:${cfg.modelId}`
          : cfg.modelId
      : "model",
  );
  // Always show the effort in the badge — even off/none (e.g. "Claude Opus 4.8 · off").
  const thinking = $derived(cfg.thinkingLevel ?? "off");
  const hasModels = $derived(store.models.length > 0);

  // Filter-as-you-type search within the model list (label / id / provider).
  let query = $state("");
  const ranked = $derived(rankModels(store.pickerModels, query));

  // Keyboard-highlight index into the flat ranked list.
  let sel = $state(0);
  // Staged effort per model: a map keyed by `${provider}:${modelId}` holding the
  // effort the user has cycled to. Seeded from the model's defaultThinkingLevel
  // (or the first sorted level) when a model is first highlighted; the active
  // model starts with its current effort. `undefined` means "no effort control"
  // (the model has no thinkingLevels at all).
  let stagedEffort = $state<Record<string, string | undefined>>({});

  // Element handles for focus management + scroll-into-view.
  let searchEl = $state<HTMLInputElement>();
  let panelEl = $state<HTMLDivElement>();

  function effortKey(m: ModelOption): string {
    return `${m.provider}:${m.modelId}`;
  }

  /** Resolve the effective effort to show for a model row: the staged value if
   *  the user has cycled it, else the model's defaultThinkingLevel, else the
   *  first sorted level, else undefined (no effort control). */
  function effortFor(m: ModelOption): string | undefined {
    const key = effortKey(m);
    if (key in stagedEffort) return stagedEffort[key];
    if (m.defaultThinkingLevel) return m.defaultThinkingLevel;
    const levels = m.thinkingLevels;
    if (levels && levels.length > 0) return sortEfforts(levels)[0];
    return undefined;
  }

  /** The sorted effort levels for a model (empty if it has none). */
  function levelsFor(m: ModelOption): string[] {
    return m.thinkingLevels ? sortEfforts(m.thinkingLevels) : [];
  }

  // Clear the query whenever the popup closes, so it's fresh on next open.
  $effect(() => {
    if (!open) {
      query = "";
      stagedEffort = {};
    }
  });
  // Keep the highlight in range as filtering shrinks the list.
  $effect(() => {
    if (open && sel >= ranked.length) sel = 0;
  });
  // Scroll the keyboard-highlighted row into view as the user arrows past the fold.
  $effect(() => {
    if (!open) return;
    sel;
    tick().then(() =>
      panelEl?.querySelector(".item.hl")?.scrollIntoView({ block: "nearest" }),
    );
  });

  function openPicker(viaKeyboard: boolean): void {
    open = true;
    sel = 0;
    // Seed the active model's staged effort with its current effort so the
    // active row shows the live value, not the model default.
    if (activeModel) {
      const key = effortKey(activeModel);
      stagedEffort = { [key]: cfg.thinkingLevel };
    }
    // Focus the filter on open — by hotkey (always) or by click (desktop only).
    // On a phone tap, skip focus so the soft keyboard doesn't pop; matches the
    // Sidebar's `if (!isPhone()) searchInput?.focus()` convention. The badge is
    // display:none under 859px, so this guard is defensive for a narrow viewport
    // where it could somehow still be clickable.
    const isPhone =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 859px)").matches;
    if (viaKeyboard || !isPhone) tick().then(() => searchEl?.focus());
  }

  function closePicker(): void {
    open = false;
    // Issue #54: always return focus to the composer on close, regardless of
    // how the picker was opened (hotkey or click). The badge is display:none
    // under 859px, so the soft-keyboard concern does not apply.
    store.focusComposer();
  }

  function toggle(viaKeyboard = false): void {
    if (open) closePicker();
    else openPicker(viaKeyboard);
  }

  // React to global hotkeys dispatched from StatusHeader via the store.
  // Snapshot the store value at mount so a remount with a stale counter
  // doesn't fire toggle on the first observation. Mirrors Transcript's
  // lastSendN = store.promptSentN pattern (which comments: "initialized to the
  // current value so a remount never scroll-jumps on its own"). Without this,
  // opening then closing a new-session draft unmounts Composer (App.svelte
  // `{#if !store.draft}`), resetting this local to 0; on remount a still-high
  // store counter (hotkeyAction is monotonic, never reset) would re-fire
  // toggle(true) and pop the picker open unbidden.
  let lastHotkeyN = $state(store.hotkeyAction?.n ?? 0);
  $effect(() => {
    const hk = store.hotkeyAction;
    if (hk && hk.n !== lastHotkeyN) {
      lastHotkeyN = hk.n;
      toggle(true);
    }
  });

  function stageEffort(m: ModelOption, level: string): void {
    stagedEffort = { ...stagedEffort, [effortKey(m)]: level };
  }

  function cycleEffort(m: ModelOption, dir: 1 | -1): void {
    const levels = levelsFor(m);
    if (levels.length === 0) return;
    const cur = effortFor(m);
    let idx = cur ? levels.indexOf(cur) : -1;
    if (idx < 0) idx = dir > 0 ? 0 : levels.length - 1;
    else idx = idx + dir;
    // Clamp (no wrapping).
    idx = Math.max(0, Math.min(levels.length - 1, idx));
    const next = levels[idx];
    if (next) stageEffort(m, next);
  }

  function applyModel(m: ModelOption): void {
    const effort = effortFor(m);
    if (!(m.provider === cfg.provider && m.modelId === cfg.modelId) || effort !== cfg.thinkingLevel) {
      store.setModel(m.provider, m.modelId, effort);
    }
    closePicker();
  }

  function onKeydown(e: KeyboardEvent): void {
    const n = ranked.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (n) sel = Math.min(sel + 1, n - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) sel = Math.max(sel - 1, 0);
    } else if (e.key === "ArrowRight" || e.key === "]") {
      e.preventDefault();
      const it = ranked[sel];
      if (it) cycleEffort(it.model, 1);
    } else if (e.key === "ArrowLeft" || e.key === "[") {
      e.preventDefault();
      const it = ranked[sel];
      if (it) cycleEffort(it.model, -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = ranked[sel];
      if (it) applyModel(it.model);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        // First Esc clears a nonempty filter.
        query = "";
        sel = 0;
      } else {
        // Second Esc closes the popup.
        closePicker();
      }
    }
  }
</script>

<div class="mp">
  {#if hasModels || cfg.modelId}
    <div class="anchor">
      <button
        class="badge"
        title={modelTitle + " (⌘⇧M)"}
        aria-label={`Model: ${modelLabel}, effort: ${thinking}`}
        disabled={!hasModels}
        onclick={() => toggle()}
        data-testid="model-badge"
      >
        <span class="badge-text">{modelLabel}</span>
        <span class="badge-sep" aria-hidden="true">·</span>
        <span class="badge-effort">{thinking}</span>
        {#if hasModels}<Chevron open={open} variant="menu" size={10} />{/if}
      </button>
      {#if open}
        <div class="panel" bind:this={panelEl} transition:reveal>
          {#each ranked as { model }, i (model.modelId)}
            {@const active = model.provider === cfg.provider && model.modelId === cfg.modelId}
            {@const levels = levelsFor(model)}
            {@const effort = effortFor(model)}
            {@const hasEffort = levels.length > 1}
            {@const effIdx = effort ? levels.indexOf(effort) : -1}
            <div
              class="item"
              class:active
              class:hl={sel === i}
              role="option"
              aria-selected={sel === i}
              title={active ? `${model.label} (current)` : `Switch to ${model.label}`}
            >
              <button
                class="item-label-btn"
                onclick={() => applyModel(model)}
              >
                <span class="item-label">{model.label}</span>
              </button>
              {#if hasEffort}
                <div class="effort" data-testid="effort-control">
                  <button
                    class="eff-arrow"
                    disabled={effIdx <= 0}
                    title="Lower effort"
                    aria-label="Lower effort"
                    onclick={() => cycleEffort(model, -1)}
                  >‹</button>
                  <span class="eff-val">{effort ?? "default"}</span>
                  <button
                    class="eff-arrow"
                    disabled={effIdx >= levels.length - 1}
                    title="Higher effort"
                    aria-label="Higher effort"
                    onclick={() => cycleEffort(model, 1)}
                  >›</button>
                </div>
              {:else}
                <button
                  class="select-btn"
                  onclick={() => applyModel(model)}
                >select</button>
              {/if}
            </div>
          {/each}
          {#if ranked.length === 0}
            <div class="empty">No models match</div>
          {/if}
          <div class="footer">
            <input
              class="filter"
              type="text"
              placeholder="Type to filter…"
              aria-label="Filter models"
              spellcheck="false"
              autocapitalize="off"
              autocorrect="off"
              bind:this={searchEl}
              bind:value={query}
              oninput={() => (sel = 0)}
              onkeydown={onKeydown}
              data-testid="model-filter"
            />
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if open}
  <button
    class="backdrop"
    aria-label="Close model picker"
    onclick={() => closePicker()}
  ></button>
{/if}

<style>
  .mp {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
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
    max-width: 42vw;
  }
  .badge:disabled {
    cursor: default;
  }
  .badge:hover {
    color: var(--text);
    background: var(--surface-sunken);
  }
  .badge:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  @media (pointer: coarse) {
    .badge {
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
    }
  }
  .badge-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge-sep {
    color: var(--text-faint);
  }
  .badge-effort {
    color: var(--text-muted);
    white-space: nowrap;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 40;
    cursor: default;
  }
  .panel {
    position: absolute;
    /* Opens UPWARD: the picker lives in the composer footer at the bottom of the
       viewport, so a downward panel would fall off-screen. */
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 50;
    width: min(440px, calc(100vw - 40px));
    max-height: 60vh;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-pop);
    padding: 4px;
  }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 112px;
    align-items: center;
    gap: 8px;
    height: 39px;
    padding: 0 4px 0 0;
    border-radius: var(--radius-sm);
  }
  .item.hl {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .item.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .item-label-btn {
    text-align: left;
    background: transparent;
    border: none;
    padding: 0 8px;
    cursor: pointer;
    color: var(--text);
    overflow: hidden;
  }
  .item-label {
    font-size: 13px;
    font-family: var(--font-sans);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .effort {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
  }
  .eff-arrow {
    width: 24px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .eff-arrow:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-sunken);
  }
  .eff-arrow:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .eff-val {
    flex: 1;
    text-align: center;
    font-size: 12px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .select-btn {
    justify-self: end;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 4px 10px;
    font-size: 12px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    cursor: pointer;
  }
  .select-btn:hover {
    color: var(--text);
    background: var(--surface-sunken);
  }
  .empty {
    padding: 8px;
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
  }
  .footer {
    padding: 4px 6px 4px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
  }
  .filter {
    width: 126px;
    box-sizing: border-box;
    font-size: 12.5px;
    font-family: var(--font-sans);
    color: var(--text);
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    padding: 4px 2px;
  }
  .filter:focus {
    outline: none;
    border-bottom-color: var(--accent);
  }
  .filter::placeholder {
    color: var(--text-faint);
  }
</style>
