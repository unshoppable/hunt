//! The repository's Claude Code memory on the move. Claude Code keeps it per repository, in
//! `~/.claude/projects/<slug of the main checkout>/memory/`; a remote session gets a copy in its own `~/.claude` on the
//! VM, and its retrieval merges what the agent changed there back into the local folder, three-way against the copy the
//! handoff sent (the base, kept as hashes in Hunt's app data). The VM never sees another session's memory.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::transcript;
use crate::git;

/// The memory's index, merged line by line.
const INDEX: &str = "MEMORY.md";

/// What the handoff sent: the hash of every file and the lines of the index.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MemoryBase {
    pub files: BTreeMap<String, String>,
    pub index: Vec<String>,
}

/// One change to the local memory folder; paths are relative to it.
#[derive(Clone, Debug, PartialEq)]
pub enum MemoryChange {
    Write(String, Vec<u8>),
    Delete(String),
}

/// The local memory folder of the repository `worktree` belongs to: Claude Code keys it by the main checkout, which
/// every worktree of the repository shares.
pub async fn local_dir(claude_dir: &Path, worktree: &Path) -> Result<PathBuf, String> {
    let common = git::run_git(worktree, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    let common = PathBuf::from(common.trim());
    let checkout = common.parent().ok_or_else(|| format!("failed to find the main checkout of {}", worktree.display()))?;
    Ok(claude_dir.join("projects").join(transcript::project_slug(&checkout.display().to_string())).join("memory"))
}

/// Every regular file below `dir` by its `/`-separated relative path; empty when `dir` is missing. Symlinks stay
/// behind, as in `transcript::copy_rewritten`.
pub fn read_files(dir: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    if std::fs::symlink_metadata(dir).is_ok_and(|metadata| metadata.is_dir()) {
        collect(dir, "", &mut files)?;
    }
    Ok(files)
}

fn collect(dir: &Path, prefix: &str, files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|error| format!("failed to read {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if file_type.is_dir() {
            collect(&entry.path(), &relative, files)?;
        } else if file_type.is_file() {
            let bytes = std::fs::read(entry.path()).map_err(|error| format!("failed to read {}: {error}", entry.path().display()))?;
            files.insert(relative, bytes);
        }
    }
    Ok(())
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes).lines().map(str::to_string).collect()
}

/// The base of `files`, as the handoff sends them.
pub fn base_of(files: &BTreeMap<String, Vec<u8>>) -> MemoryBase {
    MemoryBase {
        files: files.iter().map(|(path, bytes)| (path.clone(), hash(bytes))).collect(),
        index: files.get(INDEX).map(|bytes| lines(bytes)).unwrap_or_default(),
    }
}

pub fn read_base(path: &Path) -> Option<MemoryBase> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub fn write_base(path: &Path, base: &MemoryBase) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    }
    let json = serde_json::to_vec(base).map_err(|error| error.to_string())?;
    std::fs::write(path, json).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

/// The changes that bring the agent's memory edits on the VM (`remote`) into the local memory (`local`), three-way
/// against `base`:
/// - a file only the VM changed, added or deleted takes the VM's state;
/// - a file both sides changed keeps the local version, and the VM's goes next to it as `<name>.remote-<tag>.md`;
/// - the index takes the VM's added lines and drops the lines the VM removed.
///
/// Without a base (a session handed off before Hunt kept one) only the VM's new files and index lines come over.
pub fn merge(base: Option<&MemoryBase>, local: &BTreeMap<String, Vec<u8>>, remote: &BTreeMap<String, Vec<u8>>, tag: &str) -> Vec<MemoryChange> {
    let mut changes = Vec::new();
    let paths: BTreeSet<&String> = local.keys().chain(remote.keys()).chain(base.into_iter().flat_map(|base| base.files.keys())).collect();
    for path in paths {
        let (local_file, remote_file) = (local.get(path), remote.get(path));
        if path == INDEX {
            changes.extend(merge_index(base, local_file, remote_file));
            continue;
        }
        let Some(base) = base else {
            if let (None, Some(remote_file)) = (local_file, remote_file) {
                changes.push(MemoryChange::Write(path.clone(), remote_file.clone()));
            }
            continue;
        };
        let base_hash = base.files.get(path);
        let is_remote_changed = remote_file.map(|bytes| hash(bytes)).as_ref() != base_hash;
        let is_local_changed = local_file.map(|bytes| hash(bytes)).as_ref() != base_hash;
        if !is_remote_changed || local_file == remote_file {
            continue;
        }
        match (is_local_changed, remote_file) {
            (false, Some(remote_file)) => changes.push(MemoryChange::Write(path.clone(), remote_file.clone())),
            (false, None) => changes.push(MemoryChange::Delete(path.clone())),
            (true, Some(remote_file)) => changes.push(MemoryChange::Write(conflict_path(path, tag), remote_file.clone())),
            (true, None) => {}
        }
    }
    changes
}

/// `<stem>.remote-<tag>.<extension>` next to `path`.
fn conflict_path(path: &str, tag: &str) -> String {
    let (dir, name) = match path.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name),
        None => (String::new(), path),
    };
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{dir}{stem}.remote-{tag}.{extension}"),
        _ => format!("{dir}{name}.remote-{tag}"),
    }
}

/// The index after the VM's edits: the local lines without those the VM removed from the base, then the VM's new lines
/// in its order.
fn merge_index(base: Option<&MemoryBase>, local: Option<&Vec<u8>>, remote: Option<&Vec<u8>>) -> Option<MemoryChange> {
    let remote = lines(remote?);
    let local = local.map(|bytes| lines(bytes)).unwrap_or_default();
    let base_lines: BTreeSet<&String> = base.map(|base| base.index.iter().collect()).unwrap_or_default();
    let remote_lines: BTreeSet<&String> = remote.iter().collect();
    let local_lines: BTreeSet<&String> = local.iter().collect();
    let mut merged: Vec<String> = local.iter().filter(|line| !base_lines.contains(line) || remote_lines.contains(line)).cloned().collect();
    merged.extend(remote.iter().filter(|line| !base_lines.contains(line) && !local_lines.contains(line)).cloned());
    if merged == local {
        return None;
    }
    let mut text = merged.join("\n");
    text.push('\n');
    Some(MemoryChange::Write(INDEX.to_string(), text.into_bytes()))
}

/// Applies `changes` to the local memory folder `dir`.
pub fn apply(dir: &Path, changes: &[MemoryChange]) -> Result<(), String> {
    for change in changes {
        match change {
            MemoryChange::Write(path, bytes) => {
                let target = dir.join(path);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
                }
                std::fs::write(&target, bytes).map_err(|error| format!("failed to write {}: {error}", target.display()))?;
            }
            MemoryChange::Delete(path) => {
                let target = dir.join(path);
                match std::fs::remove_file(&target) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        return Err(format!("failed to delete {}: {error}", target.display()));
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        entries.iter().map(|(path, text)| (path.to_string(), text.as_bytes().to_vec())).collect()
    }

    fn write(path: &str, text: &str) -> MemoryChange {
        MemoryChange::Write(path.into(), text.as_bytes().to_vec())
    }

    #[test]
    fn files_only_the_vm_changed_added_or_deleted_take_its_state() {
        let handed_off = files(&[("a.md", "a"), ("b.md", "b"), ("c.md", "c")]);
        let base = base_of(&handed_off);
        let remote = files(&[("a.md", "a2"), ("c.md", "c"), ("d.md", "d")]);
        let changes = merge(Some(&base), &handed_off, &remote, "1234abcd");
        assert_eq!(changes, vec![write("a.md", "a2"), MemoryChange::Delete("b.md".into()), write("d.md", "d")]);
    }

    #[test]
    fn local_edits_win_and_both_sided_edits_keep_the_vm_version_next_to_them() {
        let base = base_of(&files(&[("a.md", "a"), ("b.md", "b"), ("dir/c", "c")]));
        let local = files(&[("a.md", "a-local"), ("dir/c", "c-local")]);
        let remote = files(&[("a.md", "a-vm"), ("b.md", "b"), ("dir/c", "c-vm")]);
        let changes = merge(Some(&base), &local, &remote, "1234abcd");
        assert_eq!(changes, vec![write("a.remote-1234abcd.md", "a-vm"), write("dir/c.remote-1234abcd", "c-vm")]);
    }

    #[test]
    fn the_index_takes_new_lines_of_the_vm_and_drops_the_lines_it_removed() {
        let base = base_of(&files(&[("MEMORY.md", "- one\n- two\n")]));
        let local = files(&[("MEMORY.md", "- one\n- two\n- local\n")]);
        let remote = files(&[("MEMORY.md", "- one\n- vm\n")]);
        let changes = merge(Some(&base), &local, &remote, "1234abcd");
        assert_eq!(changes, vec![write("MEMORY.md", "- one\n- local\n- vm\n")]);
        assert_eq!(merge(Some(&base), &local, &files(&[("MEMORY.md", "- one\n- two\n")]), "1234abcd"), Vec::new());
    }

    #[test]
    fn without_a_base_only_new_files_and_index_lines_come_over() {
        let local = files(&[("a.md", "a"), ("MEMORY.md", "- a\n")]);
        let remote = files(&[("a.md", "a-vm"), ("d.md", "d"), ("MEMORY.md", "- d\n")]);
        let changes = merge(None, &local, &remote, "1234abcd");
        assert_eq!(changes, vec![write("MEMORY.md", "- a\n- d\n"), write("d.md", "d")]);
    }

    #[test]
    fn a_repeated_merge_changes_nothing() {
        let base = base_of(&files(&[("a.md", "a"), ("b.md", "b")]));
        let remote = files(&[("a.md", "a2")]);
        assert_eq!(merge(Some(&base), &remote, &remote, "1234abcd"), Vec::new());
    }

    #[test]
    fn apply_writes_and_deletes_below_the_folder() {
        let dir = std::env::temp_dir().join(format!("hunt-memory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.md"), "old").unwrap();
        apply(&dir, &[write("nested/new.md", "new"), MemoryChange::Delete("old.md".into()), MemoryChange::Delete("missing.md".into())]).unwrap();
        assert_eq!(read_files(&dir).unwrap(), files(&[("nested/new.md", "new")]));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
