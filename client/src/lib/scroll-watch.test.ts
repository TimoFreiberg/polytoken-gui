import { describe, expect, test } from "bun:test";
import {
  DRIFT_THRESHOLD,
  formatTrace,
  isPinnedDrift,
  isUnpinnedDuringStreaming,
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

describe("isUnpinnedDuringStreaming", () => {
  test("!pinned && turnActive && gap > 0 → true (the false-un-pin suspect)", () => {
    expect(isUnpinnedDuringStreaming({ pinned: false, turnActive: true, gap: 1 })).toBe(true);
    expect(isUnpinnedDuringStreaming({ pinned: false, turnActive: true, gap: 300 })).toBe(true);
  });

  test("pinned === true → false (a pinned viewport is handled by isPinnedDrift, not this)", () => {
    expect(
      isUnpinnedDuringStreaming({ pinned: true, turnActive: true, gap: 1000 }),
    ).toBe(false);
  });

  test("turnActive === false → false (no notice when idle + scrolled up)", () => {
    expect(
      isUnpinnedDuringStreaming({ pinned: false, turnActive: false, gap: 500 }),
    ).toBe(false);
  });

  test("gap === 0 → false (at the bottom — nothing below the fold)", () => {
    expect(
      isUnpinnedDuringStreaming({ pinned: false, turnActive: true, gap: 0 }),
    ).toBe(false);
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

  test("threshold 0 (un-pinned-during-streaming latch): fires on gap>0, re-arms at gap=0", () => {
    // The un-pinned-during-streaming detector uses threshold 0: any gap>0 while un-pinned +
    // streaming is a stranding episode. The latch must fire once, hold while the gap stays
    // positive, and re-arm when the viewport returns to the bottom (gap=0) so the next
    // episode fires again.
    const T0 = 0;
    let r = nextDriftState(false, 300, T0);
    expect(r).toEqual({ reported: true, shouldNotify: true }); // first fire
    r = nextDriftState(r.reported, 400, T0);
    expect(r).toEqual({ reported: true, shouldNotify: false }); // held (no storm)
    r = nextDriftState(r.reported, 0, T0);
    expect(r).toEqual({ reported: false, shouldNotify: false }); // back at bottom → re-arm
    r = nextDriftState(r.reported, 500, T0);
    expect(r).toEqual({ reported: true, shouldNotify: true }); // new episode fires
  });
});

// The snapshot-at-notify invariant. Transcript.svelte's copyTrace() must emit the samples
// captured AT detection time, not whatever the live rolling buffer holds when the sticky
// notice's "Copy trace" action eventually runs (which can be minutes later — the notice is
// sticky, durationMs: 0). The live traceBuffer keeps rolling every 250ms tick + onScroll;
// without a snapshot, a trace copied long after the episode would contain post-episode
// samples (e.g. the user's own jump-to-bottom) and be inconsistent with lastDetectedAt.
//
// This reproduces the exact wiring using the pure functions: a rolling buffer + a snapshot
// taken when nextDriftState first fires + formatTrace on the snapshot after the buffer has
// rolled well past the episode. Both real traces that motivated the fix showed this — the
// header's detectedAt was ~10min older than every sample in the buffer.
describe("trace snapshot at notify (regression: live buffer rolls past the episode)", () => {
  const CAP = 40;

  test("snapshot taken at first fire survives subsequent buffer rolls", () => {
    // Phase 1: lead-up. A pinned viewport drifts; gap grows past the threshold.
    let buf: DriftSample[] = [];
    let snapshot: DriftSample[] = [];
    let reported = false;
    let detectedAt = 0;
    const T = 200;

    // A few sub-threshold samples (normal pinned-at-bottom).
    for (let t = 100; t <= 400; t += 100) {
      buf = pushSample(buf, sample({ t, gap: 0, pinned: true }), CAP);
    }
    // The drift: gap crosses the threshold while pinned.
    const driftT = 500;
    const driftSample = sample({ t: driftT, gap: 500, pinned: true });
    buf = pushSample(buf, driftSample, CAP);
    if (isPinnedDrift({ pinned: true, gap: 500 })) {
      const latch = nextDriftState(reported, 500, T);
      reported = latch.reported;
      if (latch.shouldNotify) {
        detectedAt = driftT;
        snapshot = [...buf]; // ← the fix: freeze at detection
      }
    }

    // Phase 2: the live buffer keeps rolling. The self-heal fires, the user
    // eventually jumps to bottom, samples accumulate — for far longer than the
    // CAP, so the drift sample is evicted from the LIVE buffer entirely.
    for (let t = 600; t <= 600 + CAP * 250; t += 250) {
      buf = pushSample(buf, sample({ t, gap: 0, pinned: true }), CAP);
    }
    // The drift sample (t=500) is gone from the live buffer.
    expect(buf.some((s) => s.t === driftT)).toBe(false);

    // Phase 3: the sticky notice's "Copy trace" finally runs. It must emit the
    // SNAPSHOT, not the live buffer.
    const trace = formatTrace(snapshot, {
      detectedAt,
      ua: "test",
      viewport: { w: 0, h: 0 },
    });
    const lines = trace.split("\n");
    const header = JSON.parse(lines[0]!);
    expect(header.detectedAt).toBe(driftT);
    // The drift sample survives in the snapshot's trace.
    const sampleLines = lines.slice(1).map((l) => JSON.parse(l) as DriftSample);
    expect(sampleLines.some((s) => s.t === driftT && s.gap === 500)).toBe(true);
    // And the lead-up samples (the evidence of how the drift developed) too.
    expect(sampleLines.some((s) => s.t === 100)).toBe(true);
  });

  test("without a snapshot, the live buffer would lose the drift sample (the bug)", () => {
    // This is the negative case that documents WHY the snapshot exists: if
    // copyTrace read the live buffer, a late copy would emit only post-episode
    // samples and be inconsistent with detectedAt. Shown by constructing the
    // same buffer roll and formatting the LIVE buffer (the old behavior).
    let buf: DriftSample[] = [];
    const driftT = 500;
    for (let t = 100; t <= 400; t += 100) {
      buf = pushSample(buf, sample({ t, gap: 0, pinned: true }), CAP);
    }
    buf = pushSample(buf, sample({ t: driftT, gap: 500, pinned: true }), CAP);
    for (let t = 600; t <= 600 + CAP * 250; t += 250) {
      buf = pushSample(buf, sample({ t, gap: 0, pinned: true }), CAP);
    }
    // The live buffer no longer contains the drift sample.
    expect(buf.some((s) => s.t === driftT)).toBe(false);
    // So formatting the live buffer (the old behavior) would produce a trace
    // whose every sample postdates detectedAt — the exact inconsistency seen
    // in the real traces.
    const trace = formatTrace(buf, {
      detectedAt: driftT,
      ua: "test",
      viewport: { w: 0, h: 0 },
    });
    const sampleLines = trace
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l) as DriftSample);
    expect(sampleLines.every((s) => s.t > driftT)).toBe(true);
  });
});
