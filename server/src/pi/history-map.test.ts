import { describe, expect, test } from "bun:test";
import {
  foldAll,
  initialSessionState,
  type SessionRef,
  type SessionSnapshot,
} from "@pilot/protocol";
import { type HistoryMessage, historyToEvents } from "./history-map.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const idleSnapshot: SessionSnapshot = {
  ref,
  workspace: { workspaceId: "w", path: "/w", displayName: "w" },
  title: "t",
  status: "idle",
  updatedAt: "0",
};
const ctx = {
  ref,
  idleSnapshot,
  toolMeta: (name: string) => ({ description: `desc:${name}` }),
};

/** Fold the mapped events the way the server/client would, to assert the transcript. */
function transcript(messages: HistoryMessage[]) {
  return foldAll(historyToEvents(messages, ctx), initialSessionState()).items;
}

describe("historyToEvents", () => {
  test("empty history maps to no events", () => {
    expect(historyToEvents([], ctx)).toEqual([]);
  });

  test("a user message becomes a user item", () => {
    const items = transcript([{ role: "user", content: "hello" }]);
    expect(items).toEqual([
      {
        kind: "user",
        id: expect.any(String),
        text: "hello",
        ts: expect.any(String),
      },
    ]);
  });

  test("a custom message becomes an inject item (turn boundary on reload)", () => {
    const items = transcript([
      { role: "user", content: "do it" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      {
        role: "custom",
        customType: "journal-nudge",
        content: "<journal-nudge>journal?</journal-nudge>",
        display: true,
        timestamp: 1_700_000_000_000,
      },
      { role: "assistant", content: [{ type: "text", text: "journaled" }] },
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "inject",
      "assistant",
    ]);
    expect(items[2]).toMatchObject({
      kind: "inject",
      customType: "journal-nudge",
      text: "<journal-nudge>journal?</journal-nudge>",
      display: true,
      ts: "1700000000000",
    });
  });

  test("a display:false custom message still maps (split-only, no render)", () => {
    const items = transcript([
      { role: "custom", customType: "ctx", content: "hidden", display: false },
    ]);
    expect(items[0]).toMatchObject({ kind: "inject", display: false });
  });

  test("a stored per-message timestamp surfaces as the item's ts", () => {
    // Regression: reloaded transcripts must show pi's real wall-clock times, not the
    // synthetic `h-N` ordering markers (which render as a blank <time> in the UI).
    const items = transcript([
      { role: "user", content: "hi", timestamp: 1_700_000_000_000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "yo" }],
        timestamp: 1_700_000_005_000,
      },
    ]);
    expect(items[0]).toMatchObject({ kind: "user", ts: "1700000000000" });
    expect(items[1]).toMatchObject({ kind: "assistant", ts: "1700000005000" });
  });

  test("a message without a timestamp falls back to a synthetic marker", () => {
    const items = transcript([{ role: "user", content: "hi" }]);
    expect((items[0] as { ts?: unknown })?.ts).toMatch(/^h-\d+$/);
  });

  test("a user image attachment survives reload as typed image data (no [image] text)", () => {
    const items = transcript([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
      },
    ]);
    // The image renders from the typed `images` field, so the text is clean — the old
    // "[image]" placeholder no longer leaks into the bubble.
    expect(items[0]).toMatchObject({
      kind: "user",
      text: "look at this",
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
  });

  test("a tool result image survives reload as typed image data", () => {
    const items = transcript([
      { role: "user", content: "render it" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "render_mockup", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "render_mockup",
        isError: false,
        content: [
          { type: "text", text: "Rendered mockup." },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
      },
    ]);
    const tool = items.find((i) => i.kind === "tool");
    // Output text is clean (no "[image]"); the bytes ride the typed `images` field.
    expect(tool).toMatchObject({
      kind: "tool",
      output: "Rendered mockup.",
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
  });

  test("a trimmed image block (no data) carries no image and no placeholder text", () => {
    const items = transcript([
      {
        role: "user",
        content: [{ type: "text", text: "a" }, { type: "image" }],
      },
    ]);
    expect(items[0]).toMatchObject({ kind: "user", text: "a" });
    expect((items[0] as { images?: unknown }).images).toBeUndefined();
  });

  test("assistant text + thinking land on one closed assistant item", () => {
    const items = transcript([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
    expect(items).toEqual([
      {
        kind: "assistant",
        id: expect.any(String),
        text: "answer",
        thinking: "hmm",
        streaming: false, // closed by the trailing runCompleted
        ts: expect.any(String),
        completedAt: expect.any(String), // turn-end stamp from the runCompleted close
      },
    ]);
  });

  test("a toolCall + its toolResult pair into one finished tool card", () => {
    const items = transcript([
      {
        role: "assistant",
        content: [
          { type: "text", text: "running it" },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "file.ts" }],
        isError: false,
      },
    ]);
    expect(items).toEqual([
      {
        kind: "assistant",
        id: expect.any(String),
        text: "running it",
        thinking: "",
        streaming: false,
        ts: expect.any(String),
      },
      {
        kind: "tool",
        id: "c1",
        name: "bash",
        label: undefined,
        description: "desc:bash",
        input: { command: "ls" },
        output: "file.ts",
        status: "ok",
        // foldEvent now stamps tool spans from the mapped event timestamps so the card
        // can show an elapsed-duration badge.
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
      },
    ]);
  });

  test("an errored toolResult yields an error tool card", () => {
    const items = transcript([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c9", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "c9",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
    ]);
    expect(items.find((i) => i.kind === "tool")).toMatchObject({
      status: "error",
      output: "boom",
    });
  });

  test("an unmatched historical tool call is interrupted at replay end", () => {
    const items = transcript([
      { role: "user", content: "ask me" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dangling-answer",
            name: "answer",
            arguments: { questions: [{ question: "Favorite color?" }] },
          },
        ],
      },
      // A later turn proves the old tool is not still executing, even though pi
      // never persisted a matching toolResult for it.
      { role: "user", content: "try again" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    ]);
    expect(
      items.find((i) => i.kind === "tool" && i.id === "dangling-answer"),
    ).toMatchObject({
      status: "interrupted",
      finishedAt: expect.any(String),
    });
    expect(items.some((i) => i.kind === "tool" && i.status === "running")).toBe(
      false,
    );
  });

  test("an errored assistant turn yields an inline error notice", () => {
    const items = transcript([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "529 overloaded",
      },
    ]);
    expect(items.find((i) => i.kind === "notice")).toMatchObject({
      level: "error",
      text: "529 overloaded",
    });
  });

  test("consecutive turns separate into distinct assistant bubbles", () => {
    const items = transcript([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "one" },
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        content: [{ type: "text", text: "r" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect((items[1] as { text: string }).text).toBe("one");
    expect((items[3] as { text: string }).text).toBe("two");
  });
});
