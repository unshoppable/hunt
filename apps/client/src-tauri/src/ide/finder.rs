//! Shows paths in the Finder.

use std::path::Path;
use std::process::Stdio;

use tokio::process::Command;

/// Opens a Finder window on the folder holding `path` with `path` selected, and brings the Finder to the front.
pub async fn reveal_in_finder(path: &Path) -> Result<(), String> {
    let output = Command::new("open")
        .arg("-R")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("failed to reveal {} in the Finder: {error}", path.display()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!("failed to reveal {} in the Finder: {}", path.display(), String::from_utf8_lossy(&output.stderr).trim()))
}
