//! Deleting session VMs through the gateway so that no failure leaves one behind. A deletion that failed (while the Mac
//! was offline, say) and the deletion of a VM whose session continued here without reaching it, which first saves what
//! the agent left on the VM into the local worktree, wait in `remote-cleanups.json` in the app data folder until they
//! succeed: they run again at each start of Hunt once the remote settings arrive (`set_remote_settings`), a saving one
//! also every `PRESERVE_RETRY` while Hunt runs. The sessions whose VM this run deleted are remembered, so that an
//! adoption leaves their VMs alone.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

use crate::remote::ssh::ssh_dir;
use crate::remote::{self, RemoteTarget, VmRef};
use crate::session::commands::{gateway_api, gateway_vm};
use crate::session::store;

/// A session VM whose deletion failed, e.g. while the Mac was offline; Hunt deletes it through the gateway at its next
/// start. Entries of older releases name the VM all sessions shared and are dropped.
#[derive(Clone, serde::Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PendingCleanup {
    vm: VmRef,
    hunt_session_id: Uuid,
    /// Set when the session continued here without reaching its VM: what the agent left there is saved first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preserve: Option<Preserve>,
}

/// Where the state a VM is deleted with goes first: the local worktree its snapshot is fetched into, from the session's
/// worktree on the VM.
#[derive(Clone, serde::Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Preserve {
    worktree: PathBuf,
    remote_worktree: String,
}

/// How often a cleanup that saves the VM's state first is tried again while Hunt runs.
const PRESERVE_RETRY: std::time::Duration = std::time::Duration::from_secs(60);

/// Serializes the changes to `remote-cleanups.json`.
static PENDING_CLEANUPS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// File of the pending cleanups in the app data folder.
const PENDING_CLEANUPS_FILE: &str = "remote-cleanups.json";

fn pending_cleanups_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(store::app_data_dir(app)?.join(PENDING_CLEANUPS_FILE))
}

fn read_pending_cleanups(path: &Path) -> Vec<PendingCleanup> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn write_pending_cleanups(path: &Path, cleanups: &[PendingCleanup]) -> Result<(), String> {
    let bytes = serde_json::to_vec(cleanups).map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

/// Applies `change` to the pending cleanups on disk.
fn change_pending_cleanups(app: &AppHandle, change: impl FnOnce(&mut Vec<PendingCleanup>)) {
    let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
    let changed = pending_cleanups_path(app).and_then(|path| {
        let mut cleanups = read_pending_cleanups(&path);
        change(&mut cleanups);
        write_pending_cleanups(&path, &cleanups)
    });
    if let Err(error) = changed {
        eprintln!("saving the pending remote cleanups failed: {error}");
    }
}

/// Points the local worktrees below `from` that the pending cleanups in `data_dir` save a VM's state into to the same
/// place below `to`, after the folder moved there.
pub fn relocate_pending_cleanups(data_dir: &Path, from: &Path, to: &Path) -> Result<(), String> {
    let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
    let path = data_dir.join(PENDING_CLEANUPS_FILE);
    let mut cleanups = read_pending_cleanups(&path);
    let mut changed = false;
    for preserve in cleanups.iter_mut().filter_map(|cleanup| cleanup.preserve.as_mut()) {
        let Ok(rest) = preserve.worktree.strip_prefix(from) else { continue };
        preserve.worktree = to.join(rest);
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    write_pending_cleanups(&path, &cleanups).map_err(|error| format!("failed to rewrite {PENDING_CLEANUPS_FILE}: {error}"))
}

/// Deletes the VM of session `id` on `target` once it can be reached, after saving what its agent left there into the
/// local `worktree` (`remote::retrieve::preserve`); until then it is tried every `PRESERVE_RETRY` and at each start of
/// Hunt.
pub(super) fn preserve_and_delete_vm(app: &AppHandle, target: &RemoteTarget, id: Uuid, worktree: &Path) {
    let preserve = Preserve { worktree: worktree.to_path_buf(), remote_worktree: target.worktree_path.display().to_string() };
    let cleanup = PendingCleanup { vm: target.vm.clone(), hunt_session_id: id, preserve: Some(preserve) };
    change_pending_cleanups(app, |cleanups| {
        if !cleanups.contains(&cleanup) {
            cleanups.push(cleanup.clone());
        }
    });
    DELETED_SESSION_VMS.lock().unwrap().push(id);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match run_cleanup(&cleanup).await {
                Ok(()) => {
                    change_pending_cleanups(&app, |pending| pending.retain(|other| *other != cleanup));
                    return;
                }
                Err(error) => eprintln!("saving and deleting the VM {} of session {id} failed, retrying: {error}", cleanup.vm.instance),
            }
            tokio::time::sleep(PRESERVE_RETRY).await;
            let is_pending = pending_cleanups_path(&app).is_ok_and(|path| {
                let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
                read_pending_cleanups(&path).contains(&cleanup)
            });
            if !is_pending {
                return;
            }
        }
    });
}

/// Deletes the VM of `cleanup` through the gateway, saving its state first when the cleanup asks for it; a VM that no
/// longer exists counts as done.
async fn run_cleanup(cleanup: &PendingCleanup) -> Result<(), String> {
    let id = cleanup.hunt_session_id;
    if let Some(preserve) = &cleanup.preserve {
        let gateway = gateway_vm("save the session's VM").await?;
        if let Some((ssh, _)) = remote::start_session_vm(&gateway, id, &cleanup.vm, &ssh_dir()?, &|_| {}).await? {
            let saved = remote::retrieve::preserve(&ssh, id, &preserve.worktree, &preserve.remote_worktree).await?;
            eprintln!("saved what session {id} left on its VM {} as {saved}", cleanup.vm.instance);
        }
    }
    gateway_api("delete the session's VM").await?.delete_vm(id).await
}

/// Sessions whose VM this run of Hunt asked the gateway to delete. The VM stays listed while it shuts down, and an
/// adoption in that time must not bring its session back.
static DELETED_SESSION_VMS: std::sync::Mutex<Vec<Uuid>> = std::sync::Mutex::new(Vec::new());

/// The sessions whose VM this Mac deleted in this run or still has to delete; adoptions leave their VMs alone.
pub(super) fn deleted_session_vms(app: &AppHandle) -> Vec<Uuid> {
    let mut ids = DELETED_SESSION_VMS.lock().unwrap().clone();
    if let Ok(path) = pending_cleanups_path(app) {
        let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
        ids.extend(read_pending_cleanups(&path).into_iter().map(|cleanup| cleanup.hunt_session_id));
    }
    ids
}

/// Deletes `vm`, the VM of session `id`, with its disks; a failed deletion is remembered for the next start of Hunt.
/// Failures are only logged: the local session must stay deletable. The VM an older handoff shared with other sessions
/// is never deleted.
pub(super) async fn delete_session_vm(app: &AppHandle, vm: &VmRef, id: Uuid) {
    if !remote::vm::is_session_vm(vm, id) {
        eprintln!("keeping the VM {} of session {id}: it is shared with other sessions", vm.instance);
        return;
    }
    DELETED_SESSION_VMS.lock().unwrap().push(id);
    let deleted = async { gateway_api("delete the session's VM").await?.delete_vm(id).await }.await;
    if let Err(error) = deleted {
        eprintln!("deleting the VM {} of session {id} failed, retrying at the next start: {error}", vm.instance);
        let cleanup = PendingCleanup { vm: vm.clone(), hunt_session_id: id, preserve: None };
        change_pending_cleanups(app, |cleanups| {
            if !cleanups.contains(&cleanup) {
                cleanups.push(cleanup);
            }
        });
    }
}

/// Deletes the session VMs whose deletion failed before through the gateway, in the background; `set_remote_settings`
/// runs it once per app run.
pub(super) fn run_pending_cleanups(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(path) = pending_cleanups_path(&app) else { return };
        let cleanups = {
            let _guard = PENDING_CLEANUPS_LOCK.lock().unwrap();
            read_pending_cleanups(&path)
        };
        if cleanups.is_empty() {
            return;
        }
        let gateway = match gateway_api("delete the session VMs left over").await {
            Ok(gateway) => gateway,
            Err(error) => {
                eprintln!("deleting the session VMs left over failed, retrying at the next start: {error}");
                return;
            }
        };
        for cleanup in cleanups {
            let id = cleanup.hunt_session_id;
            let is_done = if !remote::vm::is_session_vm(&cleanup.vm, id) {
                eprintln!("dropping the cleanup of session {id} on the shared VM {}", cleanup.vm.instance);
                true
            } else if cleanup.preserve.is_some() {
                match run_cleanup(&cleanup).await {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("saving and deleting the VM {} of session {id} failed again, retrying at the next start: {error}", cleanup.vm.instance);
                        false
                    }
                }
            } else {
                match gateway.delete_vm(id).await {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("deleting the VM {} of session {id} failed again, retrying at the next start: {error}", cleanup.vm.instance);
                        false
                    }
                }
            };
            if is_done {
                change_pending_cleanups(&app, |pending| pending.retain(|other| *other != cleanup));
            }
        }
    });
}
