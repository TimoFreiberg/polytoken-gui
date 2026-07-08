//! Parsing the daemon's `GET /files` response into pantoken's `FileInfo[]`.
//!
//! Port of `server/src/polytoken/file-catalog.ts`.
//!
//! GET /files returns `{files: string[]}` — project-relative paths, alphabetical,
//! with a trailing `/` on directories (the OpenAPI FileCatalogResponse).
//! This is the daemon-native @-mention index that replaces pantoken's `fd`-based
//! index under the polytoken driver. The daemon is ignore-aware (.gitignore,
//! .claudeignore, .polytokenignore) and excludes dotfiles + the project private
//! dir, so the set is already bounded — pantoken just splits the trailing-`/` dir
//! marker. Belt-and-suspenders: drop stray `.git` entries (the daemon excludes
//! them, but a config edge case shouldn't leak them into the menu).
//!
//! Pure — unit-testable without a daemon. Extracted from the driver so the parse
//! path is tested in isolation (mirrors the models.ts / commands.ts pattern).

use pantoken_protocol::session_driver::FileInfo;

/// Parse the daemon's GET /files string list (dirs trailing `/`) into
/// `FileInfo[]`. The daemon already normalizes to forward slashes + alphabetical
/// order; we just split the trailing-`/` dir marker. Drops stray `.git` entries
/// defensively.
pub fn parse_file_catalog(paths: &[String]) -> Vec<FileInfo> {
    let mut out: Vec<FileInfo> = Vec::new();
    for p in paths {
        if p.is_empty() {
            continue;
        }
        let is_directory = p.ends_with('/');
        let path = if is_directory {
            &p[..p.len() - 1]
        } else {
            p.as_str()
        };
        if path == ".git" || path.starts_with(".git/") || path.contains("/.git/") {
            continue;
        }
        out.push(FileInfo {
            path: path.to_string(),
            is_directory,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> String {
        v.to_string()
    }

    #[test]
    fn splits_files_from_dirs_by_trailing_slash() {
        let input = vec![s("src/main.ts"), s("src/lib/"), s("README.md"), s("docs/")];
        let out = parse_file_catalog(&input);
        assert_eq!(out.len(), 4);
        assert_eq!(out[0].path, "src/main.ts");
        assert!(!out[0].is_directory);
        assert_eq!(out[1].path, "src/lib");
        assert!(out[1].is_directory);
        assert_eq!(out[2].path, "README.md");
        assert!(!out[2].is_directory);
        assert_eq!(out[3].path, "docs");
        assert!(out[3].is_directory);
    }

    #[test]
    fn drops_stray_git_entries_defensively() {
        let input = vec![
            s(".git"),
            s(".git/config"),
            s("src/.git/hooks"),
            s("src/main.ts"),
        ];
        let out = parse_file_catalog(&input);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "src/main.ts");
        assert!(!out[0].is_directory);
    }

    #[test]
    fn empty_input_yields_empty() {
        let out = parse_file_catalog(&[]);
        assert!(out.is_empty());
    }

    #[test]
    fn empty_entries_are_skipped() {
        let input = vec![s(""), s("valid.ts")];
        let out = parse_file_catalog(&input);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "valid.ts");
    }

    #[test]
    fn root_level_directory_with_trailing_slash() {
        let input = vec![s("node_modules/")];
        let out = parse_file_catalog(&input);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "node_modules");
        assert!(out[0].is_directory);
    }
}
