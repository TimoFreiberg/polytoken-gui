import type {
  AssistantItem,
  InjectItem,
  NoticeItem,
  ToolItem,
  TranscriptItem,
} from "@pantoken/protocol";
import { describe, expect, test } from "bun:test";
import {
  createTurnGrouper,
  filterHiddenThinking,
  findPreservedSegments,
  formatWorkedDuration,
  groupTurns,
  injectText,
  parseQnaResult,
  thinkingTailId,
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
const notice = (
  id: string,
  over: Partial<NoticeItem> = {},
): TranscriptItem => ({
  kind: "notice",
  id,
  level: "info",
  text: id,
  ...over,
});

describe("filterHiddenThinking", () => {
  test("with thinking hidden, all superseded thinking-only items are dropped when followed by text/tool", () => {
    const out = filterHiddenThinking(
      [
        tool("b1", "bash"),
        asst("t1", { text: "", thinking: "pondering" }),
        tool("b2", "bash"),
        asst("t2", { text: "   ", thinking: "more" }),
        tool("b3", "bash"),
      ],
      true,
    );
    // Every thinking-only item is followed by a tool → all dropped.
    expect(out.map((i) => i.id)).toEqual(["b1", "b2", "b3"]);
  });

  test("an assistant item with user-facing text is kept even when thinking is hidden", () => {
    const out = filterHiddenThinking(
      [
        tool("b1", "bash"),
        asst("a1", { text: "here is the answer", thinking: "reasoned" }),
        tool("b2", "bash"),
      ],
      true,
    );
    // a1 has both text + thinking → never dropped (text is always visible).
    expect(out.map((i) => i.id)).toEqual(["b1", "a1", "b2"]);
  });

  test("with thinking visible, all items pass through (no-op filter)", () => {
    const out = filterHiddenThinking(
      [
        tool("b1", "bash"),
        asst("t1", { text: "", thinking: "pondering" }),
        tool("b2", "bash"),
      ],
      false,
    );
    expect(out.map((i) => i.id)).toEqual(["b1", "t1", "b2"]);
  });

  test("with thinking hidden, a thinking-only item BETWEEN two tools is dropped (superseded)", () => {
    const out = filterHiddenThinking(
      [
        tool("b1", "bash"),
        asst("t1", { text: "", thinking: "pondering" }),
        tool("b2", "bash"),
      ],
      true,
    );
    // t1 is followed by a tool → superseded → dropped.
    expect(out.map((i) => i.id)).toEqual(["b1", "b2"]);
  });

  test("with thinking hidden, a thinking-only item as the LAST item is kept (active tail)", () => {
    const out = filterHiddenThinking(
      [tool("b1", "bash"), asst("t1", { text: "", thinking: "pondering" })],
      true,
    );
    // t1 is the last item, thinking-only, no text → the active tail → kept.
    expect(out.map((i) => i.id)).toEqual(["b1", "t1"]);
  });

  test("with thinking hidden, think → tool → think → tool → text drops all thinking", () => {
    const out = filterHiddenThinking(
      [
        asst("t1", { text: "", thinking: "first" }),
        tool("b1", "bash"),
        asst("t2", { text: "", thinking: "second" }),
        tool("b2", "bash"),
        asst("a1", { text: "the answer" }),
      ],
      true,
    );
    // Every thinking-only item is superseded (followed by a tool or text) → dropped.
    expect(out.map((i) => i.id)).toEqual(["b1", "b2", "a1"]);
  });

  test("with thinking hidden, a thinking+text item survives but is not the thinking tail", () => {
    const out = filterHiddenThinking(
      [
        tool("b1", "bash"),
        asst("a1", { text: "answer text", thinking: "my reasoning" }),
      ],
      true,
    );
    // a1 has text → survives (text visible). But thinkingTailId is undefined
    // (text follows the thinking on the same item), so its thinking block
    // won't render — it's not the active tail.
    expect(out.map((i) => i.id)).toEqual(["b1", "a1"]);
    expect(thinkingTailId(out)).toBeUndefined();
  });

  test("with thinking hidden and no thinking items, all pass through", () => {
    const out = filterHiddenThinking(
      [tool("b1", "bash"), asst("a1", { text: "answer" }), tool("b2", "bash")],
      true,
    );
    expect(out.map((i) => i.id)).toEqual(["b1", "a1", "b2"]);
  });
});

describe("thinkingTailId", () => {
  test("returns the id of the last item when it's thinking-only (active tail)", () => {
    expect(
      thinkingTailId([
        tool("b1", "bash"),
        asst("t1", { text: "", thinking: "pondering" }),
      ]),
    ).toBe("t1");
  });

  test("returns undefined when the last item has text (thinking is superseded)", () => {
    expect(
      thinkingTailId([
        asst("a1", { text: "answer", thinking: "my reasoning" }),
      ]),
    ).toBeUndefined();
  });

  test("returns undefined when the last item is a tool", () => {
    expect(
      thinkingTailId([
        asst("t1", { text: "", thinking: "pondering" }),
        tool("b1", "bash"),
      ]),
    ).toBeUndefined();
  });

  test("returns undefined when the list is empty", () => {
    expect(thinkingTailId([])).toBeUndefined();
  });

  test("returns undefined when the last item has no thinking", () => {
    expect(
      thinkingTailId([tool("b1", "bash"), asst("a1", { text: "answer" })]),
    ).toBeUndefined();
  });

  test("returns the id of a thinking-only last item even with whitespace-only text", () => {
    expect(
      thinkingTailId([
        tool("b1", "bash"),
        asst("t1", { text: "   ", thinking: "pondering" }),
      ]),
    ).toBe("t1");
  });

  test("returns undefined for think → tool → think → tool → text (all superseded)", () => {
    expect(
      thinkingTailId([
        asst("t1", { text: "", thinking: "first" }),
        tool("b1", "bash"),
        asst("t2", { text: "", thinking: "second" }),
        tool("b2", "bash"),
        asst("a1", { text: "the answer" }),
      ]),
    ).toBeUndefined();
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

  test("a run of tool items counts as work and makes the turn collapsible", () => {
    const turns = groupTurns([
      user("u1"),
      tool("r1", "read"),
      tool("g1", "grep"),
      asst("final"),
    ]);
    expect(turns[0]!.collapsible).toBe(true);
    expect(turns[0]!.work[0]!.kind).toBe("tool");
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

// Regression for docs/TODO.md: "The feature that collapses the early working part
// of a turn ... seems to not be triggered when a cold session is restored in the
// GUI." A cold restore replays the daemon's raw history (server-rs/pantoken-server/
// src/polytoken/history_seed.rs), which never emits a runCompleted-equivalent
// completion — the trailing assistant bubble is instead closed by a later,
// out-of-band re-assert (the polytoken driver's `build_branch_seed` trailing
// SessionUpdated, driver.rs:784-793) stamped at RELOAD wall-clock time, not the
// turn's real historical end. So a restored turn's `completedAt` sits far past its
// `ts` (unlike a live-settled turn, where they're seconds apart) — the shape these
// tests pin. `groupTurns` must still offer the collapse: `lastTurnActive` (the
// caller's already-resolved `store.turnActive`, not anything the seed stamped) is
// the only signal it consults for the last turn — verified this holds even though
// nothing here reads `completedAt`/`streaming` to decide collapsibility.
describe("groupTurns: cold-restored session (regression)", () => {
  test("a restored turn with real tool work collapses once turnActive resolves false", () => {
    const turns = groupTurns(
      [
        user("u1", "2025-01-01T00:00:01.000Z"),
        asst("narration", { ts: "2025-01-01T00:00:02.000Z", streaming: false }),
        tool("t1", "bash"),
        asst("final", {
          ts: "2025-01-01T00:00:04.000Z",
          streaming: false,
          completedAt: "2025-06-01T12:00:00.000Z",
        }),
      ],
      // The caller resolves turnActive to false for a genuinely idle restored
      // session (status idle, no runningIds entry, no tool left running) — the
      // only input groupTurns uses to gate the last turn's collapsibility.
      false,
    );
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.collapsible).toBe(true);
    expect(t.lanes.some((l) => l.kind === "work" && l.collapsible)).toBe(true);
    expect(t.response.map((i) => i.id)).toEqual(["final"]);
  });

  test("the same shape stays inline while turnActive is still true (no early collapse)", () => {
    // The other side of the same fixture: the "live in-flight turns never
    // collapse early" guarantee must survive alongside the restore fix.
    const turns = groupTurns(
      [
        user("u1", "2025-01-01T00:00:01.000Z"),
        asst("narration", { ts: "2025-01-01T00:00:02.000Z", streaming: false }),
        tool("t1", "bash"),
        asst("final", {
          ts: "2025-01-01T00:00:04.000Z",
          streaming: false,
          completedAt: "2025-06-01T12:00:00.000Z",
        }),
      ],
      true,
    );
    expect(turns[0]!.collapsible).toBe(false);
  });

  test("multiple restored turns each collapse independently, not just the last", () => {
    const turns = groupTurns(
      [
        user("u1", "2025-01-01T00:00:01.000Z"),
        tool("t1", "bash"),
        asst("final1", {
          ts: "2025-01-01T00:00:02.000Z",
          streaming: false,
          completedAt: "2025-06-01T12:00:00.000Z",
        }),
        user("u2", "2025-01-01T00:00:03.000Z"),
        tool("t2", "bash"),
        asst("final2", {
          ts: "2025-01-01T00:00:04.000Z",
          streaming: false,
          completedAt: "2025-06-01T12:00:00.000Z",
        }),
      ],
      false,
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]!.collapsible).toBe(true);
    expect(turns[1]!.collapsible).toBe(true);
  });
});

// Queued follow-ups are delivered after the prior turn's final response; keep both ordering cases covered.
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

// Late subagent notifications collapse the preceding final assistant response (#78).
// A delayed background-agent notification folds into a `notice` transcript item that
// lands AFTER an already-settled (`completedAt`-stamped) final response, inside the
// same turn. The notice breaks the trailing-assistant-run scan, so without promotion
// the settled response folds into `work` and hides behind "Worked for Ns" — leaving
// only the short follow-up visible. The fix promotes the settled response + trailing
// notice(s) into pinned lanes so both stay visible in place.
describe("groupTurns: late notification preserving a settled response", () => {
  test("a settled response trailed by a notice stays visible; the follow-up is the response", () => {
    // [user, asst(narration), tool, asst(finalA, completedAt), notice, asst(followUp)]
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      tool("b1", "bash"),
      asst("finalA", { completedAt: "9000" }),
      notice("n1"),
      asst("followUp"),
    ]);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    // finalA is NOT in work (not collapsed).
    expect(t.work.map((i) => i.id)).not.toContain("finalA");
    // finalA renders as visible/pinned content; followUp is the trailing response.
    expect(t.visible.map((i) => i.id)).toContain("finalA");
    expect(t.response.map((i) => i.id)).toEqual(["followUp"]);
    // The notice renders in place between them — in `visible`, NOT `work`, so it
    // stays visible when the work block is collapsed (the default state).
    expect(t.visible.map((i) => i.id)).toContain("n1");
    expect(t.work.map((i) => i.id)).not.toContain("n1");
    // The turn is collapsible (tool work exists) but finalA is excluded from the
    // collapsed run.
    expect(t.collapsible).toBe(true);
    expect(t.work.map((i) => i.id)).toEqual(["narration", "b1"]);
    // Full lane structure: [work(narration,b1), pinned(finalA), pinned(notice)]
    // with response=[followUp].
    expect(t.lanes.map((l) => l.kind)).toEqual(["work", "pinned", "pinned"]);
    expect(
      t.lanes.map((l) =>
        l.kind === "pinned" ? l.item.id : l.items.map((i) => i.id).join(","),
      ),
    ).toEqual(["narration,b1", "finalA", "n1"]);
    // The turnText footer key is followUp, NOT finalA — the promoted settled
    // response doesn't steal the footer (work→visible→response order, last assistant).
    const footerIds: string[] = [];
    for (const it of [...t.work, ...t.visible, ...t.response]) {
      if (it.kind === "assistant" && it.text) footerIds.push(it.id);
    }
    expect(footerIds[footerIds.length - 1]).toBe("followUp");
  });

  test("greeting still collapses (non-regression): a completedAt trailing run with no notice is unchanged", () => {
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      tool("b1", "bash"),
      asst("final", { completedAt: "9000" }),
    ]);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    // final is the response (the trailing run), not promoted to visible.
    expect(t.response.map((i) => i.id)).toEqual(["final"]);
    expect(t.visible.map((i) => i.id)).toEqual([]);
    expect(t.work.map((i) => i.id)).toEqual(["narration", "b1"]);
    expect(t.collapsible).toBe(true);
    expect(t.lanes.map((l) => l.kind)).toEqual(["work"]);
  });

  test("cold-restore shape still collapses: completedAt far past ts, no trailing notice", () => {
    const turns = groupTurns(
      [
        user("u1", "2025-01-01T00:00:01.000Z"),
        asst("narration", { ts: "2025-01-01T00:00:02.000Z", streaming: false }),
        tool("t1", "bash"),
        asst("final", {
          ts: "2025-01-01T00:00:04.000Z",
          streaming: false,
          completedAt: "2025-06-01T12:00:00.000Z",
        }),
      ],
      false,
    );
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.collapsible).toBe(true);
    expect(t.response.map((i) => i.id)).toEqual(["final"]);
    expect(t.visible.map((i) => i.id)).toEqual([]);
  });

  test("a mid-turn compaction notice is unaffected: a non-settled streaming bubble is NOT promoted", () => {
    // [user, asst(streaming text, NO completedAt), notice, asst(more text)]
    const turns = groupTurns([
      user("u1"),
      asst("streaming-text", { streaming: true }),
      notice("compact", { text: "Compacting context…" }),
      asst("more-text"),
    ]);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    // The first assistant has no completedAt → not promoted. It stays in work
    // (trailed by a non-assistant item, but not settled, so no preservation).
    expect(t.work.map((i) => i.id)).toContain("streaming-text");
    expect(t.visible.map((i) => i.id)).not.toContain("streaming-text");
    // The notice folds into work too (the existing compaction-notice behavior).
    expect(t.work.map((i) => i.id)).toContain("compact");
    // more-text is the trailing response.
    expect(t.response.map((i) => i.id)).toEqual(["more-text"]);
  });

  test("multiple late notifications: every settled response trailed by a notice is promoted", () => {
    // [user, tool, asst(finalA, completedAt), notice, asst(followA, completedAt), notice, asst(followB)]
    const turns = groupTurns([
      user("u1"),
      tool("b1", "bash"),
      asst("finalA", { completedAt: "9000" }),
      notice("n1"),
      asst("followA", { completedAt: "10000" }),
      notice("n2"),
      asst("followB"),
    ]);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    // Both settled responses (finalA, followA) stay visible; only followB is the
    // trailing response.
    expect(t.visible.map((i) => i.id)).toEqual([
      "finalA",
      "n1",
      "followA",
      "n2",
    ]);
    expect(t.response.map((i) => i.id)).toEqual(["followB"]);
    // Only the real tool work stays in work.
    expect(t.work.map((i) => i.id)).toEqual(["b1"]);
    // Full lane structure:
    // [work(b1), pinned(finalA), pinned(n1), pinned(followA), pinned(n2)]
    // with response=[followB].
    expect(t.lanes.map((l) => l.kind)).toEqual([
      "work",
      "pinned",
      "pinned",
      "pinned",
      "pinned",
    ]);
    expect(
      t.lanes.map((l) =>
        l.kind === "pinned" ? l.item.id : l.items.map((i) => i.id).join(","),
      ),
    ).toEqual(["b1", "finalA", "n1", "followA", "n2"]);
  });

  test("an active last turn forces work lanes non-collapsible, but promoted settled responses stay visible", () => {
    const items: TranscriptItem[] = [
      user("u1"),
      asst("narration"),
      tool("b1", "bash"),
      asst("finalA", { completedAt: "9000" }),
      notice("n1"),
      asst("followUp", { streaming: true }),
    ];
    const turns = groupTurns(items, true);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    // Active: turn not collapsible, and every work lane is non-collapsible.
    expect(t.collapsible).toBe(false);
    for (const l of t.lanes)
      if (l.kind === "work") expect(l.collapsible).toBe(false);
    // The promoted settled response + notice still render as visible pinned lanes.
    expect(t.visible.map((i) => i.id)).toContain("finalA");
    expect(t.visible.map((i) => i.id)).toContain("n1");
    expect(t.response.map((i) => i.id)).toEqual(["followUp"]);
  });
});

// Direct unit tests for the preserved-segment scan, isolated from the full lane
// machinery so the boundary conditions are explicit.
describe("findPreservedSegments", () => {
  test("a settled response trailed by a notice yields one segment", () => {
    const items = [
      asst("narration"),
      tool("b1"),
      asst("finalA", { completedAt: "9000" }),
      notice("n1"),
    ];
    expect(findPreservedSegments(items)).toEqual([[2, 3]]);
  });

  test("a settled response as the trailing run (no notice) yields no segment", () => {
    const items = [
      asst("narration"),
      tool("b1"),
      asst("final", { completedAt: "9000" }),
    ];
    expect(findPreservedSegments(items)).toEqual([]);
  });

  test("a non-settled assistant trailed by a notice yields no segment", () => {
    const items = [
      asst("streaming", { streaming: true }),
      notice("compact"),
    ];
    expect(findPreservedSegments(items)).toEqual([]);
  });

  test("multiple settled responses trailed by notices yield multiple segments", () => {
    const items = [
      tool("b1"),
      asst("finalA", { completedAt: "9000" }),
      notice("n1"),
      asst("followA", { completedAt: "10000" }),
      notice("n2"),
    ];
    expect(findPreservedSegments(items)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("a settled response trailed by a tool yields no segment (tool stops promotion)", () => {
    const items = [
      asst("finalA", { completedAt: "9000" }),
      tool("b1"),
    ];
    expect(findPreservedSegments(items)).toEqual([]);
  });

  test("a settled response trailed by an inject yields no segment (inject folds into work)", () => {
    // Journal-nudge injects are designed to fold INTO the collapsed work block
    // (rendering as an `.inject-pill` inside it). Promoting them out would wrongly
    // split a single work run into two. Only `notice` items trigger promotion.
    const items = [
      asst("narration"),
      tool("b1"),
      asst("finalA", { completedAt: "9000" }),
      inject("jn-1"),
      tool("b2"),
      asst("finalB", { completedAt: "10000" }),
    ];
    expect(findPreservedSegments(items)).toEqual([]);
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
    // `narration` is the lead-up paragraph immediately before the answer card, so the
    // keep-visible peel moves it into `visible` alongside the answer tool.
    expect(t.visible.map((i) => i.id)).toEqual(["narration", "a1"]);
    expect(t.work.map((i) => i.id)).toEqual([]);
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

  test("lead-up paragraph before an answer card stays visible, not collapsed", () => {
    // The repro from docs/TODO.md: a long work run, then the agent writes a lead-up
    // paragraph and immediately asks via the answer tool. Without the keep-visible
    // peel, that paragraph is the trailing item of the pre-answer work run and folds
    // into "Worked for Ns" — hiding the question's context directly above the answer
    // card. The peel moves it into a pinned lane between the tools and the Q&A.
    const turns = groupTurns([
      user("u1"),
      tool("b1"),
      tool("b2"),
      asst("lead-up"), // the paragraph that asks the question's context
      tool("a1", "answer"),
      tool("b3"),
      asst("final"),
    ]);
    const t = turns[0]!;
    const lanes = t.lanes;
    expect(lanes.map((l) => l.kind)).toEqual([
      "work",
      "pinned",
      "pinned",
      "work",
    ]);
    expect(lanes.map((l) => (l.kind === "pinned" ? l.item.id : l.id))).toEqual([
      "u1:w0",
      "lead-up",
      "a1",
      "u1:w1",
    ]);
    // The pre-answer work run is just the tools now; lead-up is pinned visible.
    expect(
      lanes[0]!.kind === "work" && lanes[0]!.items.map((i) => i.id),
    ).toEqual(["b1", "b2"]);
    expect(lanes[1]!.kind === "pinned" && lanes[1]!.item.id).toBe("lead-up");
    expect(lanes[2]!.kind === "pinned" && lanes[2]!.item.id).toBe("a1");
    expect(
      lanes[3]!.kind === "work" && lanes[3]!.items.map((i) => i.id),
    ).toEqual(["b3"]);
    // Flat splits reflect the peel: lead-up is in `visible`, not `work`.
    expect(t.visible.map((i) => i.id)).toEqual(["lead-up", "a1"]);
    expect(t.work.map((i) => i.id)).toEqual(["b1", "b2", "b3"]);
    // The pre-answer run still collapses (it still holds tools).
    expect(lanes[0]!.kind === "work" && lanes[0]!.collapsible).toBe(true);
  });

  test("multiple lead-up paragraphs before an answer all stay visible", () => {
    const turns = groupTurns([
      user("u1"),
      tool("b1"),
      asst("lead-1"),
      asst("lead-2"),
      tool("a1", "answer"),
      asst("final"),
    ]);
    const t = turns[0]!;
    expect(t.lanes.map((l) => l.kind)).toEqual([
      "work",
      "pinned",
      "pinned",
      "pinned",
    ]);
    expect(
      t.lanes.filter((l) => l.kind === "pinned").map((l) => l.item.id),
    ).toEqual(["lead-1", "lead-2", "a1"]);
  });

  test("lead-up peel is scoped to the answer tool, not image tools", () => {
    // A screenshot tool is pinned (visible) but isn't a blocking prompt, so its
    // preceding narration should NOT be peeled — it stays in the collapsible work run.
    const png = [{ type: "image", data: "x", mimeType: "image/png" }] as const;
    const turns = groupTurns([
      user("u1"),
      tool("b1"),
      asst("narration"),
      tool("s1", "preview_screenshot", { images: [...png] }),
      asst("final"),
    ]);
    const t = turns[0]!;
    expect(t.visible.map((i) => i.id)).toEqual(["s1"]);
    expect(t.work.map((i) => i.id)).toEqual(["b1", "narration"]);
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
});

describe("groupTurns: injected custom messages", () => {
  test("a non-boundary inject stays in one turn and preserves chronological responses", () => {
    const turns = groupTurns([
      user("u1"),
      asst("narration"),
      tool("b1", "bash"),
      asst("final"),
      inject("n1"),
      tool("journal", "bash"),
      asst("post"),
    ]);
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.id).toBe("u1");
    expect(turn.response.map((i) => i.id)).toEqual(["post"]);
    // The inject `n1` and the prior assistant `final` fold into the work run
    // instead of being pinned as separate visible lanes.
    expect(turn.visible.map((i) => i.id)).toEqual([]);
    expect(turn.work.map((i) => i.id)).toEqual([
      "narration",
      "b1",
      "final",
      "n1",
      "journal",
    ]);
    expect(turn.lanes.map((lane) => lane.item?.id ?? lane.items.map((i) => i.id).join(","))).toEqual([
      "narration,b1,final,n1,journal",
    ]);
    expect(turn.collapsible).toBe(true);
  });

  test("a display:false non-boundary inject stays in the same turn", () => {
    const turns = groupTurns([
      user("u1"),
      asst("final"),
      inject("n1", { display: false }),
      tool("t", "bash"),
      asst("post"),
    ]);
    expect(turns).toHaveLength(1);
    // The inject `n1` and `final` fold into the work run; nothing is pinned visible.
    expect(turns[0]!.visible.map((i) => i.id)).toEqual([]);
    expect(turns[0]!.work.map((i) => i.id)).toEqual(["final", "n1", "t"]);
  });

  test("multiple injects between tools fold into one work run", () => {
    const turns = groupTurns([
      user("u1"),
      tool("edit1", "edit_plan"),
      inject("r1", { customType: "Plan review required" }),
      tool("edit2", "edit_plan"),
      inject("r2", { customType: "Plan review required" }),
      asst("done", { completedAt: "9000" }),
    ]);
    expect(turns).toHaveLength(1);
    const workLanes = turns[0]!.lanes.filter((l) => l.kind === "work");
    expect(workLanes).toHaveLength(1);
    expect(workLanes[0]!.items.map((i) => i.id)).toEqual([
      "edit1",
      "r1",
      "edit2",
      "r2",
    ]);
    // Injects folded into work, not pinned visible; response stays visible.
    expect(turns[0]!.visible).toEqual([]);
    expect(turns[0]!.response.map((i) => i.id)).toEqual(["done"]);
  });

  test("only an explicitly marked inject starts a new turn", () => {
    const turns = groupTurns([
      user("u1"),
      asst("final"),
      inject("n1", { turnBoundary: true, ts: "5000" }),
      tool("t", "bash"),
      asst("post", { completedAt: "9000" }),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u1", "n1"]);
    expect(turns[0]!.response.map((i) => i.id)).toEqual(["final"]);
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

describe("createTurnGrouper", () => {
  test("reuses unchanged settled turn groups when later turns change", () => {
    const memoGroupTurns = createTurnGrouper();
    const items = [
      user("u1"),
      tool("b1", "bash"),
      asst("final-1"),
      user("u2"),
      tool("b2", "bash"),
      asst("final-2"),
    ];
    const first = memoGroupTurns(items);

    (items[5] as AssistantItem).text += " streamed";
    const second = memoGroupTurns(items);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second.map((turn) => turn.id)).toEqual(["u1", "u2"]);
  });

  test("rebuilds a settled turn when a grouping-relevant tool field changes", () => {
    const memoGroupTurns = createTurnGrouper();
    const imageTool = tool("shot", "read");
    const items = [user("u1"), imageTool, asst("final")];
    const first = memoGroupTurns(items);
    expect(first[0]!.lanes[0]!.kind).toBe("work");

    imageTool.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: "abc",
      },
    ];
    const second = memoGroupTurns(items);

    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.lanes[0]!.kind).toBe("pinned");
  });

  test("changing only turnBoundary rebuilds the cached grouping", () => {
    const memoGroupTurns = createTurnGrouper();
    const injectItem = inject("n1");
    const items = [user("u1"), asst("final"), injectItem, tool("t", "bash"), asst("post")];
    const first = memoGroupTurns(items);
    expect(first).toHaveLength(1);
    injectItem.turnBoundary = true;
    const second = memoGroupTurns(items);
    expect(second).toHaveLength(2);
    expect(second[0]).not.toBe(first[0]);

  });

  test("active-tail collapse suppression does not mutate the cached settled turn", () => {
    const memoGroupTurns = createTurnGrouper();
    const items = [user("u1"), tool("b1", "bash"), asst("final")];

    const active = memoGroupTurns(items, true)[0]!;
    expect(active.collapsible).toBe(false);
    expect(active.lanes[0]!.kind).toBe("work");
    if (active.lanes[0]!.kind === "work")
      expect(active.lanes[0]!.collapsible).toBe(false);

    const settled = memoGroupTurns(items, false)[0]!;
    expect(settled.collapsible).toBe(true);
    expect(settled.lanes[0]!.kind).toBe("work");
    if (settled.lanes[0]!.kind === "work")
      expect(settled.lanes[0]!.collapsible).toBe(true);
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
