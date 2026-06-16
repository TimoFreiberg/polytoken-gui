<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte.js";
  import StatusHeader from "./components/StatusHeader.svelte";
  import Transcript from "./components/Transcript.svelte";
  import Composer from "./components/Composer.svelte";
  import ApprovalLayer from "./components/ApprovalLayer.svelte";

  // Dev affordance: ?dev shows buttons that drive the mock to any UI state, so the
  // screenshot harness can reach approval/ambient/error states deterministically.
  const dev = new URLSearchParams(location.search).has("dev");
  const scripts = ["reply", "confirm", "trust", "input", "ambient"];

  onMount(() => store.start());
</script>

<div class="app">
  <StatusHeader />
  <Transcript />
  {#if dev}
    <div class="devbar">
      {#each scripts as s (s)}
        <button onclick={() => store.mock(s)}>{s}</button>
      {/each}
    </div>
  {/if}
  <Composer />
</div>
<ApprovalLayer />

<style>
  .app {
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
