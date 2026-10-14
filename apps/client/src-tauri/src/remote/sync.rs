//! Two-way sync of a remote session's files between its worktree on the VM and its local worktree, so that the diff,
//! the editor and the diagram show the agent's changes and local edits reach the agent. Each side lists the files Git
//! sees there (`git ls-files --cached --others --exclude-standard`: tracked and untracked, not ignored) with their size
//! and modification time. The manifest holds both sides' state after the last sync, so a difference tells which side
//! changed a file: a file changed here goes to the VM, also when the agent changed it too (the local version wins); a
//! file changed only on the VM comes here; deletions follow the same rule. A file whose content did not change (same
//! blob as at the last sync) counts as unchanged, and two files of equal size and modification second count as in sync.
//! Before the first sync, the snapshot both sides started from (the handoff's, or the adoption's) tells the local edits;
//! every other file takes the VM's version.
//!
//! A file present on a side without being listed there (other ignore rules on the Mac and the VM) is never touched. On
//! a case-insensitive Mac (`core.ignorecase`) paths are compared ignoring case, the VM's spelling wins, and two VM files
//! whose names differ only in case are reported instead of synced. rsync moves the content over the session's SSH
//! connection as the VM's `agent` user; files from the VM land in a staging folder first and replace a local file only
//! while it is unchanged since the listing. Whatever completed is recorded even when a later step fails, and a file
//! that cannot move (a folder on the other side) is reported without failing the rest. Knows nothing about Tauri.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::shell_command;
use super::ssh::Ssh;
use crate::git;

/// The rsync the VM runs: as the agent's user, who owns the session's worktree.
const REMOTE_RSYNC: &str = "sudo -n -u agent rsync";

/// The record the scripts print before their listing, which tells an empty listing from a script that never ran.
const MARKER: &[u8] = b"hunt-sync";
/// The record `LIST_SCRIPT` prints before the asked paths that exist without being listed.
const UNLISTED_MARKER: &[u8] = b"hunt-sync-unlisted";

/// Where a sync stages the files it brings from the VM: in the local diagram folder, which neither syncs nor is watched.
const STAGING_DIR: &str = ".hunt/sync-staging";

const NANOS_PER_SECOND: i64 = 1_000_000_000;

/// Prints `MARKER` and `<size> <seconds>.<nanoseconds> <mode in hex> <path>` for every file Git sees in the worktree
/// `$1`, then `UNLISTED_MARKER` and the same for every path on stdin (NUL-separated) that exists without being listed.
/// Every record ends with NUL; a file deleted since Git listed it is left out.
const LIST_SCRIPT: &str = r#"
set -euo pipefail
cd -- "$1"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
git ls-files -z --cached --others --exclude-standard >"$scratch/listed"
cat >"$scratch/asked"
printf 'hunt-sync\0'
LC_ALL=C xargs -0r stat --printf '%s %.9Y %f %n\0' -- <"$scratch/listed" 2>/dev/null || true
printf 'hunt-sync-unlisted\0'
LC_ALL=C sort -zu "$scratch/listed" >"$scratch/listed.sorted"
LC_ALL=C sort -zu "$scratch/asked" | LC_ALL=C comm -z -23 - "$scratch/listed.sorted" |
  LC_ALL=C xargs -0r stat --printf '%s %.9Y %f %n\0' -- 2>/dev/null || true
"#;

/// Reads `<d|s> <path>` records ended by NUL from stdin, deletes the `d` paths in the worktree `$1` with the folders
/// they leave empty, and prints `MARKER` and the state of every path that still exists afterwards, as `LIST_SCRIPT`
/// does.
const APPLY_SCRIPT: &str = r#"
set -euo pipefail
cd -- "$1"
paths=()
while IFS= read -r -d '' entry; do
  path=${entry:2}
  if [[ ${entry:0:2} == 'd ' ]]; then
    rm -f -- "$path" 2>/dev/null || true
    rmdir -p --ignore-fail-on-non-empty -- "$(dirname -- "$path")" 2>/dev/null || true
  fi
  paths+=("$path")
done
printf 'hunt-sync\0'
if (( ${#paths[@]} )); then
  printf '%s\0' "${paths[@]}" | LC_ALL=C xargs -0r stat --printf '%s %.9Y %f %n\0' -- 2>/dev/null || true
fi
"#;

/// The size and modification time (nanoseconds since the epoch) of a file on one side, which tell that it changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub size: u64,
    pub modified_ns: i64,
}

impl FileState {
    /// Whether `other` looks like this file as rsync copies it: the same size and modification second (protocol 29
    /// carries seconds).
    pub fn matches(&self, other: &FileState) -> bool {
        self.size == other.size && self.modified_ns.div_euclid(NANOS_PER_SECOND) == other.modified_ns.div_euclid(NANOS_PER_SECOND)
    }
}

/// The files of one side, by worktree-relative path.
pub type Listing = BTreeMap<String, FileState>;

/// A file both sides had after a sync, with its state on each and the blob id of its content then, when known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedFile {
    pub local: FileState,
    pub remote: FileState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

/// Both sides' state after the last sync, by the path the VM has.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub files: BTreeMap<String, SyncedFile>,
}

/// How paths of the two sides are matched: as they are, or ignoring case where the local file system does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keys {
    pub ignore_case: bool,
}

impl Keys {
    pub fn of(&self, path: &str) -> String {
        if self.ignore_case {
            path.to_lowercase()
        } else {
            path.to_string()
        }
    }
}

/// A file of one side under its key: the path it has there and its state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub state: FileState,
}

/// What the sides are compared against.
#[derive(Debug, Clone, Copy)]
pub enum Base<'a> {
    /// The state after the last sync.
    Manifest(&'a Manifest),
    /// No sync ran yet: the keys of the paths in which the local worktree differs from the snapshot both sides started
    /// from. They are local edits; every other file takes the VM's version.
    Snapshot(&'a BTreeSet<String>),
}

/// Everything a plan is made from.
pub struct Inputs<'a> {
    pub base: Base<'a>,
    pub local: &'a Listing,
    pub remote: &'a Listing,
    pub keys: Keys,
    /// Keys of files that exist on a side without being listed there (other ignore rules); they are never touched.
    pub unlisted: &'a BTreeSet<String>,
    /// Local paths whose state changed since the last sync while their content did not.
    pub same_content: &'a BTreeSet<String>,
}

/// What one sync does. Paths to send, bring and delete on the VM are the VM's spelling; local deletions name the local
/// file.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Plan {
    pub push: Vec<String>,
    pub pull: Vec<String>,
    pub delete_remote: Vec<String>,
    pub delete_local: Vec<String>,
    /// Keys left alone because several names fall under them, and why.
    pub collisions: BTreeMap<String, String>,
}

/// What a sync changed, and the files it could not sync.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub pushed: usize,
    pub pulled: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    /// One line per file that could not sync, with the reason.
    pub conflicts: Vec<String>,
}

impl Outcome {
    /// Whether the sync changed files in the local worktree.
    pub fn changed_local(&self) -> bool {
        self.pulled > 0 || self.deleted_local > 0
    }
}

/// The session whose files a sync moves: its local worktree, its worktree on the VM, where its manifest lives and the
/// ref of the snapshot both sides started from (the handoff's or the adoption's).
pub struct SyncTarget<'a> {
    pub local: &'a Path,
    pub remote: &'a str,
    pub manifest: &'a Path,
    pub base_ref: &'a str,
}

/// Which way rsync copies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// From the local worktree to the VM.
    Push,
    /// From the VM to the local worktree.
    Pull,
}

/// The changes of a sync that completed, by key; keys missing here keep their listed state.
#[derive(Debug, Default)]
pub struct Applied {
    /// Local files the sync changed: `Some` with their new state, `None` once deleted.
    pub local: BTreeMap<String, Option<Entry>>,
    /// Files on the VM the sync changed.
    pub remote: BTreeMap<String, Option<Entry>>,
    /// Keys whose change did not complete; they keep their manifest entry, so the next sync tries again.
    pub kept: BTreeSet<String>,
    /// The content of the files that moved, by key.
    pub blobs: BTreeMap<String, String>,
}

/// `listing` by key; a key several paths fall under is left out and noted in `collisions` with the names.
fn by_key(listing: &Listing, keys: Keys, collisions: &mut BTreeMap<String, String>, side: &str) -> BTreeMap<String, Entry> {
    let mut grouped: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
    for (path, state) in listing {
        grouped.entry(keys.of(path)).or_default().push(Entry { path: path.clone(), state: *state });
    }
    let mut entries = BTreeMap::new();
    for (key, mut group) in grouped {
        if group.len() > 1 {
            let names: Vec<&str> = group.iter().map(|entry| entry.path.as_str()).collect();
            collisions.insert(key, format!("{} differ only in case {side}; this Mac cannot hold them side by side", names.join(" and ")));
            continue;
        }
        entries.insert(key, group.remove(0));
    }
    entries
}

/// The manifest's files by key, with the path the VM has.
fn manifest_by_key(manifest: &Manifest, keys: Keys) -> BTreeMap<String, (&String, &SyncedFile)> {
    manifest.files.iter().map(|(path, file)| (keys.of(path), (path, file))).collect()
}

/// What syncing the sides of `inputs` takes; see the module comment.
pub fn plan(inputs: &Inputs<'_>) -> Plan {
    let keys = inputs.keys;
    let mut plan = Plan::default();
    let local = by_key(inputs.local, keys, &mut plan.collisions, "here");
    let remote = by_key(inputs.remote, keys, &mut plan.collisions, "on the VM");
    let synced = match inputs.base {
        Base::Manifest(manifest) => manifest_by_key(manifest, keys),
        Base::Snapshot(_) => BTreeMap::new(),
    };
    let all: BTreeSet<&String> = local.keys().chain(remote.keys()).chain(synced.keys()).collect();
    for key in all {
        if inputs.unlisted.contains(key) || plan.collisions.contains_key(key) {
            continue;
        }
        let (here, there, last) = (local.get(key), remote.get(key), synced.get(key));
        let renamed_there = matches!((there, last), (Some(there), Some((path, _))) if there.path != **path);
        if let (Some(here), Some(there)) = (here, there) {
            if here.state.matches(&there.state) && !renamed_there {
                continue;
            }
        }
        let (changed_here, changed_there) = match inputs.base {
            Base::Manifest(_) => {
                let changed_here = match (here, last) {
                    (None, None) => false,
                    (Some(here), Some((_, file))) => here.state != file.local && !inputs.same_content.contains(&here.path),
                    _ => true,
                };
                let changed_there = match (there, last) {
                    (None, None) => false,
                    (Some(there), Some((_, file))) => there.state != file.remote || renamed_there,
                    _ => true,
                };
                (changed_here, changed_there)
            }
            Base::Snapshot(edits) => (edits.contains(key), true),
        };
        if changed_here {
            match (here, there) {
                (Some(here), _) => {
                    let name = there.map(|there| &there.path).or(last.map(|(path, _)| *path)).unwrap_or(&here.path);
                    plan.push.push(name.clone());
                }
                (None, Some(there)) => plan.delete_remote.push(there.path.clone()),
                (None, None) => {}
            }
        } else if changed_there {
            match (there, here) {
                (Some(there), _) => plan.pull.push(there.path.clone()),
                (None, Some(here)) => plan.delete_local.push(here.path.clone()),
                (None, None) => {}
            }
        }
    }
    plan
}

/// The manifest after a sync that compared `local` and `remote` against `base` and completed what `applied` holds: an
/// entry per key both sides have, with the VM's path. Unlisted keys lose their entry, kept keys keep the old one.
pub fn next_manifest(
    base: Option<&Manifest>,
    local: &Listing,
    remote: &Listing,
    keys: Keys,
    unlisted: &BTreeSet<String>,
    same_content: &BTreeSet<String>,
    applied: &Applied,
) -> Manifest {
    let mut ignored = BTreeMap::new();
    let mut here = by_key(local, keys, &mut ignored, "");
    let mut there = by_key(remote, keys, &mut ignored, "");
    for (key, entry) in &applied.local {
        match entry {
            Some(entry) => here.insert(key.clone(), entry.clone()),
            None => here.remove(key),
        };
    }
    for (key, entry) in &applied.remote {
        match entry {
            Some(entry) => there.insert(key.clone(), entry.clone()),
            None => there.remove(key),
        };
    }
    let previous = base.map(|manifest| manifest_by_key(manifest, keys)).unwrap_or_default();
    let all: BTreeSet<String> = here.keys().chain(there.keys()).chain(previous.keys()).cloned().collect();
    let mut files = BTreeMap::new();
    for key in all {
        if unlisted.contains(&key) {
            continue;
        }
        if applied.kept.contains(&key) || ignored.contains_key(&key) {
            if let Some((path, file)) = previous.get(&key) {
                files.insert((*path).clone(), (*file).clone());
            }
            continue;
        }
        let (Some(local_file), Some(remote_file)) = (here.get(&key), there.get(&key)) else { continue };
        let blob = match applied.blobs.get(&key) {
            Some(blob) => Some(blob.clone()),
            None => previous.get(&key).and_then(|(_, file)| {
                let is_same = file.local == local_file.state || same_content.contains(&local_file.path);
                file.blob.clone().filter(|_| is_same)
            }),
        };
        files.insert(remote_file.path.clone(), SyncedFile { local: local_file.state, remote: remote_file.state, blob });
    }
    Manifest { files }
}

/// Syncs the files of `target` over `ssh` (see the module comment) and records the new manifest, also when a step
/// failed midway; the first such failure is returned after that.
pub async fn sync(target: &SyncTarget<'_>, ssh: &Ssh) -> Result<Outcome, String> {
    let keys = Keys { ignore_case: git::ignores_case(target.local).await };
    let manifest = read_manifest(target.manifest)?;
    let local = list_local(target.local).await?;
    let synced_paths = manifest.iter().flat_map(|manifest| manifest.files.keys());
    let asked: BTreeSet<&str> = local.keys().chain(synced_paths).map(String::as_str).collect();
    let (remote, remote_unlisted) = list_remote(ssh, target.remote, &asked).await?;
    let unlisted = unlisted_keys(target.local, &local, &remote, &remote_unlisted, manifest.as_ref(), keys);
    let edits = match manifest {
        Some(_) => BTreeSet::new(),
        None => local_edits(target.local, target.base_ref, keys).await?,
    };
    let base = match &manifest {
        Some(manifest) => Base::Manifest(manifest),
        None => Base::Snapshot(&edits),
    };
    let same_content = match &manifest {
        Some(manifest) => unchanged_content(target.local, manifest, &local, keys).await,
        None => BTreeSet::new(),
    };
    let plan = plan(&Inputs { base, local: &local, remote: &remote, keys, unlisted: &unlisted, same_content: &same_content });

    let mut ignored = BTreeMap::new();
    let mut run = Run {
        target,
        keys,
        local: by_key(&local, keys, &mut ignored, ""),
        remote: by_key(&remote, keys, &mut ignored, ""),
        applied: Applied::default(),
        outcome: Outcome::default(),
        failure: None,
    };
    run.outcome.conflicts.extend(plan.collisions.values().cloned());
    run.applied.kept.extend(plan.collisions.keys().cloned());
    run.push_and_delete_remote(ssh, &plan).await;
    run.delete_local(&plan.delete_local);
    run.pull(ssh, &plan.pull).await;
    run.hash_moved_files().await;

    let Run { applied, outcome, failure, .. } = run;
    let next = next_manifest(manifest.as_ref(), &local, &remote, keys, &unlisted, &same_content, &applied);
    if manifest.as_ref() != Some(&next) {
        write_manifest(target.manifest, &next)?;
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(outcome),
    }
}

/// The steps of one sync and what they completed.
struct Run<'a> {
    target: &'a SyncTarget<'a>,
    keys: Keys,
    /// The listings by key.
    local: BTreeMap<String, Entry>,
    remote: BTreeMap<String, Entry>,
    applied: Applied,
    outcome: Outcome,
    /// The first step that failed as a whole.
    failure: Option<String>,
}

impl Run<'_> {
    fn fail(&mut self, error: String) {
        self.failure.get_or_insert(error);
    }

    /// The local file under `key` as the listing had it.
    fn listed_here(&self, key: &str) -> Option<(&String, FileState)> {
        self.local.get(key).map(|entry| (&entry.path, entry.state))
    }

    fn listed_there(&self, key: &str) -> Option<FileState> {
        self.remote.get(key).map(|entry| entry.state)
    }

    /// Sends `plan.push` and deletes `plan.delete_remote` on the VM, then records what the VM has afterwards.
    async fn push_and_delete_remote(&mut self, ssh: &Ssh, plan: &Plan) {
        if plan.push.is_empty() && plan.delete_remote.is_empty() {
            return;
        }
        let sent = transfer(ssh, Direction::Push, self.target.local, self.target.remote, &plan.push, None).await;
        if let Err(error) = &sent {
            self.fail(error.clone());
        }
        let after = match apply_remote(ssh, self.target.remote, &plan.delete_remote, &plan.push).await {
            Ok(after) => after,
            Err(error) => {
                self.fail(error);
                self.applied.kept.extend(plan.push.iter().chain(&plan.delete_remote).map(|path| self.keys.of(path)));
                return;
            }
        };
        for path in &plan.push {
            let key = self.keys.of(path);
            let sent_state = self.listed_here(&key).map(|(_, state)| state);
            match (after.get(path), sent_state) {
                (Some(state), Some(sent_state)) if state.matches(&sent_state) => {
                    self.applied.remote.insert(key, Some(Entry { path: path.clone(), state: *state }));
                    self.outcome.pushed += 1;
                }
                _ => {
                    self.applied.kept.insert(key);
                    self.outcome.conflicts.push(format!("{path}: could not be sent to the VM{}", reason(&sent, path)));
                }
            }
        }
        for path in &plan.delete_remote {
            let key = self.keys.of(path);
            if after.contains_key(path) {
                self.applied.kept.insert(key);
                self.outcome.conflicts.push(format!("{path}: could not be deleted on the VM"));
            } else {
                self.applied.remote.insert(key, None);
                self.outcome.deleted_remote += 1;
            }
        }
    }

    /// Deletes `paths` here with the folders they leave empty, each only while it is unchanged since the listing.
    fn delete_local(&mut self, paths: &[String]) {
        for path in paths {
            let key = self.keys.of(path);
            let listed = self.listed_here(&key).map(|(_, state)| state);
            if local_state(self.target.local, path) != listed {
                // Changed here since the listing: the local version wins at the next sync.
                self.applied.kept.insert(key);
                continue;
            }
            match std::fs::remove_file(self.target.local.join(path)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    self.applied.kept.insert(key);
                    self.outcome.conflicts.push(format!("{path}: could not be deleted here: {error}"));
                }
                _ => {
                    prune_empty_parents(self.target.local, path);
                    self.applied.local.insert(key, None);
                    self.outcome.deleted_local += 1;
                }
            }
        }
    }

    /// Brings `paths` from the VM into the staging folder and moves each into the worktree while the local file is
    /// unchanged since the listing and the staged one is what the VM listed.
    async fn pull(&mut self, ssh: &Ssh, paths: &[String]) {
        if paths.is_empty() {
            return;
        }
        let staging = self.target.local.join(STAGING_DIR);
        let _ = std::fs::remove_dir_all(&staging);
        if let Err(error) = std::fs::create_dir_all(&staging) {
            self.fail(format!("failed to create {}: {error}", staging.display()));
            self.applied.kept.extend(paths.iter().map(|path| self.keys.of(path)));
            return;
        }
        let brought = transfer(ssh, Direction::Pull, self.target.local, self.target.remote, paths, Some(&staging)).await;
        if let Err(error) = &brought {
            self.fail(error.clone());
        }
        for path in paths {
            let key = self.keys.of(path);
            match self.move_in(&staging, path, &key) {
                Ok(true) => self.outcome.pulled += 1,
                Ok(false) => {
                    self.applied.kept.insert(key);
                }
                Err(problem) => {
                    self.applied.kept.insert(key);
                    self.outcome.conflicts.push(format!("{path}: {problem}{}", reason(&brought, path)));
                }
            }
        }
        let _ = std::fs::remove_dir_all(&staging);
    }

    /// Moves the staged `path` in; false when the VM or the local file changed meanwhile, which the next sync handles.
    fn move_in(&mut self, staging: &Path, path: &str, key: &str) -> Result<bool, String> {
        let expected = self.listed_there(key).ok_or("the VM did not list it")?;
        let staged = local_state(staging, path).ok_or("could not be brought from the VM")?;
        if !staged.matches(&expected) {
            return Ok(false);
        }
        let listed = self.listed_here(key).map(|(path, state)| (path.clone(), state));
        let local_path = listed.as_ref().map(|(path, _)| path.as_str()).unwrap_or(path);
        if local_state(self.target.local, local_path) != listed.as_ref().map(|(_, state)| *state) {
            return Ok(false);
        }
        let destination = self.target.local.join(path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "a file here is where the VM has a folder".to_string())?;
        }
        std::fs::rename(staging.join(path), &destination).map_err(|error| match error.raw_os_error() {
            Some(libc::EISDIR | libc::ENOTEMPTY | libc::EEXIST) => "a folder here is where the VM has a file".to_string(),
            Some(libc::ENOTDIR) => "a file here is where the VM has a folder".to_string(),
            _ => format!("could not be moved into the worktree: {error}"),
        })?;
        if self.keys.ignore_case {
            fix_case(self.target.local, path);
        }
        match local_state(self.target.local, path) {
            Some(state) if state.matches(&expected) => {
                self.applied.local.insert(key.to_string(), Some(Entry { path: path.to_string(), state }));
                Ok(true)
            }
            // Saved here in between: the local version stays and wins at the next sync.
            _ => Ok(false),
        }
    }

    /// Records the content of the files that moved, so that a later change of their time alone does not count.
    async fn hash_moved_files(&mut self) {
        let moved: Vec<(String, String)> = self
            .applied
            .local
            .iter()
            .chain(&self.applied.remote)
            .filter_map(|(key, entry)| entry.as_ref().map(|entry| (key.clone(), entry.path.clone())))
            .filter(|(key, _)| !self.applied.kept.contains(key))
            .collect();
        let paths: Vec<String> = moved.iter().map(|(_, path)| path.clone()).collect();
        match git::hash_files(self.target.local, &paths).await {
            Ok(ids) => {
                for ((key, _), id) in moved.into_iter().zip(ids) {
                    self.applied.blobs.insert(key, id);
                }
            }
            Err(error) => eprintln!("hashing the synced files of {} failed: {error}", self.target.local.display()),
        }
    }
}

/// What rsync said about `path`, as a suffix of a report line; empty when it said nothing about it.
fn reason(result: &Result<Vec<String>, String>, path: &str) -> String {
    let lines = match result {
        Ok(lines) => lines.as_slice(),
        Err(_) => &[],
    };
    lines.iter().find(|line| line.contains(path)).map(|line| format!(" ({line})")).unwrap_or_default()
}

/// Keys of files that exist on a side without being listed there, which the sync leaves alone: what the VM reported
/// for the asked paths, and here the paths the VM or the manifest have that the local listing lacks.
fn unlisted_keys(
    local_dir: &Path,
    local: &Listing,
    remote: &Listing,
    remote_unlisted: &Listing,
    manifest: Option<&Manifest>,
    keys: Keys,
) -> BTreeSet<String> {
    let local_keys: BTreeSet<String> = local.keys().map(|path| keys.of(path)).collect();
    let remote_keys: BTreeSet<String> = remote.keys().map(|path| keys.of(path)).collect();
    let unlisted_there = remote_unlisted.keys().map(|path| keys.of(path)).filter(|key| !remote_keys.contains(key));
    let mut unlisted: BTreeSet<String> = unlisted_there.collect();
    let elsewhere = remote.keys().chain(manifest.iter().flat_map(|manifest| manifest.files.keys()));
    for path in elsewhere {
        let key = keys.of(path);
        if !local_keys.contains(&key) && local_state(local_dir, path).is_some() {
            unlisted.insert(key);
        }
    }
    unlisted
}

/// Keys of the paths in which the local `worktree` differs from the tree of `base_ref`.
async fn local_edits(worktree: &Path, base_ref: &str, keys: Keys) -> Result<BTreeSet<String>, String> {
    let base_tree = git::rev_parse(worktree, &format!("{base_ref}^{{tree}}"))
        .await
        .map_err(|_| format!("failed to sync the session's files: the snapshot it started from ({base_ref}) is missing"))?;
    let local_tree = git::worktree_tree(worktree).await?;
    let output = git::run_git(worktree, &["diff-tree", "-r", "-z", "--name-only", "--no-renames", &base_tree, &local_tree]).await?;
    Ok(output.split('\0').filter(|path| !path.is_empty()).map(|path| keys.of(path)).collect())
}

/// Local paths whose state differs from `manifest` while their content is the blob recorded there; a failure to hash
/// counts every such file as changed.
async fn unchanged_content(worktree: &Path, manifest: &Manifest, local: &Listing, keys: Keys) -> BTreeSet<String> {
    let synced = manifest_by_key(manifest, keys);
    let candidates: Vec<(&String, &str)> = local
        .iter()
        .filter_map(|(path, state)| {
            let (_, file) = synced.get(&keys.of(path))?;
            let blob = file.blob.as_deref().filter(|_| file.local != *state)?;
            Some((path, blob))
        })
        .collect();
    let paths: Vec<String> = candidates.iter().map(|(path, _)| (*path).clone()).collect();
    match git::hash_files(worktree, &paths).await {
        Ok(ids) => candidates.into_iter().zip(ids).filter(|((_, blob), id)| blob == id).map(|((path, _), _)| path.clone()).collect(),
        Err(error) => {
            eprintln!("hashing the changed files of {} failed: {error}", worktree.display());
            BTreeSet::new()
        }
    }
}

/// Whether the local worktree changed since the last sync recorded in `manifest`; true before the first one.
pub async fn has_local_changes(local: &Path, manifest: &Path) -> Result<bool, String> {
    let Some(base) = read_manifest(manifest)? else { return Ok(true) };
    let keys = Keys { ignore_case: git::ignores_case(local).await };
    let listing = list_local(local).await?;
    let synced = manifest_by_key(&base, keys);
    let is_synced = |(path, state): (&String, &FileState)| synced.get(&keys.of(path)).is_some_and(|(_, file)| file.local == *state);
    Ok(listing.len() != synced.len() || !listing.iter().all(is_synced))
}

/// Copies the worktree-relative `paths` between the local worktree `local` and the worktree `remote` on the VM behind
/// `ssh`, as `direction` says; for files outside the synced ones, such as the diagram in `.hunt/`.
pub async fn copy_files(ssh: &Ssh, direction: Direction, local: &Path, remote: &str, paths: &[String]) -> Result<(), String> {
    transfer(ssh, direction, local, remote, paths, None).await.map(|_| ())
}

/// Deletes the manifest at `path`, so the next sync of the session starts from its snapshot again.
pub fn forget(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("failed to delete the sync state {}: {error}", path.display()))
        }
        _ => Ok(()),
    }
}

/// The files Git sees in the local `worktree`.
async fn list_local(worktree: &Path) -> Result<Listing, String> {
    let files = git::list_files(worktree).await?;
    Ok(files
        .into_iter()
        .filter(|path| is_syncable(path))
        .filter_map(|path| {
            let state = local_state(worktree, &path)?;
            Some((path, state))
        })
        .collect())
}

/// The state of the file at the worktree-relative `path` of `worktree`; `None` when there is none or it is a folder.
fn local_state(worktree: &Path, path: &str) -> Option<FileState> {
    let metadata = std::fs::symlink_metadata(worktree.join(path)).ok()?;
    if metadata.is_dir() {
        return None;
    }
    Some(FileState { size: metadata.len(), modified_ns: metadata.mtime() * NANOS_PER_SECOND + metadata.mtime_nsec() })
}

/// Removes the folders above the deleted `path` of `worktree` that it left empty.
fn prune_empty_parents(worktree: &Path, path: &str) {
    let mut current = Path::new(path).parent();
    while let Some(dir) = current.filter(|dir| !dir.as_os_str().is_empty()) {
        if std::fs::remove_dir(worktree.join(dir)).is_err() {
            return;
        }
        current = dir.parent();
    }
}

/// Gives the file at `path` of the case-insensitive `worktree` the spelling of `path`'s last component, which a move
/// onto a file spelled differently keeps.
fn fix_case(worktree: &Path, path: &str) {
    let target = worktree.join(path);
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else { return };
    let wanted = name.to_string_lossy();
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    let existing = entries.flatten().map(|entry| entry.file_name()).find(|found| {
        let found = found.to_string_lossy();
        found != wanted && found.to_lowercase() == wanted.to_lowercase()
    });
    if let Some(existing) = existing {
        if let Err(error) = std::fs::rename(parent.join(existing), &target) {
            eprintln!("renaming {} to its spelling on the VM failed: {error}", target.display());
        }
    }
}

/// The files Git sees in the `worktree` on the VM behind `ssh`, and those of `asked` that exist there without being
/// listed.
async fn list_remote(ssh: &Ssh, worktree: &str, asked: &BTreeSet<&str>) -> Result<(Listing, Listing), String> {
    let input: Vec<u8> = asked.iter().flat_map(|path| path.bytes().chain([0])).collect();
    let output = ssh
        .run_with_input(&as_agent(LIST_SCRIPT, &[worktree]), &input)
        .await
        .map_err(|error| format!("failed to list the files on the VM: {error}"))?;
    parse_list_output(&output).map_err(|error| format!("failed to list the files on the VM: {error}"))
}

/// Reads the output of `LIST_SCRIPT`: the listed files, and the asked ones that exist without being listed.
pub fn parse_list_output(output: &[u8]) -> Result<(Listing, Listing), String> {
    let records: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    if records.first() != Some(&MARKER) {
        return Err("the script on the VM printed no listing".into());
    }
    let at = records.iter().position(|record| *record == UNLISTED_MARKER).ok_or("the script on the VM printed no unlisted section")?;
    Ok((parse_records(&records[1..at]), parse_records(&records[at + 1..])))
}

/// Deletes `deleted` in the `worktree` on the VM behind `ssh` and returns the state of `deleted` and `sent` afterwards.
async fn apply_remote(ssh: &Ssh, worktree: &str, deleted: &[String], sent: &[String]) -> Result<Listing, String> {
    let mut input = Vec::new();
    for (kind, path) in deleted.iter().map(|path| ("d", path)).chain(sent.iter().map(|path| ("s", path))) {
        input.extend_from_slice(format!("{kind} {path}\0").as_bytes());
    }
    let output = ssh
        .run_with_input(&as_agent(APPLY_SCRIPT, &[worktree]), &input)
        .await
        .map_err(|error| format!("failed to update the files on the VM: {error}"))?;
    parse_listing(&output).map_err(|error| format!("failed to update the files on the VM: {error}"))
}

/// Copies `paths` with rsync as `direction` says, a pull into `staging` when given. Returns rsync's complaints about
/// single files (a file that vanished or a folder in the way, which the caller sees in the result), and fails only when
/// rsync could not run or gave up as a whole.
async fn transfer(
    ssh: &Ssh,
    direction: Direction,
    local: &Path,
    remote: &str,
    paths: &[String],
    staging: Option<&Path>,
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let what = match direction {
        Direction::Push => format!("send {} files to the VM", paths.len()),
        Direction::Pull => format!("bring {} files from the VM", paths.len()),
    };
    let list = std::env::temp_dir().join(format!("hunt-sync-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&list, files_from(paths)).map_err(|error| format!("failed to {what}: {error}"))?;
    let args = rsync_args(&ssh.git_ssh_command(), &list, direction, local, staging, &ssh.rsync_location(remote));
    let output = Command::new("rsync").args(&args).output().await;
    let _ = std::fs::remove_file(&list);
    let output = output.map_err(|error| format!("failed to {what}: failed to run rsync: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lines = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect();
    match output.status.code() {
        Some(0 | 23 | 24) => Ok(lines),
        code => Err(format!("failed to {what}: rsync exited with {}: {}", code.unwrap_or(-1), stderr.trim())),
    }
}

/// The `--files-from` list of `paths`: one per line, each after `./`, since openrsync skips lines that start with `#`
/// or `;`.
fn files_from(paths: &[String]) -> String {
    paths.iter().map(|path| format!("./{path}\n")).collect()
}

/// The arguments of rsync that copy the files `files_from` lists between the local worktree `local` and the worktree
/// at `remote` (`<host>:<path>`), reaching the VM with `ssh_command`. A push compares contents (`-I`; protocol 29 has
/// mtimes to the second only); a pull into `staging` copies a file whose content `local` has already from there
/// (`-c --copy-dest`). Only flags macOS' openrsync knows; `--files-from` creates the parent folders without `-r`.
pub fn rsync_args(
    ssh_command: &str,
    files_from: &Path,
    direction: Direction,
    local: &Path,
    staging: Option<&Path>,
    remote: &str,
) -> Vec<String> {
    let remote = format!("{remote}/");
    let mut args = Vec::new();
    match direction {
        Direction::Push => args.push("-ltpzI".to_string()),
        Direction::Pull => {
            args.push("-ltpzc".to_string());
            if staging.is_some() {
                args.push(format!("--copy-dest={}", local.display()));
            }
        }
    }
    args.push(format!("--files-from={}", files_from.display()));
    args.extend(["-e".to_string(), ssh_command.to_string(), format!("--rsync-path={REMOTE_RSYNC}")]);
    let local = format!("{}/", staging.unwrap_or(local).display());
    match direction {
        Direction::Push => args.extend([local, remote]),
        Direction::Pull => args.extend([remote, local]),
    }
    args
}

/// Reads the output of `APPLY_SCRIPT`; folders, records that do not parse and paths that cannot sync are left out.
pub fn parse_listing(output: &[u8]) -> Result<Listing, String> {
    let records: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    if records.first() != Some(&MARKER) {
        return Err("the script on the VM printed no listing".into());
    }
    Ok(parse_records(&records[1..]))
}

/// Reads `<size> <seconds>.<nanoseconds> <mode in hex> <path>` records; see `parse_listing`.
fn parse_records(records: &[&[u8]]) -> Listing {
    let mut listing = Listing::new();
    for record in records.iter().filter(|record| !record.is_empty()) {
        let text = String::from_utf8_lossy(record);
        let mut fields = text.splitn(4, ' ');
        let (Some(size), Some(modified), Some(mode), Some(path)) = (fields.next(), fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let Ok(mode) = u32::from_str_radix(mode, 16) else { continue };
        if mode & 0o170000 == 0o040000 || !is_syncable(path) {
            continue;
        }
        let (Ok(size), Some(modified_ns)) = (size.parse(), parse_modified(modified)) else { continue };
        listing.insert(path.to_string(), FileState { size, modified_ns });
    }
    listing
}

/// `<seconds>.<fraction>` as nanoseconds; the fraction may have up to nine digits.
fn parse_modified(text: &str) -> Option<i64> {
    let (seconds, fraction) = text.split_once('.').unwrap_or((text, ""));
    if fraction.len() > 9 || !fraction.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let seconds: i64 = seconds.parse().ok()?;
    let nanos: i64 = format!("{fraction:0<9}").parse().ok()?;
    seconds.checked_mul(NANOS_PER_SECOND)?.checked_add(nanos)
}

/// Whether the worktree-relative `path` can sync: it stays inside the worktree, fits on a line of rsync's file list and
/// lies outside the diagram folder, which each side keeps for itself.
fn is_syncable(path: &str) -> bool {
    !path.is_empty() && git::ensure_inside_worktree(path).is_ok() && !path.contains(['\n', '\r']) && !path.starts_with(".hunt/")
}

/// The manifest at `path`; `None` before the first sync.
fn read_manifest(path: &Path) -> Result<Option<Manifest>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read the sync state {}: {error}", path.display())),
    };
    serde_json::from_str(&text).map(Some).map_err(|error| format!("failed to read the sync state {}: {error}", path.display()))
}

/// Replaces the manifest at `path` through a temp file that is on disk before the rename, so a crash leaves the
/// previous one or the new one.
fn write_manifest(path: &Path, manifest: &Manifest) -> Result<(), String> {
    let failed = |error: &dyn std::fmt::Display| format!("failed to write the sync state {}: {error}", path.display());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| failed(&error))?;
    }
    let text = serde_json::to_string(manifest).map_err(|error| failed(&error))?;
    let temp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temp).map_err(|error| failed(&error))?;
    file.write_all(text.as_bytes()).and_then(|()| file.sync_all()).map_err(|error| failed(&error))?;
    std::fs::rename(&temp, path).map_err(|error| failed(&error))
}

/// The remote command that runs the bash `script` with `args` as the agent's user.
fn as_agent(script: &str, args: &[&str]) -> String {
    let mut command_args = vec!["-n", "-u", "agent", "bash", "-c", script, "bash"];
    command_args.extend_from_slice(args);
    shell_command("sudo", &command_args)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: i64 = NANOS_PER_SECOND;

    fn state(size: u64, seconds: i64) -> FileState {
        FileState { size, modified_ns: seconds * SECOND }
    }

    fn listing(entries: &[(&str, FileState)]) -> Listing {
        entries.iter().map(|(path, state)| (path.to_string(), *state)).collect()
    }

    fn manifest(entries: &[(&str, FileState, FileState)]) -> Manifest {
        let file = |local: &FileState, remote: &FileState| SyncedFile { local: *local, remote: *remote, blob: None };
        let files = entries.iter().map(|(path, local, remote)| (path.to_string(), file(local, remote)));
        Manifest { files: files.collect() }
    }

    fn set(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    const EXACT: Keys = Keys { ignore_case: false };
    const FOLDED: Keys = Keys { ignore_case: true };

    fn plan_of(base: Base<'_>, local: &Listing, remote: &Listing, keys: Keys, unlisted: &[&str], same_content: &[&str]) -> Plan {
        let (unlisted, same_content) = (set(unlisted), set(same_content));
        plan(&Inputs { base, local, remote, keys, unlisted: &unlisted, same_content: &same_content })
    }

    #[test]
    fn without_a_manifest_local_edits_against_the_snapshot_win_and_the_rest_comes_from_the_vm() {
        let local = listing(&[
            ("edited.txt", state(2, 50)),
            ("new-here.txt", state(1, 50)),
            ("same.txt", state(1, 10)),
            ("gone-there.txt", state(1, 10)),
        ]);
        let remote = listing(&[
            ("edited.txt", state(3, 60)),
            ("same.txt", state(1, 20)),
            ("new-there.txt", state(1, 60)),
            ("deleted-here.txt", state(1, 20)),
        ]);
        let edits = set(&["edited.txt", "new-here.txt", "deleted-here.txt"]);
        let plan = plan_of(Base::Snapshot(&edits), &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan.push, paths(&["edited.txt", "new-here.txt"]));
        assert_eq!(plan.delete_remote, paths(&["deleted-here.txt"]));
        assert_eq!(plan.pull, paths(&["new-there.txt", "same.txt"]));
        assert_eq!(plan.delete_local, paths(&["gone-there.txt"]));
    }

    #[test]
    fn with_a_manifest_changes_flow_to_the_other_side_and_the_local_side_wins() {
        let (old_local, old_remote) = (state(1, 10), state(1, 20));
        let base = manifest(&[
            ("unchanged.txt", old_local, old_remote),
            ("edited-here.txt", old_local, old_remote),
            ("edited-there.txt", old_local, old_remote),
            ("edited-both.txt", old_local, old_remote),
            ("deleted-here.txt", old_local, old_remote),
            ("deleted-there.txt", old_local, old_remote),
            ("deleted-here-edited-there.txt", old_local, old_remote),
        ]);
        let local = listing(&[
            ("unchanged.txt", old_local),
            ("edited-here.txt", state(2, 11)),
            ("edited-there.txt", old_local),
            ("edited-both.txt", state(2, 11)),
            ("deleted-there.txt", old_local),
            ("new-here.txt", state(1, 11)),
        ]);
        let remote = listing(&[
            ("unchanged.txt", old_remote),
            ("edited-here.txt", old_remote),
            ("edited-there.txt", state(3, 21)),
            ("edited-both.txt", state(3, 21)),
            ("deleted-here.txt", old_remote),
            ("deleted-here-edited-there.txt", state(2, 21)),
            ("new-there.txt", state(1, 21)),
        ]);
        let plan = plan_of(Base::Manifest(&base), &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan.push, paths(&["edited-both.txt", "edited-here.txt", "new-here.txt"]));
        assert_eq!(plan.pull, paths(&["edited-there.txt", "new-there.txt"]));
        assert_eq!(plan.delete_remote, paths(&["deleted-here-edited-there.txt", "deleted-here.txt"]));
        assert_eq!(plan.delete_local, paths(&["deleted-there.txt"]));
    }

    #[test]
    fn a_file_missing_from_a_listing_but_present_on_that_side_is_left_alone() {
        let base = manifest(&[(".env", state(1, 10), state(1, 20)), ("ignored-here.txt", state(1, 10), state(1, 20))]);
        // The agent untracked .env and ignored it; this Mac's global excludes ignore the other file.
        let local = listing(&[(".env", state(1, 10))]);
        let remote = listing(&[("ignored-here.txt", state(1, 20))]);
        let plan = plan_of(Base::Manifest(&base), &local, &remote, EXACT, &[".env", "ignored-here.txt"], &[]);
        assert_eq!(plan, Plan::default());
        let unlisted = set(&[".env", "ignored-here.txt"]);
        let next = next_manifest(Some(&base), &local, &remote, EXACT, &unlisted, &BTreeSet::new(), &Applied::default());
        assert_eq!(next, Manifest::default());
    }

    #[test]
    fn equal_size_and_second_count_as_in_sync_so_a_lost_manifest_pushes_nothing_back() {
        let base = manifest(&[("pulled.txt", state(1, 10), state(1, 20))]);
        // A pull landed (the VM's time to the second) but its manifest entry was not saved.
        let local = listing(&[("pulled.txt", FileState { size: 5, modified_ns: 30 * SECOND })]);
        let remote = listing(&[("pulled.txt", FileState { size: 5, modified_ns: 30 * SECOND + 123 })]);
        assert_eq!(plan_of(Base::Manifest(&base), &local, &remote, EXACT, &[], &[]), Plan::default());
        let other_second = listing(&[("pulled.txt", state(5, 31))]);
        assert_eq!(plan_of(Base::Manifest(&base), &other_second, &remote, EXACT, &[], &[]).push, paths(&["pulled.txt"]));
    }

    #[test]
    fn a_local_file_whose_content_did_not_change_takes_the_vms_change() {
        let base = manifest(&[("lock.json", state(9, 10), state(9, 20))]);
        let local = listing(&[("lock.json", state(9, 15))]);
        let remote = listing(&[("lock.json", state(12, 21))]);
        let plan = plan_of(Base::Manifest(&base), &local, &remote, EXACT, &[], &["lock.json"]);
        assert_eq!(plan.pull, paths(&["lock.json"]));
        assert!(plan.push.is_empty());
        let plan = plan_of(Base::Manifest(&base), &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan.push, paths(&["lock.json"]));
    }

    #[test]
    fn a_case_only_rename_on_the_vm_comes_here_as_a_rename_on_a_case_insensitive_mac() {
        let base = manifest(&[("src/Foo.ts", state(4, 10), state(4, 20))]);
        let local = listing(&[("src/Foo.ts", state(4, 10))]);
        let remote = listing(&[("src/foo.ts", state(4, 25))]);
        let plan = plan_of(Base::Manifest(&base), &local, &remote, FOLDED, &[], &[]);
        assert_eq!(plan, Plan { pull: paths(&["src/foo.ts"]), ..Plan::default() });
        // Edited here meanwhile: the content goes to the VM under the VM's name.
        let edited = listing(&[("src/Foo.ts", state(6, 11))]);
        let plan = plan_of(Base::Manifest(&base), &edited, &remote, FOLDED, &[], &[]);
        assert_eq!(plan, Plan { push: paths(&["src/foo.ts"]), ..Plan::default() });
        // A case-sensitive Mac sees two files.
        let plan = plan_of(Base::Manifest(&base), &local, &remote, EXACT, &[], &[]);
        assert_eq!((plan.delete_local, plan.pull), (paths(&["src/Foo.ts"]), paths(&["src/foo.ts"])));
    }

    #[test]
    fn names_that_differ_only_in_case_on_the_vm_are_reported_instead_of_synced() {
        let remote = listing(&[("README.md", state(1, 20)), ("readme.md", state(2, 20)), ("other.txt", state(1, 20))]);
        let plan = plan_of(Base::Snapshot(&BTreeSet::new()), &Listing::new(), &remote, FOLDED, &[], &[]);
        assert_eq!(plan.pull, paths(&["other.txt"]));
        assert_eq!(plan.collisions.keys().cloned().collect::<Vec<_>>(), paths(&["readme.md"]));
        assert!(plan.collisions["readme.md"].contains("README.md and readme.md differ only in case on the VM"));
    }

    #[test]
    fn next_manifest_records_what_completed_and_keeps_the_rest() {
        let base = manifest(&[("kept.txt", state(1, 10), state(1, 20)), ("failed.txt", state(1, 10), state(1, 20))]);
        let local = listing(&[("kept.txt", state(1, 10)), ("failed.txt", state(2, 11)), ("sent.txt", state(3, 12))]);
        let remote = listing(&[("kept.txt", state(1, 20)), ("failed.txt", state(1, 20)), ("brought.txt", state(4, 21))]);
        let mut applied = Applied::default();
        applied.remote.insert("sent.txt".into(), Some(Entry { path: "sent.txt".into(), state: state(3, 12) }));
        applied.local.insert("brought.txt".into(), Some(Entry { path: "brought.txt".into(), state: state(4, 21) }));
        applied.kept.insert("failed.txt".into());
        applied.blobs.insert("sent.txt".into(), "abc".into());
        let next = next_manifest(Some(&base), &local, &remote, EXACT, &BTreeSet::new(), &BTreeSet::new(), &applied);
        assert_eq!(next.files["failed.txt"], base.files["failed.txt"], "a send that failed keeps the old entry and is retried");
        assert_eq!(next.files["sent.txt"], SyncedFile { local: state(3, 12), remote: state(3, 12), blob: Some("abc".into()) });
        assert_eq!(next.files["brought.txt"].local, state(4, 21));
        assert_eq!(next.files["kept.txt"], base.files["kept.txt"]);
        // The next plan retries only the failed send.
        let local = listing(&[("kept.txt", state(1, 10)), ("failed.txt", state(2, 11)), ("sent.txt", state(3, 12)), ("brought.txt", state(4, 21))]);
        let remote = listing(&[("kept.txt", state(1, 20)), ("failed.txt", state(1, 20)), ("brought.txt", state(4, 21)), ("sent.txt", state(3, 12))]);
        let plan = plan_of(Base::Manifest(&next), &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan, Plan { push: paths(&["failed.txt"]), ..Plan::default() });
    }

    #[test]
    fn parse_list_output_reads_both_sections_and_skips_folders_and_unsafe_paths() {
        let mut output = Vec::new();
        for record in [
            "hunt-sync",
            "12 1792007100.397698338 81a4 src/a b.ts",
            "7 1792007100.5 a1ff #link",
            "4096 1792007100.000000000 41ed vendor/module",
            "1 1792007100.000000000 81a4 ../escape",
            "1 1792007100.000000000 81a4 .hunt/graph.json",
            "garbage",
            "hunt-sync-unlisted",
            "3 1792007100.000000000 81a4 .env",
        ] {
            output.extend_from_slice(record.as_bytes());
            output.push(0);
        }
        let (listed, unlisted) = parse_list_output(&output).unwrap();
        assert_eq!(listed.keys().cloned().collect::<Vec<_>>(), paths(&["#link", "src/a b.ts"]));
        assert_eq!(listed["src/a b.ts"], FileState { size: 12, modified_ns: 1_792_007_100_397_698_338 });
        assert_eq!(unlisted.keys().cloned().collect::<Vec<_>>(), paths(&[".env"]));
        assert!(parse_list_output(b"hunt-sync\0").is_err(), "a listing without its unlisted section is cut short");
        assert!(parse_listing(b"").is_err());
        assert_eq!(parse_listing(b"hunt-sync\0").unwrap(), Listing::new());
    }

    #[test]
    fn parse_modified_reads_seconds_with_up_to_nine_digits() {
        assert_eq!(parse_modified("12.5"), Some(12_500_000_000));
        assert_eq!(parse_modified("12"), Some(12_000_000_000));
        assert_eq!(parse_modified("12.000000001"), Some(12_000_000_001));
        assert_eq!(parse_modified("12.0000000001"), None);
        assert_eq!(parse_modified("x.1"), None);
        assert_eq!(parse_modified("1.-1"), None);
    }

    #[test]
    fn rsync_compares_contents_on_push_and_pulls_into_staging_without_recursion() {
        let ssh_command = "ssh -T -l jane -o 'ProxyCommand=gcloud compute start-iap-tunnel %h 22'";
        let list = Path::new("/tmp/hunt-sync-1.txt");
        let local = Path::new("/Users/jane/Library/Application Support/hunt/worktrees/x");
        let staging = local.join(STAGING_DIR);
        let push = rsync_args(ssh_command, list, Direction::Push, local, None, "vm-hunt-s-ab12cd34:/home/agent/app");
        assert_eq!(
            push,
            [
                "-ltpzI",
                "--files-from=/tmp/hunt-sync-1.txt",
                "-e",
                ssh_command,
                "--rsync-path=sudo -n -u agent rsync",
                "/Users/jane/Library/Application Support/hunt/worktrees/x/",
                "vm-hunt-s-ab12cd34:/home/agent/app/",
            ]
        );
        let pull = rsync_args(ssh_command, list, Direction::Pull, local, Some(&staging), "vm-hunt-s-ab12cd34:/home/agent/app");
        assert_eq!(pull[..2], ["-ltpzc", "--copy-dest=/Users/jane/Library/Application Support/hunt/worktrees/x"]);
        let ends = ["vm-hunt-s-ab12cd34:/home/agent/app/", "/Users/jane/Library/Application Support/hunt/worktrees/x/.hunt/sync-staging/"];
        assert_eq!(pull[6..], ends);
        assert!(push.iter().chain(&pull).all(|arg| !arg.starts_with("-r") && arg != "--recursive"));
        assert_eq!(files_from(&paths(&["#notes.md", ";semi.txt", "dir/b c.txt"])), "./#notes.md\n./;semi.txt\n./dir/b c.txt\n");
    }

    #[test]
    fn is_syncable_keeps_paths_inside_the_worktree_and_outside_the_diagram_folder() {
        assert!(is_syncable("src/main.rs"));
        assert!(is_syncable(".hunt-not-the-folder"));
        assert!(!is_syncable(""));
        assert!(!is_syncable("/etc/passwd"));
        assert!(!is_syncable("a/../../b"));
        assert!(!is_syncable("two\nlines"));
        assert!(!is_syncable(".hunt/graph.json"));
    }

    /// A `Run` on `target` with the listings `local` and `remote`.
    fn run<'a>(target: &'a SyncTarget<'a>, keys: Keys, local: &Listing, remote: &Listing) -> Run<'a> {
        let mut ignored = BTreeMap::new();
        Run {
            target,
            keys,
            local: by_key(local, keys, &mut ignored, ""),
            remote: by_key(remote, keys, &mut ignored, ""),
            applied: Applied::default(),
            outcome: Outcome::default(),
            failure: None,
        }
    }

    #[test]
    fn a_local_file_saved_after_the_listing_is_neither_deleted_nor_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        std::fs::create_dir_all(worktree.join("a/b")).unwrap();
        std::fs::write(worktree.join("a/b/gone.txt"), "x").unwrap();
        std::fs::write(worktree.join("saved.txt"), "x").unwrap();
        std::fs::write(worktree.join("pulled.txt"), "old").unwrap();
        let local = listing(&[
            ("a/b/gone.txt", local_state(worktree, "a/b/gone.txt").unwrap()),
            ("saved.txt", local_state(worktree, "saved.txt").unwrap()),
            ("pulled.txt", local_state(worktree, "pulled.txt").unwrap()),
        ]);
        let target = SyncTarget { local: worktree, remote: "/home/agent/app", manifest: Path::new("/nonexistent"), base_ref: "refs/x" };

        // Saved here after the listing.
        std::fs::write(worktree.join("saved.txt"), "edited").unwrap();
        let mut deleting = run(&target, EXACT, &local, &Listing::new());
        deleting.delete_local(&paths(&["a/b/gone.txt", "saved.txt"]));
        assert!(!worktree.join("a").exists(), "the folders a deleted file leaves empty go too");
        assert_eq!(std::fs::read_to_string(worktree.join("saved.txt")).unwrap(), "edited");
        assert!(deleting.applied.kept.contains("saved.txt"));
        assert_eq!(deleting.outcome.deleted_local, 1);

        // A staged file from the VM moves in only while the local file is unchanged.
        let staging = worktree.join(STAGING_DIR);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("pulled.txt"), "new").unwrap();
        std::fs::write(staging.join("saved.txt"), "vm").unwrap();
        let staged = |path: &'static str| (path, local_state(&staging, path).unwrap());
        let remote = listing(&[staged("pulled.txt"), staged("saved.txt")]);
        let mut pulling = run(&target, EXACT, &local, &remote);
        assert_eq!(pulling.move_in(&staging, "pulled.txt", "pulled.txt"), Ok(true));
        assert_eq!(pulling.move_in(&staging, "saved.txt", "saved.txt"), Ok(false));
        assert_eq!(std::fs::read_to_string(worktree.join("pulled.txt")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(worktree.join("saved.txt")).unwrap(), "edited");
    }

    #[test]
    fn a_folder_in_the_way_is_reported_and_a_case_rename_takes_the_vms_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        std::fs::create_dir_all(worktree.join("src/kept")).unwrap();
        std::fs::write(worktree.join("src/kept/file.txt"), "x").unwrap();
        std::fs::write(worktree.join("Foo.ts"), "old").unwrap();
        let staging = worktree.join(STAGING_DIR);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("src"), "a file on the VM").unwrap();
        std::fs::write(staging.join("foo.ts"), "renamed").unwrap();
        let local = listing(&[("Foo.ts", local_state(worktree, "Foo.ts").unwrap())]);
        let remote = listing(&[("src", local_state(&staging, "src").unwrap()), ("foo.ts", local_state(&staging, "foo.ts").unwrap())]);
        let target = SyncTarget { local: worktree, remote: "/home/agent/app", manifest: Path::new("/nonexistent"), base_ref: "refs/x" };
        let mut pulling = run(&target, FOLDED, &local, &remote);
        assert_eq!(pulling.move_in(&staging, "src", "src"), Err("a folder here is where the VM has a file".to_string()));
        assert!(worktree.join("src/kept/file.txt").is_file());
        let is_case_insensitive = worktree.join("FOO.TS").exists();
        assert_eq!(pulling.move_in(&staging, "foo.ts", "foo.ts"), Ok(true));
        if is_case_insensitive {
            let entries = std::fs::read_dir(worktree).unwrap().flatten();
            let names: Vec<String> = entries.map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
            assert!(names.contains(&"foo.ts".to_string()) && !names.contains(&"Foo.ts".to_string()), "{names:?}");
        }
        assert_eq!(std::fs::read_to_string(worktree.join("foo.ts")).unwrap(), "renamed");
    }

    #[tokio::test]
    async fn local_edits_and_unchanged_content_come_from_git() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        git::run_git(worktree, &["init", "-q"]).await.unwrap();
        git::run_git(worktree, &["config", "user.email", "test@example.com"]).await.unwrap();
        git::run_git(worktree, &["config", "user.name", "Test"]).await.unwrap();
        std::fs::write(worktree.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::write(worktree.join("kept.txt"), "one").unwrap();
        std::fs::write(worktree.join("edited.txt"), "two").unwrap();
        std::fs::write(worktree.join("deleted.txt"), "three").unwrap();
        git::run_git(worktree, &["add", "."]).await.unwrap();
        git::run_git(worktree, &["commit", "-q", "-m", "init"]).await.unwrap();
        let snapshot = git::snapshot_commit(worktree, "Hunt handoff snapshot").await.unwrap();
        git::run_git(worktree, &["update-ref", "refs/hunt/x/handoff", &snapshot]).await.unwrap();

        // Edits during the handoff.
        std::fs::write(worktree.join("edited.txt"), "two, edited").unwrap();
        std::fs::remove_file(worktree.join("deleted.txt")).unwrap();
        std::fs::write(worktree.join("new.txt"), "four").unwrap();
        std::fs::create_dir_all(worktree.join("ignored")).unwrap();
        std::fs::write(worktree.join("ignored/x.txt"), "x").unwrap();
        let edits = local_edits(worktree, "refs/hunt/x/handoff", EXACT).await.unwrap();
        assert_eq!(edits, set(&["deleted.txt", "edited.txt", "new.txt"]));
        assert!(local_edits(worktree, "refs/hunt/missing/handoff", EXACT).await.unwrap_err().contains("is missing"));

        // A file rewritten with the same content keeps its blob.
        let local = list_local(worktree).await.unwrap();
        let blobs = git::hash_files(worktree, &paths(&["kept.txt", "edited.txt"])).await.unwrap();
        let synced = |blob: &str| SyncedFile { local: state(0, 0), remote: state(0, 0), blob: Some(blob.to_string()) };
        let base = Manifest { files: [("kept.txt".to_string(), synced(&blobs[0])), ("edited.txt".to_string(), synced("0000"))].into() };
        assert_eq!(unchanged_content(worktree, &base, &local, EXACT).await, set(&["kept.txt"]));
    }

    #[tokio::test]
    async fn the_manifest_tells_local_changes_and_survives_a_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        git::run_git(worktree, &["init", "-q"]).await.unwrap();
        std::fs::write(worktree.join("tracked.txt"), "one").unwrap();
        git::run_git(worktree, &["add", "tracked.txt"]).await.unwrap();
        std::fs::write(worktree.join("untracked.txt"), "two!").unwrap();
        let listed = list_local(worktree).await.unwrap();
        assert_eq!(listed.keys().cloned().collect::<Vec<_>>(), paths(&["tracked.txt", "untracked.txt"]));

        let state_dir = tempfile::tempdir().unwrap();
        let manifest_path = state_dir.path().join("remote-sync").join("x.json");
        assert!(has_local_changes(worktree, &manifest_path).await.unwrap());
        let files = listed.iter().map(|(path, here)| (path.clone(), SyncedFile { local: *here, remote: state(0, 0), blob: None }));
        write_manifest(&manifest_path, &Manifest { files: files.collect() }).unwrap();
        assert!(!has_local_changes(worktree, &manifest_path).await.unwrap());
        std::fs::write(worktree.join("untracked.txt"), "changed").unwrap();
        assert!(has_local_changes(worktree, &manifest_path).await.unwrap());
        assert!(!manifest_path.with_extension("json.tmp").exists());

        forget(&manifest_path).unwrap();
        forget(&manifest_path).unwrap();
        assert_eq!(read_manifest(&manifest_path).unwrap(), None);
    }
}
