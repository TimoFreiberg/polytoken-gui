// readPilotSettings/writePilotSettings persist pilot's own knobs (loginShell,
// backgroundModel) as a small JSON file under config.dataDir. Untested — the
// DEFAULTS, so a new field added later picks up its default for old files) and the
// corrupt-file fallback (loud-warn + defaults, never brick startup). config.dataDir
// is the singleton mutate-and-restore seam (same as config.token in config.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { readPilotSettings, writePilotSettings } from "./settings-store.js";

const origDataDir = config.dataDir;

describe("readPilotSettings / writePilotSettings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pilot-settings-"));
    config.dataDir = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    config.dataDir = origDataDir;
  });

  test("no settings file → all defaults (nulls), never throws", () => {
    // A fresh data dir has no pilot-settings.json; read must yield the DEFAULTS shape
    // (every field null), not an error. This is the safe first-run path.
    expect(readPilotSettings()).toEqual({
      loginShell: null,
      backgroundModel: null,
    });
  });

  test("write then read round-trips the merged settings", () => {
    const result = writePilotSettings({ loginShell: "/bin/zsh" });
    expect(result).toEqual({
      loginShell: "/bin/zsh",
      backgroundModel: null,
    });
    expect(readPilotSettings()).toEqual(result);
  });

  test("write layers a patch over existing persisted values (doesn't reset siblings)", () => {
    // The merge contract: writePilotSettings({...patch}) reads current, spreads patch
    // over it, writes back. A second write must NOT clobber the first's unrelated fields.
    writePilotSettings({ loginShell: "/bin/zsh" });
    writePilotSettings({ backgroundModel: "anthropic/claude-3-5-haiku" });
    expect(readPilotSettings()).toEqual({
      loginShell: "/bin/zsh", // survived the second write
      backgroundModel: "anthropic/claude-3-5-haiku",
    });
  });

  test("a partial persisted file layers over defaults (new fields default in old files)", () => {
    // Simulate an old settings file written before `backgroundModel` existed: it has
    // loginShell but no backgroundModel. Read must fill the missing field with its
    // default (null), not leave it undefined.
    writeFileSync(
      join(dir, "pilot-settings.json"),
      JSON.stringify({ loginShell: "/bin/bash" }),
    );
    expect(readPilotSettings()).toEqual({
      loginShell: "/bin/bash",
      backgroundModel: null, // defaulted, not undefined
    });
  });

  test("a corrupt settings file falls back to defaults, never throws", () => {
    // House rule: surface (warn) + fall back, don't brick startup over a bad file.
    writeFileSync(join(dir, "pilot-settings.json"), "{ not valid json");
    expect(readPilotSettings()).toEqual({
      loginShell: null,
      backgroundModel: null,
    });
  });

  test("writePilotSettings nulls a field by patching it to null (not by deleting)", () => {
    // Clearing a setting = patching it to null, which overwrites the prior value.
    writePilotSettings({ loginShell: "/bin/zsh" });
    writePilotSettings({ loginShell: null });
    expect(readPilotSettings().loginShell).toBe(null);
  });
});
