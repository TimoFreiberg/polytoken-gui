//! Worktree metadata shared by worktree creation/removal and the persisted store.
//!
//! Minimal Phase 2 subset of `server/src/shared/worktree.ts`.

use serde::{Deserialize, Serialize};

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

// Phase 3: planners + jj/git spawn helpers.
