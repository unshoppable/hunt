//! The commands of what shows a session's app: the session's Chrome on this Mac (`crate::agent::browser`), which the
//! agent of a local session drives, and the remote desktop of a session VM (`crate::remote::desktop`), both closed in
//! the background when the session's agent ends.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::running_remote;
use crate::agent::acp::SessionRegistry;
use crate::agent::app_pages::{self, AppPage};
use crate::agent::browser::{AnnotationSink, BrowserRegistry, ReviewHooks, ReviewSession, ReviewSessions};
use crate::remote::desktop::{DesktopEndpoint, DesktopRegistry};
use crate::remote::ssh::ssh_dir;
use crate::session::relay_watch::{self, AnnotationEvent};
use crate::session::store::{self, SessionRecord};

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
/// the VM instead. Its review widget lists the main session of the worktree and its sub sessions (`review_sessions`);
/// its annotations go to the windows as `review:annotation` for the session the widget names (`ReviewSessions::target`),
/// each with the screenshot of its element (see `save_screenshot`) when Hunt could capture it. The command and the
/// control socket (`super::control`) use it.
pub async fn open_browser(app: &AppHandle, id: Uuid, raises: bool) -> Result<(), String> {
    let record = store::find_session(app, id).map_err(|error| format!("failed to open the browser: {error}"))?;
    let browser_dir = store::browser_dir(app)?;
    let lister = app.clone();
    let sessions = std::sync::Arc::new(move || {
        let records = store::load_sessions(&lister).unwrap_or_else(|error| {
            eprintln!("failed to list the sessions of the browser of session {id}: {error}");
            Vec::new()
        });
        review_sessions(&records, id)
    });
    let emitter = app.clone();
    let targets = sessions.clone();
    let on_annotation: AnnotationSink = std::sync::Arc::new(move |mut annotation, screenshot, delivery| {
        let (hunt_session_id, creates_sub_session) = targets().target(&delivery);
        let emitter = emitter.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(png) = screenshot {
                match save_screenshot(&emitter, hunt_session_id, &annotation.id, &png).await {
                    Ok(path) => annotation.screenshot_path = Some(path.to_string_lossy().into_owned()),
                    Err(error) => eprintln!("{error}"),
                }
            }
            relay_watch::emit_annotation(&emitter, AnnotationEvent { hunt_session_id, annotation, sends: delivery.sends, creates_sub_session });
        });
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
    app.state::<BrowserRegistry>().open(id, &record.repo_path, &browser_dir, ReviewHooks { on_annotation, sessions }, raises, &urls).await
}

/// The sessions among `records` an annotation of the Chrome of the session `id` can go to: the main session of its
/// worktree, then that session's sub sessions in the order they are listed.
fn review_sessions(records: &[SessionRecord], id: Uuid) -> ReviewSessions {
    let main_id = records.iter().find(|record| record.id == id).and_then(|record| record.parent_id).unwrap_or(id);
    let listed = |record: &&SessionRecord| record.id == main_id || record.parent_id == Some(main_id);
    let mut sessions: Vec<ReviewSession> =
        records.iter().filter(listed).map(|record| ReviewSession { id: record.id, title: record.title.clone(), is_sub: record.parent_id.is_some() }).collect();
    sessions.sort_by_key(|session| session.is_sub);
    ReviewSessions { sessions, own: id }
}

/// Writes `png`, the screenshot of the element of the annotation `annotation_id` for the session `id`, to
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(title: &str) -> SessionRecord {
        SessionRecord::new(Uuid::new_v4(), title.into(), "/repo".into(), "/repo/wt".into(), "feat/cart".into(), "main".into(), "abc".into())
    }

    #[test]
    fn the_review_sessions_of_a_chrome_are_the_main_session_of_its_worktree_and_that_sessions_sub_sessions() {
        let main = record("Cart");
        let first_sub = SessionRecord::sub_session(Uuid::new_v4(), "Tests".into(), &main, None);
        let other = record("Elsewhere");
        let other_sub = SessionRecord::sub_session(Uuid::new_v4(), "Docs".into(), &other, None);
        let second_sub = SessionRecord::sub_session(Uuid::new_v4(), "Styles".into(), &first_sub, None);
        let records = [first_sub.clone(), other, main.clone(), other_sub, second_sub.clone()];

        let listed = |id: Uuid, title: &str, is_sub: bool| ReviewSession { id, title: title.into(), is_sub };
        let sessions = vec![listed(main.id, "Cart", false), listed(first_sub.id, "Tests", true), listed(second_sub.id, "Styles", true)];
        assert_eq!(review_sessions(&records, main.id), ReviewSessions { sessions: sessions.clone(), own: main.id });
        assert_eq!(review_sessions(&records, second_sub.id), ReviewSessions { sessions, own: second_sub.id });
        let unknown = Uuid::new_v4();
        assert_eq!(review_sessions(&records, unknown), ReviewSessions { sessions: Vec::new(), own: unknown });
    }
}
