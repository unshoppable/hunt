//! Bringing a session back from its VM: its relay stops, the agent's commits and uncommitted work come back as a
//! snapshot on top of the VM's `HEAD`, the Git LFS objects they need follow, and the transcript returns with its paths
//! moved back. The local worktree must still hold what the handoff left there; a retrieval interrupted after the
//! snapshot was applied can be repeated. A session this Mac adopted has no local worktree yet: it gets a new one in
//! the local checkout of its repository, on the branch the VM has checked out.

use std::path::Path;

use uuid::Uuid;

use super::handoff::{lfs_object_ids, lfs_object_path, lfs_objects_dir, REMOTE_CLAUDE_DIR, REMOTE_MODE};
use super::ssh::Ssh;
use super::{adoption, memory, transcript};
use super::{hunt_ctl, shell_command, start_session_vm, tar_extract, vm, Progress, RemoteStep, RemoteTarget, VmRef};
use crate::git;

/// Everything a retrieval needs from the session.
pub struct RetrieveRequest<'a> {
    pub hunt_session_id: Uuid,
    pub worktree: &'a Path,
    pub target: &'a RemoteTarget,
    /// The gateway that starts the session's VM.
    pub gateway: &'a VmRef,
    pub ssh_dir: &'a Path,
    pub claude_dir: &'a Path,
    /// The base of the repository memory the handoff sent; see `memory::merge`.
    pub memory_base: &'a Path,
    /// For a session this Mac adopted: the local repository in which the retrieval creates the worktree `worktree`.
    pub adopted_into: Option<&'a Path>,
}

/// The ACP session id the transcript continues under, as the relay left it, and for an adopted session the branch its
/// new worktree has checked out.
pub struct Retrieved {
    pub acp_session_id: Option<String>,
    pub branch: Option<String>,
}

/// Stops the session on its VM and applies its state to the local worktree. The VM stays; the caller deletes it once the
/// session runs locally again.
pub async fn retrieve(request: RetrieveRequest<'_>, progress: Progress<'_>) -> Result<Retrieved, String> {
    if let Some(repo) = request.adopted_into {
        return retrieve_adopted(&request, repo, progress).await;
    }
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

    let ssh = connect(&request, progress).await?;
    let remote_worktree = remote_worktree(&request, &ssh).await?;
    progress(RemoteStep::StoppingAgent);
    hunt_ctl(&ssh, &["stop", &id]).await?;

    progress(RemoteStep::RetrievingCode);
    if !is_applied {
        hunt_ctl(&ssh, &["snapshot", &id]).await?;
        fetch(worktree, &ssh, &remote_worktree, &retrieve_ref).await?;
        download_lfs_objects(worktree, &ssh, &id, &retrieve_ref).await?;
        apply_tree_change(worktree, &handoff_ref, &retrieve_ref).await?;
    }
    move_branch(worktree, &id, &target.branch, &target.handoff_head, &retrieve_ref).await?;
    finish_worktree(worktree, &retrieve_ref).await?;

    let acp_session_id = retrieve_transcript(&request, &ssh, &remote_worktree).await?;
    Ok(Retrieved { acp_session_id, branch: None })
}

/// Retrieves the adopted session of `request` into a new worktree of the local repository `repo`, on the branch the VM
/// has checked out. A failed retrieval removes that worktree again, so it can be repeated.
async fn retrieve_adopted(request: &RetrieveRequest<'_>, repo: &Path, progress: Progress<'_>) -> Result<Retrieved, String> {
    let id = request.hunt_session_id.to_string();
    let worktree = request.worktree;
    let target = request.target;
    let retrieve_ref = format!("refs/hunt/{id}/retrieve");
    if worktree.exists() {
        return Err(format!("failed to bring back the session: {} exists already", worktree.display()));
    }

    let ssh = connect(request, progress).await?;
    let remote_worktree = remote_worktree(request, &ssh).await?;
    let checked_out = remote_branch(&ssh, &remote_worktree).await;
    let fallback = git::session_branch(&vm::short_id(request.hunt_session_id));
    let branch = local_branch_name(repo, &[checked_out.as_deref(), Some(target.branch.as_str()), Some(fallback.as_str())]).await?;
    progress(RemoteStep::StoppingAgent);
    hunt_ctl(&ssh, &["stop", &id]).await?;

    progress(RemoteStep::RetrievingCode);
    hunt_ctl(&ssh, &["snapshot", &id]).await?;
    fetch(repo, &ssh, &remote_worktree, &retrieve_ref).await?;
    download_lfs_objects(repo, &ssh, &id, &retrieve_ref).await?;
    create_worktree_from_snapshot(repo, worktree, &branch, &retrieve_ref).await?;
    match retrieve_transcript(request, &ssh, &remote_worktree).await {
        Ok(acp_session_id) => Ok(Retrieved { acp_session_id, branch: Some(branch) }),
        Err(error) => {
            remove_worktree(repo, worktree, &branch).await;
            Err(error)
        }
    }
}

/// Starts the session's VM through the gateway when it is off and connects; the VM must speak this app's protocol, so
/// that its `hunt-ctl` knows the commands the retrieval runs.
async fn connect(request: &RetrieveRequest<'_>, progress: Progress<'_>) -> Result<Ssh, String> {
    progress(RemoteStep::Connecting);
    start_session_vm(request.gateway, request.hunt_session_id, request.ssh_dir, progress).await
}

/// The worktree of the session on its running VM: the one the record names, or for an adopted session that never
/// reached its VM the one the VM records.
async fn remote_worktree(request: &RetrieveRequest<'_>, ssh: &Ssh) -> Result<String, String> {
    if !request.target.worktree_path.as_os_str().is_empty() {
        return Ok(request.target.worktree_path.display().to_string());
    }
    Ok(adoption::read_session_meta(ssh, request.hunt_session_id).await?.worktree)
}

/// The branch the session's worktree on the VM has checked out; `None` when it is detached or git fails.
async fn remote_branch(ssh: &Ssh, remote_worktree: &str) -> Option<String> {
    let command = shell_command("sudo", &["-n", "-u", "agent", "git", "-C", remote_worktree, "symbolic-ref", "--short", "-q", "HEAD"]);
    let branch = ssh.run(&command).await.ok()?;
    Some(branch.trim().to_string()).filter(|branch| !branch.is_empty())
}

/// The first of `candidates` that is a valid branch name; fails when that branch exists in `repo` already, since the
/// new worktree must not take over someone's branch.
async fn local_branch_name(repo: &Path, candidates: &[Option<&str>]) -> Result<String, String> {
    let names = candidates.iter().flatten().map(|candidate| candidate.trim());
    for candidate in names.filter(|candidate| !candidate.is_empty() && !candidate.starts_with('-')) {
        if git::run_git(repo, &["check-ref-format", "--branch", candidate]).await.is_err() {
            continue;
        }
        if git::run_git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{candidate}")]).await.is_ok() {
            let repo = repo.display();
            return Err(format!("failed to bring back the session: the branch {candidate} exists in {repo} already; rename or delete it first"));
        }
        return Ok(candidate.to_string());
    }
    Err("failed to bring back the session: it has no valid branch name".into())
}

/// Creates the worktree `worktree` of `repo` on the new branch `branch` at the commit the agent left on the VM (the
/// parent of the retrieval snapshot), with the snapshot's uncommitted work applied; removes it again on failure.
async fn create_worktree_from_snapshot(repo: &Path, worktree: &Path, branch: &str, retrieve_ref: &str) -> Result<(), String> {
    git::worktree_add(repo, branch, worktree, &format!("{retrieve_ref}^")).await?;
    let applied = async {
        apply_tree_change(worktree, "HEAD", retrieve_ref).await?;
        finish_worktree(worktree, retrieve_ref).await
    }
    .await;
    if let Err(error) = applied {
        remove_worktree(repo, worktree, branch).await;
        return Err(error);
    }
    Ok(())
}

/// Removes the worktree and branch a failed retrieval of an adopted session created; failures are only logged.
async fn remove_worktree(repo: &Path, worktree: &Path, branch: &str) {
    if let Err(error) = git::worktree_remove(repo, worktree).await {
        eprintln!("removing the worktree {} after a failed retrieval failed: {error}", worktree.display());
    }
    if let Err(error) = git::delete_branch(repo, branch).await {
        eprintln!("deleting the branch {branch} after a failed retrieval failed: {error}");
    }
}

/// Fetches the retrieval snapshot (and with it the commits the agent made) into `retrieve_ref`, through
/// `hunt-ctl upload-pack`, which runs git on the VM as the agent's user.
async fn fetch(worktree: &Path, ssh: &Ssh, remote_worktree: &str, retrieve_ref: &str) -> Result<(), String> {
    let url = ssh.git_url(remote_worktree);
    let refspec = format!("+{retrieve_ref}:{retrieve_ref}");
    let ssh_command = ssh.git_ssh_command();
    let args = ["fetch", "--no-tags", "--quiet", "--upload-pack=sudo -n hunt-ctl upload-pack", url.as_str(), refspec.as_str()];
    git::run_git_with_env(worktree, &args, &[("GIT_SSH_COMMAND", ssh_command.as_str())])
        .await
        .map_err(|error| format!("failed to fetch the session from the VM: {error}"))?;
    Ok(())
}

/// Copies the LFS objects of `reference` that the local store lacks from the VM.
async fn download_lfs_objects(worktree: &Path, ssh: &Ssh, id: &str, reference: &str) -> Result<(), String> {
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
    let list = format!("{}\n", missing.join("\n"));
    let archive = ssh.run_with_input(&shell_command("sudo", &["-n", "hunt-ctl", "lfs-get", id]), list.as_bytes()).await?;
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

/// Copies the session's project folder back from the VM with its paths moved to the local worktree and merges its
/// memory into the repository's local one; returns the ACP session id the relay last served. A failed merge is only
/// logged: the session comes back regardless.
async fn retrieve_transcript(request: &RetrieveRequest<'_>, ssh: &Ssh, remote_worktree: &str) -> Result<Option<String>, String> {
    let id = request.hunt_session_id.to_string();
    let remote_slug = transcript::project_slug(remote_worktree);
    let archive = ssh.run_with_input(&shell_command("sudo", &["-n", "hunt-ctl", "get-claude", &id, "--project", &remote_slug]), &[]).await?;

    let staging = std::env::temp_dir().join(format!("hunt-retrieve-{}", Uuid::new_v4()));
    let result = async {
        std::fs::create_dir_all(&staging).map_err(|error| format!("failed to create {}: {error}", staging.display()))?;
        tar_extract(&archive, &staging).await?;
        let acp_session_id = relay_session_id(&staging.join("hunt-session.json"))?;
        let local_worktree = request.worktree.display().to_string();
        let local_project = request.claude_dir.join("projects").join(transcript::project_slug(&local_worktree));
        let mut replacements = vec![
            (remote_worktree.to_string(), local_worktree),
            (format!("{REMOTE_CLAUDE_DIR}/projects/{remote_slug}"), local_project.display().to_string()),
        ];
        replacements.extend(mode_replacement(request.target.restored_mode()));
        let project = staging.join("projects").join(&remote_slug);
        let remote_memory = staging.join("memory");
        if std::fs::symlink_metadata(project.join("memory")).is_ok_and(|metadata| metadata.is_dir()) {
            std::fs::rename(project.join("memory"), &remote_memory).map_err(|error| format!("failed to move the memory aside: {error}"))?;
        }
        if std::fs::symlink_metadata(&project).is_ok_and(|metadata| metadata.is_dir()) {
            transcript::copy_rewritten(&project, &local_project, &replacements)?;
        }
        if let Err(error) = merge_memory(request, &remote_memory, &replacements).await {
            eprintln!("merging the memory of session {id} into the local one failed: {error}");
        }
        Ok(acp_session_id)
    }
    .await;
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Merges the memory the agent left on the VM (`remote_dir`, its paths moved back with `replacements`) into the local
/// memory of the session's repository.
async fn merge_memory(request: &RetrieveRequest<'_>, remote_dir: &Path, replacements: &[(String, String)]) -> Result<(), String> {
    let remote = memory::read_files(remote_dir)?
        .into_iter()
        .map(|(path, bytes)| match String::from_utf8(bytes) {
            Ok(text) => (path, transcript::rewrite(&text, replacements).into_bytes()),
            Err(error) => (path, error.into_bytes()),
        })
        .collect();
    let local_dir = memory::local_dir(request.claude_dir, request.worktree).await?;
    let local = memory::read_files(&local_dir)?;
    let base = memory::read_base(request.memory_base);
    let tag = &request.hunt_session_id.simple().to_string()[..8];
    memory::apply(&local_dir, &memory::merge(base.as_ref(), &local, &remote, tag))
}

/// The ACP session id in the relay's `hunt-session.json`, a regular file of the archive the VM sent.
fn relay_session_id(path: &Path) -> Result<Option<String>, String> {
    if !std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return Err("failed to read the relay's session file: the VM sent none".into());
    }
    let text = std::fs::read_to_string(path).map_err(|error| format!("failed to read the relay's session file: {error}"))?;
    let config: serde_json::Value = serde_json::from_str(&text).map_err(|error| format!("failed to read the relay's session file: {error}"))?;
    Ok(config["acpSessionId"].as_str().map(str::to_string))
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

    /// An adopted session: the local repository only knows the default branch, the VM has the session's branch with a
    /// commit of the agent and uncommitted work on top.
    #[tokio::test]
    async fn retrieval_of_an_adopted_session_creates_a_worktree_on_the_vms_branch() {
        let local_dir = tempfile::tempdir().unwrap();
        let local = local_dir.path().join("repo");
        std::fs::create_dir_all(&local).unwrap();
        git(&local, &["init", "-q", "-b", "main"]).await;
        git(&local, &["config", "user.email", "test@example.com"]).await;
        git(&local, &["config", "user.name", "Test"]).await;
        std::fs::write(local.join("tracked.txt"), "one\n").unwrap();
        std::fs::write(local.join("gone.txt"), "temporary\n").unwrap();
        git(&local, &["add", "."]).await;
        git(&local, &["commit", "-q", "-m", "init"]).await;

        let vm_dir = tempfile::tempdir().unwrap();
        let remote = vm_dir.path().join("worktree");
        git(vm_dir.path(), &["clone", "-q", local.to_str().unwrap(), remote.to_str().unwrap()]).await;
        git(&remote, &["config", "user.email", "agent@example.com"]).await;
        git(&remote, &["config", "user.name", "Agent"]).await;
        git(&remote, &["checkout", "-q", "-b", "fix/general/123-fix"]).await;
        std::fs::write(remote.join("tracked.txt"), "two\n").unwrap();
        git(&remote, &["commit", "-q", "-am", "agent work"]).await;
        std::fs::write(remote.join("tracked.txt"), "three\n").unwrap();
        std::fs::write(remote.join("new.txt"), "fresh\n").unwrap();
        std::fs::remove_file(remote.join("gone.txt")).unwrap();
        let remote_head = git(&remote, &["rev-parse", "HEAD"]).await;
        let snapshot = git::snapshot_commit(&remote, "Hunt retrieve snapshot").await.unwrap();
        git(&remote, &["update-ref", "refs/hunt/x/retrieve", &snapshot]).await;
        git(&local, &["fetch", "-q", remote.to_str().unwrap(), "+refs/hunt/x/retrieve:refs/hunt/x/retrieve"]).await;

        let branch = local_branch_name(&local, &[Some(" fix/general/123-fix "), Some("feat/general/ab12cd34")]).await.unwrap();
        assert_eq!(branch, "fix/general/123-fix");
        let worktree = local_dir.path().join("worktrees").join("x");
        create_worktree_from_snapshot(&local, &worktree, &branch, "refs/hunt/x/retrieve").await.unwrap();

        assert_eq!(git(&worktree, &["rev-parse", "HEAD"]).await, remote_head);
        assert_eq!(git(&worktree, &["symbolic-ref", "--short", "HEAD"]).await, "fix/general/123-fix");
        assert_eq!(read(&worktree, "tracked.txt").as_deref(), Some("three\n"));
        assert_eq!(read(&worktree, "new.txt").as_deref(), Some("fresh\n"));
        assert_eq!(read(&worktree, "gone.txt"), None);
        assert_eq!(status(&worktree).await, status(&remote).await);
        assert_eq!(git(&local, &["symbolic-ref", "--short", "HEAD"]).await, "main");

        // The branch exists now, so a second adoption of it must not take it over; invalid names are skipped.
        let taken = local_branch_name(&local, &[Some("fix/general/123-fix")]).await;
        assert!(taken.unwrap_err().contains("the branch fix/general/123-fix exists"));
        let valid = local_branch_name(&local, &[None, Some("bad..name"), Some("-x"), Some("feat/general/ab12cd34")]).await;
        assert_eq!(valid.unwrap(), "feat/general/ab12cd34");
        // A branch outside the `feat/general/` scheme, as older sessions have, is kept.
        let old = local_branch_name(&local, &[Some("hunt/7-old"), Some("feat/general/ab12cd34")]).await;
        assert_eq!(old.unwrap(), "hunt/7-old");
        assert!(local_branch_name(&local, &[Some(""), None]).await.is_err());
    }
}
