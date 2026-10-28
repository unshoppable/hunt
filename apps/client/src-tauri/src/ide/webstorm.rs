//! Opens paths and diffs in WebStorm.
//!
//! The JetBrains Toolbox launcher script wraps arguments that contain spaces in literal quotes
//! before handing them to `open --args`, so paths under "Application Support" arrive as
//! `"/Users/…/file"` and WebStorm reports "Cannot find file". The app therefore calls the
//! WebStorm binary directly and only uses the script to discover where WebStorm is installed.

use std::path::{Path, PathBuf};

use tokio::process::Command;

fn webstorm_binary() -> Result<PathBuf, String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?);

    let toolbox_script = home.join("Library/Application Support/JetBrains/Toolbox/scripts/webstorm");
    if let Ok(script) = std::fs::read_to_string(&toolbox_script) {
        if let Some(binary) = parse_toolbox_binary(&script) {
            if binary.exists() {
                return Ok(binary);
            }
        }
    }

    let candidates = [
        home.join("Applications/WebStorm.app/Contents/MacOS/webstorm"),
        PathBuf::from("/Applications/WebStorm.app/Contents/MacOS/webstorm"),
    ];
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| "WebStorm not found (looked in the Toolbox script, ~/Applications and /Applications)".to_string())
}

/// Extracts the binary path from the Toolbox script's `open -na "<binary>"` line.
fn parse_toolbox_binary(script: &str) -> Option<PathBuf> {
    let line = script.lines().find(|line| line.trim_start().starts_with("open -na "))?;
    let start = line.find('"')? + 1;
    let end = start + line[start..].find('"')?;
    Some(PathBuf::from(&line[start..end]))
}

/// Starts WebStorm with the given arguments and returns as soon as the command was handed over;
/// WebStorm itself keeps running.
fn launch_webstorm(args: &[&Path]) -> Result<(), String> {
    Command::new(webstorm_binary()?)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start WebStorm: {error}"))?;
    Ok(())
}

pub async fn open_path(path: &Path) -> Result<(), String> {
    launch_webstorm(&[path])
}

/// Opens `path` with the caret on the given 1-based line and column inside the `project` directory.
///
/// WebStorm opens a bare file in the last focused window as a non-project file, which only gets
/// lexer-level highlighting. Passing the project directory first opens (or reuses) that project
/// window, and the file is then attached to it because the project's base directory contains it.
pub async fn open_path_at(project: &Path, path: &Path, line: u32, column: u32) -> Result<(), String> {
    let line = line.to_string();
    let column = column.to_string();
    launch_webstorm(&[project, Path::new("--line"), Path::new(&line), Path::new("--column"), Path::new(&column), path])
}

pub async fn open_diff(left: &Path, right: &Path) -> Result<(), String> {
    launch_webstorm(&[Path::new("diff"), left, right])
}
