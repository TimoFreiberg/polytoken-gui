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

use std::path::{Path, PathBuf};

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

// ── External (@~/, @/, @../) browsing ───────────────────────────────────
//
// Unlike `list_files_with_fd` (a recursive project-relative search), external
// browsing lists only the IMMEDIATE children of one directory at a time — the
// client drills down one path segment per accept, same mechanic as the
// project picker's directory rows. Ports the design in
// `docs/DESIGN.md`/the at-references plan: split the query at the last `/`
// into the directory being browsed (as typed) and a partial filter, resolve
// that directory to something `read_dir`-able, filter + sort its entries, and
// re-prefix the AS-TYPED directory so `~/foo` stays `~/foo` in the result
// (never canonicalized).

/// Whether an @-mention query addresses the OS filesystem outside the project
/// (`~/…`, `/…`, `../…`) rather than the project-relative file index. Mirrors
/// the client's `classifyAtQuery` external branch (`file-autocomplete.ts`) —
/// both sides must classify identically or the client's picker and the
/// server's search would disagree about which mode a query is in.
pub fn is_external_query(query: &str) -> bool {
    query.starts_with('/') || query.starts_with('~') || query.starts_with("..")
}

/// Split an external @-mention query into the directory being browsed — as
/// typed, e.g. `~/proj`, `..`, `/etc`, `~` — and the partial filter text after
/// the last `/` (may be empty). A query with no `/` at all is entirely the
/// directory with an empty partial: this covers the bare `~` and `..` special
/// cases (a trailing-slash-less final segment that IS `~` or `..` counts as
/// the directory, not a partial to filter by) as well as any other
/// slash-free query, uniformly.
pub fn split_external_query(query: &str) -> (String, String) {
    match query.rfind('/') {
        None => (query.to_string(), String::new()),
        Some(idx) => {
            let dir_prefix = &query[..idx];
            // The only `/` in the query is the leading root slash (e.g. "/etc",
            // where idx == 0): slicing it off would lose the root marker
            // entirely, so keep it as "/" rather than "".
            let dir_prefix = if dir_prefix.is_empty() && query.starts_with('/') {
                "/"
            } else {
                dir_prefix
            };
            (dir_prefix.to_string(), query[idx + 1..].to_string())
        }
    }
}

/// Join a directory prefix (as typed) and a child name into the path handed
/// back to the client, without producing a `//` when `dir_prefix` is `/` or
/// already ends in `/`.
pub fn join_prefix(dir_prefix: &str, name: &str) -> String {
    if dir_prefix.ends_with('/') {
        format!("{dir_prefix}{name}")
    } else {
        format!("{dir_prefix}/{name}")
    }
}

/// Resolve an as-typed directory prefix to an absolute filesystem path to
/// read. `base` is the session cwd (for `..`-relative prefixes); `home` is
/// the server's `$HOME` (for `~`-relative prefixes). Absolute (`/…`) prefixes
/// are used as-is. Never canonicalized — a `..` component left in the result
/// is resolved by the OS when `read_dir` is called, same as a shell would.
fn resolve_dir_prefix(dir_prefix: &str, base: &Path, home: &Path) -> PathBuf {
    if dir_prefix == "~" {
        home.to_path_buf()
    } else if let Some(rest) = dir_prefix.strip_prefix("~/") {
        home.join(rest)
    } else if dir_prefix.starts_with('/') {
        PathBuf::from(dir_prefix)
    } else {
        // The only other external lead-in is `..` (bare or `../…`) — resolve
        // relative to the session cwd.
        base.join(dir_prefix)
    }
}

/// List the immediate children of the directory an external (`~/…`, `/…`,
/// `../…`) @-mention query is browsing, filtered by the trailing partial
/// segment. `base` is the session cwd (used to resolve `..`-relative
/// prefixes); `home` is the server's `$HOME` (used to resolve `~`). A
/// missing/unreadable directory yields an empty vec — no error, matching the
/// project-search fallback's graceful-empty behavior. Hidden (dot-prefixed)
/// entries are excluded unless the partial itself starts with `.` — the
/// global reveal-all toggle is a later stage. Directories sort before files;
/// each group sorts case-insensitively alphabetical. Results are capped at
/// `cap`.
pub fn list_external(base: &Path, home: &Path, query: &str, cap: usize) -> Vec<FileInfo> {
    let (dir_prefix, partial) = split_external_query(query);
    let dir = resolve_dir_prefix(&dir_prefix, base, home);

    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let partial_lower = partial.to_lowercase();
    let reveal_dotfiles = partial.starts_with('.');

    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !reveal_dotfiles && name.starts_with('.') {
            continue;
        }
        if !partial.is_empty() && !name.to_lowercase().contains(&partial_lower) {
            continue;
        }
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        entries.push((name, is_dir));
    }

    entries.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    entries
        .into_iter()
        .take(cap)
        .map(|(name, is_dir)| FileInfo {
            path: join_prefix(&dir_prefix, &name),
            is_directory: is_dir,
        })
        .collect()
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

#[cfg(test)]
mod external_tests {
    use super::*;
    use std::fs;

    /// A synthetic `$HOME` with a `notes.md` file, a `Documents/` dir holding
    /// `report.md` + `reports/` (for the drill-down test), and a hidden
    /// `.secrets` file (for the dotfile-hiding tests).
    fn setup_home() -> tempfile::TempDir {
        let home = tempfile::tempdir().expect("home tempdir");
        fs::write(home.path().join("notes.md"), "").expect("write notes.md");
        fs::create_dir_all(home.path().join("Documents/reports")).expect("mkdir Documents");
        fs::write(home.path().join("Documents/report.md"), "").expect("write report.md");
        fs::write(home.path().join(".secrets"), "").expect("write .secrets");
        home
    }

    #[test]
    fn test_split_external_query_tilde_alone() {
        assert_eq!(split_external_query("~"), ("~".to_string(), "".to_string()));
    }

    #[test]
    fn test_split_external_query_dotdot_alone() {
        assert_eq!(
            split_external_query(".."),
            ("..".to_string(), "".to_string())
        );
    }

    #[test]
    fn test_split_external_query_trailing_slash_empty_partial() {
        assert_eq!(
            split_external_query("~/Documents/"),
            ("~/Documents".to_string(), "".to_string())
        );
    }

    #[test]
    fn test_split_external_query_root_single_segment() {
        // "/etc" has its only "/" at index 0 — the root marker must survive,
        // not collapse to an empty dir_prefix.
        assert_eq!(
            split_external_query("/etc"),
            ("/".to_string(), "etc".to_string())
        );
    }

    #[test]
    fn test_split_external_query_absolute_dir_with_partial() {
        assert_eq!(
            split_external_query("/etc/ho"),
            ("/etc".to_string(), "ho".to_string())
        );
    }

    #[test]
    fn test_join_prefix_no_double_slash_for_root() {
        assert_eq!(join_prefix("/", "etc"), "/etc");
    }

    #[test]
    fn test_join_prefix_regular_prefix() {
        assert_eq!(
            join_prefix("~/Documents", "report.md"),
            "~/Documents/report.md"
        );
    }

    #[test]
    fn test_list_external_tilde_alone_lists_home() {
        let home = setup_home();
        let base = tempfile::tempdir().expect("base tempdir");

        let files = list_external(base.path(), home.path(), "~", 50);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(names.contains(&"~/notes.md"));
        assert!(names.contains(&"~/Documents"));
        assert!(
            !names.iter().any(|n| n.contains(".secrets")),
            "dotfile should be hidden by default, got: {:?}",
            names
        );
    }

    #[test]
    fn test_list_external_drills_into_subdirectory() {
        let home = setup_home();
        let base = tempfile::tempdir().expect("base tempdir");

        let files = list_external(base.path(), home.path(), "~/Documents/", 50);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(names.contains(&"~/Documents/report.md"));
        assert!(names.contains(&"~/Documents/reports"));
    }

    #[test]
    fn test_list_external_filters_by_partial_case_insensitive() {
        let home = setup_home();
        fs::write(home.path().join("Documents/other.txt"), "").expect("write other.txt");
        let base = tempfile::tempdir().expect("base tempdir");

        let files = list_external(base.path(), home.path(), "~/Documents/REP", 50);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(names.contains(&"~/Documents/report.md"));
        assert!(names.contains(&"~/Documents/reports"));
        assert!(!names.contains(&"~/Documents/other.txt"));
    }

    #[test]
    fn test_list_external_hides_dotfiles_unless_partial_starts_with_dot() {
        let home = setup_home();
        let base = tempfile::tempdir().expect("base tempdir");

        let hidden = list_external(base.path(), home.path(), "~", 50);
        assert!(!hidden.iter().any(|f| f.path == "~/.secrets"));

        let revealed = list_external(base.path(), home.path(), "~/.se", 50);
        assert!(
            revealed.iter().any(|f| f.path == "~/.secrets"),
            "a partial starting with '.' should reveal dotfiles, got: {:?}",
            revealed
        );
    }

    #[test]
    fn test_list_external_dotdot_relative_to_base() {
        let root = tempfile::tempdir().expect("root tempdir");
        let base_dir = root.path().join("project");
        fs::create_dir_all(&base_dir).expect("mkdir project");
        fs::write(root.path().join("sibling.txt"), "").expect("write sibling.txt");
        let home = tempfile::tempdir().expect("home tempdir"); // unused by this query

        let files = list_external(&base_dir, home.path(), "..", 50);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(names.contains(&"../sibling.txt"));
        assert!(names.contains(&"../project"));
    }

    #[test]
    fn test_list_external_missing_dir_returns_empty() {
        let home = setup_home();
        let base = tempfile::tempdir().expect("base tempdir");

        let files = list_external(base.path(), home.path(), "~/does-not-exist/", 50);
        assert!(files.is_empty());
    }

    #[test]
    fn test_list_external_sorts_dirs_first_then_alpha() {
        let home = tempfile::tempdir().expect("home tempdir");
        fs::write(home.path().join("b.txt"), "").expect("write b.txt");
        fs::create_dir_all(home.path().join("a_dir")).expect("mkdir a_dir");
        fs::write(home.path().join("c.txt"), "").expect("write c.txt");
        fs::create_dir_all(home.path().join("z_dir")).expect("mkdir z_dir");
        let base = tempfile::tempdir().expect("base tempdir");

        let files = list_external(base.path(), home.path(), "~", 50);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert_eq!(names, vec!["~/a_dir", "~/z_dir", "~/b.txt", "~/c.txt"]);
    }

    #[test]
    fn test_list_external_caps_results() {
        let home = tempfile::tempdir().expect("home tempdir");
        for i in 0..10 {
            fs::write(home.path().join(format!("file_{i}.txt")), "").expect("write file");
        }
        let base = tempfile::tempdir().expect("base tempdir");

        let files = list_external(base.path(), home.path(), "~", 3);
        assert_eq!(files.len(), 3);
    }

    #[test]
    fn test_list_external_root_has_no_double_slash() {
        let base = tempfile::tempdir().expect("base tempdir");
        let home = tempfile::tempdir().expect("home tempdir");

        let files = list_external(base.path(), home.path(), "/", 5);
        for f in &files {
            assert!(
                !f.path.contains("//"),
                "path should not contain //: {}",
                f.path
            );
            assert!(
                f.path.starts_with('/'),
                "path should start with /: {}",
                f.path
            );
        }
    }

    #[test]
    fn test_is_external_query_classification() {
        assert!(is_external_query("~/Documents"));
        assert!(is_external_query("/etc"));
        assert!(is_external_query("../sibling"));
        assert!(!is_external_query("src/main.rs"));
        assert!(!is_external_query("skill:debug"));
    }
}
