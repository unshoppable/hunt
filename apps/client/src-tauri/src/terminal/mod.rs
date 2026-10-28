//! Terminals on this Mac: programs in a pseudo terminal and the open ones (`interactive.rs`), the tmux of a session
//! family (`tmux.rs`) and the user's shell, which opens a worktree in the terminal app and runs the command lines of a
//! local session (`user_shell.rs`, re-exported here).

pub mod interactive;
pub mod tmux;
mod user_shell;

pub use user_shell::*;
