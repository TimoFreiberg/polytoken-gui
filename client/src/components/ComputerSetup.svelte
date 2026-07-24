<script lang="ts">
  import { tick } from "svelte";
  import { overlayHistory, PHONE_MQ } from "../lib/overlay-history.js";
  import { store } from "../lib/store.svelte.js";
  import type { HostCoordinator } from "../lib/hosts.svelte.js";
  import type {
    ContainerInspection,
    ContainerSummary,
    NativeHostDescriptor,
    PendingRisk,
    RemoteProfile,
    TestSshResult,
  } from "../lib/hosts/types.js";
  import type { HostProvider } from "../lib/hosts/provider.js";
  import {
    humanizeContainerName,
    humanizeSshHost,
    suggestPantokenRoot,
    formatBacking,
    findSocketMount,
    RISK_BODIES,
  } from "../lib/hosts/docker-format.js";
  import { redactSshDestination } from "../lib/hosts/types.js";
  import Button from "./ui/Button.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import SegmentedControl from "./ui/SegmentedControl.svelte";
  import Chevron from "./ui/Chevron.svelte";

  // ── Props ────────────────────────────────────────────────────────────────
  const { coordinator }: { coordinator: HostCoordinator } = $props();
  const provider: HostProvider = coordinator.hostProvider;

  // ── Dialog state ──────────────────────────────────────────────────────────
  const open = $derived(store.computerSetupOpen);
  const mode = $derived(store.computerSetupMode);
  const editProfileId = $derived(store.computerSetupProfileId);
  let phone = $state(false);
  let panelEl = $state<HTMLDivElement>();
  let previousFocus: HTMLElement | null = null;
  let historyTracked = false;

  // ── Setup state machine ──────────────────────────────────────────────────
  type Stage =
    | "sshFields" // Stage 1: SSH fields + segmented control
    | "testing" // SSH test in progress
    | "sshFailed" // SSH test failed
    | "containerPicker" // Stage 2: container picker
    | "exactName" // Exact-name fallback
    | "reviewRisks" // Risk panel
    | "provisioning" // Four-phase provisioning
    | "provisioningFailed" // Provisioning failure
    | "edit"; // Edit dialog

  let stage = $state<Stage>("sshFields");
  let nameTouched = $state(false);
  let rootTouched = $state(false);

  // Form fields
  let name = $state("");
  let sshDestination = $state("");
  let port = $state(22);
  let execEnv = $state<"host" | "docker">("docker");
  let serverPath = $state("");
  let xdgMode = $state<"isolated" | "shared">("isolated");
  let advancedOpen = $state(false);
  let customizeOpen = $state(false);

  // Test results
  let testResult = $state<TestSshResult | null>(null);
  let testError = $state<{ title: string; message: string } | null>(null);
  let testSubStep = $state(0);

  // Container selection
  let selectedContainer = $state<ContainerSummary | null>(null);
  let exactContainerName = $state("");
  let containerSearch = $state("");
  let inspection = $state<ContainerInspection | null>(null);
  let inspectionError = $state<string | null>(null);

  // Container user + root (from inspection / customize)
  let containerUser = $state("");
  let pantokenRoot = $state("");

  // Risk state
  let pendingRisks = $state<PendingRisk[]>([]);
  let riskError = $state<string | null>(null);

  // Provisioning state
  let provisioningPhase = $state(1);
  let provisioningFailed = $state<{ title: string; message: string; detail?: string } | null>(null);
  let showTechnicalDetails = $state(false);
  let savedProfileId = $state<string | null>(null);
  let backgrounded = $state(false);

  // Edit state
  let editProfile = $state<RemoteProfile | null>(null);

  // Dirty check — whether any form fields have been modified.
  let dirty = $derived(
    name !== "" ||
    sshDestination !== "" ||
    selectedContainer !== null ||
    exactContainerName !== "" ||
    containerUser !== "" ||
    pantokenRoot !== "",
  );

  // ── Computed ─────────────────────────────────────────────────────────────
  const supportsDocker = $derived(provider.supportsContainerTargets());
  const containers = $derived(testResult?.containers ?? []);
  const sortedContainers = $derived(
    [...containers].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const filteredContainers = $derived(
    containerSearch.trim()
      ? sortedContainers.filter((c) =>
          c.name.toLowerCase().includes(containerSearch.toLowerCase()),
        )
      : sortedContainers,
  );
  const showSearch = $derived(containers.length > 6);
  const sshHost = $derived(redactSshDestination(sshDestination).host);
  const isEphemeralOnly = $derived(
    pendingRisks.length === 1 && pendingRisks[0]?.kind === "ephemeralData",
  );

  // Provisioning phase labels
  const PHASE_LABELS = ["SSH & Docker", "Container", "Polytoken", "Pantoken runtime"];
  const safelyCancellable = $derived(provisioningPhase <= 2);

  // ── Phone detection ──────────────────────────────────────────────────────
  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(PHONE_MQ);
    const update = () => (phone = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  // ── Open/close lifecycle ─────────────────────────────────────────────────
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      previousFocus = document.activeElement as HTMLElement | null;
      resetState();
      if (mode === "edit" && editProfileId) {
        void loadEditProfile(editProfileId);
      }
      overlayHistory.opened("computer-setup", closeFromHistory);
      historyTracked = phone;
      void focusPanel();
    }
    if (!open && prevOpen) {
      overlayHistory.closed("computer-setup");
      historyTracked = false;
    }
    prevOpen = open;
  });

  async function focusPanel(): Promise<void> {
    await tick();
    panelEl?.focus();
  }

  function closeFromHistory(): void {
    historyTracked = false;
    store.closeComputerSetup();
    restoreFocus();
  }

  function restoreFocus(): void {
    const target = phone
      ? document.querySelector<HTMLElement>(".composer-surface textarea")
      : previousFocus;
    target?.focus();
  }

  function requestClose(): void {
    if (stage === "provisioning") {
      // Once provisioning starts, close = Run in background.
      backgrounded = true;
      overlayHistory.closed("computer-setup");
      historyTracked = false;
      store.closeComputerSetup();
      restoreFocus();
      return;
    }
    if (dirty && stage !== "provisioningFailed") {
      if (!window.confirm("Discard changes?")) return;
    }
    overlayHistory.closed("computer-setup");
    historyTracked = false;
    store.closeComputerSetup();
    restoreFocus();
  }

  function resetState(): void {
    stage = "sshFields";
    nameTouched = false;
    rootTouched = false;
    name = "";
    sshDestination = "";
    port = 22;
    execEnv = "docker";
    serverPath = "";
    xdgMode = "isolated";
    advancedOpen = false;
    customizeOpen = false;
    testResult = null;
    testError = null;
    testSubStep = 0;
    selectedContainer = null;
    exactContainerName = "";
    containerSearch = "";
    inspection = null;
    inspectionError = null;
    containerUser = "";
    pantokenRoot = "";
    pendingRisks = [];
    riskError = null;
    provisioningPhase = 1;
    provisioningFailed = null;
    showTechnicalDetails = false;
    savedProfileId = null;
    backgrounded = false;
    editProfile = null;
  }

  async function loadEditProfile(id: string): Promise<void> {
    const profile = await provider.getProfile(id);
    if (!profile) return;
    editProfile = profile;
    stage = "edit";
    name = profile.label;
    nameTouched = true;
    sshDestination = profile.sshDestination;
    port = profile.port ?? 22;
    serverPath = profile.serverPath ?? "";
    xdgMode = profile.xdgMode;
    if (profile.executionTarget.kind === "dockerContainer") {
      execEnv = "docker";
      exactContainerName = profile.executionTarget.containerName;
      containerUser = profile.executionTarget.user;
      pantokenRoot = profile.executionTarget.pantokenRoot;
    } else {
      execEnv = "host";
    }
  }

  // ── SSH test ──────────────────────────────────────────────────────────────
  async function runTest(): Promise<void> {
    if (!sshDestination.trim()) return;
    stage = "testing";
    testError = null;
    testResult = null;
    testSubStep = 0;

    // Simulate sub-steps for the status box.
    const stepTimer = setInterval(() => {
      testSubStep = Math.min(testSubStep + 1, 2);
    }, 400);

    try {
      const result = await provider.testSshAndListContainers(sshDestination, port);
      clearInterval(stepTimer);
      testResult = result;
      if (!result.sshOk) {
        stage = "sshFailed";
        testError = {
          title: "Can't reach the host",
          message: "Check the SSH destination and try again.",
        };
        return;
      }
      // Suggest name if untouched.
      if (!nameTouched) {
        if (execEnv === "docker") {
          // Will be set after container selection.
        } else {
          name = humanizeSshHost(sshDestination);
        }
      }
      stage = "containerPicker";
    } catch (err) {
      clearInterval(stepTimer);
      stage = "sshFailed";
      const e = err as Error;
      testError = {
        title: e.message.includes("not available")
          ? "Container commands unavailable"
          : "SSH authentication failed",
        message: e.message,
      };
    }
  }

  function retryTest(): void {
    stage = "sshFields";
    testError = null;
  }

  function editSshFields(): void {
    stage = "sshFields";
    testError = null;
  }

  // ── Container selection ──────────────────────────────────────────────────
  function selectContainer(c: ContainerSummary): void {
    selectedContainer = c;
    // Suggest name if untouched.
    if (!nameTouched) {
      name = humanizeContainerName(c.name);
    }
    // Fetch inspection for customize target.
    void fetchInspection(c.name);
  }

  async function fetchInspection(containerName: string): Promise<void> {
    inspectionError = null;
    try {
      const insp = await provider.inspectContainer(sshDestination, port, containerName);
      inspection = insp;
      containerUser = insp.configuredUser || insp.resolvedUser;
      if (!rootTouched) {
        pantokenRoot = insp.pantokenRootSuggestion;
      }
    } catch (err) {
      inspection = null;
      inspectionError = (err as Error).message;
    }
  }

  function useExactName(): void {
    stage = "exactName";
    selectedContainer = null;
  }

  function backToPicker(): void {
    stage = "containerPicker";
    exactContainerName = "";
  }

  function saveExactNameLater(): void {
    // Save a profile for a non-running container without provisioning.
    const profile = buildProfile(exactContainerName);
    void saveAndStore(profile, false);
  }

  // ── Use this container ────────────────────────────────────────────────────
  async function useThisContainer(): Promise<void> {
    const containerName = selectedContainer?.name ?? exactContainerName;
    if (!containerName) return;

    // If using exact name, fetch inspection first.
    if (!inspection && !inspectionError) {
      await fetchInspection(containerName);
    }

    // Build and save the profile, then start provisioning.
    const profile = buildProfile(containerName);
    await saveAndStore(profile, true);
  }

  function buildProfile(containerName: string): RemoteProfile {
    const id = editProfile?.id ?? `docker-${Date.now()}`;
    return {
      id,
      label: name || humanizeContainerName(containerName),
      sshDestination,
      port: port || 22,
      polytokenPolicy: "requireExisting",
      serverPath: serverPath || undefined,
      xdgMode,
      executionTarget: {
        kind: "dockerContainer",
        containerName,
        user: containerUser || "root",
        pantokenRoot: pantokenRoot || suggestPantokenRoot("/root"),
      },
      riskAcknowledgements: editProfile?.riskAcknowledgements ?? {},
    };
  }

  async function saveAndStore(profile: RemoteProfile, startProvisioning: boolean): Promise<void> {
    const saved = await provider.addProfile(profile);
    savedProfileId = saved.id;
    await coordinator.refreshHosts();

    if (startProvisioning) {
      stage = "provisioning";
      provisioningPhase = 1;
      // Start the connection — this will transition through preflight/acknowledgement.
      try {
        await coordinator.connectHost(saved.id);
        // Check if the host is now in awaitingAcknowledgement.
        const hosts = await provider.listHosts();
        const host = hosts.find((h) => h.id === saved.id);
        if (host?.state === "awaitingAcknowledgement" && host.pendingRisks) {
          pendingRisks = host.pendingRisks;
          stage = "reviewRisks";
        } else if (host?.state === "failed") {
          provisioningFailed = {
            title: host.failureLabel ?? "Connection failed",
            message: host.failureLabel ?? "Connection failed",
            detail: host.failureDetail,
          };
          stage = "provisioningFailed";
        } else if (host?.state === "ready") {
          // Already ready (dev provider may skip provisioning).
          provisioningPhase = 4;
          onComplete();
        }
      } catch (err) {
        const e = err as Error;
        provisioningFailed = {
          title: "Connection failed",
          message: e.message,
        };
        stage = "provisioningFailed";
      }
    } else {
      // Saved without provisioning — close the dialog.
      requestClose();
    }
  }

  // ── Risk acknowledgement ──────────────────────────────────────────────────
  async function acceptRisks(): Promise<void> {
    riskError = null;
    try {
      for (const risk of pendingRisks) {
        await provider.acknowledgeRisk(savedProfileId!, risk.id, risk.fingerprint);
      }
      // All risks acknowledged — resume the connection.
      await provider.resumeConnection(savedProfileId!);
      await coordinator.refreshHosts();
      const hosts = await provider.listHosts();
      const host = hosts.find((h) => h.id === savedProfileId);
      if (host?.state === "ready") {
        provisioningPhase = 4;
        onComplete();
      } else if (host?.state === "failed") {
        provisioningFailed = {
          title: host.failureLabel ?? "Provisioning failed",
          message: host.failureLabel ?? "Provisioning failed",
          detail: host.failureDetail,
        };
        stage = "provisioningFailed";
      } else {
        // Transition to provisioning view.
        stage = "provisioning";
        provisioningPhase = 2;
      }
    } catch (err) {
      riskError = (err as Error).message;
    }
  }

  function chooseAnotherPath(): void {
    // Return to the customize target disclosure for the ephemeral-only case.
    stage = "containerPicker";
    customizeOpen = true;
    pendingRisks = [];
  }

  // ── Provisioning ───────────────────────────────────────────────────────────
  function cancelSetup(): void {
    if (!safelyCancellable) return;
    // Cancel the connection — leaves the saved profile disconnected.
    if (savedProfileId) {
      void provider.cancelConnection(savedProfileId).then(() => coordinator.refreshHosts());
    }
    requestClose();
  }

  function onComplete(): void {
    // If dialog still open at success: auto-close and select the new computer.
    if (!backgrounded && savedProfileId) {
      void coordinator.selectHost(savedProfileId);
    }
    requestClose();
  }

  // ── Edit dialog actions ───────────────────────────────────────────────────
  function reconnectNow(): void {
    if (!editProfile) return;
    const updated = buildEditProfile();
    void provider.updateProfile(updated).then(async () => {
      await coordinator.refreshHosts();
      if (editProfile) {
        await coordinator.connectHost(editProfile.id);
      }
      requestClose();
    });
  }

  function reconnectLater(): void {
    if (!editProfile) return;
    const updated = buildEditProfile();
    void provider.updateProfile(updated).then(() => coordinator.refreshHosts());
    requestClose();
  }

  function buildEditProfile(): RemoteProfile {
    if (!editProfile) return buildProfile(exactContainerName);
    return {
      ...editProfile,
      label: name,
      sshDestination,
      port: port || 22,
      serverPath: serverPath || undefined,
      xdgMode,
      executionTarget: editProfile.executionTarget.kind === "dockerContainer"
        ? {
            kind: "dockerContainer",
            containerName: exactContainerName || editProfile.executionTarget.containerName,
            user: containerUser || editProfile.executionTarget.user,
            pantokenRoot: pantokenRoot || editProfile.executionTarget.pantokenRoot,
          }
        : { kind: "host" },
    };
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      if (phone && stage !== "sshFields" && stage !== "edit") {
        // On phone, back goes to previous stage.
        if (stage === "exactName") backToPicker();
        else if (stage === "containerPicker") stage = "sshFields";
        else requestClose();
      } else {
        requestClose();
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function onNameInput(e: Event): void {
    name = (e.target as HTMLInputElement).value;
    nameTouched = true;
  }

  function onRootInput(e: Event): void {
    pantokenRoot = (e.target as HTMLInputElement).value;
    rootTouched = true;
  }

  function onContainerUserInput(e: Event): void {
    containerUser = (e.target as HTMLInputElement).value;
    // Recompute root suggestion unless user edited the path.
    if (!rootTouched && inspection) {
      const newHome = containerUser === "root" ? "/root" : `/home/${containerUser}`;
      pantokenRoot = suggestPantokenRoot(newHome);
    }
  }

  const backingLine = $derived(inspection ? formatBacking(inspection) : "");
  const hasSocketMount = $derived(inspection ? Boolean(findSocketMount(inspection.mounts)) : false);

  // Watch for provisioning phase changes from the dev provider.
  $effect(() => {
    if (stage !== "provisioning" || !savedProfileId) return;
    const summary = coordinator.summaries.find((s) => s.descriptor.id === savedProfileId);
    if (!summary) return;
    const desc = summary.descriptor;
    if (desc.state === "ready" && provisioningPhase < 4) {
      provisioningPhase = 4;
      onComplete();
    } else if (desc.state === "failed") {
      provisioningFailed = {
        title: desc.failureLabel ?? "Provisioning failed",
        message: desc.failureLabel ?? "Provisioning failed",
        detail: desc.failureDetail,
      };
      stage = "provisioningFailed";
    } else if (desc.state === "provisioning") {
      // Advance phase based on preflightPhase or provisioning state.
      if (desc.preflightPhase) {
        provisioningPhase = 2;
      }
    }
  });

  const dialogTitle = $derived(
    stage === "edit" ? "Edit computer" :
    stage === "provisioning" || stage === "provisioningFailed" ? `Connecting to ${name || "Docker target"}` :
    stage === "reviewRisks" ? "Review risks" :
    "Add computer",
  );

  const closeLabel = $derived(
    stage === "provisioning" ? "Run in background" : "Close",
  );

  const footerRight = $derived.by(() => {
    if (stage === "containerPicker") {
      return `SSH: ${sshDestination}:${port} · Docker container`;
    }
    if (stage === "reviewRisks") {
      return `${pendingRisks.length} risk${pendingRisks.length === 1 ? "" : "s"} detected · one click to accept all`;
    }
    if (stage === "provisioning") {
      return `Phase ${provisioningPhase} of 4 · ${PHASE_LABELS[provisioningPhase - 1]}`;
    }
    if (stage === "provisioningFailed") {
      return `Failed at phase ${provisioningPhase} of 4 · ${PHASE_LABELS[provisioningPhase - 1]}`;
    }
    return "";
  });
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="scrim" onclick={() => requestClose()} role="presentation"></div>
  <div
    bind:this={panelEl}
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label={dialogTitle}
    data-testid="computer-setup-panel"
    tabindex="-1"
  >
    <header class="phead">
      {#if phone && stage !== "sshFields" && stage !== "edit"}
        <button class="mobile-back" type="button" aria-label="Back" onclick={() => {
          if (stage === "exactName") backToPicker();
          else if (stage === "containerPicker") stage = "sshFields";
          else if (stage === "reviewRisks") stage = "containerPicker";
          else requestClose();
        }}>
          <span class="back-chevron"><Chevron size={14} /></span>
          <span>Back</span>
        </button>
      {/if}
      <h2>{dialogTitle}</h2>
      <button class="close-btn" onclick={() => requestClose()} data-testid="computer-setup-close">
        {closeLabel}
      </button>
    </header>

    <div class="body">
      <!-- ── Stage 1: SSH fields + segmented control ─────────────────────── -->
      {#if stage === "sshFields" || stage === "testing" || stage === "sshFailed"}
        <div class="field">
          <label for="cs-name">Name <span class="opt">(optional)</span></label>
          <input
            id="cs-name"
            type="text"
            placeholder="e.g. Work API Dev"
            value={name}
            oninput={onNameInput}
            data-testid="cs-name-input"
          />
        </div>

        <div class="field">
          <label for="cs-ssh">SSH destination</label>
          <div class="ssh-row">
            <input
              id="cs-ssh"
              type="text"
              placeholder="user@host or SSH config alias"
              value={sshDestination}
              oninput={(e) => sshDestination = (e.target as HTMLInputElement).value}
              data-testid="cs-ssh-input"
            />
            <input
              type="number"
              placeholder="Port"
              value={port}
              min={1}
              max={65535}
              oninput={(e) => port = Number((e.target as HTMLInputElement).value) || 22}
              class="port-input"
              data-testid="cs-port-input"
            />
          </div>
          <p class="hint">Pantoken uses your existing SSH config, agent, and keychain. No passwords stored.</p>
        </div>

        <div class="field">
          <label>Execution environment</label>
          <SegmentedControl
            ariaLabel="Execution environment"
            value={execEnv}
            onchange={(v: "host" | "docker") => execEnv = v}
            options={[
              { value: "host", label: "Host", testid: "cs-env-host" },
              { value: "docker", label: "Docker container", testid: "cs-env-docker", title: supportsDocker ? "Docker container" : "Docker targets require the Pantoken desktop app" },
            ]}
          />
          {#if !supportsDocker && execEnv === "docker"}
            <p class="hint warn" data-testid="cs-docker-degraded">Docker targets require the Pantoken desktop app</p>
          {:else}
            <p class="hint">Run the agent directly on the SSH host, or inside a Docker container on that host.</p>
          {/if}
        </div>

        {#if stage === "testing"}
          <div class="testing-box" data-testid="cs-testing">
            <div class="testing-spinner">
              <span class="spinner" aria-hidden="true"></span>
              <span>Testing SSH & finding containers…</span>
            </div>
            <div class="sub-steps">
              {#each ["Connecting to " + sshHost + " via SSH…", "Checking Docker access…", "Listing running containers…"] as step, i}
                <div class="sub-step" class:done={testSubStep > i} class:active={testSubStep === i}>
                  {#if testSubStep > i}<span class="check">✓</span>{:else if testSubStep === i}<span class="spinner-sm" aria-hidden="true"></span>{:else}<span class="dot">•</span>{/if}
                  {step}
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <Button
            variant="primary"
            block
            disabled={!sshDestination.trim() || (execEnv === "docker" && !supportsDocker)}
            onclick={() => void runTest()}
            data-testid="cs-test-ssh"
          >
            {stage === "sshFailed" ? "Test SSH & find containers" : "Test SSH & find containers"}
          </Button>
        {/if}

        {#if stage === "sshFailed" && testError}
          <div class="error-box" data-testid="cs-ssh-error">
            <div class="error-title">⚠ {testError.title}</div>
            <div class="error-msg">{testError.message}</div>
            <div class="error-actions">
              <Button variant="primary" onclick={() => void runTest()}>Retry</Button>
              <Button onclick={editSshFields}>Edit</Button>
            </div>
          </div>
        {/if}

        <!-- Advanced disclosure -->
        <button class="disclosure" onclick={() => advancedOpen = !advancedOpen} aria-expanded={advancedOpen}>
          {advancedOpen ? "▾" : "▸"} Advanced
        </button>
        {#if advancedOpen}
          <div class="advanced-body">
            <div class="field">
              <label for="cs-server-path">Server binary path</label>
              <input id="cs-server-path" type="text" placeholder="Default" value={serverPath} oninput={(e) => serverPath = (e.target as HTMLInputElement).value} />
            </div>
            <div class="field">
              <label>XDG mode</label>
              <SegmentedControl
                ariaLabel="XDG mode"
                value={xdgMode}
                onchange={(v: "isolated" | "shared") => xdgMode = v}
                options={[
                  { value: "isolated", label: "Isolated" },
                  { value: "shared", label: "Shared" },
                ]}
              />
            </div>
          </div>
        {/if}
      {/if}

      <!-- ── Stage 2: Container picker ───────────────────────────────────── -->
      {#if stage === "containerPicker" && testResult}
        <div class="ssh-summary" data-testid="cs-ssh-summary">
          ● SSH connected to {sshHost} · Docker permission: {testResult.dockerPermission}
        </div>

        {#if !nameTouched}
          <div class="field">
            <label for="cs-name-2">Name <span class="opt">(optional)</span></label>
            <input id="cs-name-2" type="text" placeholder="e.g. Work API Dev" value={name} oninput={onNameInput} data-testid="cs-name-input-2" />
          </div>
        {/if}

        <div class="section-label">Running containers ({containers.length})</div>

        {#if showSearch}
          <input
            type="text"
            class="container-search"
            placeholder="🔍 Search containers…"
            value={containerSearch}
            oninput={(e) => containerSearch = (e.target as HTMLInputElement).value}
            data-testid="cs-container-search"
          />
        {/if}

        <div class="container-list" role="listbox" aria-label="Running containers">
          {#each filteredContainers as c (c.name)}
            <button
              class="container-row"
              class:selected={selectedContainer?.name === c.name}
              role="option"
              aria-selected={selectedContainer?.name === c.name}
              data-testid={`cs-container-${c.name}`}
              onclick={() => selectContainer(c)}
            >
              <span class="ctr-glyph">▣</span>
              <span class="ctr-info">
                <span class="ctr-name">{c.name}</span>
                <span class="ctr-meta">
                  <span class="ctr-image">{c.image}</span>
                  ·
                  <span>{c.configuredUser || "Image default"}</span>
                  {#if c.composeProject}<span class="ctr-compose">compose: {c.composeProject}/{c.composeService}</span>{/if}
                </span>
              </span>
              <span class="ctr-state">{c.state}</span>
            </button>
          {/each}
        </div>

        <button class="link-btn" onclick={useExactName} data-testid="cs-exact-name-link">
          Enter exact container name instead
        </button>

        {#if selectedContainer}
          <button class="disclosure" onclick={() => customizeOpen = !customizeOpen} aria-expanded={customizeOpen} data-testid="cs-customize-toggle">
            {customizeOpen ? "▾" : "▸"} Customize target
          </button>
          {#if customizeOpen}
            <div class="customize-body" data-testid="cs-customize">
              {#if inspectionError}
                <p class="hint warn">Container inspection unavailable: {inspectionError}</p>
              {:else if inspection}
                <div class="field">
                  <label for="cs-user">Container user</label>
                  <input id="cs-user" type="text" value={containerUser} oninput={onContainerUserInput} data-testid="cs-user-input" />
                  <p class="resolved-id">{containerUser} · UID {inspection.resolvedUid}</p>
                  <p class="hint">Always persisted explicitly. Pre-filled from the container's configured user.</p>
                </div>
                <div class="field">
                  <label for="cs-root">Pantoken root</label>
                  <input id="cs-root" type="text" value={pantokenRoot} oninput={onRootInput} data-testid="cs-root-input" />
                  <p class="hint">Default = selected user's home + /.local/share/pantoken. Never persists ~.</p>
                  {#if backingLine}<p class="backing-line" data-testid="cs-backing">{backingLine}</p>{/if}
                </div>
              {:else}
                <p class="hint">Loading inspection…</p>
              {/if}
            </div>
          {/if}
          <Button variant="primary" block onclick={() => void useThisContainer()} data-testid="cs-use-container">
            Use this container
          </Button>
        {/if}
      {/if}

      <!-- ── Exact-name fallback ─────────────────────────────────────────── -->
      {#if stage === "exactName"}
        <button class="link-btn" onclick={backToPicker} data-testid="cs-back-to-list">
          ‹ Back to container list
        </button>
        <div class="field">
          <label for="cs-exact">Exact container name</label>
          <input id="cs-exact" type="text" value={exactContainerName} oninput={(e) => exactContainerName = (e.target as HTMLInputElement).value} data-testid="cs-exact-input" />
          <p class="hint">The saved selector is always the exact container name. Discovery is only a convenience.</p>
        </div>
        <div class="warning-box" data-testid="cs-not-running-warning">
          <div class="warning-title">⚠ Container not currently running</div>
          <div class="warning-body">
            This container is not running right now. You can still save this profile — it will appear
            as a disconnected computer in Container not running state. It cannot provision until the
            container exists and runs. Start or recreate the container outside Pantoken, then retry.
          </div>
        </div>
        <Button variant="primary" block disabled={!exactContainerName.trim()} onclick={saveExactNameLater} data-testid="cs-save-later">
          Save & connect later
        </Button>
      {/if}

      <!-- ── Review risks panel ───────────────────────────────────────────── -->
      {#if stage === "reviewRisks"}
        <div class="risks-panel" data-testid="cs-risks-panel">
          <h3>Review risks before connecting</h3>
          <p class="risks-sub">
            The following risks were detected for {selectedContainer?.name ?? exactContainerName} via {sshHost}.
            Review each item, then accept to continue.
          </p>
          {#each pendingRisks as risk (risk.id)}
            <div class="risk-card" data-testid={`cs-risk-${risk.kind}`}>
              <div class="risk-title">⚠ {RISK_BODIES[risk.kind].title}</div>
              <div class="risk-body">{RISK_BODIES[risk.kind].body}</div>
            </div>
          {/each}
          {#if riskError}
            <div class="error-box"><div class="error-msg">{riskError}</div></div>
          {/if}
          {#if isEphemeralOnly}
            <Button variant="primary" block onclick={chooseAnotherPath} data-testid="cs-choose-path">
              Choose another path
            </Button>
            <Button block onclick={() => void acceptRisks()} data-testid="cs-accept-risks">
              Accept risks & continue
            </Button>
          {:else}
            <Button variant="primary" block onclick={() => void acceptRisks()} data-testid="cs-accept-risks">
              Accept risks & continue
            </Button>
          {/if}
        </div>
      {/if}

      <!-- ── Provisioning ────────────────────────────────────────────────── -->
      {#if stage === "provisioning" || stage === "provisioningFailed"}
        <div class="provisioning" data-testid="cs-provisioning">
          <div class="prov-subtitle">Setting up Docker target</div>
          <div class="prov-subline">{selectedContainer?.name ?? exactContainerName} via {sshHost}</div>

          <div class="phase-list">
            {#each PHASE_LABELS as label, i}
              {@const phaseNum = i + 1}
              {@const isCompleted = stage === "provisioning" && provisioningPhase > phaseNum}
              {@const isActive = stage === "provisioning" && provisioningPhase === phaseNum}
              {@const isFailed = stage === "provisioningFailed" && provisioningPhase === phaseNum}
              {@const isPending = !isCompleted && !isActive && !isFailed}
              <div class="phase" class:completed={isCompleted} class:active={isActive} class:failed={isFailed} class:pending={isPending}>
                <span class="phase-marker" aria-hidden="true">
                  {#if isCompleted}✓{:else if isFailed}✕{:else}{phaseNum}{/if}
                </span>
                <span class="phase-label">{label}</span>
                {#if isCompleted && inspection}
                  <span class="phase-detail">
                    {inspection.name} · {containerUser} (UID {inspection.resolvedUid}) · {inspection.os}/{inspection.arch} · {backingLine}
                  </span>
                {:else if isActive}
                  <span class="phase-detail">
                    {#if phaseNum === 1}SSH connected · Docker CLI available{:else if phaseNum === 2}Locating container by name · inspecting identity…{:else if phaseNum === 3}Checking compatibility{:else if phaseNum === 4}Starting runtime{/if}
                  </span>
                {/if}
              </div>
            {/each}
          </div>

          {#if stage === "provisioningFailed" && provisioningFailed}
            <div class="error-box" data-testid="cs-prov-failure">
              <div class="error-title">✕ {provisioningFailed.title}</div>
              <div class="error-msg">{provisioningFailed.message}</div>
              <div class="error-actions">
                <Button variant="primary" onclick={() => {
                  stage = "provisioning";
                  provisioningFailed = null;
                  void coordinator.connectHost(savedProfileId!);
                }}>Retry</Button>
                <Button onclick={() => requestClose()}>Edit</Button>
              </div>
              {#if provisioningFailed.detail}
                <button class="disclosure" onclick={() => showTechnicalDetails = !showTechnicalDetails} aria-expanded={showTechnicalDetails}>
                  {showTechnicalDetails ? "▾" : "▸"} Show technical details
                </button>
                {#if showTechnicalDetails}
                  <pre class="tech-details">{provisioningFailed.detail.slice(0, 500)}</pre>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Edit dialog ─────────────────────────────────────────────────── -->
      {#if stage === "edit" && editProfile}
        <div class="field">
          <label for="cs-edit-name">Name</label>
          <input id="cs-edit-name" type="text" value={name} oninput={onNameInput} data-testid="cs-edit-name" />
        </div>
        <div class="field">
          <label for="cs-edit-ssh">SSH destination</label>
          <div class="ssh-row">
            <input id="cs-edit-ssh" type="text" value={sshDestination} oninput={(e) => sshDestination = (e.target as HTMLInputElement).value} />
            <input type="number" value={port} oninput={(e) => port = Number((e.target as HTMLInputElement).value) || 22} class="port-input" />
          </div>
        </div>
        <div class="field">
          <label>Execution environment</label>
          <div class="readonly-field" data-testid="cs-edit-exec-env">
            🔒 {execEnv === "docker" ? "Docker container" : "Host"} — immutable after creation
          </div>
          <p class="hint">To switch to Host execution, add a new computer profile.</p>
        </div>
        {#if editProfile.executionTarget.kind === "dockerContainer"}
          <div class="docker-target-section" data-testid="cs-edit-docker-target">
            <div class="section-label">Docker target</div>
            <div class="field">
              <label for="cs-edit-ctr">Container name</label>
              <input id="cs-edit-ctr" type="text" value={exactContainerName} oninput={(e) => exactContainerName = (e.target as HTMLInputElement).value} data-testid="cs-edit-container-name" />
            </div>
            <div class="field">
              <label for="cs-edit-user">Container user</label>
              <input id="cs-edit-user" type="text" value={containerUser} oninput={onContainerUserInput} data-testid="cs-edit-user" />
              {#if inspection}<p class="resolved-id">{containerUser} · UID {inspection.resolvedUid}</p>{/if}
            </div>
            <div class="field">
              <label for="cs-edit-root">Pantoken root</label>
              <input id="cs-edit-root" type="text" value={pantokenRoot} oninput={onRootInput} data-testid="cs-edit-root" />
              {#if backingLine}<p class="backing-line">{backingLine}</p>{/if}
            </div>
          </div>
        {/if}
        <button class="disclosure" onclick={() => advancedOpen = !advancedOpen} aria-expanded={advancedOpen}>
          {advancedOpen ? "▾" : "▸"} Advanced
        </button>
        {#if advancedOpen}
          <div class="advanced-body">
            <div class="field">
              <label for="cs-edit-server">Server binary path</label>
              <input id="cs-edit-server" type="text" value={serverPath} oninput={(e) => serverPath = (e.target as HTMLInputElement).value} />
            </div>
            <div class="field">
              <label>XDG mode</label>
              <SegmentedControl ariaLabel="XDG mode" value={xdgMode} onchange={(v: "isolated" | "shared") => xdgMode = v} options={[{ value: "isolated", label: "Isolated" }, { value: "shared", label: "Shared" }]} />
            </div>
          </div>
        {/if}
        <div class="reconnect-notice" data-testid="cs-reconnect-notice">
          ⚠ Reconnection required. Changing container selection, user, or root saves a new profile and keeps the old connection live until you reconnect.
        </div>
      {/if}
    </div>

    <!-- ── Footer ───────────────────────────────────────────────────────── -->
    <footer class="pfoot">
      {#if stage === "provisioning" || stage === "provisioningFailed"}
        {#if safelyCancellable && stage === "provisioning"}
          <Button variant="danger" onclick={cancelSetup} data-testid="cs-cancel-setup">Cancel setup</Button>
        {/if}
      {:else if stage === "edit"}
        <Button onclick={reconnectLater} data-testid="cs-reconnect-later">Reconnect later</Button>
        <Button variant="primary" onclick={reconnectNow} data-testid="cs-reconnect-now">Reconnect now</Button>
      {:else if stage !== "reviewRisks"}
        <Button onclick={requestClose} data-testid="cs-cancel-setup">Cancel setup</Button>
      {/if}
      {#if footerRight}
        <span class="footer-right">{footerRight}</span>
      {/if}
    </footer>
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
  .panel:focus { outline: none; }
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
  .phead h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .close-btn {
    border: 0; background: none; color: var(--accent); cursor: pointer;
    font: inherit; font-size: 13px; font-weight: 500;
  }
  .mobile-back { display: none; }
  .body {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 4px 20px calc(20px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 13px; font-weight: 500; color: var(--text); }
  .opt { font-weight: 400; color: var(--text-muted); }
  .field input, .container-search {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 9px 11px;
    font-size: 16px;
    background: var(--bg);
    color: var(--text);
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  .field input:focus, .container-search:focus { border-color: var(--accent); }
  .ssh-row { display: flex; gap: 8px; }
  .ssh-row input:first-child { flex: 1; min-width: 0; }
  .port-input { width: 80px; flex-shrink: 0; }
  .hint { font-size: 12px; color: var(--text-muted); line-height: 1.45; margin: 2px 0 0; }
  .hint.warn { color: var(--accent); }
  .testing-box {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    background: var(--surface);
  }
  .testing-spinner { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); }
  .spinner, .spinner-sm {
    width: 14px; height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  .spinner-sm { width: 10px; height: 10px; border-width: 1.5px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sub-steps { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .sub-step { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
  .sub-step.active { color: var(--text); }
  .sub-step.done { color: var(--ok, var(--text-muted)); }
  .sub-step .check { color: var(--ok, var(--accent)); }
  .sub-step .dot { color: var(--text-faint); }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
    border-radius: var(--radius-sm);
    padding: 12px;
    background: var(--danger-soft, var(--surface));
  }
  .error-title { font-size: 13px; font-weight: 600; color: var(--danger); margin-bottom: 4px; }
  .error-msg { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .error-actions { display: flex; gap: 8px; margin-top: 8px; }
  .ssh-summary {
    font-size: 12px; color: var(--text-muted);
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .section-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-faint); margin-top: 4px;
  }
  .container-list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; }
  .container-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px; border-radius: var(--radius-sm);
    border: 1px solid transparent; background: none;
    cursor: pointer; text-align: left; width: 100%;
    font: inherit;
  }
  .container-row:hover { background: var(--surface-hover, var(--surface)); }
  .container-row.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .ctr-glyph { color: var(--accent); font-size: 16px; flex-shrink: 0; }
  .ctr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .ctr-name { font-weight: 600; font-size: 13px; color: var(--text); }
  .ctr-meta { font-size: 11px; color: var(--text-muted); display: flex; gap: 4px; flex-wrap: wrap; }
  .ctr-image { font-family: var(--font-mono, ui-monospace, monospace); }
  .ctr-compose { color: var(--text-faint); }
  .ctr-state { font-size: 10px; color: var(--text-faint); text-transform: capitalize; flex-shrink: 0; }
  .link-btn {
    border: 0; background: none; color: var(--accent); cursor: pointer;
    font: inherit; font-size: 12px; text-align: left; padding: 4px 0;
  }
  .disclosure {
    border: 0; background: none; color: var(--text-muted); cursor: pointer;
    font: inherit; font-size: 13px; text-align: left; padding: 4px 0;
  }
  .advanced-body, .customize-body { display: flex; flex-direction: column; gap: 12px; padding-left: 8px; }
  .resolved-id { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
  .backing-line { font-size: 11px; color: var(--text-muted); }
  .warning-box {
    border: 1px solid var(--warning, var(--border));
    border-radius: var(--radius-sm);
    padding: 12px;
    background: var(--warning-soft, var(--surface));
  }
  .warning-title { font-size: 13px; font-weight: 600; color: var(--warning, var(--accent)); margin-bottom: 4px; }
  .warning-body { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .risks-panel { display: flex; flex-direction: column; gap: 10px; }
  .risks-panel h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .risks-sub { font-size: 12px; color: var(--text-muted); line-height: 1.45; margin: 0; }
  .risk-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    background: var(--surface);
  }
  .risk-title { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .risk-body { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
  .provisioning { display: flex; flex-direction: column; gap: 8px; }
  .prov-subtitle { font-size: 14px; font-weight: 500; color: var(--text); }
  .prov-subline { font-size: 12px; color: var(--text-muted); }
  .phase-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .phase { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; }
  .phase-marker {
    width: 20px; height: 20px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600; flex-shrink: 0;
  }
  .phase.completed .phase-marker { background: var(--ok, var(--accent)); color: white; }
  .phase.active .phase-marker { background: var(--accent); color: white; }
  .phase.failed .phase-marker { background: var(--danger); color: white; }
  .phase.pending .phase-marker { background: var(--surface-sunken); color: var(--text-faint); }
  .phase-label { font-size: 13px; font-weight: 500; }
  .phase.completed .phase-label, .phase.active .phase-label { color: var(--text); }
  .phase.pending .phase-label { color: var(--text-muted); }
  .phase-detail { font-size: 11px; color: var(--text-muted); flex: 1; min-width: 0; }
  .tech-details {
    font-size: 11px; color: var(--text-faint);
    background: var(--surface-sunken); padding: 8px; border-radius: var(--radius-xs);
    overflow-x: auto; white-space: pre-wrap; word-break: break-all;
    max-height: 150px; overflow-y: auto;
  }
  .readonly-field {
    padding: 9px 11px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--surface-sunken);
    font-size: 13px; color: var(--text-muted);
  }
  .docker-target-section {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .reconnect-notice {
    font-size: 12px; color: var(--accent);
    padding: 8px 10px; border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .pfoot {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 10px 20px calc(12px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .footer-right { font-size: 11px; color: var(--text-muted); text-align: right; }

  /* Phone */
  @media (max-width: 859px) {
    .scrim { display: none; }
    .panel {
      z-index: 95; inset: 0; left: 0; bottom: 0;
      transform: none; width: 100dvw; height: 100dvh;
      max-height: none; border: 0; border-radius: 0; box-shadow: none; animation: none;
    }
    .phead {
      display: grid;
      grid-template-columns: minmax(72px, 1fr) auto minmax(72px, 1fr);
      min-height: calc(52px + env(safe-area-inset-top));
      box-sizing: border-box;
      padding: env(safe-area-inset-top) 8px 0;
    }
    .phead h2 { grid-column: 2; text-align: center; }
    .close-btn { grid-column: 3; justify-self: end; min-height: 44px; }
    .mobile-back {
      display: inline-flex; grid-column: 1; align-items: center;
      justify-self: start; min-width: 72px; min-height: 44px;
      padding: 0 8px 0 2px; border: 0; background: transparent;
      color: var(--accent); font: inherit; font-size: 14px; cursor: pointer;
    }
    .back-chevron { display: inline-flex; transform: rotate(180deg); }
    .body { padding: 0 16px calc(24px + env(safe-area-inset-bottom)); }
    .field input, .container-search, .port-input { min-height: 44px; }
    .container-row { min-height: 52px; }
    .pfoot { padding: 10px 16px calc(16px + env(safe-area-inset-bottom)); }
  }

  @keyframes rise {
    from { transform: translateX(-50%) translateY(16px); opacity: 0; }
  }
  @keyframes fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .scrim, .panel { animation: none; }
  }
</style>
