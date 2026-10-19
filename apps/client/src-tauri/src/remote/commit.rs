//! The branch of a remote session at the same commit on both sides, and the push of a poller session's branch. The
//! session's branch is checked out in the local worktree and on its VM; the sync keeps the files equal, `align_heads`
//! the commits: when the agent committed on the VM, the local branch follows; when a commit was made here (Hunt's
//! changelist, or any tool in the local worktree), the VM's branch follows, which the equal files allow without touching
//! them. So the changelist shows what is uncommitted on both sides, as in a local session, and a push from this Mac
//! pushes the commits, rebased here when the target branch moved on, after which the VM's branch follows the rebased
//! commit (`move_vm_head`). Only a poller session's branch is pushed from the VM (`hunt-ctl push --stored`), with the
//! poller's stored token. Knows nothing about Tauri.

use std::path::Path;

use uuid::Uuid;

use super::retrieve;
use super::ssh::Ssh;
use super::{hunt_ctl, shell_command, RemoteTarget};
use crate::git;

/// Which side's branch moved since both pointed at the same commit, and who follows whom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Both sides point at the same commit.
    Same,
    /// The VM's branch moved on, or back, to a commit the VM has; the local branch follows it.
    LocalFollows,
    /// The local branch moved on from the VM's commit; the VM's branch follows it.
    VmFollows,
    /// Both moved; neither side can follow without losing a commit.
    Diverged,
}

/// Points the branch of the remote session `id`, checked out in its local worktree `worktree` and on the VM behind
/// `ssh`, at the same commit on both sides when one of them moved: the local branch follows the VM's commit (fetched
/// as `refs/hunt/<id>/head`), or the VM's branch follows the commit made here (sent as `refs/hunt/<id>/local`). Index
/// and files of the following side stay, the sync gave it the other side's files already. Returns the common commit;
/// `None` when both pointed at it already. Fails without moving anything when both sides moved.
pub async fn align_heads(ssh: &Ssh, id: Uuid, target: &RemoteTarget, worktree: &Path) -> Result<Option<String>, String> {
    let remote_worktree = target.worktree_path.display().to_string();
    let command = shell_command("sudo", &["-n", "-u", "agent", "git", "-C", &remote_worktree, "rev-parse", "--verify", "-q", "HEAD"]);
    let remote_head = ssh.run(&command).await?.trim().to_string();
    let local_head = git::rev_parse(worktree, "HEAD").await?;
    if local_head == remote_head {
        return Ok(None);
    }
    // A commit made here has the VM's commit among its ancestors already; any other VM commit is fetched first.
    if !git::is_ancestor(worktree, &remote_head, &local_head).await {
        retrieve::fetch_into(worktree, ssh, &remote_worktree, "HEAD", &format!("refs/hunt/{id}/head")).await?;
    }
    match direction(worktree, &local_head, &target.handoff_head, &remote_head).await {
        Direction::Same => Ok(None),
        Direction::LocalFollows => {
            follow_vm(worktree, &remote_head, &local_head).await?;
            Ok(Some(remote_head))
        }
        Direction::VmFollows => {
            follow_local(ssh, id, &remote_worktree, worktree).await?;
            Ok(Some(local_head))
        }
        Direction::Diverged => Err(diverged_error(&target.branch, &target.handoff_head, &local_head, &remote_head)),
    }
}

/// Who follows whom when the local branch points at `local_head` and the VM's at `remote_head`, both known to the
/// local repository: the local branch follows whenever the VM has its commit (`retrieve::vm_has`), also back to an
/// older one; else the VM follows when its commit is an ancestor of the local one, i.e. the commits were made here.
pub async fn direction(worktree: &Path, local_head: &str, handoff_head: &str, remote_head: &str) -> Direction {
    if local_head == remote_head {
        return Direction::Same;
    }
    if retrieve::vm_has(worktree, local_head, handoff_head, remote_head).await {
        return Direction::LocalFollows;
    }
    if git::is_ancestor(worktree, remote_head, local_head).await {
        return Direction::VmFollows;
    }
    Direction::Diverged
}

/// Points the local branch, which the worktree has checked out at `local_head`, at the VM's `commit`, and the index at
/// its tree; the files stay.
async fn follow_vm(worktree: &Path, commit: &str, local_head: &str) -> Result<(), String> {
    retrieve::point_branch(worktree, commit, local_head).await?;
    git::run_git(worktree, &["reset", "-q"]).await?;
    Ok(())
}

/// Points the branch the VM's worktree of the remote session `id` has checked out at the commit the local worktree
/// `worktree` has checked out: the commit goes to the VM as `refs/hunt/<id>/local`, and branch and index there move to
/// it as the agent's user, the files stay.
async fn follow_local(ssh: &Ssh, id: Uuid, remote_worktree: &str, worktree: &Path) -> Result<(), String> {
    let fail = |error: String| format!("failed to move the branch on the VM to the commit made here: {error}");
    let (name, email) = git::identity(worktree).await.map_err(fail)?;
    let local_ref = format!("refs/hunt/{id}/local");
    retrieve::push_into(worktree, ssh, remote_worktree, "HEAD", &local_ref).await?;
    ssh.run(&agent_git(remote_worktree, &name, &email, &["reset", "-q", &local_ref])).await.map_err(fail)?;
    let _ = ssh.run(&agent_git(remote_worktree, &name, &email, &["update-ref", "-d", &local_ref])).await;
    Ok(())
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
    let git = |args: &[&str]| agent_git(&remote_worktree, &name, &email, args);
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

/// The branch on `origin` the branch `branch` of the VM's worktree of `target` tracks; `None` when it tracks none, or
/// one on another remote.
pub async fn vm_origin_upstream(ssh: &Ssh, target: &RemoteTarget, branch: &str) -> Option<String> {
    let worktree = target.worktree_path.display().to_string();
    let config = |key: &str| shell_command("sudo", &["-n", "-u", "agent", "git", "-C", &worktree, "config", "--get", key]);
    let remote = ssh.run(&config(&format!("branch.{branch}.remote"))).await.ok()?;
    if remote.trim() != "origin" {
        return None;
    }
    let merge = ssh.run(&config(&format!("branch.{branch}.merge"))).await.ok()?;
    merge.trim().strip_prefix("refs/heads/").map(str::to_string)
}

/// Makes the branch `push_target` on `origin` the upstream of `branch` in the VM's worktree of `target`, as `hunt-ctl
/// prepare` does at the handoff, so that a Hunt taking the session over reads where its push lands.
pub async fn set_vm_origin_upstream(ssh: &Ssh, target: &RemoteTarget, branch: &str, push_target: &str) -> Result<(), String> {
    let worktree = target.worktree_path.display().to_string();
    let config = |key: &str, value: &str| shell_command("sudo", &["-n", "-u", "agent", "git", "-C", &worktree, "config", key, value]);
    let fail = |error: String| format!("failed to record the push target on the VM: {error}");
    ssh.run(&config(&format!("branch.{branch}.remote"), "origin")).await.map_err(fail)?;
    ssh.run(&config(&format!("branch.{branch}.merge"), &format!("refs/heads/{push_target}"))).await.map_err(fail)?;
    Ok(())
}

/// Pushes the branch the VM's worktree of the remote session `id` has checked out to its origin with the GitHub token
/// its VM stores, the poller's for a poller session, and makes that the branch's upstream.
pub async fn push_stored(ssh: &Ssh, id: Uuid) -> Result<(), String> {
    hunt_ctl(ssh, &["push", &id.to_string(), "--stored"]).await?;
    Ok(())
}

/// The shell command that runs `git <args>` in the VM's worktree `remote_worktree` as the agent's user under the Git
/// identity `name` and `email`, which the reflog and a stash need.
fn agent_git(remote_worktree: &str, name: &str, email: &str, args: &[&str]) -> String {
    let (name, email) = (format!("user.name={name}"), format!("user.email={email}"));
    let mut all = vec!["-n", "-u", "agent", "git", "-C", remote_worktree, "-c", name.as_str(), "-c", email.as_str()];
    all.extend_from_slice(args);
    shell_command("sudo", &all)
}

/// What `align_heads` reports when both sides moved: where each branch went, and how to get the local commits out of the
/// way so that the local branch follows the VM again.
fn diverged_error(branch: &str, handoff_head: &str, local_head: &str, remote_head: &str) -> String {
    let short = |commit: &str| commit.chars().take(10).collect::<String>();
    format!(
        "the branch {branch} moved here to {} and on the VM to {}, so neither side follows the other. Keep the commits made here on another branch (`git branch <name>`) and reset {branch} with `git reset --keep {handoff_head}`; then it follows the VM again.",
        short(local_head),
        short(remote_head)
    )
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

    /// A "VM" repository with one commit on `main` and a local clone of it; returns both paths and the commit.
    async fn repos(vm_dir: &Path, local_dir: &Path) -> (std::path::PathBuf, String) {
        git(vm_dir, &["init", "-q", "-b", "main"]).await;
        git(vm_dir, &["config", "user.email", "agent@example.com"]).await;
        git(vm_dir, &["config", "user.name", "Agent"]).await;
        std::fs::write(vm_dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(vm_dir.join("b.txt"), "one\n").unwrap();
        git(vm_dir, &["add", "."]).await;
        git(vm_dir, &["commit", "-q", "-m", "init"]).await;
        let handoff_head = git(vm_dir, &["rev-parse", "HEAD"]).await;
        let local = local_dir.join("local");
        git(local_dir, &["clone", "-q", vm_dir.to_str().unwrap(), local.to_str().unwrap()]).await;
        git(&local, &["config", "user.email", "test@example.com"]).await;
        git(&local, &["config", "user.name", "Test"]).await;
        (local, handoff_head)
    }

    /// A local worktree whose files the sync keeps equal to the VM's follows the VM's commit: from the handoff commit,
    /// and from a commit of the VM that Hunt followed before; the committed files leave its changes, the rest stay.
    #[tokio::test]
    async fn the_local_branch_follows_the_vms_commit_and_keeps_the_files() {
        let (vm_dir, local_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let vm = vm_dir.path();
        let (local, handoff_head) = repos(vm, local_dir.path()).await;
        for dir in [vm, local.as_path()] {
            std::fs::write(dir.join("a.txt"), "two\n").unwrap();
            std::fs::write(dir.join("b.txt"), "two\n").unwrap();
        }

        git(vm, &["commit", "-q", "-m", "feat: a", "--", "a.txt"]).await;
        let first = git(vm, &["rev-parse", "HEAD"]).await;
        git(&local, &["fetch", "-q", vm.to_str().unwrap(), "main"]).await;
        assert_eq!(direction(&local, &handoff_head, &handoff_head, &first).await, Direction::LocalFollows);
        follow_vm(&local, &first, &handoff_head).await.unwrap();
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).await, first);
        assert_eq!(status(&local).await, " M b.txt");
        assert_eq!(std::fs::read_to_string(local.join("a.txt")).unwrap(), "two\n");

        git(vm, &["commit", "-q", "-m", "feat: b", "--", "b.txt"]).await;
        let second = git(vm, &["rev-parse", "HEAD"]).await;
        git(&local, &["fetch", "-q", vm.to_str().unwrap(), "main"]).await;
        assert_eq!(direction(&local, &first, &handoff_head, &second).await, Direction::LocalFollows);
        follow_vm(&local, &second, &first).await.unwrap();
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).await, second);
        assert_eq!(status(&local).await, "");
        assert_eq!(direction(&local, &second, &handoff_head, &second).await, Direction::Same);
    }

    /// A commit made here on top of the VM's commit is the VM's to follow; one made on both sides is reported, and the
    /// local branch stays where it is.
    #[tokio::test]
    async fn a_commit_made_here_moves_the_vm_and_commits_on_both_sides_are_reported() {
        let (vm_dir, local_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let vm = vm_dir.path();
        let (local, handoff_head) = repos(vm, local_dir.path()).await;
        git(&local, &["commit", "-q", "--allow-empty", "-m", "made here"]).await;
        let local_head = git(&local, &["rev-parse", "HEAD"]).await;
        assert_eq!(direction(&local, &local_head, &handoff_head, &handoff_head).await, Direction::VmFollows);

        git(vm, &["commit", "-q", "--allow-empty", "-m", "feat: on the vm"]).await;
        let remote_head = git(vm, &["rev-parse", "HEAD"]).await;
        git(&local, &["fetch", "-q", vm.to_str().unwrap(), "main"]).await;
        assert_eq!(direction(&local, &local_head, &handoff_head, &remote_head).await, Direction::Diverged);
        let reported = diverged_error("main", &handoff_head, &local_head, &remote_head);
        assert!(reported.contains("the branch main moved here to") && reported.contains("git reset --keep"), "{reported}");
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).await, local_head);
    }

    #[test]
    fn the_agents_git_runs_in_the_vms_worktree_under_the_local_identity() {
        let command = agent_git("/srv/hunt/work tree", "Jane Doe", "jane@example.com", &["reset", "-q", "refs/hunt/x/local"]);
        assert_eq!(
            command,
            "sudo -n -u agent git -C '/srv/hunt/work tree' -c 'user.name=Jane Doe' -c user.email=jane@example.com reset -q refs/hunt/x/local"
        );
    }
}
