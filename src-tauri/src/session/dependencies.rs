//! Node dependencies of a session's worktree. `git worktree add` checks out tracked files only, so a fresh
//! worktree has no `node_modules` and the language server resolves no imports. When the repository has an
//! installed `node_modules`, it is cloned with one APFS `clonefile` call: copy-on-write, seconds instead of
//! minutes and no extra disk space. When the worktree's lockfile differs from the repository's, or there is
//! nothing to clone, the package manager named by the lockfile installs on top. Progress is part of the
//! session list (`SessionView::dependencies`); the worktree's language server restarts once the modules exist.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

use crate::lsp::{self, LspRegistry};

/// Lockfiles and the package manager that wrote them, with its install command.
const LOCKFILES: &[Lockfile] = &[
    Lockfile { name: "pnpm-lock.yaml", manager: "pnpm", args: &["install"] },
    Lockfile { name: "yarn.lock", manager: "yarn", args: &["install"] },
    Lockfile { name: "bun.lock", manager: "bun", args: &["install"] },
    Lockfile { name: "bun.lockb", manager: "bun", args: &["install"] },
    Lockfile { name: "package-lock.json", manager: "npm", args: &["install", "--no-audit", "--no-fund"] },
];

/// Longest tail of the install output kept in a failure message.
const MAX_OUTPUT_CHARS: usize = 2_000;

struct Lockfile {
    name: &'static str,
    manager: &'static str,
    args: &'static [&'static str],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DependencyPhase {
    Running,
    Ready,
    Failed,
}

/// What the preparation of a worktree's `node_modules` is doing or ended with.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub phase: DependencyPhase,
    pub message: String,
}

/// Status per worktree; sub sessions share their parent's worktree and therefore its status.
#[derive(Default)]
pub struct DependencyRegistry {
    statuses: Mutex<HashMap<PathBuf, DependencyStatus>>,
}

impl DependencyRegistry {
    pub fn status(&self, worktree: &Path) -> Option<DependencyStatus> {
        self.statuses.lock().unwrap().get(worktree).cloned()
    }

    pub fn forget(&self, worktree: &Path) {
        self.statuses.lock().unwrap().remove(worktree);
    }

    fn set(&self, worktree: &Path, phase: DependencyPhase, message: impl Into<String>) {
        self.statuses.lock().unwrap().insert(worktree.to_path_buf(), DependencyStatus { phase, message: message.into() });
    }
}

/// Prepares `node_modules` of `worktree` in the background when the worktree has a known lockfile and no
/// `node_modules` yet; a preparation already running for the worktree is left alone. Failures end up in the
/// status (and the log), never in the caller's result.
pub fn ensure(app: &AppHandle, repo: PathBuf, worktree: PathBuf) {
    // A session in the repository's own checkout uses whatever the user installed there.
    if worktree == repo {
        return;
    }
    let Some(lockfile) = LOCKFILES.iter().find(|lockfile| worktree.join(lockfile.name).is_file()) else {
        return;
    };
    if worktree.join("node_modules").exists() {
        return;
    }
    let registry = app.state::<DependencyRegistry>();
    if registry.status(&worktree).is_some_and(|status| status.phase == DependencyPhase::Running) {
        return;
    }
    registry.set(&worktree, DependencyPhase::Running, "Preparing node_modules…");

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let registry = app.state::<DependencyRegistry>();
        let report = |message: String| {
            registry.set(&worktree, DependencyPhase::Running, message);
            let _ = app.emit("sessions:changed", ());
        };
        let outcome = prepare(&repo, &worktree, lockfile, &report).await;
        match outcome {
            Ok(()) => {
                registry.set(&worktree, DependencyPhase::Ready, "node_modules ready");
                // The language server started without node_modules; a fresh one resolves the imports.
                lsp::stop_for_worktree(&app.state::<LspRegistry>(), &worktree).await;
            }
            Err(error) => {
                eprintln!("preparing node_modules of {} failed: {error}", worktree.display());
                registry.set(&worktree, DependencyPhase::Failed, error);
            }
        }
        let _ = app.emit("sessions:changed", ());
    });
}

/// Clones the repository's `node_modules` when it has one, then installs unless the clone matches the lockfile;
/// `report` receives the step in progress.
async fn prepare(repo: &Path, worktree: &Path, lockfile: &Lockfile, report: &(dyn Fn(String) + Sync)) -> Result<(), String> {
    let source = repo.join("node_modules");
    let target = worktree.join("node_modules");

    let mut cloned = false;
    if source.is_dir() {
        report("Cloning node_modules from the repository…".into());
        match clone_directory(&source, &target).await {
            Ok(()) => {
                cloned = true;
                // Build caches inside node_modules carry absolute paths of the repository.
                let _ = tokio::fs::remove_dir_all(target.join(".cache")).await;
            }
            Err(error) => eprintln!("cloning {} failed, installing instead: {error}", source.display()),
        }
    }
    if cloned && same_content(&repo.join(lockfile.name), &worktree.join(lockfile.name)).await {
        return Ok(());
    }

    report(format!("Running {} {}…", lockfile.manager, lockfile.args[0]));
    install(worktree, lockfile).await
}

async fn install(worktree: &Path, lockfile: &Lockfile) -> Result<(), String> {
    let output = Command::new(lockfile.manager)
        .args(lockfile.args)
        .current_dir(worktree)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("failed to run {}: {error}", lockfile.manager))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() { stdout } else { stderr };
    Err(format!("{} {} failed: {}", lockfile.manager, lockfile.args.join(" "), tail(detail.trim(), MAX_OUTPUT_CHARS)))
}

async fn same_content(left: &Path, right: &Path) -> bool {
    match (tokio::fs::read(left).await, tokio::fs::read(right).await) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Copy-on-write clone of the directory tree `source` as `target` (which must not exist) in one APFS call;
/// fails on another file system or volume.
async fn clone_directory(source: &Path, target: &Path) -> Result<(), String> {
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|error| format!("invalid source path: {error}"))?;
    let target = CString::new(target.as_os_str().as_bytes()).map_err(|error| format!("invalid target path: {error}"))?;
    tokio::task::spawn_blocking(move || {
        // SAFETY: both strings are valid NUL-terminated paths that outlive the call.
        let result = unsafe { libc::clonefile(source.as_ptr(), target.as_ptr(), 0) };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("clonefile failed: {}", std::io::Error::last_os_error()))
        }
    })
    .await
    .map_err(|error| format!("clonefile task failed: {error}"))?
}

fn tail(text: &str, max_chars: usize) -> &str {
    match text.char_indices().rev().nth(max_chars.saturating_sub(1)) {
        Some((index, _)) => &text[index..],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clone_directory_copies_the_tree_independently() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::create_dir_all(source.join("nested/.bin")).unwrap();
        std::fs::write(source.join("nested/.bin/tool"), "original").unwrap();
        std::os::unix::fs::symlink("../nested/.bin/tool", source.join("link")).unwrap();

        let target = dir.path().join("target");
        clone_directory(&source, &target).await.unwrap();

        std::fs::write(target.join("nested/.bin/tool"), "changed").unwrap();
        assert_eq!(std::fs::read_to_string(source.join("nested/.bin/tool")).unwrap(), "original");
        assert_eq!(std::fs::read_link(target.join("link")).unwrap(), Path::new("../nested/.bin/tool"));
        assert!(clone_directory(&source, &target).await.is_err(), "an existing target is refused");
    }

    fn lockfile(name: &str) -> &'static Lockfile {
        LOCKFILES.iter().find(|lockfile| lockfile.name == name).unwrap()
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[tokio::test]
    async fn prepare_clones_the_repository_modules_when_the_lockfile_matches() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, worktree) = (dir.path().join("repo"), dir.path().join("worktree"));
        write(&repo.join("package-lock.json"), "{}");
        write(&repo.join("node_modules/.bin/tsgo"), "#!/bin/sh");
        write(&repo.join("node_modules/.cache/build.json"), "{}");
        write(&worktree.join("package-lock.json"), "{}");

        let steps = Mutex::new(Vec::new());
        prepare(&repo, &worktree, lockfile("package-lock.json"), &|message| steps.lock().unwrap().push(message)).await.unwrap();

        assert!(worktree.join("node_modules/.bin/tsgo").is_file());
        assert!(!worktree.join("node_modules/.cache").exists(), "build caches are dropped from the clone");
        assert_eq!(steps.into_inner().unwrap(), vec!["Cloning node_modules from the repository…"]);
    }

    #[tokio::test]
    async fn prepare_installs_when_the_lockfile_differs() {
        if std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).all(|dir| !dir.join("npm").is_file()) {
            println!("npm not installed, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (repo, worktree) = (dir.path().join("repo"), dir.path().join("worktree"));
        let package = r#"{"name":"fixture","version":"1.0.0","private":true}"#;
        write(&repo.join("package.json"), package);
        write(&repo.join("package-lock.json"), "{}");
        write(&repo.join("node_modules/stale/index.js"), "");
        write(&worktree.join("package.json"), package);
        write(&worktree.join("package-lock.json"), r#"{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}"#);

        let steps = Mutex::new(Vec::new());
        prepare(&repo, &worktree, lockfile("package-lock.json"), &|message| steps.lock().unwrap().push(message)).await.unwrap();

        assert!(worktree.join("node_modules/.package-lock.json").is_file(), "npm wrote the worktree's node_modules");
        assert_eq!(steps.into_inner().unwrap(), vec!["Cloning node_modules from the repository…", "Running npm install…"]);
    }

    #[test]
    fn tail_keeps_the_last_characters() {
        assert_eq!(tail("abcdef", 3), "def");
        assert_eq!(tail("ab", 3), "ab");
        assert_eq!(tail("", 3), "");
    }
}
