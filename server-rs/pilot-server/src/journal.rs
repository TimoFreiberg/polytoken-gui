//! Per-session append-only journal — Rust port of `server/src/journal.ts`.
//!
//! One structure is simultaneously the seed source for connecting clients
//! (fold from zero), the resume ring for reconnecting ones (tail replay),
//! and the journaling router's core (a journaling router needs no steady-state
//! server-side fold — the hub folds a state only on demand).
//!
//! Invariant: at every instant, `fold_all(build_seed(journal).events)` ≡
//! the state a connected client folded.

use pilot_protocol::session_driver::{
    AssistantDeltaChannel, HostUiRequest, SessionDriverEvent, SessionEventBase, SessionRef,
    SessionSnapshot, WorkspaceRef,
};
use pilot_protocol::state::SessionState;

/// Tail ring caps: whichever trips first evicts oldest frames into `compacted`.
/// Bigger = a longer resumable gap for reconnecting clients, more RAM. A resume
/// older than the tail degrades to a full seed — never an error.
pub const TAIL_MAX_FRAMES: usize = 1024;
pub const TAIL_MAX_BYTES: usize = 256 * 1024;

/// One live ring entry: a stamped event awaiting possible tail-resume replay.
#[derive(Debug, Clone)]
pub struct JournalFrame {
    pub seq: u64,
    pub ev: SessionDriverEvent,
    pub bytes: usize,
}

/// The per-session journal.
#[derive(Debug, Clone)]
pub struct SessionJournal {
    /// Identity of this transcript build. Bumped when the transcript's identity
    /// changes (first attach, sessionReset, reload/branch reseed) — resume across
    /// a bump is impossible, clients must take a full seed.
    pub epoch: u64,
    /// Last assigned seq this epoch; 0 = nothing stamped yet.
    pub seq: u64,
    /// History prefix below the resume window: events evicted from the tail (or
    /// the original seed), delta-coalesced. No seqs needed — it's only foldable,
    /// never replayable.
    pub compacted: Vec<SessionDriverEvent>,
    /// The live ring — the resume source. Oldest first.
    pub tail: Vec<JournalFrame>,
    /// Total bytes of all tail frames.
    pub tail_bytes: usize,
}

pub fn create_journal(epoch: u64, seed: &[SessionDriverEvent]) -> SessionJournal {
    SessionJournal {
        epoch,
        seq: 0,
        compacted: coalesce_events(seed),
        tail: Vec::new(),
        tail_bytes: 0,
    }
}

/// Restart the journal under a new epoch (transcript identity changed). The new
/// `seed` becomes the compacted prefix; the tail (and its seq space) resets.
pub fn bump_epoch(j: &mut SessionJournal, epoch: u64, seed: &[SessionDriverEvent]) {
    j.epoch = epoch;
    j.seq = 0;
    j.compacted = coalesce_events(seed);
    j.tail.clear();
    j.tail_bytes = 0;
}

/// Stamp one event into the tail, evicting oldest frames into the compacted
/// prefix when the ring overflows. Returns the assigned seq.
pub fn append_event(j: &mut SessionJournal, ev: SessionDriverEvent) -> u64 {
    j.seq += 1;
    let bytes = serde_json::to_string(&ev).map(|s| s.len()).unwrap_or(0);
    let frame = JournalFrame {
        seq: j.seq,
        ev,
        bytes,
    };
    j.tail.push(frame);
    j.tail_bytes += j.tail.last().unwrap().bytes;

    while j.tail.len() > TAIL_MAX_FRAMES || j.tail_bytes > TAIL_MAX_BYTES {
        if j.tail.is_empty() {
            break;
        }
        let oldest = j.tail.remove(0);
        j.tail_bytes -= oldest.bytes;
        compacted_append(&mut j.compacted, oldest.ev);
    }
    j.seq
}

/// Can a client folded through `seq` (same epoch) be caught up from the tail
/// alone? True when nothing is missing between its watermark and the ring:
/// either it's already current, or the ring's oldest frame is at most seq+1.
pub fn tail_covers(j: &SessionJournal, seq: u64) -> bool {
    if seq > j.seq {
        return false; // claims a future this journal never stamped
    }
    if seq == j.seq {
        return true; // already current — nothing to replay
    }
    match j.tail.first() {
        Some(first) => first.seq <= seq + 1,
        None => false,
    }
}

/// The seed for one connecting client: every journaled event, delta-coalesced,
/// plus the {epoch, seq} watermark of the last event folded into it.
pub fn build_seed(j: &SessionJournal) -> (u64, u64, Vec<SessionDriverEvent>) {
    let mut all = j.compacted.clone();
    all.extend(j.tail.iter().map(|f| f.ev.clone()));
    (j.epoch, j.seq, coalesce_events(&all))
}

/// Append one event to the compacted prefix, merging into its last element when
/// the pair is mergeable.
fn compacted_append(compacted: &mut Vec<SessionDriverEvent>, ev: SessionDriverEvent) {
    if let Some(last) = compacted.last() {
        if let Some(merged) = try_merge(last, &ev) {
            *compacted.last_mut().unwrap() = merged;
            return;
        }
    }
    compacted.push(ev);
}

/// Merge two ADJACENT events into one fold-equivalent event, or return None.
///
/// - assistantDelta + assistantDelta on the same effective channel concatenate.
///   Safe purely by fold semantics: after folding the first delta an assistant
///   bubble is open, so the second always appends to the same accumulator — the
///   merged event (first's timestamp/entryId, joined text) folds byte-identically.
/// - usageUpdated + usageUpdated keeps the later one (the fold overwrites
///   `usage` wholesale, so only the last of an adjacent run matters).
pub fn try_merge(a: &SessionDriverEvent, b: &SessionDriverEvent) -> Option<SessionDriverEvent> {
    use SessionDriverEvent::*;

    match (a, b) {
        (
            AssistantDelta {
                base,
                text,
                channel,
                entry_id,
            },
            AssistantDelta {
                text: text_b,
                channel: channel_b,
                ..
            },
        ) => {
            let chan_a = channel.unwrap_or(AssistantDeltaChannel::Text);
            let chan_b = channel_b.unwrap_or(AssistantDeltaChannel::Text);
            if chan_a != chan_b {
                return None;
            }
            Some(AssistantDelta {
                base: base.clone(),
                text: text.clone() + text_b,
                channel: Some(chan_a),
                entry_id: entry_id.clone(),
            })
        }
        (UsageUpdated { .. }, UsageUpdated { base, usage }) => Some(UsageUpdated {
            base: base.clone(),
            usage: usage.clone(),
        }),
        _ => None,
    }
}

/// Collapse adjacent mergeable events. Fold-equivalent by construction.
pub fn coalesce_events(events: &[SessionDriverEvent]) -> Vec<SessionDriverEvent> {
    let mut out = Vec::new();
    for ev in events {
        compacted_append(&mut out, ev.clone());
    }
    out
}

/// Synthesize a minimal event prefix that reproduces a folded state's NON-item
/// fields: one `sessionOpened` carrying the meta projection, plus `hostUiRequest`
/// events for the ambient statuses/widgets/title and the pending dialogs.
///
/// Used when the journal restarts at a `sessionReset` epoch bump: the fold
/// preserves ref/title/config/queued/approvals/ambient across a reset (only
/// `items` clears), so the restarted journal needs a prefix that carries them.
pub fn meta_seed_events(
    state: &SessionState,
    session_ref: &SessionRef,
    timestamp: &str,
) -> Vec<SessionDriverEvent> {
    let r#ref = state.session_ref.as_ref().unwrap_or(session_ref);
    let mut events = Vec::new();

    // Build the sessionOpened snapshot carrying all non-item meta
    let mut snapshot = SessionSnapshot {
        r#ref: r#ref.clone(),
        workspace: WorkspaceRef {
            workspace_id: r#ref.workspace_id.clone(),
            path: String::new(),
            display_name: None,
        },
        title: state.title.clone(),
        status: state.status,
        updated_at: timestamp.to_string(),
        archived_at: None,
        preview: None,
        config: Some(state.config.clone()),
        usage: state.usage.clone(),
        facet: state.facet.clone(),
        permission_monitor: state.permission_monitor,
        adventurous_handoff: state.adventurous_handoff,
        notification_autodrain: state.notification_autodrain,
        active_plan: state.active_plan.clone(),
        goal: None,
        flags: Some(state.flags.clone()),
        todos: Some(state.todos.clone()),
        mcp_servers: Some(state.mcp_servers.clone()),
        queued_messages: Some(state.queued.clone()),
        running_run_id: None,
    };

    // goal: only set if non-null
    if let Some(Some(g)) = &state.goal {
        snapshot.goal = Some(Some(g.clone()));
    }

    events.push(SessionDriverEvent::SessionOpened {
        base: SessionEventBase {
            session_ref: r#ref.clone(),
            timestamp: timestamp.to_string(),
            run_id: None,
        },
        snapshot,
    });

    // Ambient statuses
    for (key, text) in &state.ambient.statuses {
        events.push(SessionDriverEvent::HostUiRequest {
            base: SessionEventBase {
                session_ref: r#ref.clone(),
                timestamp: timestamp.to_string(),
                run_id: None,
            },
            request: HostUiRequest::Status {
                request_id: format!("meta-status-{key}"),
                key: key.clone(),
                text: Some(text.clone()),
            },
        });
    }

    // Ambient widgets
    for w in state.ambient.widgets.values() {
        events.push(SessionDriverEvent::HostUiRequest {
            base: SessionEventBase {
                session_ref: r#ref.clone(),
                timestamp: timestamp.to_string(),
                run_id: None,
            },
            request: HostUiRequest::Widget {
                request_id: format!("meta-widget-{}", w.key),
                key: w.key.clone(),
                lines: Some(w.lines.clone()),
                placement: Some(match w.placement {
                    pilot_protocol::state::AmbientPlacement::AboveComposer => {
                        pilot_protocol::session_driver::WidgetPlacement::AboveComposer
                    }
                    pilot_protocol::state::AmbientPlacement::BelowComposer => {
                        pilot_protocol::session_driver::WidgetPlacement::BelowComposer
                    }
                }),
            },
        });
    }

    // Ambient title
    if let Some(title) = &state.ambient.title {
        events.push(SessionDriverEvent::HostUiRequest {
            base: SessionEventBase {
                session_ref: r#ref.clone(),
                timestamp: timestamp.to_string(),
                run_id: None,
            },
            request: HostUiRequest::Title {
                request_id: "meta-title".to_string(),
                title: title.clone(),
            },
        });
    }

    // Pending approvals
    for req in &state.pending_approvals {
        events.push(SessionDriverEvent::HostUiRequest {
            base: SessionEventBase {
                session_ref: r#ref.clone(),
                timestamp: timestamp.to_string(),
                run_id: None,
            },
            request: req.clone(),
        });
    }

    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use pilot_protocol::session_driver::{
        AssistantDeltaChannel, SessionDriverEvent as E, SessionEventBase, SessionRef,
        SessionSnapshot, SessionStatus, SessionUsage, WorkspaceRef,
    };
    use pilot_protocol::state::fold_all;

    fn sref() -> SessionRef {
        SessionRef {
            workspace_id: "ws".into(),
            session_id: "s1".into(),
        }
    }

    fn base() -> SessionEventBase {
        SessionEventBase {
            session_ref: sref(),
            timestamp: "t".into(),
            run_id: None,
        }
    }

    fn user_msg(id: &str, text: &str) -> E {
        E::UserMessage {
            base: base(),
            id: id.into(),
            text: text.into(),
            images: None,
            entry_id: None,
        }
    }

    fn assistant_delta(text: &str) -> E {
        E::AssistantDelta {
            base: base(),
            text: text.into(),
            channel: Some(AssistantDeltaChannel::Text),
            entry_id: None,
        }
    }

    fn snapshot() -> SessionSnapshot {
        SessionSnapshot {
            r#ref: sref(),
            workspace: WorkspaceRef {
                workspace_id: "ws".into(),
                path: "/home".into(),
                display_name: None,
            },
            title: "Test".into(),
            status: SessionStatus::Idle,
            updated_at: "t".into(),
            archived_at: None,
            preview: None,
            config: None,
            usage: None,
            running_run_id: None,
            queued_messages: None,
            facet: None,
            permission_monitor: None,
            adventurous_handoff: None,
            notification_autodrain: None,
            active_plan: None,
            goal: None,
            flags: None,
            todos: None,
            mcp_servers: None,
        }
    }

    #[test]
    fn create_journal_seeds_compacted() {
        let seed = vec![
            E::SessionOpened {
                base: base(),
                snapshot: snapshot(),
            },
            user_msg("u1", "hello"),
        ];
        let j = create_journal(1, &seed);
        assert_eq!(j.epoch, 1);
        assert_eq!(j.seq, 0);
        assert_eq!(j.compacted.len(), 2);
        assert!(j.tail.is_empty());
    }

    #[test]
    fn append_event_stamps_seq() {
        let mut j = create_journal(1, &[]);
        let seq1 = append_event(&mut j, user_msg("u1", "one"));
        let seq2 = append_event(&mut j, user_msg("u2", "two"));
        assert_eq!(seq1, 1);
        assert_eq!(seq2, 2);
        assert_eq!(j.seq, 2);
        assert_eq!(j.tail.len(), 2);
    }

    #[test]
    fn tail_covers_current() {
        let mut j = create_journal(1, &[]);
        append_event(&mut j, user_msg("u1", "one"));
        assert!(tail_covers(&j, j.seq)); // already current
    }

    #[test]
    fn tail_covers_gap() {
        let mut j = create_journal(1, &[]);
        append_event(&mut j, user_msg("u1", "one"));
        let held = j.seq;
        append_event(&mut j, user_msg("u2", "two"));
        append_event(&mut j, user_msg("u3", "three"));
        // Client held at seq=1, tail starts at seq=1, so seq+1=2 is the gap start
        assert!(tail_covers(&j, held));
    }

    #[test]
    fn tail_covers_false_for_future() {
        let mut j = create_journal(1, &[]);
        append_event(&mut j, user_msg("u1", "one"));
        assert!(!tail_covers(&j, 999));
    }

    #[test]
    fn tail_covers_false_when_evicted() {
        let mut j = create_journal(1, &[]);
        append_event(&mut j, user_msg("u1", "one"));
        let held = j.seq;
        // Overflow the ring (TAIL_MAX_FRAMES = 1024)
        for i in 0..1100 {
            append_event(&mut j, user_msg(&format!("bulk-{i}"), "x"));
        }
        // The held seq is now in compacted, not tail
        assert!(!tail_covers(&j, held));
    }

    #[test]
    fn build_seed_reconstructs_all_events() {
        let seed = vec![E::SessionOpened {
            base: base(),
            snapshot: snapshot(),
        }];
        let mut j = create_journal(1, &seed);
        append_event(&mut j, user_msg("u1", "one"));
        append_event(&mut j, user_msg("u2", "two"));

        let (epoch, seq, events) = build_seed(&j);
        assert_eq!(epoch, 1);
        assert_eq!(seq, 2);
        // sessionOpened + 2 user messages = 3 events
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn build_seed_coalesces_assistant_deltas() {
        let mut j = create_journal(1, &[]);
        append_event(&mut j, assistant_delta("Hello "));
        append_event(&mut j, assistant_delta("world"));

        let (_, _, events) = build_seed(&j);
        // Two deltas should coalesce into one
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn try_merge_assistant_deltas_same_channel() {
        let a = assistant_delta("Hello ");
        let b = assistant_delta("world");
        let merged = try_merge(&a, &b).unwrap();
        match merged {
            E::AssistantDelta { text, .. } => assert_eq!(text, "Hello world"),
            _ => panic!("expected AssistantDelta"),
        }
    }

    #[test]
    fn try_merge_assistant_deltas_different_channel_returns_none() {
        let a = E::AssistantDelta {
            base: base(),
            text: "thinking".into(),
            channel: Some(AssistantDeltaChannel::Thinking),
            entry_id: None,
        };
        let b = assistant_delta("answer");
        assert!(try_merge(&a, &b).is_none());
    }

    #[test]
    fn try_merge_usage_updated_keeps_later() {
        let usage1 = SessionUsage {
            tokens: Some(100),
            context_window: 200000,
            percent: Some(0.05),
        };
        let usage2 = SessionUsage {
            tokens: Some(500),
            context_window: 200000,
            percent: Some(0.25),
        };
        let a = E::UsageUpdated {
            base: base(),
            usage: usage1,
        };
        let b = E::UsageUpdated {
            base: base(),
            usage: usage2.clone(),
        };
        let merged = try_merge(&a, &b).unwrap();
        match merged {
            E::UsageUpdated { usage, .. } => assert_eq!(usage.tokens, Some(500)),
            _ => panic!("expected UsageUpdated"),
        }
    }

    #[test]
    fn try_merge_different_types_returns_none() {
        let a = user_msg("u1", "hello");
        let b = assistant_delta("hi");
        assert!(try_merge(&a, &b).is_none());
    }

    #[test]
    fn bump_epoch_resets_journal() {
        let mut j = create_journal(
            1,
            &[E::SessionOpened {
                base: base(),
                snapshot: snapshot(),
            }],
        );
        append_event(&mut j, user_msg("u1", "one"));
        assert_eq!(j.seq, 1);

        bump_epoch(&mut j, 2, &[user_msg("fresh", "new seed")]);
        assert_eq!(j.epoch, 2);
        assert_eq!(j.seq, 0);
        assert!(j.tail.is_empty());
    }

    #[test]
    fn coalesce_events_collapses_deltas() {
        let events = vec![
            assistant_delta("Hello "),
            assistant_delta("world"),
            user_msg("u1", "hi"),
            assistant_delta("Answer"),
        ];
        let coalesced = coalesce_events(&events);
        // First two deltas merge, then user message, then delta = 3 items
        assert_eq!(coalesced.len(), 3);
    }

    #[test]
    fn append_event_evicts_to_compacted_on_overflow() {
        let mut j = create_journal(1, &[]);
        for i in 0..1100 {
            append_event(&mut j, user_msg(&format!("u{i}"), "x"));
        }
        // Tail should be at most TAIL_MAX_FRAMES
        assert!(j.tail.len() <= TAIL_MAX_FRAMES);
        // Compacted should have the overflow
        assert!(!j.compacted.is_empty());
    }

    #[test]
    fn build_seed_fold_invariant_holds() {
        // The core invariant: fold_all(build_seed(j).events) should produce
        // the same state as folding all events individually
        let events = vec![
            E::SessionOpened {
                base: base(),
                snapshot: snapshot(),
            },
            user_msg("u1", "hello"),
            assistant_delta("Hi "),
            assistant_delta("there"),
            E::RunCompleted {
                base: base(),
                snapshot: snapshot(),
                user_entry_id: None,
                assistant_entry_id: None,
            },
        ];
        let j = create_journal(1, &events[..1]); // sessionOpened as seed
        let mut j = j;
        for ev in &events[1..] {
            append_event(&mut j, ev.clone());
        }

        let (_, _, seed_events) = build_seed(&j);
        let folded_from_seed = fold_all(&seed_events);
        let folded_direct = fold_all(&events);
        // The folded states should match (items count at least)
        assert_eq!(folded_from_seed.items.len(), folded_direct.items.len());
    }

    #[test]
    fn meta_seed_events_preserves_non_item_state() {
        use pilot_protocol::state::{fold_all, initial_session_state};

        // Build a state with ambient + pending approvals
        let mut state = initial_session_state();
        state.title = "My Session".into();
        state.facet = Some("plan".into());
        state
            .ambient
            .statuses
            .insert("build".into(), "compiling...".into());
        state.ambient.title = Some("Custom Title".into());
        state
            .pending_approvals
            .push(pilot_protocol::session_driver::HostUiRequest::Confirm {
                request_id: "r1".into(),
                title: "Confirm?".into(),
                message: "Sure?".into(),
                default_value: None,
                timeout_ms: None,
            });

        let events = meta_seed_events(&state, &sref(), "meta-ts");
        let folded = fold_all(&events);

        // Title + facet should be preserved
        assert_eq!(folded.title, "My Session");
        assert_eq!(folded.facet, Some("plan".to_string()));
        // Ambient status should be preserved
        assert_eq!(
            folded.ambient.statuses.get("build"),
            Some(&"compiling...".to_string())
        );
        // Ambient title should be preserved
        assert_eq!(folded.ambient.title, Some("Custom Title".to_string()));
        // Pending approval should be preserved
        assert_eq!(folded.pending_approvals.len(), 1);
        // Items should be empty (meta seed carries no transcript items)
        assert!(folded.items.is_empty());
    }
}
