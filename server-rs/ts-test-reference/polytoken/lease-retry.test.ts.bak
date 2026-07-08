import { describe, expect, test } from "bun:test";
import { LeaseConflictError, retryClaim } from "./daemon-client.js";

/** A fake 409 body the daemon would return: an `active` holder with an expiry. */
function leaseBody(expiresAt: Date): string {
  return JSON.stringify({
    active: {
      active_terminal_label: "tui",
      active_pid: 99999,
      expires_at: expiresAt.toISOString(),
    },
    message: "an interactive TUI is attached",
  });
}

/** Build a LeaseConflictError like claimLease throws on a 409. */
function conflict(expiresAt: Date): LeaseConflictError {
  const held = {
    summary: `"tui" pid 99999, lease expires ${expiresAt.toLocaleTimeString()}`,
    expiresAt,
  };
  return new LeaseConflictError(
    `another TUI is attached to this session (${held.summary}). Detach it there (/detach) or wait ~30s for its lease to lapse.`,
    held,
  );
}

describe("retryClaim", () => {
  test("succeeds on first try (no retry)", async () => {
    let calls = 0;
    const result = await retryClaim(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries on 409, succeeds on 2nd attempt", async () => {
    let calls = 0;
    const result = await retryClaim(
      async () => {
        calls++;
        // Expiry ~1ms — lapses well within the retry window so the early-exit
        // doesn't fire. The no-op sleep means wall-clock barely advances.
        if (calls === 1) throw conflict(new Date(Date.now() + 1));
        return "ok";
      },
      { maxRetries: 3, delayMs: 100, sleep: async () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("retries 3x, throws LeaseConflictError after exhaustion", async () => {
    let calls = 0;
    // Short expiry (laps within the retry window) so the early-exit doesn't fire
    // — all 4 attempts run before exhaustion.
    const expiresAt = new Date(Date.now() + 1);
    await expect(
      retryClaim(
        async () => {
          calls++;
          throw conflict(expiresAt);
        },
        { maxRetries: 3, delayMs: 100, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    // 1 initial + 3 retries = 4 attempts total.
    expect(calls).toBe(4);
  });

  test("does NOT retry on non-409 errors", async () => {
    let calls = 0;
    await expect(
      retryClaim(
        async () => {
          calls++;
          throw new Error("lease claim failed (500): server error");
        },
        { maxRetries: 3, delayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow(/server error/);
    expect(calls).toBe(1);
  });

  test("stops early when the lease won't lapse within the retry window", async () => {
    // Expiry 60s out — far beyond the ~3ms retry window (3 retries × 1ms).
    let calls = 0;
    const expiresAt = new Date(Date.now() + 60_000);
    await expect(
      retryClaim(
        async () => {
          calls++;
          throw conflict(expiresAt);
        },
        { maxRetries: 3, delayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(LeaseConflictError);
    // Should stop after the FIRST attempt (no retries — the lease won't lapse).
    expect(calls).toBe(1);
  });

  test("final error message includes the computed time-to-lapse (not ~30s)", async () => {
    // Expiry 5s out — within the retry window (3 retries × 2s = 6s), so retries
    // exhaust. The no-op sleep keeps wall-clock ~instant, so the 5s is still
    // ~5s when the final error is built.
    const expiresAt = new Date(Date.now() + 5000);
    let err: unknown;
    try {
      await retryClaim(
        async () => {
          throw conflict(expiresAt);
        },
        { maxRetries: 3, delayMs: 2000, sleep: async () => {} },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LeaseConflictError);
    const msg = (err as LeaseConflictError).message;
    // The message should contain a computed "Ns" wait, NOT the hardcoded "~30s".
    expect(msg).toMatch(/wait \d+s for its lease to lapse/);
    expect(msg).not.toContain("~30s");
    // The computed wait should be ~5s (within a tolerance for test timing).
    expect(msg).toMatch(/wait [3-7]s for its lease to lapse/);
  });

  test("falls back to ~30s when the body lacks an expiry", async () => {
    // A LeaseConflictError with no held info (malformed 409 body).
    await expect(
      retryClaim(
        async () => {
          throw new LeaseConflictError("lease claim failed (409): malformed body");
        },
        { maxRetries: 3, delayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow(/~30s|another TUI is attached/);
  });

  test("sleep is called between retries", async () => {
    let sleepCalls = 0;
    let claimCalls = 0;
    await retryClaim(
      async () => {
        claimCalls++;
        // Short expiry (laps within the retry window) so the early-exit doesn't fire.
        if (claimCalls < 3) throw conflict(new Date(Date.now() + 1));
        return "ok";
      },
      {
        maxRetries: 3,
        delayMs: 50,
        sleep: async (ms) => {
          sleepCalls++;
          expect(ms).toBe(50);
        },
      },
    );
    // Two retries → two sleeps (after attempt 1 and after attempt 2).
    expect(sleepCalls).toBe(2);
    expect(claimCalls).toBe(3);
  });
});

describe("LeaseConflictError", () => {
  test("is an Error with the right name", () => {
    const err = new LeaseConflictError("test message");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LeaseConflictError");
    expect(err.message).toBe("test message");
    expect(err.held).toBeNull();
  });

  test("carries the parsed holder info", () => {
    const expiresAt = new Date(Date.now() + 30_000);
    const held = {
      summary: '"tui" pid 12345, lease expires 12:00:00',
      expiresAt,
    };
    const err = new LeaseConflictError("msg", held);
    expect(err.held).toBe(held);
    expect(err.held?.expiresAt).toBe(expiresAt);
  });
});

describe("parseLeaseHeldError (via claimLease message format)", () => {
  test("the mock's failsession message matches the lease-conflict pattern", () => {
    // The mock driver throws this exact message. classifySwitchError + the
    // client's LEASE_CONFLICT_RE must both match it.
    const mockMsg =
      'another TUI is attached to this session ("tui" pid 99999, lease expires in 30s). Detach it there (/detach) or wait 30s for its lease to lapse.';
    // classifySwitchError pattern (hub.ts):
    expect(/another TUI is attached|lease claim failed \(409\)/.test(mockMsg)).toBe(true);
    // client LEASE_CONFLICT_RE (store.svelte.ts):
    expect(/another TUI is attached|lease to lapse/.test(mockMsg)).toBe(true);
  });
});
