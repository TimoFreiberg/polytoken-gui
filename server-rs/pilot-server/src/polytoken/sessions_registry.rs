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
use serde::Deserialize;

/// The on-disk `session.json` shape — the durable per-session metadata polytoken
/// writes when a session is created. Fields are all optional in the parser
/// because a corrupt or partial file must degrade to "unknown" rather than
/// crash the list.
#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Deserialize)]
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
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok();
        with_mtime.push((name, mtime));
    }

    // Sort by mtime desc (newest first). A missing/unreadable mtime sorts last.
    with_mtime.sort_by(|a, b| {
        let a_time = a.1.map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(f64::MIN)).unwrap_or(f64::MIN);
        let b_time = b.1.map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(f64::MIN)).unwrap_or(f64::MIN);
        b_time.partial_cmp(&a_time).unwrap_or(std::cmp::Ordering::Equal)
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
        Some(ParentSessionRef::Local { session_id: Some(sid) }) if !sid.is_empty() => {
            Some(sid.clone())
        }
        _ => None,
    };
    let cwd = if meta.project_path.is_empty() {
        session_dir.to_string_lossy().to_string()
    } else {
        meta.project_path.clone()
    };

    Some(SessionListEntry {
        session_id: session_id.to_string(),
        path: session_dir.join("session.json").to_string_lossy().to_string(),
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
pub struct ListColdSessionsOpts {
    pub archived_for: Box<dyn Fn(&str) -> bool + Send + Sync>,
    pub worktree_for: Option<Box<dyn Fn(&str) -> Option<WorktreeInfo> + Send + Sync>>,
}

/// List every cold session on disk as `SessionListEntry`s. Sessions with no
/// `session.json` (failed startups) are skipped. The `worktreeFor`/`archivedFor`
/// callbacks resolve pilot's own side-flags keyed by the session path.
pub fn list_cold_sessions(sessions_dir: &Path, opts: ListColdSessionsOpts) -> Vec<SessionListEntry> {
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
        let worktree = opts
            .worktree_for
            .as_ref()
            .and_then(|f| (f)(&cwd));
        let session_json_path = session_dir.join("session.json");
        let archived = (opts.archived_for)(&session_json_path.to_string_lossy());
        let entry = cold_session_entry(
            &session_dir,
            &id,
            ColdSessionOpts {
                archived,
                worktree,
            },
        );
        let Some(entry) = entry else {
            continue;
        };
        out.push(entry);
    }
    out
}
