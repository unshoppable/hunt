//! Commits of a remote session for the changelist, the push of a poller session's branch, and the local branch following
//! the VM's. The session's branch lives on its VM: `hunt-ctl commit` commits the picked files there under the local Git
//! identity, after the sync sent the local edits. Whenever the VM's `HEAD` moved (a commit of Hunt's or of the agent's),
//! the local branch points at it too (`follow_vm_head`), so the changelist shows what is uncommitted on the VM, as in a
//! local session, and a push from this Mac pushes the VM's commits, rebased here when the target branch moved on, after
//! which the VM's branch follows the rebased commit (`move_vm_head`). Only a poller session's branch is pushed from the
//! VM (`hunt-ctl push --stored`), with the poller's stored token. Knows nothing about Tauri.

use std::path::Path;

use uuid::Uuid;

use super::retrieve;
use super::ssh::Ssh;
use super::{hunt_ctl, hunt_ctl_with_input, shell_command, RemoteTarget};
use crate::git;

/// Commits `paths` of the remote session `id` with `message` on its VM behind `ssh`, under the identity of the local
/// worktree `worktree`. Paths the VM's branch has committed already are skipped there.
pub async fn commit(ssh: &Ssh, id: Uuid, worktree: &Path, paths: &[String], message: &str) -> Result<(), String> {
    let (name, email) = git::identity(worktree).await.map_err(|error| format!("failed to commit on the VM: {error}"))?;
    let input = commit_input(&name, &email, message, paths)?;
    hunt_ctl_with_input(ssh, &["commit", &id.to_string()], &input).await?;
    Ok(())
}

/// Points the local branch of the remote session `id`, which its local worktree `worktree` has checked out, at the
/// commit its worktree on the VM behind `ssh` has checked out, when that moved: fetches it as `refs/hunt/<id>/head` and
/// moves branch and index (`follow`). Returns the new commit; `None` when the branch points there already.
pub async fn follow_vm_head(ssh: &Ssh, id: Uuid, target: &RemoteTarget, worktree: &Path) -> Result<Option<String>, String> {
    let remote_worktree = target.worktree_path.display().to_string();
    let command = shell_command("sudo", &["-n", "-u", "agent", "git", "-C", &remote_worktree, "rev-parse", "--verify", "-q", "HEAD"]);
    let remote_head = ssh.run(&command).await?.trim().to_string();
    if remote_head == git::rev_parse(worktree, "HEAD").await? {
        return Ok(None);
    }
    let head_ref = format!("refs/hunt/{id}/head");
    retrieve::fetch_into(worktree, ssh, &remote_worktree, "HEAD", &head_ref).await?;
    let commit = git::rev_parse(worktree, &head_ref).await?;
    follow(worktree, &target.branch, &target.handoff_head, &commit).await?;
    Ok(Some(commit))
}

/// Points the branch the VM's worktree of the remote session `id` has checked out at the commit the local worktree
/// `worktree` has checked out, after a rebase here: the commit goes to the VM as `refs/hunt/<id>/rebased`, and the
/// worktree there is reset to it as the agent's user, with its uncommitted tracked changes stashed meanwhile under the
/// local Git identity, which the stash needs. A stash that does not apply again stays on the VM's stash list and fails
/// the move. Returns the commit; the caller records it as the one the local branch follows.
pub async fn move_vm_head(ssh: &Ssh, id: Uuid, target: &RemoteTarget, worktree: &Path) -> Result<String, String> {
    let fail = |error: String| format!("failed to move the branch on the VM to the rebased commit: {error}");
    let (name, email) = git::identity(worktree).await.map_err(fail)?;
    let head = git::rev_parse(worktree, "HEAD").await?;
    let remote_worktree = target.worktree_path.display().to_string();
    let rebased_ref = format!("refs/hunt/{id}/rebased");
    retrieve::push_into(worktree, ssh, &remote_worktree, "HEAD", &rebased_ref).await?;
    let (name, email) = (format!("user.name={name}"), format!("user.email={email}"));
    let git = |args: &[&str]| {
        let mut all = vec!["-n", "-u", "agent", "git", "-C", remote_worktree.as_str(), "-c", name.as_str(), "-c", email.as_str()];
        all.extend_from_slice(args);
        shell_command("sudo", &all)
    };
    let is_dirty = !ssh.run(&git(&["status", "--porcelain", "--untracked-files=no"])).await.map_err(fail)?.trim().is_empty();
    if is_dirty {
        ssh.run(&git(&["stash", "push", "-q"])).await.map_err(fail)?;
    }
    ssh.run(&git(&["reset", "-q", "--hard", &rebased_ref])).await.map_err(fail)?;
    let _ = ssh.run(&git(&["update-ref", "-d", &rebased_ref])).await;
    if is_dirty {
        ssh.run(&git(&["stash", "pop", "-q"]))
            .await
            .map_err(|error| format!("the branch on the VM moved to the rebased commit, but its uncommitted changes did not apply again and stay on its stash list: {error}"))?;
    }
    Ok(head)
}

/// Pushes the branch the VM's worktree of the remote session `id` has checked out to its origin with the GitHub token
/// its VM stores, the poller's for a poller session, and makes that the branch's upstream.
pub async fn push_stored(ssh: &Ssh, id: Uuid) -> Result<(), String> {
    hunt_ctl(ssh, &["push", &id.to_string(), "--stored"]).await?;
    Ok(())
}

/// What `hunt-ctl commit` reads on stdin: the author's name and email, the message and the paths, each ending with NUL.
fn commit_input(name: &str, email: &str, message: &str, paths: &[String]) -> Result<Vec<u8>, String> {
    git::ensure_paths(paths)?;
    if message.trim().is_empty() {
        return Err("commit message must not be empty".into());
    }
    let fields = [name, email, message].into_iter().chain(paths.iter().map(String::as_str));
    let mut input = Vec::new();
    for field in fields {
        if field.contains('\0') {
            return Err(format!("failed to commit on the VM: {field:?} contains a NUL character"));
        }
        input.extend_from_slice(field.as_bytes());
        input.push(0);
    }
    Ok(input)
}

/// Points the local branch `branch`, which the worktree has checked out, at `commit`, fetched from the VM, and the index
/// at its tree; the files stay, since the sync gave the worktree the VM's files already. Refuses when the branch points
/// at a commit the VM does not have (`retrieve::vm_has`): a commit made here.
async fn follow(worktree: &Path, branch: &str, handoff_head: &str, commit: &str) -> Result<(), String> {
    let local_head = git::rev_parse(worktree, "HEAD").await?;
    if local_head == commit {
        return Ok(());
    }
    if !retrieve::vm_has(worktree, &local_head, handoff_head, commit).await {
        let short = |commit: &str| commit.chars().take(10).collect::<String>();
        return Err(format!(
            "the branch {branch} here moved to {}, which the VM does not have, so it does not follow the VM's commit {}. Keep that commit on another branch (`git branch <name>`) and reset {branch} with `git reset --keep {handoff_head}`; then it follows the VM again.",
            short(&local_head),
            short(commit)
        ));
    }
    retrieve::point_branch(worktree, commit, &local_head).await?;
    git::run_git(worktree, &["reset", "-q"]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(dir: &Path, args: &[&str]) -> String {
        git::run_git(dir, args).await.unwrap().trim().to_string()
    }

    async fn status(dir: &Path) -> String {
        git::run_git(dir, &["status", "--porcelain", "--untracked-files=all"]).await.unwrap().trim_end().to_string()
    }

    #[test]
    fn the_commit_input_ends_every_field_with_nul_and_rejects_what_hunt_ctl_could_not_read() {
        let paths = vec!["src/a.ts".to_string(), "b c.md".to_string()];
        let input = commit_input("Jane Doe", "jane@example.com", "feat: add a\n\nbody", &paths).unwrap();
        assert_eq!(input, b"Jane Doe\0jane@example.com\0feat: add a\n\nbody\0src/a.ts\0b c.md\0");
        assert_eq!(commit_input("Jane", "jane@example.com", " \n", &paths).unwrap_err(), "commit message must not be empty");
        assert!(commit_input("Jane", "jane@example.com", "fix: x", &[]).is_err());
        assert!(commit_input("Jane", "jane@example.com", "fix: x", &["../outside".to_string()]).is_err());
        assert!(commit_input("Jane", "jane@example.com", "fix:\0x", &paths).unwrap_err().contains("NUL"));
    }

    /// A local worktree whose files the sync keeps equal to the VM's follows the VM's commit: from the handoff commit,
    /// and from a commit of the VM that Hunt followed before; the committed files leave its changes, the rest stay.
    #[tokio::test]
    async fn the_local_branch_follows_the_vms_commit_and_keeps_the_files() {
        let vm_dir = tempfile::tempdir().unwrap();
        let vm = vm_dir.path();
        git(vm, &["init", "-q", "-b", "main"]).await;
        git(vm, &["config", "user.email", "agent@example.com"]).await;
        git(vm, &["config", "user.name", "Agent"]).await;
        std::fs::write(vm.join("a.txt"), "one\n").unwrap();
        std::fs::write(vm.join("b.txt"), "one\n").unwrap();
        git(vm, &["add", "."]).await;
        git(vm, &["commit", "-q", "-m", "init"]).await;
        let handoff_head = git(vm, &["rev-parse", "HEAD"]).await;

        let local_dir = tempfile::tempdir().unwrap();
        let local = local_dir.path().join("local");
        git(local_dir.path(), &["clone", "-q", vm.to_str().unwrap(), local.to_str().unwrap()]).await;
        for dir in [vm, local.as_path()] {
            std::fs::write(dir.join("a.txt"), "two\n").unwrap();
            std::fs::write(dir.join("b.txt"), "two\n").unwrap();
        }

        git(vm, &["commit", "-q", "-m", "feat: a", "--", "a.txt"]).await;
        let first = git(vm, &["rev-parse", "HEAD"]).await;
        git(&local, &["fetch", "-q", vm.to_str().unwrap(), "main"]).await;
        follow(&local, "main", &handoff_head, &first).await.unwrap();
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).await, first);
        assert_eq!(status(&local).await, " M b.txt");
        assert_eq!(std::fs::read_to_string(local.join("a.txt")).unwrap(), "two\n");

        git(vm, &["commit", "-q", "-m", "feat: b", "--", "b.txt"]).await;
        let second = git(vm, &["rev-parse", "HEAD"]).await;
        git(&local, &["fetch", "-q", vm.to_str().unwrap(), "main"]).await;
        follow(&local, "main", &handoff_head, &second).await.unwrap();
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).await, second);
        assert_eq!(status(&local).await, "");
        follow(&local, "main", &handoff_head, &second).await.unwrap();
    }

    #[tokio::test]
    async fn the_local_branch_stays_on_a_commit_the_vm_does_not_have() {
        let vm_dir = tempfile::tempdir().unwrap();
        let vm = vm_dir.path();
        git(vm, &["init", "-q", "-b", "main"]).await;
        git(vm, &["config", "user.email", "agent@example.com"]).await;
        git(vm, &["config", "user.name", "Agent"]).await;
        std::fs::write(vm.join("a.txt"), "one\n").unwrap();
        git(vm, &["add", "."]).await;
        git(vm, &["commit", "-q", "-m", "init"]).await;
        let handoff_head = git(vm, &["rev-parse", "HEAD"]).await;

        let local_dir = tempfile::tempdir().unwrap();
        let local = local_dir.path().join("local");
        git(local_dir.path(), &["clone", "-q", vm.to_str().unwrap(), local.to_str().unwrap()]).await;
        git(&local, &["config", "user.email", "test@example.com"]).await;
        git(&local, &["config", "user.name", "Test"]).await;
        git(&local, &["commit", "-q", "--allow-empty", "-m", "local only"]).await;
        let local_head = git(&local, &["rev-parse", "HEAD"]).await;
        git(vm, &["commit", "-q", "--allow-empty", "-m", "feat: on the vm"]).await;
        let commit = git(vm, &["rev-parse", "HEAD"]).await;
        git(&local, &["fetch", "-q", vm.to_str().unwrap(), "main"]).await;

        let refused = follow(&local, "main", &handoff_head, &commit).await.unwrap_err();
        assert!(refused.contains("the branch main here moved to") && refused.contains("git reset --keep"), "{refused}");
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).await, local_head);
    }
}
