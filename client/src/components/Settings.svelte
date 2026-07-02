<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import type { ThemeMode } from "../lib/theme.js";
  import Button from "./ui/Button.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import SegmentedControl from "./ui/SegmentedControl.svelte";
  import { MAX_SCALE, MIN_SCALE, STEP } from "../lib/font-scale.js";

  // The settings panel. Per-client view state (theme, notifications, this device's
  // access token) sits next to server-side global agent config (provider credentials,
  // default model/thinking, favorites) which travels the WS and persists in the agent.

  const open = $derived(store.settingsOpen);

  // Section navigation. The panel is a left-rail of section tabs + a content pane
  // showing only the active section — so the long lists (Providers, Models+Favorites,
  // Extensions) each get their own scroll instead of crowding one. The rail labels ARE
  // the seven top-level section names, so every name stays visible (and reachable) the
  // moment the panel opens. On the phone bottom-sheet the rail reflows to a horizontal
  // scrollable strip (see the media query). Tabs are flat — not a drill-in stack — so
  // Escape closes the panel as before (section searches still clear on the first Esc).
  //
  // Active section persists across close/reopen AND reload, mirroring the app's other
  // per-device localStorage prefs (pilot.sidebarOpen, pilot.theme, …). So reopening
  // lands you on the section you last viewed — e.g. tweak an API key, Esc, reopen →
  // back on Providers. Defaults to Appearance when no pref is stored (or on SSR/tests).
  type SectionId =
    | "appearance"
    | "notifications"
    | "models"
    | "environment"
    | "mcp"
    | "token";
  const SECTIONS: { id: SectionId; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "notifications", label: "Notifications" },
    { id: "models", label: "Models" },
    { id: "environment", label: "Environment" },
    { id: "mcp", label: "MCP" },
    { id: "token", label: "Access token" },
  ];
  const ACTIVE_SECTION_KEY = "pilot.settingsSection";
  function initialSection(): SectionId {
    if (typeof window === "undefined") return "appearance";
    const stored = localStorage.getItem(ACTIVE_SECTION_KEY);
    return stored && SECTIONS.some((s) => s.id === stored)
      ? (stored as SectionId)
      : "appearance";
  }
  let activeSection = $state<SectionId>(initialSection());
  function setSection(id: SectionId): void {
    activeSection = id;
    if (typeof window !== "undefined")
      localStorage.setItem(ACTIVE_SECTION_KEY, id);
  }

  // Transcript text-size, shown as a percentage of the default. The hotkeys (⌘=/⌘-/⌘0)
  // and these buttons share store.bumpFontScale / resetFontScale.
  const fontPct = $derived(Math.round(store.fontScale * 100));

  const THEMES: { mode: ThemeMode; label: string }[] = [
    { mode: "system", label: "System" },
    { mode: "light", label: "Light" },
    { mode: "dark", label: "Dark" },
  ];
  // Shape THEMES for the SegmentedControl; keep the `theme-<mode>` testids the e2e relies on.
  const themeOptions = THEMES.map((t) => ({
    value: t.mode,
    label: t.label,
    title: `Use ${t.label} theme`,
    testid: `theme-${t.mode}`,
  }));

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

  // Environment: the login shell pilot captures your PATH/tools from at startup, the live
  // status of that capture, and whether a config change is still waiting on a restart.
  const loginEnv = $derived(store.loginEnv);
  const shellPending = $derived(store.loginShellPendingRestart);
  // Draft for the shell-path field; seeded from the configured value on panel open.
  let shellDraft = $state("");
  const shellDirty = $derived(
    shellDraft.trim() !== (store.pilotSettings.loginShell ?? ""),
  );
  function saveLoginShell(): void {
    store.setLoginShell(shellDraft.trim() || null);
  }
  function useDefaultShell(): void {
    shellDraft = "";
    store.setLoginShell(null);
  }

  // Background model: the cheap model spec pilot's own extensions run their out-of-band
  // LLM calls against (session auto-naming, the answer tool's structured-extraction).
  // A `provider/model[:thinking]` spec OR a `script:`-prefixed path. Draft seeded from
  // the server's configured value each open; the resolved `warning` (bad/unresolvable
  // spec) surfaces as a loud red error under the field.
  let bgModelDraft = $state("");
  const bgModelDirty = $derived(
    bgModelDraft.trim() !== (store.pilotSettings.backgroundModel ?? ""),
  );
  const bgModelWarning = $derived(store.backgroundModelWarning);
  function saveBackgroundModel(): void {
    store.setBackgroundModel(bgModelDraft.trim() || null);
  }
  function clearBackgroundModel(): void {
    bgModelDraft = "";
    store.setBackgroundModel(null);
  }

  // Re-seed the shell + background-model drafts on each open transition.
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      // Seed the login-shell field from the server's configured value each open.
      shellDraft = store.pilotSettings.loginShell ?? "";
      // Seed the background-model field likewise.
      bgModelDraft = store.pilotSettings.backgroundModel ?? "";
    }
    prevOpen = open;
  });

  let tokenDraft = $state("");

  function close(): void {
    store.closeSettings();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      close();
      return;
    }
    // Alt+1..6 — jump straight to a section tab (the rail order). Read e.code
    // ("Digit1".."Digit6") rather than e.key: on macOS Option+digit composes a glyph
    // (Option+1 → "¡"), so Number(e.key) is NaN and the shortcut would silently no-op
    // on the project's primary platform. e.code is the physical key, layout/OS-
    // independent. Safe even while a settings field is focused (model/shell/token
    // fields): Option+digit would compose a glyph there, but we preventDefault() on
    // the Digit1..6 match before it lands, swallowing the glyph and navigating
    // instead — so the shortcut never corrupts field text. noUncheckedIndexedAccess
    // makes SECTIONS[idx] `T | undefined`; the guard narrows it at runtime but not to
    // TS, so capture the element after the bound check.
    if (open && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const m = /^Digit([1-6])$/.exec(e.code);
      const target = m ? SECTIONS[Number(m[1]) - 1] : undefined;
      if (target) {
        e.preventDefault();
        setSection(target.id);
        return;
      }
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
      <IconButton title="Close settings" aria-label="Close settings" onclick={close}>✕</IconButton>
    </header>

    <div class="settings-shell">
      <!-- ARIA tabs: the rail is the tablist, each tab aria-controls the shared panel
           body below (which aria-labelledby points back to the active tab). Matches
           QnaForm's dot-tab pattern, completed with the panel-side wiring. -->
      <div
        class="settings-nav"
        role="tablist"
        aria-label="Settings sections"
      >
        {#each SECTIONS as s, i (s.id)}
          <button
            class="tab"
            type="button"
            id="settings-tab-{s.id}"
            role="tab"
            aria-selected={activeSection === s.id}
            aria-controls="settings-panel-body"
            data-testid="settings-tab-{s.id}"
            title={`${s.label} section (Alt+${i + 1})`}
            onclick={() => setSection(s.id)}
          >
            <span class="tab-label">{s.label}</span>
          </button>
        {/each}
      </div>

      <div
        class="body"
        id="settings-panel-body"
        role="tabpanel"
        aria-labelledby="settings-tab-{activeSection}"
      >
      <!-- Appearance -->
      {#if activeSection === "appearance"}
      <section class="group">
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Theme</div>
            <div class="rdesc">"System" follows your OS appearance.</div>
          </div>
          <SegmentedControl
            ariaLabel="Theme"
            options={themeOptions}
            value={store.themeMode}
            onchange={(mode) => store.setTheme(mode)}
          />
        </div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Text size</div>
            <div class="rdesc">Scales the conversation text. ⌘= / ⌘- / ⌘0.</div>
          </div>
          <div class="stepper" role="group" aria-label="Text size">
            <button
              class="step-btn"
              data-testid="font-smaller"
              title="Smaller text (⌘-)"
              aria-label="Smaller text"
              disabled={store.fontScale <= MIN_SCALE}
              onclick={() => store.bumpFontScale(-STEP)}>A−</button
            >
            <button
              class="step-btn val"
              data-testid="font-reset"
              title="Reset text size (⌘0)"
              aria-label="Reset text size"
              onclick={() => store.resetFontScale()}>{fontPct}%</button
            >
            <button
              class="step-btn"
              data-testid="font-larger"
              title="Larger text (⌘=)"
              aria-label="Larger text"
              disabled={store.fontScale >= MAX_SCALE}
              onclick={() => store.bumpFontScale(STEP)}>A+</button
            >
          </div>
        </div>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Hide older thinking blocks</div>
            <div class="rdesc">Collapse superseded reasoning; the most recent thinking block always shows (collapsed, expandable).</div>
          </div>
          <button
            class="seg-btn"
            class:active={store.hideThinking}
            role="switch"
            aria-checked={store.hideThinking}
            data-testid="hide-thinking"
            title={store.hideThinking ? "Show all thinking blocks" : "Hide older thinking blocks (most recent always shows)"}
            onclick={() => store.setHideThinking(!store.hideThinking)}
          >
            {store.hideThinking ? "On" : "Off"}
          </button>
        </div>
      </section>
      {/if}

      <!-- Notifications -->
      {#if activeSection === "notifications"}
      <section class="group">
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Push on this device</div>
            <div class="rdesc">{pushStatus[push] ?? push}</div>
          </div>
          {#if push !== "unsupported"}
            <div class="actions">
              <Button
                variant="primary"
                disabled={push === "working" || push === "subscribed"}
                title="Enable push notifications on this device"
                onclick={() => store.enablePush()}
              >
                {push === "subscribed" ? "Enabled" : "Enable"}
              </Button>
              <Button
                disabled={push === "working"}
                title="Send a test push notification to this device"
                onclick={() => store.testPush()}>Test</Button
              >
            </div>
          {/if}
        </div>
        <p class="note">
          The agent buzzes this device when a turn finishes or needs your input. A
          backgrounded tab uses Web Notifications; a closed phone uses Web Push (iOS
          requires Add-to-Home-Screen first).
        </p>
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Auto-drain notifications</div>
            <div class="rdesc">Automatically dismiss non-blocking notifications so they don't pile up.</div>
          </div>
          <button
            class="seg-btn"
            class:active={store.session.notificationAutodrain ?? false}
            role="switch"
            aria-checked={store.session.notificationAutodrain ?? false}
            data-testid="notification-autodrain"
            title={(store.session.notificationAutodrain ?? false) ? "Disable auto-drain" : "Enable auto-drain (auto-dismiss non-blocking notifications)"}
            onclick={() => store.setNotificationAutodrain(!(store.session.notificationAutodrain ?? false))}
          >
            {(store.session.notificationAutodrain ?? false) ? "On" : "Off"}
          </button>
        </div>
      </section>
      {/if}

      <!-- Models -->
      {#if activeSection === "models"}
      <section class="group">
        <div class="row" data-testid="background-model-row">
          <div class="rinfo">
            <div class="rlabel">Background model</div>
            <div class="rdesc">
              The cheap model pilot's own extensions use for out-of-band tasks (session
              auto-naming, the answer tool's extraction) — separate from the session's
              primary model. A <code>provider/model[:thinking]</code> spec, or a
              <code>script:</code>-prefixed path whose stdout is one. Blank = unset
              (extensions fall back).
            </div>
          </div>
        </div>
        <form
          class="shellform"
          onsubmit={(e) => {
            e.preventDefault();
            saveBackgroundModel();
          }}
        >
          <input
            bind:value={bgModelDraft}
            type="text"
            placeholder="e.g. anthropic/claude-haiku-4-5:low"
            title="Background model spec — provider/model[:thinking], or script:<path> (blank = unset)"
            aria-label="Background model spec"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            autocomplete="off"
            data-testid="background-model-input"
          />
          <Button
            variant="primary"
            type="submit"
            title="Save the background model spec"
            disabled={!bgModelDirty}>Save</Button
          >
          {#if store.pilotSettings.backgroundModel}
            <Button
              type="button"
              title="Clear the background model spec (extensions fall back)"
              onclick={clearBackgroundModel}>Clear</Button
            >
          {/if}
        </form>
        {#if bgModelWarning}
          <p class="note warn" data-testid="background-model-warning">
            ⚠ {bgModelWarning}
          </p>
        {/if}

      </section>
      {/if}

      <!-- Environment -->
      {#if activeSection === "environment"}
      <section class="group" data-testid="env-section">
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Login shell</div>
            <div class="rdesc">
              Pilot runs this shell at startup to load your PATH and tools, so the agent's
              commands see what your terminal does. Leave blank for your default
              (<code>$SHELL</code>). Applies on the next restart.
            </div>
          </div>
        </div>
        <form
          class="shellform"
          onsubmit={(e) => {
            e.preventDefault();
            saveLoginShell();
          }}
        >
          <input
            bind:value={shellDraft}
            type="text"
            placeholder="Default ($SHELL) — e.g. /opt/homebrew/bin/fish"
            title="Absolute path to the login shell pilot captures your environment from"
            aria-label="Login shell path"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            autocomplete="off"
            data-testid="login-shell-input"
          />
          <Button
            variant="primary"
            type="submit"
            title="Save the login shell (applies after a restart)"
            disabled={!shellDirty}>Save</Button
          >
          {#if store.pilotSettings.loginShell}
            <Button
              type="button"
              title="Use the default login shell ($SHELL)"
              onclick={useDefaultShell}>Default</Button
            >
          {/if}
        </form>
        <p class="note" data-testid="login-shell-status">
          {#if loginEnv.activeShell}
            Active: <code>{loginEnv.activeShell}</code>{#if loginEnv.detail}
              · {loginEnv.detail}{/if}
          {:else}
            Not captured{#if loginEnv.detail} · {loginEnv.detail}{/if}
          {/if}
        </p>
        {#if shellPending}
          <p class="note warn" data-testid="login-shell-restart">
            Restart Pilot to apply the new login shell.
          </p>
        {/if}
      </section>
      {/if}

      <!-- MCP servers -->
      {#if activeSection === "mcp"}
      <section class="group" data-testid="mcp-section">
        <div class="gtitle">MCP servers</div>
        <div class="rdesc" style="margin-bottom: 12px">
          Model Context Protocol servers extend the agent's tools. Status and controls
          mirror the daemon's MCP API.
        </div>
        {#if store.session.mcpServers && store.session.mcpServers.length > 0}
          {#each store.session.mcpServers as srv (srv.serverName)}
            <div class="mcp-row" data-testid="mcp-server-{srv.serverName}">
              <div class="mcp-info">
                <span
                  class="mcp-dot mcp-{srv.status}"
                  aria-hidden="true"
                  title={srv.status}
                ></span>
                <span class="mcp-name">{srv.serverName}</span>
                <span class="mcp-status">{srv.status}</span>
                {#if srv.toolCount > 0}
                  <span class="mcp-tools">{srv.toolCount} tool{srv.toolCount === 1 ? "" : "s"}</span>
                {/if}
              </div>
              <div class="mcp-actions">
                {#if srv.status === "disabled"}
                  <button
                    class="mcp-btn"
                    data-testid="mcp-enable-{srv.serverName}"
                    title={`Enable ${srv.serverName}`}
                    onclick={() => store.setMcpServer(srv.serverName, "enable")}
                  >Enable</button>
                {/if}
                {#if srv.status === "connected"}
                  <button
                    class="mcp-btn"
                    data-testid="mcp-disconnect-{srv.serverName}"
                    title={`Disconnect ${srv.serverName}`}
                    onclick={() => store.setMcpServer(srv.serverName, "disconnect")}
                  >Disconnect</button>
                  <button
                    class="mcp-btn"
                    data-testid="mcp-disable-{srv.serverName}"
                    title={`Disable ${srv.serverName}`}
                    onclick={() => store.setMcpServer(srv.serverName, "disable")}
                  >Disable</button>
                {/if}
                {#if srv.status === "disconnected" || srv.status === "reconnecting"}
                  <button
                    class="mcp-btn"
                    data-testid="mcp-reconnect-{srv.serverName}"
                    title={`Reconnect ${srv.serverName}`}
                    onclick={() => store.setMcpServer(srv.serverName, "reconnect")}
                  >Reconnect</button>
                {/if}
              </div>
            </div>
          {/each}
        {:else}
          <div class="mcp-empty">No MCP servers configured.</div>
        {/if}
      </section>
      {/if}

      <!-- Access token -->
      {#if activeSection === "token"}
      <section class="group">
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">{store.hasToken ? "Saved on this device" : "No token saved"}</div>
            <div class="rdesc">
              The app-level token gates this server. Tailscale is the network ACL; this
              is the credential.
            </div>
          </div>
          {#if store.hasToken}
            <Button variant="danger" title="Forget the access token saved on this device" onclick={() => store.signOut()}>Forget</Button>
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
          <Button variant="primary" type="submit" title="Save this access token on this device" disabled={!tokenDraft.trim()}>Save</Button>
        </form>
      </section>

      <section class="group" data-testid="data-dir-section">
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Data directory</div>
            <div class="rdesc">
              Where pilot.log, settings, and the session archive live on this server.
              <code data-testid="data-dir-path">{store.dataDir || "unknown"}</code>
            </div>
          </div>
          {#if store.dataDir}
            <div class="actions">
              <Button
                title="Copy the data directory path to the clipboard"
                onclick={() => store.copyDataDirPath()}
              >Copy path</Button
              >
              <Button
                title="Reveal the data directory in your file manager (Finder on macOS)"
                onclick={() => store.openDataDir()}
              >Reveal</Button
              >
            </div>
          {/if}
        </div>
      </section>
      {/if}
      </div>
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
  .body {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 4px 20px calc(20px + env(safe-area-inset-bottom));
  }
  /* Section nav: a left-rail of section tabs whose labels ARE the seven top-level
     section names, so every name stays visible the instant the panel opens. Only the
     active section renders, keeping the long lists from sharing one scroll. On the
     phone bottom-sheet the rail reflows to a horizontal scrollable strip (below). */
  .settings-shell {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .settings-nav {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 2px;
    padding: 12px 8px calc(12px + env(safe-area-inset-bottom));
    border-right: 1px solid var(--border);
    /* The rail scrolls on its own if the viewport is short (many tabs + a tall
       font scale) rather than pushing the content pane off-screen. */
    overflow-y: auto;
  }
  .tab {
    display: flex;
    align-items: center;
    width: 100%;
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    text-align: left;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
    /* A comfortable tap target on the mobile bottom-sheet (coarse pointer bumps it
       to a full 44px via the media query below, matching .gtitle-toggle). */
    min-height: 34px;
  }
  .tab:hover {
    background: var(--surface);
    color: var(--text);
  }
  .tab:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1.5px var(--accent);
  }
  .tab[aria-selected="true"] {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
  }
  .tab-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (pointer: coarse) {
    .tab {
      min-height: 44px;
    }
  }
  /* Phone bottom-sheet (matches the <600px panel-is-a-sheet breakpoint): the rail
     reflows from a left column to a horizontal scrollable strip pinned under the
     header, so the narrow sheet keeps its full width for the active section's
     content. All section names stay visible/reachable by scrolling the strip. */
  @media (max-width: 599px) {
    .settings-shell {
      flex-direction: column;
    }
    .settings-nav {
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
      border-right: none;
      border-bottom: 1px solid var(--border);
      padding: 6px 10px;
      gap: 4px;
      /* The strip never wraps; excess tabs scroll horizontally. */
      flex-wrap: nowrap;
    }
    .tab {
      width: auto;
      flex-shrink: 0;
      padding: 8px 12px;
    }
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
  /* MCP server list */
  .mcp-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .mcp-row:last-child {
    border-bottom: none;
  }
  .mcp-info {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .mcp-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .mcp-dot.mcp-connected {
    background: var(--ok);
  }
  .mcp-dot.mcp-disconnected {
    background: var(--text-faint);
  }
  .mcp-dot.mcp-reconnecting {
    background: var(--warning);
  }
  .mcp-dot.mcp-disabled {
    background: var(--danger);
  }
  .mcp-name {
    font-weight: 500;
    font-size: 13px;
    color: var(--text);
  }
  .mcp-status {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: capitalize;
  }
  .mcp-tools {
    font-size: 11px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .mcp-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .mcp-btn {
    font: inherit;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: var(--radius-xs, 6px);
    border: 1px solid var(--border);
    background: var(--surface-sunken);
    color: var(--text-muted);
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .mcp-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .mcp-btn:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .mcp-empty {
    font-size: 13px;
    color: var(--text-muted);
    padding: 16px 0;
  }
  /* Static section header (Providers, Extensions) — each has its own tab now, so the
     list isn't collapsed behind a toggle. Carries the at-a-glance count (connected / on)
     without being clickable. Same weight as .gtitle; flex so the count sits on the right. */
  .gtitle-static {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  /* Collapsible section header (Favorites, nested under Models) — same weight as .gtitle, but clickable. */
  .gtitle-toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    background: none;
    border: 0;
    /* A comfortable click target — the bare 11px label was a ~13px-tall hit area,
       fiddly to tap on the mobile bottom-sheet. Padding adds the height; the 6px
       bottom margin replaces .gtitle's 10px (the padding now carries that gap). */
    padding: 6px 0;
    margin-bottom: 6px;
    text-align: left;
    cursor: pointer;
  }
  /* Touch: section headers become a full 44px tap target (the panel is a phone
     bottom-sheet there). align-items:center keeps the label/chevron/count centred. */
  @media (pointer: coarse) {
    .gtitle-toggle {
      min-height: 44px;
    }
  }
  .gtitle-toggle:hover {
    color: var(--text-muted);
  }
  .gtitle-toggle:hover :global(.chevron),
  .gtitle-toggle:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  .gtitle-toggle:focus-visible {
    outline: none;
    color: var(--text);
    border-radius: var(--radius-xs);
    box-shadow: 0 0 0 1.5px var(--accent);
  }
  /* Sub-header (Favorites, nested under Models) — separated from the selects above it.
     A touch less top space than 16px since the toggle already carries 6px padding-top. */
  .gtitle-toggle.subhead {
    margin-top: 10px;
  }
  .gtitle-count {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
    font-size: 10.5px;
    opacity: 0.8;
  }
  /* Search box shared by the Providers / Extensions sections. */
  .sub-search {
    width: 100%;
    box-sizing: border-box;
    font-size: 12.5px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px 9px;
    margin: 2px 0 8px;
  }
  .sub-search:focus {
    outline: none;
    border-color: var(--accent);
  }
  .fav-note {
    margin-top: 0;
    margin-bottom: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }
  /* The default-model row wraps so its picker can drop a full-width menu onto a second
     line (the menu is a sibling flex item with flex-basis:100%). */
  .dm-row {
    flex-wrap: wrap;
    row-gap: 6px;
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
  /* Pill toggle for the hide-thinking switch. The theme control moved to
     <SegmentedControl>, which scopes its own .seg-btn; this row still needs it. */
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
  /* Text-size stepper: A− / value / A+ in a segmented pill, mirroring the theme control. */
  .stepper {
    display: inline-flex;
    align-items: stretch;
    flex-shrink: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--surface);
  }
  .step-btn {
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 13px;
    padding: 5px 11px;
    cursor: pointer;
  }
  .step-btn:not(:last-child) {
    border-right: 1px solid var(--border);
  }
  .step-btn.val {
    min-width: 52px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .step-btn:hover:not(:disabled) {
    background: var(--surface-sunken);
    color: var(--text);
  }
  .step-btn:disabled {
    color: var(--text-faint);
    cursor: default;
  }
  .actions {
    display: flex;
    gap: 8px;
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
  /* The favorites provider header doubles as a per-provider collapse toggle. */
  .mprovider-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: none;
    border: 0;
    text-align: left;
    cursor: pointer;
  }
  .mprovider-toggle:hover {
    color: var(--text-muted);
  }
  .mprovider-toggle:hover :global(.chevron),
  .mprovider-toggle:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  .mprovider-toggle:focus-visible {
    outline: none;
    color: var(--text);
    border-radius: var(--radius-xs);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .mprovider-name {
    flex: 1;
  }
  .mprovider-count {
    text-transform: none;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
  }
  .favstar {
    color: var(--accent);
    opacity: 1;
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
  .exts {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ext {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 0;
  }
  /* A disabled extension reads dimmed (its toggle is the lone full-opacity affordance). */
  .ext.off .rinfo {
    opacity: 0.55;
  }
  .ext-error {
    font-size: 12px;
    color: var(--danger);
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .note.warn {
    color: var(--accent);
  }
  /* Login-shell path entry, mirroring .tokenform. */
  .shellform {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .shellform input {
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
  .shellform input:focus {
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
  /* OAuth sign-in modal — sits above the settings panel (z 60/61). */
  .oauth-scrim {
    z-index: 70;
    background: rgba(20, 19, 18, 0.45);
  }
  .oauth-dialog {
    position: fixed;
    z-index: 71;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(460px, 100%);
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
    .oauth-dialog {
      top: 50%;
      bottom: auto;
      transform: translate(-50%, -50%);
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  .oauth-body {
    overflow-y: auto;
    padding: 14px 20px calc(20px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .oauth-progress {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .oauth-error {
    font-size: 13px;
    color: var(--danger);
    margin: 0;
  }
  .oauth-open {
    align-self: flex-start;
    text-decoration: none;
  }
  .oauth-msg {
    font-size: 13px;
    color: var(--text);
  }
  .oauth-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .oauth-form input {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 9px 11px;
    font-size: 16px;
    background: var(--bg);
    color: var(--text);
    outline: none;
  }
  .oauth-form input:focus {
    border-color: var(--accent);
  }
  .oauth-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .oauth-code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 22px;
    letter-spacing: 0.1em;
    color: var(--text);
    text-align: center;
    margin: 4px 0;
    user-select: all;
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
  /* Reduced motion: the panel/scrim appear instantly rather than sliding up — the
     same courtesy <Chevron> and `reveal` extend to the collapse animations. */
  @media (prefers-reduced-motion: reduce) {
    .scrim,
    .panel,
    .oauth-scrim,
    .oauth-dialog {
      animation: none;
    }
  }
</style>
