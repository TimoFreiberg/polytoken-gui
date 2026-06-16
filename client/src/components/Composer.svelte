<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  let deliverAs = $state<"steer" | "followUp">("steer");
  let ta = $state<HTMLTextAreaElement>();

  const widgets = $derived(
    Object.values(store.session.ambient.widgets).filter((w) => w.placement === "aboveComposer"),
  );
  const streaming = $derived(store.streaming);

  function autosize() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }

  function submit() {
    const text = store.composerDraft;
    if (!text.trim()) return;
    store.prompt(text, streaming ? deliverAs : undefined);
    queueMicrotask(autosize);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }
</script>

<div class="composer-wrap">
  <div class="col">
    {#each widgets as w (w.key)}
      <div class="widget">
        {#each w.lines as line, i (i)}<div class="wline">{line}</div>{/each}
      </div>
    {/each}

    {#if streaming}
      <div class="streamrow">
        <div class="modes">
          <button class:active={deliverAs === "steer"} onclick={() => (deliverAs = "steer")} title="Deliver after the current step">steer</button>
          <button class:active={deliverAs === "followUp"} onclick={() => (deliverAs = "followUp")} title="Deliver when the agent stops">follow-up</button>
        </div>
        <button class="stop" onclick={() => store.abort()}>■ Stop</button>
      </div>
    {/if}

    <div class="box" class:streaming>
      <textarea
        bind:this={ta}
        bind:value={store.composerDraft}
        oninput={autosize}
        onkeydown={onKeydown}
        placeholder={streaming ? "Queue a message…" : "Message pilot…"}
        rows="1"
      ></textarea>
      <button class="send" disabled={!store.composerDraft.trim()} onclick={submit} aria-label="Send">
        ↑
      </button>
    </div>
  </div>
</div>

<style>
  .composer-wrap {
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
    padding: 10px 16px calc(12px + env(safe-area-inset-bottom));
  }
  .col {
    max-width: var(--maxw);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .widget {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 11px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .wline {
    line-height: 1.5;
  }
  .streamrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .modes {
    display: inline-flex;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px;
  }
  .modes button {
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 12px;
    padding: 3px 11px;
    border-radius: 999px;
  }
  .modes button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-card);
  }
  .stop {
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 13px;
    font-weight: 550;
    padding: 5px 14px;
    border-radius: 999px;
  }
  .box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 8px 8px 8px 14px;
    transition: border-color 0.15s;
  }
  .box:focus-within {
    border-color: var(--accent);
  }
  textarea {
    flex: 1;
    resize: none;
    border: none;
    outline: none;
    background: none;
    color: var(--text);
    font-family: inherit;
    font-size: 15px;
    line-height: 1.5;
    max-height: 220px;
    padding: 4px 0;
  }
  .send {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 17px;
    line-height: 1;
    display: grid;
    place-items: center;
    transition: opacity 0.15s, transform 0.1s;
  }
  .send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .send:not(:disabled):active {
    transform: scale(0.92);
  }
</style>
