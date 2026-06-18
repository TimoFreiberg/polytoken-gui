import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  SessionRef,
  SessionSnapshot,
  SessionStatus,
} from "@pilot/protocol";
import { type MapCtx, mapPiEvent } from "./event-map.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const ctx: MapCtx = {
  ref,
  now: () => "t",
  toolMeta: (name) => ({ label: undefined, description: `desc:${name}` }),
  snapshot: (status: SessionStatus): SessionSnapshot => ({
    ref,
    workspace: { workspaceId: "w", path: "/w" },
    title: "T",
    status,
    updatedAt: "t",
    config: { modelId: "m" },
  }),
  liveStatus: () => "idle",
};
// pi's event union is broad; cast synthetic literals to it for these mapping tests.
const pi = (e: unknown): AgentSessionEvent => e as AgentSessionEvent;

describe("mapPiEvent", () => {
  test("text_delta -> assistantDelta (text channel)", () => {
    const out = mapPiEvent(
      pi({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
      ctx,
    );
    expect(out).toEqual([
      {
        sessionRef: ref,
        timestamp: "t",
        type: "assistantDelta",
        text: "hi",
        channel: "text",
      },
    ]);
  });

  test("thinking_delta -> assistantDelta (thinking channel)", () => {
    const out = mapPiEvent(
      pi({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
      }),
      ctx,
    );
    expect(out[0]).toMatchObject({
      type: "assistantDelta",
      channel: "thinking",
      text: "hmm",
    });
  });

  test("tool_execution_start -> toolStarted with resolved description", () => {
    const out = mapPiEvent(
      pi({
        type: "tool_execution_start",
        toolCallId: "c",
        toolName: "bash",
        args: { command: "ls" },
      }),
      ctx,
    );
    expect(out[0]).toMatchObject({
      type: "toolStarted",
      callId: "c",
      toolName: "bash",
      description: "desc:bash",
    });
  });

  test("tool_execution_update -> toolUpdated (stringified partial)", () => {
    const out = mapPiEvent(
      pi({
        type: "tool_execution_update",
        toolCallId: "c",
        toolName: "bash",
        partialResult: "out",
      }),
      ctx,
    );
    expect(out[0]).toMatchObject({
      type: "toolUpdated",
      callId: "c",
      text: "out",
    });
  });

  test("tool_execution_end -> toolFinished (success from !isError)", () => {
    const ok = mapPiEvent(
      pi({
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        result: "r",
        isError: false,
      }),
      ctx,
    );
    expect(ok[0]).toMatchObject({
      type: "toolFinished",
      callId: "c",
      success: true,
      output: "r",
    });
    const bad = mapPiEvent(
      pi({
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        result: "e",
        isError: true,
      }),
      ctx,
    );
    expect(bad[0]).toMatchObject({ success: false });
  });

  test("agent_start -> running; agent_end -> runCompleted unless willRetry", () => {
    expect(mapPiEvent(pi({ type: "agent_start" }), ctx)[0]).toMatchObject({
      type: "sessionUpdated",
    });
    expect(
      mapPiEvent(
        pi({ type: "agent_end", messages: [], willRetry: false }),
        ctx,
      )[0],
    ).toMatchObject({ type: "runCompleted" });
    expect(
      mapPiEvent(pi({ type: "agent_end", messages: [], willRetry: true }), ctx),
    ).toEqual([]);
  });

  test("assistant error -> runFailed", () => {
    const out = mapPiEvent(
      pi({
        type: "message_update",
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: "boom",
        },
      }),
      ctx,
    );
    expect(out[0]).toMatchObject({
      type: "runFailed",
      error: { message: "boom" },
    });
  });

  test("session_info_changed -> sessionUpdated at the live status (not forced idle)", () => {
    // At rest: idle.
    expect(
      mapPiEvent(pi({ type: "session_info_changed", name: "n" }), ctx)[0],
    ).toMatchObject({ type: "sessionUpdated", snapshot: { status: "idle" } });
    // Mid-turn (rename while streaming): must stay running, else the fold reducer
    // closes the open assistant bubble and the running indicator clears.
    const running: MapCtx = { ...ctx, liveStatus: () => "running" };
    expect(
      mapPiEvent(pi({ type: "session_info_changed", name: "n" }), running)[0],
    ).toMatchObject({
      type: "sessionUpdated",
      snapshot: { status: "running" },
    });
  });

  test("ignored events map to nothing", () => {
    expect(mapPiEvent(pi({ type: "turn_start" }), ctx)).toEqual([]);
    expect(
      mapPiEvent(pi({ type: "queue_update", steering: [], followUp: [] }), ctx),
    ).toEqual([]);
  });
});
