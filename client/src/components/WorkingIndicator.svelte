<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { formatWorkedDuration } from "../lib/transcript-view.js";

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

  // Estimated tokens streamed in this turn — a liveness readout so you can see the API
  // is feeding you (number climbs) vs. stalled (it freezes), even during hidden thinking.
  const tokens = $derived(store.turnStreamTokens);

  // Live elapsed time for the current turn. We anchor to the wall-clock moment THIS
  // client first sees the turn go active (Date.now()), not a server event timestamp:
  // the mock driver's scripted fixtures stamp events with a fake epoch-0 clock, so a
  // Date.now()-minus-event-ts reading would be off by decades in the preview / e2e.
  // Client-side capture is identical under the mock and real pi. Tradeoff: a page reload
  // mid-turn restarts the count from 0 — it measures "time since observed active", not
  // absolute turn start. Acceptable for an ephemeral liveness affordance (same per-client
  // scope as the token counter beside it).
  let startedAt = $state<number | null>(null);
  let nowMs = $state(Date.now());

  // Anchor on the active edge; release when the turn settles. `??=` only stamps the first
  // time we see it active, so a multi-bubble turn keeps one continuous count.
  $effect(() => {
    if (store.turnActive) startedAt ??= Date.now();
    else startedAt = null;
  });

  // Tick ~1Hz while a turn runs; the interval is torn down on settle / unmount. nowMs is
  // only written (never read) here, so it can't re-trigger this effect.
  $effect(() => {
    if (!store.turnActive) return;
    nowMs = Date.now();
    const id = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const elapsed = $derived(
    startedAt === null ? "" : formatWorkedDuration(nowMs - startedAt),
  );

  // A new session is being created server-side (pi warming up + first prompt in flight),
  // before its first turn has started. We show the indicator through this gap too so the
  // just-sent prompt isn't left under a silent, idle-looking composer; the real turn's
  // "Working…"/"Thinking…" takes over the moment the run starts (turnActive wins the label).
  const creating = $derived(store.creatingSession !== null && !store.turnActive);
  const label = $derived(
    store.turnActive ? (thinking ? "Thinking…" : "Working…") : "Starting session…",
  );
</script>

<!-- The "pi is still working" affordance. Lives at the bottom of the chat window,
     just above the composer, so it sits below the last output and stays visible
     through thinking/tool gaps (not only while text streams). Replaces the inline
     streaming caret. Driven by store.turnActive — the robust in-flight signal, so it
     never disappears mid-turn just because a stray snapshot reported idle. -->
{#if store.turnActive || creating}
  <div class="wrap" data-testid="working-indicator" role="status" aria-live="polite">
    <span
      class="inner"
      title={creating
        ? "Starting the new session"
        : thinking
          ? "pi is thinking"
          : "pi is working"}
    >
      <span class="mark" aria-hidden="true">
        <span class="pi">π</span>
        <!-- Only .ring rotates; the π is a static, centered sibling so its
             centering transform never collides with the orbit animation. -->
        <span class="ring"><span class="dot"></span></span>
      </span>
      <span class="label" data-testid="working-label">{label}</span>
    </span>
    <!-- aria-hidden: both this elapsed timer and the token counter below live inside the
         role=status live region and tick frequently; announcing every tick would spam a
         screen reader. They're visual liveness affordances — the "Working…"/"Thinking…"
         label carries the announced state. -->
    {#if elapsed}
      <span
        class="elapsed"
        data-testid="working-elapsed"
        aria-hidden="true"
        title="Time elapsed on the current turn">{elapsed}</span
      >
    {/if}
    {#if store.turnActive}
      <span
        class="tokens"
        data-testid="working-tokens"
        aria-hidden="true"
        title="Estimated tokens received from the model this turn (~4 chars/token). Climbing = the API is streaming; frozen = it has stalled."
        >~{tokens.toLocaleString("en-US")} tok</span
      >
    {/if}
  </div>
{/if}

<style>
  .wrap {
    max-width: var(--maxw);
    width: 100%;
    margin: 0 auto;
    padding: 4px 18px 10px;
    animation: fade 0.2s ease;
    display: flex;
    align-items: center;
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
  .tokens,
  .elapsed {
    font-size: 12px;
    color: var(--text-muted);
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
    cursor: default;
    user-select: none;
  }
  .tokens::before,
  .elapsed::before {
    content: "·";
    margin: 0 7px 0 3px;
    opacity: 0.6;
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
