import { describe, expect, test } from "bun:test";
import { randomWorktreeName } from "./worktree-name.js";

describe("randomWorktreeName", () => {
  test("produces a two-word adjective-animal slug", () => {
    for (let i = 0; i < 100; i++) {
      const name = randomWorktreeName();
      // lowercase words joined by a single hyphen, no extra separators
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  test("varies across calls (not a constant)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(randomWorktreeName());
    // Astronomically unlikely to collapse to <5 distinct values across 50 draws.
    expect(seen.size).toBeGreaterThan(5);
  });
});
