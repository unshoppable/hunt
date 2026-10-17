//! The private files of a repository: the ignored files matching the glob patterns of Settings → Remote VM (default
//! `**/.env.private`), such as the `.env.private` a service reads. A new worktree gets them from the repository's own
//! checkout (`copy_into_worktree`), since git does not carry ignored files into a worktree, and a handoff takes them to
//! the VM (`list_ignored`). The main window stores the patterns here at its start and on every change
//! (`set_file_patterns`).
use std::path::Path;
use std::sync::Mutex;

use glob::{MatchOptions, Pattern};

use crate::git;

/// The patterns of the main window's settings; empty until it sent them.
static FILE_PATTERNS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Takes the glob patterns of the private files from the main window, at its start and on every change; invalid
/// patterns are refused and leave the stored ones.
#[tauri::command]
pub fn set_file_patterns(patterns: Vec<String>) -> Result<(), String> {
    compile_patterns(&patterns)?;
    *FILE_PATTERNS.lock().unwrap() = patterns;
    Ok(())
}

/// The stored glob patterns of the private files.
pub fn file_patterns() -> Vec<String> {
    FILE_PATTERNS.lock().unwrap().clone()
}

/// The glob patterns from the settings; absolute patterns and `..` segments are rejected.
pub fn compile_patterns(patterns: &[String]) -> Result<Vec<Pattern>, String> {
    patterns
        .iter()
        .map(|pattern| pattern.trim())
        .filter(|pattern| !pattern.is_empty())
        .map(|pattern| {
            if pattern.starts_with('/') || pattern.split('/').any(|segment| segment == "..") {
                return Err(format!("failed to use the file pattern {pattern:?}: it must stay inside the worktree"));
            }
            Pattern::new(pattern).map_err(|error| format!("failed to use the file pattern {pattern:?}: {error}"))
        })
        .collect()
}

/// Whether the worktree-relative `path` matches one of `patterns`; `*` stays within a folder, `**` crosses folders.
pub fn matches_any(patterns: &[Pattern], path: &str) -> bool {
    let options = MatchOptions { case_sensitive: true, require_literal_separator: true, require_literal_leading_dot: false };
    patterns.iter().any(|pattern| pattern.matches_with(path, options))
}

/// The ignored files of `worktree` that match `patterns`, worktree-relative and sorted as git lists them, including
/// files inside ignored folders; `node_modules` folders are never searched. Symlinks are listed like files.
pub async fn list_ignored(worktree: &Path, patterns: &[Pattern]) -> Result<Vec<String>, String> {
    if patterns.is_empty() {
        return Ok(Vec::new());
    }
    let output = git::run_git(worktree, &["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ":(glob,exclude)**/node_modules/**"]).await?;
    Ok(output.split('\0').filter(|path| !path.is_empty() && matches_any(patterns, path)).map(str::to_string).collect())
}

/// Copies the private files of the repository's checkout `repo` that match `patterns` to the same paths in `worktree`;
/// a file the worktree has already stays as it is, and symlinks stay behind. Returns the copied paths.
pub async fn copy_into_worktree(repo: &Path, worktree: &Path, patterns: &[String]) -> Result<Vec<String>, String> {
    let patterns = compile_patterns(patterns)?;
    let mut copied = Vec::new();
    for path in list_ignored(repo, &patterns).await? {
        let (source, target) = (repo.join(&path), worktree.join(&path));
        let Ok(metadata) = std::fs::symlink_metadata(&source) else { continue };
        if !metadata.is_file() || target.symlink_metadata().is_ok() {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        std::fs::copy(&source, &target).map_err(|error| format!("failed to copy {} into the worktree: {error}", source.display()))?;
        copied.push(path);
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_nested_files_and_reject_paths_outside_the_worktree() {
        let patterns = compile_patterns(&["**/.env.private".to_string(), "config/*.local".to_string(), " ".to_string()]).unwrap();
        assert!(matches_any(&patterns, ".env.private"));
        assert!(matches_any(&patterns, "apps/med/.env.private"));
        assert!(matches_any(&patterns, "config/app.local"));
        assert!(!matches_any(&patterns, "config/nested/app.local"));
        assert!(!matches_any(&patterns, "apps/med/.env"));
        assert!(compile_patterns(&["../secrets".to_string()]).is_err());
        assert!(compile_patterns(&["/etc/passwd".to_string()]).is_err());
    }

    #[tokio::test]
    async fn copies_the_matching_ignored_files_of_the_checkout_into_the_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, worktree) = (dir.path().join("repo"), dir.path().join("worktree"));
        for folder in ["apps/med/downloads", "apps/ppp-rl", "node_modules/pkg"] {
            std::fs::create_dir_all(repo.join(folder)).unwrap();
        }
        git::run_git(&repo, &["init", "-q", "-b", "main"]).await.unwrap();
        std::fs::write(repo.join(".gitignore"), ".env.private\ndownloads/\nnode_modules/\n").unwrap();
        std::fs::write(repo.join("apps/med/.env"), "PUBLIC=1\n").unwrap();
        std::fs::write(repo.join("apps/med/.env.private"), "KEY=1\n").unwrap();
        std::fs::write(repo.join("apps/med/downloads/.env.private"), "KEY=2\n").unwrap();
        std::fs::write(repo.join("apps/ppp-rl/.env.private"), "KEY=3\n").unwrap();
        std::fs::write(repo.join("node_modules/pkg/.env.private"), "KEY=4\n").unwrap();
        std::os::unix::fs::symlink("apps/med/.env.private", repo.join(".env.private")).unwrap();
        std::fs::create_dir_all(worktree.join("apps/ppp-rl")).unwrap();
        std::fs::write(worktree.join("apps/ppp-rl/.env.private"), "MINE=1\n").unwrap();

        let copied = copy_into_worktree(&repo, &worktree, &["**/.env.private".to_string()]).await.unwrap();

        assert_eq!(copied, ["apps/med/.env.private", "apps/med/downloads/.env.private"]);
        let read = |path: &str| std::fs::read_to_string(worktree.join(path)).unwrap();
        assert_eq!(read("apps/med/.env.private"), "KEY=1\n");
        assert_eq!(read("apps/med/downloads/.env.private"), "KEY=2\n", "a file inside an ignored folder comes along");
        assert_eq!(read("apps/ppp-rl/.env.private"), "MINE=1\n", "a file the worktree has stays");
        assert!(!worktree.join("apps/med/.env").exists(), "a file no pattern matches stays behind");
        assert!(!worktree.join("node_modules").exists());
        assert!(worktree.join(".env.private").symlink_metadata().is_err(), "symlinks stay behind");
        assert_eq!(copy_into_worktree(&repo, &worktree, &[]).await.unwrap(), Vec::<String>::new());
    }
}
