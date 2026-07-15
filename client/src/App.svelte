<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte.js";
  import StatusHeader from "./components/StatusHeader.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import RightSidebar from "./components/RightSidebar.svelte";
  import ConnectionBanner from "./components/ConnectionBanner.svelte";
  import Transcript from "./components/Transcript.svelte";
  import WorkingIndicator from "./components/WorkingIndicator.svelte";
  import NewSession from "./components/NewSession.svelte";
  import Composer from "./components/Composer.svelte";
  import QnaInline from "./components/QnaInline.svelte";
  import ApprovalLayer from "./components/ApprovalLayer.svelte";
  import TokenGate from "./components/TokenGate.svelte";
  import Settings from "./components/Settings.svelte";
  import PlanView from "./components/PlanView.svelte";
  import Tooltip from "./components/Tooltip.svelte";
  import ChatNotice from "./components/ChatNotice.svelte";
  import ImageLightbox from "./components/ImageLightbox.svelte";
  import { untrack } from "svelte";
  import { imageViewer } from "./lib/image-viewer.svelte.js";
  import { attention, type AttentionSurface } from "./lib/attention-cycle.svelte.js";
  import IconButton from "./components/ui/IconButton.svelte";
  import { notifyIfUnfocused } from "./lib/notify.js";
  import { wakeLock } from "./lib/wake-lock.js";
  import { trackKeyboardInset } from "./lib/keyboard-inset.js";
  import { watchAppBadgeClear } from "./lib/app-badge.js";
  import { STEP as FONT_STEP } from "./lib/font-scale.js";
  import { edgeSwipe } from "./lib/edge-swipe.js";
  import { createEdgeSwipe } from "./lib/edge-swipe.svelte.js";
  import { PHONE_MQ } from "./lib/overlay-history.js";
  import { auxClickAction } from "./lib/store-helpers.js";
  import type { PermissionMonitorMode } from "@pantoken/protocol";

  // Dev affordance: ?dev shows buttons that drive the mock to any UI state, so the
  // screenshot harness can reach approval/ambient/error states deterministically.
  const dev = new URLSearchParams(location.search).has("dev");

  // Dev-only test hook for the live (fake-daemon) e2e tier. The fake driver's
  // run_script vocabulary (stream/queue/abort/ask/approve) differs from the mock's
  // dev-bar buttons, and the bar's script list is the mock's. Rather than duplicate
  // that list, expose the SAME capability the dev bar already offers (store.mock →
  // {type:"mock", script}) as a named hook the live specs call by name via
  // page.evaluate. Gated on ?dev, so it never attaches on a normal load. The Rust
  // `run_script` match is the single source of truth for valid names; an unknown one
  // just warns server-side and the flow never renders → the spec fails loud.
  onMount(() => {
    if (!dev) return;
    (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock =
      (script: string) => store.mock(script);
  });

  // Left-edge swipe opens the phone drawer. One controller instance owns the live-follow
  // snapshot; the Sidebar reacts to it for the transform, the action below fires open/cancel.
  // Phone-only (the drawer is the desktop sidebar, always reachable via ⌘B or the left
  // edge pop-in arrow below) and disabled once the drawer is open (a second swipe would
  // just fight the drawer's own scrim/scroll). Tracks the same 859px breakpoint the
  // drawer CSS uses.
  const edge = createEdgeSwipe();
  const edgeEnabled = $derived(
    store.sidebarOpen === false &&
      typeof window !== "undefined" &&
      window.matchMedia(PHONE_MQ).matches,
  );
  const scripts = ["reply", "reset", "markdown", "search", "thinkingtools", "skill", "confirm", "input", "qna", "answercard", "answerleadup", "ambient", "compat", "bgrun", "bgwait", "queue", "deliverqueue", "discardqueue", "initializing", "editdiff", "editbounds", "editpatch", "images", "error", "idle", "streamhold", "staleidle", "pendinghold", "slowabort", "timeout", "yesno", "journalnudge", "contextfull", "longoutput", "selectmany", "planhandoff", "planhandofftimeout", "planfacet", "planview", "goalactive", "goalclear", "context", "permission", "failnewsession", "failsession", "goal", "unknown", "jobs"];

  // The agent-driven attention surfaces currently active, in cycle order. The ⌘\
  // hotkey advances focus through these; each cycled-away-from surface collapses to
  // a pill. Transcript is always present (the "home" surface). User-driven modals
  // (Settings, PlanView, ImageLightbox) are excluded — they have their
  // own hotkeys and are not agent-initiated.
  const activeAttentionSurfaces = $derived.by(() => {
    const surfaces: AttentionSurface[] = ["transcript"];
    // While drafting, store.session is the previous session and its qna/approval
    // cards are unmounted (App gates them on !store.draft) — don't offer them.
    if (store.draft) return surfaces;
    if (store.session.pendingApprovals.some((r) => r.kind === "qna"))
      surfaces.push("qna");
    if (store.session.pendingApprovals.some((r) => r.kind !== "qna"))
      surfaces.push("approval");
    return surfaces;
  });

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

  // The SW sets the app-icon badge from push payloads; clear it whenever the
  // app comes to the foreground (no-op where the Badging API is missing).
  onMount(() => watchAppBadgeClear());

  // Keep the screen awake while the focused session's turn streams, so a phone you're
  // watching doesn't sleep mid-run. Released the moment the turn settles.
  $effect(() => wakeLock.set(store.turnActive));

  // Buzz the user (when pantoken is unfocused) for every session, not just the focused
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
            : "pantoken";
      const detail =
        item.phase === "waiting"
          ? (item.pendingTitle ?? "Waiting on you")
          : item.phase === "failed"
            ? (item.activity ?? "The run failed")
            : "Agent finished its turn";
      notifyIfUnfocused(title, `${session}: ${detail}`, {
        tag: `pantoken-${item.phase}-${item.sessionId}`,
        onClick: () => store.openSessionById(item.sessionId),
      });
    }
    prevAttention = next;
    prevAttentionVersion = version;
  });

  // Reflect the active session's title in the browser tab so it's legible from the
  // tab strip / app switcher instead of always reading "pantoken" (DESIGN.md SHOULD).
  // Ambient title wins over the folded snapshot title, mirroring StatusHeader.
  $effect(() => {
    if (store.draft) {
      document.title = "New session · pantoken";
      return;
    }
    const t = store.session.ambient.title || store.session.title;
    document.title = t ? `${t} · pantoken` : "pantoken";
  });

  // When ⌘\ cycles to transcript (home), refocus the composer textarea.
  // focusComposer() just bumps a counter; the composer reacts to it (idempotent).
  // untrack: focusComposer() writes focusComposerN ($state) — without untrack,
  // that write re-triggers this effect (Svelte 5 treats writes during an effect
  // as potential self-dependencies), creating an infinite re-run loop that floods
  // the microtask queue and blocks the next keydown from firing.
  $effect(() => {
    const f = attention.focused;
    if (f === "transcript") untrack(() => store.focusComposer());
  });

  // App-global navigation hotkeys. The ⌘/Ctrl modifier keeps them clear of typing;
  // component-local handlers own the ⇧-modified combos (⌘⇧M/E/J) and arrow nav, so we
  // take only the unshifted, alt-free set here — plus ⌘⇧C (facet menu) and ⌘⇧P
  // (permission monitor cycle), which are app-global. (⌘N is browser-reserved in a
  // plain tab but free in the installed PWA / desktop app, pantoken's primary surface;
  // ⌘[ / ⌘] cancel the browser's history nav, which is unused since the app routes
  // views client-side.)
  function onGlobalKeydown(e: KeyboardEvent) {
    if (store.unauthorized) return;
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle forward/back through sessions in sidebar order.
    // Handled before the generic guard because it's the one combo that *wants* Shift,
    // and it's gated on Ctrl specifically (Cmd+Tab is the OS app switcher and never
    // reaches us). Like ⌘N, the browser eats it in a plain tab but leaves it for the
    // page in the installed PWA / desktop app, pantoken's primary surface. We deliberately
    // don't use Cmd+←/→: in any focused text field (the composer, almost always) those
    // are move-to-line-start/end, and the app already maps history nav to ⌘[ / ⌘].
    if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      store.cycleSession(e.shiftKey ? -1 : 1);
      return;
    }
    // ⌘⇧C / Ctrl+Shift+C — open the facet dropdown. A modifier combo so it
    // fires even when the composer is focused (unlike Shift+Tab, which the
    // browser consumes for reverse-focus traversal in form fields). Known
    // trade-off: ⌘⇧C is the browser's Inspect Element shortcut, so like ⌘N
    // it mostly won't reach us in a plain tab, and the installed PWA /
    // desktop app — pantoken's primary surface — deliberately gives it to
    // the page (devtools stay reachable via menu / ⌘⌥I there). Opens the
    // facet picker; number keys (1-9) quick-select inside it. While
    // drafting a new session, composerFacet/setFacet target the DRAFT's
    // facet pick — not the last-focused live session.
    // Must run before the modifier early-return below (has Shift).
    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      !e.altKey &&
      (e.key === "C" || e.key === "c")
    ) {
      e.preventDefault();
      store.openFacetMenu();
      return;
    }
    // ⌘Shift+P — cycle permission monitor mode
    // (Standard → Bypass → Bypass+ → Autonomous → Standard).
    // Must run before the modifier early-return below (has Shift).
    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      !e.altKey &&
      (e.key === "P" || e.key === "p")
    ) {
      e.preventDefault();
      const modes: PermissionMonitorMode[] = [
        "standard",
        "bypass",
        "bypass_plus",
        "autonomous",
      ];
      const current = store.composerPermissionMonitor;
      const idx = modes.indexOf(current);
      const next = modes[(idx + 1) % modes.length]!;
      store.setPermissionMonitor(next);
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
      case "p":
      case "P":
        // ⌘P — toggle the plan view overlay (only when a plan exists). Inert
        // while drafting: store.session is the PREVIOUS session and PlanView is
        // unmounted in the draft view, so toggling would only flip invisible state.
        if (!store.draft && store.session.activePlan) {
          e.preventDefault();
          store.togglePlanView();
        }
        break;
      case "\\":
        // ⌘\ / Ctrl+\ — cycle focus through active agent-driven attention surfaces
        // (transcript → qna → approval → …). Each cycled-away-from surface
        // collapses to a pill. No-op when a user-driven modal owns the keyboard,
        // or while drafting (the qna/approval surfaces belong to the previous
        // session and are unmounted in the draft view).
        if (
          store.draft ||
          store.settingsOpen ||
          store.planViewOpen ||
          imageViewer.index !== null
        )
          break;
        e.preventDefault();
        attention.cycle(activeAttentionSurfaces);
        break;
    }
  }

  function onMouseAuxClick(e: MouseEvent) {
    if (store.unauthorized) return;
    const action = auxClickAction(e.button);
    if (!action) return;
    e.preventDefault();
    if (action === "back") store.navBack();
    else store.navForward();
  }
</script>

<svelte:window
  onkeydown={(e) => { onZoomKey(e); onGlobalKeydown(e); }}
  onauxclick={onMouseAuxClick}
/>
{#if store.unauthorized}
  <TokenGate />
{:else if store.protocolMismatch}
  <div class="fatal">
    <h1>Update required</h1>
    <p>{store.protocolMismatch}</p>
    <button onclick={() => location.reload()}>Reload</button>
  </div>
{:else}
<div class="shell">
  <Sidebar edge={edge} />
  <!-- No edge pop-in arrows on either side: both collapsed panels reopen from a chevron
       in the header (StatusHeader), at the leading/trailing edge respectively — the top
       corner each panel's own collapse control sits in. (⌘B / ⌘⇧J too.) A collapsed
       panel's own root is display:none (desktop) or translated off-screen (phone
       drawer), so it can't host its reopen affordance itself. -->
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
      <ChatNotice />
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
      <!-- QnaInline/ApprovalLayer read store.session, which still holds the
           PREVIOUS session while a new-session draft is up — hide them there so
           its dialogs can't pop over the draft form (sidebar attention still
           points at them). -->
      {#if !store.draft}
        <QnaInline />
      {/if}
      <Composer />
      {#if !store.draft}
        <ApprovalLayer />
      {/if}
    </div>
  </div>
  <!-- No right edge pop-in arrow: the collapsed context panel reopens from the header's
       trailing-edge chevron (StatusHeader), which lands on the same pixel as the panel's
       own collapse chevron — so collapse/expand is one repeatable click. (⌘⇧J too.) -->
  {#if !store.draft}
    <RightSidebar />
  {/if}
</div>
<Settings />
{#if !store.draft}
  <PlanView />
{/if}
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
    <span class="update-msg">A new version of pantoken is available.</span>
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
<!-- Themed tooltip override for every `title` in the app; works behind the gate too. -->
<Tooltip />

<style>
  .fatal {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    height: 100dvh;
    padding: 40px;
    text-align: center;
    font-family: var(--font-sans);
    color: var(--text);
    background: var(--bg);
  }
  .fatal h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0;
  }
  .fatal p {
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-muted);
    max-width: 360px;
    margin: 0;
  }
  .fatal button {
    font: inherit;
    font-size: 14px;
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--highlight);
    background: var(--highlight);
    color: var(--highlight-text);
    cursor: pointer;
  }
  .fatal button:hover {
    border-color: var(--highlight-hover);
    background: var(--highlight-hover);
  }
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
