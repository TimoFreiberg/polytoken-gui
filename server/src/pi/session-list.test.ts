import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@pilot/protocol";
import type { HistoryMessage } from "./history-map.js";
import { firstUserPreview, mergeSessionLists } from "./session-list.js";

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

describe("firstUserPreview", () => {
  const msg = (over: Partial<HistoryMessage>): HistoryMessage => ({
    role: "user",
    ...over,
  });

  test("returns the first user message's text (string content)", () => {
    const messages = [
      msg({ role: "user", content: "Add a /health route to the server." }),
      msg({ role: "assistant", content: [{ type: "text", text: "On it." }] }),
    ];
    expect(firstUserPreview(messages)).toBe(
      "Add a /health route to the server.",
    );
  });

  test("flattens block content and collapses whitespace", () => {
    const messages = [
      msg({
        role: "user",
        content: [
          { type: "text", text: "line one\n\n  line two" },
          { type: "image" },
        ],
      }),
    ];
    expect(firstUserPreview(messages)).toBe("line one line two[image]");
  });

  test("skips non-user messages to find the opening prompt", () => {
    const messages = [
      msg({ role: "assistant", content: [{ type: "text", text: "hi" }] }),
      msg({ role: "user", content: "the actual prompt" }),
    ];
    expect(firstUserPreview(messages)).toBe("the actual prompt");
  });

  test("caps long prompts", () => {
    const messages = [msg({ role: "user", content: "x".repeat(500) })];
    expect(firstUserPreview(messages, 200)).toHaveLength(200);
  });

  test("empty when there's no user message yet", () => {
    expect(firstUserPreview([])).toBe("");
    expect(
      firstUserPreview([
        msg({ role: "assistant", content: [{ type: "text", text: "hi" }] }),
      ]),
    ).toBe("");
  });
});
