<script lang="ts">
  import { tick } from "svelte";
  import type { ModelOption } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import Chevron from "./ui/Chevron.svelte";

  type Open = "none" | "model" | "thinking";
  let open = $state<Open>("none");

  // Current selection: the active session's folded config, or — while drafting a new
  // session — the draft's chosen model/effort (composerConfig unifies the two). The
  // switchable set arrives separately as store.models.
  const cfg = $derived(store.composerConfig);
  // Show the friendly label (e.g. "Opus 4.8") in the badge, matching the Claude
  // app; fall back to the raw id before the model list arrives or if the active
  // model isn't in it. The raw provider:id stays available in the tooltip.
  const activeModel = $derived(
    store.models.find((m) => m.provider === cfg.provider && m.modelId === cfg.modelId),
  );
  const modelLabel = $derived(activeModel?.label ?? cfg.modelId ?? "model");
  const modelTitle = $derived(
    cfg.modelId
      ? cfg.provider
        ? `${cfg.provider}:${cfg.modelId}`
        : cfg.modelId
      : "model",
  );
  const thinking = $derived(cfg.thinkingLevel);
  const levels = $derived(cfg.availableThinkingLevels ?? []);

  // Group the picker's models by provider, like pi-gui's selector. `pickerModels` is
  // filtered to favorites (when any are set), always keeping the active model visible.
  const groups = $derived.by(() => {
    const m = new Map<string, ModelOption[]>();
    for (const opt of store.pickerModels) {
      const arr = m.get(opt.provider);
      if (arr) arr.push(opt);
      else m.set(opt.provider, [opt]);
    }
    return [...m.entries()].map(([provider, items]) => ({ provider, items }));
  });

  const hasModels = $derived(store.models.length > 0);
  const filtering = $derived(store.modelDefaults.favorites.length > 0);

  // Filter-as-you-type search within the model menu (label / id / provider), since the
  // list grows quickly with many providers connected.
  let modelQuery = $state("");
  const mq = $derived(modelQuery.trim().toLowerCase());
  const filteredGroups = $derived.by(() => {
    if (!mq) return groups;
    const out: { provider: string; items: ModelOption[] }[] = [];
    for (const g of groups) {
      const items = g.items.filter(
        (m) =>
          m.label.toLowerCase().includes(mq) ||
          m.modelId.toLowerCase().includes(mq) ||
          m.provider.toLowerCase().includes(mq),
      );
      if (items.length > 0) out.push({ provider: g.provider, items });
    }
    return out;
  });
  // Per-provider collapse. The list grows long with many providers, so groups start
  // collapsed — only the active model's provider is seeded open (so your current pick stays
  // visible). A non-empty search query auto-expands every matching group.
  let expandedProviders = $state<Set<string>>(new Set());
  function isExpanded(provider: string): boolean {
    return mq !== "" || expandedProviders.has(provider);
  }
  function toggleProvider(provider: string): void {
    const next = new Set(expandedProviders);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    expandedProviders = next;
    sel = 0; // the visible list changed; keep the highlight valid
  }
  // Flat list of the VISIBLE model rows (expanded groups only), in render order —
  // arrow-key navigation walks this, and `sel` indexes into it.
  const flatModelItems = $derived(
    filteredGroups.flatMap((g) => (isExpanded(g.provider) ? g.items : [])),
  );

  // Keyboard-highlight index into the open menu's item list (model rows or levels).
  let sel = $state(0);
  // Element handles for focus management + scroll-into-view.
  let searchEl = $state<HTMLInputElement>();
  let modelPanelEl = $state<HTMLDivElement>();
  let thinkingPanelEl = $state<HTMLDivElement>();
  // Whether the open menu was opened via its hotkey. Gates returning focus to the
  // composer on close, so a plain mouse/tap interaction never pops up the keyboard.
  let openedViaKeyboard = false;

  // Clear the query whenever the model menu closes, so it's fresh on next open.
  $effect(() => {
    if (open !== "model") modelQuery = "";
  });
  // Seed the active model's provider open whenever the menu opens (so your current pick is
  // visible); everything else starts collapsed. Falls back to the first group if no active
  // provider. Picking a model closes the menu first, so this never re-collapses mid-use.
  $effect(() => {
    if (open !== "model") return;
    // A favorites-filtered or single-provider list is already short — collapsing it would
    // hide the very models you curated (or leave just a lone header), so expand everything.
    if (filtering || groups.length <= 1) {
      expandedProviders = new Set(groups.map((g) => g.provider));
    } else {
      const seed = cfg.provider || groups[0]?.provider;
      expandedProviders = new Set(seed ? [seed] : []);
    }
  });
  // Keep the highlight in range as filtering/collapsing shrinks the model list under the
  // cursor. Gated to the model menu: `sel` is shared with the thinking menu, and the model
  // list can now be empty (all providers collapsed), which would otherwise clamp the
  // thinking highlight to 0.
  $effect(() => {
    if (open === "model" && sel >= flatModelItems.length) sel = 0;
  });
  // Scroll the keyboard-highlighted model row into view as the user arrows past the fold.
  $effect(() => {
    if (open !== "model") return;
    sel;
    tick().then(() =>
      modelPanelEl?.querySelector(".item.hl")?.scrollIntoView({ block: "nearest" }),
    );
  });

  function focusMenu(which: "model" | "thinking"): void {
    if (which === "model") searchEl?.focus();
    else thinkingPanelEl?.focus();
  }

  function openMenu(which: "model" | "thinking", viaKeyboard: boolean): void {
    open = which;
    openedViaKeyboard = viaKeyboard;
    // Start on the active level for thinking (so Enter is a no-op until you move);
    // start at the top for models.
    sel = which === "thinking" ? Math.max(0, thinking ? levels.indexOf(thinking) : 0) : 0;
    if (viaKeyboard) tick().then(() => focusMenu(which));
  }

  function closeMenu(refocus: boolean): void {
    open = "none";
    openedViaKeyboard = false;
    if (refocus) store.focusComposer();
  }

  function toggle(which: "model" | "thinking", viaKeyboard = false): void {
    if (open === which) closeMenu(viaKeyboard);
    else openMenu(which, viaKeyboard);
  }

  // React to global hotkeys dispatched from StatusHeader via the store.
  let lastHotkeyN = $state(0);
  $effect(() => {
    const hk = store.hotkeyAction;
    if (hk && hk.n !== lastHotkeyN) {
      lastHotkeyN = hk.n;
      toggle(hk.which, true);
    }
  });

  function pickModel(provider: string, modelId: string, refocus: boolean): void {
    if (!(provider === cfg.provider && modelId === cfg.modelId))
      store.setModel(provider, modelId);
    closeMenu(refocus);
  }
  function pickThinking(level: string, refocus: boolean): void {
    if (level !== thinking) store.setThinking(level);
    closeMenu(refocus);
  }

  function onModelKeydown(e: KeyboardEvent): void {
    const n = flatModelItems.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      if (n) sel = (sel + 1) % n;
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      if (n) sel = (sel - 1 + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = flatModelItems[sel];
      if (it) pickModel(it.provider, it.modelId, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    }
  }

  function onThinkingKeydown(e: KeyboardEvent): void {
    const n = levels.length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      if (n) sel = (sel + 1) % n;
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      if (n) sel = (sel - 1 + n) % n;
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const lvl = levels[sel];
      if (lvl) pickThinking(lvl, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // The thinking panel (a focused div, not an input) would otherwise let a bare
      // printable key bubble to the composer's type-to-focus handler, yanking focus
      // out of the open menu. Swallow it — the menu has nothing to type into.
      e.stopPropagation();
    }
  }
</script>

<div class="mp">
  {#if hasModels || cfg.modelId}
    <div class="anchor">
      <button
        class="badge"
        title={modelTitle + " (⌘⇧M)"}
        disabled={!hasModels}
        onclick={() => toggle("model")}
        data-testid="model-badge"
      >
        <span class="badge-text">{modelLabel}</span>
        {#if hasModels}<Chevron open={open === "model"} variant="menu" size={10} />{/if}
      </button>
      {#if open === "model"}
        <div class="panel" bind:this={modelPanelEl}>
          <input
            class="model-search"
            type="text"
            placeholder="Search models…"
            title="Filter models by name, id, or provider (↑↓ to move · ↵ select · esc cancel)"
            aria-label="Search models"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            bind:this={searchEl}
            bind:value={modelQuery}
            oninput={() => (sel = 0)}
            onkeydown={onModelKeydown}
          />
          {#each filteredGroups as g (g.provider)}
            {@const expanded = isExpanded(g.provider)}
            <button
              class="group-title"
              type="button"
              aria-expanded={expanded}
              title={expanded
                ? `Collapse ${g.provider}`
                : `Expand ${g.provider} (${g.items.length} model${g.items.length === 1 ? "" : "s"})`}
              onclick={() => toggleProvider(g.provider)}
            >
              <Chevron open={expanded} size={10} />
              <span class="group-name">{g.provider}</span>
              <span class="group-count">{g.items.length}</span>
            </button>
            {#if expanded}
              {#each g.items as opt (opt.modelId)}
                {@const active =
                  opt.provider === cfg.provider && opt.modelId === cfg.modelId}
                <button
                  class="item"
                  class:active
                  class:hl={flatModelItems[sel] === opt}
                  title={active ? `${opt.label} (current model)` : `Switch to ${opt.label}`}
                  onclick={() => pickModel(opt.provider, opt.modelId, openedViaKeyboard)}
                >
                  <span class="item-label">{opt.label}</span>
                  {#if active}
                    <span class="item-meta"
                      >active{#if filtering && !store.isFavorite(opt.provider, opt.modelId)}<span
                          class="off"
                          title="Not in favorites — switch from Settings to manage the list"
                          > · not favorited</span
                        >{/if}</span
                    >
                  {/if}
                </button>
              {/each}
            {/if}
          {/each}
          {#if filteredGroups.length === 0}
            <div class="model-empty">No models match</div>
          {:else}
            <div class="kbd-hint">↑↓ move · ↵ select · esc cancel</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if thinking}
    <div class="anchor">
      <button class="badge" title="Thinking level (⌘⇧E)" onclick={() => toggle("thinking")} data-testid="thinking-badge">
        <span class="badge-text">{thinking}</span>
        {#if levels.length > 0}<Chevron open={open === "thinking"} variant="menu" size={10} />{/if}
      </button>
      {#if open === "thinking" && levels.length > 0}
        <!-- Focusable container (tabindex -1) so the hotkey lands keyboard focus here
             and arrow/enter/esc drive the list. -->
        <div
          class="panel"
          role="listbox"
          tabindex="-1"
          aria-label="Thinking level"
          bind:this={thinkingPanelEl}
          onkeydown={onThinkingKeydown}
        >
          <div class="group-title">Thinking</div>
          {#each levels as lvl, i (lvl)}
            <button
              class="item"
              class:active={lvl === thinking}
              class:hl={sel === i}
              role="option"
              aria-selected={sel === i}
              title={lvl === thinking ? `Thinking: ${lvl} (current)` : `Set thinking level to ${lvl}`}
              onclick={() => pickThinking(lvl, openedViaKeyboard)}
            >
              <span class="item-label">{lvl}</span>
              {#if lvl === thinking}<span class="item-meta">active</span>{/if}
            </button>
          {/each}
          <div class="kbd-hint">↑↓ move · ↵ select · esc cancel</div>
        </div>
      {/if}
    </div>
  {/if}

  {#if open !== "none"}
    <button class="backdrop" aria-label="Close model menu" onclick={() => closeMenu(openedViaKeyboard)}
    ></button>
  {/if}
</div>

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
    /* Sans (not mono) to match the Claude app, where model/effort read as UI
       labels rather than raw IDs. Slight negative tracking tightens the label. */
    font-family: var(--font-sans);
    letter-spacing: -0.01em;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 3px 9px;
    border-radius: 999px;
    cursor: pointer;
    max-width: 42vw;
  }
  .badge:disabled {
    cursor: default;
  }
  .badge-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 40;
    cursor: default;
  }
  .panel:focus {
    /* The keyboard highlight (.item.hl) shows position; the container's own focus
       ring would just be noise. */
    outline: none;
  }
  .panel {
    position: absolute;
    /* Opens UPWARD: the picker lives in the composer footer at the bottom of the
       viewport, so a downward panel would fall off-screen. */
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 50;
    width: max(180px, 100%);
    max-height: 60vh;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 4px;
  }
  .model-search {
    width: 100%;
    box-sizing: border-box;
    font-size: 12.5px;
    color: var(--text);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    margin-bottom: 4px;
  }
  .model-search:focus {
    outline: none;
    border-color: var(--accent);
  }
  .model-empty {
    padding: 8px;
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
  }
  .group-title {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px 5px;
    background: none;
    border: 0;
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .group-title:hover {
    color: var(--text-muted);
  }
  .group-title:hover :global(.chevron),
  .group-title:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  .group-title:focus-visible {
    outline: none;
    color: var(--text);
    border-radius: var(--radius-xs);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .group-name {
    flex: 1;
    text-align: left;
  }
  .group-count {
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    padding: 7px 8px;
    cursor: pointer;
    color: var(--text);
  }
  .item:hover {
    background: var(--surface-sunken);
  }
  .item.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  /* Keyboard highlight — a ring rather than a fill, so it reads clearly even on the
     active row (which already has the accent-tinted background). */
  .item.hl {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .item-label {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item-meta {
    font-size: 11px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .off {
    color: var(--text-faint);
  }
  .kbd-hint {
    padding: 6px 8px 3px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
    text-align: center;
  }
</style>
