//! The commands of the Factory tab: the pipeline record of a software-factory session, the results of its steps and the
//! transcripts of their conversations, read from `.hunt/swf/` of its local worktree (`session::swf`), which the pulls of
//! the session keep up to date.

use tauri::AppHandle;
use uuid::Uuid;

use super::{gateway_api, remote_host};
use crate::agent::plan_usage::{self, PlanUsage};
use crate::remote::api::VmUsage;
use crate::remote::hunt_ctl;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::session::store;
use crate::session::swf::{self, SwfPipelineFiles};

/// The pipeline record of the session `session_id` as its local worktree holds it, with the list of its step result
/// files; `None` while the worktree has none, or the session has no local worktree yet. A `pipeline.json` that is not
/// JSON is an error.
#[tauri::command]
pub async fn read_swf_pipeline(app: AppHandle, session_id: Uuid) -> Result<Option<SwfPipelineFiles>, String> {
    let record = store::find_session(&app, session_id)?;
    if !record.worktree_path.is_dir() {
        return Ok(None);
    }
    swf::read_pipeline(&record.worktree_path)
}

/// The body of the step result the run `n` of the session `session_id` ended with (`steps/<nn>-<step>.md`); `None`
/// without one, or without a local worktree.
#[tauri::command]
pub async fn read_swf_step(app: AppHandle, session_id: Uuid, n: u32) -> Result<Option<String>, String> {
    let record = store::find_session(&app, session_id)?;
    if !record.worktree_path.is_dir() {
        return Ok(None);
    }
    swf::read_step(&record.worktree_path, n)
}

/// The transcript of the conversation of the run `n` of the session `session_id` (`transcripts/<nn>-<step>.jsonl`), as
/// JSON lines; `None` without one, or without a local worktree.
#[tauri::command]
pub async fn read_swf_transcript(app: AppHandle, session_id: Uuid, n: u32) -> Result<Option<String>, String> {
    let record = store::find_session(&app, session_id)?;
    if !record.worktree_path.is_dir() {
        return Ok(None);
    }
    swf::read_transcript(&record.worktree_path, n)
}

/// The claude.ai plan limits of the Claude account the session `session_id` runs with on its VM, read there by
/// `hunt-ctl plan-usage`: a poller session runs with the poller's account, not with the one picked on this Mac. `None`
/// for a session without a VM. Fails while the VM is off.
#[tauri::command]
pub async fn read_session_plan_usage(app: AppHandle, session_id: Uuid) -> Result<Option<PlanUsage>, String> {
    let record = store::find_session(&app, session_id)?;
    let Some((owner, target)) = remote_host(&app, &record) else {
        return Ok(None);
    };
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    let output = hunt_ctl(&ssh, &["plan-usage", &owner.to_string()]).await?;
    plan_usage::parse_output(&output.to_string()).map(Some)
}

/// How long the VM of the session `session_id` ran and its machine type, from the gateway (`vms.usage`), for the
/// estimate of its cost; `None` for a session without a VM. Works while the VM is off.
#[tauri::command]
pub async fn read_session_vm_usage(app: AppHandle, session_id: Uuid) -> Result<Option<VmUsage>, String> {
    let record = store::find_session(&app, session_id)?;
    let Some((owner, _)) = remote_host(&app, &record) else {
        return Ok(None);
    };
    gateway_api("read the session VM's running time").await?.vm_usage(owner).await.map(Some)
}
