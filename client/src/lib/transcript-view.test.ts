import type { AssistantItem, ToolItem, TranscriptItem } from "@pilot/protocol";
import { describe, expect, test } from "bun:test";
import {
  type DisplayItem,
  formatWorkedDuration,
  groupTurns,
  mergeTools,
  workedLabel,
} from "./transcript-view.js";

// ── builders ─────────────────────────────────────────────────────────────────
const user = (id: string, ts?: string): TranscriptItem => ({
  kind: "user",
  id,
  text: id,
  ts,
});
const asst = (
  id: string,
  over: Partial<AssistantItem> = {},
): TranscriptItem => ({
  kind: "assistant",
  id,
  text: id,
  thinking: "",
  streaming: false,
  ...over,
});
const tool = (
  id: string,
  name = "bash",
  over: Partial<ToolItem> = {},
): ToolItem => ({
  kind: "tool",
  id,
  name,
  status: "ok",
  ...over,
});

describe("mergeTools", () => {
  test("collapses an uninterrupted run of nav tools into one heterogeneous card", () => {
    const out = mergeTools([
      tool("r1", "read"),
      tool("g1", "grep"),
      tool("f1", "find"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "mergedTools",
      names: ["read", "grep", "find"],
    });
  });

  test("a single nav tool passes through as a plain tool", () => {
    const out = mergeTools([tool("r1", "read")]);
    expect(out[0]!.kind).toBe("tool");
  });

  test("a non-mergeable tool (bash) breaks the run", () => {
    const out = mergeTools([
      tool("r1", "read"),
      tool("b1", "bash"),
      tool("r2", "read"),
    ]);
    expect(out.map((i) => i.kind)).toEqual(["tool", "tool", "tool"]);
  });
});

describe("groupTurns", () => {
  test("splits at each user message", () => {
    const turns = groupTurns([user("u1"), asst("a1"), user("u2"), asst("a2")]);
    expect(turns.map((t) => t.id)).toEqual(["u1", "u2"]);
  });

  test("a turn with a tool then a final answer is collapsible; work holds the tool + narration", () => {
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      tool("b1", "bash"),
      asst("final"),
    ]);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.collapsible).toBe(true);
    expect(t.work.map((i) => i.id)).toEqual(["narration", "b1"]);
    expect(t.response.map((i) => i.id)).toEqual(["final"]);
  });

  test("response is the LAST assistant after the last tool, not earlier ones", () => {
    // narration → tool → final. Only `final` is the response; `narration` is work.
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      tool("b1"),
      asst("final"),
    ]);
    expect(turns[0]!.response.map((i) => i.id)).toEqual(["final"]);
  });

  test("a turn that ends on a tool (no trailing answer) is not collapsible", () => {
    const turns = groupTurns([user("u1"), asst("narration"), tool("b1")]);
    expect(turns[0]!.collapsible).toBe(false);
    expect(turns[0]!.response).toEqual([]);
  });

  test("a no-tool turn is not collapsible (nothing to hide)", () => {
    const turns = groupTurns([user("u1"), asst("a1")]);
    expect(turns[0]!.collapsible).toBe(false);
    expect(turns[0]!.work).toEqual([]);
    expect(turns[0]!.response.map((i) => i.id)).toEqual(["a1"]);
  });

  test("a merged-tools run counts as work and makes the turn collapsible", () => {
    const items: DisplayItem[] = mergeTools([
      tool("r1", "read"),
      tool("g1", "grep"),
    ]);
    const turns = groupTurns([user("u1"), ...items, asst("final")]);
    expect(turns[0]!.collapsible).toBe(true);
    expect(turns[0]!.work[0]!.kind).toBe("mergedTools");
  });

  test("a leading run before any user message becomes a turn with no user", () => {
    const turns = groupTurns([asst("a0"), user("u1"), asst("a1")]);
    expect(turns[0]!.user).toBeUndefined();
    expect(turns[0]!.id).toBe("a0");
  });

  test("derives turn bounds: user ts → final assistant completedAt", () => {
    const turns = groupTurns([
      user("u1", "1000"),
      tool("b1"),
      asst("final", { ts: "2000", completedAt: "38000" }),
    ]);
    expect(turns[0]!.startTs).toBe("1000");
    expect(turns[0]!.endTs).toBe("38000");
  });
});

describe("formatWorkedDuration", () => {
  test("sub-second rounds up to 1s (never 0s)", () => {
    expect(formatWorkedDuration(120)).toBe("1s");
  });
  test("whole seconds under a minute", () => {
    expect(formatWorkedDuration(37_000)).toBe("37s");
  });
  test("minutes and seconds", () => {
    expect(formatWorkedDuration(125_000)).toBe("2m 5s");
  });
  test("exact minute drops the seconds", () => {
    expect(formatWorkedDuration(120_000)).toBe("2m");
  });
  test("hours and minutes", () => {
    expect(formatWorkedDuration(3_780_000)).toBe("1h 3m");
  });
});

describe("workedLabel", () => {
  test("settled turn with both bounds yields the duration", () => {
    const t = groupTurns([
      user("u1", "1000"),
      tool("b1"),
      asst("final", { completedAt: "38000" }),
    ])[0]!;
    expect(workedLabel(t)).toBe("Worked for 37s");
  });
  test("missing end bound falls back to bare 'Worked'", () => {
    const t = groupTurns([
      user("u1", "1000"),
      tool("b1"),
      asst("final", { ts: undefined }),
    ])[0]!;
    expect(workedLabel(t)).toBe("Worked");
  });
});
