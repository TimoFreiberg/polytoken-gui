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
  import Toast from "./components/Toast.svelte";
  import ImageLightbox from "./components/ImageLightbox.svelte";
  import { imageViewer } from "./lib/image-viewer.svelte.js";
  import IconButton from "./components/ui/IconButton.svelte";
  import { notifyIfUnfocused } from "./lib/notify.js";
  import { wakeLock } from "./lib/wake-lock.js";
  import { trackKeyboardInset } from "./lib/keyboard-inset.js";
  import { STEP as FONT_STEP } from "./lib/font-scale.js";
  import { edgeSwipe } from "./lib/edge-swipe.js";
  import { createEdgeSwipe } from "./lib/edge-swipe.svelte.js";

  // Dev affordance: ?dev shows buttons that drive the mock to any UI state, so the
  // screenshot harness can reach approval/ambient/error states deterministically.
  const dev = new URLSearchParams(location.search).has("dev");

  // Left-edge swipe opens the phone drawer. One controller instance owns the live-follow
  // snapshot; the Sidebar reacts to it for the transform, the action below fires open/cancel.
  // Phone-only (the drawer is the desktop sidebar, always reachable via ⌘B / the header
  // button) and disabled once the drawer is open (a second swipe would just fight the
  // drawer's own scrim/scroll). Tracks the same 859px breakpoint the drawer CSS uses.
  const edge = createEdgeSwipe();
  const PHONE_MQ = "(max-width: 859px)";
  const edgeEnabled = $derived(
    store.sidebarOpen === false &&
      typeof window !== "undefined" &&
      window.matchMedia(PHONE_MQ).matches,
  );
  const scripts = ["reply", "markdown", "search", "thinkingtools", "skill", "confirm", "trust", "input", "qna", "answercard", "answerleadup", "ambient", "compat", "bgrun", "bgwait", "queue", "deliverqueue", "initializing", "editdiff", "images", "error", "idle", "streamhold", "staleidle", "pendinghold", "timeout", "yesno", "journalnudge", "contextfull", "longoutput", "selectmany", "planhandoff", "planhandofftimeout", "planfacet", "permission", "failnewsession"];

  onMount(() => store.start());

  // Transcript zoom: intercept the browser-zoom keys (⌘=/⌘+ grow, ⌘- shrink, ⌘0 reset)
  // and drive our own persisted, PWA-safe text-scale instead. Modifier-gated, so plain
  // typing of = / - / 0 is untouched.
  function onZoomKey(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") {
      e.preventDefault();
      store.bumpFontScale(FONT_STEP);
    } else if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") {
      e.preventDefault();
      store.bumpFontScale(-FONT_STEP);
    } else if (e.key === "0" || e.code === "Numpad0") {
      e.preventDefault();
      store.resetFontScale();
    }
  }

  // Publish the on-screen keyboard's overlap as --keyboard-inset so the composer stays pinned
  // above it on a phone (the CSS below applies it on touch). No-op without visualViewport.
  onMount(() => trackKeyboardInset());

  // Keep the screen awake while the focused session's turn streams, so a phone you're
  // watching doesn't sleep mid-run. Released the moment the turn settles.
  $effect(() => wakeLock.set(store.turnActive));

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

  // App-global navigation hotkeys. The ⌘/Ctrl modifier keeps them clear of typing;
  // component-local handlers own the ⇧-modified combos (⌘⇧M/E/T) and arrow nav, so we
  // take only the unshifted, alt-free set here. (⌘N is browser-reserved in a plain tab
  // but free in the installed PWA / desktop app, pilot's primary surface; ⌘[ / ⌘] cancel
  // the browser's history nav, which is unused since the app routes views client-side.)
  function onGlobalKeydown(e: KeyboardEvent) {
    if (store.unauthorized) return;
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle forward/back through sessions in sidebar order.
    // Handled before the generic guard because it's the one combo that *wants* Shift,
    // and it's gated on Ctrl specifically (Cmd+Tab is the OS app switcher and never
    // reaches us). Like ⌘N, the browser eats it in a plain tab but leaves it for the
    // page in the installed PWA / desktop app, pilot's primary surface. We deliberately
    // don't use Cmd+←/→: in any focused text field (the composer, almost always) those
    // are move-to-line-start/end, and the app already maps history nav to ⌘[ / ⌘].
    if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      store.cycleSession(e.shiftKey ? -1 : 1);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey) return;
    switch (e.key) {
      case "n":
      case "N":
        e.preventDefault();
        store.newSessionHotkey();
        break;
      case "[":
        e.preventDefault();
        store.navBack();
        break;
      case "]":
        e.preventDefault();
        store.navForward();
        break;
      case "b":
      case "B":
        e.preventDefault();
        store.toggleSidebar();
        break;
      case "f":
      case "F":
        // ⌘F — find in transcript. While drafting there's nothing to search, so we let
        // the browser's native find handle the draft form (no preventDefault).
        if (store.draft) break;
        e.preventDefault();
        store.openSearch();
        break;
    }
  }
</script>

<svelte:window onkeydown={(e) => { onZoomKey(e); onGlobalKeydown(e); }} />
{#if store.unauthorized}
  <TokenGate />
{:else}
<div class="shell">
  <Sidebar edge={edge} />
  <div
    class="app"
    use:edgeSwipe={{
      enabled: edgeEnabled,
      onOpen: edge.open,
      onChange: edge.onChange,
      onCancel: edge.cancel,
    }}
  >
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
<!-- Shared full-screen viewer for any read-only transcript image (user attachments,
     tool image output). Opened via imageViewer.open(batch, index) from Transcript /
     ToolCard; the composer drives its own local lightbox. -->
{#if imageViewer.index !== null}
  <ImageLightbox
    images={imageViewer.images}
    index={imageViewer.index}
    onClose={() => imageViewer.close()}
    onIndex={(i) => imageViewer.setIndex(i)}
  />
{/if}
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

<!-- Transient snackbars (archive undo, resolved-elsewhere). Outside the gate so it overlays
     the whole app. -->
<Toast />

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
  /* On touch devices, shrink the app by the on-screen keyboard's overlap (--keyboard-inset,
     published by lib/keyboard-inset.ts from the visualViewport) so the bottom-anchored
     composer stays pinned just above the keyboard instead of sliding behind it / scrolling
     off. Desktop (fine pointer) is untouched, so trackpad pinch-zoom never shrinks the layout;
     the var defaults to 0 when no keyboard is up. */
  @media (pointer: coarse) {
    .shell,
    .app {
      height: calc(100dvh - var(--keyboard-inset, 0px));
    }
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
