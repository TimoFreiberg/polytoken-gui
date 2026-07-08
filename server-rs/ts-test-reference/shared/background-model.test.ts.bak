import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBackgroundModel,
  type BackgroundModelRegistry,
  type ModelLike,
} from "./background-model.js";

// A couple of known models — mirrors the shape getAvailable() returns
// (provider/id/name), without needing a real AuthStorage + models.json. Covers the
// canonical `provider/id`, bare-id, and thinking-suffix paths.
const MODELS: ModelLike[] = [
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
];

function registry(models: ModelLike[] = MODELS): BackgroundModelRegistry {
  return {
    getAvailable: () => models,
  };
}

describe("resolveBackgroundModel — null / unset", () => {
  test("null → no model, no warning (callers fall back, not an error)", () => {
    const r = resolveBackgroundModel(null, registry());
    expect(r.model).toBeUndefined();
    expect(r.thinkingLevel).toBeUndefined();
    expect(r.warning).toBeUndefined();
  });

  test("empty / whitespace-only string → treated as unset", () => {
    for (const spec of ["", "   ", "\t"]) {
      const r = resolveBackgroundModel(spec, registry());
      expect(r.warning).toBeUndefined();
      expect(r.model).toBeUndefined();
    }
  });
});

describe("resolveBackgroundModel — good spec", () => {
  test("canonical provider/model resolves", () => {
    const r = resolveBackgroundModel("anthropic/claude-haiku-4-5", registry());
    expect(r.model).toEqual(MODELS[0]);
    expect(r.warning).toBeUndefined();
    expect(r.thinkingLevel).toBeUndefined();
  });

  test("provider/model:thinking resolves with the level", () => {
    const r = resolveBackgroundModel("anthropic/claude-haiku-4-5:low", registry());
    expect(r.model).toEqual(MODELS[0]);
    expect(r.thinkingLevel).toBe("low");
    expect(r.warning).toBeUndefined();
  });

  test("bare id resolves when unambiguous", () => {
    const r = resolveBackgroundModel("gpt-5", registry());
    expect(r.model).toEqual(MODELS[2]);
    expect(r.warning).toBeUndefined();
  });

  test("off thinking level is honoured", () => {
    const r = resolveBackgroundModel("anthropic/claude-sonnet-4-6:off", registry());
    expect(r.model).toEqual(MODELS[1]);
    expect(r.thinkingLevel).toBe("off");
  });
});

describe("resolveBackgroundModel — bad spec (loud warning)", () => {
  test("model not in the registry → warning, no model", () => {
    const r = resolveBackgroundModel("anthropic/claude-opus-9-9", registry());
    expect(r.model).toBeUndefined();
    expect(r.warning).toMatch(/No registered model matches/);
  });

  test("invalid thinking level on a RESOLVING prefix → model + non-fatal warning (scope-warn)", () => {
    // The prefix `anthropic/claude-haiku-4-5` resolves, so the scope-warn path returns
    // the model with the bad `:thinking` level DROPPED + a non-fatal warning. Settings
    // thus agrees with runtime (the model works; the suffix is just noted), instead of
    // rejecting a spec the runtime would happily use.
    const r = resolveBackgroundModel("anthropic/claude-haiku-4-5:banana", registry());
    expect(r.model).toEqual(MODELS[0]);
    expect(r.thinkingLevel).toBeUndefined();
    expect(r.warning).toMatch(/Invalid thinking level "banana" in spec ".*" — dropped/);
  });

  test("invalid thinking level on a NON-resolving prefix → fatal warning, no model", () => {
    // The prefix doesn't resolve either: the missing model is the real problem, the bad
    // suffix is moot, so the resolver returns no model + the inner (fatal) warning.
    const r = resolveBackgroundModel("anthropic/nope-9-9:banana", registry());
    expect(r.model).toBeUndefined();
    expect(r.warning).toMatch(/No registered model matches/);
  });

  test("ambiguous bare id falls back to partial match (tryMatchModel)", () => {
    // Two providers ship a model with id "dupe". An exact bare-id match is ambiguous and
    // rejected, BUT tryMatchModel then falls back to a partial (substring) match and
    // picks an alias — so a bare ambiguous id is NOT a loud warning. The
    // loud-reject-on-ambiguity holds for the canonical form below.
    const dup = [
      { provider: "anthropic", id: "dupe" },
      { provider: "openai", id: "dupe" },
    ];
    const r = resolveBackgroundModel("dupe", registry(dup));
    expect(r.model).toBeDefined();
    expect(r.warning).toBeUndefined();
  });

  test("canonical provider/id with a real collision → warning (no silent pick)", () => {
    // The SAME canonical `provider/id` appearing twice (shouldn't happen, but if a
    // custom provider double-registers) is ambiguous and rejected loud.
    const dup = [
      { provider: "anthropic", id: "dupe" },
      { provider: "anthropic", id: "dupe" },
    ];
    const r = resolveBackgroundModel("anthropic/dupe", registry(dup));
    expect(r.model).toBeUndefined();
    expect(r.warning).toMatch(/No registered model matches/);
  });
});

describe("resolveBackgroundModel — script: path", () => {
  test("runs the script, parses stdout as a spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-bg-"));
    const scriptPath = join(dir, "resolve.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\necho "anthropic/claude-haiku-4-5:low"\n`,
      { mode: 0o755 },
    );
    const r = resolveBackgroundModel(`script:${scriptPath}`, registry());
    expect(r.model).toEqual(MODELS[0]);
    expect(r.thinkingLevel).toBe("low");
    expect(r.warning).toBeUndefined();
  });

  test("script that prints a bad spec → warning (loud, not silent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-bg-"));
    const scriptPath = join(dir, "bad.sh");
    writeFileSync(scriptPath, `#!/bin/sh\necho "anthropic/nope-not-a-model"\n`, {
      mode: 0o755,
    });
    const r = resolveBackgroundModel(`script:${scriptPath}`, registry());
    expect(r.model).toBeUndefined();
    expect(r.warning).toMatch(/No registered model matches/);
  });

  test("script that exits non-zero → warning naming the script + exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-bg-"));
    const scriptPath = join(dir, "fail.sh");
    writeFileSync(scriptPath, `#!/bin/sh\necho "oops" >&2\nexit 3\n`, {
      mode: 0o755,
    });
    const r = resolveBackgroundModel(`script:${scriptPath}`, registry());
    expect(r.model).toBeUndefined();
    expect(r.warning).toMatch(/exited 3/);
  });

  test("missing script → warning (no crash)", () => {
    const r = resolveBackgroundModel(
      `script:${join(tmpdir(), "pilot-does-not-exist-" + process.pid)}.sh`,
      registry(),
    );
    expect(r.model).toBeUndefined();
    expect(r.warning).toMatch(/Failed to run background-model script/);
  });

  test("script that prints nothing → warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-bg-"));
    const scriptPath = join(dir, "empty.sh");
    writeFileSync(scriptPath, `#!/bin/sh\ntrue\n`, { mode: 0o755 });
    const r = resolveBackgroundModel(`script:${scriptPath}`, registry());
    expect(r.warning).toMatch(/printed no spec/);
  });
});
