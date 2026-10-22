//! Guardrail suggestions the user declined, kept with their repository in `declined-guardrails.json` in the app data
//! directory. The system prompt of every agent started in a repository lists that repository's declines, so the agent
//! neither suggests them again nor anything as narrow.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::session::store;

/// Lists the declined suggestions of the session's repository as examples of what not to suggest.
const PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/declined-guardrails.system-prompt.md"));

/// The kinds `<!-- hunt:guardrail KIND: … -->` may name (`KINDS` in `src/chat/guardrailSuggestion.ts`).
const KINDS: [&str; 5] = ["instruction", "rule", "skill", "agent", "adr"];

/// Serializes every read and read-modify-write cycle on the file.
static LOCK: Mutex<()> = Mutex::new(());

/// Why the user declined a suggestion, picked from the menu of the guardrail chat's "Decline" button.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeclineReason {
    TooSpecific,
    AlreadyRecorded,
    NotWanted,
}

impl DeclineReason {
    fn label(self) -> &'static str {
        match self {
            DeclineReason::TooSpecific => "too specific",
            DeclineReason::AlreadyRecorded => "already recorded",
            DeclineReason::NotWanted => "not wanted",
        }
    }
}

/// One declined suggestion: the repository its session works on, what the agent suggested and why the user declined it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclinedGuardrail {
    pub repo_path: PathBuf,
    pub kind: String,
    pub summary: String,
    pub reason: DeclineReason,
    pub session_id: Uuid,
    pub declined_at: chrono::DateTime<chrono::Utc>,
}

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(store::app_data_dir(app)?.join("declined-guardrails.json"))
}

/// Every stored decline, oldest first; an absent file counts as none. The caller holds `LOCK`.
fn load(path: &Path) -> Result<Vec<DeclinedGuardrail>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_str(&content).map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

/// Appends `entry` to the file at `path`, written to a sibling temp file and renamed over the target.
fn append(path: &Path, entry: DeclinedGuardrail) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut entries = load(path)?;
    entries.push(entry);
    let content = serde_json::to_string_pretty(&entries).map_err(|error| error.to_string())?;
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, content).map_err(|error| format!("failed to write {}: {error}", temp_path.display()))?;
    std::fs::rename(&temp_path, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp_path);
        format!("failed to replace {}: {error}", path.display())
    })
}

/// The prompt section listing the declines of `repo`, one line each; empty when the repository has none.
fn prompt_for(entries: &[DeclinedGuardrail], repo: &Path) -> String {
    let lines: Vec<String> = entries
        .iter()
        .filter(|entry| entry.repo_path == repo)
        .map(|entry| format!("- {}, {}: {}", entry.kind, entry.reason.label(), entry.summary.split_whitespace().collect::<Vec<_>>().join(" ")))
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    crate::graph::fill_prompt(PROMPT, &[("declinedGuardrails", &lines.join("\n"))])
}

/// The system prompt section on the declines of the repository of the Hunt session `hunt_session_id`; empty when it
/// has none or they cannot be read, which must not keep the agent from starting.
pub fn system_prompt(app: &AppHandle, hunt_session_id: Uuid) -> String {
    let section = (|| {
        let repo = store::find_session(app, hunt_session_id)?.repo_path;
        let path = file_path(app)?;
        let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok::<_, String>(prompt_for(&load(&path)?, &repo))
    })();
    section.unwrap_or_else(|error| {
        eprintln!("failed to list the declined guardrails: {error}");
        String::new()
    })
}

/// Records that the user declined the guardrail the agent of session `id` suggested; agents started in its repository
/// from now on get it listed in their system prompt.
#[tauri::command]
pub fn decline_guardrail(app: AppHandle, id: Uuid, kind: String, summary: String, reason: DeclineReason) -> Result<(), String> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("failed to record the declined guardrail: unknown kind {kind}"));
    }
    let record = store::find_session(&app, id)?;
    let entry = DeclinedGuardrail { repo_path: record.repo_path, kind, summary: summary.trim().to_string(), reason, session_id: id, declined_at: chrono::Utc::now() };
    append(&file_path(&app)?, entry).map_err(|error| format!("failed to record the declined guardrail: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(repo: &str, summary: &str, reason: DeclineReason) -> DeclinedGuardrail {
        DeclinedGuardrail { repo_path: repo.into(), kind: "skill".into(), summary: summary.into(), reason, session_id: Uuid::nil(), declined_at: chrono::Utc::now() }
    }

    #[test]
    fn append_keeps_every_decline_in_order() {
        let dir = std::env::temp_dir().join(format!("hunt-declined-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("declined-guardrails.json");
        for index in 0..12 {
            append(&path, entry("/repo", &format!("summary {index}"), DeclineReason::TooSpecific)).unwrap();
        }
        let entries = load(&path).unwrap();
        assert_eq!(entries.len(), 12);
        assert_eq!(entries[0].summary, "summary 0");
        assert_eq!(entries[11].summary, "summary 11");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prompt_lists_only_the_declines_of_the_repository() {
        let entries = [
            entry("/repo", "Check the migration\nin a rollback transaction", DeclineReason::TooSpecific),
            entry("/other", "Something else", DeclineReason::NotWanted),
            entry("/repo", "Use useLoad", DeclineReason::AlreadyRecorded),
        ];
        let prompt = prompt_for(&entries, Path::new("/repo"));
        assert!(prompt.contains("- skill, too specific: Check the migration in a rollback transaction\n- skill, already recorded: Use useLoad"));
        assert!(!prompt.contains("Something else"));
        assert!(!prompt.contains("{{"));
        assert_eq!(prompt_for(&entries, Path::new("/none")), "");
    }

    #[test]
    fn reasons_serialize_as_camel_case() {
        assert_eq!(serde_json::to_string(&DeclineReason::TooSpecific).unwrap(), "\"tooSpecific\"");
    }
}
