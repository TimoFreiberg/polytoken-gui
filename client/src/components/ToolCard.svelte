<script lang="ts">
  import type { ToolItem } from "@pilot/protocol";

  let { item }: { item: ToolItem } = $props();
  let open = $state(false);

  function preview(input: unknown): string {
    if (input == null) return "";
    if (typeof input === "object") {
      const o = input as Record<string, unknown>;
      if (typeof o.command === "string") return o.command;
      if (typeof o.path === "string") return o.path;
      return JSON.stringify(input);
    }
    return String(input);
  }

  function outputText(out: unknown): string {
    if (out == null) return "";
    return typeof out === "string" ? out : JSON.stringify(out, null, 2);
  }

  const statusIcon: Record<string, string> = { running: "○", ok: "●", error: "✕" };
</script>

<div class="tool {item.status}">
  <button class="head" onclick={() => (open = !open)}>
    <span class="status">{statusIcon[item.status]}</span>
    <span class="name">{item.label ?? item.name}</span>
    <span class="arg">{preview(item.input)}</span>
    <span class="chev">{open ? "▾" : "▸"}</span>
  </button>
  {#if open}
    <div class="body">
      {#if item.description}<div class="desc">{item.description}</div>{/if}
      {#if item.text}<pre class="stream">{item.text}</pre>{/if}
      {#if item.output !== undefined}<pre class="out">{outputText(item.output)}</pre>{/if}
      {#if item.status === "running" && !item.text}<div class="running">running…</div>{/if}
    </div>
  {/if}
</div>

<style>
  .tool {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    overflow: hidden;
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    background: none;
    border: none;
    padding: 9px 12px;
    text-align: left;
    color: var(--text);
  }
  .status {
    font-size: 9px;
    line-height: 1;
  }
  .tool.running .status {
    color: var(--accent);
    animation: blink 1s ease-in-out infinite;
  }
  .tool.ok .status {
    color: var(--ok);
  }
  .tool.error .status {
    color: var(--danger);
  }
  @keyframes blink {
    50% {
      opacity: 0.3;
    }
  }
  .name {
    font-weight: 550;
    font-size: 13.5px;
    flex-shrink: 0;
  }
  .arg {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .chev {
    font-size: 10px;
    color: var(--text-faint);
    flex-shrink: 0;
  }
  .body {
    border-top: 1px solid var(--border);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .desc {
    font-size: 12.5px;
    color: var(--text-muted);
  }
  pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--surface-sunken);
    border-radius: var(--radius-xs);
    padding: 9px 11px;
    max-height: 320px;
    overflow: auto;
  }
  .out {
    color: var(--text);
  }
  .running {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }
</style>
