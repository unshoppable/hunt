//! The repository's guardrail skill: the Claude Code skill `hunt.json` names as `guardrailSkill` (`DEFAULT_SKILL` without
//! it), which the "Guardrail" button of the chat invokes and whose qualification criteria and guardrail kinds the
//! guardrail offer of the system prompt quotes. A session start writes the skill from `TEMPLATE` into a worktree that lacks it.

use std::path::Path;

use crate::agent::declined_guardrails;

/// The skill of a repository whose hunt.json sets no `guardrailSkill`.
pub const DEFAULT_SKILL: &str = "guardrail";
/// The ADR folder of a repository whose hunt.json sets no `adrDir` (`DEFAULT_GUARDRAIL_DIRS.adr` in `src/guardrails/guardrail-config.utils.ts`).
const DEFAULT_ADR_DIR: &str = ".claude/resources/adrs";
const MAX_SKILL_NAME_LENGTH: usize = 64;

/// The skill Hunt writes into a repository without one; `{{skillName}}`, `{{adrDir}}` and `{{declinesFile}}` are the
/// repository's.
const TEMPLATE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/guardrails/guardrail.skill.md"));

/// The guardrail offer of the system prompt; `{{skillName}}`, `{{skillFile}}`, `{{criteria}}` and `{{kinds}}` are the
/// repository's.
const OFFER_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/guardrails/guardrail-offer.system-prompt.md"));

/// The `hunt:<section>` comments of the skill that enclose its qualification criteria and its guardrail kinds.
const CRITERIA_SECTION: &str = "criteria";
const KINDS_SECTION: &str = "kinds";

/// The guardrail skill of the repository in `worktree` (`guardrailSkill` of its hunt.json), `DEFAULT_SKILL` without a
/// usable value or file.
pub fn skill_name(worktree: &Path) -> String {
    hunt_json(worktree)
        .and_then(|root| root.get("guardrailSkill")?.as_str().map(str::to_string))
        .filter(|name| is_skill_name(name))
        .unwrap_or_else(|| DEFAULT_SKILL.to_string())
}

/// Worktree-relative path of the skill file of the skill `name`.
pub fn skill_file(name: &str) -> String {
    format!(".claude/skills/{name}/SKILL.md")
}

/// A skill name as Claude Code accepts it: kebab-case of letters and digits, at most `MAX_SKILL_NAME_LENGTH` characters.
pub fn is_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_SKILL_NAME_LENGTH
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

/// Writes the repository's guardrail skill from `TEMPLATE` unless its file exists; returns the worktree-relative path it
/// wrote, None when the skill was there already.
pub fn ensure(worktree: &Path) -> Result<Option<String>, String> {
    let name = skill_name(worktree);
    let file = skill_file(&name);
    let path = worktree.join(&file);
    if path.exists() {
        return Ok(None);
    }
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
    }
    std::fs::write(&path, template(&name, &adr_dir(Some(worktree)), &declined_guardrails::declines_file(Some(worktree)))).map_err(|error| format!("failed to write {file}: {error}"))?;
    Ok(Some(file))
}

/// The guardrail offer for the agent of a session in `worktree`: it names the repository's skill and quotes the
/// qualification criteria and the guardrail kinds of its skill file. Without a worktree (an agent on a session VM) the
/// skill is `DEFAULT_SKILL`; a section the file lacks is taken from `TEMPLATE`.
pub fn offer_prompt(worktree: Option<&Path>) -> String {
    let name = worktree.map(skill_name).unwrap_or_else(|| DEFAULT_SKILL.to_string());
    let file = skill_file(&name);
    let skill = worktree.and_then(|worktree| std::fs::read_to_string(worktree.join(&file)).ok()).unwrap_or_default();
    let template = template(&name, &adr_dir(worktree), &declined_guardrails::declines_file(worktree));
    let section = |section_name| section_of(&skill, section_name).or_else(|| section_of(&template, section_name)).unwrap_or_default();
    crate::graph::fill_prompt(
        OFFER_PROMPT,
        &[("skillName", &name), ("skillFile", &file), ("criteria", &section(CRITERIA_SECTION)), ("kinds", &section(KINDS_SECTION))],
    )
}

/// `TEMPLATE` filled for the skill `name`, the ADR folder `adr_dir` and the declines file `declines_file`.
fn template(name: &str, adr_dir: &str, declines_file: &str) -> String {
    crate::graph::fill_prompt(TEMPLATE, &[("skillName", name), ("adrDir", adr_dir), ("declinesFile", declines_file)])
}

/// The ADR folder of the repository in `worktree` (`adrDir` of its hunt.json), `DEFAULT_ADR_DIR` without a worktree or value.
fn adr_dir(worktree: Option<&Path>) -> String {
    worktree
        .and_then(hunt_json)
        .and_then(|root| root.get("adrDir")?.as_str().map(str::to_string))
        .unwrap_or_else(|| DEFAULT_ADR_DIR.to_string())
}

/// The text between the `hunt:<section_name>` comments of a skill file, trimmed; None when the file has no such pair.
fn section_of(skill: &str, section_name: &str) -> Option<String> {
    let start_comment = format!("<!-- hunt:{section_name} -->");
    let end_comment = format!("<!-- /hunt:{section_name} -->");
    let start = skill.find(&start_comment)? + start_comment.len();
    let end = start + skill[start..].find(&end_comment)?;
    let section = skill[start..end].trim();
    (!section.is_empty()).then(|| section.to_string())
}

/// The parsed hunt.json of `worktree`; None without a readable one. The VM validates the file fully
/// (`apps/session/src/session-config/hunt-json.value-object.ts`); here only the fields of the guardrails matter.
pub(crate) fn hunt_json(worktree: &Path) -> Option<serde_json::Value> {
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
        assert_eq!(skill_name(worktree(Some(r#"{ "version": 3, "guardrailSkill": "team-lessons" }"#)).path()), "team-lessons");
        for hunt_json in [None, Some("{"), Some(r#"{ "version": 3 }"#), Some(r#"{ "guardrailSkill": 7 }"#), Some(r#"{ "guardrailSkill": "Bad Name" }"#)] {
            assert_eq!(skill_name(worktree(hunt_json).path()), DEFAULT_SKILL);
        }
    }

    #[test]
    fn skill_names_are_kebab_case() {
        for name in ["guardrail", "team-lessons-2", "a"] {
            assert!(is_skill_name(name), "{name}");
        }
        for name in ["", "-a", "a-", "a--b", "Guardrail", "guard rail", "guard_rail", &"a".repeat(65)] {
            assert!(!is_skill_name(name), "{name}");
        }
    }

    #[test]
    fn ensure_writes_the_filled_template_once() {
        let dir = worktree(Some(r#"{ "version": 3, "guardrailSkill": "lessons", "adrDir": "docs/adr", "declinedGuardrailsFile": "docs/declines.jsonl" }"#));
        assert_eq!(ensure(dir.path()).unwrap(), Some(".claude/skills/lessons/SKILL.md".to_string()));
        let skill = std::fs::read_to_string(dir.path().join(".claude/skills/lessons/SKILL.md")).unwrap();
        assert!(skill.starts_with("---\nname: lessons\n"));
        assert!(skill.contains("docs/adr"));
        assert!(skill.contains("grep -i '<key word>' docs/declines.jsonl"));
        assert!(!skill.contains("{{"));

        std::fs::write(dir.path().join(".claude/skills/lessons/SKILL.md"), "mine").unwrap();
        assert_eq!(ensure(dir.path()).unwrap(), None);
        assert_eq!(std::fs::read_to_string(dir.path().join(".claude/skills/lessons/SKILL.md")).unwrap(), "mine");
    }

    #[test]
    fn offer_prompt_quotes_the_sections_of_the_repository_skill() {
        let dir = worktree(Some(r#"{ "version": 3, "guardrailSkill": "lessons" }"#));
        std::fs::create_dir_all(dir.path().join(".claude/skills/lessons")).unwrap();
        std::fs::write(
            dir.path().join(".claude/skills/lessons/SKILL.md"),
            "intro\n<!-- hunt:criteria -->\nOnly lessons about ports.\n<!-- /hunt:criteria -->\n\
             <!-- hunt:kinds -->\nOnly rules.\n<!-- /hunt:kinds -->\nrest",
        )
        .unwrap();
        let prompt = offer_prompt(Some(dir.path()));
        assert!(prompt.contains("`/lessons` skill (`.claude/skills/lessons/SKILL.md`)"));
        assert!(prompt.contains("\n\nOnly lessons about ports.\n\n"));
        assert!(prompt.contains("\n\nOnly rules.\n\n"));
        assert!(!prompt.contains("{{"));
    }

    #[test]
    fn offer_prompt_falls_back_to_the_template_sections() {
        let template = template(DEFAULT_SKILL, DEFAULT_ADR_DIR, declined_guardrails::DEFAULT_DECLINES_FILE);
        let template_criteria = section_of(&template, CRITERIA_SECTION).unwrap();
        let template_kinds = section_of(&template, KINDS_SECTION).unwrap();
        assert!(template_criteria.starts_with("Yes only if"));
        assert!(template_kinds.starts_with("- **Rule**"));
        assert!(template_kinds.contains(DEFAULT_ADR_DIR));
        for prompt in [offer_prompt(None), offer_prompt(Some(worktree(None).path()))] {
            assert!(prompt.contains("`/guardrail` skill (`.claude/skills/guardrail/SKILL.md`)"));
            assert!(prompt.contains(&template_criteria));
            assert!(prompt.contains(&template_kinds));
            assert!(!prompt.contains("{{"));
        }
        let dir = worktree(None);
        std::fs::create_dir_all(dir.path().join(".claude/skills/guardrail")).unwrap();
        std::fs::write(dir.path().join(".claude/skills/guardrail/SKILL.md"), "no markers").unwrap();
        let prompt = offer_prompt(Some(dir.path()));
        assert!(prompt.contains(&template_criteria));
        assert!(prompt.contains(&template_kinds));
    }

    #[test]
    fn offer_prompt_fills_the_adr_folder_of_hunt_json_into_the_template_kinds() {
        let prompt = offer_prompt(Some(worktree(Some(r#"{ "version": 3, "adrDir": "docs/adr" }"#)).path()));
        assert!(prompt.contains("(`docs/adr/NNNN-title.md`)"));
    }
}
