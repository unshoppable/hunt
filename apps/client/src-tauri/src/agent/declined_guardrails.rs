//! Guardrail suggestions the user declined, kept in the repository itself: `DECLINES_FILE` gets one JSON line per
//! decline, and the repository's CLAUDE.md a section that tells agents to search it before they suggest a guardrail.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The declines of the repository, worktree-relative; committed with the repository like every other guardrail.
pub const DECLINES_FILE: &str = ".claude/declined-guardrails.jsonl";

/// Points the agents at `DECLINES_FILE`; appended to the repository's CLAUDE.md unless it names the file already.
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

/// One line of `DECLINES_FILE`: what the agent suggested, why the user declined it and on which day.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclinedGuardrail {
    pub kind: String,
    pub reason: DeclineReason,
    pub summary: String,
    pub declined_at: chrono::NaiveDate,
}

/// Appends `entry` to `DECLINES_FILE` of `worktree` and adds the CLAUDE.md section if no CLAUDE.md names the file yet;
/// returns the worktree-relative paths it changed.
pub fn record(worktree: &Path, entry: &DeclinedGuardrail) -> Result<Vec<String>, String> {
    let entry = DeclinedGuardrail { summary: entry.summary.split_whitespace().collect::<Vec<_>>().join(" "), ..entry.clone() };
    let line = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
    let path = worktree.join(DECLINES_FILE);
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|error| format!("failed to open {DECLINES_FILE}: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("failed to write {DECLINES_FILE}: {error}"))?;
    let mut changed = vec![DECLINES_FILE.to_string()];
    changed.extend(reference_in_claude_md(worktree)?);
    Ok(changed)
}

/// Appends `CLAUDE_MD_SECTION` to the root CLAUDE.md, else to `.claude/CLAUDE.md`, else creates the root one, unless
/// one of them names `DECLINES_FILE` already; returns the path it changed.
fn reference_in_claude_md(worktree: &Path) -> Result<Option<String>, String> {
    let candidates = ["CLAUDE.md", ".claude/CLAUDE.md"];
    let mut existing = Vec::new();
    for candidate in candidates {
        let Ok(text) = std::fs::read_to_string(worktree.join(candidate)) else { continue };
        if text.contains(DECLINES_FILE) {
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
    std::fs::write(worktree.join(target), format!("{text}{separator}{CLAUDE_MD_SECTION}")).map_err(|error| format!("failed to write {target}: {error}"))?;
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
        assert_eq!(record(&dir, &entry("Check the migration\nin a rollback transaction")).unwrap(), [DECLINES_FILE, "CLAUDE.md"]);
        assert_eq!(record(&dir, &entry("Second")).unwrap(), [DECLINES_FILE]);
        let lines = std::fs::read_to_string(dir.join(DECLINES_FILE)).unwrap();
        assert_eq!(
            lines,
            "{\"kind\":\"skill\",\"reason\":\"tooSpecific\",\"summary\":\"Check the migration in a rollback transaction\",\"declinedAt\":\"2026-10-22\"}\n\
             {\"kind\":\"skill\",\"reason\":\"tooSpecific\",\"summary\":\"Second\",\"declinedAt\":\"2026-10-22\"}\n"
        );
        let claude_md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert!(claude_md.starts_with("# Repo\n\n## Declined guardrail suggestions\n"));
        assert_eq!(claude_md.matches(DECLINES_FILE).count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_section_goes_into_the_claude_folder_or_a_new_root_file() {
        let dir = worktree();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude/CLAUDE.md"), "# Rules").unwrap();
        assert_eq!(record(&dir, &entry("A")).unwrap(), [DECLINES_FILE, ".claude/CLAUDE.md"]);
        assert!(std::fs::read_to_string(dir.join(".claude/CLAUDE.md")).unwrap().starts_with("# Rules\n\n## Declined"));
        std::fs::remove_dir_all(&dir).unwrap();

        let dir = worktree();
        assert_eq!(record(&dir, &entry("A")).unwrap(), [DECLINES_FILE, "CLAUDE.md"]);
        assert!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap().starts_with("## Declined"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
