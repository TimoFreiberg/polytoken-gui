<script lang="ts">
  import type { ModelOption } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import type { ThemeMode } from "../lib/theme.js";

  // The settings panel. Per-client view state (theme, notifications, this device's
  // access token) sits next to server-side global pi config (provider credentials,
  // default model/thinking, favorites) which travels the WS and persists in pi.

  const open = $derived(store.settingsOpen);

  const THEMES: { mode: ThemeMode; label: string }[] = [
    { mode: "system", label: "System" },
    { mode: "light", label: "Light" },
    { mode: "dark", label: "Dark" },
  ];

  // Push status copy mirrors the header bell so the two stay in step.
  const push = $derived(store.pushState);
  const pushStatus: Record<string, string> = {
    working: "Subscribing…",
    idle: "Not enabled on this device",
    subscribed: "Enabled on this device",
    denied: "Blocked — enable in your browser/iOS settings",
    "needs-install": "Add to Home Screen first, then re-open and enable",
    error: "Couldn't subscribe — tap retry (see console)",
    unsupported: "Not supported on this device",
  };

  // Provider credentials + global model config (server-authoritative).
  const providers = $derived(store.providers);
  const defaults = $derived(store.modelDefaults);

  // Available models grouped by provider — drives both the default-model select and
  // the favorites checklist.
  const groups = $derived.by(() => {
    const m = new Map<string, ModelOption[]>();
    for (const opt of store.models) {
      const arr = m.get(opt.provider);
      if (arr) arr.push(opt);
      else m.set(opt.provider, [opt]);
    }
    return [...m.entries()].map(([provider, items]) => ({ provider, items }));
  });

  // Filter-as-you-type search for the favorites list (it grows with every provider).
  let favQuery = $state("");
  const fq = $derived(favQuery.trim().toLowerCase());
  const favGroups = $derived.by(() => {
    if (!fq) return groups;
    const out: { provider: string; items: ModelOption[] }[] = [];
    for (const g of groups) {
      const items = g.items.filter(
        (m) =>
          m.label.toLowerCase().includes(fq) ||
          m.modelId.toLowerCase().includes(fq) ||
          m.provider.toLowerCase().includes(fq),
      );
      if (items.length > 0) out.push({ provider: g.provider, items });
    }
    return out;
  });

  // pi's setDefaultThinkingLevel accepts this fixed union (independent of the current
  // model's supported levels — it's the default for whatever new session is created).
  const DEFAULT_THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const;

  const sourceLabel: Record<string, string> = {
    none: "Not connected",
    oauth: "Connected · OAuth",
    auth_file: "Connected · API key",
    env: "Connected · env var",
    external: "Connected · external config",
  };

  // API-key entry: which provider's field is expanded + its draft (write-only; a saved
  // key is never sent back to the client).
  let keyProviderId = $state<string | null>(null);
  let keyDraft = $state("");
  let tokenDraft = $state("");

  function close(): void {
    store.closeSettings();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      close();
      return;
    }
    // ⌘+, / Ctrl+, — the standard "open preferences" shortcut. Toggles the panel
    // so the keyboard can both summon and dismiss it.
    if ((e.metaKey || e.ctrlKey) && e.key === "," && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (open) close();
      else store.openSettings();
    }
  }
  function saveToken(): void {
    const t = tokenDraft.trim();
    if (!t) return;
    store.changeToken(t);
    tokenDraft = "";
  }
  function openKeyField(id: string): void {
    keyProviderId = id;
    keyDraft = "";
  }
  function cancelKeyField(): void {
    keyProviderId = null;
    keyDraft = "";
  }
  function saveKey(): void {
    const id = keyProviderId;
    const k = keyDraft.trim();
    if (!id || !k) return;
    store.setProviderApiKey(id, k);
    keyProviderId = null;
    keyDraft = "";
  }
  function onDefaultModel(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    const i = v.indexOf(":");
    if (i < 0) return;
    store.setDefaultModel(v.slice(0, i), v.slice(i + 1));
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    data-testid="settings-panel"
  >
    <header class="phead">
      <h2>Settings</h2>
      <button class="x" aria-label="Close settings" onclick={close}>✕</button>
    </header>

    <div class="body">
      <!-- Appearance -->
      <section class="group">
        <div class="gtitle">Appearance</div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Theme</div>
            <div class="rdesc">"System" follows your OS appearance.</div>
          </div>
          <div class="seg" role="radiogroup" aria-label="Theme">
            {#each THEMES as t (t.mode)}
              <button
                class="seg-btn"
                class:active={store.themeMode === t.mode}
                role="radio"
                aria-checked={store.themeMode === t.mode}
                data-testid="theme-{t.mode}"
                title={`Use ${t.label} theme`}
                onclick={() => store.setTheme(t.mode)}>{t.label}</button
              >
            {/each}
          </div>
        </div>
      </section>

      <!-- Notifications -->
      <section class="group">
        <div class="gtitle">Notifications</div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Push on this device</div>
            <div class="rdesc">{pushStatus[push] ?? push}</div>
          </div>
          {#if push !== "unsupported"}
            <div class="actions">
              <button
                class="btn"
                disabled={push === "working" || push === "subscribed"}
                title="Enable push notifications on this device"
                onclick={() => store.enablePush()}
              >
                {push === "subscribed" ? "Enabled" : "Enable"}
              </button>
              <button
                class="btn ghost"
                disabled={push === "working"}
                title="Send a test push notification to this device"
                onclick={() => store.testPush()}>Test</button
              >
            </div>
          {/if}
        </div>
        <p class="note">
          The agent buzzes this device when a turn finishes or needs your input. A
          backgrounded tab uses Web Notifications; a closed phone uses Web Push (iOS
          requires Add-to-Home-Screen first).
        </p>
      </section>

      <!-- Providers -->
      <section class="group">
        <div class="gtitle">Providers</div>
        {#if providers.length === 0}
          <p class="note">No providers reported by the server.</p>
        {:else}
          <div class="providers">
            {#each providers as p (p.id)}
              <div class="prow" data-testid="provider-{p.id}">
                <div class="rinfo">
                  <div class="rlabel">{p.name}</div>
                  <div class="rdesc" class:connected={p.hasAuth}>
                    {sourceLabel[p.authSource] ??
                      (p.hasAuth ? "Connected" : "Not connected")}
                  </div>
                </div>
                <div class="actions">
                  {#if p.apiKeySetupSupported}
                    <button
                      class="btn ghost"
                      title={p.authSource === "auth_file"
                        ? `Replace the API key for ${p.name}`
                        : `Set an API key for ${p.name}`}
                      onclick={() => openKeyField(p.id)}
                    >
                      {p.authSource === "auth_file" ? "Replace key" : "Set key"}
                    </button>
                  {/if}
                  {#if p.authSource === "auth_file"}
                    <button
                      class="btn danger"
                      title={`Remove the saved API key for ${p.name}`}
                      onclick={() => store.removeProviderApiKey(p.id)}
                    >
                      Remove
                    </button>
                  {/if}
                </div>
              </div>
              {#if keyProviderId === p.id}
                <form
                  class="keyform"
                  onsubmit={(e) => {
                    e.preventDefault();
                    saveKey();
                  }}
                >
                  <input
                    bind:value={keyDraft}
                    type="password"
                    placeholder="Enter API key…"
                    autocomplete="off"
                    data-testid="provider-key-input"
                  />
                  <button class="btn" type="submit" title="Save this API key" disabled={!keyDraft.trim()}>Save</button>
                  <button class="btn ghost" type="button" title="Cancel without saving the key" onclick={cancelKeyField}>Cancel</button>
                </form>
              {/if}
            {/each}
          </div>
          <p class="note">
            Keys save into pi's <code>auth.json</code> on the server — shared with the
            terminal <code>pi</code> on this machine. Providers configured via environment
            variables show as connected but aren't editable here.
          </p>
        {/if}
      </section>

      <!-- Models -->
      <section class="group">
        <div class="gtitle">Models</div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Default model</div>
            <div class="rdesc">
              For new sessions. Switch the current session from the header.
            </div>
          </div>
          <select
            class="select"
            data-testid="default-model"
            onchange={onDefaultModel}
            value={defaults.provider && defaults.modelId
              ? `${defaults.provider}:${defaults.modelId}`
              : ""}
          >
            <option value="">Choose…</option>
            {#each groups as g (g.provider)}
              <optgroup label={g.provider}>
                {#each g.items as opt (opt.modelId)}
                  <option value={`${opt.provider}:${opt.modelId}`}>{opt.label}</option>
                {/each}
              </optgroup>
            {/each}
          </select>
        </div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Default thinking</div>
            <div class="rdesc">Reasoning level for new sessions.</div>
          </div>
          <select
            class="select"
            data-testid="default-thinking"
            value={defaults.thinkingLevel ?? ""}
            onchange={(e) =>
              store.setDefaultThinking((e.target as HTMLSelectElement).value)}
          >
            <option value="" disabled>Choose…</option>
            {#each DEFAULT_THINKING_LEVELS as lvl (lvl)}
              <option value={lvl}>{lvl}</option>
            {/each}
          </select>
        </div>

        <div class="rdesc available">
          Favorites — the header picker shows only these (none = show all):
        </div>
        {#if groups.length === 0}
          <p class="note">No models available — connect a provider above.</p>
        {:else}
          <input
            class="fav-search"
            type="text"
            placeholder="Search models…"
            title="Filter the model list by name, id, or provider"
            aria-label="Search models"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            bind:value={favQuery}
          />
          <div class="models">
            {#each favGroups as g (g.provider)}
              <div class="mprovider">{g.provider}</div>
              {#each g.items as opt (opt.modelId)}
                <label class="mitem fav" data-testid="fav-{opt.provider}-{opt.modelId}">
                  <input
                    type="checkbox"
                    checked={store.isFavorite(opt.provider, opt.modelId)}
                    onchange={() => store.toggleFavorite(opt.provider, opt.modelId)}
                  />
                  <span class="mlabel">{opt.label}</span>
                </label>
              {/each}
            {/each}
            {#if favGroups.length === 0}
              <div class="mempty">No models match</div>
            {/if}
          </div>
        {/if}
      </section>

      <!-- Access token -->
      <section class="group">
        <div class="gtitle">Access token</div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">{store.hasToken ? "Saved on this device" : "No token saved"}</div>
            <div class="rdesc">
              The app-level token gates this server. Tailscale is the network ACL; this
              is the credential.
            </div>
          </div>
          {#if store.hasToken}
            <button class="btn danger" title="Forget the access token saved on this device" onclick={() => store.signOut()}>Forget</button>
          {/if}
        </div>
        <form
          class="tokenform"
          onsubmit={(e) => {
            e.preventDefault();
            saveToken();
          }}
        >
          <input
            bind:value={tokenDraft}
            type="password"
            placeholder={store.hasToken ? "Replace token…" : "Enter token…"}
            autocomplete="off"
          />
          <button class="btn" type="submit" title="Save this access token on this device" disabled={!tokenDraft.trim()}>Save</button>
        </form>
      </section>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 60;
    animation: fade 0.15s ease;
  }
  .panel {
    position: fixed;
    z-index: 61;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(540px, 100%);
    max-height: 88dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    box-shadow: var(--shadow-pop);
    animation: rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @media (min-width: 600px) {
    .panel {
      top: 50%;
      bottom: auto;
      transform: translate(-50%, -50%);
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .phead h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .x {
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
  }
  .x:hover {
    background: var(--surface-sunken);
    border-color: var(--border);
    color: var(--text);
  }
  .body {
    overflow-y: auto;
    padding: 4px 20px calc(20px + env(safe-area-inset-bottom));
  }
  .group {
    padding: 16px 0;
    border-bottom: 1px solid var(--border);
  }
  .group:last-child {
    border-bottom: none;
  }
  .gtitle {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
    margin-bottom: 10px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }
  .rinfo {
    min-width: 0;
  }
  .rlabel {
    font-size: 14px;
    color: var(--text);
  }
  .rdesc {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 2px;
    line-height: 1.45;
  }
  .rdesc.connected {
    color: var(--ok);
  }
  .note {
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1.5;
    margin: 10px 0 0;
  }
  .seg {
    display: inline-flex;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px;
    flex-shrink: 0;
  }
  .seg-btn {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 12.5px;
    padding: 5px 12px;
    border-radius: 999px;
    cursor: pointer;
  }
  .seg-btn.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-card);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .btn {
    border: 1px solid var(--border-strong);
    background: var(--accent);
    color: var(--accent-text);
    border-color: transparent;
    border-radius: var(--radius-sm);
    padding: 7px 13px;
    font-size: 13px;
    cursor: pointer;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn.ghost {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .btn.danger {
    background: transparent;
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    flex-shrink: 0;
  }
  .select {
    flex-shrink: 0;
    max-width: 58%;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 6px 9px;
    cursor: pointer;
  }
  .select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .available {
    margin: 12px 0 6px;
  }
  .fav-search {
    width: 100%;
    box-sizing: border-box;
    font-size: 12.5px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px 9px;
    margin-bottom: 6px;
  }
  .fav-search:focus {
    outline: none;
    border-color: var(--accent);
  }
  .mempty {
    padding: 8px;
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
  }
  .models {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 4px;
  }
  .mprovider {
    padding: 6px 8px 3px;
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .mitem {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border-radius: var(--radius-xs);
  }
  .mitem.fav {
    cursor: pointer;
  }
  .mitem.fav:hover {
    background: var(--surface-sunken);
  }
  .mitem input[type="checkbox"] {
    flex-shrink: 0;
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
  }
  .mlabel {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .providers {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .prow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
  }
  .keyform {
    display: flex;
    gap: 8px;
    margin: 2px 0 8px;
  }
  .keyform input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 9px 11px;
    font-size: 16px;
    background: var(--bg);
    color: var(--text);
    outline: none;
  }
  .keyform input:focus {
    border-color: var(--accent);
  }
  .tokenform {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .tokenform input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 9px 11px;
    font-size: 16px;
    background: var(--bg);
    color: var(--text);
    outline: none;
  }
  .tokenform input:focus {
    border-color: var(--accent);
  }
  @keyframes rise {
    from {
      transform: translateX(-50%) translateY(16px);
      opacity: 0;
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
