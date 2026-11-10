//! The commands of what shows a session's app: the session's Chrome on this Mac (`crate::agent::browser`), which the
//! agent of a local session drives, and the remote desktop of a session VM (`crate::remote::desktop`), both closed in
//! the background when the session's agent ends.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::running_remote;
use crate::agent::acp::SessionRegistry;
use crate::agent::app_pages::{self, AppPage};
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

/// The apps of the local session `id` that show a page now (see `crate::agent::app_pages`); none for a remote session,
/// whose pages the window reads from its preview (`preview_status`). "Browser" is enabled while there is one.
#[tauri::command]
pub async fn browser_pages(app: AppHandle, id: Uuid) -> Result<Vec<AppPage>, String> {
    let record = store::find_session(&app, id)?;
    if record.remote.is_some() {
        return Ok(Vec::new());
    }
    Ok(app_pages::running_pages(&record.worktree_path).await)
}

/// Opens the Chrome of the session `id` and brings it to the front (see `crate::agent::browser`).
#[tauri::command]
pub async fn browser_open(app: AppHandle, id: Uuid) -> Result<(), String> {
    open_browser(&app, id, true).await
}

/// Opens the Chrome of the session `id` with a copy of its repository's profile unless it runs; with `raises`, its
/// window comes to the front with a tab for each app of the session that shows a page and has none yet: at
/// `localhost` for a local session, at the preview URLs of its VM for a remote one, whose agent drives the Chromium on
/// the VM instead. The annotations of its review widget go to the windows as `review:annotation`, each with the
/// screenshot of its element (see `save_screenshot`) when Hunt could capture it. The command and the control socket
/// (`super::control`) use it.
pub async fn open_browser(app: &AppHandle, id: Uuid, raises: bool) -> Result<(), String> {
    let record = store::find_session(app, id).map_err(|error| format!("failed to open the browser: {error}"))?;
    let browser_dir = store::browser_dir(app)?;
    let emitter = app.clone();
    let on_annotation: AnnotationSink = std::sync::Arc::new(move |annotation, screenshot| match screenshot {
        Some(png) => {
            let emitter = emitter.clone();
            tauri::async_runtime::spawn(async move {
                let mut annotation = annotation;
                match save_screenshot(&emitter, id, &annotation.id, &png).await {
                    Ok(path) => annotation.screenshot_path = Some(path.to_string_lossy().into_owned()),
                    Err(error) => eprintln!("{error}"),
                }
                relay_watch::emit_annotation(&emitter, id, annotation);
            });
        }
        None => relay_watch::emit_annotation(&emitter, id, annotation),
    });
    let pages = if !raises {
        Vec::new()
    } else if record.remote.is_some() {
        let status = super::remote::preview_status(app.clone(), app.state::<SessionRegistry>(), id)
            .await
            .map_err(|error| format!("failed to open the browser: {error}"))?;
        app_pages::remote_pages(&status)
    } else {
        app_pages::running_pages(&record.worktree_path).await
    };
    let urls: Vec<String> = pages.into_iter().map(|page| page.url).collect();
    app.state::<BrowserRegistry>().open(id, &record.repo_path, &browser_dir, on_annotation, raises, &urls).await
}

/// Writes `png`, the screenshot of the element of the annotation `annotation_id` of the session `id`, to
/// `<app data>/annotations/<session id>/<annotation id>.png` and returns its path.
async fn save_screenshot(app: &AppHandle, id: Uuid, annotation_id: &str, png: &[u8]) -> Result<PathBuf, String> {
    let failed = |error: String| format!("failed to save the screenshot of annotation {annotation_id}: {error}");
    let dir = store::annotations_dir(app, id).map_err(failed)?;
    tokio::fs::create_dir_all(&dir).await.map_err(|error| failed(error.to_string()))?;
    let path = dir.join(format!("{annotation_id}.png"));
    tokio::fs::write(&path, png).await.map_err(|error| failed(error.to_string()))?;
    Ok(path)
}

/// Deletes the screenshots of the annotations of the session `id`; a failure is only logged.
pub fn delete_screenshots(app: &AppHandle, id: Uuid) {
    let removed = store::annotations_dir(app, id).and_then(|dir| match std::fs::remove_dir_all(&dir) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
        _ => Ok(()),
    });
    if let Err(error) = removed {
        eprintln!("deleting the annotation screenshots of session {id} failed: {error}");
    }
}

/// Closes the Chrome of the session `id` in the background, once its agent or the session ends; its profile replaces
/// the repository's.
pub fn close_browser(app: &AppHandle, id: Uuid) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { app.state::<BrowserRegistry>().close(id).await });
}
