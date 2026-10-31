//! Guardrail suggestions the user declined, kept in the repository itself: its declines file (`declines_file`) gets one
//! JSON line per decline, and the repository's CLAUDE.md a section that tells agents to search it before they suggest a
//! guardrail.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent::guardrail_skill::hunt_json;

/// The declines file of a repository whose hunt.json sets no `declinedGuardrailsFile`, worktree-relative; committed with
/// the repository like every other guardrail.
pub const DEFAULT_DECLINES_FILE: &str = ".claude/declined-guardrails.jsonl";
const MAX_DECLINES_FILE_LENGTH: usize = 255;

/// Points the agents at the declines file, `{{declinesFile}}`; appended to the repository's CLAUDE.md unless it names the
/// file already.
const CLAUDE_MD_SECTION: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/guardrails/declined-guardrails.claude-md.md"));

/// The kinds `<!-- hunt:guardrail KIND: … -->` may name (`KINDS` in `src/chat/guardrail/guardrail-suggestion.utils.ts`).
pub const KINDS: [&str; 5] = ["instruction", "rule", "skill", "agent", "adr"];

/// Why the user declined a suggestion, picked from the menu of the guardrail chat's "Decline" button.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeclineReason {
    TooSpecific,
    AlreadyRecorded,
    NotWanted,
}

/// One line of the declines file: what the agent suggested, why the user declined it and on which day.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclinedGuardrail {
    pub kind: String,
    pub reason: DeclineReason,
    pub summary: String,
    pub declined_at: chrono::NaiveDate,
}

/// The declines file of the repository in `worktree` (`declinedGuardrailsFile` of its hunt.json), `DEFAULT_DECLINES_FILE`
/// without a worktree or without a value inside the worktree.
pub fn declines_file(worktree: Option<&Path>) -> String {
    worktree
        .and_then(hunt_json)
        .and_then(|root| root.get("declinedGuardrailsFile")?.as_str().map(str::to_string))
        .filter(|file| is_worktree_file(file))
        .unwrap_or_else(|| DEFAULT_DECLINES_FILE.to_string())
}

/// A file relative to the worktree as hunt.json accepts it (`ZodWorktreeFile` in
/// `apps/session/src/session-config/hunt-json.rules.ts`): at most `MAX_DECLINES_FILE_LENGTH` characters, segments of
/// letters, digits, `.`, `_` and `-`, none `.` or `..`.
fn is_worktree_file(file: &str) -> bool {
    file.len() <= MAX_DECLINES_FILE_LENGTH
        && file.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
        })
}

/// Appends `entry` to the declines file of `worktree` and adds the CLAUDE.md section if no CLAUDE.md names the file yet;
/// returns the worktree-relative paths it changed.
pub fn record(worktree: &Path, entry: &DeclinedGuardrail) -> Result<Vec<String>, String> {
    let entry = DeclinedGuardrail { summary: entry.summary.split_whitespace().collect::<Vec<_>>().join(" "), ..entry.clone() };
    let line = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
    let declines_file = declines_file(Some(worktree));
    let path = worktree.join(&declines_file);
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|error| format!("failed to open {declines_file}: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("failed to write {declines_file}: {error}"))?;
    let mut changed = vec![declines_file.clone()];
    changed.extend(reference_in_claude_md(worktree, &declines_file)?);
    Ok(changed)
}

/// Appends `CLAUDE_MD_SECTION` for `declines_file` to the root CLAUDE.md, else to `.claude/CLAUDE.md`, else creates the
/// root one, unless one of them names `declines_file` already; returns the path it changed.
fn reference_in_claude_md(worktree: &Path, declines_file: &str) -> Result<Option<String>, String> {
    let candidates = ["CLAUDE.md", ".claude/CLAUDE.md"];
    let mut existing = Vec::new();
    for candidate in candidates {
        let Ok(text) = std::fs::read_to_string(worktree.join(candidate)) else { continue };
        if text.contains(declines_file) {
            return Ok(None);
        }
        existing.push((candidate, text));
    }
    let (target, text) = existing.into_iter().next().unwrap_or((candidates[0], String::new()));
    let separator = match text.as_str() {
        "" => "",
        text if text.ends_with("\n\n") => "",
        text if text.ends_with('\n') => "\n",
        _ => "\n\n",
    };
    let section = crate::graph::fill_prompt(CLAUDE_MD_SECTION, &[("declinesFile", declines_file)]);
    std::fs::write(worktree.join(target), format!("{text}{separator}{section}")).map_err(|error| format!("failed to write {target}: {error}"))?;
    Ok(Some(target.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worktree() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hunt-declined-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entry(summary: &str) -> DeclinedGuardrail {
        DeclinedGuardrail { kind: "skill".into(), reason: DeclineReason::TooSpecific, summary: summary.into(), declined_at: "2026-10-22".parse().unwrap() }
    }

    #[test]
    fn every_decline_becomes_one_line_and_claude_md_names_the_file_once() {
        let dir = worktree();
        std::fs::write(dir.join("CLAUDE.md"), "# Repo\n").unwrap();
        assert_eq!(record(&dir, &entry("Check the migration\nin a rollback transaction")).unwrap(), [DEFAULT_DECLINES_FILE, "CLAUDE.md"]);
        assert_eq!(record(&dir, &entry("Second")).unwrap(), [DEFAULT_DECLINES_FILE]);
        let lines = std::fs::read_to_string(dir.join(DEFAULT_DECLINES_FILE)).unwrap();
        assert_eq!(
            lines,
            "{\"kind\":\"skill\",\"reason\":\"tooSpecific\",\"summary\":\"Check the migration in a rollback transaction\",\"declinedAt\":\"2026-10-22\"}\n\
             {\"kind\":\"skill\",\"reason\":\"tooSpecific\",\"summary\":\"Second\",\"declinedAt\":\"2026-10-22\"}\n"
        );
        let claude_md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert!(claude_md.starts_with("# Repo\n\n## Declined guardrail suggestions\n"));
        assert_eq!(claude_md.matches(DEFAULT_DECLINES_FILE).count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_section_goes_into_the_claude_folder_or_a_new_root_file() {
        let dir = worktree();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude/CLAUDE.md"), "# Rules").unwrap();
        assert_eq!(record(&dir, &entry("A")).unwrap(), [DEFAULT_DECLINES_FILE, ".claude/CLAUDE.md"]);
        assert!(std::fs::read_to_string(dir.join(".claude/CLAUDE.md")).unwrap().starts_with("# Rules\n\n## Declined"));
        std::fs::remove_dir_all(&dir).unwrap();

        let dir = worktree();
        assert_eq!(record(&dir, &entry("A")).unwrap(), [DEFAULT_DECLINES_FILE, "CLAUDE.md"]);
        assert!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap().starts_with("## Declined"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_declines_go_to_the_file_hunt_json_names() {
        let dir = worktree();
        let file = ".claude/resources/guardrails/declined-guardrails.jsonl";
        std::fs::write(dir.join("hunt.json"), format!(r#"{{ "version": 3, "declinedGuardrailsFile": "{file}" }}"#)).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "# Repo\n").unwrap();
        assert_eq!(record(&dir, &entry("A")).unwrap(), [file, "CLAUDE.md"]);
        assert_eq!(record(&dir, &entry("B")).unwrap(), [file]);
        assert_eq!(std::fs::read_to_string(dir.join(file)).unwrap().lines().count(), 2);
        assert!(!dir.join(DEFAULT_DECLINES_FILE).exists());
        let claude_md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert_eq!(claude_md.matches(file).count(), 1);
        assert!(!claude_md.contains("{{"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_declines_file_outside_the_worktree_falls_back_to_the_default() {
        let dir = worktree();
        for file in ["/etc/declines.jsonl", "../declines.jsonl", "a/./b.jsonl", "a//b.jsonl", "", "a b.jsonl"] {
            std::fs::write(dir.join("hunt.json"), serde_json::json!({ "version": 3, "declinedGuardrailsFile": file }).to_string()).unwrap();
            assert_eq!(declines_file(Some(&dir)), DEFAULT_DECLINES_FILE, "{file}");
        }
        assert_eq!(declines_file(None), DEFAULT_DECLINES_FILE);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
