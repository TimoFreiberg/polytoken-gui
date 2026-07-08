<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  import Button from "./ui/Button.svelte";
  let value = $state("");

  // Explain *why* the gate appeared. An expiry mid-session is disorienting if it
  // reads like a cold first-run prompt, so name it (and reassure nothing's lost).
  const expired = $derived(store.unauthorizedReason === "expired");
</script>

<div class="gate">
  <div class="card">
    <img class="mark" src="/icon.svg" alt="" width="52" height="52" />
    <h1>pantoken</h1>
    {#if expired}
      <p>Your access token was rejected or expired — re-enter it to reconnect.</p>
    {:else}
      <p>This server requires an access token.</p>
    {/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        if (value.trim()) store.authenticate(value);
      }}
    >
      <input bind:value type="password" placeholder="Access token" autocomplete="current-password" />
      <Button variant="primary" size="lg" type="submit" title="Connect with this access token" disabled={!value.trim()}>Connect</Button>
    </form>
    <p class="hint">Tip: open <code>https://&lt;host&gt;/?token=…</code> once and it's remembered.</p>
  </div>
</div>

<style>
  .gate {
    height: 100dvh;
    display: grid;
    place-items: center;
    padding: 20px;
  }
  .card {
    width: min(360px, 100%);
    text-align: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    padding: 28px 24px;
  }
  .mark {
    width: 52px;
    height: 52px;
    margin: 0 auto 12px;
    display: block;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 20px;
  }
  p {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 16px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  input {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 13px;
    font-size: 15px;
    background: var(--bg);
    color: var(--text);
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
  }
  .hint {
    margin: 16px 0 0;
    font-size: 12px;
    color: var(--text-faint);
  }
  .hint code {
    font-family: var(--font-mono);
  }
</style>
