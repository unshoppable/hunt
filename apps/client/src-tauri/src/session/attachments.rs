//! Files a prompt attaches that are not images (spreadsheets, PDFs, logs): copied into `.hunt/attachments/` of the
//! session's worktree, where the agent reads them by the path the prompt names. The file sync leaves `.hunt/` out, so a
//! remote session's VM gets the attachments a prompt names just before the prompt (`named_in`).

use std::path::{Path, PathBuf};

/// The worktree-relative folder that holds the attached files.
pub const ATTACHMENTS_DIR: &str = ".hunt/attachments";

/// Copies the regular files among `paths` (absolute) into `.hunt/attachments/` of `worktree` and returns their
/// worktree-relative paths, in order; folders and missing files are left out. A name taken by other content gets a
/// number (`report-2.xlsx`); a file with the same content as the one there reuses it.
pub fn attach(worktree: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let folder = worktree.join(ATTACHMENTS_DIR);
    let mut attached = Vec::new();
    for path in paths {
        let source = Path::new(path);
        if !source.is_file() {
            continue;
        }
        let Some(name) = source.file_name().and_then(|name| name.to_str()) else { continue };
        std::fs::create_dir_all(&folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
        let bytes = std::fs::read(source).map_err(|error| format!("failed to read {path}: {error}"))?;
        let target_name = free_name(&folder, name, &bytes);
        let target = folder.join(&target_name);
        if !target.exists() {
            std::fs::write(&target, &bytes).map_err(|error| format!("failed to copy {path} into the worktree: {error}"))?;
        }
        attached.push(format!("{ATTACHMENTS_DIR}/{target_name}"));
    }
    Ok(attached)
}

/// The worktree-relative paths of the attached files of `worktree` that `text` names.
pub fn named_in(worktree: &Path, text: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(worktree.join(ATTACHMENTS_DIR)) else { return Vec::new() };
    let mut named: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_file()))
        .filter_map(|entry| entry.file_name().to_str().map(|name| format!("{ATTACHMENTS_DIR}/{name}")))
        .filter(|path| text.contains(path.as_str()))
        .collect();
    named.sort();
    named
}

/// The name in `folder` for a file `name` with the content `bytes`: `name` itself while it is free or holds the same
/// content, else the first free or equal `<stem>-<n>.<extension>` from 2 on.
fn free_name(folder: &Path, name: &str, bytes: &[u8]) -> String {
    let fits = |candidate: &PathBuf| std::fs::read(candidate).map_or(!candidate.exists(), |existing| existing == bytes);
    if fits(&folder.join(name)) {
        return name.to_string();
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or(name);
    let extension = path.extension().and_then(|extension| extension.to_str()).map(|extension| format!(".{extension}")).unwrap_or_default();
    let mut number = 2;
    loop {
        let candidate = format!("{stem}-{number}{extension}");
        if fits(&folder.join(&candidate)) {
            return candidate;
        }
        number += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_copies_files_and_skips_folders_and_missing_ones() {
        let source = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        let sheet = source.path().join("Nacht 0126.xlsx");
        std::fs::write(&sheet, [1u8, 2, 3]).unwrap();
        let paths: Vec<String> =
            [source.path().to_path_buf(), source.path().join("gone.csv"), sheet.clone()].iter().map(|path| path.to_string_lossy().into_owned()).collect();

        let attached = attach(worktree.path(), &paths).unwrap();

        assert_eq!(attached, vec![".hunt/attachments/Nacht 0126.xlsx".to_string()]);
        assert_eq!(std::fs::read(worktree.path().join(&attached[0])).unwrap(), vec![1u8, 2, 3]);
    }

    #[test]
    fn attach_reuses_equal_content_and_numbers_other_content() {
        let source = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        let first = source.path().join("a").join("report.csv");
        let second = source.path().join("b").join("report.csv");
        std::fs::create_dir_all(first.parent().unwrap()).unwrap();
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::write(&first, "1").unwrap();
        std::fs::write(&second, "2").unwrap();
        let paths = |path: &Path| vec![path.to_string_lossy().into_owned()];

        assert_eq!(attach(worktree.path(), &paths(&first)).unwrap(), vec![".hunt/attachments/report.csv".to_string()]);
        assert_eq!(attach(worktree.path(), &paths(&second)).unwrap(), vec![".hunt/attachments/report-2.csv".to_string()]);
        assert_eq!(attach(worktree.path(), &paths(&first)).unwrap(), vec![".hunt/attachments/report.csv".to_string()]);
        assert_eq!(std::fs::read_to_string(worktree.path().join(".hunt/attachments/report-2.csv")).unwrap(), "2");
    }

    #[test]
    fn named_in_finds_the_attachments_a_text_mentions() {
        let worktree = tempfile::tempdir().unwrap();
        let folder = worktree.path().join(ATTACHMENTS_DIR);
        std::fs::create_dir_all(&folder).unwrap();
        for name in ["costs.xlsx", "night.xlsx", "old.pdf"] {
            std::fs::write(folder.join(name), "x").unwrap();
        }

        let named = named_in(worktree.path(), "compare `/home/agent/app/.hunt/attachments/night.xlsx` and .hunt/attachments/costs.xlsx");

        assert_eq!(named, vec![".hunt/attachments/costs.xlsx".to_string(), ".hunt/attachments/night.xlsx".to_string()]);
        assert!(named_in(&worktree.path().join("missing"), "anything").is_empty());
    }
}
