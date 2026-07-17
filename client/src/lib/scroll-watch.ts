// The pinned-scroll drift detector for the transcript scroller, extracted pure so the
// decision is unit-testable in isolation (no DOM, no store, no Svelte effect timing) —
// mirroring scroll-follow.ts (the pin decision) and scroll-position.ts (saved spots).
//
// WHAT THIS CATCHES. The transcript's follow logic has a gap: the streaming-pin $effect
// (Transcript.svelte) only re-asserts the bottom when `contentSize` changes, and
// `contentSize` tracks only item count + the LAST item's streaming length. It does NOT tick
// on a "Worked for Ns" block collapsing (animated reveal slide), an image decode, a
// markstream block reflow when final/fade flips, or growth in a non-last item. The only
// other re-assert path is the ResizeObserver → applySettle(), but that is gated on
// `Date.now() < settleUntil` — a ~500ms window opened only by settleScroll() on
// send/switch/restore. So OUTSIDE that window, a height change while `pinned` silently
// strands the viewport past/short of the content end, showing empty space. Any scroll input
// retriggers onScroll → nextPinned → the streaming-pin effect → settleScroll(), which is
// why a manual scroll "fixes" the blank. This is the intermittent "transcript goes blank
// while streaming, any scroll fixes it" bug.
//
// THE WATCHER. A sampling watcher closes this gap: it continuously checks the pinned
// invariant — a pinned scroller SHOULD sit at the bottom (gap ≈ 0) — and both corrects it
// (self-heal: re-assert scrollTo(bottom)) and reports it (debug notice with a paste-able
// trace). The pure functions here are the testable surface; the wiring lives in
// Transcript.svelte.
//
// WHY 200px (not 80px). BOTTOM_GAP (scroll-position.ts) is 80px — the "at the bottom zone"
// threshold the pin logic uses. DRIFT_THRESHOLD is deliberately much larger (200px) so the
// detector never fires during normal settle churn: a programmatic snapToBottom chase frame
// can land short by a sub-80px amount (see scroll-follow.ts WHY DIRECTION, NOT GAP ALONE),
// and that must NOT trip the heal or the notice. A real blank is typically a full-viewport-
// plus gap — the viewport is parked far from the content end. 200px is a deliberate starting
// point well above the 80px bottom zone; the value may be tuned after the first real trace.
// It is NOT derived from BOTTOM_GAP to avoid coupling the drift threshold to the pin
// threshold (they answer different questions).

/** Gap (px) from the bottom beyond which a pinned viewport is considered "drifted".
 *  Well above BOTTOM_GAP (80px) so normal settle churn never trips it. */
export const DRIFT_THRESHOLD = 200;

/** A single scroll-geometry sample captured by the watcher. Captured on the sampling
 *  interval and on each onScroll, kept in a ring buffer as evidence for the "Copy trace"
 *  debug payload. Pure data — no DOM references. */
export type DriftSample = {
  /** Capture instant (epoch ms). */
  t: number;
  /** The scroller's scrollTop at capture. */
  scrollTop: number;
  /** The scroller's scrollHeight at capture. */
  scrollHeight: number;
  /** The scroller's clientHeight at capture. */
  clientHeight: number;
  /** `scrollHeight - scrollTop - clientHeight` at capture. */
  gap: number;
  /** Whether the viewport was pinned (following the live tail) at capture. */
  pinned: boolean;
  /** Whether a turn was actively streaming at capture (store.turnActive). */
  turnActive: boolean;
};

/** Whether a pinned viewport has drifted too far from the bottom.
 *
 *  A pinned scroller should sit at the bottom (gap ≈ 0). A large gap while pinned means the
 *  viewport is parked past/short of the content end — the "transcript goes blank" symptom.
 *  Returns true only when BOTH pinned AND gap exceeds the threshold, so a user who scrolled
 *  up (pinned = false) is never false-healed back down.
 *
 *  `threshold` is a parameter so tests control it without depending on the module constant. */
export function isPinnedDrift({
  pinned,
  gap,
  threshold,
}: {
  pinned: boolean;
  gap: number;
  threshold?: number;
}): boolean {
  return pinned && gap > (threshold ?? DRIFT_THRESHOLD);
}

/** Push a sample onto a ring buffer, dropping the oldest when the cap is reached. Returns a
 *  new array (immutable, so the component can hold it as plain `let` without surprising
 *  re-render coupling). Cap keeps recent history bounded for the "Copy trace" payload. */
export function pushSample<T>(
  buffer: readonly T[],
  sample: T,
  cap: number,
): T[] {
  const next = [...buffer, sample];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Format the ring buffer as a paste-able JSON trace string for the "Copy trace" action.
 *
 *  Output shape: a one-line header (detection instant + UA + viewport size for context),
 *  followed by one JSON object per sample on its own line (t, scrollTop, scrollHeight,
 *  clientHeight, gap, pinned, turnActive). The samples leading up to the drift show WHICH
 *  height-churn event preceded the stranding: a sudden scrollHeight drop = a collapse; a
 *  gradual change = a reflow; etc. That evidence is the input to the later root-cause fix.
 *
 *  Extracted pure so AC.4 can unit-test the shape without a clipboard. */
export function formatTrace(
  samples: readonly DriftSample[],
  meta: { detectedAt: number; ua: string; viewport: { w: number; h: number } },
): string {
  const header = JSON.stringify({
    pantokenScrollDriftTrace: true,
    detectedAt: meta.detectedAt,
    ua: meta.ua,
    viewport: meta.viewport,
  });
  const lines = samples.map((s) =>
    JSON.stringify({
      t: s.t,
      scrollTop: s.scrollTop,
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
      gap: s.gap,
      pinned: s.pinned,
      turnActive: s.turnActive,
    }),
  );
  return [header, ...lines].join("\n");
}

/** The episode latch: raise the notice on the FIRST detection of a drift episode, not every
 *  250ms tick while it sits drifted (no toast storm). Once the gap returns under the
 *  threshold, the latch re-arms so the NEXT episode fires again.
 *
 *  - `prevReported=false` + gap over threshold → fire (`shouldNotify: true`, arm `reported`).
 *  - `prevReported=true`  + gap over threshold → hold (`shouldNotify: false`, no storm).
 *  - gap under threshold → re-arm (`reported: false`, `shouldNotify: false`).
 *
 *  Extracted pure so AC.5 can unit-test the latch without e2e forcing. */
export function nextDriftState(
  prevReported: boolean,
  gap: number,
  threshold: number,
): { reported: boolean; shouldNotify: boolean } {
  const drifting = gap > threshold;
  if (!drifting) return { reported: false, shouldNotify: false };
  if (prevReported) return { reported: true, shouldNotify: false };
  return { reported: true, shouldNotify: true };
}
