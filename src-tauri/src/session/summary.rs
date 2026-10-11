//! Background session summaries: after every finished turn a headless `claude -p` call (small model,
//! no tools) merges the turn into the session's bullet list of what the user wants and checks whether the
//! title still fits.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, SessionNotification, SessionUpdate, ToolCallStatus};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use uuid::Uuid;

use crate::session::store;

const MODEL: &str = "haiku";
const TIMEOUT: Duration = Duration::from_secs(120);
/// Longest agent message kept per turn; the rest is cut from the middle.
const MAX_MESSAGE_CHARS: usize = 1_500;
/// Longest transcript handed to the summarizer; the rest is cut from the middle.
const MAX_TRANSCRIPT_CHARS: usize = 16_000;

/// System prompt of the summarizer; `language` is the one the bullets and the title are written in.
fn system_prompt(language: &str) -> String {
    format!(
        "You maintain a running list of what the user wants from a coding session with an AI coding agent: \
their goals, requirements and constraints, never the agent's actions. You write the list and the title in {language}, \
whatever language the user writes in. You answer only with the requested JSON."
    )
}

const OUTPUT_SCHEMA: &str = r#"{"type":"object","properties":{"summary":{"type":"array","items":{"type":"string"}},"title":{"type":["string","null"]}},"required":["summary","title"]}"#;

/// Per-session locks so overlapping turns are summarized one after the other, each seeing the previous result.
#[derive(Default)]
pub struct SummaryRegistry {
    locks: tokio::sync::Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryEvent {
    hunt_session_id: Uuid,
    title: String,
    summary: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SummaryOutput {
    summary: Vec<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
struct CliResult {
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    structured_output: Option<SummaryOutput>,
}

/// Summarizes `turn` (the user prompt and everything the agent sent until it finished) in the background and
/// publishes the new summary and title as `session:summary`. Failures are logged; the summary is best effort.
pub fn schedule(app: AppHandle, hunt_session_id: Uuid, turn: Vec<SessionNotification>) {
    tauri::async_runtime::spawn(async move {
        let lock = {
            let registry = app.state::<SummaryRegistry>();
            let mut locks = registry.locks.lock().await;
            locks.entry(hunt_session_id).or_default().clone()
        };
        let _guard = lock.lock().await;
        if let Err(error) = summarize(&app, hunt_session_id, &turn).await {
            eprintln!("session summary for {hunt_session_id} failed: {error}");
        }
    });
}

async fn summarize(app: &AppHandle, hunt_session_id: Uuid, turn: &[SessionNotification]) -> Result<(), String> {
    let transcript = transcribe(turn);
    if transcript.trim().is_empty() {
        return Ok(());
    }
    let record = store::find_session(app, hunt_session_id)?;
    let language = crate::preferences::ai_language(app);
    let prompt = build_prompt(&record.title, &record.summary, &transcript, &language);
    let output = run_claude(app, &prompt, &language).await?;

    let summary: Vec<String> = output.summary.into_iter().map(|line| line.trim().to_string()).filter(|line| !line.is_empty()).collect();
    let title = output.title.map(|title| title.trim().to_string()).filter(|title| !title.is_empty());

    // The session may have been deleted while the summarizer ran; then there is nothing to update.
    let Some(updated) = store::update_session(app, hunt_session_id, |stored| {
        stored.summary = summary;
        if let Some(title) = title {
            stored.title = title;
        }
    })?
    else {
        return Ok(());
    };

    app.emit("session:summary", SummaryEvent { hunt_session_id, title: updated.title, summary: updated.summary })
        .map_err(|error| error.to_string())
}

fn build_prompt(title: &str, summary: &[String], transcript: &str, language: &str) -> String {
    let bullets = if summary.is_empty() {
        "(none yet)".to_string()
    } else {
        summary.iter().map(|line| format!("- {line}")).collect::<Vec<_>>().join("\n")
    };
    format!(
        "Current session title: \"{title}\"\n\nCurrent summary:\n{bullets}\n\nLatest turn:\n{transcript}\n\n\
Update the summary so it states what the user wants from the whole session including the latest turn:\n\
- 3 to 6 bullets, each a short line of at most 10 words, no trailing period\n\
- every bullet is a goal, requirement or constraint the user has asked for, phrased as the desired outcome\n\
- never list what the agent did: no files read, checks run, tests passed, notes saved or commits made\n\
- keep earlier bullets that still hold, fold in refinements and corrections, replace bullets the latest turn supersedes\n\
- write every bullet in {language}\n\n\
Title: return a new title of at most 6 words in {language} only if the current title no longer describes what the \
session is about; return null to keep it. Never return a new title merely to rephrase the current one or to \
translate it."
    )
}

/// Compact plain-text transcript of a turn: user and agent text plus one line per tool call with its final status.
fn transcribe(turn: &[SessionNotification]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut agent_text = String::new();
    let mut tool_lines: HashMap<String, usize> = HashMap::new();
    let mut tool_status: HashMap<usize, Option<ToolCallStatus>> = HashMap::new();

    let flush_agent = |lines: &mut Vec<String>, agent_text: &mut String| {
        if !agent_text.trim().is_empty() {
            lines.push(format!("Agent: {}", truncate_middle(agent_text.trim(), MAX_MESSAGE_CHARS)));
        }
        agent_text.clear();
    };

    for notification in turn {
        match &notification.update {
            SessionUpdate::UserMessageChunk(chunk) => {
                flush_agent(&mut lines, &mut agent_text);
                lines.push(format!("User: {}", truncate_middle(content_text(&chunk.content).trim(), MAX_MESSAGE_CHARS)));
            }
            SessionUpdate::AgentMessageChunk(chunk) => agent_text.push_str(&content_text(&chunk.content)),
            SessionUpdate::ToolCall(tool_call) => {
                flush_agent(&mut lines, &mut agent_text);
                lines.push(format!("Tool: {}", tool_call.title));
                tool_lines.insert(tool_call.tool_call_id.to_string(), lines.len() - 1);
                tool_status.insert(lines.len() - 1, Some(tool_call.status));
            }
            SessionUpdate::ToolCallUpdate(update) => {
                let id = update.tool_call_id.to_string();
                let index = match tool_lines.get(&id) {
                    Some(index) => *index,
                    None => {
                        flush_agent(&mut lines, &mut agent_text);
                        lines.push(format!("Tool: {}", update.fields.title.clone().unwrap_or_else(|| id.clone())));
                        tool_lines.insert(id, lines.len() - 1);
                        lines.len() - 1
                    }
                };
                if let Some(title) = &update.fields.title {
                    lines[index] = format!("Tool: {title}");
                }
                if update.fields.status.is_some() {
                    tool_status.insert(index, update.fields.status);
                }
            }
            _ => {}
        }
    }
    flush_agent(&mut lines, &mut agent_text);

    for (index, status) in tool_status {
        let suffix = match status {
            Some(ToolCallStatus::Failed) => " [failed]",
            Some(ToolCallStatus::Completed) => "",
            _ => " [unfinished]",
        };
        lines[index].push_str(suffix);
    }

    truncate_middle(&lines.join("\n"), MAX_TRANSCRIPT_CHARS)
}

fn content_text(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(text) => text.text.clone(),
        ContentBlock::Image(_) => "[image]".into(),
        ContentBlock::Audio(_) => "[audio]".into(),
        ContentBlock::ResourceLink(link) => format!("[{}]", link.uri),
        ContentBlock::Resource(_) => "[resource]".into(),
        _ => String::new(),
    }
}

/// Keeps the first and last part of `text` when it exceeds `max_chars`, marking the cut.
fn truncate_middle(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let keep = max_chars / 2;
    let head: String = text.chars().take(keep).collect();
    let tail: String = text.chars().skip(count - keep).collect();
    format!("{head}\n[… {} characters cut …]\n{tail}", count - 2 * keep)
}

/// Runs `claude -p` with tools disabled and the output schema enforced; the prompt goes in via stdin.
async fn run_claude(app: &AppHandle, prompt: &str, language: &str) -> Result<SummaryOutput, String> {
    let cwd = store::app_data_dir(app)?;
    let mut child = Command::new("claude")
        .args(["-p", "--model", MODEL, "--no-session-persistence", "--setting-sources", "", "--tools", ""])
        .args(["--output-format", "json", "--json-schema", OUTPUT_SCHEMA, "--system-prompt", &system_prompt(language)])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start claude: {error}"))?;

    let mut stdin = child.stdin.take().ok_or("claude stdin is not available")?;
    stdin.write_all(prompt.as_bytes()).await.map_err(|error| error.to_string())?;
    drop(stdin);

    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "claude did not answer in time".to_string())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("claude exited with {}: {}", output.status, String::from_utf8_lossy(&output.stderr).trim()));
    }

    parse_output(&String::from_utf8_lossy(&output.stdout))
}

/// Reads the structured output of a `--output-format json` result; falls back to parsing the text result as JSON.
fn parse_output(stdout: &str) -> Result<SummaryOutput, String> {
    let result: CliResult = serde_json::from_str(stdout.trim()).map_err(|error| format!("unexpected claude output: {error}"))?;
    if let Some(output) = result.structured_output {
        return Ok(output);
    }
    let text = result.result.unwrap_or_default();
    if result.is_error {
        return Err(format!("claude reported an error: {text}"));
    }
    serde_json::from_str(text.trim().trim_start_matches("```json").trim_end_matches("```").trim())
        .map_err(|error| format!("summary is not valid JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ContentChunk, SessionId, TextContent, ToolCall, ToolCallUpdate, ToolCallUpdateFields, ToolKind};

    fn note(update: SessionUpdate) -> SessionNotification {
        SessionNotification::new(SessionId::new("acp"), update)
    }

    fn text(text: &str) -> ContentChunk {
        ContentChunk::new(ContentBlock::Text(TextContent::new(text)))
    }

    #[test]
    fn transcribes_a_turn_with_merged_agent_text_and_tool_status() {
        let turn = vec![
            note(SessionUpdate::UserMessageChunk(text("Fix the login bug"))),
            note(SessionUpdate::AgentMessageChunk(text("Looking "))),
            note(SessionUpdate::AgentMessageChunk(text("at login.ts now."))),
            note(SessionUpdate::ToolCall(ToolCall::new("call-1", "Edit login.ts").kind(ToolKind::Edit))),
            note(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                "call-1",
                ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
            ))),
            note(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                "call-2",
                ToolCallUpdateFields::new().title("Run tests".to_string()).status(ToolCallStatus::Failed),
            ))),
            note(SessionUpdate::AgentMessageChunk(text("Done."))),
        ];

        assert_eq!(
            transcribe(&turn),
            "User: Fix the login bug\nAgent: Looking at login.ts now.\nTool: Edit login.ts\nTool: Run tests [failed]\nAgent: Done."
        );
    }

    #[test]
    fn parses_structured_output_and_falls_back_to_result_text() {
        let structured = r#"{"is_error":false,"result":"ignored","structured_output":{"summary":["a","b"],"title":null}}"#;
        let output = parse_output(structured).unwrap();
        assert_eq!(output.summary, vec!["a", "b"]);
        assert_eq!(output.title, None);

        let plain = r#"{"is_error":false,"result":"```json\n{\"summary\":[\"c\"],\"title\":\"New\"}\n```"}"#;
        let output = parse_output(plain).unwrap();
        assert_eq!(output.summary, vec!["c"]);
        assert_eq!(output.title.as_deref(), Some("New"));

        let failed = r#"{"is_error":true,"result":"Not logged in"}"#;
        assert!(parse_output(failed).unwrap_err().contains("Not logged in"));
    }

    #[test]
    fn truncates_long_text_from_the_middle() {
        let truncated = truncate_middle(&"x".repeat(100), 20);
        assert!(truncated.starts_with(&"x".repeat(10)));
        assert!(truncated.ends_with(&"x".repeat(10)));
        assert!(truncated.contains("80 characters cut"));
        assert_eq!(truncate_middle("short", 20), "short");
    }
}
