import { describe, expect, test } from "bun:test";
import { nextPinned } from "./scroll-follow.js";

// The pin decision for the transcript scroller. Extracted from Transcript.svelte's
// onScroll so the rule is unit-testable in isolation — the failure it guards (a
// programmatic snap chase landing short → scroll event at gap ≥ 80 → unpin → streaming-pin
// stops following → "New messages ↓" pill, never recovers) can't be staged in headless
// Chromium (Chrome's overflow-anchor keeps gap near 0 on growth), so the decision is the
// testable surface. See scroll-follow.ts for the full rationale.

const BOTTOM = 30; // gap < 80: at the bottom zone
const SHORT = 200; // gap ≥ 80: short of the bottom

describe("nextPinned", () => {
  test("reaches the bottom zone from any direction → pinned", () => {
    // Scroll DOWN to the bottom (common: a reader scrolling back down).
    expect(
      nextPinned({ prevPinned: false, prevTop: 400, top: 1000, gap: BOTTOM }),
    ).toBe(true);
    // Already pinned, a chase frame re-asserts the bottom.
    expect(
      nextPinned({ prevPinned: true, prevTop: 1000, top: 1000, gap: BOTTOM }),
    ).toBe(true);
    // Even an upward move that lands back in the bottom zone re-pins.
    expect(
      nextPinned({ prevPinned: false, prevTop: 1050, top: 1010, gap: BOTTOM }),
    ).toBe(true);
  });

  test("content grew under a pinned viewport (gap opens, scrollTop unchanged) → STAYS pinned", () => {
    // THE BUG: a snapToBottom chase frame landed, then scrollHeight grew (a collapsing
    // work block / streaming delta settled), so gap is now ≥ 80 while scrollTop is
    // unchanged. The old `pinned = gap < 80` rule un-pinned here, which stopped the
    // streaming follow and surfaced a sticky "New messages ↓" pill. Direction-based
    // pinning holds: no upward move, so no unpin.
    expect(
      nextPinned({ prevPinned: true, prevTop: 1000, top: 1000, gap: SHORT }),
    ).toBe(true);
  });

  test("content grew and the chase nudged scrollTop up slightly → STAYS pinned", () => {
    // Same race, but the chase frame's re-assertion moved scrollTop up a hair (still short
    // of the new bottom). An upward move that hasn't left the bottom zone is not an unpin.
    expect(
      nextPinned({ prevPinned: true, prevTop: 1000, top: 1005, gap: SHORT }),
    ).toBe(true);
  });

  test("a genuine user scroll-up that leaves the bottom zone → un-pins", () => {
    expect(
      nextPinned({ prevPinned: true, prevTop: 1000, top: 400, gap: SHORT }),
    ).toBe(false);
    // Even from an un-pinned state, keep it un-pinned (no re-pin short of the bottom).
    expect(
      nextPinned({ prevPinned: false, prevTop: 400, top: 300, gap: SHORT }),
    ).toBe(false);
  });

  test("a jitter within the 80px bottom zone does NOT un-pin", () => {
    // A 10px upward nudge while still in the bottom zone: the `&& gap >= 80` guard on the
    // unpin keeps us pinned. Without it, a bare `top < prevTop` rule would twitch off.
    expect(
      nextPinned({ prevPinned: true, prevTop: 1000, top: 990, gap: BOTTOM }),
    ).toBe(true);
  });

  test("session switch to a shorter live session (scrollTop clamps down to the bottom) → STAYS pinned", () => {
    // prevTop is component-scoped, so a switch from a tall scrolled-down session
    // (prevTop ≈ 5000) to a shorter live session whose bottom sits at top ≈ 700 fires a
    // scroll event with top < prevTop. But the DOM swap clamps scrollTop to the new max, so
    // the viewport landed AT the new bottom (gap < 80) — this must re-pin, not un-pin,
    // otherwise a session you're sitting at the bottom of would spuriously flag unread the
    // moment a stream starts. (Transcript.svelte's restore effect ALSO resets lastScrollTop
    // to 0 at the switch — see the taller-session case below for why — so prevTop would
    // actually be 0 here; this case still passes with the stale value thanks to gap < 80.)
    expect(
      nextPinned({ prevPinned: true, prevTop: 5000, top: 700, gap: BOTTOM }),
    ).toBe(true);
  });

  test("session switch to a TALLER live session, first chase frame lands short → STAYS pinned", () => {
    // The case the `&& gap >= 80` guard does NOT close: switching to a taller live session
    // whose first chase frame lands short (scrollHeight grows under it on first render —
    // exactly what the 4-frame chase exists to absorb), with a stale-higher prevTop carried
    // from the prior (taller-scrolled-down) session. `top < prevTop && gap >= 80` would
    // spuriously un-pin a LIVE tail — reproducing the exact stuck-pill symptom. The fix is
    // in the WIRING: Transcript.svelte's restore effect resets lastScrollTop = 0 at the
    // switch, so the real code feeds prevTop = 0 here, and `top < 0` is impossible → the
    // frame holds pinned (returns prevPinned=true) and later chase frames close the gap.
    // This test pins the wiring invariant by asserting the reset-fed shape stays pinned.
    expect(
      nextPinned({ prevPinned: true, prevTop: 0, top: 2500, gap: 400 }),
    ).toBe(true);
    // And the buggy shape (stale higher prevTop, what the code would feed WITHOUT the
    // reset) DOES un-pin — documenting why the reset is load-bearing. If someone removes
    // the reset, this assertion still passes (it's the nextPinned contract), but the taller-
    // session-switch e2e path would regress; the wiring reset is guarded by the restore
    // effect's own behavior, not by this unit.
    expect(
      nextPinned({ prevPinned: true, prevTop: 5000, top: 2500, gap: 400 }),
    ).toBe(false);
  });

  test("session switch restoring a scrolled-up reading spot → un-pins", () => {
    // The restore effect sets pinned=false explicitly and snaps to a saved mid-transcript
    // spot, then resets lastScrollTop = 0; the chase frames then fire onScroll. With
    // prevTop = 0 the unpin branch can't fire (top < 0 is impossible), but the rule still
    // returns the explicit prevPinned=false via the third arm — so the restore STAYS
    // un-pinned as intended. (This is why the scrolled-up restore path doesn't depend on
    // the unpin branch: the restore effect sets the pin state directly.)
    expect(
      nextPinned({ prevPinned: false, prevTop: 0, top: 200, gap: SHORT }),
    ).toBe(false);
  });
});
