//! Diagram generation in the background: every request runs its own headless `claude -p` process in the session's
//! local worktree, which writes the diagram of one type into `.hunt/`. The session's chat agent takes no part, so it
//! may run a turn or be stopped meanwhile. A remote session's diagram is generated on this Mac as well: the file sync
//! keeps its local worktree in step with the VM and leaves `.hunt/` out, so the file stays where the panel reads it.

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

use crate::accounts;
use crate::graph::{self, DiagramType};
use crate::session::store::SessionRecord;

const TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Tools the diagram agent may use without asking: reading the worktree, the read-only git commands the prompts name
/// and writing inside `.hunt/`. In the `dontAsk` permission mode every other tool call is denied.
const ALLOWED_TOOLS: [&str; 8] =
    ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git ls-files:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)"];

/// The diagrams being generated, as pairs of Hunt session ID and diagram type; one run per pair at a time.
#[derive(Default)]
pub struct DiagramRuns(Mutex<HashSet<(Uuid, DiagramType)>>);

/// Takes its pair out of `DiagramRuns` when the run ends, however it ends.
struct RunClaim<'a> {
    runs: &'a DiagramRuns,
    key: (Uuid, DiagramType),
}

impl Drop for RunClaim<'_> {
    fn drop(&mut self) {
        self.runs.0.lock().unwrap().remove(&self.key);
    }
}

#[derive(Deserialize)]
struct CliResult {
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: Option<String>,
}

/// Generates the diagram of `diagram_type` for the session `record` with the standard prompt plus the user's
/// `instructions` for this run, on `model` with `effort`, and tells every window about the new file. Resolves once the
/// agent finished; fails when the same diagram of the session is already being generated.
pub async fn generate(
    app: &AppHandle,
    record: &SessionRecord,
    diagram_type: DiagramType,
    instructions: &str,
    model: &str,
    effort: &str,
) -> Result<(), String> {
    let runs = app.state::<DiagramRuns>();
    let key = (record.id, diagram_type);
    if !runs.0.lock().unwrap().insert(key) {
        return Err("failed to generate the diagram: it is already being generated".into());
    }
    let _claim = RunClaim { runs: &runs, key };

    graph::prepare_dir(&record.worktree_path)?;
    let language = crate::preferences::ai_language(app);
    let prompt = graph::refresh_prompt(diagram_type, &language, record.diff_base(), instructions.trim());
    let mut command = Command::new("claude");
    if let Some(token) = accounts::active_token(app).await? {
        command.env(accounts::TOKEN_ENV, token);
    }
    let mut child = command
        .args(claude_args(model, effort, &graph::system_prompt(&language)))
        .current_dir(&record.worktree_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start claude: {error}"))?;

    let mut stdin = child.stdin.take().ok_or("failed to generate the diagram: claude stdin is not available")?;
    stdin.write_all(prompt.as_bytes()).await.map_err(|error| format!("failed to send the diagram prompt: {error}"))?;
    drop(stdin);

    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "failed to generate the diagram: claude did not finish within 30 minutes".to_string())?
        .map_err(|error| format!("failed to generate the diagram: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    match serde_json::from_str::<CliResult>(stdout.trim()) {
        Ok(result) if result.is_error => {
            return Err(format!("failed to generate the diagram: {}", result.result.unwrap_or_default().trim()));
        }
        Ok(_) if output.status.success() => {}
        _ => return Err(format!("failed to generate the diagram: claude exited with {}: {}", output.status, String::from_utf8_lossy(&output.stderr).trim())),
    }

    graph::emit_changed(app, record.id);
    Ok(())
}

/// Arguments of the `claude -p` run: the diagram model and effort, no MCP servers and no stored transcript, the diagram
/// instructions appended to the system prompt, JSON output and the permissions of `ALLOWED_TOOLS` plus writes into
/// `.hunt/`, everything else denied without a prompt.
fn claude_args(model: &str, effort: &str, system_prompt: &str) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--model", model, "--effort", effort, "--no-session-persistence", "--strict-mcp-config"]
        .into_iter()
        .map(String::from)
        .collect();
    args.extend(["--append-system-prompt".into(), system_prompt.into(), "--output-format".into(), "json".into()]);
    args.extend(["--permission-mode".into(), "dontAsk".into(), "--allowedTools".into()]);
    args.extend(ALLOWED_TOOLS.iter().map(|tool| tool.to_string()));
    args.extend(["Write", "Edit"].map(|tool| format!("{tool}(./{}/**)", graph::GRAPH_DIR)));
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_args_deny_everything_but_reading_git_and_writing_the_diagram_folder() {
        let args = claude_args("claude-opus-5-5", "high", "diagram rules");
        let after = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].as_str();
        assert_eq!(after("--model"), "claude-opus-5-5");
        assert_eq!(after("--effort"), "high");
        assert_eq!(after("--append-system-prompt"), "diagram rules");
        assert_eq!(after("--permission-mode"), "dontAsk");
        let allowed = &args[args.iter().position(|arg| arg == "--allowedTools").unwrap() + 1..];
        assert!(allowed.contains(&"Write(./.hunt/**)".to_string()) && allowed.contains(&"Edit(./.hunt/**)".to_string()));
        assert!(allowed.iter().all(|tool| !tool.starts_with('-')), "the tool list must end the arguments: {allowed:?}");
        assert!(!allowed.iter().any(|tool| tool == "Bash" || tool == "Write" || tool == "Edit"));
    }
}
