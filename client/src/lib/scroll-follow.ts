// The pinned-to-bottom decision for the transcript scroller, extracted pure so the
// rule is unit-testable in isolation (no DOM, no store, no Svelte effect timing).
//
// WHY DIRECTION, NOT GAP ALONE: a programmatic `snapToBottom` chase frame can land short
// of the true bottom — `scrollHeight` grows AFTER the chase's `scrollTo` as a collapsing
// "Worked for Ns" block animates / streaming content settles (see commit uttrywkuwpns),
// and the resulting `scroll` event would, under the old `pinned = gap < 80` rule, read
// `gap >= 80` and un-pin us. Once un-pinned, the streaming-pin effect stops following (it
// only scrolls while pinned), the next content delta hits its `else if (grew)` branch,
// marks the active session unread, and the "New messages ↓" pill appears — and the view
// never recovers until the next send/switch. (This reproduces on iOS Safari, whose
// `overflow-anchor` is unreliable; desktop Chrome's anchoring masks it by keeping `gap`
// near 0 on growth.)
//
// The discriminator: a programmatic snap only ever moves the viewport DOWN — `scrollTop`
// rises toward the max or holds. A user scrolling UP lowers `scrollTop`. Content growth
// (the iOS failure) opens a gap WITHOUT lowering `scrollTop`. So a `scrollTop` DECREASE
// that leaves the bottom zone is the one reliable signal the user moved away; a gap alone
// is ambiguous (could be our own short-landing chase racing a late reflow).
//
// WHY `&& gap >= 80` ON THE UNPIN (not just `top < prevTop`): two holes a bare direction
// rule opens, both closed by also requiring the viewport to have actually left the 80px
// bottom zone —
//   1. Jitter: a 10px upward nudge that stays within the bottom zone would otherwise
//      un-pin, twitchy against the gap-only rule's deliberate 80px tolerance.
//   2. Session switch: `prevTop` is component-scoped (not per-session), so it's stale
//      across a switch. The `&& gap >= 80` guard closes the switch-to-a-SHORTER-live-
//      session case (landing at its bottom clamps `gap < 80` → re-pin regardless of the
//      stale prevTop). It does NOT close the switch-to-a-TALLER-live-session case: a stale
//      higher prevTop with a first chase frame that lands short (`gap >= 80`) would trip
//      `top < prevTop` and spuriously un-pin a live tail — the same stuck-pill symptom.
//      That's closed in the WIRING instead: Transcript.svelte's session-restore effect
//      resets `lastScrollTop = 0` at the switch, so the cross-session comparison can only
//      re-pin or hold, never spuriously un-pin. (A scrolled-up restore relies on `pinned`
//      being set false explicitly by that effect, not on this unpin branch.)
//
// This rule needs no time window (a `progScrollUntil` gate would also suppress a real
// reader scroll-up during streaming, since that window is always in the future while
// pinned — breaking the scroll-up-to-read-scrollback affordance).

export type PinnedInput = {
  /** Whether the viewport was pinned before this scroll event. */
  prevPinned: boolean;
  /** `scrollTop` seen by the PREVIOUS onScroll call (component-scoped, not per-session). */
  prevTop: number;
  /** `scrollTop` for THIS scroll event. */
  top: number;
  /** `scrollHeight - scrollTop - clientHeight` for THIS scroll event. */
  gap: number;
};

/** Whether the transcript should stay stuck to the live bottom after a scroll event.
 *
 *  - Un-pin only on a genuine upward move that has left the 80px bottom zone.
 *  - Re-pin whenever the viewport reaches the bottom zone (from any direction).
 *  - Otherwise (moved down or held, but still short of the bottom — e.g. a programmatic
 *    chase frame that landed short while content grew under it) hold the prior pin so the
 *    streaming-pin effect keeps following. */
export function nextPinned({
  prevPinned,
  prevTop,
  top,
  gap,
}: PinnedInput): boolean {
  if (top < prevTop && gap >= 80) return false;
  if (gap < 80) return true;
  return prevPinned;
}
