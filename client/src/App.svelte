<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte.js";
  import StatusHeader from "./components/StatusHeader.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ConnectionBanner from "./components/ConnectionBanner.svelte";
  import Transcript from "./components/Transcript.svelte";
  import WorkingIndicator from "./components/WorkingIndicator.svelte";
  import NewSession from "./components/NewSession.svelte";
  import Composer from "./components/Composer.svelte";
  import QnaInline from "./components/QnaInline.svelte";
  import ApprovalLayer from "./components/ApprovalLayer.svelte";
  import TrustCard from "./components/TrustCard.svelte";
  import TokenGate from "./components/TokenGate.svelte";
  import Settings from "./components/Settings.svelte";
  import TreeView from "./components/TreeView.svelte";
  import Tooltip from "./components/Tooltip.svelte";
  import IconButton from "./components/ui/IconButton.svelte";
  import { notifyIfUnfocused } from "./lib/notify.js";

  // Dev affordance: ?dev shows buttons that drive the mock to any UI state, so the
  // screenshot harness can reach approval/ambient/error states deterministically.
  const dev = new URLSearchParams(location.search).has("dev");
  const scripts = ["reply", "markdown", "search", "skill", "confirm", "trust", "input", "qna", "ambient", "compat", "bgrun", "bgwait", "queue", "deliverqueue", "initializing", "editdiff", "images", "error", "idle", "streamhold", "staleidle", "pendinghold", "timeout", "yesno", "journalnudge", "contextfull", "longoutput", "selectmany"];

  onMount(() => store.start());

  // Buzz the user (when pilot is unfocused) for every session, not just the focused
  // transcript. The first sessionStatus message is a reconnect baseline, not a live event.
  let prevAttention = new Map<string, string>();
  let prevAttentionVersion = 0;
  $effect(() => {
    const version = store.attentionVersion;
    const attention = [...store.attention.values()];
    const next = new Map(
      attention.map((item) => [
        item.sessionId,
        `${item.phase}:${item.pendingCount ?? 0}:${item.pendingTitle ?? ""}`,
      ]),
    );
    if (version === 0) return;
    if (prevAttentionVersion === 0) {
      prevAttention = next;
      prevAttentionVersion = version;
      return;
    }
    for (const item of attention) {
      const key = next.get(item.sessionId)!;
      if (prevAttention.get(item.sessionId) === key) continue;
      if (
        item.phase !== "waiting" &&
        item.phase !== "failed" &&
        item.phase !== "done"
      )
        continue;
      const listed = store.sessions.find(
        (session) => session.sessionId === item.sessionId,
      );
      const session = listed?.displayName ?? listed?.preview ?? item.sessionId;
      const title =
        item.phase === "waiting"
          ? "Approval needed"
          : item.phase === "failed"
            ? "Run failed"
            : "pilot";
      const detail =
        item.phase === "waiting"
          ? (item.pendingTitle ?? "Waiting on you")
          : item.phase === "failed"
            ? (item.activity ?? "The run failed")
            : "Agent finished its turn";
      notifyIfUnfocused(title, `${session}: ${detail}`, {
        tag: `pilot-${item.phase}-${item.sessionId}`,
        onClick: () => store.openSessionById(item.sessionId),
      });
    }
    prevAttention = next;
    prevAttentionVersion = version;
  });

  // Reflect the active session's title in the browser tab so it's legible from the
  // tab strip / app switcher instead of always reading "pilot" (DESIGN.md SHOULD).
  // Ambient title wins over the folded snapshot title, mirroring StatusHeader.
  $effect(() => {
    const t = store.session.ambient.title || store.session.title;
    document.title = t ? `${t} · pilot` : "pilot";
  });
</script>

{#if store.unauthorized}
  <TokenGate />
{:else}
<div class="shell">
  <Sidebar />
  <div class="app">
    <StatusHeader />
    <div class="chat">
      <ConnectionBanner />
      {#if store.draft}
        <NewSession />
      {:else}
        <Transcript />
        <WorkingIndicator />
      {/if}
      {#if dev}
        <div class="devbar">
          {#each scripts as s (s)}
            <button onclick={() => store.mock(s)}>{s}</button>
          {/each}
          <button onclick={() => store.testPush()}>push</button>
          <button onclick={() => store.markUpdateReady()}>update</button>
        </div>
      {/if}
      <QnaInline />
      <Composer />
      <ApprovalLayer />
    </div>
  </div>
</div>
<TrustCard />
<Settings />
<TreeView />
{#if store.swUpdateReady}
  <div class="update-toast" role="status">
    <span class="update-msg">A new version of pilot is available.</span>
    <button
      class="update-refresh"
      title="Reload to update to the new version"
      onclick={() => store.applyUpdate()}>Refresh</button
    >
    <IconButton
      size="sm"
      title="Dismiss update notice"
      aria-label="Dismiss update"
      onclick={() => store.dismissUpdate()}>×</IconButton
    >
  </div>
{/if}
{/if}

<!-- Themed tooltip override for every `title` in the app; works behind the gate too. -->
<Tooltip />

<style>
  .shell {
    display: flex;
    flex-direction: row;
    height: 100%;
    height: 100dvh;
    overflow-x: hidden;
  }
  .app {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    height: 100dvh;
  }
  .chat {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .devbar {
    display: flex;
    flex-wrap: wrap;
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
  .update-toast {
    position: fixed;
    left: 50%;
    bottom: calc(16px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: calc(100vw - 24px);
    padding: 9px 10px 9px 14px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    box-shadow: var(--shadow-pop);
    font-size: 13px;
    color: var(--text);
  }
  .update-refresh {
    flex-shrink: 0;
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: 999px;
    padding: 5px 13px;
    font-size: 12.5px;
    font-weight: 550;
  }
</style>
