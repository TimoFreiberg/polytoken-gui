// Chunk 2 (docs/PLAN-self-contained-extensions.md): the ported session-namer is
// pilot's first real owned extension. Replaces the Chunk-0 spike test (which proved the
// `additionalExtensionPaths` load mechanism against a throwaway no-op). This drives the
// REAL pi `DefaultResourceLoader` with the session-namer path — the exact code path
// pi-driver.ts `warmUp` hands it — pointed at a throwaway agentDir (no `.pi/extensions`,
// so nothing else loads) and asserts:
//   a. the extension loads (no error) and exports a valid factory;
//   b. it registers the `background-model` flag (the D2/[OPEN F] channel the extension
//      reads pilot's backgroundModel setting through);
//   c. pi stamps the `additionalExtensionPaths` source metadata
//      (source:"cli", scope:"temporary", origin:"top-level") — the raw shape the
//      driver's `listExtensions` re-projects to source:"Pilot" (D3);
//   d. the frontmatter `@pilot` block parses to the expected description (D3).
//
// The mock driver never calls createAgentSessionServices, so a mock-driver e2e can't
// exercise the `additionalExtensionPaths` wiring — driving the real loader is the
// faithful substitute (same as the spike test it replaces). The extension's runtime
// behaviour (resolving the spec, streaming, setting the name) needs a live pi session +
// model auth and is out of unit reach; the failure-philosophy guards are reviewed in the
// source, not asserted here.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// The same pilot-owned, repo-root-absolute resolution pi-driver.ts uses (it builds its
// PILOT_OWNED_EXTENSIONS map from PILOT_OWNED_EXTENSION_NAMES the same way). Hardcoded
// here rather than imported because the path map isn't exported from pi-driver.ts — and
// re-exporting an internal path constant would outlive its purpose. If these drift, the
// driver's listExtensions (which reads the same file) would surface a load error first.
const NAMER_PATH = resolve(
  import.meta.dir,
  "../../../pilot/extensions/session-namer.ts",
);

// A throwaway agentDir with NO `.pi/extensions` — so user-scope auto-discovery finds
// nothing and only the session-namer (via additionalExtensionPaths) loads. Built per
// test so settings never leak across cases.
function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-namer-test-"));
}

describe("Chunk 2: session-namer pilot extension via additionalExtensionPaths", () => {
  test("(a) the extension loads and exports a valid factory", async () => {
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [NAMER_PATH],
    });
    await loader.reload();

    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);

    const namer = extensions.find((e) => e.path === NAMER_PATH);
    expect(namer).toBeDefined();
    // A factory was called (the `flags` Map is populated by registerFlag inside it).
    expect(namer?.flags.size).toBeGreaterThan(0);
  });

  test("(b) it registers the `background-model` flag (the D2/[OPEN F] channel)", async () => {
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [NAMER_PATH],
    });
    await loader.reload();

    const namer = loader.getExtensions().extensions.find(
      (e) => e.path === NAMER_PATH,
    );
    // The flag pilot threads in warmUp (extensionFlagValues.set("background-model", …)).
    // The extension registers it so ctx.getFlag can read it; without registration getFlag
    // returns undefined (pi's loader gates flag reads on registration).
    expect(namer?.flags.has("background-model")).toBe(true);
    const flag = namer?.flags.get("background-model");
    expect(flag?.type).toBe("string");
  });

  test("(c) source surfaces as source:'cli', scope:'temporary', origin:'top-level'", async () => {
    // This is the raw metadata resolveExtensionSources stamps on CLI-provided paths.
    // pi-driver's `listExtensions` re-projects this to source:"Pilot" (D3) — the raw
    // shape here is what that projection keys off (the owned-path match + the scope).
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [NAMER_PATH],
    });
    await loader.reload();

    const namer = loader.getExtensions().extensions.find(
      (e) => e.path === NAMER_PATH,
    );
    expect(namer?.sourceInfo.source).toBe("cli");
    expect(namer?.sourceInfo.scope).toBe("temporary");
    expect(namer?.sourceInfo.origin).toBe("top-level");
  });

  test("(d) the @pilot frontmatter parses to the expected description (D3)", async () => {
    // The driver's listExtensions parses the leading `/** @pilot … description: … */`
    // block to surface a description on the Settings row. Assert the parser finds the
    // line by running the same regex against the file — a regression guard if the
    // frontmatter shape drifts from what the parser expects.
    const src = await Bun.file(NAMER_PATH).text();
    const m = src.match(/^\/\*\*[\s\S]*?\*\//);
    expect(m).not.toBeNull();
    expect(m?.[0]).toContain("@pilot");
    const lines = m![0]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim());
    const descLine = lines.find((l) =>
      l.toLowerCase().startsWith("description:"),
    );
    expect(descLine).toBeDefined();
    const desc = descLine!.slice("description:".length).trim();
    expect(desc).toBe(
      "Auto-names a session from its first prompt via the background model.",
    );
  });
});
