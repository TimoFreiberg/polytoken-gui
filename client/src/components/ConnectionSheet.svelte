<script lang="ts">
  import { tick } from "svelte";
  import { overlayHistory, PHONE_MQ } from "../lib/overlay-history.js";
  import { connectionSheet } from "../lib/connection-sheet.svelte.js";
  import { profileEditor } from "../lib/profile-editor.svelte.js";
  import type { HostCoordinator } from "../lib/hosts.svelte.js";
  import type { HostSummary, PendingRisk } from "../lib/hosts/types.js";
  import { redactSshDestination } from "../lib/hosts/types.js";
  import Button from "./ui/Button.svelte";
  import Chevron from "./ui/Chevron.svelte";

  const { coordinator }: { coordinator: HostCoordinator } = $props();

  let phone = $state(false);
  let panelEl = $state<HTMLDivElement>();
  let previousFocus: HTMLElement | null = null;
  let historyTracked = false;
  let detailOpen = $state(false);

  // Reset detailOpen when the watched host changes.
  $effect(() => {
    void watchedId;
    detailOpen = false;
  });

  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(PHONE_MQ);
    const update = () => (phone = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  const watchedId = $derived(connectionSheet.visibleHostId);
  const watchedSummary = $derived<HostSummary | null>(
    watchedId ? coordinator.summaries.find((s) => s.descriptor.id === watchedId) ?? null : null,
  );
  const watchedDescriptor = $derived(watchedSummary?.descriptor ?? null);
  const isFirstTime = $derived(watchedId ? !coordinator.hasEverConnected(watchedId) : false);

  const profileForWatched = $derived(
    watchedId ? coordinator.profiles.find((p) => p.id === watchedId) ?? null : null,
  );

  const redactedHost = $derived(
    watchedDescriptor?.subtitle
      ? watchedDescriptor.subtitle
      : profileForWatched
        ? redactSshDestination(profileForWatched.sshDestination).host
        : "",
  );

  // ── Show/hide logic ───────────────────────────────────────────────────
  // Watches all host summaries (not just the selected host) because
  // selectHost doesn't update selectedHostId until connectHost completes,
  // and connectHost blocks during the connecting phase. The sheet must
  // appear as soon as any host enters a first-time connecting state.
  $effect(() => {
    // Show for first-time connecting states on any host.
    for (const summary of coordinator.summaries) {
      const id = summary.descriptor.id;
      if (id === "local") continue;

      const state = summary.descriptor.state;
      const everConnected = coordinator.hasEverConnected(id);

      if (
        !everConnected &&
        ["testingSsh", "connecting", "provisioning", "starting", "preflight", "awaitingAcknowledgement"].includes(state)
      ) {
        connectionSheet.show(id);
        return;
      }

      // Re-escalate on actionable failure. For first-time connections, any
      // failure is actionable. For reconnects (everConnected), only
      // re-escalate if the failure has a suggested action — transient
      // failures (e.g. network blip) without an action stay non-modal.
      if (state === "failed") {
        const hasAction = Boolean(summary.descriptor.failureAction);
        if (!everConnected || hasAction) {
          connectionSheet.show(id);
          return;
        }
      }
    }

    // Auto-hide when the watched host reaches a terminal-ish state.
    const watched = connectionSheet.visibleHostId;
    if (!watched) return;
    const watchedState = coordinator.summaries.find((s) => s.descriptor.id === watched)?.descriptor.state;

    if (watchedState === "ready") {
      connectionSheet.hide();
    } else if (watchedState === "disconnected") {
      connectionSheet.hide();
    } else if (watchedState === "reconnecting" && coordinator.hasEverConnected(watched)) {
      // Non-modal reconnect — hide the sheet, use the existing ConnectionBanner.
      connectionSheet.hide();
    }
  });

  // ── Overlay history ──────────────────────────────────────────────────
  $effect(() => {
    const isOpen = connectionSheet.visibleHostId !== null;
    if (isOpen && !historyTracked) {
      previousFocus = document.activeElement as HTMLElement | null;
      historyTracked = phone;
      if (phone) {
        overlayHistory.opened("connection-sheet", closeFromHistory);
      }
      void tick().then(() => panelEl?.focus());
    }
  });

  function closeFromHistory(): void {
    historyTracked = false;
    // Cancel the connection if it's still in-flight.
    const id = connectionSheet.visibleHostId;
    if (id) {
      const state = coordinator.summaries.find((s) => s.descriptor.id === id)?.descriptor.state;
      if (state && ["testingSsh", "connecting", "provisioning", "starting", "preflight"].includes(state)) {
        void coordinator.cancelConnection(id);
      }
    }
    connectionSheet.hide();
    restoreFocus();
  }

  function close(): void {
    if (phone && historyTracked) {
      overlayHistory.closed("connection-sheet");
    }
    historyTracked = false;
    connectionSheet.hide();
    restoreFocus();
  }

  function restoreFocus(): void {
    const target = phone
      ? document.querySelector<HTMLElement>(".composer-surface textarea")
      : previousFocus;
    target?.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && connectionSheet.visibleHostId !== null) {
      e.preventDefault();
      close();
    }
  }

  // ── Step mapping ──────────────────────────────────────────────────────
  type StepInfo = { label: string; status: "done" | "active" | "pending" };

  const steps = $derived.by<StepInfo[]>(() => {
    if (!watchedDescriptor) return [];
    const state = watchedDescriptor.state;
    const hasPreflight = Boolean(watchedDescriptor.preflightPhase);

    const stepStates: StepInfo[] = [
      { label: "SSH connection", status: "pending" },
      { label: "Remote system", status: "pending" },
      { label: "Polytoken compatibility", status: "pending" },
      { label: "Pantoken runtime", status: "pending" },
    ];

    if (state === "ready") {
      return stepStates.map((s) => ({ ...s, status: "done" as const }));
    }

    if (state === "failed") {
      // Mark steps up to the failure point as done (best effort).
      // We don't know exactly where it failed, so show all as pending
      // except the one the failure most likely maps to.
      return stepStates;
    }

    let currentStep = 0;

    if (state === "testingSsh" || state === "connecting") {
      currentStep = 0;
    } else if (state === "preflight") {
      currentStep = 1;
    } else if (state === "provisioning") {
      // Heuristic: if preflightPhase present, step 2 (remote system);
      // otherwise step 3 (polytoken).
      currentStep = hasPreflight ? 1 : 2;
    } else if (state === "starting") {
      currentStep = 3;
    } else if (state === "awaitingAcknowledgement") {
      currentStep = 1;
    }

    for (let i = 0; i < stepStates.length; i++) {
      if (i < currentStep) stepStates[i]!.status = "done";
      else if (i === currentStep) stepStates[i]!.status = "active";
      else stepStates[i]!.status = "pending";
    }
    return stepStates;
  });

  const canCancel = $derived(
    watchedDescriptor
      ? ["testingSsh", "connecting", "provisioning", "starting", "preflight"].includes(watchedDescriptor.state)
      : false,
  );

  const isFailed = $derived(watchedDescriptor?.state === "failed");
  const isAwaitingAck = $derived(
    watchedDescriptor?.state === "awaitingAcknowledgement" &&
    Boolean(watchedDescriptor?.pendingRisks && watchedDescriptor.pendingRisks.length > 0),
  );

  const pendingRisks = $derived(watchedDescriptor?.pendingRisks ?? []);

  async function cancelConnection(): Promise<void> {
    if (!watchedId) return;
    await coordinator.cancelConnection(watchedId);
    close();
  }

  async function retryConnection(): Promise<void> {
    if (!watchedId) return;
    await coordinator.selectHost(watchedId);
  }

  function editConnection(): void {
    if (watchedId && profileForWatched) {
      profileEditor.openEdit(profileForWatched);
    }
    close();
  }

  async function acknowledgeRisk(risk: PendingRisk): Promise<void> {
    if (!watchedId) return;
    await coordinator.acknowledgeRisk(watchedId, risk.id, risk.fingerprint);
    await coordinator.resumeConnection(watchedId);
  }

  async function cancelRisk(): Promise<void> {
    if (!watchedId) return;
    await coordinator.cancelConnection(watchedId);
    close();
  }

  function copyDetail(): void {
    if (watchedDescriptor?.failureDetail) {
      navigator.clipboard?.writeText(watchedDescriptor.failureDetail);
    }
  }

  const open = $derived(connectionSheet.visibleHostId !== null);
</script>

<svelte:window onkeydown={onKey} />

{#if open && watchedDescriptor}
  <div class="scrim" onclick={() => close()} role="presentation"></div>
  <div
    bind:this={panelEl}
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Connecting to computer"
    data-testid="connection-sheet-panel"
    tabindex="-1"
  >
    <header class="phead">
      {#if phone}
        <button class="mobile-back" type="button" title="Back" aria-label="Back" onclick={() => close()}>
          <span class="back-chevron"><Chevron size={14} /></span><span>Back</span>
        </button>
        <h2>{watchedDescriptor.label}</h2>
        <span class="header-spacer" aria-hidden="true"></span>
      {:else}
        <h2>{watchedDescriptor.label}</h2>
        <button class="close-btn" type="button" title="Close" aria-label="Close" onclick={() => close()}>✕</button>
      {/if}
    </header>

    <div class="body">
      {#if redactedHost}
        <p class="host-subtitle" data-testid="connection-sheet-host">{redactedHost}</p>
      {/if}

      {#if isAwaitingAck}
        <!-- Docker risk acknowledgement -->
        <div class="risk-section" data-testid="risk-section">
          {#each pendingRisks as risk (risk.id)}
            <div class="risk-card" data-testid={`risk-${risk.id}`}>
              <div class="risk-title">{risk.title}</div>
              <p class="risk-explanation">{risk.explanation}</p>
              <p class="risk-consequences">{risk.consequences}</p>
              <div class="risk-actions">
                <Button variant="primary" title={risk.continueLabel} onclick={() => void acknowledgeRisk(risk)}>
                  {risk.continueLabel}
                </Button>
                <Button variant="danger" title="Cancel this connection" onclick={() => void cancelRisk()}>Cancel</Button>
              </div>
            </div>
          {/each}
        </div>
      {:else if isFailed}
        <!-- Failure rendering -->
        <div class="failure-section" data-testid="failure-section">
          <div class="failure-label" role="alert">{watchedDescriptor.failureLabel ?? "Connection failed"}</div>
          {#if watchedDescriptor.failureAction}
            <p class="failure-action">{watchedDescriptor.failureAction}</p>
          {/if}
          <div class="failure-actions">
            <Button variant="primary" title="Retry connecting" onclick={() => void retryConnection()} data-testid="failure-retry">Retry</Button>
            <Button title="Edit connection settings" onclick={() => editConnection()} data-testid="failure-edit">Edit connection</Button>
            <Button title="Dismiss" onclick={() => close()} data-testid="failure-dismiss">Cancel</Button>
          </div>
          {#if watchedDescriptor.failureDetail}
            <button class="detail-toggle" onclick={() => (detailOpen = !detailOpen)} aria-expanded={detailOpen}>
              <Chevron variant="disclosure" open={detailOpen} />
              <span>Diagnostic detail</span>
            </button>
            {#if detailOpen}
              <div class="failure-detail" data-testid="failure-detail">
                <code>{watchedDescriptor.failureDetail}</code>
                <Button title="Copy diagnostic detail" onclick={() => copyDetail()}>Copy</Button>
              </div>
            {/if}
          {/if}
        </div>
      {:else}
        <!-- Progress steps -->
        <ol class="steps" data-testid="connection-steps">
          {#each steps as step, i (step.label)}
            <li class="step {step.status}" data-testid={`connection-step-${i}`}>
              <span class="step-icon" aria-hidden="true">
                {#if step.status === "done"}✓{:else if step.status === "active"}●{:else}○{/if}
              </span>
              <div class="step-content">
                <span class="step-label">{step.label}</span>
                {#if step.status === "active" && watchedSummary?.statusText}
                  <span class="step-detail">{watchedSummary.statusText}</span>
                {/if}
              </div>
            </li>
          {/each}
        </ol>

        {#if canCancel}
          <div class="actions">
            <Button title="Cancel this connection" onclick={() => void cancelConnection()} data-testid="connection-cancel">Cancel</Button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 110;
    animation: fade 0.15s ease;
  }
  .panel {
    position: fixed;
    z-index: 111;
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
    font: inherit; font-size: 18px; color: var(--text-muted);
    background: none; border: 0; cursor: pointer; padding: 4px 8px;
    min-height: 44px; min-width: 44px;
  }
  .close-btn:hover { color: var(--text); }
  .mobile-back { display: none; }
  .header-spacer { display: none; }
  .body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 12px 20px calc(20px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .host-subtitle {
    font-size: 12px;
    color: var(--text-faint);
    margin: 0;
  }
  /* Progress steps */
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .step {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .step-icon {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    line-height: 1;
  }
  .step.done .step-icon { color: var(--ok); }
  .step.active .step-icon { color: var(--progress); font-size: 16px; }
  .step.pending .step-icon { color: var(--text-faint); }
  .step-content { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .step-label { font-size: 13px; font-weight: 550; color: var(--text); }
  .step.done .step-label { color: var(--text-muted); }
  .step.pending .step-label { color: var(--text-faint); }
  .step-detail { font-size: 12px; color: var(--progress); }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  /* Failure rendering */
  .failure-section { display: flex; flex-direction: column; gap: 10px; }
  .failure-label { font-size: 15px; font-weight: 600; color: var(--danger); }
  .failure-action { font-size: 13px; color: var(--text-muted); margin: 0; line-height: 1.5; }
  .failure-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .detail-toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: 0;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    color: var(--text-faint);
    padding: 4px 0;
    min-height: 44px;
  }
  .detail-toggle:hover { color: var(--text-muted); }
  .failure-detail {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px;
    background: var(--surface-sunken);
    border-radius: var(--radius-sm);
  }
  .failure-detail code {
    flex: 1;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
  /* Risk acknowledgement */
  .risk-section { display: flex; flex-direction: column; gap: 12px; }
  .risk-card {
    padding: 12px;
    background: var(--danger-soft);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .risk-title { font-size: 14px; font-weight: 600; color: var(--text); }
  .risk-explanation { font-size: 13px; color: var(--text-muted); margin: 0; line-height: 1.5; }
  .risk-consequences { font-size: 12px; color: var(--danger); margin: 0; line-height: 1.5; }
  .risk-actions { display: flex; gap: 8px; }
  @keyframes rise {
    from { transform: translateX(-50%) translateY(16px); opacity: 0; }
  }
  @keyframes fade {
    from { opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .scrim, .panel { animation: none; }
  }
  /* Phone: full-screen overlay */
  @media (max-width: 859px) {
    .scrim { display: none; }
    .panel {
      z-index: 111;
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
    .phead h2 { grid-column: 2; text-align: center; }
    .close-btn { display: none; }
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
    .back-chevron { display: inline-flex; transform: rotate(180deg); }
    .header-spacer { display: block; grid-column: 3; width: 72px; }
    .body { padding: 0 16px calc(24px + env(safe-area-inset-bottom)); }
    .body :global(.btn), .detail-toggle {
      min-height: 44px;
    }
  }
</style>
