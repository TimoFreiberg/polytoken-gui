// Chunk 0 spike (docs/PLAN-self-contained-extensions.md): prove the load mechanism.
//
// The mock driver never calls createAgentSessionServices, so a mock-driver e2e can't
// exercise the `additionalExtensionPaths` wiring. Instead this drives the REAL pi
// `DefaultResourceLoader` with the spike path — the exact code path pi-driver.ts
// hands it — pointed at a throwaway agentDir (no `.pi/extensions`, so nothing else
// loads) and asserts the 5 points the plan calls out:
//   a. the extension loads + the `/pilot-spike` command is registered
//   b. it's in getExtensions()
//   c. FINDING: the force-exclude `-<resolvedPath>` override does NOT disable an
//      additionalExtensionPaths entry (contradicts plan D1) — pinned with a
//      boundary test showing it DOES work for user-scope auto-discovered ones.
//   d. source:"cli" surfaces (the D3 "Pilot" badge projection question)
//   e. double-registration: same file via additionalExtensionPaths AND a symlinked
//      user-scope copy → both load (no cross-scope path dedup), command collides.
//
// Point (e) here is the source-level confirmation the plan asks for when a live
// double-registration test is unsafe — it constructs the collision in a temp agentDir
// instead of touching the operator's real ~/.pi/agent/extensions.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// The same pilot-owned, repo-root-absolute resolution pi-driver.ts uses
// (PILOT_SPIKE_EXTENSION_PATH). Duplicated here rather than imported because the
// constant isn't exported from pi-driver.ts — re-exporting a throwaway spike path
// would outlive its purpose. If these drift, the wiring test in pi-driver.ts (once
// added) would catch it; for the spike, matching the construction is the point.
const SPIKE_PATH = resolve(
  import.meta.dir,
  "../../../pilot/extensions/_spike.ts",
);

// A throwaway agentDir with NO `.pi/extensions` — so user-scope auto-discovery finds
// nothing and only the spike (via additionalExtensionPaths) loads. Built per test so
// settings never leak across cases.
function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-spike-test-"));
}

describe("Chunk 0 spike: pilot extension via additionalExtensionPaths", () => {
  test("(a,b) the spike loads and registers a /pilot-spike command", async () => {
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [SPIKE_PATH],
    });
    await loader.reload();

    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);

    const spike = extensions.find((e) => e.path === SPIKE_PATH);
    expect(spike).toBeDefined();
    expect(spike?.commands.has("pilot-spike")).toBe(true);

    const cmd = spike?.commands.get("pilot-spike");
    expect(cmd?.description).toBe("pilot chunk-0 spike (no-op)");
  });

  test("(d) source surfaces as source:'cli', scope:'temporary', origin:'top-level'", async () => {
    const agentDir = freshAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [SPIKE_PATH],
    });
    await loader.reload();

    const spike = loader.getExtensions().extensions.find(
      (e) => e.path === SPIKE_PATH,
    );
    // This is the metadata resolveExtensionSources stamps on CLI-provided paths
    // (resource-loader.ts reload(): { source: "cli", scope: "temporary", origin:
    // "top-level" }). It's what pilot's Settings projection would need to badge as
    // "Pilot" rather than "temporary" — see the finding recorded in the plan writeup.
    expect(spike?.sourceInfo.source).toBe("cli");
    expect(spike?.sourceInfo.scope).toBe("temporary");
    expect(spike?.sourceInfo.origin).toBe("top-level");
  });

  test("(c) FINDING: force-exclude -<resolvedPath> does NOT disable an additionalExtensionPaths entry (contradicts plan D1)", async () => {
    // The plan's D1 claims "Force-exclude overrides (`-<resolvedPath>` in pi settings)
    // apply to [additionalExtensionPaths]". That is FALSE for the local-file source
    // path. Root cause (pi packages/coding-agent/src/core/package-manager.ts):
    // `resolveLocalExtensionSource` calls `addResource(..., enabled: true)`
    // UNCONDITIONALLY — it never consults `isEnabledByOverrides`. The `-<path>` /
    // `!path` override patterns are only applied on the auto-discovery filesystem
    // scan path (addResources → isEnabledByOverrides), not the local-file-package
    // source path that `additionalExtensionPaths` routes through.
    //
    // Consequence for the plan: the "uniform enable/disable toggle" goal (D1's whole
    // rationale for file-based over extensionFactories) is NOT met by
    // additionalExtensionPaths as-is. The toggle works for user/project auto-discovered
    // extensions (see the next test) but NOT for pilot-owned CLI-path ones. This needs
    // a plan decision before chunks 2–4 — see the writeup. Recorded here as a failing-
    // loud assertion of the actual behavior so the gap can't be silently forgotten.
    const agentDir = freshAgentDir();
    const settings = SettingsManager.create(agentDir, agentDir, {
      projectTrusted: false,
    });
    settings.setExtensionPaths([`-${SPIKE_PATH}`]);
    await settings.flush();

    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: settings,
      additionalExtensionPaths: [SPIKE_PATH],
    });
    await loader.reload();

    const spike = loader.getExtensions().extensions.find(
      (e) => e.path === SPIKE_PATH,
    );
    // NOT undefined — the force-exclude was ignored. This is the finding, not a bug
    // in the test: pilot-owned CLI extensions are NOT toggleable via -<path> today.
    expect(spike).toBeDefined();
    expect(spike?.commands.has("pilot-spike")).toBe(true);
  });

  test("(c-boundary) the same -<path> override DOES disable a user-scope auto-discovered extension", async () => {
    // Complement to (c): pin the exact boundary. A user-scope extension (dropped into
    // <agentDir>/extensions, auto-discovered by the filesystem scan) IS disabled by the
    // `-<path>` override — because that path goes through addResources →
    // isEnabledByOverrides. So pilot's existing toggle works for user extensions today;
    // it's specifically the additionalExtensionPaths route that bypasses it.
    const agentDir = freshAgentDir();
    const userExtDir = join(agentDir, "extensions");
    mkdirSync(userExtDir, { recursive: true });
    const userCopy = join(userExtDir, "_spike.ts");
    writeFileSync(userCopy, await Bun.file(SPIKE_PATH).text());

    const settings = SettingsManager.create(agentDir, agentDir, {
      projectTrusted: false,
    });
    settings.setExtensionPaths([`-${userCopy}`]);
    await settings.flush();

    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: settings,
    });
    await loader.reload();

    const spike = loader.getExtensions().extensions.find((e) => e.path === userCopy);
    // Disabled → not loaded. Confirms the toggle works on the auto-discovery path
    // (so the gap in (c) is specific to additionalExtensionPaths, not the override
    // mechanism itself).
    expect(spike).toBeUndefined();
  });

  test("(e) double-registration: same file discoverable as user-scope AND via additionalExtensionPaths both load → command collision", async () => {
    // Construct the D1 "must remove from dotfiles" collision in a temp agentDir
    // rather than touching the operator's real ~/.pi/agent/extensions. The user-scope
    // dir is <agentDir>/extensions; drop a copy of the spike there, then ALSO pass it
    // via additionalExtensionPaths — the situation that arises if pilot ships an
    // extension the dotfiles symlink still resolves.
    const agentDir = freshAgentDir();
    const userExtDir = join(agentDir, "extensions");
    mkdirSync(userExtDir, { recursive: true });
    const userCopyPath = join(userExtDir, "_spike.ts");
    writeFileSync(userCopyPath, await Bun.file(SPIKE_PATH).text());

    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [SPIKE_PATH],
    });
    await loader.reload();

    const { extensions } = loader.getExtensions();

    // Both copies loaded — distinct resolved paths (the user-scope one is a real file
    // copy under agentDir/extensions, the CLI one is the pilot repo path). pi's
    // mergePaths dedupes by canonicalizePath (realpath), and these are DIFFERENT files
    // (a copy, not a symlink), so they're NOT deduped. Both register `pilot-spike`.
    const pilotCopy = extensions.find((e) => e.path === SPIKE_PATH);
    const userCopy = extensions.find((e) => e.path === userCopyPath);
    expect(pilotCopy).toBeDefined();
    expect(userCopy).toBeDefined();
    expect(pilotCopy?.commands.has("pilot-spike")).toBe(true);
    expect(userCopy?.commands.has("pilot-spike")).toBe(true);

    // The runner's resolveRegisteredCommands would disambiguate the invocation names
    // (pilot-spike:1, pilot-spike:2) — but BOTH extensions are loaded, so BOTH command
    // handlers exist. That's the collision the plan warns about: leaving the dotfiles
    // copy in place when pilot ships its own means a duplicate, not coexistence.
    const pilotSpikeCommands = extensions.filter((e) =>
      e.commands.has("pilot-spike"),
    );
    expect(pilotSpikeCommands.length).toBe(2);
  });

  test("(e-note) symlinked user-scope copy IS deduped against the CLI path (realpath collision)", async () => {
    // Complement to the copy case above: if the user-scope entry is a SYMLINK to the
    // pilot file (as ~/.pi/agent/extensions is in the real setup), canonicalizePath
    // (realpathSync) resolves both to the SAME inode → mergePaths dedupes them and
    // only ONE loads. So the dotfiles symlink alone doesn't double-register — the
    // collision in production would come from a real second copy. Documents the exact
    // boundary of the D1 constraint.
    const agentDir = freshAgentDir();
    const userExtDir = join(agentDir, "extensions");
    mkdirSync(userExtDir, { recursive: true });
    const userLinkPath = join(userExtDir, "_spike-link.ts");
    symlinkSync(SPIKE_PATH, userLinkPath);

    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager: SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [SPIKE_PATH],
    });
    await loader.reload();

    const { extensions } = loader.getExtensions();
    const pilotSpikeCommands = extensions.filter((e) =>
      e.commands.has("pilot-spike"),
    );
    // One extension, one command — the symlink collapsed into the CLI path.
    expect(pilotSpikeCommands.length).toBe(1);
  });
});
