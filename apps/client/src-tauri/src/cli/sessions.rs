//! `hunt sessions`: the stored sessions as a table, or as JSON.

use std::path::Path;

use crate::session::session_id::SessionId;
use crate::session::store::{self, SessionRecord};

/// The column headings of the table.
const HEADINGS: [&str; 5] = ["ID", "CREATED", "WHERE", "BRANCH", "TITLE"];

/// Prints the sessions stored in the app data folder `data_dir`: with `as_json` as they are stored, else as a table.
pub fn list(data_dir: &Path, as_json: bool) -> Result<(), String> {
    let sessions = in_list_order(store::read_sessions(data_dir)?);
    if as_json {
        let json = serde_json::to_string_pretty(&sessions).map_err(|error| format!("failed to write the sessions as JSON: {error}"))?;
        println!("{json}");
        return Ok(());
    }
    print!("{}", table(&sessions));
    Ok(())
}

/// `sessions` oldest first, as Hunt's sidebar lists them, each sub chat right below its session; a sub chat whose
/// session is gone comes last.
fn in_list_order(mut sessions: Vec<SessionRecord>) -> Vec<SessionRecord> {
    sessions.sort_by_key(|session| session.created_at);
    let (sub_chats, top_level): (Vec<SessionRecord>, Vec<SessionRecord>) = sessions.into_iter().partition(|session| session.parent_id.is_some());
    let mut ordered = Vec::new();
    for session in top_level {
        let id = session.id;
        ordered.push(session);
        ordered.extend(sub_chats.iter().filter(|sub_chat| sub_chat.parent_id == Some(id)).cloned());
    }
    let orphans: Vec<SessionRecord> = sub_chats.into_iter().filter(|sub_chat| !ordered.iter().any(|listed| listed.id == sub_chat.id)).collect();
    ordered.extend(orphans);
    ordered
}

/// The table of `sessions`: one row each, columns padded to their widest cell, the title last; a sub chat's title is
/// marked with `↳`.
fn table(sessions: &[SessionRecord]) -> String {
    if sessions.is_empty() {
        return "no sessions\n".to_string();
    }
    let rows: Vec<[String; 5]> = sessions.iter().map(row).collect();
    let mut widths = HEADINGS.map(|heading| heading.chars().count());
    for cells in &rows {
        for (index, cell) in cells.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    let mut text = String::new();
    for cells in std::iter::once(HEADINGS.map(str::to_string)).chain(rows) {
        let mut line = String::new();
        for (index, cell) in cells.iter().enumerate() {
            if index + 1 == cells.len() {
                line.push_str(cell);
            } else {
                line.push_str(&format!("{cell:<width$}  ", width = widths[index]));
            }
        }
        text.push_str(line.trim_end());
        text.push('\n');
    }
    text
}

/// The cells of `session`: its short ID, creation time in local time, the VM it runs on or `local`, branch and title.
fn row(session: &SessionRecord) -> [String; 5] {
    let place = match &session.remote {
        Some(remote) => remote.vm.instance.clone(),
        None => "local".to_string(),
    };
    let title = match session.parent_id {
        Some(_) => format!("↳ {}", session.title),
        None => session.title.clone(),
    };
    let created = session.created_at.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string();
    [SessionId(session.id).short(), created, place, session.branch.clone(), title]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stored session with `id`, `title` and `created_at`, under `parent_id` if given, on a VM when `instance` is.
    fn session(id: &str, title: &str, created_at: &str, parent_id: Option<&str>, instance: Option<&str>) -> SessionRecord {
        let remote = instance.map(|instance| {
            serde_json::json!({
                "vm": { "project": "acme", "zone": "europe-west1-c", "instance": instance },
                "worktreePath": "/srv/hunt/sessions/1/worktree",
                "repo": "git@github.com:acme/app.git",
                "branch": "feat/general/login",
                "handoffHead": "abc",
                "handedOffAt": created_at
            })
        });
        serde_json::from_value(serde_json::json!({
            "id": id,
            "title": title,
            "repoPath": "/repo",
            "worktreePath": "/worktrees/1",
            "branch": "feat/general/login",
            "baseRef": "master",
            "baseCommit": "abc",
            "acpSessionId": null,
            "createdAt": created_at,
            "parentId": parent_id,
            "remote": remote
        }))
        .unwrap()
    }

    #[test]
    fn sub_chats_follow_their_session_and_orphans_come_last() {
        let ordered = in_list_order(vec![
            session("cccccccc-0000-4000-8000-000000000003", "Sub chat", "2026-10-27T12:00:00Z", Some("aaaaaaaa-0000-4000-8000-000000000001"), None),
            session("bbbbbbbb-0000-4000-8000-000000000002", "Second", "2026-10-27T11:00:00Z", None, None),
            session("dddddddd-0000-4000-8000-000000000004", "Orphan", "2026-10-27T09:00:00Z", Some("eeeeeeee-0000-4000-8000-000000000005"), None),
            session("aaaaaaaa-0000-4000-8000-000000000001", "First", "2026-10-27T10:00:00Z", None, None),
        ]);
        let titles: Vec<&str> = ordered.iter().map(|session| session.title.as_str()).collect();
        assert_eq!(titles, ["First", "Sub chat", "Second", "Orphan"]);
    }

    #[test]
    fn the_table_shows_where_each_session_runs() {
        let text = table(&[
            session("aaaaaaaa-0000-4000-8000-000000000001", "Fix the login", "2026-10-27T10:00:00Z", None, Some("vm-hunt-s-aaaaaaaa")),
            session("bbbbbbbb-0000-4000-8000-000000000002", "Ask about it", "2026-10-27T11:00:00Z", Some("aaaaaaaa-0000-4000-8000-000000000001"), None),
        ]);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].starts_with("ID        CREATED           WHERE               BRANCH              TITLE"), "{text}");
        assert!(lines[1].starts_with("aaaaaaaa  ") && lines[1].contains("  vm-hunt-s-aaaaaaaa  feat/general/login  Fix the login"), "{text}");
        assert!(lines[2].starts_with("bbbbbbbb  ") && lines[2].contains("  local               feat/general/login  ↳ Ask about it"), "{text}");
        assert_eq!(table(&[]), "no sessions\n");
    }

    #[test]
    fn the_sessions_are_read_from_the_app_data_folder() {
        let data_dir = tempfile::tempdir().unwrap();
        assert!(store::read_sessions(data_dir.path()).unwrap().is_empty());
        let stored = vec![session("aaaaaaaa-0000-4000-8000-000000000001", "First", "2026-10-27T10:00:00Z", None, None)];
        std::fs::write(data_dir.path().join("sessions.json"), serde_json::to_string(&stored).unwrap()).unwrap();
        assert_eq!(store::read_sessions(data_dir.path()).unwrap()[0].title, "First");
    }
}
