import { describe, expect, test } from "bun:test";
import { EdgeSwipeTracker } from "./edge-swipe.js";

// Defaults: edge 24, threshold 88, resistance 1, max 320.

describe("EdgeSwipeTracker", () => {
  test("a rightward drag past the threshold arms and triggers on release", () => {
    const t = new EdgeSwipeTracker();
    t.start(12); // inside the 24px edge strip
    const snap = t.move(120); // dx 108 → distance 108 (> 88)
    expect(snap.phase).toBe("armed");
    expect(snap.distance).toBe(108);
    expect(snap.progress).toBe(1);
    expect(t.end().triggered).toBe(true);
  });

  test("a drag short of the threshold does not trigger", () => {
    const t = new EdgeSwipeTracker();
    t.start(10);
    const snap = t.move(60); // dx 50 (< 88)
    expect(snap.phase).toBe("pulling");
    expect(snap.distance).toBe(50);
    expect(t.end().triggered).toBe(false);
  });

  test("never engages when the touch starts outside the edge strip", () => {
    const t = new EdgeSwipeTracker();
    t.start(80); // well past the 24px edge
    const snap = t.move(300);
    expect(snap.phase).toBe("idle");
    expect(snap.distance).toBe(0);
    expect(t.active).toBe(false);
    expect(t.end().triggered).toBe(false);
  });

  test("an leftward drag (back out of the screen) stays idle", () => {
    const t = new EdgeSwipeTracker();
    t.start(12);
    const snap = t.move(0); // dx -12
    expect(snap.phase).toBe("idle");
    expect(snap.distance).toBe(0);
    expect(t.end().triggered).toBe(false);
  });

  test("caps travel at max and clamps progress at 1", () => {
    const capped = new EdgeSwipeTracker({ max: 100 });
    capped.start(0);
    const snap = capped.move(500); // dx 500 → capped at 100
    expect(snap.distance).toBe(100);
    expect(snap.progress).toBe(1);
    expect(snap.phase).toBe("armed");
  });

  test("applies resistance to the raw drag", () => {
    const heavy = new EdgeSwipeTracker({ resistance: 0.5 });
    heavy.start(0);
    expect(heavy.move(120).distance).toBeCloseTo(60); // 120 * 0.5
  });

  test("active reflects a live rightward pull only", () => {
    const t = new EdgeSwipeTracker();
    t.start(0);
    expect(t.active).toBe(false); // not moved yet
    t.move(120);
    expect(t.active).toBe(true);
    t.end();
    expect(t.active).toBe(false); // reset after release
  });

  test("a touch started in-edge but released before moving does not trigger", () => {
    const t = new EdgeSwipeTracker();
    t.start(12);
    expect(t.end().triggered).toBe(false); // never armed
  });

  test("cancel aborts an in-flight swipe without firing", () => {
    const t = new EdgeSwipeTracker();
    t.start(12);
    t.move(120); // armed
    t.cancel();
    expect(t.snapshot.phase).toBe("idle");
    expect(t.active).toBe(false);
    // A subsequent end() after cancel does not fire.
    expect(t.end().triggered).toBe(false);
  });

  test("the arm threshold is measured post-resistance, not raw", () => {
    // resistance 0.5 + threshold 88: a raw dx of 150 → distance 75 → still pulling.
    const t = new EdgeSwipeTracker({ resistance: 0.5 });
    t.start(0);
    expect(t.move(150).phase).toBe("pulling"); // 75 < 88
    expect(t.move(200).phase).toBe("armed"); // 100 >= 88
  });
});
