import { describe, expect, test } from "bun:test";
import type { SessionRef } from "@pilot/protocol";
import { historyToSeedEvents, type HistoryItem } from "./history-seed.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };

// Helpers to build history items with only the fields the fold reads.
// NOTE: per the wire schema, user/assistant/tool_result items do NOT carry
// `emitted_at` (only HistoryItemMeta: item_id + projected_index). The test helpers
// omit it to match the real daemon — the fold's ISO fallback must handle this.
const user = (content: string, promptId = "p1"): HistoryItem =>
  ({ type: "user", content, prompt_id: promptId } as unknown as HistoryItem);

const assistant = (
  blocks: Array<Record<string, unknown>>,
  promptId = "p1",
): HistoryItem =>
  ({ type: "assistant", blocks, prompt_id: promptId } as unknown as HistoryItem);

const toolResult = (
  callId: string,
  content: unknown,
  isError = false,
  promptId = "p1",
): HistoryItem =>
  ({
    type: "tool_result",
    call_id: callId,
    content,
    is_error: isError,
    prompt_id: promptId,
  }) as unknown as HistoryItem;

describe("historyToSeedEvents", () => {
  test("empty items → empty seed", () => {
    expect(historyToSeedEvents([], { ref })).toEqual([]);
  });

  test("user item → userMessage", () => {
    const out = historyToSeedEvents([user("hello world")], { ref });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "userMessage",
      text: "hello world",
      sessionRef: ref,
    });
    expect((out[0] as { id: string }).id).toMatch(/^u-/);
  });

  test("assistant text block → assistantDelta(text channel)", () => {
    const out = historyToSeedEvents(
      [assistant([{ type: "text", text: "hi there" }])],
      { ref },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "assistantDelta",
      text: "hi there",
      channel: "text",
    });
  });

  test("assistant thinking block → assistantDelta(thinking channel)", () => {
    const out = historyToSeedEvents(
      [assistant([{ type: "thinking", text: "reasoning...", signature: "sig" }])],
      { ref },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "assistantDelta",
      text: "reasoning...",
      channel: "thinking",
    });
  });

  test("assistant tool_use block → toolStarted with input", () => {
    const out = historyToSeedEvents(
      [
        assistant([
          { type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } },
        ]),
      ],
      { ref },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "toolStarted",
      callId: "call_1",
      toolName: "shell",
      input: { cmd: "ls" },
    });
  });

  test("assistant multi-block → multiple deltas + toolStarted in order", () => {
    const out = historyToSeedEvents(
      [
        assistant([
          { type: "text", text: "Running a tool" },
          { type: "thinking", text: "planning", signature: "s" },
          { type: "tool_use", id: "c1", name: "edit", input: { file: "a.ts" } },
          { type: "text", text: "Done" },
        ]),
      ],
      { ref },
    );
    expect(out.map((e) => (e as { type: string }).type)).toEqual([
      "assistantDelta",
      "assistantDelta",
      "toolStarted",
      "assistantDelta",
    ]);
  });

  test("tool_result text content → toolFinished(success)", () => {
    const out = historyToSeedEvents(
      [toolResult("c1", { text: "ok" })],
      { ref },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "toolFinished",
      callId: "c1",
      success: true,
      output: "ok",
    });
  });

  test("tool_result with is_error → toolFinished(failure)", () => {
    const out = historyToSeedEvents(
      [toolResult("c1", { text: "boom" }, true)],
      { ref },
    );
    expect(out[0]).toMatchObject({
      type: "toolFinished",
      success: false,
      output: "boom",
    });
  });

  test("tool_result image content → lifts images", () => {
    const out = historyToSeedEvents(
      [
        toolResult("c1", {
          image: { data: "base64==", media_type: "image/png", text_fallback: "img" },
        }),
      ],
      { ref },
    );
    expect(out[0]).toMatchObject({
      type: "toolFinished",
      images: [{ type: "image", data: "base64==", mimeType: "image/png" }],
      output: "img",
    });
  });

  test("tool_result blocks content → joins text blocks", () => {
    const out = historyToSeedEvents(
      [
        toolResult("c1", {
          blocks: [
            { type: "text", text: "part1" },
            { type: "text", text: "part2" },
          ],
        }),
      ],
      { ref },
    );
    expect(out[0]).toMatchObject({ output: "part1part2" });
  });

  test("non-transcript kinds (lifecycle, model_switch, state_update) are skipped", () => {
    const out = historyToSeedEvents(
      [
        { type: "session_lifecycle", kind: "created", session_id: "s", text: "" } as unknown as HistoryItem,
        { type: "model_switch", from_model: "a", to_model: "b" } as unknown as HistoryItem,
        { type: "state_update", delta: {} } as unknown as HistoryItem,
        user("only this counts"),
      ],
      { ref },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "userMessage", text: "only this counts" });
  });

  test("full turn: user → assistant(text+tool_use) → tool_result", () => {
    const out = historyToSeedEvents(
      [
        user("edit the file"),
        assistant([
          { type: "text", text: "Sure" },
          { type: "tool_use", id: "c1", name: "edit", input: { file: "a.ts" } },
        ]),
        toolResult("c1", { text: "edited" }),
      ],
      { ref },
    );
    expect(out.map((e) => (e as { type: string }).type)).toEqual([
      "userMessage",
      "assistantDelta",
      "toolStarted",
      "toolFinished",
    ]);
  });

  test("unknown future history kind is skipped, not crashed", () => {
    const out = historyToSeedEvents(
      [
        { type: "some_future_kind", payload: {} } as unknown as HistoryItem,
        user("still works"),
      ],
      { ref },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "userMessage" });
  });

  test("event ids are unique across items", () => {
    const out = historyToSeedEvents(
      [user("a"), user("b"), user("c")],
      { ref },
    );
    const ids = out.map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
  });

  test("fallback timestamp is a valid ISO string (not h-N) when emitted_at absent", () => {
    // user/assistant/tool_result items carry NO emitted_at in the wire schema —
    // the fold must produce a valid ISO timestamp so the client's Date parse works.
    const out = historyToSeedEvents([user("hello")], { ref });
    const ts = (out[0] as { timestamp: string }).timestamp;
    expect(() => new Date(ts).getTime()).not.toThrow();
    expect(Number.isNaN(new Date(ts).getTime())).toBe(false);
  });

  test("emitted_at is used when present (state_update etc. carry it)", () => {
    const out = historyToSeedEvents(
      [
        { type: "user", content: "x", prompt_id: "p", emitted_at: "2026-06-28T12:00:00Z" } as unknown as HistoryItem,
      ],
      { ref },
    );
    expect((out[0] as { timestamp: string }).timestamp).toBe("2026-06-28T12:00:00Z");
  });
});
