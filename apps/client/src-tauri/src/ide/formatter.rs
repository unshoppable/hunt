//! Formats a file with the Prettier its project installs, through `apps/client/scripts/prettier.mjs` on the `node` of
//! PATH, so the project's Prettier version, config and plugins apply as on its command line.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const SCRIPT: &str = "apps/client/scripts/prettier.mjs";
const TIMEOUT: Duration = Duration::from_secs(30);

/// What Prettier made of a file: `installed` is false when no Prettier resolves from it, `formatted` is `None` when
/// Prettier ignores the file or has no parser for it.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrettierOutput {
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub formatted: Option<String>,
    #[serde(default, skip_serializing)]
    error: Option<String>,
}

/// Formats `text` as the content of `file` in `worktree` with the script at `script`.
pub async fn format_with_prettier(script: &Path, worktree: &Path, file: &Path, text: &str) -> Result<PrettierOutput, String> {
    let input = json!({ "worktree": worktree, "filePath": file, "text": text }).to_string();
    let mut child = Command::new("node")
        .arg(script)
        .current_dir(worktree)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start node: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("failed to format with Prettier: node stdin is not available")?;
    stdin.write_all(input.as_bytes()).await.map_err(|error| format!("failed to format with Prettier: {error}"))?;
    drop(stdin);

    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "failed to format with Prettier: no answer in time".to_string())?
        .map_err(|error| format!("failed to format with Prettier: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("failed to format with Prettier: node exited with {}: {}", output.status, stderr.trim()));
    }
    parse_output(&output.stdout)
}

fn parse_output(stdout: &[u8]) -> Result<PrettierOutput, String> {
    let output: PrettierOutput = serde_json::from_slice(stdout).map_err(|error| format!("failed to format with Prettier: {error}"))?;
    match output.error {
        Some(error) => Err(format!("failed to format with Prettier: {error}")),
        None => Ok(output),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_formatted_text_ignored_files_and_errors() {
        let formatted = parse_output(br#"{"installed":true,"formatted":"a;\n"}"#).unwrap();
        assert!(formatted.installed);
        assert_eq!(formatted.formatted.as_deref(), Some("a;\n"));
        let ignored = parse_output(br#"{"installed":true,"formatted":null}"#).unwrap();
        assert!(ignored.installed && ignored.formatted.is_none());
        assert!(!parse_output(br#"{"installed":false}"#).unwrap().installed);
        assert_eq!(parse_output(br#"{"error":"Expression expected. (1:12)"}"#).unwrap_err(), "failed to format with Prettier: Expression expected. (1:12)");
    }
}
