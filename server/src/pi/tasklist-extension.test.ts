// Chunk 3 (docs/PLAN-self-contained-extensions.md): the ported tasklist is pilot's second
// owned extension (after session-namer). Mirrors session-namer-extension.test.ts: drives
// the REAL pi `DefaultResourceLoader` with the tasklist path — the exact code path
// pi-driver.ts `warmUp` hands it — pointed at a throwaway agentDir (no `.pi/extensions`,
// so nothing else loads) and asserts:
//   a. the extension loads (no error) and exports a valid factory;
//   b. it registers its tasklist tools (tasklist_add/done/delete/list) + the /tasks
//      command (tasklist has NO model/flag dependency — unlike session-namer it registers
//      no `background-model` flag, pure state management);
//   c. pi stamps the `additionalExtensionPaths` source metadata
//      (source:"cli", scope:"temporary", origin:"top-level") — the raw shape the
//      driver's `listExtensions` re-projects to source:"Pilot" (D3);
//   d. the frontmatter `@pilot` block parses to the expected description (D3).
//
// The mock driver never calls createAgentSessionServices, so a mock-driver e2e can't
// exercise the `additionalExtensionPaths` wiring — driving the real loader is the
// faithful substitute (same as session-namer's loader test). The extension's runtime
// behaviour (file persistence, the reminder firing, fuzzy matching) needs a live pi
// session and is out of unit reach; the [OPEN B] id-internal change is verified by
// reading `updateWidget`/`formatReminder` in the source + the client parser tests +
// the e2e, not asserted here.

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
const TASKLIST_PATH = resolve(
  import.meta.dir,
  "../../../pilot/extensions/tasklist.ts",
);

// A throwaway agentDir with NO `.pi/extensions` — so user-scope auto-discovery finds
// nothing and only the tasklist (via additionalExtensionPaths) loads. Built per test so
// settings never leak across cases.
function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-tasklist-test-"));
}

describe("Chunk 3: tasklist pilot extension via additionalExtensionPaths", () => {
  test("(a) the extension loads and exports a valid factory", async () => {
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [TASKLIST_PATH],
    });
    await loader.reload();

    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);

    const tasklist = extensions.find((e) => e.path === TASKLIST_PATH);
    expect(tasklist).toBeDefined();
    // A factory was called (the `tools` Map is populated by registerTool inside it).
    expect(tasklist?.tools.size).toBeGreaterThan(0);
  });

  test("(b) it registers the tasklist tools + the /tasks command (no model/flag dep)", async () => {
    // tasklist is pure state management — it registers NO `background-model` flag (unlike
    // session-namer). Instead it registers its four tools + the /tasks command. Asserting
    // these (not the flag) is the faithful "it wired itself up" check for this extension.
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [TASKLIST_PATH],
    });
    await loader.reload();

    const tasklist = loader.getExtensions().extensions.find(
      (e) => e.path === TASKLIST_PATH,
    );
    // The four tasklist tools.
    expect(tasklist?.tools.has("tasklist_add")).toBe(true);
    expect(tasklist?.tools.has("tasklist_done")).toBe(true);
    expect(tasklist?.tools.has("tasklist_delete")).toBe(true);
    expect(tasklist?.tools.has("tasklist_list")).toBe(true);
    expect(tasklist?.tools.size).toBe(4);
    // The /tasks command.
    expect(tasklist?.commands.has("tasks")).toBe(true);
    // No model/flag dependency: tasklist registers no extension flags at all.
    expect(tasklist?.flags.size).toBe(0);
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
      additionalExtensionPaths: [TASKLIST_PATH],
    });
    await loader.reload();

    const tasklist = loader.getExtensions().extensions.find(
      (e) => e.path === TASKLIST_PATH,
    );
    expect(tasklist?.sourceInfo.source).toBe("cli");
    expect(tasklist?.sourceInfo.scope).toBe("temporary");
    expect(tasklist?.sourceInfo.origin).toBe("top-level");
  });

  test("(d) the @pilot frontmatter parses to the expected description (D3)", async () => {
    // The driver's listExtensions parses the leading `/** @pilot … description: … */`
    // block to surface a description on the Settings row. Assert the parser finds the
    // line by running the same regex against the file — a regression guard if the
    // frontmatter shape drifts from what the parser expects.
    const src = await Bun.file(TASKLIST_PATH).text();
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
      "In-session task tracking widget — the agent maintains a focused task list with reminders.",
    );
  });
});
