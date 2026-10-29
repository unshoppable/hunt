//! The commands of Git: the Git tab on a session's worktree or a repository's own checkout (`GitScope`) with its log,
//! refs and commits, the moves of the checked-out branch (rebase, merge, reset, update), the local and remote branches
//! and a session's push target, which a remote session's VM records as well; and the branches of a repository for a
//! new session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::{push_target, remote_host, remote_vm_state, worktree_session};
use crate::agent::acp::SessionRegistry;
use crate::git::{self, FileDiff};
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::{self, RemoteTarget};
use crate::session::link;
use crate::session::store::{self, announce_sessions_changed, SessionRecord, Workspace};
use crate::session::sync;

#[tauri::command]
pub async fn list_branches(repo_path: String) -> Result<Vec<String>, String> {
    git::list_branches(Path::new(&repo_path)).await
}

/// The branch the repository's checkout is on; `HEAD` when it is detached.
#[tauri::command]
pub async fn current_branch(repo_path: String) -> Result<String, String> {
    git::current_branch(Path::new(&repo_path)).await
}

/// Fetches the branch `branch` of the repository's `origin`; `false` when `origin` has no such branch.
#[tauri::command]
pub async fn fetch_repo_branch(repo_path: String, branch: String) -> Result<bool, String> {
    git::fetch_branch(Path::new(&repo_path), &branch).await
}

/// What the Git tab works on: the worktree of a session, or the own checkout of a repository when no session is active.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitScope {
    Session { id: Uuid },
    Repo { path: PathBuf },
}

/// The directory git runs in for `scope`, with the session's record when it is one.
async fn git_scope(app: &AppHandle, scope: &GitScope) -> Result<(PathBuf, Option<SessionRecord>), String> {
    match scope {
        GitScope::Session { id } => {
            let record = worktree_session(app, *id)?;
            Ok((record.worktree_path.clone(), Some(record)))
        }
        GitScope::Repo { path } => {
            git::ensure_repo_root(path).await?;
            Ok((path.clone(), None))
        }
    }
}

/// A page of the commit log of the scope, see `git::LogQuery`.
#[tauri::command]
pub async fn git_log(app: AppHandle, scope: GitScope, query: git::LogQuery) -> Result<Vec<git::Commit>, String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::log(&directory, &query).await
}

/// Every branch and tag of the scope, its checked-out branch and the commits no remote has.
#[tauri::command]
pub async fn git_refs(app: AppHandle, scope: GitScope) -> Result<git::RefList, String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::refs(&directory).await
}

/// Message, committer, changed files and containing branches of the commit `commit` of the scope.
#[tauri::command]
pub async fn git_commit(app: AppHandle, scope: GitScope, commit: String) -> Result<git::CommitDetails, String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::commit_details(&directory, &commit).await
}

/// The change of `path` (moved from `old_path` when the commit renamed it) in the commit `commit` of the scope.
#[tauri::command]
pub async fn git_commit_file_diff(app: AppHandle, scope: GitScope, commit: String, path: String, old_path: Option<String>) -> Result<FileDiff, String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::ensure_inside_worktree(&path)?;
    if let Some(old_path) = &old_path {
        git::ensure_inside_worktree(old_path)?;
    }
    git::commit_file_diff(&directory, &commit, &path, old_path.as_deref()).await
}

/// Checks the branch `branch` out in the repository's own checkout, a remote one (`is_remote`, `origin/<name>`) as the
/// local branch of its name. Refused while a session works in that checkout, whose record names the branch.
#[tauri::command]
pub async fn git_checkout(app: AppHandle, repo_path: PathBuf, branch: String, is_remote: bool) -> Result<(), String> {
    git::ensure_repo_root(&repo_path).await?;
    let holder = store::load_sessions(&app)?.into_iter().find(|stored| stored.workspace == Workspace::Checkout && stored.repo_path == repo_path);
    if let Some(holder) = holder {
        return Err(format!("failed to check out {branch}: the session \"{}\" works in the checkout", holder.title));
    }
    git::checkout_branch(&repo_path, &branch, is_remote).await
}

/// A move of the session's branch to another commit, made in its local worktree from the Git tab.
enum HeadMove {
    /// `git rebase` onto a branch or remote branch.
    RebaseOnto(String),
    /// `git merge` of a branch or remote branch.
    Merge(String),
    /// A fetch of the branch on `origin` the push lands on and a rebase onto it, as the push does first.
    UpdateFrom(String),
    /// `git reset` to a commit of the log in the given mode.
    Reset(String, git::ResetMode),
    /// A fast-forward of the checked-out branch to its upstream, fetched first (`git::fast_forward_branch`).
    Pull(String),
    /// A reset of the checked-out branch to its upstream, fetched first, that keeps the uncommitted changes
    /// (`git::reset_branch_to_upstream`).
    ForcePull(String),
}

impl HeadMove {
    fn verb(&self) -> &'static str {
        match self {
            HeadMove::RebaseOnto(_) => "rebase",
            HeadMove::Merge(_) => "merge",
            HeadMove::UpdateFrom(_) => "update",
            HeadMove::Reset(..) => "reset",
            HeadMove::Pull(_) => "pull",
            HeadMove::ForcePull(_) => "force pull",
        }
    }

    async fn apply(&self, worktree: &Path) -> Result<(), String> {
        match self {
            HeadMove::RebaseOnto(onto) => git::rebase_onto(worktree, onto, onto).await,
            HeadMove::Merge(from) => git::merge_into_head(worktree, from).await,
            HeadMove::UpdateFrom(target) => {
                git::fetch_branch(worktree, target).await?;
                if git::is_behind_origin(worktree, target).await {
                    git::rebase_onto_origin(worktree, target).await?;
                }
                Ok(())
            }
            HeadMove::Reset(commit, mode) => git::reset(worktree, commit, *mode).await,
            HeadMove::Pull(branch) => git::fast_forward_branch(worktree, branch).await.map(|_| ()),
            HeadMove::ForcePull(branch) => git::reset_branch_to_upstream(worktree, branch).await,
        }
    }

    /// Moves the VM's branch of the remote session `id` to the commit the local worktree moved to: a reset repeats there
    /// in its mode, any other move rebuilds the VM's files on the new commit.
    async fn follow_on_vm(&self, ssh: &Ssh, id: Uuid, remote: &RemoteTarget, worktree: &Path) -> Result<String, String> {
        match self {
            HeadMove::Reset(_, mode) => remote::commit::reset_vm_head(ssh, id, remote, worktree, *mode).await,
            _ => remote::commit::move_vm_head(ssh, id, remote, worktree).await,
        }
    }
}

/// Applies `change` to the branch of the session `record` in its local worktree. For a remote session connected to its
/// VM it runs while no sync of the session does, after its branch was brought to the same commit here and on its VM
/// (`sync::follow_head`), and the VM's branch moves to the new commit afterwards (`remote::commit::move_vm_head`), as
/// it does for the rebase before a push. One not connected changes the local branch alone; the VM's branch follows it
/// at the next connect (`remote::commit::direction`).
async fn move_head(app: &AppHandle, record: &SessionRecord, change: HeadMove) -> Result<(), String> {
    link::ensure_writable(app, record.id, change.verb())?;
    let owner = match remote_host(app, record) {
        Some((owner, _)) if sync::is_connected(app, owner) => owner,
        _ => return change.apply(&record.worktree_path).await,
    };
    let worktree = record.worktree_path.as_path();
    sync::exclusive(app, owner, |_| async move {
        let remote = store::find_session(app, owner)?.remote.ok_or_else(|| format!("failed to {}: the session runs locally now", change.verb()))?;
        let ssh = Ssh::open(&remote.vm, &ssh_dir()?).await?;
        sync::follow_head(app, owner, &ssh, &remote, worktree).await?;
        let before = git::rev_parse(worktree, "HEAD").await?;
        change.apply(worktree).await?;
        if git::rev_parse(worktree, "HEAD").await? == before {
            return Ok(());
        }
        let head = change.follow_on_vm(&ssh, owner, &remote, worktree).await?;
        store::update_session(app, owner, |stored| {
            if let Some(remote) = stored.remote.as_mut() {
                remote.handoff_head = head;
            }
        })?;
        Ok(())
    })
    .await
}

/// Applies `change` to the checked-out branch of `scope`: a session's through `move_head`, a repository's checkout directly.
async fn move_scope_head(app: &AppHandle, scope: &GitScope, change: HeadMove) -> Result<(), String> {
    match git_scope(app, scope).await? {
        (_, Some(record)) => move_head(app, &record, change).await,
        (directory, None) => change.apply(&directory).await,
    }
}

/// Rebases the checked-out branch onto the branch or remote branch `onto`; a conflict aborts and reports the files.
#[tauri::command]
pub async fn git_rebase(app: AppHandle, scope: GitScope, onto: String) -> Result<(), String> {
    move_scope_head(&app, &scope, HeadMove::RebaseOnto(onto)).await
}

/// Merges the branch or remote branch `from` into the checked-out branch; a conflict aborts and reports the files.
#[tauri::command]
pub async fn git_merge(app: AppHandle, scope: GitScope, from: String) -> Result<(), String> {
    move_scope_head(&app, &scope, HeadMove::Merge(from)).await
}

/// Resets the checked-out branch to the commit `commit` in `mode`, WebStorm's "Reset Current Branch to Here".
#[tauri::command]
pub async fn git_reset(app: AppHandle, scope: GitScope, commit: String, mode: git::ResetMode) -> Result<(), String> {
    move_scope_head(&app, &scope, HeadMove::Reset(commit, mode)).await
}

/// Rebases the session's own branch onto the branch on `origin` its push lands on, fetched first, as the push does.
#[tauri::command]
pub async fn git_update_branch(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let remote = remote_host(&app, &record).map(|(_, target)| target);
    let target = push_target(&record, remote.as_ref()).await;
    move_head(&app, &record, HeadMove::UpdateFrom(target)).await
}

/// The top-level session whose worktree has the local branch `branch` of `repo` checked out; `None` when no worktree
/// or one outside Hunt's sessions has it.
async fn session_of_branch(app: &AppHandle, repo: &Path, branch: &str) -> Result<Option<SessionRecord>, String> {
    let Some(worktree) = git::worktree_of_branch(repo, branch).await? else {
        return Ok(None);
    };
    let worktree = Path::new(&worktree);
    Ok(store::load_sessions(app)?.into_iter().find(|record| record.parent_id.is_none() && record.worktree_path == worktree))
}

/// Fast-forwards the local branch `branch`, another one than the session's, to its upstream as fetched now; `false`
/// when the upstream has no commits the branch lacks. The branch of another session moves in its worktree through
/// `move_head`.
#[tauri::command]
pub async fn git_pull_branch(app: AppHandle, scope: GitScope, branch: String) -> Result<bool, String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    let Some(record) = session_of_branch(&app, &directory, &branch).await? else {
        return git::fast_forward_branch(&directory, &branch).await;
    };
    let before = git::rev_parse(&record.worktree_path, "HEAD").await?;
    move_head(&app, &record, HeadMove::Pull(branch)).await?;
    Ok(git::rev_parse(&record.worktree_path, "HEAD").await? != before)
}

/// Resets the local branch `branch`, another one than the session's, to its upstream as fetched now; the commits the
/// upstream lacks are lost. The branch of another session moves in its worktree through `move_head`.
#[tauri::command]
pub async fn git_force_pull_branch(app: AppHandle, scope: GitScope, branch: String) -> Result<(), String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    match session_of_branch(&app, &directory, &branch).await? {
        Some(record) => move_head(&app, &record, HeadMove::ForcePull(branch)).await,
        None => git::reset_branch_to_upstream(&directory, &branch).await,
    }
}

/// Pushes the local branch `branch`, another one than the session's (see `push_branch`), to the branch of the same
/// name on `origin`.
#[tauri::command]
pub async fn git_push_local_branch(app: AppHandle, scope: GitScope, branch: String) -> Result<(), String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::push_local_branch(&directory, &branch).await
}

/// Force pushes the local branch `branch`, another one than the session's, to the branch of the same name on
/// `origin`; the commits `origin` has there that `branch` lacks are dropped, unless `origin` moved since the last fetch.
#[tauri::command]
pub async fn git_force_push_local_branch(app: AppHandle, scope: GitScope, branch: String) -> Result<(), String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::force_push_local_branch(&directory, &branch).await
}

/// Renames the local branch `branch` to `new_name`. The records of the sessions of the repository on that branch and
/// their sub chats follow; a remote session refuses, since its VM has the branch under that name.
#[tauri::command]
pub async fn git_rename_branch(app: AppHandle, scope: GitScope, branch: String, new_name: String) -> Result<(), String> {
    let (directory, record) = git_scope(&app, &scope).await?;
    let repo_path = record.map_or_else(|| directory.clone(), |record| record.repo_path);
    let holders: Vec<SessionRecord> = store::load_sessions(&app)?
        .into_iter()
        .filter(|stored| stored.repo_path == repo_path && stored.branch == branch)
        .collect();
    if holders.iter().any(|holder| remote_host(&app, holder).is_some()) {
        return Err("failed to rename the branch: the session's VM has it under this name; retrieve the session first".into());
    }
    git::rename_branch(&directory, &branch, &new_name).await?;
    if holders.is_empty() {
        return Ok(());
    }
    for holder in holders {
        store::update_session(&app, holder.id, |stored| stored.branch = new_name.clone())?;
    }
    announce_sessions_changed(&app);
    Ok(())
}

/// Makes the branch `target` on `origin` the one a push of the session lands on: the session's branch tracks it here,
/// for its sub chats too, which share the branch, and a remote session records it in its VM's worktree too, in the
/// background (`schedule_vm_push_target`), where a Hunt taking the session over reads it
/// (`sync::take_over_vm_push_target`). With `create`, a branch `origin` lacks is created there first, at the commit of
/// the branch pushed to so far. A poller session pushes its own branch from its VM.
#[tauri::command]
pub async fn set_push_target(app: AppHandle, id: Uuid, target: String, create: bool) -> Result<(), String> {
    link::ensure_writable(&app, id, "change the push target")?;
    let record = worktree_session(&app, id)?;
    let remote = remote_host(&app, &record);
    if remote.as_ref().is_some_and(|(_, remote)| remote.origin.keeps_vm_tokens()) {
        return Err("failed to change the push target: a poller session pushes its own branch".into());
    }
    if create {
        let from = push_target(&record, remote.as_ref().map(|(_, target)| target)).await;
        git::ensure_origin_branch(&record.worktree_path, &target, &from).await?;
    } else if !git::fetch_branch(&record.worktree_path, &target).await? {
        return Err(format!("failed to change the push target: origin has no branch {target}"));
    }
    git::set_origin_upstream(&record.worktree_path, &record.branch, &target).await?;
    if let Some((host_id, _)) = remote {
        schedule_vm_push_target(&app, host_id);
    }
    announce_sessions_changed(&app);
    Ok(())
}

/// Per remote session, the lock that lets one recording of its push target on the VM run at a time.
static VM_PUSH_TARGET_LOCKS: std::sync::Mutex<Option<HashMap<Uuid, std::sync::Arc<tokio::sync::Mutex<()>>>>> = std::sync::Mutex::new(None);

/// Records the push target of the remote session `host_id` in its VM's worktree in the background, one recording per
/// session at a time, so that the last one records the latest target. The record gets `push_target_pending` first and
/// keeps it until a recording succeeds, so that the next connect records the target (`sync::take_over_vm_push_target`)
/// when the VM is off, cannot be reached, or Hunt quits before the recording ran.
fn schedule_vm_push_target(app: &AppHandle, host_id: Uuid) {
    set_push_target_pending(app, host_id, true);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let lock = VM_PUSH_TARGET_LOCKS.lock().unwrap().get_or_insert_with(HashMap::new).entry(host_id).or_default().clone();
        let _guard = lock.lock().await;
        record_vm_push_target(&app, host_id).await;
    });
}

/// Records the push target of the remote session `host_id`, the upstream of its local branch, in its VM's worktree when
/// its VM runs, which a connected session proves and an unconnected one asks the gateway; a VM that is off is not
/// started. Clears `push_target_pending` once recorded; a failure is only logged, since the records name the target
/// already.
async fn record_vm_push_target(app: &AppHandle, host_id: Uuid) {
    let recorded = async {
        let registry = app.state::<SessionRegistry>();
        let (remote, is_running) = remote_vm_state(app, &registry, host_id, "record the push target on the VM").await?;
        if !is_running {
            return Ok(false);
        }
        let target = push_target(&store::find_session(app, host_id)?, Some(&remote)).await;
        let ssh = Ssh::open(&remote.vm, &ssh_dir()?).await?;
        remote::commit::set_vm_origin_upstream(&ssh, &remote, &remote.branch, &target).await?;
        Ok::<bool, String>(true)
    }
    .await;
    match recorded {
        Ok(true) => set_push_target_pending(app, host_id, false),
        Ok(false) => {}
        Err(error) => eprintln!("recording the push target of session {host_id} on its VM failed: {error}"),
    }
}

/// Sets `push_target_pending` of the remote session `host_id`; a failure is only logged.
fn set_push_target_pending(app: &AppHandle, host_id: Uuid, is_pending: bool) {
    let update = store::update_session(app, host_id, |stored| {
        if let Some(remote) = stored.remote.as_mut() {
            remote.push_target_pending = is_pending;
        }
    });
    if let Err(error) = update {
        eprintln!("setting the pending push target of session {host_id} on its VM failed: {error}");
    }
}

/// Deletes the local branch `branch`; without `force`, git refuses one whose commits its upstream (or HEAD) lacks.
#[tauri::command]
pub async fn git_delete_branch(app: AppHandle, scope: GitScope, branch: String, force: bool) -> Result<(), String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::delete_local_branch(&directory, &branch, force).await
}

/// Deletes the branch `branch` on `origin`.
#[tauri::command]
pub async fn git_delete_remote_branch(app: AppHandle, scope: GitScope, branch: String) -> Result<(), String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::delete_remote_branch(&directory, &branch).await
}

/// Fetches the branch `branch` of `origin`; `false` when `origin` has no such branch.
#[tauri::command]
pub async fn git_fetch_branch(app: AppHandle, scope: GitScope, branch: String) -> Result<bool, String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::fetch_branch(&directory, &branch).await
}

/// Fetches every branch of `origin` and drops the remote-tracking refs of the branches `origin` no longer has.
#[tauri::command]
pub async fn git_fetch_origin(app: AppHandle, scope: GitScope) -> Result<(), String> {
    let (directory, _) = git_scope(&app, &scope).await?;
    git::fetch_origin(&directory).await
}
