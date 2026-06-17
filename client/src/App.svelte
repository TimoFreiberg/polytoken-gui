<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte.js";
  import StatusHeader from "./components/StatusHeader.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ConnectionBanner from "./components/ConnectionBanner.svelte";
  import Transcript from "./components/Transcript.svelte";
  import Composer from "./components/Composer.svelte";
  import ApprovalLayer from "./components/ApprovalLayer.svelte";
  import TrustCard from "./components/TrustCard.svelte";
  import TokenGate from "./components/TokenGate.svelte";
  import Settings from "./components/Settings.svelte";
  import { notifyIfHidden } from "./lib/notify.js";

  // Dev affordance: ?dev shows buttons that drive the mock to any UI state, so the
  // screenshot harness can reach approval/ambient/error states deterministically.
  const dev = new URLSearchParams(location.search).has("dev");
  const scripts = ["reply", "confirm", "trust", "input", "ambient"];

  onMount(() => store.start());

  // Buzz the user (when backgrounded) on run-complete and new approvals.
  let prevStatus = "idle";
  let prevPending = 0;
  $effect(() => {
    const status = store.session.status;
    const pending = store.session.pendingApprovals.length;
    if (prevStatus === "running" && status === "idle") {
      notifyIfHidden("pilot", "Agent finished its turn");
    }
    if (pending > prevPending && pending > 0) {
      const top = store.session.pendingApprovals[0];
      const title = top && "title" in top ? top.title : "Waiting on you";
      notifyIfHidden("Approval needed", title);
    }
    prevStatus = status;
    prevPending = pending;
  });
</script>

{#if store.unauthorized}
  <TokenGate />
{:else}
<div class="shell">
  <Sidebar />
  <div class="app">
    <StatusHeader />
    <ConnectionBanner />
    <Transcript />
    {#if dev}
      <div class="devbar">
        {#each scripts as s (s)}
          <button onclick={() => store.mock(s)}>{s}</button>
        {/each}
        <button onclick={() => store.testPush()}>push</button>
      </div>
    {/if}
    <Composer />
  </div>
</div>
<ApprovalLayer />
<TrustCard />
<Settings />
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: row;
    height: 100%;
    height: 100dvh;
  }
  .app {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    height: 100dvh;
  }
  .devbar {
    display: flex;
    gap: 6px;
    justify-content: center;
    padding: 6px;
    border-top: 1px dashed var(--border-strong);
    background: var(--surface-sunken);
  }
  .devbar button {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 3px 9px;
  }
</style>
