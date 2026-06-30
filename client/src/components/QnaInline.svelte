<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import QnaForm, { type QnaDraft } from "./QnaForm.svelte";

  // The Q&A form renders inline in the chat column (above the composer), not as a
  // floating sheet like the other dialogs — matching the chat-native placement the
  // Claude app uses. ApprovalLayer deliberately skips `qna` so this owns it; the two
  // can show at once (a floating confirm over the inline form) without fighting.
  const current = $derived(
    store.session.pendingApprovals.find((r) => r.kind === "qna") ?? null,
  );

  // Q&A answers are local drafts until Submit. Keyed by session/request so focusing
  // another chat can unmount the form without discarding typed answers. (Moved here
  // from ApprovalLayer with the rest of the qna handling.)
  const qnaDrafts = new Map<string, QnaDraft>();
  function qnaKey(requestId: string): string {
    return `${store.session.ref?.sessionId ?? "unknown"}:${requestId}`;
  }
  function rememberQna(key: string, draft: QnaDraft): void {
    qnaDrafts.set(key, draft);
    // Pending forms are few, but bound stale drafts if another client resolves one
    // while this chat is in the background.
    if (qnaDrafts.size > 20) {
      const oldest = qnaDrafts.keys().next().value;
      if (oldest) qnaDrafts.delete(oldest);
    }
  }

  // Minimized state is per-request: a fresh question set always starts expanded.
  let collapsed = $state(false);
  let lastRequestId: string | undefined;
  $effect(() => {
    const id = current?.requestId;
    if (id !== lastRequestId) {
      lastRequestId = id;
      collapsed = false;
    }
  });

  function cancel(requestId: string): void {
    qnaDrafts.delete(qnaKey(requestId));
    store.respondUi({ requestId, cancelled: true });
  }
</script>

{#if current}
  {@const draftKey = qnaKey(current.requestId)}
  <div class="qna-inline-wrap">
    <div class="qna-inline">
      {#key current.requestId}
        <QnaForm
          request={current}
          {collapsed}
          onMinimize={() => (collapsed = !collapsed)}
          initialDraft={qnaDrafts.get(draftKey)}
          onchange={(draft) => rememberQna(draftKey, draft)}
          onsubmit={(answers) => {
            qnaDrafts.delete(draftKey);
            store.respondUi({ requestId: current.requestId, answers });
          }}
          oncancel={() => cancel(current.requestId)}
        />
      {/key}
    </div>
  </div>
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
    /* One scaled base — children in `em` inherit it, mirroring the Transcript's
       `.col` pattern. Controls (Button.svelte) keep their own px sizing and stay
       at body size regardless of --font-scale (the "zoom what you read, not the
       controls" intent). */
    font-size: calc(15px * var(--font-scale, 1));
  }
</style>
