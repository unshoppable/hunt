//! Paths the frontend names inside a worktree, which must never leave it.

use std::path::{Component, Path};

use serde::Deserialize;

/// A path relative to a worktree that stays inside it: not absolute and without a `..` component. A Tauri command takes
/// it as an argument, which rejects any other path before the command runs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct WorktreeRelativePath(String);

impl WorktreeRelativePath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for WorktreeRelativePath {
    type Error = String;

    fn try_from(path: String) -> Result<Self, Self::Error> {
        ensure_inside_worktree(&path)?;
        Ok(WorktreeRelativePath(path))
    }
}

/// Rejects absolute paths and paths with `..` components so a path can never leave the worktree.
pub fn ensure_inside_worktree(path: &str) -> Result<(), String> {
    let relative = Path::new(path);
    let is_inside_worktree = relative.is_relative() && !relative.components().any(|component| matches!(component, Component::ParentDir));
    if !is_inside_worktree {
        return Err(format!("refusing to touch a path outside the worktree: {path}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSIDE: [&str; 7] = ["", "src", "src/app/user.ts", "./src/app.ts", "dir with space/b.txt", "..hidden/file", "a..b"];
    const OUTSIDE: [&str; 7] = ["/etc/passwd", "/", "..", "../secret", "src/../../secret", "src/..", "./.."];

    #[test]
    fn ensure_inside_worktree_accepts_relative_paths_only() {
        for path in INSIDE {
            assert!(ensure_inside_worktree(path).is_ok(), "{path:?} should be accepted");
        }
        for path in OUTSIDE {
            assert!(ensure_inside_worktree(path).is_err(), "{path:?} should be rejected");
        }
    }

    #[test]
    fn try_from_keeps_a_path_inside_the_worktree_as_given_and_rejects_the_others() {
        for path in INSIDE {
            assert_eq!(WorktreeRelativePath::try_from(path.to_string()).map(|relative| relative.as_str().to_string()), Ok(path.to_string()));
        }
        for path in OUTSIDE {
            assert_eq!(WorktreeRelativePath::try_from(path.to_string()), Err(format!("refusing to touch a path outside the worktree: {path}")));
        }
    }

    #[test]
    fn deserializes_from_a_string_inside_the_worktree_only() {
        let path: WorktreeRelativePath = serde_json::from_value(serde_json::json!("src/app.ts")).unwrap();
        assert_eq!(path.as_str(), "src/app.ts");
        let error = serde_json::from_value::<WorktreeRelativePath>(serde_json::json!("../secret")).unwrap_err();
        assert_eq!(error.to_string(), "refusing to touch a path outside the worktree: ../secret");
        assert!(serde_json::from_value::<WorktreeRelativePath>(serde_json::json!(42)).is_err());
    }
}
