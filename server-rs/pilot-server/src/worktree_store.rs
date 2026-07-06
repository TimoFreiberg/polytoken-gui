//! The worktree index: pilot's record of the jj/git worktrees it created, keyed by
//! the worktree dir (which is the session's cwd).
//!
//! Faithful port of `server/src/worktree-store.ts`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::shared::worktree::WorktreeMeta;

pub struct WorktreeStore {
    file: PathBuf,
    by_path: HashMap<String, WorktreeMeta>,
    /// Paths whose worktree dir has been reaped. The meta stays in `by_path` (so
    /// `base` survives for grouping); this set marks it as no-longer-a-live-worktree.
    reaped: HashSet<String>,
}

impl WorktreeStore {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        let file = file.into();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).unwrap_or_else(|e| {
                panic!("[worktree] failed to create {}: {e}", parent.display())
            });
        }
        let mut store = Self {
            file,
            by_path: HashMap::new(),
            reaped: HashSet::new(),
        };
        store.load();
        store
    }

    /// The worktree pilot created (or once created) at this path (== a session cwd),
    /// or `None`. Returns reaped tombstones too; callers that need a live worktree
    /// must use `live` instead.
    pub fn get(&self, path: &str) -> Option<&WorktreeMeta> {
        self.by_path.get(path)
    }

    /// The worktree at this path only if it's still LIVE (not reaped).
    pub fn live(&self, path: &str) -> Option<&WorktreeMeta> {
        if self.reaped.contains(path) {
            None
        } else {
            self.by_path.get(path)
        }
    }

    /// True if this path's worktree dir has been reaped (tombstoned).
    pub fn is_reaped(&self, path: &str) -> bool {
        self.reaped.contains(path)
    }

    pub fn add(&mut self, meta: WorktreeMeta) {
        let path = meta.path.clone();
        self.by_path.insert(path.clone(), meta);
        // Defensive: a path reused after a prior reap starts live again.
        self.reaped.remove(&path);
        self.persist();
    }

    /// Tombstone the worktree at `path`: keep its meta for grouping but mark it reaped.
    pub fn mark_reaped(&mut self, path: &str) {
        if self.by_path.contains_key(path) && !self.reaped.contains(path) {
            self.reaped.insert(path.to_string());
            self.persist();
        }
    }

    fn load(&mut self) {
        if !Path::new(&self.file).exists() {
            return;
        }
        match fs::read_to_string(&self.file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<PersistedWorktree>>(&raw).ok())
        {
            Some(arr) => {
                let count = arr.len();
                for entry in arr {
                    let meta = entry.meta;
                    let path = meta.path.clone();
                    self.by_path.insert(path.clone(), meta);
                    if entry.reaped.unwrap_or(false) {
                        self.reaped.insert(path);
                    }
                }
                if count > 0 {
                    println!("[worktree] loaded {count} tracked worktree(s)");
                }
            }
            None => eprintln!("[worktree] failed to load index"),
        }
    }

    fn persist(&self) {
        let out: Vec<PersistedWorktree> = self
            .by_path
            .values()
            .cloned()
            .map(|meta| PersistedWorktree {
                reaped: self.reaped.contains(&meta.path).then_some(true),
                meta,
            })
            .collect();
        let json = serde_json::to_string_pretty(&out).expect("worktree index should serialize");
        fs::write(&self.file, json)
            .unwrap_or_else(|e| panic!("[worktree] failed to write {}: {e}", self.file.display()));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedWorktree {
    #[serde(flatten)]
    meta: WorktreeMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    reaped: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::worktree::Vcs;
    use serde_json::Value;
    use std::fs;

    fn meta(path: &str) -> WorktreeMeta {
        meta_with_base(path, "/repo")
    }

    fn meta_with_base(path: &str, base: &str) -> WorktreeMeta {
        WorktreeMeta {
            path: path.to_string(),
            base: base.to_string(),
            vcs: Vcs::Jj,
            name: path[1..].to_string(),
        }
    }

    #[test]
    fn get_is_none_for_an_unknown_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        assert!(WorktreeStore::new(file).get("/wt-a").is_none());
    }

    #[test]
    fn add_stores_and_persists_the_meta_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut s1 = WorktreeStore::new(&file);
        s1.add(meta("/wt-a"));
        s1.add(meta_with_base("/wt-b", "/other"));
        let s2 = WorktreeStore::new(&file);
        assert_eq!(s2.get("/wt-a"), Some(&meta("/wt-a")));
        assert_eq!(s2.get("/wt-b"), Some(&meta_with_base("/wt-b", "/other")));
        assert!(s2.get("/wt-c").is_none());
    }

    #[test]
    fn live_returns_the_worktree_when_not_reaped() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut store = WorktreeStore::new(file);
        store.add(meta("/wt-a"));
        assert_eq!(store.live("/wt-a"), Some(&meta("/wt-a")));
    }

    #[test]
    fn mark_reaped_tombstones_get_still_returns_meta_live_excludes_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut store = WorktreeStore::new(file);
        store.add(meta("/wt-a"));
        store.mark_reaped("/wt-a");
        assert_eq!(store.get("/wt-a"), Some(&meta("/wt-a")));
        assert!(store.is_reaped("/wt-a"));
        assert!(store.live("/wt-a").is_none());
    }

    #[test]
    fn mark_reaped_is_a_no_op_for_an_unknown_path_no_phantom_tombstone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut store = WorktreeStore::new(file);
        store.mark_reaped("/never-added");
        assert!(!store.is_reaped("/never-added"));
        assert!(store.get("/never-added").is_none());
    }

    #[test]
    fn mark_reaped_is_idempotent_remarking_a_reaped_path_doesnt_double_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut store = WorktreeStore::new(&file);
        store.add(meta("/wt-a"));
        store.mark_reaped("/wt-a");
        let before = fs::read_to_string(&file).unwrap();
        store.mark_reaped("/wt-a");
        assert_eq!(fs::read_to_string(&file).unwrap(), before);
    }

    #[test]
    fn add_on_a_reaped_path_revives_it_reaped_flag_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut store = WorktreeStore::new(file);
        store.add(meta("/wt-a"));
        store.mark_reaped("/wt-a");
        assert!(store.is_reaped("/wt-a"));
        store.add(meta("/wt-a"));
        assert!(!store.is_reaped("/wt-a"));
        assert_eq!(store.live("/wt-a"), Some(&meta("/wt-a")));
    }

    #[test]
    fn tombstone_and_reaped_flag_persist_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut s1 = WorktreeStore::new(&file);
        s1.add(meta("/wt-a"));
        s1.add(meta("/wt-b"));
        s1.mark_reaped("/wt-a");
        let s2 = WorktreeStore::new(&file);
        assert_eq!(s2.get("/wt-a"), Some(&meta("/wt-a")));
        assert!(s2.is_reaped("/wt-a"));
        assert!(s2.live("/wt-a").is_none());
        assert_eq!(s2.live("/wt-b"), Some(&meta("/wt-b")));
    }

    #[test]
    fn persisted_shape_stamps_reaped_entries_with_a_reaped_true_flag() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("worktrees.json");
        let mut store = WorktreeStore::new(&file);
        store.add(meta("/live"));
        store.add(meta("/dead"));
        store.mark_reaped("/dead");
        let on_disk: Vec<Value> =
            serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        let live = on_disk
            .iter()
            .find(|entry| entry["path"] == "/live")
            .unwrap();
        let dead = on_disk
            .iter()
            .find(|entry| entry["path"] == "/dead")
            .unwrap();
        assert!(live.get("reaped").is_none());
        assert_eq!(dead.get("reaped"), Some(&Value::Bool(true)));
    }

    #[test]
    fn a_missing_index_file_loads_as_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            WorktreeStore::new(dir.path().join("nope.json"))
                .get("/wt-a")
                .is_none()
        );
    }
}
