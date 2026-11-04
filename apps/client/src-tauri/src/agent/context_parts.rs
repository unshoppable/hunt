//! The text of a session agent's context window, rebuilt from its Claude Code transcript as a list of parts: the system
//! prompt and the tool definitions of the transcript's last prompt snapshot, then everything since the last compaction —
//! the instruction files, skills and other system reminders Claude Code attached, the prompts, the replies with their
//! thinking, and each tool call with its result. A rebuild, not what went over the wire byte for byte: Claude Code wraps
//! reminders in tags and drops old thinking when it sends a request.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::loaded_context::SKILL_MARKER;

/// What a part of the context is.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PartKind {
    SystemPrompt,
    Tools,
    /// A `CLAUDE.md`, rule or memory file Claude Code loaded.
    Instructions,
    /// Any other text Claude Code added, e.g. the skill listing or the MCP server instructions.
    Reminder,
    Skill,
    /// The summary a compaction left of the conversation before it.
    Summary,
    User,
    Assistant,
    Thinking,
    ToolCall,
    ToolResult,
}

/// One part of the context; mirrored by `ContextPart` in `src/chat/loaded-context/loaded-context.types.ts`.
#[derive(Serialize, Debug, PartialEq)]
pub struct ContextPart {
    pub kind: PartKind,
    pub title: String,
    pub text: String,
}

impl ContextPart {
    fn new(kind: PartKind, title: impl Into<String>, text: impl Into<String>) -> Self {
        ContextPart { kind, title: title.into(), text: text.into() }
    }
}

/// The parts of the context the transcript at `transcript` holds; none while it does not exist.
pub fn read(transcript: &Path) -> Result<Vec<ContextPart>, String> {
    match std::fs::read_to_string(transcript) {
        Ok(jsonl) => Ok(parse(&jsonl)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("failed to read the transcript {}: {error}", transcript.display())),
    }
}

fn parse(jsonl: &str) -> Vec<ContextPart> {
    let mut system_prompt = None;
    let mut tools = None;
    let mut parts = Vec::new();
    // The name of each tool call by its id, for the title of its result.
    let mut tool_names: HashMap<String, String> = HashMap::new();
    for line in jsonl.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        match entry["type"].as_str() {
            Some("system") if entry["subtype"] == "compact_boundary" => parts.clear(),
            Some("attachment") if entry["attachment"]["type"] == "prompt_snapshot" => {
                let snapshot = &entry["attachment"];
                system_prompt = system_prompt_part(&snapshot["systemPrompt"]).or(system_prompt);
                tools = tools_part(&snapshot["tools"]).or(tools);
            }
            Some("attachment") => parts.extend(attachment_parts(&entry["attachment"])),
            Some("user") => parts.extend(user_parts(&entry, &tool_names)),
            Some("assistant") => {
                for block in entry["message"]["content"].as_array().into_iter().flatten() {
                    if let (Some("tool_use"), Some(id), Some(name)) = (block["type"].as_str(), block["id"].as_str(), block["name"].as_str()) {
                        tool_names.insert(id.to_string(), name.to_string());
                    }
                    parts.extend(assistant_part(block));
                }
            }
            _ => {}
        }
    }
    system_prompt.into_iter().chain(tools).chain(parts).collect()
}

fn system_prompt_part(prompt: &Value) -> Option<ContextPart> {
    let sections: Vec<&str> = prompt.as_array()?.iter().filter_map(Value::as_str).map(str::trim).filter(|section| !section.is_empty()).collect();
    (!sections.is_empty()).then(|| ContextPart::new(PartKind::SystemPrompt, "System prompt", sections.join("\n\n")))
}

/// The tool definitions as one part: each tool's name as heading, its description and its other fields as JSON.
fn tools_part(tools: &Value) -> Option<ContextPart> {
    let tools = tools.as_array().filter(|tools| !tools.is_empty())?;
    let text = tools
        .iter()
        .map(|tool| {
            let mut rest = tool.as_object().cloned().unwrap_or_default();
            let name = rest.remove("name").and_then(|name| name.as_str().map(String::from)).unwrap_or_default();
            let description = rest.remove("description").and_then(|description| description.as_str().map(String::from)).unwrap_or_default();
            format!("## {name}\n\n{}\n\n{}", description.trim(), pretty(&Value::Object(rest)))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    Some(ContextPart::new(PartKind::Tools, format!("Tool definitions ({})", tools.len()), text))
}

/// The parts an attachment entry adds; attachments without text add none.
fn attachment_parts(attachment: &Value) -> Vec<ContextPart> {
    let reminder = |title: &str, text: String| (!text.trim().is_empty()).then(|| ContextPart::new(PartKind::Reminder, title, text)).into_iter().collect();
    let joined = |lines: &Value, separator: &str| lines.as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(separator);
    match attachment["type"].as_str().unwrap_or_default() {
        "instructions" => attachment["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|file| ContextPart::new(PartKind::Instructions, text_of(&file["path"]), text_of(&file["content"])))
            .collect(),
        "nested_memory" => vec![ContextPart::new(PartKind::Instructions, text_of(&attachment["path"]), text_of(&attachment["content"]["content"]))],
        "invoked_skills" => attachment["skills"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|skill| ContextPart::new(PartKind::Skill, text_of(&skill["name"]), text_of(&skill["content"])))
            .collect(),
        "skill_listing" => reminder("Skill listing", text_of(&attachment["content"])),
        "mcp_instructions_delta" => reminder("MCP server instructions", joined(&attachment["addedBlocks"], "\n\n")),
        "agent_listing_delta" => reminder("Agent types", joined(&attachment["addedLines"], "\n")),
        "deferred_tools_delta" => reminder("Deferred tools", joined(&attachment["addedLines"], "\n")),
        "session_context" => reminder("Session context", attachment["context"].as_object().into_iter().flatten().map(|(_, text)| text_of(text)).collect::<Vec<_>>().join("\n\n")),
        "model" => reminder("Model", text_of(&attachment["text"])),
        "output_style_instructions" => reminder("Output style", text_of(&attachment["style"]["prompt"])),
        "date" => reminder("Date", text_of(&attachment["date"])),
        "environment" => reminder("Environment", pretty(&attachment["snapshot"])),
        other => reminder(other, text_of(&attachment["content"])),
    }
}

/// The parts of a user entry: a prompt, a skill's text, a reminder Claude Code added, a compaction's summary, or the
/// results of tool calls.
fn user_parts(entry: &Value, tool_names: &HashMap<String, String>) -> Vec<ContextPart> {
    let content = &entry["message"]["content"];
    if entry["isCompactSummary"] == true {
        return vec![ContextPart::new(PartKind::Summary, "Summary of the compacted conversation", blocks_text(content))];
    }
    if entry["isMeta"] == true {
        let text = blocks_text(content);
        let skill = text.strip_prefix(SKILL_MARKER).and_then(|rest| rest.lines().next()).map(|folder| folder.trim().rsplit('/').next().unwrap_or_default().to_string());
        return vec![match skill {
            Some(name) => ContextPart::new(PartKind::Skill, name, text),
            None => ContextPart::new(PartKind::Reminder, "Added to the prompt", text),
        }];
    }
    let Some(blocks) = content.as_array() else { return vec![ContextPart::new(PartKind::User, "Prompt", text_of(content))] };
    let prompt = blocks.iter().filter(|block| block["type"] != "tool_result").map(block_text).collect::<Vec<_>>().join("\n\n");
    let results = blocks.iter().filter(|block| block["type"] == "tool_result").map(|block| {
        let name = block["tool_use_id"].as_str().and_then(|id| tool_names.get(id)).map_or("tool", String::as_str);
        let title = if block["is_error"] == true { format!("{name} (error)") } else { name.to_string() };
        ContextPart::new(PartKind::ToolResult, title, blocks_text(&block["content"]))
    });
    (!prompt.is_empty()).then(|| ContextPart::new(PartKind::User, "Prompt", prompt)).into_iter().chain(results).collect()
}

/// The part of one block of an agent reply: its text, its thinking or a tool call with its input as JSON.
fn assistant_part(block: &Value) -> Option<ContextPart> {
    match block["type"].as_str()? {
        "text" => Some(ContextPart::new(PartKind::Assistant, "Reply", text_of(&block["text"]))),
        "thinking" => Some(ContextPart::new(PartKind::Thinking, "Thinking", text_of(&block["thinking"]))).filter(|part| !part.text.is_empty()),
        "tool_use" => Some(ContextPart::new(PartKind::ToolCall, text_of(&block["name"]), pretty(&block["input"]))),
        _ => None,
    }
}

/// The text of a `content` that is a string or a list of blocks, one paragraph per block.
fn blocks_text(content: &Value) -> String {
    match content {
        Value::Array(blocks) => blocks.iter().map(block_text).collect::<Vec<_>>().join("\n\n"),
        other => text_of(other),
    }
}

/// The text of one content block; an image or document shows as a placeholder.
fn block_text(block: &Value) -> String {
    match block["type"].as_str() {
        Some("text") => text_of(&block["text"]),
        Some(kind) => format!("[{kind}]"),
        None => String::new(),
    }
}

fn text_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parsed(lines: &[Value]) -> Vec<(PartKind, String, String)> {
        let jsonl = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        parse(&jsonl).into_iter().map(|part| (part.kind, part.title, part.text)).collect()
    }

    fn part(kind: PartKind, title: &str, text: &str) -> (PartKind, String, String) {
        (kind, title.into(), text.into())
    }

    #[test]
    fn puts_the_system_prompt_and_the_tools_first_and_keeps_them_across_a_compaction() {
        let lines = [
            json!({ "type": "user", "message": { "content": "before" } }),
            json!({ "type": "attachment", "attachment": { "type": "prompt_snapshot", "systemPrompt": ["You are Claude.", "  ", "Be brief."], "tools": null } }),
            json!({ "type": "attachment", "attachment": { "type": "prompt_snapshot", "systemPrompt": ["You are Claude."], "tools": [
                { "name": "Read", "description": "Reads a file.", "input_schema": { "type": "object" } }
            ] } }),
            json!({ "type": "system", "subtype": "compact_boundary" }),
            json!({ "type": "user", "isCompactSummary": true, "message": { "content": "We talked." } }),
        ];
        assert_eq!(
            parsed(&lines),
            vec![
                part(PartKind::SystemPrompt, "System prompt", "You are Claude."),
                part(PartKind::Tools, "Tool definitions (1)", "## Read\n\nReads a file.\n\n{\n  \"input_schema\": {\n    \"type\": \"object\"\n  }\n}"),
                part(PartKind::Summary, "Summary of the compacted conversation", "We talked."),
            ]
        );
    }

    #[test]
    fn splits_attachments_into_instruction_files_skills_and_reminders() {
        let lines = [
            json!({ "type": "attachment", "attachment": { "type": "instructions", "files": [{ "path": "/w/CLAUDE.md", "type": "Project", "content": "# Rules" }] } }),
            json!({ "type": "attachment", "attachment": { "type": "nested_memory", "path": "/w/.claude/rules/ui.md", "content": { "content": "UI rule" } } }),
            json!({ "type": "attachment", "attachment": { "type": "skill_listing", "content": "- spec: writes specs" } }),
            json!({ "type": "attachment", "attachment": { "type": "mcp_instructions_delta", "addedBlocks": ["## a\nA", "## b\nB"] } }),
            json!({ "type": "attachment", "attachment": { "type": "hook_success", "content": "" } }),
            json!({ "type": "user", "isMeta": true, "message": { "content": [{ "type": "text", "text": "Base directory for this skill: /w/.claude/skills/spec\n\n# Spec" }] } }),
        ];
        assert_eq!(
            parsed(&lines),
            vec![
                part(PartKind::Instructions, "/w/CLAUDE.md", "# Rules"),
                part(PartKind::Instructions, "/w/.claude/rules/ui.md", "UI rule"),
                part(PartKind::Reminder, "Skill listing", "- spec: writes specs"),
                part(PartKind::Reminder, "MCP server instructions", "## a\nA\n\n## b\nB"),
                part(PartKind::Skill, "spec", "Base directory for this skill: /w/.claude/skills/spec\n\n# Spec"),
            ]
        );
    }

    #[test]
    fn lists_prompts_replies_and_tool_calls_with_their_results() {
        let lines = [
            json!({ "type": "user", "message": { "content": [{ "type": "text", "text": "Look at this" }, { "type": "image" }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "Hmm." }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "a.ts", "is_error": true }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Done." }] } }),
        ];
        assert_eq!(
            parsed(&lines),
            vec![
                part(PartKind::User, "Prompt", "Look at this\n\n[image]"),
                part(PartKind::Thinking, "Thinking", "Hmm."),
                part(PartKind::ToolCall, "Bash", "{\n  \"command\": \"ls\"\n}"),
                part(PartKind::ToolResult, "Bash (error)", "a.ts"),
                part(PartKind::Assistant, "Reply", "Done."),
            ]
        );
    }
}
