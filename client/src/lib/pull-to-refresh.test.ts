import { describe, expect, test } from "bun:test";
import { PullTracker } from "./pull-to-refresh.js";

// Defaults: threshold 64, resistance 0.5, max 90.

describe("PullTracker", () => {
  test("a downward pull past the threshold arms and triggers on release", () => {
    const t = new PullTracker();
    t.start(0, 0);
    const snap = t.move(200, 0); // dy 200 → distance min(100, 90) = 90
    expect(snap.phase).toBe("armed");
    expect(snap.distance).toBe(90); // capped at max
    expect(snap.progress).toBe(1);
    expect(t.end().triggered).toBe(true);
  });

  test("a pull short of the threshold does not trigger", () => {
    const t = new PullTracker();
    t.start(0, 0);
    const snap = t.move(100, 0); // dy 100 → distance 50 (< 64)
    expect(snap.phase).toBe("pulling");
    expect(snap.distance).toBe(50);
    expect(t.end().triggered).toBe(false);
  });

  test("never engages when the container is already scrolled down", () => {
    const t = new PullTracker();
    t.start(0, 30); // not at the top
    const snap = t.move(400, 30);
    expect(snap.phase).toBe("idle");
    expect(snap.distance).toBe(0);
    expect(t.active).toBe(false);
    expect(t.end().triggered).toBe(false);
  });

  test("an upward drag stays idle", () => {
    const t = new PullTracker();
    t.start(100, 0);
    const snap = t.move(50, 0); // dy -50
    expect(snap.phase).toBe("idle");
    expect(snap.distance).toBe(0);
    expect(t.end().triggered).toBe(false);
  });

  test("losing the top edge mid-pull collapses and won't trigger", () => {
    const t = new PullTracker();
    t.start(0, 0);
    expect(t.move(200, 0).phase).toBe("armed");
    const snap = t.move(200, 40); // content scrolled away from the top
    expect(snap.phase).toBe("idle");
    expect(t.end().triggered).toBe(false);
  });

  test("applies resistance and caps travel at max", () => {
    const heavy = new PullTracker({
      resistance: 0.4,
      max: 1000,
      threshold: 64,
    });
    heavy.start(0, 0);
    expect(heavy.move(100, 0).distance).toBeCloseTo(40); // 100 * 0.4

    const capped = new PullTracker({ resistance: 1, max: 30 });
    capped.start(0, 0);
    expect(capped.move(500, 0).distance).toBe(30);
  });

  test("active reflects a live downward pull only", () => {
    const t = new PullTracker();
    t.start(0, 0);
    expect(t.active).toBe(false); // not moved yet
    t.move(200, 0);
    expect(t.active).toBe(true);
    t.end();
    expect(t.active).toBe(false); // reset after release
  });
});
