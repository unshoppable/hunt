//! The commands of the Checks tab: the checks the worktree's hunt.json declares with their last runs, running and
//! stopping them in the worktree of a local session or on the VM of a remote one, and their output, which
//! `checks:changed` and `checks:output` stream to the main window.

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::{remote_worktree, running_remote, worktree_file, worktree_session};
use crate::agent::acp::SessionRegistry;
use crate::checks::{self, CheckDefinition, CheckNotice, CheckRegistry, CheckRunView};
use crate::git;
use crate::platform::shell::shell_command;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::terminal;
use crate::terminal::interactive::{Terminal, TerminalSize};

/// Cells of the pseudo terminal a check runs in; its output is shown later at any width, so it is wide.
const CHECK_TERMINAL_SIZE: TerminalSize = TerminalSize { cols: 160, rows: 50 };

/// The checks of a session as the Checks tab shows them: those the worktree's hunt.json declares (none and `problem`
/// when its `checks` section is malformed), the last run of each and the names of those whose run started on another
/// state of the worktree.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksStatus {
    definitions: Vec<CheckDefinition>,
    problem: Option<String>,
    runs: Vec<CheckRunView>,
    outdated: Vec<String>,
}

#[tauri::command]
pub async fn checks_status(app: AppHandle, checks: State<'_, CheckRegistry>, id: Uuid) -> Result<ChecksStatus, String> {
    let record = worktree_session(&app, id)?;
    let (definitions, problem) = match checks::read_checks(&record.worktree_path) {
        Ok(definitions) => (definitions, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let runs = checks.runs(id);
    let current = if runs.iter().any(|(_, tree)| tree.is_some()) { git::worktree_tree(&record.worktree_path).await.ok() } else { None };
    let outdated = checks::outdated_names(&runs, current.as_deref());
    Ok(ChecksStatus { definitions, problem, runs: runs.into_iter().map(|(view, _)| view).collect(), outdated })
}

/// Runs the check `name` of the worktree's hunt.json: in the worktree of a local session, on the VM of a remote one
/// (`hunt-ctl check`), whose VM must run. `checks:changed` and `checks:output` report the run.
#[tauri::command]
pub async fn run_check(app: AppHandle, registry: State<'_, SessionRegistry>, checks: State<'_, CheckRegistry>, id: Uuid, name: String) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let tree = git::worktree_tree(&record.worktree_path).await.ok();
    start_check(&app, &registry, &checks, id, &name, tree).await.map(|_| ())
}

/// Runs every check of the worktree's hunt.json at once, except those that run already. A check that cannot start
/// fails with the error as its output; the others start all the same.
#[tauri::command]
pub async fn run_all_checks(app: AppHandle, registry: State<'_, SessionRegistry>, checks: State<'_, CheckRegistry>, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let definitions = checks::read_checks(&record.worktree_path)?;
    let tree = git::worktree_tree(&record.worktree_path).await.ok();
    for definition in definitions {
        if checks.is_running(id, &definition.name) {
            continue;
        }
        if let Err(error) = start_check(&app, &registry, &checks, id, &definition.name, tree.clone()).await {
            let emitter = app.clone();
            let _ = checks.start(id, &definition.name, tree.clone(), |_| Err(error), move |notice| emit_check_notice(&emitter, notice));
        }
    }
    Ok(())
}

/// Starts the check `name` of the session `id` on the worktree's tree object `tree` and returns the signal of its end.
async fn start_check(
    app: &AppHandle,
    registry: &SessionRegistry,
    checks: &CheckRegistry,
    id: Uuid,
    name: &str,
    tree: Option<String>,
) -> Result<oneshot::Receiver<()>, String> {
    let record = worktree_session(app, id)?;
    let definition = checks::read_checks(&record.worktree_path)?
        .into_iter()
        .find(|definition| definition.name == name)
        .ok_or_else(|| format!("failed to run the check {name}: hunt.json declares no such check"))?;
    let (program, args, folder) = match record.remote {
        None => {
            let folder = worktree_file(&record, definition.cwd.as_deref().unwrap_or(""))?;
            let (program, args) = terminal::local_command(&definition.command);
            (program, args, Some(folder))
        }
        Some(_) => {
            let target = running_remote(app, registry, id, "run the check").await?;
            let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
            let worktree = remote_worktree(app, id, &target, &ssh).await?;
            let command = shell_command("sudo", &["-n", "hunt-ctl", "check", &worktree, name]);
            ("ssh".to_string(), ssh.terminal_args(&command), None)
        }
    };
    let removed_env = terminal::foreign_env();
    let emitter = app.clone();
    checks.start(
        id,
        name,
        tree,
        move |handler| Terminal::spawn(&program, &args, folder.as_deref(), &removed_env, CHECK_TERMINAL_SIZE, handler),
        move |notice| emit_check_notice(&emitter, notice),
    )
}

/// Stops the check `name` of the session `id` if it runs.
#[tauri::command]
pub fn cancel_check(app: AppHandle, checks: State<'_, CheckRegistry>, id: Uuid, name: String) {
    if checks.cancel(id, &name) {
        emit_check_notice(&app, CheckNotice::Changed { session: id });
    }
}

/// Stops every running check of the session `id`.
#[tauri::command]
pub fn cancel_all_checks(app: AppHandle, checks: State<'_, CheckRegistry>, id: Uuid) {
    checks.cancel_all(id);
    emit_check_notice(&app, CheckNotice::Changed { session: id });
}

/// The output of the last run of a check, base64 of its last bytes; `end` is the offset at which `checks:output` of the
/// same run continues it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutput {
    run: u64,
    end: u64,
    data: String,
}

#[tauri::command]
pub fn check_output(checks: State<'_, CheckRegistry>, id: Uuid, name: String) -> Option<CheckOutput> {
    let tail = checks.output(id, &name)?;
    Some(CheckOutput { run: tail.run, end: tail.end, data: base64::engine::general_purpose::STANDARD.encode(tail.data) })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecksChangedEvent {
    session_id: Uuid,
}

/// A chunk of a check's output as base64, starting at byte `offset` of the run's output.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckOutputEvent {
    session_id: Uuid,
    name: String,
    run: u64,
    offset: u64,
    data: String,
}

/// Hands a run's change to the main window, the one with the Checks tab, as `checks:changed` or `checks:output`.
fn emit_check_notice(app: &AppHandle, notice: CheckNotice) {
    let _ = match notice {
        CheckNotice::Changed { session } => app.emit_to("main", "checks:changed", ChecksChangedEvent { session_id: session }),
        CheckNotice::Output { session, name, run, offset, data } => {
            let data = base64::engine::general_purpose::STANDARD.encode(data);
            app.emit_to("main", "checks:output", CheckOutputEvent { session_id: session, name, run, offset, data })
        }
    };
}
