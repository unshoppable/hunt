//! The editor side: the shared documents and the atomic writes of their files (`disk_file.rs`), the line diff of the
//! change markers and the diff views (`line_diff.rs`), language servers, worktree access, Find in Files, Prettier and
//! ESLint rules of the built-in editor, and opening paths in WebStorm (`webstorm.rs`, re-exported here).

pub mod disk_file;
pub mod documents;
pub mod find_in_files;
pub mod formatter;
pub mod line_diff;
pub mod lint_rules;
pub mod lsp;
mod webstorm;
pub mod workspace;

pub use webstorm::*;
