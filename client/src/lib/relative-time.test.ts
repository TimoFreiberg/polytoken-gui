import { describe, expect, test } from "bun:test";
import { compactTime, relativeTime } from "./relative-time.js";

const NOW = 1_700_000_000_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HR = 60 * MIN;
const DAY = 24 * HR;

describe("relativeTime", () => {
  test("sub-minute → just now", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59 * SEC), NOW)).toBe("just now");
  });

  test("minutes / hours / days", () => {
    expect(relativeTime(ago(15 * MIN), NOW)).toBe("15m ago");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("59m ago");
    expect(relativeTime(ago(3 * HR), NOW)).toBe("3h ago");
    expect(relativeTime(ago(2 * DAY), NOW)).toBe("2d ago");
  });

  test("weeks / months / years", () => {
    expect(relativeTime(ago(10 * DAY), NOW)).toBe("1w ago");
    expect(relativeTime(ago(40 * DAY), NOW)).toBe("1mo ago");
    expect(relativeTime(ago(400 * DAY), NOW)).toBe("1y ago");
  });

  test("future timestamps clamp to just now", () => {
    expect(relativeTime(ago(-5 * MIN), NOW)).toBe("just now");
  });

  test("unparseable → empty string", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("");
    expect(relativeTime("", NOW)).toBe("");
  });
});

describe("compactTime", () => {
  test("drops the ' ago' suffix across all buckets", () => {
    expect(compactTime(ago(0), NOW)).toBe("now");
    expect(compactTime(ago(15 * MIN), NOW)).toBe("15m");
    expect(compactTime(ago(3 * HR), NOW)).toBe("3h");
    expect(compactTime(ago(2 * DAY), NOW)).toBe("2d");
    expect(compactTime(ago(10 * DAY), NOW)).toBe("1w");
    expect(compactTime(ago(40 * DAY), NOW)).toBe("1mo");
    expect(compactTime(ago(400 * DAY), NOW)).toBe("1y");
  });

  test("future clamps to now; unparseable → empty string", () => {
    expect(compactTime(ago(-5 * MIN), NOW)).toBe("now");
    expect(compactTime("not-a-date", NOW)).toBe("");
  });
});
