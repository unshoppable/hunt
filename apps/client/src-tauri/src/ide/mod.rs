//! The editor side: the shared documents, language servers, worktree access, Find in Files, Prettier and ESLint rules
//! of the built-in editor, and opening paths in WebStorm (`webstorm.rs`, re-exported here).

pub mod documents;
pub mod find_in_files;
pub mod formatter;
pub mod lint_rules;
pub mod lsp;
mod webstorm;
pub mod workspace;

pub use webstorm::*;
