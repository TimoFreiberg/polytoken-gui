// Parsing `polytoken models` text output into pilot's `ModelOption[]`.
//
// `polytoken models` prints a human-readable config dump (NOT JSON — there's no
// --format flag on this subcommand). The shape (observed, polytoken 0.3.3):
//
//   default_model: umans/umans-glm-5.2
//   default_small_model: umans/umans-flash
//
//   models:
//   - deepseek/deepseek-v4-pro
//     provider: deepseek/deepseek-v4-pro
//     variant: claude
//     tool_loading: eager
//     reasoning: effort set=deepseek_v4; levels=high (default), max, none; can_disable=yes
//     selectable: deepseek/deepseek-v4-pro, deepseek/deepseek-v4-pro(none), deepseek/deepseek-v4-pro(high), deepseek/deepseek-v4-pro(max)
//
// The model id is the `- <id>` header line; `provider` is often == the id; `selectable`
// is a comma-separated list of `<id>` / `<id>(<reasoning_level>)` variants. The
// reasoning `levels` (minus the `(default)` marker) are the model's thinking levels.
//
// This is a pure parser over the text — unit-testable without invoking the binary.
// The driver shells out to `polytoken models` and hands the stdout here.

import type { ModelOption } from "@pilot/protocol";

/** The parsed `polytoken models` output: the model list + the two default markers.
 *  The defaults are NOT ModelOptions — they're config markers (`default_model` /
 *  `default_small_model`) the Settings panel may surface later; the model list is what
 *  the picker renders. */
export interface ParsedModels {
  models: ModelOption[];
  defaultModel: string | null;
  defaultSmallModel: string | null;
}

/** Parse a `reasoning:` line's levels list into thinking levels.
 *  Input shape: `effort set=<set>; levels=high (default), max, none; can_disable=yes`
 *  → extract the `levels=` segment, strip the `(default)` marker, split on `,`, trim.
 *  Returns [] when the segment is absent (a non-reasoning model). */
function parseReasoningLevels(reasoningLine: string): string[] {
  const levelsMatch = reasoningLine.match(/levels=([^;]+)/);
  if (!levelsMatch?.[1]) return [];
  return levelsMatch[1]
    .split(",")
    .map((l) => l.replace(/\s*\(default\)\s*/i, "").trim())
    .filter(Boolean);
}

/** Parse `polytoken models` text output into `ModelOption[]` (+ default markers).
 *  Pure — no I/O. Loud on a malformed header line: a model block that doesn't start
 *  with `- <id>` is skipped (never crashes the whole list on one bad entry). */
export function parseModels(stdout: string): ParsedModels {
  const lines = stdout.split("\n");
  let defaultModel: string | null = null;
  let defaultSmallModel: string | null = null;
  const models: ModelOption[] = [];

  // Track the current model block as we walk the lines. A block starts at
  // `- <id>` (indented 0 under `models:`) and its fields are indented further.
  let currentId: string | null = null;
  let currentProvider: string | null = null;
  let currentReasoning: string | null = null;
  // Only treat `- <id>` lines as model headers once we've seen the `models:`
  // section marker. A future `polytoken models` that prints a preamble or another
  // dash-bulleted section (e.g. `providers:`) above `models:` would otherwise be
  // misparsed as spurious models. Set on the bare `models:` line; stays true after.
  let inModelsSection = false;

  const flush = () => {
    if (currentId === null) return;
    models.push({
      // The model id (e.g. `deepseek/deepseek-v4-pro`) already carries its provider
      // prefix; polytoken's `provider:` field is often identical. Split on the first
      // `/` so pilot's provider-grouped picker gets a sensible group key — but fall
      // back to the whole id when there's no slash (split returns the whole string
      // as [0] when there's no separator, so no separate fallback is needed).
      provider: currentProvider ?? currentId.split("/")[0]!,
      modelId: currentId,
      label: currentId,
      thinkingLevels:
        currentReasoning !== null ? parseReasoningLevels(currentReasoning) : undefined,
    });
    currentId = null;
    currentProvider = null;
    currentReasoning = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // Top-level default markers (no leading indent).
    const defaultMatch = line.match(/^default_model:\s*(\S+)/);
    if (defaultMatch?.[1]) {
      defaultModel = defaultMatch[1];
      continue;
    }
    const defaultSmallMatch = line.match(/^default_small_model:\s*(\S+)/);
    if (defaultSmallMatch?.[1]) {
      defaultSmallModel = defaultSmallMatch[1];
      continue;
    }
    // The `models:` section marker — a bare top-level line. Everything below it
    // (until EOF) is model blocks. `trim()` aligns with the default-marker regexes'
    // whitespace tolerance (a future output with trailing whitespace stays correct).
    if (line.trim() === "models:") {
      inModelsSection = true;
      continue;
    }
    // A new model block: `- <id>` (only recognized inside the models: section).
    const headerMatch = line.match(/^-\s+(\S+)/);
    if (inModelsSection && headerMatch?.[1]) {
      flush();
      currentId = headerMatch[1];
      continue;
    }
    if (currentId === null) continue;
    // Field lines are indented further than the `- ` header.
    const providerMatch = line.match(/^\s+provider:\s*(\S+)/);
    if (providerMatch?.[1]) {
      currentProvider = providerMatch[1];
      continue;
    }
    const reasoningMatch = line.match(/^\s+reasoning:\s*(.*)$/);
    if (reasoningMatch?.[1]) {
      currentReasoning = reasoningMatch[1];
      continue;
    }
  }
  flush();
  return { models, defaultModel, defaultSmallModel };
}

/** Split a full `provider/id` registry name into the picker's {provider, modelId}
 *  shape. `modelId` stays the FULL registry name (polytoken's POST /model key),
 *  NOT the bare id — see setModel notes. Falls back to the whole string as both
 *  when there's no slash (mirrors parseModels' provider fallback). */
export function defaultModelRef(marker: string): {
  provider: string;
  modelId: string;
} {
  const slash = marker.indexOf("/");
  if (slash < 0) return { provider: marker, modelId: marker };
  return { provider: marker.slice(0, slash), modelId: marker };
}

/** The model string to POST to /model. Polytoken's ModelConfig.name (the registry
 *  key) is the FULL `provider/id`, which is exactly what ModelOption.modelId and
 *  the default markers already carry — so the POST key IS the modelId, unmodified.
 *  (Contrast pi, where modelId is bare and the driver joins provider/modelId for
 *  modelRegistry.find.) Centralized here so setModel/newSession share one tested
 *  path instead of each inlining a (previously buggy) `${provider}/${modelId}` join. */
export function modelPostKey(modelId: string): string {
  return modelId;
}

/** Synthesize ModelOption entries for default-marker models that aren't already
 *  in the parsed models list (catalog providers whose models appear only as
 *  default_model markers, not as models: blocks).
 *  Temporary: remove once polytoken models lists catalog models natively. */
export function synthesizeDefaultModels(parsed: ParsedModels): ModelOption[] {
  const existing = new Set(parsed.models.map((m) => m.modelId));
  const out: ModelOption[] = [];
  for (const marker of [parsed.defaultModel, parsed.defaultSmallModel]) {
    if (!marker || existing.has(marker)) continue;
    const { provider, modelId } = defaultModelRef(marker);
    out.push({ provider, modelId, label: modelId, thinkingLevels: undefined });
  }
  return out;
}
