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

  test("assistant item records the timestamp of its first delta only", () => {
    const s = foldAll([
      base({
        type: "assistantDelta",
        text: "a",
        channel: "text",
        timestamp: "t1",
      }),
      base({
        type: "assistantDelta",
        text: "b",
        channel: "text",
        timestamp: "t2",
      }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "assistant", ts: "t1" });
  });

  test("user message carries its event timestamp", () => {
    const s = foldAll([
      base({ type: "userMessage", id: "u1", text: "hi", timestamp: "t1" }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "user", text: "hi", ts: "t1" });
  });

  test("queueUpdated replaces the full queue and omitted snapshots preserve it", () => {
    const queued = {
      id: "q1",
      mode: "steer" as const,
      text: "Inspect first",
      createdAt: "t1",
      updatedAt: "t1",
    };
    const s = initialSessionState();
    foldEvent(s, base({ type: "queueUpdated", messages: [queued] }));
    expect(s.queued).toEqual([queued]);
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/w" },
          title: "T",
          status: "running",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.queued).toEqual([queued]);
    foldEvent(s, base({ type: "queueUpdated", messages: [] }));
    expect(s.queued).toEqual([]);
  });

  test("customMessage folds to an inject item and closes the open assistant", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "final", channel: "text" }),
      base({
        type: "customMessage",
        id: "inject-1",
        customType: "journal-nudge",
        text: "<journal-nudge>do it</journal-nudge>",
        display: true,
        timestamp: "t9",
      }),
    ]);
    // The streaming assistant is closed (no completedAt — the boundary marker doesn't
    // claim the turn ended), and the inject lands as its own item.
    expect(s.items[0]).toMatchObject({ kind: "assistant", streaming: false });
    expect(s.items[0]).not.toHaveProperty("completedAt");
    expect(s.items[1]).toMatchObject({
      kind: "inject",
      id: "inject-1",
      customType: "journal-nudge",
      text: "<journal-nudge>do it</journal-nudge>",
      display: true,
      ts: "t9",
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

  test("tool span stamps startedAt/finishedAt from event timestamps", () => {
    const s = foldAll([
      base({
        type: "toolStarted",
        callId: "c1",
        toolName: "bash",
        timestamp: "100",
      }),
      base({
        type: "toolFinished",
        callId: "c1",
        success: true,
        output: "ok",
        timestamp: "1340",
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "tool",
      startedAt: "100",
      finishedAt: "1340",
    });
  });

  test("a still-running tool has startedAt but no finishedAt", () => {
    const s = foldAll([
      base({
        type: "toolStarted",
        callId: "c1",
        toolName: "bash",
        timestamp: "100",
      }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "tool", startedAt: "100" });
    expect((s.items[0] as { finishedAt?: string }).finishedAt).toBeUndefined();
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

  test("runCompleted interrupts a tool with no matching result", () => {
    const s = foldAll([
      base({
        type: "toolStarted",
        callId: "c1",
        toolName: "answer",
        timestamp: "100",
      }),
      base({
        type: "runCompleted",
        timestamp: "250",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "250",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "tool",
      status: "interrupted",
      startedAt: "100",
      finishedAt: "250",
    });
  });

  test("an idle sessionUpdated does not interrupt a live tool", () => {
    const s = foldAll([
      base({ type: "toolStarted", callId: "c1", toolName: "bash" }),
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "tool", status: "running" });
  });

  test("runFailed interrupts a tool with no matching result", () => {
    const s = foldAll([
      base({ type: "toolStarted", callId: "c1", toolName: "bash" }),
      base({
        type: "runFailed",
        timestamp: "failed-at",
        error: { message: "aborted" },
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "tool",
      status: "interrupted",
      finishedAt: "failed-at",
    });
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

  test("permission dialog request queues + resolves like other dialogs", () => {
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "hostUiRequest",
        request: {
          kind: "permission",
          requestId: "perm1",
          title: "Run bash?",
          toolName: "shell_exec",
          toolInput: '{"command":"ls"}',
          options: ["Deny", "Allow once", "Allow for session"],
        },
      }),
    );
    expect(s.pendingApprovals).toHaveLength(1);
    expect(s.pendingApprovals[0]).toMatchObject({ kind: "permission", requestId: "perm1" });
    foldEvent(s, base({ type: "hostUiResolved", requestId: "perm1" }));
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

  test("extensionCompatibilityIssue becomes a warning notice", () => {
    const s = foldAll([
      base({
        type: "extensionCompatibilityIssue",
        issue: {
          capability: "custom",
          classification: "terminal-only",
          message: "Custom UI is not available in the pilot remote.",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "notice",
      level: "warning",
      text: 'Extension capability "custom" is terminal-only: Custom UI is not available in the pilot remote.',
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

  test("an idle sessionUpdated snapshot closes the open assistant", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "answer", channel: "text" }),
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "assistant", streaming: false });
  });

  test("a mid-turn notice closes the open assistant (no orphaned caret)", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "first", channel: "text" }),
      base({
        type: "hostUiRequest",
        request: {
          kind: "notify",
          requestId: "n1",
          message: "Compacting context…",
          level: "info",
        },
      }),
      base({ type: "assistantDelta", text: "second", channel: "text" }),
    ]);
    // Two separate bubbles split by the notice; only the latest one may stream.
    const assistants = s.items.filter((i) => i.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ text: "first", streaming: false });
    expect(assistants[1]).toMatchObject({ text: "second", streaming: true });
  });

  test("a running sessionUpdated snapshot leaves the assistant open", () => {
    const s = foldAll([
      base({ type: "assistantDelta", text: "answer", channel: "text" }),
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "running",
          updatedAt: "t",
        },
      }),
    ]);
    expect(s.items[0]).toMatchObject({ kind: "assistant", streaming: true });
  });

  test("snapshot.facet propagates to state.facet (the badge data path)", () => {
    // Without the foldEvent guard, facet lands on the wire snapshot but is dropped
    // at the fold, so store.session.facet is always undefined and the badge never
    // renders. This is the test that would have caught the critical gap.
    const s = foldAll([
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t",
          facet: "plan",
        },
      }),
    ]);
    expect(s.facet).toBe("plan");
  });

  test("a snapshot without facet leaves an existing state.facet intact", () => {
    // Mirrors usage's overwrite-guarded semantics: a snapshot that carries facet
    // overwrites; one that omits it (older daemon, usage-less mock abort) must
    // not blank a known facet.
    const s = initialSessionState();
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t1",
          facet: "plan",
        },
      }),
    );
    expect(s.facet).toBe("plan");
    // A later snapshot that omits facet must not erase the known value.
    foldEvent(
      s,
      base({
        type: "sessionUpdated",
        snapshot: {
          ref,
          workspace: { workspaceId: "w", path: "/p" },
          title: "t",
          status: "idle",
          updatedAt: "t2",
        },
      }),
    );
    expect(s.facet).toBe("plan");
  });
});
