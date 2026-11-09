//! The repository's ticket skill: the Claude Code skill `hunt.json` names as `ticketSkill` (`DEFAULT_SKILL` without
//! it), which the agent of a ticket session (`SessionMode::Ticket`) invokes first to write the GitHub issue of a task
//! before anyone codes it. The start of a ticket session writes the skill from `TEMPLATE` into a worktree that lacks
//! it, and its system prompt (`prompt`) names the skill and sets the rules the skill may leave open.

use std::path::Path;

use crate::agent::guardrail_skill::{is_skill_name, skill_file};

/// The skill of a repository whose hunt.json sets no `ticketSkill`.
pub const DEFAULT_SKILL: &str = "ticket";
/// The ADR folder of a repository whose hunt.json sets no `adrDir` (`DEFAULT_GUARDRAIL_DIRS.adr` in `src/guardrails/guardrail-config.utils.ts`).
const DEFAULT_ADR_DIR: &str = ".claude/resources/adrs";

/// The skill Hunt writes into a repository without one; `{{skillName}}` and `{{adrDir}}` are the repository's.
const TEMPLATE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/ticket/ticket.skill.md"));

/// The system prompt part of a ticket session; `{{skillName}}` and `{{skillFile}}` are the repository's.
const SESSION_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/ticket/ticket.system-prompt.md"));

/// The ticket skill of the repository in `worktree` (`ticketSkill` of its hunt.json), `DEFAULT_SKILL` without a usable
/// value or file.
pub fn skill_name(worktree: &Path) -> String {
    hunt_json(worktree)
        .and_then(|root| root.get("ticketSkill")?.as_str().map(str::to_string))
        .filter(|name| is_skill_name(name))
        .unwrap_or_else(|| DEFAULT_SKILL.to_string())
}

/// Writes the repository's ticket skill from `TEMPLATE` unless its file exists; returns the worktree-relative path it
/// wrote, None when the skill was there already.
pub fn ensure(worktree: &Path) -> Result<Option<String>, String> {
    let name = skill_name(worktree);
    let file = skill_file(&name);
    let path = worktree.join(&file);
    if path.exists() {
        return Ok(None);
    }
    let adr_dir = hunt_json(worktree).and_then(|root| root.get("adrDir")?.as_str().map(str::to_string)).unwrap_or_else(|| DEFAULT_ADR_DIR.to_string());
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
    }
    let content = crate::graph::fill_prompt(TEMPLATE, &[("skillName", &name), ("adrDir", &adr_dir)]);
    std::fs::write(&path, content).map_err(|error| format!("failed to write {file}: {error}"))?;
    Ok(Some(file))
}

/// The system prompt part of a ticket session in `worktree`: it names the repository's ticket skill and its file.
pub fn prompt(worktree: &Path) -> String {
    let name = skill_name(worktree);
    let file = skill_file(&name);
    crate::graph::fill_prompt(SESSION_PROMPT, &[("skillName", &name), ("skillFile", &file)])
}

/// The parsed hunt.json of `worktree`; None without a readable one. The VM validates the file fully
/// (`apps/session/src/session-config/hunt-json.value-object.ts`); here only `ticketSkill` and `adrDir` matter.
fn hunt_json(worktree: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(worktree.join("hunt.json")).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worktree(hunt_json: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(hunt_json) = hunt_json {
            std::fs::write(dir.path().join("hunt.json"), hunt_json).unwrap();
        }
        dir
    }

    #[test]
    fn skill_name_comes_from_hunt_json_or_is_the_default() {
        assert_eq!(skill_name(worktree(Some(r#"{ "version": 3, "ticketSkill": "spec" }"#)).path()), "spec");
        for hunt_json in [None, Some("{"), Some(r#"{ "version": 3 }"#), Some(r#"{ "ticketSkill": 7 }"#), Some(r#"{ "ticketSkill": "Bad Name" }"#)] {
            assert_eq!(skill_name(worktree(hunt_json).path()), DEFAULT_SKILL);
        }
    }

    #[test]
    fn ensure_writes_the_filled_template_once() {
        let dir = worktree(Some(r#"{ "version": 3, "adrDir": "docs/adr" }"#));
        assert_eq!(ensure(dir.path()).unwrap(), Some(".claude/skills/ticket/SKILL.md".to_string()));
        let written = std::fs::read_to_string(dir.path().join(".claude/skills/ticket/SKILL.md")).unwrap();
        assert!(written.starts_with("---\nname: ticket\n"));
        assert!(written.contains("the ADRs in `docs/adr`"));
        assert!(!written.contains("{{"));

        std::fs::write(dir.path().join(".claude/skills/ticket/SKILL.md"), "mine").unwrap();
        assert_eq!(ensure(dir.path()).unwrap(), None);
        assert_eq!(std::fs::read_to_string(dir.path().join(".claude/skills/ticket/SKILL.md")).unwrap(), "mine");
    }

    #[test]
    fn ensure_respects_the_configured_skill_and_leaves_an_existing_file() {
        let dir = worktree(Some(r#"{ "version": 3, "ticketSkill": "spec" }"#));
        std::fs::create_dir_all(dir.path().join(".claude/skills/spec")).unwrap();
        std::fs::write(dir.path().join(".claude/skills/spec/SKILL.md"), "theirs").unwrap();
        assert_eq!(ensure(dir.path()).unwrap(), None);
        assert!(!dir.path().join(".claude/skills/ticket").exists());
    }

    #[test]
    fn the_session_prompt_names_the_skill_and_its_file() {
        let configured = prompt(worktree(Some(r#"{ "version": 3, "ticketSkill": "spec" }"#)).path());
        assert!(configured.starts_with("## Ticket session\n"));
        assert!(configured.contains("skill `spec` (`.claude/skills/spec/SKILL.md`)"));
        assert!(!configured.contains("{{"));
        assert!(prompt(worktree(None).path()).contains("skill `ticket` (`.claude/skills/ticket/SKILL.md`)"));
    }
}
