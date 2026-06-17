<script lang="ts">
  import { store } from "../lib/store.svelte.js";
  let value = $state("");
</script>

<div class="gate">
  <div class="card">
    <div class="mark">π</div>
    <h1>pilot</h1>
    <p>This server requires an access token.</p>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        if (value.trim()) store.authenticate(value);
      }}
    >
      <input bind:value type="password" placeholder="Access token" autocomplete="current-password" />
      <button type="submit" title="Connect with this access token" disabled={!value.trim()}>Connect</button>
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
    border-radius: 14px;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 28px;
    font-weight: 700;
    display: grid;
    place-items: center;
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
  button {
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: var(--radius-sm);
    padding: 11px;
    font-size: 15px;
    font-weight: 550;
  }
  button:disabled {
    opacity: 0.4;
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
