// Resolve pilot's "background model" setting to a concrete model + thinking level,
// with a loud `warning` channel for bad specs. This is what pilot's own extensions
// (session auto-naming, the answer tool's structured-extraction) will use for their
// cheap out-of-band LLM calls — replacing the dotfiles `_lib/roles.mjs` per-role
// resolver. Chunk 1 ships the resolver + Settings validation; the extensions read it
// at runtime via the `background-model` extension flag (threaded in pi-driver warmUp)
// + `ctx.modelRegistry` (Chunks 2/4).
//
// WHY PI's parseModelPattern ISN'T USED: the plan (D2) called for reusing pi's
// `parseModelPattern(spec, modelRegistry.getModels())` from
// `~/src/pi/.../core/model-resolver.ts`. That function is marked `@internal Exported
// for testing` and is NOT re-exported by the published `@earendil-works/pi-coding-agent`
// package (only `.` is exported, sans this fn); `Model<Api>` / `ThinkingLevel` aren't
// exported either, so the return type can't even be named across the boundary.
// Reimplementing the cheap spec parser here is the only stable, type-safe path, and it
// matches the runtime contract the ported extensions will use: the dotfiles `roles.mjs`
// resolves via `parseSpec()` + `registry.find(provider, modelId)` (both PUBLIC pi API),
// NOT via pi's internal `parseModelPattern`. So this resolver mirrors `parseSpec`'s
// spec grammar + `ModelRegistry.getAvailable()` for matching — public surface only.
//
// PARITY WITH PI (precise — not a blanket claim): the MATCHING semantics track pi so a
// spec resolves to the SAME model here as at runtime — exact/canonical reference, partial
// (substring) match with alias-vs-dated preference (`tryMatchModel`), valid `:thinking`
// suffixes, AND the invalid-thinking scope-warn path (recurse on the prefix; if it
// resolves, return the model with the bad level dropped + a non-fatal warning). The
// WARNING channel is pilot's own, stricter surfacing: pi is silent on a no-match (returns
// no model, no warning), but pilot warns so the operator sees a bad spec in Settings — a
// deliberate divergence in surfacing only (the model a spec resolves to still agrees;
// pi's no-match yields neither, pilot's yields no model + a warning). The `script:` path
// has no pi analogue.

import { spawnSync } from "node:child_process";

/** The resolved background model. `model` is undefined when the spec is unset (null) or
 *  doesn't resolve to a registered model. `warning` is a human-readable note the Settings
 *  UI surfaces (red): a FATAL warning (no `model`) means the spec didn't resolve; a
 *  NON-FATAL warning (alongside a resolved `model`) means the model resolved but
 *  something is off (e.g. an invalid `:thinking` suffix was dropped). `model` and
 *  `warning` CAN both be set (non-fatal case); a fatal warning stands alone. */
export interface ResolvedBackgroundModel {
  /** The matched model object (carries provider/id/name/...), or undefined. Opaque to
   *  pilot — the extensions hand it straight to pi's stream API. */
  model?: unknown;
  /** pi thinking level (`off`|`minimal`|`low`|`medium`|`high`|`xhigh`) when one was
   *  parsed from a `:thinking` suffix, else undefined (use the model/provider default). */
  thinkingLevel?: string;
  /** Note channel surfaced to the Settings UI. FATAL (no `model`): the spec didn't
   *  resolve. NON-FATAL (with `model`): the model resolved but something's off (e.g. an
   *  invalid `:thinking` level was dropped). undefined when the spec is unset or
   *  resolved cleanly. */
  warning?: string;
}

/** A read-only slice of `ModelRegistry` — the only matching primitive the resolver
 *  needs (the unused `find` was dropped in the S1 cleanup). Declared locally so unit
 *  tests can pass a hand-rolled fake without constructing a real `ModelRegistry` (which
 *  wants an `AuthStorage` + models.json). */
export interface BackgroundModelRegistry {
  /** Models with working credentials (the ones actually usable). Mirrors
   *  `ModelRegistry.getAvailable()` — the only matching primitive the resolver needs. */
  getAvailable(): readonly ModelLike[];
}

/** Adapt pi's `ModelRegistry` (or any `{getAvailable()}`-shaped object) to the resolver's
 *  `BackgroundModelRegistry` slice. The resolver only needs `getAvailable()`, so this is a
 *  thin passthrough. `pi-driver.ts` `warmUp` is its single production caller (it
 *  resolves the `backgroundModel` setting before threading it into the `background-model`
 *  extension flag — see Chunk 2's C1 fix). `hub.ts` Settings validation hand-rolls its own
 *  inline adapter over the wire `ModelOption` cache instead (different model source);
 *  this adapter was dropped as dead in Chunk 1's S1 cleanup once that happened, then
 *  re-added when `warmUp` became a real caller. */
export function asBackgroundModelRegistry<
  T extends { getAvailable(): readonly ModelLike[] },
>(registry: T): BackgroundModelRegistry {
  return { getAvailable: () => registry.getAvailable() };
}

/** Reconstruct a plain `provider/model[:thinking]` spec string from a resolved
 *  background model. `warmUp` calls this after `resolveBackgroundModel` so the
 *  `background-model` extension flag carries a plain spec (not a raw `script:` path) —
 *  the ported extensions read it + resolve via `ctx.modelRegistry` themselves. Exported
 *  so `warmUp` and its test share ONE reconstruction (not a hand-copied duplicate that
 *  silently drifts). Returns undefined when the resolution has no model (unset or
 *  non-resolving) → the caller threads nothing and the extension no-ops. */
export function reconstructPlainSpec(
  resolved: ResolvedBackgroundModel,
): string | undefined {
  if (!resolved.model) return undefined;
  // `model` is typed `unknown` (pi's `Model<Api>` isn't exported); cast through the
  // structural `ModelLike` shape the matcher already uses.
  const m = resolved.model as ModelLike;
  return `${m.provider}/${m.id}${
    resolved.thinkingLevel ? `:${resolved.thinkingLevel}` : ""
  }`;
}

/** The model fields the matcher reads. A structural slice of pi's `Model<Api>` — kept
 *  loose (no `Api` typing, since that's not exported) so pilot doesn't couple to the
 *  full model shape. `name` is optional because custom/user models may omit it. */
export interface ModelLike {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

/** pi's thinking-level ladder (incl. `off`). Mirrors pi's `VALID_THINKING_LEVELS` /
 *  `ThinkingLevelMap` — a spec's `:thinking` suffix must be one of these or it's a
 *  warning (matching pi's `isValidThinkingLevel`). Pilot's Settings `DEFAULT_THINKING_LEVELS`
 *  is the same set. */
const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Prefix marking a spec as a script to run (its stdout is then parsed as a spec).
 *  Mirrors the dotfiles convention; lets an operator keep their own resolver. */
const SCRIPT_PREFIX = "script:";

/** A model id is an "alias" (stable, e.g. `claude-sonnet-4-5`) rather than a dated
 *  version (`claude-sonnet-4-5-20250929`) or a `-latest` tag. Aliases are preferred
 *  when a bare-id pattern matches several versions — tracks pi's `isAlias`. */
function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/.test(id);
}

/** Find an exact model reference match. Supports either a bare model id or a canonical
 *  `provider/modelId` reference. Bare-id matches are rejected when ambiguous across
 *  providers (so a bare `gpt-4` that two providers ship resolves to nothing, not a
 *  silent pick). Tracks pi's `findExactModelReferenceMatch`. */
function findExactModelReferenceMatch(
  reference: string,
  models: readonly ModelLike[],
): ModelLike | undefined {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();

  // Canonical `provider/id` exact match.
  const canonical = models.filter(
    (m) => `${m.provider}/${m.id}`.toLowerCase() === lower,
  );
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined; // ambiguous

  // `provider/id` with different casing/components.
  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const provider = trimmed.slice(0, slash).trim();
    const modelId = trimmed.slice(slash + 1).trim();
    if (provider && modelId) {
      const pm = models.filter(
        (m) =>
          m.provider.toLowerCase() === provider.toLowerCase() &&
          m.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (pm.length === 1) return pm[0];
      if (pm.length > 1) return undefined;
    }
  }

  // Bare id exact match (ambiguous across providers → reject).
  const byId = models.filter((m) => m.id.toLowerCase() === lower);
  return byId.length === 1 ? byId[0] : undefined;
}

/** Match a pattern to a model: exact reference first, then a partial (id-or-name)
 *  substring match preferring aliases over dated versions. Tracks pi's `tryMatchModel`. */
function tryMatchModel(
  pattern: string,
  models: readonly ModelLike[],
): ModelLike | undefined {
  const exact = findExactModelReferenceMatch(pattern, models);
  if (exact) return exact;

  const lower = pattern.toLowerCase();
  const matches = models.filter(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      m.name?.toLowerCase().includes(lower),
  );
  if (matches.length === 0) return undefined;

  const aliases = matches.filter((m) => isAlias(m.id));
  const dated = matches.filter((m) => !isAlias(m.id));
  const pool = aliases.length > 0 ? aliases : dated;
  // Highest-sorting id wins (aliases: the alias itself; dated: the latest date).
  pool.sort((a, b) => b.id.localeCompare(a.id));
  return pool[0];
}

/** Parse a `provider/model[:thinking]` spec against the available models. Returns
 *  `{model, thinkingLevel}` on a clean resolve, `{model, warning}` when the model resolves
 *  but a `:thinking` suffix was invalid (dropped — non-fatal, matches pi's scope-warn
 *  path), or `{warning}` (no model) when the spec doesn't resolve (a fatal warning so the
 *  operator sees a bad spec; `null`/unset is the only true no-op). Tracks pi's
 *  `parseModelPattern` colon-splitting + thinking-level rules. */
function parseSpec(
  spec: string,
  registry: BackgroundModelRegistry,
): ResolvedBackgroundModel {
  const available = registry.getAvailable();

  // Exact (incl. canonical `provider/id`) match first — no thinking suffix to consider.
  const exact = tryMatchModel(spec, available);
  if (exact) return { model: exact };

  // No exact match: if there's a `:thinking` suffix, split on the LAST colon (after any
  // provider slash) and recurse on the prefix — mirroring pi's algorithm so a model id
  // that itself contains a colon (rare) still needs an explicit slash to disambiguate.
  const colon = spec.lastIndexOf(":");
  const slash = spec.indexOf("/");
  if (colon !== -1 && colon > slash) {
    const suffix = spec.slice(colon + 1);
    const prefix = spec.slice(0, colon);
    if (
      VALID_THINKING_LEVELS.includes(
        suffix as (typeof VALID_THINKING_LEVELS)[number],
      )
    ) {
      const inner = parseSpec(prefix, registry);
      if (inner.model) {
        // Only honour the thinking level when the prefix resolved cleanly.
        return { model: inner.model, thinkingLevel: suffix };
      }
      // Prefix didn't resolve either — fall through to the not-found warning below,
      // reporting the FULL spec so the operator sees what they typed.
    } else {
      // Invalid thinking level. Mirror pi's scope-warn path
      // (`allowInvalidThinkingLevelFallback`): recurse on the prefix. If it resolves,
      // return the model with the bad level DROPPED + a non-fatal warning (so Settings
      // agrees with runtime — the model works, the suffix is just noted). If the prefix
      // doesn't resolve, return the inner result's warning (no model): the missing model
      // is the real problem, the bad suffix is moot.
      const inner = parseSpec(prefix, registry);
      if (inner.model) {
        return {
          model: inner.model,
          warning: `Invalid thinking level "${suffix}" in spec "${spec}" — dropped; valid: ${VALID_THINKING_LEVELS.join(", ")}.`,
        };
      }
      return {
        // Name the FULL spec (incl. the bad suffix) so the operator sees everything
        // they typed — the missing model is the real problem, but the bad suffix is moot
        // only AFTER a model resolves; until then both are wrong and both should show.
        warning: `No registered model matches "${spec}" (invalid thinking level "${suffix}" dropped; valid: ${VALID_THINKING_LEVELS.join(", ")}).`,
      };
    }
  }

  // Well-formed but matches nothing registered.
  return {
    warning: `No registered model matches "${spec}". Check the provider/model id, or connect the provider first.`,
  };
}

/** Run a `script:`-prefixed path, capture stdout, and parse it as a spec. The script is
 *  the operator's escape hatch (keep using roles.mjs, or any resolver). Failures are
 *  loud — a script that errors or prints nothing usable is a `warning`, never a silent
 *  no-op. Uses spawnSync (blocking) — fine for a Settings-panel validation call, not a
 *  hot path. */
function resolveScriptSpec(
  scriptPath: string,
  registry: BackgroundModelRegistry,
): ResolvedBackgroundModel {
  try {
    const res = spawnSync(scriptPath, [], {
      encoding: "utf8",
      // Don't inherit the server's stdio — capture stdout only. A script that needs
      // env inherits process.env (so it can read PI_ROLE_* etc., like roles.mjs does).
      env: process.env,
      timeout: 5000,
    });
    if (res.error) {
      return {
        warning: `Failed to run background-model script "${scriptPath}": ${res.error.message}`,
      };
    }
    if (res.status !== 0) {
      const stderr = res.stderr?.trim();
      return {
        warning: `Background-model script "${scriptPath}" exited ${res.status}${stderr ? `: ${stderr}` : ""}`,
      };
    }
    const stdout = res.stdout?.trim();
    if (!stdout) {
      return {
        warning: `Background-model script "${scriptPath}" printed no spec to stdout.`,
      };
    }
    // The script's stdout is itself a spec string — recurse via parseSpec.
    return parseSpec(stdout, registry);
  } catch (e) {
    return {
      warning: `Error running background-model script "${scriptPath}": ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Resolve the `backgroundModel` setting. The single entry point: handles `null`
 *  (unset → no-op), `script:` paths (run → parse stdout), and plain specs (parse
 *  against the registry). Always returns a `ResolvedBackgroundModel`; the caller
 *  surfaces `warning` to the UI. Never throws — bad specs are `warning`s, not crashes. */
export function resolveBackgroundModel(
  backgroundModel: string | null | undefined,
  registry: BackgroundModelRegistry,
): ResolvedBackgroundModel {
  const spec = backgroundModel?.trim() || null;
  if (spec === null) return {}; // unset — extensions fall back; not an error.
  if (spec.startsWith(SCRIPT_PREFIX)) {
    return resolveScriptSpec(spec.slice(SCRIPT_PREFIX.length).trim(), registry);
  }
  return parseSpec(spec, registry);
}
