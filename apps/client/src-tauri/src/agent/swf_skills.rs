//! The skills with which a repository refines the agent steps of Hunt's swf pipeline: `.claude/skills/<name>/SKILL.md`
//! for each step, named in `swf.skills` of its hunt.json, which must have an entry for every agent step. Opening a session
//! of a repository whose hunt.json has an `swf` section offers to add the missing entries (under the names of `TEMPLATES`,
//! `swf-<step>`) and to write the missing files from `TEMPLATES` (`ensureSwfSkills` in `src/guardrails/swf-skills.utils.ts`),
//! which the command `create_swf_skills` carries out.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use crate::agent::guardrail_skill::{is_skill_name, skill_file};

/// The template of each agent step's skill, in the order of `AGENT_STEPS`; `{{skillName}}` is the repository's name of it.
const TEMPLATES: [(&str, &str); 5] = [
    ("plan", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-plan.skill.md"))),
    ("implement", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-implement.skill.md"))),
    ("verify", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-verify.skill.md"))),
    ("gate", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-gate.skill.md"))),
    ("pr", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-pr.skill.md"))),
];

/// The repository's Hunt configuration at the root of the worktree, whose `swf.skills` names the skill of each agent step.
const HUNT_JSON: &str = "hunt.json";

/// The skill `name` of the agent step `step` to create unless its file exists and, with `add_entry`, the entry
/// `swf.skills.<step>` of hunt.json to add unless it exists, as the UI asks for them (`SwfStepSkill` in
/// `src/guardrails/guardrail.types.ts`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepSkill {
    pub step: String,
    pub name: String,
    pub add_entry: bool,
}

/// The skill file of `skill` filled from its step's template; rejects an unknown step or a name Claude Code does not accept.
pub fn render(skill: &StepSkill) -> Result<String, String> {
    let Some((_, template)) = TEMPLATES.iter().find(|(step, _)| *step == skill.step) else {
        return Err(format!("failed to create the skill of the swf step {}: unknown step", skill.step));
    };
    if !is_skill_name(&skill.name) {
        return Err(format!("failed to create the skill of the swf step {}: {:?} is no skill name", skill.step, skill.name));
    }
    Ok(crate::graph::fill_prompt(template, &[("skillName", &skill.name)]))
}

/// Writes each of `skills` from its template into `worktree` unless its file exists and adds the entry of each with
/// `add_entry` to `swf.skills` of the worktree's hunt.json unless it exists, after checking them all (nothing is written
/// when a step or name is invalid or hunt.json has no `swf` object); returns the worktree-relative paths it wrote,
/// `hunt.json` among them when an entry was added.
pub fn ensure(worktree: &Path, skills: &[StepSkill]) -> Result<Vec<String>, String> {
    let rendered = skills.iter().map(|skill| Ok((skill_file(&skill.name), render(skill)?))).collect::<Result<Vec<_>, String>>()?;
    let entries: Vec<&StepSkill> = skills.iter().filter(|skill| skill.add_entry).collect();
    let hunt_json = if entries.is_empty() { None } else { with_entries(&read_hunt_json(worktree)?, &entries)? };
    let mut written = Vec::new();
    for (file, content) in rendered {
        let path = worktree.join(&file);
        if path.exists() {
            continue;
        }
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
        }
        std::fs::write(&path, content).map_err(|error| format!("failed to write {file}: {error}"))?;
        written.push(file);
    }
    if let Some(content) = hunt_json {
        std::fs::write(worktree.join(HUNT_JSON), content).map_err(|error| format!("failed to write {HUNT_JSON}: {error}"))?;
        written.push(HUNT_JSON.to_string());
    }
    Ok(written)
}

/// The parsed hunt.json of `worktree`.
fn read_hunt_json(worktree: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(worktree.join(HUNT_JSON)).map_err(|error| format!("failed to read {HUNT_JSON}: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("failed to read {HUNT_JSON}: {error}"))
}

/// The text of `hunt_json`, which must hold an object `swf` (the dialog only appears for one), with the entry
/// `swf.skills.<step>` of each of `entries` whose step has none yet, pretty-printed with two spaces and a trailing
/// newline; None when every entry exists, so that the file keeps its formatting.
fn with_entries(hunt_json: &Value, entries: &[&StepSkill]) -> Result<Option<String>, String> {
    let mut hunt_json = hunt_json.clone();
    let Some(swf) = hunt_json.get_mut("swf").and_then(Value::as_object_mut) else {
        return Err(format!("failed to add the skills to {HUNT_JSON}: it has no swf object"));
    };
    let Some(skills) = swf.entry("skills").or_insert_with(|| Value::Object(Default::default())).as_object_mut() else {
        return Err(format!("failed to add the skills to {HUNT_JSON}: swf.skills is no object"));
    };
    let mut inserted = false;
    for entry in entries {
        if skills.contains_key(&entry.step) {
            continue;
        }
        skills.insert(entry.step.clone(), Value::String(entry.name.clone()));
        inserted = true;
    }
    if !inserted {
        return Ok(None);
    }
    let text = serde_json::to_string_pretty(&hunt_json).map_err(|error| format!("failed to write {HUNT_JSON}: {error}"))?;
    Ok(Some(format!("{text}\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(step: &str, name: &str) -> StepSkill {
        StepSkill { step: step.to_string(), name: name.to_string(), add_entry: false }
    }

    fn entry(step: &str, name: &str) -> StepSkill {
        StepSkill { add_entry: true, ..skill(step, name) }
    }

    fn write_hunt_json(worktree: &Path, text: &str) {
        std::fs::write(worktree.join(HUNT_JSON), text).unwrap();
    }

    fn read_hunt_json_text(worktree: &Path) -> String {
        std::fs::read_to_string(worktree.join(HUNT_JSON)).unwrap()
    }

    #[test]
    fn templates_follow_the_agent_steps() {
        let steps: Vec<&str> = TEMPLATES.iter().map(|(step, _)| *step).collect();
        assert_eq!(steps, ["plan", "implement", "verify", "gate", "pr"]);
    }

    #[test]
    fn every_template_renders_a_complete_skill_file() {
        for (step, _) in TEMPLATES {
            let name = format!("team-{step}");
            let content = render(&skill(step, &name)).unwrap();
            let front_matter = format!("---\nname: {name}\ndescription: Refines the {step} step of Hunt's swf pipeline");
            assert!(content.starts_with(&front_matter), "{step}");
            assert!(content.contains("\n---\n\n# "), "{step}");
            assert!(content.contains("\n## This repository\n"), "{step}");
            assert!(content.contains("TODO: "), "{step}");
            assert!(!content.contains("{{"), "{step}");
        }
    }

    #[test]
    fn the_gate_template_starts_with_the_default_rubric() {
        let content = render(&skill("gate", "swf-gate")).unwrap();
        let rubric = content.split("\n## Review necessity\n").nth(1).unwrap();
        assert!(rubric.contains("A person must review when any of these holds:\n\n- it touches data migrations or schemas;"));
        assert!(rubric.contains("No person is needed when the change consists only of:\n\n- isolated texts;"));
        assert!(rubric.find("## This repository") > rubric.find("No person is needed"));
    }

    #[test]
    fn render_rejects_unknown_steps_and_bad_names() {
        assert!(render(&skill("review", "swf-review")).is_err());
        assert!(render(&skill("plan", "Swf Plan")).is_err());
        assert!(render(&skill("plan", "")).is_err());
    }

    #[test]
    fn ensure_writes_only_the_missing_skills() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude/skills/swf-plan")).unwrap();
        std::fs::write(dir.path().join(".claude/skills/swf-plan/SKILL.md"), "mine").unwrap();

        let written = ensure(dir.path(), &[skill("plan", "swf-plan"), skill("gate", "review-rubric")]).unwrap();
        assert_eq!(written, [".claude/skills/review-rubric/SKILL.md"]);
        assert_eq!(std::fs::read_to_string(dir.path().join(".claude/skills/swf-plan/SKILL.md")).unwrap(), "mine");
        let gate = std::fs::read_to_string(dir.path().join(".claude/skills/review-rubric/SKILL.md")).unwrap();
        assert!(gate.starts_with("---\nname: review-rubric\n"));
        assert!(ensure(dir.path(), &[skill("gate", "review-rubric")]).unwrap().is_empty());
        assert!(!dir.path().join(HUNT_JSON).exists());
    }

    #[test]
    fn ensure_writes_nothing_when_one_skill_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure(dir.path(), &[skill("plan", "swf-plan"), skill("merge", "swf-merge")]).is_err());
        assert!(!dir.path().join(".claude").exists());
    }

    #[test]
    fn ensure_adds_the_missing_entries_keeping_the_other_keys_in_their_order() {
        let dir = tempfile::tempdir().unwrap();
        write_hunt_json(dir.path(), r#"{"version": 3, "swf": {"repository": "acme/app", "skills": {"gate": "acme-gate"}}, "checks": {}}"#);

        let written = ensure(dir.path(), &[entry("plan", "swf-plan"), entry("gate", "swf-gate"), skill("pr", "swf-pr")]).unwrap();
        let files = [".claude/skills/swf-plan/SKILL.md", ".claude/skills/swf-gate/SKILL.md", ".claude/skills/swf-pr/SKILL.md", HUNT_JSON];
        assert_eq!(written, files);
        let expected = concat!(
            "{\n  \"version\": 3,\n  \"swf\": {\n    \"repository\": \"acme/app\",\n    \"skills\": {\n",
            "      \"gate\": \"acme-gate\",\n      \"plan\": \"swf-plan\"\n    }\n  },\n  \"checks\": {}\n}\n"
        );
        assert_eq!(read_hunt_json_text(dir.path()), expected);
    }

    #[test]
    fn ensure_creates_the_skills_object_of_an_swf_section_without_one() {
        let dir = tempfile::tempdir().unwrap();
        write_hunt_json(dir.path(), r#"{"swf": {"repository": "acme/app"}}"#);

        let written = ensure(dir.path(), &[entry("verify", "swf-verify")]).unwrap();
        assert_eq!(written, [".claude/skills/swf-verify/SKILL.md", HUNT_JSON]);
        let expected = concat!(
            "{\n  \"swf\": {\n    \"repository\": \"acme/app\",\n    \"skills\": {\n",
            "      \"verify\": \"swf-verify\"\n    }\n  }\n}\n"
        );
        assert_eq!(read_hunt_json_text(dir.path()), expected);
    }

    #[test]
    fn ensure_leaves_hunt_json_alone_when_every_entry_exists() {
        let dir = tempfile::tempdir().unwrap();
        let original = "{\n    \"swf\": {\"skills\": {\"plan\": \"acme-plan\"}}\n}";
        write_hunt_json(dir.path(), original);

        let written = ensure(dir.path(), &[entry("plan", "swf-plan")]).unwrap();
        assert_eq!(written, [".claude/skills/swf-plan/SKILL.md"]);
        assert_eq!(read_hunt_json_text(dir.path()), original);
    }

    #[test]
    fn ensure_writes_nothing_without_an_swf_object() {
        for hunt_json in [None, Some("{}"), Some(r#"{"swf": []}"#), Some(r#"{"swf": {"skills": "all"}}"#), Some("not json")] {
            let dir = tempfile::tempdir().unwrap();
            if let Some(text) = hunt_json {
                write_hunt_json(dir.path(), text);
            }
            let error = ensure(dir.path(), &[skill("pr", "swf-pr"), entry("plan", "swf-plan")]).unwrap_err();
            assert!(error.contains(HUNT_JSON), "{hunt_json:?}: {error}");
            assert!(!dir.path().join(".claude").exists(), "{hunt_json:?}");
            if let Some(text) = hunt_json {
                assert_eq!(read_hunt_json_text(dir.path()), text);
            }
        }
    }
}
