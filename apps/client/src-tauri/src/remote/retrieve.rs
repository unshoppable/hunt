//! Bringing a session back from its VM: its relay stops, a last sync (`sync.rs`) sends the local edits and brings the
//! agent's files, and the agent's commits come back with a snapshot on top of the VM's `HEAD`, which must hold exactly
//! the files of the local worktree; the branch moves to the agent's last commit, the Git LFS objects follow and the
//! transcript returns with its paths moved back. A retrieval that failed midway can be repeated. A session this Mac
//! adopted gets a local worktree in the local checkout of its repository, on the branch the VM has checked out: while
//! it runs there (`check_out_adopted`), or when it comes back without one.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use uuid::Uuid;

use super::handoff::{lfs_object_ids, lfs_object_path, lfs_objects_dir, REMOTE_CLAUDE_DIR, REMOTE_MODE};
use super::ssh::Ssh;
use super::sync::{self, SyncTarget};
use super::{adoption, memory, transcript};
use super::{hunt_ctl, shell_command, start_session_vm, tar_extract, vm, Progress, RemoteStep, RemoteTarget, VmRef};
use crate::git::{self, TreeChange};

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
    /// The sync state of the local worktree and the snapshot the sync started from; see `sync.rs`.
    pub sync_manifest: &'a Path,
    pub sync_base_ref: &'a str,
    /// For a session this Mac adopted that has no local worktree yet: the local repository in which the retrieval
    /// creates the worktree `worktree`.
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
    let retrieve_ref = format!("refs/hunt/{id}/retrieve");

    let ssh = connect(&request, progress).await?;
    let remote_worktree = remote_worktree(&request, &ssh).await?;
    progress.step(RemoteStep::StoppingAgent);
    hunt_ctl(&ssh, &["stop", &id]).await?;

    progress.step(RemoteStep::RetrievingCode);
    let manifest = request.sync_manifest;
    let sync_target = SyncTarget { local: worktree, remote: &remote_worktree, manifest, base_ref: request.sync_base_ref };
    sync::sync(&sync_target, &ssh).await?;
    let local_tree = git::worktree_tree(worktree).await?;
    hunt_ctl(&ssh, &["snapshot", &id]).await?;
    fetch(worktree, &ssh, &remote_worktree, &retrieve_ref).await?;
    download_lfs_objects(worktree, &ssh, &id, &retrieve_ref).await?;
    ensure_same_files(worktree, &ssh, &remote_worktree, &local_tree, &retrieve_ref).await?;
    let remote_head = git::rev_parse(worktree, &format!("{retrieve_ref}^")).await?;
    ensure_branch_unmoved(worktree, &target.branch, &target.handoff_head, &remote_head).await?;
    if git::worktree_tree(worktree).await? != local_tree {
        return Err("failed to retrieve the session: files changed here during the retrieval; nothing was moved, bring it back again".into());
    }
    move_branch(worktree, &id, &target.branch, &target.handoff_head, &retrieve_ref).await?;
    finish_worktree(worktree, &retrieve_ref).await?;
    sync::clear_staging(worktree);

    let acp_session_id = retrieve_transcript(&request, &ssh, &remote_worktree).await?;
    Ok(Retrieved { acp_session_id, branch: None })
}

/// Refuses a retrieval after which the local worktree would not hold the files of the VM's snapshot `retrieve_ref`:
/// `local_tree` (the local worktree after the last sync, with this Mac's ignore rules) is compared with it. The files
/// only the VM has that this Mac ignores (its global excludes, files the agent added with `-f`) are brought here once
/// nothing else blocks, and only where this Mac has no file of that name or the same one; the files only this Mac has
/// that the VM ignores stay. Anything else that differs is named with the ignore rules that apply, and nothing moved
/// then.
async fn ensure_same_files(worktree: &Path, ssh: &Ssh, remote_worktree: &str, local_tree: &str, retrieve_ref: &str) -> Result<(), String> {
    let ignore_case = git::ignores_case(worktree).await;
    let retrieve_tree = git::rev_parse(worktree, &format!("{retrieve_ref}^{{tree}}")).await?;
    let changes = git::tree_changes(worktree, local_tree, &retrieve_tree, ignore_case).await?;
    if changes.is_empty() {
        return Ok(());
    }
    let paths: Vec<String> = changes.iter().map(|(path, _)| path.clone()).collect();
    let rules_here = git::ignore_rules(worktree, &paths).await?;
    let rules_there = remote_ignore_rules(ssh, remote_worktree, &paths).await?;
    let is_ignored_here = |(path, change): &&(String, TreeChange)| *change == TreeChange::Added && rules_here.contains_key(path);
    let ignored_here: Vec<&String> = changes.iter().filter(is_ignored_here).map(|(path, _)| path).collect();
    let links = link_paths(worktree, &retrieve_tree).await?;
    let (links, files): (Vec<String>, Vec<String>) = ignored_here.into_iter().cloned().partition(|path| links.contains(path));
    let fetched = sync::stage_fetch(ssh, worktree, remote_worktree, &files, &links).await;
    let mut problems = fetched.problems.clone();
    problems.extend(fetched.differing.iter().map(|path| format!("{path}: this Mac has its own version, which stays")));
    let brought: Vec<String> = fetched.new.iter().chain(&fetched.same).cloned().collect();
    let blocking = blocking_changes(&changes, &brought, &rules_there);
    if !blocking.is_empty() {
        sync::clear_staging(worktree);
        return Err(blocking_message(&blocking, &rules_here, &rules_there, &problems, &[]));
    }
    let (placed, problems) = sync::place_fetched(worktree, &fetched, ignore_case);
    let brought: Vec<String> = placed.iter().chain(&fetched.same).cloned().collect();
    let blocking = blocking_changes(&changes, &brought, &rules_there);
    if blocking.is_empty() {
        return Ok(());
    }
    Err(blocking_message(&blocking, &rules_here, &rules_there, &problems, &placed))
}

/// The changes between the local worktree and the VM's snapshot that block a retrieval: all but the files only the VM
/// has that were `placed` here and the files only this Mac has that the VM ignores (`rules_there`), which stay here.
pub(crate) fn blocking_changes<'a>(
    changes: &'a [(String, TreeChange)],
    placed: &[String],
    rules_there: &BTreeMap<String, String>,
) -> Vec<&'a (String, TreeChange)> {
    changes
        .iter()
        .filter(|(path, change)| match change {
            TreeChange::Added => !placed.contains(path),
            TreeChange::Deleted => !rules_there.contains_key(path),
            TreeChange::Modified => true,
        })
        .collect()
}

/// What a refused retrieval tells: each differing file, on which side it is, the ignore rules that keep it from syncing,
/// the files that could not be brought here, and the ignored files it did bring (`moved`), the only change it made.
pub(crate) fn blocking_message(
    blocking: &[&(String, TreeChange)],
    rules_here: &BTreeMap<String, String>,
    rules_there: &BTreeMap<String, String>,
    problems: &[String],
    moved: &[String],
) -> String {
    let describe = |(path, change): &(String, TreeChange)| {
        let side = match change {
            TreeChange::Added => "only on the VM",
            TreeChange::Deleted => "only here",
            TreeChange::Modified => "different on the VM",
        };
        let mut text = format!("{path} ({side}");
        if let Some(rule) = rules_here.get(path) {
            text.push_str(&format!("; ignored here by {rule}"));
        }
        if let Some(rule) = rules_there.get(path) {
            text.push_str(&format!("; ignored on the VM by {rule}"));
        }
        text.push(')');
        text
    };
    let shown: Vec<String> = blocking.iter().take(10).map(|change| describe(change)).collect();
    let more = blocking.len().saturating_sub(shown.len());
    let more = if more > 0 { format!(" and {more} more") } else { String::new() };
    let problems = if problems.is_empty() { String::new() } else { format!(" Could not be brought here: {}.", problems.join("; ")) };
    let moved = match moved {
        [] => "Nothing was moved.".to_string(),
        moved => format!("Only these files this Mac ignores were brought here: {}; nothing else was moved.", moved.join(", ")),
    };
    format!(
        "failed to retrieve the session: after the last sync these files still differ between here and the VM: {}{more}.{problems} A file that only one side ignores does not sync: change that ignore rule, or remove or commit the file on the side that has it, then bring the session back again. {moved}",
        shown.join(", ")
    )
}

/// The rule that makes git on the VM ignore each of `paths` in the session's worktree there; see `git::ignore_rules`.
async fn remote_ignore_rules(ssh: &Ssh, remote_worktree: &str, paths: &[String]) -> Result<BTreeMap<String, String>, String> {
    if paths.is_empty() {
        return Ok(BTreeMap::new());
    }
    let input: Vec<u8> = paths.iter().flat_map(|path| path.bytes().chain([0])).collect();
    let output = ssh
        .run_with_input(&sync::remote_ignore_rules_command(remote_worktree), &input)
        .await
        .map_err(|error| format!("failed to read the ignore rules on the VM: {error}"))?;
    Ok(git::parse_ignore_rules(&String::from_utf8_lossy(&output)))
}

/// The paths of the links in `tree`.
async fn link_paths(worktree: &Path, tree: &str) -> Result<BTreeSet<String>, String> {
    let output = git::run_git(worktree, &["ls-tree", "-r", "-z", tree]).await?;
    Ok(output
        .split('\0')
        .filter_map(|entry| entry.split_once('\t'))
        .filter(|(meta, _)| meta.starts_with("120000 "))
        .map(|(_, path)| path.to_string())
        .collect())
}

/// Refuses to move the session's branch when it moved here since the session went to the VM (`handoff_head`) to
/// another commit than the VM's `remote_head`: the VM does not have those local commits.
pub(crate) async fn ensure_branch_unmoved(worktree: &Path, branch: &str, handoff_head: &str, remote_head: &str) -> Result<(), String> {
    let local_head = git::rev_parse(worktree, "HEAD").await?;
    if local_head == handoff_head || local_head == remote_head {
        return Ok(());
    }
    Err(branch_moved_error(branch, handoff_head, &local_head))
}

/// What a retrieval tells when the branch moved here: what happened and how to get the local commits out of the way.
fn branch_moved_error(branch: &str, handoff_head: &str, local_head: &str) -> String {
    let short = |commit: &str| commit.chars().take(10).collect::<String>();
    format!(
        "failed to retrieve the session: the branch {branch} moved here from {} to {} since the session went to the VM, which does not have those commits. Keep them on another branch (`git branch <name>`), reset {branch} with `git reset --keep {handoff_head}`, then bring the session back again. Nothing was moved.",
        short(handoff_head),
        short(local_head)
    )
}

/// The local worktree `check_out_adopted` created: the branch it has checked out, the commit it started from and the
/// commit its changes compare against (the merge base with the origin's default branch), when one is found.
pub struct CheckedOut {
    pub branch: String,
    pub head: String,
    pub diff_base: Option<String>,
}

/// The ref of the snapshot an adopted session's local worktree was created from, which its first sync starts from.
pub fn adopted_ref(id: Uuid) -> String {
    format!("refs/hunt/{id}/adopted")
}

/// Creates the local worktree `worktree` of the adopted session `id` in the local repository `repo` while the session
/// runs on its VM behind `ssh`: on the branch the VM's worktree `remote_worktree` has checked out (else `target_branch`
/// or the session's own branch name, with a number added when the repository has that branch already), with the VM's
/// commits and uncommitted work as a snapshot shows them, which `adopted_ref` keeps. The agent keeps running; the sync
/// brings what it changes afterwards.
pub async fn check_out_adopted(
    ssh: &Ssh,
    id: Uuid,
    remote_worktree: &str,
    target_branch: &str,
    repo: &Path,
    worktree: &Path,
) -> Result<CheckedOut, String> {
    if worktree.exists() {
        return Err(format!("failed to create the local worktree of the session: {} exists already", worktree.display()));
    }
    let id_text = id.to_string();
    let retrieve_ref = format!("refs/hunt/{id_text}/retrieve");
    let checked_out = remote_branch(ssh, remote_worktree).await;
    let fallback = git::session_branch(&vm::short_id(id));
    let branch = unused_branch_name(repo, &[checked_out.as_deref(), Some(target_branch), Some(fallback.as_str())]).await?;
    hunt_ctl(ssh, &["snapshot", &id_text]).await?;
    fetch(repo, ssh, remote_worktree, &retrieve_ref).await?;
    download_lfs_objects(repo, ssh, &id_text, &retrieve_ref).await?;
    create_worktree_from_snapshot(repo, worktree, &branch, &retrieve_ref).await?;
    let snapshot = git::rev_parse(repo, &retrieve_ref).await?;
    git::run_git(repo, &["update-ref", &adopted_ref(id), &snapshot]).await?;
    let head = git::rev_parse(worktree, "HEAD").await?;
    Ok(CheckedOut { branch, head, diff_base: default_branch_base(worktree).await })
}

/// The merge base of `worktree`'s `HEAD` with the origin's default branch, which the changes of an adopted session
/// compare against so that they include the agent's commits; `None` without such a branch.
async fn default_branch_base(worktree: &Path) -> Option<String> {
    for candidate in ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"] {
        if let Ok(base) = git::merge_base(worktree, candidate, "HEAD").await {
            return Some(base);
        }
    }
    None
}

/// The first of `candidates` that is a valid branch name `repo` does not have yet; else the first valid one with the
/// lowest number from 2 on appended that is free.
async fn unused_branch_name(repo: &Path, candidates: &[Option<&str>]) -> Result<String, String> {
    let mut valid = Vec::new();
    for candidate in candidates.iter().flatten().map(|candidate| candidate.trim()) {
        let is_invalid = candidate.is_empty() || candidate.starts_with('-');
        if is_invalid || git::run_git(repo, &["check-ref-format", "--branch", candidate]).await.is_err() {
            continue;
        }
        if !git::local_branch_exists(repo, candidate).await {
            return Ok(candidate.to_string());
        }
        valid.push(candidate.to_string());
    }
    let first = valid.first().ok_or("failed to pick the local branch of the session: it has no valid branch name")?;
    for number in 2..100 {
        let numbered = format!("{first}-{number}");
        if !git::local_branch_exists(repo, &numbered).await {
            return Ok(numbered);
        }
    }
    Err(format!("failed to pick the local branch of the session: {first} and its numbered variants exist already"))
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
    progress.step(RemoteStep::StoppingAgent);
    hunt_ctl(&ssh, &["stop", &id]).await?;

    progress.step(RemoteStep::RetrievingCode);
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
    progress.step(RemoteStep::Connecting);
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
        if git::local_branch_exists(repo, candidate).await {
            let repo = repo.display();
            return Err(format!(
                "failed to pick the local branch of the session: the branch {candidate} exists in {repo} already; rename or delete it first"
            ));
        }
        return Ok(candidate.to_string());
    }
    Err("failed to pick the local branch of the session: it has no valid branch name".into())
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

/// Changes the working tree from the snapshot `from_ref`, which it holds, to the retrieval snapshot: the edits, new
/// files and deletions between them, including those of untracked files. The index ends up at the retrieval snapshot;
/// `finish_worktree` rebuilds it.
pub(crate) async fn apply_tree_change(worktree: &Path, from_ref: &str, retrieve_ref: &str) -> Result<(), String> {
    let from_tree = format!("{from_ref}^{{tree}}");
    git::run_git(worktree, &["read-tree", &from_tree]).await?;
    // Exits non-zero when entries need an update, which is what the refresh is for.
    let _ = git::run_git(worktree, &["update-index", "-q", "--refresh"]).await;
    git::run_git(worktree, &["read-tree", "-u", "-m", &from_tree, &format!("{retrieve_ref}^{{tree}}")]).await?;
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
        return Err(branch_moved_error(branch, handoff_head, &local_head));
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

    /// A synced session: once the local worktree holds the VM's files, the retrieval moves the branch to the agent's
    /// commit; while one file still differs, or after a local commit, it refuses and nothing moves.
    #[tokio::test]
    async fn retrieval_of_a_synced_worktree_moves_the_branch_only_when_both_sides_agree() {
        let local_dir = tempfile::tempdir().unwrap();
        let local = local_dir.path();
        git(local, &["init", "-q", "-b", "main"]).await;
        git(local, &["config", "user.email", "test@example.com"]).await;
        git(local, &["config", "user.name", "Test"]).await;
        std::fs::write(local.join("tracked.txt"), "one\n").unwrap();
        std::fs::write(local.join("gone.txt"), "temporary\n").unwrap();
        git(local, &["add", "."]).await;
        git(local, &["commit", "-q", "-m", "init"]).await;
        let handoff_head = git(local, &["rev-parse", "HEAD"]).await;

        let vm_dir = tempfile::tempdir().unwrap();
        let bare = vm_dir.path().join("repo.git");
        let remote = vm_dir.path().join("worktree");
        git(vm_dir.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]).await;
        git(&bare, &["config", "user.email", "agent@example.com"]).await;
        git(&bare, &["config", "user.name", "Agent"]).await;
        git(local, &["push", "-q", bare.to_str().unwrap(), "HEAD:refs/heads/main"]).await;
        git(&bare, &["worktree", "add", "-q", remote.to_str().unwrap(), "main"]).await;

        // The agent commits and leaves uncommitted work; the sync brought all of it but `late.txt`.
        std::fs::write(remote.join("tracked.txt"), "two\n").unwrap();
        git(&remote, &["commit", "-q", "-am", "agent work"]).await;
        std::fs::write(remote.join("tracked.txt"), "three\n").unwrap();
        std::fs::remove_file(remote.join("gone.txt")).unwrap();
        std::fs::write(remote.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(remote.join("late.txt"), "from the vm\n").unwrap();
        for (file, content) in [("tracked.txt", "three\n"), ("new.txt", "fresh\n"), ("late.txt", "stale\n")] {
            std::fs::write(local.join(file), content).unwrap();
        }
        std::fs::remove_file(local.join("gone.txt")).unwrap();
        let remote_head = git(&remote, &["rev-parse", "HEAD"]).await;
        let retrieve_snapshot = git::snapshot_commit(&remote, "Hunt retrieve snapshot").await.unwrap();
        git(&remote, &["update-ref", "refs/hunt/x/retrieve", &retrieve_snapshot]).await;
        git(local, &["fetch", "-q", bare.to_str().unwrap(), "+refs/hunt/x/retrieve:refs/hunt/x/retrieve"]).await;

        let retrieve_tree = git(local, &["rev-parse", "refs/hunt/x/retrieve^{tree}"]).await;
        let local_tree = git::worktree_tree(local).await.unwrap();
        let changes = git::tree_changes(local, &local_tree, &retrieve_tree, false).await.unwrap();
        let blocking = blocking_changes(&changes, &[], &BTreeMap::new());
        let refused = blocking_message(&blocking, &BTreeMap::new(), &BTreeMap::new(), &[], &[]);
        assert!(refused.contains("still differ between here and the VM: late.txt (different on the VM)."), "{refused}");
        assert!(refused.contains("Nothing was moved"));
        assert_eq!(git(local, &["rev-parse", "HEAD"]).await, handoff_head);

        std::fs::write(local.join("late.txt"), "from the vm\n").unwrap();
        let local_tree = git::worktree_tree(local).await.unwrap();
        assert!(git::tree_changes(local, &local_tree, &retrieve_tree, false).await.unwrap().is_empty());
        ensure_branch_unmoved(local, "main", &handoff_head, &remote_head).await.unwrap();
        move_branch(local, "x", "main", &handoff_head, "refs/hunt/x/retrieve").await.unwrap();
        finish_worktree(local, "refs/hunt/x/retrieve").await.unwrap();

        assert_eq!(git(local, &["rev-parse", "HEAD"]).await, remote_head);
        assert_eq!(read(local, "tracked.txt").as_deref(), Some("three\n"));
        assert_eq!(read(local, "gone.txt"), None);
        assert_eq!(status(local).await, status(&remote).await);
        // A repeated retrieval finds the branch moved already.
        ensure_branch_unmoved(local, "main", &handoff_head, &remote_head).await.unwrap();
    }

    #[test]
    fn files_only_one_side_ignores_do_not_block_when_handled_and_are_named_with_their_rule_when_they_do() {
        let changes = vec![
            (".vscode/settings.json".to_string(), TreeChange::Added),
            ("build.log".to_string(), TreeChange::Deleted),
            ("notes.md".to_string(), TreeChange::Added),
            ("app.env".to_string(), TreeChange::Deleted),
        ];
        let rules_here = BTreeMap::from([(".vscode/settings.json".to_string(), "/Users/jane/.config/git/ignore:1:.vscode/".to_string())]);
        let rules_there = BTreeMap::from([("build.log".to_string(), ".gitignore:2:*.log".to_string())]);
        let placed = vec![".vscode/settings.json".to_string()];
        let blocking = blocking_changes(&changes, &placed, &rules_there);
        assert_eq!(blocking.iter().map(|(path, _)| path.as_str()).collect::<Vec<_>>(), ["notes.md", "app.env"]);

        let blocking = blocking_changes(&changes, &[], &rules_there);
        let problems = [".vscode/settings.json: not placed here, since .vscode is a link".to_string()];
        let message = blocking_message(&blocking, &rules_here, &rules_there, &problems, &[]);
        assert!(message.contains(".vscode/settings.json (only on the VM; ignored here by /Users/jane/.config/git/ignore:1:.vscode/)"), "{message}");
        assert!(message.contains("app.env (only here)") && message.contains("Could not be brought here: .vscode/settings.json"));
        assert!(!message.contains("build.log") && message.ends_with("Nothing was moved."));
        let moved = blocking_message(&blocking, &rules_here, &rules_there, &[], &["debug/trace.txt".to_string()]);
        assert!(moved.ends_with("Only these files this Mac ignores were brought here: debug/trace.txt; nothing else was moved."), "{moved}");
    }

    #[tokio::test]
    async fn a_local_commit_since_the_handoff_stops_the_retrieval_with_what_to_do() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path();
        git(local, &["init", "-q", "-b", "main"]).await;
        git(local, &["config", "user.email", "test@example.com"]).await;
        git(local, &["config", "user.name", "Test"]).await;
        std::fs::write(local.join("a.txt"), "one\n").unwrap();
        git(local, &["add", "."]).await;
        git(local, &["commit", "-q", "-m", "init"]).await;
        let handoff_head = git(local, &["rev-parse", "HEAD"]).await;
        git(local, &["commit", "-q", "--allow-empty", "-m", "local"]).await;
        let refused = ensure_branch_unmoved(local, "main", &handoff_head, "0000000000000000000000000000000000000000").await.unwrap_err();
        assert!(refused.contains(&format!("git reset --keep {handoff_head}")) && refused.contains("Nothing was moved"), "{refused}");
    }

    #[tokio::test]
    async fn an_adopted_worktree_takes_a_free_branch_name() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]).await;
        git(repo, &["config", "user.email", "test@example.com"]).await;
        git(repo, &["config", "user.name", "Test"]).await;
        git(repo, &["commit", "-q", "--allow-empty", "-m", "init"]).await;
        git(repo, &["branch", "fix/general/123-fix"]).await;
        assert_eq!(unused_branch_name(repo, &[Some("fix/general/123-fix"), Some("feat/general/ab12cd34")]).await.unwrap(), "feat/general/ab12cd34");
        git(repo, &["branch", "feat/general/ab12cd34"]).await;
        assert_eq!(unused_branch_name(repo, &[Some("fix/general/123-fix"), Some("feat/general/ab12cd34")]).await.unwrap(), "fix/general/123-fix-2");
        assert!(unused_branch_name(repo, &[None, Some("bad..name")]).await.is_err());
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
