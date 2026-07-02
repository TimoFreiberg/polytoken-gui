// The reverse half of the host-UI bridge: translate pilot's HostUiResponse back
// into polytoken's InterrogativeResponse, so the daemon can resume the turn the
// interrogative paused.
//
// The forward half (DaemonEvent → hostUiRequest) lives in event-map.ts; this
// module owns the response side because it needs the same per-interrogative
// metadata (its type + the clarification options / question ids) that the
// forward mapping captured. Like event-map.ts, this is a PURE function — the
// driver does the POST, this builds the body.
//
// Shapes grounded in the binary's own self-describing schemas (`polytoken openapi` /
// `polytoken event-schema`). The permission model has 3 modes (not 4) and 7 approval
// choices (not 5).

import type { components } from "./wire-types.js";
import type { HostUiResponse, QnaAnswer } from "@pilot/protocol";

type InterrogativeResponse = components["schemas"]["InterrogativeResponse"];
type InterrogativeType = components["schemas"]["InterrogativeType"];

/** pilot-side discriminator that extends the daemon's InterrogativeType with
 *  `ask_user_question`, which is a SEPARATE DaemonEvent variant (not an
 *  interrogative_type) but responds via the same /interrogative/{id}/respond
 *  endpoint with kind:"ask_user_question_answers". Unifying it here lets the
 *  driver store one pending map keyed by interrogative id. */
export type PendingInterrogativeType = InterrogativeType | "ask_user_question" | "unknown";

/** One question's id + its option ids + rendered labels, in pilot's render order.
 *  The qna card returns selectedOptionIndices (into optionLabels); this maps them
 *  to the daemon's option ids for the reply. */
export interface PendingQuestion {
  questionId: string;
  optionIds: readonly string[];
  /** The rendered labels, parallel to optionIds. Not currently used by the
   *  reverse builder (qna returns INDICES, not labels — unlike select), but
   *  kept for symmetry + future-proofing if the qna contract changes. */
  optionLabels?: readonly string[];
}

/** Metadata the forward mapping captured for a pending interrogative — enough to
 *  build the correct response shape from any pilot HostUiResponse variant.
 *
 *  The reverse builder needs more than just the interrogative id: a select
 *  response carries the chosen option's LABEL STRING (the client sends
 *  `value: <label>`, NOT a numeric index — see client/src/components/
 *  ApprovalLayer.svelte:268 `submitValue(opt)` where opt is the label). So the
 *  forward mapping captures the rendered labels here, and the pure builder maps
 *  the label back to the daemon's key/id/decision via `indexOf`. */
export interface PendingInterrogative {
  /** The daemon's interrogative id — the path param for POST /interrogative/{id}/respond. */
  interrogativeId: string;
  /** Which interrogative kind this is — routes the response builder. Includes
   *  the pilot-side "ask_user_question" for the separate DaemonEvent variant. */
  interrogativeType: PendingInterrogativeType;
  /** For clarification interrogatives: the rendered labels IN ORDER, parallel to
   *  the daemon's clarification_options. The reverse builder maps a response
   *  label → its index → the daemon's key. (We store labels, not keys, because
   *  the response carries a label; the keys are recoverable by parallel index
   *  only if we also kept them, so we keep BOTH.) */
  clarificationLabels?: readonly string[];
  /** For clarification interrogatives: the daemon's option keys, parallel to
   *  clarificationLabels. label index → key. */
  clarificationOptionKeys?: readonly string[];
  /** For plan_handoff interrogatives: the rendered labels IN ORDER, parallel to
   *  the daemon's PlanHandoffDecision order. The reverse builder maps a response
   *  label → its index → the decision. */
  planHandoffLabels?: readonly string[];
  /** For ask_user_question interrogatives: the per-question id + option ids +
   *  rendered labels, in pilot's qna render order. A QnaAnswer's
   *  selectedOptionIndices index into optionLabels; the builder maps them to the
   *  daemon's option ids. Also determines question count + ordering for the reply. */
  questions?: readonly PendingQuestion[];
  /** For permission interrogatives: the rendered approval choices (the pruned
   *  subset from pruneApprovalOptions), in order. The reverse builder maps the
   *  chosen label → its index here → the grant/target pair. Absent = fall back
   *  to the full fixed PERMISSION_APPROVAL_CHOICES array (backward compat for
   *  in-flight cards from before this change — the ui-bridge tests rely on it). */
  permissionChoices?: readonly ApprovalChoice[];
}

// ---------------------------------------------------------------------------
// Permission approval — the most non-trivial translation.
//
// pilot's approval card surfaces the daemon's 7 choices as a select list whose
// first option (index 0) is "Deny" and indices 1-6 are the grant+target pairs.
// A select response carries the chosen index in `value` (a string). This maps
// that index back to the granted/persistence_target pair the daemon expects.
//
// The ordering MUST match buildPermissionRequest() in event-map.ts — the index
// is the only link between the card pilot rendered and the response it parses.
// ---------------------------------------------------------------------------

/** The grant + persistence pair for one approval choice. Index 0 is the deny. */
export interface ApprovalChoice {
  granted: boolean;
  persistenceTarget: components["schemas"]["PersistenceTarget"] | null;
}

/** Re-export the daemon's persistence-target union so the pruning helper's
 *  signature is self-documenting without callers importing wire-types. */
export type PersistenceTarget = components["schemas"]["PersistenceTarget"];

/** pilot's approval card order: Deny (0), then grants by escalating scope.
 *  This is the SINGLE source of truth for the index↔target mapping —
 *  buildPermissionRequest() in event-map.ts renders options in this order, and
 *  this array maps a response index back. Keep them in sync. */
export const PERMISSION_APPROVAL_CHOICES: readonly ApprovalChoice[] = [
  { granted: false, persistenceTarget: null }, // "Deny"
  { granted: true, persistenceTarget: null }, // "Allow once" (null = this occurrence only)
  { granted: true, persistenceTarget: "session" },
  { granted: true, persistenceTarget: "project_local" },
  { granted: true, persistenceTarget: "project" },
  { granted: true, persistenceTarget: "user_local" },
  { granted: true, persistenceTarget: "user" },
];

/** Human labels for the approval choices, in card order. Used by the forward
 *  mapping (event-map.ts) to render the select options, and surfaced here so a
 *  reviewer can read the intent without cross-referencing the schema. */
export const PERMISSION_APPROVAL_LABELS: readonly string[] = [
  "Deny",
  "Allow once",
  "Allow for session",
  "Allow for project (local)",
  "Allow for project",
  "Allow for user (local)",
  "Allow for user",
];

/** The plan-handoff decision order pilot's select card renders. Index 0,1,2.
 *  Must match buildPlanHandoffRequest() in event-map.ts. */
const PLAN_HANDOFF_DECISIONS = [
  "implement_new_context",
  "implement_current_context",
  "cancel",
] as const;

/** Map an approval choice index (from a label lookup) to the grant + persistence
 *  pair, or null if out of range. */
function approvalFromIndex(idx: number): ApprovalChoice | null {
  if (idx < 0 || idx >= PERMISSION_APPROVAL_CHOICES.length) {
    return null;
  }
  return PERMISSION_APPROVAL_CHOICES[idx] ?? null;
}

/** Prune the 7 approval choices down to those valid for the current request.
 *
 *  The daemon's `permission_candidate_rule.keep_targets` lists the persistence
 *  targets a grant may use for THIS request. When present, grant choices whose
 *  `persistenceTarget` is NOT in `keepTargets` are invalid (the daemon would
 *  reject them) so we don't offer them. Always kept:
 *  - Deny (index 0, null target — a refusal is always valid)
 *  - Allow once (index 1, null target — this occurrence only, no persistence)
 *
 *  When `keepTargets` is null/absent (no candidate rule, or a degraded daemon
 *  that didn't send one), return all 7 — backward compat with the pre-pruning
 *  behavior, so an operator still sees every option.
 *
 *  This is the SINGLE source of truth for pruning — used by the forward mapping
 *  (event-map.ts) AND the mock fixture (fixtures.ts) so both paths agree. */
export function pruneApprovalOptions(
  keepTargets?: readonly PersistenceTarget[] | null,
): readonly ApprovalChoice[] {
  if (!keepTargets || keepTargets.length === 0) {
    return PERMISSION_APPROVAL_CHOICES;
  }
  return PERMISSION_APPROVAL_CHOICES.filter((choice) => {
    // Deny (index 0) + Allow once (index 1) have null targets — always valid.
    if (choice.persistenceTarget === null) return true;
    return keepTargets.includes(choice.persistenceTarget);
  });
}

// ---------------------------------------------------------------------------
// The pure response builder. Returns the InterrogativeResponse to POST, or null
// when the response doesn't match the pending interrogative's type (a bug —
// the hub should never route a confirm reply to a permission card).
// ---------------------------------------------------------------------------

/** Build the polytoken InterrogativeResponse for a pilot HostUiResponse, given
 *  the pending interrogative's captured metadata. Pure — the driver POSTs.
 *
 *  Returns null if the response shape doesn't match the interrogative type
 *  (a defensively-typed no-op rather than a throw, so a misrouted response
 *  surfaces as a stuck card the operator can dismiss, not a crashed driver).
 *
 *  `cancelled` is special-cased: pilot sends it for any dialog the operator
 *  dismissed, and the daemon accepts `kind:"cancel"` for every interrogative
 *  type — so cancel short-circuits before the type switch. */
export function buildInterrogativeResponse(
  pending: PendingInterrogative,
  response: HostUiResponse,
): InterrogativeResponse | null {
  // Cancel dismisses any interrogative — the daemon accepts kind:"cancel"
  // universally, regardless of interrogative_type.
  if ("cancelled" in response) {
    return { kind: "cancel" };
  }

  switch (pending.interrogativeType) {
    case "confirmation": {
      // pilot confirm card → {requestId, confirmed}. Maps directly.
      if (!("confirmed" in response)) return null;
      return { kind: "confirmation_answer", confirmed: response.confirmed };
    }

    case "clarification": {
      // A clarification offers options (select) OR free text (input). pilot
      // renders both as needed; the response shape tells us which path fired.
      if ("value" in response) {
        const labels = pending.clarificationLabels;
        const keys = pending.clarificationOptionKeys;
        if (labels && keys && labels.length > 0) {
          // Select path: the client sends the chosen LABEL string (not an
          // index). Map label → index → the daemon's key.
          const idx = labels.indexOf(response.value);
          if (idx < 0 || idx >= keys.length) return null;
          return { kind: "clarification_choice", choice: keys[idx] ?? "" };
        }
        // Free-text path: value is the typed answer.
        return { kind: "clarification_text", text: response.value };
      }
      // A qna-style answer to a clarification is unexpected; treat as text.
      if ("answers" in response) {
        return { kind: "clarification_text", text: response.answers[0]?.customText ?? "" };
      }
      return null;
    }

    case "capability": {
      // pilot capability card → a confirm-like {requestId, confirmed}.
      if ("confirmed" in response) {
        return { kind: "capability_answer", granted: response.confirmed };
      }
      return null;
    }

    case "plan_handoff": {
      // pilot plan-handoff card → a select whose value is the chosen LABEL
      // string. Map label → index → the decision (the labels are parallel to
      // PLAN_HANDOFF_DECISIONS, captured by the forward mapping).
      if ("value" in response) {
        const labels = pending.planHandoffLabels;
        if (!labels) return null;
        const idx = labels.indexOf(response.value);
        if (idx < 0 || idx >= PLAN_HANDOFF_DECISIONS.length) return null;
        const decision = PLAN_HANDOFF_DECISIONS[idx];
        if (!decision) return null;
        return { kind: "plan_handoff_answer", decision };
      }
      return null;
    }

    case "permission": {
      // pilot permission card → a select whose value is the chosen LABEL string.
      // The label↔choice mapping is ALWAYS via the full PERMISSION_APPROVAL_LABELS
      // index (a label always maps to the same grant/target, pruning or not).
      // When the forward mapping pruned options (permissionChoices captured),
      // reject labels whose choice didn't survive pruning — a stale/raced
      // response to a pruned-out option shouldn't reach the daemon. The fallback
      // (no permissionChoices) accepts any known label (backward compat — the
      // existing ui-bridge tests call pending("permission") with no choices).
      if ("value" in response) {
        const idx = PERMISSION_APPROVAL_LABELS.indexOf(response.value);
        const choice = approvalFromIndex(idx);
        if (!choice) return null;
        const choices = pending.permissionChoices;
        if (choices && !choices.includes(choice)) return null;
        return {
          kind: "permission_answer",
          granted: choice.granted,
          persistence_target: choice.persistenceTarget,
        };
      }
      return null;
    }

    case "ask_user_question": {
      // Separate DaemonEvent variant, but same respond endpoint. pilot's qna
      // card returns one QnaAnswer per question; map each to an
      // AskUserQuestionReply with the question id + selected option ids.
      if (!("answers" in response)) return null;
      const questions = pending.questions ?? [];
      const replies = response.answers.map((ans: QnaAnswer, i: number) => {
        const q = questions[i];
        const optionIds = q?.optionIds ?? [];
        const selectedOptionIds = ans.selectedOptionIndices
          .map((idx) => optionIds[idx])
          .filter((id): id is string => typeof id === "string");
        return {
          question_id: q?.questionId ?? "",
          selected_option_ids: selectedOptionIds,
          free_text: ans.customText || null,
        };
      });
      return { kind: "ask_user_question_answers", answers: replies };
    }

    case "goal_proposal": {
      // pilot confirm card → {requestId, confirmed}. Maps directly to
      // goal_proposal_answer{accepted: boolean}.
      if (!("confirmed" in response)) return null;
      return { kind: "goal_proposal_answer", accepted: response.confirmed };
    }

    case "unknown": {
      // Unknown interrogative type (from the deny-safe default arm in
      // buildInterrogativeMapping). Cancel is the only valid action — both
      // the confirm(true) and confirm(false) button paths produce
      // {kind:"cancel"} so the daemon's turn is always unblocked.
      return { kind: "cancel" };
    }

    default: {
      // Exhaustiveness: if a new interrogative_type appears, return null so the
      // card stays dismissable rather than crashing the driver.
      const _exhaustive: never = pending.interrogativeType;
      void _exhaustive;
      return null;
    }
  }
}
