//! Git operations Hunt needs: one worktree per session, the uncommitted changes of that
//! worktree against `HEAD`, and committing, pushing or shelving them. Everything shells out to
//! the `git` CLI so hooks, config and credential behavior match the terminal.

use std::ffi::OsStr;
use std::ops::RangeInclusive;
use std::path::Path;

use serde::Serialize;
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

pub async fn delete_branch(repo: &Path, branch: &str) -> Result<(), String> {
    run_git(repo, &["branch", "-D", branch]).await?;
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
fn ensure_paths(paths: &[String]) -> Result<(), String> {
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

/// Pushes the worktree's current branch to the branch of the same name on `origin` and makes that its upstream, which
/// for a session branch created from `origin/<default branch>` is that default branch until the first push.
pub async fn push_branch(worktree: &Path) -> Result<(), String> {
    if current_branch(worktree).await? == "HEAD" {
        return Err("the worktree has no branch checked out".into());
    }
    run_git(worktree, &["push", "-q", "-u", "--", "origin", "HEAD"]).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn push_branch_pushes_to_the_branch_of_the_same_name_and_tracks_it() {
        let origin = fixture().await;
        let clone_dir = tempfile::tempdir().unwrap();
        let repo = clone_dir.path().join("repo");
        git(clone_dir.path(), &["clone", "-q", origin.path().to_str().unwrap(), repo.to_str().unwrap()]).await;
        git(&repo, &["checkout", "-q", "--track", "-b", "feat/general/x", "origin/main"]).await;

        push_branch(&repo).await.unwrap();

        let pushed = run_git(origin.path(), &["rev-parse", "feat/general/x"]).await.unwrap();
        assert_eq!(pushed, run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap());
        let upstream = run_git(&repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).await.unwrap();
        assert_eq!(upstream.trim(), "origin/feat/general/x");
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
