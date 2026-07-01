import { describe, expect, test } from "bun:test";
import type { components } from "./wire-types.js";
import type {
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  WorkspaceRef,
} from "@pilot/protocol";
import {
  type FoldAccumulator,
  type MapCtx,
  buildPostFetchEvent,
  createAccumulator,
  mapDaemonEvent,
  resetAccumulator,
  snapshotFromState,
} from "./event-map.js";

type DaemonEvent = components["schemas"]["DaemonEvent"];
type DaemonState = components["schemas"]["SessionStateSnapshot"];

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const workspace: WorkspaceRef = { workspaceId: "w", path: "/w" };

// A minimal daemon state snapshot for the test ctx.
const baseState: DaemonState = {
  active_facet: "execute",
  active_model: "anthropic/claude-sonnet-4",
  active_reasoning_effort: "medium",
  env: {},
  flags: [],
  plugin_config: null,
  session_title: "Test Session",
  todos: [],
  turn_in_flight: false,
  context_usage: { limit_tokens: 200_000, used_tokens: 50_000 },
};

const ctx: MapCtx = {
  ref,
  workspace,
  now: () => "t",
  snapshot: (status: SessionStatus): SessionSnapshot => ({
    ref,
    workspace,
    title: "Test Session",
    status,
    updatedAt: "t",
    config: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4", thinkingLevel: "medium" },
    usage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
  }),
  liveStatus: () => "idle",
};

// Cast synthetic literals to the broad DaemonEvent union for mapping tests.
const ev = (e: unknown): DaemonEvent => e as DaemonEvent;

function fold(e: unknown, acc: FoldAccumulator = createAccumulator()) {
  return mapDaemonEvent(ev(e), acc, ctx);
}

describe("mapDaemonEvent", () => {
  // ===== Turn boundaries =====

  test("message_start -> sessionUpdated(running) + clears turn error", () => {
    const acc = createAccumulator();
    acc.turnError = { message: "old error" };
    const out = fold({ type: "message_start", prompt_id: "p1" }, acc);
    expect(out.events).toEqual([
      {
        sessionRef: ref,
        timestamp: "t",
        type: "sessionUpdated",
        snapshot: ctx.snapshot("running"),
      },
    ]);
    expect(acc.turnError).toBeNull();
  });

  test("message_complete (no error) -> fetchState effect for runCompleted with promptId", () => {
    const out = fold({ type: "message_complete", prompt_id: "p1" });
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([
      { type: "fetchState", emit: "runCompleted", promptId: "p1" },
    ]);
  });

  test("message_complete (with turn error) -> runFailed + clears error", () => {
    const acc = createAccumulator();
    acc.turnError = { message: "529 overloaded" };
    const out = fold({ type: "message_complete", prompt_id: "p1" }, acc);
    expect(out.events).toEqual([
      { sessionRef: ref, timestamp: "t", type: "runFailed", error: { message: "529 overloaded" } },
    ]);
    expect(acc.turnError).toBeNull();
  });

  test("message_complete after retry (error cleared by message_start) -> runCompleted effect", () => {
    const acc = createAccumulator();
    acc.turnError = { message: "transient" };
    fold({ type: "message_start", prompt_id: "p2" }, acc); // clears the error
    const out = fold({ type: "message_complete", prompt_id: "p2" }, acc);
    expect(out.effects).toEqual([
      { type: "fetchState", emit: "runCompleted", promptId: "p2" },
    ]);
  });

  test("turn_cancelled -> fetchState effect for sessionUpdated", () => {
    const out = fold({ type: "turn_cancelled", prompt_id: "p1", reason: "user_cancelled" });
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ type: "fetchState", emit: "sessionUpdated" }]);
  });

  // ===== Content block streaming =====

  test("content_block_start(text) -> sets blockKind, no events", () => {
    const acc = createAccumulator();
    const out = fold({
      type: "content_block_start",
      block_index: 0,
      block_type: { type: "text" },
      prompt_id: "p1",
    }, acc);
    expect(out.events).toEqual([]);
    expect(acc.blockKind).toBe("text");
  });

  test("content_block_start(tool_use) -> sets blockKind + toolUseBlock", () => {
    const acc = createAccumulator();
    const out = fold({
      type: "content_block_start",
      block_index: 1,
      block_type: { type: "tool_use", id: "tu1", name: "bash" },
      prompt_id: "p1",
    }, acc);
    expect(out.events).toEqual([]);
    expect(acc.blockKind).toBe("tool_use");
    expect(acc.toolUseBlock).toEqual({ id: "tu1", name: "bash" });
  });

  test("content_block_delta(text) -> assistantDelta (text channel)", () => {
    const acc = createAccumulator();
    acc.blockKind = "text";
    const out = fold({
      type: "content_block_delta",
      block_index: 0,
      delta: { type: "text", text: "hello" },
      prompt_id: "p1",
    }, acc);
    expect(out.events).toEqual([
      { sessionRef: ref, timestamp: "t", type: "assistantDelta", text: "hello", channel: "text" },
    ]);
  });

  test("content_block_delta(thinking) -> assistantDelta (thinking channel)", () => {
    const acc = createAccumulator();
    acc.blockKind = "thinking";
    const out = fold({
      type: "content_block_delta",
      block_index: 0,
      delta: { type: "thinking", text: "hmm" },
      prompt_id: "p1",
    }, acc);
    expect(out.events[0]).toMatchObject({
      type: "assistantDelta",
      channel: "thinking",
      text: "hmm",
    });
  });

  test("content_block_delta(redacted_thinking) -> assistantDelta (thinking)", () => {
    const acc = createAccumulator();
    acc.blockKind = "redacted_thinking";
    const out = fold({
      type: "content_block_delta",
      block_index: 0,
      delta: { type: "redacted_thinking", data: "[redacted]" },
      prompt_id: "p1",
    }, acc);
    expect(out.events[0]).toMatchObject({
      type: "assistantDelta",
      channel: "thinking",
      text: "[redacted]",
    });
  });

  test("content_block_delta(open_ai_reasoning_opaque) -> assistantDelta (thinking)", () => {
    const acc = createAccumulator();
    acc.blockKind = "open_ai_reasoning_opaque";
    const out = fold({
      type: "content_block_delta",
      block_index: 0,
      delta: { type: "open_ai_reasoning_opaque", data: "opaque", id: "rs_123" },
      prompt_id: "p1",
    }, acc);
    expect(out.events[0]).toMatchObject({
      type: "assistantDelta",
      channel: "thinking",
      text: "opaque",
    });
  });

  test("content_block_delta(tool_use_input) -> accumulates, no events", () => {
    const acc = createAccumulator();
    acc.blockKind = "tool_use";
    fold({
      type: "content_block_delta",
      block_index: 1,
      delta: { type: "tool_use_input", partial_json: '{"command":"ls' },
      prompt_id: "p1",
    }, acc);
    const out = fold({
      type: "content_block_delta",
      block_index: 1,
      delta: { type: "tool_use_input", partial_json: '"}' },
      prompt_id: "p1",
    }, acc);
    expect(out.events).toEqual([]);
    expect(acc.toolInputBuffer).toBe('{"command":"ls"}');
  });

  test("content_block_delta(signature_delta) -> no events (pass-through)", () => {
    const acc = createAccumulator();
    acc.blockKind = "thinking";
    const out = fold({
      type: "content_block_delta",
      block_index: 0,
      delta: { type: "signature_delta", signature: "sig" },
      prompt_id: "p1",
    }, acc);
    expect(out.events).toEqual([]);
  });

  test("content_block_delta(text) when blockKind is null -> no events (stale/misordered)", () => {
    const acc = createAccumulator();
    const out = fold({
      type: "content_block_delta",
      block_index: 0,
      delta: { type: "text", text: "orphan" },
      prompt_id: "p1",
    }, acc);
    expect(out.events).toEqual([]);
  });

  test("content_block_stop -> clears blockKind", () => {
    const acc = createAccumulator();
    acc.blockKind = "text";
    const out = fold({
      type: "content_block_stop",
      block_index: 0,
      prompt_id: "p1",
    }, acc);
    expect(out.events).toEqual([]);
    expect(acc.blockKind).toBeNull();
  });

  // ===== Tool plumbing =====

  test("tool_call -> toolStarted with parsed input from accumulator", () => {
    const acc = createAccumulator();
    acc.blockKind = "tool_use";
    acc.toolUseBlock = { id: "tu1", name: "bash" };
    acc.toolInputBuffer = '{"command":"ls -la"}';
    const out = fold({
      type: "tool_call",
      call_id: "call1",
      name: "bash",
      prompt_id: "p1",
    }, acc);
    expect(out.events[0]).toMatchObject({
      type: "toolStarted",
      toolName: "bash",
      callId: "call1",
      input: { command: "ls -la" },
    });
  });

  test("tool_call with explicit input field -> uses it over the accumulator", () => {
    const acc = createAccumulator();
    acc.toolInputBuffer = '{"old":"stale"}';
    const out = fold({
      type: "tool_call",
      call_id: "call1",
      input: { command: "echo hi" },
      name: "bash",
      prompt_id: "p1",
    }, acc);
    expect(out.events[0]).toMatchObject({
      input: { command: "echo hi" },
    });
  });

  test("tool_call with no input and no buffer -> undefined input", () => {
    const acc = createAccumulator();
    const out = fold({
      type: "tool_call",
      call_id: "call1",
      name: "bash",
      prompt_id: "p1",
    }, acc);
    expect(out.events[0]).toMatchObject({
      type: "toolStarted",
      input: undefined,
    });
  });

  test("tool_call with invalid JSON buffer -> falls back to raw string", () => {
    const acc = createAccumulator();
    acc.toolInputBuffer = "not json";
    const out = fold({
      type: "tool_call",
      call_id: "call1",
      name: "bash",
      prompt_id: "p1",
    }, acc);
    expect(out.events[0]).toMatchObject({ input: "not json" });
  });

  test("tool_result (success, content string) -> toolFinished", () => {
    const out = fold({
      type: "tool_result",
      call_id: "call1",
      content: "done",
      is_error: false,
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({
      type: "toolFinished",
      callId: "call1",
      success: true,
      output: "done",
    });
  });

  test("tool_result (error) -> toolFinished with success:false", () => {
    const out = fold({
      type: "tool_result",
      call_id: "call1",
      content: "boom",
      is_error: true,
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({ success: false, output: "boom" });
  });

  test("tool_result with content_full image -> lifts image into images field", () => {
    const out = fold({
      type: "tool_result",
      call_id: "call1",
      content: "Rendered.",
      content_full: { image: { data: "QUJD", media_type: "image/png", text_fallback: "img" } },
      is_error: false,
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({
      type: "toolFinished",
      output: "Rendered.",
      images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    });
  });

  test("tool_result with content_full text variant -> uses text from content", () => {
    const out = fold({
      type: "tool_result",
      call_id: "call1",
      content: "short",
      content_full: { text: "longer text" },
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({ output: "short" });
  });

  test("tool_result with content_full blocks variant -> extracts text", () => {
    const out = fold({
      type: "tool_result",
      call_id: "call1",
      content_full: {
        blocks: [
          { type: "text", text: "line1 " },
          { type: "text", text: "line2" },
        ],
      },
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({ output: "line1 line2" });
  });

  test("tool_result with null content and null content_full -> undefined output", () => {
    const out = fold({
      type: "tool_result",
      call_id: "call1",
      content: null,
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({ output: undefined });
  });

  // ===== Queue (steering / follow-up) =====

  test("pending_turn_input_queued -> refetchQueue effect, no events", () => {
    const out = fold({
      type: "pending_turn_input_queued",
      admission_prompt_id: "p1",
      content: "steer this",
      item_id: "item1",
      queue_revision: 1,
    });
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([{ type: "refetchQueue" }]);
  });

  test("pending_turn_input_dequeued -> refetchQueue effect", () => {
    const out = fold({
      type: "pending_turn_input_dequeued",
      item_id: "item1",
      queue_revision: 2,
    });
    expect(out.effects).toEqual([{ type: "refetchQueue" }]);
  });

  test("pending_turn_input_discarded -> refetchQueue effect", () => {
    const out = fold({
      type: "pending_turn_input_discarded",
      item_ids: ["item1"],
      queue_revision: 3,
      reason: "superseded",
    });
    expect(out.effects).toEqual([{ type: "refetchQueue" }]);
  });

  test("pending_turn_input_drained -> queuedMessageStarted + queueUpdated([])", () => {
    const out = fold({
      type: "pending_turn_input_drained",
      admission_prompt_ids: ["p1"],
      content: "steer this",
      final_prompt_id: "p2",
      item_ids: ["item1"],
      queue_revision: 0,
      raw_history_index: 5,
    });
    expect(out.events).toHaveLength(2);
    expect(out.events[0]).toMatchObject({
      type: "queuedMessageStarted",
      message: { mode: "steer", text: "steer this" },
    });
    expect(out.events[1]).toMatchObject({ type: "queueUpdated", messages: [] });
  });

  test("pending_turn_input_drained (multi-item) -> queuedMessageStarted + refetchQueue effect", () => {
    const out = fold({
      type: "pending_turn_input_drained",
      admission_prompt_ids: ["p1", "p2"],
      content: "steer this",
      final_prompt_id: "p3",
      item_ids: ["item1", "item2"],
      queue_revision: 0,
      raw_history_index: 5,
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "queuedMessageStarted",
      message: { mode: "steer", text: "steer this" },
    });
    expect(out.effects).toEqual([{ type: "refetchQueue" }]);
  });

  // ===== Errors + retries =====

  test("model_error -> sets turnError + notify (deferred failure)", () => {
    const acc = createAccumulator();
    const out = fold({
      type: "model_error",
      error: { type: "rate_limited", retry_after_seconds: 30 },
      prompt_id: "p1",
    }, acc);
    expect(acc.turnError).toEqual({ message: "Rate limited (retry in 30s)" });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: { kind: "notify", level: "warning" },
    });
  });

  test("model_error (transport) -> human-readable message", () => {
    const acc = createAccumulator();
    fold({
      type: "model_error",
      error: { type: "transport", kind: "connection_refused", message: "conn refused" },
      prompt_id: "p1",
    }, acc);
    expect(acc.turnError?.message).toBe("Transport error (connection_refused): conn refused");
  });

  test("model_error (other) -> code: message format", () => {
    const acc = createAccumulator();
    fold({
      type: "model_error",
      error: { type: "other", code: "E500", message: "internal" },
      prompt_id: "p1",
    }, acc);
    expect(acc.turnError?.message).toBe("E500: internal");
  });

  test("retry_wait -> notify with attempt/max_retries", () => {
    const out = fold({
      type: "retry_wait",
      attempt: 2,
      delay_ms: 5000,
      error_summary: "rate_limited",
      error_type: "rate_limited",
      max_retries: 5,
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: {
        kind: "notify",
        message: "Retrying (attempt 2/5): rate_limited",
        level: "warning",
      },
    });
  });

  test("stream_discontinuity -> reseed effect", () => {
    const out = fold({ type: "stream_discontinuity", missed: 3 });
    expect(out.effects).toEqual([{ type: "reseed" }]);
  });

  // ===== Session metadata =====

  test("session_title_changed -> sessionUpdated with new title (live status)", () => {
    const out = fold({
      type: "session_title_changed",
      source: "inferred",
      title: "My New Title",
    });
    expect(out.events[0]).toMatchObject({
      type: "sessionUpdated",
      snapshot: { title: "My New Title", status: "idle" },
    });
  });

  test("session_title_changed mid-turn -> uses liveStatus (running)", () => {
    const running: MapCtx = { ...ctx, liveStatus: () => "running" };
    const out = mapDaemonEvent(
      ev({ type: "session_title_changed", source: "operator", title: "X" }),
      createAccumulator(),
      running,
    );
    expect(out.events[0]).toMatchObject({ snapshot: { status: "running" } });
  });

  test("session_state_changed -> fetchState effect for sessionUpdated", () => {
    const out = fold({
      type: "session_state_changed",
      domains: ["todos"],
    });
    expect(out.effects).toEqual([{ type: "fetchState", emit: "sessionUpdated" }]);
  });

  test("model_switch -> sessionUpdated with new config (no fetch)", () => {
    const out = fold({
      type: "model_switch",
      from_model: "anthropic/old",
      to_model: "openai/gpt-5",
      to_reasoning_effort: "high",
    });
    expect(out.events[0]).toMatchObject({
      type: "sessionUpdated",
      snapshot: {
        config: { provider: "openai", modelId: "openai/gpt-5", thinkingLevel: "high" },
      },
    });
  });

  test("session_rewound -> reseed effect", () => {
    const out = fold({
      type: "session_rewound",
      rewound_to_index: 3,
    });
    expect(out.effects).toEqual([{ type: "reseed" }]);
  });

  test("context_cleared -> reseed effect", () => {
    const out = fold({
      type: "context_cleared",
      facet: "execute",
    });
    expect(out.effects).toEqual([{ type: "reseed" }]);
  });

  test("facet_switch -> fetchState effect for sessionUpdated", () => {
    const out = fold({
      type: "facet_switch",
      from_facet: "plan",
      to_facet: "execute",
    });
    expect(out.effects).toEqual([{ type: "fetchState", emit: "sessionUpdated" }]);
  });

  // ===== Compaction =====

  test("compaction_started -> notify (info)", () => {
    const out = fold({
      type: "compaction_started",
      compaction_id: "c1",
      reason: "auto_threshold",
    });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: { kind: "notify", message: "Compacting context…", level: "info" },
    });
  });

  test("compaction_complete -> notify + fetchState", () => {
    const out = fold({
      type: "compaction_complete",
      compaction_id: "c1",
      preserved_files_count: 3,
      summary_length: 500,
      todos_count: 2,
    });
    expect(out.events[0]).toMatchObject({ request: { kind: "notify", level: "info" } });
    expect(out.effects).toEqual([{ type: "fetchState", emit: "sessionUpdated" }]);
  });

  test("compaction_cancelled -> notify (warning)", () => {
    const out = fold({
      type: "compaction_cancelled",
      compaction_id: "c1",
      reason: "user_cancelled",
    });
    expect(out.events[0]).toMatchObject({ request: { level: "warning" } });
  });

  test("compaction_failed -> notify (error)", () => {
    const out = fold({
      type: "compaction_failed",
      compaction_id: "c1",
      reason: { type: "provider_error", detail: "boom" },
    });
    expect(out.events[0]).toMatchObject({ request: { level: "error" } });
  });

  test("subagent_compaction_notice -> notify with summary", () => {
    const out = fold({
      type: "subagent_compaction_notice",
      compaction_id: "c1",
      emitted_at: "2026-06-28T10:00:00Z",
      summary: "Subagent context compacted",
    });
    expect(out.events[0]).toMatchObject({
      request: { message: "Subagent context compacted" },
    });
  });

  // ===== Notifications =====

  test("notification_queued -> notify with summary", () => {
    const out = fold({
      type: "notification_queued",
      notification: {
        id: "n1",
        notification_type: { type: "job_complete", exit_code: 0 },
        source: "background",
        summary: "Job finished",
        timestamp: "2026-06-28T10:00:00Z",
      },
    });
    expect(out.events[0]).toMatchObject({
      request: { kind: "notify", message: "Job finished" },
    });
  });

  // ===== System reminders =====

  test("system_reminder (non-plan-review reason) -> customMessage (display:false)", () => {
    const out = fold({
      type: "system_reminder",
      body: "Don't forget the tests",
      display_name: "Reminder",
      emitted_at: "2026-06-28T10:00:00Z",
      reason: { type: "session_start" },
      slug: "test-reminder",
    });
    expect(out.events[0]).toMatchObject({
      type: "customMessage",
      customType: "test-reminder",
      text: "Don't forget the tests",
      display: false,
    });
  });

  test("system_reminder (plan_review_required) -> visible customMessage", () => {
    const out = fold({
      type: "system_reminder",
      body: "The plan reviewer flagged a missing error-handling path.",
      display_name: "Reminder",
      emitted_at: "2026-06-28T10:00:00Z",
      reason: { type: "plan_review_required" },
      slug: "plan-review-1",
    });
    expect(out.events[0]).toMatchObject({
      type: "customMessage",
      customType: "Plan review required",
      text: "The plan reviewer flagged a missing error-handling path.",
      display: true,
    });
  });

  test("system_reminder (plan_mode_reinforcement) -> visible customMessage", () => {
    const out = fold({
      type: "system_reminder",
      body: "Stay in plan mode until the design is settled.",
      display_name: "Reminder",
      emitted_at: "2026-06-28T10:00:00Z",
      reason: { type: "plan_mode_reinforcement" },
      slug: "plan-reinforce-1",
    });
    expect(out.events[0]).toMatchObject({
      type: "customMessage",
      customType: "Plan mode reminder",
      display: true,
    });
  });

  test("system_reminder (plan_verification) -> visible customMessage", () => {
    const out = fold({
      type: "system_reminder",
      body: "Verify the implementation matches the approved plan.",
      display_name: "Reminder",
      emitted_at: "2026-06-28T10:00:00Z",
      reason: { type: "plan_verification" },
      slug: "plan-verify-1",
    });
    expect(out.events[0]).toMatchObject({
      type: "customMessage",
      customType: "Plan verification",
      display: true,
    });
  });

  test("system_reminder (unknown reason type) -> customMessage (display:false, forward-compat)", () => {
    const out = fold({
      type: "system_reminder",
      body: "Some future reason not yet in the enum.",
      display_name: "Reminder",
      emitted_at: "2026-06-28T10:00:00Z",
      reason: { type: "some_future_reason" },
      slug: "future-reminder",
    });
    expect(out.events[0]).toMatchObject({
      type: "customMessage",
      customType: "future-reminder",
      text: "Some future reason not yet in the enum.",
      display: false,
    });
  });

  // ===== Subagent routing =====

  test("events with subagent_handle are skipped (not top-level transcript)", () => {
    const out = fold({
      type: "content_block_delta",
      block_index: 0,
      delta: { type: "text", text: "subagent text" },
      prompt_id: "p1",
      subagent_handle: "sub1",
    });
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([]);
  });

  test("message_start with subagent_handle is skipped", () => {
    const out = fold({
      type: "message_start",
      prompt_id: "p1",
      subagent_handle: "sub1",
    });
    expect(out.events).toEqual([]);
  });

  // ===== v1-ignored variants (return empty) =====

  test("heartbeat -> empty", () => {
    expect(fold({ type: "heartbeat", timestamp: "t" })).toEqual({ events: [], effects: [] });
  });

  test("notification_autodrain_switch -> empty", () => {
    expect(fold({ type: "notification_autodrain_switch", enabled: true })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("notifications_drained -> empty", () => {
    expect(fold({ type: "notifications_drained", count: 3 })).toEqual({
      events: [],
      effects: [],
    });
  });

  // ===== Host UI + permissions (Chunk 3) =====

  test("permission_monitor_switch -> sessionUpdated carries the new mode + setMonitorMode effect", () => {
    const out = fold({
      type: "permission_monitor_switch",
      from_monitor: { type: "standard" },
      to_monitor: { type: "bypass" },
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "sessionUpdated",
      snapshot: { permissionMonitor: "bypass" },
    });
    expect(out.effects).toEqual([{ type: "setMonitorMode", mode: "bypass" }]);
  });

  test("interrogative (confirmation) -> confirm card + registerInterrogative", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "i1",
      interrogative_type: "confirmation",
      question: "Continue?",
      prompt_id: "p1",
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: { kind: "confirm", requestId: "i1", message: "Continue?" },
    });
    expect(out.effects).toEqual([
      {
        type: "registerInterrogative",
        pending: { interrogativeId: "i1", interrogativeType: "confirmation" },
      },
    ]);
  });

  test("interrogative (clarification) -> select card + option keys captured", () => {
    const out = fold({
      type: "interrogative",
      clarification_options: [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      interrogative_id: "i2",
      interrogative_type: "clarification",
      prompt_id: "p1",
      question: "Which?",
    });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: { kind: "select", requestId: "i2", options: ["Yes", "No"] },
    });
    expect(out.effects[0]).toMatchObject({
      type: "registerInterrogative",
      pending: {
        interrogativeId: "i2",
        interrogativeType: "clarification",
        clarificationLabels: ["Yes", "No"],
        clarificationOptionKeys: ["yes", "no"],
      },
    });
  });

  test("interrogative (capability) -> confirm card", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "i3",
      interrogative_type: "capability",
      prompt_id: "p1",
      question: "Grant network access?",
    });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: { kind: "confirm", requestId: "i3", message: "Grant network access?" },
    });
  });

  test("interrogative (plan_handoff) -> plan card with markdown + action labels", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "i4",
      interrogative_type: "plan_handoff",
      plan_handoff: {
        action_labels: {
          cancel: "Cancel",
          implement_current_context: "Implement here",
          implement_new_context: "Implement fresh",
        },
        display_path: "/plan.md",
        plan_path: "/plan.md",
        plan_text: "the plan",
        target_facet: "execute",
        title: "Review plan",
      },
      prompt_id: "p1",
      question: "Approve plan?",
    });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: {
        kind: "plan",
        requestId: "i4",
        title: "Review plan",
        planText: "the plan",
        displayPath: "/plan.md",
        targetFacet: "execute",
        actionLabels: ["Implement fresh", "Implement here", "Cancel"],
      },
    });
  });

  test("interrogative (plan_handoff) with null plan_handoff -> fallback labels + empty body", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "i4",
      interrogative_type: "plan_handoff",
      plan_handoff: null,
      prompt_id: "p1",
      question: "Approve plan?",
    });
    expect(out.events[0]).toMatchObject({
      request: {
        kind: "plan",
        planText: "",
        actionLabels: ["Implement (new context)", "Implement (current context)", "Cancel"],
      },
    });
  });

  test("interrogative (permission) with null context -> permission card, all 7 options", () => {
    // No permission_tool_call + no permission_candidate_rule: degraded but not
    // silent. All 7 options render (backward compat), no tool context (AC.3).
    const out = fold({
      type: "interrogative",
      interrogative_id: "i5",
      interrogative_type: "permission",
      prompt_id: "p1",
      question: "Run bash?",
    });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: {
        kind: "permission",
        requestId: "i5",
        title: "Run bash?",
        toolName: null,
        toolInput: null,
        options: [
          "Deny",
          "Allow once",
          "Allow for session",
          "Allow for project (local)",
          "Allow for project",
          "Allow for user (local)",
          "Allow for user",
        ],
      },
    });
    // All 7 choices captured (no pruning — keep_targets absent).
    const eff = out.effects[0] as Extract<
      (typeof out.effects)[number],
      { type: "registerInterrogative" }
    >;
    expect(eff).toMatchObject({
      type: "registerInterrogative",
      pending: {
        interrogativeId: "i5",
        interrogativeType: "permission",
      },
    });
    expect(eff.pending.permissionChoices).toHaveLength(7);
    expect(eff.pending.permissionChoices![0]).toMatchObject({
      granted: false,
      persistenceTarget: null,
    });
  });

  test("interrogative (permission) with tool_call -> permission card shows tool name + input", () => {
    // AC.1: the tool name + a JSON preview of the tool input render in the card.
    const out = fold({
      type: "interrogative",
      interrogative_id: "i6",
      interrogative_type: "permission",
      prompt_id: "p1",
      question: "Run bash?",
      permission_tool_call: {
        tool_name: "shell_exec",
        tool_use_id: "tu1",
        input: { command: "rm -rf /tmp/test" },
      },
    });
    expect(out.events[0]).toMatchObject({
      request: {
        kind: "permission",
        toolName: "shell_exec",
        toolInput: JSON.stringify({ command: "rm -rf /tmp/test" }, null, 2),
      },
    });
  });

  test("interrogative (permission) with keep_targets=[session] -> only 3 options render", () => {
    // AC.2: only Deny + Allow once + Allow for session render (project/user pruned).
    const out = fold({
      type: "interrogative",
      interrogative_id: "i7",
      interrogative_type: "permission",
      prompt_id: "p1",
      question: "Run bash?",
      permission_candidate_rule: {
        keep_targets: ["session"],
        default_target: "session",
        candidate_rule_raw: "rule",
        candidate_rule_resolved_today: "rule-today",
        floor_context: { tool_name: "shell_exec" },
      },
    });
    expect(out.events[0]).toMatchObject({
      request: {
        kind: "permission",
        options: ["Deny", "Allow once", "Allow for session"],
      },
    });
    // The pruned subset is captured (3 choices, not 7).
    const eff = out.effects[0] as Extract<
      (typeof out.effects)[number],
      { type: "registerInterrogative" }
    >;
    expect(eff.pending.permissionChoices).toHaveLength(3);
    expect(eff.pending.permissionChoices![2]).toMatchObject({
      granted: true,
      persistenceTarget: "session",
    });
  });

  test("interrogative (permission) with keep_targets=[user] -> Deny + Allow once + Allow for user (local) + Allow for user", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "i8",
      interrogative_type: "permission",
      prompt_id: "p1",
      question: "Run bash?",
      permission_candidate_rule: {
        keep_targets: ["user_local", "user"],
        default_target: "user",
        candidate_rule_raw: "rule",
        candidate_rule_resolved_today: "rule-today",
        floor_context: { tool_name: "shell_exec" },
      },
    });
    expect(out.events[0]).toMatchObject({
      request: {
        options: ["Deny", "Allow once", "Allow for user (local)", "Allow for user"],
      },
    });
    const eff = out.effects[0] as Extract<
      (typeof out.effects)[number],
      { type: "registerInterrogative" }
    >;
    expect(eff.pending.permissionChoices).toHaveLength(4);
  });

  test("ask_user_question -> qna card + question/option ids captured", () => {
    const out = fold({
      type: "ask_user_question",
      interrogative_id: "q1",
      payload: {
        questions: [
          {
            id: "q-a",
            mode: "single_select",
            options: [
              { id: "o1", label: "Opt1", description: "desc" },
              { id: "o2", label: "Opt2" },
            ],
            question: "Pick one?",
          },
          {
            id: "q-b",
            mode: "text",
            question: "Free text?",
            allow_free_text: true,
          },
        ],
      },
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: {
        kind: "qna",
        requestId: "q1",
        questions: [
          {
            question: "Pick one?",
            options: [
              { label: "Opt1", description: "desc" },
              { label: "Opt2", description: undefined },
            ],
            multiSelect: false,
          },
          { question: "Free text?", multiSelect: false },
        ],
      },
    });
    expect(out.effects[0]).toMatchObject({
      type: "registerInterrogative",
      pending: {
        interrogativeId: "q1",
        interrogativeType: "ask_user_question",
        questions: [
          { questionId: "q-a", optionIds: ["o1", "o2"], optionLabels: ["Opt1", "Opt2"] },
          { questionId: "q-b", optionIds: [], optionLabels: [] },
        ],
      },
    });
  });

  test("interrogative (goal_proposal) -> confirm card + registerInterrogative", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "g1",
      interrogative_type: "goal_proposal",
      goal_proposal: {
        title: "Ship feature X",
        proposed_summary: "Implement the new dashboard widget",
        proposed_file_path: "/goal.md",
        action_labels: { accept: "Accept", reject: "Reject" },
      },
      prompt_id: "p1",
      question: "Propose goal?",
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: {
        kind: "confirm",
        requestId: "g1",
        title: "Ship feature X",
        message: "Implement the new dashboard widget",
      },
    });
    expect(out.effects).toEqual([
      {
        type: "registerInterrogative",
        pending: { interrogativeId: "g1", interrogativeType: "goal_proposal" },
      },
    ]);
  });

  test("interrogative (goal_proposal) with null goal_proposal -> fallback title", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "g2",
      interrogative_type: "goal_proposal",
      goal_proposal: null,
      prompt_id: "p1",
      question: "Propose goal?",
    });
    expect(out.events[0]).toMatchObject({
      request: {
        kind: "confirm",
        requestId: "g2",
        title: "Goal proposal",
      },
    });
    expect(out.effects[0]).toMatchObject({
      type: "registerInterrogative",
      pending: { interrogativeId: "g2", interrogativeType: "goal_proposal" },
    });
  });

  test("interrogative (unknown_type) -> confirm dialog (deny-safe) + registerInterrogative", () => {
    // Cast to bypass the TS type — the runtime path is JSON.parse'd wire data.
    const out = fold({
      type: "interrogative",
      interrogative_id: "u1",
      interrogative_type: "some_future_type",
      prompt_id: "p1",
      question: "?",
    } as unknown as Parameters<typeof fold>[0]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "hostUiRequest",
      request: {
        kind: "confirm",
        requestId: "u1",
        title: "⚠ Unknown request type: some_future_type",
      },
    });
    expect(out.effects).toEqual([
      {
        type: "registerInterrogative",
        pending: { interrogativeId: "u1", interrogativeType: "unknown" },
      },
    ]);
  });

  test("interrogative with subagent_handle is skipped (not top-level)", () => {
    const out = fold({
      type: "interrogative",
      interrogative_id: "i1",
      interrogative_type: "confirmation",
      prompt_id: "p1",
      question: "ok?",
      subagent_handle: "sub1",
    });
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([]);
  });

  test("hook_fired -> empty", () => {
    expect(
      fold({
        type: "hook_fired",
        event_type: "pre_tool",
        hook_name: "my-hook",
        outcome: "allowed",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("context_loaded -> empty", () => {
    expect(fold({ type: "context_loaded", hash: "abc", path: "/foo" })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("tool_reveal -> empty", () => {
    expect(
      fold({
        type: "tool_reveal",
        prompt_id: "p1",
        source: { type: "tool_search" },
        tool_names: ["bash"],
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("tool_exposure_changed -> empty", () => {
    expect(
      fold({
        type: "tool_exposure_changed",
        exposed_count: 5,
        provider_capability_mode: "eager",
        reason: "initial",
        revealed_count: 3,
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("classifier_decision -> empty", () => {
    expect(
      fold({
        type: "classifier_decision",
        call_id: "c1",
        outcome: "allow",
        prompt_id: "p1",
        tool_name: "bash",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("extension_registered -> empty", () => {
    expect(fold({ type: "extension_registered", name: "my-ext" })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("subagent_started -> empty", () => {
    expect(
      fold({
        type: "subagent_started",
        handle: "sub1",
        model: "anthropic/claude",
        subagent_type: "general-purpose",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("subagent_completed -> empty", () => {
    expect(
      fold({
        type: "subagent_completed",
        handle: "sub1",
        outcome: { type: "success" },
        result_summary: "done",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("subsession_created -> empty", () => {
    expect(
      fold({
        type: "subsession_created",
        facet: "execute",
        port: 12345,
        prompt_summary: "summary",
        subsession_id: "sub1",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("subsession_stopped -> empty", () => {
    expect(
      fold({ type: "subsession_stopped", subsession_id: "sub1", summary: "done" }),
    ).toEqual({ events: [], effects: [] });
  });

  test("subsession_terminated -> empty", () => {
    expect(
      fold({ type: "subsession_terminated", reason: "cancelled", subsession_id: "sub1" }),
    ).toEqual({ events: [], effects: [] });
  });

  test("subsession_interrogative -> empty", () => {
    expect(
      fold({
        type: "subsession_interrogative",
        interrogative_id: "i1",
        interrogative_type: "confirmation",
        question: "ok?",
        subsession_id: "sub1",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("subsession_message -> empty", () => {
    expect(
      fold({
        type: "subsession_message",
        subsession_id: "sub1",
        summary: "msg",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("mcp_server_connected -> empty", () => {
    expect(
      fold({
        type: "mcp_server_connected",
        resource_count: 3,
        server_name: "my-mcp",
        tool_count: 5,
        transport: "stdio",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("mcp_server_disconnected -> empty", () => {
    expect(
      fold({
        type: "mcp_server_disconnected",
        reason: "error",
        server_name: "my-mcp",
        transport: "stdio",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("mcp_server_reconnecting -> empty", () => {
    expect(
      fold({
        type: "mcp_server_reconnecting",
        attempt: 1,
        next_retry_in_ms: 1000,
        server_name: "my-mcp",
        transport: "stdio",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("mcp_server_disabled -> empty", () => {
    expect(
      fold({
        type: "mcp_server_disabled",
        reason: "config_error",
        server_name: "my-mcp",
        transport: "stdio",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("image_reference_resolved -> empty", () => {
    expect(
      fold({
        type: "image_reference_resolved",
        file_size_bytes: 1024,
        media_type: "image/png",
        path: "/img.png",
        prompt_id: "p1",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("job_promoted -> empty", () => {
    expect(fold({ type: "job_promoted", job_id: "j1" })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("job_completed -> empty", () => {
    expect(fold({ type: "job_completed", exit_code: 0, job_id: "j1" })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("job_expiring -> empty", () => {
    expect(fold({ type: "job_expiring", job_id: "j1" })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("job_cancelled -> empty", () => {
    expect(fold({ type: "job_cancelled", job_id: "j1" })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("job_updated -> empty", () => {
    expect(fold({ type: "job_updated", job_id: "j1" })).toEqual({
      events: [],
      effects: [],
    });
  });

  test("goal_driver_update -> empty", () => {
    expect(
      fold({
        type: "goal_driver_update",
        goal: null,
        proposed_summary: null,
        transition: "proposed",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("agent_block_violation -> empty", () => {
    expect(
      fold({
        type: "agent_block_violation",
        path: "/some/path",
        tool_name: "shell_exec",
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("usage_throttle -> empty", () => {
    expect(
      fold({
        type: "usage_throttle",
        action: "other",
        provider: "anthropic",
        snapshot: { input_tokens: 100, output_tokens: 50 },
      }),
    ).toEqual({ events: [], effects: [] });
  });

  test("unknown variant type -> empty + console.warn (observable, not silent)", () => {
    // The default branch must warn so a future DaemonEvent variant is observable
    // (the plan's loud-failure principle), not silently swallowed.
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const out = fold({ type: "future_unknown_variant" });
      expect(out).toEqual({ events: [], effects: [] });
      expect(warned).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// buildPostFetchEvent — pure follow-up event builder after a fetchState effect.
// ---------------------------------------------------------------------------

describe("buildPostFetchEvent", () => {
  test("runCompleted -> runCompleted event with idle snapshot", () => {
    const out = buildPostFetchEvent("runCompleted", ctx);
    expect(out).toMatchObject({
      type: "runCompleted",
      snapshot: { status: "idle" },
    });
  });

  test("runCompleted with promptId -> stamps userEntryId + assistantEntryId", () => {
    const out = buildPostFetchEvent("runCompleted", ctx, "p1");
    expect(out).toMatchObject({
      type: "runCompleted",
      snapshot: { status: "idle" },
      userEntryId: "p1",
      assistantEntryId: "p1",
    });
  });

  test("runCompleted without promptId -> no entryIds (pre-fix behavior preserved)", () => {
    const out = buildPostFetchEvent("runCompleted", ctx);
    expect(out).toMatchObject({ type: "runCompleted" });
    expect(out).not.toHaveProperty("userEntryId");
    expect(out).not.toHaveProperty("assistantEntryId");
  });

  test("sessionUpdated -> sessionUpdated event with live status", () => {
    const running: MapCtx = { ...ctx, liveStatus: () => "running" };
    const out = buildPostFetchEvent("sessionUpdated", running);
    expect(out).toMatchObject({
      type: "sessionUpdated",
      snapshot: { status: "running" },
    });
  });
});

// ---------------------------------------------------------------------------
// resetAccumulator — clears stale stream state on reconnect/reseed.
// ---------------------------------------------------------------------------

describe("resetAccumulator", () => {
  test("clears blockKind, toolInputBuffer, toolUseBlock, and turnError", () => {
    const acc = createAccumulator();
    acc.blockKind = "tool_use";
    acc.toolInputBuffer = '{"partial":true}';
    acc.toolUseBlock = { id: "tu1", name: "bash" };
    acc.turnError = { message: "stale error" };
    resetAccumulator(acc);
    expect(acc.blockKind).toBeNull();
    expect(acc.toolInputBuffer).toBe("");
    expect(acc.toolUseBlock).toBeNull();
    expect(acc.turnError).toBeNull();
  });

  test("prevents stale turnError from failing the next message_complete", () => {
    // Simulate: model_error sets turnError, then the daemon crashes (no
    // message_complete). On reconnect, resetAccumulator clears the stale error
    // so the NEXT message_complete doesn't spuriously fail.
    const acc = createAccumulator();
    fold({ type: "message_start", prompt_id: "p1" }, acc);
    fold({ type: "model_error", error: { type: "auth_failed" }, prompt_id: "p1" }, acc);
    expect(acc.turnError).not.toBeNull();

    // Reconnect → reseed → reset
    resetAccumulator(acc);

    // New turn completes successfully
    fold({ type: "message_start", prompt_id: "p2" }, acc);
    const out = fold({ type: "message_complete", prompt_id: "p2" }, acc);
    expect(out.effects).toEqual([
      { type: "fetchState", emit: "runCompleted", promptId: "p2" },
    ]);
    expect(out.events).toEqual([]); // NOT a runFailed
  });
});

// ---------------------------------------------------------------------------
// Integration: full streaming pipeline (the spike §4 observed trace).
// ---------------------------------------------------------------------------

describe("streaming pipeline integration", () => {
  test("full turn: message_start → text delta → message_complete", () => {
    const acc = createAccumulator();
    // message_start
    let out = fold({ type: "message_start", prompt_id: "p1" }, acc);
    expect(out.events[0]).toMatchObject({ type: "sessionUpdated", snapshot: { status: "running" } });

    // content_block_start (text)
    out = fold(
      {
        type: "content_block_start",
        block_index: 0,
        block_type: { type: "text" },
        prompt_id: "p1",
      },
      acc,
    );
    expect(out.events).toEqual([]);

    // content_block_delta (text)
    out = fold(
      {
        type: "content_block_delta",
        block_index: 0,
        delta: { type: "text", text: "hello world" },
        prompt_id: "p1",
      },
      acc,
    );
    expect(out.events[0]).toMatchObject({
      type: "assistantDelta",
      text: "hello world",
      channel: "text",
    });

    // content_block_stop
    out = fold(
      { type: "content_block_stop", block_index: 0, prompt_id: "p1" },
      acc,
    );
    expect(out.events).toEqual([]);

    // message_complete
    out = fold({ type: "message_complete", prompt_id: "p1" }, acc);
    expect(out.events).toEqual([]);
    expect(out.effects).toEqual([
      { type: "fetchState", emit: "runCompleted", promptId: "p1" },
    ]);

    // Driver would then call buildPostFetchEvent("runCompleted", ctx, promptId)
    const finalEvent = buildPostFetchEvent("runCompleted", ctx, "p1");
    expect(finalEvent).toMatchObject({ type: "runCompleted", snapshot: { status: "idle" } });
    expect(finalEvent).toMatchObject({ userEntryId: "p1", assistantEntryId: "p1" });
  });

  test("tool turn: message_start → tool_use block → tool_call → tool_result → message_complete", () => {
    const acc = createAccumulator();

    fold({ type: "message_start", prompt_id: "p1" }, acc);

    // Tool use block streaming
    fold(
      {
        type: "content_block_start",
        block_index: 0,
        block_type: { type: "tool_use", id: "tu1", name: "bash" },
        prompt_id: "p1",
      },
      acc,
    );
    fold(
      {
        type: "content_block_delta",
        block_index: 0,
        delta: { type: "tool_use_input", partial_json: '{"command":"ls"' },
        prompt_id: "p1",
      },
      acc,
    );
    fold(
      {
        type: "content_block_delta",
        block_index: 0,
        delta: { type: "tool_use_input", partial_json: "}" },
        prompt_id: "p1",
      },
      acc,
    );

    // tool_call — authoritative tool start
    let out = fold(
      { type: "tool_call", call_id: "call1", name: "bash", prompt_id: "p1" },
      acc,
    );
    expect(out.events[0]).toMatchObject({
      type: "toolStarted",
      toolName: "bash",
      callId: "call1",
      input: { command: "ls" },
    });

    // tool_result
    out = fold({
      type: "tool_result",
      call_id: "call1",
      content: "file1\nfile2",
      is_error: false,
      prompt_id: "p1",
    });
    expect(out.events[0]).toMatchObject({
      type: "toolFinished",
      success: true,
      output: "file1\nfile2",
    });

    // message_complete
    out = fold({ type: "message_complete", prompt_id: "p1" }, acc);
    expect(out.effects).toEqual([
      { type: "fetchState", emit: "runCompleted", promptId: "p1" },
    ]);
  });

  test("error then retry: model_error → message_start (clears) → message_complete", () => {
    const acc = createAccumulator();
    fold({ type: "message_start", prompt_id: "p1" }, acc);

    // Error during turn
    fold(
      {
        type: "model_error",
        error: { type: "rate_limited", retry_after_seconds: 10 },
        prompt_id: "p1",
      },
      acc,
    );
    expect(acc.turnError).not.toBeNull();

    // Retry starts — message_start clears the error
    fold({ type: "message_start", prompt_id: "p1" }, acc);
    expect(acc.turnError).toBeNull();

    // Turn completes successfully
    const out = fold({ type: "message_complete", prompt_id: "p1" }, acc);
    expect(out.effects).toEqual([
      { type: "fetchState", emit: "runCompleted", promptId: "p1" },
    ]);
  });

  test("unretried error: model_error → message_complete -> runFailed", () => {
    const acc = createAccumulator();
    fold({ type: "message_start", prompt_id: "p1" }, acc);
    fold(
      {
        type: "model_error",
        error: { type: "auth_failed" },
        prompt_id: "p1",
      },
      acc,
    );
    const out = fold({ type: "message_complete", prompt_id: "p1" }, acc);
    expect(out.events).toEqual([
      { sessionRef: ref, timestamp: "t", type: "runFailed", error: { message: "Authentication failed" } },
    ]);
  });
});

describe("snapshotFromState config", () => {
  // Site A direct coverage: active_model is the FULL `provider/id` registry name, so
  // modelId must stay the full form (matching ModelOption.modelId) for the picker's
  // find() to resolve the friendly label — not the bare split-on-`/` id.
  test("slash-bearing active_model -> full-form modelId + bare provider prefix", () => {
    const snap = snapshotFromState(baseState, ref, workspace, "idle", "t");
    expect(snap.config).toEqual({
      provider: "anthropic",
      modelId: "anthropic/claude-sonnet-4",
      thinkingLevel: "medium",
    });
  });

  // No-slash fallback: defaultModelRef returns the whole string as both provider and
  // modelId (mirrors parseModels' provider fallback). Pins the behavior delta — today
  // a slash-less active_model yields modelId: undefined; after the fix it yields the
  // whole string, so the badge shows the local name instead of falling back to "model".
  test("slash-less active_model -> whole string as both provider and modelId", () => {
    const state = { ...baseState, active_model: "local-model" };
    const snap = snapshotFromState(state, ref, workspace, "idle", "t");
    expect(snap.config).toEqual({
      provider: "local-model",
      modelId: "local-model",
      thinkingLevel: "medium",
    });
  });

  test("null state -> undefined config", () => {
    const snap = snapshotFromState(null, ref, workspace, "idle", "t");
    expect(snap.config).toBeUndefined();
  });
});

describe("snapshotFromState", () => {
  test("threads active_facet onto the snapshot", () => {
    // The event-map step of the facet data path: a daemon state carrying
    // active_facet produces a SessionSnapshot whose facet field is set, which
    // foldEvent then propagates to state.facet (covered in protocol/state.test.ts).
    const snap = snapshotFromState(
      { ...baseState, active_facet: "plan" },
      ref,
      workspace,
      "idle",
      "t",
    );
    expect(snap.facet).toBe("plan");
  });

  test("defaults facet to undefined when active_facet is absent", () => {
    // An older/partial daemon state (or a null state) must not synthesize a facet —
    // the badge hides when facet is undefined / "execute".
    const snap = snapshotFromState(null, ref, workspace, "idle", "t");
    expect(snap.facet).toBeUndefined();
  });

  test("threads active_plan onto the snapshot as activePlan", () => {
    // The event-map step of the plan-overlay data path: a daemon state carrying
    // active_plan produces a SessionSnapshot whose activePlan field is set.
    const snap = snapshotFromState(
      { ...baseState, active_plan: "# My Plan\n- Step 1" },
      ref,
      workspace,
      "idle",
      "t",
    );
    expect(snap.activePlan).toBe("# My Plan\n- Step 1");
  });

  test("defaults activePlan to undefined when active_plan is absent", () => {
    // An older/partial daemon state (or a null state) must not synthesize a plan.
    const snap = snapshotFromState(null, ref, workspace, "idle", "t");
    expect(snap.activePlan).toBeUndefined();
  });
});
