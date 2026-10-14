//! Two-way sync of a remote session's files between its worktree on the VM and its local worktree, so that the diff,
//! the editor and the diagram show the agent's changes and local edits reach the agent. Each side lists the files Git
//! sees there (`git ls-files --cached --others --exclude-standard`: tracked and untracked, not ignored) with their size
//! and modification time. The manifest holds both sides' state after the last sync, so a difference tells which side
//! changed a file: a file changed here goes to the VM, also when the agent changed it too (the local version wins); a
//! file changed only on the VM comes here; deletions follow the same rule. rsync moves the content over the session's
//! SSH connection as the VM's `agent` user, who owns the worktree there. Without a manifest (the first sync after a
//! handoff or an adoption) the VM's files replace the local ones. Knows nothing about Tauri.

use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::shell_command;
use super::ssh::Ssh;
use crate::git;

/// The rsync the VM runs: as the agent's user, who owns the session's worktree.
const REMOTE_RSYNC: &str = "sudo -n -u agent rsync";

/// The first record the scripts print, which tells an empty listing from a script that never got that far.
const MARKER: &[u8] = b"hunt-sync";

/// Prints `MARKER`, then `<size> <seconds>.<nanoseconds> <mode in hex> <path>` for every file Git sees in the worktree
/// `$1`, each record ended by NUL. A file deleted since Git listed it is left out.
const LIST_SCRIPT: &str = r#"
set -euo pipefail
cd -- "$1"
list=$(mktemp)
trap 'rm -f -- "$list"' EXIT
git ls-files -z --cached --others --exclude-standard >"$list"
printf 'hunt-sync\0'
LC_ALL=C xargs -0r stat --printf '%s %.9Y %f %n\0' -- <"$list" 2>/dev/null || true
"#;

/// Reads `<d|s> <path>` records ended by NUL from stdin, deletes the `d` paths in the worktree `$1`, and prints
/// `MARKER` and the state of every path that still exists afterwards, as `LIST_SCRIPT` does.
const APPLY_SCRIPT: &str = r#"
set -euo pipefail
cd -- "$1"
paths=()
while IFS= read -r -d '' entry; do
  path=${entry:2}
  if [[ ${entry:0:2} == 'd ' ]]; then
    rm -f -- "$path" 2>/dev/null || true
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

/// The files of one side, by worktree-relative path.
pub type Listing = BTreeMap<String, FileState>;

/// A file both sides had after the last sync, with its state on each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncedFile {
    pub local: FileState,
    pub remote: FileState,
}

/// Both sides' state after the last sync.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub files: BTreeMap<String, SyncedFile>,
}

/// What one sync does, each list sorted by path.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Plan {
    pub push: Vec<String>,
    pub pull: Vec<String>,
    pub delete_remote: Vec<String>,
    pub delete_local: Vec<String>,
}

/// What a sync changed: files sent to the VM, files brought here, and files deleted on either side.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub pushed: usize,
    pub pulled: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
}

impl Outcome {
    /// Whether the sync changed files in the local worktree.
    pub fn changed_local(&self) -> bool {
        self.pulled > 0 || self.deleted_local > 0
    }
}

/// The session whose files a sync moves: its local worktree, its worktree on the VM and where its manifest lives.
pub struct SyncTarget<'a> {
    pub local: &'a Path,
    pub remote: &'a str,
    pub manifest: &'a Path,
}

/// Which way rsync copies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// From the local worktree to the VM.
    Push,
    /// From the VM to the local worktree.
    Pull,
}

/// What syncing `local` with `remote` takes, given the state `base` of the last sync. A file changed here since then is
/// sent (or deleted on the VM), whatever the VM did to it; a file changed only on the VM comes here (or is deleted here).
/// Without a base every file of the VM comes here and every other local one is deleted.
pub fn plan(base: Option<&Manifest>, local: &Listing, remote: &Listing) -> Plan {
    let mut plan = Plan::default();
    let Some(base) = base else {
        plan.pull = remote.keys().cloned().collect();
        plan.delete_local = local.keys().filter(|path| !remote.contains_key(*path)).cloned().collect();
        return plan;
    };
    let paths: BTreeSet<&String> = local.keys().chain(remote.keys()).chain(base.files.keys()).collect();
    for path in paths {
        let synced = base.files.get(path);
        let (here, there) = (local.get(path), remote.get(path));
        if here != synced.map(|file| &file.local) {
            if here.is_some() {
                plan.push.push(path.clone());
            } else if there.is_some() {
                plan.delete_remote.push(path.clone());
            }
        } else if there != synced.map(|file| &file.remote) {
            if there.is_some() {
                plan.pull.push(path.clone());
            } else if here.is_some() {
                plan.delete_local.push(path.clone());
            }
        }
    }
    plan
}

/// The manifest after `plan` ran on the listings `local` and `remote`: the files on both sides, the moved and deleted
/// ones with their state afterwards, `local_after` for the local side and `remote_after` (which lacks the files gone
/// from the VM) for the VM.
pub fn next_manifest(
    local: &Listing,
    remote: &Listing,
    plan: &Plan,
    local_after: impl Fn(&str) -> Option<FileState>,
    remote_after: &Listing,
) -> Manifest {
    let mut local = local.clone();
    let mut remote = remote.clone();
    for path in plan.pull.iter().chain(&plan.delete_local) {
        match local_after(path) {
            Some(state) => local.insert(path.clone(), state),
            None => local.remove(path),
        };
    }
    for path in plan.push.iter().chain(&plan.delete_remote) {
        match remote_after.get(path) {
            Some(state) => remote.insert(path.clone(), *state),
            None => remote.remove(path),
        };
    }
    let files = local
        .into_iter()
        .filter_map(|(path, here)| {
            let there = *remote.get(&path)?;
            Some((path, SyncedFile { local: here, remote: there }))
        })
        .collect();
    Manifest { files }
}

/// Syncs the files of `target` over `ssh` (see the module comment) and records the new manifest.
pub async fn sync(target: &SyncTarget<'_>, ssh: &Ssh) -> Result<Outcome, String> {
    let base = read_manifest(target.manifest)?;
    let remote = list_remote(ssh, target.remote).await?;
    let local = list_local(target.local).await?;
    let mut plan = plan(base.as_ref(), &local, &remote);
    // A file saved here since the listing wins over the VM's version; the next sync sends it.
    let is_unchanged_here = |path: &String| local_state(target.local, path) == local.get(path).copied();
    plan.pull.retain(is_unchanged_here);
    plan.delete_local.retain(is_unchanged_here);

    transfer(ssh, Direction::Push, target.local, target.remote, &plan.push).await?;
    let remote_after = if plan.push.is_empty() && plan.delete_remote.is_empty() {
        Listing::new()
    } else {
        apply_remote(ssh, target.remote, &plan.delete_remote, &plan.push).await?
    };
    transfer(ssh, Direction::Pull, target.local, target.remote, &plan.pull).await?;
    for path in &plan.delete_local {
        delete_local(target.local, path)?;
    }

    let next = next_manifest(&local, &remote, &plan, |path| local_state(target.local, path), &remote_after);
    if base.as_ref() != Some(&next) {
        write_manifest(target.manifest, &next)?;
    }
    Ok(Outcome {
        pushed: plan.push.len(),
        pulled: plan.pull.len(),
        deleted_remote: plan.delete_remote.len(),
        deleted_local: plan.delete_local.len(),
    })
}

/// Whether the local worktree changed since the last sync recorded in `manifest`; true before the first one.
pub async fn has_local_changes(local: &Path, manifest: &Path) -> Result<bool, String> {
    let Some(base) = read_manifest(manifest)? else { return Ok(true) };
    let listing = list_local(local).await?;
    let is_synced = |(path, state): (&String, &FileState)| base.files.get(path).is_some_and(|file| file.local == *state);
    Ok(listing.len() != base.files.len() || !listing.iter().all(is_synced))
}

/// Copies the worktree-relative `paths` between the local worktree `local` and the worktree `remote` on the VM behind
/// `ssh`, as `direction` says; for files outside the synced ones, such as the diagram in `.hunt/`.
pub async fn copy_files(ssh: &Ssh, direction: Direction, local: &Path, remote: &str, paths: &[String]) -> Result<(), String> {
    transfer(ssh, direction, local, remote, paths).await
}

/// Deletes the manifest at `path`, so the next sync of the session starts over from the VM's files.
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
    Some(FileState { size: metadata.len(), modified_ns: metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec() })
}

/// The files Git sees in the `worktree` on the VM behind `ssh`.
async fn list_remote(ssh: &Ssh, worktree: &str) -> Result<Listing, String> {
    let output = ssh
        .run_with_input(&as_agent(LIST_SCRIPT, &[worktree]), &[])
        .await
        .map_err(|error| format!("failed to list the files on the VM: {error}"))?;
    parse_listing(&output).map_err(|error| format!("failed to list the files on the VM: {error}"))
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

/// Deletes the file at the worktree-relative `path` of the local `worktree`; one that is gone already counts as deleted.
fn delete_local(worktree: &Path, path: &str) -> Result<(), String> {
    match std::fs::remove_file(worktree.join(path)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("failed to delete {path}: {error}")),
        _ => Ok(()),
    }
}

/// Copies `paths` with rsync as `direction` says. Files that vanished between the listing and the copy are skipped;
/// the next sync sees them gone.
async fn transfer(ssh: &Ssh, direction: Direction, local: &Path, remote: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let what = match direction {
        Direction::Push => format!("send {} files to the VM", paths.len()),
        Direction::Pull => format!("bring {} files from the VM", paths.len()),
    };
    let list = std::env::temp_dir().join(format!("hunt-sync-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&list, files_from(paths)).map_err(|error| format!("failed to {what}: {error}"))?;
    let args = rsync_args(&ssh.git_ssh_command(), &list, direction, local, &ssh.rsync_location(remote));
    let output = Command::new("rsync").args(&args).output().await;
    let _ = std::fs::remove_file(&list);
    let output = output.map_err(|error| format!("failed to {what}: failed to run rsync: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() || (matches!(output.status.code(), Some(23 | 24)) && reports_only_vanished_files(&stderr)) {
        return Ok(());
    }
    Err(format!("failed to {what}: rsync exited with {}: {}", output.status.code().unwrap_or(-1), stderr.trim()))
}

/// The `--files-from` list of `paths`: one per line.
fn files_from(paths: &[String]) -> String {
    paths.iter().map(|path| format!("{path}\n")).collect()
}

/// The arguments of rsync that copy the files `files_from` lists between the local worktree `local` and the worktree
/// at `remote` (`<host>:<path>`), reaching the VM with `ssh_command`. Only flags macOS' openrsync knows: it speaks
/// protocol 29, and its `-e` keeps single-quoted words together.
pub fn rsync_args(ssh_command: &str, files_from: &Path, direction: Direction, local: &Path, remote: &str) -> Vec<String> {
    let local = format!("{}/", local.display());
    let remote = format!("{remote}/");
    let (source, destination) = match direction {
        Direction::Push => (local, remote),
        Direction::Pull => (remote, local),
    };
    vec![
        "-rltpz".to_string(),
        format!("--files-from={}", files_from.display()),
        "-e".to_string(),
        ssh_command.to_string(),
        format!("--rsync-path={REMOTE_RSYNC}"),
        source,
        destination,
    ]
}

/// Whether the error output of an rsync that exited with 23 or 24 only reports source files that no longer exist.
fn reports_only_vanished_files(stderr: &str) -> bool {
    let is_vanished = |line: &str| {
        line.contains("No such file or directory") || line.starts_with("rsync error: some files") || line.starts_with("file has vanished")
    };
    stderr.lines().map(str::trim).filter(|line| !line.is_empty()).all(is_vanished)
}

/// Reads the output of `LIST_SCRIPT` or `APPLY_SCRIPT`; folders, records that do not parse and paths that cannot sync
/// are left out.
pub fn parse_listing(output: &[u8]) -> Result<Listing, String> {
    let mut records = output.split(|byte| *byte == 0);
    if records.next() != Some(MARKER) {
        return Err("the script on the VM printed no listing".into());
    }
    let mut listing = Listing::new();
    for record in records.filter(|record| !record.is_empty()) {
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
    Ok(listing)
}

/// `<seconds>.<fraction>` as nanoseconds; the fraction may have up to nine digits.
fn parse_modified(text: &str) -> Option<i64> {
    let (seconds, fraction) = text.split_once('.').unwrap_or((text, ""));
    if fraction.len() > 9 || !fraction.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let seconds: i64 = seconds.parse().ok()?;
    let nanos: i64 = format!("{fraction:0<9}").parse().ok()?;
    seconds.checked_mul(1_000_000_000)?.checked_add(nanos)
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

/// Replaces the manifest at `path` through a temp file, so a crash mid-write leaves the previous one.
fn write_manifest(path: &Path, manifest: &Manifest) -> Result<(), String> {
    let failed = |error: &dyn std::fmt::Display| format!("failed to write the sync state {}: {error}", path.display());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| failed(&error))?;
    }
    let text = serde_json::to_string(manifest).map_err(|error| failed(&error))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|error| failed(&error))?;
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

    fn state(size: u64, modified_ns: i64) -> FileState {
        FileState { size, modified_ns }
    }

    fn listing(entries: &[(&str, FileState)]) -> Listing {
        entries.iter().map(|(path, state)| (path.to_string(), *state)).collect()
    }

    fn manifest(entries: &[(&str, FileState, FileState)]) -> Manifest {
        let files = entries.iter().map(|(path, local, remote)| (path.to_string(), SyncedFile { local: *local, remote: *remote }));
        Manifest { files: files.collect() }
    }

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn plan_without_a_base_takes_the_vms_files() {
        let local = listing(&[("both.txt", state(1, 1)), ("local-only.txt", state(1, 1))]);
        let remote = listing(&[("both.txt", state(2, 2)), ("remote-only.txt", state(1, 1))]);
        let plan = plan(None, &local, &remote);
        assert_eq!(plan.pull, paths(&["both.txt", "remote-only.txt"]));
        assert_eq!(plan.delete_local, paths(&["local-only.txt"]));
        assert!(plan.push.is_empty() && plan.delete_remote.is_empty());
    }

    #[test]
    fn plan_sends_local_changes_and_brings_remote_ones() {
        let (old_local, old_remote) = (state(1, 10), state(1, 20));
        let base = manifest(&[
            ("unchanged.txt", old_local, old_remote),
            ("edited-here.txt", old_local, old_remote),
            ("edited-there.txt", old_local, old_remote),
            ("edited-both.txt", old_local, old_remote),
        ]);
        let local = listing(&[
            ("unchanged.txt", old_local),
            ("edited-here.txt", state(2, 11)),
            ("edited-there.txt", old_local),
            ("edited-both.txt", state(2, 11)),
            ("new-here.txt", state(1, 11)),
            ("new-both.txt", state(1, 11)),
        ]);
        let remote = listing(&[
            ("unchanged.txt", old_remote),
            ("edited-here.txt", old_remote),
            ("edited-there.txt", state(3, 21)),
            ("edited-both.txt", state(3, 21)),
            ("new-there.txt", state(1, 21)),
            ("new-both.txt", state(2, 21)),
        ]);
        let plan = plan(Some(&base), &local, &remote);
        assert_eq!(plan.push, paths(&["edited-both.txt", "edited-here.txt", "new-both.txt", "new-here.txt"]));
        assert_eq!(plan.pull, paths(&["edited-there.txt", "new-there.txt"]));
        assert!(plan.delete_remote.is_empty() && plan.delete_local.is_empty());
    }

    #[test]
    fn plan_follows_deletions_and_the_local_side_wins() {
        let (old_local, old_remote) = (state(1, 10), state(1, 20));
        let base = manifest(&[
            ("deleted-here.txt", old_local, old_remote),
            ("deleted-there.txt", old_local, old_remote),
            ("deleted-both.txt", old_local, old_remote),
            ("deleted-here-edited-there.txt", old_local, old_remote),
            ("edited-here-deleted-there.txt", old_local, old_remote),
        ]);
        let local = listing(&[("deleted-there.txt", old_local), ("edited-here-deleted-there.txt", state(2, 11))]);
        let remote = listing(&[("deleted-here.txt", old_remote), ("deleted-here-edited-there.txt", state(2, 21))]);
        let plan = plan(Some(&base), &local, &remote);
        assert_eq!(plan.delete_remote, paths(&["deleted-here-edited-there.txt", "deleted-here.txt"]));
        assert_eq!(plan.delete_local, paths(&["deleted-there.txt"]));
        assert_eq!(plan.push, paths(&["edited-here-deleted-there.txt"]));
        assert!(plan.pull.is_empty());
    }

    #[test]
    fn next_manifest_records_both_sides_after_the_plan() {
        let local = listing(&[("kept.txt", state(1, 10)), ("sent.txt", state(2, 11)), ("deleted-there.txt", state(1, 10))]);
        let remote = listing(&[
            ("kept.txt", state(1, 20)),
            ("sent.txt", state(1, 20)),
            ("brought.txt", state(5, 21)),
            ("deleted-here.txt", state(1, 20)),
        ]);
        let plan = Plan {
            push: paths(&["sent.txt"]),
            pull: paths(&["brought.txt"]),
            delete_remote: paths(&["deleted-here.txt"]),
            delete_local: paths(&["deleted-there.txt"]),
        };
        let local_after = |path: &str| (path == "brought.txt").then(|| state(5, 30));
        let remote_after = listing(&[("sent.txt", state(2, 31))]);
        let next = next_manifest(&local, &remote, &plan, local_after, &remote_after);
        let expected = manifest(&[
            ("brought.txt", state(5, 30), state(5, 21)),
            ("kept.txt", state(1, 10), state(1, 20)),
            ("sent.txt", state(2, 11), state(2, 31)),
        ]);
        assert_eq!(next, expected);
        // The next plan finds nothing to do.
        let local = listing(&[("brought.txt", state(5, 30)), ("kept.txt", state(1, 10)), ("sent.txt", state(2, 11))]);
        let remote = listing(&[("brought.txt", state(5, 21)), ("kept.txt", state(1, 20)), ("sent.txt", state(2, 31))]);
        assert_eq!(super::plan(Some(&next), &local, &remote), Plan::default());
    }

    #[test]
    fn next_manifest_leaves_out_a_file_whose_copy_failed() {
        let local = listing(&[("sent.txt", state(2, 11))]);
        let plan = Plan { push: paths(&["sent.txt"]), ..Plan::default() };
        let next = next_manifest(&local, &Listing::new(), &plan, |_| None, &Listing::new());
        assert_eq!(next, Manifest::default());
        // So the next sync sends it again.
        assert_eq!(super::plan(Some(&next), &local, &Listing::new()).push, paths(&["sent.txt"]));
    }

    #[test]
    fn parse_listing_reads_the_records_and_skips_folders_and_unsafe_paths() {
        let mut output = b"hunt-sync\0".to_vec();
        for record in [
            "12 1792007100.397698338 81a4 src/a b.ts",
            "7 1792007100.5 a1ff link",
            "4096 1792007100.000000000 41ed vendor/module",
            "1 1792007100.000000000 81a4 ../escape",
            "1 1792007100.000000000 81a4 .hunt/graph.json",
            "garbage",
        ] {
            output.extend_from_slice(record.as_bytes());
            output.push(0);
        }
        let parsed = parse_listing(&output).unwrap();
        assert_eq!(parsed, listing(&[("link", state(7, 1_792_007_100_500_000_000)), ("src/a b.ts", state(12, 1_792_007_100_397_698_338))]));
        assert_eq!(parse_listing(b"hunt-sync\0").unwrap(), Listing::new());
        assert!(parse_listing(b"").is_err());
        assert!(parse_listing(b"something else\0").is_err());
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
    fn rsync_args_copy_the_listed_files_as_the_agent() {
        let ssh_command = "ssh -T -l jane -o 'ProxyCommand=gcloud compute start-iap-tunnel %h 22'";
        let list = Path::new("/tmp/hunt-sync-1.txt");
        let local = Path::new("/Users/jane/Library/Application Support/hunt/worktrees/x");
        let push = rsync_args(ssh_command, list, Direction::Push, local, "vm-hunt-s-ab12cd34:/home/agent/app");
        assert_eq!(
            push,
            [
                "-rltpz",
                "--files-from=/tmp/hunt-sync-1.txt",
                "-e",
                ssh_command,
                "--rsync-path=sudo -n -u agent rsync",
                "/Users/jane/Library/Application Support/hunt/worktrees/x/",
                "vm-hunt-s-ab12cd34:/home/agent/app/",
            ]
        );
        let pull = rsync_args(ssh_command, list, Direction::Pull, local, "vm-hunt-s-ab12cd34:/home/agent/app");
        assert_eq!(&pull[5..], ["vm-hunt-s-ab12cd34:/home/agent/app/", "/Users/jane/Library/Application Support/hunt/worktrees/x/"]);
        assert_eq!(files_from(&paths(&["a.txt", "dir/b c.txt"])), "a.txt\ndir/b c.txt\n");
    }

    #[test]
    fn vanished_files_alone_do_not_fail_a_copy() {
        assert!(reports_only_vanished_files("rsync: [sender] link_stat \"/home/agent/app/gone.txt\" failed: No such file or directory (2)\n"));
        assert!(reports_only_vanished_files("rsync(22925): error: gone.txt: stat: No such file or directory\n"));
        assert!(reports_only_vanished_files("file has vanished: \"/home/agent/app/tmp.txt\"\nrsync error: some files vanished before they could be transferred (code 24)\n"));
        assert!(!reports_only_vanished_files("rsync: [receiver] mkstemp \"/home/agent/app/.a.txt.x\" failed: Permission denied (13)\n"));
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

    #[tokio::test]
    async fn local_listing_and_manifest_tell_local_changes() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        git::run_git(worktree, &["init", "-q"]).await.unwrap();
        std::fs::write(worktree.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir_all(worktree.join("ignored")).unwrap();
        std::fs::write(worktree.join("ignored/x.txt"), "x").unwrap();
        std::fs::write(worktree.join("tracked.txt"), "one").unwrap();
        git::run_git(worktree, &["add", "tracked.txt"]).await.unwrap();
        std::fs::write(worktree.join("untracked.txt"), "two!").unwrap();

        let listed = list_local(worktree).await.unwrap();
        assert_eq!(listed.keys().cloned().collect::<Vec<_>>(), paths(&[".gitignore", "tracked.txt", "untracked.txt"]));
        assert_eq!(listed["untracked.txt"].size, 4);

        let state_dir = tempfile::tempdir().unwrap();
        let manifest_path = state_dir.path().join("remote-sync").join("x.json");
        assert!(has_local_changes(worktree, &manifest_path).await.unwrap());
        let synced = listed.iter().map(|(path, here)| (path.clone(), SyncedFile { local: *here, remote: state(0, 0) })).collect();
        write_manifest(&manifest_path, &Manifest { files: synced }).unwrap();
        assert!(!has_local_changes(worktree, &manifest_path).await.unwrap());
        std::fs::write(worktree.join("untracked.txt"), "changed").unwrap();
        assert!(has_local_changes(worktree, &manifest_path).await.unwrap());

        forget(&manifest_path).unwrap();
        forget(&manifest_path).unwrap();
        assert_eq!(read_manifest(&manifest_path).unwrap(), None);
    }
}
