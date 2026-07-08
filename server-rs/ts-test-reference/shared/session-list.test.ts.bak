import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@pilot/protocol";
import { mergeSessionLists } from "./session-list.js";

function entry(
  sessionId: string,
  over: Partial<SessionListEntry> = {},
): SessionListEntry {
  return {
    sessionId,
    path: `/sessions/${sessionId}.jsonl`,
    cwd: "/proj",
    preview: "",
    userMessageCount: 0,
    updatedAt: "2026-06-18T00:00:00.000Z",
    createdAt: "2026-06-18T00:00:00.000Z",
    lastUserMessageAt: "2026-06-18T00:00:00.000Z",
    archived: false,
    ...over,
  };
}

describe("mergeSessionLists", () => {
  test("includes a warm session that isn't on disk yet (the new-session bug)", () => {
    const onDisk = [entry("old")];
    const warm = [entry("fresh", { preview: "warm placeholder" })];
    const merged = mergeSessionLists(onDisk, warm);
    expect(merged.map((e) => e.sessionId)).toEqual(["fresh", "old"]);
  });

  test("a warm session already on disk keeps its richer disk entry", () => {
    const onDisk = [
      entry("s1", { preview: "real first message", userMessageCount: 4 }),
    ];
    const warm = [entry("s1", { preview: "", userMessageCount: 0 })];
    const merged = mergeSessionLists(onDisk, warm);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.preview).toBe("real first message");
    expect(merged[0]?.userMessageCount).toBe(4);
  });

  test("no warm sessions leaves the disk list untouched", () => {
    const onDisk = [entry("a"), entry("b")];
    expect(mergeSessionLists(onDisk, [])).toEqual(onDisk);
  });

  test("warm-only entries precede disk entries", () => {
    const merged = mergeSessionLists(
      [entry("disk1"), entry("disk2")],
      [entry("warm1"), entry("warm2")],
    );
    expect(merged.map((e) => e.sessionId)).toEqual([
      "warm1",
      "warm2",
      "disk1",
      "disk2",
    ]);
  });
});
