//! Two-way sync of a remote session's files between its worktree on the VM and its local worktree, so that the diff,
//! the editor and the diagram show the agent's changes and local edits reach the agent. Each side lists the files Git
//! sees there (`git ls-files --cached --others --exclude-standard`: tracked and untracked, not ignored) with their size,
//! modification time, execute bit and whether they are links. The manifest holds both sides' state after the last sync,
//! so a difference tells which side changed a file: a file changed here goes to the VM, also when the agent changed it
//! too (the local version wins); a file changed only on the VM comes here; deletions follow the same rule. A file whose
//! content did not change (same blob as at the last sync) counts as unchanged, and two files of equal size,
//! modification second and mode count as in sync. Before the first sync, a file is a local edit only when it differs from
//! the snapshot both sides started from (the handoff's, or the adoption's); otherwise the VM's version wins. Later, a
//! file without a manifest entry is a local edit only when it exists here in another state than when the sync left it
//! alone.
//!
//! A file present on a side without being listed there (other ignore rules on the Mac and the VM) is never touched. On
//! a case-insensitive Mac (`core.ignorecase`) paths are compared ignoring case, the VM's spelling wins, and two VM files
//! whose names differ only in case are reported instead of synced. rsync moves the content over the session's SSH
//! connection as the VM's `agent` user; links go to the VM as their text, since openrsync stops at a link it cannot
//! follow. Files from the VM land in a staging folder first (links last, so that nothing lands below one) and replace a
//! local file only while it is unchanged since the listing, never below a local link and never as a link that is
//! absolute or climbs out of a folder it entered (`a/..`), which could lead outside the worktree through other links.
//! Whatever completed is recorded even when a later step fails, and a file that cannot move (a folder on the other
//! side) is reported without failing the rest. Knows nothing about Tauri.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
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

/// The longest a sync waits for git to hash the files it moved; a file that never ends (a device) must not hold it.
const HASH_TIMEOUT: Duration = Duration::from_secs(120);

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

/// Reads NUL-separated records from stdin: `d <path>` deletes the file in the worktree `$1` with the folders it leaves
/// empty, `s <path>` only asks for its state, and `l <path>` followed by its target and its modification time in seconds
/// makes it that link (unless a folder is in the way). Prints `MARKER` and the state of every named path that exists
/// afterwards, as `LIST_SCRIPT` does.
const APPLY_SCRIPT: &str = r#"
set -euo pipefail
cd -- "$1"
paths=()
while IFS= read -r -d '' entry; do
  path=${entry:2}
  case ${entry:0:2} in
    'd ')
      rm -f -- "$path" 2>/dev/null || true
      rmdir -p --ignore-fail-on-non-empty -- "$(dirname -- "$path")" 2>/dev/null || true
      ;;
    'l ')
      IFS= read -r -d '' target
      IFS= read -r -d '' seconds
      if [[ ! -d $path || -L $path ]]; then
        { mkdir -p -- "$(dirname -- "$path")" && rm -f -- "$path" && ln -s -- "$target" "$path" && touch -h -d "@$seconds" -- "$path"; } 2>/dev/null || true
      fi
      ;;
  esac
  paths+=("$path")
done
printf 'hunt-sync\0'
if (( ${#paths[@]} )); then
  printf '%s\0' "${paths[@]}" | LC_ALL=C xargs -0r stat --printf '%s %.9Y %f %n\0' -- 2>/dev/null || true
fi
"#;

/// The size, modification time (nanoseconds since the epoch), execute bit and kind of a file on one side, which tell
/// that it changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub size: u64,
    pub modified_ns: i64,
    #[serde(default)]
    pub executable: bool,
    /// A symbolic link, whose size is the length of its target.
    #[serde(default)]
    pub link: bool,
}

impl FileState {
    /// Whether `other` looks like this file as rsync copies it: the same size, mode and modification second (protocol
    /// 29 carries seconds).
    pub fn matches(&self, other: &FileState) -> bool {
        let second = |state: &FileState| state.modified_ns.div_euclid(NANOS_PER_SECOND);
        self.size == other.size && second(self) == second(other) && self.executable == other.executable && self.link == other.link
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

/// Both sides' state after the last sync, by the path the VM has, and the local files it left alone (not listed on the
/// VM, colliding names, or a move that did not complete) with their state then; they count as changed here only once
/// that state changes.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub files: BTreeMap<String, SyncedFile>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub skipped: BTreeMap<String, FileState>,
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

/// Everything a plan is made from.
pub struct Inputs<'a> {
    /// The state after the last sync; `None` before the first one.
    pub manifest: Option<&'a Manifest>,
    /// Before the first sync: keys of the paths in which the local worktree differs from the snapshot both sides started
    /// from. Without them every local file counts as a local edit.
    pub edits: Option<&'a BTreeSet<String>>,
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
    /// Local files a pull or a deletion here did not reach, still as listed: without a manifest entry they are noted
    /// as left alone, so that the next sync does not take them for local edits. A kept send is never here.
    pub untouched: BTreeMap<String, Entry>,
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
    let synced = inputs.manifest.map(|manifest| manifest_by_key(manifest, keys)).unwrap_or_default();
    let skipped: BTreeMap<String, FileState> =
        inputs.manifest.iter().flat_map(|manifest| &manifest.skipped).map(|(path, state)| (keys.of(path), *state)).collect();
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
        let (changed_here, changed_there) = match (last, inputs.manifest) {
            (Some((_, file)), _) => {
                let changed_here = here.is_none_or(|here| here.state != file.local && !inputs.same_content.contains(&here.path));
                let changed_there = there.is_none_or(|there| there.state != file.remote || renamed_there);
                (changed_here, changed_there)
            }
            // Before the first sync, a file is a local edit only when it differs from the snapshot.
            (None, None) => (inputs.edits.map_or(here.is_some(), |edits| edits.contains(key)), true),
            // A file without an entry that is missing here was never made here; one that is here is a local edit unless
            // it is as the sync left it alone. Only a file the VM has can come here: one that never synced stays.
            (None, Some(_)) => (here.is_some_and(|here| skipped.get(key) != Some(&here.state)), there.is_some()),
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

/// The manifest after a sync that compared `local` and `remote` and completed what `applied` holds: an entry per key
/// both sides have, with the VM's path. Unlisted keys lose their entry, kept and colliding keys keep the old one, and
/// the local files of unlisted and colliding keys are noted as left alone with their listed state. A kept key without
/// an entry is noted too when a pull or a deletion here did not reach its unchanged local file (`applied.untouched`), or
/// when it was noted before and is still in that state; a kept send is not, so that it counts as a local change until
/// it moved.
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
    let listed_here = by_key(local, keys, &mut ignored, "");
    let mut here = listed_here.clone();
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
    let previously_skipped: BTreeMap<String, FileState> =
        base.iter().flat_map(|manifest| &manifest.skipped).map(|(path, state)| (keys.of(path), *state)).collect();
    let all: BTreeSet<String> = here.keys().chain(there.keys()).chain(previous.keys()).chain(ignored.keys()).cloned().collect();
    let mut next = Manifest::default();
    let skip = |key: &str, next: &mut Manifest| {
        if let Some(entry) = listed_here.get(key) {
            next.skipped.insert(entry.path.clone(), entry.state);
        }
    };
    for key in all {
        if unlisted.contains(&key) {
            skip(&key, &mut next);
            continue;
        }
        if applied.kept.contains(&key) || ignored.contains_key(&key) {
            if let Some((path, file)) = previous.get(&key) {
                next.files.insert((*path).clone(), (*file).clone());
            } else if let Some(entry) = applied.untouched.get(&key) {
                next.skipped.insert(entry.path.clone(), entry.state);
            } else if let Some(entry) = listed_here.get(&key).filter(|entry| previously_skipped.get(&key) == Some(&entry.state)) {
                next.skipped.insert(entry.path.clone(), entry.state);
            }
            if ignored.contains_key(&key) {
                skip(&key, &mut next);
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
        next.files.insert(remote_file.path.clone(), SyncedFile { local: local_file.state, remote: remote_file.state, blob });
    }
    next
}

/// Syncs the files of `target` over `ssh` (see the module comment) and records the new manifest, also when a step
/// failed midway; the first such failure is returned after that.
pub async fn sync(target: &SyncTarget<'_>, ssh: &Ssh) -> Result<Outcome, String> {
    let keys = Keys { ignore_case: git::ignores_case(target.local).await };
    clear_staging(target.local);
    let manifest = read_manifest(target.manifest)?;
    let local = list_local(target.local).await?;
    let synced_paths = manifest.iter().flat_map(|manifest| manifest.files.keys());
    let asked: BTreeSet<&str> = local.keys().chain(synced_paths).map(String::as_str).collect();
    let (remote, remote_unlisted) = list_remote(ssh, target.remote, &asked).await?;
    let unlisted = unlisted_keys(target.local, &local, &remote, &remote_unlisted, manifest.as_ref(), keys);
    let edits = match manifest {
        Some(_) => None,
        None => Some(local_edits(target.local, target.base_ref, keys).await?),
    };
    let same_content = match &manifest {
        Some(manifest) => unchanged_content(target.local, manifest, &local, keys).await,
        None => BTreeSet::new(),
    };
    let inputs = Inputs {
        manifest: manifest.as_ref(),
        edits: edits.as_ref(),
        local: &local,
        remote: &remote,
        keys,
        unlisted: &unlisted,
        same_content: &same_content,
    };
    let plan = plan(&inputs);

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

    /// Sends `plan.push` and deletes `plan.delete_remote` on the VM, then records what the VM has afterwards. Regular
    /// files go with rsync, links as their text; a file that is gone or of another kind by now waits for the next sync.
    async fn push_and_delete_remote(&mut self, ssh: &Ssh, plan: &Plan) {
        if plan.push.is_empty() && plan.delete_remote.is_empty() {
            return;
        }
        let local = self.target.local;
        let mut files = Vec::new();
        let mut links = Vec::new();
        for path in &plan.push {
            match local_state(local, path) {
                Some(state) if state.link => match std::fs::read_link(local.join(path)) {
                    Ok(target) => {
                        let seconds = state.modified_ns.div_euclid(NANOS_PER_SECOND);
                        links.push(LinkRecord { path: path.clone(), target, seconds });
                    }
                    Err(_) => continue,
                },
                Some(_) => files.push(path.clone()),
                None => continue,
            }
        }
        let sent = transfer(ssh, Direction::Push, local, self.target.remote, &files, None).await;
        if let Err(error) = &sent {
            self.fail(error.clone());
        }
        let after = match apply_remote(ssh, self.target.remote, &plan.delete_remote, &files, &links).await {
            Ok(after) => after,
            Err(error) => {
                self.fail(error);
                self.applied.kept.extend(plan.push.iter().chain(&plan.delete_remote).map(|path| self.keys.of(path)));
                return;
            }
        };
        for path in &plan.push {
            let key = self.keys.of(path);
            let listed = self.listed_here(&key).map(|(_, state)| state);
            match (after.get(path), listed) {
                (Some(state), Some(listed)) if state.matches(&listed) => {
                    self.applied.remote.insert(key, Some(Entry { path: path.clone(), state: *state }));
                    self.outcome.pushed += 1;
                }
                _ => {
                    self.applied.kept.insert(key);
                    // Saved here during the send: the next sync sends the newest version.
                    if local_state(local, path) == listed {
                        self.outcome.conflicts.push(format!("{path}: could not be sent to the VM{}", reason(&sent, path)));
                    }
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

    /// Deletes `paths` here with the folders they leave empty, each only while it is unchanged since the listing and
    /// not below a link.
    fn delete_local(&mut self, paths: &[String]) {
        for path in paths {
            let key = self.keys.of(path);
            let listed = self.listed_here(&key).map(|(_, state)| state);
            if let Some(link) = linked_parent(self.target.local, path) {
                self.keep_untouched(&key);
                self.outcome.conflicts.push(format!("{path}: not deleted here, since {link} is a link"));
                continue;
            }
            if local_state(self.target.local, path) != listed {
                // Changed here since the listing: the local version wins at the next sync.
                self.applied.kept.insert(key);
                continue;
            }
            match std::fs::remove_file(self.target.local.join(path)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    self.keep_untouched(&key);
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
        let (links, files): (Vec<String>, Vec<String>) =
            paths.iter().cloned().partition(|path| self.listed_there(&self.keys.of(path)).is_some_and(|state| state.link));
        let staging = self.target.local.join(STAGING_DIR);
        let brought = stage(ssh, self.target.local, self.target.remote, &staging, &files, &links).await;
        if let Err(error) = &brought {
            self.fail(error.clone());
        }
        self.move_in_all(&staging, paths, &brought);
        clear_staging(self.target.local);
    }

    /// Moves the staged `paths` in (see `move_in`); a path that does not move is kept, its local file noted as untouched
    /// while it is as listed.
    fn move_in_all(&mut self, staging: &Path, paths: &[String], brought: &Result<Vec<String>, String>) {
        for path in paths {
            let key = self.keys.of(path);
            match self.move_in(staging, path, &key) {
                Ok(true) => self.outcome.pulled += 1,
                Ok(false) => self.keep_untouched(&key),
                Err(problem) => {
                    self.keep_untouched(&key);
                    self.outcome.conflicts.push(format!("{path}: {problem}{}", reason(brought, path)));
                }
            }
        }
    }

    /// Keeps `key` for the next sync after a change here did not reach its local file; the file is noted as untouched
    /// while it still has its listed state.
    fn keep_untouched(&mut self, key: &str) {
        self.applied.kept.insert(key.to_string());
        let Some((path, listed)) = self.listed_here(key).map(|(path, state)| (path.clone(), state)) else { return };
        if local_state(self.target.local, &path) == Some(listed) {
            self.applied.untouched.insert(key.to_string(), Entry { path, state: listed });
        }
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
        place(self.target.local, staging, path, self.keys.ignore_case)?;
        match local_state(self.target.local, path) {
            Some(state) if state.matches(&expected) => {
                self.applied.local.insert(key.to_string(), Some(Entry { path: path.to_string(), state }));
                Ok(true)
            }
            // Saved here in between: the local version stays and wins at the next sync.
            _ => Ok(false),
        }
    }

    /// Records the content of the files that moved, so that a later change of their time alone does not count: only for
    /// a file that has the state the manifest records for it before and after hashing. A sent file that changed since
    /// the listing waits for the next sync.
    async fn hash_moved_files(&mut self) {
        let mut expected = Vec::new();
        for (key, entry) in &self.applied.local {
            if let Some(entry) = entry {
                expected.push((key.clone(), entry.path.clone(), entry.state, false));
            }
        }
        for (key, entry) in &self.applied.remote {
            let Some(entry) = entry else { continue };
            if let Some((_, listed)) = self.listed_here(key) {
                expected.push((key.clone(), entry.path.clone(), listed, true));
            }
        }
        let files: Vec<(String, FileState)> = expected.iter().map(|(_, path, state, _)| (path.clone(), *state)).collect();
        let ids = content_ids(self.target.local, &files).await;
        for (key, path, state, is_sent) in expected {
            match ids.get(&path) {
                Some(id) => {
                    self.applied.blobs.insert(key, id.clone());
                }
                // Changed since the listing: the next sync sends the newest version. A file that only could not be
                // hashed is recorded without its content.
                None if is_sent && local_state(self.target.local, &path) != Some(state) => {
                    self.applied.kept.insert(key);
                }
                None => {}
            }
        }
    }
}

/// A link to send to the VM: its path, its target and its modification second.
struct LinkRecord {
    path: String,
    target: PathBuf,
    seconds: i64,
}

/// What rsync said about `path`, as a suffix of a report line; empty when it said nothing about it.
fn reason(result: &Result<Vec<String>, String>, path: &str) -> String {
    let lines = match result {
        Ok(lines) => lines.as_slice(),
        Err(_) => &[],
    };
    lines.iter().find(|line| line.contains(path)).map(|line| format!(" ({line})")).unwrap_or_default()
}

/// Brings `files` and then `links` from the worktree `remote` on the VM into the empty `staging` folder of the local
/// worktree `local`; the links come last, so that no file lands below one. Returns rsync's complaints about single files.
async fn stage(ssh: &Ssh, local: &Path, remote: &str, staging: &Path, files: &[String], links: &[String]) -> Result<Vec<String>, String> {
    clear_staging(local);
    std::fs::create_dir_all(staging).map_err(|error| format!("failed to create {}: {error}", staging.display()))?;
    let mut lines = transfer(ssh, Direction::Pull, local, remote, files, Some(staging)).await?;
    lines.extend(transfer(ssh, Direction::Pull, local, remote, links, Some(staging)).await?);
    Ok(lines)
}

/// What `stage_fetch` brought into the staging folder, by what this Mac has at each path.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Fetched {
    /// Nothing here yet.
    pub new: Vec<String>,
    /// The same file here already.
    pub same: Vec<String>,
    /// Another version here (or a folder), which stays.
    pub differing: Vec<String>,
    /// A line per path that could not be brought from the VM.
    pub problems: Vec<String>,
}

/// Brings `files` and `links` from the worktree `remote` on the VM into the staging folder of the local worktree
/// `local` and compares each with what is there here; for the files only the VM lists that the Mac ignores. Nothing
/// outside the staging folder changes until `place_fetched`.
pub async fn stage_fetch(ssh: &Ssh, local: &Path, remote: &str, files: &[String], links: &[String]) -> Fetched {
    let staging = local.join(STAGING_DIR);
    let brought = stage(ssh, local, remote, &staging, files, links).await;
    let mut fetched = Fetched::default();
    for path in files.iter().chain(links) {
        if std::fs::symlink_metadata(staging.join(path)).is_err() {
            fetched.problems.push(format!("{path}: could not be brought from the VM{}", reason(&brought, path)));
        } else if std::fs::symlink_metadata(local.join(path)).is_err() {
            fetched.new.push(path.clone());
        } else if is_same_file(&staging.join(path), &local.join(path)) {
            fetched.same.push(path.clone());
        } else {
            fetched.differing.push(path.clone());
        }
    }
    fetched
}

/// Moves the new files of `fetched` from the staging folder into the local worktree `local` as a sync does (never below
/// a local link, no link that could lead outside) and clears the staging folder. Returns the paths it placed and a line
/// per path it could not.
pub fn place_fetched(local: &Path, fetched: &Fetched, ignore_case: bool) -> (Vec<String>, Vec<String>) {
    let staging = local.join(STAGING_DIR);
    let mut placed = Vec::new();
    let mut problems = Vec::new();
    for path in &fetched.new {
        match place(local, &staging, path, ignore_case) {
            Ok(()) => placed.push(path.clone()),
            Err(problem) => problems.push(format!("{path}: {problem}")),
        }
    }
    clear_staging(local);
    (placed, problems)
}

/// Whether `left` and `right` are the same link or regular files with the same content.
fn is_same_file(left: &Path, right: &Path) -> bool {
    let (Ok(left_metadata), Ok(right_metadata)) = (std::fs::symlink_metadata(left), std::fs::symlink_metadata(right)) else { return false };
    let (left_type, right_type) = (left_metadata.file_type(), right_metadata.file_type());
    if left_type.is_symlink() && right_type.is_symlink() {
        return std::fs::read_link(left).ok() == std::fs::read_link(right).ok();
    }
    if !left_type.is_file() || !right_type.is_file() || left_metadata.len() != right_metadata.len() {
        return false;
    }
    matches!((std::fs::read(left), std::fs::read(right)), (Ok(left), Ok(right)) if left == right)
}

/// Removes the staging folder of the local worktree `local`, also what a sync cut short left there.
pub fn clear_staging(local: &Path) {
    let _ = std::fs::remove_dir_all(local.join(STAGING_DIR));
}

/// Moves the staged `path` into `worktree`, refusing a target below a local link (it would land outside the worktree)
/// and a link that points outside the worktree.
fn place(worktree: &Path, staging: &Path, path: &str, ignore_case: bool) -> Result<(), String> {
    if let Some(link) = linked_parent(worktree, path) {
        return Err(format!("not placed here, since {link} is a link"));
    }
    let staged = staging.join(path);
    if std::fs::symlink_metadata(&staged).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        let target = std::fs::read_link(&staged).map_err(|error| format!("could not read the link: {error}"))?;
        if !stays_inside(path, &target) || !resolves_inside(worktree, path, &target) {
            return Err(format!("is a link to {}, which could lead outside the worktree, so it is not placed here", target.display()));
        }
    }
    let destination = worktree.join(path);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "a file here is where the VM has a folder".to_string())?;
    }
    std::fs::rename(&staged, &destination).map_err(|error| match error.raw_os_error() {
        Some(libc::EISDIR | libc::ENOTEMPTY | libc::EEXIST) => "a folder here is where the VM has a file".to_string(),
        Some(libc::ENOTDIR) => "a file here is where the VM has a folder".to_string(),
        _ => format!("could not be moved into the worktree: {error}"),
    })?;
    if ignore_case {
        fix_case(worktree, path);
    }
    Ok(())
}

/// The first folder on the way to the worktree-relative `path` of `worktree` that is a link, if any; resolved like the
/// file system does, so on a case-insensitive Mac in any spelling.
fn linked_parent(worktree: &Path, path: &str) -> Option<String> {
    let mut prefix = PathBuf::new();
    let components: Vec<Component> = Path::new(path).components().collect();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        prefix.push(component);
        let is_link = std::fs::symlink_metadata(worktree.join(&prefix)).is_ok_and(|metadata| metadata.file_type().is_symlink());
        if is_link {
            return Some(prefix.display().to_string());
        }
    }
    None
}

/// Whether a link at the worktree-relative `path` with `target` stays inside the worktree by its text: relative, with
/// `..` only in front (from the link's own folder, which `place` makes sure is no link) and not above the worktree.
/// A `..` after a name could climb out of a link's target (`L/..` with `L -> .`), so it is refused.
fn stays_inside(path: &str, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut depth = Path::new(path).components().count().saturating_sub(1);
    let mut has_name = false;
    for component in target.components() {
        match component {
            Component::ParentDir if has_name || depth == 0 => return false,
            Component::ParentDir => depth -= 1,
            Component::Normal(_) => has_name = true,
            _ => {}
        }
    }
    true
}

/// Whether the part of the link target that exists already resolves inside `worktree`, following the links on its way
/// as the file system does; a local link of the user that points outside must not serve as a way out.
fn resolves_inside(worktree: &Path, path: &str, target: &Path) -> bool {
    let Ok(root) = worktree.canonicalize() else { return false };
    let joined = worktree.join(path).parent().map(|parent| parent.join(target)).unwrap_or_default();
    let mut existing = joined.as_path();
    while existing.symlink_metadata().is_err() {
        let Some(parent) = existing.parent() else { return false };
        existing = parent;
    }
    existing.canonicalize().is_ok_and(|resolved| resolved.starts_with(&root))
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

/// Local paths whose state differs from `manifest` while their content is the blob recorded there; a file that cannot
/// be hashed in its listed state counts as changed.
async fn unchanged_content(worktree: &Path, manifest: &Manifest, local: &Listing, keys: Keys) -> BTreeSet<String> {
    let synced = manifest_by_key(manifest, keys);
    let candidates: Vec<(&String, FileState, &str)> = local
        .iter()
        .filter_map(|(path, state)| {
            let (_, file) = synced.get(&keys.of(path))?;
            let blob = file.blob.as_deref().filter(|_| file.local != *state)?;
            Some((path, *state, blob))
        })
        .collect();
    let files: Vec<(String, FileState)> = candidates.iter().map(|(path, state, _)| ((*path).clone(), *state)).collect();
    let ids = content_ids(worktree, &files).await;
    candidates.into_iter().filter(|(path, _, blob)| ids.get(*path).is_some_and(|id| id == blob)).map(|(path, ..)| path.clone()).collect()
}

/// The blob ids of the local `files` of `worktree` as git stores them, for each that has its given state before and
/// after hashing: a regular file through the repository's clean filters, a link by its text. Anything else, and every
/// file when git does not finish within `HASH_TIMEOUT`, gets none.
pub async fn content_ids(worktree: &Path, files: &[(String, FileState)]) -> BTreeMap<String, String> {
    let stable: Vec<&(String, FileState)> = files.iter().filter(|(path, state)| local_state(worktree, path) == Some(*state)).collect();
    let (links, regular): (Vec<&(String, FileState)>, Vec<&(String, FileState)>) = stable.into_iter().partition(|(_, state)| state.link);
    let mut ids = BTreeMap::new();
    if !regular.is_empty() {
        let input: String = regular.iter().map(|(path, _)| format!("{path}\n")).collect();
        match hash_with_git(worktree, &["hash-object", "--stdin-paths"], input.as_bytes()).await {
            Ok(output) => ids.extend(regular.iter().map(|(path, _)| path.clone()).zip(output.lines().map(str::to_string))),
            // One file the batch fails on (a clean filter, no permission) must not cost the others their id.
            Err(_) => {
                for (path, _) in &regular {
                    match hash_with_git(worktree, &["hash-object", "--", path], &[]).await {
                        Ok(output) => {
                            ids.insert(path.clone(), output.trim().to_string());
                        }
                        Err(error) => eprintln!("hashing {path} of {} failed: {error}", worktree.display()),
                    }
                }
            }
        }
    }
    for (path, _) in links {
        let Ok(target) = std::fs::read_link(worktree.join(path)) else { continue };
        match hash_with_git(worktree, &["hash-object", "--no-filters", "--stdin"], target.as_os_str().as_bytes()).await {
            Ok(output) => {
                ids.insert(path.clone(), output.trim().to_string());
            }
            Err(error) => eprintln!("hashing the link {path} of {} failed: {error}", worktree.display()),
        }
    }
    let files: BTreeMap<&String, FileState> = files.iter().map(|(path, state)| (path, *state)).collect();
    ids.retain(|path, _| files.get(path).is_some_and(|state| local_state(worktree, path) == Some(*state)));
    ids
}

/// Runs git with `args` in `worktree` and `input` on stdin for at most `HASH_TIMEOUT`, killing it when it takes longer.
async fn hash_with_git(worktree: &Path, args: &[&str], input: &[u8]) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(worktree)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to run git: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("failed to open the stdin of git")?;
    let input = input.to_vec();
    let writer = tokio::spawn(async move { stdin.write_all(&input).await });
    let output = tokio::time::timeout(HASH_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("git {} took longer than {} s", args.join(" "), HASH_TIMEOUT.as_secs()))?
        .map_err(|error| format!("failed to run git: {error}"))?;
    let _ = writer.await;
    if !output.status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Whether the local worktree changed since the last sync recorded in `manifest`, file by file: a file with a manifest
/// entry in another state (also one whose move did not complete), a file left alone in another state than then, a new
/// file, or a synced file that is gone. True before the first sync.
pub async fn has_local_changes(local: &Path, manifest: &Path) -> Result<bool, String> {
    let Some(base) = read_manifest(manifest)? else { return Ok(true) };
    let keys = Keys { ignore_case: git::ignores_case(local).await };
    let listing = list_local(local).await?;
    Ok(differs_from_manifest(&base, &listing, keys))
}

/// See `has_local_changes`.
fn differs_from_manifest(base: &Manifest, listing: &Listing, keys: Keys) -> bool {
    let synced = manifest_by_key(base, keys);
    let skipped: BTreeMap<String, FileState> = base.skipped.iter().map(|(path, state)| (keys.of(path), *state)).collect();
    let mut seen = BTreeSet::new();
    for (path, state) in listing {
        let key = keys.of(path);
        let is_unchanged = skipped.get(&key) == Some(state) || synced.get(&key).is_some_and(|(_, file)| file.local == *state);
        if !is_unchanged {
            return true;
        }
        seen.insert(key);
    }
    synced.keys().any(|key| !seen.contains(key))
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

/// The state of the regular file or link at the worktree-relative `path` of `worktree`; `None` when there is none or
/// something else is there (a folder, a pipe).
fn local_state(worktree: &Path, path: &str) -> Option<FileState> {
    let metadata = std::fs::symlink_metadata(worktree.join(path)).ok()?;
    let file_type = metadata.file_type();
    if !file_type.is_file() && !file_type.is_symlink() {
        return None;
    }
    Some(FileState {
        size: metadata.len(),
        modified_ns: metadata.mtime() * NANOS_PER_SECOND + metadata.mtime_nsec(),
        executable: file_type.is_file() && metadata.permissions().mode() & 0o111 != 0,
        link: file_type.is_symlink(),
    })
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

/// Deletes `deleted` in the `worktree` on the VM behind `ssh`, makes `links` there, and returns the state afterwards of
/// those paths and of the `sent` files.
async fn apply_remote(ssh: &Ssh, worktree: &str, deleted: &[String], sent: &[String], links: &[LinkRecord]) -> Result<Listing, String> {
    let output = ssh
        .run_with_input(&as_agent(APPLY_SCRIPT, &[worktree]), &apply_input(deleted, sent, links))
        .await
        .map_err(|error| format!("failed to update the files on the VM: {error}"))?;
    parse_listing(&output).map_err(|error| format!("failed to update the files on the VM: {error}"))
}

/// The stdin of `APPLY_SCRIPT` for `deleted`, `sent` and `links`.
fn apply_input(deleted: &[String], sent: &[String], links: &[LinkRecord]) -> Vec<u8> {
    let mut input = Vec::new();
    for (kind, path) in deleted.iter().map(|path| ("d", path)).chain(sent.iter().map(|path| ("s", path))) {
        input.extend_from_slice(format!("{kind} {path}\0").as_bytes());
    }
    for link in links {
        input.extend_from_slice(format!("l {}\0", link.path).as_bytes());
        input.extend_from_slice(link.target.as_os_str().as_bytes());
        input.extend_from_slice(format!("\0{}\0", link.seconds).as_bytes());
    }
    input
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

/// Reads the output of `APPLY_SCRIPT`; see `parse_records`.
pub fn parse_listing(output: &[u8]) -> Result<Listing, String> {
    let records: Vec<&[u8]> = output.split(|byte| *byte == 0).collect();
    if records.first() != Some(&MARKER) {
        return Err("the script on the VM printed no listing".into());
    }
    Ok(parse_records(&records[1..]))
}

/// Reads `<size> <seconds>.<nanoseconds> <mode in hex> <path>` records of regular files and links; folders, anything
/// else, records that do not parse and paths that cannot sync are left out.
fn parse_records(records: &[&[u8]]) -> Listing {
    let mut listing = Listing::new();
    for record in records.iter().filter(|record| !record.is_empty()) {
        let text = String::from_utf8_lossy(record);
        let mut fields = text.splitn(4, ' ');
        let (Some(size), Some(modified), Some(mode), Some(path)) = (fields.next(), fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let Ok(mode) = u32::from_str_radix(mode, 16) else { continue };
        let (is_file, is_link) = (mode & 0o170000 == 0o100000, mode & 0o170000 == 0o120000);
        if !(is_file || is_link) || !is_syncable(path) {
            continue;
        }
        let (Ok(size), Some(modified_ns)) = (size.parse(), parse_modified(modified)) else { continue };
        listing.insert(path.to_string(), FileState { size, modified_ns, executable: is_file && mode & 0o111 != 0, link: is_link });
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

/// The command that runs `git check-ignore -v` as the agent's user in the worktree on the VM for the NUL-separated
/// paths on stdin; see `git::ignore_rules`.
pub fn remote_ignore_rules_command(worktree: &str) -> String {
    as_agent(r#"cd -- "$1" && { git check-ignore -v -z --no-index --stdin || [ $? -eq 1 ]; }"#, &[worktree])
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: i64 = NANOS_PER_SECOND;

    fn state(size: u64, seconds: i64) -> FileState {
        FileState { size, modified_ns: seconds * SECOND, executable: false, link: false }
    }

    fn listing(entries: &[(&str, FileState)]) -> Listing {
        entries.iter().map(|(path, state)| (path.to_string(), *state)).collect()
    }

    fn manifest(entries: &[(&str, FileState, FileState)]) -> Manifest {
        let file = |local: &FileState, remote: &FileState| SyncedFile { local: *local, remote: *remote, blob: None };
        let files = entries.iter().map(|(path, local, remote)| (path.to_string(), file(local, remote)));
        Manifest { files: files.collect(), skipped: BTreeMap::new() }
    }

    fn set(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    const EXACT: Keys = Keys { ignore_case: false };
    const FOLDED: Keys = Keys { ignore_case: true };

    /// The plan against `manifest`, with `edits` the paths that differ from the snapshot.
    fn plan_of(
        manifest: Option<&Manifest>,
        edits: &[&str],
        local: &Listing,
        remote: &Listing,
        keys: Keys,
        unlisted: &[&str],
        same_content: &[&str],
    ) -> Plan {
        let (edits, unlisted, same_content) = (set(edits), set(unlisted), set(same_content));
        plan(&Inputs { manifest, edits: Some(&edits), local, remote, keys, unlisted: &unlisted, same_content: &same_content })
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
        let plan = plan_of(None, &["edited.txt", "new-here.txt", "deleted-here.txt"], &local, &remote, EXACT, &[], &[]);
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
        // A new local file differs from the snapshot both sides started from.
        let plan = plan_of(Some(&base), &["new-here.txt"], &local, &remote, EXACT, &[], &[]);
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
        let plan = plan_of(Some(&base), &[], &local, &remote, EXACT, &[".env", "ignored-here.txt"], &[]);
        assert_eq!(plan, Plan::default());
        let unlisted = set(&[".env", "ignored-here.txt"]);
        let next = next_manifest(Some(&base), &local, &remote, EXACT, &unlisted, &BTreeSet::new(), &Applied::default());
        assert!(next.files.is_empty());
        assert_eq!(next.skipped, BTreeMap::from([(".env".to_string(), state(1, 10))]), "a local file left alone is noted with its state");
    }

    #[test]
    fn equal_size_and_second_count_as_in_sync_so_a_lost_manifest_pushes_nothing_back() {
        let base = manifest(&[("pulled.txt", state(1, 10), state(1, 20))]);
        // A pull landed (the VM's time to the second) but its manifest entry was not saved.
        let local = listing(&[("pulled.txt", state(5, 30))]);
        let remote = listing(&[("pulled.txt", FileState { modified_ns: 30 * SECOND + 123, ..state(5, 30) })]);
        assert_eq!(plan_of(Some(&base), &[], &local, &remote, EXACT, &[], &[]), Plan::default());
        let other_second = listing(&[("pulled.txt", state(5, 31))]);
        assert_eq!(plan_of(Some(&base), &[], &other_second, &remote, EXACT, &[], &[]).push, paths(&["pulled.txt"]));
    }

    #[test]
    fn a_local_file_whose_content_did_not_change_takes_the_vms_change() {
        let base = manifest(&[("lock.json", state(9, 10), state(9, 20))]);
        let local = listing(&[("lock.json", state(9, 15))]);
        let remote = listing(&[("lock.json", state(12, 21))]);
        let plan = plan_of(Some(&base), &[], &local, &remote, EXACT, &[], &["lock.json"]);
        assert_eq!(plan.pull, paths(&["lock.json"]));
        assert!(plan.push.is_empty());
        let plan = plan_of(Some(&base), &[], &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan.push, paths(&["lock.json"]));
    }

    #[test]
    fn a_case_only_rename_on_the_vm_comes_here_as_a_rename_on_a_case_insensitive_mac() {
        let base = manifest(&[("src/Foo.ts", state(4, 10), state(4, 20))]);
        let local = listing(&[("src/Foo.ts", state(4, 10))]);
        let remote = listing(&[("src/foo.ts", state(4, 25))]);
        let plan = plan_of(Some(&base), &[], &local, &remote, FOLDED, &[], &[]);
        assert_eq!(plan, Plan { pull: paths(&["src/foo.ts"]), ..Plan::default() });
        // Edited here meanwhile: the content goes to the VM under the VM's name.
        let edited = listing(&[("src/Foo.ts", state(6, 11))]);
        let plan = plan_of(Some(&base), &[], &edited, &remote, FOLDED, &[], &[]);
        assert_eq!(plan, Plan { push: paths(&["src/foo.ts"]), ..Plan::default() });
        // A case-sensitive Mac sees two files.
        let plan = plan_of(Some(&base), &[], &local, &remote, EXACT, &[], &[]);
        assert_eq!((plan.delete_local, plan.pull), (paths(&["src/Foo.ts"]), paths(&["src/foo.ts"])));
    }

    #[test]
    fn names_that_differ_only_in_case_on_the_vm_are_reported_instead_of_synced() {
        let remote = listing(&[("README.md", state(1, 20)), ("readme.md", state(2, 20)), ("other.txt", state(1, 20))]);
        let plan = plan_of(None, &[], &Listing::new(), &remote, FOLDED, &[], &[]);
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
        assert!(next.skipped.is_empty(), "a file whose send failed counts as a local change until it moved");
        assert!(differs_from_manifest(&next, &local, EXACT));
        // The next plan retries only the failed send.
        let local = listing(&[("kept.txt", state(1, 10)), ("failed.txt", state(2, 11)), ("sent.txt", state(3, 12)), ("brought.txt", state(4, 21))]);
        let remote = listing(&[("kept.txt", state(1, 20)), ("failed.txt", state(1, 20)), ("brought.txt", state(4, 21)), ("sent.txt", state(3, 12))]);
        let plan = plan_of(Some(&next), &[], &local, &remote, EXACT, &[], &[]);
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
        assert_eq!(listed["src/a b.ts"], FileState { size: 12, modified_ns: 1_792_007_100_397_698_338, executable: false, link: false });
        assert!(listed["#link"].link && !listed["#link"].executable);
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
        let ids = content_ids(worktree, &[("kept.txt".to_string(), local["kept.txt"])]).await;
        let synced = |blob: &str| SyncedFile { local: state(0, 0), remote: state(0, 0), blob: Some(blob.to_string()) };
        let files = [("kept.txt".to_string(), synced(&ids["kept.txt"])), ("edited.txt".to_string(), synced("0000"))].into();
        let base = Manifest { files, skipped: BTreeMap::new() };
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
        write_manifest(&manifest_path, &Manifest { files: files.collect(), skipped: BTreeMap::new() }).unwrap();
        assert!(!has_local_changes(worktree, &manifest_path).await.unwrap());
        std::fs::write(worktree.join("untracked.txt"), "changed").unwrap();
        assert!(has_local_changes(worktree, &manifest_path).await.unwrap());
        assert!(!manifest_path.with_extension("json.tmp").exists());

        forget(&manifest_path).unwrap();
        forget(&manifest_path).unwrap();
        assert_eq!(read_manifest(&manifest_path).unwrap(), None);
    }

    #[test]
    fn a_file_the_agent_recreated_comes_here_while_a_new_local_file_goes_to_the_vm() {
        // src/a.ts was in the snapshot; the agent deleted it, the sync deleted it here, and now the agent made it again.
        // In the same sync the user created a file, so the snapshot rule must not call src/a.ts a local deletion.
        let base = manifest(&[("other.txt", state(1, 10), state(1, 20))]);
        let local = listing(&[("new.txt", state(1, 30)), ("other.txt", state(1, 10))]);
        let remote = listing(&[("src/a.ts", state(3, 40)), ("other.txt", state(1, 20))]);
        let plan = plan_of(Some(&base), &["src/a.ts", "new.txt"], &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan, Plan { push: paths(&["new.txt"]), pull: paths(&["src/a.ts"]), ..Plan::default() });
    }

    #[test]
    fn a_file_without_an_entry_is_a_local_edit_unless_it_is_as_the_sync_left_it_alone() {
        let mut base = manifest(&[]);
        base.skipped.insert("stale.txt".into(), state(2, 30));
        base.skipped.insert("never-synced.txt".into(), state(1, 30));
        base.skipped.insert("edited.txt".into(), state(2, 30));
        // The VM lists the first two again after it ignored them for a while; it never had the third.
        let local = listing(&[("stale.txt", state(2, 30)), ("never-synced.txt", state(1, 30)), ("edited.txt", state(5, 31))]);
        let remote = listing(&[("stale.txt", state(3, 40)), ("edited.txt", state(3, 40))]);
        let plan = plan_of(Some(&base), &[], &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan, Plan { push: paths(&["edited.txt"]), pull: paths(&["stale.txt"]), ..Plan::default() });
    }

    #[test]
    fn without_the_snapshot_a_local_file_without_an_entry_is_never_deleted() {
        let local = listing(&[("new.txt", state(1, 30))]);
        let unlisted = BTreeSet::new();
        let remote = Listing::new();
        let inputs = Inputs { manifest: None, edits: None, local: &local, remote: &remote, keys: EXACT, unlisted: &unlisted, same_content: &unlisted };
        assert_eq!(plan(&inputs), Plan { push: paths(&["new.txt"]), ..Plan::default() });
    }

    #[test]
    fn a_change_of_the_execute_bit_alone_syncs() {
        let base = manifest(&[("run.sh", state(4, 10), state(4, 20))]);
        let local = listing(&[("run.sh", state(4, 10))]);
        let remote = listing(&[("run.sh", FileState { executable: true, ..state(4, 20) })]);
        assert_eq!(plan_of(Some(&base), &[], &local, &remote, EXACT, &[], &[]).pull, paths(&["run.sh"]));
        assert!(!state(4, 20).matches(&FileState { executable: true, ..state(4, 20) }));
        assert!(!state(4, 20).matches(&FileState { link: true, ..state(4, 20) }));

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("run.sh"), "echo").unwrap();
        assert!(!local_state(dir.path(), "run.sh").unwrap().executable);
        std::fs::set_permissions(dir.path().join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(local_state(dir.path(), "run.sh").unwrap().executable);
        let records: [&[u8]; 2] = [b"4 1792007100.0 81ed run.sh", b"4 1792007100.0 81a4 plain.sh"];
        let parsed = parse_records(&records);
        assert!(parsed["run.sh"].executable && !parsed["plain.sh"].executable);
    }

    #[tokio::test]
    async fn a_file_git_cannot_hash_costs_only_its_own_id_and_stays_recorded_when_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        git::run_git(worktree, &["init", "-q"]).await.unwrap();
        std::fs::write(worktree.join("readable.txt"), "content").unwrap();
        std::fs::write(worktree.join("locked.txt"), "secret").unwrap();
        std::fs::set_permissions(worktree.join("locked.txt"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let listed = |path: &str| local_state(worktree, path).unwrap();
        let files = [("readable.txt".to_string(), listed("readable.txt")), ("locked.txt".to_string(), listed("locked.txt"))];
        let ids = content_ids(worktree, &files).await;
        assert_eq!(ids.keys().cloned().collect::<Vec<_>>(), paths(&["readable.txt"]));

        let local = listing(&[("readable.txt", listed("readable.txt")), ("locked.txt", listed("locked.txt"))]);
        let target = SyncTarget { local: worktree, remote: "/home/agent/app", manifest: Path::new("/nonexistent"), base_ref: "refs/x" };
        let mut run = run(&target, EXACT, &local, &Listing::new());
        for path in ["readable.txt", "locked.txt"] {
            run.applied.remote.insert(path.into(), Some(Entry { path: path.to_string(), state: state(1, 50) }));
        }
        run.hash_moved_files().await;
        assert!(run.applied.kept.is_empty(), "an unchanged file that could not be hashed is recorded without its content");
        assert!(run.applied.blobs.contains_key("readable.txt") && !run.applied.blobs.contains_key("locked.txt"));
        std::fs::set_permissions(worktree.join("locked.txt"), std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn a_fetched_ignored_file_never_replaces_another_local_version() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        let staging = worktree.join(STAGING_DIR);
        std::fs::create_dir_all(&staging).unwrap();
        // .env.local is ignored here only; the user edited it during the session.
        std::fs::write(worktree.join(".env.local"), "TOKEN=mine").unwrap();
        std::fs::write(staging.join(".env.local"), "TOKEN=vm").unwrap();
        std::fs::write(worktree.join("same.log"), "line").unwrap();
        std::fs::write(staging.join("same.log"), "line").unwrap();
        std::fs::write(staging.join("new.log"), "fresh").unwrap();
        assert!(!is_same_file(&staging.join(".env.local"), &worktree.join(".env.local")));
        assert!(is_same_file(&staging.join("same.log"), &worktree.join("same.log")));
        std::os::unix::fs::symlink("a", staging.join("link")).unwrap();
        std::os::unix::fs::symlink("a", worktree.join("link")).unwrap();
        assert!(is_same_file(&staging.join("link"), &worktree.join("link")));

        let (new, same, differing) = (paths(&["new.log"]), paths(&["same.log", "link"]), paths(&[".env.local"]));
        let fetched = Fetched { new, same, differing, problems: Vec::new() };
        let (placed, problems) = place_fetched(worktree, &fetched, false);
        assert_eq!((placed, problems), (paths(&["new.log"]), Vec::new()));
        assert_eq!(std::fs::read_to_string(worktree.join(".env.local")).unwrap(), "TOKEN=mine");
        assert_eq!(std::fs::read_to_string(worktree.join("new.log")).unwrap(), "fresh");
        assert!(!staging.exists(), "the staging folder is cleared");
    }

    #[test]
    fn a_pull_the_agent_overtook_in_the_first_sync_does_not_turn_into_a_local_edit() {
        // Scenario A: the first sync of an adopted session plans to pull x.ts while the agent writes it.
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        std::fs::write(worktree.join("x.ts"), "snapshot").unwrap();
        let staging = worktree.join(STAGING_DIR);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("x.ts"), "agent, half written").unwrap();
        let local = listing(&[("x.ts", local_state(worktree, "x.ts").unwrap())]);
        let remote = listing(&[("x.ts", state(40, 60))]);
        assert_eq!(plan_of(None, &[], &local, &remote, EXACT, &[], &[]).pull, paths(&["x.ts"]));
        let target = SyncTarget { local: worktree, remote: "/home/agent/app", manifest: Path::new("/nonexistent"), base_ref: "refs/x" };
        let mut run = run(&target, EXACT, &local, &remote);
        run.move_in_all(&staging, &paths(&["x.ts"]), &Ok(Vec::new()));
        assert!(run.applied.kept.contains("x.ts") && run.outcome.pulled == 0);
        assert_eq!(std::fs::read_to_string(worktree.join("x.ts")).unwrap(), "snapshot");

        let next = next_manifest(None, &local, &remote, EXACT, &BTreeSet::new(), &BTreeSet::new(), &run.applied);
        assert_eq!(next.skipped.get("x.ts"), Some(&local["x.ts"]));
        // The next sync brings the agent's version instead of sending the snapshot's.
        let remote = listing(&[("x.ts", state(48, 70))]);
        let plan = plan_of(Some(&next), &[], &local, &remote, EXACT, &[], &[]);
        assert_eq!(plan, Plan { pull: paths(&["x.ts"]), ..Plan::default() });
    }

    #[test]
    fn a_file_left_alone_stays_left_alone_when_its_pull_is_kept() {
        // Scenario C: x.ts was unlisted on the VM, is listed again, and its pull does not complete.
        let mut base = manifest(&[]);
        base.skipped.insert("x.ts".into(), state(2, 30));
        let local = listing(&[("x.ts", state(2, 30))]);
        let remote = listing(&[("x.ts", state(3, 40))]);
        assert_eq!(plan_of(Some(&base), &[], &local, &remote, EXACT, &[], &[]).pull, paths(&["x.ts"]));
        let applied = Applied { kept: set(&["x.ts"]), ..Applied::default() };
        let next = next_manifest(Some(&base), &local, &remote, EXACT, &BTreeSet::new(), &BTreeSet::new(), &applied);
        assert_eq!(next.skipped.get("x.ts"), Some(&state(2, 30)));
        assert!(!differs_from_manifest(&next, &local, EXACT));
        assert_eq!(plan_of(Some(&next), &[], &local, &remote, EXACT, &[], &[]).pull, paths(&["x.ts"]));
    }

    #[test]
    fn a_kept_send_without_an_entry_still_counts_as_a_local_change() {
        let base = manifest(&[]);
        let local = listing(&[("new.txt", state(1, 30))]);
        assert_eq!(plan_of(Some(&base), &[], &local, &Listing::new(), EXACT, &[], &[]).push, paths(&["new.txt"]));
        let applied = Applied { kept: set(&["new.txt"]), ..Applied::default() };
        let next = next_manifest(Some(&base), &local, &Listing::new(), EXACT, &BTreeSet::new(), &BTreeSet::new(), &applied);
        assert!(next.files.is_empty() && next.skipped.is_empty());
        assert!(differs_from_manifest(&next, &local, EXACT), "a prompt waits until the file reached the VM");
    }

    #[test]
    fn the_manifest_tells_local_changes_file_by_file() {
        let mut base = manifest(&[("synced.txt", state(1, 10), state(1, 20))]);
        base.skipped.insert("ignored-there.txt".into(), state(2, 10));
        let listing_of = |entries: &[(&str, FileState)]| listing(entries);
        let unchanged = listing_of(&[("synced.txt", state(1, 10)), ("ignored-there.txt", state(2, 10))]);
        assert!(!differs_from_manifest(&base, &unchanged, EXACT), "a file left alone in its old state is no change");
        assert!(differs_from_manifest(&base, &listing_of(&[("synced.txt", state(1, 10)), ("ignored-there.txt", state(3, 11))]), EXACT));
        assert!(differs_from_manifest(&base, &listing_of(&[("synced.txt", state(1, 11)), ("ignored-there.txt", state(2, 10))]), EXACT));
        assert!(differs_from_manifest(&base, &listing_of(&[("ignored-there.txt", state(2, 10))]), EXACT), "a synced file that is gone");
        let with_new = listing_of(&[("synced.txt", state(1, 10)), ("ignored-there.txt", state(2, 10)), ("new.txt", state(1, 12))]);
        assert!(differs_from_manifest(&base, &with_new, EXACT));
    }

    #[test]
    fn a_staged_file_never_lands_below_a_local_link_and_a_link_never_points_outside() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().join("worktree");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, worktree.join("D")).unwrap();
        let staging = worktree.join(STAGING_DIR);
        std::fs::create_dir_all(staging.join("D")).unwrap();
        std::fs::write(staging.join("D/evil.plist"), "x").unwrap();
        assert_eq!(place(&worktree, &staging, "D/evil.plist", false), Err("not placed here, since D is a link".to_string()));
        assert!(!outside.join("evil.plist").exists());
        assert_eq!(linked_parent(&worktree, "D/evil.plist"), Some("D".to_string()));
        assert_eq!(linked_parent(&worktree, "D"), None, "the link itself is no parent");

        std::os::unix::fs::symlink("../../outside", staging.join("escape")).unwrap();
        assert!(place(&worktree, &staging, "escape", false).unwrap_err().contains("outside the worktree"));
        // A link may climb only from its own folder: `D/..` could leave the worktree through a link chain.
        std::os::unix::fs::symlink("D/../inside.txt", staging.join("chain")).unwrap();
        assert!(place(&worktree, &staging, "chain", false).unwrap_err().contains("could lead outside the worktree"));
        std::fs::create_dir_all(staging.join("sub")).unwrap();
        std::os::unix::fs::symlink("../inside.txt", staging.join("sub/fine")).unwrap();
        assert_eq!(place(&worktree, &staging, "sub/fine", false), Ok(()));
        assert!(std::fs::symlink_metadata(worktree.join("sub/fine")).unwrap().file_type().is_symlink());
        // Through the user's own link D, which points outside, a link would lead out as well.
        std::os::unix::fs::symlink("D/evil.plist", staging.join("via")).unwrap();
        assert!(place(&worktree, &staging, "via", false).unwrap_err().contains("could lead outside the worktree"));

        assert!(stays_inside("a/b/link", Path::new("../c")));
        assert!(stays_inside("link", Path::new("x/y")));
        assert!(!stays_inside("link", Path::new("../x")));
        assert!(!stays_inside("a/link", Path::new("../../x")));
        assert!(!stays_inside("a/link", Path::new("/etc/passwd")));
        assert!(!stays_inside("a/b/link", Path::new("L/../x")), "a `..` after a name is refused");
    }

    #[tokio::test]
    async fn links_and_pipes_are_hashed_without_reading_what_they_point_at() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        git::run_git(worktree, &["init", "-q"]).await.unwrap();
        std::os::unix::fs::symlink("/dev/zero", worktree.join("zero")).unwrap();
        let fifo = std::ffi::CString::new(worktree.join("pipe").as_os_str().as_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
        std::fs::write(worktree.join("file.txt"), "content").unwrap();

        assert_eq!(local_state(worktree, "pipe"), None, "a pipe is no file to sync");
        let zero = local_state(worktree, "zero").unwrap();
        assert!(zero.link && zero.size == "/dev/zero".len() as u64);
        let file = local_state(worktree, "file.txt").unwrap();
        // Given as a file, the pipe must not be opened.
        let pipe = FileState { size: 0, modified_ns: 0, executable: false, link: false };
        let files = [("zero".to_string(), zero), ("pipe".to_string(), pipe), ("file.txt".to_string(), file)];
        let ids = tokio::time::timeout(Duration::from_secs(20), content_ids(worktree, &files)).await.expect("hashing finished");
        assert_eq!(ids.keys().cloned().collect::<Vec<_>>(), paths(&["file.txt", "zero"]));
        let link_id = hash_with_git(worktree, &["hash-object", "--no-filters", "--stdin"], b"/dev/zero").await.unwrap();
        assert_eq!(ids["zero"], link_id.trim());
    }

    #[tokio::test]
    async fn a_moved_file_saved_again_during_the_sync_gets_no_blob_and_a_sent_one_waits() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        git::run_git(worktree, &["init", "-q"]).await.unwrap();
        std::fs::write(worktree.join("sent.txt"), "v1").unwrap();
        std::fs::write(worktree.join("pulled.txt"), "vm").unwrap();
        std::fs::write(worktree.join("steady.txt"), "same").unwrap();
        let listed = |path: &str| local_state(worktree, path).unwrap();
        let local = listing(&[("sent.txt", listed("sent.txt")), ("steady.txt", listed("steady.txt"))]);
        let target = SyncTarget { local: worktree, remote: "/home/agent/app", manifest: Path::new("/nonexistent"), base_ref: "refs/x" };
        let mut run = run(&target, EXACT, &local, &Listing::new());
        let entry = |path: &str, state: FileState| Some(Entry { path: path.to_string(), state });
        run.applied.remote.insert("sent.txt".into(), entry("sent.txt", state(2, 50)));
        run.applied.remote.insert("steady.txt".into(), entry("steady.txt", state(4, 50)));
        run.applied.local.insert("pulled.txt".into(), entry("pulled.txt", listed("pulled.txt")));

        // Saved again after the listing: v2 must still count as a local change.
        std::fs::write(worktree.join("sent.txt"), "v2, longer").unwrap();
        run.hash_moved_files().await;
        assert!(!run.applied.blobs.contains_key("sent.txt"));
        assert!(run.applied.kept.contains("sent.txt"));
        assert!(run.applied.blobs.contains_key("steady.txt") && run.applied.blobs.contains_key("pulled.txt"));
        assert!(!run.applied.kept.contains("steady.txt"));
    }
}
