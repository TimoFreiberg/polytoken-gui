<script lang="ts">
  import type { ModelOption } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import type { ThemeMode } from "../lib/theme.js";

  // A per-client settings panel (D5 view state): theme, notifications, the read-only
  // model/provider overview, and this device's access token. Provider credential
  // editing (writing pi's auth files) is a deferred server-side follow-up — see TODO.

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

  // Read-only model overview. Current selection lives in the folded session config;
  // the switchable set arrives as store.models. Switching happens in the header picker.
  const cfg = $derived(store.session.config);
  const groups = $derived.by(() => {
    const m = new Map<string, ModelOption[]>();
    for (const opt of store.models) {
      const arr = m.get(opt.provider);
      if (arr) arr.push(opt);
      else m.set(opt.provider, [opt]);
    }
    return [...m.entries()].map(([provider, items]) => ({ provider, items }));
  });

  let tokenDraft = $state("");

  function close(): void {
    store.closeSettings();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) close();
  }
  function saveToken(): void {
    const t = tokenDraft.trim();
    if (!t) return;
    store.changeToken(t);
    tokenDraft = "";
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
                onclick={() => store.enablePush()}
              >
                {push === "subscribed" ? "Enabled" : "Enable"}
              </button>
              <button
                class="btn ghost"
                disabled={push === "working"}
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

      <!-- Models -->
      <section class="group">
        <div class="gtitle">Model</div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Current</div>
            <div class="rdesc mono">
              {cfg.provider ? `${cfg.provider} · ` : ""}{cfg.modelId ?? "—"}
            </div>
          </div>
          {#if cfg.thinkingLevel}
            <span class="pill">thinking: {cfg.thinkingLevel}</span>
          {/if}
        </div>
        {#if groups.length > 0}
          <div class="rdesc available">Available — switch from the header:</div>
          <div class="models">
            {#each groups as g (g.provider)}
              <div class="mprovider">{g.provider}</div>
              {#each g.items as opt (opt.modelId)}
                <div
                  class="mitem"
                  class:active={opt.provider === cfg.provider &&
                    opt.modelId === cfg.modelId}
                >
                  <span class="mlabel">{opt.label}</span>
                  {#if opt.provider === cfg.provider && opt.modelId === cfg.modelId}
                    <span class="mmeta">active</span>
                  {/if}
                </div>
              {/each}
            {/each}
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
            <button class="btn danger" onclick={() => store.signOut()}>Forget</button>
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
          <button class="btn" type="submit" disabled={!tokenDraft.trim()}>Save</button>
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
  .rdesc.mono {
    font-family: var(--font-mono);
    color: var(--text);
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
  .pill {
    flex-shrink: 0;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 9px;
  }
  .available {
    margin: 12px 0 6px;
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
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--radius-xs);
  }
  .mitem.active {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .mlabel {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mmeta {
    font-size: 11px;
    color: var(--accent);
    flex-shrink: 0;
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
