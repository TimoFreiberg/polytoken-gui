import { describe, expect, test } from "bun:test";
import { decideProjectTrust } from "./trust.js";

describe("decideProjectTrust", () => {
  test("no trust-requiring resources → trusted (gate is moot)", () => {
    // Even a non-launch cwd with a saved deny is trusted when nothing needs gating.
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: false,
        savedDecision: false,
        isLaunchCwd: false,
      }),
    ).toBe(true);
  });

  test("a saved decision wins over the launch-cwd default", () => {
    // Saved deny beats the implicit launch-cwd trust...
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: true,
        savedDecision: false,
        isLaunchCwd: true,
      }),
    ).toBe(false);
    // ...and a saved trust beats the deny-other-paths default.
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: true,
        savedDecision: true,
        isLaunchCwd: false,
      }),
    ).toBe(true);
  });

  test("no saved decision: launch cwd trusted, other paths denied", () => {
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: true,
        savedDecision: null,
        isLaunchCwd: true,
      }),
    ).toBe(true);
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: true,
        savedDecision: null,
        isLaunchCwd: false,
      }),
    ).toBe(false);
  });
});
