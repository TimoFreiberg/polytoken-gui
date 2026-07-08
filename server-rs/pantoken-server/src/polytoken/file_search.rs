//! In-process `.gitignore`-aware file search — the Rust-native replacement for
//! the TS `listFilesWithFd` (which spawns the `fd` binary).
//!
//! Ports `server/src/file-search.ts`: the same `.gitignore`-aware traversal,
//! hidden-file inclusion, symlink following, `.git` exclusion, and result cap.
//! Uses the `ignore` crate (from ripgrep) instead of spawning `fd` — no
//! external binary dependency, fully testable in-process.
//!
//! The `list_files` driver method is the fallback @-mention search: it fires
//! when the daemon's prefetched file index was truncated (or for a new-session
//! draft with no session). The daemon's `GET /files` has no query param, so
//! the fallback does the per-query search locally.

use std::path::Path;

use ignore::WalkBuilder;
use pantoken_protocol::session_driver::FileInfo;

/// Result cap for the per-query fallback search (only fires on a truncated
/// index). Mirrors `FILE_QUERY_CAP` in `server/src/file-search.ts`.
pub const FILE_QUERY_CAP: usize = 50;

/// Build the ordered list of query segments a path must contain to match.
///
/// **Deliberate divergence from TS `buildFdPathQuery`** (`server/src/file-search.ts`):
/// the TS port builds a regex joining escaped segments with a `[\\/]` separator
/// class, which requires segments to appear in **adjacent** path components
/// (`src/main` matches `src/main.rs` but not `src/other/main.rs`). This Rust
/// port instead returns the segments and matches them as ordered-but-
/// **non-adjacent** substrings of path components (see `path_matches`). That is
/// intentionally more permissive: for @-mention completion the client fuzzy-
/// matches locally anyway, and substring-on-ordered-components is what the
/// fuzzy matcher effectively does. `fd`'s regex escaping is unnecessary here
/// because we never feed the query to a regex engine.
fn build_path_query(query: &str) -> Vec<String> {
    let normalized = query.replace('\\', "/");
    if !normalized.contains('/') {
        return if normalized.is_empty() {
            vec![]
        } else {
            vec![normalized]
        };
    }
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return vec![];
    }
    trimmed
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Check if a relative path matches the query segments (in order).
///
/// Each segment must appear as a substring of some path component, and the
/// segments must appear in order along the path — but NOT necessarily in
/// adjacent components (see `build_path_query` for the deliberate divergence
/// from the TS regex-based matcher, which requires adjacency).
fn path_matches(path: &str, query_segments: &[String]) -> bool {
    if query_segments.is_empty() {
        return true;
    }
    let components: Vec<&str> = path.split('/').collect();
    let mut seg_idx = 0;
    for comp in &components {
        if seg_idx >= query_segments.len() {
            break;
        }
        if comp.contains(&query_segments[seg_idx]) {
            seg_idx += 1;
        }
    }
    seg_idx == query_segments.len()
}

/// Search for files in `root` matching `query`, returning at most
/// `FILE_QUERY_CAP` results. Mirrors `listFilesWithFd` in
/// `server/src/file-search.ts`.
///
/// Behavior (matching `fd`'s `baseFdArgs`):
/// - `.gitignore`-aware (via `ignore` crate)
/// - Follows symlinks
/// - Includes hidden files (dotfiles)
/// - Excludes the `.git` tree
/// - Lists both files and directories
/// - Caps results at `FILE_QUERY_CAP`
///
/// **Divergence from TS `baseFdArgs`:** `.git_global(false)` skips the user's
/// *global* gitignore (`core.excludesFile` / `~/.gitignore_global`), whereas
/// `fd`'s default respects it. Global patterns are usually editor/OS cruft
/// (`*.swp`, `.DS_Store`); skipping them is a deliberate simplification for
/// the truncated-index fallback path.
pub fn list_files_with_fd(root: &Path, query: &str) -> Vec<FileInfo> {
    let query_segments = build_path_query(query);
    let walker = WalkBuilder::new(root)
        // `hidden(false)` DISABLES the ignore crate's hidden-file filter, i.e.
        // it INCLUDES dotfiles — matching `fd --hidden` / TS `baseFdArgs`.
        // (The crate's `hidden(true)` would *ignore* dotfiles, the opposite
        // of what @-mention search wants.)
        .hidden(false)
        .ignore(true) // .gitignore aware
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .follow_links(true)
        .filter_entry(|entry| {
            // Exclude the .git directory tree (belt-and-suspenders — ignore
            // already respects .gitignore, but a repo without .gitignore
            // shouldn't leak .git internals).
            let name = entry.file_name().to_string_lossy();
            name != ".git"
        })
        .build();

    let mut results: Vec<FileInfo> = Vec::new();
    for entry in walker {
        let Ok(entry) = entry else { continue };
        if results.len() >= FILE_QUERY_CAP {
            break;
        }

        let file_type = match entry.file_type() {
            Some(ft) => ft,
            None => continue,
        };
        // Skip the root itself.
        if entry.depth() == 0 {
            continue;
        }

        let is_dir = file_type.is_dir();
        // fd lists both files and directories.
        if !file_type.is_file() && !is_dir {
            continue;
        }

        // Get the path relative to root.
        let rel = match entry.path().strip_prefix(root) {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => continue,
        };

        // Normalize to forward slashes.
        let rel = rel.replace('\\', "/");

        // Drop stray .git entries defensively.
        if rel == ".git" || rel.starts_with(".git/") || rel.contains("/.git/") {
            continue;
        }

        if !path_matches(&rel, &query_segments) {
            continue;
        }

        results.push(FileInfo {
            path: rel,
            is_directory: is_dir,
        });
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_build_path_query_plain() {
        assert_eq!(build_path_query("main"), vec!["main".to_string()]);
    }

    #[test]
    fn test_build_path_query_path_segments() {
        let segs = build_path_query("src/main");
        assert_eq!(segs, vec!["src".to_string(), "main".to_string()]);
    }

    #[test]
    fn test_build_path_query_empty() {
        assert_eq!(build_path_query(""), Vec::<String>::new());
    }

    #[test]
    fn test_path_matches_simple() {
        assert!(path_matches("src/main.rs", &["main".to_string()]));
        assert!(!path_matches("src/lib.rs", &["main".to_string()]));
    }

    #[test]
    fn test_path_matches_ordered_segments() {
        assert!(path_matches(
            "src/main/mod.rs",
            &["src".to_string(), "main".to_string()]
        ));
        // Out-of-order segments should NOT match.
        assert!(!path_matches(
            "main/src/mod.rs",
            &["src".to_string(), "main".to_string()]
        ));
    }

    #[test]
    fn test_path_matches_empty_query_matches_all() {
        assert!(path_matches("anything.rs", &[]));
    }

    #[test]
    fn test_list_files_finds_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::write(root.join("src/main.rs"), "fn main() {}").expect("write");
        fs::write(root.join("src/lib.rs"), "pub fn lib() {}").expect("write");
        fs::write(root.join("README.md"), "# project").expect("write");

        let files = list_files_with_fd(root, "");
        assert!(!files.is_empty(), "should find files");
        assert!(
            files.iter().any(|f| f.path == "src/main.rs"),
            "should find src/main.rs"
        );
        assert!(
            files.iter().any(|f| f.path == "README.md"),
            "should find README.md"
        );
    }

    #[test]
    fn test_list_files_filters_by_query() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::write(root.join("src/main.rs"), "").expect("write");
        fs::write(root.join("src/lib.rs"), "").expect("write");

        let files = list_files_with_fd(root, "main");
        assert_eq!(files.len(), 1, "should only find main.rs");
        assert_eq!(files[0].path, "src/main.rs");
    }

    #[test]
    fn test_list_files_excludes_git_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        fs::create_dir_all(root.join(".git/objects")).expect("mkdir");
        fs::write(root.join(".git/HEAD"), "ref").expect("write");
        fs::write(root.join("main.rs"), "").expect("write");

        let files = list_files_with_fd(root, "");
        assert!(
            !files.iter().any(|f| f.path.starts_with(".git")),
            "should not include .git entries"
        );
        assert!(
            files.iter().any(|f| f.path == "main.rs"),
            "should find main.rs"
        );
    }

    #[test]
    fn test_list_files_caps_results() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        // Create more files than FILE_QUERY_CAP.
        for i in 0..(FILE_QUERY_CAP + 10) {
            fs::write(root.join(format!("file_{i}.txt")), "").expect("write");
        }

        let files = list_files_with_fd(root, "");
        assert!(
            files.len() <= FILE_QUERY_CAP,
            "should cap at FILE_QUERY_CAP, got {}",
            files.len()
        );
    }

    #[test]
    fn test_list_files_includes_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        fs::create_dir_all(root.join("src/components")).expect("mkdir");
        fs::write(root.join("src/main.rs"), "").expect("write");

        let files = list_files_with_fd(root, "");
        assert!(
            files.iter().any(|f| f.is_directory && f.path == "src"),
            "should include directories"
        );
    }

    #[test]
    fn test_list_files_includes_hidden_files() {
        // Regression guard for the `.hidden(false)` call: dotfiles must be
        // INCLUDED (matching `fd --hidden`). With `.hidden(true)` (the bug)
        // every dotfile is silently dropped — this test would catch that.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        fs::write(root.join(".env"), "SECRET=1").expect("write .env");
        fs::write(root.join("visible.rs"), "").expect("write visible.rs");

        let files = list_files_with_fd(root, "");
        assert!(
            files.iter().any(|f| f.path == ".env"),
            "should include dotfiles, got: {:?}",
            files
        );
        assert!(
            files.iter().any(|f| f.path == "visible.rs"),
            "should include regular files"
        );
    }

    #[test]
    fn test_list_files_is_gitignore_aware() {
        // The headline feature: the `ignore` crate respects `.gitignore`.
        // Like `fd` (and the TS `baseFdArgs`, which passes no
        // `--no-require-git`), gitignore rules only apply inside a git repo, so
        // initialize one. Ignored files must NOT appear in results.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        fs::create_dir_all(root.join(".git")).expect("mkdir .git");
        fs::write(root.join(".gitignore"), "*.log\n").expect("write .gitignore");
        fs::write(root.join("keep.rs"), "").expect("write keep.rs");
        fs::write(root.join("ignored.log"), "noise").expect("write ignored.log");

        let files = list_files_with_fd(root, "");
        assert!(
            files.iter().any(|f| f.path == "keep.rs"),
            "non-ignored file should be found"
        );
        assert!(
            !files.iter().any(|f| f.path == "ignored.log"),
            "gitignored file should NOT be found, got: {:?}",
            files
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_list_files_follows_symlinks() {
        // `follow_links(true)` means symlinks are resolved and listed.
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();

        fs::write(root.join("real.rs"), "").expect("write real.rs");
        symlink("real.rs", root.join("link.rs")).expect("symlink");

        let files = list_files_with_fd(root, "");
        assert!(
            files.iter().any(|f| f.path == "link.rs"),
            "symlink target should be found (follow_links), got: {:?}",
            files
        );
    }
}
