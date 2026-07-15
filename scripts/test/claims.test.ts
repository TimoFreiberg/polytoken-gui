import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAIMS_SH = join(__dirname, "..", "claims.sh");

let tempHome: string;
let claimsDir: string;
let claimsFile: string;

/**
 * Source claims.sh with a custom HOME so all paths resolve to temp dirs.
 * Runs a function from claims.sh and returns stdout.
 */
function runClaimsFn(fn: string, args: string[] = [], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const script = `set -euo pipefail
source "${CLAIMS_SH}"
${fn} ${args.join(" ")}
`;
  const result = spawnSync("bash", ["-c", script], {
    env: { ...process.env, HOME: tempHome, ...extraEnv },
    encoding: "utf-8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? -1,
  };
}

function readClaims(): unknown {
  return JSON.parse(readFileSync(claimsFile, "utf-8"));
}

beforeEach(() => {
  tempHome = mkdtempSync(join(process.env.TMPDIR || "/tmp", "claims-test-"));
  claimsDir = join(tempHome, ".local", "share", "pantoken-autopilot");
  claimsFile = join(claimsDir, "claims.json");
  mkdirSync(claimsDir, { recursive: true });
  writeFileSync(claimsFile, '{"claims":[]}');
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

describe("claims.sh", () => {
  test("init_claims creates the claims file if missing", () => {
    rmSync(claimsFile);
    runClaimsFn("init_claims");
    expect(existsSync(claimsFile)).toBe(true);
    expect(readClaims()).toEqual({ claims: [] });
  });

  test("claim_issue adds a claim (no slot parameter)", () => {
    runClaimsFn("claim_issue", ["23"]);
    const claims = readClaims() as { claims: Array<{ issue_number: number; session_id: string }> };
    expect(claims.claims).toHaveLength(1);
    expect(claims.claims[0]!.issue_number).toBe(23);
    expect(claims.claims[0]!.session_id).toBe("");
    // Verify no slot field exists
    expect("slot" in claims.claims[0]!).toBe(false);
  });

  test("release_claim removes a claim", () => {
    runClaimsFn("claim_issue", ["23"]);
    runClaimsFn("claim_issue", ["24"]);
    runClaimsFn("release_claim", ["23"]);
    const claims = readClaims() as { claims: Array<{ issue_number: number }> };
    expect(claims.claims).toHaveLength(1);
    expect(claims.claims[0]!.issue_number).toBe(24);
  });

  test("update_claim_session sets session_id", () => {
    runClaimsFn("claim_issue", ["23"]);
    runClaimsFn("update_claim_session", ["23", "abc-123"]);
    const claims = readClaims() as { claims: Array<{ issue_number: number; session_id: string }> };
    expect(claims.claims[0]!.session_id).toBe("abc-123");
  });

  test("get_claim_session_id returns session_id for an issue", () => {
    runClaimsFn("claim_issue", ["23"]);
    runClaimsFn("update_claim_session", ["23", "sess-42"]);
    const result = runClaimsFn("get_claim_session_id", ["23"]);
    expect(result.stdout).toBe("sess-42");
  });

  test("is_issue_claimed returns true for claimed issue", () => {
    runClaimsFn("claim_issue", ["23"]);
    const result = runClaimsFn("is_issue_claimed", ["23"]);
    expect(result.exitCode).toBe(0);
  });

  test("is_issue_claimed returns false for unclaimed issue", () => {
    runClaimsFn("claim_issue", ["23"]);
    const result = runClaimsFn("is_issue_claimed", ["99"]);
    expect(result.exitCode).toBe(1);
  });

  test("list_claimed_issues returns all claimed issue numbers", () => {
    runClaimsFn("claim_issue", ["23"]);
    runClaimsFn("claim_issue", ["42"]);
    const result = runClaimsFn("list_claimed_issues");
    expect(result.stdout).toContain("23");
    expect(result.stdout).toContain("42");
  });

  test("list_claimed_issues returns empty string when no claims", () => {
    const result = runClaimsFn("list_claimed_issues");
    expect(result.stdout).toBe("");
  });

  test("recover_stale_claims releases claim with dead daemon PID", () => {
    runClaimsFn("claim_issue", ["23"]);
    runClaimsFn("update_claim_session", ["23", "fake-session-id"]);
    const result = runClaimsFn("recover_stale_claims");
    expect(result.exitCode).toBe(0);
    const claims = readClaims() as { claims: unknown[] };
    expect(claims.claims).toHaveLength(0);
  });

  test("recover_stale_claims keeps claim with alive daemon PID", () => {
    runClaimsFn("claim_issue", ["23"]);
    runClaimsFn("update_claim_session", ["23", "alive-session"]);
    const sessionDir = join(tempHome, ".local", "share", "polytoken", "sessions", "alive-session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "startup.json"), JSON.stringify({ state: "ready", pid: process.pid, port: 12345 }));
    runClaimsFn("recover_stale_claims");
    const claims = readClaims() as { claims: Array<{ issue_number: number }> };
    expect(claims.claims).toHaveLength(1);
    expect(claims.claims[0]!.issue_number).toBe(23);
  });

  test("recover_stale_claims keeps claim with empty session_id (daemon not yet spawned)", () => {
    runClaimsFn("claim_issue", ["23"]);
    runClaimsFn("recover_stale_claims");
    const claims = readClaims() as { claims: unknown[] };
    expect(claims.claims).toHaveLength(1);
  });
});
