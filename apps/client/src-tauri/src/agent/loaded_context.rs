//! Which guardrails a session's agent holds in its context window, taken from its Claude Code transcript
//! (`~/.claude/projects/<slug>/<session id>.jsonl`): the instruction files Claude Code loaded at the start (`CLAUDE.md`,
//! rules without `paths:`, memory) or once the agent touched a matching file (rules with `paths:`, nested `CLAUDE.md`),
//! the skills it invoked or the user called, and the ADRs and other `.claude/` files it read with `Read` or printed with
//! a shell command. A compaction drops everything before it; Claude Code then attaches the instruction files and the
//! invoked skills again. A `/clear` starts a new transcript.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// What Claude Code puts in front of the text of a skill it loads, followed by the skill's folder.
pub(crate) const SKILL_MARKER: &str = "Base directory for this skill: ";
/// Shell commands that print a file into the context, as opposed to listing or searching it.
const PRINTING_COMMANDS: [&str; 6] = ["cat", "head", "tail", "sed", "less", "bat"];

/// What kind of guardrail a context file is.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContextKind {
    /// A `CLAUDE.md` or `CLAUDE.local.md`.
    Instructions,
    /// A file below `.claude/rules/`.
    Rule,
    /// Claude Code's auto memory: `MEMORY.md` and the files of its `memory/` folder.
    Memory,
    Skill,
    /// A file in an `adr` or `adrs` folder.
    Adr,
    /// Any other file below a `.claude/` folder, e.g. an agent definition or a reference file.
    Resource,
}

/// How a context file got into the context.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoadTrigger {
    /// Claude Code loaded it when the conversation started or was compacted.
    Start,
    /// Claude Code loaded it when the agent touched a file its `paths:` or folder match.
    Path,
    /// The agent invoked the skill, or the user called it as a slash command.
    Invoked,
    /// The agent read the file.
    Read,
}

/// One file in the agent's context; mirrored by `LoadedContextFile` in `src/chat/loaded-context.types.ts`.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    pub kind: ContextKind,
    pub trigger: LoadTrigger,
    /// Relative to the worktree when inside it, absolute otherwise; a skill's `SKILL.md`.
    pub path: String,
    pub is_in_worktree: bool,
}

/// The context files of the transcript at `transcript` in the order they were loaded; none while it does not exist.
pub fn read(transcript: &Path, worktree: &Path) -> Result<Vec<ContextFile>, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    match std::fs::read_to_string(transcript) {
        Ok(jsonl) => Ok(parse(&jsonl, worktree, &home)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("failed to read the transcript {}: {error}", transcript.display())),
    }
}

fn parse(jsonl: &str, worktree: &Path, home: &Path) -> Vec<ContextFile> {
    let mut loaded: Vec<(PathBuf, ContextKind, LoadTrigger)> = Vec::new();
    for line in jsonl.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let cwd = Path::new(entry["cwd"].as_str().unwrap_or_default());
        match entry["type"].as_str() {
            Some("system") if entry["subtype"] == "compact_boundary" => loaded.clear(),
            Some("attachment") => loaded.extend(attached(&entry["attachment"])),
            Some("user") if entry["isMeta"] == true => {
                loaded.extend(skill_file(&message_text(&entry["message"]["content"])).map(|path| (path, ContextKind::Skill, LoadTrigger::Invoked)));
            }
            Some("assistant") => {
                let Some(blocks) = entry["message"]["content"].as_array() else { continue };
                for block in blocks.iter().filter(|block| block["type"] == "tool_use") {
                    let read = read_paths(&block["name"], &block["input"]).into_iter().map(|raw| absolute(cwd, home, raw));
                    loaded.extend(read.filter_map(|path| read_kind(&path).map(|kind| (path, kind, LoadTrigger::Read))));
                }
            }
            _ => {}
        }
    }
    let mut seen = HashSet::new();
    loaded
        .into_iter()
        .filter(|(path, _, _)| seen.insert(path.clone()))
        .map(|(path, kind, trigger)| {
            let relative = path.strip_prefix(worktree).ok();
            ContextFile { kind, trigger, path: relative.unwrap_or(&path).display().to_string(), is_in_worktree: relative.is_some() }
        })
        .collect()
}

/// The context files an attachment entry brings: the instruction files of the start, a path-scoped rule or nested
/// `CLAUDE.md`, or the skills a compaction attaches again.
fn attached(attachment: &Value) -> Vec<(PathBuf, ContextKind, LoadTrigger)> {
    match attachment["type"].as_str() {
        Some("instructions") => attachment["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|file| Some((PathBuf::from(file["path"].as_str()?), instruction_kind(file), LoadTrigger::Start)))
            .collect(),
        Some("nested_memory") => {
            attachment["path"].as_str().map(|path| (PathBuf::from(path), instruction_kind(&attachment["content"]), LoadTrigger::Path)).into_iter().collect()
        }
        Some("invoked_skills") => attachment["skills"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|skill| skill_file(skill["content"].as_str()?))
            .map(|path| (path, ContextKind::Skill, LoadTrigger::Invoked))
            .collect(),
        _ => Vec::new(),
    }
}

/// The kind of an instruction file Claude Code loaded, from its `path` and memory `type`.
fn instruction_kind(file: &Value) -> ContextKind {
    if file["type"] == "AutoMem" {
        return ContextKind::Memory;
    }
    let path = Path::new(file["path"].as_str().unwrap_or_default());
    if is_below(path, &[".claude", "rules"]) { ContextKind::Rule } else { ContextKind::Instructions }
}

/// The kind of a file the agent read, or `None` for a file that is no guardrail.
fn read_kind(path: &Path) -> Option<ContextKind> {
    let is_adr = path.parent()?.components().any(|component| matches!(component.as_os_str().to_str(), Some("adr" | "adrs")));
    let file_name = path.file_name()?.to_str()?;
    if is_adr {
        Some(ContextKind::Adr)
    } else if matches!(file_name, "CLAUDE.md" | "CLAUDE.local.md") {
        Some(ContextKind::Instructions)
    } else if !is_below(path, &[".claude"]) {
        None
    } else if is_below(path, &[".claude", "rules"]) {
        Some(ContextKind::Rule)
    } else if file_name == "MEMORY.md" || path.parent().and_then(Path::file_name).is_some_and(|folder| folder == "memory") {
        Some(ContextKind::Memory)
    } else if is_below(path, &[".claude", "projects"]) {
        // Transcripts and the tool output Claude Code moved out of them.
        None
    } else {
        Some(ContextKind::Resource)
    }
}

/// Whether `path` lies below the folders `segments`, which follow each other directly, e.g. `.claude/rules`.
fn is_below(path: &Path, segments: &[&str]) -> bool {
    let names: Vec<&str> = path.parent().into_iter().flat_map(Path::components).filter_map(|component| component.as_os_str().to_str()).collect();
    names.windows(segments.len()).any(|window| window == segments)
}

/// The `SKILL.md` of the skill whose text starts with `text`, or `None` for any other text.
fn skill_file(text: &str) -> Option<PathBuf> {
    let folder = text.strip_prefix(SKILL_MARKER)?.lines().next()?.trim();
    (!folder.is_empty()).then(|| Path::new(folder).join("SKILL.md"))
}

/// The text of a message's `content`, which is a string or a list of blocks whose first text block counts.
fn message_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks.iter().find_map(|block| block["text"].as_str()).unwrap_or_default().to_string(),
        _ => String::new(),
    }
}

/// The paths a tool call reads: the file of a `Read`, the Markdown files a shell command prints.
fn read_paths<'a>(tool: &Value, input: &'a Value) -> Vec<&'a str> {
    match tool.as_str() {
        Some("Read") => input["file_path"].as_str().into_iter().collect(),
        Some("Bash") => printed_files(input["command"].as_str().unwrap_or_default()),
        _ => Vec::new(),
    }
}

/// The Markdown files `command` names when it runs a printing command; globs are left out, and so are relative paths
/// when the command changes its folder, since they no longer start from the transcript's `cwd`.
fn printed_files(command: &str) -> Vec<&str> {
    let words: Vec<&str> = command.split(|character: char| character.is_whitespace() || matches!(character, ';' | '|' | '&' | '(' | ')')).collect();
    if !words.iter().any(|word| PRINTING_COMMANDS.contains(word)) {
        return Vec::new();
    }
    let changes_folder = words.contains(&"cd");
    words
        .into_iter()
        .map(|word| word.trim_matches(['\'', '"']))
        .filter(|word| word.ends_with(".md") && !word.contains('*'))
        .filter(|word| !changes_folder || word.starts_with(['/', '~']))
        .collect()
}

/// `raw` resolved against `cwd`, or against `home` after a leading `~/`, without `.` segments.
fn absolute(cwd: &Path, home: &Path, raw: &str) -> PathBuf {
    let path = raw.strip_prefix("~/").map_or_else(|| cwd.join(raw), |below_home| home.join(below_home));
    path.components().filter(|component| !matches!(component, Component::CurDir)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKTREE: &str = "/work/app";

    fn line(value: Value) -> String {
        value.to_string()
    }

    fn instructions(files: &[(&str, &str)]) -> String {
        let files: Vec<Value> = files.iter().map(|(path, kind)| serde_json::json!({ "path": path, "type": kind, "content": "…" })).collect();
        line(serde_json::json!({ "type": "attachment", "attachment": { "type": "instructions", "files": files } }))
    }

    fn tool_call(name: &str, input: Value) -> String {
        line(serde_json::json!({ "type": "assistant", "cwd": WORKTREE, "message": { "content": [{ "type": "tool_use", "name": name, "input": input }] } }))
    }

    fn file(kind: ContextKind, trigger: LoadTrigger, path: &str, is_in_worktree: bool) -> ContextFile {
        ContextFile { kind, trigger, path: path.into(), is_in_worktree }
    }

    fn parsed(lines: &[String]) -> Vec<ContextFile> {
        parse(&lines.join("\n"), Path::new(WORKTREE), Path::new("/home/me"))
    }

    #[test]
    fn lists_the_instruction_files_of_the_start_and_the_path_scoped_rules() {
        let lines = [
            instructions(&[
                ("/home/me/.claude/CLAUDE.md", "User"),
                ("/work/app/CLAUDE.md", "Project"),
                ("/work/app/.claude/rules/git.md", "Project"),
                ("/home/me/.claude/projects/x/memory/MEMORY.md", "AutoMem"),
            ]),
            line(serde_json::json!({ "type": "attachment", "attachment": {
                "type": "nested_memory", "path": "/work/app/.claude/rules/ui.md", "content": { "path": "/work/app/.claude/rules/ui.md", "type": "Project" }
            } })),
        ];
        assert_eq!(
            parsed(&lines),
            vec![
                file(ContextKind::Instructions, LoadTrigger::Start, "/home/me/.claude/CLAUDE.md", false),
                file(ContextKind::Instructions, LoadTrigger::Start, "CLAUDE.md", true),
                file(ContextKind::Rule, LoadTrigger::Start, ".claude/rules/git.md", true),
                file(ContextKind::Memory, LoadTrigger::Start, "/home/me/.claude/projects/x/memory/MEMORY.md", false),
                file(ContextKind::Rule, LoadTrigger::Path, ".claude/rules/ui.md", true),
            ]
        );
    }

    #[test]
    fn lists_skills_by_their_loaded_text_whether_the_agent_or_the_user_invoked_them() {
        let lines = [
            line(serde_json::json!({ "type": "user", "isMeta": true, "message": { "content": [{ "type": "text", "text": "Base directory for this skill: /work/app/.claude/skills/spec\n\n# Spec" }] } })),
            line(serde_json::json!({ "type": "user", "message": { "content": "Base directory for this skill: /work/app/.claude/skills/quoted" } })),
        ];
        assert_eq!(parsed(&lines), vec![file(ContextKind::Skill, LoadTrigger::Invoked, ".claude/skills/spec/SKILL.md", true)]);
    }

    #[test]
    fn lists_the_guardrail_files_the_agent_read_or_printed_and_skips_other_files() {
        let lines = [
            tool_call("Read", serde_json::json!({ "file_path": "/work/app/.claude/resources/adrs/0001-slices.md" })),
            tool_call("Read", serde_json::json!({ "file_path": "/work/app/src/main.ts" })),
            tool_call("Read", serde_json::json!({ "file_path": "/home/me/.claude/projects/x/abc/tool-results/out.txt" })),
            tool_call("Bash", serde_json::json!({ "command": "cat ./.claude/resources/guide.md && sed -n 1,20p docs/adr/0002-x.md" })),
            tool_call("Bash", serde_json::json!({ "command": "ls .claude/agents/reviewer.md; grep -l x .claude/rules/*.md" })),
            tool_call("Bash", serde_json::json!({ "command": "cd ../other && cat .claude/rules/ui.md ~/.claude/rules/brief.md" })),
        ];
        assert_eq!(
            parsed(&lines),
            vec![
                file(ContextKind::Adr, LoadTrigger::Read, ".claude/resources/adrs/0001-slices.md", true),
                file(ContextKind::Resource, LoadTrigger::Read, ".claude/resources/guide.md", true),
                file(ContextKind::Adr, LoadTrigger::Read, "docs/adr/0002-x.md", true),
                file(ContextKind::Rule, LoadTrigger::Read, "/home/me/.claude/rules/brief.md", false),
            ]
        );
    }

    #[test]
    fn keeps_the_first_load_of_a_file_and_starts_over_after_a_compaction() {
        let before = [
            instructions(&[("/work/app/CLAUDE.md", "Project")]),
            tool_call("Read", serde_json::json!({ "file_path": "/work/app/CLAUDE.md" })),
            tool_call("Read", serde_json::json!({ "file_path": "/work/app/.claude/agents/reviewer.md" })),
        ];
        assert_eq!(
            parsed(&before),
            vec![
                file(ContextKind::Instructions, LoadTrigger::Start, "CLAUDE.md", true),
                file(ContextKind::Resource, LoadTrigger::Read, ".claude/agents/reviewer.md", true),
            ]
        );

        let mut lines = before.to_vec();
        lines.push(line(serde_json::json!({ "type": "system", "subtype": "compact_boundary" })));
        lines.push(instructions(&[("/work/app/CLAUDE.md", "Project")]));
        lines.push(line(serde_json::json!({ "type": "attachment", "attachment": {
            "type": "invoked_skills", "skills": [{ "name": "spec", "content": "Base directory for this skill: /work/app/.claude/skills/spec\n…" }]
        } })));
        assert_eq!(
            parsed(&lines),
            vec![
                file(ContextKind::Instructions, LoadTrigger::Start, "CLAUDE.md", true),
                file(ContextKind::Skill, LoadTrigger::Invoked, ".claude/skills/spec/SKILL.md", true),
            ]
        );
    }

    #[test]
    fn a_missing_transcript_holds_nothing() {
        assert_eq!(read(Path::new("/nonexistent/transcript.jsonl"), Path::new(WORKTREE)), Ok(Vec::new()));
    }
}
