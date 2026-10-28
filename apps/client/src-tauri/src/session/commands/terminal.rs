//! The commands of a session's terminals: a terminal on a tmux window or a service, on the VM of a remote session or in
//! the family's tmux server on this Mac, with its input, size and end; the tmux windows themselves; and opening the
//! worktree in the user's terminal app.

use std::path::Path;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use super::{remote_vm_state, remote_worktree, running_remote, worktree_file, worktree_session};
use crate::agent::acp::SessionRegistry;
use crate::git::WorktreeRelativePath;
use crate::remote;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::session::store::{self, SessionRecord};
use crate::terminal;
use crate::terminal::interactive::{Terminal, TerminalEvent, TerminalRegistry, TerminalSize, TerminalTarget};
use crate::terminal::tmux::{self, LocalTmux, Machine, TmuxWindow};

/// A chunk of a terminal's output as base64 of its bytes, which may end inside a UTF-8 or an escape sequence.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    id: Uuid,
    data: String,
}

/// The end of a terminal's program; `code` is `None` when a signal ended it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    id: Uuid,
    code: Option<u32>,
}

/// Opens the terminal `terminal_id` with `cols` × `rows` cells showing `process` of the session `id`: a service or a
/// window on the VM of a remote session, whose VM must run (it is not started), or a window of the family's tmux server
/// on this Mac. The caller picks the ID so it can listen before the first output arrives: `terminal:output` and finally
/// `terminal:exit` go to the calling window only, which owns the terminal.
#[tauri::command]
pub async fn open_terminal(
    app: AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, SessionRegistry>,
    terminals: State<'_, TerminalRegistry>,
    id: Uuid,
    terminal_id: Uuid,
    process: TerminalTarget,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let size = TerminalSize { cols, rows };
    let events = forward_terminal_events(&app, window.label(), terminal_id);
    let terminal = match &process {
        TerminalTarget::Window { id: window_id, machine: Machine::Desktop } => {
            let (record, tmux) = local_tmux(&app, id).await?;
            let args = tmux::view_args(&tmux::view_name(terminal_id), window_id)?;
            Terminal::spawn(&tmux.wrapper().to_string_lossy(), &args, Some(&record.worktree_path), &terminal::foreign_env(), size, events)?
        }
        _ => {
            let target = running_remote(&app, &registry, id, "open the terminal").await?;
            let args = remote::terminal::attach_args(&target, &process, terminal_id, &ssh_dir()?).await?;
            Terminal::spawn("ssh", &args, None, &[], size, events)?
        }
    };
    terminals.insert(terminal_id, window.label(), terminal)
}

/// The family's tmux server on this Mac for the session `id`, the server of the family's root session, with the
/// worktree's `.hunt/tmux` written.
async fn local_tmux(app: &AppHandle, id: Uuid) -> Result<(SessionRecord, LocalTmux), String> {
    let record = worktree_session(app, id)?;
    let tmux = LocalTmux::prepare(&record.worktree_path, record.parent_id.unwrap_or(record.id)).await?;
    Ok((record, tmux))
}

/// Hands the output and the end of the terminal `terminal_id` to the window `owner`, as `terminal:output` and `terminal:exit`.
fn forward_terminal_events(app: &AppHandle, owner: &str, terminal_id: Uuid) -> impl FnMut(TerminalEvent) + Send + 'static {
    let (emitter, receiver) = (app.clone(), owner.to_string());
    move |event| {
        let _ = match event {
            TerminalEvent::Output(bytes) => {
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                emitter.emit_to(receiver.as_str(), "terminal:output", TerminalOutputEvent { id: terminal_id, data })
            }
            TerminalEvent::Exit(code) => emitter.emit_to(receiver.as_str(), "terminal:exit", TerminalExitEvent { id: terminal_id, code }),
        };
    }
}

/// The windows of the tmux session `app` of the session `id` on `machine`, in their order: on the VM of a remote
/// session, where a VM that is off has none and is not started, or in the family's tmux server on this Mac, which a
/// remote session without a local worktree yet does not have.
#[tauri::command]
pub async fn terminal_windows(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, machine: Machine) -> Result<Vec<TmuxWindow>, String> {
    if machine == Machine::Desktop {
        if !store::find_session(&app, id)?.worktree_path.is_dir() {
            return Ok(Vec::new());
        }
        return local_tmux(&app, id).await?.1.list_windows().await;
    }
    let (target, is_running) = remote_vm_state(&app, &registry, id, "list the terminal windows").await?;
    if !is_running {
        return Ok(Vec::new());
    }
    // Only the family's root session runs on its VM, so every window there belongs to it.
    let root = store::find_session(&app, id)?.parent_id.unwrap_or(id);
    let mut windows = remote::terminal::list_windows(&Ssh::open(&target.vm, &ssh_dir()?).await?).await?;
    for window in &mut windows {
        window.owner.get_or_insert(root);
    }
    Ok(windows)
}

/// Starts a shell in a new tmux window of the session `id` and returns the window's ID: on the VM of a remote session,
/// in the family's tmux server on this Mac for a local one. With `script` the window runs that package.json script of
/// the worktree folder `directory`.
#[tauri::command]
pub async fn open_shell_window(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    directory: WorktreeRelativePath,
    script: Option<String>,
) -> Result<String, String> {
    if store::find_session(&app, id)?.remote.is_none() {
        let (record, tmux) = local_tmux(&app, id).await?;
        let folder = worktree_file(&record, directory.as_str())?;
        return match script {
            Some(script) => tmux.open_script_window(&folder, &script, id).await,
            None => tmux.open_shell_window(&folder, id).await,
        };
    }
    let target = running_remote(&app, &registry, id, "open a shell").await?;
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    let Some(script) = script else {
        return remote::terminal::open_shell_window(&ssh).await;
    };
    let folder = Path::new(&remote_worktree(&app, id, &target, &ssh).await?).join(directory.as_str()).display().to_string();
    remote::terminal::open_script_window(&ssh, &folder, &script).await
}

/// Runs the package.json script of the ended script window `window_id` of the session `id` on `machine` again.
#[tauri::command]
pub async fn rerun_terminal_window(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, machine: Machine, window_id: String) -> Result<(), String> {
    if machine == Machine::Desktop {
        return local_tmux(&app, id).await?.1.rerun_window(&window_id, id).await;
    }
    let target = running_remote(&app, &registry, id, "run the script again").await?;
    remote::terminal::rerun_window(&Ssh::open(&target.vm, &ssh_dir()?).await?, &window_id).await
}

/// Ends the tmux window `window_id` of the session `id` on `machine` and the processes in it.
#[tauri::command]
pub async fn close_terminal_window(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, machine: Machine, window_id: String) -> Result<(), String> {
    if machine == Machine::Desktop {
        return local_tmux(&app, id).await?.1.kill_window(&window_id).await;
    }
    let target = running_remote(&app, &registry, id, "close the terminal window").await?;
    remote::terminal::kill_window(&Ssh::open(&target.vm, &ssh_dir()?).await?, &window_id).await
}

/// Types `data`, base64 of the input bytes, into the terminal `terminal_id`.
#[tauri::command]
pub fn write_terminal(terminals: State<'_, TerminalRegistry>, terminal_id: Uuid, data: String) -> Result<(), String> {
    let bytes =
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|error| format!("failed to decode the terminal input: {error}"))?;
    terminals.write(terminal_id, bytes)
}

#[tauri::command]
pub fn resize_terminal(terminals: State<'_, TerminalRegistry>, terminal_id: Uuid, cols: u16, rows: u16) -> Result<(), String> {
    terminals.resize(terminal_id, TerminalSize { cols, rows })
}

/// Ends the terminal `terminal_id`; the process it shows keeps running.
#[tauri::command]
pub fn close_terminal(terminals: State<'_, TerminalRegistry>, terminal_id: Uuid) {
    terminals.close(terminal_id);
}

/// Opens a shell in the session's worktree in the user's terminal.
#[tauri::command]
pub async fn open_worktree_in_terminal(app: AppHandle, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    terminal::open_directory(&record.worktree_path).await
}
