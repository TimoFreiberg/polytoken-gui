<script lang="ts">
  import type { ModelOption } from "@pilot/protocol";
  import { isPilotOwnedExtension } from "@pilot/protocol";
  import { reveal } from "../lib/transitions.js";
  import { store } from "../lib/store.svelte.js";
  import type { ThemeMode } from "../lib/theme.js";
  import Button from "./ui/Button.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import Chevron from "./ui/Chevron.svelte";
  import DefaultModelPicker from "./DefaultModelPicker.svelte";
  import SegmentedControl from "./ui/SegmentedControl.svelte";
  import { MAX_SCALE, MIN_SCALE, STEP } from "../lib/font-scale.js";

  // The settings panel. Per-client view state (theme, notifications, this device's
  // access token) sits next to server-side global pi config (provider credentials,
  // default model/thinking, favorites) which travels the WS and persists in pi.

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
    | "providers"
    | "models"
    | "extensions"
    | "environment"
    | "token";
  const SECTIONS: { id: SectionId; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "notifications", label: "Notifications" },
    { id: "providers", label: "Providers" },
    { id: "models", label: "Models" },
    { id: "extensions", label: "Extensions" },
    { id: "environment", label: "Environment" },
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

  // Provider credentials + global model config (server-authoritative).
  const providers = $derived(store.providers);
  const defaults = $derived(store.modelDefaults);
  // The in-progress OAuth sign-in flow (null when none). Rendered as a modal over the
  // panel; the server drives it via oauthPrompt/oauthProgress/oauthResult.
  const oauth = $derived(store.oauthFlow);

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

  // The provider list is a long block you rarely touch once a provider is connected, so it
  // collapses behind its section header (collapsed by default — the header shows a connected
  // count so you can see at a glance without expanding).
  let providersOpen = $state(false);
  const connectedCount = $derived(providers.filter((p) => p.hasAuth).length);
  // Filter-as-you-type over the provider list (name or id). Matches the favorites search.
  let providerQuery = $state("");
  const pq = $derived(providerQuery.trim().toLowerCase());
  const filteredProviders = $derived(
    pq
      ? providers.filter(
          (p) =>
            p.name.toLowerCase().includes(pq) || p.id.toLowerCase().includes(pq),
        )
      : providers,
  );

  // The pi extensions for the focused session (Settings "Extensions" view). Fetched on
  // demand when the section expands (collapsed by default) — re-queried each expand so it
  // reflects any toggles since. Toggling applies on the session's NEXT start (pi loads
  // extensions at start), which the section's note spells out.
  const extensions = $derived(store.extensions);
  const extensionsOn = $derived(extensions.filter((x) => x.enabled).length);
  let extensionsOpen = $state(false);
  function toggleExtensionsSection(): void {
    extensionsOpen = !extensionsOpen;
    if (extensionsOpen) store.queryExtensions();
  }
  // Filter-as-you-type over the extension list (name or source).
  let extQuery = $state("");
  const xq = $derived(extQuery.trim().toLowerCase());
  const filteredExtensions = $derived(
    xq
      ? extensions.filter(
          (x) =>
            x.name.toLowerCase().includes(xq) ||
            x.source.toLowerCase().includes(xq),
        )
      : extensions,
  );
  // D3: group the filtered extensions under collapsible origin headers so the Settings
  //   list reads "Pilot / User / Project / …" rather than one flat alphabetical run.
  //   Pilot comes first (pilot's own shipped extensions), then the rest alphabetically
  //   by their `source` label ("user", "project", "user · package", …). A non-empty
  //   search auto-expands every group with a match (mirrors the favorites behaviour).
  type ExtGroup = { origin: string; items: typeof filteredExtensions };
  const extGroups = $derived.by<ExtGroup[]>(() => {
    const order = ["Pilot"];
    const map = new Map<string, typeof filteredExtensions>();
    for (const x of filteredExtensions) {
      const arr = map.get(x.source) ?? [];
      arr.push(x);
      map.set(x.source, arr);
    }
    const origins = [...map.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        // Pinned origins (Pilot) sort before everything else; among pinned, by their index.
        if (ia !== -1 && ib !== -1) return ia - ib;
        return ia !== -1 ? -1 : 1;
      }
      return a.localeCompare(b);
    });
    return origins.map((origin) => ({ origin, items: map.get(origin)! }));
  });
  let collapsedExtOrigins = $state<Set<string>>(new Set());
  function isExtOriginExpanded(origin: string): boolean {
    return xq !== "" || !collapsedExtOrigins.has(origin);
  }
  function toggleExtOrigin(origin: string): void {
    const next = new Set(collapsedExtOrigins);
    if (next.has(origin)) next.delete(origin);
    else next.add(origin);
    collapsedExtOrigins = next;
  }
  // The load-bearing-breakage warning for pilot-owned extensions ([OPEN D]). Maps an
  //   owned extension basename → a short warning shown inline when its toggle is OFF, so
  //   disabling a load-bearing one (answer breaks the Q&A UI; tasklist degrades the
  //   widget) doesn't fail silently. session-namer is LOW-risk (disabling just stops
  //   auto-naming) so it's absent here — but the render path reads this map so Chunk 4
  //   can add an "answer" warning without touching the markup.
  const EXT_LOAD_BEARING_WARNINGS: Record<string, string> = {
    tasklist:
      "Disabling this hides the open-tasks widget above the composer.",
  };
  // Whether a row is one of pilot's OWNED extensions (its toggle routes to pilot's
  //   `enabledExtensions`, not pi's force-exclude — Chunk 0 finding). Delegates to the
  //   shared protocol predicate so client + server can't disagree on what counts as owned.
  function isPilotOwnedExt(name: string): boolean {
    return isPilotOwnedExtension(name);
  }

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

  // The favorites checklist grows with every connected provider, so the whole list lives
  // behind a collapsible sub-header (collapsed by default — the header shows favorited +
  // total counts at a glance). Per-provider sub-collapse + search live inside.
  let favoritesOpen = $state(false);
  const totalModels = $derived(store.models.length);
  const totalFavorites = $derived(
    store.models.filter((m) => store.isFavorite(m.provider, m.modelId)).length,
  );

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

  // Per-provider collapse for the favorites checklist (mirrors the header ModelPicker): the
  // list grows long with every provider, so groups start collapsed — except providers that
  // already hold a favorite, seeded open so your existing curation stays visible. A non-empty
  // search auto-expands every matching group.
  let expandedFavProviders = $state<Set<string>>(new Set());
  function isFavExpanded(provider: string): boolean {
    return fq !== "" || expandedFavProviders.has(provider);
  }
  function toggleFavProvider(provider: string): void {
    const next = new Set(expandedFavProviders);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    expandedFavProviders = next;
  }
  // Re-seed the favorites collapse on each open transition only (not on every favorite
  // toggle): expand providers that have a favorite, collapse the rest. `prevOpen` is a plain
  // var so writing it here doesn't make the effect re-run on its own assignment.
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      const seeded = new Set<string>();
      for (const g of groups) {
        if (g.items.some((m) => store.isFavorite(m.provider, m.modelId)))
          seeded.add(g.provider);
      }
      expandedFavProviders = seeded;
      // Seed the login-shell field from the server's configured value each open.
      shellDraft = store.pilotSettings.loginShell ?? "";
      // Seed the background-model field likewise.
      bgModelDraft = store.pilotSettings.backgroundModel ?? "";
      // Fetch the extension list on open (even while the section is collapsed) so its
      // header can show the at-a-glance "N/M on" count without making you expand first.
      store.queryExtensions();
    }
    prevOpen = open;
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
  // The OAuth paste field (code / redirect URL). Cleared on submit; one prompt is
  // answered before the next arrives, so no per-prompt reset is needed.
  let oauthDraft = $state("");

  function submitOauth(): void {
    const v = oauthDraft.trim();
    if (!v) return;
    store.oauthRespond(v);
    oauthDraft = "";
  }

  function close(): void {
    store.closeSettings();
  }
  // Escape in a section search clears the filter first (and stops the event before the
  // window handler closes the whole panel) — mirrors the sidebar search. An empty box
  // lets Escape bubble through to close the panel as usual.
  function searchEsc(e: KeyboardEvent, clear: () => void, hasValue: boolean): void {
    if (e.key === "Escape" && hasValue) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      close();
      return;
    }
    // Alt+1..7 — jump straight to a section tab (the rail order). Read e.code
    // ("Digit1".."Digit7") rather than e.key: on macOS Option+digit composes a glyph
    // (Option+1 → "¡"), so Number(e.key) is NaN and the shortcut would silently no-op
    // on the project's primary platform. e.code is the physical key, layout/OS-
    // independent. Safe even while a settings field is focused (provider/favorites/
    // extension searches, key/shell/token fields): Option+digit would compose a
    // glyph there, but we preventDefault() on the Digit1..7 match before it lands,
    // swallowing the glyph and navigating instead — so the shortcut never corrupts
    // field text. noUncheckedIndexedAccess makes SECTIONS[idx] `T | undefined`; the
    // guard narrows it at runtime but not to TS, so capture the element after the
    // bound check.
    if (open && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
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
            <div class="rlabel">Hide thinking blocks</div>
            <div class="rdesc">Replace thinking content with a subtle placeholder.</div>
          </div>
          <button
            class="seg-btn"
            class:active={store.hideThinking}
            role="switch"
            aria-checked={store.hideThinking}
            data-testid="hide-thinking"
            title={store.hideThinking ? "Show thinking blocks" : "Hide thinking blocks"}
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
      </section>
      {/if}

      <!-- Providers -->
      {#if activeSection === "providers"}
      <section class="group">
        <button
          class="gtitle gtitle-toggle"
          type="button"
          aria-expanded={providersOpen}
          data-testid="providers-toggle"
          title={providersOpen ? "Collapse providers" : "Expand providers"}
          onclick={() => (providersOpen = !providersOpen)}
        >
          <Chevron open={providersOpen} size={10} />
          <span class="gtitle-name">Providers</span>
          {#if providers.length > 0}
            <span class="gtitle-count">{connectedCount}/{providers.length} connected</span>
          {/if}
        </button>
        {#if providersOpen}
          <div class="section-body" transition:reveal>
          {#if providers.length === 0}
            <p class="note">No providers reported by the server.</p>
          {:else}
          {#if providers.length > 1}
            <input
              class="sub-search"
              type="text"
              placeholder="Search providers…"
              title="Filter providers by name or id"
              aria-label="Search providers"
              spellcheck="false"
              autocapitalize="off"
              autocorrect="off"
              bind:value={providerQuery}
              onkeydown={(e) => searchEsc(e, () => (providerQuery = ""), pq !== "")}
            />
          {/if}
          <div class="providers">
            {#each filteredProviders as p (p.id)}
              <div class="prow" data-testid="provider-{p.id}">
                <div class="rinfo">
                  <div class="rlabel">{p.name}</div>
                  <div class="rdesc" class:connected={p.hasAuth}>
                    {sourceLabel[p.authSource] ??
                      (p.hasAuth ? "Connected" : "Not connected")}
                  </div>
                </div>
                <div class="actions">
                  {#if p.oauthSupported && p.authSource !== "oauth"}
                    <button
                      class="btn"
                      data-testid="provider-signin"
                      title={`Sign in to ${p.name} with OAuth`}
                      onclick={() => store.oauthLogin(p.id)}
                    >
                      Sign in
                    </button>
                  {/if}
                  {#if p.apiKeySetupSupported}
                    <Button
                      title={p.authSource === "auth_file"
                        ? `Replace the API key for ${p.name}`
                        : `Set an API key for ${p.name}`}
                      onclick={() => openKeyField(p.id)}
                    >
                      {p.authSource === "auth_file" ? "Replace key" : "Set key"}
                    </Button>
                  {/if}
                  {#if p.authSource === "auth_file"}
                    <Button
                      variant="danger"
                      title={`Remove the saved API key for ${p.name}`}
                      onclick={() => store.removeProviderApiKey(p.id)}
                    >
                      Remove
                    </Button>
                  {/if}
                  {#if p.authSource === "oauth"}
                    <button
                      class="btn danger"
                      data-testid="provider-signout"
                      title={`Sign out of ${p.name}`}
                      onclick={() => store.oauthLogout(p.id)}
                    >
                      Sign out
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
                  <Button variant="primary" type="submit" title="Save this API key" disabled={!keyDraft.trim()}>Save</Button>
                  <Button type="button" title="Cancel without saving the key" onclick={cancelKeyField}>Cancel</Button>
                </form>
              {/if}
            {/each}
            {#if filteredProviders.length === 0}
              <div class="mempty">No providers match</div>
            {/if}
          </div>
          <p class="note">
            Keys save into pi's <code>auth.json</code> on the server — shared with the
            terminal <code>pi</code> on this machine. Providers configured via environment
            variables show as connected but aren't editable here.
          </p>
          {/if}
          </div>
        {/if}
      </section>
      {/if}

      <!-- Models -->
      {#if activeSection === "models"}
      <section class="group">
        <div class="row dm-row">
          <div class="rinfo">
            <div class="rlabel">Default model</div>
            <div class="rdesc">
              For new sessions. Switch the current session from the header.
            </div>
          </div>
          <DefaultModelPicker />
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

        <button
          class="gtitle gtitle-toggle subhead"
          type="button"
          aria-expanded={favoritesOpen}
          data-testid="favorites-toggle"
          title={favoritesOpen ? "Collapse favorites" : "Expand favorites"}
          onclick={() => (favoritesOpen = !favoritesOpen)}
        >
          <Chevron open={favoritesOpen} size={10} />
          <span class="gtitle-name">Favorites</span>
          {#if totalModels > 0}
            <span class="gtitle-count">
              {#if totalFavorites > 0}<span class="favstar">{totalFavorites}★</span> · {/if}{totalModels}
              model{totalModels === 1 ? "" : "s"}
            </span>
          {/if}
        </button>
        {#if favoritesOpen}
          <div class="section-body" transition:reveal>
          <p class="note fav-note">
            The header picker shows only your favorites (none set = show all).
          </p>
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
              onkeydown={(e) => searchEsc(e, () => (favQuery = ""), fq !== "")}
            />
            <div class="models">
              {#each favGroups as g (g.provider)}
                {@const expanded = isFavExpanded(g.provider)}
                {@const favCount = g.items.filter((m) =>
                  store.isFavorite(m.provider, m.modelId),
                ).length}
                <button
                  class="mprovider mprovider-toggle"
                  type="button"
                  aria-expanded={expanded}
                  data-testid="fav-group-{g.provider}"
                  title={expanded
                    ? `Collapse ${g.provider}`
                    : `Expand ${g.provider} (${g.items.length} model${g.items.length === 1 ? "" : "s"})`}
                  onclick={() => toggleFavProvider(g.provider)}
                >
                  <Chevron open={expanded} size={10} />
                  <span class="mprovider-name">{g.provider}</span>
                  <span class="mprovider-count">
                    {#if favCount > 0}<span class="favstar">{favCount}★</span> · {/if}{g.items
                      .length}
                  </span>
                </button>
                {#if expanded}
                  <div class="mgroup-items" transition:reveal={{ duration: 140 }}>
                    {#each g.items as opt (opt.modelId)}
                      <label class="mitem fav" data-testid="fav-{opt.provider}-{opt.modelId}">
                        <input
                          type="checkbox"
                          title={store.isFavorite(opt.provider, opt.modelId)
                            ? `Remove ${opt.label} from favorites`
                            : `Add ${opt.label} to favorites`}
                          checked={store.isFavorite(opt.provider, opt.modelId)}
                          onchange={() => store.toggleFavorite(opt.provider, opt.modelId)}
                        />
                        <span class="mlabel">{opt.label}</span>
                      </label>
                    {/each}
                  </div>
                {/if}
              {/each}
              {#if favGroups.length === 0}
                <div class="mempty">No models match</div>
              {/if}
            </div>
          {/if}
          </div>
        {/if}
      </section>
      {/if}

      <!-- Extensions -->
      {#if activeSection === "extensions"}
      <section class="group">
        <button
          class="gtitle gtitle-toggle"
          type="button"
          aria-expanded={extensionsOpen}
          data-testid="extensions-toggle"
          title={extensionsOpen ? "Collapse extensions" : "Expand extensions"}
          onclick={toggleExtensionsSection}
        >
          <Chevron open={extensionsOpen} size={10} />
          <span class="gtitle-name">Extensions</span>
          {#if extensions.length > 0}
            <span class="gtitle-count">{extensionsOn}/{extensions.length} on</span>
          {/if}
        </button>
        {#if extensionsOpen}
          <div class="section-body" transition:reveal>
          {#if extensions.length === 0}
            <p class="note">No extensions loaded for this session.</p>
          {:else}
          {#if extensions.length > 1}
            <input
              class="sub-search"
              type="text"
              placeholder="Search extensions…"
              title="Filter extensions by name or source"
              aria-label="Search extensions"
              spellcheck="false"
              autocapitalize="off"
              autocorrect="off"
              bind:value={extQuery}
              onkeydown={(e) => searchEsc(e, () => (extQuery = ""), xq !== "")}
            />
          {/if}
          <div class="exts">
            {#each extGroups as g (g.origin)}
              {@const expanded = isExtOriginExpanded(g.origin)}
              {@const groupOn = g.items.filter((x) => x.enabled).length}
              <button
                class="mprovider mprovider-toggle ext-origin"
                type="button"
                aria-expanded={expanded}
                data-testid="ext-origin-{g.origin}"
                title={expanded
                  ? `Collapse ${g.origin} extensions`
                  : `Expand ${g.origin} extensions (${g.items.length} total)`}
                onclick={() => toggleExtOrigin(g.origin)}
              >
                <Chevron open={expanded} size={10} />
                <span class="mprovider-name">{g.origin}</span>
                <span class="mprovider-count">{groupOn}/{g.items.length}</span>
              </button>
              {#if expanded}
                <div class="mgroup-items" transition:reveal={{ duration: 140 }}>
                  {#each g.items as x (x.resolvedPath)}
                    <div
                      class="ext"
                      class:off={!x.enabled}
                      class:pilot={g.origin === "Pilot"}
                      data-testid="ext-{x.name}"
                    >
                      <div class="rinfo">
                        <div class="rlabel">{x.name}</div>
                        <div class="rdesc">
                          {#if x.description}{x.description} · {/if}{x.source}{#if x.toolCount > 0}
                            · {x.toolCount} tool{x.toolCount === 1 ? "" : "s"}{/if}{#if x.commandCount > 0}
                            · {x.commandCount} command{x.commandCount === 1 ? "" : "s"}{/if}
                        </div>
                        {#if x.error}
                          <div class="ext-error" title={x.error}>⚠ {x.error}</div>
                        {/if}
                        {#if !x.enabled && EXT_LOAD_BEARING_WARNINGS[x.name.replace(/\.ts$/, "")]}
                          <div class="ext-error" data-testid="ext-warn-{x.name}">
                            ⚠ {EXT_LOAD_BEARING_WARNINGS[x.name.replace(/\.ts$/, "")]}
                          </div>
                        {/if}
                      </div>
                      <button
                        class="seg-btn"
                        class:active={x.enabled}
                        role="switch"
                        aria-checked={x.enabled}
                        data-testid="ext-toggle-{x.name}"
                        title={x.enabled
                          ? `Disable ${x.name} (applies on this session's next start)`
                          : `Enable ${x.name} (applies on this session's next start)`}
                        onclick={() => store.setExtensionEnabled(x.resolvedPath, !x.enabled)}
                      >
                        {x.enabled ? "On" : "Off"}
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            {/each}
            {#if filteredExtensions.length === 0}
              <div class="mempty">No extensions match</div>
            {/if}
          </div>
          <p class="note">
            Enabling or disabling takes effect on the session's <strong>next start</strong> —
            pi loads extensions when a session begins, so the change isn't live.
          </p>
          {/if}
          </div>
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
      {/if}
      </div>
    </div>
  </div>
{/if}

{#if oauth}
  <div class="scrim oauth-scrim" role="presentation"></div>
  <div
    class="oauth-dialog"
    role="dialog"
    aria-modal="true"
    aria-label="Provider sign-in"
    data-testid="oauth-dialog"
  >
    <header class="phead">
      <h2>Signing in</h2>
      <IconButton
        title="Cancel sign-in"
        aria-label="Close sign-in"
        onclick={() => store.oauthCancel()}>✕</IconButton
      >
    </header>
    <div class="oauth-body">
      {#each oauth.progress as line, i (i)}
        <p class="oauth-progress">{line}</p>
      {/each}

      {#if oauth.error}
        <p class="oauth-error" data-testid="oauth-error">{oauth.error}</p>
      {/if}

      {#if oauth.prompt}
        {#if oauth.prompt.url}
          <a
            class="btn oauth-open"
            href={oauth.prompt.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the authorization page in a new tab"
            data-testid="oauth-open">Open authorization page ↗</a
          >
          {#if oauth.prompt.instructions}
            <p class="note">{oauth.prompt.instructions}</p>
          {/if}
        {/if}

        {#if oauth.prompt.kind === "select"}
          <div class="oauth-options">
            {#each oauth.prompt.options ?? [] as opt (opt.id)}
              <button
                class="btn ghost"
                title={opt.label}
                onclick={() => store.oauthRespond(opt.id)}>{opt.label}</button
              >
            {/each}
          </div>
        {:else}
          <form
            class="oauth-form"
            onsubmit={(e) => {
              e.preventDefault();
              submitOauth();
            }}
          >
            <label class="oauth-msg" for="oauth-input">{oauth.prompt.message}</label>
            <input
              id="oauth-input"
              bind:value={oauthDraft}
              type="text"
              placeholder={oauth.prompt.placeholder ?? "Paste here…"}
              autocomplete="off"
              spellcheck="false"
              autocapitalize="off"
              autocorrect="off"
              data-testid="oauth-input"
            />
            <div class="actions">
              <button
                class="btn"
                type="submit"
                title="Submit and finish sign-in"
                disabled={!oauthDraft.trim()}>Submit</button
              >
              <button
                class="btn ghost"
                type="button"
                title="Cancel sign-in"
                onclick={() => store.oauthCancel()}>Cancel</button
              >
            </div>
          </form>
        {/if}
      {:else if oauth.device}
        <p class="note">
          Open
          <a
            href={oauth.device.verificationUri}
            target="_blank"
            rel="noopener noreferrer">{oauth.device.verificationUri}</a
          >
          and enter this code:
        </p>
        <p class="oauth-code" data-testid="oauth-device-code">
          {oauth.device.userCode}
        </p>
      {:else if oauth.done}
        <p class="oauth-progress" data-testid="oauth-done">
          {oauth.error ? "Sign-in failed." : "Signed in ✓"}
        </p>
        <div class="actions">
          <button class="btn" title="Close" onclick={() => store.closeOauth()}
            >Close</button
          >
        </div>
      {:else}
        <p class="oauth-progress">Working…</p>
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
  /* Collapsible section header (Providers) — same weight as .gtitle, but clickable. */
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
  /* Search box shared by the Providers / Extensions collapsible sections. */
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
