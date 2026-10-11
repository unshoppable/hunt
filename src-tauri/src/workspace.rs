//! Read access to a session's worktree for the built-in editor: directory listings, file contents and
//! the resolution of relative import specifiers to files.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::git::ensure_inside_worktree;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Entries of the worktree directory `path` (relative, empty for the root): folders first, then files,
/// both sorted case-insensitively. The `.git` entry is left out.
pub fn list_dir(worktree: &Path, path: &str) -> Result<Vec<DirEntry>, String> {
    ensure_inside_worktree(path)?;
    let dir = worktree.join(path);
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|error| format!("failed to read {path}: {error}"))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        // Symlinks count as what they point to, so a linked directory can be expanded.
        let is_dir = std::fs::metadata(entry.path()).map(|metadata| metadata.is_dir()).unwrap_or(false);
        entries.push(DirEntry { name, is_dir });
    }
    entries.sort_by(|left, right| right.is_dir.cmp(&left.is_dir).then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase())));
    Ok(entries)
}

/// UTF-8 content of a worktree file; binary files are rejected.
pub fn read_file(worktree: &Path, path: &str) -> Result<String, String> {
    ensure_inside_worktree(path)?;
    let bytes = std::fs::read(worktree.join(path)).map_err(|error| format!("failed to read {path}: {error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not a text file"))
}

/// Extensions tried, in order, when a specifier names no existing file; `.js` specifiers may point at TypeScript sources.
const SOURCE_EXTENSIONS: [&str; 8] = ["ts", "tsx", "d.ts", "js", "jsx", "mjs", "cjs", "json"];
const INDEX_FILES: [&str; 5] = ["index.ts", "index.tsx", "index.d.ts", "index.js", "index.jsx"];

/// Resolves relative import specifiers (`./user.service`, `../common/page`) of the file `from` to worktree-relative
/// paths; bare module names and specifiers without a matching file resolve to `None`.
pub fn resolve_imports(worktree: &Path, from: &str, specifiers: &[String]) -> Result<Vec<Option<String>>, String> {
    ensure_inside_worktree(from)?;
    let base = Path::new(from).parent().unwrap_or(Path::new(""));
    Ok(specifiers.iter().map(|specifier| resolve_import(worktree, base, specifier)).collect())
}

fn resolve_import(worktree: &Path, base: &Path, specifier: &str) -> Option<String> {
    if !(specifier.starts_with("./") || specifier.starts_with("../") || specifier == "." || specifier == "..") {
        return None;
    }
    let target = normalize(&base.join(specifier))?;
    let candidates = candidate_paths(&target);
    candidates
        .into_iter()
        .find(|candidate| worktree.join(candidate).is_file())
        .map(|candidate| candidate.to_string_lossy().replace('\\', "/"))
}

/// The paths a specifier may denote, most specific first: the path itself, with each source extension appended
/// (also replacing a `.js`-style extension), then the index files of a directory.
fn candidate_paths(target: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![target.to_path_buf()];
    let as_string = target.to_string_lossy().into_owned();
    let mut stems = vec![as_string.clone()];
    for extension in ["js", "jsx", "mjs", "cjs"] {
        if let Some(stem) = as_string.strip_suffix(&format!(".{extension}")) {
            stems.push(stem.to_string());
        }
    }
    for stem in &stems {
        for extension in SOURCE_EXTENSIONS {
            candidates.push(PathBuf::from(format!("{stem}.{extension}")));
        }
    }
    for index in INDEX_FILES {
        candidates.push(target.join(index));
    }
    candidates
}

/// Removes `.` and `..` components without touching the file system; `None` when the path would leave the worktree.
fn normalize(path: &Path) -> Option<PathBuf> {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    return None;
                }
            }
            Component::Normal(part) => result.push(part),
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/app/user")).unwrap();
        std::fs::create_dir_all(dir.path().join("src/common")).unwrap();
        std::fs::write(dir.path().join("src/app/user/user.service.ts"), "").unwrap();
        std::fs::write(dir.path().join("src/app/user/user.module.ts"), "").unwrap();
        std::fs::write(dir.path().join("src/common/index.ts"), "").unwrap();
        std::fs::write(dir.path().join("src/common/page.tsx"), "").unwrap();
        dir
    }

    #[test]
    fn resolves_relative_specifiers() {
        let dir = fixture();
        let resolved = resolve_imports(
            dir.path(),
            "src/app/user/user.module.ts",
            &["./user.service".into(), "./user.service.js".into(), "../../common".into(), "../../common/page".into(), "@nestjs/common".into(), "./missing".into()],
        )
        .unwrap();
        assert_eq!(
            resolved,
            vec![
                Some("src/app/user/user.service.ts".into()),
                Some("src/app/user/user.service.ts".into()),
                Some("src/common/index.ts".into()),
                Some("src/common/page.tsx".into()),
                None,
                None
            ]
        );
    }

    #[test]
    fn never_leaves_the_worktree() {
        let dir = fixture();
        let resolved = resolve_imports(dir.path(), "src/common/index.ts", &["../../../etc/passwd".into()]).unwrap();
        assert_eq!(resolved, vec![None]);
    }

    #[test]
    fn lists_folders_before_files() {
        let dir = fixture();
        let entries = list_dir(dir.path(), "src/app/user").unwrap();
        assert_eq!(entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(), vec!["user.module.ts", "user.service.ts"]);
        let root = list_dir(dir.path(), "").unwrap();
        assert!(root[0].is_dir && root[0].name == "src");
    }
}
