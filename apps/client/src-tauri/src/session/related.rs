//! `.hunt/sessions.md` of a worktree: what the agents that work in it are told about one another. Hunt writes one
//! file per family (a session and its sub chats, which share the worktree) with every session's id, role, title,
//! whether its agent works right now, where it runs and the path of its transcript on each machine that has a copy,
//! and points the agents at it from the system prompt (`libs/domain/prompts/sessions.system-prompt.md`). The file is
//! written anew whenever the stored sessions change, a summary gave a session its title, an agent started or stopped
//! or a turn started or ended, and reaches the VM of a connected remote session through its file sync's copy
//! (`session::sync::copy_files`), a little later and once for every burst of changes. The `.hunt` folder is excluded
//! from Git and left out of the file sync, so the file never reaches the repository.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::remote::sync::Direction;
use crate::remote::transcript::{local_project, remote_project};
use crate::remote::{claude_dir, RemoteTarget};
use crate::session::store::{self, SessionRecord};
use crate::session::sync;

/// The file, inside the worktree's `.hunt` folder.
pub const SESSIONS_FILE: &str = ".hunt/sessions.md";
/// How long changes are gathered before the file goes to the VM.
const PUSH_DELAY: Duration = Duration::from_millis(800);

/// What the file tells of the agents: which sessions have one, and whether it runs a turn.
#[derive(Default)]
pub struct RelatedRegistry {
    /// The sessions whose agent is connected, with whether its turn runs.
    agents: Mutex<HashMap<Uuid, bool>>,
    /// The remote sessions whose file is to go to their VM.
    to_push: Mutex<HashSet<Uuid>>,
    is_pushing: AtomicBool,
}

/// What a session's agent is doing, as the file says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentState {
    Working,
    Idle,
    NotRunning,
}

impl AgentState {
    fn label(self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::Idle => "idle",
            AgentState::NotRunning => "not running",
        }
    }
}

/// Records that the agent of `id` is connected and idle, and refreshes the file of its family.
pub fn agent_started(app: &AppHandle, id: Uuid) {
    app.state::<RelatedRegistry>().agents.lock().unwrap().insert(id, false);
    refresh_family(app, id);
}

/// Records that the agent of `id` ended, and refreshes the file of its family.
pub fn agent_stopped(app: &AppHandle, id: Uuid) {
    app.state::<RelatedRegistry>().agents.lock().unwrap().remove(&id);
    refresh_family(app, id);
}

/// Records whether the agent of `id` runs a turn, and refreshes the file of its family when that changed.
pub fn set_turn(app: &AppHandle, id: Uuid, is_running: bool) {
    let changed = {
        let registry = app.state::<RelatedRegistry>();
        let mut agents = registry.agents.lock().unwrap();
        let Some(running) = agents.get_mut(&id) else { return };
        std::mem::replace(running, is_running) != is_running
    };
    if changed {
        refresh_family(app, id);
    }
}

/// Writes the file of the family of `id` (its own, or its parent's for a sub chat) anew; a failure is only logged.
pub fn refresh_family(app: &AppHandle, id: Uuid) {
    let owner = store::find_session(app, id).ok().map(|record| record.parent_id.unwrap_or(record.id)).unwrap_or(id);
    if let Err(error) = refresh(app, &[owner]) {
        eprintln!("writing the sessions file of session {owner} failed: {error}");
    }
}

/// Writes the file of every family anew; a failure is only logged.
pub fn refresh_all(app: &AppHandle) {
    let owners: Vec<Uuid> = match store::load_sessions(app) {
        Ok(sessions) => sessions.iter().filter(|record| record.parent_id.is_none()).map(|record| record.id).collect(),
        Err(error) => {
            eprintln!("writing the sessions files failed: {error}");
            return;
        }
    };
    if let Err(error) = refresh(app, &owners) {
        eprintln!("writing the sessions files failed: {error}");
    }
}

fn refresh(app: &AppHandle, owners: &[Uuid]) -> Result<(), String> {
    let sessions = store::load_sessions(app)?;
    let claude = claude_dir()?;
    let agents = app.state::<RelatedRegistry>().agents.lock().unwrap().clone();
    let state_of = |record: &SessionRecord| match agents.get(&record.id) {
        Some(true) => AgentState::Working,
        Some(false) => AgentState::Idle,
        None => AgentState::NotRunning,
    };
    for owner in owners {
        let Some(record) = sessions.iter().find(|record| record.id == *owner) else { continue };
        if !record.worktree_path.is_dir() {
            continue;
        }
        let sub_chats: Vec<&SessionRecord> = sessions.iter().filter(|session| session.parent_id == Some(*owner)).collect();
        let text = render(record, &sub_chats, &claude, &state_of);
        write_atomic(&record.worktree_path.join(SESSIONS_FILE), &text)?;
        if record.remote.is_some() && sync::is_syncing(app, *owner) {
            push_later(app, *owner);
        }
    }
    Ok(())
}

/// The file of the family of `owner`.
fn render(owner: &SessionRecord, sub_chats: &[&SessionRecord], claude_dir: &Path, state_of: &dyn Fn(&SessionRecord) -> AgentState) -> String {
    let mut text = String::from(
        "# Sessions in this worktree\n\nHunt writes this file; do not edit it. Every session below works in this worktree. A transcript path is \
         given for each machine that has a copy; use the one of the machine you run on. A transcript is JSONL, one record per line, \
         and large: read only the records you need.\n",
    );
    let project = local_project(&owner.worktree_path, claude_dir);
    let remote = owner.remote.as_ref();
    text.push_str(&section(owner, "the session", remote, &project, state_of(owner)));
    for sub_chat in sub_chats {
        let role = match &sub_chat.selection {
            Some(selection) => match &selection.task {
                Some(task) => format!("a sub chat of the session for the task: {}", task.trim()),
                None => format!("a sub chat of the session, opened from `{}` lines {}-{}", selection.path, selection.start_line, selection.end_line),
            },
            None => "a sub chat of the session".to_string(),
        };
        text.push_str(&section(sub_chat, &role, remote, &project, state_of(sub_chat)));
    }
    text
}

/// The section of one session; `remote` is where the family's session runs when it runs on a VM.
fn section(record: &SessionRecord, role: &str, remote: Option<&RemoteTarget>, project: &Path, state: AgentState) -> String {
    let mut text = format!("\n## {}\n\n- Hunt session id: `{}`\n- Role: {role}\n- Agent: {}\n", record.title.trim(), record.id, state.label());
    let runs_on = match (record.parent_id, remote) {
        (None, Some(target)) => format!("the session VM `{}`", target.vm.instance),
        _ => "the desktop".to_string(),
    };
    text.push_str(&format!("- Agent runs on: {runs_on}\n"));
    match &record.acp_session_id {
        Some(acp_session_id) => {
            text.push_str(&format!("- Transcript on the desktop: `{}`\n", project.join(format!("{acp_session_id}.jsonl")).display()));
            if let Some(target) = remote {
                let remote_project = remote_project(&target.worktree_path.display().to_string());
                text.push_str(&format!("- Transcript on the VM: `{remote_project}/{acp_session_id}.jsonl`\n"));
            }
        }
        None => text.push_str("- Transcript: none yet\n"),
    }
    if !record.summary.is_empty() {
        text.push_str("- So far:\n");
        for line in &record.summary {
            text.push_str(&format!("  - {}\n", line.trim()));
        }
    }
    text
}

/// Writes `text` to `path` through a temporary file, creating the folder as needed.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let folder = path.parent().ok_or_else(|| format!("failed to write {}: it has no folder", path.display()))?;
    std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
    let temporary = path.with_extension("md.tmp");
    std::fs::write(&temporary, text)
        .and_then(|()| std::fs::rename(&temporary, path))
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

/// Has the file of the remote session `owner` copied to its VM after `PUSH_DELAY`, together with every other asked for
/// meanwhile.
fn push_later(app: &AppHandle, owner: Uuid) {
    let registry = app.state::<RelatedRegistry>();
    registry.to_push.lock().unwrap().insert(owner);
    if registry.is_pushing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PUSH_DELAY).await;
            let owners: Vec<Uuid> = std::mem::take(&mut *app.state::<RelatedRegistry>().to_push.lock().unwrap()).into_iter().collect();
            for owner in owners {
                if !sync::is_syncing(&app, owner) {
                    continue;
                }
                if let Err(error) = sync::copy_files(&app, owner, Direction::Push, &[SESSIONS_FILE.to_string()]).await {
                    eprintln!("copying the sessions file of session {owner} to its VM failed: {error}");
                }
            }
            let registry = app.state::<RelatedRegistry>();
            let to_push = registry.to_push.lock().unwrap();
            if to_push.is_empty() {
                // Decided under the lock, so a request that comes now sees the task gone and starts a new one.
                registry.is_pushing.store(false, Ordering::SeqCst);
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{RemoteOrigin, VmRef};
    use crate::session::store::SelectionContext;
    use std::path::PathBuf;

    fn record(id: Uuid, title: &str) -> SessionRecord {
        SessionRecord::new(id, title.into(), PathBuf::from("/repo"), PathBuf::from("/Users/jane/wt"), "b".into(), "main".into(), "c".into())
    }

    #[test]
    fn the_file_names_every_session_with_its_role_state_and_transcripts() {
        let (owner_id, sub_id, task_id) = (Uuid::nil(), Uuid::from_u128(1), Uuid::from_u128(2));
        let mut owner = record(owner_id, "Fix login");
        owner.acp_session_id = Some("abc".into());
        owner.summary = vec!["Found the bug in auth.ts".into()];
        owner.remote = Some(RemoteTarget {
            vm: VmRef { project: "p".into(), zone: "z".into(), instance: "vm-hunt-s-0000".into() },
            worktree_path: PathBuf::from("/home/agent/app"),
            repo: "acme/app".into(),
            branch: "b".into(),
            handoff_head: "c".into(),
            handed_off_at: chrono::Utc::now(),
            local_mode: None,
            last_active_at: None,
            cleanup_asked_at: None,
            preview_domain: None,
            origin: RemoteOrigin::default(),
            issue: None,
            agent: String::new(),
        });
        let selection = SelectionContext { path: "src/auth.ts".into(), start_line: 3, end_line: 9, text: "x".into(), task: None };
        let mut sub = SessionRecord::sub_session(sub_id, "Why this check?".into(), &owner, Some(selection));
        sub.acp_session_id = Some("def".into());
        let task = SelectionContext { path: "README.md".into(), start_line: 1, end_line: 1, text: String::new(), task: Some("Write the file".into()) };
        let task_sub = SessionRecord::sub_session(task_id, "README".into(), &owner, Some(task));
        let state_of = |record: &SessionRecord| if record.id == sub_id { AgentState::Working } else if record.id == owner_id { AgentState::Idle } else { AgentState::NotRunning };

        let text = render(&owner, &[&sub, &task_sub], Path::new("/Users/jane/.claude"), &state_of);

        assert!(text.starts_with("# Sessions in this worktree\n\nHunt writes this file; do not edit it."));
        assert!(text.contains(
            "\n## Fix login\n\n- Hunt session id: `00000000-0000-0000-0000-000000000000`\n- Role: the session\n- Agent: idle\n- Agent runs on: the session VM `vm-hunt-s-0000`\n\
             - Transcript on the desktop: `/Users/jane/.claude/projects/-Users-jane-wt/abc.jsonl`\n\
             - Transcript on the VM: `/home/agent/.claude/projects/-home-agent-app/abc.jsonl`\n- So far:\n  - Found the bug in auth.ts\n"
        ));
        assert!(text.contains(
            "\n## Why this check?\n\n- Hunt session id: `00000000-0000-0000-0000-000000000001`\n- Role: a sub chat of the session, opened from `src/auth.ts` lines 3-9\n\
             - Agent: working\n- Agent runs on: the desktop\n- Transcript on the desktop: `/Users/jane/.claude/projects/-Users-jane-wt/def.jsonl`\n\
             - Transcript on the VM: `/home/agent/.claude/projects/-home-agent-app/def.jsonl`\n"
        ));
        assert!(text.contains("\n## README\n\n- Hunt session id: `00000000-0000-0000-0000-000000000002`\n- Role: a sub chat of the session for the task: Write the file\n- Agent: not running\n- Agent runs on: the desktop\n- Transcript: none yet\n"));
    }

    #[test]
    fn a_local_session_lists_only_desktop_transcripts() {
        let mut owner = record(Uuid::nil(), "Local");
        owner.acp_session_id = Some("abc".into());
        let text = render(&owner, &[], Path::new("/Users/jane/.claude"), &|_| AgentState::NotRunning);
        assert!(text.contains("- Agent runs on: the desktop\n- Transcript on the desktop: `/Users/jane/.claude/projects/-Users-jane-wt/abc.jsonl`\n"));
        assert!(!text.contains("on the VM"));
    }
}
