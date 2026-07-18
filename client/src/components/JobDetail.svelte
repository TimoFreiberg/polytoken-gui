<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import IconButton from "./ui/IconButton.svelte";
  import type { BackgroundJob } from "@pantoken/protocol";

  const job = $derived<BackgroundJob | null>(
    store.jobs.find((j) => j.handle === store.selectedJobHandle) ?? null,
  );

  const JOB_KIND_ICON: Record<string, string> = {
    subagent: "◇",
    shell: "□",
  };
  const STATUS_ICON: Record<string, string> = {
    reserved: "◌",
    running: "◐",
    completed: "●",
    failed: "✕",
    cancelled: "⊘",
  };
  const STATUS_LABEL: Record<string, string> = {
    reserved: "Reserved",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };

  function close(): void {
    store.closeJobDetail();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function formatTime(iso?: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if job}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label="Job detail"
    data-testid="job-detail"
  >
    <header class="phead">
      <div class="phead-left">
        <span class="kind-icon">{JOB_KIND_ICON[job.kind] ?? "?"}</span>
        <h2>{job.subagentType ?? job.toolName}</h2>
        <span class="status-badge {job.status}">{STATUS_ICON[job.status] ?? "?"} {STATUS_LABEL[job.status] ?? job.status}</span>
      </div>
      <IconButton
        title="Close (Esc)"
        aria-label="Close job detail"
        onclick={close}>✕</IconButton
      >
    </header>
    <div class="body" data-testid="job-detail-body">
      {#if job.outputTail}
        <pre class="output-tail" data-testid="job-output-tail">{job.outputTail}</pre>
      {:else}
        <p class="no-output">No output captured</p>
      {/if}
      <dl class="meta">
        <div class="meta-row">
          <dt>Handle</dt>
          <dd class="mono">{job.handle}</dd>
        </div>
        <div class="meta-row">
          <dt>Type</dt>
          <dd>{job.kind === "subagent" ? "Subagent" : "Shell"}</dd>
        </div>
        <div class="meta-row">
          <dt>Tool</dt>
          <dd class="mono">{job.toolName}</dd>
        </div>
        <div class="meta-row">
          <dt>Created</dt>
          <dd>{formatTime(job.createdAt)}</dd>
        </div>
        {#if job.startedAt}
          <div class="meta-row">
            <dt>Started</dt>
            <dd>{formatTime(job.startedAt)}</dd>
          </div>
        {/if}
        {#if job.endedAt}
          <div class="meta-row">
            <dt>Ended</dt>
            <dd>{formatTime(job.endedAt)}</dd>
          </div>
        {/if}
        {#if job.model}
          <div class="meta-row">
            <dt>Model</dt>
            <dd class="mono">{job.model}</dd>
          </div>
        {/if}
        {#if job.outputBytes != null}
          <div class="meta-row">
            <dt>Output</dt>
            <dd>{job.outputBytes} bytes</dd>
          </div>
        {/if}
      </dl>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: var(--z-detail-scrim);
    animation: fade 0.15s ease;
  }
  @keyframes fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .panel {
    position: fixed;
    z-index: var(--z-detail);
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: 100%;
    max-height: calc(100dvh - 20px);
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
      width: min(520px, calc(100vw - 48px));
      max-height: calc(100dvh - 48px);
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  @keyframes rise {
    from { transform: translate(-50%, 100%); }
    to { transform: translate(-50%, 0); }
  }
  @media (min-width: 600px) {
    @keyframes rise {
      from { transform: translate(-50%, calc(-50% + 20px)); opacity: 0; }
      to { transform: translate(-50%, -50%); opacity: 1; }
    }
  }
  .phead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .phead-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .kind-icon {
    font-size: 15px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .phead h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-badge {
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .status-badge.running { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
  .status-badge.completed { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 30%, var(--border)); }
  .status-badge.failed { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, var(--border)); }
  .status-badge.cancelled { color: var(--text-muted); }
  .body {
    overflow-y: auto;
    padding: 16px;
    -webkit-overflow-scrolling: touch;
    flex: 1;
  }
  .output-tail {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
    background: var(--surface-sunken);
    border-radius: 8px;
    padding: 12px;
    margin: 0 0 16px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
    overflow-y: auto;
  }
  .no-output {
    font-size: 13px;
    color: var(--text-faint);
    margin: 0 0 16px;
  }
  .meta {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .meta-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .meta-row dt {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
    width: 70px;
  }
  .meta-row dd {
    font-size: 12px;
    color: var(--text);
    margin: 0;
    word-break: break-all;
  }
  .mono {
    font-family: var(--font-mono, monospace);
  }
</style>
