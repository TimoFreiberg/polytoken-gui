import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  buildTrustOptions,
  decideProjectTrust,
  makeTrustResolver,
  needsInteractiveTrust,
} from "./trust.js";

describe("decideProjectTrust", () => {
  test("no trust-requiring resources → trusted (gate is moot)", () => {
    // Even a cwd with a saved deny is trusted when nothing needs gating.
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: false,
        savedDecision: false,
      }),
    ).toBe(true);
  });

  test("a saved decision wins over the deny-by-default", () => {
    // A saved deny denies...
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: true,
        savedDecision: false,
      }),
    ).toBe(false);
    // ...and a saved trust trusts.
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: true,
        savedDecision: true,
      }),
    ).toBe(true);
  });

  test("no saved decision: every path denied (no implicit trust)", () => {
    expect(
      decideProjectTrust({
        hasTrustRequiringResources: true,
        savedDecision: null,
      }),
    ).toBe(false);
  });
});

describe("needsInteractiveTrust", () => {
  test("only an untrusted, undecided cwd should ask", () => {
    const base = {
      hasTrustRequiringResources: true,
      savedDecision: null,
    };
    expect(needsInteractiveTrust(base)).toBe(true);
    // each of the escape hatches removes the need to ask:
    expect(
      needsInteractiveTrust({ ...base, hasTrustRequiringResources: false }),
    ).toBe(false);
    expect(needsInteractiveTrust({ ...base, savedDecision: true })).toBe(false);
    expect(needsInteractiveTrust({ ...base, savedDecision: false })).toBe(
      false,
    );
  });
});

describe("buildTrustOptions", () => {
  test("offers the five pi-parity options with the right trust.json updates", () => {
    const cwd = "/Users/me/code/repo";
    const opts = buildTrustOptions(cwd);
    expect(opts.map((o) => o.trusted)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    // Trust this folder → persist a true for the resolved cwd.
    expect(opts[0]).toMatchObject({
      trusted: true,
      updates: [{ path: resolve(cwd), decision: true }],
    });
    // Trust parent → trust the parent, clear any narrower decision.
    expect(opts[1].label).toContain(dirname(resolve(cwd)));
    expect(opts[1].updates).toEqual([
      { path: dirname(resolve(cwd)), decision: true },
      { path: resolve(cwd), decision: null },
    ]);
    // The two "this session only" options decide now but persist nothing.
    expect(opts[2].updates).toEqual([]);
    expect(opts[4].updates).toEqual([]);
    // Don't trust → persist a false.
    expect(opts[3].updates).toEqual([{ path: resolve(cwd), decision: false }]);
  });

  test("omits the parent option at the filesystem root", () => {
    const opts = buildTrustOptions("/");
    expect(opts.some((o) => o.label.startsWith("Trust parent"))).toBe(false);
  });
});

describe("makeTrustResolver (interactive)", () => {
  // A temp cwd with a `.pi/settings.json` so hasTrustRequiringProjectResources is true,
  // forcing the interactive branch. The choices exercised here ("session only" / deny /
  // dismiss) never write trust.json, so this stays a read-only integration test.
  const root = mkdtempSync(join(tmpdir(), "pilot-trust-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "settings.json"), "{}\n");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("escalates to ask, and a session-only trust returns true without persisting", async () => {
    let asked: { cwd: string; optionCount: number } | null = null;
    const resolver = makeTrustResolver(root, async ({ cwd, options }) => {
      asked = { cwd, optionCount: options.length };
      return options.findIndex(
        (o) => o.label === "Trust for this session only",
      );
    });
    expect(await resolver()).toBe(true);
    expect(asked).toMatchObject({ cwd: root, optionCount: 5 });
  });

  test("a null answer (cancel / dismiss / timeout) denies", async () => {
    const resolver = makeTrustResolver(root, async () => null);
    expect(await resolver()).toBe(false);
  });

  test("without an ask channel it stays non-interactive (deny-safe)", async () => {
    // No ask wired → falls back to decideProjectTrust: an untrusted cwd with no saved
    // decision denies. No path is implicitly trusted.
    expect(await makeTrustResolver(root)()).toBe(false);
  });
});
