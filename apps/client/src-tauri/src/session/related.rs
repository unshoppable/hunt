//! `.hunt/sessions.md` of a worktree: what the agents that work in it are told about one another. Hunt writes one
//! file per family (a session and its sub chats, which share the worktree) with every session's id, role, title,
//! whether its agent works right now, where it runs, the path of its transcript on each machine that has a copy, its
//! current or last request (the transcript's last prompt) and the uncommitted changes its tool calls made
//! (`session/attribution.rs`), plus the changes none of them made and the folders of the family's terminal logs, and
//! points the agents at it from the system prompt (`libs/domain/prompts/sessions.system-prompt.md`). The file is
//! written anew a moment after the stored sessions change, a summary gave a session its title, an agent started or
//! stopped, a turn started or ended or a session changed files, once for every burst of these, and reaches the VM of a
//! connected remote session through its file sync's copy (`session::sync::copy_files`), a little later. The `.hunt`
//! folder is excluded from Git and left out of the file sync, so the file never reaches the repository.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::agent::acp::message_time;
use crate::agent::claude_config::claude_dir;
use crate::git;
use crate::platform::shell::shell_quote;
use crate::remote::handoff::REMOTE_LOGS_DIR;
use crate::remote::sync::Direction;
use crate::remote::transcript::{local_project, remote_project};
use crate::remote::RemoteTarget;
use crate::session::store::{self, SessionRecord};
use crate::session::sync;
use crate::terminal::tmux::{self, DESKTOP_LOGS, LOGS_DIR};

/// The file, inside the worktree's `.hunt` folder.
pub const SESSIONS_FILE: &str = ".hunt/sessions.md";
/// How long changes are gathered before the files are written.
const REFRESH_DELAY: Duration = Duration::from_millis(300);
/// How long changes are gathered before the file goes to the VM.
const PUSH_DELAY: Duration = Duration::from_millis(800);
/// The most changed files the file lists in one place; it counts the rest.
const MAX_LISTED_PATHS: usize = 50;
/// The most characters of a request the file quotes.
const MAX_REQUEST_CHARS: usize = 300;

/// What the file tells of the agents: which sessions have one, and whether it runs a turn.
#[derive(Default)]
pub struct RelatedRegistry {
    /// The sessions whose agent is connected, with whether its turn runs.
    agents: Mutex<HashMap<Uuid, bool>>,
    /// The families whose file is to be written anew, by their root session.
    to_refresh: Batch,
    /// The remote sessions whose file is to go to their VM.
    to_push: Batch,
}

/// Families that wait for a task to work through them, and whether that task runs.
#[derive(Default)]
struct Batch {
    waiting: Mutex<HashSet<Uuid>>,
    is_running: AtomicBool,
}

impl Batch {
    /// Adds `owners`; true when no task runs, so that the caller starts one.
    fn add(&self, owners: impl IntoIterator<Item = Uuid>) -> bool {
        self.waiting.lock().unwrap().extend(owners);
        !self.is_running.swap(true, Ordering::SeqCst)
    }

    /// Takes the waiting families. Without any the task ends, decided under the lock, so that a family added now starts
    /// a new one.
    fn take(&self) -> Vec<Uuid> {
        let mut waiting = self.waiting.lock().unwrap();
        if waiting.is_empty() {
            self.is_running.store(false, Ordering::SeqCst);
        }
        std::mem::take(&mut *waiting).into_iter().collect()
    }
}

/// What the file tells beyond the stored sessions: the worktree's uncommitted changes and each session's last request.
struct Activity<'a> {
    /// The paths of the worktree's uncommitted changes.
    changed: &'a [String],
    /// The last prompt of each session whose transcript holds one.
    requests: &'a HashMap<Uuid, String>,
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

/// Has the file of the family of `id` (its own, or its parent's for a sub chat) written anew in a moment; a failure is
/// only logged.
pub fn refresh_family(app: &AppHandle, id: Uuid) {
    let owner = store::find_session(app, id).ok().map(|record| record.parent_id.unwrap_or(record.id)).unwrap_or(id);
    refresh_later(app, [owner]);
}

/// Has the file of every family written anew in a moment; a failure is only logged.
pub fn refresh_all(app: &AppHandle) {
    match store::load_sessions(app) {
        Ok(sessions) => refresh_later(app, sessions.iter().filter(|record| record.parent_id.is_none()).map(|record| record.id)),
        Err(error) => eprintln!("writing the sessions files failed: {error}"),
    }
}

/// Has the files of the families of `owners` written anew after `REFRESH_DELAY`, together with every other asked for
/// meanwhile, one after the other.
fn refresh_later(app: &AppHandle, owners: impl IntoIterator<Item = Uuid>) {
    if !app.state::<RelatedRegistry>().to_refresh.add(owners) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REFRESH_DELAY).await;
            let owners = app.state::<RelatedRegistry>().to_refresh.take();
            if owners.is_empty() {
                return;
            }
            for owner in owners {
                if let Err(error) = refresh(&app, owner).await {
                    eprintln!("writing the sessions file of session {owner} failed: {error}");
                }
            }
        }
    });
}

/// Writes the file of the family of `owner` anew, and has it copied to the VM of a connected remote session.
async fn refresh(app: &AppHandle, owner: Uuid) -> Result<(), String> {
    let sessions = store::load_sessions(app)?;
    let Some(record) = sessions.iter().find(|record| record.id == owner) else { return Ok(()) };
    if !record.worktree_path.is_dir() {
        return Ok(());
    }
    let sub_chats: Vec<&SessionRecord> = sessions.iter().filter(|session| session.parent_id == Some(owner)).collect();
    let changed: Vec<String> = match git::changed_files(&record.worktree_path, git::DIFF_BASE).await {
        Ok(files) => files.into_iter().map(|file| file.path).collect(),
        Err(error) => {
            eprintln!("listing the changes for the sessions file of session {owner} failed: {error}");
            Vec::new()
        }
    };
    let claude = claude_dir()?;
    let project = local_project(&record.worktree_path, &claude);
    let transcripts: Vec<(Uuid, PathBuf)> = std::iter::once(record)
        .chain(sub_chats.iter().copied())
        .filter_map(|session| Some((session.id, project.join(format!("{}.jsonl", session.acp_session_id.as_ref()?)))))
        .collect();
    let requests: HashMap<Uuid, String> = tauri::async_runtime::spawn_blocking(move || {
        transcripts.into_iter().filter_map(|(id, path)| Some((id, message_time::last_prompt(&path)?))).collect()
    })
    .await
    .map_err(|error| format!("failed to read the transcripts: {error}"))?;
    let agents = app.state::<RelatedRegistry>().agents.lock().unwrap().clone();
    let state_of = |record: &SessionRecord| match agents.get(&record.id) {
        Some(true) => AgentState::Working,
        Some(false) => AgentState::Idle,
        None => AgentState::NotRunning,
    };
    let text = render(record, &sub_chats, &claude, &state_of, &Activity { changed: &changed, requests: &requests });
    write_atomic(&record.worktree_path.join(SESSIONS_FILE), &text)?;
    if record.remote.is_some() && sync::is_syncing(app, owner) {
        push_later(app, owner);
    }
    Ok(())
}

/// The file of the family of `owner`.
fn render(
    owner: &SessionRecord,
    sub_chats: &[&SessionRecord],
    claude_dir: &Path,
    state_of: &dyn Fn(&SessionRecord) -> AgentState,
    activity: &Activity,
) -> String {
    let mut text = String::from(
        "# Sessions in this worktree\n\nHunt writes this file; do not edit it. Every session below works in this worktree. A transcript path is \
         given for each machine that has a copy; use the one of the machine you run on. A transcript is JSONL, one record per line, \
         and large: read only the records you need.\n",
    );
    let project = local_project(&owner.worktree_path, claude_dir);
    let remote = owner.remote.as_ref();
    text.push_str(&section(owner, "the session", remote, &project, state_of(owner), activity));
    for sub_chat in sub_chats {
        let role = match &sub_chat.selection {
            Some(selection) => match &selection.task {
                Some(task) => format!("a sub chat of the session for the task: {}", task.trim()),
                None => format!("a sub chat of the session, opened from `{}` lines {}-{}", selection.path, selection.start_line, selection.end_line),
            },
            None => "a sub chat of the session".to_string(),
        };
        text.push_str(&section(sub_chat, &role, remote, &project, state_of(sub_chat), activity));
    }
    let family: Vec<&SessionRecord> = std::iter::once(owner).chain(sub_chats.iter().copied()).collect();
    text.push_str(&untouched_section(&family, activity.changed, remote.is_some()));
    text.push_str(&logs_section(&owner.worktree_path, remote.is_some()));
    text
}

/// The uncommitted changes that no session of `family` made with its tool calls; nothing when there are none.
fn untouched_section(family: &[&SessionRecord], changed: &[String], is_remote: bool) -> String {
    let untouched: Vec<&str> =
        changed.iter().filter(|path| !family.iter().any(|record| record.touched_files.contains(path))).map(String::as_str).collect();
    if untouched.is_empty() {
        return String::new();
    }
    let makers = if is_remote { "the user, an IDE or the session's agent on the VM, whose changes Hunt does not attribute yet" } else { "the user or an IDE" };
    format!("\n## Changes no session made\n\nUncommitted changes that no session's tool calls made; they come from {makers}:\n\n{}", path_list(&untouched, ""))
}

/// `paths` as list items indented by `indent`, at most `MAX_LISTED_PATHS` of them, then how many more there are.
fn path_list(paths: &[&str], indent: &str) -> String {
    let mut text: String = paths.iter().take(MAX_LISTED_PATHS).map(|path| format!("{indent}- `{path}`\n")).collect();
    if paths.len() > MAX_LISTED_PATHS {
        text.push_str(&format!("{indent}- … and {} more\n", paths.len() - MAX_LISTED_PATHS));
    }
    text
}

/// `request` cut to `MAX_REQUEST_CHARS` characters.
fn shortened(request: &str) -> String {
    if request.chars().count() <= MAX_REQUEST_CHARS {
        return request.to_string();
    }
    let cut: String = request.chars().take(MAX_REQUEST_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Where the family's tmux windows and services log their output, on each machine that has a copy.
fn logs_section(worktree: &Path, is_remote: bool) -> String {
    let services = if is_remote { ", every service of hunt.json to `<service name>.log`," } else { "" };
    let mut text = format!(
        "\n## Terminal logs\n\nEvery tmux window of this family writes its output to `<window name>.log`{services} in the folders below. \
         To see what a process of another session printed, read the end of its log, for example with `tail -n 200`.\n\n"
    );
    let desktop = tmux::desktop_logs(worktree);
    let wrapper = shell_quote(&tmux::wrapper_path(worktree).to_string_lossy());
    let owners = format!(
        "\nEvery window on the desktop names the Hunt session it belongs to in its tmux option `@hunt-session`: the session \
         whose Terminal tab opened it or last ran its script, or whose agent created it; it is empty when Hunt does not know. \
         `{wrapper} list-windows -t app -F '#{{window_name}} #{{@hunt-session}}'` lists them."
    );
    if !is_remote {
        text.push_str(&format!("- Windows on the desktop: `{}/`\n{owners}\n", desktop.display()));
        return text;
    }
    text.push_str(&format!("- Windows on the desktop: on the desktop `{}/`, on the VM `{REMOTE_LOGS_DIR}/{DESKTOP_LOGS}/`\n", desktop.display()));
    text.push_str(&format!(
        "- Services and windows on the VM: on the VM `{REMOTE_LOGS_DIR}/`, on the desktop `{}/` (all but `{DESKTOP_LOGS}/`)\n",
        worktree.join(LOGS_DIR).display()
    ));
    text.push_str("- The copies follow within seconds while the session is connected, a line once it is complete.\n");
    text.push_str(&format!("{owners} Every window on the VM belongs to the session that runs there.\n"));
    text
}

/// The section of one session; `remote` is where the family's session runs when it runs on a VM.
fn section(record: &SessionRecord, role: &str, remote: Option<&RemoteTarget>, project: &Path, state: AgentState, activity: &Activity) -> String {
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
    if let Some(request) = activity.requests.get(&record.id) {
        let label = if state == AgentState::Working { "Current request" } else { "Last request" };
        text.push_str(&format!("- {label}: {}\n", shortened(request)));
    }
    if !record.summary.is_empty() {
        text.push_str("- So far:\n");
        for line in &record.summary {
            text.push_str(&format!("  - {}\n", line.trim()));
        }
    }
    let changes: Vec<&str> = activity.changed.iter().filter(|path| record.touched_files.contains(path)).map(String::as_str).collect();
    if !changes.is_empty() {
        text.push_str("- Uncommitted changes from its tool calls:\n");
        text.push_str(&path_list(&changes, "  "));
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
    if !app.state::<RelatedRegistry>().to_push.add([owner]) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PUSH_DELAY).await;
            let owners = app.state::<RelatedRegistry>().to_push.take();
            if owners.is_empty() {
                return;
            }
            for owner in owners {
                if !sync::is_syncing(&app, owner) {
                    continue;
                }
                if let Err(error) = sync::copy_files(&app, owner, Direction::Push, &[SESSIONS_FILE.to_string()]).await {
                    eprintln!("copying the sessions file of session {owner} to its VM failed: {error}");
                }
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

    fn remote_target() -> RemoteTarget {
        RemoteTarget {
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
            push_target_pending: false,
            relay_activity: None,
        }
    }

    /// Renders the file of `owner` and `sub_chats` with the changed files `changed` and the requests `requests`.
    fn render_with(owner: &SessionRecord, sub_chats: &[&SessionRecord], state_of: &dyn Fn(&SessionRecord) -> AgentState, changed: &[&str], requests: &[(Uuid, &str)]) -> String {
        let changed: Vec<String> = changed.iter().map(|path| path.to_string()).collect();
        let requests: HashMap<Uuid, String> = requests.iter().map(|(id, request)| (*id, request.to_string())).collect();
        render(owner, sub_chats, Path::new("/Users/jane/.claude"), state_of, &Activity { changed: &changed, requests: &requests })
    }

    #[test]
    fn the_file_names_every_session_with_its_role_state_and_transcripts() {
        let (owner_id, sub_id, task_id) = (Uuid::nil(), Uuid::from_u128(1), Uuid::from_u128(2));
        let mut owner = record(owner_id, "Fix login");
        owner.acp_session_id = Some("abc".into());
        owner.summary = vec!["Found the bug in auth.ts".into()];
        owner.remote = Some(remote_target());
        let selection = SelectionContext { path: "src/auth.ts".into(), start_line: 3, end_line: 9, text: "x".into(), task: None, is_folder: false, is_original: false };
        let mut sub = SessionRecord::sub_session(sub_id, "Why this check?".into(), &owner, Some(selection));
        sub.acp_session_id = Some("def".into());
        let task = SelectionContext { path: "README.md".into(), start_line: 1, end_line: 1, text: String::new(), task: Some("Write the file".into()), is_folder: false, is_original: false };
        let task_sub = SessionRecord::sub_session(task_id, "README".into(), &owner, Some(task));
        let state_of = |record: &SessionRecord| if record.id == sub_id { AgentState::Working } else if record.id == owner_id { AgentState::Idle } else { AgentState::NotRunning };

        let text = render_with(&owner, &[&sub, &task_sub], &state_of, &[], &[]);

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
        assert!(text.contains(
            "\n## Terminal logs\n\nEvery tmux window of this family writes its output to `<window name>.log`, every service of hunt.json to `<service name>.log`"
        ));
        assert!(text.ends_with(
            "- Windows on the desktop: on the desktop `/Users/jane/wt/.hunt/logs/desktop/`, on the VM `/home/agent/logs/desktop/`\n\
             - Services and windows on the VM: on the VM `/home/agent/logs/`, on the desktop `/Users/jane/wt/.hunt/logs/` (all but `desktop/`)\n\
             - The copies follow within seconds while the session is connected, a line once it is complete.\n\n\
             Every window on the desktop names the Hunt session it belongs to in its tmux option `@hunt-session`: the session whose Terminal tab \
             opened it or last ran its script, or whose agent created it; it is empty when Hunt does not know. \
             `/Users/jane/wt/.hunt/tmux list-windows -t app -F '#{window_name} #{@hunt-session}'` lists them. \
             Every window on the VM belongs to the session that runs there.\n"
        ));
    }

    #[test]
    fn a_local_session_lists_only_desktop_transcripts() {
        let mut owner = record(Uuid::nil(), "Local");
        owner.acp_session_id = Some("abc".into());
        let text = render_with(&owner, &[], &|_| AgentState::NotRunning, &[], &[]);
        assert!(text.contains("- Agent runs on: the desktop\n- Transcript on the desktop: `/Users/jane/.claude/projects/-Users-jane-wt/abc.jsonl`\n"));
        assert!(text.contains("- Windows on the desktop: `/Users/jane/wt/.hunt/logs/desktop/`\n\nEvery window on the desktop names the Hunt session"));
        assert!(text.ends_with("`/Users/jane/wt/.hunt/tmux list-windows -t app -F '#{window_name} #{@hunt-session}'` lists them.\n"));
        assert!(!text.contains("on the VM"));
        assert!(!text.contains("request") && !text.contains("Uncommitted"));
    }

    #[test]
    fn the_file_names_each_session_s_request_and_uncommitted_changes_and_those_no_session_made() {
        let (owner_id, sub_id) = (Uuid::nil(), Uuid::from_u128(1));
        let mut owner = record(owner_id, "Fix login");
        owner.touched_files = vec!["src/auth.ts".into(), "src/committed.ts".into(), "src/shared.ts".into()];
        let mut sub = SessionRecord::sub_session(sub_id, "Tests".into(), &owner, None);
        sub.touched_files = vec!["src/auth.test.ts".into(), "src/shared.ts".into()];
        let long_request = "x".repeat(400);
        let state_of = |record: &SessionRecord| if record.id == sub_id { AgentState::Working } else { AgentState::Idle };
        let changed = ["src/auth.ts", "src/auth.test.ts", "src/shared.ts", "README.md"];

        let text = render_with(&owner, &[&sub], &state_of, &changed, &[(owner_id, "Fix the login"), (sub_id, &long_request)]);

        assert!(text.contains(
            "- Transcript: none yet\n- Last request: Fix the login\n- Uncommitted changes from its tool calls:\n  - `src/auth.ts`\n  - `src/shared.ts`\n\n## Tests\n"
        ));
        assert!(text.contains(&format!(
            "- Current request: {}…\n- Uncommitted changes from its tool calls:\n  - `src/auth.test.ts`\n  - `src/shared.ts`\n",
            "x".repeat(299)
        )));
        assert!(text.contains(
            "\n## Changes no session made\n\nUncommitted changes that no session's tool calls made; they come from the user or an IDE:\n\n- `README.md`\n\n## Terminal logs\n"
        ));
        assert!(!text.contains("src/committed.ts"));

        owner.remote = Some(remote_target());
        let many: Vec<String> = (0..52).map(|number| format!("src/{number}.ts")).collect();
        owner.touched_files = many.clone();
        let changed: Vec<&str> = many.iter().map(String::as_str).chain(["README.md"]).collect();
        let text = render_with(&owner, &[], &state_of, &changed, &[]);
        assert!(text.contains("  - `src/49.ts`\n  - … and 2 more\n\n## Changes no session made\n"));
        assert!(!text.contains("`src/50.ts`"));
        assert!(text.contains("they come from the user, an IDE or the session's agent on the VM, whose changes Hunt does not attribute yet:\n\n- `README.md`\n"));
    }
}
