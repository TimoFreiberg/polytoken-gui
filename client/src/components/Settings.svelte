<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import type { HostCoordinator } from "../lib/hosts.svelte.js";
  import { profileEditor } from "../lib/profile-editor.svelte.js";
  import { redactSshDestination, type RemoteProfile } from "../lib/hosts/types.js";
  import type { ThemeMode } from "../lib/theme.js";
  import Button from "./ui/Button.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import SegmentedControl from "./ui/SegmentedControl.svelte";
  import Chevron from "./ui/Chevron.svelte";
  import { MAX_SCALE, MIN_SCALE, STEP } from "../lib/font-scale.js";
  import { onMount, tick } from "svelte";
  import { overlayHistory, PHONE_MQ } from "../lib/overlay-history.js";

  const { coordinator }: { coordinator: HostCoordinator } = $props();

  // The settings panel. Per-client view state (theme, notifications, this device's
  // access token) sits next to server-side global agent config (provider credentials,
  // default model/thinking, favorites) which travels the WS and persists in the agent.

  const open = $derived(store.settingsOpen);

  // Desktop uses a left rail of section tabs and one scrollable content pane. Phone
  // Settings opens on a full-screen section index; choosing a row drills into one
  // full-screen detail, where Back or Escape returns to the index before Settings closes.
  //
  // Active section persists across close/reopen AND reload, mirroring the app's other
  // per-device localStorage prefs (pantoken.sidebarOpen, pantoken.theme, …). Desktop
  // reopens on the section last viewed; phone still opens its section index, with that
  // section ready when selected. Defaults to Appearance without a stored pref (or on
  // SSR/tests).
  type SectionId =
    | "appearance"
    | "notifications"
    | "models"
    | "environment"
    | "mcp"
    | "token"
    | "computers";
  const SECTIONS: { id: SectionId; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "notifications", label: "Notifications" },
    { id: "models", label: "Models" },
    { id: "environment", label: "Environment" },
    { id: "mcp", label: "MCP" },
    { id: "token", label: "Access token" },
    { id: "computers", label: "Computers" },
  ];
  const ACTIVE_SECTION_KEY = "pantoken.settingsSection";
  function initialSection(): SectionId {
    if (typeof window === "undefined") return "appearance";
    const stored = localStorage.getItem(ACTIVE_SECTION_KEY);
    return stored && SECTIONS.some((s) => s.id === stored)
      ? (stored as SectionId)
      : "appearance";
  }
  let activeSection = $state<SectionId>(initialSection());
  // Pick up a requested section from openSettings(section).
  $effect(() => {
    void store._settingsSectionN;
    const requested = store.requestedSettingsSection;
    if (requested) {
      activeSection = requested as SectionId;
      store.requestedSettingsSection = null;
    }
  });
  let phone = $state(false);
  let mobileDetail = $state<SectionId | null>(null);
  let panelEl = $state<HTMLDivElement>();
  let previousFocus: HTMLElement | null = null;
  let settingsHistoryTracked = false;

  onMount(() => {
    const mq = window.matchMedia(PHONE_MQ);
    const update = () => {
      const wasPhone = phone;
      phone = mq.matches;
      if (!phone && wasPhone) {
        if (mobileDetail) overlayHistory.closed("settings-detail");
        mobileDetail = null;
      } else if (phone && !wasPhone && open && !settingsHistoryTracked) {
        overlayHistory.opened("settings", closeFromHistory);
        settingsHistoryTracked = true;
      }
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  function setSection(id: SectionId): void {
    activeSection = id;
    if (typeof window !== "undefined")
      localStorage.setItem(ACTIVE_SECTION_KEY, id);
    if (phone && mobileDetail !== id) {
      mobileDetail = id;
      overlayHistory.openedNested("settings-detail", () => {
        mobileDetail = null;
        void focusPanel();
      });
      void focusPanel();
    }
  }

  async function focusPanel(): Promise<void> {
    await tick();
    panelEl?.focus();
  }

  function restoreFocus(): void {
    const target = phone
      ? document.querySelector<HTMLElement>(".composer-surface textarea")
      : previousFocus;
    target?.focus();
  }

  function closeFromHistory(): void {
    settingsHistoryTracked = false;
    mobileDetail = null;
    store.closeSettings();
    restoreFocus();
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

  // Settings is the durable home for healthy connection and push state. The header
  // only interrupts when either state is degraded.
  const push = $derived(store.pushState);
  const connection = $derived(store.connection);
  const connectionLabel = $derived(
    connection === "connected"
      ? "Connected"
      : connection === "disconnected"
        ? "Offline"
        : connection === "connecting"
          ? "Connecting…"
          : "Reconnecting…",
  );
  const pushStatus: Record<string, string> = {
    working: "Subscribing…",
    idle: "Not enabled on this device",
    subscribed: "Enabled on this device",
    denied: "Blocked — enable in your browser/iOS settings",
    "needs-install": "Add to Home Screen first, then re-open and enable",
    error: "Couldn't subscribe — tap retry (see console)",
    unsupported: "Not supported on this device",
  };

  // Environment: the login shell pantoken captures your PATH/tools from at startup, the live
  // status of that capture, and whether a config change is still waiting on a restart.
  const loginEnv = $derived(store.loginEnv);
  const shellPending = $derived(store.loginShellPendingRestart);
  // Draft for the shell-path field; seeded from the configured value on panel open.
  let shellDraft = $state("");
  const shellDirty = $derived(
    shellDraft.trim() !== (store.pantokenSettings.loginShell ?? ""),
  );
  function saveLoginShell(): void {
    store.setLoginShell(shellDraft.trim() || null);
  }
  function useDefaultShell(): void {
    shellDraft = "";
    store.setLoginShell(null);
  }

  // Re-seed the shell draft on each open transition.
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      previousFocus = document.activeElement as HTMLElement | null;
      shellDraft = store.pantokenSettings.loginShell ?? "";
      mobileDetail = null;
      // Jump to a requested section if openSettingsTo() was called.
      if (store.requestedSettingsSection) {
        setSection(store.requestedSettingsSection as SectionId);
        store.requestedSettingsSection = null;
      }
      overlayHistory.opened("settings", closeFromHistory);
      settingsHistoryTracked = phone;
      void focusPanel();
    }
    prevOpen = open;
  });

  let tokenDraft = $state("");

  function consumeSettingsHistory(): void {
    if (phone && mobileDetail && settingsHistoryTracked)
      overlayHistory.closed("settings-detail");
    overlayHistory.closed("settings");
    settingsHistoryTracked = false;
  }

  function close(): void {
    consumeSettingsHistory();
    mobileDetail = null;
    store.closeSettings();
    restoreFocus();
  }
  function backToIndex(): void {
    if (!mobileDetail) return;
    overlayHistory.closed("settings-detail");
    mobileDetail = null;
    void focusPanel();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      if (phone && mobileDetail) backToIndex();
      else close();
      return;
    }
    // Alt+1..7 — jump straight to a section tab (the rail order). Read e.code
    // ("Digit1".."Digit7") rather than e.key: on macOS Option+digit composes a glyph
    // (Option+1 → "¡"), so Number(e.key) is NaN and the shortcut would silently no-op
    // on the project's primary platform. e.code is the physical key, layout/OS-
    // independent. Safe even while a settings field is focused (model/shell/token
    // fields): Option+digit would compose a glyph there, but we preventDefault() on
    // the Digit1..7 match before it lands, swallowing the glyph and navigating
    // instead — so the shortcut never corrupts field text. noUncheckedIndexedAccess
    // makes SECTIONS[idx] `T | undefined`; the guard narrows it at runtime but not to
    // TS, so capture the element after the bound check.
    if (open && !phone && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const m = /^Digit([1-7])$/.exec(e.code);
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
    if (e.key === "Tab" && open && panelEl) {
      const candidates = Array.from(
        panelEl.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (candidates.length === 0) {
        e.preventDefault();
        panelEl.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelEl)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panelEl)) {
        e.preventDefault();
        first?.focus();
      }
    }
  }
  function saveToken(): void {
    const t = tokenDraft.trim();
    if (!t) return;
    store.changeToken(t);
    tokenDraft = "";
  }
  function forgetToken(): void {
    consumeSettingsHistory();
    mobileDetail = null;
    store.signOut();
  }

  // ── Computers section ─────────────────────────────────────────────────

  const showComputers = $derived(coordinator.multiHostCapable);
  let deleteConfirmId = $state<string | null>(null);

  function hostStateLabel(id: string): string {
    const summary = coordinator.summaries.find((s) => s.descriptor.id === id);
    if (!summary) return "Offline";
    return summary.statusText;
  }

  function isHostConnected(id: string): boolean {
    const summary = coordinator.summaries.find((s) => s.descriptor.id === id);
    return summary?.descriptor.state === "ready" || summary?.descriptor.state === "reconnecting";
  }

  function isHostConnecting(id: string): boolean {
    const summary = coordinator.summaries.find((s) => s.descriptor.id === id);
    if (!summary) return false;
    return ["testingSsh", "connecting", "provisioning", "starting", "preflight", "awaitingAcknowledgement"].includes(summary.descriptor.state);
  }

  function isHostFailed(id: string): boolean {
    const summary = coordinator.summaries.find((s) => s.descriptor.id === id);
    return summary?.descriptor.state === "failed";
  }

  async function connectProfile(id: string): Promise<void> {
    await coordinator.selectHost(id);
  }

  async function disconnectProfile(id: string): Promise<void> {
    await coordinator.disconnectHost(id);
  }

  async function retryProfile(id: string): Promise<void> {
    await coordinator.selectHost(id);
  }

  async function doDeleteProfile(id: string): Promise<void> {
    await coordinator.deleteProfile(id);
    deleteConfirmId = null;
  }

  function confirmDelete(profile: RemoteProfile): void {
    deleteConfirmId = profile.id;
  }

  function cancelDelete(): void {
    deleteConfirmId = null;
  }

  async function reconnectNow(id: string): Promise<void> {
    await coordinator.reconnectHost(id);
  }

  function dismissReconnect(id: string): void {
    coordinator.clearReconnectRequired(id);
  }

  function editProfile(profile: RemoteProfile): void {
    profileEditor.openEdit(profile);
  }

  function addComputer(): void {
    profileEditor.openNew();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="scrim" onclick={() => close()} role="presentation"></div>
  <div
    bind:this={panelEl}
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    data-testid="settings-panel"
    tabindex="-1"
  >
    <header class="phead">
      {#if phone && mobileDetail}
        <button class="mobile-back" type="button" title="Back to Settings" aria-label="Back to Settings" onclick={() => backToIndex()}><span class="back-chevron"><Chevron size={14} /></span><span>Back</span></button>
        <h2>{SECTIONS.find((section) => section.id === mobileDetail)?.label}</h2>
        <span class="header-spacer" aria-hidden="true"></span>
      {:else}
        <h2>Settings</h2>
        <IconButton title="Close settings" aria-label="Close settings" onclick={() => close()}>✕</IconButton>
      {/if}
    </header>

    <div class="settings-shell">
      <!-- Desktop ARIA tabs: the rail controls the shared panel body. Phone renders
           these same entries as ordinary navigation buttons into a detail page. -->
      {#if !phone || mobileDetail === null}
      <div
        class="settings-nav"
        role={phone ? undefined : "tablist"}
        aria-label="Settings sections"
        data-testid="settings-index"
      >
        {#each SECTIONS.filter((s) => s.id !== "computers" || showComputers) as s, i (s.id)}
          <button
            class="tab"
            type="button"
            id="settings-tab-{s.id}"
            role={phone ? undefined : "tab"}
            aria-selected={phone ? undefined : activeSection === s.id}
            aria-controls={phone ? undefined : "settings-panel-body"}
            data-testid="settings-tab-{s.id}"
            title={phone ? `Open ${s.label}` : `${s.label} section (Alt+${i + 1})`}
            onclick={() => setSection(s.id)}
          >
            <span class="tab-label">{s.label}</span>
            {#if phone}<Chevron size={14} />{/if}
          </button>
        {/each}
      </div>
      {/if}

      {#if !phone || mobileDetail !== null}
      <div
        class="body"
        id="settings-panel-body"
        role={phone ? undefined : "tabpanel"}
        aria-labelledby={phone ? undefined : `settings-tab-${activeSection}`}
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
            <div class="rdesc">Collapse superseded reasoning; only the active thinking tail shows (collapsed, expandable).</div>
          </div>
          <button
            class="seg-btn"
            class:active={store.hideThinking}
            role="switch"
            aria-checked={store.hideThinking}
            data-testid="hide-thinking"
            title={store.hideThinking ? "Hide superseded thinking blocks (only active reasoning shows)" : "Show all thinking blocks"}
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
        <div class="row" data-testid="connection-settings-row">
          <div class="rinfo">
            <div class="rlabel">Agent connection</div>
            <div class="rdesc">{connectionLabel}</div>
          </div>
          <span class="connection-state {connection}" role="status">
            {connection === "connected" ? "Live" : connection}
          </span>
        </div>
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
        <p class="section-empty">Session models and effort are selected from the composer.</p>
        {#if store.backgroundModelWarning}
          <p class="note warn" data-testid="background-model-warning">
            ⚠ Background model configuration is invalid; extensions will use their fallback.
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
              Pantoken runs this shell at startup to load your PATH and tools, so the agent's
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
            title="Absolute path to the login shell pantoken captures your environment from"
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
          {#if store.pantokenSettings.loginShell}
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
            Restart Pantoken to apply the new login shell.
          </p>
        {/if}
        <div class="row">
          <div class="rinfo">
            <div class="rlabel">Reload facets</div>
            <div class="rdesc">Re-read available facet definitions from disk (use after editing facet files).</div>
          </div>
          <Button
            title="Reload the facet list from disk"
            onclick={() => store.refreshFacets()}
          >Reload</Button>
        </div>
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
            <Button variant="danger" title="Forget the access token saved on this device" onclick={forgetToken}>Forget</Button>
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
              Where pantoken.log, settings, and the session archive live on this server.
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

      <!-- Computers -->
      {#if activeSection === "computers" && showComputers}
      <section class="group" data-testid="computers-section">
        <div class="row computer-row">
          <div class="rinfo">
            <div class="rlabel">{store.serverLabel || "This computer"}</div>
            <div class="rdesc">This computer</div>
          </div>
          <span class="computer-state connected" role="status">Connected</span>
        </div>

        {#each coordinator.profiles as profile (profile.id)}
          <div class="row computer-row" data-testid={`computer-row-${profile.id}`}>
            <div class="rinfo">
              <div class="rlabel">{profile.label}</div>
              <div class="rdesc">{redactSshDestination(profile.sshDestination).host}</div>
            </div>
            <div class="computer-actions">
              {#if deleteConfirmId === profile.id}
                <div class="delete-confirm" data-testid={`delete-confirm-${profile.id}`}>
                  <span class="delete-confirm-text">Remove {profile.label}? This disconnects it if connected.</span>
                  <div class="delete-confirm-actions">
                    <Button variant="danger" title="Remove this computer" onclick={() => void doDeleteProfile(profile.id)}>Remove</Button>
                    <Button title="Cancel" onclick={() => cancelDelete()}>Cancel</Button>
                  </div>
                </div>
              {:else}
                <span class="computer-state {isHostFailed(profile.id) ? 'failed' : isHostConnected(profile.id) ? 'connected' : ''}" role="status">
                  {hostStateLabel(profile.id)}
                </span>
                <div class="actions">
                  {#if coordinator.hasReconnectRequired(profile.id)}
                    <Button variant="primary" title="Reconnect with updated settings" onclick={() => void reconnectNow(profile.id)}>Reconnect now</Button>
                    <Button title="Reconnect later" onclick={() => dismissReconnect(profile.id)}>Later</Button>
                  {:else if isHostConnecting(profile.id)}
                    <Button title="Cancel this connection" onclick={() => void coordinator.cancelConnection(profile.id)}>Cancel</Button>
                  {:else if isHostFailed(profile.id)}
                    <Button title="Retry connecting" onclick={() => void retryProfile(profile.id)}>Retry</Button>
                  {:else if isHostConnected(profile.id)}
                    <Button title="Disconnect this computer" onclick={() => void disconnectProfile(profile.id)}>Disconnect</Button>
                  {:else}
                    <Button variant="primary" title="Connect to this computer" onclick={() => void connectProfile(profile.id)}>Connect</Button>
                  {/if}
                  <Button title="Edit this computer" onclick={() => editProfile(profile)}>Edit</Button>
                  <Button title="Remove this computer" onclick={() => confirmDelete(profile)}>Remove</Button>
                </div>
              {/if}
            </div>
          </div>
        {/each}

        <div class="add-computer">
          <Button variant="primary" title="Add a new computer" onclick={() => addComputer()} data-testid="add-computer-btn">Add computer</Button>
        </div>
      </section>
      {/if}
      </div>
      {/if}
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
  .panel:focus {
    outline: none;
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
  .mobile-back {
    display: none;
  }
  .header-spacer {
    display: none;
  }
  .body {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 4px 20px calc(20px + env(safe-area-inset-bottom));
  }
  /* Desktop section navigation is a left rail beside the active detail. On phone the
     same six entries become the full-screen index and only the chosen detail renders. */
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
    /* Coarse pointers bump this to the shared 44px minimum below. */
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
  .tab :global(.chevron) {
    margin-left: auto;
  }
  @media (pointer: coarse) {
    .tab {
      min-height: 44px;
    }
  }
  /* Phone Settings is a full-screen navigation surface: an index first, then one
     scrollable detail page. Desktop keeps the compact rail-and-pane dialog. */
  @media (max-width: 859px) {
    .scrim {
      display: none;
    }
    .panel {
      z-index: 95;
      inset: 0;
      left: 0;
      bottom: 0;
      transform: none;
      width: 100dvw;
      height: 100dvh;
      max-height: none;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      animation: none;
    }
    .phead {
      display: grid;
      grid-template-columns: minmax(72px, 1fr) auto minmax(72px, 1fr);
      min-height: calc(52px + env(safe-area-inset-top));
      box-sizing: border-box;
      padding: env(safe-area-inset-top) 8px 0;
    }
    .phead h2 {
      grid-column: 2;
      text-align: center;
    }
    .phead > :global(.icon-btn) {
      grid-column: 3;
      justify-self: end;
    }
    .mobile-back {
      display: inline-flex;
      grid-column: 1;
      align-items: center;
      justify-self: start;
      min-width: 72px;
      min-height: 44px;
      padding: 0 8px 0 2px;
      border: 0;
      background: transparent;
      color: var(--accent);
      font: inherit;
      font-size: 14px;
      cursor: pointer;
    }
    .back-chevron {
      display: inline-flex;
      transform: rotate(180deg);
    }
    .mobile-back:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
      border-radius: var(--radius-sm);
    }
    .header-spacer {
      display: block;
      grid-column: 3;
      width: 72px;
    }
    .settings-shell {
      flex-direction: column;
    }
    .settings-nav {
      flex: 1 1 auto;
      flex-direction: column;
      overflow-x: hidden;
      overflow-y: auto;
      border-right: none;
      border-bottom: none;
      padding: 8px 12px calc(16px + env(safe-area-inset-bottom));
      gap: 0;
    }
    .tab {
      width: 100%;
      min-height: 52px;
      flex-shrink: 0;
      padding: 0 12px;
      border-radius: 0;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      font-size: 15px;
    }
    .tab:hover,
    .tab:active {
      background: var(--surface);
    }
    .body {
      padding: 0 16px calc(24px + env(safe-area-inset-bottom));
      overscroll-behavior: contain;
    }
    .group {
      padding-top: 16px;
    }
    .row {
      min-height: 52px;
      padding-block: 6px;
    }
    .step-btn,
    .seg-btn,
    .mcp-btn {
      min-height: 44px;
    }
    .shellform {
      flex-wrap: wrap;
    }
    .shellform input {
      flex-basis: 100%;
      min-height: 44px;
    }
    .mcp-row {
      min-height: 52px;
      flex-wrap: wrap;
    }
    .mcp-btn {
      padding-inline: 14px;
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
       fiddly to tap in the phone detail. Padding adds the height; the 6px
       bottom margin replaces .gtitle's 10px (the padding now carries that gap). */
    padding: 6px 0;
    margin-bottom: 6px;
    text-align: left;
    cursor: pointer;
  }
  /* Touch: section headers become a full 44px tap target. */
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
  .connection-state {
    flex-shrink: 0;
    padding: 3px 8px;
    color: var(--text-muted);
    font-size: 11.5px;
    text-transform: capitalize;
    background: var(--surface-sunken);
    border-radius: 999px;
  }
  .connection-state.connected {
    color: var(--ok);
  }
  .connection-state.disconnected {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .connection-state.connecting,
  .connection-state.reconnecting {
    color: var(--warning);
    background: var(--warning-soft);
  }
  .note {
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1.5;
    margin: 10px 0 0;
  }
  .section-empty {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
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
  .ext-error {
    font-size: 12px;
    color: var(--danger);
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  /* Computers section */
  .computer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .computer-row:last-of-type {
    border-bottom: none;
  }
  .computer-state {
    flex-shrink: 0;
    padding: 3px 8px;
    color: var(--text-muted);
    font-size: 11.5px;
    background: var(--surface-sunken);
    border-radius: 999px;
  }
  .computer-state.connected {
    color: var(--ok);
  }
  .computer-state.failed {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .computer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .delete-confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
  }
  .delete-confirm-text {
    font-size: 12.5px;
    color: var(--danger);
    max-width: 240px;
    text-align: right;
  }
  .delete-confirm-actions {
    display: flex;
    gap: 6px;
  }
  .add-computer {
    padding-top: 12px;
  }
  @media (pointer: coarse) {
    .computer-row {
      min-height: 52px;
      flex-wrap: wrap;
    }
  }
  @media (max-width: 859px) {
    .computer-row {
      min-height: 52px;
      padding-block: 6px;
    }
    .delete-confirm {
      align-items: stretch;
    }
    .delete-confirm-text {
      text-align: left;
    }
  }
</style>
