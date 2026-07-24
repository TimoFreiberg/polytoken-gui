<script lang="ts">
  import { tick } from "svelte";
  import { overlayHistory, PHONE_MQ } from "../lib/overlay-history.js";
  import { profileEditor } from "../lib/profile-editor.svelte.js";
  import { validateProfileDraft } from "../lib/profile-form.js";
  import type { HostCoordinator } from "../lib/hosts.svelte.js";
  import type {
    RemoteProfile,
    PolytokenPolicy,
    XdgMode,
    ExecutionTargetProfile,
  } from "../lib/hosts/types.js";
  import Button from "./ui/Button.svelte";
  import SegmentedControl from "./ui/SegmentedControl.svelte";
  import Chevron from "./ui/Chevron.svelte";

  const { coordinator }: { coordinator: HostCoordinator } = $props();

  const open = $derived(profileEditor.open);
  const editing = $derived(profileEditor.editing);
  const isEdit = $derived(editing !== null);

  let phone = $state(false);
  let panelEl = $state<HTMLDivElement>();
  let previousFocus: HTMLElement | null = null;
  let historyTracked = false;

  // Form fields
  let labelDraft = $state("");
  let sshDestinationDraft = $state("");
  let portDraft = $state("");
  let polytokenPolicyDraft = $state<PolytokenPolicy>("requireExisting");
  let advancedOpen = $state(false);
  let remoteRootOverrideDraft = $state("");
  let serverPathDraft = $state("");
  let xdgModeDraft = $state<XdgMode>("isolated");
  let executionTargetDraft = $state<ExecutionTargetProfile>({ kind: "host" });
  let error = $state<string | null>(null);
  let saving = $state(false);

  // Docker sub-fields
  let dockerContainerName = $state("");
  let dockerUser = $state("");
  let dockerWorkdir = $state("");
  let dockerPantokenRoot = $state("");

  // Track whether we've seeded fields for the current editing session.
  let seededFor = $state<string | null>(null);

  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(PHONE_MQ);
    const update = () => (phone = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  // Seed form fields when the editor opens.
  $effect(() => {
    if (!open) {
      seededFor = null;
      return;
    }
    if (seededFor !== null) return;

    if (editing) {
      seededFor = editing.id;
      labelDraft = editing.label;
      sshDestinationDraft = editing.sshDestination;
      portDraft = editing.port ? String(editing.port) : "";
      polytokenPolicyDraft = editing.polytokenPolicy;
      remoteRootOverrideDraft = editing.remoteRootOverride ?? "";
      serverPathDraft = editing.serverPath ?? "";
      xdgModeDraft = editing.xdgMode;
      executionTargetDraft = structuredClone(editing.executionTarget);
      if (editing.executionTarget.kind === "dockerContainer") {
        dockerContainerName = editing.executionTarget.containerName;
        dockerUser = editing.executionTarget.user;
        dockerWorkdir = editing.executionTarget.workdir ?? "";
        dockerPantokenRoot = editing.executionTarget.pantokenRoot;
      } else {
        dockerContainerName = "";
        dockerUser = "";
        dockerWorkdir = "";
        dockerPantokenRoot = "";
      }
    } else {
      seededFor = "new";
      labelDraft = "";
      sshDestinationDraft = "";
      portDraft = "";
      polytokenPolicyDraft = "requireExisting";
      advancedOpen = false;
      remoteRootOverrideDraft = "";
      serverPathDraft = "";
      xdgModeDraft = "isolated";
      executionTargetDraft = { kind: "host" };
      dockerContainerName = "";
      dockerUser = "";
      dockerWorkdir = "";
      dockerPantokenRoot = "";
    }
    error = null;
  });

  // Focus management
  $effect(() => {
    if (open && !historyTracked) {
      previousFocus = document.activeElement as HTMLElement | null;
      historyTracked = phone;
      if (phone) {
        overlayHistory.opened("profile-form", closeFromHistory);
      }
      void tick().then(() => panelEl?.focus());
    }
  });

  function closeFromHistory(): void {
    historyTracked = false;
    profileEditor.close();
    restoreFocus();
  }

  function close(): void {
    if (phone && historyTracked) {
      overlayHistory.closed("profile-form");
    }
    historyTracked = false;
    profileEditor.close();
    restoreFocus();
  }

  function restoreFocus(): void {
    const target = phone
      ? document.querySelector<HTMLElement>(".composer-surface textarea")
      : previousFocus;
    target?.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    }
  }

  const policyOptions = [
    { value: "requireExisting" as const, label: "Require existing" },
    { value: "offerInstall" as const, label: "Offer install" },
  ];

  const xdgOptions = [
    { value: "isolated" as const, label: "Isolated" },
    { value: "shared" as const, label: "Shared" },
  ];

  const targetOptions = [
    { value: "host" as const, label: "Host" },
    { value: "dockerContainer" as const, label: "Docker container" },
  ];

  function isAbsolutePath(p: string): boolean {
    return p.startsWith("/");
  }

  function validate(): string | null {
    return validateProfileDraft({
      label: labelDraft,
      sshDestination: sshDestinationDraft,
      port: portDraft,
      remoteRootOverride: remoteRootOverrideDraft,
      serverPath: serverPathDraft,
      executionTarget: executionTargetDraft,
      dockerContainerName,
      dockerUser,
      dockerWorkdir,
      dockerPantokenRoot,
    });
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      error = validationError;
      return;
    }

    saving = true;
    error = null;

    try {
      const portNum = portDraft.trim() ? Number(portDraft.trim()) : undefined;

      const executionTarget: ExecutionTargetProfile =
        executionTargetDraft.kind === "dockerContainer"
          ? {
              kind: "dockerContainer",
              containerName: dockerContainerName.trim(),
              user: dockerUser.trim(),
              workdir: dockerWorkdir.trim() || undefined,
              pantokenRoot: dockerPantokenRoot.trim(),
            }
          : { kind: "host" };

      const profile: RemoteProfile = {
        id: editing?.id ?? crypto.randomUUID(),
        label: labelDraft.trim(),
        sshDestination: sshDestinationDraft.trim(),
        port: portNum,
        polytokenPolicy: polytokenPolicyDraft,
        remoteRootOverride: remoteRootOverrideDraft.trim() || undefined,
        serverPath: serverPathDraft.trim() || undefined,
        xdgMode: xdgModeDraft,
        executionTarget,
        riskAcknowledgements: editing?.riskAcknowledgements ?? {},
      };

      if (isEdit) {
        await coordinator.updateProfile(profile);
      } else {
        await coordinator.addProfile(profile);
      }

      close();
    } catch (err) {
      error = (err as Error)?.message ?? "Failed to save computer";
      // Preserve all form values on error — do not reset.
    } finally {
      saving = false;
    }
  }

  function toggleAdvanced(): void {
    advancedOpen = !advancedOpen;
  }

  function onTargetChange(kind: "host" | "dockerContainer"): void {
    executionTargetDraft =
      kind === "dockerContainer"
        ? { kind: "dockerContainer", containerName: "", user: "", pantokenRoot: "" }
        : { kind: "host" };
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
    aria-label={isEdit ? "Edit computer" : "Add computer"}
    data-testid="profile-form-panel"
    tabindex="-1"
  >
    <header class="phead">
      {#if phone}
        <button class="mobile-back" type="button" title="Back" aria-label="Back" onclick={() => close()}>
          <span class="back-chevron"><Chevron size={14} /></span><span>Back</span>
        </button>
        <h2>{isEdit ? "Edit computer" : "Add computer"}</h2>
        <span class="header-spacer" aria-hidden="true"></span>
      {:else}
        <h2>{isEdit ? "Edit computer" : "Add computer"}</h2>
        <button class="close-btn" type="button" title="Close" aria-label="Close" onclick={() => close()}>✕</button>
      {/if}
    </header>

    <form class="body" onsubmit={submit}>
      <div class="field">
        <label for="profile-label">Name</label>
        <input
          id="profile-label"
          bind:value={labelDraft}
          type="text"
          placeholder="My build server"
          spellcheck="false"
          autocomplete="off"
          data-testid="profile-label-input"
        />
      </div>

      <div class="field">
        <label for="profile-ssh">SSH destination</label>
        <input
          id="profile-ssh"
          bind:value={sshDestinationDraft}
          type="text"
          placeholder="user@host or SSH config alias"
          spellcheck="false"
          autocomplete="off"
          data-testid="profile-ssh-input"
        />
      </div>

      <div class="field">
        <label for="profile-port">Port <span class="optional">(optional)</span></label>
        <input
          id="profile-port"
          bind:value={portDraft}
          type="text"
          inputmode="numeric"
          placeholder="22"
          spellcheck="false"
          autocomplete="off"
          data-testid="profile-port-input"
        />
      </div>

      <div class="field">
        <div class="field-label">Polytoken policy</div>
        <SegmentedControl
          ariaLabel="Polytoken policy"
          options={policyOptions}
          bind:value={polytokenPolicyDraft}
        />
      </div>

      <button type="button" class="advanced-toggle" onclick={toggleAdvanced} aria-expanded={advancedOpen}>
        <Chevron variant="disclosure" open={advancedOpen} />
        <span>Advanced</span>
      </button>

      {#if advancedOpen}
        <div class="advanced-body">
          <div class="field">
            <div class="field-label">Execution target</div>
            <SegmentedControl
              ariaLabel="Execution target"
              options={targetOptions}
              value={executionTargetDraft.kind}
              onchange={(v) => onTargetChange(v)}
            />
          </div>

          {#if executionTargetDraft.kind === "dockerContainer"}
            <div class="docker-fields">
              <div class="field">
                <label for="docker-container">Container name</label>
                <input
                  id="docker-container"
                  bind:value={dockerContainerName}
                  type="text"
                  placeholder="my-container"
                  spellcheck="false"
                  autocomplete="off"
                  data-testid="docker-container-input"
                />
              </div>
              <div class="field">
                <label for="docker-user">User</label>
                <input
                  id="docker-user"
                  bind:value={dockerUser}
                  type="text"
                  placeholder="root"
                  spellcheck="false"
                  autocomplete="off"
                  data-testid="docker-user-input"
                />
              </div>
              <div class="field">
                <label for="docker-workdir">Workdir <span class="optional">(optional)</span></label>
                <input
                  id="docker-workdir"
                  bind:value={dockerWorkdir}
                  type="text"
                  placeholder="/workspace"
                  spellcheck="false"
                  autocomplete="off"
                  data-testid="docker-workdir-input"
                />
              </div>
              <div class="field">
                <label for="docker-root">Pantoken root</label>
                <input
                  id="docker-root"
                  bind:value={dockerPantokenRoot}
                  type="text"
                  placeholder="/home/user/.local/share/pantoken"
                  spellcheck="false"
                  autocomplete="off"
                  data-testid="docker-root-input"
                />
              </div>
            </div>
          {/if}

          <div class="field">
            <label for="profile-root-override">Remote-root override <span class="optional">(optional)</span></label>
            <input
              id="profile-root-override"
              bind:value={remoteRootOverrideDraft}
              type="text"
              placeholder="/custom/pantoken-root"
              spellcheck="false"
              autocomplete="off"
              data-testid="profile-root-input"
            />
          </div>

          <div class="field">
            <label for="profile-server-path">Server path override <span class="optional">(optional)</span></label>
            <input
              id="profile-server-path"
              bind:value={serverPathDraft}
              type="text"
              placeholder="/usr/local/bin/pantoken-server"
              spellcheck="false"
              autocomplete="off"
              data-testid="profile-server-path-input"
            />
          </div>

          <div class="field">
            <div class="field-label">XDG mode</div>
            <SegmentedControl
              ariaLabel="XDG mode"
              options={xdgOptions}
              bind:value={xdgModeDraft}
            />
          </div>
        </div>
      {/if}

      <p class="credential-note">
        Pantoken uses your existing SSH configuration, agent, and system keychain. It does
        not store passwords or private keys.
      </p>

      {#if error}
        <p class="error" role="alert" data-testid="profile-form-error">{error}</p>
      {/if}

      <div class="actions">
        <Button variant="primary" type="submit" disabled={saving} data-testid="profile-form-save">
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add computer"}
        </Button>
        <Button type="button" onclick={() => close()}>Cancel</Button>
      </div>
    </form>
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
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field label, .field-label {
    font-size: 13px;
    font-weight: 550;
    color: var(--text);
  }
  .field .optional { color: var(--text-faint); font-weight: 400; }
  .field input {
    font: inherit;
    font-size: 15px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 9px 11px;
    background: var(--bg);
    color: var(--text);
    outline: none;
  }
  .field input:focus { border-color: var(--accent); }
  .advanced-toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: 0;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 550;
    color: var(--text-muted);
    padding: 4px 0;
    min-height: 44px;
  }
  .advanced-toggle:hover { color: var(--text); }
  .advanced-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-left: 4px;
    border-left: 2px solid var(--border);
    margin-left: -4px;
    padding-left: 12px;
  }
  .docker-fields {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 10px 12px;
    background: var(--surface-sunken);
    border-radius: var(--radius-sm);
  }
  .credential-note {
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1.5;
    margin: 4px 0 0;
  }
  .error {
    font-size: 13px;
    color: var(--danger);
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
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
    .field input, .advanced-toggle, .body :global(.btn) {
      min-height: 44px;
    }
  }
</style>
