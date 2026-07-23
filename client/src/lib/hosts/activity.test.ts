import { describe, expect, test } from "bun:test";
import { deriveIndicator, indicatorColor } from "./activity.js";
import type { HostActivity } from "./types.js";

const none: HostActivity = {
  running: false,
  unseen: false,
  waiting: false,
  failed: false,
};

describe("deriveIndicator", () => {
  test("returns offline when not connected", () => {
    expect(deriveIndicator(none, false)).toBe("offline");
  });

  test("returns failed when activity.failed (even if running/unseen)", () => {
    expect(
      deriveIndicator({ ...none, failed: true, running: true, unseen: true }, true),
    ).toBe("failed");
  });

  test("returns waiting when activity.waiting (even if unseen/running)", () => {
    expect(
      deriveIndicator({ ...none, waiting: true, unseen: true, running: true }, true),
    ).toBe("waiting");
  });

  test("returns unseen when activity.unseen (even if running)", () => {
    expect(
      deriveIndicator({ ...none, unseen: true, running: true }, true),
    ).toBe("unseen");
  });

  test("returns running when activity.running", () => {
    expect(deriveIndicator({ ...none, running: true }, true)).toBe("running");
  });

  test("returns quiet when all false and connected", () => {
    expect(deriveIndicator(none, true)).toBe("quiet");
  });

  test("reconnecting suppresses stale unseen/running but preserves attention", () => {
    expect(deriveIndicator({ ...none, unseen: true, running: true }, "reconnecting")).toBe("reconnecting");
    expect(deriveIndicator({ ...none, waiting: true }, "reconnecting")).toBe("waiting");
    expect(deriveIndicator({ ...none, failed: true }, "reconnecting")).toBe("failed");
  });

  test("offline takes precedence over everything (disconnected host with failed activity)", () => {
    expect(
      deriveIndicator({ ...none, failed: true, running: true }, false),
    ).toBe("offline");
  });

  test("precedence: connection failure > session attention > unseen > running > quiet", () => {
    // connected, all false → quiet
    expect(deriveIndicator(none, true)).toBe("quiet");
    // connected, running → running (overrides quiet)
    expect(deriveIndicator({ ...none, running: true }, true)).toBe("running");
    // connected, unseen → unseen (overrides running)
    expect(deriveIndicator({ ...none, unseen: true, running: true }, true)).toBe("unseen");
    // connected, waiting → waiting (overrides unseen/running)
    expect(
      deriveIndicator({ ...none, waiting: true, unseen: true, running: true }, true),
    ).toBe("waiting");
    // connected, failed → failed (overrides waiting/unseen/running)
    expect(
      deriveIndicator(
        { ...none, failed: true, waiting: true, unseen: true, running: true },
        true,
      ),
    ).toBe("failed");
    // disconnected → offline (overrides everything)
    expect(
      deriveIndicator(
        { ...none, failed: true, waiting: true, unseen: true, running: true },
        false,
      ),
    ).toBe("offline");
  });
});

describe("indicatorColor", () => {
  test("maps each indicator to a CSS token", () => {
    expect(indicatorColor("offline")).toBe("var(--muted)");
    expect(indicatorColor("failed")).toBe("var(--danger)");
    expect(indicatorColor("waiting")).toBe("var(--warning)");
    expect(indicatorColor("unseen")).toBe("var(--highlight)");
    expect(indicatorColor("running")).toBe("var(--progress)");
    expect(indicatorColor("quiet")).toBe("transparent");
  });
});
