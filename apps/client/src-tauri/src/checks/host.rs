//! Where the checks of a session run: a window of the family's tmux server on this Mac (`terminal/tmux.rs`), or of the
//! tmux session `app` on the VM of a remote session (`remote/terminal.rs`). Like every window there, a check's window
//! logs its output, which the agents of the family read. Knows nothing about Tauri.

use std::path::Path;

use uuid::Uuid;

use crate::remote::ssh::Ssh;
use crate::remote::terminal as vm_terminal;
use crate::terminal::tmux::{LocalTmux, Machine, TmuxWindow};

/// The tmux that runs the checks of a session.
pub enum CheckHost {
    /// The family's tmux server on this Mac; the check windows belong to the Hunt session `owner`.
    Desktop { tmux: LocalTmux, owner: Uuid },
    /// The tmux session `app` on the running VM of a remote session.
    Vm(Ssh),
}

impl CheckHost {
    pub fn machine(&self) -> Machine {
        match self {
            CheckHost::Desktop { .. } => Machine::Desktop,
            CheckHost::Vm(_) => Machine::Vm,
        }
    }

    /// Runs the check `check` with the command line `command` in the folder `folder` in its window and returns the
    /// window's ID.
    pub async fn run(&self, folder: &str, check: &str, command: &str) -> Result<String, String> {
        match self {
            CheckHost::Desktop { tmux, owner } => tmux.run_check_window(Path::new(folder), check, command, *owner).await,
            CheckHost::Vm(ssh) => vm_terminal::run_check_window(ssh, folder, check, command).await,
        }
    }

    /// The window `window_id`; `None` once it is gone.
    pub async fn window(&self, window_id: &str) -> Result<Option<TmuxWindow>, String> {
        let windows = match self {
            CheckHost::Desktop { tmux, .. } => tmux.list_windows().await?,
            CheckHost::Vm(ssh) => vm_terminal::list_windows(ssh).await?,
        };
        Ok(windows.into_iter().find(|window| window.id == window_id))
    }

    /// Ends the program of the window `window_id`; the window stays with its output.
    pub async fn stop(&self, window_id: &str) -> Result<(), String> {
        match self {
            CheckHost::Desktop { tmux, .. } => tmux.stop_window(window_id).await,
            CheckHost::Vm(ssh) => vm_terminal::stop_window(ssh, window_id).await,
        }
    }

    /// The history and the screen of the window `window_id` as plain text.
    pub async fn capture(&self, window_id: &str) -> Result<String, String> {
        match self {
            CheckHost::Desktop { tmux, .. } => tmux.capture_window(window_id).await,
            CheckHost::Vm(ssh) => vm_terminal::capture_window(ssh, window_id).await,
        }
    }
}
