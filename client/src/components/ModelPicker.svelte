<script lang="ts">
  import type { ModelOption } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";

  type Open = "none" | "model" | "thinking";
  let open = $state<Open>("none");

  // Current selection lives in the folded session config (server-authoritative);
  // the switchable set arrives separately as store.models.
  const cfg = $derived(store.session.config);
  const modelLabel = $derived(cfg.modelId ?? "model");
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

  function toggle(which: "model" | "thinking"): void {
    open = open === which ? "none" : which;
  }
  function pickModel(provider: string, modelId: string): void {
    if (!(provider === cfg.provider && modelId === cfg.modelId))
      store.setModel(provider, modelId);
    open = "none";
  }
  function pickThinking(level: string): void {
    if (level !== thinking) store.setThinking(level);
    open = "none";
  }
</script>

<div class="mp">
  {#if hasModels || cfg.modelId}
    <div class="anchor">
      <button
        class="badge"
        title={cfg.provider ? `${cfg.provider}:${modelLabel}` : modelLabel}
        disabled={!hasModels}
        onclick={() => toggle("model")}
      >
        <span class="badge-text">{modelLabel}</span>
        {#if hasModels}<span class="chev" class:up={open === "model"}>▾</span>{/if}
      </button>
      {#if open === "model"}
        <div class="panel">
          {#each groups as g (g.provider)}
            <div class="group-title">{g.provider}</div>
            {#each g.items as opt (opt.modelId)}
              {@const active =
                opt.provider === cfg.provider && opt.modelId === cfg.modelId}
              <button
                class="item"
                class:active
                onclick={() => pickModel(opt.provider, opt.modelId)}
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
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if thinking}
    <div class="anchor">
      <button class="badge" title="Thinking level" onclick={() => toggle("thinking")}>
        <span class="badge-text">{thinking}</span>
        {#if levels.length > 0}<span class="chev" class:up={open === "thinking"}>▾</span>{/if}
      </button>
      {#if open === "thinking" && levels.length > 0}
        <div class="panel">
          <div class="group-title">Thinking</div>
          {#each levels as lvl (lvl)}
            <button
              class="item"
              class:active={lvl === thinking}
              onclick={() => pickThinking(lvl)}
            >
              <span class="item-label">{lvl}</span>
              {#if lvl === thinking}<span class="item-meta">active</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if open !== "none"}
    <button class="backdrop" aria-label="Close model menu" onclick={() => (open = "none")}
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
  .chev {
    color: var(--text-faint);
    font-size: 10px;
    transition: transform 0.12s ease;
  }
  .chev.up {
    transform: rotate(180deg);
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
    top: calc(100% + 6px);
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
  .group-title {
    padding: 6px 8px 3px;
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
</style>
