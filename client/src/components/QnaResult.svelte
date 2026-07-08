<script lang="ts">
  import type { ToolItem } from "@pantoken/protocol";
  import { parseQnaResult, toolOutputText } from "../lib/transcript-view.js";

  // The `answer` tool's result, rendered visibly in the transcript (not buried in a
  // collapsed tool card) so the user can read back the answers they submitted. The
  // tool's output is the answer extension's `formatQnA` text; we parse it into Q/A
  // pairs, falling back to the raw text if the upstream format ever drifts.
  interface Props {
    item: ToolItem;
  }
  let { item }: Props = $props();

  const text = $derived(toolOutputText(item.output));
  const entries = $derived(parseQnaResult(text));
</script>

<div class="qna-result">
  <div class="qr-head">Your answers</div>
  {#if entries}
    {#each entries as e, i (i)}
      <div class="qr-item">
        <div class="qr-question">{e.question}</div>
        {#if e.context}<div class="qr-context">{e.context}</div>{/if}
        <div class="qr-answer">{e.answer || "(no answer)"}</div>
      </div>
    {/each}
  {:else if text}
    <pre class="qr-raw">{text}</pre>
  {/if}
</div>

<style>
  .qna-result {
    /* No align-self override: inherit the column's centering + --maxw cap (.col >
       :global(*)) so the card sits inline with the prose/tool-card measure instead of
       hugging the wide track's left edge. */
    box-sizing: border-box;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin: 2px 0;
  }
  .qr-head {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    margin-bottom: 10px;
  }
  .qr-item + .qr-item {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .qr-question {
    font-size: 14px;
    font-weight: 550;
    line-height: 1.4;
    color: var(--text);
  }
  .qr-context {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
    line-height: 1.4;
  }
  .qr-answer {
    font-size: 14px;
    color: var(--accent);
    margin-top: 5px;
    line-height: 1.4;
  }
  .qr-raw {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
    color: var(--text);
  }
</style>
