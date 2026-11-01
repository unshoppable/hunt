//! The skills with which a repository refines the agent steps of Hunt's swf pipeline: `.claude/skills/<name>/SKILL.md`
//! for each step, named in `swf.steps.<step>.skill` of its hunt.json or in the older alias `swf.skills.<step>`, one of which
//! every agent step must set. Opening a session of a repository whose hunt.json has an `swf` section offers to add the
//! missing entries (under the names of `TEMPLATES`, `swf-<step>`) and to write the missing files from `TEMPLATES`
//! (`ensureSwfSkills` in `src/guardrails/swf-skills.utils.ts`), which the command `create_swf_skills` carries out.

use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::agent::guardrail_skill::{is_skill_name, skill_file};

/// The template of each agent step's skill, in the order of `AGENT_STEPS`; `{{skillName}}` is the repository's name of it.
const TEMPLATES: [(&str, &str); 5] = [
    ("plan", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-plan.skill.md"))),
    ("implement", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-implement.skill.md"))),
    ("verify", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-verify.skill.md"))),
    ("review", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-review.skill.md"))),
    ("pr", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/swf/swf-pr.skill.md"))),
];

/// The repository's Hunt configuration at the root of the worktree, whose `swf` section names the skill of each agent step.
const HUNT_JSON: &str = "hunt.json";

/// The skill `name` of the agent step `step` to create unless its file exists and, with `add_entry`, the entry of the step
/// to add to hunt.json unless the step names a skill there (`with_entries`), as the UI asks for them (`SwfStepSkill` in
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
/// `add_entry` to the worktree's hunt.json unless its step names a skill there (`with_entries`), after checking them all
/// (nothing is written when a step or name is invalid or hunt.json has no `swf` object); returns the worktree-relative
/// paths it wrote, `hunt.json` among them when an entry was added.
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

/// The text of `hunt_json`, which must hold an object `swf` (the dialog only appears for one), with the entry of each of
/// `entries` whose step names no skill yet (`name_skill`), pretty-printed with two spaces and a trailing newline; None when
/// every step names one, so that the file keeps its formatting.
fn with_entries(hunt_json: &Value, entries: &[&StepSkill]) -> Result<Option<String>, String> {
    let mut hunt_json = hunt_json.clone();
    let Some(swf) = hunt_json.get_mut("swf").and_then(Value::as_object_mut) else {
        return Err(format!("failed to add the skills to {HUNT_JSON}: it has no swf object"));
    };
    let mut inserted = false;
    for entry in entries {
        if !names_skill(swf, &entry.step) {
            name_skill(swf, entry)?;
            inserted = true;
        }
    }
    if !inserted {
        return Ok(None);
    }
    let text = serde_json::to_string_pretty(&hunt_json).map_err(|error| format!("failed to write {HUNT_JSON}: {error}"))?;
    Ok(Some(format!("{text}\n")))
}

/// Whether the `swf` object of a hunt.json names a skill for the agent step `step`: `swf.steps.<step>.skill` or the older
/// alias `swf.skills.<step>` is a non-empty string.
fn names_skill(swf: &Map<String, Value>, step: &str) -> bool {
    let named = |value: Option<&Value>| value.and_then(Value::as_str).is_some_and(|name| !name.is_empty());
    named(swf.get("steps").and_then(|steps| steps.get(step)).and_then(|settings| settings.get("skill")))
        || named(swf.get("skills").and_then(|skills| skills.get(step)))
}

/// Names the skill of `entry` for its step in `swf`: as `swf.steps.<step>.skill` when `swf.steps` is an object (creating
/// the step's object, keeping its other keys), else as `swf.skills.<step>` (creating `swf.skills`).
fn name_skill(swf: &mut Map<String, Value>, entry: &StepSkill) -> Result<(), String> {
    let name = Value::String(entry.name.clone());
    if let Some(steps) = swf.get_mut("steps").and_then(Value::as_object_mut) {
        let Some(settings) = steps.entry(entry.step.as_str()).or_insert_with(|| Value::Object(Map::new())).as_object_mut() else {
            return Err(format!("failed to add the skills to {HUNT_JSON}: swf.steps.{} is no object", entry.step));
        };
        settings.insert("skill".to_string(), name);
        return Ok(());
    }
    let Some(skills) = swf.entry("skills").or_insert_with(|| Value::Object(Map::new())).as_object_mut() else {
        return Err(format!("failed to add the skills to {HUNT_JSON}: swf.skills is no object"));
    };
    skills.insert(entry.step.clone(), name);
    Ok(())
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
        assert_eq!(steps, ["plan", "implement", "verify", "review", "pr"]);
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
    fn the_review_template_starts_with_the_default_criteria() {
        let content = render(&skill("review", "swf-review")).unwrap();
        let criteria = content.split("\n## Review criteria\n").nth(1).unwrap();
        assert!(criteria.contains("- **Correctness**:"));
        assert!(criteria.contains("- **Guardrails**:"));
        assert!(criteria.contains("- **Leftovers**:"));
        assert!(criteria.find("## This repository") > criteria.find("A finding is **blocking**"));
    }

    #[test]
    fn render_rejects_unknown_steps_and_bad_names() {
        assert!(render(&skill("checks", "swf-checks")).is_err());
        assert!(render(&skill("gate", "swf-gate")).is_err());
        assert!(render(&skill("plan", "Swf Plan")).is_err());
        assert!(render(&skill("plan", "")).is_err());
    }

    #[test]
    fn ensure_writes_only_the_missing_skills() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".claude/skills/swf-plan")).unwrap();
        std::fs::write(dir.path().join(".claude/skills/swf-plan/SKILL.md"), "mine").unwrap();

        let written = ensure(dir.path(), &[skill("plan", "swf-plan"), skill("review", "review-criteria")]).unwrap();
        assert_eq!(written, [".claude/skills/review-criteria/SKILL.md"]);
        assert_eq!(std::fs::read_to_string(dir.path().join(".claude/skills/swf-plan/SKILL.md")).unwrap(), "mine");
        let review = std::fs::read_to_string(dir.path().join(".claude/skills/review-criteria/SKILL.md")).unwrap();
        assert!(review.starts_with("---\nname: review-criteria\n"));
        assert!(ensure(dir.path(), &[skill("review", "review-criteria")]).unwrap().is_empty());
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
        write_hunt_json(dir.path(), r#"{"version": 3, "swf": {"repository": "acme/app", "skills": {"review": "acme-review"}}, "checks": {}}"#);

        let written = ensure(dir.path(), &[entry("plan", "swf-plan"), entry("review", "swf-review"), skill("pr", "swf-pr")]).unwrap();
        let files = [".claude/skills/swf-plan/SKILL.md", ".claude/skills/swf-review/SKILL.md", ".claude/skills/swf-pr/SKILL.md", HUNT_JSON];
        assert_eq!(written, files);
        let expected = concat!(
            "{\n  \"version\": 3,\n  \"swf\": {\n    \"repository\": \"acme/app\",\n    \"skills\": {\n",
            "      \"review\": \"acme-review\",\n      \"plan\": \"swf-plan\"\n    }\n  },\n  \"checks\": {}\n}\n"
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
    fn ensure_adds_the_missing_entries_to_swf_steps_keeping_the_keys_of_each_step() {
        let dir = tempfile::tempdir().unwrap();
        let original = r#"{"swf": {"steps": {"plan": {"model": "opus"}, "verify": {"skill": "my-verify"}, "checks": {"maxReturns": 2}}}}"#;
        write_hunt_json(dir.path(), original);

        let skills = [entry("plan", "swf-plan"), entry("verify", "swf-verify"), entry("pr", "swf-pr")];
        let written = ensure(dir.path(), &skills).unwrap();
        let files = [".claude/skills/swf-plan/SKILL.md", ".claude/skills/swf-verify/SKILL.md", ".claude/skills/swf-pr/SKILL.md", HUNT_JSON];
        assert_eq!(written, files);
        let expected = concat!(
            "{\n  \"swf\": {\n    \"steps\": {\n",
            "      \"plan\": {\n        \"model\": \"opus\",\n        \"skill\": \"swf-plan\"\n      },\n",
            "      \"verify\": {\n        \"skill\": \"my-verify\"\n      },\n",
            "      \"checks\": {\n        \"maxReturns\": 2\n      },\n",
            "      \"pr\": {\n        \"skill\": \"swf-pr\"\n      }\n    }\n  }\n}\n"
        );
        assert_eq!(read_hunt_json_text(dir.path()), expected);
    }

    #[test]
    fn ensure_takes_either_form_as_the_skill_of_a_step() {
        let dir = tempfile::tempdir().unwrap();
        let original = r#"{"swf": {"steps": {"plan": {"skill": ""}, "review": {}}, "skills": {"review": "acme-review", "plan": ""}}}"#;
        write_hunt_json(dir.path(), original);

        let written = ensure(dir.path(), &[entry("review", "swf-review"), entry("plan", "swf-plan")]).unwrap();
        assert_eq!(written, [".claude/skills/swf-review/SKILL.md", ".claude/skills/swf-plan/SKILL.md", HUNT_JSON]);
        let expected = concat!(
            "{\n  \"swf\": {\n    \"steps\": {\n",
            "      \"plan\": {\n        \"skill\": \"swf-plan\"\n      },\n",
            "      \"review\": {}\n    },\n",
            "    \"skills\": {\n      \"review\": \"acme-review\",\n      \"plan\": \"\"\n    }\n  }\n}\n"
        );
        assert_eq!(read_hunt_json_text(dir.path()), expected);
    }

    #[test]
    fn ensure_writes_nothing_for_a_step_of_swf_steps_that_is_no_object() {
        let dir = tempfile::tempdir().unwrap();
        let original = r#"{"swf": {"steps": {"plan": "swf-plan"}}}"#;
        write_hunt_json(dir.path(), original);

        let error = ensure(dir.path(), &[entry("plan", "swf-plan")]).unwrap_err();
        assert!(error.contains("swf.steps.plan"), "{error}");
        assert!(!dir.path().join(".claude").exists());
        assert_eq!(read_hunt_json_text(dir.path()), original);
    }

    #[test]
    fn ensure_leaves_hunt_json_alone_when_every_entry_exists() {
        let dir = tempfile::tempdir().unwrap();
        let original = "{\n    \"swf\": {\"steps\": {\"verify\": {\"skill\": \"acme-verify\"}}, \"skills\": {\"plan\": \"acme-plan\"}}\n}";
        write_hunt_json(dir.path(), original);

        let written = ensure(dir.path(), &[entry("plan", "swf-plan"), entry("verify", "swf-verify")]).unwrap();
        assert_eq!(written, [".claude/skills/swf-plan/SKILL.md", ".claude/skills/swf-verify/SKILL.md"]);
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
