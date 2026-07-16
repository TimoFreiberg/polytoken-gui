<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import { formatWorkedDuration } from "../lib/transcript-view.js";

  // Estimated tokens streamed in this turn — a liveness readout so you can see the API
  // is feeding you (number climbs) vs. stalled (it freezes), even during hidden thinking.
  const tokens = $derived(store.turnStreamTokens);

  // Live elapsed time for the current turn. We anchor to the wall-clock moment THIS
  // client first sees the turn go active (Date.now()), not a server event timestamp:
  // the mock driver's scripted fixtures stamp events with a fake epoch-0 clock, so a
  // Date.now()-minus-event-ts reading would be off by decades in the preview / e2e.
  // Client-side capture is identical under the mock and real driver. Tradeoff: a page reload
  // mid-turn restarts the count from 0 — it measures "time since observed active", not
  // absolute turn start. Acceptable for an ephemeral liveness affordance (same per-client
  // scope as the token counter beside it).
  let startedAt = $state<number | null>(null);
  let nowMs = $state(Date.now());

  // Anchor on the active edge; release when the turn settles. `??=` only stamps the first
  // time we see it active, so a multi-bubble turn keeps one continuous count. Anchors on
  // `creating` too so the timer starts the moment a prompt is sent (warm-up), before the
  // first turn begins — the climbing timer is the liveness signal during that gap.
  $effect(() => {
    if (store.turnActive || creating) startedAt ??= Date.now();
    else startedAt = null;
  });

  // Tick ~1Hz while a turn runs (or warm-up is in progress); the interval is torn down on
  // settle / unmount. nowMs is only written (never read) here, so it can't re-trigger this effect.
  $effect(() => {
    if (!store.turnActive && !creating) return;
    nowMs = Date.now();
    const id = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const elapsed = $derived(
    startedAt === null ? "" : formatWorkedDuration(nowMs - startedAt),
  );

  // A new session is being created server-side (session warming up + first prompt in flight),
  // before its first turn has started. We show the indicator through this gap too so the
  // just-sent prompt isn't left under a silent, idle-looking composer; the climbing timer
  // carries the liveness feedback until the real turn starts.
  const creating = $derived(store.creatingSession !== null && !store.turnActive);
  const stopState = $derived(store.stopState);
</script>

<!-- The "agent is still working" affordance. Lives at the bottom of the chat window,
     just above the composer, so it sits below the last output and stays visible
     through thinking/tool gaps (not only while text streams). Replaces the inline
     streaming caret. Driven by store.turnActive — the robust in-flight signal, so it
     never disappears mid-turn just because a stray snapshot reported idle. The stop
     button takes the place of the former spinner; text labels were removed in favor of
     the stop button's own text/tooltip carrying the stop-action states. -->
{#if store.turnActive || creating}
  <div class="wrap" data-testid="working-indicator" role="status" aria-live="polite">
    {#if store.turnActive}
      <!-- The stop button: same text/tooltip/disabled logic as the former Composer stop
           button. The button's own text carries the stop-action states (■ Stop / ■
           Stopping… / ↻ Retry stop) — no separate label is needed. -->
      <button
        class="stop"
        data-testid="stop-button"
        onclick={() => store.abort()}
        disabled={store.connection !== "connected" || stopState === "stopping"}
        title={store.connection === "connected"
          ? stopState === "stopping"
            ? "Stop requested — waiting for Pantoken"
            : stopState === "unconfirmed"
              ? "Retry stopping the agent (Esc)"
              : "Stop the agent (Esc)"
          : "Can't stop while offline — the agent keeps running"}
      >
        {stopState === "stopping"
          ? "■ Stopping…"
          : stopState === "unconfirmed"
            ? "↻ Retry stop"
            : "■ Stop"}
      </button>
    {/if}
    <!-- aria-hidden: both this elapsed timer and the token counter below live inside the
         role=status live region and tick frequently; announcing every tick would spam a
         screen reader. They're visual liveness affordances — the stop button's visible
         text/title carries the announced state. -->
    {#if elapsed}
      <span
        class="elapsed"
        data-testid="working-elapsed"
        aria-hidden="true">{elapsed}</span
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
    gap: 10px;
  }
  .stop {
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 13px;
    font-weight: 550;
    padding: 5px 14px;
    border-radius: 999px;
    flex-shrink: 0;
  }
  /* Offline: a remote turn can't be stopped from a dead socket, so the pill reads inert
     rather than inviting a dead click (the offline banner explains the agent keeps going). */
  .stop:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @media (pointer: coarse) {
    .stop {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
