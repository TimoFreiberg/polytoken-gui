<script lang="ts">
  import { onDestroy } from "svelte";
  import { store } from "../lib/store.svelte.js";
  import { PERMISSION_MODES } from "../lib/composer-controls.js";

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();
  const cfg = $derived(store.composerConfig);
  const usage = $derived(store.draft ? undefined : store.session.usage);
  const models = $derived(store.pickerModels);
  let modelQuery = $state("");
  const filteredModels = $derived.by(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return models;
    return models.filter(
      (model) =>
        model.label.toLowerCase().includes(query) ||
        model.modelId.toLowerCase().includes(query) ||
        model.provider.toLowerCase().includes(query),
    );
  });
  const groupedModels = $derived.by(() => {
    const groups = new Map<string, typeof filteredModels>();
    for (const model of filteredModels) {
      const group = groups.get(model.provider);
      if (group) group.push(model);
      else groups.set(model.provider, [model]);
    }
    return [...groups.entries()];
  });

  const ARM_TIMEOUT = 3000;
  let armed = $state<"compact" | "clear" | null>(null);
  let armTimer: ReturnType<typeof setTimeout> | null = null;

  function disarm(): void {
    armed = null;
    if (armTimer) clearTimeout(armTimer);
    armTimer = null;
  }

  function runContextAction(action: "compact" | "clear"): void {
    if (armed === action) {
      disarm();
      if (action === "compact") store.compact();
      else store.clearContext();
      return;
    }
    disarm();
    armed = action;
    armTimer = setTimeout(disarm, ARM_TIMEOUT);
  }

  onDestroy(disarm);

  function fmt(n: number): string {
    return n.toLocaleString("en-US");
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }}
/>

<div
  class="mobile-session-controls"
  role="dialog"
  aria-modal="true"
  aria-labelledby="mobile-session-controls-title"
  data-testid="mobile-session-controls"
>
  <header class="topbar">
    <button
      class="back"
      type="button"
      onclick={onclose}
      title="Close session controls"
    >
      <span aria-hidden="true">←</span>
      <span>Back</span>
    </button>
    <h2 id="mobile-session-controls-title">Session controls</h2>
    <span class="topbar-spacer" aria-hidden="true"></span>
  </header>

  <div class="content">
    <fieldset>
      <legend>Permission mode</legend>
      <p class="section-help">
        Choose when Pantoken should ask before tools run.
      </p>
      <div class="choices">
        {#each PERMISSION_MODES as option (option.id)}
          <label class:active={store.composerPermissionMonitor === option.id}>
            <span class="choice-copy">
              <span class="choice-title">{option.label}</span>
              <span class="choice-detail">{option.desc}</span>
            </span>
            <input
              type="radio"
              name="mobile-permission"
              value={option.id}
              title={`Set permission mode to ${option.label}`}
              checked={store.composerPermissionMonitor === option.id}
              onchange={() => store.setPermissionMonitor(option.id)}
            />
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend>Facet</legend>
      <p class="section-help">Set how the agent approaches this session.</p>
      <div class="choices compact">
        {#each store.facets as facet (facet)}
          {@const label = facet.charAt(0).toUpperCase() + facet.slice(1)}
          <label class:active={store.composerFacet === facet}>
            <span class="choice-title">{label}</span>
            <input
              type="radio"
              name="mobile-facet"
              value={facet}
              title={`Set facet to ${label}`}
              checked={store.composerFacet === facet}
              onchange={() => store.setFacet(facet)}
            />
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend>Model</legend>
      <p class="section-help">Choose the model for the next response.</p>
      {#if models.length > 1}
        <input
          class="model-search"
          type="search"
          bind:value={modelQuery}
          placeholder="Search models…"
          aria-label="Search models"
          title="Search models"
          autocomplete="off"
        />
      {/if}
      <div class="model-groups">
        {#each groupedModels as [provider, items] (provider)}
          <div class="provider">
            <h3>{provider}</h3>
            <div class="choices compact">
              {#each items as model (`${model.provider}:${model.modelId}`)}
                <label
                  class:active={cfg.provider === model.provider &&
                    cfg.modelId === model.modelId}
                >
                  <span class="choice-copy">
                    <span class="choice-title">{model.label}</span>
                    <span class="choice-detail">{model.modelId}</span>
                  </span>
                  <input
                    type="radio"
                    name="mobile-model"
                    value={`${model.provider}:${model.modelId}`}
                    title={`Set model to ${model.label}`}
                    checked={cfg.provider === model.provider &&
                      cfg.modelId === model.modelId}
                    onchange={() =>
                      store.setModel(
                        model.provider,
                        model.modelId,
                        model.defaultThinkingLevel,
                      )}
                  />
                </label>
              {/each}
            </div>
          </div>
        {:else}
          <p class="empty">No models match “{modelQuery}”.</p>
        {/each}
      </div>
    </fieldset>

    {#if (cfg.availableThinkingLevels?.length ?? 0) > 0}
      <fieldset>
        <legend>Thinking level</legend>
        <p class="section-help">
          Choose how much reasoning the model should use.
        </p>
        <div class="choices compact">
          {#each cfg.availableThinkingLevels ?? [] as level (level)}
            <label class:active={cfg.thinkingLevel === level}>
              <span class="choice-title"
                >{level.charAt(0).toUpperCase() + level.slice(1)}</span
              >
              <input
                type="radio"
                name="mobile-thinking"
                value={level}
                title={`Set thinking level to ${level}`}
                checked={cfg.thinkingLevel === level}
                onchange={() => store.setThinking(level)}
              />
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    {#if usage}
      <section class="context-section" aria-labelledby="mobile-context-title">
        <h2 id="mobile-context-title">Context window</h2>
        {#if usage.tokens === null}
          <p class="context-detail">Context size pending</p>
          <p class="section-help">
            Recomputed after the next response · {fmt(usage.contextWindow)} token
            window
          </p>
        {:else}
          <p class="context-detail">
            {fmt(usage.tokens)} / {fmt(usage.contextWindow)} tokens
          </p>
          <div class="context-bar" aria-hidden="true">
            <span style={`width: ${Math.min(100, usage.percent ?? 0)}%`}></span>
          </div>
          <p class="section-help">
            {Math.round(usage.percent ?? 0)}% of the context window used
          </p>
        {/if}
        <div class="context-actions">
          <button
            type="button"
            class:armed={armed === "compact"}
            onclick={() => runContextAction("compact")}
            title={armed === "compact"
              ? "Tap again to compact context"
              : "Compact context"}
            >{armed === "compact"
              ? "Tap again to compact"
              : "Compact context"}</button
          >
          <button
            type="button"
            class="danger"
            class:armed={armed === "clear"}
            onclick={() => runContextAction("clear")}
            title={armed === "clear"
              ? "Tap again to clear context"
              : "Clear context"}
            >{armed === "clear"
              ? "Tap again to clear"
              : "Clear context"}</button
          >
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .mobile-session-controls {
    display: none;
  }

  @media (max-width: 859px) {
    .mobile-session-controls {
      position: fixed;
      inset: 0;
      z-index: 190;
      display: flex;
      flex-direction: column;
      min-width: 0;
      background: var(--bg);
      color: var(--text);
    }
    .topbar {
      flex: none;
      display: grid;
      grid-template-columns: minmax(76px, 1fr) auto minmax(76px, 1fr);
      align-items: center;
      min-height: calc(54px + env(safe-area-inset-top));
      padding: env(safe-area-inset-top) 10px 0;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .topbar h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 650;
    }
    .back {
      justify-self: start;
      min-width: 72px;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      border: 0;
      border-radius: var(--radius-xs);
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 14px;
    }
    .back:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .topbar-spacer {
      min-width: 72px;
    }
    .content {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 22px 16px calc(28px + env(safe-area-inset-bottom));
    }
    fieldset,
    .context-section {
      max-width: 640px;
      margin: 0 auto 28px;
      padding: 0;
      border: 0;
    }
    legend,
    .context-section h2 {
      padding: 0;
      margin: 0;
      font-size: 17px;
      font-weight: 650;
    }
    .section-help,
    .context-detail {
      margin: 5px 0 12px;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .context-detail {
      color: var(--text);
      font-size: 14px;
    }
    .choices {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface);
    }
    .choices label {
      min-height: 58px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 13px;
      border-bottom: 1px solid var(--border);
    }
    .choices label:last-child {
      border-bottom: 0;
    }
    .choices label.active {
      background: var(--accent-soft);
    }
    .choices.compact label {
      min-height: 50px;
    }
    .choices.compact > label > .choice-title {
      flex: 1;
    }
    .choice-copy {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .choice-title {
      font-size: 14px;
      font-weight: 560;
      text-transform: none;
    }
    .choice-detail {
      font-size: 12px;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }
    input[type="radio"] {
      flex: none;
      width: 20px;
      height: 20px;
      accent-color: var(--accent);
    }
    .model-search {
      width: 100%;
      min-height: 48px;
      margin-bottom: 12px;
      padding: 0 13px;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      font: inherit;
      font-size: 16px;
    }
    .model-search:focus {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .provider + .provider {
      margin-top: 16px;
    }
    .provider h3 {
      margin: 0 0 7px 3px;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .empty {
      color: var(--text-muted);
      font-size: 14px;
    }
    .context-bar {
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--surface-sunken);
    }
    .context-bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }
    .context-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 14px;
    }
    .context-actions button {
      min-height: 48px;
      padding: 8px 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: var(--surface);
      color: var(--text);
      font: inherit;
      font-size: 13px;
    }
    .context-actions button.armed {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .context-actions button.danger {
      color: var(--danger);
    }
    .context-actions button.danger.armed {
      border-color: var(--danger);
      background: var(--danger-soft);
    }
  }
</style>
