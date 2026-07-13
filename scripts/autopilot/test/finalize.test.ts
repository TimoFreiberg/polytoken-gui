import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Skip all tests in this file if jj is not installed (e.g. CI on Linux)
const jjAvailable = spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
const describeOrSkip = jjAvailable ? describe : describe.skip;

let tempDir: string;

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(cmd[0] ?? "", cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

function runBash(script: string, cwd: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

/**
 * Create a bare throwaway jj repo for testing finalize.sh logic.
 * We test the jj primitives (op log, rebase, bookmark move, op restore)
 * rather than the full script (which needs gh + network + worktree).
 */
beforeEach(() => {
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "finalize-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describeOrSkip("finalize.sh jj primitives", () => {
  test("jj op log captures current op ID for rollback", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    const opResult = run(["jj", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], tempDir);
    expect(opResult.exitCode).toBe(0);
    expect(opResult.stdout.length).toBeGreaterThan(0);
    expect(opResult.stdout).toMatch(/^[0-9a-f]/);
  });

  test("jj rebase main..@ rebases only new commits onto destination", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "initial\n");
    run(["jj", "describe", "-m", "base commit"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature commit"], tempDir);
    const logResult = run(["jj", "log", "-r", "main..@", "--no-graph", "-T", "description"], tempDir);
    expect(logResult.exitCode).toBe(0);
    expect(logResult.stdout).toContain("feature commit");
    expect(logResult.stdout).not.toContain("base commit");
  });

  test("jj bookmark move main --to @ advances bookmark", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "content\n");
    run(["jj", "describe", "-m", "first commit"], tempDir);
    run(["jj", "new"], tempDir);
    const moveResult = run(["jj", "bookmark", "move", "main", "--to", "@"], tempDir);
    expect(moveResult.exitCode).toBe(0);
    const logResult = run(["jj", "log", "-r", "main", "--no-graph", "-T", "description"], tempDir);
    expect(logResult.exitCode).toBe(0);
  });

  test("jj op restore rolls back to a previous state", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "original\n");
    run(["jj", "describe", "-m", "original"], tempDir);
    const preOpId = run(["jj", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], tempDir).stdout;
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "file2.txt"), "new file\n");
    run(["jj", "describe", "-m", "added file2"], tempDir);
    expect(existsSync(join(tempDir, "file2.txt"))).toBe(true);
    const restoreResult = run(["jj", "op", "restore", preOpId], tempDir);
    expect(restoreResult.exitCode).toBe(0);
    expect(existsSync(join(tempDir, "file2.txt"))).toBe(false);
  });

  test("jj rebase -s main..@ -d main works on colocated repo", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature"], tempDir);
    const rebaseResult = run(["jj", "rebase", "-s", "main..@", "-d", "main"], tempDir);
    expect(rebaseResult.exitCode).toBe(0);
  });

  test("finalize.sh requires an issue number argument", () => {
    const finalizeSh = join(__dirname, "..", "finalize.sh");
    const result = runBash(`bash "${finalizeSh}" 2>&1; true`, tempDir);
    expect(result.stdout).toContain("usage: finalize.sh <issue_number>");
  });

  test("jj log 'main..@ ~ empty()' returns nothing when @ is an empty commit", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);

    // Create a base commit and set main there
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Create a new empty change on top — no non-empty commits above main
    run(["jj", "new"], tempDir);

    // main..@ ~ empty() should be empty (no non-empty commits above main)
    const result = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "commit_id"], tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("jj log 'main..@ ~ empty()' finds non-empty commits", () => {
    run(["git", "init"], tempDir);
    run(["jj", "git", "init", "--colocate"], tempDir);

    // Create a base commit and set main there
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Create a real commit on top, then an empty @ on top of that
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "content\n");
    run(["jj", "describe", "-m", "real commit"], tempDir);
    run(["jj", "new"], tempDir); // empty @ on top

    const result = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "description"], tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("real commit");
  });
});
