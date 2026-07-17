import { describe, expect, test } from "bun:test";
import {
  DRIFT_THRESHOLD,
  formatTrace,
  isPinnedDrift,
  nextDriftState,
  pushSample,
  type DriftSample,
} from "./scroll-watch.js";

// The pinned-scroll drift detector for the transcript scroller. Extracted from
// Transcript.svelte so the decision is unit-testable in isolation — the failure it guards
// (a pinned viewport silently stranded past/short of the content end after a height-churn
// event the follow logic missed, showing blank space until a manual scroll re-triggers the
// follow) can't be reliably staged in headless Chromium (Chrome's overflow-anchor masks
// growth; a forced shrink may be re-clamped before the watcher sees it). The pure decision
// functions are the testable surface; see scroll-watch.ts for the full rationale.

function sample(over: Partial<DriftSample> = {}): DriftSample {
  return {
    t: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    gap: 0,
    pinned: false,
    turnActive: false,
    ...over,
  };
}

describe("isPinnedDrift", () => {
  test("not pinned → never drift (a scrolled-up reader is left alone)", () => {
    expect(isPinnedDrift({ pinned: false, gap: 1000 })).toBe(false);
  });

  test("pinned + gap ≤ threshold → not drift (normal settle churn, sub-threshold)", () => {
    expect(isPinnedDrift({ pinned: true, gap: 0 })).toBe(false);
    expect(isPinnedDrift({ pinned: true, gap: 80 })).toBe(false); // BOTTOM_GAP zone
    expect(isPinnedDrift({ pinned: true, gap: DRIFT_THRESHOLD })).toBe(false);
  });

  test("pinned + gap > threshold → drift (viewport stranded past the content end)", () => {
    expect(isPinnedDrift({ pinned: true, gap: DRIFT_THRESHOLD + 1 })).toBe(true);
    expect(isPinnedDrift({ pinned: true, gap: 1000 })).toBe(true);
  });

  test("threshold parameter is honored (custom boundary)", () => {
    // A tiny threshold for tests that want to force the drift cheaply.
    expect(isPinnedDrift({ pinned: true, gap: 50, threshold: 40 })).toBe(true);
    expect(isPinnedDrift({ pinned: true, gap: 40, threshold: 40 })).toBe(false);
    expect(isPinnedDrift({ pinned: true, gap: 10, threshold: 40 })).toBe(false);
  });

  test("AC.6 — sub-80px chase-landing frames never trip it (settle churn boundary)", () => {
    // A programmatic snapToBottom chase frame that landed short by a sub-80px amount (the
    // race scroll-follow.ts guards) must NOT be classified as drift, or the self-heal would
    // fight normal follow and the notice would spam.
    expect(isPinnedDrift({ pinned: true, gap: 79 })).toBe(false);
  });
});

describe("pushSample", () => {
  test("appends samples in order", () => {
    const buf = pushSample([], sample({ t: 1 }), 40);
    const buf2 = pushSample(buf, sample({ t: 2 }), 40);
    expect(buf2.map((s) => s.t)).toEqual([1, 2]);
  });

  test("caps the buffer, dropping the OLDEST (ring buffer)", () => {
    let buf: DriftSample[] = [];
    for (let i = 0; i < 5; i++) buf = pushSample(buf, sample({ t: i }), 3);
    expect(buf.map((s) => s.t)).toEqual([2, 3, 4]);
  });

  test("cap 1 keeps exactly the most recent sample", () => {
    const buf = pushSample(
      pushSample([], sample({ t: 1 }), 1),
      sample({ t: 2 }),
      1,
    );
    expect(buf.map((s) => s.t)).toEqual([2]);
  });

  test("does not mutate the input buffer (immutable)", () => {
    const orig: DriftSample[] = [sample({ t: 1 })];
    const next = pushSample(orig, sample({ t: 2 }), 40);
    expect(orig.map((s) => s.t)).toEqual([1]);
    expect(next.map((s) => s.t)).toEqual([1, 2]);
  });
});

describe("formatTrace", () => {
  test("outputs a header line with detection instant + UA + viewport, then one JSON object per sample", () => {
    const samples = [
      sample({
        t: 100,
        scrollTop: 500,
        scrollHeight: 1500,
        clientHeight: 800,
        gap: 200,
        pinned: true,
        turnActive: true,
      }),
      sample({ t: 200, gap: 500, pinned: true, turnActive: false }),
    ];
    const trace = formatTrace(samples, {
      detectedAt: 1234567890,
      ua: "Mozilla/5.0 test",
      viewport: { w: 1280, h: 800 },
    });
    const lines = trace.split("\n");
    expect(lines.length).toBe(3);

    // Header: JSON object with the marker, detection instant, UA, viewport.
    const header = JSON.parse(lines[0]!);
    expect(header).toEqual({
      pantokenScrollDriftTrace: true,
      detectedAt: 1234567890,
      ua: "Mozilla/5.0 test",
      viewport: { w: 1280, h: 800 },
    });

    // Each sample line is a JSON object with the named fields.
    const s0 = JSON.parse(lines[1]!);
    expect(s0).toEqual({
      t: 100,
      scrollTop: 500,
      scrollHeight: 1500,
      clientHeight: 800,
      gap: 200,
      pinned: true,
      turnActive: true,
    });
    const s1 = JSON.parse(lines[2]!);
    expect(s1).toEqual({
      t: 200,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      gap: 500,
      pinned: true,
      turnActive: false,
    });
  });

  test("empty buffer yields just the header", () => {
    const trace = formatTrace([], {
      detectedAt: 0,
      ua: "",
      viewport: { w: 0, h: 0 },
    });
    expect(trace.split("\n")).toHaveLength(1);
    expect(JSON.parse(trace)).toEqual({
      pantokenScrollDriftTrace: true,
      detectedAt: 0,
      ua: "",
      viewport: { w: 0, h: 0 },
    });
  });
});

describe("nextDriftState", () => {
  const T = 200; // threshold

  test("first sample over threshold with !prevReported → fires (shouldNotify: true)", () => {
    const r = nextDriftState(false, 500, T);
    expect(r).toEqual({ reported: true, shouldNotify: true });
  });

  test("sustained-over-threshold samples do NOT re-fire (no toast storm)", () => {
    // After the first fire, reported is true; subsequent over-threshold samples hold.
    let r = nextDriftState(false, 500, T);
    expect(r.shouldNotify).toBe(true);
    r = nextDriftState(r.reported, 600, T);
    expect(r).toEqual({ reported: true, shouldNotify: false });
    r = nextDriftState(r.reported, 700, T);
    expect(r).toEqual({ reported: true, shouldNotify: false });
  });

  test("gap drops below threshold → re-arms (reported resets to false)", () => {
    let r = nextDriftState(false, 500, T);
    expect(r.shouldNotify).toBe(true); // fire
    r = nextDriftState(r.reported, 600, T);
    expect(r.shouldNotify).toBe(false); // held
    // Gap returns under threshold → re-arm.
    r = nextDriftState(r.reported, 50, T);
    expect(r).toEqual({ reported: false, shouldNotify: false });
    // Next over-threshold sample fires again (new episode).
    r = nextDriftState(r.reported, 800, T);
    expect(r).toEqual({ reported: true, shouldNotify: true });
  });

  test("gap exactly at threshold → not drifting (strictly greater-than)", () => {
    expect(nextDriftState(false, T, T).shouldNotify).toBe(false);
    expect(nextDriftState(true, T, T)).toEqual({ reported: false, shouldNotify: false });
  });

  test("never-reported + under-threshold → no fire, stays re-armed", () => {
    expect(nextDriftState(false, 50, T)).toEqual({
      reported: false,
      shouldNotify: false,
    });
  });
});
