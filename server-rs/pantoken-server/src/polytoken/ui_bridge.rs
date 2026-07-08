//! The reverse half of the host-UI bridge: translate pantoken's `HostUiResponse`
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

use pantoken_daemon_types::{
    AskUserQuestionReply, InterrogativeResponse, InterrogativeType, PersistenceTarget,
    PlanHandoffDecision,
};
use pantoken_protocol::session_driver::{HostUiResponse, QnaAnswer};

/// pantoken-side discriminator that extends the daemon's `InterrogativeType` with
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

/// One question's id + its option ids + rendered labels, in pantoken's render
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
/// to build the correct response shape from any pantoken `HostUiResponse` variant.
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
    /// the pantoken-side `AskUserQuestion` for the separate `DaemonEvent` variant.
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
    /// plus rendered labels, in pantoken's qna render order. A `QnaAnswer`'s
    /// `selectedOptionIndices` index into `optionLabels`; the builder maps them
    /// to the daemon's option ids. Also determines question count and ordering
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
// pantoken's approval card surfaces the daemon's 7 choices as a select list whose
// first option (index 0) is "Deny" and indices 1-6 are the grant+target pairs.
// A select response carries the chosen index in `value` (a string). This maps
// that index back to the granted/persistence_target pair the daemon expects.
//
// The ordering MUST match `buildPermissionRequest()` in `event-map.ts` — the
// index is the only link between the card pantoken rendered and the response it
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

/// pantoken's approval card order: Deny (0), then grants by escalating scope.
/// This is the SINGLE source of truth for the index↔target mapping —
/// `buildPermissionRequest()` in `event-map.ts` renders options in this order,
/// and this array maps a response index back. Keep them in sync.
pub const PERMISSION_APPROVAL_CHOICES: [ApprovalChoice; 7] = [
    ApprovalChoice {
        granted: false,
        persistence_target: None,
    }, // "Deny"
    ApprovalChoice {
        granted: true,
        persistence_target: None,
    }, // "Allow once" (null = this occurrence only)
    ApprovalChoice {
        granted: true,
        persistence_target: Some(PersistenceTarget::Session),
    },
    ApprovalChoice {
        granted: true,
        persistence_target: Some(PersistenceTarget::ProjectLocal),
    },
    ApprovalChoice {
        granted: true,
        persistence_target: Some(PersistenceTarget::Project),
    },
    ApprovalChoice {
        granted: true,
        persistence_target: Some(PersistenceTarget::UserLocal),
    },
    ApprovalChoice {
        granted: true,
        persistence_target: Some(PersistenceTarget::User),
    },
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

/// The plan-handoff decision order pantoken's select card renders. Index 0,1,2.
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

/// Build the polytoken `InterrogativeResponse` for a pantoken `HostUiResponse`,
/// given the pending interrogative's captured metadata. Pure — the driver
/// POSTs.
///
/// Returns `None` if the response shape doesn't match the interrogative type (a
/// defensively-typed no-op rather than a throw, so a misrouted response surfaces
/// as a stuck card the operator can dismiss, not a crashed driver).
///
/// `cancelled` is special-cased: pantoken sends it for any dialog the operator
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
            // pantoken confirm card → {requestId, confirmed}. Maps directly.
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
            // pantoken renders both as needed; the response shape tells us which
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
            // pantoken capability card → a confirm-like {requestId, confirmed}.
            if let HostUiResponse::Confirmed { confirmed, .. } = response {
                Some(InterrogativeResponse::CapabilityAnswer {
                    granted: *confirmed,
                })
            } else {
                None
            }
        }

        PendingInterrogativeType::PlanHandoff => {
            // pantoken plan-handoff card → a select whose value is the chosen LABEL
            // string. Map label → index → the decision (the labels are parallel
            // to PLAN_HANDOFF_DECISIONS, captured by the forward mapping).
            if let HostUiResponse::Value { value, .. } = response {
                let labels = pending.plan_handoff_labels.as_deref()?;
                let idx = labels.iter().position(|l| l == value)?;
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
            // pantoken permission card → a select whose value is the chosen LABEL
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
                    .position(|l| *l == value.as_str())?;
                let choice = approval_from_index(idx)?;
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
            // Separate DaemonEvent variant, but same respond endpoint. pantoken's
            // qna card returns one QnaAnswer per question; map each to an
            // AskUserQuestionReply with the question id + selected option ids.
            if let HostUiResponse::Answers { answers, .. } = response {
                let questions = pending.questions.as_deref().unwrap_or(&[]);
                let replies: Vec<AskUserQuestionReply> = answers
                    .iter()
                    .enumerate()
                    .map(|(i, ans)| build_ask_user_question_reply(i, ans, questions))
                    .collect();
                Some(InterrogativeResponse::AskUserQuestionAnswers { answers: replies })
            } else {
                None
            }
        }

        PendingInterrogativeType::GoalProposal => {
            // pantoken confirm card → {requestId, confirmed}. Maps directly to
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(interrogative_type: PendingInterrogativeType) -> PendingInterrogative {
        PendingInterrogative {
            interrogative_id: "i1".to_string(),
            interrogative_type,
            clarification_labels: None,
            clarification_option_keys: None,
            plan_handoff_labels: None,
            questions: None,
            permission_choices: None,
        }
    }

    fn value(value: &str) -> HostUiResponse {
        HostUiResponse::Value {
            request_id: "i1".to_string(),
            value: value.to_string(),
        }
    }

    fn confirmed(confirmed: bool) -> HostUiResponse {
        HostUiResponse::Confirmed {
            request_id: "i1".to_string(),
            confirmed,
        }
    }

    fn cancel() -> HostUiResponse {
        HostUiResponse::Cancelled {
            request_id: "i1".to_string(),
            cancelled: true,
        }
    }

    fn answer(selected_option_indices: Vec<i64>, custom_text: &str) -> QnaAnswer {
        QnaAnswer {
            selected_option_indices,
            custom_text: custom_text.to_string(),
        }
    }

    fn answers(answers: Vec<QnaAnswer>) -> HostUiResponse {
        HostUiResponse::Answers {
            request_id: "i1".to_string(),
            answers,
        }
    }

    fn with_clarification_options(
        mut pending: PendingInterrogative,
        labels: Vec<&str>,
        keys: Vec<&str>,
    ) -> PendingInterrogative {
        pending.clarification_labels = Some(labels.into_iter().map(str::to_string).collect());
        pending.clarification_option_keys = Some(keys.into_iter().map(str::to_string).collect());
        pending
    }

    fn with_plan_handoff_labels(
        mut pending: PendingInterrogative,
        labels: Vec<&str>,
    ) -> PendingInterrogative {
        pending.plan_handoff_labels = Some(labels.into_iter().map(str::to_string).collect());
        pending
    }

    fn with_questions(
        mut pending: PendingInterrogative,
        questions: Vec<PendingQuestion>,
    ) -> PendingInterrogative {
        pending.questions = Some(questions);
        pending
    }

    fn with_permission_choices(
        mut pending: PendingInterrogative,
        permission_choices: Vec<ApprovalChoice>,
    ) -> PendingInterrogative {
        pending.permission_choices = Some(permission_choices);
        pending
    }

    fn question(question_id: &str, option_ids: Vec<&str>) -> PendingQuestion {
        PendingQuestion {
            question_id: question_id.to_string(),
            option_ids: option_ids.into_iter().map(str::to_string).collect(),
            option_labels: None,
        }
    }

    fn build(
        pending: PendingInterrogative,
        response: HostUiResponse,
    ) -> Option<InterrogativeResponse> {
        build_interrogative_response(&pending, &response)
    }

    fn expect_cancel(out: Option<InterrogativeResponse>) {
        assert!(matches!(out, Some(InterrogativeResponse::Cancel)));
    }

    fn expect_permission(
        out: Option<InterrogativeResponse>,
        expected_granted: bool,
        expected_target: Option<PersistenceTarget>,
    ) {
        match out {
            Some(InterrogativeResponse::PermissionAnswer {
                granted,
                persistence_target,
            }) => {
                assert_eq!(granted, expected_granted);
                assert_eq!(persistence_target, expected_target);
            }
            other => panic!("expected permission answer, got {other:?}"),
        }
    }

    fn expect_ask_user_question_answers(
        out: Option<InterrogativeResponse>,
    ) -> Vec<AskUserQuestionReply> {
        match out {
            Some(InterrogativeResponse::AskUserQuestionAnswers { answers }) => answers,
            other => panic!("expected ask_user_question_answers, got {other:?}"),
        }
    }

    #[test]
    fn cancel_kind_cancel_regardless_of_type() {
        for interrogative_type in [
            PendingInterrogativeType::Confirmation,
            PendingInterrogativeType::Clarification,
            PendingInterrogativeType::Capability,
            PendingInterrogativeType::PlanHandoff,
            PendingInterrogativeType::Permission,
            PendingInterrogativeType::AskUserQuestion,
            PendingInterrogativeType::GoalProposal,
            PendingInterrogativeType::Unknown,
        ] {
            expect_cancel(build(pending(interrogative_type), cancel()));
        }
    }

    #[test]
    fn confirmation_confirmed_true_confirmation_answer_confirmed_true() {
        match build(
            pending(PendingInterrogativeType::Confirmation),
            confirmed(true),
        ) {
            Some(InterrogativeResponse::ConfirmationAnswer { confirmed }) => assert!(confirmed),
            other => panic!("expected confirmation answer, got {other:?}"),
        }
    }

    #[test]
    fn confirmation_confirmed_false_confirmation_answer_confirmed_false() {
        match build(
            pending(PendingInterrogativeType::Confirmation),
            confirmed(false),
        ) {
            Some(InterrogativeResponse::ConfirmationAnswer { confirmed }) => assert!(!confirmed),
            other => panic!("expected confirmation answer, got {other:?}"),
        }
    }

    #[test]
    fn confirmation_wrong_shape_value_null_misroute_defense() {
        assert!(
            build(
                pending(PendingInterrogativeType::Confirmation),
                value("yes")
            )
            .is_none()
        );
    }

    #[test]
    fn clarification_select_label_yes_clarification_choice_with_keys_0() {
        let out = build(
            with_clarification_options(
                pending(PendingInterrogativeType::Clarification),
                vec!["Yes", "No"],
                vec!["yes", "no"],
            ),
            value("Yes"),
        );
        match out {
            Some(InterrogativeResponse::ClarificationChoice { choice }) => {
                assert_eq!(choice, "yes")
            }
            other => panic!("expected clarification choice, got {other:?}"),
        }
    }

    #[test]
    fn clarification_select_label_no_clarification_choice_with_keys_1() {
        let out = build(
            with_clarification_options(
                pending(PendingInterrogativeType::Clarification),
                vec!["Yes", "No"],
                vec!["yes", "no"],
            ),
            value("No"),
        );
        match out {
            Some(InterrogativeResponse::ClarificationChoice { choice }) => assert_eq!(choice, "no"),
            other => panic!("expected clarification choice, got {other:?}"),
        }
    }

    #[test]
    fn clarification_unknown_label_null() {
        let out = build(
            with_clarification_options(
                pending(PendingInterrogativeType::Clarification),
                vec!["Yes"],
                vec!["yes"],
            ),
            value("Maybe"),
        );
        assert!(out.is_none());
    }

    #[test]
    fn clarification_value_with_no_labels_clarification_text() {
        match build(
            pending(PendingInterrogativeType::Clarification),
            value("my custom answer"),
        ) {
            Some(InterrogativeResponse::ClarificationText { text }) => {
                assert_eq!(text, "my custom answer");
            }
            other => panic!("expected clarification text, got {other:?}"),
        }
    }

    #[test]
    fn clarification_empty_labels_clarification_text() {
        let out = build(
            with_clarification_options(
                pending(PendingInterrogativeType::Clarification),
                vec![],
                vec![],
            ),
            value("typed"),
        );
        match out {
            Some(InterrogativeResponse::ClarificationText { text }) => assert_eq!(text, "typed"),
            other => panic!("expected clarification text, got {other:?}"),
        }
    }

    #[test]
    fn capability_confirmed_true_capability_answer_granted_true() {
        match build(
            pending(PendingInterrogativeType::Capability),
            confirmed(true),
        ) {
            Some(InterrogativeResponse::CapabilityAnswer { granted }) => assert!(granted),
            other => panic!("expected capability answer, got {other:?}"),
        }
    }

    #[test]
    fn capability_confirmed_false_capability_answer_granted_false() {
        match build(
            pending(PendingInterrogativeType::Capability),
            confirmed(false),
        ) {
            Some(InterrogativeResponse::CapabilityAnswer { granted }) => assert!(!granted),
            other => panic!("expected capability answer, got {other:?}"),
        }
    }

    #[test]
    fn plan_handoff_label_implement_fresh_implement_new_context() {
        let out = build(
            with_plan_handoff_labels(
                pending(PendingInterrogativeType::PlanHandoff),
                vec!["Implement fresh", "Implement here", "Cancel"],
            ),
            value("Implement fresh"),
        );
        match out {
            Some(InterrogativeResponse::PlanHandoffAnswer { decision }) => {
                assert_eq!(decision, serde_json::json!("implement_new_context"));
            }
            other => panic!("expected plan handoff answer, got {other:?}"),
        }
    }

    #[test]
    fn plan_handoff_label_implement_here_implement_current_context() {
        let out = build(
            with_plan_handoff_labels(
                pending(PendingInterrogativeType::PlanHandoff),
                vec!["Implement fresh", "Implement here", "Cancel"],
            ),
            value("Implement here"),
        );
        match out {
            Some(InterrogativeResponse::PlanHandoffAnswer { decision }) => {
                assert_eq!(decision, serde_json::json!("implement_current_context"));
            }
            other => panic!("expected plan handoff answer, got {other:?}"),
        }
    }

    #[test]
    fn plan_handoff_label_cancel_cancel() {
        let out = build(
            with_plan_handoff_labels(
                pending(PendingInterrogativeType::PlanHandoff),
                vec!["Implement fresh", "Implement here", "Cancel"],
            ),
            value("Cancel"),
        );
        match out {
            Some(InterrogativeResponse::PlanHandoffAnswer { decision }) => {
                assert_eq!(decision, serde_json::json!("cancel"));
            }
            other => panic!("expected plan handoff answer, got {other:?}"),
        }
    }

    #[test]
    fn plan_handoff_unknown_label_null() {
        let out = build(
            with_plan_handoff_labels(
                pending(PendingInterrogativeType::PlanHandoff),
                vec!["Implement fresh", "Implement here", "Cancel"],
            ),
            value("Something else"),
        );
        assert!(out.is_none());
    }

    #[test]
    fn permission_label_deny_permission_answer_granted_false_target_null() {
        expect_permission(
            build(pending(PendingInterrogativeType::Permission), value("Deny")),
            false,
            None,
        );
    }

    #[test]
    fn permission_label_allow_once_granted_true_target_null() {
        expect_permission(
            build(
                pending(PendingInterrogativeType::Permission),
                value("Allow once"),
            ),
            true,
            None,
        );
    }

    #[test]
    fn permission_label_allow_for_session_granted_true_target_session() {
        expect_permission(
            build(
                pending(PendingInterrogativeType::Permission),
                value("Allow for session"),
            ),
            true,
            Some(PersistenceTarget::Session),
        );
    }

    #[test]
    fn permission_label_allow_for_user_granted_true_target_user() {
        expect_permission(
            build(
                pending(PendingInterrogativeType::Permission),
                value("Allow for user"),
            ),
            true,
            Some(PersistenceTarget::User),
        );
    }

    #[test]
    fn permission_unknown_label_null() {
        assert!(
            build(
                pending(PendingInterrogativeType::Permission),
                value("Maybe")
            )
            .is_none()
        );
    }

    #[test]
    fn permission_pruned_subset_allow_for_session_correct_grant_target() {
        let choices = prune_approval_options(Some(&[PersistenceTarget::Session]));
        expect_permission(
            build(
                with_permission_choices(pending(PendingInterrogativeType::Permission), choices),
                value("Allow for session"),
            ),
            true,
            Some(PersistenceTarget::Session),
        );
    }

    #[test]
    fn permission_pruned_subset_deny_granted_false() {
        let choices = prune_approval_options(Some(&[PersistenceTarget::User]));
        expect_permission(
            build(
                with_permission_choices(pending(PendingInterrogativeType::Permission), choices),
                value("Deny"),
            ),
            false,
            None,
        );
    }

    #[test]
    fn permission_pruned_subset_allow_for_user_pruned_out_null() {
        let choices = prune_approval_options(Some(&[PersistenceTarget::Session]));
        assert!(
            build(
                with_permission_choices(pending(PendingInterrogativeType::Permission), choices),
                value("Allow for user"),
            )
            .is_none()
        );
    }

    #[test]
    fn permission_no_permission_choices_fallback_fixed_array_lookup_still_works() {
        expect_permission(
            build(
                pending(PendingInterrogativeType::Permission),
                value("Allow for project"),
            ),
            true,
            Some(PersistenceTarget::Project),
        );
    }

    #[test]
    fn ask_user_question_answers_ask_user_question_answers_with_option_ids_mapped() {
        let out = build(
            with_questions(
                pending(PendingInterrogativeType::AskUserQuestion),
                vec![question("q-a", vec!["o1", "o2"]), question("q-b", vec![])],
            ),
            answers(vec![
                answer(vec![0], ""),
                answer(vec![], "free text answer"),
            ]),
        );
        let answers = expect_ask_user_question_answers(out);
        assert_eq!(answers.len(), 2);
        assert_eq!(answers[0].question_id, "q-a");
        assert_eq!(answers[0].selected_option_ids, Some(vec!["o1".to_string()]));
        assert_eq!(answers[0].free_text, None);
        assert_eq!(answers[1].question_id, "q-b");
        assert_eq!(answers[1].selected_option_ids, Some(vec![]));
        assert_eq!(answers[1].free_text, Some("free text answer".to_string()));
    }

    #[test]
    fn ask_user_question_multi_select_all_selected_option_ids_mapped() {
        let out = build(
            with_questions(
                pending(PendingInterrogativeType::AskUserQuestion),
                vec![question("q-a", vec!["o1", "o2", "o3"])],
            ),
            answers(vec![answer(vec![0, 2], "")]),
        );
        let answers = expect_ask_user_question_answers(out);
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].question_id, "q-a");
        assert_eq!(
            answers[0].selected_option_ids,
            Some(vec!["o1".to_string(), "o3".to_string()])
        );
    }

    #[test]
    fn ask_user_question_out_of_range_index_filtered_out_not_crashed() {
        let out = build(
            with_questions(
                pending(PendingInterrogativeType::AskUserQuestion),
                vec![question("q-a", vec!["o1"])],
            ),
            answers(vec![answer(vec![0, 5], "")]),
        );
        let answers = expect_ask_user_question_answers(out);
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].selected_option_ids, Some(vec!["o1".to_string()]));
    }

    #[test]
    fn ask_user_question_wrong_shape_confirmed_null() {
        assert!(
            build(
                pending(PendingInterrogativeType::AskUserQuestion),
                confirmed(true),
            )
            .is_none()
        );
    }

    #[test]
    fn goal_proposal_confirmed_true_goal_proposal_answer_accepted_true() {
        match build(
            pending(PendingInterrogativeType::GoalProposal),
            confirmed(true),
        ) {
            Some(InterrogativeResponse::GoalProposalAnswer { accepted }) => assert!(accepted),
            other => panic!("expected goal proposal answer, got {other:?}"),
        }
    }

    #[test]
    fn goal_proposal_confirmed_false_goal_proposal_answer_accepted_false() {
        match build(
            pending(PendingInterrogativeType::GoalProposal),
            confirmed(false),
        ) {
            Some(InterrogativeResponse::GoalProposalAnswer { accepted }) => assert!(!accepted),
            other => panic!("expected goal proposal answer, got {other:?}"),
        }
    }

    #[test]
    fn goal_proposal_wrong_shape_value_null() {
        assert!(
            build(
                pending(PendingInterrogativeType::GoalProposal),
                value("something"),
            )
            .is_none()
        );
    }

    #[test]
    fn unknown_confirmed_false_kind_cancel_dismiss_button() {
        expect_cancel(build(
            pending(PendingInterrogativeType::Unknown),
            confirmed(false),
        ));
    }

    #[test]
    fn unknown_confirmed_true_kind_cancel_affirmative_also_cancels() {
        expect_cancel(build(
            pending(PendingInterrogativeType::Unknown),
            confirmed(true),
        ));
    }

    #[test]
    fn permission_approval_labels_has_7_entries_matching_the_choices() {
        assert_eq!(PERMISSION_APPROVAL_LABELS.len(), 7);
        assert_eq!(PERMISSION_APPROVAL_CHOICES.len(), 7);
    }

    #[test]
    fn index_0_is_deny_granted_false() {
        assert!(!PERMISSION_APPROVAL_CHOICES[0].granted);
        assert_eq!(PERMISSION_APPROVAL_CHOICES[0].persistence_target, None);
    }

    #[test]
    fn index_1_is_allow_once_granted_true_null_target() {
        assert!(PERMISSION_APPROVAL_CHOICES[1].granted);
        assert_eq!(PERMISSION_APPROVAL_CHOICES[1].persistence_target, None);
    }

    #[test]
    fn indices_2_6_grant_with_escalating_persistence_targets() {
        let targets: Vec<Option<PersistenceTarget>> = PERMISSION_APPROVAL_CHOICES[2..]
            .iter()
            .map(|choice| choice.persistence_target.clone())
            .collect();
        assert_eq!(
            targets,
            vec![
                Some(PersistenceTarget::Session),
                Some(PersistenceTarget::ProjectLocal),
                Some(PersistenceTarget::Project),
                Some(PersistenceTarget::UserLocal),
                Some(PersistenceTarget::User),
            ]
        );
    }

    #[test]
    fn every_grant_choice_has_granted_true() {
        for choice in &PERMISSION_APPROVAL_CHOICES[1..] {
            assert!(choice.granted);
        }
    }
}
