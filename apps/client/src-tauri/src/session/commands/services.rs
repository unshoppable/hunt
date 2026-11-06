//! The commands of the services of hunt.json: of a local session the services the worktree's hunt.json declares with
//! the state of their windows, and starting and stopping them in windows of the family's tmux server on this Mac; of a
//! session on a VM starting and stopping one through `hunt-ctl service`, whose systemd unit runs it in a tmux server
//! of its own (`preview_status` reports their state). `services:changed` tells the main window about every start and
//! stop.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use super::{local_session, running_remote, worktree_file};
use crate::agent::acp::SessionRegistry;
use crate::remote::preview::is_service_name;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote;
use crate::services::{self, ServiceDefinition, ServiceView};
use crate::session::store::{self, SessionRecord};
use crate::terminal::tmux::{service_command, service_window, LocalTmux};

/// The services of a local session as the Terminal tab shows them: those the worktree's hunt.json declares (none and
/// `problem` when its `services` section is malformed), each with the state of its window.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicesStatus {
    services: Vec<ServiceView>,
    problem: Option<String>,
}

#[tauri::command]
pub async fn services_status(app: AppHandle, id: Uuid) -> Result<ServicesStatus, String> {
    let record = local_session(&app, id)?;
    let (definitions, problem) = match services::read_services(&record.worktree_path) {
        Ok(definitions) => (definitions, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    if definitions.is_empty() {
        return Ok(ServicesStatus { services: Vec::new(), problem });
    }
    let windows = family_tmux(&record).await?.list_windows().await?;
    let mut views = services::service_views(&definitions, &windows);
    let listening = futures_util::future::join_all(views.iter().map(|view| async move {
        match view.port {
            Some(port) => services::is_listening(port).await,
            None => false,
        }
    }))
    .await;
    for (view, is_listening) in views.iter_mut().zip(listening) {
        view.is_listening = is_listening;
    }
    Ok(ServicesStatus { services: views, problem })
}

/// Starts the service `name` of the worktree's hunt.json, or every service without a name, each in its window of the
/// family's tmux server; a service that runs already stays as it is. Every service that can start starts; the first
/// error is returned after. A session on a VM starts the one service `name` there.
#[tauri::command]
pub async fn start_services(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, name: Option<String>) -> Result<(), String> {
    if store::find_session(&app, id)?.remote.is_some() {
        let name = name.ok_or("failed to start the services: a session on a VM starts them one at a time")?;
        return remote_service(&app, &registry, id, "start", &name).await;
    }
    let record = local_session(&app, id)?;
    let definitions = services::read_services(&record.worktree_path)?;
    let chosen: Vec<&ServiceDefinition> = match &name {
        Some(name) => vec![definitions
            .iter()
            .find(|definition| &definition.name == name)
            .ok_or_else(|| format!("failed to start the service {name}: hunt.json declares no such service"))?],
        None => definitions.iter().collect(),
    };
    let tmux = family_tmux(&record).await?;
    let mut first_error = None;
    for definition in chosen {
        if let Err(error) = start_one(&record, &tmux, definition).await {
            first_error.get_or_insert(format!("failed to start the service {}: {error}", definition.name));
        }
    }
    emit_services_changed(&app, id);
    first_error.map_or(Ok(()), Err)
}

async fn start_one(record: &SessionRecord, tmux: &LocalTmux, definition: &ServiceDefinition) -> Result<String, String> {
    let folder = worktree_file(record, definition.cwd.as_deref().unwrap_or(""))?;
    let command = service_command(&definition.command, &definition.env);
    tmux.start_service_window(&folder, &definition.name, &command, record.id).await
}

/// Stops the service `name` if it runs; its window stays with the output so far. On a VM its unit stops, and its log
/// keeps the output.
#[tauri::command]
pub async fn stop_service(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid, name: String) -> Result<(), String> {
    if store::find_session(&app, id)?.remote.is_some() {
        return remote_service(&app, &registry, id, "stop", &name).await;
    }
    let record = local_session(&app, id)?;
    let tmux = family_tmux(&record).await?;
    let windows = tmux.list_windows().await?;
    if let Some(window) = service_window(&windows, &name).filter(|window| !window.is_dead) {
        tmux.stop_window(&window.id).await?;
    }
    emit_services_changed(&app, id);
    Ok(())
}

/// Runs `hunt-ctl service <action> <name>` on the running VM of the remote session `id`.
async fn remote_service(app: &AppHandle, registry: &SessionRegistry, id: Uuid, action: &str, name: &str) -> Result<(), String> {
    if !is_service_name(name) {
        return Err(format!("failed to {action} the service: {name:?} is no service name"));
    }
    let what = format!("{action} the service {name}");
    let target = running_remote(app, registry, id, &what).await?;
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    let result = remote::hunt_ctl(&ssh, &["service", action, name]).await.map_err(|error| format!("failed to {what}: {error}"));
    emit_services_changed(app, id);
    result.map(|_| ())
}

/// The tmux server of the family of the local session `record`.
async fn family_tmux(record: &SessionRecord) -> Result<LocalTmux, String> {
    LocalTmux::prepare(&record.worktree_path, record.parent_id.unwrap_or(record.id)).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServicesChangedEvent {
    session_id: Uuid,
}

/// Tells the main window, the one with the Terminal tab, that a service of the session `id` started or stopped.
fn emit_services_changed(app: &AppHandle, id: Uuid) {
    let _ = app.emit_to("main", "services:changed", ServicesChangedEvent { session_id: id });
}
