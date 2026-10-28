//! The commands of a session's life: listing, creating (in a worktree of its own, in the repository's checkout or as a
//! sub chat), renaming, opening, clearing and closing sessions, and preparing their worktree's dependencies.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::{
    activate, activate_remote, drop_pending_permissions, finish_progress, forget_remote, local_start, open_remote_relay, progress_reporter,
    remote_claude_token, remote_host, start_remote_relay, stop_agent, worktree_session, SessionView,
};
use crate::agent::accounts;
use crate::agent::acp::{AgentTransport, PermissionRegistry, SessionRegistry, SessionStart};
use crate::checks::CheckRegistry;
use crate::git::{self, private_files};
use crate::github::{github_token, PullRequestRef};
use crate::graph::WatcherRegistry;
use crate::ide::documents::DocumentRegistry;
use crate::ide::find_in_files::FindRegistry;
use crate::ide::lsp::{self, LspRegistry};
use crate::remote;
use crate::session::attribution;
use crate::session::dependencies::{self, DependencyRegistry, Install};
use crate::session::store::{self, announce_sessions_changed, SelectionContext, SessionRecord, Workspace};
use crate::session::summary;
use crate::session::sync;
use crate::session::vm_cleanup::delete_session_vm;
use crate::terminal::tmux;

#[tauri::command]
pub async fn list_sessions(app: AppHandle, registry: State<'_, SessionRegistry>) -> Result<Vec<SessionView>, String> {
    let live: HashSet<Uuid> = registry.live.lock().await.keys().copied().collect();
    let mut sessions = Vec::new();
    for record in store::load_sessions(&app)? {
        let is_live = live.contains(&record.id);
        sessions.push(SessionView::new(&app, record, is_live).await);
    }
    // Oldest first, so that a new session joins the end of the sidebar and the marks of the existing ones stay put.
    sessions.sort_by(|left, right| left.record.created_at.cmp(&right.record.created_at));
    Ok(sessions)
}

/// Creates the session `id`: with `workspace` `Worktree` in a fresh worktree off `base_ref`, with `Checkout` in the
/// repository's own checkout on its current branch, where `base_ref` is ignored. The UI picks the id so it can list
/// the session before this returns. `pull_request` marks it as the review of that pull request; `diff_base_ref` is
/// then the pull request's target branch, whose merge base with the base becomes the diff base, and the worktree works
/// on the pull request's own branch `pull_request_branch` rather than a new one, with `base_ref` naming that branch
/// locally or on a remote (`origin/<branch>`); while another worktree, the checkout included, has that branch checked
/// out, on a new `<branch>-<n>` off it, whose push lands on it. `new_branch` names a branch the user asked for instead
/// of the generated `<base>-<n>` (`git::next_session_branch`): created off `base_ref` in a worktree, or at `HEAD` of
/// the checkout, which switches to it; like a pull request's branch it is the session's base, so a push lands on it
/// under its own name, and deleting the session keeps it.
#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    id: Uuid,
    repo_path: String,
    base_ref: String,
    title: String,
    pull_request: Option<PullRequestRef>,
    diff_base_ref: Option<String>,
    pull_request_branch: Option<String>,
    new_branch: Option<String>,
    workspace: Workspace,
) -> Result<SessionView, String> {
    ensure_new_id(&app, id)?;
    let repo_path = PathBuf::from(repo_path);
    if let Some(branch) = &new_branch {
        git::ensure_new_branch(&repo_path, branch).await?;
    }
    let (worktree_path, base_ref) = match workspace {
        Workspace::Worktree => (store::worktrees_dir(&app)?.join(id.to_string()), base_ref),
        Workspace::Checkout => (repo_path.clone(), git::current_branch(&repo_path).await?),
    };
    let base_commit = git::rev_parse(&repo_path, &base_ref).await?;
    let diff_base = match &diff_base_ref {
        Some(reference) => Some(git::merge_base(&repo_path, reference, &base_commit).await?),
        None => None,
    };

    let mut keeps_branch = false;
    let branch = match workspace {
        Workspace::Worktree => {
            // git checks a branch out in one worktree only: a pull request's branch checked out elsewhere gets a session branch off it.
            let review_branch = match pull_request_branch {
                Some(branch) => git::worktree_of_branch(&repo_path, &branch).await?.is_none().then_some(branch),
                None => None,
            };
            let branch = match review_branch.clone().or_else(|| new_branch.clone()) {
                Some(branch) => branch,
                None => git::next_session_branch(&repo_path, &base_ref).await?,
            };
            if review_branch.is_some() {
                keeps_branch = !git::worktree_add_on_branch(&repo_path, &branch, &worktree_path, &base_ref).await?;
            } else {
                git::worktree_add(&repo_path, &branch, &worktree_path, &base_commit).await?;
                keeps_branch = new_branch.is_some();
                // The branch tracks the base branch on origin, where its push lands (`push_target`), so the target
                // travels with the branch: the handoff copies the upstream to the VM, and a Hunt taking the session
                // over reads it there. A branch of the user's name has none and is pushed under that name.
                if new_branch.is_none() {
                    git::set_origin_upstream(&repo_path, &branch, base_ref.strip_prefix("origin/").unwrap_or(&base_ref)).await?;
                }
            }
            private_files::copy_into_worktree(&repo_path, &worktree_path).await?;
            dependencies::ensure(&app, repo_path.clone(), worktree_path.clone(), Install::Updating);
            branch
        }
        Workspace::Checkout => match &new_branch {
            Some(created) => {
                git::switch_to_new_branch(&repo_path, created).await?;
                created.clone()
            }
            None => base_ref.clone(),
        },
    };
    // A branch the user named is the session's base: a push lands on it under its own name.
    let base_ref = if new_branch.is_some() { branch.clone() } else { base_ref };

    let mut record = SessionRecord::new(id, title, repo_path, worktree_path.clone(), branch, base_ref, base_commit);
    record.pull_request = pull_request;
    record.diff_base = diff_base;
    record.workspace = workspace;
    record.keeps_branch = keeps_branch;
    store::upsert_session(&app, record.clone())?;
    announce_sessions_changed(&app);
    let view = activate(&app, &registry, &watchers, record, SessionStart::New { cwd: worktree_path }, AgentTransport::Local).await?;
    announce_sessions_changed(&app);
    Ok(view)
}

/// Starts the sub session `id` of `parent_id`: a fresh agent session in the parent's worktree, listed under the
/// parent in the UI, which picks the id so it can list the session before this returns. A sub chat opened from the
/// diff passes the `selection`, which goes into the system prompt. The sub session of a remote session runs on this
/// Mac as well, in the session's local worktree, which the session's file sync keeps in step with the VM.
#[tauri::command]
pub async fn create_sub_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    id: Uuid,
    parent_id: Uuid,
    title: String,
    selection: Option<SelectionContext>,
) -> Result<SessionView, String> {
    ensure_new_id(&app, id)?;
    let parent = store::find_session(&app, parent_id)?;
    let record = SessionRecord::sub_session(id, title, &parent, selection);
    store::upsert_session(&app, record.clone())?;
    announce_sessions_changed(&app);
    let view = activate(&app, &registry, &watchers, record, SessionStart::New { cwd: parent.worktree_path }, AgentTransport::Local).await?;
    announce_sessions_changed(&app);
    Ok(view)
}

/// Gives the session `id` the title `title`; the UI names a session created without a prompt after its first one.
/// The branch keeps the slug of the title the session was created with.
#[tauri::command]
pub async fn rename_session(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, title: String) -> Result<SessionView, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("failed to rename session: the title is empty".into());
    }
    let record = store::update_session(&app, id, |stored| stored.title = title)?.ok_or_else(|| format!("failed to rename session: the session {id} is not stored"))?;
    announce_sessions_changed(&app);
    let is_live = registry.live.lock().await.contains_key(&id);
    Ok(SessionView::new(&app, record, is_live).await)
}

/// Rejects a session id the UI picked when a stored session carries it already.
fn ensure_new_id(app: &AppHandle, id: Uuid) -> Result<(), String> {
    if store::find_session(app, id).is_ok() {
        return Err(format!("failed to create session: a session with the id {id} exists already"));
    }
    Ok(())
}

/// Brings a stored session back to life by loading its Claude Code transcript.
#[tauri::command]
pub async fn open_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    let record = store::find_session(&app, id)?;
    // An open while another one runs (the sidebar and a sub chat popover, or a double click) waits for that one.
    if !registry.claim_start(id).await {
        return Ok(SessionView::new(&app, store::find_session(&app, id)?, true).await);
    }
    if record.worktree_path.is_dir() {
        dependencies::ensure(&app, record.repo_path.clone(), record.worktree_path.clone(), install_for(&app, &record));
        if let Err(error) = private_files::copy_hooks_into_worktree(&record.repo_path, &record.worktree_path).await {
            eprintln!("copying the hook files into {} failed: {error}", record.worktree_path.display());
        }
    }
    if record.remote.is_some() {
        let activated = activate_remote(&app, &registry, &watchers, record).await;
        registry.end_start(id).await;
        finish_progress(&app, id);
        return activated;
    }

    let start = local_start(&record);
    let activated = activate(&app, &registry, &watchers, record, start, AgentTransport::Local).await;
    registry.end_start(id).await;
    activated
}

/// Starts the conversation of `id` over, like `/clear` in the terminal: the agent is restarted with a new session
/// and the session record gets its ID. Clearing inside the running agent would move it to a conversation Hunt
/// does not know, so a later resume would not find the one the agent continued.
#[tauri::command]
pub async fn clear_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    let record = store::find_session(&app, id)?;
    // Fetched before anything stops: without a token the remote conversation keeps running as it is. A poller session's
    // relay keeps the tokens stored on its VM and takes this Mac's only where it stores none, so it needs no Claude
    // account selected.
    let token_input = match &record.remote {
        Some(target) => {
            let claude_token = if target.origin.keeps_vm_tokens() {
                accounts::active_token(&app).await?.unwrap_or_default()
            } else {
                remote_claude_token(&app, "clear session").await?
            };
            remote::token_input(&claude_token, github_token::read().await?.as_deref())
        }
        None => remote::token_input("", None),
    };
    drop_pending_permissions(&permissions, id);
    let finished = registry.live.lock().await.remove(&id).and_then(|mut live| live.shutdown());
    // The ended agent task clears the registries on its way out; the new agent registers only after that.
    if let Some(finished) = finished {
        let _ = finished.await;
    }
    if !registry.claim_start(id).await {
        return Err("failed to clear session: its agent was started again meanwhile".into());
    }
    // The summary described the conversation that just ended.
    if let Err(error) = summary::clear(&app, id) {
        eprintln!("clearing the summary of session {id} failed: {error}");
    }
    if let Some(target) = record.remote.clone() {
        let activated = async {
            // The chat shows the connect's steps, which take a while even on a running VM.
            let instance = target.vm.instance.clone();
            let Some((ssh, target)) = start_remote_relay(&app, id, target, &progress_reporter(&app, id)).await? else {
                return Err(format!("failed to clear session: its VM {instance} no longer exists; send a prompt to continue the session here"));
            };
            let id_text = id.to_string();
            let mut args = vec!["clear", &id_text];
            args.extend(target.origin.relay_token_args());
            let status = remote::hunt_ctl_with_input(&ssh, &args, token_input.as_bytes()).await?;
            let acp_session_id = status["acpSessionId"].as_str().map(str::to_string).ok_or("failed to clear session: the relay reports no new session")?;
            store::update_session(&app, id, |stored| stored.acp_session_id = Some(acp_session_id))?
                .ok_or_else(|| "failed to clear session: the session was closed meanwhile".to_string())?;
            open_remote_relay(&app, &registry, &watchers, id, ssh, target).await
        }
        .await;
        registry.end_start(id).await;
        finish_progress(&app, id);
        return activated;
    }
    let start = SessionStart::New { cwd: record.worktree_path.clone() };
    let activated = activate(&app, &registry, &watchers, record, start, AgentTransport::Local).await;
    registry.end_start(id).await;
    activated
}

/// Prepares the worktree's `node_modules` again, after a failed attempt or for a session created before Hunt did
/// this; the result shows up in the session list.
#[tauri::command]
pub async fn prepare_dependencies(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let install = install_for(&app, &record);
    dependencies::ensure(&app, record.repo_path, record.worktree_path, install);
    announce_sessions_changed(&app);
    Ok(())
}

/// How the dependencies of `record`'s worktree install: without touching the lockfile while its files sync with a VM.
fn install_for(app: &AppHandle, record: &SessionRecord) -> Install {
    if remote_host(app, record).is_some() {
        Install::Frozen
    } else {
        Install::Updating
    }
}

/// How `close_session` ends a session (mirror of `SessionEnding` in src/sessions/session.types.ts).
#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Ending {
    /// Only the agent stops; the session stays listed.
    Stop,
    /// The session goes with its sub chats, worktree, branch and, for a remote session, its VM.
    Delete,
    /// Like `Delete`, but a remote session's VM stays for the other people working on it and for a later adoption.
    Forget,
}

#[tauri::command]
pub async fn close_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    lsp: State<'_, LspRegistry>,
    id: Uuid,
    ending: Ending,
) -> Result<(), String> {
    let result = end_session(&app, &registry, &watchers, &permissions, &lsp, id, ending).await;
    announce_sessions_changed(&app);
    result
}

/// Stops the agent of `id` and, unless `ending` is `Stop`, deletes the session record together with its sub chats,
/// worktree and branch; a session in the repository's own checkout only loses its records. A remote session's VM
/// goes only with `Delete`.
async fn end_session(
    app: &AppHandle,
    registry: &SessionRegistry,
    watchers: &WatcherRegistry,
    permissions: &PermissionRegistry,
    lsp: &LspRegistry,
    id: Uuid,
    ending: Ending,
) -> Result<(), String> {
    stop_agent(app, registry, watchers, permissions, id).await;
    if ending == Ending::Stop {
        return Ok(());
    }
    app.state::<CheckRegistry>().forget(id);

    let record = store::find_session(app, id)?;
    // A sub chat only owns its record; the worktree belongs to its parent.
    if record.parent_id.is_some() {
        return store::remove_session(app, id);
    }

    for child in store::load_sessions(app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent(app, registry, watchers, permissions, child.id).await;
        store::remove_session(app, child.id)?;
    }
    // The family's terminals end with it, together with the processes its agents left running.
    if let Err(error) = tmux::kill_server(id).await {
        eprintln!("ending the tmux server of session {id} failed: {error}");
    }
    if let Some(target) = &record.remote {
        sync::stop_and_wait(app, id).await;
        forget_remote(app, target, id, ending == Ending::Delete).await;
        sync::forget(app, id);
        // An adopted session that never synced has nothing here but its record.
        if target.is_adopted() && !record.worktree_path.is_dir() {
            return store::remove_session(app, id);
        }
    } else if let Some(leftover) = &record.leftover_vm {
        if ending == Ending::Delete {
            delete_session_vm(app, leftover, id).await;
        }
    }
    if record.workspace == Workspace::Checkout {
        store::remove_session(app, id)?;
        forget_worktree_if_unused(app, &record.worktree_path);
        return Ok(());
    }

    // The language server holds files of the worktree open; it must be gone before the directory is removed.
    lsp::stop_for_worktree(lsp, &record.worktree_path).await;
    app.state::<DependencyRegistry>().forget(&record.worktree_path);
    // A moved or deleted repository must not make the session undeletable.
    let removal = git::worktree_remove(&record.repo_path, &record.worktree_path).await;
    if removal.is_ok() {
        delete_created_branch(&record).await;
    } else if record.worktree_path.exists() {
        std::fs::remove_dir_all(&record.worktree_path)
            .map_err(|error| format!("failed to remove the worktree {}: {error}", record.worktree_path.display()))?;
    }
    // Handoffs and retrievals leave snapshot refs behind, which keep their commits alive.
    if let Err(error) = git::delete_refs(&record.repo_path, &format!("refs/hunt/{id}/")).await {
        eprintln!("deleting the refs of session {id} failed: {error}");
    }
    store::remove_session(app, id)?;
    forget_worktree_if_unused(app, &record.worktree_path);
    removal
}

/// Deletes the branch of the worktree session `record` when Hunt created it; a branch that existed before the session (a
/// reviewed pull request's) stays. A failure is only logged.
async fn delete_created_branch(record: &SessionRecord) {
    if record.keeps_branch {
        return;
    }
    if let Err(error) = git::delete_branch(&record.repo_path, &record.branch).await {
        eprintln!("deleting branch {} of session {} failed: {error}", record.branch, record.id);
    }
}

/// Deletes the edit log, the search texts and the documents (unsaved edits included) of `worktree` when no stored session
/// works in it any more; a failure is only logged.
fn forget_worktree_if_unused(app: &AppHandle, worktree: &Path) {
    let result = store::load_sessions(app).and_then(|sessions| {
        if sessions.iter().any(|session| session.worktree_path == worktree) {
            return Ok(());
        }
        app.state::<FindRegistry>().forget(worktree);
        app.state::<DocumentRegistry>().forget(worktree);
        attribution::forget_worktree(app, worktree)
    });
    if let Err(error) = result {
        eprintln!("deleting the edit log of {} failed: {error}", worktree.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn deleting_a_session_deletes_only_the_branch_hunt_created() {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git::run_git(&repo, &["init", "-q", "-b", "main"]).await.unwrap();
        git::run_git(&repo, &["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "init"]).await.unwrap();
        git::run_git(&repo, &["branch", "fix/sentry/admin-ui-errors"]).await.unwrap();

        let created = directory.path().join("created");
        git::worktree_add(&repo, "feat/general/x-0123abcd", &created, "main").await.unwrap();
        let review = directory.path().join("review");
        let is_created = git::worktree_add_on_branch(&repo, "fix/sentry/admin-ui-errors", &review, "origin/fix/sentry/admin-ui-errors").await.unwrap();
        let session = |worktree: &Path, branch: &str| {
            SessionRecord::new(Uuid::new_v4(), "x".into(), repo.clone(), worktree.to_path_buf(), branch.into(), "main".into(), String::new())
        };
        let mut review_session = session(&review, "fix/sentry/admin-ui-errors");
        review_session.keeps_branch = !is_created;

        for record in [session(&created, "feat/general/x-0123abcd"), review_session] {
            git::worktree_remove(&repo, &record.worktree_path).await.unwrap();
            delete_created_branch(&record).await;
        }
        assert!(!git::local_branch_exists(&repo, "feat/general/x-0123abcd").await);
        assert!(git::local_branch_exists(&repo, "fix/sentry/admin-ui-errors").await);
    }
}
