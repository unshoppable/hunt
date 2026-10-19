//! The private files of a repository: the ignored files its services need in a worktree, which `hunt.json` names per
//! service under `worktreeInclude` as glob patterns (such as `apps/med/.env.private`). A new worktree gets them from
//! the repository's own checkout (`copy_into_worktree`), since git does not carry ignored files into a worktree, and a
//! handoff takes them to the VM (`list_ignored`). The ignored files of the repository's hooks folder (husky's generated
//! `.husky/_`) travel the same way, since the hooks of a worktree's commits need them.
use std::path::Path;

use glob::{MatchOptions, Pattern};
use serde_json::Value;

use crate::git;

/// The glob patterns of the `worktreeInclude` lists of every service in the worktree's `hunt.json`, in the file's
/// order without repeats; none without the file or the lists. The VM validates the file fully
/// (`apps/session/src/config.ts`); here only the lists' shape matters.
pub fn patterns_of(worktree: &Path) -> Result<Vec<String>, String> {
    let path = worktree.join("hunt.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    let json: Value = serde_json::from_str(&text).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let Some(Value::Object(services)) = json.get("services") else { return Ok(Vec::new()) };
    let mut patterns: Vec<String> = Vec::new();
    for (name, service) in services {
        let invalid = || format!("failed to read {}: services.{name}.worktreeInclude must be a list of glob patterns", path.display());
        let items = match service.get("worktreeInclude") {
            None | Some(Value::Null) => continue,
            Some(Value::Array(items)) => items,
            Some(_) => return Err(invalid()),
        };
        for item in items {
            let pattern = item.as_str().ok_or_else(invalid)?;
            if !patterns.iter().any(|known| known == pattern) {
                patterns.push(pattern.to_string());
            }
        }
    }
    Ok(patterns)
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

/// The repository's `core.hooksPath` when it is a folder inside the checkout (husky's `.husky`), checkout-relative.
pub async fn hooks_path(checkout: &Path) -> Option<String> {
    let path = git::run_git(checkout, &["config", "core.hooksPath"]).await.ok()?;
    let path = path.trim().trim_start_matches("./").trim_end_matches('/');
    if path.is_empty() || path.starts_with(['/', '-', '~']) || path.split('/').any(|segment| segment == "..") {
        return None;
    }
    Some(path.to_string())
}

/// The ignored files of `checkout` inside its hooks folder `hooks_path` (husky's generated `.husky/_`), checkout-relative.
pub async fn list_ignored_hooks(checkout: &Path, hooks_path: &str) -> Result<Vec<String>, String> {
    let output = git::run_git(checkout, &["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", hooks_path]).await?;
    Ok(output.split('\0').filter(|path| !path.is_empty()).map(str::to_string).collect())
}

/// Copies the private files of the repository's checkout `repo`, those matching the `worktreeInclude` patterns of the
/// services in the worktree's `hunt.json` and the ignored files of its hooks folder, to the same paths in `worktree`; a
/// file the worktree has already stays as it is, and symlinks stay behind. Returns the copied paths.
pub async fn copy_into_worktree(repo: &Path, worktree: &Path) -> Result<Vec<String>, String> {
    let patterns = compile_patterns(&patterns_of(worktree)?)?;
    let mut paths = list_ignored(repo, &patterns).await?;
    paths.extend(ignored_hooks(repo).await?);
    paths.sort();
    paths.dedup();
    copy_files(repo, worktree, &paths)
}

/// Copies the ignored files of the repository's hooks folder from its checkout `repo` into `worktree`, as
/// `copy_into_worktree` does, for a worktree created before Hunt copied them. Returns the copied paths.
pub async fn copy_hooks_into_worktree(repo: &Path, worktree: &Path) -> Result<Vec<String>, String> {
    copy_files(repo, worktree, &ignored_hooks(repo).await?)
}

async fn ignored_hooks(repo: &Path) -> Result<Vec<String>, String> {
    match hooks_path(repo).await {
        Some(hooks_path) => list_ignored_hooks(repo, &hooks_path).await,
        None => Ok(Vec::new()),
    }
}

/// Copies the files `paths` of `repo` to the same paths in `worktree`, skipping symlinks and files the worktree has.
fn copy_files(repo: &Path, worktree: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();
    for path in paths {
        let (source, target) = (repo.join(path), worktree.join(path));
        let Ok(metadata) = std::fs::symlink_metadata(&source) else { continue };
        if !metadata.is_file() || target.symlink_metadata().is_ok() {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        std::fs::copy(&source, &target).map_err(|error| format!("failed to copy {} into the worktree: {error}", source.display()))?;
        copied.push(path.clone());
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
        std::fs::write(worktree.join("hunt.json"), r#"{ "version": 3, "services": { "web": { "worktreeInclude": ["**/.env.private"] } } }"#).unwrap();

        let copied = copy_into_worktree(&repo, &worktree).await.unwrap();

        assert_eq!(copied, ["apps/med/.env.private", "apps/med/downloads/.env.private"]);
        let read = |path: &str| std::fs::read_to_string(worktree.join(path)).unwrap();
        assert_eq!(read("apps/med/.env.private"), "KEY=1\n");
        assert_eq!(read("apps/med/downloads/.env.private"), "KEY=2\n", "a file inside an ignored folder comes along");
        assert_eq!(read("apps/ppp-rl/.env.private"), "MINE=1\n", "a file the worktree has stays");
        assert!(!worktree.join("apps/med/.env").exists(), "a file no pattern matches stays behind");
        assert!(!worktree.join("node_modules").exists());
        assert!(worktree.join(".env.private").symlink_metadata().is_err(), "symlinks stay behind");
    }

    #[tokio::test]
    async fn copies_the_ignored_files_of_the_hooks_folder_into_the_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, worktree) = (dir.path().join("repo"), dir.path().join("worktree"));
        std::fs::create_dir_all(repo.join(".husky/_")).unwrap();
        git::run_git(&repo, &["init", "-q", "-b", "main"]).await.unwrap();
        git::run_git(&repo, &["config", "core.hooksPath", ".husky"]).await.unwrap();
        std::fs::write(repo.join(".husky/pre-commit"), ". \"$(dirname -- \"$0\")/_/husky.sh\"\n").unwrap();
        std::fs::write(repo.join(".husky/_/.gitignore"), "*\n").unwrap();
        std::fs::write(repo.join(".husky/_/husky.sh"), "#!/usr/bin/env sh\n").unwrap();
        std::fs::create_dir_all(&worktree).unwrap();

        assert_eq!(copy_hooks_into_worktree(&repo, &worktree).await.unwrap(), [".husky/_/.gitignore", ".husky/_/husky.sh"]);
        assert_eq!(std::fs::read_to_string(worktree.join(".husky/_/husky.sh")).unwrap(), "#!/usr/bin/env sh\n");
        assert!(!worktree.join(".husky/pre-commit").exists(), "tracked hooks come with the checkout");
        assert!(copy_into_worktree(&repo, &worktree).await.unwrap().is_empty(), "files the worktree has stay");
    }

    #[test]
    fn patterns_come_from_the_worktree_include_lists_of_the_services_in_hunt_json() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path();
        let write = |json: &str| std::fs::write(worktree.join("hunt.json"), json).unwrap();
        assert_eq!(patterns_of(worktree).unwrap(), Vec::<String>::new(), "no hunt.json");
        write(r#"{ "version": 3, "services": { "web": { "command": "npm start", "port": 3000 } } }"#);
        assert_eq!(patterns_of(worktree).unwrap(), Vec::<String>::new(), "no lists");
        write(r#"{ "version": 3, "services": {
            "backend": { "worktreeInclude": ["apps/med/.env.private", "config/*.local"] },
            "ui": { "worktreeInclude": [] },
            "admin": { "worktreeInclude": ["apps/med/.env.private", "apps/admin/.env.private"] }
        } }"#);
        assert_eq!(patterns_of(worktree).unwrap(), ["apps/med/.env.private", "config/*.local", "apps/admin/.env.private"]);
        write(r#"{ "version": 3, "services": { "web": { "worktreeInclude": "apps/web/.env.private" } } }"#);
        assert!(patterns_of(worktree).unwrap_err().ends_with("hunt.json: services.web.worktreeInclude must be a list of glob patterns"));
        write("{");
        assert!(patterns_of(worktree).is_err());
    }
}
