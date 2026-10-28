//! The commands of a session's changelist: the changed files with the sessions that touched them, their diffs and edit
//! history, writing, moving, deleting and reverting worktree files, writing the skills of the swf steps from Hunt's
//! templates, shelves, and committing and pushing the session's branch, which the branch on a remote session's VM follows.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use super::{push_target, remote_host, session_file, worktree_file, worktree_session};
use crate::agent::swf_skills;
use crate::git::{self, ChangedFile, FileDiff, Shelf};
use crate::remote;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::session::attribution::{self, FileVersion};
use crate::session::link;
use crate::session::related;
use crate::session::store;
use crate::session::sync;

/// A changed file plus the sessions of the same worktree whose tool calls touched it (empty when the
/// change was made outside the agents, for example in an IDE or by restoring a shelf).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileView {
    #[serde(flatten)]
    pub file: ChangedFile,
    pub touched_by: Vec<Uuid>,
}

/// What the changelist and its diffs compare the worktree against.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Comparison {
    /// The session's diff base: `HEAD`, or the merge base of the pull request it reviews.
    DiffBase,
    /// The commit `HEAD` shares with the branch its push lands on (`git::push_base`).
    PushTarget,
}

/// The commit or ref `comparison` compares the worktree of `record` against.
pub(super) async fn comparison_base(app: &AppHandle, record: &store::SessionRecord, comparison: Comparison) -> Result<String, String> {
    match comparison {
        Comparison::DiffBase => Ok(record.diff_base().to_string()),
        Comparison::PushTarget => {
            let remote = remote_host(app, record).map(|(_, target)| target);
            git::push_base(&record.worktree_path, &push_target(record, remote.as_ref()).await).await
        }
    }
}

#[tauri::command]
pub async fn list_changed_files(app: AppHandle, id: Uuid, comparison: Comparison) -> Result<Vec<ChangedFileView>, String> {
    let record = worktree_session(&app, id)?;
    let base = comparison_base(&app, &record, comparison).await?;
    let files = git::changed_files(&record.worktree_path, &base).await?;
    let mut touched_by = store::touched_by(&app, &record.worktree_path)?;
    Ok(files
        .into_iter()
        .map(|file| ChangedFileView { touched_by: touched_by.remove(&file.path).unwrap_or_default(), file })
        .collect())
}

/// Added and removed lines of every changed file of the session (untracked files count as all added).
#[tauri::command]
pub async fn change_stats(app: AppHandle, id: Uuid) -> Result<Vec<git::ChangeStat>, String> {
    let record = worktree_session(&app, id)?;
    git::change_stats(&record.worktree_path, record.diff_base()).await
}

#[tauri::command]
pub async fn read_file_diff(app: AppHandle, id: Uuid, path: String, comparison: Comparison) -> Result<FileDiff, String> {
    let (record, _) = session_file(&app, id, &path)?;
    let base = comparison_base(&app, &record, comparison).await?;
    git::file_diff(&record.worktree_path, &base, &path).await
}

/// The versions of `path` in the edit log of the session's worktree, oldest first, each with the session that wrote it.
#[tauri::command]
pub async fn read_file_history(app: AppHandle, id: Uuid, path: String) -> Result<Vec<FileVersion>, String> {
    let (record, _) = session_file(&app, id, &path)?;
    attribution::file_history(&app, &record.worktree_path, &path).await
}

/// Writes `content` to `path` inside the session's worktree; `path` must be relative and must not leave the worktree.
/// The change counts as the session's own, like an edit by its agent.
#[tauri::command]
pub async fn write_file(app: AppHandle, id: Uuid, path: String, content: String) -> Result<(), String> {
    link::ensure_writable(&app, id, &format!("save {path}"))?;
    let (record, target) = session_file(&app, id, &path)?;
    attribution::record_write(&app, &record.worktree_path, id, || {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, content).map_err(|error| format!("failed to write {path}: {error}"))
    })
    .await?;
    store::add_touched_files(&app, id, std::slice::from_ref(&path))?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

/// Writes the skills of the swf steps `skills` from Hunt's templates into the session's worktree, leaving existing skill
/// files alone, and adds their missing entries to `swf.skills` of its hunt.json (`swf_skills::ensure`); returns the
/// worktree-relative paths it wrote, hunt.json among them when it changed, which count as the session's own changes.
#[tauri::command]
pub async fn create_swf_skills(app: AppHandle, id: Uuid, skills: Vec<swf_skills::StepSkill>) -> Result<Vec<String>, String> {
    link::ensure_writable(&app, id, "create the skills of the swf steps")?;
    let record = worktree_session(&app, id)?;
    let mut written = Vec::new();
    attribution::record_write(&app, &record.worktree_path, id, || {
        written = swf_skills::ensure(&record.worktree_path, &skills)?;
        Ok(())
    })
    .await?;
    if written.is_empty() {
        return Ok(written);
    }
    store::add_touched_files(&app, id, &written)?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)?;
    Ok(written)
}

/// Moves the file at `from` to `to` inside the session's worktree, creating `to`'s folders; both paths must be
/// relative and must not leave the worktree, and nothing may exist at `to` yet. Both count as the session's own
/// changes, like an edit by its agent.
#[tauri::command]
pub async fn move_path(app: AppHandle, id: Uuid, from: String, to: String) -> Result<(), String> {
    link::ensure_writable(&app, id, &format!("move {from}"))?;
    let (record, source) = session_file(&app, id, &from)?;
    let target = worktree_file(&record, &to)?;
    if from.is_empty() || to.is_empty() {
        return Err("refusing to move the worktree itself".to_string());
    }
    if target.exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&source, &target).map_err(|error| format!("failed to move {from} to {to}: {error}"))?;
    store::add_touched_files(&app, id, &[from, to])?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

/// Deletes the file or folder (recursively) at `path` inside the session's worktree; `path` must be relative and
/// must not leave the worktree. The deleted files count as the session's own changes, like an edit by its agent.
#[tauri::command]
pub async fn delete_path(app: AppHandle, id: Uuid, path: String) -> Result<(), String> {
    link::ensure_writable(&app, id, &format!("delete {path}"))?;
    let (record, target) = session_file(&app, id, &path)?;
    if path.is_empty() {
        return Err("refusing to delete the worktree itself".to_string());
    }

    let mut deleted = Vec::new();
    if target.is_dir() {
        collect_files_below(&target, &record.worktree_path, &mut deleted);
        std::fs::remove_dir_all(&target).map_err(|error| format!("failed to delete {path}: {error}"))?;
    } else {
        deleted.push(path.clone());
        std::fs::remove_file(&target).map_err(|error| format!("failed to delete {path}: {error}"))?;
    }
    store::add_touched_files(&app, id, &deleted)?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

/// Appends the worktree-relative paths of every file below `dir` to `out`.
fn collect_files_below(dir: &Path, worktree: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_below(&path, worktree, out);
        } else if let Ok(relative) = path.strip_prefix(worktree) {
            out.push(relative.to_string_lossy().to_string());
        }
    }
}

#[tauri::command]
pub async fn revert_file(app: AppHandle, id: Uuid, path: String, comparison: Comparison) -> Result<(), String> {
    link::ensure_writable(&app, id, &format!("revert {path}"))?;
    let (record, _) = session_file(&app, id, &path)?;
    let base = comparison_base(&app, &record, comparison).await?;
    git::revert_file(&record.worktree_path, &base, &path).await?;
    store::forget_touched_files(&app, &record.worktree_path, std::slice::from_ref(&path))?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn shelve_files(app: AppHandle, id: Uuid, paths: Vec<String>, name: String) -> Result<(), String> {
    link::ensure_writable(&app, id, "shelve the files")?;
    let record = worktree_session(&app, id)?;
    git::shelve_files(&record.worktree_path, &paths, &name).await?;
    store::forget_touched_files(&app, &record.worktree_path, &paths)?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn list_shelves(app: AppHandle, id: Uuid) -> Result<Vec<Shelf>, String> {
    let record = worktree_session(&app, id)?;
    git::list_shelves(&record.worktree_path, &record.branch).await
}

/// Restores a shelf into the worktree; `keep` leaves the shelf in place instead of dropping it.
#[tauri::command]
pub async fn unshelve(app: AppHandle, id: Uuid, reference: String, keep: bool) -> Result<(), String> {
    link::ensure_writable(&app, id, "unshelve the files")?;
    let record = worktree_session(&app, id)?;
    git::unshelve(&record.worktree_path, &reference, keep).await?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

#[tauri::command]
pub async fn drop_shelf(app: AppHandle, id: Uuid, reference: String) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    git::drop_shelf(&record.worktree_path, &reference).await
}

/// Commits exactly `paths` with `message` on the session's current branch in its local worktree, with this Mac's Git,
/// hooks and identity; the branch on the VM of a remote session then follows the new commit, at the next connect when
/// the session is not connected.
#[tauri::command]
pub async fn commit_files(app: AppHandle, id: Uuid, paths: Vec<String>, message: String) -> Result<(), String> {
    link::ensure_writable(&app, id, "commit")?;
    let record = worktree_session(&app, id)?;
    match remote_host(&app, &record) {
        Some((owner, _)) if sync::is_connected(&app, owner) => commit_followed(&app, owner, &record.worktree_path, &paths, &message).await?,
        _ => git::commit_files(&record.worktree_path, &paths, &message).await?,
    }
    store::forget_touched_files(&app, &record.worktree_path, &paths)?;
    related::refresh_family(&app, id);
    Ok(())
}

/// Commits `paths` of the remote session `id` in its local worktree `worktree` while no sync of it runs, after one sent
/// the local edits to the VM, so that the VM's branch can follow the commit without touching its files
/// (`sync::follow_head`); refuses when one of the files could not reach the VM.
async fn commit_followed(app: &AppHandle, id: Uuid, worktree: &Path, paths: &[String], message: &str) -> Result<(), String> {
    sync::exclusive(app, id, |outcome| async move {
        let unsynced: Vec<&String> = outcome
            .iter()
            .flat_map(|outcome| &outcome.conflicts)
            .filter(|line| paths.iter().any(|path| line.starts_with(&format!("{path}: "))))
            .collect();
        if !unsynced.is_empty() {
            let lines = unsynced.iter().map(|line| line.as_str()).collect::<Vec<_>>().join("\n");
            return Err(format!("failed to commit: these files did not reach the VM:\n{lines}"));
        }
        let target = store::find_session(app, id)?.remote.ok_or("failed to commit: the session runs locally now")?;
        git::commit_files(worktree, paths, message).await?;
        let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
        sync::follow_head(app, id, &ssh, &target, worktree).await?;
        Ok(())
    })
    .await
}

/// Pushes the session's commits from here, with this Mac's Git credentials, to the branch on `origin` its branch tracks
/// (`push_target`), after a rebase onto that branch when it moved on. The branch of a remote session connected to its VM is first brought to the same commit here and on
/// its VM, and the VM's branch follows the rebase (`push_followed`); one not connected pushes from its local worktree
/// alone, and the VM's branch follows at the next connect (`remote::commit::direction`). Only a poller session's branch
/// is pushed from its VM under its own name with the poller's stored token, so that the push shows the poller's GitHub
/// App like the rest of what its agent does on GitHub.
#[tauri::command]
pub async fn push_branch(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let Some((owner, target)) = remote_host(&app, &record) else {
        return git::push_branch(&record.worktree_path, &push_target(&record, None).await).await;
    };
    if !target.origin.keeps_vm_tokens() && !sync::is_connected(&app, owner) {
        return git::push_branch(&record.worktree_path, &push_target(&record, Some(&target)).await).await;
    }
    if target.origin.keeps_vm_tokens() {
        let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
        remote::commit::push_stored(&ssh, owner).await?;
        // The local remote-tracking ref learns about the VM's push, so `unpushed_commit_count` stops offering one.
        if let Err(error) = git::fetch_branch(&record.worktree_path, &target.branch).await {
            eprintln!("failed to fetch the pushed branch {} of session {id}: {error}", target.branch);
        }
        return Ok(());
    }
    push_followed(&app, owner, &record.worktree_path, &push_target(&record, Some(&target)).await).await
}

/// Number of commits `push_branch` would publish, counted in the session's local worktree against the branch the push
/// lands on, as fetched last; a remote session's local branch and its VM's point at the same commit.
#[tauri::command]
pub async fn unpushed_commit_count(app: AppHandle, id: Uuid) -> Result<u32, String> {
    let record = worktree_session(&app, id)?;
    let remote = remote_host(&app, &record).map(|(_, target)| target);
    git::unpushed_commit_count(&record.worktree_path, &push_target(&record, remote.as_ref()).await).await
}

/// Pushes the commits of the remote session `id`, checked out in its local worktree `worktree`, to the branch `target`
/// on `origin` from here, while no sync of the session runs: the branch is brought to the same commit here and on the
/// VM (`sync::follow_head`); when `origin/<target>` moved on, the branch is rebased onto it here, with the local Git
/// identity, and the VM's branch moves to the rebased commit (`remote::commit::move_vm_head`), which the local branch
/// follows from then on; then `HEAD` is pushed. A branch that moved on both sides fails the push with the message of
/// the alignment.
async fn push_followed(app: &AppHandle, id: Uuid, worktree: &Path, target: &str) -> Result<(), String> {
    sync::exclusive(app, id, |_| async move {
        let remote = store::find_session(app, id)?.remote.ok_or("failed to push: the session runs locally now")?;
        let ssh = Ssh::open(&remote.vm, &ssh_dir()?).await?;
        sync::follow_head(app, id, &ssh, &remote, worktree).await?;
        git::fetch_branch(worktree, target).await?;
        if git::is_behind_origin(worktree, target).await {
            git::rebase_onto_origin(worktree, target).await?;
            let head = remote::commit::move_vm_head(&ssh, id, &remote, worktree).await?;
            store::update_session(app, id, |stored| {
                if let Some(remote) = stored.remote.as_mut() {
                    remote.handoff_head = head;
                }
            })?;
        }
        git::push_head(worktree, target).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_files_below_lists_every_file_relative_to_the_worktree() {
        let directory = tempfile::tempdir().unwrap();
        let worktree = directory.path();
        std::fs::create_dir_all(worktree.join("src/app/nested")).unwrap();
        std::fs::write(worktree.join("src/app/a.ts"), "").unwrap();
        std::fs::write(worktree.join("src/app/nested/b.ts"), "").unwrap();
        std::fs::write(worktree.join("root.txt"), "").unwrap();

        let mut files = Vec::new();
        collect_files_below(&worktree.join("src"), worktree, &mut files);
        files.sort();
        assert_eq!(files, vec!["src/app/a.ts".to_string(), "src/app/nested/b.ts".to_string()]);

        let mut none = Vec::new();
        collect_files_below(&worktree.join("missing"), worktree, &mut none);
        assert!(none.is_empty());
    }
}
