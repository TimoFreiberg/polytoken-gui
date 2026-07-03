//! The reverse half of the host-UI bridge: translate pilot's `HostUiResponse`
//! back into polytoken's `InterrogativeResponse`, so the daemon can resume the
//! turn the interrogative paused.
//!
//! Port of `server/src/polytoken/ui-bridge.ts`.
//!
//! The forward half (DaemonEvent → hostUiRequest) lives in `event-map.ts`; this
//! module owns the response side because it needs the same per-interrogative
//! metadata (its type + the clarification options / question ids) that the
//! forward mapping captured. Like event-map.ts, this is a PURE function — the
//! driver does the POST, this builds the body.
//!
//! Shapes grounded in the binary's own self-describing schemas (`polytoken
//! openapi` / `polytoken event-schema`). The permission model has 3 modes (not
//! 4) and 7 approval choices (not 5).

use pilot_daemon_types::{
    AskUserQuestionReply, InterrogativeResponse, InterrogativeType, PersistenceTarget,
    PlanHandoffDecision,
};
use pilot_protocol::session_driver::{HostUiResponse, QnaAnswer};

/// pilot-side discriminator that extends the daemon's `InterrogativeType` with
/// `AskUserQuestion`, which is a SEPARATE `DaemonEvent` variant (not an
/// `interrogative_type`) but responds via the same
/// `/interrogative/{id}/respond` endpoint with `kind:"ask_user_question_answers"`.
/// Unifying it here lets the driver store one pending map keyed by interrogative
/// id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingInterrogativeType {
    Permission,
    Confirmation,
    Clarification,
    Capability,
    PlanHandoff,
    GoalProposal,
    AskUserQuestion,
    Unknown,
}

impl From<InterrogativeType> for PendingInterrogativeType {
    fn from(t: InterrogativeType) -> Self {
        match t {
            InterrogativeType::Permission => Self::Permission,
            InterrogativeType::Confirmation => Self::Confirmation,
            InterrogativeType::Clarification => Self::Clarification,
            InterrogativeType::Capability => Self::Capability,
            InterrogativeType::PlanHandoff => Self::PlanHandoff,
            InterrogativeType::GoalProposal => Self::GoalProposal,
        }
    }
}

/// One question's id + its option ids + rendered labels, in pilot's render
/// order. The qna card returns `selectedOptionIndices` (into `optionLabels`);
/// this maps them to the daemon's option ids for the reply.
#[derive(Debug, Clone)]
pub struct PendingQuestion {
    pub question_id: String,
    pub option_ids: Vec<String>,
    /// The rendered labels, parallel to `option_ids`. Not currently used by the
    /// reverse builder (qna returns INDICES, not labels — unlike select), but
    /// kept for symmetry + future-proofing if the qna contract changes.
    pub option_labels: Option<Vec<String>>,
}

/// Metadata the forward mapping captured for a pending interrogative — enough
/// to build the correct response shape from any pilot `HostUiResponse` variant.
///
/// The reverse builder needs more than just the interrogative id: a select
/// response carries the chosen option's LABEL STRING (the client sends
/// `value: <label>`, NOT a numeric index). So the forward mapping captures the
/// rendered labels here, and the pure builder maps the label back to the
/// daemon's key/id/decision via `indexOf`.
#[derive(Debug, Clone)]
pub struct PendingInterrogative {
    /// The daemon's interrogative id — the path param for
    /// `POST /interrogative/{id}/respond`.
    pub interrogative_id: String,
    /// Which interrogative kind this is — routes the response builder. Includes
    /// the pilot-side `AskUserQuestion` for the separate `DaemonEvent` variant.
    pub interrogative_type: PendingInterrogativeType,
    /// For clarification interrogatives: the rendered labels IN ORDER, parallel
    /// to the daemon's `clarification_options`. The reverse builder maps a
    /// response label → its index → the daemon's key.
    pub clarification_labels: Option<Vec<String>>,
    /// For clarification interrogatives: the daemon's option keys, parallel to
    /// `clarification_labels`. label index → key.
    pub clarification_option_keys: Option<Vec<String>>,
    /// For `plan_handoff` interrogatives: the rendered labels IN ORDER, parallel
    /// to the daemon's `PlanHandoffDecision` order. The reverse builder maps a
    /// response label → its index → the decision.
    pub plan_handoff_labels: Option<Vec<String>>,
    /// For `ask_user_question` interrogatives: the per-question id + option ids
    /// + rendered labels, in pilot's qna render order. A `QnaAnswer`'s
    /// `selectedOptionIndices` index into `optionLabels`; the builder maps them
    /// to the daemon's option ids. Also determines question count + ordering
    /// for the reply.
    pub questions: Option<Vec<PendingQuestion>>,
    /// For permission interrogatives: the rendered approval choices (the pruned
    /// subset from `prune_approval_options`), in order. The reverse builder maps
    /// the chosen label → its index here → the grant/target pair. Absent = fall
    /// back to the full `PERMISSION_APPROVAL_CHOICES` array (backward compat for
    /// in-flight cards from before this change — the ui-bridge tests rely on it).
    pub permission_choices: Option<Vec<ApprovalChoice>>,
}

// ---------------------------------------------------------------------------
// Permission approval — the most non-trivial translation.
//
// pilot's approval card surfaces the daemon's 7 choices as a select list whose
// first option (index 0) is "Deny" and indices 1-6 are the grant+target pairs.
// A select response carries the chosen index in `value` (a string). This maps
// that index back to the granted/persistence_target pair the daemon expects.
//
// The ordering MUST match `buildPermissionRequest()` in `event-map.ts` — the
// index is the only link between the card pilot rendered and the response it
// parses.
// ---------------------------------------------------------------------------

/// The grant + persistence pair for one approval choice. Index 0 is the deny.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalChoice {
    pub granted: bool,
    pub persistence_target: Option<PersistenceTarget>,
}

/// Re-export the daemon's persistence-target union so the pruning helper's
/// signature is self-documenting without callers importing wire-types.
pub type PersistenceTargetAlias = PersistenceTarget;

/// pilot's approval card order: Deny (0), then grants by escalating scope.
/// This is the SINGLE source of truth for the index↔target mapping —
/// `buildPermissionRequest()` in `event-map.ts` renders options in this order,
/// and this array maps a response index back. Keep them in sync.
pub const PERMISSION_APPROVAL_CHOICES: [ApprovalChoice; 7] = [
    ApprovalChoice { granted: false, persistence_target: None }, // "Deny"
    ApprovalChoice { granted: true, persistence_target: None }, // "Allow once" (null = this occurrence only)
    ApprovalChoice { granted: true, persistence_target: Some(PersistenceTarget::Session) },
    ApprovalChoice { granted: true, persistence_target: Some(PersistenceTarget::ProjectLocal) },
    ApprovalChoice { granted: true, persistence_target: Some(PersistenceTarget::Project) },
    ApprovalChoice { granted: true, persistence_target: Some(PersistenceTarget::UserLocal) },
    ApprovalChoice { granted: true, persistence_target: Some(PersistenceTarget::User) },
];

/// Human labels for the approval choices, in card order. Used by the forward
/// mapping (`event-map.ts`) to render the select options, and surfaced here so
/// a reviewer can read the intent without cross-referencing the schema.
pub const PERMISSION_APPROVAL_LABELS: [&str; 7] = [
    "Deny",
    "Allow once",
    "Allow for session",
    "Allow for project (local)",
    "Allow for project",
    "Allow for user (local)",
    "Allow for user",
];

/// The plan-handoff decision order pilot's select card renders. Index 0,1,2.
/// Must match `buildPlanHandoffRequest()` in `event-map.ts`.
const PLAN_HANDOFF_DECISIONS: [&str; 3] = [
    "implement_new_context",
    "implement_current_context",
    "cancel",
];

/// Map an approval choice index (from a label lookup) to the grant + persistence
/// pair, or `None` if out of range.
fn approval_from_index(idx: usize) -> Option<ApprovalChoice> {
    PERMISSION_APPROVAL_CHOICES.get(idx).cloned()
}

/// Prune the 7 approval choices down to those valid for the current request.
///
/// The daemon's `permission_candidate_rule.keep_targets` lists the persistence
/// targets a grant may use for THIS request. When present, grant choices whose
/// `persistence_target` is NOT in `keep_targets` are invalid (the daemon would
/// reject them) so we don't offer them. Always kept:
/// - Deny (index 0, null target — a refusal is always valid)
/// - Allow once (index 1, null target — this occurrence only, no persistence)
///
/// When `keep_targets` is `None`/empty (no candidate rule, or a degraded daemon
/// that didn't send one), return all 7 — backward compat with the pre-pruning
/// behavior, so an operator still sees every option.
///
/// This is the SINGLE source of truth for pruning — used by the forward mapping
/// (`event-map.ts`) AND the mock fixture (`fixtures.ts`) so both paths agree.
pub fn prune_approval_options(keep_targets: Option<&[PersistenceTarget]>) -> Vec<ApprovalChoice> {
    match keep_targets {
        None | Some(&[]) => PERMISSION_APPROVAL_CHOICES.to_vec(),
        Some(targets) => {
            PERMISSION_APPROVAL_CHOICES
                .iter()
                .filter(|choice| {
                    // Deny (index 0) + Allow once (index 1) have null targets —
                    // always valid.
                    match &choice.persistence_target {
                        None => true,
                        Some(pt) => targets.contains(pt),
                    }
                })
                .cloned()
                .collect()
        }
    }
}

// ---------------------------------------------------------------------------
// The pure response builder. Returns the `InterrogativeResponse` to POST, or
// `None` when the response doesn't match the pending interrogative's type (a
// bug — the hub should never route a confirm reply to a permission card).
// ---------------------------------------------------------------------------

/// Build the polytoken `InterrogativeResponse` for a pilot `HostUiResponse`,
/// given the pending interrogative's captured metadata. Pure — the driver
/// POSTs.
///
/// Returns `None` if the response shape doesn't match the interrogative type (a
/// defensively-typed no-op rather than a throw, so a misrouted response surfaces
/// as a stuck card the operator can dismiss, not a crashed driver).
///
/// `cancelled` is special-cased: pilot sends it for any dialog the operator
/// dismissed, and the daemon accepts `kind:"cancel"` for every interrogative
/// type — so cancel short-circuits before the type switch.
pub fn build_interrogative_response(
    pending: &PendingInterrogative,
    response: &HostUiResponse,
) -> Option<InterrogativeResponse> {
    // Cancel dismisses any interrogative — the daemon accepts kind:"cancel"
    // universally, regardless of interrogative_type.
    if let HostUiResponse::Cancelled { .. } = response {
        return Some(InterrogativeResponse::Cancel);
    }

    match pending.interrogative_type {
        PendingInterrogativeType::Confirmation => {
            // pilot confirm card → {requestId, confirmed}. Maps directly.
            if let HostUiResponse::Confirmed { confirmed, .. } = response {
                Some(InterrogativeResponse::ConfirmationAnswer {
                    confirmed: *confirmed,
                })
            } else {
                None
            }
        }

        PendingInterrogativeType::Clarification => {
            // A clarification offers options (select) OR free text (input).
            // pilot renders both as needed; the response shape tells us which
            // path fired.
            match response {
                HostUiResponse::Value { value, .. } => {
                    let labels = pending.clarification_labels.as_deref();
                    let keys = pending.clarification_option_keys.as_deref();
                    if let (Some(labels), Some(keys)) = (labels, keys) {
                        if !labels.is_empty() {
                            // Select path: the client sends the chosen LABEL
                            // string (not an index). Map label → index → the
                            // daemon's key.
                            let idx = labels.iter().position(|l| l == value);
                            if let Some(idx) = idx {
                                if idx < keys.len() {
                                    return Some(InterrogativeResponse::ClarificationChoice {
                                        choice: keys[idx].clone(),
                                    });
                                }
                            }
                            return None;
                        }
                    }
                    // Free-text path: value is the typed answer.
                    Some(InterrogativeResponse::ClarificationText {
                        text: value.clone(),
                    })
                }
                HostUiResponse::Answers { answers, .. } => {
                    // A qna-style answer to a clarification is unexpected; treat
                    // as text.
                    let text = answers
                        .first()
                        .map(|a| a.custom_text.clone())
                        .unwrap_or_default();
                    Some(InterrogativeResponse::ClarificationText { text })
                }
                _ => None,
            }
        }

        PendingInterrogativeType::Capability => {
            // pilot capability card → a confirm-like {requestId, confirmed}.
            if let HostUiResponse::Confirmed { confirmed, .. } = response {
                Some(InterrogativeResponse::CapabilityAnswer {
                    granted: *confirmed,
                })
            } else {
                None
            }
        }

        PendingInterrogativeType::PlanHandoff => {
            // pilot plan-handoff card → a select whose value is the chosen LABEL
            // string. Map label → index → the decision (the labels are parallel
            // to PLAN_HANDOFF_DECISIONS, captured by the forward mapping).
            if let HostUiResponse::Value { value, .. } = response {
                let labels = pending.plan_handoff_labels.as_deref();
                let Some(labels) = labels else {
                    return None;
                };
                let idx = labels.iter().position(|l| l == value);
                let Some(idx) = idx else {
                    return None;
                };
                if idx >= PLAN_HANDOFF_DECISIONS.len() {
                    return None;
                }
                let decision: PlanHandoffDecision =
                    serde_json::Value::String(PLAN_HANDOFF_DECISIONS[idx].to_string());
                Some(InterrogativeResponse::PlanHandoffAnswer { decision })
            } else {
                None
            }
        }

        PendingInterrogativeType::Permission => {
            // pilot permission card → a select whose value is the chosen LABEL
            // string. The label↔choice mapping is ALWAYS via the full
            // PERMISSION_APPROVAL_LABELS index (a label always maps to the same
            // grant/target, pruning or not). When the forward mapping pruned
            // options (permissionChoices captured), reject labels whose choice
            // didn't survive pruning — a stale/raced response to a pruned-out
            // option shouldn't reach the daemon. The fallback (no
            // permissionChoices) accepts any known label (backward compat — the
            // existing ui-bridge tests call pending("permission") with no
            // choices).
            if let HostUiResponse::Value { value, .. } = response {
                let idx = PERMISSION_APPROVAL_LABELS
                    .iter()
                    .position(|l| *l == value.as_str());
                let Some(idx) = idx else {
                    return None;
                };
                let choice = approval_from_index(idx);
                let Some(choice) = choice else {
                    return None;
                };
                if let Some(choices) = &pending.permission_choices {
                    if !choices.contains(&choice) {
                        return None;
                    }
                }
                Some(InterrogativeResponse::PermissionAnswer {
                    granted: choice.granted,
                    persistence_target: choice.persistence_target,
                })
            } else {
                None
            }
        }

        PendingInterrogativeType::AskUserQuestion => {
            // Separate DaemonEvent variant, but same respond endpoint. pilot's
            // qna card returns one QnaAnswer per question; map each to an
            // AskUserQuestionReply with the question id + selected option ids.
            if let HostUiResponse::Answers { answers, .. } = response {
                let questions = pending.questions.as_deref().unwrap_or(&[]);
                let replies: Vec<AskUserQuestionReply> = answers
                    .iter()
                    .enumerate()
                    .map(|(i, ans)| build_ask_user_question_reply(i, ans, questions))
                    .collect();
                Some(InterrogativeResponse::AskUserQuestionAnswers {
                    answers: replies,
                })
            } else {
                None
            }
        }

        PendingInterrogativeType::GoalProposal => {
            // pilot confirm card → {requestId, confirmed}. Maps directly to
            // goal_proposal_answer{accepted: boolean}.
            if let HostUiResponse::Confirmed { confirmed, .. } = response {
                Some(InterrogativeResponse::GoalProposalAnswer {
                    accepted: *confirmed,
                })
            } else {
                None
            }
        }

        PendingInterrogativeType::Unknown => {
            // Unknown interrogative type (from the deny-safe default arm in
            // buildInterrogativeMapping). Cancel is the only valid action —
            // both the confirm(true) and confirm(false) button paths produce
            // {kind:"cancel"} so the daemon's turn is always unblocked.
            Some(InterrogativeResponse::Cancel)
        }
    }
}

/// Build one `AskUserQuestionReply` from a `QnaAnswer` + its pending question.
///
/// Maps `ans.selectedOptionIndices` (indices into `option_labels`) to the
/// daemon's option ids via `option_ids`. Out-of-bounds or negative indices are
/// skipped (matching the TS `.filter((id): id is string => typeof id === "string")`).
/// `free_text` is `None` when `custom_text` is empty (matching the JS
/// `ans.customText || null` falsy check).
fn build_ask_user_question_reply(
    i: usize,
    ans: &QnaAnswer,
    questions: &[PendingQuestion],
) -> AskUserQuestionReply {
    let q = questions.get(i);
    let option_ids: &[String] = q.map(|q| q.option_ids.as_slice()).unwrap_or(&[]);
    let selected_option_ids: Vec<String> = ans
        .selected_option_indices
        .iter()
        .filter_map(|&idx| {
            // The TS uses `optionIds[idx]` which returns undefined for negative
            // or out-of-bounds indices, then filters those out. In Rust, we
            // check bounds explicitly.
            if idx >= 0 {
                let uidx = idx as usize;
                option_ids.get(uidx).cloned()
            } else {
                None
            }
        })
        .collect();
    // `ans.customText || null` — empty string is falsy in JS → null.
    let free_text = if ans.custom_text.is_empty() {
        None
    } else {
        Some(ans.custom_text.clone())
    };
    AskUserQuestionReply {
        question_id: q.map(|q| q.question_id.clone()).unwrap_or_default(),
        // Always include the array (matching the TS which always sends
        // selected_option_ids as an array, never omits it).
        selected_option_ids: Some(selected_option_ids),
        free_text,
    }
}
