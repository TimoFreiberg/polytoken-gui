<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { reveal } from "../lib/transitions.js";
  import Chevron from "./ui/Chevron.svelte";
  import CollapseFooter from "./ui/CollapseFooter.svelte";
  import CoinMark from "./ui/CoinMark.svelte";
  import { store } from "../lib/store.svelte.js";
  import {
    filterHiddenThinking,
    createTurnGrouper,
    injectText,
    thinkingTailId,
    type TurnGroup,
    workedLabel,
  } from "../lib/transcript-view.js";
  import type { TranscriptItem } from "@pantoken/protocol";
  import Markdown from "./Markdown.svelte";
  import ToolCard from "./ToolCard.svelte";
  import ThinkingBlock from "./ThinkingBlock.svelte";
  import QnaResult from "./QnaResult.svelte";
  import TranscriptSearch from "./TranscriptSearch.svelte";
  import PullIndicator from "./PullIndicator.svelte";
  import { pullToRefresh } from "../lib/pull-to-refresh.js";
  import { createPullRefresh } from "../lib/pull-to-refresh.svelte.js";
  import { imageViewer } from "../lib/image-viewer.svelte.js";
  import {
    loadScrollPositions,
    persistScrollPositions,
    saveScrollPosition,
    planRestore,
  } from "../lib/scroll-position.js";
  import { nextPinned } from "../lib/scroll-follow.js";
  import {
    DRIFT_THRESHOLD,
    isPinnedDrift,
    isUnpinnedDuringStreaming,
    nextDriftState,
    pushSample,
    formatTrace,
    type DriftSample,
  } from "../lib/scroll-watch.js";

  const items = $derived(store.transcriptItems);

  // Pull-to-refresh (touch only): pulling the transcript down from the top forces a
  // reconnect + re-snapshot — the universal mobile "I think this is stale" gesture.
  const pull = createPullRefresh();
  onDestroy(() => pull.dispose());
  onDestroy(() => disarm());

  // Touch devices have no hover, so the copy footer (hover-revealed on desktop) would be
  // unreachable. Pin it visible on touch-primary devices. Gate on a JS capability check
  // (maxTouchPoints), NOT `@media (hover: none)` — headless Chromium reports hover:none
  // and would force the button visible on desktop too, breaking the desktop fade-out spec.
  const isTouch =
    typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;

  // The branch handle of the most recent user prompt — the target of the
  // Cmd/Ctrl+Shift+↑ "branch from last prompt" hotkey, so its button can advertise the
  // shortcut. undefined when no prompt carries an entry id yet.
  const lastUserEntryId = $derived.by(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.kind === "user" && it.entryId) return it.entryId;
    }
    return undefined;
  });
  // The entry id of the active path's TIP — the last transcript item that carries one.
  // Branching "from here" on the tip is a no-op (it's already where the next message
  // appends), so the turn-final assistant footer suppresses its branch button there.
  // "Last item with an entry id" (any kind) — not "last assistant" — so a committed user
  // prompt with no answer yet correctly shifts the tip off the prior assistant, keeping
  // that earlier turn genuinely branchable. (The real daemon backfills an entry id on every
  // settled turn; the mock now matches so this holds across both drivers.)
  const leafEntryId = $derived.by(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      // Only user/assistant items carry an entry id (tool items never do), so the tip is
      // the last of those — a trailing tool item is part of its turn, not a fork point.
      if (it && (it.kind === "user" || it.kind === "assistant") && it.entryId)
        return it.entryId;
    }
    return undefined;
  });
  // Two view-model passes (pure, unit-tested in transcript-view.test.ts):
  //   1. filterHiddenThinking — drop thinking-only assistant items when the toggle is
  //      on, so they don't create invisible gaps between tool cards.
  //   2. groupTurns — each turn (user → next user) splits into a collapsible "work"
  //      portion (tools + intermediate narration) and the turn-final response that
  //      stays visible. That's the "Worked for Ns" block below.
  const displayItems = $derived(filterHiddenThinking(items, store.hideThinking));
  // When hideThinking is on, only the active thinking tail renders (collapsed):
  // the last item, if it's still streaming reasoning with no answer text yet.
  // null = show all thinking blocks (hideThinking off); otherwise a Set of item
  // IDs whose thinking should be visible (at most one — the tail, or empty).
  const visibleThinkingIds = $derived.by<(Set<string> | null)>(() => {
    if (!store.hideThinking) return null;
    const tail = thinkingTailId(displayItems);
    return tail ? new Set([tail]) : new Set<string>();
  });
  // While the last turn is active, its trailing text is only a candidate final
  // response — another tool can still follow. Keep the whole turn inline until the
  // lifecycle says it settled, then expose the collapse affordance.
  const groupTurnsMemo = createTurnGrouper();
  const turns = $derived(groupTurnsMemo(displayItems, store.turnActive));
  const lastTurnId = $derived(turns[turns.length - 1]?.id);
  function turnDone(turn: TurnGroup): boolean {
    return turn.id !== lastTurnId || !store.turnActive;
  }

  // Click-twice confirm gate for rewind (a destructive action — the daemon's /rewind
  // drops the target prompt + everything after, NOT a non-destructive branch). First
  // click arms the button into a "Click again to rewind" state (destructive red + armed
  // label); second click within ARM_TIMEOUT fires the rewind. No popup — phone-first.
  // Shared by the user-prompt + assistant-footer rewind buttons.
  const ARM_TIMEOUT = 3000;
  let armedRewindId = $state<string | null>(null);
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  function confirmRewind(entryId: string): void {
    if (armedRewindId === entryId) {
      // Second click within the window — fire.
      disarm();
      store.branch(entryId);
    } else {
      // First click — arm.
      disarm();
      armedRewindId = entryId;
      armTimer = setTimeout(disarm, ARM_TIMEOUT);
    }
  }
  function disarm(): void {
    armedRewindId = null;
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
  }
  // Reset the armed state when the transcript's session changes (a rewind changes the
  // items, so the armed entryId is no longer valid).
  $effect(() => {
    void items;
    disarm();
  });

  // Per-work-run open/close, keyed by lane id (a turn can hold several runs, split by
  // pinned answer/screenshot cards). Default: collapsed once the turn settles, expanded
  // while it's still in flight. An explicit user toggle overrides the default.
  let workOpen = $state<Record<string, boolean>>({});
  function toggleWork(laneId: string, turn: TurnGroup) {
    const current = workOpen[laneId] ?? !turnDone(turn);
    workOpen = { ...workOpen, [laneId]: !current };
  }
  function workShown(laneId: string, turn: TurnGroup): boolean {
    // ⌘F must be able to find (and land on) a match inside a collapsed "Worked for Ns"
    // run — otherwise runSearch's TreeWalker never sees its unmounted text. Force every
    // lane open while search is active; `workOpen` itself is left untouched, so closing
    // search naturally restores each lane's prior state (manual toggle or the turnDone
    // default) with no extra bookkeeping.
    if (store.searchOpen) return true;
    return workOpen[laneId] ?? !turnDone(turn);
  }

  // Per-turn aggregation for the assistant footer (copy + timestamp). Only the LAST
  // assistant paragraph of a turn carries the footer, and ONLY once the turn is done
  // (turnDone). While a turn is still in flight, NO paragraph gets the footer: a
  // paragraph that currently looks final can still be followed by more tools and more
  // text, so attaching the footer mid-turn renders it on a non-final paragraph (the bug
  // — a finished-streaming paragraph followed by running tool cards). Copy grabs ALL of
  // the turn's assistant text (every paragraph joined), excluding tool + thinking
  // blocks. Keyed by the turn-final text-bearing assistant item's id, value = joined text.
  const turnText = $derived.by(() => {
    const map = new Map<string, string>();
    for (const turn of turns) {
      // A live turn's trailing paragraph is only a candidate final response — suppress
      // the footer until it settles, then surface it on the genuine final paragraph.
      if (!turnDone(turn)) continue;
      const buf: string[] = [];
      let lastId: string | null = null;
      // work → visible → response is chronological order; only assistant items bear text.
      for (const it of [...turn.work, ...turn.visible, ...turn.response]) {
        if (it.kind === "assistant" && it.text) {
          buf.push(it.text);
          lastId = it.id;
        }
      }
      if (lastId !== null) map.set(lastId, buf.join("\n\n"));
    }
    return map;
  });

  // Per-inject expand state — a nudge note renders as a tiny collapsed pill by
  // default; clicking reveals its text. Keyed by item id, default collapsed.
  let injectOpen = $state<Record<string, boolean>>({});
  function toggleInject(id: string) {
    injectOpen = { ...injectOpen, [id]: !injectOpen[id] };
  }

  let scroller = $state<HTMLDivElement>();
  // Reactive so `showNewPill` ($derived) re-evaluates when scrolling flips it.
  let pinned = $state(true);

  // A monotonically-bumped tick that forces relative timestamps to re-evaluate
  // on a coarse cadence. Cheap: one timer, no per-item state.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  const ANCIENT_CUTOFF_MS = Date.parse("2020-01-01T00:00:00Z");

  /** Human-friendly relative time. Reads `now` so callers re-run on each tick. */
  function relativeTime(iso: string): string {
    // `iso` may be an ISO 8601 string or epoch milliseconds as a string.
    // Number(iso) handles the epoch-ms case; Date.parse handles ISO strings.
    const then = new Date(Number(iso) || iso).getTime();
    // Same plausibility floor as lib/relative-time.ts: fabricated epoch-era
    // stamps (seed fallbacks) must render as nothing, not "20644d ago".
    if (Number.isNaN(then) || then < ANCIENT_CUTOFF_MS) return "";
    const diff = now - then;
    if (diff < 45_000) return "just now";
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(diff / 3_600_000);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(diff / 86_400_000);
    return `${days}d ago`;
  }

  /** Exact local timestamp for the `title=` hover tooltip. */
  function exactTime(iso: string): string {
    const d = new Date(Number(iso) || iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // Long user prompts (a pasted brief, a log dump) render clamped to ~10 lines
  // with an explicit expand/collapse toggle, so one prompt can't swallow the
  // transcript. Expansion is per-item view state (resets on reload, like scroll).
  // The length gate is a cheap text heuristic (newline count, plus a char floor
  // for single-paragraph walls) rather than DOM measurement — deterministic and
  // no per-bubble observer; the CSS line-clamp handles soft-wrap visually.
  const PROMPT_CLAMP_LINES = 10;
  let expandedPrompts = $state<ReadonlySet<string>>(new Set());
  function isLongPrompt(text: string): boolean {
    return (
      text.split("\n").length > PROMPT_CLAMP_LINES || text.length > 1200
    );
  }
  function togglePromptExpanded(id: string): void {
    const next = new Set(expandedPrompts);
    if (!next.delete(id)) next.add(id);
    expandedPrompts = next;
  }

  // Per-item "Copied" feedback, keyed by item id. Cleared after a short delay.
  // Copies via store.copyToClipboard so a rejection (permissions / insecure
  // context) surfaces as a visible error instead of a silent no-op.
  let copiedId = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyText(id: string, text: string) {
    if (!(await store.copyToClipboard(text))) return;
    copiedId = id;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedId = null;
    }, 1500);
  }

  // A scalar that grows whenever the transcript gains content: item count plus the
  // streaming length of the last item. Reactive — the grow-detector effect reads it.
  const contentSize = $derived.by(() => {
    const last = items[items.length - 1];
    let tick = 0;
    if (last?.kind === "assistant") {
      tick = last.text.length + last.thinking.length;
    } else if (last?.kind === "tool") {
      // A running tool streams its output into `text` (and ticks `progress`) via
      // toolUpdated. Count it too, so the pinned-scroll effect re-runs and keeps
      // following a long command's output — not just assistant deltas.
      tick = (last.text?.length ?? 0) + (last.progress ?? 0);
    }
    return items.length * 1_000_000 + tick;
  });
  // The previous content size, to tell "the transcript grew" from "it re-rendered".
  // Starts at -1 so the first measurement never reads as growth.
  let prevSize = -1;

  // --- Prompt-stepping nav (Cmd/Ctrl+↑/↓). `navIndex` is a cursor into the visible
  //     `.row.user` list: null = not stepping (sitting at the live tail). ↑ walks toward
  //     older prompts, ↓ toward newer ones, and stepping past the newest returns to the
  //     live bottom. The CURSOR — not the scroll position — is the source of truth, so a
  //     rapid burst of presses steps deterministically even while a scroll from the
  //     previous press is still settling (reading scrollTop mid-jump would stutter).
  // $state: the template reads it (`class:visible` keeps the floating nav
  // control shown while actively stepping) — a plain let wouldn't re-render.
  let navIndex = $state<number | null>(null);
  // Whether the transcript area is hovered or focused, so the floating prev/next
  // prompt-nav control is visible. On touch (pointer: coarse) the control is always
  // visible via CSS — hover/focus doesn't apply there.
  let navHovered = $state(false);
  // A programmatic scroll fires `scroll` events of its own; treat scrolls within this
  // window as ours and keep the cursor. Once it lapses, a genuine user scroll drops the
  // cursor so the next ↑ re-anchors to the most recent prompt. Prompt-stepping uses an
  // INSTANT scroll (scrollTo, no animation), so it lands within a frame or two; the
  // window is short (120ms) but still covers the async scroll-event dispatch + any rAF
  // the browser defers to. settleScroll (switch/restore/send) keeps its own longer
  // 500ms window since it chases late layout reflow.
  let progScrollUntil = 0;
  function markProgScroll(ms = 120): void {
    progScrollUntil = Date.now() + ms;
  }

  // ── Pinned-scroll drift watcher: self-heal + diagnostics ──────────────────────
  //
  // A watcher that continuously checks the pinned invariant: a pinned scroller SHOULD sit
  // at the bottom (gap ≈ 0). When the viewport has drifted far from it (gap > DRIFT_THRESHOLD),
  // the watcher (a) self-heals by re-asserting scrollTo(bottom) and (b) raises a sticky
  // in-app notice offering a "Copy trace" of the recent scroll geometry. The notice is
  // ALWAYS ON (no longer ?dev-gated) — the single-user release build needs this diagnostic
  // visible (the real Pantoken.app loads no ?dev). A second, notice-only condition catches
  // the suspected false-un-pin: un-pinned while streaming with content below the fold.
  //
  // WHY THIS EXISTS (the gap in the follow logic this closes):
  //  - The streaming-pin $effect (below) only re-asserts the bottom when `contentSize`
  //    changes, and `contentSize` tracks only item count + the LAST item's streaming length.
  //    It does NOT tick on: a "Worked for Ns" block collapsing (animated reveal slide), an
  //    image decode, a markstream block reflow when final/fade flips, or growth in a non-last
  //    item.
  //  - The only other re-assert path is the ResizeObserver → applySettle(). For the
  //    ratio-based restore (a saved reading spot) it is gated on
  //    `Date.now() < settleUntil` — a ~500ms window opened only by settleScroll() on
  //    send/switch/restore. The live-bottom follow (settleRatio === undefined) now
  //    re-asserts on EVERY content height change while pinned (#57), closing the gap
  //    that previously stranded a pinned viewport past/short of the content end.
  //  - So OUTSIDE that window, a height change while `pinned` only strands the viewport
  //    in the ratio-restore (scrolled-up reading) case; the pinned live-bottom case is
  //    now handled by the ResizeObserver. The watcher remains as a safety net for
  //    large/catastrophic drift and any future regression.
  //
  // The watcher closes the gap directly: it checks the invariant on a sampling interval AND
  // on each onScroll, regardless of which height-churn event caused the stranding. The
  // self-heal is a no-regret fix (a pinned scroller should be at the bottom); the notices
  // are always-on diagnostics for the root-cause fix. The pure decisions live in
  // scroll-watch.ts (unit-tested). See scroll-follow.ts for the related pin decision.
  let traceBuffer: DriftSample[] = [];
  // Frozen copy of the ring buffer at the instant a drift episode was first
  // detected. The live `traceBuffer` keeps rolling every 250ms tick + onScroll,
  // so by the time a sticky notice's "Copy trace" action runs (which can be
  // minutes later — the notice is sticky, durationMs: 0), the live buffer has
  // moved far past the actual drift and would emit whatever happened most
  // recently (e.g. the user's own jump-to-bottom), not the drift. The snapshot
  // freezes the evidence at detection so the trace is self-consistent with
  // `lastDetectedAt`. See scroll-watch.test.ts "snapshot" describe block.
  let traceSnapshot: DriftSample[] = [];
  let driftReported = false;
  // A separate latch for the un-pinned-during-streaming notice (the false-un-pin suspect).
  // Distinct from `driftReported` because the two conditions are mutually exclusive (pinned
  // vs !pinned) and a single shared latch would suppress one notice type after the other
  // fired during a transitional tick. Re-arms when `gap` returns to 0 (back at the bottom).
  let unpinnedReported = false;
  // The detection instant of the current/last drift episode — captured for the trace header
  // so the root-cause analysis knows when the drift was first observed. Shared across both
  // notice types: whichever episode fired most recently owns the header's `detectedAt`. The
  // ring-buffer samples themselves are correct regardless (they always capture), so only the
  // header's instant reflects the most recent episode — acceptable for a diagnostics-only
  // feature (per-notice attribution isn't worth a second variable).
  let lastDetectedAt = 0;

  /** Capture a scroll-geometry sample, push it to the ring buffer, evaluate drift, and (if
   *  drifting) self-heal + raise the debug notice. Called on the 250ms sampling interval and
   *  on each onScroll (so user scrolls land in the trace too). Pure decisions are delegated
   *  to scroll-watch.ts. */
  function sampleGeometry(): void {
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    const scrollHeight = scroller.scrollHeight;
    const clientHeight = scroller.clientHeight;
    const gap = scrollHeight - scrollTop - clientHeight;
    const s: DriftSample = {
      t: Date.now(),
      scrollTop,
      scrollHeight,
      clientHeight,
      gap,
      pinned,
      turnActive: store.turnActive,
    };
    traceBuffer = pushSample(traceBuffer, s, 40);

    // Two mutually-exclusive drift detectors run here, each with its OWN episode latch so a
    // notice of one type can't suppress the other on a transitional tick:
    //
    //  1. isPinnedDrift (pinned && gap > DRIFT_THRESHOLD): the pinned scroller has drifted far
    //     from the bottom after a height-churn event the follow logic missed. Self-heals
    //     (re-asserts scrollTo(bottom)) AND raises a sticky notice. Notice was previously
    //     ?dev-gated; it's now ALWAYS ON — the single-user release build needs this
    //     diagnostic visible (the real Pantoken.app loads no ?dev). The self-heal was always
    //     un-gated and stays so.
    //
    //  2. isUnpinnedDuringStreaming (!pinned && turnActive && gap > 0): the viewport is
    //     un-pinned while the agent is actively streaming, with content below the fold — the
    //     suspected false-un-pin recurrence (a "Worked for Ns" collapse anchor-adjusts
    //     scrollTop, which nextPinned reads as a genuine scroll-up and un-pins). Once
    //     un-pinned, every re-assert path bails, stranding the viewport. Notice-ONLY: the
    //     self-heal NEVER fires here (never yank a reader who deliberately scrolled up). The
    //     latch re-arms when gap returns to 0 (back at the bottom).
    //
    // When neither fires, both latches re-arm for the next episode.
    if (isPinnedDrift({ pinned, gap })) {
      const latch = nextDriftState(driftReported, gap, DRIFT_THRESHOLD);
      driftReported = latch.reported;

      // SELF-HEAL (always on, not dev-gated): re-assert the bottom. Mark it as ours via
      // markProgScroll(300) — the window must span the 250ms sample interval plus scroll-event-
      // dispatch slack, since markProgScroll's default 120ms would lapse before the next tick
      // and let the heal's own scroll event run onScroll ungated (persisting the corrected
      // position and dropping any in-flight nav cursor). 300ms covers the next tick's potential
      // re-heal. Leave `pinned` true — we're correcting a pinned scroller back to where it
      // should be, not un-pinning it.
      markProgScroll(300);
      scroller.scrollTo({ top: scrollHeight });

      // NOTICE (always on — no longer ?dev-gated): sticky, with a "Copy trace" action. Fires
      // only on the first detection of an episode (the latch above); sustained drift holds.
      // console.warn is belt-and-suspenders: the WKWebView inspector is not visible by
      // default in the release build, so the sticky notice is the primary surface; the warn
      // surfaces if the inspector is ever opened.
      if (latch.shouldNotify) {
        lastDetectedAt = s.t;
        // Freeze the evidence at detection — the live buffer keeps rolling and
        // would otherwise emit post-episode samples by the time the sticky
        // notice's "Copy trace" runs.
        traceSnapshot = [...traceBuffer];
        console.warn("[pantoken] scroll drift (pinned, self-healed)", {
          gap,
          pinned,
          turnActive: s.turnActive,
        });
        store.chatNotice(
          `Scroll drift self-corrected (gap was ${Math.round(gap)}px)`,
          {
            durationMs: 0, // sticky — don't miss it
            action: { label: "Copy trace", run: copyTrace },
          },
        );
      }
    } else if (
      isUnpinnedDuringStreaming({ pinned, turnActive: store.turnActive, gap })
    ) {
      // Un-pinned-during-streaming notice — NO self-heal (never yank a reader who scrolled up).
      const unpinnedLatch = nextDriftState(unpinnedReported, gap, 0);
      unpinnedReported = unpinnedLatch.reported;
      if (unpinnedLatch.shouldNotify) {
        lastDetectedAt = s.t;
        traceSnapshot = [...traceBuffer];
        console.warn("[pantoken] viewport unpinned during streaming", {
          gap,
          pinned,
          turnActive: s.turnActive,
        });
        store.chatNotice(
          `Viewport not following — unpinned during streaming (gap ${Math.round(gap)}px)`,
          {
            durationMs: 0, // sticky — don't miss it
            action: { label: "Copy trace", run: copyTrace },
          },
        );
      }
    } else {
      // Neither condition holds: re-arm both latches for the next episode.
      driftReported = false;
      unpinnedReported = false;
    }
  }

  /** Format the ring buffer as a paste-able JSON trace and copy it to the clipboard via the
   *  store helper (which surfaces clipboard errors). Called by the notice's "Copy trace"
   *  action button (NoticeItem runs action.run() then onDismiss, so each episode yields
   *  exactly one trace copy). */
  async function copyTrace(): Promise<void> {
    const trace = formatTrace(traceSnapshot, {
      detectedAt: lastDetectedAt,
      ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
      viewport:
        typeof window !== "undefined"
          ? { w: window.innerWidth, h: window.innerHeight }
          : { w: 0, h: 0 },
    });
    await store.copyToClipboard(trace);
  }

  // Per-session reading position, persisted so switching back to a warmed session
  // restores where you were instead of always jumping to the bottom. Saved on scroll
  // (debounced), on session-switch-away, and on pagehide (mirrors the draft stash).
  let scrollPositions = $state<
    Record<string, { ratio: number; atBottom: boolean; at: number }>
  >(loadScrollPositions());
  let savePosTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSavePosition(): void {
    if (!scroller || !store.session.ref?.sessionId) return;
    const id = store.session.ref.sessionId;
    // Capture geometry NOW (at scroll time, on the session in view), not in the timer:
    // by the time the debounce fires the session may have swapped, and the scroller would
    // then read the new transcript's geometry against the old id (the exact mis-pairing
    // the switch-away save used to commit).
    const top = scroller.scrollTop;
    const h = scroller.scrollHeight;
    const c = scroller.clientHeight;
    // Debounce: a burst of streaming-delta scrolls coalesces into one write.
    clearTimeout(savePosTimer);
    savePosTimer = setTimeout(() => {
      scrollPositions = saveScrollPosition(scrollPositions, id, top, h, c);
      persistScrollPositions(scrollPositions);
    }, 200);
  }
  function savePositionNow(): void {
    // NOTE: callers that want to stash the session being LEFT at a switch must pass its id
    // explicitly — `store.session.ref` may already point at the NEW session by the time
    // this runs (the snapshot swap fires before the switch effect re-evaluates), so reading
    // it here would save the NEW session's id with the OLD session's scrollTop.
    savePositionFor(store.session.ref?.sessionId);
  }
  function savePositionFor(id: string | undefined): void {
    if (!scroller || !id) return;
    scrollPositions = saveScrollPosition(
      scrollPositions,
      id,
      scroller.scrollTop,
      scroller.scrollHeight,
      scroller.clientHeight,
    );
    persistScrollPositions(scrollPositions);
  }

  // The scrollTop the last onScroll saw — fed to nextPinned as prevTop. Component-scoped
  // (not per-session), so it's reset to 0 in the session-restore effect below at every
  // switch (a stale cross-session prevTop could spuriously un-pin a taller live session —
  // see scroll-follow.ts). Within a session it tracks the live scroll position.
  let lastScrollTop = 0;
  function onScroll() {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const gap = scroller.scrollHeight - top - scroller.clientHeight;
    // Direction-based pin (extracted, unit-tested in scroll-follow.test.ts): a programmatic
    // snap can land short (scrollHeight grows after its scrollTo as a collapsing work block /
    // streaming content settles), and the resulting scroll event would, under a gap-only
    // `pinned = gap < 80` rule, un-pin us — at which point the streaming-pin effect stops
    // following (it only scrolls while pinned), the next delta hits its `else if (grew)`
    // branch, marks the active session unread, and the "New messages ↓" pill appears. The
    // view never recovers until the next send/switch. Re-pinning only on a genuine upward
    // move that has left the bottom zone holds the pin through our own short-landing events
    // without a time window (which would also suppress a real reader scroll-up during
    // streaming, since progScrollUntil is always in the future while pinned).
    pinned = nextPinned({
      prevPinned: pinned,
      prevTop: lastScrollTop,
      top,
      gap,
    });
    lastScrollTop = top;
    // Reaching the bottom clears the active-session unread flag (you've seen it all).
    if (pinned) store.clearActiveUnread();
    // A user scroll (not one of ours) abandons prompt-stepping, so the next ⌘↑ re-anchors.
    if (Date.now() >= progScrollUntil) navIndex = null;
    // Persist where the user is reading (debounced). Skipped during our own programmatic
    // scrolls (prompt-stepping / settleScroll) — those set progScrollUntil, and saving a
    // transient mid-scroll position would restore to a spot the user never chose.
    if (Date.now() >= progScrollUntil) scheduleSavePosition();
    // Capture a scroll-geometry sample for the drift watcher (self-heal + trace). Called
    // AFTER the pin decision so the sample reflects the updated `pinned` state. User scrolls
    // land in the trace too, so the evidence shows the geometry leading up to a drift.
    sampleGeometry();
  }

  // Re-assert a scroll position as late layout changes the content height — images decode,
  // markstream finalizes blocks ASYNCHRONOUSLY (mermaid/infographic/code swaps change a
  // block's height over its own rAF passes after first paint), and a turn's "Worked for Ns"
  // block collapses. So `scrollHeight` measured once at switch/restore time is NOT the
  // settled height — a single scrollTo lands short (wrong spot, sometimes blank past the
  // content end).
  //
  // Keep a target (a `ratio`, or `undefined` = the live bottom) and re-apply it against the
  // CURRENT height whenever the content actually resizes. For the live-bottom follow
  // (settleRatio === undefined + pinned), the ResizeObserver re-asserts on EVERY height
  // change (#57); the "short window" applies only to the ratio-based restore (a transient
  // target for switch/restore, not an invariant to hold indefinitely). A ResizeObserver
  // fires only on real height changes, so static content is left alone.
  let settleRatio: number | undefined;
  let settleUntil = 0;
  let content = $state<HTMLDivElement>();
  let settleObserver: ResizeObserver | undefined;
  function applySettle(): void {
    if (!scroller) return;
    if (settleRatio === undefined) {
      // Live-bottom follow: only while still pinned, so a user scrolling up mid-window isn't
      // yanked back down (mirrors the streaming pin's `pinned` gate).
      if (!pinned) return;
      scroller.scrollTo({ top: scroller.scrollHeight });
    } else {
      scroller.scrollTo({ top: settleRatio * scroller.scrollHeight });
    }
  }
  /** Scroll to a target and hold it against late reflow for ~half a second. `ratio`
   *  undefined chases the live bottom; a number restores that proportional reading spot. */
  function settleScroll(ratio?: number): void {
    settleRatio = ratio;
    settleUntil = Date.now() + 500;
    // Mark these scrolls as ours so onScroll doesn't persist a transient mid-settle position.
    progScrollUntil = Date.now() + 500;
    applySettle();
  }

  // SAVE the leaving session's reading position BEFORE the swap. This MUST be an
  // `$effect.pre`: a regular `$effect` runs AFTER Svelte patches the DOM, by which point
  // the scroller already shows the INCOMING session's transcript — reading its geometry
  // there saved the leaving session's id against the wrong height (proven: it stored
  // demo-session's position using older-session's scrollHeight). A pre-effect fires before
  // the patch, while the scroller still shows the OLD transcript, so the geometry is right.
  let leavingId: string | undefined;
  $effect.pre(() => {
    const id = store.session.ref?.sessionId;
    if (id === leavingId) return;
    if (leavingId) savePositionFor(leavingId); // old DOM still mounted here
    leavingId = id;
  });

  // RESTORE on focus. Runs after the DOM patch (post-effect), then `settleScroll` chases
  // the settling layout. Policy (the owner's call): honour the saved position whatever the
  // session's live state — if you were at the live tail, return to the tail (even if it
  // grew while you were away); if you were scrolled up, return to that spot and let the
  // "new messages ↓" pill flag anything below. Only a session with NO saved position (or no
  // id) defaults to the bottom.
  // Keyed off the focused session id, not every snapshot: a same-session re-snapshot
  // mid-turn (rename, model change) must NOT yank the position out from under you.
  // Declared before the streaming-pin effect so it wins the flush — it rebaselines
  // `prevSize` first, then the pin reads the swap as a baseline (not growth), so the new
  // session is never spuriously flagged unread.
  let lastFocusId: string | undefined;
  $effect(() => {
    const id = store.session.ref?.sessionId;
    if (id === lastFocusId) return;
    lastFocusId = id;
    prevSize = -1;
    // Reset the onScroll direction baseline so the first chase frame's scroll event can't
    // spuriously un-pin a LIVE session. `lastScrollTop` is component-scoped (not
    // per-session), so without this it would carry the prior (taller) session's scrollTop;
    // switching to a taller live session whose first chase frame lands short (scrollHeight
    // grows under it on first render) would feed nextPinned a stale-higher prevTop and trip
    // `top < prevTop && gap >= 80` — un-pinning the live tail, the same stuck-pill symptom
    // this fix targets. With prevTop=0 the comparison can only re-pin or hold. (A scrolled-
    // up restore relies on `pinned` being set false explicitly below, not on this branch.)
    lastScrollTop = 0;
    navIndex = null;
    const plan = id ? planRestore(scrollPositions, id) : null;
    if (plan && plan !== "bottom") {
      // Scrolled-up reading spot: NOT pinned. settleScroll re-derives ratio * scrollHeight
      // each frame, so late reflow (markstream/images/work-block collapse) lands it right.
      pinned = false;
      settleScroll(plan.ratio);
    } else {
      // "bottom" (left at the tail) or null (never scrolled this session) — the live tail.
      pinned = true;
      store.clearActiveUnread();
      settleScroll();
    }
  });

  // keep pinned to the bottom while streaming, unless the user scrolled up
  $effect(() => {
    const size = contentSize;
    const grew = size > prevSize && prevSize !== -1;
    prevSize = size;
    if (pinned && scroller) {
      // Re-assert across a few frames, not a single scrollTo: without content-visibility,
      // rows lay out at true height and a prior turn's "Worked for Ns" block collapses
      // (animated) while the next turn streams — both make scrollHeight jump AFTER a one-shot
      // scrollTo runs, leaving it short. A short landing fires a scroll event read as a
      // scroll-away, unpinning us for good (the pin then stops, so it never recovers, and
      // every later delta false-flags the active session unread). settleScroll chases the
      // true bottom until it holds steady. (Same reason send/switch use it.)
      settleScroll();
      // Pinned + caught up: nothing is below the fold.
      store.clearActiveUnread();
    } else if (grew) {
      // New content landed while scrolled up — it's below the viewport. Flag the active
      // session unread (the "new messages ↓" signal); the pill below offers a jump.
      store.markActiveUnread();
    }
  });

  // Jump to the bottom whenever the user sends a prompt. Sending is a strong "show me
  // what I just said and the reply" signal, so we re-pin and scroll even if they'd
  // scrolled up reading scrollback — otherwise the just-sent bubble lands below the fold
  // behind the "New messages ↓" pill. Tracked via a store counter so each send re-fires;
  // initialized to the current value so a remount never scroll-jumps on its own.
  let lastSendN = store.promptSentN;
  $effect(() => {
    const n = store.promptSentN;
    if (n === lastSendN) return;
    lastSendN = n;
    pinned = true;
    navIndex = null;
    store.clearActiveUnread();
    // Re-assert across frames (not a single scrollTo): sending while scrolled up jumps
    // from the top, where content between may still be settling (images decoding,
    // markstream finalizing). A one-shot scroll can land short; settleScroll chases the
    // true bottom until it holds steady. (Same reason session-switch uses it.)
    settleScroll();
  });

  // Re-assert the pinned bottom the instant the composer resizes — autosize()
  // bumps composerResizeN after setting the textarea height, so this flushes
  // before paint (microtask), earlier than the viewportObserver. The
  // viewportObserver ResizeObserver (the async path) fires a frame later; on
  // WKWebView (overflow-anchor unreliable) that leaves a one-frame visible
  // dip (#64). This closes it before paint. Only while pinned: a reader
  // scrolled up must never be yanked back down.
  //
  // The entire action runs inside untrack() because settleScroll() →
  // applySettle() reads `pinned` (line 585), and scrollTo() fires onScroll
  // which writes `pinned` — even to the same value. Svelte 5 re-triggers
  // effects on any $state write (not just value changes), so reading `pinned`
  // inside this effect would loop to effect_update_depth_exceeded. untrack()
  // breaks the cycle: the effect reacts ONLY to composerResizeN.
  let lastResizeN = store.composerResizeN;
  $effect(() => {
    const n = store.composerResizeN;
    if (n === lastResizeN) return;
    lastResizeN = n;
    untrack(() => {
      if (pinned && scroller) {
        settleScroll();
        // Surface the proactive-path tick for e2e + devtools inspection —
        // proves the proactive re-assert fired (the async ResizeObserver
        // path doesn't touch this attribute).
        scroller.dataset.composerResizeN = String(n);
      }
    });
  });

  /** Jump to the newest content and clear the unread flag (the "new messages ↓" pill). */
  function scrollToBottom(): void {
    if (!scroller) return;
    // Ours — don't save transient mid-smooth-scroll positions (see settleScroll).
    progScrollUntil = Date.now() + 900;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    pinned = true;
    store.clearActiveUnread();
  }

  // True when the active session has content below the viewport (drives the pill).
  const showNewPill = $derived(!pinned && store.activeUnread);

  /** Where the first ⌘↑ lands when you're not already stepping. At the live tail it's the
   *  most recent prompt (re-read what you just asked) — a short final turn can leave that
   *  prompt mid-viewport instead of scrolled off the top, so the tail is detected from the
   *  scroll gap, not the top edge. Scrolled up, it's the most recent prompt above the
   *  viewport top: the jump stays relative to where you're reading and never yanks you
   *  back down to the tail. */
  function firstUpAnchor(prompts: NodeListOf<HTMLElement>): number {
    const last = prompts.length - 1;
    if (!scroller) return last;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (gap < 80) return last; // at/near the live bottom
    const sTop = scroller.getBoundingClientRect().top;
    for (let i = last; i >= 0; i--) {
      const top = prompts[i]?.getBoundingClientRect().top ?? Infinity;
      if (top < sTop - 1) return i;
    }
    return 0; // nothing scrolled off the top yet → the oldest prompt
  }

  /** Step the prompt cursor and scroll the target prompt to the top of the viewport
   *  (your message + the response below it). ⌘↑ (dir -1) walks toward older prompts; the
   *  first press anchors relative to where you're reading (see firstUpAnchor). ⌘↓ (dir +1)
   *  walks back toward newer ones, and stepping past the newest returns to the live
   *  bottom. */
  function stepPrompt(dir: -1 | 1): void {
    if (!scroller) return;
    const prompts = scroller.querySelectorAll<HTMLElement>(".row.user");
    const last = prompts.length - 1;
    if (dir === 1) {
      // ⌘↓: not stepping yet, or already at/past the newest prompt → return to the live
      // bottom (preserves the old "⌘↓ jumps to the tail from anywhere" gesture).
      if (navIndex === null || navIndex >= last) {
        navIndex = null;
        markProgScroll();
        scrollToBottom();
        return;
      }
      navIndex += 1;
    } else {
      if (last < 0) return; // no prompts to step to
      // ⌘↑: first press anchors to your reading spot; otherwise one older, clamped oldest.
      navIndex = navIndex === null ? firstUpAnchor(prompts) : Math.max(0, navIndex - 1);
    }
    const target = prompts[navIndex];
    if (!target) return;
    // INSTANT jump (no smooth animation) so the prompt is visible + settled within a
    // frame — well under the ≤300ms target. scrollIntoView({block:"start"}) clamps at
    // the max scroll offset (a prompt near the tail can't reach the top), so we
    // replicate that with Math.min. A brief flash on the row confirms the landing
    // (see flashPromptRow) so the instant jump isn't disorienting.
    const scTop = scroller.getBoundingClientRect().top;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const top = Math.min(
      target.getBoundingClientRect().top - scTop + scroller.scrollTop,
      max,
    );
    markProgScroll();
    scroller.scrollTo({ top });
    flashPromptRow(target);
  }

  // Brief highlight flash on a prompt row the user just jumped to, so an instant scroll
  // isn't disorienting. Removes any prior flash class first so rapid bursts (↑↑↑) reset
  // the animation cleanly rather than no-op'ing on an already-flashing row.
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function flashPromptRow(row: HTMLElement): void {
    row.classList.remove("nav-flash");
    // Force a reflow so the class removal takes effect before re-adding — without this
    // the browser coalesces the remove+add and the animation doesn't restart.
    void row.offsetWidth;
    row.classList.add("nav-flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => row.classList.remove("nav-flash"), 700);
  }

  // Global hotkey. Cmd/Ctrl modifier keeps it clear of the composer's type-to-focus
  // (which only grabs unmodified printable keys). Fires regardless of focus so it
  // works while reading scrollback.
  onMount(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === "ArrowUp") {
        e.preventDefault();
        // Shift = act on the last prompt (branch/re-edit); plain = step to the previous one.
        if (e.shiftKey) store.branchLastPrompt();
        else stepPrompt(-1);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "ArrowDown") {
        // ⌘↓ steps to the next prompt; past the newest it returns to the live bottom.
        e.preventDefault();
        stepPrompt(1);
      }
    }
    window.addEventListener("keydown", onKey);
    // Stash the reading position on tab-close/navigate-away so it restores next visit.
    // (Mirrors Composer's pagehide draft stash.) pagehide fires on bfcache eviction too,
    // so a return from the back-stack still has the position.
    const onPageHide = () => savePositionNow();
    window.addEventListener("pagehide", onPageHide);
    // Re-apply the active settle target whenever the content's height actually changes (late
    // markstream block enhancement, image decode, work-block collapse). The settle window
    // (settleUntil) now gates ONLY the ratio-based restore (a saved reading spot); the
    // live-bottom follow (settleRatio === undefined) re-asserts on EVERY height change while
    // pinned — image decode can happen seconds after send/switch/restore, long after the
    // 500ms window lapses. See settleScroll and the ResizeObserver callback below (#57).
    if (content && typeof ResizeObserver !== "undefined") {
      settleObserver = new ResizeObserver(() => {
        if (settleRatio === undefined) {
          // Live-bottom follow: re-assert the bottom on ANY content height change
          // while pinned — NOT just within the 500ms settle window. Image decode,
          // markstream reflow, and work-block collapse can happen seconds after
          // send/switch/restore, long after the settle window lapses. Without this,
          // a pinned viewport drifts short of the bottom as late layout shifts the
          // content height, leaving the final message behind the composer (#57).
          // markProgScroll covers the scroll-event dispatch so onScroll treats the
          // re-assert as ours (no transient position persistence, no nav-cursor drop).
          if (!pinned) return;
          markProgScroll(300);
          applySettle();
        } else if (Date.now() < settleUntil) {
          // Ratio-based restore (scrolled-up reading spot): only within the settle
          // window — the saved ratio is a transient target for switch/restore, not
          // an invariant to hold indefinitely.
          applySettle();
        }
      });
      settleObserver.observe(content);
    }
    // Re-assert the pinned invariant when the SCROLLER's own height changes (not just
    // when the content's height changes). The `.col` observer above fires on content
    // growth (markstream reflow, image decode, work-block collapse); this observer fires
    // on VIEWPORT (clientHeight) changes — the composer's textarea growing/shrinking via
    // autosize() as the user types, which shrinks the scroller's flex:1 height and opens
    // a gap at the bottom. Without this, a line-wrap keystroke opens a gap (the
    // composer grows by one line height, shrinking clientHeight, and nothing
    // closes the gap until the next content change or manual scroll) (#64).
    // The callback mirrors the `.col` observer's branches exactly; only the trigger
    // differs. ResizeObserver fires on border-box dimension changes, not on scrollTop
    // changes, so there's no feedback loop with the scrollTo it triggers.
    let viewportObserver: ResizeObserver | undefined;
    if (scroller && typeof ResizeObserver !== "undefined") {
      viewportObserver = new ResizeObserver(() => {
        if (settleRatio === undefined) {
          // Live-bottom follow: re-assert the bottom on viewport height changes
          // while pinned — the composer growing shrinks clientHeight, opening a gap.
          if (!pinned) return;
          markProgScroll(300);
          applySettle();
        } else if (Date.now() < settleUntil) {
          // Ratio-based restore (scrolled-up reading spot): only within the settle
          // window — the saved ratio is a transient target for switch/restore.
          applySettle();
        }
      });
      viewportObserver.observe(scroller);
    }
    // Drift watcher sampling interval: checks the pinned invariant on a steady cadence so a
    // drift is caught within a beat even without a scroll event (the gap in the follow logic
    // strands the viewport silently — see the watcher comment above). ~250ms is frequent
    // enough to catch a drift promptly, cheap (4 property reads). onScroll also samples, so
    // user scrolls land in the trace; this interval covers the no-input case.
    const driftTimer = setInterval(sampleGeometry, 250);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onPageHide);
      settleObserver?.disconnect();
      viewportObserver?.disconnect();
      clearInterval(driftTimer);
    };
  });
</script>

<div
  class="transcript-wrap"
  role="region"
  aria-label="Transcript"
  onmouseenter={() => (navHovered = true)}
  onmouseleave={() => (navHovered = false)}
  onfocusin={() => (navHovered = true)}
  onfocusout={(e) => {
    // Only hide if focus actually left the wrap (focusout bubbles from children).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      navHovered = false;
    }
  }}
>
<TranscriptSearch {scroller} />
<PullIndicator snap={pull.snap} refreshing={pull.refreshing} testid="ptr-transcript" />
<div
  class="scroller"
  class:touch={isTouch}
  bind:this={scroller}
  onscroll={onScroll}
  use:pullToRefresh={{
    enabled: isTouch && !pull.refreshing,
    onRefresh: pull.trigger,
    onChange: pull.onChange,
  }}
>
  <div class="col" bind:this={content}>
    <!-- Branch ("jump here") affordance — a git-fork glyph. Reused on user prompts and
         turn-final assistant paragraphs. -->
    {#snippet branchIcon()}
      <svg
        class="ico"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="6" cy="5" r="2.2" />
        <circle cx="6" cy="19" r="2.2" />
        <circle cx="18" cy="9" r="2.2" />
        <path d="M6 7.2v9.6" />
        <path d="M18 11.2v.6a4 4 0 0 1-4 4H6" />
      </svg>
    {/snippet}

    <!-- Copy affordance — swaps to a check on a successful copy. Shared by the user
         prompt footer and the turn-final assistant footer. -->
    {#snippet copyIcon(copied: boolean)}
      {#if copied}
        <svg
          class="ico"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      {:else}
        <svg
          class="ico"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      {/if}
    {/snippet}

    <!-- One transcript item, rendered the same whether it sits in a turn's collapsible
         work block or as the visible final response. -->
    {#snippet itemView(item: TranscriptItem)}
      {#if item.kind === "user"}
        <div class="row user" class:pending={item.delivery && item.delivery !== "rejected"} class:rejected={item.delivery === "rejected"}>
          {#if item.images && item.images.length > 0}
            <div class="user-images">
              {#each item.images as image, index (index)}
                <button
                  type="button"
                  class="att-img-btn"
                  onclick={() => imageViewer.open(item.images!, index)}
                  title="View image full screen (Enter)"
                  aria-label={`View attached image ${index + 1} full screen`}
                >
                  <img
                    class="att-img"
                    src="data:{image.mimeType};base64,{image.data}"
                    alt={`Attached image ${index + 1}`}
                    data-testid="sent-image"
                  />
                </button>
              {/each}
            </div>
          {/if}
          {#if item.text}
            {@const longPrompt = isLongPrompt(item.text)}
            {@const promptExpanded = expandedPrompts.has(item.id)}
            <div class="bubble">
              <!-- Clamp lives on an unpadded inner element: overflow clips at the
                   padding box, so clamping the bubble itself would bleed a sliver
                   of the 11th line into its bottom padding. -->
              <div class="btext" class:clamped={longPrompt && !promptExpanded}>
                {item.text}
              </div>
            </div>
            {#if longPrompt}
              <button
                class="prompt-expand"
                type="button"
                data-testid="prompt-expand"
                aria-expanded={promptExpanded}
                title={promptExpanded
                  ? "Collapse back to the preview"
                  : "Show the full prompt"}
                onclick={() => togglePromptExpanded(item.id)}
              >
                <Chevron open={promptExpanded} variant="disclosure" size={10} />
                {promptExpanded ? "Show less" : "Show full prompt"}
              </button>
            {/if}
          {/if}
          {#if item.references && item.references.length > 0}
            <!-- Subtle chips for the `@`-references the daemon resolved out of this
                 prompt (file/skill/subagent/model) — kind-badged, muted, name in mono.
                 Non-interactive (nothing to click through to yet); the tooltip names
                 the resolved kind + name for anyone who wants the detail. -->
            <div class="ref-chips">
              {#each item.references as ref (ref.kind + ":" + ref.name)}
                <span class="ref-chip" title={`Resolved reference: ${ref.kind} ${ref.name}`}>
                  <span class="ref-kind">{ref.kind}</span><span class="ref-name">{ref.name}</span>
                </span>
              {/each}
            </div>
          {/if}
          {#if item.delivery}
            <div class="delivery {item.delivery}" role={item.delivery === "rejected" ? "alert" : "status"}>
              <span>
                {item.delivery === "sending"
                  ? "Sending…"
                  : item.delivery === "connecting"
                    ? "Sending when reconnected…"
                    : item.delivery === "offline"
                      ? "Queued offline"
                      : `Not sent${item.deliveryError ? ` — ${item.deliveryError}` : ""}`}
              </span>
              {#if item.delivery === "rejected"}
                <button
                  type="button"
                  title="Try sending this prompt again"
                  onclick={() => store.retryPending(item.id)}>Retry</button
                >
                <button
                  type="button"
                  title="Return this prompt and its images to the composer"
                  onclick={() => store.editPending(item.id)}>Edit</button
                >
              {/if}
            </div>
          {/if}
          {#if (item.text || (item.images && item.images.length > 0)) && (item.entryId || (item.ts && !item.delivery))}
            <div
              class="umeta"
              class:armed={item.entryId === armedRewindId}
            >
              {#if item.text}
                <button
                  class="copy"
                  class:copied={copiedId === item.id}
                  type="button"
                  onclick={(e) => {
                    copyText(item.id, item.text);
                    e.currentTarget.blur();
                  }}
                  title={copiedId === item.id ? "Copied" : "Copy message"}
                  aria-label="Copy message"
                >
                  {@render copyIcon(copiedId === item.id)}
                </button>
              {/if}
              {#if item.entryId}
                <button
                  class="branch"
                  class:armed={armedRewindId === item.entryId}
                  type="button"
                  onclick={(e) => {
                    if (item.entryId) confirmRewind(item.entryId);
                    e.currentTarget.blur();
                  }}
                  title={armedRewindId === item.entryId
                    ? "Click again to rewind — this drops this prompt and everything after (destructive)"
                    : item.entryId === lastUserEntryId
                      ? "Rewind to this prompt — edit & resend (⌘⇧↑)"
                      : "Rewind to this prompt — edit & resend"}
                  aria-label="Rewind to this prompt"
                >
                  {@render branchIcon()}
                </button>
              {/if}
              {#if item.ts}
                <time class="ts" datetime={item.ts} title={exactTime(item.ts)}>{relativeTime(item.ts)}</time>
              {/if}
            </div>
          {/if}
        </div>
      {:else if item.kind === "assistant"}
        <div class="row assistant">
          <!-- Thinking blocks: when hideThinking is off, all render (collapsed by
               default, expandable via ThinkingBlock's header button). When on,
               only the active thinking tail — the last item, still streaming
               reasoning with no text — renders as a collapsed ThinkingBlock.
               All superseded thinking is dropped entirely. -->
          {#if item.thinking && (visibleThinkingIds === null || visibleThinkingIds.has(item.id))}
            <ThinkingBlock text={item.thinking} streaming={item.streaming && !item.text} />
          {/if}
          {#if item.text}
            <Markdown
              content={item.text}
              final={!(item.streaming && store.turnActive)}
              fade={item.streaming && store.turnActive}
            />
          {/if}
          <!-- "Still working" lives in the bottom WorkingIndicator now, not as an
               inline caret on the streaming paragraph. The copy + timestamp footer
               shows ONLY on the turn-final paragraph (turnText holds its id), and only
               once the turn settles — turnText already excludes live turns, so a
               mid-turn paragraph followed by tool calls stays bare. -->
          {#if turnText.has(item.id)}
            <div
              class="meta"
              class:armed={item.entryId === armedRewindId}
            >
              <button
                class="copy"
                class:copied={copiedId === item.id}
                type="button"
                onclick={(e) => {
                  // Copy the WHOLE turn's assistant text (all paragraphs joined), not
                  // just this final block.
                  copyText(item.id, turnText.get(item.id) ?? item.text);
                  // Drop focus so a mouse click doesn't leave the button pinned
                  // visible via :focus-visible after the pointer leaves the row.
                  e.currentTarget.blur();
                }}
                title={copiedId === item.id ? "Copied" : "Copy message"}
                aria-label="Copy message"
              >
                {@render copyIcon(copiedId === item.id)}
              </button>
              {#if item.entryId && item.entryId !== leafEntryId}
                <button
                  class="branch"
                  class:armed={armedRewindId === item.entryId}
                  type="button"
                  onclick={(e) => {
                    if (item.entryId) confirmRewind(item.entryId);
                    e.currentTarget.blur();
                  }}
                  title={armedRewindId === item.entryId
                    ? "Click again to rewind — this drops everything after (destructive)"
                    : "Rewind from here — continue on a new path"}
                  aria-label="Rewind from here"
                >
                  {@render branchIcon()}
                </button>
              {/if}
              {#if item.ts}
                <time class="ts" datetime={item.ts} title={exactTime(item.ts)}>{relativeTime(item.ts)}</time>
              {/if}
            </div>
          {/if}
        </div>
      {:else if item.kind === "tool" && item.name === "answer"}
        <!-- The user's Q&A answers, surfaced visibly instead of buried in a tool card. -->
        <QnaResult {item} />
      {:else if item.kind === "tool"}
        <ToolCard {item} />
      {:else if item.kind === "inject"}
        <!-- An extension-injected custom message (e.g. a journal nudge). `display:false`
             ones are turn-boundary markers only — render nothing. The rest show a tiny
             collapsed pill that expands to the (de-wrapped) note text. -->
        {#if item.display}
          <div class="row inject">
            <button
              class="inject-pill"
              class:open={injectOpen[item.id] ?? false}
              type="button"
              onclick={() => toggleInject(item.id)}
              aria-expanded={injectOpen[item.id] ?? false}
              title={(injectOpen[item.id] ?? false)
                ? `Collapse the injected ${item.customType} note`
                : `Expand the injected ${item.customType} note`}
            >
              <Chevron open={injectOpen[item.id] ?? false} size={9} strokeWidth={2} />
              <span class="inject-label">{item.customType}</span>
            </button>
            {#if injectOpen[item.id] ?? false}
              <div class="inject-body" transition:reveal={{ duration: 150 }}>{injectText(item)}</div>
            {/if}
          </div>
        {/if}
      {:else if item.kind === "notice"}
        <div class="row notice {item.level}">
          <span class="ico">{item.level === "error" ? "✕" : item.level === "warning" ? "⚠" : "ℹ"}</span>
          <span class="ntext">{item.text}</span>
          {#if item.level === "error"}
            <span class="nactions">
              <button
                class="naction"
                title="Send a continue signal to resume the turn"
                onclick={() => store.resumeTurn()}>Resume</button
              >
              <button
                class="naction"
                title="Copy the error message"
                onclick={() => copyText(item.id, item.text)}
                >{copiedId === item.id ? "Copied" : "Copy"}</button
              >
            </span>
          {/if}
        </div>
      {/if}
    {/snippet}

    {#each turns as turn (turn.id)}
        {#if turn.user}
          {@render itemView(turn.user)}
        {/if}
        <!-- Lanes render the turn body in chronological order: each collapsible work run
             folds behind its own "Worked for Ns" header, while pinned items (the answer
             Q&A, screenshots) stay in place between runs so they don't float to the
             bottom as later work streams in. -->
        {#each turn.lanes as lane (lane.id)}
        {#if lane.kind === "pinned"}
          {@render itemView(lane.item)}
        {:else if lane.collapsible}
          <!-- Codex-style working block: the run's tools + intermediate narration
               collapse behind a "Worked for Ns" header only once the turn settles. -->
          <div class="turn-work" class:open={workShown(lane.id, turn)}>
            <button
              class="work-head"
              data-testid="work-toggle"
              onclick={() => toggleWork(lane.id, turn)}
              aria-expanded={workShown(lane.id, turn)}
            >
              <Chevron open={workShown(lane.id, turn)} size={10} />
              <span class="work-label">{turnDone(turn) ? workedLabel(lane) : "Working…"}</span>
            </button>
            {#if workShown(lane.id, turn)}
              <!-- Slide the working steps closed instead of snapping: when a turn finishes
                   its closing paragraph the early work autocollapses, and an instant removal
                   jumped the content below. A short height/opacity glide smooths it (and the
                   manual toggle). Intro is skipped on initial mount, so settled turns on load
                   don't animate. -->
              <div
                class="work-body"
                data-testid="work-body"
                transition:reveal={{ duration: 180, easing: cubicOut }}
              >
                {#each lane.items as it (it.id)}
                  {@render itemView(it)}
                {/each}
                <CollapseFooter onCollapse={() => toggleWork(lane.id, turn)} />
              </div>
            {/if}
          </div>
        {:else}
          {#each lane.items as it (it.id)}
            {@render itemView(it)}
          {/each}
        {/if}
      {/each}
      {#each turn.response as it (it.id)}
        {@render itemView(it)}
      {/each}
    {/each}
    {#if turns.length === 0}
      <div class="empty">No messages yet. Say something below to start a turn.</div>
    {/if}
  </div>
</div>
{#if store.openingSession}
  <div class="opening-overlay" data-testid="opening-session-placeholder">
    <span class="opening-mark" aria-hidden="true">
      <CoinMark size={11} strokeWidth={3} />
      <span class="ring"><span class="dot"></span></span>
    </span>
    <span class="opening-label">Opening session…</span>
  </div>
{/if}
{#if showNewPill}
  <button
    class="new-pill"
    data-testid="new-messages-pill"
    title="Jump to the newest messages (⌘↓) · ⌘↑/⌘↓ step through your prompts"
    aria-label="New messages below — jump to newest"
    onclick={scrollToBottom}
  >
    New messages ↓
  </button>
{/if}
<div
  class="prompt-nav"
  class:visible={navHovered || navIndex !== null}
  role="group"
  aria-label="Prompt navigation"
>
  <button
    class="prompt-nav-btn"
    data-testid="prompt-nav-up"
    type="button"
    title="Previous prompt (⌘↑)"
    aria-label="Previous prompt"
    onclick={() => stepPrompt(-1)}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      width="18"
      height="18"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  </button>
  <button
    class="prompt-nav-btn"
    data-testid="prompt-nav-down"
    type="button"
    title="Next prompt (⌘↓)"
    aria-label="Next prompt"
    onclick={() => stepPrompt(1)}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      width="18"
      height="18"
    >
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  </button>
</div>
</div>

<style>
  .transcript-wrap {
    /* --maxw / --maxw-wide are inherited from .chat (App.svelte). */
    position: relative;
    isolation: isolate;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .scroller {
    position: relative;
    z-index: 0;
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  /* "New messages ↓" pill — floats over the transcript when content lands below the
     fold while scrolled up. Centered near the bottom, above the composer. */
  .new-pill {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12.5px;
    font-weight: 550;
    color: var(--highlight-text);
    background: var(--highlight);
    border: none;
    border-radius: 999px;
    padding: 7px 14px;
    box-shadow: var(--shadow-pop);
    cursor: pointer;
    animation: pillIn 0.16s ease;
  }
  .new-pill:hover {
    background: var(--highlight-hover);
  }
  @keyframes pillIn {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .new-pill {
      animation: none;
    }
    .row.user.nav-flash {
      animation: none;
    }
    .prompt-nav,
    .prompt-nav-btn {
      transition: none;
    }
  }
  /* Floating prev/next-prompt nav — a discoverability affordance for the ⌘↑/⌘↓
     prompt-stepping. Fades in on transcript hover/focus; always visible on touch
     (pointer: coarse) where hover doesn't apply. Always mounted (opacity toggle)
     so the fade-out works symmetrically with the fade-in. */
  .prompt-nav {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 4px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.16s ease;
  }
  .prompt-nav.visible {
    opacity: 1;
    pointer-events: auto;
  }
  .prompt-nav-btn {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: var(--surface);
    color: var(--text-muted);
    cursor: pointer;
    box-shadow: var(--shadow-pop);
    opacity: 0.75;
    transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
  }
  .prompt-nav-btn:hover {
    opacity: 1;
    color: var(--accent-text);
    background: var(--accent);
  }
  /* Touch devices: always visible (no hover state) + 44px touch targets. */
  @media (pointer: coarse) {
    .prompt-nav {
      opacity: 1;
      pointer-events: auto;
    }
    .prompt-nav-btn {
      min-width: 44px;
      min-height: 44px;
    }
  }
  .col {
    /* Wide track so fenced code / tables can break out into the desktop gutter. Every
       turn is re-capped to --maxw and centered below, so prose + chrome sit exactly where
       a plain --maxw column would — only code opts wider. */
    max-width: var(--maxw-wide);
    margin: 0 auto;
    padding: 22px 44px 28px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    /* Per-device reading-size knob (lib/font-scale.ts; ⌘=/⌘-/⌘0). Scales the transcript
       only — header / composer / sidebar keep the body size. */
    font-size: calc(16.5px * var(--font-scale, 1));
  }
  /* Each turn sits at the reading measure, centered (:global so child-component roots —
     tool cards, the markdown body — are capped too, not just Transcript's own elements). */
  .col > :global(*) {
    width: min(100%, var(--maxw));
    min-width: 0;
  }
  /* …except an assistant turn, which may stretch to the wide track so its fenced code and
     tables can break out (handled below). Its text still stays at the measure. */
  .col > .row.assistant {
    width: min(100%, var(--maxw-wide));
  }
  /* Assistant internals — thinking block + copy/timestamp footer — stay at the measure,
     centered, so they align with the prose left edge. */
  .row.assistant > :global(*) {
    max-width: var(--maxw);
    margin-inline: auto;
  }
  /* The thinking block must fill its measure like .md-host fills the wide row, not
     shrink-wrap to its "Thinking…" label. Capped at --maxw (not --maxw-wide) and centered
     so its left edge lines up with the prose left edge instead of the wide row's edge —
     `max-width: none` here would stretch it under the full --maxw-wide row, landing its
     border ~200px left of the prose. */
  .row.assistant > :global(.think) {
    width: 100%;
    min-width: 0;
    max-width: var(--maxw);
    margin-inline: auto;
  }
  /* The markdown body fills the wide row so its fenced code / tables can break out; the
     leaf `.node-content > *` rules below re-cap prose at the measure. `<Markdown>` wraps
     markstream in a `.md-host` div (it hosts the copy-code action), so THAT wrapper — the
     real direct child of the row — is what must fill the row. Targeting the inner
     `.markstream-svelte.markdown-renderer` (a grandchild) misses, and the body then
     shrink-wraps to its widest block — which on a narrow viewport overflows the row
     instead of letting a wide table scroll. `min-width: 0` stops this flex item blowing
     out to a wide table's min-content. */
  .row.assistant > :global(.md-host) {
    width: 100%;
    min-width: 0;
    max-width: none;
    margin-inline: 0;
  }
  .row.assistant :global(.node-slot),
  .row.assistant :global(.node-content) {
    width: auto;
    max-width: none;
    margin-inline: 0;
  }
  .row.assistant :global(.node-content) > :global(*) {
    max-width: var(--maxw);
    margin-inline: auto;
  }
  /* Allow — not force — fenced code and tables to break out: sized to content up to the
     wide ceiling, left-aligned with the prose and extending into the right gutter; a short
     snippet stays narrow. Past the ceiling they scroll (markstream sets overflow-x: auto). */
  .row.assistant :global(.node-content) > :global(pre),
  .row.assistant :global(.node-content) > :global(table) {
    width: fit-content;
    /* Cap at the space from the prose's left edge to the row's right edge, so a long
       unbreakable line scrolls (overflow-x) instead of overflowing the viewport — NOT a
       fixed --maxw-wide, which fit-content would blow past on an unbreakable min-content.
       The row is already ≤ --maxw-wide, so this also honours that ceiling. */
    max-width: calc(100% - max(0px, (100% - var(--maxw)) / 2));
    margin-inline: max(0px, calc((100% - var(--maxw)) / 2)) 0;
  }
  .row {
    display: flex;
    flex-direction: column;
  }
  .row.user {
    align-items: flex-end;
  }
  .user .bubble {
    background: var(--prompt-bg);
    border: 1px solid var(--border-strong);
    padding: 10px 14px;
    border-radius: var(--radius);
    border-bottom-right-radius: 4px;
    max-width: 86%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Long-prompt preview: clamp to ~10 rendered lines (line-clamp also counts
     soft-wrapped lines, which the newline heuristic can't see). */
  .user .btext.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 10;
    line-clamp: 10;
    overflow: hidden;
  }
  .prompt-expand {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    padding: 2px 8px;
    background: transparent;
    border: none;
    border-radius: 999px;
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .prompt-expand:hover {
    color: var(--text);
    background: var(--surface-sunken);
  }
  /* The chevron inherits a faint currentColor; brighten with the label on hover. */
  .prompt-expand:hover :global(.chevron) {
    opacity: 1;
  }
  /* Resolution-feedback chips: subtle pills under the sent prompt naming the
     `@`-references the daemon resolved. Right-aligned like the bubble (the row is
     flex-end); non-interactive, so no hover/focus treatment — just a tooltip. The
     `.ref-kind` label mirrors the look AtMenu's front `kind:` prefix used to share
     when it had a `.kind-badge` (a separate Svelte component's scoped styles can't
     be shared directly, so this mirrors the look rather than the rule). */
  .ref-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
    margin-top: 4px;
    max-width: 86%;
  }
  .ref-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 8px 1px 3px;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    line-height: 1.6;
  }
  .ref-kind {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
  }
  .ref-name {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Brief accent flash on a prompt row the user jumped to via ⌘↑/⌘↓, confirming the
     landing target after an instant (non-animated) scroll. The flash is on the row, not
     the bubble, so it reads as a location marker rather than a state change. */
  .row.user.nav-flash {
    animation: nav-flash 0.6s ease-out;
  }
  @keyframes nav-flash {
    0% {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    100% {
      background: transparent;
    }
  }
  /* Echo of the image attachments the user sent with this prompt. Right-aligned
     thumbnails under the bubble (the row is flex-end); the same data-URL the
     composer sent, so no extra fetch. */
  .user-images {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 180px));
    gap: 6px;
    max-width: min(86%, 366px);
    margin-bottom: 5px;
  }
  /* The thumbnail is a button so it's keyboard-reachable and opens the full-screen
     viewer; it carries no chrome of its own — the bordered look lives on the inner img. */
  .att-img-btn {
    display: block;
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
    border-radius: var(--radius-sm);
  }
  .att-img-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .att-img {
    display: block;
    width: 100%;
    max-height: 240px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    object-fit: cover;
    transition: border-color 0.12s;
  }
  .att-img-btn:hover .att-img {
    border-color: var(--accent);
  }
  /* A lone attachment spans both grid columns and caps wider than a paired thumbnail. */
  .att-img-btn:only-child {
    grid-column: 1 / -1;
    max-width: 300px;
  }
  .assistant {
    gap: 5px;
  }
  /* The complete turn footer (actions + time) follows one visibility rule. Desktop
     reveals it on hover/focus; touch pins the whole group visible below. */
  .ts {
    font-size: 11px;
    line-height: 1;
    color: var(--text-faint);
    user-select: none;
    cursor: default;
  }
  .row.user .ts {
    margin-top: 4px;
    padding-right: 2px;
  }
  /* assistant footer: copy button + timestamp, revealed on row hover */
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: -2px;
    min-height: 18px;
    /* Fill the measure so the footer's flex-start content sits at the prose's left
       edge. Without an explicit width the auto cross-axis margins inherited from
       `.row.assistant > *` suppress flex stretch, shrink-wrapping `.meta` and then
       centering that small box in the wide row. */
    width: 100%;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }
  .copy {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    padding: 4px;
    border-radius: var(--radius-xs);
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .copy .ico {
    display: block;
    width: 13px;
    height: 13px;
  }
  .assistant:hover .meta,
  .assistant:focus-within .meta,
  .row.user:hover .umeta,
  .row.user:focus-within .umeta {
    opacity: 1;
    pointer-events: auto;
  }
  /* Touch devices have no hover; pin the complete footer visible. */
  .scroller.touch .meta,
  .scroller.touch .umeta,
  .meta.armed {
    opacity: 1;
    pointer-events: auto;
  }
  .copy:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  /* brief post-copy confirmation — the check icon picks up the accent tint */
  .copy.copied {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .copy:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* user prompt footer: branch button + timestamp, right-aligned under the bubble */
  .row.user .umeta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    opacity: 0;
    /* The footer owns reserved layout below the bubble, so keep it hit-testable while
       transparent: entering an action can then establish `.row.user:hover` and reveal
       it before pointerdown. Disabling hit testing here makes the parent row win the
       target check, leaving a visually hover-revealed action impossible to click. */
    pointer-events: auto;
    position: relative;
    z-index: 1;
    transition: opacity 0.12s ease;
  }
  .row.user .umeta .ts {
    margin-top: 0;
  }
  /* The parent footer owns visibility, so a destructive rewind stays discoverable after
     the pointer leaves during its click-twice confirmation window. This rule follows the
     user-footer base rule intentionally: its higher specificity wins the hidden default. */
  .row.user .umeta.armed {
    opacity: 1;
    pointer-events: auto;
  }
  /* branch ("jump here") button — same quiet, hover-revealed treatment as copy */
  .branch {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    padding: 4px;
    border-radius: var(--radius-xs);
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .branch .ico {
    display: block;
    width: 13px;
    height: 13px;
  }
  .branch:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .branch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* Armed state (click-twice confirm): shift to destructive red so the operator sees
     the button is primed and a second click will fire the irreversible rewind. */
  .branch.armed {
    color: var(--danger);
    border-color: var(--danger);
    opacity: 1;
  }
  .branch.armed:hover {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
  /* Touch devices have no hover — keep every footer action reachable with a 44px target. */
  @media (max-width: 859px) {
    .scroller.touch .meta,
    .scroller.touch .umeta {
      opacity: 1;
      pointer-events: auto;
    }
    .copy,
    .branch {
      width: 44px;
      height: 44px;
      padding: 0;
    }
    /* Sidebars are overlay drawers here — no gutter to hold against them. */
    .col {
      padding-inline: 18px;
    }
  }
  .notice {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
    font-size: 13px;
    color: var(--text-muted);
    align-self: center;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
  }
  .notice .ntext {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .notice.error {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .notice.warning {
    color: var(--warning);
    background: var(--warning-soft);
    border-color: color-mix(in srgb, var(--warning) 30%, transparent);
  }
  .row.user.pending .bubble {
    opacity: 0.72;
  }
  .row.user.pending .user-images {
    opacity: 0.72;
  }
  .row.user.rejected .bubble {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }
  .row.user.rejected .att-img {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }
  .delivery {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .delivery.rejected {
    color: var(--danger);
  }
  .delivery button {
    border: 0;
    border-radius: 999px;
    padding: 2px 7px;
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .nactions {
    display: inline-flex;
    gap: 6px;
    margin-left: 2px;
  }
  .naction {
    font-size: 12px;
    color: inherit;
    background: color-mix(in srgb, currentColor 12%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 999px;
    padding: 2px 9px;
    cursor: pointer;
  }
  .naction:hover {
    background: color-mix(in srgb, currentColor 20%, transparent);
  }
  .empty {
    color: var(--text-faint);
    text-align: center;
    padding: 60px 0;
    font-size: 14px;
  }

  /* ── Opening-session overlay (existing-session switch, pre-seed) ── */
  /* Positioned over the scroller so it doesn't affect scroll geometry — the
     old transcript stays in the DOM (hidden behind the overlay) so scroll
     restoration measures the right height when the seed swaps in. */
  .opening-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-faint);
    font-size: 14px;
    pointer-events: none;
    background: var(--surface);
  }
  .opening-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    width: 18px;
    height: 18px;
  }
  .opening-mark .ring {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }
  .opening-mark .ring .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .opening-mark .ring {
    animation: orbit 1.1s linear infinite;
  }
  @keyframes orbit {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .opening-mark .ring {
      animation: none;
    }
    .opening-mark .dot {
      display: none;
    }
  }
  .row.inject {
    align-items: flex-start;
    gap: 5px;
  }
  .inject-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    background: transparent;
    border: none;
    padding: 1px 0;
    color: var(--text-faint);
    font-size: 11.5px;
    font-weight: 550;
    letter-spacing: 0.02em;
    cursor: pointer;
  }
  .inject-pill:hover {
    color: var(--text-muted);
  }
  .inject-pill:hover :global(.chevron),
  .inject-pill:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  .inject-label {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .inject-body {
    margin-top: 5px;
    margin-left: 14px;
    padding-left: 11px;
    border-left: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 86%;
  }

  /* ── Per-turn "Worked for Ns" block (Codex-style collapsed working section) ── */
  .work-head {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: none;
    padding: 2px 0;
    color: var(--text-muted);
    font-size: 12.5px;
    cursor: pointer;
  }
  .work-head:hover {
    color: var(--text);
  }
  .work-head:hover :global(.chevron) {
    color: var(--text-muted);
  }
  .work-head .work-label {
    font-weight: 550;
  }
  /* When expanded, the work items indent under the header with a thread line. */
  .work-body {
    margin-top: 10px;
    margin-left: 5px;
    padding-left: 13px;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* Consecutive tool cards sit flush, with no dead-space gap between them — the flex
     `gap` on their container is for spacing a tool against neighboring narration/thinking,
     but between two tool cards in a row it just made the hover-highlighted header
     background look like a floating stripe. A negative margin on the second (and any
     later) adjacent `.tool` cancels exactly that gap, without touching tool-to-prose or
     tool-to-thinking spacing (these selectors only match when BOTH sides are `.tool`).
     Two containers, because a turn's tools live in different parents depending on state:
       • `.work-body` (gap 8px) — a SETTLED turn, tools folded behind "Worked for Ns".
       • `.col` (gap 18px) — a LIVE turn: groupTurns forces its work lane non-collapsible
         while in flight, so the tools render inline as direct transcript children. This
         is the case the freshly-loaded / streaming screenshot shows. */
  .work-body > :global(.tool) + :global(.tool) {
    margin-top: -8px;
  }
  .col > :global(.tool) + :global(.tool) {
    margin-top: -18px;
  }
</style>
