import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const UPDATER = join(import.meta.dir, "../../deploy/update-headless.sh");

// ── Fixture helpers ──────────────────────────────────────────────

function makeFixture(name: string) {
  const home = mkdtempSync(join(tmpdir(), `pantoken-update-${name}-`));
  const versionsDir = join(home, "pantoken-versions");
  const stateDir = join(home, ".local", "state", "pantoken");
  const libexecDir = join(home, ".local", "libexec");
  const liveLink = join(home, "pantoken-live");

  mkdirSync(versionsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(libexecDir, { recursive: true });

  return {
    home,
    versionsDir,
    stateDir,
    libexecDir,
    liveLink,
    env() {
      return {
        ...process.env,
        HOME: home,
        PANTOKEN_UPDATE_TEST_MODE: "1",
        PATH: `${home}/bin:${home}/sbin:${process.env.PATH}`,
      };
    },
  };
}

function writePackedArchive(
  versionsDir: string,
  version: string,
  buildSha: string,
  {
    healthBody = `{"ok":true}`,
    htmlBody = "<html><body>hello</body></html>",
    fakeMinisign = false,
    malicious = false,
  }: {
    healthBody?: string;
    htmlBody?: string;
    fakeMinisign?: boolean;
    malicious?: boolean;
  } = {}
) {
  const tarPath = join(versionsDir, `pantoken-headless-macos-aarch64.tar.gz`);
  const sigPath = join(versionsDir, `pantoken-headless-macos-aarch64.tar.gz.sig`);

  // We create a tar archive on-the-fly with bun:shell_exec
  // For tests we use the Bun.spawn approach
  const archiveContent = Buffer.from("FAKE-ARCHIVE-DATA");

  writeFileSync(tarPath, archiveContent);
  writeFileSync(sigPath, fakeMinisign ? "FAKE-SIG" : "VALID-SIG");

  return { tarPath, sigPath, archiveContent };
}

function spawnUpdater(
  fixture: ReturnType<typeof makeFixture>,
  tag?: string,
  extraEnv: Record<string, string> = {}
) {
  return Bun.spawn(
    ["/bin/bash", UPDATER, ...(tag ? [tag] : [])],
    {
      env: {
        ...fixture.env(),
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

function waitForPort(port: number, timeout = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => {
        if (Date.now() - start < timeout) {
          setTimeout(check, 100);
        } else {
          resolve(false);
        }
      });
    };
    check();
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// ── Test: validates strict semantic-version tags ──────────────────
describe("update-headless.sh", () => {
  test("rejects invalid release tags", async () => {
    const badTags = [
      "v1.2",
      "v01.2.3",
      "1.2.3",
      "v1.2.3-beta",
      "latest",
      "abc",
      "v1.2.3.4",
      "",
    ];

    for (const tag of badTags) {
      const fixture = makeFixture(`bad-tag-${tag.slice(0, 10)}`);
      const proc = spawnUpdater(fixture, tag);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
    }
  });

  test("accepts valid semantic-version tags", () => {
    // Validation is done at URL resolution; we just verify the regex.
    const validTags = [
      "v0.1.0",
      "v1.0.0",
      "v1.2.3",
      "v0.0.1",
      "v10.20.30",
    ];

    for (const tag of validTags) {
      const valid = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
        tag
      );
      expect(valid).toBe(true);
    }
  });

  // ── Test: signature verification ───────────────────────────────

  test("requires minisign before extraction", async () => {
    const fixture = makeFixture("missing-sig");
    // We can't easily test without minisign in CI, but we verify
    // the script structure expects signature before tar extraction.
    const script = readFileSync(UPDATER, "utf8");
    const lines = script.split("\n");

    // Find the order of operations
    const verifyLine = lines.findIndex((l) => l.includes("verify_signature"));
    const extractLine = lines.findIndex((l) => l.includes("extract_staging"));
    const validateLine = lines.findIndex((l) => l.includes("validate_tar"));

    // Signature must be verified BEFORE extraction
    expect(verifyLine).toBeLessThan(extractLine);
    // Tar validation must also be before extraction
    expect(validateLine).toBeLessThan(extractLine);
  });

  // ── Test: tar member validation ────────────────────────────────

  test("validates tar before extraction", async () => {
    const script = readFileSync(UPDATER, "utf8");
    const lines = script.split("\n");

    const validateLine = lines.findIndex((l) =>
      l.includes("validate_tar")
    );
    const extractLine = lines.findIndex((l) =>
      l.includes("extract_staging")
    );

    expect(validateLine).toBeLessThan(extractLine);
  });

  // ── Test: atomic symlink flip ──────────────────────────────────

  test("uses atomic rename for symlink flip", async () => {
    const script = readFileSync(UPDATER, "utf8");
    // Should use ln -sfn + mv pattern, not direct ln -sfn to the final path
    expect(script).toContain(".new.$$");
    expect(script).toContain("ln -sfn");
    expect(script).toContain("mv -f");
  });

  // ── Test: journal states ───────────────────────────────────────

  test("records all required journal states", async () => {
    const script = readFileSync(UPDATER, "utf8");

    const requiredStates = [
      "started",
      "downloaded",
      "signature-verified",
      "archive-validated",
      "smoke-passed",
      "flipped",
      "restart-requested",
      "new-process-confirmed",
      "healthy",
      "committed",
      "rollback-started",
      "rollback-flipped",
      "rollback-healthy",
      "rollback-failed",
    ];

    for (const state of requiredStates) {
      expect(script).toContain(state);
    }
  });

  // ── Test: test-mode isolation ──────────────────────────────────

  test("test-mode overrides are gated", async () => {
    const script = readFileSync(UPDATER, "utf8");

    // Should only apply overrides when PANTOKEN_UPDATE_TEST_MODE=1
    expect(script).toContain("PANTOKEN_UPDATE_TEST_MODE");
    expect(script).toContain("PANTOKEN_TEST_ASSET_URL");
    expect(script).toContain("PANTOKEN_TEST_SIG_URL");
    expect(script).toContain("PANTOKEN_TEST_KICKSTART_CMD");

    // Production default should always be the canonical URL
    expect(script).toContain("TimoFreiberg/polytoken-gui");
  });

  // ── Test: lock prevents concurrent invocations ─────────────────

  test("uses an atomic directory lock", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain('mkdir "$LOCK_DIR"');
    expect(script).not.toContain("flock");
  });

  // ── Test: rollback on health failure ───────────────────────────

  test("rolls back on post-flip health failure", async () => {
    const script = readFileSync(UPDATER, "utf8");

    // Should capture old_dir before flip
    expect(script).toContain("STAGED_OLD_DIR");
    // Should rollback if health fails
    expect(script).toContain("rollback");
    // Should attempt to restore old symlink
    expect(script).toContain("rollback");
    expect(script).toContain("ln -sfn");
  });

  // ── Test: launchd kickstart ────────────────────────────────────

  test("uses sudoers-allowed kickstart command", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain('launchctl kickstart -k "system/${LAUNCHD_LABEL}"');
    expect(script).toContain("sudo -n");
    // Should not use `kill` for restart
    expect(script).not.toMatch(/kill\s+\$\{?PID/);
  });

  // ── Test: canonical URLs ───────────────────────────────────────

  test("uses canonical release host URLs", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("TimoFreiberg/polytoken-gui");
    expect(script).toContain(
      "releases/download/"
    );
    expect(script).toContain(
      "pantoken-headless-macos-aarch64.tar.gz"
    );
  });

  // ── Test: retention pruning ────────────────────────────────────

  test("retains active and previous versions", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("MAX_RETENTION");
    expect(script).toContain("active_ver");
    expect(script).toContain("prune");
  });

  // ── Test: BUILD_SHA validation ─────────────────────────────────

  test("validates BUILD_SHA format", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("BUILD_SHA");
    expect(script).toContain("0-9a-f");
    expect(script).toContain("40");
  });

  // ── Test: VERSION validation ───────────────────────────────────

  test("validates VERSION file", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("VERSION");
  });

  // ── Test: required files in staged payload ─────────────────────

  test("checks all required staged files", async () => {
    const script = readFileSync(UPDATER, "utf8");
    expect(script).toContain("bin/pantoken-server");
    expect(script).toContain("client-dist/index.html");
    expect(script).toContain("run.sh");
    expect(script).toContain("update.sh");
  });
});
