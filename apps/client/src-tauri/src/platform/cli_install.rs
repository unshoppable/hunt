//! The `hunt` command on the user's PATH: the symlink `~/.local/bin/hunt` to the `hunt-cli` binary beside the app's own
//! (`target/<profile>/hunt-cli` in development, `Hunt.app/Contents/MacOS/hunt-cli` in the bundle), installed from
//! Settings → Updates.

use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::{symlink, DirBuilderExt};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// File name of the CLI binary, built next to the app binary.
const CLI_BINARY: &str = "hunt-cli";

/// Where the link goes, relative to the home folder.
const LINK_PATH: &str = ".local/bin/hunt";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstall {
    /// Full path of the link, `$HOME/.local/bin/hunt`.
    pub link_path: String,
    /// Whether the link is a symlink resolving to this app's `hunt-cli`.
    pub installed: bool,
    /// Whether the link's folder is a folder of Hunt's PATH, which is the login shell's.
    pub on_path: bool,
}

#[tauri::command]
pub fn cli_install_status() -> Result<CliInstall, String> {
    let (link, target) = (link_path()?, cli_binary()?);
    Ok(link_status(&link, &target, std::env::var_os("PATH").as_deref()))
}

#[tauri::command]
pub fn install_cli() -> Result<CliInstall, String> {
    let (link, target) = (link_path()?, cli_binary()?);
    install_link(&link, &target)?;
    Ok(link_status(&link, &target, std::env::var_os("PATH").as_deref()))
}

fn link_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("failed to find the home folder: HOME is not set")?;
    Ok(PathBuf::from(home).join(LINK_PATH))
}

fn cli_binary() -> Result<PathBuf, String> {
    let app_binary = std::env::current_exe().map_err(|error| format!("failed to find the app binary: {error}"))?;
    Ok(app_binary.with_file_name(CLI_BINARY))
}

/// The state of `link` against the CLI binary `target`; `path_var` is the value of `PATH`.
pub fn link_status(link: &Path, target: &Path, path_var: Option<&OsStr>) -> CliInstall {
    let on_path = link.parent().is_some_and(|folder| is_on_path(folder, path_var));
    CliInstall { link_path: link.display().to_string(), installed: links_to(link, target), on_path }
}

/// Makes `link` a symlink to `target`, creating its folder (0755) when missing. A symlink already at `link` is replaced
/// whatever it points at; a file or folder there is left alone and fails the install, as does a missing `target`.
pub fn install_link(link: &Path, target: &Path) -> Result<(), String> {
    if !target.is_file() {
        let hint = if cfg!(debug_assertions) { "; build it first with `cargo build --bin hunt-cli`" } else { "" };
        return Err(format!("failed to install the command line tool: {} does not exist{hint}", target.display()));
    }
    if let Some(folder) = link.parent() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o755)
            .create(folder)
            .map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
    }
    match fs::symlink_metadata(link) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(link).map_err(|error| format!("failed to remove the old link {}: {error}", link.display()))?;
        }
        Ok(metadata) => {
            let kind = if metadata.is_dir() { "a folder" } else { "a file" };
            return Err(format!(
                "failed to install the command line tool: {} is {kind}, not a symlink; move it away and install again",
                link.display()
            ));
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect {}: {error}", link.display())),
    }
    symlink(target, link).map_err(|error| format!("failed to link {} to {}: {error}", link.display(), target.display()))
}

/// Whether `link` is a symlink that resolves to the existing file `target`.
fn links_to(link: &Path, target: &Path) -> bool {
    let is_symlink = fs::symlink_metadata(link).is_ok_and(|metadata| metadata.file_type().is_symlink());
    if !is_symlink {
        return false;
    }
    match (fs::canonicalize(link), fs::canonicalize(target)) {
        (Ok(resolved_link), Ok(resolved_target)) => resolved_link == resolved_target,
        _ => false,
    }
}

fn is_on_path(folder: &Path, path_var: Option<&OsStr>) -> bool {
    path_var.is_some_and(|path_value| std::env::split_paths(path_value).any(|path_folder| path_folder == folder))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporary home with the CLI binary at `app/hunt-cli` and the link path `.local/bin/hunt`, which does not exist yet.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join("app").join(CLI_BINARY);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "binary").unwrap();
        let link = home.path().join(LINK_PATH);
        (home, link, target)
    }

    #[test]
    fn installs_the_link_and_its_folder() {
        let (_home, link, target) = fixture();
        install_link(&link, &target).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), target);
        assert!(link_status(&link, &target, None).installed);
    }

    #[test]
    fn replaces_a_symlink_whatever_it_points_at() {
        let (home, link, target) = fixture();
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(home.path().join("old/hunt-cli"), &link).unwrap();
        install_link(&link, &target).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), target);
        install_link(&link, &target).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), target);
    }

    #[test]
    fn refuses_a_file_or_folder_at_the_link_path() {
        let (_home, link, target) = fixture();
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        fs::write(&link, "someone else's hunt").unwrap();
        let error = install_link(&link, &target).unwrap_err();
        assert!(error.contains(&link.display().to_string()) && error.contains("a file"), "{error}");
        assert_eq!(fs::read_to_string(&link).unwrap(), "someone else's hunt");

        fs::remove_file(&link).unwrap();
        fs::create_dir(&link).unwrap();
        let error = install_link(&link, &target).unwrap_err();
        assert!(error.contains("a folder"), "{error}");
        assert!(link.is_dir());
    }

    #[test]
    fn refuses_a_missing_cli_binary() {
        let (_home, link, target) = fixture();
        fs::remove_file(&target).unwrap();
        let error = install_link(&link, &target).unwrap_err();
        assert!(error.contains(&target.display().to_string()), "{error}");
        assert!(fs::symlink_metadata(&link).is_err());
    }

    #[test]
    fn counts_only_a_symlink_to_the_current_binary_as_installed() {
        let (home, link, target) = fixture();
        assert!(!link_status(&link, &target, None).installed, "missing link");

        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let other = home.path().join("other-hunt-cli");
        fs::write(&other, "other binary").unwrap();
        symlink(&other, &link).unwrap();
        assert!(!link_status(&link, &target, None).installed, "link to another binary");

        fs::remove_file(&link).unwrap();
        symlink(&target, &link).unwrap();
        let status = link_status(&link, &target, None);
        assert!(status.installed, "link to the current binary");
        assert_eq!(status.link_path, link.display().to_string());

        fs::remove_file(&target).unwrap();
        assert!(!link_status(&link, &target, None).installed, "link to a binary that no longer exists");
    }

    #[test]
    fn detects_the_link_folder_on_the_path() {
        let link = Path::new("/Users/someone/.local/bin/hunt");
        let target = Path::new("/Applications/Hunt.app/Contents/MacOS/hunt-cli");
        let on_path = |path_var: &str| link_status(link, target, Some(OsStr::new(path_var))).on_path;
        assert!(on_path("/usr/bin:/Users/someone/.local/bin:/bin"));
        assert!(on_path("/Users/someone/.local/bin/"));
        assert!(!on_path("/usr/bin:/Users/someone/.local/bin/hunt:/Users/someone/.local"));
        assert!(!on_path(""));
        assert!(!link_status(link, target, None).on_path);
    }
}
