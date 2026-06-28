// Unit tests for parseModels — pure, no binary invocation. Fixtures are the real
// `polytoken models` output shapes (observed, polytoken 0.3.3).

import { test, expect } from "bun:test";
import { parseModels } from "./models.js";

// The actual observed output from `polytoken models` on the mini (2 models).
const REAL_OUTPUT = `default_model: umans/umans-glm-5.2
default_small_model: umans/umans-flash

models:
- deepseek/deepseek-v4-pro
  provider: deepseek/deepseek-v4-pro
  variant: claude
  tool_loading: eager
  reasoning: effort set=deepseek_v4; levels=high (default), max, none; can_disable=yes
  selectable: deepseek/deepseek-v4-pro, deepseek/deepseek-v4-pro(none), deepseek/deepseek-v4-pro(high), deepseek/deepseek-v4-pro(max)
- deepseek/deepseek-v4-flash
  provider: deepseek/deepseek-v4-flash
  variant: claude
  tool_loading: eager
  reasoning: effort set=deepseek_v4; levels=high (default), max, none; can_disable=yes
  selectable: deepseek/deepseek-v4-flash, deepseek/deepseek-v4-flash(none), deepseek/deepseek-v4-flash(high), deepseek/deepseek-v4-flash(max)
`;

test("parseModels > parses the real observed output", () => {
  const { models, defaultModel, defaultSmallModel } = parseModels(REAL_OUTPUT);
  expect(defaultModel).toBe("umans/umans-glm-5.2");
  expect(defaultSmallModel).toBe("umans/umans-flash");
  expect(models).toHaveLength(2);
  const [pro, flash] = models;
  expect(pro!.provider).toBe("deepseek/deepseek-v4-pro");
  expect(pro!.modelId).toBe("deepseek/deepseek-v4-pro");
  expect(pro!.label).toBe("deepseek/deepseek-v4-pro");
  expect(pro!.thinkingLevels).toEqual(["high", "max", "none"]);
  expect(flash!.modelId).toBe("deepseek/deepseek-v4-flash");
  expect(flash!.thinkingLevels).toEqual(["high", "max", "none"]);
});

test("parseModels > splits provider from modelId on the first slash", () => {
  // A model id with a provider prefix: `provider/modelId`. The provider field is
  // often identical to the id, so we derive the provider from the id's prefix when
  // the provider field is absent too.
  const out = parseModels(
    "models:\n- anthropic/claude-sonnet-5\n  reasoning: levels=low (default), high; can_disable=yes\n",
  );
  expect(out.models).toHaveLength(1);
  expect(out.models[0]!.provider).toBe("anthropic");
  expect(out.models[0]!.modelId).toBe("anthropic/claude-sonnet-5");
});

test("parseModels > falls back to the whole id as provider when there's no slash", () => {
  const out = parseModels("models:\n- local-model\n  reasoning: levels=high; can_disable=yes\n");
  expect(out.models[0]!.provider).toBe("local-model");
  expect(out.models[0]!.modelId).toBe("local-model");
});

test("parseModels > a model with no reasoning line has undefined thinkingLevels", () => {
  const out = parseModels("models:\n- base-model\n  provider: base-model\n");
  expect(out.models[0]!.thinkingLevels).toBeUndefined();
});

test("parseModels > reasoning levels strip the (default) marker and trim whitespace", () => {
  const out = parseModels(
    "models:\n- m1\n  reasoning: effort set=x; levels= minimal (default),  high , none ; can_disable=yes\n",
  );
  expect(out.models[0]!.thinkingLevels).toEqual(["minimal", "high", "none"]);
});

test("parseModels > empty output yields no models and null defaults", () => {
  const { models, defaultModel, defaultSmallModel } = parseModels("");
  expect(models).toEqual([]);
  expect(defaultModel).toBeNull();
  expect(defaultSmallModel).toBeNull();
});

test("parseModels > a malformed header line (no id after dash) is skipped", () => {
  const out = parseModels("models:\n- \n- good-model\n  provider: good-model\n");
  expect(out.models).toHaveLength(1);
  expect(out.models[0]!.modelId).toBe("good-model");
});

test("parseModels > CRLF line endings are handled", () => {
  const crlf = REAL_OUTPUT.replace(/\n/g, "\r\n");
  const { models, defaultModel } = parseModels(crlf);
  expect(defaultModel).toBe("umans/umans-glm-5.2");
  expect(models).toHaveLength(2);
  expect(models[0]!.thinkingLevels).toEqual(["high", "max", "none"]);
});

test("parseModels > a dash-bulleted line BEFORE the models: section is not a model", () => {
  // A future `polytoken models` that prints a preamble or another dash-bulleted
  // section above `models:` must not be absorbed as spurious models.
  const out = parseModels(
    "notes:\n- this is not a model\nmodels:\n- real-model\n  provider: real-model\n",
  );
  expect(out.models).toHaveLength(1);
  expect(out.models[0]!.modelId).toBe("real-model");
});

test("parseModels > no models: section yields no models", () => {
  // Output with default markers but no models: section — no spurious models.
  const out = parseModels(
    "default_model: umans/umans-glm-5.2\n- stray dash line\n",
  );
  expect(out.models).toEqual([]);
  expect(out.defaultModel).toBe("umans/umans-glm-5.2");
});
