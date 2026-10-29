//! The commands of the Checks tab: the checks the worktree's hunt.json declares with their last runs, running and
//! stopping them in a tmux window of a local session or on the VM of a remote one (`checks::CheckHost`), following each
//! window to the end of its check, and the output of a run as text. `checks:changed` tells the main window about every
//! change of a run.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use super::{remote_worktree, running_remote, worktree_file, worktree_session};
use crate::agent::acp::SessionRegistry;
use crate::checks::{self, CheckDefinition, CheckHost, CheckRegistry, CheckRunView, CheckWindow};
use crate::git;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::session::store::SessionRecord;
use crate::terminal::tmux::LocalTmux;

/// How often Hunt asks whether the program of a running check ended.
const CHECK_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Failed reads of a running check's window in a row after which Hunt gives the check up, such as while the VM is unreachable.
const MAX_FOLLOW_ERRORS: u32 = 10;

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

/// Runs the check `name` of the worktree's hunt.json in its tmux window: in the family's tmux server for a local
/// session, on the VM of a remote one, whose VM must run. `checks:changed` reports the run.
#[tauri::command]
pub async fn run_check(app: AppHandle, registry: State<'_, SessionRegistry>, checks: State<'_, CheckRegistry>, id: Uuid, name: String) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let tree = git::worktree_tree(&record.worktree_path).await.ok();
    start_check(&app, &registry, &checks, id, &name, tree).await
}

/// Runs every check of the worktree's hunt.json at once, except those that run already. A check that cannot start
/// fails with the error; the others start all the same.
#[tauri::command]
pub async fn run_all_checks(app: AppHandle, registry: State<'_, SessionRegistry>, checks: State<'_, CheckRegistry>, id: Uuid) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    let definitions = checks::read_checks(&record.worktree_path)?;
    let tree = git::worktree_tree(&record.worktree_path).await.ok();
    for definition in definitions {
        if checks.is_running(id, &definition.name) {
            continue;
        }
        // A check that cannot start keeps the error in its run.
        let _ = start_check(&app, &registry, &checks, id, &definition.name, tree.clone()).await;
    }
    Ok(())
}

/// Starts the check `name` of the session `id` on the worktree's tree object `tree` and follows its window until the
/// check ends. A check that cannot start fails with the error, which it also returns.
async fn start_check(app: &AppHandle, registry: &SessionRegistry, checks: &CheckRegistry, id: Uuid, name: &str, tree: Option<String>) -> Result<(), String> {
    let run = checks.start(id, name, tree)?;
    emit_checks_changed(app, id);
    let (host, window_id) = match open_check_window(app, registry, id, name).await {
        Ok(opened) => opened,
        Err(error) => {
            checks.fail(id, name, run, error.clone());
            emit_checks_changed(app, id);
            return Err(error);
        }
    };
    if !checks.attach(id, name, run, CheckWindow { id: window_id.clone(), machine: host.machine() }) {
        return host.stop(&window_id).await;
    }
    emit_checks_changed(app, id);
    tauri::async_runtime::spawn(follow_check(app.clone(), host, id, name.to_string(), run, window_id));
    Ok(())
}

/// The tmux of the session `id` and the ID of the window in which it runs the check `name` of the worktree's hunt.json,
/// in the check's folder.
async fn open_check_window(app: &AppHandle, registry: &SessionRegistry, id: Uuid, name: &str) -> Result<(CheckHost, String), String> {
    let record = worktree_session(app, id)?;
    let definition = checks::read_checks(&record.worktree_path)?
        .into_iter()
        .find(|definition| definition.name == name)
        .ok_or_else(|| format!("failed to run the check {name}: hunt.json declares no such check"))?;
    let cwd = definition.cwd.as_deref().unwrap_or("");
    let (host, folder) = match record.remote {
        None => (local_host(&record).await?, worktree_file(&record, cwd)?.display().to_string()),
        Some(_) => {
            git::ensure_inside_worktree(cwd)?;
            let target = running_remote(app, registry, id, "run the check").await?;
            let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
            let folder = Path::new(&remote_worktree(app, id, &target, &ssh).await?).join(cwd).display().to_string();
            (CheckHost::Vm(ssh), folder)
        }
    };
    let window_id = host.run(&folder, name, &definition.command).await?;
    Ok((host, window_id))
}

/// Asks every `CHECK_POLL_INTERVAL` whether the program in the window `window_id` of the run `run` ended, and ends the
/// run with its exit code; as failed when the window is gone or could not be read `MAX_FOLLOW_ERRORS` times in a row.
/// Stops once the run no longer runs (cancelled, replaced or forgotten).
async fn follow_check(app: AppHandle, host: CheckHost, id: Uuid, name: String, run: u64, window_id: String) {
    let checks = app.state::<CheckRegistry>();
    let mut errors = 0;
    loop {
        tokio::time::sleep(CHECK_POLL_INTERVAL).await;
        if !checks.is_current(id, &name, run) {
            return;
        }
        let has_ended = match host.window(&window_id).await {
            Ok(Some(window)) if !window.is_dead => {
                errors = 0;
                continue;
            }
            Ok(Some(window)) => checks.end(id, &name, run, window.exit_code),
            Ok(None) => checks.fail(id, &name, run, format!("the check's tmux window {window_id} was closed")),
            Err(error) => {
                errors += 1;
                if errors < MAX_FOLLOW_ERRORS {
                    continue;
                }
                checks.fail(id, &name, run, format!("failed to follow the check: {error}"))
            }
        };
        if has_ended {
            emit_checks_changed(&app, id);
        }
        return;
    }
}

/// Stops the check `name` of the session `id` if it runs; its window stays with the output so far.
#[tauri::command]
pub async fn cancel_check(app: AppHandle, registry: State<'_, SessionRegistry>, checks: State<'_, CheckRegistry>, id: Uuid, name: String) -> Result<(), String> {
    let window = checks.cancel(id, &name);
    emit_checks_changed(&app, id);
    stop_windows(&app, &registry, id, window.into_iter().collect()).await
}

/// Stops every running check of the session `id`.
#[tauri::command]
pub async fn cancel_all_checks(app: AppHandle, registry: State<'_, SessionRegistry>, checks: State<'_, CheckRegistry>, id: Uuid) -> Result<(), String> {
    let windows = checks.cancel_all(id);
    emit_checks_changed(&app, id);
    stop_windows(&app, &registry, id, windows).await
}

/// Ends the programs in the check windows `windows` of the session `id`.
async fn stop_windows(app: &AppHandle, registry: &SessionRegistry, id: Uuid, windows: Vec<CheckWindow>) -> Result<(), String> {
    if windows.is_empty() {
        return Ok(());
    }
    let host = check_host(app, registry, id).await?;
    for window in windows {
        host.stop(&window.id).await?;
    }
    Ok(())
}

/// The output of the last run of the check `name` as plain text: the history and the screen of its window, or why it
/// could not start; `None` before its first run.
#[tauri::command]
pub async fn check_output(app: AppHandle, registry: State<'_, SessionRegistry>, checks: State<'_, CheckRegistry>, id: Uuid, name: String) -> Result<Option<String>, String> {
    let Some(run) = checks.run(id, &name) else { return Ok(None) };
    let Some(window) = run.window else { return Ok(run.error) };
    check_host(&app, &registry, id).await?.capture(&window.id).await.map(Some)
}

/// The tmux that runs the checks of the session `id`: the family's tmux server for a local session, the running VM of
/// a remote one.
async fn check_host(app: &AppHandle, registry: &SessionRegistry, id: Uuid) -> Result<CheckHost, String> {
    let record = worktree_session(app, id)?;
    if record.remote.is_none() {
        return local_host(&record).await;
    }
    let target = running_remote(app, registry, id, "reach the window of the check").await?;
    Ok(CheckHost::Vm(Ssh::open(&target.vm, &ssh_dir()?).await?))
}

/// The tmux server of the family of the local session `record`, whose check windows belong to that session.
async fn local_host(record: &SessionRecord) -> Result<CheckHost, String> {
    let tmux = LocalTmux::prepare(&record.worktree_path, record.parent_id.unwrap_or(record.id)).await?;
    Ok(CheckHost::Desktop { tmux, owner: record.id })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChecksChangedEvent {
    session_id: Uuid,
}

/// Tells the main window, the one with the Checks tab, that a run of the session `id` changed (`checks:changed`).
fn emit_checks_changed(app: &AppHandle, id: Uuid) {
    let _ = app.emit_to("main", "checks:changed", ChecksChangedEvent { session_id: id });
}
