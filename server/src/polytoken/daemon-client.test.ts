import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { waitForDaemonStartup } from "./daemon-client.js";

/**
 * The stale-startup.json regression: a session dir left behind by a prior daemon
 * (state:"ready", a now-dead pid + port) must NOT be trusted when resuming.
 * waitForDaemonStartup only returns a `ready` port whose pid matches the process
 * we just spawned. Without this guard, every cold resume of an old session reads
 * the dead daemon's port on the first poll → waitForHealth spins 10s against an
 * unbound port → "session switch failed". (Confirmed against a real stale
 * session dir: state:"ready", pid 16128 dead, port 60339 unbound.)
 */
describe("waitForDaemonStartup stale-startup.json guard", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "pilot-daemon-test-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  const sessionDir = (sid: string) => join(sessionsDir, sid);
  const writeStartup = (
    sid: string,
    json: { state: string; pid?: number; port?: number; message?: string },
  ) => {
    mkdirSync(sessionDir(sid), { recursive: true });
    writeFileSync(
      join(sessionDir(sid), "startup.json"),
      JSON.stringify({ session_id: sid, ...json }),
    );
  };

  test("ignores a stale ready file (wrong pid), waits for the matching one", async () => {
    const sid = "stale-ready";
    // A prior daemon's leftover file — ready, but a different (dead) pid.
    writeStartup(sid, { state: "ready", pid: 99999, port: 60339 });
    // Our daemon's pid.
    const ourPid = 12345;

    // Schedule our daemon's ready file after a short delay (simulating bind).
    const ourPort = 54321;
    setTimeout(
      () => writeStartup(sid, { state: "ready", pid: ourPid, port: ourPort }),
      60,
    );

    const port = await waitForDaemonStartup(sessionsDir, sid, 2000, ourPid);
    expect(port).toBe(ourPort);
  });

  test("without expectPid, trusts any ready file (back-compat for callers that don't pass a pid)", async () => {
    const sid = "no-pid-check";
    writeStartup(sid, { state: "ready", pid: 99999, port: 60339 });
    const port = await waitForDaemonStartup(sessionsDir, sid, 2000);
    expect(port).toBe(60339);
  });

  test("ignores a stale failed file (wrong pid), keeps waiting", async () => {
    const sid = "stale-failed";
    // A prior daemon's failure leftover — must not abort our wait.
    writeStartup(sid, {
      state: "failed",
      pid: 99999,
      message: "prior crash",
    });
    const ourPid = 12345;
    const ourPort = 54321;
    setTimeout(
      () => writeStartup(sid, { state: "ready", pid: ourPid, port: ourPort }),
      60,
    );
    const port = await waitForDaemonStartup(sessionsDir, sid, 2000, ourPid);
    expect(port).toBe(ourPort);
  });

  test("a failed file from OUR pid is terminal", async () => {
    const sid = "our-failure";
    const ourPid = 12345;
    setTimeout(
      () =>
        writeStartup(sid, {
          state: "failed",
          pid: ourPid,
          message: "config parse error",
        }),
      60,
    );
    await expect(
      waitForDaemonStartup(sessionsDir, sid, 2000, ourPid),
    ).rejects.toThrow(/config parse error/);
  });

  test("times out when no matching ready file appears, naming the stale file + expected pid", async () => {
    const sid = "stuck-stale";
    writeStartup(sid, { state: "ready", pid: 99999, port: 60339 });
    const ourPid = 12345;
    await expect(
      waitForDaemonStartup(sessionsDir, sid, 300, ourPid),
    ).rejects.toThrow(/did not become ready/);
    // The error should hint at the stale file + the expected pid for diagnostics.
    await expect(
      waitForDaemonStartup(sessionsDir, sid, 300, ourPid),
    ).rejects.toThrow(/expected pid: 12345/);
  });
});
