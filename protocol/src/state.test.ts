import { describe, expect, test } from "bun:test";
import type { SessionDriverEvent, SessionRef } from "./session-driver.js";
import { foldAll, foldEvent, initialSessionState } from "./state.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const base = (over: Partial<SessionDriverEvent> = {}) =>
  ({ sessionRef: ref, timestamp: "t", ...over }) as SessionDriverEvent;

describe("foldEvent", () => {
  test("accumulates assistant text deltas into one item", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "Hello ", channel: "text" }),
      base({ type: "assistantDelta", text: "world", channel: "text" }),
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      kind: "assistant",
      text: "Hello world",
      streaming: true,
    });
  });

  test("keeps thinking and text on separate channels", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "hmm", channel: "thinking" }),
      base({ type: "assistantDelta", text: "answer", channel: "text" }),
    ]);
    const a = s.items[0] as { kind: string; text: string; thinking: string };
    expect(a.thinking).toBe("hmm");
    expect(a.text).toBe("answer");
  });

  test("a tool call closes the open assistant; later text starts a new item", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "before", channel: "text" }),
      base({ type: "toolStarted", callId: "c1", toolName: "bash" }),
      base({ type: "assistantDelta", text: "after", channel: "text" }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  test("tool lifecycle: running -> ok with output", () => {
    const s = foldAll([
      base({
        type: "toolStarted",
        callId: "c1",
        toolName: "bash",
        input: { command: "ls" },
      }),
      base({ type: "toolUpdated", callId: "c1", text: "partial" }),
      base({
        type: "toolFinished",
        callId: "c1",
        success: true,
        output: "done",
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "tool",
      status: "ok",
      text: "partial",
      output: "done",
    });
  });

  test("tool failure marks error", () => {
    const s = foldAll([
      base({ type: "toolStarted", callId: "c1", toolName: "bash" }),
      base({
        type: "toolFinished",
        callId: "c1",
        success: false,
        output: "boom",
      }),
    ]);
    expect(s.items[0]).toMatchObject({ status: "error" });
  });

  test("dialog requests queue as pending approvals and resolve away", () => {
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "hostUiRequest",
        request: { kind: "confirm", requestId: "r1", title: "t", message: "m" },
      }),
    );
    expect(s.pendingApprovals).toHaveLength(1);
    // duplicate request id is ignored
    foldEvent(
      s,
      base({
        type: "hostUiRequest",
        request: { kind: "confirm", requestId: "r1", title: "t", message: "m" },
      }),
    );
    expect(s.pendingApprovals).toHaveLength(1);
    foldEvent(s, base({ type: "hostUiResolved", requestId: "r1" }));
    expect(s.pendingApprovals).toHaveLength(0);
  });

  test("ambient status upserts and clears; widget keyed", () => {
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "hostUiRequest",
        request: {
          kind: "status",
          requestId: "x",
          key: "branch",
          text: "main",
        },
      }),
    );
    expect(s.ambient.statuses.branch).toBe("main");
    foldEvent(
      s,
      base({
        type: "hostUiRequest",
        request: { kind: "status", requestId: "x", key: "branch" },
      }),
    );
    expect(s.ambient.statuses.branch).toBeUndefined();
    foldEvent(
      s,
      base({
        type: "hostUiRequest",
        request: {
          kind: "widget",
          requestId: "w",
          key: "todo",
          lines: ["a", "b"],
        },
      }),
    );
    expect(s.ambient.widgets.todo?.lines).toEqual(["a", "b"]);
  });

  test("notify becomes a notice item", () => {
    const s = foldAll([
      base({
        type: "hostUiRequest",
        request: {
          kind: "notify",
          requestId: "n",
          message: "hi",
          level: "warning",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "notice",
      level: "warning",
      text: "hi",
    });
  });

  test("runFailed sets failed status and an error notice", () => {
    const s = foldAll([
      base({ type: "runFailed", error: { message: "529 overloaded" } }),
    ]);
    expect(s.status).toBe("failed");
    expect(s.items[0]).toMatchObject({ kind: "notice", level: "error" });
  });

  test("snapshot events update title/status/config", () => {
    const s = foldAll([
      base({
        type: "sessionOpened",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "My session",
          status: "running",
          updatedAt: "t",
          config: { provider: "anthropic", modelId: "claude-opus-4-8" },
        },
      }),
    ]);
    expect(s.title).toBe("My session");
    expect(s.status).toBe("running");
    expect(s.config.modelId).toBe("claude-opus-4-8");
  });
});
