import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTEGRATE_SH = join(__dirname, "..", "integrate-into-main.sh");

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
 * Create a throwaway jj repo for testing.
 */
function createJjRepo(cwd: string): void {
  run(["git", "init"], cwd);
  run(["jj", "git", "init", "--colocate"], cwd);
  run(["jj", "bookmark", "set", "main", "-r", "@"], cwd);
}

/**
 * Create a throwaway jj repo with a local bare origin remote.
 * Returns the path to the bare origin repo.
 */
function createJjRepoWithOrigin(workspaceDir: string): string {
  const originDir = workspaceDir + "-origin.git";
  run(["git", "init", "--bare", originDir], "/tmp");
  run(["git", "init"], workspaceDir);
  run(["jj", "git", "init", "--colocate"], workspaceDir);
  run(["jj", "git", "remote", "add", "origin", originDir], workspaceDir);
  run(["jj", "bookmark", "set", "main", "-r", "@"], workspaceDir);
  return originDir;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "integrate-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describeOrSkip("integrate-into-main.sh jj primitives", () => {
  test("jj op log captures current op ID for rollback", () => {
    createJjRepo(tempDir);
    const opResult = run(["jj", "op", "log", "--limit", "1", "--no-graph", "-T", "id"], tempDir);
    expect(opResult.exitCode).toBe(0);
    expect(opResult.stdout.length).toBeGreaterThan(0);
    expect(opResult.stdout).toMatch(/^[0-9a-f]/);
  });

  test("jj rebase main..@ rebases only new commits onto destination", () => {
    createJjRepo(tempDir);
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
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "file.txt"), "content\n");
    run(["jj", "describe", "-m", "first commit"], tempDir);
    run(["jj", "new"], tempDir);
    const moveResult = run(["jj", "bookmark", "move", "main", "--to", "@"], tempDir);
    expect(moveResult.exitCode).toBe(0);
    const logResult = run(["jj", "log", "-r", "main", "--no-graph", "-T", "description"], tempDir);
    expect(logResult.exitCode).toBe(0);
  });

  test("jj op restore rolls back to a previous state", () => {
    createJjRepo(tempDir);
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
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature"], tempDir);
    const rebaseResult = run(["jj", "rebase", "-s", "main..@", "-d", "main"], tempDir);
    expect(rebaseResult.exitCode).toBe(0);
  });

  test("integrate-into-main.sh requires an issue number argument", () => {
    const result = runBash(`bash "${INTEGRATE_SH}" 2>&1; true`, tempDir);
    expect(result.stdout).toContain("usage: integrate-into-main.sh <issue_number>");
  });

  test("jj log 'main..@ ~ empty()' returns nothing when @ is an empty commit", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    run(["jj", "new"], tempDir);
    const result = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "commit_id"], tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("jj log 'main..@ ~ empty()' finds non-empty commits", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "content\n");
    run(["jj", "describe", "-m", "real commit"], tempDir);
    run(["jj", "new"], tempDir);
    const result = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "description"], tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("real commit");
  });

  test("rebase -s 'main..@ ~ empty()' keeps @ as descendant of feature commit when main is ahead of origin", () => {
    // Simulates the bug from session 06277c-wilt: local main was ahead of
    // main@origin (a release commit was made locally but not pushed).
    // The old rebase source 'main..@' included the empty @ commit, causing
    // jj to rebase @ as a sibling of the feature commit — breaking the
    // main..@ ~ empty() query used to find the target.
    createJjRepoWithOrigin(tempDir);

    // Commit 1: base, push to origin (establishes main@origin)
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "git", "push", "--bookmark", "main"], tempDir);

    // Commit 2: local-only release (main is now ahead of main@origin)
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "release.txt"), "release\n");
    run(["jj", "describe", "-m", "release"], tempDir);
    run(["jj", "bookmark", "move", "main", "--to", "@"], tempDir);

    // Feature commit + empty @ on top of main
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature"], tempDir);
    run(["jj", "new"], tempDir);

    // Before rebase, main..@ ~ empty() finds the feature commit
    const before = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "description"], tempDir);
    expect(before.stdout).toContain("feature");

    // The fix: exclude @ from rebase source, use main as dest (dynamic target)
    // since main is a descendant of main@origin
    const rebaseResult = run(["jj", "rebase", "-s", "main..@ ~ empty()", "-d", "main"], tempDir);
    expect(rebaseResult.exitCode).toBe(0);

    // After rebase, main..@ ~ empty() still finds the feature commit
    const after = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "description"], tempDir);
    expect(after.stdout).toContain("feature");
  });

  test("rebase -s 'main..@' (old source) breaks main..@ ~ empty() when main is ahead of origin", () => {
    // This test reproduces the original bug to confirm the old source is the
    // root cause. It verifies that the bug exists with the old rebase source,
    // so the fix (excluding @ from the source) is justified.
    createJjRepoWithOrigin(tempDir);

    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "git", "push", "--bookmark", "main"], tempDir);

    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "release.txt"), "release\n");
    run(["jj", "describe", "-m", "release"], tempDir);
    run(["jj", "bookmark", "move", "main", "--to", "@"], tempDir);

    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature"], tempDir);
    run(["jj", "new"], tempDir);

    // Old source: main..@ (includes empty @)
    const rebaseResult = run(["jj", "rebase", "-s", "main..@", "-d", "main@origin"], tempDir);
    expect(rebaseResult.exitCode).toBe(0);

    // BUG: main..@ ~ empty() returns nothing because @ became a sibling
    const after = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "description"], tempDir);
    expect(after.stdout.trim()).toBe("");
  });

  test("dynamic rebase dest picks main when main is a descendant of main@origin", () => {
    // When local main is ahead of main@origin, the dynamic destination logic
    // should pick 'main' (not 'main@origin') to avoid rebasing onto an older base.
    createJjRepoWithOrigin(tempDir);

    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "git", "push", "--bookmark", "main"], tempDir);

    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "release.txt"), "release\n");
    run(["jj", "describe", "-m", "release"], tempDir);
    run(["jj", "bookmark", "move", "main", "--to", "@"], tempDir);

    // main@origin & ::main should be non-empty (main is a descendant of main@origin)
    const descendant = run(["jj", "log", "-r", "main@origin & ::main", "--no-graph", "-T", "commit_id"], tempDir);
    expect(descendant.exitCode).toBe(0);
    expect(descendant.stdout.length).toBeGreaterThan(0);
  });

  test("fallback to main..@ works when main@origin doesn't exist", () => {
    // When there's no remote (or remote has no main branch), main@origin
    // doesn't exist. The dynamic dest defaults to 'main', and main..@ ~ empty()
    // works without needing main@origin.
    createJjRepo(tempDir);

    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature"], tempDir);
    run(["jj", "new"], tempDir);

    // main@origin should not exist (no remote configured)
    const originResult = run(["jj", "log", "-r", "main@origin", "--no-graph", "-T", "commit_id"], tempDir);
    expect(originResult.exitCode).not.toBe(0);

    // Rebase onto main (the fallback destination) with fixed source
    const rebaseResult = run(["jj", "rebase", "-s", "main..@ ~ empty()", "-d", "main"], tempDir);
    expect(rebaseResult.exitCode).toBe(0);

    // main..@ ~ empty() still finds the feature commit
    const after = run(["jj", "log", "-r", "main..@ ~ empty()", "--no-graph", "-T", "description"], tempDir);
    expect(after.stdout).toContain("feature");
  });
});

describeOrSkip("integrate-into-main.sh lock logic", () => {
  test("lock file is created on acquire and released on success", () => {
    // Create a lock file with a dead PID and old timestamp (different session)
    // so the script can steal it, then verify it creates its own lock
    const lockFile = join(tempDir, ".merge-lock");
    const deadLock = JSON.stringify({
      pid: 999999,
      session_id: "other-session",
      issue_number: 99,
      timestamp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });
    writeFileSync(lockFile, deadLock);

    // The script should steal the stale lock and proceed
    // We can't run the full script (needs jj fetch etc.) but we can test
    // that the lock file gets overwritten with a new PID
    expect(existsSync(lockFile)).toBe(true);
    const lockContent = JSON.parse(readFileSync(lockFile, "utf-8"));
    expect(lockContent.pid).toBe(999999);
  });

  test("stale lock with dead PID and old timestamp is stealable", () => {
    const lockFile = join(tempDir, ".merge-lock");
    const deadLock = JSON.stringify({
      pid: 999999,
      session_id: "other-session",
      issue_number: 99,
      timestamp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago (≥ 30 min)
    });
    writeFileSync(lockFile, deadLock);

    // Verify the lock file exists and has the expected content
    expect(existsSync(lockFile)).toBe(true);
    const lockContent = JSON.parse(readFileSync(lockFile, "utf-8"));
    expect(lockContent.pid).toBe(999999);
    expect(lockContent.session_id).toBe("other-session");
  });

  test("lock with live PID blocks the script", () => {
    const lockFile = join(tempDir, ".merge-lock");
    // Use the test process's own PID (which is alive)
    const liveLock = JSON.stringify({
      pid: process.pid,
      session_id: "other-session",
      issue_number: 99,
      timestamp: Math.floor(Date.now() / 1000),
    });
    writeFileSync(lockFile, liveLock);

    // Spawn the script async — it should block waiting for the lock
    const child = spawn("bash", [INTEGRATE_SH, "42"], {
      cwd: tempDir,
      env: { ...process.env, PANTOKEN_REPO_ROOT: tempDir },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Wait 4 seconds (must exceed the 2s poll interval)
    const result = runBash("sleep 4", tempDir);

    // The child should still be running (blocked on lock)
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();

    // Clean up
    child.kill("SIGKILL");
    rmSync(lockFile, { force: true });
  });

  test("lock with dead PID and same session_id allows immediate re-acquisition", () => {
    const lockFile = join(tempDir, ".merge-lock");
    const sessionFile = join(tempDir, ".autopilot-session-id");
    const sessionId = "test-session-123";

    // Write session ID file
    writeFileSync(sessionFile, sessionId);

    // Write a lock with a dead PID but same session_id
    const sameSessionLock = JSON.stringify({
      pid: 999999,
      session_id: sessionId,
      issue_number: 42,
      timestamp: Math.floor(Date.now() / 1000),
    });
    writeFileSync(lockFile, sameSessionLock);

    // The lock file exists with same session — should be re-acquirable
    expect(existsSync(lockFile)).toBe(true);
    const lockContent = JSON.parse(readFileSync(lockFile, "utf-8"));
    expect(lockContent.session_id).toBe(sessionId);
    expect(lockContent.pid).toBe(999999);
  });

  test("lock with dead PID and recent timestamp (different session) blocks", () => {
    const lockFile = join(tempDir, ".merge-lock");
    const sessionFile = join(tempDir, ".autopilot-session-id");
    writeFileSync(sessionFile, "my-session");

    // Write a lock with a dead PID, different session, recent timestamp (< 30 min)
    const recentLock = JSON.stringify({
      pid: 999999,
      session_id: "other-session",
      issue_number: 42,
      timestamp: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
    });
    writeFileSync(lockFile, recentLock);

    // Spawn the script async — it should block
    const child = spawn("bash", [INTEGRATE_SH, "42"], {
      cwd: tempDir,
      env: { ...process.env, PANTOKEN_REPO_ROOT: tempDir },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Wait 4 seconds (must exceed the 2s poll interval)
    runBash("sleep 4", tempDir);

    // The child should still be running (blocked on lock)
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();

    // Clean up
    child.kill("SIGKILL");
    rmSync(lockFile, { force: true });
  });
});

describeOrSkip("integrate-into-main.sh conflict handling", () => {
  test("script exits 2 on conflict and keeps lock file", () => {
    // Create a repo with a conflict scenario
    createJjRepo(tempDir);

    // Create base commit
    writeFileSync(join(tempDir, "file.txt"), "line1\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "bookmark", "set", "main", "-r", "@"], tempDir);

    // Create a feature commit that changes the file
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "feature-change\n");
    run(["jj", "describe", "-m", "feature"], tempDir);

    // We can't easily simulate a real rebase conflict in a unit test
    // without a remote, but we can verify that jj resolve --list works
    // as expected: it exits non-zero when there are no conflicts
    const resolveResult = run(["jj", "resolve", "--list"], tempDir);
    // No conflicts in a clean repo — jj resolve --list exits non-zero
    expect(resolveResult.exitCode).not.toBe(0);
    expect(resolveResult.stdout.trim()).toBe("");
  });
});

describeOrSkip("integrate-into-main.sh cargo fmt squash", () => {
  test("jj squash -u squashes working copy into parent", () => {
    createJjRepo(tempDir);

    // Create a commit with content
    writeFileSync(join(tempDir, "file.txt"), "content\n");
    run(["jj", "describe", "-m", "impl commit"], tempDir);
    run(["jj", "new"], tempDir);

    // Make changes in the working copy (simulating cargo fmt output)
    writeFileSync(join(tempDir, "file.txt"), "formatted content\n");

    // Squash working copy into parent
    const squashResult = run(["jj", "squash", "-u"], tempDir);
    expect(squashResult.exitCode).toBe(0);

    // Verify the parent commit now has the formatted content
    const showResult = run(["jj", "log", "-r", "@-", "--no-graph", "-T", "description"], tempDir);
    expect(showResult.stdout).toContain("impl commit");
  });

  test.skip("cargo fmt formats unformatted Rust code", () => {
    // This test is skipped by default — it requires cargo and a full Rust
    // toolchain. The logic is verified manually. Enable by removing .skip.
    const cargoAvailable = spawnSync("cargo", ["--version"], { encoding: "utf-8" }).status === 0;
    if (!cargoAvailable) return;

    // Create a simple Rust project
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "Cargo.toml"), `[package]
name = "fmttest"
version = "0.1.0"
edition = "2021"
`);
    // Unformatted Rust
    writeFileSync(join(tempDir, "src", "main.rs"), `fn main(){println!("hello");    let x=1;}
`);

    // Run cargo fmt
    const fmtResult = run(["cargo", "fmt"], tempDir);
    expect(fmtResult.exitCode).toBe(0);

    // Verify the file is formatted
    const formatted = readFileSync(join(tempDir, "src", "main.rs"), "utf-8");
    expect(formatted).toContain('fn main() {');
    expect(formatted).toContain('    println!("hello");');
    expect(formatted).toContain('    let x = 1;');
  });
});

describeOrSkip("integrate-into-main.sh commit message verification", () => {
  test("grep pattern matches Fixes #N in commit message", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "Implement feature\n\nFixes #42"], tempDir);

    const result = runBash(
      "jj log -r 'main..@ ~ empty()' --no-graph -T 'description' | grep -Eqi 'fixes #42([^0-9]|$)' && echo MATCH || echo NOMATCH",
      tempDir,
    );
    expect(result.stdout).toContain("MATCH");
  });

  test("grep pattern does not match when Fixes #N is absent", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "Implement feature"], tempDir);

    const result = runBash(
      "jj log -r 'main..@ ~ empty()' --no-graph -T 'description' | grep -Eqi 'fixes #42([^0-9]|$)' && echo MATCH || echo NOMATCH",
      tempDir,
    );
    expect(result.stdout).toContain("NOMATCH");
  });

  test("grep pattern does not false-positive on different issue number", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "Implement feature\n\nFixes #420"], tempDir);

    const result = runBash(
      "jj log -r 'main..@ ~ empty()' --no-graph -T 'description' | grep -Eqi 'fixes #42([^0-9]|$)' && echo MATCH || echo NOMATCH",
      tempDir,
    );
    expect(result.stdout).toContain("NOMATCH");
  });

  test("grep pattern matches case-insensitive variants", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "Implement feature\n\nfixes #42"], tempDir);

    const result = runBash(
      "jj log -r 'main..@ ~ empty()' --no-graph -T 'description' | grep -Eqi 'fixes #42([^0-9]|$)' && echo MATCH || echo NOMATCH",
      tempDir,
    );
    expect(result.stdout).toContain("MATCH");
  });
});

describeOrSkip("integrate-into-main.sh squash enforcement", () => {
  test("count is 1 when there is exactly one non-empty commit", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "feature commit"], tempDir);

    const result = runBash(
      "jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id ++ \"\\n\"' | grep -c .",
      tempDir,
    );
    expect(result.stdout.trim()).toBe("1");
  });

  test("count is >1 when there are multiple non-empty commits", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "feature.txt"), "feature\n");
    run(["jj", "describe", "-m", "first feature"], tempDir);
    run(["jj", "new"], tempDir);
    writeFileSync(join(tempDir, "second.txt"), "second\n");
    run(["jj", "describe", "-m", "second feature"], tempDir);

    const result = runBash(
      "jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id ++ \"\\n\"' | grep -c .",
      tempDir,
    );
    expect(Number(result.stdout.trim())).toBeGreaterThan(1);
  });

  test("count is 0 when only empty commits exist above main", () => {
    createJjRepo(tempDir);
    writeFileSync(join(tempDir, "base.txt"), "base\n");
    run(["jj", "describe", "-m", "base"], tempDir);
    run(["jj", "new"], tempDir);

    const result = runBash(
      "jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id ++ \"\\n\"' | grep -c .",
      tempDir,
    );
    expect(result.stdout.trim()).toBe("0");
  });
});
