//! Create/remove isolated jj/git worktrees for pilot sessions.
//!
//! Command/path planning is pure (unit-tested); only the create/remove/clean helpers
//! touch disk + spawn the VCS.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::worktree_name::random_worktree_name;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Vcs {
    Jj,
    Git,
}

/// A pilot-created worktree, recorded at creation so it can later be flagged in the
/// sidebar and cleaned up. `path` is the worktree dir (== the session's cwd); `base`
/// is the repo it was forked from; `name` is the jj workspace name (unused for git).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeMeta {
    pub path: String,
    pub base: String,
    pub vcs: Vcs,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreePlan {
    pub path: String,
    pub command: String,
    pub args: Vec<String>,
    pub name: String,
    pub base: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRemovalPlan {
    pub command: String,
    pub args: Vec<String>,
    pub remove_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoveResult {
    pub removed: bool,
    pub reason: Option<String>,
}

/// Detect the VCS backing a directory. Prefers jj when a repo is colocated jj+git.
pub fn detect_vcs(repo_dir: impl AsRef<Path>) -> Option<Vcs> {
    let repo_dir = repo_dir.as_ref();
    if repo_dir.join(".jj").exists() {
        return Some(Vcs::Jj);
    }
    if repo_dir.join(".git").exists() {
        return Some(Vcs::Git);
    }
    None
}

/// Pure: plan the worktree path + the command to create it. The worktree is a
/// sibling dir of the repo.
pub fn plan_worktree(repo_dir: impl AsRef<Path>, vcs: Vcs, id: &str) -> WorktreePlan {
    let base = resolve_lexical(repo_dir.as_ref());
    let name = format!("pilot-{id}");
    let path = format!("{base}-{id}");

    match vcs {
        Vcs::Jj => WorktreePlan {
            path: path.clone(),
            command: "jj".to_string(),
            args: vec![
                "-R".to_string(),
                base.clone(),
                "workspace".to_string(),
                "add".to_string(),
                "--name".to_string(),
                name.clone(),
                path,
            ],
            name,
            base,
        },
        Vcs::Git => WorktreePlan {
            path: path.clone(),
            command: "git".to_string(),
            args: vec![
                "-C".to_string(),
                base.clone(),
                "worktree".to_string(),
                "add".to_string(),
                "--detach".to_string(),
                path,
            ],
            name,
            base,
        },
    }
}

/// Pure: plan how to tear a worktree down.
pub fn plan_worktree_removal(meta: &WorktreeMeta, force: bool) -> WorktreeRemovalPlan {
    match meta.vcs {
        Vcs::Jj => WorktreeRemovalPlan {
            command: "jj".to_string(),
            args: vec![
                "-R".to_string(),
                meta.base.clone(),
                "workspace".to_string(),
                "forget".to_string(),
                meta.name.clone(),
            ],
            remove_dir: true,
        },
        Vcs::Git => {
            let mut args = vec![
                "-C".to_string(),
                meta.base.clone(),
                "worktree".to_string(),
                "remove".to_string(),
            ];
            if force {
                args.push("--force".to_string());
            }
            args.push(meta.path.clone());
            WorktreeRemovalPlan {
                command: "git".to_string(),
                args,
                remove_dir: false,
            }
        }
    }
}

/// Pick a worktree plan whose sibling dir doesn't already exist.
pub fn plan_fresh_worktree(repo_dir: impl AsRef<Path>, vcs: Vcs) -> WorktreePlan {
    let repo_dir = repo_dir.as_ref();
    for _ in 0..10 {
        let plan = plan_worktree(repo_dir, vcs.clone(), &random_worktree_name());
        if !Path::new(&plan.path).exists() {
            return plan;
        }
    }

    let fallback = format!("{}-{}", random_worktree_name(), now_base36());
    plan_worktree(repo_dir, vcs, &fallback)
}

/// Create an isolated worktree of `repo_dir` and return its metadata.
pub async fn create(repo_dir: impl AsRef<Path>, id: Option<&str>) -> Result<WorktreeMeta, String> {
    let repo_dir = repo_dir.as_ref();
    let vcs = detect_vcs(repo_dir).ok_or_else(|| {
        format!(
            "cannot create a worktree: {} is not a jj or git repository",
            repo_dir.display()
        )
    })?;
    let plan = match id {
        Some(id) => plan_worktree(repo_dir, vcs.clone(), id),
        None => plan_fresh_worktree(repo_dir, vcs.clone()),
    };

    run(&plan.command, &plan.args).await?;
    Ok(WorktreeMeta {
        path: plan.path,
        base: plan.base,
        vcs,
        name: plan.name,
    })
}

/// True if the worktree has no changes that removal would destroy. Returns false if
/// the check itself errors.
pub async fn is_clean(meta: &WorktreeMeta) -> bool {
    let output = match meta.vcs {
        Vcs::Git => {
            Command::new("git")
                .args(["-C", &meta.path, "status", "--porcelain"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await
        }
        Vcs::Jj => {
            let mut cmd = Command::new("jj");
            cmd.args(["diff", "--name-only"])
                .current_dir(&meta.path)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            cmd.output().await
        }
    };

    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().is_empty()
        }
        _ => false,
    }
}

/// Remove a pilot-created worktree.
pub async fn remove(meta: &WorktreeMeta, force: bool) -> Result<RemoveResult, String> {
    if !force && !is_clean(meta).await {
        return Ok(RemoveResult {
            removed: false,
            reason: Some("worktree has uncommitted changes".to_string()),
        });
    }

    let plan = plan_worktree_removal(meta, force);
    run(&plan.command, &plan.args).await?;
    if plan.remove_dir {
        match tokio::fs::remove_dir_all(&meta.path).await {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("failed to remove {}: {err}", meta.path)),
        }
    }

    Ok(RemoveResult {
        removed: true,
        reason: None,
    })
}

async fn run(command: &str, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(command);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|err| format!("failed to run {command}: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "{command} {} failed with status {}{}{}",
            args.join(" "),
            output.status,
            if detail.is_empty() { "" } else { ": " },
            detail
        ));
    }
    Ok(())
}

fn resolve_lexical(path: &Path) -> String {
    let mut absolute = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir()
            .expect("current_dir() failed while resolving a relative worktree base path")
    };

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                absolute.pop();
            }
            other => absolute.push(other.as_os_str()),
        }
    }

    absolute.to_string_lossy().trim_end_matches('/').to_string()
}

fn now_base36() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    to_base36(millis)
}

fn to_base36(mut n: u128) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while n > 0 {
        let digit = (n % 36) as u8;
        chars.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        n /= 36;
    }
    chars.iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn detect_vcs_prefers_jj_over_git() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".jj")).unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();

        assert_eq!(detect_vcs(dir.path()), Some(Vcs::Jj));
    }

    #[test]
    fn detect_vcs_finds_git_and_returns_none_for_non_repo() {
        let git_dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(git_dir.path().join(".git")).unwrap();
        assert_eq!(detect_vcs(git_dir.path()), Some(Vcs::Git));

        let plain_dir = tempfile::tempdir().unwrap();
        assert_eq!(detect_vcs(plain_dir.path()), None);
    }

    #[test]
    fn plan_worktree_jj_workspace_add_at_sibling_path_with_unique_name() {
        let p = plan_worktree("/Users/x/repo", Vcs::Jj, "abc");

        assert_eq!(p.path, "/Users/x/repo-abc");
        assert_eq!(p.command, "jj");
        assert_eq!(
            p.args,
            strings(&[
                "-R",
                "/Users/x/repo",
                "workspace",
                "add",
                "--name",
                "pilot-abc",
                "/Users/x/repo-abc",
            ])
        );
    }

    #[test]
    fn plan_worktree_git_detached_worktree_at_sibling_path() {
        let p = plan_worktree("/Users/x/repo/", Vcs::Git, "xy");

        assert_eq!(p.path, "/Users/x/repo-xy");
        assert_eq!(p.command, "git");
        assert_eq!(
            p.args,
            strings(&[
                "-C",
                "/Users/x/repo",
                "worktree",
                "add",
                "--detach",
                "/Users/x/repo-xy",
            ])
        );
    }

    #[test]
    fn plan_worktree_exposes_name_and_base_for_worktree_index() {
        let p = plan_worktree("/Users/x/repo", Vcs::Jj, "abc");

        assert_eq!(p.name, "pilot-abc");
        assert_eq!(p.base, "/Users/x/repo");
    }

    #[test]
    fn plan_worktree_removal_jj_forgets_workspace_and_caller_removes_dir() {
        let meta = WorktreeMeta {
            path: "/Users/x/repo-abc".to_string(),
            base: "/Users/x/repo".to_string(),
            vcs: Vcs::Jj,
            name: "pilot-abc".to_string(),
        };

        let p = plan_worktree_removal(&meta, false);

        assert_eq!(p.command, "jj");
        assert_eq!(
            p.args,
            strings(&["-R", "/Users/x/repo", "workspace", "forget", "pilot-abc",])
        );
        assert!(p.remove_dir);
    }

    #[test]
    fn plan_worktree_removal_git_worktree_remove_deletes_dir_itself() {
        let meta = git_meta();

        let p = plan_worktree_removal(&meta, false);

        assert_eq!(p.command, "git");
        assert_eq!(
            p.args,
            strings(&[
                "-C",
                "/Users/x/repo",
                "worktree",
                "remove",
                "/Users/x/repo-xy"
            ])
        );
        assert!(!p.remove_dir);
    }

    #[test]
    fn plan_worktree_removal_git_force_adds_force_to_discard_dirty_worktree() {
        let meta = git_meta();

        let p = plan_worktree_removal(&meta, true);

        assert!(p.args.contains(&"--force".to_string()));
    }

    #[tokio::test]
    async fn git_integration_create_clean_and_remove_spawn_path() {
        if Command::new("git").arg("--version").output().await.is_err() {
            eprintln!("skipping git integration test: git executable is unavailable");
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]).await;
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        git(&repo, &["add", "README.md"]).await;
        git(
            &repo,
            &[
                "-c",
                "user.email=pilot@example.test",
                "-c",
                "user.name=Pilot Test",
                "commit",
                "-m",
                "initial",
            ],
        )
        .await;

        let meta = create(&repo, Some("spawn")).await.unwrap();
        assert_eq!(meta.vcs, Vcs::Git);
        assert!(Path::new(&meta.path).is_dir());
        assert!(is_clean(&meta).await);

        std::fs::write(Path::new(&meta.path).join("dirty.txt"), "dirty\n").unwrap();
        assert!(!is_clean(&meta).await);

        let blocked = remove(&meta, false).await.unwrap();
        assert!(!blocked.removed);
        assert_eq!(
            blocked.reason.as_deref(),
            Some("worktree has uncommitted changes")
        );
        assert!(Path::new(&meta.path).is_dir());

        let removed = remove(&meta, true).await.unwrap();
        assert!(removed.removed);
        assert!(removed.reason.is_none());
        assert!(!Path::new(&meta.path).exists());

        let list = Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "list",
                "--porcelain",
            ])
            .output()
            .await
            .unwrap();
        assert!(list.status.success());
        let stdout = String::from_utf8_lossy(&list.stdout);
        assert!(!stdout.contains(&meta.path));
    }

    async fn git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git -C {} {} failed: {}",
            repo.display(),
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_meta() -> WorktreeMeta {
        WorktreeMeta {
            path: "/Users/x/repo-xy".to_string(),
            base: "/Users/x/repo".to_string(),
            vcs: Vcs::Git,
            name: "pilot-xy".to_string(),
        }
    }
}
