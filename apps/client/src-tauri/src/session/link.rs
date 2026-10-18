//! Whether the local worktree of a remote session may change, so that only one side writes while the two cannot sync:
//! while the sync channel is open, or the agent of the VM is connected and it opens again (`live`), both sides write and
//! every change reaches the other within a moment; while the
//! gateway says the session's VM is off (`vmStopped`) nobody writes there, so the local side may, and the next sync sends
//! it. Otherwise the worktree is `locked`: the VM runs without a channel (`vmRunning`), or neither it nor the gateway can
//! be reached (`unreachable`), and its agent may write there. Hunt then refuses its own writes to the worktree
//! (`ensure_writable`); editors outside Hunt are not held back. A locked session is checked again every `RECHECK` until
//! it is not; every change reaches the windows as `remote:link`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::session::store;

/// How often a locked session's VM is asked for again.
const RECHECK: Duration = Duration::from_secs(15);

/// Why a remote session's worktree may or may not change here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "reason")]
pub enum Link {
    Live,
    VmStopped,
    Locked(LockReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockReason {
    VmRunning,
    Unreachable,
}

/// The link of every remote session that has one, and the sessions a recheck runs for.
#[derive(Default)]
pub struct LinkRegistry {
    links: Mutex<HashMap<Uuid, Link>>,
    rechecks: Mutex<HashMap<Uuid, tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkEvent {
    hunt_session_id: Uuid,
    link: Link,
}

/// Records `link` for the remote session `id` and tells the windows when it changed; a locked session gets checked again
/// until it is not.
pub fn set(app: &AppHandle, id: Uuid, link: Link) {
    let registry = app.state::<LinkRegistry>();
    let previous = registry.links.lock().unwrap().insert(id, link);
    if previous != Some(link) {
        let _ = app.emit("remote:link", LinkEvent { hunt_session_id: id, link });
    }
    if matches!(link, Link::Locked(_)) {
        recheck(app, id);
    } else if let Some(task) = registry.rechecks.lock().unwrap().remove(&id) {
        task.abort();
    }
}

/// The link of the remote session `id`, asking the gateway when none is known yet; `None` for a local session.
pub async fn current(app: &AppHandle, id: Uuid) -> Option<Link> {
    let owner = owner_of(app, id);
    store::find_session(app, owner).ok()?.remote.as_ref()?;
    if let Some(link) = app.state::<LinkRegistry>().links.lock().unwrap().get(&owner).copied() {
        return Some(link);
    }
    Some(check(app, owner).await)
}

/// Asks the gateway whether the VM of the remote session `id` runs and records the link that follows. A session whose
/// agent is connected counts as live: its syncs run, and the channel is about to open again.
pub async fn check(app: &AppHandle, id: Uuid) -> Link {
    let link = match crate::session::commands::gateway_api("check the session's VM").await {
        Ok(api) => match api.is_vm_running(id).await {
            Ok(true) => Link::Locked(LockReason::VmRunning),
            Ok(false) => Link::VmStopped,
            Err(_) => Link::Locked(LockReason::Unreachable),
        },
        Err(_) => Link::Locked(LockReason::Unreachable),
    };
    let link = if crate::session::sync::is_syncing(app, id) { Link::Live } else { link };
    set(app, id, link);
    link
}

/// Checks the link of `id` in the background, as after its sync channel ended.
pub fn check_later(app: &AppHandle, id: Uuid) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        check(&app, id).await;
    });
}

/// Fails with `what` (the action) while the worktree of `id`, or of the remote session whose sub chat `id` is, is
/// locked; a local session and an unknown link pass.
pub fn ensure_writable(app: &AppHandle, id: Uuid, what: &str) -> Result<(), String> {
    let owner = owner_of(app, id);
    match app.state::<LinkRegistry>().links.lock().unwrap().get(&owner) {
        Some(Link::Locked(LockReason::VmRunning)) => {
            Err(format!("failed to {what}: the agent may be working on the VM, which is not connected; connect the session first"))
        }
        Some(Link::Locked(LockReason::Unreachable)) => {
            Err(format!("failed to {what}: the session's VM cannot be reached; wait for the connection or continue locally"))
        }
        _ => Ok(()),
    }
}

/// Forgets the link of `id`, which runs locally now.
pub fn forget(app: &AppHandle, id: Uuid) {
    let registry = app.state::<LinkRegistry>();
    registry.links.lock().unwrap().remove(&id);
    if let Some(task) = registry.rechecks.lock().unwrap().remove(&id) {
        task.abort();
    }
}

/// Checks the locked session `id` every `RECHECK` until its link changes; one task per session.
fn recheck(app: &AppHandle, id: Uuid) {
    let registry = app.state::<LinkRegistry>();
    let mut rechecks = registry.rechecks.lock().unwrap();
    if rechecks.contains_key(&id) {
        return;
    }
    let app = app.clone();
    rechecks.insert(
        id,
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(RECHECK).await;
                let is_remote = store::find_session(&app, id).is_ok_and(|record| record.remote.is_some());
                if !is_remote {
                    forget(&app, id);
                    return;
                }
                if !matches!(check(&app, id).await, Link::Locked(_)) {
                    return;
                }
            }
        }),
    );
}

/// The session whose VM `id` works on: its parent for a sub chat, else `id` itself.
fn owner_of(app: &AppHandle, id: Uuid) -> Uuid {
    store::find_session(app, id).ok().and_then(|record| record.parent_id).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_serializes_with_its_reason() {
        assert_eq!(serde_json::to_value(Link::Live).unwrap(), serde_json::json!({ "state": "live" }));
        assert_eq!(serde_json::to_value(Link::VmStopped).unwrap(), serde_json::json!({ "state": "vmStopped" }));
        assert_eq!(
            serde_json::to_value(Link::Locked(LockReason::Unreachable)).unwrap(),
            serde_json::json!({ "state": "locked", "reason": "unreachable" })
        );
    }
}
