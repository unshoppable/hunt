//! Bringing a session back from the VM: its container stops, the agent's commits and uncommitted work come back as a
//! snapshot on top of the VM's `HEAD`, the Git LFS objects they need follow, and the transcript returns with its paths
//! moved back. The local worktree must still hold what the handoff left there; a retrieval interrupted after the
//! snapshot was applied can be repeated.

use std::path::Path;

use uuid::Uuid;

use super::handoff::{lfs_object_ids, lfs_object_path, lfs_objects_dir, REMOTE_CLAUDE_DIR, REMOTE_MODE};
use super::ssh::Ssh;
use super::transcript;
use super::{hunt_ctl, shell_command, shell_quote, tar_extract, vm, Progress, RemoteStep, RemoteTarget};
use crate::git;

/// Everything a retrieval needs from the session.
pub struct RetrieveRequest<'a> {
    pub hunt_session_id: Uuid,
    pub worktree: &'a Path,
    pub target: &'a RemoteTarget,
    pub ssh_dir: &'a Path,
    pub claude_dir: &'a Path,
}

/// The ACP session id the transcript continues under, as the relay left it.
pub struct Retrieved {
    pub acp_session_id: Option<String>,
}

/// The bare repository on the VM that holds the session's branch.
pub fn repository_path(target: &RemoteTarget) -> String {
    format!("/srv/repos/{}.git", target.repo)
}

/// Stops the session on the VM and applies its state to the local worktree. The VM side stays in place; the caller
/// removes it once the session runs locally again.
pub async fn retrieve(request: RetrieveRequest<'_>, progress: Progress<'_>) -> Result<Retrieved, String> {
    let id = request.hunt_session_id.to_string();
    let worktree = request.worktree;
    let target = request.target;
    let handoff_ref = format!("refs/hunt/{id}/handoff");
    let retrieve_ref = format!("refs/hunt/{id}/retrieve");

    let handoff_tree = git::rev_parse(worktree, &format!("{handoff_ref}^{{tree}}"))
        .await
        .map_err(|_| "failed to retrieve the session: its handoff snapshot is missing in the local repository".to_string())?;
    let local_tree = git::worktree_tree(worktree).await?;
    let applied_tree = git::rev_parse(worktree, &format!("{retrieve_ref}^{{tree}}")).await.ok();
    let is_applied = local_tree != handoff_tree && applied_tree.as_deref() == Some(local_tree.as_str());
    if local_tree != handoff_tree && !is_applied {
        return Err("failed to retrieve the session: its local worktree changed since the handoff; revert or shelve those changes first".into());
    }

    progress(RemoteStep::Connecting);
    let ssh = Ssh::open(&target.vm, request.ssh_dir).await?;
    vm::ensure_running(&target.vm, &ssh, progress).await?;
    progress(RemoteStep::StoppingAgent);
    hunt_ctl(&ssh, &["stop", &id]).await?;

    progress(RemoteStep::RetrievingCode);
    if !is_applied {
        hunt_ctl(&ssh, &["snapshot", &id]).await?;
        let repo_path = repository_path(target);
        fetch(worktree, &ssh, &repo_path, &retrieve_ref).await?;
        download_lfs_objects(worktree, &ssh, &repo_path, &retrieve_ref).await?;
        apply_tree_change(worktree, &handoff_ref, &retrieve_ref).await?;
    }
    move_branch(worktree, &id, &target.branch, &target.handoff_head, &retrieve_ref).await?;
    finish_worktree(worktree, &retrieve_ref).await?;

    let acp_session_id = retrieve_transcript(&request, &ssh).await?;
    Ok(Retrieved { acp_session_id })
}

/// Fetches the retrieval snapshot (and with it the commits the agent made) into `retrieve_ref`.
async fn fetch(worktree: &Path, ssh: &Ssh, repo_path: &str, retrieve_ref: &str) -> Result<(), String> {
    let url = ssh.git_url(repo_path);
    let refspec = format!("+{retrieve_ref}:{retrieve_ref}");
    let ssh_command = ssh.git_ssh_command();
    let args = ["fetch", "--no-tags", "--quiet", "--upload-pack=sudo -n -u hunt git-upload-pack", url.as_str(), refspec.as_str()];
    git::run_git_with_env(worktree, &args, &[("GIT_SSH_COMMAND", ssh_command.as_str())])
        .await
        .map_err(|error| format!("failed to fetch the session from the VM: {error}"))?;
    Ok(())
}

/// Copies the LFS objects of `reference` that the local store lacks from the VM.
async fn download_lfs_objects(worktree: &Path, ssh: &Ssh, repo_path: &str, reference: &str) -> Result<(), String> {
    let objects_dir = lfs_objects_dir(worktree).await?;
    let missing: Vec<String> = lfs_object_ids(worktree, &[reference])
        .await
        .iter()
        .map(|id| lfs_object_path(id))
        .filter(|path| !objects_dir.join(path).is_file())
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let paths: Vec<String> = missing.iter().map(|path| shell_quote(path)).collect();
    let script = format!("cd {}/lfs/objects && tar -czf - {}", shell_quote(repo_path), paths.join(" "));
    let archive = ssh.run_with_input(&shell_command("sudo", &["-n", "-u", "hunt", "sh", "-c", &script]), &[]).await?;
    std::fs::create_dir_all(&objects_dir).map_err(|error| format!("failed to create {}: {error}", objects_dir.display()))?;
    tar_extract(&archive, &objects_dir).await
}

/// Changes the working tree from the handoff snapshot to the retrieval snapshot: the edits, new files and deletions
/// the agent made, including those of files that were untracked at the handoff. The index ends up at the retrieval
/// snapshot; `finish_worktree` rebuilds it.
pub(crate) async fn apply_tree_change(worktree: &Path, handoff_ref: &str, retrieve_ref: &str) -> Result<(), String> {
    let handoff_tree = format!("{handoff_ref}^{{tree}}");
    git::run_git(worktree, &["read-tree", &handoff_tree]).await?;
    // Exits non-zero when entries need an update, which is what the refresh is for.
    let _ = git::run_git(worktree, &["update-index", "-q", "--refresh"]).await;
    git::run_git(worktree, &["read-tree", "-u", "-m", &handoff_tree, &format!("{retrieve_ref}^{{tree}}")]).await?;
    Ok(())
}

/// Points the session's branch at the commit the agent left on the VM (the parent of the retrieval snapshot). The
/// commit the branch had at the handoff stays reachable as `refs/hunt/<id>/pre-retrieve`.
pub(crate) async fn move_branch(worktree: &Path, id: &str, branch: &str, handoff_head: &str, retrieve_ref: &str) -> Result<(), String> {
    let remote_head = git::rev_parse(worktree, &format!("{retrieve_ref}^")).await?;
    let local_head = git::rev_parse(worktree, "HEAD").await?;
    if local_head == remote_head {
        return Ok(());
    }
    if local_head != handoff_head {
        return Err(format!("failed to retrieve the session: the branch {branch} moved since the handoff"));
    }
    git::run_git(worktree, &["update-ref", &format!("refs/hunt/{id}/pre-retrieve"), handoff_head]).await?;
    let head_ref = git::run_git(worktree, &["symbolic-ref", "-q", "HEAD"]).await.map(|name| name.trim().to_string()).unwrap_or_else(|_| "HEAD".into());
    git::run_git(worktree, &["update-ref", &head_ref, &remote_head, handoff_head]).await?;
    Ok(())
}

/// Rebuilds the index from the new `HEAD`, so the agent's uncommitted work shows as uncommitted again, after Git LFS
/// files got their content.
pub(crate) async fn finish_worktree(worktree: &Path, retrieve_ref: &str) -> Result<(), String> {
    if !lfs_object_ids(worktree, &[retrieve_ref]).await.is_empty() {
        git::run_git(worktree, &["lfs", "checkout"]).await?;
    }
    git::run_git(worktree, &["reset", "-q"]).await?;
    Ok(())
}

/// Copies the session's project folder back from the VM with its paths moved to the local worktree; returns the ACP
/// session id the relay last served.
async fn retrieve_transcript(request: &RetrieveRequest<'_>, ssh: &Ssh) -> Result<Option<String>, String> {
    let id = request.hunt_session_id;
    let config = ssh.run(&shell_command("sudo", &["-n", "cat", &format!("/srv/claude/{id}/hunt-session.json")])).await?;
    let config: serde_json::Value = serde_json::from_str(&config).map_err(|error| format!("failed to read the relay's session file: {error}"))?;
    let acp_session_id = config["acpSessionId"].as_str().map(str::to_string);

    let remote_worktree = request.target.worktree_path.display().to_string();
    let remote_slug = transcript::project_slug(&remote_worktree);
    let remote_project = format!("/srv/claude/{id}/projects/{remote_slug}");
    let script = format!("if cd {} 2>/dev/null; then tar -czf - .; else tar -czf - -T /dev/null; fi", shell_quote(&remote_project));
    let archive = ssh.run_with_input(&shell_command("sudo", &["-n", "-u", "hunt", "sh", "-c", &script]), &[]).await?;

    let staging = std::env::temp_dir().join(format!("hunt-retrieve-{}", Uuid::new_v4()));
    let result = async {
        std::fs::create_dir_all(&staging).map_err(|error| format!("failed to create {}: {error}", staging.display()))?;
        tar_extract(&archive, &staging).await?;
        let local_worktree = request.worktree.display().to_string();
        let local_project = request.claude_dir.join("projects").join(transcript::project_slug(&local_worktree));
        let mut replacements = vec![
            (remote_worktree.clone(), local_worktree),
            (format!("{REMOTE_CLAUDE_DIR}/projects/{remote_slug}"), local_project.display().to_string()),
        ];
        replacements.extend(mode_replacement(request.target.restored_mode()));
        transcript::copy_rewritten(&staging, &local_project, &replacements)
    }
    .await;
    let _ = std::fs::remove_dir_all(&staging);
    result?;
    Ok(acp_session_id)
}

/// Every record the agent wrote on the VM carries `REMOTE_MODE`, and a local agent resumes in the mode of the last
/// record; this replacement gives those records the session's local mode instead.
fn mode_replacement(local_mode: &str) -> Option<(String, String)> {
    let field = |mode: &str| format!("\"permissionMode\":{}", serde_json::Value::from(mode));
    (local_mode != REMOTE_MODE).then(|| (field(REMOTE_MODE), field(local_mode)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_replacement_gives_records_from_the_vm_the_local_mode() {
        let (from, to) = mode_replacement("auto").unwrap();
        let record = r#"{"type":"user","permissionMode":"bypassPermissions","message":{"content":"say \"permissionMode\":\"bypassPermissions\""}}"#;
        assert_eq!(
            transcript::rewrite(record, &[(from, to)]),
            r#"{"type":"user","permissionMode":"auto","message":{"content":"say \"permissionMode\":\"bypassPermissions\""}}"#
        );
        assert_eq!(mode_replacement(REMOTE_MODE), None);
    }

    async fn git(dir: &Path, args: &[&str]) -> String {
        git::run_git(dir, args).await.unwrap().trim().to_string()
    }

    fn read(dir: &Path, file: &str) -> Option<String> {
        std::fs::read_to_string(dir.join(file)).ok()
    }

    /// `git status --porcelain` lines, sorted, for comparing two worktrees.
    async fn status(dir: &Path) -> Vec<String> {
        let mut lines: Vec<String> = git(dir, &["status", "--porcelain", "--untracked-files=all"]).await.lines().map(str::to_string).collect();
        lines.sort();
        lines
    }

    /// Runs the round trip a handoff and a retrieval make, with a local bare repository and worktree standing in for
    /// the VM and `hunt-ctl`.
    #[tokio::test]
    async fn retrieval_applies_commits_edits_new_files_and_deletions_of_the_vm() {
        let local_dir = tempfile::tempdir().unwrap();
        let local = local_dir.path();
        git(local, &["init", "-q", "-b", "main"]).await;
        git(local, &["config", "user.email", "test@example.com"]).await;
        git(local, &["config", "user.name", "Test"]).await;
        std::fs::write(local.join("tracked.txt"), "one\n").unwrap();
        std::fs::write(local.join("other.txt"), "keep\n").unwrap();
        git(local, &["add", "."]).await;
        git(local, &["commit", "-q", "-m", "init"]).await;

        // Uncommitted work at the handoff: an edit, a deletion and two untracked files.
        std::fs::write(local.join("tracked.txt"), "two\n").unwrap();
        std::fs::remove_file(local.join("other.txt")).unwrap();
        std::fs::write(local.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(local.join("gone.txt"), "temporary\n").unwrap();
        let handoff_head = git(local, &["rev-parse", "HEAD"]).await;
        let snapshot = git::snapshot_commit(local, "Hunt handoff snapshot").await.unwrap();
        git(local, &["update-ref", "refs/hunt/x/handoff", &snapshot]).await;
        assert_eq!(git(local, &["rev-parse", "HEAD"]).await, handoff_head);

        // The VM: a bare repository with the pushed refs and a worktree with the snapshot applied (`hunt-ctl prepare`).
        let vm_dir = tempfile::tempdir().unwrap();
        let bare = vm_dir.path().join("repo.git");
        let remote = vm_dir.path().join("worktree");
        git(vm_dir.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]).await;
        git(&bare, &["config", "user.email", "agent@example.com"]).await;
        git(&bare, &["config", "user.name", "Agent"]).await;
        git(local, &["push", "-q", bare.to_str().unwrap(), "HEAD:refs/heads/main", "refs/hunt/x/handoff:refs/hunt/x/handoff"]).await;
        git(&bare, &["worktree", "add", "-q", remote.to_str().unwrap(), "main"]).await;
        git(&remote, &["read-tree", "-u", "-m", "HEAD", "refs/hunt/x/handoff"]).await;
        git(&remote, &["reset", "-q"]).await;
        assert_eq!(status(&remote).await, status(local).await);

        // The agent commits (and amends), then leaves more uncommitted work behind.
        git(&remote, &["commit", "-q", "-am", "agent work"]).await;
        git(&remote, &["commit", "-q", "--amend", "-m", "agent work, amended"]).await;
        std::fs::write(remote.join("tracked.txt"), "three\n").unwrap();
        std::fs::write(remote.join("new.txt"), "fresher\n").unwrap();
        std::fs::write(remote.join("another.txt"), "added on the vm\n").unwrap();
        std::fs::remove_file(remote.join("gone.txt")).unwrap();
        let remote_head = git(&remote, &["rev-parse", "HEAD"]).await;
        // `hunt-ctl snapshot`: the working tree on top of HEAD, through a scratch index.
        let retrieve_snapshot = git::snapshot_commit(&remote, "Hunt retrieve snapshot").await.unwrap();
        git(&remote, &["update-ref", "refs/hunt/x/retrieve", &retrieve_snapshot]).await;

        git(local, &["fetch", "-q", bare.to_str().unwrap(), "+refs/hunt/x/retrieve:refs/hunt/x/retrieve"]).await;
        apply_tree_change(local, "refs/hunt/x/handoff", "refs/hunt/x/retrieve").await.unwrap();
        move_branch(local, "x", "main", &handoff_head, "refs/hunt/x/retrieve").await.unwrap();
        finish_worktree(local, "refs/hunt/x/retrieve").await.unwrap();

        assert_eq!(git(local, &["rev-parse", "HEAD"]).await, remote_head);
        assert_eq!(git(local, &["rev-parse", "refs/hunt/x/pre-retrieve"]).await, handoff_head);
        assert_eq!(read(local, "tracked.txt").as_deref(), Some("three\n"));
        assert_eq!(read(local, "new.txt").as_deref(), Some("fresher\n"));
        assert_eq!(read(local, "another.txt").as_deref(), Some("added on the vm\n"));
        assert_eq!(read(local, "other.txt"), None);
        assert_eq!(read(local, "gone.txt"), None);
        assert_eq!(status(local).await, status(&remote).await);

        // Repeating the branch move after an interrupted retrieval changes nothing.
        move_branch(local, "x", "main", &handoff_head, "refs/hunt/x/retrieve").await.unwrap();
        assert_eq!(git(local, &["rev-parse", "HEAD"]).await, remote_head);
    }
}
