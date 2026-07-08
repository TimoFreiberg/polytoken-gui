import { describe, expect, test } from "bun:test";
import { evictionPlan } from "./warm-cap.js";

describe("evictionPlan", () => {
  test("no eviction when within the cap", () => {
    expect(evictionPlan(["a", "b", "c"], "c", 8)).toEqual([]);
  });

  test("evicts the oldest when over the cap", () => {
    expect(evictionPlan(["a", "b", "c"], "c", 2)).toEqual(["a"]);
  });

  test("evicts multiple oldest to reach the cap", () => {
    expect(evictionPlan(["a", "b", "c", "d"], "d", 2)).toEqual(["a", "b"]);
  });

  test("never evicts the protected (about-to-focus) id", () => {
    // "a" is oldest, but it's the protected id, so "b" goes instead.
    expect(evictionPlan(["a", "b", "c"], "a", 2)).toEqual(["b"]);
  });

  test("cap <= 0 means unbounded", () => {
    expect(evictionPlan(["a", "b", "c"], "a", 0)).toEqual([]);
    expect(evictionPlan(["a", "b", "c"], "a", -1)).toEqual([]);
  });

  // --- evictable predicate (mid-turn protection) ---

  test("skips a non-evictable (running) session, evicts the next idle one", () => {
    // "a" is oldest but running → skipped; "b" is the next idle candidate.
    expect(evictionPlan(["a", "b", "c"], "c", 2, (id) => id !== "a")).toEqual(["b"]);
  });

  test("evicts multiple idle sessions, skipping running ones in between", () => {
    // need=2: "a" (idle→evict), "b" (running→skip), "c" (idle→evict), "d" (protected)
    expect(
      evictionPlan(["a", "b", "c", "d"], "d", 2, (id) => id !== "b"),
    ).toEqual(["a", "c"]);
  });

  test("allows over-cap when all eviction candidates are running", () => {
    // need=2: "a" running, "b" running, "c" protected → nothing evictable
    expect(
      evictionPlan(["a", "b", "c"], "c", 1, () => false),
    ).toEqual([]);
  });

  test("partial over-cap when some but not enough are evictable", () => {
    // need=3: "a" (evict), "b" (running→skip), "c" (evict), "d" (running→skip), "e" (protected)
    // Only 2 of 3 needed → stays over-cap by 1
    expect(
      evictionPlan(
        ["a", "b", "c", "d", "e"],
        "e",
        2,
        (id) => id !== "b" && id !== "d",
      ),
    ).toEqual(["a", "c"]);
  });

  test("default predicate (all evictable) matches original behavior", () => {
    // No predicate → all non-protected sessions are evictable (backward compat).
    expect(evictionPlan(["a", "b", "c"], "c", 2)).toEqual(["a"]);
    expect(evictionPlan(["a", "b", "c", "d"], "d", 2)).toEqual(["a", "b"]);
  });
});
