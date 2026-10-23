//! Git operations Hunt needs: one worktree per session, the uncommitted changes of that
//! worktree against `HEAD`, and committing, pushing or shelving them. Everything shells out to
//! the `git` CLI so hooks, config and credential behavior match the terminal.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::ops::RangeInclusive;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Single-letter git status: A, M, D, R, or ? for untracked.
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub unified: String,
}

/// Added and removed line counts of one changed file.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeStat {
    pub path: String,
    pub added: u32,
    pub removed: u32,
}

/// A shelved set of changes, stored as a git stash entry scoped to the session's branch.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    /// Stash reference such as `stash@{0}`; valid until the stash list changes.
    pub reference: String,
    pub name: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub files: Vec<ChangedFile>,
}

/// Runs git in `cwd`. Exit code 1 is accepted for `diff` and `grep` commands, where it only means "has changes"
/// or "no match".
pub async fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_with_env::<&Path>(cwd, args, &[]).await
}

/// `run_git` with extra environment variables for the git process.
pub async fn run_git_with_env<V: AsRef<OsStr>>(cwd: &Path, args: &[&str], envs: &[(&str, V)]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .envs(envs.iter().map(|(key, value)| (*key, value.as_ref())))
        .output()
        .await
        .map_err(|error| format!("failed to run git: {error}"))?;

    let is_benign_exit = matches!(args.first(), Some(&"diff") | Some(&"grep")) && output.status.code() == Some(1);
    if !output.status.success() && !is_benign_exit {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {} failed: {stderr}", args.join(" ")));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// `run_git_with_env` that writes `input` to the git process's stdin, for the `--batch` and `--stdin` modes.
async fn run_git_with_input(cwd: &Path, args: &[&str], envs: &[(&str, &Path)], input: &str) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let mut child = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .envs(envs.iter().map(|(key, value)| (*key, value.as_os_str())))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run git: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("failed to open the stdin of git")?;
    let input = input.to_string();
    let writer = tokio::spawn(async move { stdin.write_all(input.as_bytes()).await });
    let output = child.wait_with_output().await.map_err(|error| format!("failed to run git: {error}"))?;
    writer.await.map_err(|error| error.to_string())?.map_err(|error| format!("failed to write to git: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {} failed: {stderr}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The ref every changelist and diff of a worktree compares against: its uncommitted changes.
pub const DIFF_BASE: &str = "HEAD";

/// The prefix of the branches Hunt creates for its sessions, in the `<type>/<scope>/<name>` form repositories check
/// branch names against.
const SESSION_BRANCH_PREFIX: &str = "feat/general/";

/// The branch Hunt creates for a session: `feat/general/<name>`.
pub fn session_branch(name: &str) -> String {
    format!("{SESSION_BRANCH_PREFIX}{name}")
}

/// The branch of a new worktree session off `base_ref`: the base branch without `origin/` and the next number after
/// the highest local `<base>-<n>`, so `master-1`, `master-2`, … A base outside the `<type>/<scope>/<name>` form gets
/// the session prefix (`feat/general/master-1`), since pre-push hooks check the branch a push starts from.
pub async fn next_session_branch(repo: &Path, base_ref: &str) -> Result<String, String> {
    let stem = session_branch_stem(base_ref);
    let existing = run_git(repo, &["for-each-ref", "--format=%(refname:short)", &format!("refs/heads/{stem}-*")]).await?;
    Ok(numbered_branch(&stem, existing.lines()))
}

fn session_branch_stem(base_ref: &str) -> String {
    let base = base_ref.strip_prefix("origin/").unwrap_or(base_ref);
    let mut segments = base.splitn(3, '/');
    let is_conventional = matches!(segments.next(), Some("feat" | "feature" | "fix" | "chore"))
        && segments.next().is_some_and(|scope| !scope.is_empty())
        && segments.next().is_some_and(|name| !name.is_empty());
    if is_conventional { base.to_string() } else { session_branch(base) }
}

fn numbered_branch<'a>(stem: &str, existing: impl Iterator<Item = &'a str>) -> String {
    let prefix = format!("{stem}-");
    let highest = existing
        .filter_map(|branch| branch.strip_prefix(&prefix))
        .filter(|number| number.bytes().all(|byte| byte.is_ascii_digit()))
        .filter_map(|number| number.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    format!("{prefix}{}", highest + 1)
}

/// Full commit hash of `reference`. The ref follows `--end-of-options` and may not start with `-`, so a
/// frontend-supplied value can never act as a git option.
pub async fn rev_parse(repo: &Path, reference: &str) -> Result<String, String> {
    if reference.is_empty() || reference.starts_with('-') {
        return Err(format!("invalid git reference: {reference:?}"));
    }
    Ok(run_git(repo, &["rev-parse", "--verify", "--end-of-options", reference]).await?.trim().to_string())
}

/// Commit the changelist of a pull request review compares the worktree against: the best common ancestor of the
/// pull request's target branch `base` and its head `head`. Both refs are validated like in `rev_parse`.
pub async fn merge_base(repo: &Path, base: &str, head: &str) -> Result<String, String> {
    for reference in [base, head] {
        if reference.is_empty() || reference.starts_with('-') {
            return Err(format!("invalid git reference: {reference:?}"));
        }
    }
    Ok(run_git(repo, &["merge-base", base, head]).await?.trim().to_string())
}

/// Whether the commit `ancestor` is `descendant` or one of its ancestors; also false when git knows either of them not.
/// Both refs are validated like in `rev_parse`.
pub async fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> bool {
    let is_valid = [ancestor, descendant].iter().all(|reference| !reference.is_empty() && !reference.starts_with('-'));
    is_valid && run_git(repo, &["merge-base", "--is-ancestor", ancestor, descendant]).await.is_ok()
}

/// The author name and email `repo` commits with (`user.name`, `user.email`).
pub async fn identity(repo: &Path) -> Result<(String, String), String> {
    let name = run_git(repo, &["config", "user.name"]).await.unwrap_or_default();
    let email = run_git(repo, &["config", "user.email"]).await.unwrap_or_default();
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err("git has no user.name or user.email for its repository".into());
    }
    Ok((name.trim().to_string(), email.trim().to_string()))
}

/// Whether the repository of `worktree` treats paths as case-insensitive (`core.ignorecase`), as git sets it on a
/// case-insensitive file system.
pub async fn ignores_case(worktree: &Path) -> bool {
    run_git(worktree, &["config", "--bool", "core.ignorecase"]).await.is_ok_and(|value| value.trim() == "true")
}

/// Where a path differs between two trees, seen from the first: only in the second, only in the first, or in both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeChange {
    Added,
    Deleted,
    Modified,
}

/// The paths that differ between the trees `left` and `right` of `repo`, each with how. With `ignore_case`, a file
/// whose name only changed case with the same content counts as unchanged.
pub async fn tree_changes(repo: &Path, left: &str, right: &str, ignore_case: bool) -> Result<Vec<(String, TreeChange)>, String> {
    let output = run_git(repo, &["diff-tree", "-r", "-z", "--raw", "--no-renames", left, right]).await?;
    Ok(changed_entries(&output, ignore_case))
}

/// Reads `git diff-tree -r -z --raw` output; see `tree_changes`.
fn changed_entries(output: &str, ignore_case: bool) -> Vec<(String, TreeChange)> {
    // Each change is `:<old mode> <new mode> <old id> <new id> <status>` followed by its path, NUL-separated.
    let mut changes: Vec<(String, TreeChange, String)> = Vec::new();
    let mut fields = output.split('\0').filter(|field| !field.is_empty());
    while let (Some(meta), Some(path)) = (fields.next(), fields.next()) {
        let parts: Vec<&str> = meta.trim_start_matches(':').split(' ').collect();
        let [_, _, old, new, status] = parts.as_slice() else { continue };
        let (change, id) = match *status {
            "A" => (TreeChange::Added, new),
            "D" => (TreeChange::Deleted, old),
            _ => (TreeChange::Modified, new),
        };
        changes.push((path.to_string(), change, id.to_string()));
    }
    let keyed = |wanted: TreeChange| -> Vec<(String, String)> {
        changes.iter().filter(|change| change.1 == wanted).map(|change| (change.0.to_lowercase(), change.2.clone())).collect()
    };
    let (added, deleted) = if ignore_case { (keyed(TreeChange::Added), keyed(TreeChange::Deleted)) } else { (Vec::new(), Vec::new()) };
    changes
        .into_iter()
        .filter(|(path, change, id)| {
            let key = (path.to_lowercase(), id.clone());
            match change {
                TreeChange::Added => !deleted.contains(&key),
                TreeChange::Deleted => !added.contains(&key),
                TreeChange::Modified => true,
            }
        })
        .map(|(path, change, _)| (path, change))
        .collect()
}

/// The rule (`<source>:<line>:<pattern>`) that makes git ignore each of `paths` in `worktree`, tracked or not; paths no
/// rule ignores are left out.
pub async fn ignore_rules(worktree: &Path, paths: &[String]) -> Result<std::collections::BTreeMap<String, String>, String> {
    if paths.is_empty() {
        return Ok(Default::default());
    }
    use tokio::io::AsyncWriteExt;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(["check-ignore", "-v", "-z", "--no-index", "--stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run git: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("failed to open the stdin of git")?;
    let input: Vec<u8> = paths.iter().flat_map(|path| path.bytes().chain([0])).collect();
    let writer = tokio::spawn(async move { stdin.write_all(&input).await });
    let output = child.wait_with_output().await.map_err(|error| format!("failed to run git: {error}"))?;
    let _ = writer.await;
    // Exit status 1 means that no path is ignored.
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err(format!("git check-ignore failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(parse_ignore_rules(&String::from_utf8_lossy(&output.stdout)))
}

/// Reads `git check-ignore -v -z` output, four NUL-separated fields per path: source, line, pattern and path. A
/// negated pattern (`!…`) matches a path it does not ignore, which is left out.
pub fn parse_ignore_rules(output: &str) -> std::collections::BTreeMap<String, String> {
    let fields: Vec<&str> = output.split('\0').collect();
    fields
        .chunks_exact(4)
        .filter(|chunk| !chunk[2].starts_with('!') && !chunk[3].is_empty())
        .map(|chunk| (chunk[3].to_string(), format!("{}:{}:{}", chunk[0], chunk[1], chunk[2])))
        .collect()
}

/// Name of the branch `repo`'s checkout is on; `HEAD` when it is detached.
pub async fn current_branch(repo: &Path) -> Result<String, String> {
    Ok(run_git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?.trim().to_string())
}

/// Local and remote branch names, local first, without duplicates.
pub async fn list_branches(repo: &Path) -> Result<Vec<String>, String> {
    let output = run_git(
        repo,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    )
    .await?;

    let mut branches: Vec<String> = Vec::new();
    for line in output.lines() {
        let name = line.trim();
        if name.is_empty() || name.ends_with("/HEAD") || branches.iter().any(|known| known == name) {
            continue;
        }
        branches.push(name.to_string());
    }

    Ok(branches)
}

pub async fn worktree_add(repo: &Path, branch: &str, path: &Path, base: &str) -> Result<(), String> {
    let path = path.to_string_lossy();
    run_git(repo, &["worktree", "add", "-b", branch, &path, base]).await?;
    Ok(())
}

/// The branch on `origin` the local branch `branch` tracks (`branch.<name>.merge`); `None` when it tracks none, or
/// one on another remote.
pub async fn origin_upstream(repo: &Path, branch: &str) -> Option<String> {
    let remote = run_git(repo, &["config", "--get", &format!("branch.{branch}.remote")]).await.ok()?;
    if remote.trim() != "origin" {
        return None;
    }
    let merge = run_git(repo, &["config", "--get", &format!("branch.{branch}.merge")]).await.ok()?;
    merge.trim().strip_prefix("refs/heads/").map(str::to_string)
}

/// Makes the branch `target` on `origin` the upstream of the local branch `branch`, whether or not `origin/<target>`
/// was fetched yet: the branch's push lands there, and the upstream travels with the branch to a session's VM.
pub async fn set_origin_upstream(repo: &Path, branch: &str, target: &str) -> Result<(), String> {
    ensure_branch_name(repo, branch).await?;
    ensure_branch_name(repo, target).await?;
    run_git(repo, &["config", &format!("branch.{branch}.remote"), "origin"]).await?;
    run_git(repo, &["config", &format!("branch.{branch}.merge"), &format!("refs/heads/{target}")]).await?;
    Ok(())
}

/// Makes a plain `git push` in `worktree` push like Hunt does: to the branch on `origin` the checked-out branch tracks,
/// or, without an upstream, to a branch of its own name, which then becomes its upstream. The settings go into the
/// worktree's own config (`extensions.worktreeConfig`), so the repository's other worktrees and its checkout keep theirs.
pub async fn configure_push(worktree: &Path) -> Result<(), String> {
    if run_git(worktree, &["config", "--get", "core.worktree"]).await.is_ok() {
        return Err("failed to configure git push: the repository sets core.worktree, which per-worktree config would hide".into());
    }
    run_git(worktree, &["config", "extensions.worktreeConfig", "true"]).await?;
    run_git(worktree, &["config", "--worktree", "push.default", "upstream"]).await?;
    run_git(worktree, &["config", "--worktree", "push.autoSetupRemote", "true"]).await?;
    Ok(())
}

/// Adds the worktree `path` of `repo` on the existing branch `branch` rather than a new one: on the local branch of
/// that name, else on a new local branch of that name that tracks `remote_ref`, the branch on a remote (e.g.
/// `origin/<branch>`). Returns whether it created the local branch. Fails when a worktree of `repo`, its own checkout
/// included, has the branch checked out already, since git checks a branch out in one worktree only.
pub async fn worktree_add_on_branch(repo: &Path, branch: &str, path: &Path, remote_ref: &str) -> Result<bool, String> {
    if branch.starts_with('-') || run_git(repo, &["check-ref-format", "--branch", branch]).await.is_err() {
        return Err(format!("failed to create the session's worktree: invalid branch name {branch:?}"));
    }
    let path = path.to_string_lossy();
    if !local_branch_exists(repo, branch).await {
        run_git(repo, &["worktree", "add", "--track", "-b", branch, &path, remote_ref]).await?;
        return Ok(true);
    }
    if let Some(checkout) = worktree_of_branch(repo, branch).await? {
        return Err(format!("failed to create the session's worktree: branch {branch} is already checked out in {checkout}"));
    }
    run_git(repo, &["worktree", "add", &path, branch]).await?;
    Ok(false)
}

/// Whether `repo` has the local branch `branch`.
pub async fn local_branch_exists(repo: &Path, branch: &str) -> bool {
    run_git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await.is_ok()
}

/// The path of the worktree of `repo`, its own checkout included, that has the local branch `branch` checked out.
async fn worktree_of_branch(repo: &Path, branch: &str) -> Result<Option<String>, String> {
    let listing = run_git(repo, &["worktree", "list", "--porcelain"]).await?;
    let checked_out = format!("branch refs/heads/{branch}");
    let mut worktree = None;
    for line in listing.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            worktree = Some(path);
        } else if line == checked_out {
            return Ok(worktree.map(str::to_string));
        }
    }
    Ok(None)
}

pub async fn worktree_remove(repo: &Path, path: &Path) -> Result<(), String> {
    let path = path.to_string_lossy();
    run_git(repo, &["worktree", "remove", "--force", &path]).await?;
    Ok(())
}

/// Deletes the local branch `branch` whatever it contains.
pub async fn delete_branch(repo: &Path, branch: &str) -> Result<(), String> {
    delete_local_branch(repo, branch, true).await
}

/// Deletes the local branch `branch`; without `force`, git refuses a branch whose commits its upstream (or HEAD) lacks
/// with "not fully merged". A branch checked out in a worktree is refused either way.
pub async fn delete_local_branch(repo: &Path, branch: &str, force: bool) -> Result<(), String> {
    ensure_branch_name(repo, branch).await?;
    run_git(repo, &["branch", if force { "-D" } else { "-d" }, "--", branch]).await?;
    Ok(())
}

/// Deletes the branch `branch` on `origin`.
pub async fn delete_remote_branch(worktree: &Path, branch: &str) -> Result<(), String> {
    ensure_branch_name(worktree, branch).await?;
    run_git(worktree, &["push", "-q", "--delete", "--", "origin", branch]).await?;
    Ok(())
}

/// Renames the local branch `branch` to `new_name`, in whichever worktree it is checked out.
pub async fn rename_branch(repo: &Path, branch: &str, new_name: &str) -> Result<(), String> {
    ensure_branch_name(repo, branch).await?;
    ensure_branch_name(repo, new_name).await?;
    run_git(repo, &["branch", "-m", "--", branch, new_name]).await?;
    Ok(())
}

/// Rejects `branch` as the name of a branch to create: an invalid name, or one `repo` has locally or on a remote already.
pub async fn ensure_new_branch(repo: &Path, branch: &str) -> Result<(), String> {
    ensure_branch_name(repo, branch).await?;
    if local_branch_exists(repo, branch).await {
        return Err(format!("branch {branch} exists already"));
    }
    if run_git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")]).await.is_ok() {
        return Err(format!("branch {branch} exists on origin already"));
    }
    Ok(())
}

/// Creates the branch `branch` at `HEAD` of the checkout `repo` and switches it there, keeping its working changes.
pub async fn switch_to_new_branch(repo: &Path, branch: &str) -> Result<(), String> {
    ensure_new_branch(repo, branch).await?;
    run_git(repo, &["switch", "-q", "-c", branch]).await?;
    Ok(())
}

/// Deletes every ref below `prefix`, which ends with `/` (e.g. `refs/hunt/<id>/`).
pub async fn delete_refs(repo: &Path, prefix: &str) -> Result<(), String> {
    let commands = run_git(repo, &["for-each-ref", "--format=delete %(refname)", prefix]).await?;
    if commands.trim().is_empty() {
        return Ok(());
    }
    run_git_with_input(repo, &["update-ref", "--stdin"], &[], &commands).await?;
    Ok(())
}

/// Adds `.hunt/` to the repository's `info/exclude` (shared by all worktrees) so the diagram folder never shows up in
/// git; an entry for the folder's former name `.harness/` is replaced.
pub async fn exclude_hunt_dir(worktree: &Path) -> Result<(), String> {
    let exclude_path = run_git(worktree, &["rev-parse", "--git-path", "info/exclude"]).await?;
    let exclude_path = worktree.join(exclude_path.trim());

    if let Some(parent) = exclude_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == ".hunt/") {
        return Ok(());
    }

    let mut content: String = existing.lines().filter(|line| line.trim() != ".harness/").map(|line| format!("{line}\n")).collect();
    content.push_str(".hunt/\n");
    std::fs::write(&exclude_path, content).map_err(|error| error.to_string())
}

/// Object store for worktree snapshots outside the repository: new objects go to `objects`, the repository's own
/// objects stay readable as alternates, so a snapshot neither adds objects to the repository nor copies its files.
pub struct SnapshotStore {
    objects: std::path::PathBuf,
    alternates: std::path::PathBuf,
}

impl SnapshotStore {
    /// Opens the store in `objects` (created when missing) for the repository of `worktree`.
    pub async fn open(worktree: &Path, objects: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(objects).map_err(|error| format!("failed to create the snapshot store: {error}"))?;
        let alternates = run_git(worktree, &["rev-parse", "--git-path", "objects"]).await?;
        Ok(Self { objects: objects.to_path_buf(), alternates: worktree.join(alternates.trim()) })
    }

    fn envs(&self) -> [(&'static str, &Path); 2] {
        [("GIT_OBJECT_DIRECTORY", self.objects.as_path()), ("GIT_ALTERNATE_OBJECT_DIRECTORIES", self.alternates.as_path())]
    }
}

/// Tree object of the current working tree in `store`: tracked and untracked files, ignored files excluded.
/// The tree is built through a scratch copy of the index, so neither the real index nor HEAD change.
/// The copy carries the stat cache, which lets git skip rehashing files that did not change.
pub async fn snapshot_tree(worktree: &Path, store: &SnapshotStore) -> Result<String, String> {
    tree_through_scratch_index(worktree, &store.envs()).await
}

/// Tree object of the current working tree like `snapshot_tree`, but written to the repository's own objects, so it
/// can be pushed and compared with trees of commits.
pub async fn worktree_tree(worktree: &Path) -> Result<String, String> {
    tree_through_scratch_index(worktree, &[]).await
}

/// A commit of the current working tree (tracked and untracked files, ignored ones excluded) on top of `HEAD`, for
/// moving uncommitted work to another machine; neither the index nor any branch changes.
pub async fn snapshot_commit(worktree: &Path, message: &str) -> Result<String, String> {
    let tree = worktree_tree(worktree).await?;
    Ok(run_git(worktree, &["commit-tree", &tree, "-p", "HEAD", "-m", message]).await?.trim().to_string())
}

/// Writes the tree of the working tree through a scratch copy of the index, with `envs` added to every git call.
async fn tree_through_scratch_index(worktree: &Path, envs: &[(&str, &Path)]) -> Result<String, String> {
    let index_path = run_git(worktree, &["rev-parse", "--git-path", "index"]).await?;
    let index_path = worktree.join(index_path.trim());
    let scratch_index = std::env::temp_dir().join(format!("hunt-index-{}", uuid::Uuid::new_v4()));
    if index_path.exists() {
        std::fs::copy(&index_path, &scratch_index).map_err(|error| error.to_string())?;
    }

    let mut all_envs = vec![("GIT_INDEX_FILE", scratch_index.as_path())];
    all_envs.extend_from_slice(envs);
    let result = async {
        run_git_with_env(worktree, &["add", "-A", "--", "."], &all_envs).await?;
        run_git_with_env(worktree, &["write-tree"], &all_envs).await
    }
    .await;
    let _ = std::fs::remove_file(&scratch_index);
    Ok(result?.trim().to_string())
}

/// Paths that differ between two tree objects of `store`, as `snapshot_tree` returns them.
pub async fn changed_paths_between(worktree: &Path, store: &SnapshotStore, before: &str, after: &str) -> Result<Vec<String>, String> {
    let output = run_git_with_env(worktree, &["diff-tree", "-r", "--name-only", "--no-renames", before, after], &store.envs()).await?;
    Ok(output.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect())
}

/// Blob id of `path` in each of `trees` (objects of `store`), `None` where the tree has no such file.
pub async fn blob_ids_at(worktree: &Path, store: &SnapshotStore, trees: &[String], path: &str) -> Result<Vec<Option<String>>, String> {
    let input: String = trees.iter().map(|tree| format!("{tree}:{path}\n")).collect();
    let output = run_git_with_input(worktree, &["cat-file", "--batch-check=%(objectname) %(objecttype)"], &store.envs(), &input).await?;
    let ids: Vec<Option<String>> = output
        .lines()
        .map(|line| match line.split_once(' ') {
            Some((id, "blob")) => Some(id.to_string()),
            _ => None,
        })
        .collect();
    if ids.len() != trees.len() {
        return Err(format!("failed to look up {path} in the snapshots: expected {} answers, got {}", trees.len(), ids.len()));
    }
    Ok(ids)
}

/// Content of the blob `id` of `store`, decoded lossily as UTF-8.
pub async fn read_blob(worktree: &Path, store: &SnapshotStore, id: &str) -> Result<String, String> {
    run_git_with_env(worktree, &["cat-file", "blob", id], &store.envs()).await
}

/// Every project file for the file search: tracked and untracked files, ignored files and files deleted from
/// the working tree excluded. Paths are worktree-relative and sorted.
pub async fn list_files(worktree: &Path) -> Result<Vec<String>, String> {
    let listed = run_git(worktree, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).await?;
    let deleted = run_git(worktree, &["ls-files", "-z", "--deleted"]).await?;
    let deleted: std::collections::HashSet<&str> = deleted.split('\0').filter(|path| !path.is_empty()).collect();
    let mut files: Vec<String> = listed
        .split('\0')
        .filter(|path| !path.is_empty() && !deleted.contains(path))
        .map(str::to_string)
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

/// Tracked changes against `base` plus untracked files, sorted by path.
pub async fn changed_files(worktree: &Path, base: &str) -> Result<Vec<ChangedFile>, String> {
    let mut files: Vec<ChangedFile> = Vec::new();

    let tracked = run_git(worktree, &["diff", "--name-status", "--no-renames", base]).await?;
    push_name_status(&mut files, &tracked);

    let untracked = run_git(worktree, &["ls-files", "--others", "--exclude-standard"]).await?;
    push_untracked(&mut files, &untracked);

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// Parses `git diff --name-status` output (`<status>\t<path>` per line) into `files`.
fn push_name_status(files: &mut Vec<ChangedFile>, output: &str) {
    for line in output.lines() {
        let mut parts = line.splitn(2, '\t');
        let status = parts.next().unwrap_or("").chars().next().unwrap_or('M').to_string();
        let Some(path) = parts.next() else { continue };
        files.push(ChangedFile { path: path.to_string(), status });
    }
}

/// Adds one `?` entry per non-empty line of `output` to `files`.
fn push_untracked(files: &mut Vec<ChangedFile>, output: &str) {
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        files.push(ChangedFile { path: line.to_string(), status: "?".into() });
    }
}

/// Added and removed lines per file: tracked changes against `base` plus untracked files, whose whole line
/// count is `added`. Sorted by path.
pub async fn change_stats(worktree: &Path, base: &str) -> Result<Vec<ChangeStat>, String> {
    let numstat = run_git(worktree, &["diff", "--numstat", "--no-renames", base]).await?;
    let mut stats = parse_numstat(&numstat);

    let untracked = run_git(worktree, &["ls-files", "--others", "--exclude-standard"]).await?;
    for line in untracked.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // Binary and non-UTF-8 files fail to read as text and count as empty.
        let added = std::fs::read_to_string(worktree.join(line)).map(|content| count_lines(&content)).unwrap_or(0);
        stats.push(ChangeStat { path: line.to_string(), added, removed: 0 });
    }

    stats.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(stats)
}

/// Parses `git diff --numstat` output (`<added>\t<removed>\t<path>` per line). Binary files show `-` for both
/// counts and count as 0.
fn parse_numstat(output: &str) -> Vec<ChangeStat> {
    let mut stats: Vec<ChangeStat> = Vec::new();
    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        stats.push(ChangeStat { path: path.to_string(), added: added.parse().unwrap_or(0), removed: removed.parse().unwrap_or(0) });
    }
    stats
}

/// Number of lines as git counts them: one per `\n`, plus one for a last line without a trailing newline.
fn count_lines(content: &str) -> u32 {
    let newlines = content.matches('\n').count();
    let has_unterminated_line = !content.is_empty() && !content.ends_with('\n');
    (newlines + usize::from(has_unterminated_line)) as u32
}

/// Old content (from `base`), new content (from disk) and the unified diff of one file.
pub async fn file_diff(worktree: &Path, base: &str, path: &str) -> Result<FileDiff, String> {
    let old_content = show(worktree, base, path).await;
    let new_content = std::fs::read_to_string(worktree.join(path)).ok();

    let unified = if old_content.is_some() {
        run_git(worktree, &["diff", base, "--", path]).await?
    } else {
        run_git(worktree, &["diff", "--no-index", "--", "/dev/null", path]).await?
    };

    Ok(FileDiff { path: path.to_string(), old_content, new_content, unified })
}

/// Restores `path` to its state at `base`: the content from `base`, or removed from index and disk
/// when the file did not exist there.
pub async fn revert_file(worktree: &Path, base: &str, path: &str) -> Result<(), String> {
    if show(worktree, base, path).await.is_some() {
        run_git(worktree, &["checkout", base, "--", path]).await?;
        return Ok(());
    }

    run_git(worktree, &["rm", "-f", "-q", "--ignore-unmatch", "--", path]).await?;
    let on_disk = worktree.join(path);
    if on_disk.exists() {
        std::fs::remove_file(&on_disk).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Content of `path` at `base`, or `None` when the file does not exist there.
pub async fn show(worktree: &Path, base: &str, path: &str) -> Option<String> {
    run_git(worktree, &["show", &format!("{base}:{path}")]).await.ok()
}

/// Lines of the new version that the hunks of a unified diff cover (changed lines and their context), read from the
/// `+start,count` of every `@@ -a,b +c,d @@` header; a bare `+start` means one line. These are the lines GitHub
/// accepts inline review comments on.
pub fn unified_new_line_ranges(unified: &str) -> Vec<RangeInclusive<u32>> {
    unified
        .lines()
        .filter(|line| line.starts_with("@@ "))
        .filter_map(|header| {
            let spec = header.split(' ').nth(2)?.strip_prefix('+')?;
            let (start, count): (u32, u32) = match spec.split_once(',') {
                Some((start, count)) => (start.parse().ok()?, count.parse().ok()?),
                None => (spec.parse().ok()?, 1),
            };
            if count == 0 {
                return None;
            }
            Some(start..=start + count - 1)
        })
        .collect()
}

/// Rejects absolute paths and paths with `..` components so a path can never leave the worktree.
pub fn ensure_inside_worktree(path: &str) -> Result<(), String> {
    let relative = Path::new(path);
    let is_inside_worktree = relative.is_relative()
        && !relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir));
    if !is_inside_worktree {
        return Err(format!("refusing to touch a path outside the worktree: {path}"));
    }
    Ok(())
}

/// Requires at least one path, each of which stays inside the worktree.
pub fn ensure_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no files selected".into());
    }
    for path in paths {
        ensure_inside_worktree(path)?;
    }
    Ok(())
}

/// Accepts only `stash@{<digits>}` so a reference can never address another ref or be read as an option.
fn ensure_stash_reference(reference: &str) -> Result<(), String> {
    let index = reference.strip_prefix("stash@{").and_then(|rest| rest.strip_suffix('}'));
    match index {
        Some(index) if !index.is_empty() && index.chars().all(|character| character.is_ascii_digit()) => Ok(()),
        _ => Err(format!("invalid shelf reference: {reference}")),
    }
}

/// `args` followed by `paths`, ready for `run_git`.
fn with_paths<'a>(args: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    args.iter().copied().chain(paths.iter().map(String::as_str)).collect()
}

/// Stashes exactly `paths` (untracked files included) under `name`. Git prefixes the subject with
/// `On <branch>: `, which is how `list_shelves` scopes entries to a branch. The index is reset first
/// because `stash push` with a pathspec fails on staged deletions.
pub async fn shelve_files(worktree: &Path, paths: &[String], name: &str) -> Result<(), String> {
    ensure_paths(paths)?;
    if name.trim().is_empty() {
        return Err("shelf name must not be empty".into());
    }

    run_git(worktree, &["reset", "-q", "--"]).await?;
    run_git(worktree, &with_paths(&["stash", "push", "-u", "-m", name, "--"], paths)).await?;
    Ok(())
}

/// Stash entries created on `branch`, newest first. The stash list is shared by every worktree of a
/// repository, so entries of other branches are skipped.
pub async fn list_shelves(worktree: &Path, branch: &str) -> Result<Vec<Shelf>, String> {
    let prefix = format!("On {branch}: ");
    let output = run_git(worktree, &["stash", "list", "--format=%gd%x1f%s%x1f%ct"]).await?;

    let mut shelves: Vec<Shelf> = Vec::new();
    for line in output.lines() {
        let mut fields = line.split('\u{1f}');
        let (Some(reference), Some(subject), Some(timestamp)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let Some(name) = subject.strip_prefix(&prefix) else { continue };
        let created_at = timestamp
            .trim()
            .parse::<i64>()
            .ok()
            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
            .ok_or_else(|| format!("invalid stash timestamp: {timestamp}"))?;
        let files = stash_files(worktree, reference).await?;
        shelves.push(Shelf { reference: reference.to_string(), name: name.to_string(), created_at, files });
    }

    Ok(shelves)
}

/// Tracked changes of a stash against its parent commit plus the untracked files it carries (its
/// third parent, which only exists when untracked files were stashed), sorted by path.
async fn stash_files(worktree: &Path, reference: &str) -> Result<Vec<ChangedFile>, String> {
    let mut files: Vec<ChangedFile> = Vec::new();

    let tracked = run_git(worktree, &["diff", "--name-status", "--no-renames", &format!("{reference}^1"), reference]).await?;
    push_name_status(&mut files, &tracked);

    if let Ok(untracked) = run_git(worktree, &["ls-tree", "-r", "--name-only", &format!("{reference}^3")]).await {
        push_untracked(&mut files, &untracked);
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// Restores a stash into the worktree, keeping the entry when `keep`. Git fails on conflicts and
/// keeps the entry in that case.
pub async fn unshelve(worktree: &Path, reference: &str, keep: bool) -> Result<(), String> {
    ensure_stash_reference(reference)?;
    run_git(worktree, &["reset", "-q", "--"]).await?;
    let action = if keep { "apply" } else { "pop" };
    run_git(worktree, &["stash", action, "-q", reference]).await?;
    Ok(())
}

pub async fn drop_shelf(worktree: &Path, reference: &str) -> Result<(), String> {
    ensure_stash_reference(reference)?;
    run_git(worktree, &["stash", "drop", "-q", reference]).await?;
    Ok(())
}

/// Commits exactly `paths` (untracked files and deletions included) with `message` on the worktree's current branch.
/// Changes staged for other paths stay staged and out of the commit; the repository's commit hooks run.
pub async fn commit_files(worktree: &Path, paths: &[String], message: &str) -> Result<(), String> {
    ensure_paths(paths)?;
    if message.trim().is_empty() {
        return Err("commit message must not be empty".into());
    }

    run_git(worktree, &with_paths(&["add", "-A", "--"], paths)).await?;
    run_git(worktree, &with_paths(&["commit", "-q", "-m", message, "--"], paths)).await?;
    Ok(())
}

/// Pushes the worktree's `HEAD` to the branch `target` on `origin` and makes `origin/<target>` the upstream of the
/// worktree's branch. When `origin/<target>` has commits `HEAD` lacks, the worktree's branch is rebased onto it first
/// (`rebase_onto_origin`).
pub async fn push_branch(worktree: &Path, target: &str) -> Result<(), String> {
    ensure_branch_name(worktree, target).await?;
    if current_branch(worktree).await? == "HEAD" {
        return Err("the worktree has no branch checked out".into());
    }
    fetch_branch(worktree, target).await?;
    if is_behind_origin(worktree, target).await {
        rebase_onto_origin(worktree, target).await?;
    }
    push_head(worktree, target).await
}

/// Pushes the worktree's `HEAD` to the branch `target` on `origin` and makes that the upstream of the worktree's branch;
/// `origin` rejects the push when `origin/<target>` has commits `HEAD` lacks.
pub async fn push_head(worktree: &Path, target: &str) -> Result<(), String> {
    ensure_branch_name(worktree, target).await?;
    run_git(worktree, &["push", "-q", "-u", "--", "origin", &format!("HEAD:refs/heads/{target}")]).await?;
    Ok(())
}

/// Whether `origin/<branch>`, as fetched last, has commits the worktree's `HEAD` lacks, so that a push to it needs a
/// rebase first; `false` without a remote-tracking ref of the branch.
pub async fn is_behind_origin(worktree: &Path, branch: &str) -> bool {
    let remote_ref = format!("refs/remotes/origin/{branch}");
    rev_parse(worktree, &remote_ref).await.is_ok() && !is_ancestor(worktree, &remote_ref, "HEAD").await
}

/// Rebases the worktree's branch onto `origin/<branch>` as fetched last, see `rebase_onto`.
pub async fn rebase_onto_origin(worktree: &Path, branch: &str) -> Result<(), String> {
    ensure_branch_name(worktree, branch).await?;
    rebase_onto(worktree, &format!("refs/remotes/origin/{branch}"), &format!("origin/{branch}")).await
}

/// Rebases the worktree's branch onto `reference` (a branch or remote branch, called `display` in messages), with the
/// uncommitted changes stashed meanwhile; a conflict aborts the rebase, which leaves branch and files as they were,
/// and fails with git's report.
pub async fn rebase_onto(worktree: &Path, reference: &str, display: &str) -> Result<(), String> {
    ensure_branch_name(worktree, reference).await?;
    if let Err(error) = run_git(worktree, &["rebase", "-q", "--autostash", "--", reference]).await {
        let conflicts = conflicting_files(worktree).await;
        let _ = run_git(worktree, &["rebase", "--abort"]).await;
        return Err(conflict_error(&format!("rebase onto {display}"), &conflicts, &error));
    }
    Ok(())
}

/// Merges `reference` (a branch or remote branch) into the worktree's branch with git's default message, the
/// uncommitted changes stashed meanwhile; a conflict aborts the merge, which leaves branch and files as they were,
/// and fails with git's report.
pub async fn merge_into_head(worktree: &Path, reference: &str) -> Result<(), String> {
    ensure_branch_name(worktree, reference).await?;
    if let Err(error) = run_git(worktree, &["merge", "-q", "--no-edit", "--autostash", "--", reference]).await {
        let conflicts = conflicting_files(worktree).await;
        let _ = run_git(worktree, &["merge", "--abort"]).await;
        return Err(conflict_error(&format!("merge {reference}"), &conflicts, &error));
    }
    Ok(())
}

/// The files a stopped rebase or merge left with conflict markers, one per line.
async fn conflicting_files(worktree: &Path) -> String {
    run_git(worktree, &["diff", "--name-only", "--diff-filter=U", "--"]).await.unwrap_or_default()
}

/// The message of a failed `action` (e.g. `rebase onto origin/main`): the files `conflicts` (one per line) it
/// stopped at, else git's own `error`.
fn conflict_error(action: &str, conflicts: &str, error: &str) -> String {
    let files: Vec<&str> = conflicts.lines().filter(|line| !line.is_empty()).collect();
    if files.is_empty() {
        return format!("failed to {action}: {error}");
    }
    format!("failed to {action}: conflicts in {}; resolve them in the chat or by hand", files.join(", "))
}

/// Fast-forwards the local branch `branch`, which is not checked out here, to its upstream as fetched now, like
/// `git pull --ff-only`: a branch whose upstream has no commits it lacks stays as it is. Fails without an upstream,
/// when both have commits the other lacks, or when a worktree has the branch checked out.
pub async fn fast_forward_branch(repo: &Path, branch: &str) -> Result<(), String> {
    ensure_branch_name(repo, branch).await?;
    let local_ref = format!("refs/heads/{branch}");
    let upstream = run_git(repo, &["for-each-ref", "--format=%(upstream:short)", &local_ref]).await?;
    let upstream = upstream.trim();
    let Some((remote, remote_branch)) = upstream.split_once('/') else {
        return Err(format!("failed to update {branch}: it has no upstream"));
    };
    run_git(repo, &["fetch", "-q", "--", remote, &format!("refs/heads/{remote_branch}")]).await?;
    if is_ancestor(repo, upstream, &local_ref).await {
        return Ok(());
    }
    if !is_ancestor(repo, &local_ref, upstream).await {
        return Err(format!("failed to update {branch}: it and {upstream} both have commits the other lacks; rebase or merge instead"));
    }
    run_git(repo, &["fetch", "-q", "--", ".", &format!("refs/remotes/{upstream}:{local_ref}")]).await?;
    Ok(())
}

/// Pushes the local branch `branch` to the branch of the same name on `origin` and makes that its upstream; `origin`
/// rejects the push when its branch has commits `branch` lacks.
pub async fn push_local_branch(worktree: &Path, branch: &str) -> Result<(), String> {
    ensure_branch_name(worktree, branch).await?;
    run_git(worktree, &["push", "-q", "-u", "--", "origin", &format!("refs/heads/{branch}:refs/heads/{branch}")]).await?;
    Ok(())
}

/// Number of commits a push to the branch `target` on `origin` would publish: those `origin/<target>`, as fetched last,
/// lacks or, without a remote-tracking ref of it, those no branch of `origin` has. A detached HEAD has nothing to push.
pub async fn unpushed_commit_count(worktree: &Path, target: &str) -> Result<u32, String> {
    ensure_branch_name(worktree, target).await?;
    if current_branch(worktree).await? == "HEAD" {
        return Ok(0);
    }
    let remote_ref = format!("refs/remotes/origin/{target}");
    let output = if rev_parse(worktree, &remote_ref).await.is_ok() {
        run_git(worktree, &["rev-list", "--count", &format!("{remote_ref}..HEAD"), "--"]).await?
    } else {
        run_git(worktree, &["rev-list", "--count", "HEAD", "--not", "--remotes=origin", "--"]).await?
    };
    output.trim().parse().map_err(|error| format!("failed to count unpushed commits: {error}"))
}

/// Updates the worktree's remote-tracking ref of `branch` from `origin`; `false` when `origin` has no such branch.
pub async fn fetch_branch(worktree: &Path, branch: &str) -> Result<bool, String> {
    ensure_branch_name(worktree, branch).await?;
    match run_git(worktree, &["fetch", "-q", "origin", branch]).await {
        Ok(_) => Ok(true),
        Err(error) if error.contains("couldn't find remote ref") => Ok(false),
        Err(error) => Err(error),
    }
}

/// Makes sure `origin` has the branch `branch` and the worktree its remote-tracking ref. A branch `origin` has is fetched;
/// one it lacks is created there at the commit `origin`'s branch `from` points at, so that a push landing on it publishes
/// what a push to `from` would. One round trip asks `origin` for both branches, `from` is fetched only when this
/// repository lacks its commit, and the push that creates `branch` updates its remote-tracking ref too; it fails when
/// `origin` got the branch meanwhile.
pub async fn ensure_origin_branch(worktree: &Path, branch: &str, from: &str) -> Result<(), String> {
    let commits = origin_branch_commits(worktree, &[branch, from]).await?;
    if commits.contains_key(branch) {
        fetch_branch(worktree, branch).await?;
        return Ok(());
    }
    let Some(commit) = commits.get(from) else {
        return Err(format!("failed to create the branch {branch} on origin: origin has no branch {from} to start it from"));
    };
    if rev_parse(worktree, &format!("{commit}^{{commit}}")).await.is_err() {
        fetch_branch(worktree, from).await?;
    }
    let lease = format!("--force-with-lease=refs/heads/{branch}:");
    run_git(worktree, &["push", "-q", &lease, "--", "origin", &format!("{commit}:refs/heads/{branch}")]).await?;
    Ok(())
}

/// The commit each of `branches` points at on `origin`, keyed by branch name and asked in one round trip; a branch
/// `origin` lacks has no entry.
async fn origin_branch_commits(worktree: &Path, branches: &[&str]) -> Result<HashMap<String, String>, String> {
    let mut patterns = Vec::new();
    for branch in branches {
        ensure_branch_name(worktree, branch).await?;
        patterns.push(format!("refs/heads/{branch}"));
    }
    let mut args = vec!["ls-remote", "--heads", "origin"];
    args.extend(patterns.iter().map(String::as_str));
    let output = run_git(worktree, &args).await?;
    let commits = output
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .filter_map(|(commit, name)| Some((name.strip_prefix("refs/heads/")?.to_string(), commit.to_string())))
        .collect();
    Ok(commits)
}

/// Rejects `branch` unless git accepts it as a branch name, which rules out options and refspecs.
async fn ensure_branch_name(repo: &Path, branch: &str) -> Result<(), String> {
    if branch.starts_with('-') || run_git(repo, &["check-ref-format", "--branch", branch]).await.is_err() {
        return Err(format!("invalid branch name: {branch:?}"));
    }
    Ok(())
}

/// Worktree-relative paths of the text files containing `word` as a whole word (tracked and untracked, never
/// ignored files), sorted as git lists them. `word` must be an identifier.
pub async fn files_containing_word(worktree: &Path, word: &str) -> Result<Vec<String>, String> {
    let is_identifier = !word.is_empty() && word.chars().all(|char| char.is_alphanumeric() || char == '_' || char == '$');
    if !is_identifier {
        return Err(format!("not an identifier: {word:?}"));
    }
    let output = run_git(worktree, &["grep", "-I", "-l", "-w", "-F", "--untracked", "-e", word, "--"]).await?;
    Ok(output.lines().filter(|line| !line.is_empty()).map(str::to_string).collect())
}

/// One commit of the log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub authored_at: chrono::DateTime<chrono::Utc>,
    pub subject: String,
    /// Branches and tags at the commit as `git log --decorate` names them (`HEAD -> master`, `origin/master`, `tag: v1.0`), without `<remote>/HEAD`.
    pub refs: Vec<String>,
}

/// A page of the log: the commits reachable from `reference` (every branch, remote branch and tag when empty) whose
/// message contains `text`, ignoring case, or whose hash starts with it; `skip` and `limit` page through them, newest
/// first.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    pub reference: String,
    pub text: String,
    pub skip: u32,
    pub limit: u32,
}

/// A branch or tag of the repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    /// Short name: `master`, `origin/master`, `v1.0`.
    pub name: String,
    pub kind: RefKind,
    /// The commit the ref points at; for an annotated tag the tagged commit.
    pub target: String,
    /// The short name of the local branch's upstream, when it has one.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Local,
    Remote,
    Tag,
}

/// Every branch and tag plus what the log needs to mark commits: the checked-out branch and the commits no remote has.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefList {
    /// The checked-out branch, or `HEAD` when it is detached.
    pub head: String,
    pub refs: Vec<GitRef>,
    /// Commits on a local branch that no remote-tracking branch has yet, i.e. a push would publish them.
    pub unpushed: Vec<String>,
}

/// A file a commit changed; `old_path` is set for a rename.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    /// Single-letter git status: A, M, D or R.
    pub status: String,
    pub old_path: Option<String>,
}

/// What the log shows for a selected commit.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub id: String,
    /// The full message, subject included.
    pub message: String,
    pub committer: String,
    pub committed_at: chrono::DateTime<chrono::Utc>,
    /// The files changed against the first parent, sorted by path.
    pub files: Vec<CommitFile>,
    /// Local and remote branches that contain the commit.
    pub branches: Vec<String>,
}

const RECORD_SEPARATOR: char = '\u{1e}';
const FIELD_SEPARATOR: char = '\u{1f}';
const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e";

/// Whether `id` can only be a commit hash (or a prefix of one), so it is safe as a git argument.
pub fn is_commit_id(id: &str) -> bool {
    (4..=40).contains(&id.len()) && id.chars().all(|character| character.is_ascii_hexdigit())
}

/// Rejects a user-typed revision that git would read as an option.
fn ensure_revision(reference: &str) -> Result<(), String> {
    if reference.starts_with('-') || reference.contains('\0') {
        return Err(format!("invalid revision: {reference:?}"));
    }
    Ok(())
}

/// The commits of `query`, newest first in date order (every parent comes after its children).
pub async fn log(repo: &Path, query: &LogQuery) -> Result<Vec<Commit>, String> {
    let range = log_range(repo, query.reference.trim()).await?;
    let text = query.text.trim();
    if !text.is_empty() {
        return filtered_log(repo, &range, text, query.skip, query.limit).await;
    }

    let skip = format!("--skip={}", query.skip);
    let limit = format!("--max-count={}", query.limit.clamp(1, 5000));
    let mut args = vec!["log", "--date-order", LOG_FORMAT, skip.as_str(), limit.as_str()];
    args.extend(range);
    args.push("--");
    let output = run_git(repo, &args).await?;
    Ok(parse_log(&output))
}

/// The revisions of the log of `reference`: every branch, remote branch and tag when it is empty, else the branch or tag.
async fn log_range<'a>(repo: &Path, reference: &'a str) -> Result<Vec<&'a str>, String> {
    if reference.is_empty() {
        return Ok(vec!["--branches", "--remotes", "--tags"]);
    }
    ensure_revision(reference)?;
    rev_parse(repo, &format!("{reference}^{{commit}}")).await.map_err(|_| format!("unknown branch or tag: {reference}"))?;
    Ok(vec![reference])
}

/// The page `skip`..`skip + limit` of the commits of `range` whose message contains `text`, ignoring case, or whose hash
/// starts with it, newest first in date order; each parent is rewritten to its nearest match (`rewrite_parents`), so
/// the graph joins the matches.
async fn filtered_log(repo: &Path, range: &[&str], text: &str, skip: u32, limit: u32) -> Result<Vec<Commit>, String> {
    let graph = run_git(repo, &[&["rev-list", "--date-order", "--parents"], range, &["--"]].concat()).await?;
    let graph = parse_rev_list(&graph);
    let grep = format!("--grep={text}");
    let by_message = run_git(repo, &[&["rev-list", "--regexp-ignore-case", "--fixed-strings", grep.as_str()], range, &["--"]].concat()).await?;
    let mut matches: HashSet<&str> = by_message.split_whitespace().collect();
    let prefix = text.to_ascii_lowercase();
    if is_commit_id(&prefix) {
        matches.extend(graph.iter().map(|(id, _)| id.as_str()).filter(|id| id.starts_with(&prefix)));
    }

    let rows = rewrite_parents(&graph, &matches);
    let start = (skip as usize).min(rows.len());
    let page = &rows[start..(start + limit.clamp(1, 5000) as usize).min(rows.len())];
    if page.is_empty() {
        return Ok(Vec::new());
    }

    let ids = page.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>().join("\n");
    let output = run_git_with_input(repo, &["log", "--no-walk=unsorted", "--stdin", LOG_FORMAT, "--"], &[], &ids).await?;
    let parents: HashMap<&str, &Vec<String>> = page.iter().map(|(id, parents)| (id.as_str(), parents)).collect();
    let mut commits = parse_log(&output);
    for commit in &mut commits {
        if let Some(rewritten) = parents.get(commit.id.as_str()) {
            commit.parents = (*rewritten).clone();
        }
    }
    Ok(commits)
}

/// Reads `rev-list --parents` output: per line a commit followed by its parents.
fn parse_rev_list(output: &str) -> Vec<(String, Vec<String>)> {
    output
        .lines()
        .filter_map(|line| {
            let mut ids = line.split_whitespace().map(str::to_string);
            Some((ids.next()?, ids.collect()))
        })
        .collect()
}

/// The commits of `graph` (every parent after its children) that are in `matches`, in its order, each parent replaced by
/// the nearest match on that parent's first-parent line; a parent with no match below it is dropped.
fn rewrite_parents(graph: &[(String, Vec<String>)], matches: &HashSet<&str>) -> Vec<(String, Vec<String>)> {
    let mut nearest: HashMap<&str, Option<&str>> = HashMap::new();
    // Backwards, every commit's parents are resolved before the commit itself.
    for (id, parents) in graph.iter().rev() {
        let found = if matches.contains(id.as_str()) { Some(id.as_str()) } else { parents.first().and_then(|parent| nearest.get(parent.as_str()).copied().flatten()) };
        nearest.insert(id.as_str(), found);
    }

    graph
        .iter()
        .filter(|(id, _)| matches.contains(id.as_str()))
        .map(|(id, parents)| {
            let mut rewritten: Vec<String> = Vec::new();
            for parent in parents {
                let Some(Some(found)) = nearest.get(parent.as_str()) else { continue };
                if !rewritten.iter().any(|known| known == found) {
                    rewritten.push(found.to_string());
                }
            }
            (id.clone(), rewritten)
        })
        .collect()
}

/// Parses the records of `LOG_FORMAT`; a record that does not parse is skipped.
fn parse_log(output: &str) -> Vec<Commit> {
    output
        .split(RECORD_SEPARATOR)
        .filter_map(|record| {
            let fields: Vec<&str> = record.trim_start_matches('\n').splitn(7, FIELD_SEPARATOR).collect();
            let [id, parents, author, author_email, authored_at, refs, subject] = fields[..] else { return None };
            let authored_at = chrono::DateTime::parse_from_rfc3339(authored_at).ok()?.with_timezone(&chrono::Utc);
            Some(Commit {
                id: id.to_string(),
                parents: parents.split_whitespace().map(str::to_string).collect(),
                author: author.to_string(),
                author_email: author_email.to_string(),
                authored_at,
                subject: subject.to_string(),
                refs: refs.split(", ").filter(|name| !name.is_empty() && !name.ends_with("/HEAD")).map(str::to_string).collect(),
            })
        })
        .collect()
}

/// How `reset` moves the checked-out branch: `Soft` keeps index and files, `Mixed` keeps the files, `Hard` drops every
/// uncommitted change, `Keep` resets the files but keeps the uncommitted changes and fails when one is in the way.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
    Keep,
}

impl ResetMode {
    /// The option of `git reset` for the mode.
    pub fn flag(self) -> &'static str {
        match self {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
            ResetMode::Keep => "--keep",
        }
    }
}

/// Points the worktree's checked-out branch at the commit `id` with `git reset` in `mode`.
pub async fn reset(worktree: &Path, id: &str, mode: ResetMode) -> Result<(), String> {
    if !is_commit_id(id) {
        return Err(format!("invalid commit id: {id:?}"));
    }
    run_git(worktree, &["reset", "-q", mode.flag(), id, "--"]).await.map_err(|error| format!("failed to reset to {id}: {error}"))?;
    Ok(())
}

/// Every branch and tag with its upstream state, the checked-out branch and the commits no remote has.
pub async fn refs(repo: &Path) -> Result<RefList, String> {
    let output = run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )
    .await?;
    let refs = parse_refs(&output);
    let head = current_branch(repo).await?;
    let unpushed = run_git(repo, &["rev-list", "--max-count=5000", "--branches", "--not", "--remotes", "--"]).await?;
    let unpushed = unpushed.split_whitespace().map(str::to_string).collect();
    Ok(RefList { head, refs, unpushed })
}

/// Parses the `for-each-ref` records of `refs`; the symbolic `<remote>/HEAD` is left out.
fn parse_refs(output: &str) -> Vec<GitRef> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.splitn(5, FIELD_SEPARATOR).collect();
            let [refname, object, peeled, upstream, track] = fields[..] else { return None };
            let (kind, name) = if let Some(name) = refname.strip_prefix("refs/heads/") {
                (RefKind::Local, name)
            } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
                if name.ends_with("/HEAD") {
                    return None;
                }
                (RefKind::Remote, name)
            } else {
                (RefKind::Tag, refname.strip_prefix("refs/tags/")?)
            };
            let (ahead, behind) = parse_track(track);
            Some(GitRef {
                name: name.to_string(),
                kind,
                target: if peeled.is_empty() { object.to_string() } else { peeled.to_string() },
                upstream: if upstream.is_empty() { None } else { Some(upstream.to_string()) },
                ahead,
                behind,
            })
        })
        .collect()
}

/// Reads `[ahead 2, behind 1]`, `[ahead 2]`, `[behind 1]`, `[gone]` or an empty string.
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.trim_matches(|character| character == '[' || character == ']').split(", ") {
        if let Some(count) = part.strip_prefix("ahead ") {
            ahead = count.trim().parse().unwrap_or(0);
        } else if let Some(count) = part.strip_prefix("behind ") {
            behind = count.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

/// The first parent of the commit `id`, or `None` for a root commit.
async fn first_parent(repo: &Path, id: &str) -> Option<String> {
    rev_parse(repo, &format!("{id}^1")).await.ok()
}

/// Message, committer, changed files and containing branches of the commit `id`.
pub async fn commit_details(repo: &Path, id: &str) -> Result<CommitDetails, String> {
    if !is_commit_id(id) {
        return Err(format!("invalid commit id: {id:?}"));
    }
    let output = run_git(repo, &["show", "--no-patch", "--format=%B%x1f%cn%x1f%cI", id, "--"]).await?;
    let fields: Vec<&str> = output.splitn(3, FIELD_SEPARATOR).collect();
    let [message, committer, committed_at] = fields[..] else { return Err(format!("failed to read commit {id}: unexpected output")) };
    let committed_at = chrono::DateTime::parse_from_rfc3339(committed_at.trim())
        .map_err(|error| format!("failed to read the date of commit {id}: {error}"))?
        .with_timezone(&chrono::Utc);

    let names = match first_parent(repo, id).await {
        Some(parent) => run_git(repo, &["diff-tree", "-r", "-M", "--name-status", "-z", &parent, id, "--"]).await?,
        None => run_git(repo, &["diff-tree", "-r", "-M", "--root", "--no-commit-id", "--name-status", "-z", id, "--"]).await?,
    };
    let mut files = parse_name_status(&names);
    files.sort_by(|left, right| left.path.cmp(&right.path));

    let branches = run_git(repo, &["for-each-ref", "--format=%(refname)", "--contains", id, "refs/heads", "refs/remotes"]).await?;
    let branches = branches
        .lines()
        .filter(|name| !name.ends_with("/HEAD"))
        .filter_map(|name| name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/remotes/")))
        .map(str::to_string)
        .collect();

    Ok(CommitDetails { id: id.to_string(), message: message.trim_end().to_string(), committer: committer.to_string(), committed_at, files, branches })
}

/// Parses `--name-status -z` output: `<status>\0<path>\0`, renames and copies as `<status><score>\0<old>\0<new>\0`.
fn parse_name_status(output: &str) -> Vec<CommitFile> {
    let mut files = Vec::new();
    let mut fields = output.split('\0').filter(|field| !field.is_empty());
    while let Some(status) = fields.next() {
        let Some(letter) = status.chars().next() else { break };
        match letter {
            'R' | 'C' => {
                let (Some(old_path), Some(path)) = (fields.next(), fields.next()) else { break };
                files.push(CommitFile { path: path.to_string(), status: "R".to_string(), old_path: Some(old_path.to_string()) });
            }
            _ => {
                let Some(path) = fields.next() else { break };
                files.push(CommitFile { path: path.to_string(), status: letter.to_string(), old_path: None });
            }
        }
    }
    files
}

/// The change of `path` in the commit `id` against its first parent, where the file was at `old_path` when the commit
/// renamed it: both contents and the unified diff.
pub async fn commit_file_diff(repo: &Path, id: &str, path: &str, old_path: Option<&str>) -> Result<FileDiff, String> {
    if !is_commit_id(id) {
        return Err(format!("invalid commit id: {id:?}"));
    }
    let new_content = show(repo, id, path).await;
    let Some(parent) = first_parent(repo, id).await else {
        let unified = run_git(repo, &["diff-tree", "-p", "--root", "--no-commit-id", id, "--", path]).await?;
        return Ok(FileDiff { path: path.to_string(), old_content: None, new_content, unified });
    };
    let old_content = show(repo, &parent, old_path.unwrap_or(path)).await;
    let mut args = vec!["diff", "-M", parent.as_str(), id, "--", path];
    if let Some(old_path) = old_path {
        args.push(old_path);
    }
    let unified = run_git(repo, &args).await?;
    Ok(FileDiff { path: path.to_string(), old_content, new_content, unified })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn parse_log_reads_records_with_parents_and_decorations() {
        let output = "aaaa\u{1f}bbbb cccc\u{1f}Jane\u{1f}jane@example.com\u{1f}2026-10-10T00:38:00+02:00\u{1f}HEAD -> master, origin/master, origin/HEAD, tag: v1\u{1f}feat: x\u{1e}\ndddd\u{1f}\u{1f}Jo\u{1f}jo@example.com\u{1f}2026-10-09T11:15:00+02:00\u{1f}\u{1f}init\u{1e}\n";
        let commits = parse_log(output);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].id, "aaaa");
        assert_eq!(commits[0].parents, vec!["bbbb", "cccc"]);
        assert_eq!(commits[0].refs, vec!["HEAD -> master", "origin/master", "tag: v1"]);
        assert_eq!(commits[0].subject, "feat: x");
        assert_eq!(commits[0].authored_at.to_rfc3339(), "2026-10-09T22:38:00+00:00");
        assert!(commits[1].parents.is_empty());
        assert!(commits[1].refs.is_empty());
    }

    #[test]
    fn parse_refs_classifies_refs_and_reads_the_upstream_state() {
        let output = "refs/heads/master\u{1f}1111\u{1f}\u{1f}origin/master\u{1f}[ahead 1, behind 2]\nrefs/remotes/origin/HEAD\u{1f}1111\u{1f}\u{1f}\u{1f}\nrefs/remotes/origin/master\u{1f}2222\u{1f}\u{1f}\u{1f}\nrefs/tags/v1\u{1f}3333\u{1f}4444\u{1f}\u{1f}\n";
        let refs = parse_refs(output);
        assert_eq!(refs.len(), 3);
        assert_eq!((refs[0].kind, refs[0].name.as_str(), refs[0].ahead, refs[0].behind), (RefKind::Local, "master", 1, 2));
        assert_eq!(refs[0].upstream.as_deref(), Some("origin/master"));
        assert_eq!((refs[1].kind, refs[1].name.as_str()), (RefKind::Remote, "origin/master"));
        assert_eq!((refs[2].kind, refs[2].target.as_str()), (RefKind::Tag, "4444"));
    }

    #[test]
    fn parse_track_reads_every_form() {
        assert_eq!(parse_track(""), (0, 0));
        assert_eq!(parse_track("[gone]"), (0, 0));
        assert_eq!(parse_track("[ahead 3]"), (3, 0));
        assert_eq!(parse_track("[behind 4]"), (0, 4));
        assert_eq!(parse_track("[ahead 1, behind 2]"), (1, 2));
    }

    #[test]
    fn parse_name_status_reads_renames_with_both_paths() {
        let files = parse_name_status("M\0src/a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0");
        assert_eq!(
            files,
            vec![
                CommitFile { path: "src/a.ts".into(), status: "M".into(), old_path: None },
                CommitFile { path: "new.ts".into(), status: "R".into(), old_path: Some("old.ts".into()) },
                CommitFile { path: "gone.ts".into(), status: "D".into(), old_path: None },
            ]
        );
    }

    #[test]
    fn rewrite_parents_joins_matches_along_first_parents() {
        let commit = |id: &str, parents: &[&str]| (id.to_string(), parents.iter().map(|parent| parent.to_string()).collect::<Vec<_>>());
        // e merges d into c; b and d are hidden, so e joins a over c and drops d's line, which has no match below it.
        let graph = vec![commit("e", &["c", "d"]), commit("d", &[]), commit("c", &["b"]), commit("b", &["a"]), commit("a", &[])];
        let matches = HashSet::from(["e", "c", "a"]);

        let rows = rewrite_parents(&graph, &matches);

        assert_eq!(rows, vec![commit("e", &["c"]), commit("c", &["a"]), commit("a", &[])]);
    }

    #[tokio::test]
    async fn log_filters_by_message_or_hash_prefix() {
        let dir = fixture().await;
        let repo = dir.path();
        for subject in ["fix: Nachtdienst (#1464)", "chore: unrelated", "feat: nachtdienst windows"] {
            git(repo, &["commit", "-q", "--allow-empty", "-m", subject]).await;
        }
        let query = |text: &str| LogQuery { reference: String::new(), text: text.to_string(), skip: 0, limit: 50 };
        let subjects = |commits: &[Commit]| commits.iter().map(|commit| commit.subject.clone()).collect::<Vec<_>>();

        let commits = log(repo, &query("NACHTDIENST")).await.unwrap();
        assert_eq!(subjects(&commits), ["feat: nachtdienst windows", "fix: Nachtdienst (#1464)"]);
        assert_eq!(commits[0].parents, vec![commits[1].id.clone()]);
        assert!(commits[1].parents.is_empty());

        assert_eq!(subjects(&log(repo, &query("1464")).await.unwrap()), ["fix: Nachtdienst (#1464)"]);

        let init = run_git(repo, &["rev-parse", "HEAD~3"]).await.unwrap();
        let commits = log(repo, &query(&init[..7].to_uppercase())).await.unwrap();
        assert_eq!(subjects(&commits), ["init"]);

        let second_page = log(repo, &LogQuery { skip: 1, limit: 1, ..query("nachtdienst") }).await.unwrap();
        assert_eq!(subjects(&second_page), ["fix: Nachtdienst (#1464)"]);
    }

    #[tokio::test]
    async fn reset_moves_the_branch_in_each_mode() {
        let dir = fixture().await;
        let repo = dir.path();
        let base = run_git(repo, &["rev-parse", "HEAD"]).await.unwrap().trim().to_string();
        let commit_edit = |content: &'static str| async move {
            std::fs::write(repo.join("tracked.txt"), content).unwrap();
            git(repo, &["commit", "-q", "-am", content]).await;
        };
        let status = || async { run_git(repo, &["status", "--porcelain"]).await.unwrap() };

        commit_edit("two\n").await;
        reset(repo, &base, ResetMode::Soft).await.unwrap();
        assert_eq!(status().await, "M  tracked.txt\n");

        reset(repo, &base, ResetMode::Mixed).await.unwrap();
        assert_eq!(status().await, " M tracked.txt\n");

        reset(repo, &base, ResetMode::Hard).await.unwrap();
        assert_eq!(status().await, "");
        assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).unwrap(), "one\n");

        commit_edit("three\n").await;
        std::fs::write(repo.join("tracked.txt"), "mine\n").unwrap();
        assert!(reset(repo, &base, ResetMode::Keep).await.unwrap_err().starts_with("failed to reset to"));
        std::fs::write(repo.join("other.txt"), "edited\n").unwrap();
        git(repo, &["checkout", "-q", "--", "tracked.txt"]).await;
        reset(repo, &base, ResetMode::Keep).await.unwrap();
        assert_eq!(status().await, " M other.txt\n");
        assert_eq!(run_git(repo, &["rev-parse", "HEAD"]).await.unwrap().trim(), base);

        assert_eq!(reset(repo, "HEAD", ResetMode::Hard).await.unwrap_err(), "invalid commit id: \"HEAD\"");
    }

    #[test]
    fn is_commit_id_accepts_hex_prefixes_only() {
        assert!(is_commit_id("1a820c75"));
        assert!(!is_commit_id("abc"));
        assert!(!is_commit_id("master"));
        assert!(!is_commit_id("-n"));
    }

    #[test]
    fn changed_entries_pairs_case_only_renames_with_the_same_content() {
        let (old, new, other) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let zero = "0".repeat(40);
        let output = format!(
            ":100644 000000 {old} {zero} D\0src/Foo.ts\0:000000 100644 {zero} {old} A\0src/foo.ts\0:100644 100644 {old} {new} M\0edited.txt\0:000000 100644 {zero} {other} A\0Bar.ts\0:100644 000000 {new} {zero} D\0bar.ts\0"
        );
        let paths = |changes: Vec<(String, TreeChange)>| changes.into_iter().map(|(path, _)| path).collect::<Vec<_>>();
        assert_eq!(paths(changed_entries(&output, true)), ["edited.txt", "Bar.ts", "bar.ts"]);
        assert_eq!(paths(changed_entries(&output, false)), ["src/Foo.ts", "src/foo.ts", "edited.txt", "Bar.ts", "bar.ts"]);
        let changes = changed_entries(&output, true);
        assert_eq!(changes[1], ("Bar.ts".to_string(), TreeChange::Added));
        assert_eq!(changes[2], ("bar.ts".to_string(), TreeChange::Deleted));
        assert!(changed_entries("", true).is_empty());
    }

    #[test]
    fn parse_ignore_rules_names_the_rule_and_skips_negations() {
        let output = ".gitignore\x003\x00*.log\x00debug.log\x00/Users/jane/.config/git/ignore\x001\x00.vscode/\x00.vscode/settings.json\x00.gitignore\x004\x00!keep.log\x00keep.log\x00";
        let rules = parse_ignore_rules(output);
        assert_eq!(rules["debug.log"], ".gitignore:3:*.log");
        assert_eq!(rules[".vscode/settings.json"], "/Users/jane/.config/git/ignore:1:.vscode/");
        assert!(!rules.contains_key("keep.log"));
    }

    #[test]
    fn unified_new_line_ranges_reads_the_new_side_of_every_hunk() {
        let unified = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,4 +1,5 @@\n a\n+b\n c\n@@ -20,3 +21 @@\n-x\n@@ -30,0 +31,2 @@\n+y\n+z\n";
        assert_eq!(unified_new_line_ranges(unified), vec![1..=5, 21..=21, 31..=32]);
    }

    #[test]
    fn unified_new_line_ranges_skips_hunks_without_new_lines() {
        assert_eq!(unified_new_line_ranges("@@ -3,2 +2,0 @@\n-a\n-b\n"), Vec::<RangeInclusive<u32>>::new());
        assert!(unified_new_line_ranges("").is_empty());
    }

    #[test]
    fn session_branch_stem_keeps_conventional_bases_and_prefixes_the_others() {
        assert_eq!(session_branch_stem("master"), "feat/general/master");
        assert_eq!(session_branch_stem("origin/master"), "feat/general/master");
        assert_eq!(session_branch_stem("origin/fix/sentry/admin-ui-errors"), "fix/sentry/admin-ui-errors");
        assert_eq!(session_branch_stem("release/2026"), "feat/general/release/2026");
        assert_eq!(session_branch_stem("feat//x"), "feat/general/feat//x");
    }

    #[tokio::test]
    async fn next_session_branch_counts_up_from_the_highest_numbered_branch() {
        let dir = fixture().await;
        let repo = dir.path();
        assert_eq!(next_session_branch(repo, "main").await.unwrap(), "feat/general/main-1");

        for branch in ["feat/general/main-1", "feat/general/main-3", "feat/general/main-x", "feat/general/main-4-old", "fix/sentry/abc-2"] {
            git(repo, &["branch", branch]).await;
        }
        assert_eq!(next_session_branch(repo, "main").await.unwrap(), "feat/general/main-4");
        assert_eq!(next_session_branch(repo, "origin/main").await.unwrap(), "feat/general/main-4");
        assert_eq!(next_session_branch(repo, "fix/sentry/abc").await.unwrap(), "fix/sentry/abc-3");
    }

    #[tokio::test]
    async fn ensure_new_branch_rejects_invalid_and_existing_names() {
        let dir = fixture().await;
        let repo = dir.path();
        git(repo, &["branch", "feat/general/taken"]).await;
        git(repo, &["update-ref", "refs/remotes/origin/feat/general/pushed", "HEAD"]).await;

        ensure_new_branch(repo, "feat/general/fresh").await.unwrap();
        assert!(ensure_new_branch(repo, "feat/general/taken").await.unwrap_err().contains("exists already"));
        assert!(ensure_new_branch(repo, "feat/general/pushed").await.unwrap_err().contains("exists on origin already"));
        assert!(ensure_new_branch(repo, "bad name").await.unwrap_err().contains("invalid branch name"));
        assert!(ensure_new_branch(repo, "-x").await.unwrap_err().contains("invalid branch name"));
    }

    #[tokio::test]
    async fn switch_to_new_branch_creates_the_branch_at_head_and_keeps_working_changes() {
        let dir = fixture().await;
        let repo = dir.path();
        std::fs::write(repo.join("tracked.txt"), "edited\n").unwrap();
        let head = rev_parse(repo, "HEAD").await.unwrap();

        switch_to_new_branch(repo, "feat/general/fresh").await.unwrap();

        assert_eq!(current_branch(repo).await.unwrap(), "feat/general/fresh");
        assert_eq!(rev_parse(repo, "feat/general/fresh").await.unwrap(), head);
        assert!(local_branch_exists(repo, "main").await);
        assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).unwrap(), "edited\n");
        assert!(switch_to_new_branch(repo, "feat/general/fresh").await.unwrap_err().contains("exists already"));
    }

    async fn git(repo: &Path, args: &[&str]) {
        run_git(repo, args).await.unwrap();
    }

    /// A snapshot store in a temporary directory, which must outlive the store.
    async fn snapshot_store(repo: &Path) -> (tempfile::TempDir, SnapshotStore) {
        let objects = tempfile::tempdir().unwrap();
        let store = SnapshotStore::open(repo, objects.path()).await.unwrap();
        (objects, store)
    }

    /// A repository with one committed file; commits need an identity, which the test sets locally.
    #[tokio::test]
    async fn delete_refs_removes_only_the_refs_below_the_prefix() {
        let dir = fixture().await;
        let repo = dir.path();
        for name in ["refs/hunt/a/handoff", "refs/hunt/a/retrieve", "refs/hunt/ab/handoff"] {
            git(repo, &["update-ref", name, "HEAD"]).await;
        }

        delete_refs(repo, "refs/hunt/a/").await.unwrap();
        delete_refs(repo, "refs/hunt/missing/").await.unwrap();

        let left = run_git(repo, &["for-each-ref", "--format=%(refname)", "refs/hunt/"]).await.unwrap();
        assert_eq!(left.trim(), "refs/hunt/ab/handoff");
    }

    async fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]).await;
        git(repo, &["config", "user.email", "test@example.com"]).await;
        git(repo, &["config", "user.name", "Test"]).await;
        std::fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        std::fs::write(repo.join("other.txt"), "keep\n").unwrap();
        git(repo, &["add", "."]).await;
        git(repo, &["commit", "-q", "-m", "init"]).await;
        dir
    }

    #[tokio::test]
    async fn commit_files_commits_only_the_given_paths() {
        let dir = fixture().await;
        let repo = dir.path();
        std::fs::remove_file(repo.join("tracked.txt")).unwrap();
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        std::fs::write(repo.join("other.txt"), "staged\n").unwrap();
        git(repo, &["add", "other.txt"]).await;

        commit_files(repo, &["tracked.txt".into(), "new.txt".into()], "feat: replace tracked.txt").await.unwrap();

        let committed = run_git(repo, &["show", "--name-status", "--format=%s", "HEAD"]).await.unwrap();
        assert_eq!(committed.trim(), "feat: replace tracked.txt\n\nA\tnew.txt\nD\ttracked.txt");
        let left = run_git(repo, &["status", "--porcelain"]).await.unwrap();
        assert_eq!(left.trim_end(), "M  other.txt");
    }

    #[tokio::test]
    async fn commit_files_refuses_an_empty_message() {
        let dir = fixture().await;
        std::fs::write(dir.path().join("tracked.txt"), "two\n").unwrap();

        assert_eq!(commit_files(dir.path(), &["tracked.txt".into()], " \n").await.unwrap_err(), "commit message must not be empty");
    }

    /// A clone of `origin`, whose `develop` branch exists next to its checked-out `main`, with the session branch
    /// `feat/general/x` created from `origin/develop` and checked out.
    async fn session_clone(origin: &Path, clone_dir: &Path) -> PathBuf {
        git(origin, &["branch", "develop"]).await;
        let repo = clone_dir.join("repo");
        git(clone_dir, &["clone", "-q", origin.to_str().unwrap(), repo.to_str().unwrap()]).await;
        git(&repo, &["checkout", "-q", "-b", "feat/general/x", "origin/develop"]).await;
        repo
    }

    /// Commits `content` of `tracked.txt` on `origin`'s `develop` branch, as a push of someone else would.
    async fn commit_on_origin_develop(origin: &Path, content: &str) -> String {
        git(origin, &["checkout", "-q", "develop"]).await;
        std::fs::write(origin.join("tracked.txt"), content).unwrap();
        git(origin, &["commit", "-q", "-am", "elsewhere"]).await;
        let commit = run_git(origin, &["rev-parse", "HEAD"]).await.unwrap();
        git(origin, &["checkout", "-q", "main"]).await;
        commit
    }

    #[tokio::test]
    async fn push_branch_pushes_head_to_the_base_branch_and_tracks_it() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        commit_files(&repo, &["tracked.txt".into()], "one").await.unwrap();

        push_branch(&repo, "develop").await.unwrap();

        let pushed = run_git(origin.path(), &["rev-parse", "develop"]).await.unwrap();
        assert_eq!(pushed, run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap());
        let upstream = run_git(&repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).await.unwrap();
        assert_eq!(upstream.trim(), "origin/develop");
        let branches = run_git(origin.path(), &["branch", "--list", "feat/general/*"]).await.unwrap();
        assert_eq!(branches.trim(), "");
        assert_eq!(push_branch(&repo, "--all").await.unwrap_err(), "invalid branch name: \"--all\"");
    }

    #[tokio::test]
    async fn push_branch_rebases_onto_the_base_branch_when_origin_moved_on() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        commit_files(&repo, &["new.txt".into()], "session commit").await.unwrap();
        let elsewhere = commit_on_origin_develop(origin.path(), "two\n").await;
        std::fs::write(repo.join("other.txt"), "edited\n").unwrap();

        push_branch(&repo, "develop").await.unwrap();

        let head = run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap();
        assert_eq!(run_git(origin.path(), &["rev-parse", "develop"]).await.unwrap(), head);
        assert_eq!(run_git(&repo, &["rev-parse", "HEAD^"]).await.unwrap(), elsewhere);
        assert_eq!(run_git(&repo, &["log", "-1", "--format=%s"]).await.unwrap().trim(), "session commit");
        assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).unwrap(), "two\n");
        assert_eq!(std::fs::read_to_string(repo.join("other.txt")).unwrap(), "edited\n");
    }

    #[tokio::test]
    async fn push_branch_aborts_a_conflicting_rebase_and_pushes_nothing() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        std::fs::write(repo.join("tracked.txt"), "mine\n").unwrap();
        commit_files(&repo, &["tracked.txt".into()], "session commit").await.unwrap();
        let before = run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap();
        let elsewhere = commit_on_origin_develop(origin.path(), "theirs\n").await;

        let error = push_branch(&repo, "develop").await.unwrap_err();

        assert_eq!(error, "failed to rebase onto origin/develop: conflicts in tracked.txt; resolve them in the chat or by hand");
        assert_eq!(run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap(), before);
        assert_eq!(run_git(origin.path(), &["rev-parse", "develop"]).await.unwrap(), elsewhere);
        assert_eq!(run_git(&repo, &["status", "--porcelain"]).await.unwrap().trim(), "");
        assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).unwrap(), "mine\n");
    }

    #[tokio::test]
    async fn rebase_onto_rebases_the_branch_and_keeps_the_uncommitted_changes() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        commit_files(&repo, &["new.txt".into()], "session commit").await.unwrap();
        let elsewhere = commit_on_origin_develop(origin.path(), "two\n").await;
        git(&repo, &["fetch", "-q", "origin"]).await;
        std::fs::write(repo.join("other.txt"), "edited\n").unwrap();

        rebase_onto(&repo, "origin/develop", "origin/develop").await.unwrap();

        assert_eq!(run_git(&repo, &["rev-parse", "HEAD^"]).await.unwrap(), elsewhere);
        assert_eq!(run_git(&repo, &["log", "-1", "--format=%s"]).await.unwrap().trim(), "session commit");
        assert_eq!(std::fs::read_to_string(repo.join("other.txt")).unwrap(), "edited\n");
        assert_eq!(rebase_onto(&repo, "--root", "--root").await.unwrap_err(), "invalid branch name: \"--root\"");
    }

    #[tokio::test]
    async fn merge_into_head_merges_the_branch_and_aborts_a_conflict() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        commit_files(&repo, &["new.txt".into()], "session commit").await.unwrap();
        let elsewhere = commit_on_origin_develop(origin.path(), "two\n").await;
        git(&repo, &["fetch", "-q", "origin"]).await;

        merge_into_head(&repo, "origin/develop").await.unwrap();

        assert_eq!(run_git(&repo, &["rev-parse", "HEAD^2"]).await.unwrap(), elsewhere);
        assert_eq!(std::fs::read_to_string(repo.join("tracked.txt")).unwrap(), "two\n");

        std::fs::write(repo.join("tracked.txt"), "mine\n").unwrap();
        commit_files(&repo, &["tracked.txt".into()], "mine").await.unwrap();
        let before = run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap();
        commit_on_origin_develop(origin.path(), "theirs\n").await;
        git(&repo, &["fetch", "-q", "origin"]).await;

        let error = merge_into_head(&repo, "origin/develop").await.unwrap_err();

        assert_eq!(error, "failed to merge origin/develop: conflicts in tracked.txt; resolve them in the chat or by hand");
        assert_eq!(run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap(), before);
        assert_eq!(run_git(&repo, &["status", "--porcelain"]).await.unwrap().trim(), "");
    }

    #[tokio::test]
    async fn fast_forward_branch_updates_a_branch_that_is_not_checked_out() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        git(&repo, &["branch", "--track", "develop", "origin/develop"]).await;
        git(&repo, &["branch", "loose"]).await;
        let elsewhere = commit_on_origin_develop(origin.path(), "two\n").await;

        fast_forward_branch(&repo, "develop").await.unwrap();

        assert_eq!(run_git(&repo, &["rev-parse", "develop"]).await.unwrap(), elsewhere);
        assert_eq!(fast_forward_branch(&repo, "loose").await.unwrap_err(), "failed to update loose: it has no upstream");
    }

    #[tokio::test]
    async fn fast_forward_branch_keeps_a_branch_ahead_of_its_upstream_and_refuses_a_diverged_one() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        git(&repo, &["branch", "--track", "develop", "origin/develop"]).await;
        git(&repo, &["checkout", "-q", "develop"]).await;
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        commit_files(&repo, &["new.txt".into()], "local commit").await.unwrap();
        let local = run_git(&repo, &["rev-parse", "develop"]).await.unwrap();
        git(&repo, &["checkout", "-q", "--detach"]).await;

        fast_forward_branch(&repo, "develop").await.unwrap();
        assert_eq!(run_git(&repo, &["rev-parse", "develop"]).await.unwrap(), local);

        commit_on_origin_develop(origin.path(), "two\n").await;
        assert_eq!(
            fast_forward_branch(&repo, "develop").await.unwrap_err(),
            "failed to update develop: it and origin/develop both have commits the other lacks; rebase or merge instead"
        );
        assert_eq!(run_git(&repo, &["rev-parse", "develop"]).await.unwrap(), local);
    }

    #[tokio::test]
    async fn branches_are_renamed_pushed_and_deleted_by_name() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        git(&repo, &["branch", "work", "origin/develop"]).await;
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        commit_files(&repo, &["new.txt".into()], "session commit").await.unwrap();

        rename_branch(&repo, "work", "fix/general/work").await.unwrap();
        push_local_branch(&repo, "fix/general/work").await.unwrap();

        assert!(local_branch_exists(&repo, "fix/general/work").await && !local_branch_exists(&repo, "work").await);
        assert_eq!(run_git(origin.path(), &["rev-parse", "fix/general/work"]).await.unwrap(), run_git(&repo, &["rev-parse", "fix/general/work"]).await.unwrap());
        assert_eq!(run_git(&repo, &["for-each-ref", "--format=%(upstream:short)", "refs/heads/fix/general/work"]).await.unwrap().trim(), "origin/fix/general/work");

        // The session branch has a commit no other branch has: only a forced delete removes it, once it is not checked out.
        git(&repo, &["checkout", "-q", "fix/general/work"]).await;
        let error = delete_local_branch(&repo, "feat/general/x", false).await.unwrap_err();
        assert!(error.contains("not fully merged"), "{error}");
        delete_local_branch(&repo, "feat/general/x", true).await.unwrap();
        assert!(!local_branch_exists(&repo, "feat/general/x").await);

        delete_remote_branch(&repo, "fix/general/work").await.unwrap();
        assert_eq!(run_git(origin.path(), &["branch", "--list", "fix/*"]).await.unwrap().trim(), "");
        assert_eq!(delete_remote_branch(&repo, "-f").await.unwrap_err(), "invalid branch name: \"-f\"");
    }

    #[tokio::test]
    async fn set_origin_upstream_makes_the_branch_track_origin_before_it_was_fetched() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        git(&repo, &["branch", "loose"]).await;
        assert_eq!(origin_upstream(&repo, "feat/general/x").await.as_deref(), Some("develop"));
        assert_eq!(origin_upstream(&repo, "loose").await, None);

        set_origin_upstream(&repo, "feat/general/x", "release/next").await.unwrap();

        assert_eq!(origin_upstream(&repo, "feat/general/x").await.as_deref(), Some("release/next"));
        assert_eq!(run_git(&repo, &["config", "--get", "branch.feat/general/x.remote"]).await.unwrap().trim(), "origin");
        assert_eq!(set_origin_upstream(&repo, "feat/general/x", "--all").await.unwrap_err(), "invalid branch name: \"--all\"");
    }

    #[tokio::test]
    async fn configure_push_makes_git_push_land_on_the_upstream_or_the_own_branch() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        configure_push(&repo).await.unwrap();

        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        commit_files(&repo, &["tracked.txt".into()], "two").await.unwrap();
        git(&repo, &["push", "-q"]).await;
        let head = run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap();
        assert_eq!(run_git(origin.path(), &["rev-parse", "develop"]).await.unwrap(), head);

        git(&repo, &["branch", "--unset-upstream"]).await;
        git(&repo, &["push", "-q"]).await;
        assert_eq!(run_git(origin.path(), &["rev-parse", "feat/general/x"]).await.unwrap(), head);
        assert_eq!(origin_upstream(&repo, "feat/general/x").await.as_deref(), Some("feat/general/x"));
        assert!(run_git(&repo, &["config", "--file", ".git/config", "--get", "push.default"]).await.is_err());
    }

    #[tokio::test]
    async fn unpushed_commit_count_counts_the_commits_the_base_branch_on_origin_lacks() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        assert_eq!(unpushed_commit_count(&repo, "develop").await.unwrap(), 0);

        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        commit_files(&repo, &["tracked.txt".into()], "one").await.unwrap();
        assert_eq!(unpushed_commit_count(&repo, "develop").await.unwrap(), 1);
        assert_eq!(unpushed_commit_count(&repo, "feature/new").await.unwrap(), 1);

        push_branch(&repo, "develop").await.unwrap();
        assert_eq!(unpushed_commit_count(&repo, "develop").await.unwrap(), 0);

        std::fs::write(repo.join("tracked.txt"), "three\n").unwrap();
        commit_files(&repo, &["tracked.txt".into()], "two").await.unwrap();
        std::fs::write(repo.join("tracked.txt"), "four\n").unwrap();
        commit_files(&repo, &["tracked.txt".into()], "three").await.unwrap();
        assert_eq!(unpushed_commit_count(&repo, "develop").await.unwrap(), 2);
    }

    #[tokio::test]
    async fn fetch_branch_tells_whether_origin_has_the_branch() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;

        assert!(fetch_branch(&repo, "develop").await.unwrap());
        assert!(!fetch_branch(&repo, "feature/new").await.unwrap());
        assert!(!is_behind_origin(&repo, "feature/new").await);
        assert!(!is_behind_origin(&repo, "develop").await);
        commit_on_origin_develop(origin.path(), "two\n").await;
        assert!(!is_behind_origin(&repo, "develop").await);
        assert!(fetch_branch(&repo, "develop").await.unwrap());
        assert!(is_behind_origin(&repo, "develop").await);
    }

    #[tokio::test]
    async fn ensure_origin_branch_creates_a_missing_branch_at_origins_from_and_only_fetches_an_existing_one() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = session_clone(origin.path(), clone_dir.path()).await;
        // `develop` moves on `origin` after the clone, so the clone lacks the commit the new branch starts at.
        let moved = commit_on_origin_develop(origin.path(), "two\n").await;

        ensure_origin_branch(&repo, "feature/new", "develop").await.unwrap();

        assert_eq!(run_git(origin.path(), &["rev-parse", "feature/new"]).await.unwrap(), moved);
        assert_eq!(run_git(&repo, &["rev-parse", "origin/feature/new"]).await.unwrap(), moved);

        // `old` stays behind `develop` even though moving it there would be a fast-forward.
        git(origin.path(), &["branch", "old", "main"]).await;
        let old = run_git(origin.path(), &["rev-parse", "old"]).await.unwrap();
        ensure_origin_branch(&repo, "old", "develop").await.unwrap();
        assert_eq!(run_git(origin.path(), &["rev-parse", "old"]).await.unwrap(), old);
        assert_eq!(run_git(&repo, &["rev-parse", "origin/old"]).await.unwrap(), old);

        assert!(ensure_origin_branch(&repo, "feature/other", "missing").await.is_err());
        assert!(run_git(origin.path(), &["rev-parse", "--verify", "feature/other"]).await.is_err());
    }

    async fn head_branch(worktree: &Path) -> String {
        run_git(worktree, &["symbolic-ref", "--short", "HEAD"]).await.unwrap().trim().to_string()
    }

    #[tokio::test]
    async fn worktree_add_on_branch_checks_the_existing_local_branch_out() {
        let dir = fixture().await;
        let repo = dir.path();
        git(repo, &["branch", "feature/med/623-scope-filter"]).await;
        let worktrees = tempfile::tempdir().unwrap();
        let worktree = worktrees.path().join("review");

        let created = worktree_add_on_branch(repo, "feature/med/623-scope-filter", &worktree, "origin/feature/med/623-scope-filter").await;
        assert!(!created.unwrap());
        assert_eq!(head_branch(&worktree).await, "feature/med/623-scope-filter");
    }

    #[tokio::test]
    async fn worktree_add_on_branch_creates_a_local_branch_tracking_the_remote_one() {
        let origin = fixture().await;
        git(origin.path(), &["branch", "fix/sentry/admin-ui-errors"]).await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = clone_dir.path().join("repo");
        git(clone_dir.path(), &["clone", "-q", origin.path().to_str().unwrap(), repo.to_str().unwrap()]).await;
        assert!(!local_branch_exists(&repo, "fix/sentry/admin-ui-errors").await);
        let worktree = clone_dir.path().join("review");

        let created = worktree_add_on_branch(&repo, "fix/sentry/admin-ui-errors", &worktree, "origin/fix/sentry/admin-ui-errors").await;
        assert!(created.unwrap());
        assert_eq!(head_branch(&worktree).await, "fix/sentry/admin-ui-errors");
        let upstream = run_git(&worktree, &["rev-parse", "--abbrev-ref", "@{upstream}"]).await.unwrap();
        assert_eq!(upstream.trim(), "origin/fix/sentry/admin-ui-errors");
    }

    #[tokio::test]
    async fn worktree_add_on_branch_refuses_a_branch_checked_out_elsewhere() {
        let dir = fixture().await;
        let repo = dir.path();
        git(repo, &["branch", "feat/review"]).await;
        let worktrees = tempfile::tempdir().unwrap();
        worktree_add_on_branch(repo, "feat/review", &worktrees.path().join("first"), "origin/feat/review").await.unwrap();

        // git names a worktree by its resolved path, which differs from the temporary one on macOS (/private/var/…).
        let second = worktree_add_on_branch(repo, "feat/review", &worktrees.path().join("second"), "origin/feat/review").await.unwrap_err();
        assert!(second.starts_with("failed to create the session's worktree: branch feat/review is already checked out in /"), "{second}");
        assert!(second.ends_with("/first"), "{second}");
        let main = worktree_add_on_branch(repo, "main", &worktrees.path().join("third"), "origin/main").await.unwrap_err();
        let repo_name = repo.file_name().unwrap().to_str().unwrap();
        assert!(main.contains("branch main is already checked out in /") && main.ends_with(&format!("/{repo_name}")), "{main}");
        assert!(!worktrees.path().join("second").exists() && !worktrees.path().join("third").exists());

        let invalid = worktree_add_on_branch(repo, "-x", &worktrees.path().join("fourth"), "main").await;
        assert_eq!(invalid.unwrap_err(), "failed to create the session's worktree: invalid branch name \"-x\"");
    }

    #[tokio::test]
    async fn exclude_hunt_dir_replaces_the_former_folder_name_and_runs_once() {
        let dir = fixture().await;
        let repo = dir.path();
        let exclude = repo.join(".git/info/exclude");
        std::fs::write(&exclude, "*.tmp\n.harness/\n").unwrap();

        exclude_hunt_dir(repo).await.unwrap();
        assert_eq!(std::fs::read_to_string(&exclude).unwrap(), "*.tmp\n.hunt/\n");

        exclude_hunt_dir(repo).await.unwrap();
        assert_eq!(std::fs::read_to_string(&exclude).unwrap(), "*.tmp\n.hunt/\n");
    }

    #[tokio::test]
    async fn snapshot_tree_captures_the_working_tree_without_touching_the_index() {
        let dir = fixture().await;
        let repo = dir.path();
        let head_tree = run_git(repo, &["rev-parse", "HEAD^{tree}"]).await.unwrap().trim().to_string();

        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        std::fs::write(repo.join("new.txt"), "fresh\n").unwrap();
        std::fs::write(repo.join("ignored.log"), "noise\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.log\n").unwrap();

        let (_objects, store) = snapshot_store(repo).await;
        let tree = snapshot_tree(repo, &store).await.unwrap();
        let changed = changed_paths_between(repo, &store, &head_tree, &tree).await.unwrap();
        assert_eq!(changed, vec![".gitignore".to_string(), "new.txt".to_string(), "tracked.txt".to_string()]);

        // Nothing was staged: the real index still equals HEAD.
        let staged = run_git(repo, &["diff", "--cached", "--name-only"]).await.unwrap();
        assert_eq!(staged.trim(), "");
        assert_eq!(snapshot_tree(repo, &store).await.unwrap(), tree);
        // The snapshot's objects live in the store, not in the repository.
        assert!(run_git(repo, &["cat-file", "-e", &tree]).await.is_err());
    }

    #[tokio::test]
    async fn files_containing_word_matches_whole_words_in_tracked_and_untracked_files() {
        let dir = fixture().await;
        let repo = dir.path();
        std::fs::write(repo.join("tracked.txt"), "class UserListQuery {}\n").unwrap();
        std::fs::write(repo.join("other.txt"), "UserListQueryPage\n").unwrap();
        std::fs::write(repo.join("new.ts"), "new UserListQuery()\n").unwrap();
        std::fs::write(repo.join("ignored.ts"), "UserListQuery\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.ts\n").unwrap();

        let files = files_containing_word(repo, "UserListQuery").await.unwrap();
        assert_eq!(files, vec!["new.ts".to_string(), "tracked.txt".to_string()]);
        assert_eq!(files_containing_word(repo, "Missing").await.unwrap(), Vec::<String>::new());
        assert!(files_containing_word(repo, "--help").await.is_err());
    }

    #[test]
    fn parse_numstat_reads_counts_and_treats_binary_files_as_empty() {
        let stats = parse_numstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t12\tdir with space/b.txt\n");
        let summary: Vec<(&str, u32, u32)> = stats.iter().map(|stat| (stat.path.as_str(), stat.added, stat.removed)).collect();
        assert_eq!(summary, vec![("src/a.ts", 3, 1), ("logo.png", 0, 0), ("dir with space/b.txt", 0, 12)]);
        assert!(parse_numstat("").is_empty());
    }

    #[test]
    fn count_lines_counts_like_git() {
        assert_eq!(count_lines(""), 0);
        assert_eq!(count_lines("one\n"), 1);
        assert_eq!(count_lines("one\ntwo"), 2);
        assert_eq!(count_lines("one\ntwo\n"), 2);
    }

    #[tokio::test]
    async fn change_stats_combines_tracked_diff_and_untracked_files() {
        let dir = fixture().await;
        let repo = dir.path();
        std::fs::write(repo.join("tracked.txt"), "uno\ndos\n").unwrap();
        std::fs::write(repo.join("new.txt"), "a\nb\nc").unwrap();
        std::fs::write(repo.join("image.bin"), [0u8, 159, 146, 150]).unwrap();

        let stats = change_stats(repo, "HEAD").await.unwrap();
        let summary: Vec<(&str, u32, u32)> = stats.iter().map(|stat| (stat.path.as_str(), stat.added, stat.removed)).collect();
        assert_eq!(summary, vec![("image.bin", 0, 0), ("new.txt", 3, 0), ("tracked.txt", 2, 1)]);
    }

    #[tokio::test]
    async fn snapshot_tree_records_deletions() {
        let dir = fixture().await;
        let repo = dir.path();
        let (_objects, store) = snapshot_store(repo).await;
        let before = snapshot_tree(repo, &store).await.unwrap();

        std::fs::remove_file(repo.join("other.txt")).unwrap();

        let after = snapshot_tree(repo, &store).await.unwrap();
        assert_eq!(changed_paths_between(repo, &store, &before, &after).await.unwrap(), vec!["other.txt".to_string()]);
    }

    #[tokio::test]
    async fn blob_ids_at_finds_each_version_of_a_file() {
        let dir = fixture().await;
        let repo = dir.path();
        let (_objects, store) = snapshot_store(repo).await;
        let first = snapshot_tree(repo, &store).await.unwrap();
        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        let second = snapshot_tree(repo, &store).await.unwrap();
        std::fs::remove_file(repo.join("tracked.txt")).unwrap();
        let third = snapshot_tree(repo, &store).await.unwrap();

        let ids = blob_ids_at(repo, &store, &[first, second, third], "tracked.txt").await.unwrap();
        let contents = [read_blob(repo, &store, ids[0].as_deref().unwrap()).await.unwrap(), read_blob(repo, &store, ids[1].as_deref().unwrap()).await.unwrap()];
        assert_eq!(contents, ["one\n".to_string(), "two\n".to_string()]);
        assert_eq!(ids[2], None);
    }

    #[tokio::test]
    async fn list_files_skips_ignored_and_deleted_files() {
        let dir = fixture().await;
        let repo = dir.path();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/new.ts"), "").unwrap();
        std::fs::write(repo.join("ignored.log"), "noise\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.log\n").unwrap();
        std::fs::remove_file(repo.join("other.txt")).unwrap();

        let files = list_files(repo).await.unwrap();
        assert_eq!(files, vec![".gitignore".to_string(), "src/new.ts".to_string(), "tracked.txt".to_string()]);
    }

    #[test]
    fn ensure_inside_worktree_accepts_relative_paths_only() {
        for path in ["", "src", "src/app/user.ts", "./src/app.ts", "dir with space/b.txt", "..hidden/file", "a..b"] {
            assert!(ensure_inside_worktree(path).is_ok(), "{path:?} should be accepted");
        }
        for path in ["/etc/passwd", "/", "..", "../secret", "src/../../secret", "src/..", "./.."] {
            assert!(ensure_inside_worktree(path).is_err(), "{path:?} should be rejected");
        }
    }

    #[test]
    fn ensure_stash_reference_accepts_only_numbered_stash_entries() {
        assert!(ensure_stash_reference("stash@{0}").is_ok());
        assert!(ensure_stash_reference("stash@{12}").is_ok());
        for reference in ["", "stash", "stash@{}", "stash@{a}", "stash@{-1}", "HEAD", "--all", "stash@{0}^1", "refs/stash"] {
            assert!(ensure_stash_reference(reference).is_err(), "{reference:?} should be rejected");
        }
    }

    #[tokio::test]
    async fn rev_parse_resolves_refs_and_rejects_options() {
        let dir = fixture().await;
        let repo = dir.path();
        let head = run_git(repo, &["rev-parse", "HEAD"]).await.unwrap().trim().to_string();

        assert_eq!(rev_parse(repo, "main").await.unwrap(), head);
        assert_eq!(rev_parse(repo, DIFF_BASE).await.unwrap(), head);
        assert!(rev_parse(repo, "--git-dir=/nowhere").await.is_err());
        assert!(rev_parse(repo, "-q").await.is_err());
        assert!(rev_parse(repo, "").await.is_err());
        assert!(rev_parse(repo, "no-such-branch").await.is_err());
    }

    #[tokio::test]
    async fn merge_base_finds_the_fork_point_of_a_branch() {
        let dir = fixture().await;
        let repo = dir.path();
        let fork_point = run_git(repo, &["rev-parse", "HEAD"]).await.unwrap().trim().to_string();
        git(repo, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        git(repo, &["commit", "-q", "-am", "feature"]).await;
        git(repo, &["checkout", "-q", "main"]).await;
        std::fs::write(repo.join("other.txt"), "moved on\n").unwrap();
        git(repo, &["commit", "-q", "-am", "main"]).await;

        assert_eq!(merge_base(repo, "main", "feature").await.unwrap(), fork_point);
        assert!(merge_base(repo, "--all", "feature").await.is_err());
        assert!(merge_base(repo, "main", "").await.is_err());
    }
}
