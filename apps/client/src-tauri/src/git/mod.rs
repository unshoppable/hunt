//! Git: the operations on a session's worktree through the `git` CLI (`git.rs`, re-exported here), the paths that must
//! stay inside a worktree (`worktree_relative_path.rs`, re-exported here), the ignored files a worktree gets from the
//! repository's checkout (`private_files.rs`) and the one file watch per worktree that everything following its files
//! shares (`worktree_watcher.rs`), and the runs that concurrent callers share (`single_flight.rs`), through which every
//! caller reads a worktree's changelist.

mod git;
pub mod private_files;
mod single_flight;
mod worktree_relative_path;
pub mod worktree_watcher;

pub use git::*;
pub use worktree_relative_path::{ensure_inside_worktree, WorktreeRelativePath};
