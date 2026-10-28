//! Git: the operations on a session's worktree through the `git` CLI (`git.rs`, re-exported here), the paths that must
//! stay inside a worktree (`worktree_relative_path.rs`, re-exported here) and the ignored files a worktree gets from the
//! repository's checkout (`private_files.rs`).

mod git;
pub mod private_files;
mod worktree_relative_path;

pub use git::*;
pub use worktree_relative_path::{ensure_inside_worktree, WorktreeRelativePath};
