<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { attention } from "../lib/attention-cycle.svelte.js";
  import QnaForm, { type QnaDraft } from "./QnaForm.svelte";

  // The Q&A form renders inline in the chat column (above the composer), not as a
  // floating sheet like the other dialogs — matching the chat-native placement the
  // Claude app uses. ApprovalLayer deliberately skips `qna` so this owns it; the two
  // can show at once (a floating confirm over the inline form) without fighting.
  const current = $derived(
    store.session.pendingApprovals.find((r) => r.kind === "qna") ?? null,
  );

  // Q&A answers are local drafts until Submit. Keyed by session/request so focusing
  // another chat can unmount the form without discarding typed answers.
  const qnaDrafts = new Map<string, QnaDraft>();
  function qnaKey(requestId: string): string {
    return `${store.session.ref?.sessionId ?? "unknown"}:${requestId}`;
  }
  function rememberQna(key: string, draft: QnaDraft): void {
    qnaDrafts.set(key, draft);
    if (qnaDrafts.size > 20) {
      const oldest = qnaDrafts.keys().next().value;
      if (oldest) qnaDrafts.delete(oldest);
    }
  }

  // Two collapse levels:
  // 1. QnaForm's own `collapsed` — collapses the body to just the title bar
  //    (the form's internal minimize button). Owned here, passed as a prop.
  // 2. The attention cycle's `minimized.qna` — collapses the ENTIRE form to a
  //    small pill (the ⌘\ cycle). Owned by the controller.
  // When the controller minimizes to a pill, QnaForm isn't rendered at all; when
  // QnaForm collapses to its title bar, the form is still visible (just shorter).
  const pillMinimized = $derived(attention.minimized.qna);
  let bodyCollapsed = $state(false);

  // Per-request reset: a fresh question always starts un-pill-minimized and
  // with the body expanded.
  let lastRequestId: string | undefined;
  $effect(() => {
    const id = current?.requestId;
    if (id !== lastRequestId) {
      if (lastRequestId !== undefined) attention.clear("qna");
      lastRequestId = id;
      bodyCollapsed = false;
    }
  });

  // Re-focus when cycled back to via ⌘\.
  $effect(() => {
    if (attention.focused === "qna" && !attention.minimized.qna) {
      queueMicrotask(() => {
        const el = document.querySelector<HTMLElement>(".qna-inline .qna");
        el?.focus();
      });
    }
  });

  function cancel(requestId: string): void {
    qnaDrafts.delete(qnaKey(requestId));
    attention.clear("qna");
    store.respondUi({ requestId, cancelled: true });
  }
</script>

{#if current}
  {@const draftKey = qnaKey(current.requestId)}
  {#if pillMinimized}
    <div class="qna-inline-wrap">
      <div class="qna-inline">
        <button
          type="button"
          class="attention-pill"
          onclick={() => attention.restore("qna")}
          title="Question pending — click or press ⌘\ to restore"
        >
          <span class="pill-label">1 question pending</span>
        </button>
      </div>
    </div>
  {:else}
    <div class="qna-inline-wrap">
      <div class="qna-inline">
        {#key current.requestId}
          <QnaForm
            request={current}
            collapsed={bodyCollapsed}
            onMinimize={() => (bodyCollapsed = !bodyCollapsed)}
            initialDraft={qnaDrafts.get(draftKey)}
            onchange={(draft) => rememberQna(draftKey, draft)}
            onsubmit={(answers) => {
              qnaDrafts.delete(draftKey);
              attention.clear("qna");
              store.respondUi({ requestId: current.requestId, answers });
            }}
            oncancel={() => cancel(current.requestId)}
          />
        {/key}
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Full-width gutter so the card aligns to the same column as the composer. */
  .qna-inline-wrap {
    padding: 0 16px 10px;
  }
  .qna-inline {
    max-width: var(--maxw);
    margin: 0 auto;
    box-sizing: border-box;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-pop);
    font-size: calc(15px * var(--font-scale, 1));
  }
  /* Minimized pill — reuses TaskList's .pill visual language. */
  .attention-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    max-width: 100%;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  .attention-pill:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .attention-pill:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .pill-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
