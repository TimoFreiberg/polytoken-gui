import type {
  AssistantItem,
  InjectItem,
  ToolItem,
  TranscriptItem,
} from "@pilot/protocol";
import { describe, expect, test } from "bun:test";
import {
  type DisplayItem,
  type MergedToolsItem,
  formatWorkedDuration,
  groupTurns,
  injectText,
  mergeTools,
  mergedSummary,
  parseQnaResult,
  skillFromTool,
  summarizeToolRun,
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
const inject = (
  id: string,
  over: Partial<InjectItem> = {},
): TranscriptItem => ({
  kind: "inject",
  id,
  customType: "journal-nudge",
  text: id,
  display: true,
  ...over,
});

describe("mergeTools", () => {
  test("collapses an uninterrupted run of tools, including bash, into one summary", () => {
    const out = mergeTools([
      tool("r1", "read"),
      tool("g1", "grep"),
      tool("b1", "bash"),
      tool("f1", "find"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "mergedTools",
      names: ["read", "grep", "bash", "find"],
    });
  });

  test("a single non-write/edit tool still becomes a summary", () => {
    const out = mergeTools([tool("b1", "bash")]);
    expect(out[0]).toMatchObject({
      kind: "mergedTools",
      names: ["bash"],
      tools: [{ id: "b1" }],
    });
  });

  test("write and edit stay standalone and break surrounding summary runs", () => {
    const out = mergeTools([
      tool("r1", "read"),
      tool("w1", "write"),
      tool("b1", "bash"),
      tool("e1", "edit"),
      tool("g1", "grep"),
    ]);
    expect(out.map((i) => i.kind)).toEqual([
      "mergedTools",
      "tool",
      "mergedTools",
      "tool",
      "mergedTools",
    ]);
    expect(out[1]).toMatchObject({ name: "write" });
    expect(out[3]).toMatchObject({ name: "edit" });
  });

  test("thinking-only items break runs by default (thinking visible)", () => {
    const out = mergeTools([
      tool("b1", "bash"),
      asst("t1", { text: "", thinking: "pondering" }),
      tool("b2", "bash"),
    ]);
    // Visible thinking block sits between two cards: three items, no merge.
    expect(out.map((i) => i.kind)).toEqual([
      "mergedTools",
      "assistant",
      "mergedTools",
    ]);
  });

  test("with thinking hidden, thinking-only items are dropped and runs merge across them", () => {
    const out = mergeTools(
      [
        tool("b1", "bash"),
        asst("t1", { text: "", thinking: "pondering" }),
        tool("b2", "bash"),
        asst("t2", { text: "   ", thinking: "more" }),
        tool("b3", "bash"),
      ],
      true,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "mergedTools",
      names: ["bash"],
      tools: [{ id: "b1" }, { id: "b2" }, { id: "b3" }],
    });
  });

  test("hidden thinking does not absorb an assistant item that has user-facing text", () => {
    const out = mergeTools(
      [
        tool("b1", "bash"),
        asst("a1", { text: "here is the answer", thinking: "reasoned" }),
        tool("b2", "bash"),
      ],
      true,
    );
    // Visible text still breaks the run even with thinking hidden.
    expect(out.map((i) => i.kind)).toEqual([
      "mergedTools",
      "assistant",
      "mergedTools",
    ]);
  });

  // ── sealed flag ─────────────────────────────────────────────────────────

  test("mergeTrailing=true (default): trailing tools are sealed", () => {
    const out = mergeTools([tool("b1", "bash"), tool("r1", "read")]);
    expect(out).toHaveLength(1);
    expect((out[0] as MergedToolsItem).sealed).toBe(true);
  });

  test("mergeTrailing=false: trailing tools are unsealed", () => {
    const out = mergeTools(
      [tool("b1", "bash"), tool("r1", "read")],
      false,
      false,
    );
    expect(out).toHaveLength(1);
    expect((out[0] as MergedToolsItem).sealed).toBe(false);
  });

  test("a non-tool item seals the preceding run", () => {
    const out = mergeTools([
      tool("r1", "read"),
      tool("b1", "bash"),
      asst("a1"),
    ]);
    expect(out.map((i) => i.kind)).toEqual(["mergedTools", "assistant"]);
    expect((out[0] as MergedToolsItem).sealed).toBe(true);
    expect((out[0] as MergedToolsItem).tools).toHaveLength(2);
  });

  test("a non-tool item seals the run even when standalone tools sit between them", () => {
    // Timeline case: read+bash, then write, then text. Read+bash should be sealed
    // because text eventually follows, even though write broke the run.
    const out = mergeTools([
      tool("r1", "read"),
      tool("b1", "bash"),
      tool("w1", "write"),
      asst("a1"),
    ]);
    expect(out.map((i) => i.kind)).toEqual([
      "mergedTools",
      "tool",
      "assistant",
    ]);
    expect((out[0] as MergedToolsItem).sealed).toBe(true);
    expect((out[0] as MergedToolsItem).names).toEqual(["read", "bash"]);
    expect((out[1] as ToolItem).name).toBe("write");
  });

  test("without a non-tool item and mergeTrailing=false, the run stays unsealed", () => {
    // Streaming: read+bash then write, no text yet.
    const out = mergeTools(
      [tool("r1", "read"), tool("b1", "bash"), tool("w1", "write")],
      false,
      false,
    );
    expect(out.map((i) => i.kind)).toEqual(["mergedTools", "tool"]);
    expect((out[0] as MergedToolsItem).sealed).toBe(false);
  });

  test("standalone tools stay standalone and don't seal adjacent runs", () => {
    // answer between two summarizable runs — neither should seal the other.
    const out = mergeTools(
      [tool("r1", "read"), tool("a1", "answer"), tool("b1", "bash")],
      false,
      false,
    );
    expect(out.map((i) => i.kind)).toEqual([
      "mergedTools",
      "tool",
      "mergedTools",
    ]);
    expect((out[0] as MergedToolsItem).sealed).toBe(false);
    expect((out[2] as MergedToolsItem).sealed).toBe(false);
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

  test("an active last turn stays inline even when it has a candidate final response", () => {
    const items = [
      user("u1"),
      asst("narration"),
      tool("b1", "bash"),
      asst("candidate-final", { streaming: true }),
    ];

    expect(groupTurns(items, true)[0]!.collapsible).toBe(false);
    expect(groupTurns(items, false)[0]!.collapsible).toBe(true);
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

// Regression for the queued-follow-up position bug: a follow-up sent mid-run is delivered
// by pi only once the agent would stop, so it belongs AFTER the prior turn's final
// response. pilot used to insert it at SEND time (mid-work), which split the turn early
// and pushed the real final response into a later turn's collapsible work — it vanished
// behind "Worked for Ns". The driver fix repositions the bubble to its delivery point;
// these two cases pin both halves of that contract.
describe("groupTurns: queued follow-up delivery position", () => {
  test("fixed order — follow-up AFTER the final response keeps that response visible", () => {
    // origPrompt → work → finalA → [follow-up delivered] → work → finalB
    const turns = groupTurns([
      user("orig"),
      asst("narration"),
      tool("b1"),
      asst("finalA"), // the real final response to the original prompt
      user("followup"), // delivered here, once the agent would stop
      tool("b2"),
      asst("finalB"),
    ]);
    expect(turns).toHaveLength(2);
    // Turn 0's final response stays visible (NOT collapsed into work).
    expect(turns[0]!.response.map((i) => i.id)).toEqual(["finalA"]);
    expect(turns[0]!.work.map((i) => i.id)).not.toContain("finalA");
    // Turn 1 (the follow-up) keeps its own final response too.
    expect(turns[1]!.user!.id).toBe("followup");
    expect(turns[1]!.response.map((i) => i.id)).toEqual(["finalB"]);
  });

  test("buggy order — follow-up BEFORE the final response swallows it into work", () => {
    // The pre-fix shape: the bubble lands mid-work (at send time), so finalA — now
    // trailed by a tool inside the follow-up's turn — collapses instead of showing.
    const turns = groupTurns([
      user("orig"),
      asst("narration"),
      tool("b1"),
      user("followup"), // mis-positioned at send time, mid-run
      asst("finalA"),
      tool("b2"),
      asst("finalB"),
    ]);
    // Turn 0 ends on a tool — no visible response at all.
    expect(turns[0]!.response).toEqual([]);
    // finalA is buried in the follow-up turn's collapsible work, not its response.
    expect(turns[1]!.work.map((i) => i.id)).toContain("finalA");
    expect(turns[1]!.response.map((i) => i.id)).toEqual(["finalB"]);
  });
});

describe("groupTurns: answer (visible) tools", () => {
  test("the answer tool is pulled out of work into visible, in order", () => {
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      tool("a1", "answer", { output: "Q: x\nA: y" }),
      asst("final"),
    ]);
    const t = turns[0]!;
    expect(t.visible.map((i) => i.id)).toEqual(["a1"]);
    expect(t.work.map((i) => i.id)).toEqual(["narration"]);
    expect(t.response.map((i) => i.id)).toEqual(["final"]);
  });

  test("a turn whose only tool is answer is not collapsible", () => {
    const turns = groupTurns([user("u1"), tool("a1", "answer"), asst("final")]);
    expect(turns[0]!.collapsible).toBe(false);
    expect(turns[0]!.visible.map((i) => i.id)).toEqual(["a1"]);
  });

  test("lanes pin the answer in chronological place between work runs", () => {
    // pre-answer work, the answer, then MORE work, then the response: the pinned answer
    // must sit between the two work runs (not floated to the bottom of the work block),
    // so later work streams in below it instead of shoving it down.
    const turns = groupTurns([
      user("u1"),
      asst("intro"),
      tool("b1"),
      tool("a1", "answer"),
      tool("b2"),
      asst("final"),
    ]);
    const lanes = turns[0]!.lanes;
    expect(lanes.map((l) => l.id)).toEqual(["u1:w0", "a1", "u1:w1"]);
    expect(lanes.map((l) => l.kind)).toEqual(["work", "pinned", "work"]);
    const [pre, pinned, post] = lanes;
    expect(pre!.kind === "work" && pre.items.map((i) => i.id)).toEqual([
      "intro",
      "b1",
    ]);
    expect(pinned!.kind === "pinned" && pinned.item.id).toBe("a1");
    expect(post!.kind === "work" && post.items.map((i) => i.id)).toEqual([
      "b2",
    ]);
    // Both work runs collapse (each holds a tool + the turn has a response).
    expect(pre!.kind === "work" && pre.collapsible).toBe(true);
    expect(post!.kind === "work" && post.collapsible).toBe(true);
  });

  test("an active last turn forces every work lane non-collapsible", () => {
    const items = [
      user("u1"),
      tool("b1"),
      tool("a1", "answer"),
      tool("b2"),
      asst("final"),
    ];
    const lanes = groupTurns(items, true)[0]!.lanes;
    for (const l of lanes)
      if (l.kind === "work") expect(l.collapsible).toBe(false);
  });

  test("answer stays standalone, not folded into a tool summary", () => {
    const out = mergeTools([tool("a1", "answer"), tool("r1", "read")]);
    expect(out.map((i) => i.kind)).toEqual(["tool", "mergedTools"]);
  });
});

describe("groupTurns: image-bearing tools (visible)", () => {
  const png = [{ type: "image", data: "x", mimeType: "image/png" }] as const;
  const shot = (id: string, name = "preview_screenshot") =>
    tool(id, name, { images: [...png] });

  test("a screenshot tool is pulled out of work into visible, not collapsed", () => {
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      shot("s1"),
      asst("final"),
    ]);
    const t = turns[0]!;
    expect(t.visible.map((i) => i.id)).toEqual(["s1"]);
    expect(t.work.map((i) => i.id)).toEqual(["narration"]);
    expect(t.response.map((i) => i.id)).toEqual(["final"]);
  });

  test("detection is by the images field, not the tool name (a read of a PNG counts)", () => {
    const turns = groupTurns([user("u1"), shot("r1", "read"), asst("final")]);
    expect(turns[0]!.visible.map((i) => i.id)).toEqual(["r1"]);
  });

  test("an image tool stays standalone, not folded into a tool summary", () => {
    const out = mergeTools([
      tool("r1", "read"),
      shot("s1"),
      tool("r2", "read"),
    ]);
    // The screenshot breaks the run: read | screenshot | read, not one merged card.
    expect(out.map((i) => i.kind)).toEqual([
      "mergedTools",
      "tool",
      "mergedTools",
    ]);
  });

  test("an image-less tool of the same name still merges normally", () => {
    // A still-running screenshot has no images yet — it summarizes like any other tool
    // until toolFinished lands the image and the next fold reclassifies it.
    const out = mergeTools([
      tool("r1", "read"),
      tool("s1", "preview_screenshot"),
    ]);
    expect(out.map((i) => i.kind)).toEqual(["mergedTools"]);
  });
});

describe("groupTurns: injected custom messages (nudge boundary)", () => {
  test("an injected message opens a NEW turn, freeing the prior turn's response", () => {
    // The journal-nudge bug: turn 1 (work + final response), then an injected nudge
    // that triggers a second run (journal tool + reply). Without the split, the nudge
    // run glues onto turn 1 and its real `final` response collapses into work.
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      tool("b1", "bash"),
      asst("final"),
      inject("n1"),
      tool("journal", "bash"),
      asst("post"),
    ]);
    expect(turns).toHaveLength(2);
    // Turn 1 keeps its real final response visible; only narration + tool collapse.
    const t1 = turns[0]!;
    expect(t1.id).toBe("u1");
    expect(t1.response.map((i) => i.id)).toEqual(["final"]);
    expect(t1.work.map((i) => i.id)).toEqual(["narration", "b1"]);
    // Turn 2 is headed by the nudge; the journal call collapses, the reply stays.
    const t2 = turns[1]!;
    expect(t2.id).toBe("n1");
    expect(t2.user?.kind).toBe("inject");
    expect(t2.work.map((i) => i.id)).toEqual(["journal"]);
    expect(t2.response.map((i) => i.id)).toEqual(["post"]);
    expect(t2.collapsible).toBe(true);
  });

  test("a display:false inject still splits the turn (robustness net)", () => {
    const turns = groupTurns([
      user("u1"),
      asst("final"),
      inject("n1", { display: false }),
      tool("t", "bash"),
      asst("post"),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u1", "n1"]);
    expect(turns[0]!.response.map((i) => i.id)).toEqual(["final"]);
  });

  test("inject carries its ts into the turn's startTs", () => {
    const turns = groupTurns([
      user("u1"),
      asst("final"),
      inject("n1", { ts: "5000" }),
      tool("t", "bash"),
      asst("post", { completedAt: "9000" }),
    ]);
    expect(turns[1]!.startTs).toBe("5000");
  });

  test("injectText strips a single matching outer wrapper tag", () => {
    expect(
      injectText(
        inject("x", {
          text: "<journal-nudge>do the thing</journal-nudge>",
        }) as InjectItem,
      ),
    ).toBe("do the thing");
    // No wrapper → raw text, trimmed.
    expect(
      injectText(inject("x", { text: "  bare text  " }) as InjectItem),
    ).toBe("bare text");
    // Mismatched tags → left as-is.
    expect(injectText(inject("x", { text: "<a>keep</b>" }) as InjectItem)).toBe(
      "<a>keep</b>",
    );
  });
});

describe("parseQnaResult", () => {
  test("parses questions, context, options and answer lines", () => {
    const text = [
      "Q: Which package manager?",
      "> repo has both locks",
      "Options:",
      "  [x] bun",
      "  [ ] npm",
      "A: bun",
      "",
      "Q: Anything else?",
      "A: keep commits small",
    ].join("\n");
    expect(parseQnaResult(text)).toEqual([
      {
        question: "Which package manager?",
        context: "repo has both locks",
        options: [
          { label: "bun", picked: true },
          { label: "npm", picked: false },
        ],
        answer: "bun",
      },
      { question: "Anything else?", answer: "keep commits small" },
    ]);
  });

  test("returns null when there are no Q: lines (raw fallback)", () => {
    expect(parseQnaResult("just some prose, no questions")).toBeNull();
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

describe("skillFromTool", () => {
  const read = (input: unknown) => tool("r", "read", { input });

  test("a read of a SKILL.md resolves to the parent-dir skill name", () => {
    expect(skillFromTool(read({ path: ".pi/skills/debug/SKILL.md" }))).toBe(
      "debug",
    );
  });
  test("accepts the file_path alias and is case-insensitive on the basename", () => {
    expect(
      skillFromTool(read({ file_path: "/abs/agents/skills/jj/Skill.md" })),
    ).toBe("jj");
  });
  test("a normal file read is not a skill load", () => {
    expect(skillFromTool(read({ path: "protocol/src/state.ts" }))).toBeNull();
  });
  test("a non-read tool is never a skill load, even with a SKILL.md arg", () => {
    expect(
      skillFromTool(
        tool("e", "edit", { input: { path: "skills/x/SKILL.md" } }),
      ),
    ).toBeNull();
  });
  test("a read without a path arg is not a skill load", () => {
    expect(skillFromTool(read({ pattern: "x" }))).toBeNull();
  });
});

describe("summarizeToolRun", () => {
  const read = (id: string, path: string) =>
    tool(id, "read", { input: { path } });

  test("groups by category in first-appearance order, capitalizing the sentence", () => {
    // searchBatch's shape: 2 reads, 2 greps, 1 find, 1 bash. grep+find fold into searches.
    expect(
      summarizeToolRun([
        read("r1", "a.ts"),
        read("r2", "b.ts"),
        tool("g1", "grep"),
        tool("g2", "grep"),
        tool("f1", "find"),
        tool("b1", "bash"),
      ]),
    ).toBe("Read 2 files, ran 3 searches, ran a command");
  });

  test("a single command reads in the singular", () => {
    expect(summarizeToolRun([tool("b", "bash")])).toBe("Ran a command");
  });

  test("a SKILL.md read becomes 'loaded skill X', named", () => {
    expect(summarizeToolRun([read("s", ".pi/skills/debug/SKILL.md")])).toBe(
      "Loaded skill debug",
    );
  });

  test("a skill load mixes with other tools, skill first in order", () => {
    expect(
      summarizeToolRun([
        read("s", "skills/debug/SKILL.md"),
        read("r", "state.ts"),
        tool("b", "bash"),
      ]),
    ).toBe("Loaded skill debug, read a file, ran a command");
  });

  test("multiple skills collapse to a count rather than naming each", () => {
    expect(
      summarizeToolRun([
        read("s1", "skills/debug/SKILL.md"),
        read("s2", "skills/jj/SKILL.md"),
      ]),
    ).toBe("Loaded 2 skills");
  });

  test("an unknown tool falls back to its name as the verb", () => {
    expect(summarizeToolRun([tool("x", "browser")])).toBe("Used browser");
    expect(
      summarizeToolRun([tool("x1", "browser"), tool("x2", "browser")]),
    ).toBe("Used browser 2×");
  });

  test("mergedSummary delegates to the run summarizer", () => {
    const merged = mergeTools([read("r1", "a.ts"), tool("b1", "bash")]);
    expect(merged[0]!.kind).toBe("mergedTools");
    expect(mergedSummary(merged[0] as never)).toBe(
      "Read a file, ran a command",
    );
  });
});
