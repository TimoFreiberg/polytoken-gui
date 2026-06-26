// C1: warmUp must resolve the `backgroundModel` setting SERVER-SIDE (via
// `resolveBackgroundModel`, the SAME resolver hub.ts Settings validation uses) and
// reconstruct a PLAIN `provider/id[:thinking]` spec for the `background-model` flag — so
// a `script:` setting resolves to a real model instead of being threaded verbatim (the
// session-namer extension's `resolveSpec` does NOT handle `script:`; threading it raw
// made Settings green + runtime broken, failing silently per-prompt).
//
// `reconstructPlainSpec` IS the production reconstruction `warmUp` calls (no hand-copied
// mirror — round-2 review flagged that anti-pattern). This test drives the real pipeline:
// resolve (incl. running a `script:` spec) → `reconstructPlainSpec` → a plain spec the
// extension would accept. Locks the parity between Settings-validation and runtime the
// extension's docstring claims.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  asBackgroundModelRegistry,
  reconstructPlainSpec,
  resolveBackgroundModel,
  type ModelLike,
} from "./background-model.js";

const MODELS: ModelLike[] = [
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
];

// Drive the REAL pipeline warmUp uses: resolve the setting (running any `script:` spec),
// then reconstruct the plain spec via the shared `reconstructPlainSpec`. Returns
// undefined when there's no resolved model (unset/non-resolving) → warmUp threads
// nothing and the extension no-ops.
function resolveAndReconstruct(
  setting: string | null | undefined,
  models: ModelLike[] = MODELS,
): string | undefined {
  const registry = asBackgroundModelRegistry({ getAvailable: () => models });
  return reconstructPlainSpec(resolveBackgroundModel(setting, registry));
}

function scriptThatPrints(spec: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pilot-c1-"));
  const p = join(dir, "resolve.sh");
  writeFileSync(p, `#!/bin/sh\nprintf '%s' "${spec}"\n`, { mode: 0o755 });
  return `script:${p}`;
}

describe("C1: warmUp resolves the script: spec server-side + threads a plain spec", () => {
  test("a script: spec resolving a model → plain provider/id (no script: leaks)", () => {
    const spec = resolveAndReconstruct(
      scriptThatPrints("anthropic/claude-haiku-4-5"),
    );
    // The extension's resolveSpec accepts exactly this shape; a `script:` prefix would
    // be threaded verbatim (pre-C1 bug) and never resolve. Assert no `script:` leaks.
    expect(spec).toBe("anthropic/claude-haiku-4-5");
    expect(spec).not.toMatch(/^script:/);
  });

  test("a script: spec resolving a model WITH a thinking level → provider/id:thinking", () => {
    expect(
      resolveAndReconstruct(scriptThatPrints("anthropic/claude-haiku-4-5:low")),
    ).toBe("anthropic/claude-haiku-4-5:low");
  });

  test("a plain (non-script) spec → already plain, reconstructed identically", () => {
    // Plain specs pay zero spawn cost (resolveBackgroundModel's parseSpec is pure) and
    // reconstruct to the same canonical form.
    expect(resolveAndReconstruct("anthropic/claude-haiku-4-5")).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(resolveAndReconstruct("anthropic/claude-haiku-4-5:low")).toBe(
      "anthropic/claude-haiku-4-5:low",
    );
  });

  test("unset (null) setting → threads nothing (extension no-ops)", () => {
    expect(resolveAndReconstruct(null)).toBeUndefined();
    expect(resolveAndReconstruct("   ")).toBeUndefined();
  });

  test("a non-resolving script: spec (no model) → threads nothing (not a bad raw value)", () => {
    // Pre-C1 this threaded the raw `script:...` string, which the extension then failed
    // on. With C1 a non-resolving spec yields no model → thread nothing → extension's
    // unset/no-op path. Settings shows the same warning (parity), runtime no-ops cleanly.
    expect(
      resolveAndReconstruct(scriptThatPrints("anthropic/nope-9-9")),
    ).toBeUndefined();
  });

  test("asBackgroundModelRegistry passes the registry slice through", () => {
    // The adapter C1 re-added: a {getAvailable()}-shaped object (incl. a real
    // ModelRegistry) maps to the resolver's BackgroundModelRegistry slice unchanged.
    const models = MODELS;
    const adapted = asBackgroundModelRegistry({ getAvailable: () => models });
    expect(adapted.getAvailable()).toBe(models);
  });
});
