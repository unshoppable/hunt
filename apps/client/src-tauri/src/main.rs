// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsStr;

fn main() {
    remove_launcher_variables();
    // A .app launched from Finder does not inherit the shell PATH; node and git must still resolve.
    let _ = fix_path_env::fix();
    hunt_lib::run()
}

/// Removes what `npm run` and Volta leave in the environment when Hunt is started from the workspace. Every shell,
/// git hook and agent Hunt starts inherits it, and while `_VOLTA_TOOL_RECURSION` is set Volta ignores the node version
/// a project pins and runs the next `node` on PATH.
fn remove_launcher_variables() {
    let names: Vec<_> = std::env::vars_os().map(|(name, _)| name).filter(|name| is_launcher_variable(name)).collect();
    for name in names {
        // SAFETY: runs first in `main`, before any other thread exists.
        unsafe { std::env::remove_var(name) };
    }
}

fn is_launcher_variable(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name == "_VOLTA_TOOL_RECURSION" || name == "INIT_CWD" || name == "NODE" || name.starts_with("npm_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treats_the_volta_and_npm_run_state_as_launcher_variables() {
        for name in ["_VOLTA_TOOL_RECURSION", "INIT_CWD", "NODE", "npm_config_prefix", "npm_lifecycle_event"] {
            assert!(is_launcher_variable(OsStr::new(name)), "{name}");
        }
    }

    #[test]
    fn keeps_every_other_variable() {
        for name in ["PATH", "VOLTA_HOME", "NODE_OPTIONS", "HOME", "NPM_TOKEN"] {
            assert!(!is_launcher_variable(OsStr::new(name)), "{name}");
        }
    }
}
