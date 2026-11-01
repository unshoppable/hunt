//! A worktree file on disk as the shared documents see it: the stamp (modification time and length) that tells whether
//! it changed since it was last read or written, and the atomic write every save of Hunt goes through, so that a
//! watcher, a dev server or the agent never reads a truncated or half-written file.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::SystemTime;

/// Modification time and length of a file. Equal stamps count as unchanged content, the heuristic of every IDE; a
/// missing stamp (`None`) is unknown and never equal to anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiskStamp {
    pub modified: SystemTime,
    pub len: u64,
}

impl DiskStamp {
    /// The stamp of the file at `path`, through symlinks; None when it is missing or has no modification time.
    pub fn of(path: &Path) -> Option<DiskStamp> {
        fs::metadata(path).ok().as_ref().and_then(DiskStamp::from_metadata)
    }

    fn from_metadata(metadata: &Metadata) -> Option<DiskStamp> {
        Some(DiskStamp { modified: metadata.modified().ok()?, len: metadata.len() })
    }

    /// Whether two stamps are both known and equal.
    pub fn same(first: Option<DiskStamp>, second: Option<DiskStamp>) -> bool {
        matches!((first, second), (Some(first), Some(second)) if first == second)
    }
}

static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// A hidden sibling of `target` for one atomic write, whose suffix no source glob matches.
fn temp_path(target: &Path) -> PathBuf {
    let name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let count = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    target.with_file_name(format!(".{name}.hunt-save-{}-{count}", std::process::id()))
}

/// Writes `bytes` to `path` atomically: into a temp file in the same folder, synced to disk, with the permissions of
/// the file it replaces, then renamed over it. A symlink keeps pointing at its target, which gets the content. When the
/// temp file cannot be created or renamed (a read-only folder, a symlink to another volume), the file is written in
/// place instead. Returns the stamp the file has afterwards, taken from the written file itself.
///
/// Ported from `write_atomic` in OpenIDEA's `crates/ide-vfs/src/encoding.rs` (Apache License 2.0).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<Option<DiskStamp>> {
    let target = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => match fs::canonicalize(path) {
            Ok(target) => target,
            Err(_) => return write_in_place(path, bytes),
        },
        _ => path.to_path_buf(),
    };
    let existing = fs::metadata(&target).ok();
    let temp = temp_path(&target);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    if existing.is_some() {
        // The new content must not become readable to others before the original permissions are set.
        options.mode(0o600);
    }
    let Ok(mut file) = options.open(&temp) else {
        return write_in_place(&target, bytes);
    };
    let written = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(metadata) = &existing {
            file.set_permissions(metadata.permissions())?;
        }
        file.metadata()
    })();
    drop(file);
    let metadata = match written {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    };
    if fs::rename(&temp, &target).is_err() {
        let _ = fs::remove_file(&temp);
        return write_in_place(&target, bytes);
    }
    Ok(DiskStamp::from_metadata(&metadata))
}

/// Truncates and rewrites the file at `path`, the fallback of `write_atomic`.
fn write_in_place(path: &Path, bytes: &[u8]) -> io::Result<Option<DiskStamp>> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(DiskStamp::from_metadata(&file.metadata()?))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{symlink, PermissionsExt};

    use super::*;

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn replaces_the_content_and_keeps_the_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("run.sh");
        fs::write(&file, "old").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o751)).unwrap();

        let stamp = write_atomic(&file, b"echo new").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "echo new");
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o751);
        assert_eq!(stamp, DiskStamp::of(&file), "the stamp is the one the file has afterwards");
        assert_eq!(entries(dir.path()), ["run.sh"], "no temp file is left behind");
    }

    #[test]
    fn creates_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("new.ts");
        let stamp = write_atomic(&file, b"export {};\n").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "export {};\n");
        assert_eq!(stamp.map(|stamp| stamp.len), Some(11));
        assert_eq!(entries(dir.path()), ["new.ts"]);
    }

    #[test]
    fn writes_through_a_symlink_to_its_target() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("shared")).unwrap();
        let target = dir.path().join("shared/config.json");
        fs::write(&target, "{}").unwrap();
        let link = dir.path().join("config.json");
        symlink(&target, &link).unwrap();

        write_atomic(&link, b"{ \"a\": 1 }").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link stays a link");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{ \"a\": 1 }");
        assert_eq!(entries(dir.path()), ["config.json", "shared"]);
        assert_eq!(entries(&dir.path().join("shared")), ["config.json"]);
    }

    #[test]
    fn writes_in_place_when_the_folder_takes_no_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("locked");
        fs::create_dir(&folder).unwrap();
        let file = folder.join("a.ts");
        fs::write(&file, "old").unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();

        let result = write_atomic(&file, b"new");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        result.unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(entries(&folder), ["a.ts"]);
    }

    #[test]
    fn temp_files_match_no_source_glob() {
        let name = temp_path(Path::new("/w/src/app.component.ts")).file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(".app.component.ts.hunt-save-"), "{name}");
        assert!(!name.ends_with(".ts"));
    }

    #[test]
    fn unknown_stamps_are_never_the_same() {
        let stamp = DiskStamp { modified: SystemTime::UNIX_EPOCH, len: 1 };
        assert!(DiskStamp::same(Some(stamp), Some(stamp)));
        assert!(!DiskStamp::same(Some(stamp), Some(DiskStamp { len: 2, ..stamp })));
        assert!(!DiskStamp::same(None, None));
        assert!(!DiskStamp::same(Some(stamp), None));
    }
}
