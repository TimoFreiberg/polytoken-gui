import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "polytoken-config", "hooks", "stop-check-integration.sh");

// Skip all tests if jj is not installed
const jjAvailable = spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
const describeOrSkip = jjAvailable ? describe : describe.skip;

let tempDir: string;

function runHook(env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [HOOK], {
    cwd: tempDir,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

function createJjRepo(cwd: string): void {
  spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
  spawnSync("jj", ["git", "init", "--colocate"], { cwd, encoding: "utf-8" });
  spawnSync("jj", ["bookmark", "set", "main", "-r", "@"], { cwd, encoding: "utf-8" });
}

function writeCommit(cwd: string, file: string, content: string): void {
  spawnSync("jj", ["new"], { cwd, encoding: "utf-8" });
  writeFileSync(join(cwd, file), content);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "stop-hook-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describeOrSkip("stop-check-integration.sh", () => {
  test("returns stop (exit 0, no output) when no issue number file exists", () => {
    createJjRepo(tempDir);
    const result = runHook();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("returns stop when issue number exists but no unpushed commits", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ".autopilot-issue-number"), "42");
    const result = runHook();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("returns continue with redirect message when unpushed commits exist", () => {
    createJjRepo(tempDir);
    // Advance main bookmark to the initial empty commit
    writeFileSync(join(tempDir, ".autopilot-issue-number"), "42");
    // Create a non-empty commit above main
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    const result = runHook();
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("continue");
    expect(parsed.reason).toContain("just integrate-into-main 42");
    expect(parsed.reason).toContain("NOT yet integrated");
  });

  test("returns stop after MAX_REDIRECTS (3) continue redirects", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ".autopilot-issue-number"), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // Simulate 3 prior redirects
    writeFileSync(join(tempDir, ".autopilot-stop-redirects"), "3");

    const result = runHook();
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.outcome).toBe("stop");
  });

  test("increments redirect counter on each continue", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ".autopilot-issue-number"), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");

    // First redirect
    let result = runHook();
    expect(JSON.parse(result.stdout).outcome).toBe("continue");
    expect(readFileSync(join(tempDir, ".autopilot-stop-redirects"), "utf-8").trim()).toBe("1");

    // Second redirect
    result = runHook();
    expect(JSON.parse(result.stdout).outcome).toBe("continue");
    expect(readFileSync(join(tempDir, ".autopilot-stop-redirects"), "utf-8").trim()).toBe("2");
  });

  test("clears redirect counter when integration is complete (no unpushed commits)", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ".autopilot-issue-number"), "42");
    writeFileSync(join(tempDir, ".autopilot-stop-redirects"), "2");

    // No unpushed commits — should clear the counter and stop
    const result = runHook();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // Redirect file should be removed
    expect(() => readFileSync(join(tempDir, ".autopilot-stop-redirects"), "utf-8")).toThrow();
  });

  test("clears redirect counter after exhausted redirects let agent stop", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, ".autopilot-issue-number"), "42");
    writeCommit(tempDir, "feature.ts", "export const x = 1;\n");
    writeFileSync(join(tempDir, ".autopilot-stop-redirects"), "3");

    runHook();
    expect(() => readFileSync(join(tempDir, ".autopilot-stop-redirects"), "utf-8")).toThrow();
  });
});
