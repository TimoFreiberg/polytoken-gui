// Round-trip tests for the host-UI bridge: the forward mapping (event-map.ts)
// captures PendingInterrogative metadata + emits a hostUiRequest card; the
// reverse mapping (ui-bridge.ts) consumes that metadata + a pilot HostUiResponse
// to build the daemon's InterrogativeResponse. These tests assert the index↔key
// mappings line up across the round trip — the single most error-prone part.
//
// The forward-mapping assertions live in event-map.test.ts; this file owns the
// REVERSE side (buildInterrogativeResponse), exercising every interrogative type
// + the cancel short-circuit + misroute defense.

import { describe, expect, test } from "bun:test";
import type { HostUiResponse } from "@pilot/protocol";
import {
  PERMISSION_APPROVAL_CHOICES,
  PERMISSION_APPROVAL_LABELS,
  buildInterrogativeResponse,
  pruneApprovalOptions,
  type PendingInterrogative,
} from "./ui-bridge.js";

const cancel: HostUiResponse = { requestId: "i1", cancelled: true };

function pending(
  type: PendingInterrogative["interrogativeType"],
  extra: Partial<PendingInterrogative> = {},
): PendingInterrogative {
  return { interrogativeId: "i1", interrogativeType: type, ...extra };
}

describe("buildInterrogativeResponse", () => {
  // ===== Cancel short-circuits every type =====

  test("cancel -> kind:cancel regardless of type", () => {
    for (const type of [
      "confirmation",
      "clarification",
      "capability",
      "plan_handoff",
      "permission",
      "ask_user_question",
    ] as const) {
      const out = buildInterrogativeResponse(pending(type), cancel);
      expect(out).toEqual({ kind: "cancel" });
    }
  });

  // ===== confirmation =====

  test("confirmation + confirmed:true -> confirmation_answer{confirmed:true}", () => {
    const out = buildInterrogativeResponse(pending("confirmation"), {
      requestId: "i1",
      confirmed: true,
    });
    expect(out).toEqual({ kind: "confirmation_answer", confirmed: true });
  });

  test("confirmation + confirmed:false -> confirmation_answer{confirmed:false}", () => {
    const out = buildInterrogativeResponse(pending("confirmation"), {
      requestId: "i1",
      confirmed: false,
    });
    expect(out).toEqual({ kind: "confirmation_answer", confirmed: false });
  });

  test("confirmation + wrong shape (value) -> null (misroute defense)", () => {
    const out = buildInterrogativeResponse(pending("confirmation"), {
      requestId: "i1",
      value: "yes",
    });
    expect(out).toBeNull();
  });

  // ===== clarification (select path) =====

  test("clarification + select label 'Yes' -> clarification_choice with keys[0]", () => {
    const out = buildInterrogativeResponse(
      pending("clarification", {
        clarificationLabels: ["Yes", "No"],
        clarificationOptionKeys: ["yes", "no"],
      }),
      { requestId: "i1", value: "Yes" },
    );
    expect(out).toEqual({ kind: "clarification_choice", choice: "yes" });
  });

  test("clarification + select label 'No' -> clarification_choice with keys[1]", () => {
    const out = buildInterrogativeResponse(
      pending("clarification", {
        clarificationLabels: ["Yes", "No"],
        clarificationOptionKeys: ["yes", "no"],
      }),
      { requestId: "i1", value: "No" },
    );
    expect(out).toEqual({ kind: "clarification_choice", choice: "no" });
  });

  test("clarification + unknown label -> null", () => {
    const out = buildInterrogativeResponse(
      pending("clarification", {
        clarificationLabels: ["Yes"],
        clarificationOptionKeys: ["yes"],
      }),
      { requestId: "i1", value: "Maybe" },
    );
    expect(out).toBeNull();
  });

  // ===== clarification (free-text path) =====

  test("clarification + value with no labels -> clarification_text", () => {
    const out = buildInterrogativeResponse(pending("clarification"), {
      requestId: "i1",
      value: "my custom answer",
    });
    expect(out).toEqual({ kind: "clarification_text", text: "my custom answer" });
  });

  test("clarification + empty labels -> clarification_text", () => {
    const out = buildInterrogativeResponse(
      pending("clarification", { clarificationLabels: [], clarificationOptionKeys: [] }),
      { requestId: "i1", value: "typed" },
    );
    expect(out).toEqual({ kind: "clarification_text", text: "typed" });
  });

  // ===== capability =====

  test("capability + confirmed:true -> capability_answer{granted:true}", () => {
    const out = buildInterrogativeResponse(pending("capability"), {
      requestId: "i1",
      confirmed: true,
    });
    expect(out).toEqual({ kind: "capability_answer", granted: true });
  });

  test("capability + confirmed:false -> capability_answer{granted:false}", () => {
    const out = buildInterrogativeResponse(pending("capability"), {
      requestId: "i1",
      confirmed: false,
    });
    expect(out).toEqual({ kind: "capability_answer", granted: false });
  });

  // ===== plan_handoff =====

  test("plan_handoff + label 'Implement fresh' -> implement_new_context", () => {
    const out = buildInterrogativeResponse(
      pending("plan_handoff", { planHandoffLabels: ["Implement fresh", "Implement here", "Cancel"] }),
      { requestId: "i1", value: "Implement fresh" },
    );
    expect(out).toEqual({ kind: "plan_handoff_answer", decision: "implement_new_context" });
  });

  test("plan_handoff + label 'Implement here' -> implement_current_context", () => {
    const out = buildInterrogativeResponse(
      pending("plan_handoff", { planHandoffLabels: ["Implement fresh", "Implement here", "Cancel"] }),
      { requestId: "i1", value: "Implement here" },
    );
    expect(out).toEqual({ kind: "plan_handoff_answer", decision: "implement_current_context" });
  });

  test("plan_handoff + label 'Cancel' -> cancel", () => {
    const out = buildInterrogativeResponse(
      pending("plan_handoff", { planHandoffLabels: ["Implement fresh", "Implement here", "Cancel"] }),
      { requestId: "i1", value: "Cancel" },
    );
    expect(out).toEqual({ kind: "plan_handoff_answer", decision: "cancel" });
  });

  test("plan_handoff + unknown label -> null", () => {
    const out = buildInterrogativeResponse(
      pending("plan_handoff", { planHandoffLabels: ["Implement fresh", "Implement here", "Cancel"] }),
      { requestId: "i1", value: "Something else" },
    );
    expect(out).toBeNull();
  });

  // ===== permission (the 7-choice approval) =====

  test("permission + label 'Deny' -> permission_answer{granted:false, target:null}", () => {
    const out = buildInterrogativeResponse(pending("permission"), {
      requestId: "i1",
      value: "Deny",
    });
    expect(out).toEqual({
      kind: "permission_answer",
      granted: false,
      persistence_target: null,
    });
  });

  test("permission + label 'Allow once' -> granted:true, target:null", () => {
    const out = buildInterrogativeResponse(pending("permission"), {
      requestId: "i1",
      value: "Allow once",
    });
    expect(out).toEqual({
      kind: "permission_answer",
      granted: true,
      persistence_target: null,
    });
  });

  test("permission + label 'Allow for session' -> granted:true, target:session", () => {
    const out = buildInterrogativeResponse(pending("permission"), {
      requestId: "i1",
      value: "Allow for session",
    });
    expect(out).toEqual({
      kind: "permission_answer",
      granted: true,
      persistence_target: "session",
    });
  });

  test("permission + label 'Allow for user' -> granted:true, target:user", () => {
    const out = buildInterrogativeResponse(pending("permission"), {
      requestId: "i1",
      value: "Allow for user",
    });
    expect(out).toEqual({
      kind: "permission_answer",
      granted: true,
      persistence_target: "user",
    });
  });

  test("permission + unknown label -> null", () => {
    const out = buildInterrogativeResponse(pending("permission"), {
      requestId: "i1",
      value: "Maybe",
    });
    expect(out).toBeNull();
  });

  // ===== permission (pruned subset — the new permissionChoices path) =====

  test("permission + pruned subset + 'Allow for session' -> correct grant/target", () => {
    // keep_targets=[session] prunes to Deny, Allow once, Allow for session.
    // The chosen label must still map to {granted:true, target:session}.
    const choices = pruneApprovalOptions(["session"]);
    const out = buildInterrogativeResponse(
      pending("permission", { permissionChoices: choices }),
      { requestId: "i1", value: "Allow for session" },
    );
    expect(out).toEqual({
      kind: "permission_answer",
      granted: true,
      persistence_target: "session",
    });
  });

  test("permission + pruned subset + 'Deny' -> granted:false", () => {
    const choices = pruneApprovalOptions(["user"]);
    const out = buildInterrogativeResponse(
      pending("permission", { permissionChoices: choices }),
      { requestId: "i1", value: "Deny" },
    );
    expect(out).toEqual({
      kind: "permission_answer",
      granted: false,
      persistence_target: null,
    });
  });

  test("permission + pruned subset + 'Allow for user' (pruned out) -> null", () => {
    // keep_targets=[session] prunes out user grants. A response carrying a
    // pruned-out label (stale/raced card) must NOT reach the daemon.
    const choices = pruneApprovalOptions(["session"]);
    const out = buildInterrogativeResponse(
      pending("permission", { permissionChoices: choices }),
      { requestId: "i1", value: "Allow for user" },
    );
    expect(out).toBeNull();
  });

  test("permission + no permissionChoices (fallback) -> fixed-array lookup still works", () => {
    // Backward compat: an in-flight card from before this change has no
    // permissionChoices. The reverse builder must fall back to the full array
    // and resolve any known label. This pins the fallback as intentional, not
    // incidental (AC.3 test strategy).
    const out = buildInterrogativeResponse(pending("permission"), {
      requestId: "i1",
      value: "Allow for project",
    });
    expect(out).toEqual({
      kind: "permission_answer",
      granted: true,
      persistence_target: "project",
    });
  });

  // ===== ask_user_question (the qna round trip) =====

  test("ask_user_question + answers -> ask_user_question_answers with option ids mapped", () => {
    const out = buildInterrogativeResponse(
      pending("ask_user_question", {
        questions: [
          { questionId: "q-a", optionIds: ["o1", "o2"] },
          { questionId: "q-b", optionIds: [] },
        ],
      }),
      {
        requestId: "i1",
        answers: [
          { selectedOptionIndices: [0], customText: "" },
          { selectedOptionIndices: [], customText: "free text answer" },
        ],
      },
    );
    expect(out).toEqual({
      kind: "ask_user_question_answers",
      answers: [
        { question_id: "q-a", selected_option_ids: ["o1"], free_text: null },
        { question_id: "q-b", selected_option_ids: [], free_text: "free text answer" },
      ],
    });
  });

  test("ask_user_question + multi-select -> all selected option ids mapped", () => {
    const out = buildInterrogativeResponse(
      pending("ask_user_question", {
        questions: [{ questionId: "q-a", optionIds: ["o1", "o2", "o3"] }],
      }),
      {
        requestId: "i1",
        answers: [{ selectedOptionIndices: [0, 2], customText: "" }],
      },
    );
    expect(out).toMatchObject({
      answers: [{ question_id: "q-a", selected_option_ids: ["o1", "o3"] }],
    });
  });

  test("ask_user_question + out-of-range index -> filtered out (not crashed)", () => {
    const out = buildInterrogativeResponse(
      pending("ask_user_question", {
        questions: [{ questionId: "q-a", optionIds: ["o1"] }],
      }),
      {
        requestId: "i1",
        answers: [{ selectedOptionIndices: [0, 5], customText: "" }],
      },
    );
    expect(out).toMatchObject({
      answers: [{ selected_option_ids: ["o1"] }],
    });
  });

  test("ask_user_question + wrong shape (confirmed) -> null", () => {
    const out = buildInterrogativeResponse(
      pending("ask_user_question"),
      { requestId: "i1", confirmed: true },
    );
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Consistency: the permission approval choices + labels line up.
// ---------------------------------------------------------------------------

describe("permission approval constants", () => {
  test("PERMISSION_APPROVAL_LABELS has 7 entries matching the choices", () => {
    expect(PERMISSION_APPROVAL_LABELS).toHaveLength(7);
    expect(PERMISSION_APPROVAL_CHOICES).toHaveLength(7);
  });

  test("index 0 is Deny (granted:false)", () => {
    expect(PERMISSION_APPROVAL_CHOICES[0]).toEqual({
      granted: false,
      persistenceTarget: null,
    });
  });

  test("index 1 is Allow once (granted:true, null target)", () => {
    expect(PERMISSION_APPROVAL_CHOICES[1]).toEqual({
      granted: true,
      persistenceTarget: null,
    });
  });

  test("indices 2-6 grant with escalating persistence targets", () => {
    const targets = PERMISSION_APPROVAL_CHOICES.slice(2).map((c) => c.persistenceTarget);
    expect(targets).toEqual(["session", "project_local", "project", "user_local", "user"]);
  });

  test("every grant choice has granted:true", () => {
    for (const choice of PERMISSION_APPROVAL_CHOICES.slice(1)) {
      expect(choice.granted).toBe(true);
    }
  });
});
