//! Opens a directory in a terminal: a new tab of WezTerm when it is installed, else a new Terminal.app window.

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
