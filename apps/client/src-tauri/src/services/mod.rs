//! The services a repository's `hunt.json` declares, which a local session runs in windows of its family's tmux server
//! (`services.rs`), re-exported here.

mod services;

pub use services::*;
