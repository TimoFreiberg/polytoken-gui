//! Merge warm in-memory sessions with on-disk session-list entries.
//!
//! Faithful port of `server/src/shared/session-list.ts`.

use std::collections::HashSet;

use pantoken_protocol::session_driver::SessionListEntry;

/// Combine warm (in-memory) and on-disk session entries, deduped by session id.
/// A warm session that's also on disk keeps its richer disk entry; warm-only
/// entries come first.
pub fn merge_session_lists(
    on_disk: &[SessionListEntry],
    warm: &[SessionListEntry],
) -> Vec<SessionListEntry> {
    let on_disk_ids: HashSet<&str> = on_disk
        .iter()
        .map(|entry| entry.session_id.as_str())
        .collect();
    let mut merged: Vec<SessionListEntry> = warm
        .iter()
        .filter(|entry| !on_disk_ids.contains(entry.session_id.as_str()))
        .cloned()
        .collect();
    merged.extend(on_disk.iter().cloned());
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(session_id: &str) -> SessionListEntry {
        entry_with(session_id, "", 0)
    }

    fn entry_with(session_id: &str, preview: &str, user_message_count: i64) -> SessionListEntry {
        SessionListEntry {
            session_id: session_id.to_string(),
            path: format!("/sessions/{session_id}.jsonl"),
            cwd: "/proj".to_string(),
            display_name: None,
            preview: preview.to_string(),
            user_message_count,
            updated_at: "2026-06-18T00:00:00.000Z".to_string(),
            created_at: "2026-06-18T00:00:00.000Z".to_string(),
            last_user_message_at: "2026-06-18T00:00:00.000Z".to_string(),
            parent_session_path: None,
            usage: None,
            archived: false,
            worktree: None,
        }
    }

    #[test]
    fn includes_a_warm_session_that_is_not_on_disk_yet() {
        let on_disk = vec![entry("old")];
        let warm = vec![entry_with("fresh", "warm placeholder", 0)];
        let merged = merge_session_lists(&on_disk, &warm);
        let ids: Vec<&str> = merged
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["fresh", "old"]);
    }

    #[test]
    fn a_warm_session_already_on_disk_keeps_its_richer_disk_entry() {
        let on_disk = vec![entry_with("s1", "real first message", 4)];
        let warm = vec![entry_with("s1", "", 0)];
        let merged = merge_session_lists(&on_disk, &warm);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].preview, "real first message");
        assert_eq!(merged[0].user_message_count, 4);
    }

    #[test]
    fn no_warm_sessions_leaves_the_disk_list_untouched() {
        let on_disk = vec![entry("a"), entry("b")];
        let merged = merge_session_lists(&on_disk, &[]);
        assert_eq!(merged, on_disk);
    }

    #[test]
    fn warm_only_entries_precede_disk_entries() {
        let merged = merge_session_lists(
            &[entry("disk1"), entry("disk2")],
            &[entry("warm1"), entry("warm2")],
        );
        let ids: Vec<&str> = merged
            .iter()
            .map(|entry| entry.session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["warm1", "warm2", "disk1", "disk2"]);
    }
}
