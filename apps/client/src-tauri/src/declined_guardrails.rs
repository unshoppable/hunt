//! Guardrail suggestions the user declined, kept with their repository in `declined-guardrails.json` in the app data
//! directory. `session::related` mirrors the declines of a session's repository into `WORKTREE_FILE` of its worktree,
//! which the agent searches before it suggests a guardrail (`prompts/guardrail-offer.system-prompt.md`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::session::store;

/// The declines of the worktree's repository, one JSON object per line, inside the worktree's `.hunt` folder.
pub const WORKTREE_FILE: &str = ".hunt/declined-guardrails.jsonl";

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

/// Every stored decline, oldest first.
pub fn load_all(app: &AppHandle) -> Result<Vec<DeclinedGuardrail>, String> {
    let path = file_path(app)?;
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    load(&path)
}

/// The content of `WORKTREE_FILE` for a worktree of `repo`: its declines, oldest first, each with kind, reason, summary
/// and date on one line; empty when the repository has none.
pub fn worktree_text(entries: &[DeclinedGuardrail], repo: &Path) -> String {
    entries
        .iter()
        .filter(|entry| entry.repo_path == repo)
        .map(|entry| {
            let line = serde_json::json!({
                "kind": entry.kind,
                "reason": entry.reason,
                "summary": entry.summary.split_whitespace().collect::<Vec<_>>().join(" "),
                "declinedAt": entry.declined_at.date_naive().to_string(),
            });
            format!("{line}\n")
        })
        .collect()
}

/// Records that the user declined the guardrail the agent of session `id` suggested and rewrites `WORKTREE_FILE` of
/// every worktree.
#[tauri::command]
pub fn decline_guardrail(app: AppHandle, id: Uuid, kind: String, summary: String, reason: DeclineReason) -> Result<(), String> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("failed to record the declined guardrail: unknown kind {kind}"));
    }
    let record = store::find_session(&app, id)?;
    let entry = DeclinedGuardrail { repo_path: record.repo_path, kind, summary: summary.trim().to_string(), reason, session_id: id, declined_at: chrono::Utc::now() };
    append(&file_path(&app)?, entry).map_err(|error| format!("failed to record the declined guardrail: {error}"))?;
    crate::session::related::refresh_all(&app);
    Ok(())
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
    fn the_worktree_file_lists_only_the_declines_of_the_repository() {
        let entries = [
            entry("/repo", "Check the migration\nin a rollback transaction", DeclineReason::TooSpecific),
            entry("/other", "Something else", DeclineReason::NotWanted),
            entry("/repo", "Use useLoad", DeclineReason::AlreadyRecorded),
        ];
        let text = worktree_text(&entries, Path::new("/repo"));
        let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["reason"], "tooSpecific");
        assert_eq!(lines[0]["summary"], "Check the migration in a rollback transaction");
        assert_eq!(lines[1]["kind"], "skill");
        assert!(!text.contains("Something else"));
        assert_eq!(worktree_text(&entries, Path::new("/none")), "");
    }

    #[test]
    fn reasons_serialize_as_camel_case() {
        assert_eq!(serde_json::to_string(&DeclineReason::TooSpecific).unwrap(), "\"tooSpecific\"");
    }
}
