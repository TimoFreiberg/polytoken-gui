<script lang="ts">
  import { store } from "../lib/store.svelte.js";

  // The current turn is in its THINKING phase: the open assistant bubble is
  // accumulating reasoning but hasn't emitted answer text yet. With thinking blocks
  // hidden (the default) this is the only feedback the model is doing something, so
  // the indicator says "Thinking…" instead of the generic "Working…".
  const thinking = $derived.by(() => {
    const items = store.session.items;
    const last = items[items.length - 1];
    return (
      !!last &&
      last.kind === "assistant" &&
      last.streaming &&
      last.thinking.length > 0 &&
      last.text.length === 0
    );
  });
</script>

<!-- The "pi is still working" affordance. Lives at the bottom of the chat window,
     just above the composer, so it sits below the last output and stays visible
     through thinking/tool gaps (not only while text streams). Replaces the inline
     streaming caret. Driven by store.turnActive — the robust in-flight signal, so it
     never disappears mid-turn just because a stray snapshot reported idle. -->
{#if store.turnActive}
  <div class="wrap" data-testid="working-indicator" role="status" aria-live="polite">
    <span class="inner" title={thinking ? "pi is thinking" : "pi is working"}>
      <span class="mark" aria-hidden="true">
        <span class="pi">π</span>
        <!-- Only .ring rotates; the π is a static, centered sibling so its
             centering transform never collides with the orbit animation. -->
        <span class="ring"><span class="dot"></span></span>
      </span>
      <span class="label">{thinking ? "Thinking…" : "Working…"}</span>
    </span>
  </div>
{/if}

<style>
  .wrap {
    max-width: var(--maxw);
    width: 100%;
    margin: 0 auto;
    padding: 4px 18px 10px;
    animation: fade 0.2s ease;
  }
  .inner {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    position: relative;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }
  .pi {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 14px;
    line-height: 1;
    color: var(--accent);
  }
  .ring {
    position: absolute;
    inset: 0;
    animation: orbit 1.1s linear infinite;
  }
  .dot {
    position: absolute;
    top: 0;
    left: 50%;
    width: 5px;
    height: 5px;
    transform: translateX(-50%);
    border-radius: 50%;
    background: var(--accent);
  }
  .label {
    font-size: 13px;
    color: var(--text-muted);
  }
  @keyframes orbit {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring {
      animation: none;
    }
    .dot {
      opacity: 0.7;
    }
  }
</style>
