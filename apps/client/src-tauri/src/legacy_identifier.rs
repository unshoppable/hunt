//! Moves what Hunt kept under its former bundle identifier to the current one on the first start after the change:
//! the webview's storage (settings, layouts), the app data folder with the session worktrees, and everything that
//! names a worktree by its path (`sessions.json`, pending cleanups, edit logs, git's worktree records, Claude Code's
//! project folders).

use std::ffi::OsString;
use std::path::Path;

use crate::git;
use crate::remote::{self, transcript};
use crate::session::{attribution, commands, store};

const LEGACY_IDENTIFIER: &str = "info.medconomy.harness";

/// Moves the data of `LEGACY_IDENTIFIER` to `identifier`. Runs before the first window opens, so no webview and no
/// session has used the new folders yet; failures are only logged.
pub fn migrate(identifier: &str) {
    let Ok(home) = std::env::var("HOME") else { return };
    let claude_dir = match remote::claude_dir() {
        Ok(dir) => dir,
        Err(error) => return eprintln!("{error}"),
    };
    tauri::async_runtime::block_on(migrate_in(Path::new(&home), &claude_dir, LEGACY_IDENTIFIER, identifier));
}

async fn migrate_in(home: &Path, claude_dir: &Path, legacy: &str, identifier: &str) {
    if legacy == identifier {
        return;
    }
    let library = home.join("Library");
    if let Err(error) = move_folder(&library.join("WebKit").join(legacy), &library.join("WebKit").join(identifier)) {
        eprintln!("{error}");
    }

    let from = library.join("Application Support").join(legacy);
    let to = library.join("Application Support").join(identifier);
    if !from.is_dir() || to.exists() {
        return;
    }
    let worktree_names = folder_names(&from.join("worktrees"));
    if let Err(error) = move_folder(&from, &to) {
        return eprintln!("{error}");
    }
    if let Err(error) = store::relocate_worktrees(&to, &from, &to) {
        eprintln!("{error}");
    }
    if let Err(error) = commands::relocate_pending_cleanups(&to, &from, &to) {
        eprintln!("{error}");
    }
    for name in worktree_names {
        let old_worktree = from.join("worktrees").join(&name);
        let worktree = to.join("worktrees").join(&name);
        if let Err(error) = attribution::relocate_edit_log(&to, &old_worktree, &worktree) {
            eprintln!("{error}");
        }
        let projects = (transcript::local_project(&old_worktree, claude_dir), transcript::local_project(&worktree, claude_dir));
        if let Err(error) = move_folder(&projects.0, &projects.1) {
            eprintln!("{error}");
        }
        if worktree.join(".git").is_file() {
            if let Err(error) = git::repair_worktree(&worktree).await {
                eprintln!("{error}");
            }
        }
    }
}

/// Renames the folder `from` to `to`; does nothing when `from` is missing or `to` exists.
fn move_folder(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_dir() || to.exists() {
        return Ok(());
    }
    std::fs::rename(from, to).map_err(|error| format!("failed to move {} to {}: {error}", from.display(), to.display()))
}

/// The names of the folders in `dir`; empty when it is missing.
fn folder_names(dir: &Path) -> Vec<OsString> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries.flatten().filter(|entry| entry.path().is_dir()).map(|entry| entry.file_name()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::run_git;
    use crate::session::store::SessionRecord;
    use std::path::PathBuf;
    use uuid::Uuid;

    const NEW: &str = "info.medconomy.hunt";
    const OLD: &str = "info.medconomy.harness";

    struct Fixture {
        _dir: tempfile::TempDir,
        home: PathBuf,
        claude_dir: PathBuf,
        repo: PathBuf,
    }

    impl Fixture {
        fn data_dir(&self, identifier: &str) -> PathBuf {
            self.home.join("Library/Application Support").join(identifier)
        }

        fn worktree(&self, identifier: &str) -> PathBuf {
            self.data_dir(identifier).join("worktrees/session-1")
        }
    }

    fn edit_log(data_dir: &Path, worktree: &Path) -> PathBuf {
        data_dir.join("edit-log").join(Uuid::new_v5(&Uuid::NAMESPACE_URL, worktree.to_string_lossy().as_bytes()).to_string())
    }

    /// A home folder holding what Hunt kept under `OLD`: a repository with one session worktree, its session record,
    /// pending cleanup, edit log and Claude Code project folder, and the webview's storage.
    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let home = root.join("home");
        let claude_dir = home.join(".claude");
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q", "-b", "main"]).await.unwrap();
        let identity = ["-c", "user.email=test@example.com", "-c", "user.name=Test"];
        run_git(&repo, &[&identity[..], &["commit", "-q", "--allow-empty", "-m", "init"]].concat()).await.unwrap();
        let fixture = Fixture { _dir: dir, home, claude_dir, repo };

        let data_dir = fixture.data_dir(OLD);
        let worktree = fixture.worktree(OLD);
        std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        git::worktree_add(&fixture.repo, "feat/general/x", &worktree, "main").await.unwrap();

        let id = Uuid::new_v4();
        let session = |id, worktree: &Path, branch: &str| {
            SessionRecord::new(id, "x".into(), fixture.repo.clone(), worktree.into(), branch.into(), "main".into(), "abc".into())
        };
        let sessions = vec![session(id, &worktree, "feat/general/x"), session(Uuid::new_v4(), &fixture.repo, "main")];
        std::fs::write(data_dir.join("sessions.json"), serde_json::to_vec(&sessions).unwrap()).unwrap();
        let cleanup = serde_json::json!([{
            "vm": { "project": "p", "zone": "z", "instance": "i" },
            "huntSessionId": id,
            "preserve": { "worktree": worktree, "remoteWorktree": "/srv/worktree" },
        }]);
        std::fs::write(data_dir.join("remote-cleanups.json"), cleanup.to_string()).unwrap();
        std::fs::create_dir_all(edit_log(&data_dir, &worktree)).unwrap();
        std::fs::create_dir_all(transcript::local_project(&worktree, &fixture.claude_dir)).unwrap();
        std::fs::create_dir_all(fixture.home.join("Library/WebKit").join(OLD).join("WebsiteData")).unwrap();
        fixture
    }

    #[tokio::test]
    async fn migrate_moves_the_data_and_every_reference_to_the_worktrees_once() {
        let fixture = fixture().await;
        migrate_in(&fixture.home, &fixture.claude_dir, OLD, NEW).await;

        let data_dir = fixture.data_dir(NEW);
        let worktree = fixture.worktree(NEW);
        assert!(!fixture.data_dir(OLD).exists() && worktree.join(".git").is_file());
        assert!(fixture.home.join("Library/WebKit").join(NEW).join("WebsiteData").is_dir());

        let sessions: Vec<SessionRecord> = serde_json::from_slice(&std::fs::read(data_dir.join("sessions.json")).unwrap()).unwrap();
        assert_eq!(sessions[0].worktree_path, worktree);
        assert_eq!(sessions[1].worktree_path, fixture.repo);
        let cleanups: serde_json::Value = serde_json::from_slice(&std::fs::read(data_dir.join("remote-cleanups.json")).unwrap()).unwrap();
        assert_eq!(cleanups[0]["preserve"]["worktree"], worktree.display().to_string());

        assert!(edit_log(&data_dir, &worktree).is_dir() && !edit_log(&data_dir, &fixture.worktree(OLD)).exists());
        assert!(transcript::local_project(&worktree, &fixture.claude_dir).is_dir());
        assert!(!transcript::local_project(&fixture.worktree(OLD), &fixture.claude_dir).exists());

        let worktrees = run_git(&fixture.repo, &["worktree", "list", "--porcelain"]).await.unwrap();
        assert!(worktrees.contains(&format!("worktree {}\n", worktree.display())), "{worktrees}");
        assert!(!worktrees.contains("prunable"), "{worktrees}");

        std::fs::create_dir_all(fixture.data_dir(OLD)).unwrap();
        migrate_in(&fixture.home, &fixture.claude_dir, OLD, NEW).await;
        assert!(fixture.data_dir(OLD).is_dir() && worktree.join(".git").is_file());
    }
}
