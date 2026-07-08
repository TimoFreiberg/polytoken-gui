//! The archive index: pantoken's source of truth for which sessions the operator has
//! archived. Keyed by the session's switch-key path — the live `PolytokenDriver`
//! uses the `session.json` path, the mock uses the `.jsonl` path; the store
//! itself is path-agnostic.
//!
//! Faithful port of `server/src/archive-store.ts`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub struct ArchiveStore {
    file: PathBuf,
    archived: HashSet<String>,
}

impl ArchiveStore {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        let file = file.into();
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)
                .unwrap_or_else(|e| panic!("[archive] failed to create {}: {e}", parent.display()));
        }
        let mut store = Self {
            file,
            archived: HashSet::new(),
        };
        store.load();
        store
    }

    pub fn has(&self, path: &str) -> bool {
        self.archived.contains(path)
    }

    /// Set/clear the archived flag for a session path. Persists only on an actual change.
    pub fn set(&mut self, path: &str, archived: bool) {
        let changed = if archived {
            !self.archived.contains(path)
        } else {
            self.archived.contains(path)
        };
        if !changed {
            return;
        }
        if archived {
            self.archived.insert(path.to_string());
        } else {
            self.archived.remove(path);
        }
        self.persist();
    }

    fn load(&mut self) {
        if !Path::new(&self.file).exists() {
            return;
        }
        match fs::read_to_string(&self.file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        {
            Some(arr) => {
                let count = arr.len();
                for path in arr {
                    self.archived.insert(path);
                }
                if count > 0 {
                    println!("[archive] loaded {count} archived session(s)");
                }
            }
            None => eprintln!("[archive] failed to load index"),
        }
    }

    fn persist(&self) {
        let json = serde_json::to_string_pretty(&self.archived.iter().collect::<Vec<_>>())
            .expect("archive index should serialize");
        fs::write(&self.file, json)
            .unwrap_or_else(|e| panic!("[archive] failed to write {}: {e}", self.file.display()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn has_is_false_for_an_unknown_path() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        assert!(!ArchiveStore::new(file).has("/a.jsonl"));
    }

    #[test]
    fn set_true_archives_set_false_unarchives() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        let mut store = ArchiveStore::new(file);
        store.set("/a.jsonl", true);
        assert!(store.has("/a.jsonl"));
        store.set("/a.jsonl", false);
        assert!(!store.has("/a.jsonl"));
    }

    #[test]
    fn persists_across_instances_the_file_is_the_source_of_truth() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        let mut s1 = ArchiveStore::new(&file);
        s1.set("/a.jsonl", true);
        s1.set("/b.jsonl", true);
        let s2 = ArchiveStore::new(&file);
        assert!(s2.has("/a.jsonl"));
        assert!(s2.has("/b.jsonl"));
        assert!(!s2.has("/c.jsonl"));
    }

    #[test]
    fn unarchiving_removes_the_path_from_the_persisted_set() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("archived.json");
        let mut s1 = ArchiveStore::new(&file);
        s1.set("/a.jsonl", true);
        s1.set("/a.jsonl", false);
        let raw = fs::read_to_string(&file).unwrap();
        let arr: Vec<String> = serde_json::from_str(&raw).unwrap();
        assert_eq!(arr, Vec::<String>::new());
        assert!(!ArchiveStore::new(&file).has("/a.jsonl"));
    }

    #[test]
    fn a_missing_index_file_loads_as_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!ArchiveStore::new(dir.path().join("nope.json")).has("/a.jsonl"));
    }
}
