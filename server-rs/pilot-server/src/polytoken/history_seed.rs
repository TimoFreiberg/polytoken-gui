//! Folding polytoken's `GET /history` items into pilot's `SessionDriverEvent[]` —
//! the REPLAY/seed path (the inverse of event-map.rs's live stream fold).
//!
//! Port of `server/src/polytoken/history-seed.ts` (316 LOC).
//!
//! `openSession`/`reloadSession` spawn a daemon and must deliver the session's
//! existing transcript to the hub atomically: a `sessionOpened` snapshot + the
//! replayed history, so the client renders the full conversation on focus/reload
//! (the hub resets + folds these, never via `subscribe`).
//!
//! polytoken's history is a linear event log (no branch DAG), and
//! `KnownSessionHistoryItem` is a tagged union on `type`. The renderable kinds for
//! a transcript are: `user` (content + prompt_id), `assistant` (blocks[] +
//! prompt_id), and `tool_result` (call_id + content + is_error + prompt_id).
//! Others (session_lifecycle, model_switch, state_update, facet_switch,
//! compaction_fencepost, system_reminder, classifier_decision, context_cleared,
//! image_reference) are metadata, not transcript rows — they're skipped on the
//! replay path exactly as the live event-fold skips or handles them ambiently.
//!
//! This mirrors the original driver's historyToEvents: a pure function over a typed input, so it's
//! unit-testable without a daemon. Tool input comes from the assistant's
//! `tool_use` blocks (not a separate tool_call event in history), so we emit
//! `toolStarted` inline as we walk the assistant blocks, then pair the later
//! `tool_result` by `call_id`.
//!
//! NOTE: `KnownSessionHistoryItem` / `SessionHistoryItem` are `serde_json::Value`
//! aliases in `pilot_daemon_types` (the daemon's schema is self-describing JSON),
//! so — like the TS, which treats items as `Record<string, unknown>` — we parse the
//! fields defensively by key. Unknown variants (future daemon kinds) are skipped,
//! never crashing the seed.

use pilot_daemon_types::SessionHistoryItem;
use pilot_protocol::session_driver::{
    AssistantDeltaChannel, ImageContent, SessionConfig, SessionDriverEvent, SessionEventBase,
    SessionRef, SessionSnapshot, SessionStatus, WorkspaceRef,
};
use serde_json::Value;

use crate::polytoken::models::default_model_ref;

// ---------------------------------------------------------------------------
// PLAN_REVIEW_LABELS — the snake_case reason.type → human label map.
// Mirrors `PLAN_REVIEW_LABELS` in event-map.ts (and the `plan_review_label`
// helper in event_map.rs, which keys on the typed SystemReminderReason enum).
// Kept local here because history items are untyped JSON, so we key on the raw
// string discriminator exactly as the TS does.
// ---------------------------------------------------------------------------
fn plan_review_label(reason_type: &str) -> Option<&'static str> {
    match reason_type {
        "plan_review_required" => Some("Plan review required"),
        "plan_mode_reinforcement" => Some("Plan mode reminder"),
        "plan_verification" => Some("Plan verification"),
        _ => None,
    }
}

/// The extracted output + optional images from a tool_result's `content`.
/// Mirrors the TS `liftToolResult` return shape.
struct LiftedToolResult {
    output: Option<Value>,
    images: Option<Vec<ImageContent>>,
    success: bool,
}

/// Lift image content from a tool_result's `content` (ToolResultContent has three
/// variants: {text}, {blocks}, {image}). Reuses the live path's extractToolResult
/// shape so the reloaded tool card matches the live one.
///
/// `content` is the daemon's `ToolResultContent` (= `serde_json::Value`). `is_error`
/// drives the `success` flag.
fn lift_tool_result(content: Option<&Value>, is_error: Option<bool>) -> LiftedToolResult {
    let success = !is_error.unwrap_or(false);
    let Some(content) = content else {
        return LiftedToolResult {
            output: None,
            images: None,
            success,
        };
    };
    let Some(obj) = content.as_object() else {
        return LiftedToolResult {
            output: None,
            images: None,
            success,
        };
    };

    // Image variant: {image: {data, media_type, text_fallback}}
    if let Some(img) = obj.get("image").and_then(|v| v.as_object()) {
        let data = img.get("data").and_then(|v| v.as_str());
        let media_type = img.get("media_type").and_then(|v| v.as_str());
        if let (Some(data), Some(media_type)) = (data, media_type) {
            let text_fallback = img.get("text_fallback").and_then(|v| v.as_str());
            return LiftedToolResult {
                output: Some(Value::String(text_fallback.unwrap_or("").to_string())),
                images: Some(vec![ImageContent::Image {
                    data: data.to_string(),
                    mime_type: media_type.to_string(),
                }]),
                success,
            };
        }
    }

    // Text variant: {text: string}
    if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
        return LiftedToolResult {
            output: Some(Value::String(text.to_string())),
            images: None,
            success,
        };
    }

    // Blocks variant: {blocks: ContentBlock[]} — join text blocks
    if let Some(blocks) = obj.get("blocks").and_then(|v| v.as_array()) {
        let text = blocks
            .iter()
            .filter_map(|b| {
                let is_text = b
                    .as_object()
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str())
                    == Some("text");
                if is_text {
                    b.as_object()
                        .and_then(|o| o.get("text"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<String>();
        return LiftedToolResult {
            output: Some(Value::String(text)),
            images: None,
            success,
        };
    }

    LiftedToolResult {
        output: None,
        images: None,
        success,
    }
}

/// Context for [`history_to_seed_events`]. Carries the session ref to stamp onto
/// every emitted event (mirrors the TS `HistoryMapCtx`).
pub struct HistoryMapCtx {
    pub r#ref: SessionRef,
}

/// Fold `GET /history` items into `SessionDriverEvent[]`. Pure — no I/O, no daemon.
/// Items are rendered in order; `assistant` blocks emit `assistantDelta` (text +
/// thinking) and `toolStarted` (tool_use) inline, and a later `tool_result` pairs
/// by `call_id`. Non-transcript kinds (lifecycle, model_switch, …) are skipped or
/// mapped to the same driver events the live path emits.
///
/// Mirrors `historyToSeedEvents` in history-seed.ts.
pub fn history_to_seed_events(
    items: &[SessionHistoryItem],
    ctx: &HistoryMapCtx,
) -> Vec<SessionDriverEvent> {
    if items.is_empty() {
        return Vec::new();
    }
    let ref_ = &ctx.r#ref;
    let mut out: Vec<SessionDriverEvent> = Vec::new();
    let mut seq: usize = 0;

    // Per-item timestamp. As of daemon 0.4.0-unstable.6+, ALL 12 history kinds carry
    // `emitted_at` on the wire — but with a required/optional split (confirmed against
    // the .7 OpenAPI dump, KnownSessionHistoryItem):
    //   * REQUIRED (always present): session_lifecycle, state_update, model_switch,
    //     compaction_fencepost, system_reminder, classifier_decision, context_cleared,
    //     image_reference.
    //   * OPTIONAL (nullable): user, assistant, tool_result, facet_switch — these
    //     gained `emitted_at` in unstable.6 but the schema marks it optional, so a
    //     session recorded before .6 (or any item the daemon leaves unstamped) can
    //     still arrive without it.
    // We therefore always prefer the real `emitted_at` (schema-agnostic read below);
    // the synthetic fallback only fires for an optional-kind item that genuinely lacks
    // one (pre-.6 replay). It is a deterministic monotonic ISO stamp (epoch-anchored,
    // advancing per item) so the client's relative-time display gets a valid Date
    // instead of an Invalid Date. The absolute value is wrong (epoch), but it's never
    // shown as wall-clock — only as ordering within the replayed transcript, which seq
    // preserves. Do NOT delete the fallback: the 4 optional kinds keep it reachable.
    //
    // `new Date(i * 1000).toISOString()` → seconds-since-epoch → ISO 8601 UTC.
    // We format manually to avoid pulling in chrono just for this synthetic stamp.
    let ts = |item: &Value, i: usize| -> String {
        if let Some(emitted) = item.get("emitted_at").and_then(|v| v.as_str()) {
            return emitted.to_string();
        }
        // i * 1000 ms since epoch → synthetic ISO timestamp.
        let secs = (i as u64).saturating_mul(1000);
        format_synthetic_iso(secs)
    };

    for (i, item) in items.iter().enumerate() {
        let Some(item_type) = item.get("type").and_then(|v| v.as_str()) else {
            continue;
        };

        match item_type {
            "user" => {
                let content = item.get("content");
                let prompt_id = item.get("prompt_id").and_then(|v| v.as_str());
                // The daemon's prompt_id IS the branch handle (POST /rewind's
                // to_prompt_id). Thread it as both id (for client reconciliation) and
                // entryId (the branch button's target). Falls back to a synthetic id
                // only for malformed items lacking one (defensive — the wire schema
                // guarantees prompt_id on `user` items).
                let (id, entry_id) = match prompt_id {
                    Some(pid) => (pid.to_string(), Some(pid.to_string())),
                    None => {
                        let s = format!("u-{}", seq);
                        seq += 1;
                        (s, None)
                    }
                };
                let text = content.and_then(|v| v.as_str()).unwrap_or("");
                out.push(SessionDriverEvent::UserMessage {
                    base: SessionEventBase {
                        session_ref: ref_.clone(),
                        timestamp: ts(item, i),
                        run_id: None,
                    },
                    id,
                    text: text.to_string(),
                    images: None,
                    entry_id,
                });
            }
            "assistant" => {
                let Some(blocks) = item.get("blocks").and_then(|v| v.as_array()) else {
                    continue;
                };
                // The assistant message's prompt_id: same per-turn id as the preceding
                // `user` item (the daemon assigns one prompt_id per user turn, and the
                // assistant reply carries it). Thread it as the branch handle for
                // "branch from here" on the assistant turn.
                let prompt_id = item.get("prompt_id").and_then(|v| v.as_str());
                for b in blocks {
                    let Some(block_type) = b.get("type").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let stamp = ts(item, i);
                    match block_type {
                        "text" => {
                            let text = b.get("text").and_then(|v| v.as_str()).unwrap_or("");
                            out.push(SessionDriverEvent::AssistantDelta {
                                base: SessionEventBase {
                                    session_ref: ref_.clone(),
                                    timestamp: stamp,
                                    run_id: None,
                                },
                                text: text.to_string(),
                                channel: Some(AssistantDeltaChannel::Text),
                                entry_id: prompt_id.map(|s| s.to_string()),
                            });
                        }
                        "thinking" => {
                            let text = b.get("text").and_then(|v| v.as_str()).unwrap_or("");
                            out.push(SessionDriverEvent::AssistantDelta {
                                base: SessionEventBase {
                                    session_ref: ref_.clone(),
                                    timestamp: stamp,
                                    run_id: None,
                                },
                                text: text.to_string(),
                                channel: Some(AssistantDeltaChannel::Thinking),
                                entry_id: prompt_id.map(|s| s.to_string()),
                            });
                        }
                        "tool_use" => {
                            let id = b
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = b
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let input = b.get("input").cloned();
                            out.push(SessionDriverEvent::ToolStarted {
                                base: SessionEventBase {
                                    session_ref: ref_.clone(),
                                    timestamp: stamp,
                                    run_id: None,
                                },
                                tool_name: name,
                                call_id: id,
                                input,
                                label: None,
                                description: None,
                            });
                        }
                        // redacted_thinking / open_ai_reasoning_opaque: no transcript text (skip).
                        _ => {}
                    }
                }
            }
            "tool_result" => {
                let call_id = item
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_error = item.get("is_error").and_then(|v| v.as_bool());
                let lifted = lift_tool_result(item.get("content"), is_error);
                out.push(SessionDriverEvent::ToolFinished {
                    base: SessionEventBase {
                        session_ref: ref_.clone(),
                        timestamp: ts(item, i),
                        run_id: None,
                    },
                    call_id,
                    success: lifted.success,
                    output: lifted.output,
                    images: lifted.images,
                });
            }
            // Non-transcript history kinds: mapped to the same driver events the live
            // path emits, so a reloaded transcript matches what a live session would show.
            "system_reminder" => {
                let reason_type = item
                    .get("reason")
                    .and_then(|v| v.as_object())
                    .and_then(|o| o.get("type"))
                    .and_then(|v| v.as_str());
                let label = reason_type.and_then(plan_review_label);
                let visible = label.is_some();
                let slug = item
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .unwrap_or("reminder");
                let custom_type = match label {
                    Some(l) => l.to_string(),
                    None => slug.to_string(),
                };
                let text = item
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                out.push(SessionDriverEvent::CustomMessage {
                    base: SessionEventBase {
                        session_ref: ref_.clone(),
                        timestamp: ts(item, i),
                        run_id: None,
                    },
                    id: format!("reminder-{}-{}", slug, i),
                    custom_type,
                    text,
                    display: visible,
                });
            }
            "model_switch" => {
                // Thread the model config like the live model_switch event does.
                let to_model = item.get("to_model").and_then(|v| v.as_str());
                if let Some(to_model) = to_model {
                    let mr = default_model_ref(to_model);
                    let thinking_level = item
                        .get("to_reasoning_effort")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let config = SessionConfig {
                        provider: Some(mr.provider),
                        model_id: Some(mr.model_id),
                        thinking_level,
                        available_thinking_levels: None,
                    };
                    let stamp = ts(item, i);
                    out.push(SessionDriverEvent::SessionUpdated {
                        base: SessionEventBase {
                            session_ref: ref_.clone(),
                            timestamp: stamp.clone(),
                            run_id: None,
                        },
                        snapshot: SessionSnapshot {
                            r#ref: ref_.clone(),
                            workspace: WorkspaceRef {
                                workspace_id: ref_.workspace_id.clone(),
                                path: String::new(),
                                display_name: None,
                            },
                            title: String::new(),
                            status: SessionStatus::Idle,
                            updated_at: stamp,
                            archived_at: None,
                            preview: None,
                            config: Some(config),
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
                        },
                    });
                }
            }
            "facet_switch" => {
                let to_facet = item.get("to_facet").and_then(|v| v.as_str());
                if let Some(to_facet) = to_facet {
                    let stamp = ts(item, i);
                    out.push(SessionDriverEvent::SessionUpdated {
                        base: SessionEventBase {
                            session_ref: ref_.clone(),
                            timestamp: stamp.clone(),
                            run_id: None,
                        },
                        snapshot: SessionSnapshot {
                            r#ref: ref_.clone(),
                            workspace: WorkspaceRef {
                                workspace_id: ref_.workspace_id.clone(),
                                path: String::new(),
                                display_name: None,
                            },
                            title: String::new(),
                            status: SessionStatus::Idle,
                            updated_at: stamp,
                            archived_at: None,
                            preview: None,
                            config: None,
                            usage: None,
                            running_run_id: None,
                            queued_messages: None,
                            facet: Some(to_facet.to_string()),
                            permission_monitor: None,
                            adventurous_handoff: None,
                            notification_autodrain: None,
                            active_plan: None,
                            goal: None,
                            flags: None,
                            todos: None,
                            mcp_servers: None,
                        },
                    });
                }
            }
            "compaction_fencepost" => {
                let compaction_id = item.get("compaction_id").and_then(|v| v.as_str());
                let id_suffix = match compaction_id {
                    Some(cid) => cid.to_string(),
                    None => {
                        let s = seq.to_string();
                        seq += 1;
                        s
                    }
                };
                let text = item
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Context compacted")
                    .to_string();
                out.push(SessionDriverEvent::CustomMessage {
                    base: SessionEventBase {
                        session_ref: ref_.clone(),
                        timestamp: ts(item, i),
                        run_id: None,
                    },
                    id: format!("compaction-{}-{}", id_suffix, i),
                    custom_type: "compaction".to_string(),
                    text,
                    display: true,
                });
            }
            "context_cleared" => {
                out.push(SessionDriverEvent::CustomMessage {
                    base: SessionEventBase {
                        session_ref: ref_.clone(),
                        timestamp: ts(item, i),
                        run_id: None,
                    },
                    id: format!("context-cleared-{}", i),
                    custom_type: "context-cleared".to_string(),
                    text: "Context cleared".to_string(),
                    display: true,
                });
            }
            "session_lifecycle" => {
                // A lifecycle event (session started/ended etc). Surface as a non-display
                // turn-boundary marker (same as the live path's customMessage with
                // display:false — it splits the turn without rendering a visible row).
                let text = item
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                out.push(SessionDriverEvent::CustomMessage {
                    base: SessionEventBase {
                        session_ref: ref_.clone(),
                        timestamp: ts(item, i),
                        run_id: None,
                    },
                    id: format!("lifecycle-{}", i),
                    custom_type: "lifecycle".to_string(),
                    text,
                    display: false,
                });
            }
            // state_update, classifier_decision, image_reference: no transcript
            // representation in the live path either — skip (they're metadata-only).
            _ => {}
        }
    }
    out
}

/// Format a millisecond-since-epoch value as an ISO 8601 UTC timestamp,
/// mirroring `new Date(ms).toISOString()` (e.g. `1970-01-01T00:00:01.000Z`).
///
/// Used only for the synthetic fallback timestamp on transcript-rendering history
/// items (user/assistant/tool_result) that lack `emitted_at`. The absolute value is
/// never shown as wall-clock — only as ordering within the replayed transcript.
fn format_synthetic_iso(ms: u64) -> String {
    let total_secs = ms / 1000;
    let millis = ms % 1000;

    // Days since epoch + time-of-day.
    let days = total_secs / 86_400;
    let rem = total_secs % 86_400;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    let (year, month, day) = civil_from_days(days as i64);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

/// Convert a count of days since the Unix epoch (1970-01-01) into a proleptic
/// Gregorian (year, month, day). Algorithm: Howard Hinnant's `days_from_civil`
/// inverse, which is the standard days-to-date transform used by libc++ and is
/// valid for any non-negative day count.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Shift epoch from 1970-03-01 would require an offset; Hinnant's algorithm
    // uses 0000-03-01 as the era boundary. `z` is days since 0000-03-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx() -> HistoryMapCtx {
        HistoryMapCtx {
            r#ref: SessionRef {
                workspace_id: "ws".to_string(),
                session_id: "s1".to_string(),
            },
        }
    }

    #[test]
    fn empty_input_returns_empty() {
        assert!(history_to_seed_events(&[], &ctx()).is_empty());
    }

    #[test]
    fn user_message_with_prompt_id() {
        let items = vec![json!({
            "type": "user",
            "content": "hello",
            "prompt_id": "p1",
        })];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 1);
        match &out[0] {
            SessionDriverEvent::UserMessage {
                id, text, entry_id, ..
            } => {
                assert_eq!(id, "p1");
                assert_eq!(text, "hello");
                assert_eq!(entry_id.as_deref(), Some("p1"));
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }
    }

    #[test]
    fn user_message_without_prompt_id_uses_synthetic_id() {
        let items = vec![json!({ "type": "user", "content": "hi" })];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 1);
        match &out[0] {
            SessionDriverEvent::UserMessage { id, entry_id, .. } => {
                assert_eq!(id, "u-0");
                assert!(entry_id.is_none());
            }
            other => panic!("expected UserMessage, got {:?}", other),
        }
    }

    #[test]
    fn assistant_text_and_tool_use() {
        let items = vec![json!({
            "type": "assistant",
            "prompt_id": "p1",
            "blocks": [
                { "type": "text", "text": "thinking..." },
                { "type": "tool_use", "id": "call_1", "name": "Bash", "input": { "cmd": "ls" } },
            ],
        })];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 2);
        match &out[0] {
            SessionDriverEvent::AssistantDelta {
                text,
                channel,
                entry_id,
                ..
            } => {
                assert_eq!(text, "thinking...");
                assert_eq!(*channel.as_ref().unwrap(), AssistantDeltaChannel::Text);
                assert_eq!(entry_id.as_deref(), Some("p1"));
            }
            other => panic!("expected AssistantDelta, got {:?}", other),
        }
        match &out[1] {
            SessionDriverEvent::ToolStarted {
                call_id,
                tool_name,
                input,
                ..
            } => {
                assert_eq!(call_id, "call_1");
                assert_eq!(tool_name, "Bash");
                assert_eq!(input.as_ref().unwrap(), &json!({ "cmd": "ls" }));
            }
            other => panic!("expected ToolStarted, got {:?}", other),
        }
    }

    #[test]
    fn assistant_thinking_channel() {
        let items = vec![json!({
            "type": "assistant",
            "blocks": [ { "type": "thinking", "text": "hmm", "signature": "s" } ],
        })];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 1);
        match &out[0] {
            SessionDriverEvent::AssistantDelta { channel, text, .. } => {
                assert_eq!(*channel.as_ref().unwrap(), AssistantDeltaChannel::Thinking);
                assert_eq!(text, "hmm");
            }
            other => panic!("expected AssistantDelta(thinking), got {:?}", other),
        }
    }

    #[test]
    fn tool_result_text_variant() {
        let items = vec![json!({
            "type": "tool_result",
            "call_id": "c1",
            "content": { "text": "ok" },
            "is_error": false,
        })];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 1);
        match &out[0] {
            SessionDriverEvent::ToolFinished {
                call_id,
                success,
                output,
                images,
                ..
            } => {
                assert_eq!(call_id, "c1");
                assert!(*success);
                assert_eq!(output.as_ref().unwrap(), &json!("ok"));
                assert!(images.is_none());
            }
            other => panic!("expected ToolFinished, got {:?}", other),
        }
    }

    #[test]
    fn tool_result_image_variant() {
        let items = vec![json!({
            "type": "tool_result",
            "call_id": "c1",
            "content": { "image": { "data": "BASE64", "media_type": "image/png", "text_fallback": "alt" } },
            "is_error": true,
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::ToolFinished {
                success,
                output,
                images,
                ..
            } => {
                assert!(!*success);
                assert_eq!(output.as_ref().unwrap(), &json!("alt"));
                let imgs = images.as_ref().unwrap();
                assert_eq!(imgs.len(), 1);
            }
            other => panic!("expected ToolFinished, got {:?}", other),
        }
    }

    #[test]
    fn tool_result_blocks_variant_joins_text() {
        let items = vec![json!({
            "type": "tool_result",
            "call_id": "c1",
            "content": { "blocks": [
                { "type": "text", "text": "foo" },
                { "type": "tool_use", "input": {} },
                { "type": "text", "text": "bar" },
            ] },
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::ToolFinished { output, .. } => {
                assert_eq!(output.as_ref().unwrap(), &json!("foobar"));
            }
            other => panic!("expected ToolFinished, got {:?}", other),
        }
    }

    #[test]
    fn system_reminder_visible_label() {
        let items = vec![json!({
            "type": "system_reminder",
            "emitted_at": "2025-01-01T00:00:00.000Z",
            "reason": { "type": "plan_review_required" },
            "slug": "x",
            "body": "review needed",
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::CustomMessage {
                custom_type,
                text,
                display,
                ..
            } => {
                assert_eq!(*custom_type, "Plan review required");
                assert_eq!(text, "review needed");
                assert!(*display);
            }
            other => panic!("expected CustomMessage, got {:?}", other),
        }
    }

    #[test]
    fn system_reminder_unknown_reason_falls_back_to_slug() {
        let items = vec![json!({
            "type": "system_reminder",
            "reason": { "type": "something_else" },
            "body": "b",
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::CustomMessage {
                custom_type,
                display,
                ..
            } => {
                assert_eq!(*custom_type, "reminder"); // slug defaults to "reminder"
                assert!(!*display);
            }
            other => panic!("expected CustomMessage, got {:?}", other),
        }
    }

    #[test]
    fn model_switch_emits_session_updated() {
        let items = vec![json!({
            "type": "model_switch",
            "emitted_at": "2025-01-01T00:00:00.000Z",
            "to_model": "deepseek/deepseek-v4-pro",
            "to_reasoning_effort": "high",
        })];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 1);
        match &out[0] {
            SessionDriverEvent::SessionUpdated { snapshot, .. } => {
                let cfg = snapshot.config.as_ref().unwrap();
                assert_eq!(cfg.provider.as_deref(), Some("deepseek"));
                assert_eq!(cfg.model_id.as_deref(), Some("deepseek/deepseek-v4-pro"));
                assert_eq!(cfg.thinking_level.as_deref(), Some("high"));
            }
            other => panic!("expected SessionUpdated, got {:?}", other),
        }
    }

    #[test]
    fn model_switch_without_to_model_is_skipped() {
        let items = vec![json!({ "type": "model_switch" })];
        assert!(history_to_seed_events(&items, &ctx()).is_empty());
    }

    #[test]
    fn facet_switch_emits_session_updated_with_facet() {
        let items = vec![json!({
            "type": "facet_switch",
            "emitted_at": "2025-01-01T00:00:00.000Z",
            "to_facet": "plan",
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::SessionUpdated { snapshot, .. } => {
                assert_eq!(snapshot.facet.as_deref(), Some("plan"));
            }
            other => panic!("expected SessionUpdated, got {:?}", other),
        }
    }

    #[test]
    fn compaction_fencepost() {
        let items = vec![json!({
            "type": "compaction_fencepost",
            "emitted_at": "2025-01-01T00:00:00.000Z",
            "compaction_id": "c9",
            "summary": "compacted!",
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::CustomMessage {
                id,
                custom_type,
                text,
                display,
                ..
            } => {
                assert_eq!(id, "compaction-c9-0");
                assert_eq!(*custom_type, "compaction");
                assert_eq!(text, "compacted!");
                assert!(*display);
            }
            other => panic!("expected CustomMessage, got {:?}", other),
        }
    }

    #[test]
    fn compaction_fencepost_without_id_uses_seq() {
        let items = vec![json!({
            "type": "compaction_fencepost",
            "summary": "s",
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::CustomMessage { id, text, .. } => {
                assert_eq!(id, "compaction-0-0");
                assert_eq!(text, "s");
            }
            other => panic!("expected CustomMessage, got {:?}", other),
        }
    }

    #[test]
    fn context_cleared() {
        let items = vec![json!({
            "type": "context_cleared",
            "emitted_at": "2025-01-01T00:00:00.000Z",
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::CustomMessage {
                id,
                custom_type,
                text,
                display,
                ..
            } => {
                assert_eq!(id, "context-cleared-0");
                assert_eq!(*custom_type, "context-cleared");
                assert_eq!(text, "Context cleared");
                assert!(*display);
            }
            other => panic!("expected CustomMessage, got {:?}", other),
        }
    }

    #[test]
    fn session_lifecycle_non_display() {
        let items = vec![json!({
            "type": "session_lifecycle",
            "emitted_at": "2025-01-01T00:00:00.000Z",
            "text": "started",
        })];
        let out = history_to_seed_events(&items, &ctx());
        match &out[0] {
            SessionDriverEvent::CustomMessage {
                id,
                custom_type,
                text,
                display,
                ..
            } => {
                assert_eq!(id, "lifecycle-0");
                assert_eq!(*custom_type, "lifecycle");
                assert_eq!(text, "started");
                assert!(!*display);
            }
            other => panic!("expected CustomMessage, got {:?}", other),
        }
    }

    #[test]
    fn unknown_type_is_skipped() {
        let items = vec![
            json!({ "type": "classifier_decision" }),
            json!({ "type": "state_update" }),
        ];
        assert!(history_to_seed_events(&items, &ctx()).is_empty());
    }

    #[test]
    fn missing_type_is_skipped() {
        let items = vec![json!({ "content": "no type" })];
        assert!(history_to_seed_events(&items, &ctx()).is_empty());
    }

    #[test]
    fn synthetic_iso_timestamp_format() {
        // 1000ms = 1 second since epoch → 1970-01-01T00:00:01.000Z
        assert_eq!(format_synthetic_iso(1000), "1970-01-01T00:00:01.000Z");
        // 0ms → epoch
        assert_eq!(format_synthetic_iso(0), "1970-01-01T00:00:00.000Z");
        // 86400000ms = 1 day → 1970-01-02T00:00:00.000Z
        assert_eq!(format_synthetic_iso(86_400_000), "1970-01-02T00:00:00.000Z");
    }

    #[test]
    fn synthetic_iso_non_leap_year_rollover() {
        // 730 days = 2 non-leap years (365*2) → 1972-01-01T00:00:00.000Z
        assert_eq!(
            format_synthetic_iso(730 * 86_400_000),
            "1972-01-01T00:00:00.000Z"
        );
    }

    // --- emitted_at adoption (daemon 0.4.0-unstable.6+, AC.2) ---

    /// Pull the seed event's timestamp regardless of variant.
    fn stamp(ev: &SessionDriverEvent) -> &str {
        match ev {
            SessionDriverEvent::UserMessage { base, .. }
            | SessionDriverEvent::AssistantDelta { base, .. }
            | SessionDriverEvent::ToolStarted { base, .. }
            | SessionDriverEvent::ToolFinished { base, .. }
            | SessionDriverEvent::CustomMessage { base, .. }
            | SessionDriverEvent::SessionUpdated { base, .. } => &base.timestamp,
            other => panic!("unexpected event variant: {:?}", other),
        }
    }

    #[test]
    fn uses_emitted_at_for_schema_supported_kinds() {
        // .7 schema: user/assistant/tool_result carry `emitted_at`. When present, the
        // real value must flow into the seed event timestamp, never the synthetic
        // epoch fallback.
        let real = "2025-03-14T09:26:53.000Z";
        let items = vec![
            json!({ "type": "user", "content": "hi", "prompt_id": "p1", "emitted_at": real }),
            json!({ "type": "assistant", "prompt_id": "p1",
                    "blocks": [ { "type": "text", "text": "yo" } ], "emitted_at": real }),
            json!({ "type": "tool_result", "call_id": "c1",
                    "content": { "text": "ok" }, "is_error": false, "emitted_at": real }),
        ];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 3);
        for ev in &out {
            assert_eq!(
                stamp(ev),
                real,
                "expected real emitted_at, got synthetic fallback"
            );
        }
    }

    #[test]
    fn retains_deterministic_fallback_for_kinds_without_emitted_at() {
        // The optional kinds (user/assistant/tool_result/facet_switch) can arrive
        // without `emitted_at` when replaying a pre-.6 session. The seed must fall
        // back to the deterministic epoch-anchored stamp (index * 1000 ms), not crash
        // or emit an invalid date.
        let items = vec![
            json!({ "type": "user", "content": "a", "prompt_id": "p1" }), // i=0 → epoch
            json!({ "type": "tool_result", "call_id": "c1", "content": { "text": "ok" } }), // i=1 → +1s
        ];
        let out = history_to_seed_events(&items, &ctx());
        assert_eq!(out.len(), 2);
        assert_eq!(stamp(&out[0]), format_synthetic_iso(0).as_str());
        assert_eq!(stamp(&out[1]), format_synthetic_iso(1000).as_str());
    }
}
