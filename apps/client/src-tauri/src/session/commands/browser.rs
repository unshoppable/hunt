//! The commands of what shows a session's app: the Chrome of a local session (`crate::agent::browser`) and the remote
//! desktop of a session VM (`crate::remote::desktop`), both closed in the background when the session's agent ends.

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::running_remote;
use crate::agent::acp::SessionRegistry;
use crate::agent::browser::{AnnotationSink, BrowserRegistry};
use crate::remote::desktop::{DesktopEndpoint, DesktopRegistry};
use crate::remote::ssh::ssh_dir;
use crate::session::relay_watch;
use crate::session::store;

/// The remote desktop of the session `id`: the base URL (`http://127.0.0.1:<port>`) of a forward from this Mac to its
/// VM's desktop proxy, opened once and kept for the session (see `remote::desktop`). A VM that is off is an error and
/// stays off.
#[tauri::command]
pub async fn desktop_open(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    desktops: State<'_, DesktopRegistry>,
    id: Uuid,
) -> Result<DesktopEndpoint, String> {
    let running_vm = || async { Ok(running_remote(&app, &registry, id, "open the remote desktop").await?.vm) };
    desktops.open(id, &ssh_dir()?, running_vm).await
}

/// Cancels the desktop forward of the session `id` in the background, once its agent or the session ends.
pub fn close_desktop(app: &AppHandle, id: Uuid) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { app.state::<DesktopRegistry>().close(id).await });
}

/// Opens the Chrome of the local session `id` and brings it to the front (see `crate::agent::browser`).
#[tauri::command]
pub async fn browser_open(app: AppHandle, id: Uuid) -> Result<(), String> {
    open_browser(&app, id, true).await
}

/// Opens the Chrome of the local session `id` with a copy of its repository's profile unless it runs; with `raises`, its
/// window comes to the front. The annotations of its review widget go to the windows as `review:annotation`. The command
/// and the control socket (`super::control`) use it; a remote session has its Chromium on its VM.
pub async fn open_browser(app: &AppHandle, id: Uuid, raises: bool) -> Result<(), String> {
    let record = store::find_session(app, id).map_err(|error| format!("failed to open the browser: {error}"))?;
    if record.remote.is_some() {
        return Err("failed to open the browser: the session runs on a VM".into());
    }
    let browser_dir = store::browser_dir(app)?;
    let emitter = app.clone();
    let on_annotation: AnnotationSink = std::sync::Arc::new(move |annotation| relay_watch::emit_annotation(&emitter, id, annotation));
    app.state::<BrowserRegistry>().open(id, &record.repo_path, &browser_dir, on_annotation, raises).await
}

/// Closes the Chrome of the session `id` in the background, once its agent or the session ends; its profile replaces
/// the repository's.
pub fn close_browser(app: &AppHandle, id: Uuid) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { app.state::<BrowserRegistry>().close(id).await });
}
