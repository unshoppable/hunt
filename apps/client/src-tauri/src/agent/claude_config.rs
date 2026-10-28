//! Where Claude Code keeps its configuration on this Mac.

use std::path::PathBuf;

/// Claude Code's configuration folder on this Mac, where transcripts, the global `CLAUDE.md` and skills live.
pub fn claude_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME").map_err(|_| "failed to find the home folder: HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".claude"))
}
