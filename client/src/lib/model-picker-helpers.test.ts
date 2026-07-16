import { describe, expect, test } from "bun:test";
import type { ModelOption } from "@pantoken/protocol";
import { rankModels, sortEfforts } from "./model-picker-helpers.js";

function model(
  provider: string,
  modelId: string,
  label: string,
  thinkingLevels?: string[],
): ModelOption {
  return { provider, modelId, label, thinkingLevels };
}

const MODELS: ModelOption[] = [
  model("anthropic", "claude-opus-4-8", "Claude Opus 4.8", ["off", "low", "medium", "high"]),
  model("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", ["off", "low", "medium", "high"]),
  model("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", ["off"]),
  model("openai", "gpt-5", "GPT-5", ["minimal", "low", "medium", "high"]),
];

describe("sortEfforts", () => {
  test("sorts known levels low to high", () => {
    expect(sortEfforts(["high", "off", "medium", "low"])).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("places unknown levels after known ones", () => {
    expect(sortEfforts(["high", "banana", "off"])).toEqual(["off", "high", "banana"]);
  });

  test("preserves relative order of unknown levels (stable)", () => {
    expect(sortEfforts(["banana", "custom", "off", "cherry"])).toEqual([
      "off",
      "banana",
      "custom",
      "cherry",
    ]);
  });

  test("empty input returns empty", () => {
    expect(sortEfforts([])).toEqual([]);
  });
});

describe("rankModels", () => {
  test("empty query returns all models unranked", () => {
    const ranked = rankModels(MODELS, "");
    expect(ranked.length).toBe(4);
    expect(ranked.every((r) => r.substring === false)).toBe(true);
  });

  test("substring match ranks ahead of subsequence match", () => {
    // "deep" is a substring of "DeepSeek V4 Flash" but only a subsequence of others
    // (no other model contains "deep" as a substring).
    const ranked = rankModels(MODELS, "deep");
    expect(ranked.length).toBe(1);
    expect(ranked[0].model.modelId).toBe("deepseek-v4-flash");
    expect(ranked[0].substring).toBe(true);
  });

  test("subsequence (fuzzy) match works", () => {
    // "g5" is a subsequence of "gpt-5" (label "GPT-5") but not a substring.
    const ranked = rankModels(MODELS, "g5");
    expect(ranked.length).toBe(1);
    expect(ranked[0].model.modelId).toBe("gpt-5");
    expect(ranked[0].substring).toBe(false);
  });

  test("catalog order is preserved for ties", () => {
    // "claude" matches both Anthropic models by substring; they should stay in
    // catalog order.
    const ranked = rankModels(MODELS, "claude");
    expect(ranked.length).toBe(2);
    expect(ranked[0].model.modelId).toBe("claude-opus-4-8");
    expect(ranked[1].model.modelId).toBe("claude-sonnet-4-6");
  });

  test("no matches returns empty", () => {
    const ranked = rankModels(MODELS, "zzz");
    expect(ranked).toEqual([]);
  });

  test("query is case-insensitive", () => {
    const upper = rankModels(MODELS, "DEEP");
    const lower = rankModels(MODELS, "deep");
    expect(upper).toEqual(lower);
  });

  test("matches on provider as well", () => {
    const ranked = rankModels(MODELS, "anthropic");
    expect(ranked.length).toBe(2);
    expect(ranked.every((r) => r.model.provider === "anthropic")).toBe(true);
  });
});
