<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import ContextRing from "./ContextRing.svelte";

  // Context-window fill for the active session, server-authoritative (folded from the
  // snapshot's `usage`; recomputed at turn boundaries + model switches). Undefined
  // until a snapshot carries it, or when the model exposes no context window — the ring
  // (and its scale/colors) live in the shared ContextRing.
  const usage = $derived(store.session.usage);
</script>

{#if usage}
  <ContextRing {usage} testid="context-meter" />
{/if}
