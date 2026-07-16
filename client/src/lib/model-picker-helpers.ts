import type { ModelOption } from "@pantoken/protocol";

/** Canonical ordering for effort levels, lowest to highest. Unknown levels
 *  sort after all known ones, preserving their relative catalog order. */
const EFFORT_ORDER = [
  "off",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Sort effort levels from low to high using the canonical EFFORT_ORDER.
 *  Unknown levels go last, preserving their relative order (stable sort).
 *  Returns a new array; does not mutate the input. */
export function sortEfforts(levels: readonly string[]): string[] {
  return [...levels].sort((a, b) => {
    const ai = EFFORT_ORDER.indexOf(a as (typeof EFFORT_ORDER)[number]);
    const bi = EFFORT_ORDER.indexOf(b as (typeof EFFORT_ORDER)[number]);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
  });
}

/** Whether `query` is a subsequence of `target` (fuzzy match, case-insensitive).
 *  Reused from directory-picker.ts. */
function fuzzyMatch(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

export interface RankedModel {
  model: ModelOption;
  /** Substring match (higher rank than a pure subsequence match). */
  substring: boolean;
}

/** Rank models by query: substring matches first, then subsequence (fuzzy)
 *  matches, preserving catalog order for ties. An empty query returns every
 *  model unranked (substring=false). */
export function rankModels(
  models: readonly ModelOption[],
  query: string,
): RankedModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models.map((model) => ({ model, substring: false }));
  return models
    .map((model, order) => {
      const label = model.label.toLowerCase();
      const id = model.modelId.toLowerCase();
      const provider = model.provider.toLowerCase();
      const substring =
        label.includes(q) || id.includes(q) || provider.includes(q);
      const fuzzy =
        fuzzyMatch(q, label) || fuzzyMatch(q, id) || fuzzyMatch(q, provider);
      return { model, substring, fuzzy, order };
    })
    .filter((entry) => entry.fuzzy)
    .sort((a, b) => Number(b.substring) - Number(a.substring) || a.order - b.order)
    .map(({ model, substring }) => ({ model, substring }));
}
