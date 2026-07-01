// Unit tests for the pure cycle-decision core (planCycle), split out of
// attention-cycle.svelte.ts so it runs under `bun test` without a Svelte
// compiler. Mirrors the transitions.ts / revealDuration pattern.

import { describe, expect, test } from "bun:test";
import { planCycle } from "./attention-cycle-core.js";

const ALL: ["transcript", "qna", "approval", "trust"] = [
  "transcript",
  "qna",
  "approval",
  "trust",
];

describe("planCycle", () => {
  test("first press from home (null) advances past transcript to the next surface", () => {
    // With all surfaces active and nothing cycled yet, the first ⌘\ should land
    // on qna (not transcript — that would be a no-op).
    const r = planCycle(null, [...ALL]);
    expect(r?.focused).toBe("qna");
    expect(r?.minimize).toEqual([]);
  });

  test("advances one step forward and minimizes the previous non-transcript surface", () => {
    let r = planCycle("qna", [...ALL]);
    expect(r?.focused).toBe("approval");
    expect(r?.minimize).toEqual(["qna"]);
    r = planCycle("approval", [...ALL]);
    expect(r?.focused).toBe("trust");
    expect(r?.minimize).toEqual(["approval"]);
    r = planCycle("trust", [...ALL]);
    expect(r?.focused).toBe("transcript");
    expect(r?.minimize).toEqual(["trust"]);
  });

  test("wraps transcript → qna and minimizes nothing when leaving transcript", () => {
    // Leaving transcript (home) minimizes nothing — transcript has no pill.
    const r = planCycle("transcript", [...ALL]);
    expect(r?.focused).toBe("qna");
    expect(r?.minimize).toEqual([]);
  });

  test("skips inactive surfaces (only transcript + approval active)", () => {
    const active = ["transcript", "approval"] as const;
    // From home → approval.
    expect(planCycle(null, [...active])?.focused).toBe("approval");
    // approval → transcript (wrap), minimizing approval.
    const r = planCycle("approval", [...active]);
    expect(r?.focused).toBe("transcript");
    expect(r?.minimize).toEqual(["approval"]);
  });

  test("focused surface no longer active restarts from transcript", () => {
    // Focused on "trust" but trust just resolved (no longer active). Should
    // restart from transcript's position — i.e. land on transcript (home), since
    // the stale focused surface is gone. Trust is NOT minimized (it's already gone).
    const active = ["transcript", "approval"] as const;
    const r = planCycle("trust", [...active]);
    expect(r?.focused).toBe("transcript");
    expect(r?.minimize).toEqual([]);
  });

  test("empty active list is a no-op (returns null)", () => {
    expect(planCycle(null, [])).toBeNull();
    expect(planCycle("approval", [])).toBeNull();
  });

  test("only transcript active → cycles back to transcript (single surface)", () => {
    // The degenerate case: pressing ⌘\ with nothing but transcript. From home,
    // advances past transcript and wraps to... transcript. No minimize.
    const r = planCycle(null, ["transcript"]);
    expect(r?.focused).toBe("transcript");
    expect(r?.minimize).toEqual([]);
  });

  test("restore() and clear() are controller-level — core only owns the advance", () => {
    // planCycle is the pure decision; restore/clear mutate $state in the
    // .svelte.ts wrapper. Here we just assert the core's contract: it never
    // touches restore semantics, only the advance from `current`.
    const r = planCycle("qna", ["transcript", "qna", "approval"]);
    expect(r?.focused).toBe("approval");
  });
});
