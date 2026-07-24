// The pinned-to-bottom decision for the transcript scroller, extracted pure so the
// rule is unit-testable in isolation (no DOM, no store, no Svelte effect timing).
//
// INPUT-GATING: the pin is turned OFF only by explicit user-input events — wheel,
// touch drag, keyboard scroll keys, prompt-nav buttons, and scrollbar drag.
// Programmatic scrolls (ResizeObserver re-asserts, settleScroll, find-in-transcript,
// content-shrink clamps) structurally cannot false-un-pin because they never fire
// user-input events.
//
// THE GATE: `userScrolling` is set true by blessed-input event handlers on `.scroller`
// (onwheel, ontouchstart, onkeydown for scroll keys) and cleared after scrolling
// settles (~150ms). `pointerDownOnScroller` covers the scrollbar-drag case (no
// wheel/touch event fires, but the pointer is down on the scrollbar and a
// scroll follows). It's gated on `e.target === scroller` so content clicks
// (which target child elements) don't set it. Both are OR'd: either is a
// user-initiated scroll. The un-pin decision then requires BOTH a
// user-input signal AND a genuine upward move that has left the 80px bottom zone.
//
// WHY `&& top < prevTop && gap >= 80` ON THE UNPIN (not just `userScrolling`): two
// guards —
//   1. Jitter: a 10px upward nudge that stays within the bottom zone would otherwise
//      un-pin, twitchy against the gap-only rule's deliberate 80px tolerance.
//   2. Session switch: `prevTop` is component-scoped (not per-session), so it's stale
//      across a switch. The `&& gap >= 80` guard closes the switch-to-a-SHORTER-live-
//      session case (landing at its bottom clamps `gap < 80` → re-pin regardless of the
//      stale prevTop). The switch-to-a-TALLER-live-session case is closed in the WIRING
//      instead: Transcript.svelte's session-restore effect resets `lastScrollTop = 0` at
//      the switch, so the cross-session comparison can only re-pin or hold, never
//      spuriously un-pin.
//
// Re-pin is movement-based and unambiguous: reaching the bottom zone (`gap < 80`) via
// any cause → re-pin. Programmatic scrolls that reach the bottom (snapToBottom,
// ResizeObserver re-assert) correctly re-pin; user scrolls that return to the bottom
// correctly re-pin.

export type PinnedInput = {
  /** Whether the viewport was pinned before this scroll event. */
  prevPinned: boolean;
  /** `scrollTop` seen by the PREVIOUS onScroll call (component-scoped, not per-session). */
  prevTop: number;
  /** `scrollTop` for THIS scroll event. */
  top: number;
  /** `scrollHeight - scrollTop - clientHeight` for THIS scroll event. */
  gap: number;
  /** Whether a user-input event (wheel/touch/keyboard) marked scrolling recently. */
  userScrolling: boolean;
  /** Whether the pointer is down on the scroller (scrollbar drag — no wheel/touch fires). */
  pointerDownOnScroller: boolean;
};

/** Whether the transcript should stay stuck to the live bottom after a scroll event.
 *
 *  - Re-pin whenever the viewport reaches the bottom zone (from any direction, any cause).
 *  - Un-pin only on a genuine user-input scroll-up that has left the 80px bottom zone
 *    (`userScrolling || pointerDownOnScroller`) AND moved scrollTop upward.
 *  - Otherwise (programmatic scroll, content-shrink, moved down or held but still short
 *    of the bottom) hold the prior pin so the streaming-pin effect keeps following. */
export function nextPinned({
  prevPinned,
  prevTop,
  top,
  gap,
  userScrolling,
  pointerDownOnScroller,
}: PinnedInput): boolean {
  if (gap < 80) return true;
  if ((userScrolling || pointerDownOnScroller) && top < prevTop && gap >= 80) return false;
  return prevPinned;
}
