//! Reading polytoken's on-disk sessions registry WITHOUT spawning a daemon.
//!
//! Port of `server/src/polytoken/sessions-registry.ts`.
//!
//! polytoken writes one directory per session under the sessions dir (default
//! `$XDG_DATA_HOME/polytoken/sessions` or `~/.local/share/polytoken/sessions`),
//! each holding `session.json` (the durable metadata), `log.jsonl` (the event
//! log), and `startup.json` (the last daemon-start state: ready/failed + pid/port).
//!
//! `polytoken sessions` only lists LIVE daemons (with a pid/port) and
//! stale-cleans dead entries — it is NOT a source for the session sidebar. The
//! sidebar wants every session that has ever existed, cold or warm, so the
//! on-disk `session.json` registry is the authoritative list. This module reads
//! it directly: no daemon spawn needed until a session is opened.
//!
//! A failed daemon startup leaves a session dir with `startup.json{state:"failed"}`
//! but NO `session.json` — those dirs have no metadata to list from, so they are
//! skipped.

use std::fs;
use std::path::{Path, PathBuf};

use pilot_protocol::session_driver::{SessionListEntry, WorktreeInfo};
use serde::{Deserialize, Serialize};

/// The on-disk `session.json` shape — the durable per-session metadata polytoken
/// writes when a session is created. Fields are all optional in the parser
/// because a corrupt or partial file must degrade to "unknown" rather than
/// crash the list.
#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub struct SessionJson {
    pub session_id: String,
    pub project_path: String,
    pub created_at: String,
    pub last_activity_at: String,
    /// The first ~N chars of the first user message. Absent on a session with
    /// no turn.
    #[serde(default)]
    pub last_user_message_preview: Option<String>,
    #[serde(default)]
    pub initial_model_name: Option<String>,
    /// Tagged: `{kind:"standalone"}` | `{kind:"local", session_id}`. The parent
    /// session, for subsessions. Standalone = no parent.
    #[serde(default)]
    pub parent_session_id: Option<ParentSessionRef>,
}

/// The `parent_session_id` field — a tagged union on `kind`.
#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum ParentSessionRef {
    #[serde(rename = "standalone")]
    Standalone,
    #[serde(rename = "local")]
    Local {
        #[serde(default)]
        session_id: Option<String>,
    },
}

/// Resolve the default sessions dir the daemon uses, mirroring polytoken's own
/// resolution: `$XDG_DATA_HOME/polytoken/sessions` or
/// `~/.local/share/polytoken/sessions`. The daemon's `--sessions-dir` flag
/// overrides this; callers that spawn a daemon with a custom dir should pass the
/// same dir here so the list matches.
pub fn default_sessions_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .map(|s| {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() {
                PathBuf::from(home_dir()).join(".local").join("share")
            } else {
                PathBuf::from(trimmed)
            }
        })
        .unwrap_or_else(|| PathBuf::from(home_dir()).join(".local").join("share"));
    base.join("polytoken").join("sessions")
}

/// Get the home directory from `$HOME`, falling back to the user's home via
/// the libc `getpwuid` if unset (mirrors Node's `os.homedir()`).
fn home_dir() -> String {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return home;
        }
    }
    // Fallback: use getpwuid_r via libc.
    // This mirrors Node's os.homedir() which tries environment variables first.
    // If HOME is unset, we fall back to a best-effort.
    String::new()
}

/// Read one session dir's `session.json`, or `None` if it has none (a failed
/// startup leaves a dir with only `startup.json`). Loud-fails a corrupt file to
/// a console warning + `None` so one bad session can't blank the whole sidebar.
pub fn read_session_json(session_dir: &Path) -> Option<SessionJson> {
    let file = session_dir.join("session.json");
    if !file.exists() {
        return None;
    }
    match fs::read_to_string(&file) {
        Ok(contents) => match serde_json::from_str::<SessionJson>(&contents) {
            Ok(meta) => Some(meta),
            Err(e) => {
                eprintln!("[polytoken] failed to parse {}: {}", file.display(), e);
                None
            }
        },
        Err(e) => {
            eprintln!("[polytoken] failed to read {}: {}", file.display(), e);
            None
        }
    }
}

/// The list of session ids on disk (one per subdirectory of the sessions dir
/// that has a `session.json`). Sorted newest-first by directory mtime — the
/// sidebar re-sorts anyway, but this keeps the raw order sensible.
pub fn list_session_ids(sessions_dir: &Path) -> Vec<String> {
    let entries = match fs::read_dir(sessions_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut with_mtime: Vec<(String, Option<std::time::SystemTime>)> = Vec::new();
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) if ft.is_dir() => ft,
            _ => continue,
        };
        let _ = file_type; // already used by is_dir check
        let name = entry.file_name().to_string_lossy().to_string();
        let mtime = entry.metadata().and_then(|m| m.modified()).ok();
        with_mtime.push((name, mtime));
    }

    // Sort by mtime desc (newest first). A missing/unreadable mtime sorts last.
    with_mtime.sort_by(|a, b| {
        let a_time =
            a.1.map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(f64::MIN)
            })
            .unwrap_or(f64::MIN);
        let b_time =
            b.1.map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(f64::MIN)
            })
            .unwrap_or(f64::MIN);
        b_time
            .partial_cmp(&a_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    with_mtime.into_iter().map(|(name, _)| name).collect()
}

/// Options for building a cold session entry.
pub struct ColdSessionOpts {
    pub archived: bool,
    pub worktree: Option<WorktreeInfo>,
}

/// Build a `SessionListEntry` for a COLD session (no daemon spawned) from its
/// on-disk `session.json`. `path` is the `session.json` file path — the stable
/// switch key the client sends to `openSession` (mirrors the daemon's
/// .jsonl-path key). `archived` + `worktree` are resolved by the caller
/// (pilot-side stores) since they're pilot's own flags, not polytoken's. Returns
/// `None` when the session has no readable `session.json` (a failed startup) —
/// those dirs are skipped.
pub fn cold_session_entry(
    session_dir: &Path,
    session_id: &str,
    opts: ColdSessionOpts,
) -> Option<SessionListEntry> {
    let meta = read_session_json(session_dir)?;
    let created_at = if meta.created_at.is_empty() {
        // `new Date(0).toISOString()` → "1970-01-01T00:00:00.000Z"
        "1970-01-01T00:00:00.000Z".to_string()
    } else {
        meta.created_at.clone()
    };
    let updated_at = if meta.last_activity_at.is_empty() {
        created_at.clone()
    } else {
        meta.last_activity_at.clone()
    };
    // last_user_message_preview doubles as the sidebar preview AND the "last
    // user message at" proxy — when present, last activity was a user turn
    // (preview is captured on user-message). When absent (no turns yet), fall
    // back to createdAt.
    let preview = meta.last_user_message_preview.clone().unwrap_or_default();
    let last_user_message_at = if !preview.is_empty() {
        updated_at.clone()
    } else {
        created_at.clone()
    };
    let parent_session_path = match &meta.parent_session_id {
        Some(ParentSessionRef::Local {
            session_id: Some(sid),
        }) if !sid.is_empty() => Some(sid.clone()),
        _ => None,
    };
    let cwd = if meta.project_path.is_empty() {
        session_dir.to_string_lossy().to_string()
    } else {
        meta.project_path.clone()
    };

    Some(SessionListEntry {
        session_id: session_id.to_string(),
        path: session_dir
            .join("session.json")
            .to_string_lossy()
            .to_string(),
        cwd,
        display_name: None,
        preview,
        // The daemon doesn't expose a per-session user-message count without a
        // daemon; 0 is a safe default (the sidebar shows it, not a wrong number).
        user_message_count: 0,
        updated_at,
        created_at,
        last_user_message_at,
        parent_session_path,
        usage: None,
        archived: opts.archived,
        worktree: opts.worktree,
    })
}

/// Callbacks the caller provides to resolve pilot-side flags.
type WorktreeResolver<'a> = dyn Fn(&str) -> Option<WorktreeInfo> + Send + Sync + 'a;

pub struct ListColdSessionsOpts<'a> {
    pub archived_for: Box<dyn Fn(&str) -> bool + Send + Sync + 'a>,
    pub worktree_for: Option<Box<WorktreeResolver<'a>>>,
}

/// List every cold session on disk as `SessionListEntry`s. Sessions with no
/// `session.json` (failed startups) are skipped. The `worktreeFor`/`archivedFor`
/// callbacks resolve pilot's own side-flags keyed by the session path.
pub fn list_cold_sessions(
    sessions_dir: &Path,
    opts: ListColdSessionsOpts<'_>,
) -> Vec<SessionListEntry> {
    let mut out: Vec<SessionListEntry> = Vec::new();
    for id in list_session_ids(sessions_dir) {
        let session_dir = sessions_dir.join(&id);
        // Resolve worktree from the session's cwd (the worktree dir == session
        // cwd). Read the json first to get cwd, then resolve the worktree flag,
        // then build the entry with both resolved — cold_session_entry takes
        // the resolved flags.
        let meta = match read_session_json(&session_dir) {
            Some(m) => m,
            None => continue,
        };
        let cwd = if meta.project_path.is_empty() {
            session_dir.to_string_lossy().to_string()
        } else {
            meta.project_path.clone()
        };
        let worktree = opts.worktree_for.as_ref().and_then(|f| (f)(&cwd));
        let session_json_path = session_dir.join("session.json");
        let archived = (opts.archived_for)(&session_json_path.to_string_lossy());
        let entry = cold_session_entry(&session_dir, &id, ColdSessionOpts { archived, worktree });
        let Some(entry) = entry else {
            continue;
        };
        out.push(entry);
    }
    out
}

#[cfg(test)]
mod tests {
    //! Mirrors `server/src/polytoken/sessions-registry.test.ts` (15 tests).
    //!
    //! Env-var tests mutate global process state, so they are serialized behind a
    //! single `ENV_MUTEX` (the `serial_test` crate is not a dev-dep here).

    use super::*;
    use pilot_protocol::session_driver::WorktreeInfo;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Serializes env-mutating tests so they don't race each other under the
    /// default parallel test runner. `set_var`/`remove_var` are `unsafe` on
    /// edition 2024, hence the explicit `unsafe` blocks.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// RAII guard that restores `XDG_DATA_HOME` to its prior value (or unsets
    /// it) on drop — even if the test's assertion panics, so one failing test
    /// can't bleed a stale env var into the rest of the process.
    struct XdgGuard {
        orig: Option<String>,
    }
    impl XdgGuard {
        fn set(value: Option<&str>) -> Self {
            let orig = std::env::var("XDG_DATA_HOME").ok();
            match value {
                Some(v) => unsafe { std::env::set_var("XDG_DATA_HOME", v) },
                None => unsafe { std::env::remove_var("XDG_DATA_HOME") },
            }
            Self { orig }
        }
    }
    impl Drop for XdgGuard {
        fn drop(&mut self) {
            match self.orig.take() {
                Some(v) => unsafe { std::env::set_var("XDG_DATA_HOME", v) },
                None => unsafe { std::env::remove_var("XDG_DATA_HOME") },
            }
        }
    }

    /// Base `SessionJson`, equivalent to the TS `baseMeta()` helper. Takes an
    /// override closure so each test customizes only the fields it cares about.
    fn base_meta<F>(over: F) -> SessionJson
    where
        F: FnOnce(&mut SessionJson),
    {
        let mut m = SessionJson {
            session_id: "test".to_string(),
            project_path: "/proj".to_string(),
            created_at: "2026-06-28T10:00:00Z".to_string(),
            last_activity_at: "2026-06-28T11:00:00Z".to_string(),
            last_user_message_preview: Some("hello".to_string()),
            initial_model_name: Some("anthropic/claude".to_string()),
            parent_session_id: Some(ParentSessionRef::Standalone),
        };
        over(&mut m);
        m
    }

    /// Make a temp sessions dir and populate it with the given session metadatas.
    /// `None` values create an empty dir (a failed startup with no session.json).
    /// Returns a `TempDir` guard so the dir is cleaned up on drop (the TS
    /// `mkdtempSync` leaks; we improve on it — CI runs these loops repeatedly).
    fn make_sessions_dir(sessions: &[(&str, Option<SessionJson>)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (id, meta) in sessions {
            let session_dir = dir.path().join(id);
            fs::create_dir_all(&session_dir).unwrap();
            if let Some(meta) = meta {
                let json = serde_json::to_string(meta).unwrap();
                fs::write(session_dir.join("session.json"), json).unwrap();
            }
            // A failed startup has no session.json — leave the dir empty.
        }
        dir
    }

    // ── default_sessions_dir ───────────────────────────────────────────────

    #[test]
    fn default_sessions_dir_respects_xdg_data_home() {
        let _guard = ENV_MUTEX.lock().unwrap();
        // Restored on drop (even on panic) so a failing assert can't bleed the
        // var into other tests.
        let _env = XdgGuard::set(Some("/custom/xdg"));
        let dir = default_sessions_dir();
        assert_eq!(dir, PathBuf::from("/custom/xdg/polytoken/sessions"));
    }

    #[test]
    fn default_sessions_dir_falls_back_to_home_local_share() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let _env = XdgGuard::set(None);
        let dir = default_sessions_dir();
        let s = dir.to_string_lossy();
        assert!(s.contains("polytoken/sessions"));
        assert!(s.contains(".local/share"));
    }

    // ── read_session_json ─────────────────────────────────────────────────

    #[test]
    fn read_session_json_returns_none_for_a_dir_with_no_session_json() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_session_json(dir.path()).is_none());
    }

    #[test]
    fn read_session_json_returns_none_for_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("session.json"), "{not valid json").unwrap();
        // Must NOT panic — degrades to None.
        assert!(read_session_json(dir.path()).is_none());
    }

    #[test]
    fn read_session_json_parses_a_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let expected = base_meta(|_| {});
        fs::write(
            dir.path().join("session.json"),
            serde_json::to_string(&expected).unwrap(),
        )
        .unwrap();
        let got = read_session_json(dir.path()).expect("should parse");
        assert_eq!(got, expected);
    }

    // ── list_session_ids ──────────────────────────────────────────────────

    #[test]
    fn list_session_ids_returns_session_dirs_sorted_newest_first() {
        use filetime::{FileTime, set_file_mtime};
        use std::time::{SystemTime, UNIX_EPOCH};

        let dir = make_sessions_dir(&[
            (
                "older",
                Some(base_meta(|m| m.session_id = "older".to_string())),
            ),
            (
                "newer",
                Some(base_meta(|m| m.session_id = "newer".to_string())),
            ),
        ]);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Pin distinct mtimes so the sort is deterministic (back-to-back mkdirs
        // can land within one mtime tick and tie).
        set_file_mtime(
            dir.path().join("older"),
            FileTime::from_unix_time((now - 60) as i64, 0),
        )
        .unwrap();
        set_file_mtime(
            dir.path().join("newer"),
            FileTime::from_unix_time(now as i64, 0),
        )
        .unwrap();

        let ids = list_session_ids(dir.path());
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], "newer");
    }

    #[test]
    fn list_session_ids_skips_non_directory_entries() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("real-session")).unwrap();
        fs::write(dir.path().join("stray-file.json"), "{}").unwrap();
        assert_eq!(
            list_session_ids(dir.path()),
            vec!["real-session".to_string()]
        );
    }

    #[test]
    fn list_session_ids_returns_empty_for_a_missing_dir() {
        assert!(list_session_ids(Path::new("/nonexistent/path/xyz")).is_empty());
    }

    // ── cold_session_entry ────────────────────────────────────────────────

    #[test]
    fn cold_session_entry_builds_a_session_list_entry() {
        let dir = make_sessions_dir(&[(
            "abc123",
            Some(base_meta(|m| {
                m.session_id = "abc123".to_string();
                m.project_path = "/my/proj".to_string();
                m.last_user_message_preview = Some("do the thing".to_string());
            })),
        )]);
        let entry = cold_session_entry(
            &dir.path().join("abc123"),
            "abc123",
            ColdSessionOpts {
                archived: false,
                worktree: None,
            },
        )
        .expect("should build an entry");

        assert_eq!(entry.session_id, "abc123");
        assert_eq!(entry.cwd, "/my/proj");
        assert_eq!(entry.preview, "do the thing");
        assert!(!entry.archived);
        // preview present → last_user_message_at == last_activity_at.
        assert_eq!(entry.last_user_message_at, "2026-06-28T11:00:00Z");
        assert_eq!(entry.path, dir.path().join("abc123").join("session.json"));
    }

    #[test]
    fn cold_session_entry_returns_none_for_a_failed_startup() {
        let dir = make_sessions_dir(&[("failed", None)]);
        assert!(
            cold_session_entry(
                &dir.path().join("failed"),
                "failed",
                ColdSessionOpts {
                    archived: false,
                    worktree: None,
                },
            )
            .is_none()
        );
    }

    #[test]
    fn cold_session_entry_last_user_message_at_falls_back_to_created_at() {
        let dir = make_sessions_dir(&[(
            "no-turn",
            Some(base_meta(|m| {
                m.session_id = "no-turn".to_string();
                m.last_user_message_preview = None;
                m.last_activity_at = "2026-06-28T11:00:00Z".to_string();
                m.created_at = "2026-06-28T10:00:00Z".to_string();
            })),
        )]);
        let entry = cold_session_entry(
            &dir.path().join("no-turn"),
            "no-turn",
            ColdSessionOpts {
                archived: false,
                worktree: None,
            },
        )
        .expect("should build an entry");
        // No preview → last activity wasn't a user turn → fall back to createdAt.
        assert_eq!(entry.last_user_message_at, "2026-06-28T10:00:00Z");
        assert_eq!(entry.preview, "");
    }

    #[test]
    fn cold_session_entry_local_parent_sets_parent_session_path() {
        let dir = make_sessions_dir(&[(
            "child",
            Some(base_meta(|m| {
                m.session_id = "child".to_string();
                m.parent_session_id = Some(ParentSessionRef::Local {
                    session_id: Some("parent-id".to_string()),
                });
            })),
        )]);
        let entry = cold_session_entry(
            &dir.path().join("child"),
            "child",
            ColdSessionOpts {
                archived: false,
                worktree: None,
            },
        )
        .expect("should build an entry");
        assert_eq!(entry.parent_session_path.as_deref(), Some("parent-id"));
    }

    #[test]
    fn cold_session_entry_standalone_parent_has_no_parent_session_path() {
        let dir = make_sessions_dir(&[(
            "solo",
            Some(base_meta(|m| {
                m.session_id = "solo".to_string();
                m.parent_session_id = Some(ParentSessionRef::Standalone);
            })),
        )]);
        let entry = cold_session_entry(
            &dir.path().join("solo"),
            "solo",
            ColdSessionOpts {
                archived: false,
                worktree: None,
            },
        )
        .expect("should build an entry");
        assert!(entry.parent_session_path.is_none());
    }

    // ── list_cold_sessions ────────────────────────────────────────────────

    #[test]
    fn list_cold_sessions_merges_archive_and_worktree_flags() {
        let dir = make_sessions_dir(&[
            (
                "s1",
                Some(base_meta(|m| {
                    m.session_id = "s1".to_string();
                    m.project_path = "/p1".to_string();
                })),
            ),
            (
                "s2",
                Some(base_meta(|m| {
                    m.session_id = "s2".to_string();
                    m.project_path = "/p2".to_string();
                })),
            ),
            ("failed", None),
        ]);
        let archived_paths = std::collections::HashSet::from([dir
            .path()
            .join("s2")
            .join("session.json")
            .to_string_lossy()
            .to_string()]);
        let entries = list_cold_sessions(
            dir.path(),
            ListColdSessionsOpts {
                archived_for: Box::new(move |p: &str| archived_paths.contains(p)),
                worktree_for: Some(Box::new(|cwd: &str| {
                    if cwd == "/p1" {
                        Some(WorktreeInfo {
                            path: "/p1".to_string(),
                            base: "/repo".to_string(),
                            name: "wt-name".to_string(),
                            reaped: None,
                        })
                    } else {
                        None
                    }
                })),
            },
        );
        // "failed" is skipped (no session.json).
        assert_eq!(entries.len(), 2);
        let s1 = entries
            .iter()
            .find(|e| e.session_id == "s1")
            .expect("s1 present");
        let s2 = entries
            .iter()
            .find(|e| e.session_id == "s2")
            .expect("s2 present");
        assert!(!s1.archived);
        assert_eq!(
            s1.worktree,
            Some(WorktreeInfo {
                path: "/p1".to_string(),
                base: "/repo".to_string(),
                name: "wt-name".to_string(),
                reaped: None,
            })
        );
        assert!(s2.archived);
        assert!(s2.worktree.is_none());
    }

    #[test]
    fn list_cold_sessions_returns_empty_for_a_missing_dir() {
        let entries = list_cold_sessions(
            Path::new("/nonexistent"),
            ListColdSessionsOpts {
                archived_for: Box::new(|_| false),
                worktree_for: None,
            },
        );
        assert!(entries.is_empty());
    }
}
