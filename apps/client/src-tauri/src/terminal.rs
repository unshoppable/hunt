//! Opens a directory in a terminal: a new tab of WezTerm when it is installed, else a new Terminal.app window. Also
//! names the program the embedded terminals of a local session run.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// How long `wezterm start` may take to hand the tab to a running WezTerm; past it, it runs the GUI itself.
const WEZTERM_HANDOVER: Duration = Duration::from_secs(3);

fn wezterm_app() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().map(|home| PathBuf::from(home).join("Applications/WezTerm.app"));
    [Some(PathBuf::from("/Applications/WezTerm.app")), home].into_iter().flatten().find(|app| app.join("Contents/MacOS/wezterm").exists())
}

/// Opens a shell in `directory` and brings the terminal to the front.
pub async fn open_directory(directory: &Path) -> Result<(), String> {
    let Some(app) = wezterm_app() else {
        return run(Command::new("open").arg("-a").arg("Terminal").arg(directory)).await;
    };
    let mut start = Command::new(app.join("Contents/MacOS/wezterm"))
        .arg("start")
        .arg("--new-tab")
        .arg("--cwd")
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start WezTerm: {error}"))?;
    // A running WezTerm takes the tab over and `wezterm start` exits, leaving WezTerm in the background; without one
    // it becomes the GUI, which comes to the front by itself.
    match tokio::time::timeout(WEZTERM_HANDOVER, start.wait()).await {
        Ok(Ok(status)) if status.success() => run(Command::new("open").arg("-a").arg(&app)).await,
        Ok(Ok(status)) => Err(format!("failed to open a WezTerm tab: wezterm start exited with {status}")),
        Ok(Err(error)) => Err(format!("failed to open a WezTerm tab: {error}")),
        Err(_) => Ok(()),
    }
}

/// Program and arguments of an embedded terminal of a local session: the user's login shell, interactive; with `script`
/// it runs the package.json script `script` through npm and ends with it. A login shell also reads the profile files
/// that put Node and npm on the `PATH`, which an app started from the Finder lacks.
pub fn local_shell(script: Option<&str>) -> (String, Vec<String>) {
    match script {
        None => (user_shell(), vec!["-l".to_string()]),
        Some(script) => local_command(&crate::remote::shell_command("npm", &["run", script])),
    }
}

/// Program and arguments that run the shell command line `command_line` in the user's interactive login shell, as
/// `local_shell` runs a script, and end with it.
pub fn local_command(command_line: &str) -> (String, Vec<String>) {
    (user_shell(), vec!["-l".to_string(), "-i".to_string(), "-c".to_string(), command_line.to_string()])
}

fn user_shell() -> String {
    std::env::var("SHELL").ok().filter(|shell| !shell.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string())
}

/// The environment variables of Hunt that an embedded terminal leaves out: the `npm_*` ones of the `npm run` that
/// started Hunt in development, which would steer the npm of the terminal.
pub fn foreign_env() -> Vec<String> {
    std::env::vars_os().filter_map(|(name, _)| name.into_string().ok()).filter(|name| name.starts_with("npm_")).collect()
}

async fn run(command: &mut Command) -> Result<(), String> {
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("failed to open the terminal: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!("failed to open the terminal: {}", String::from_utf8_lossy(&output.stderr).trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_shell_runs_a_script_through_npm_in_a_login_shell() {
        let (_, args) = local_shell(None);
        assert_eq!(args, ["-l"]);
        let (_, args) = local_shell(Some("start:server"));
        assert_eq!(args, ["-l", "-i", "-c", "npm run start:server"]);
        let (_, args) = local_shell(Some("a b; rm"));
        assert_eq!(args[3], "npm run 'a b; rm'");
    }
}
