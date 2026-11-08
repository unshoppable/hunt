//! The commands of the Factory tab: the pipeline record of a software-factory session, the results of its steps and the
//! transcripts of their conversations, read from `.hunt/swf/` of its local worktree (`session::swf`), which the pulls of
//! the session keep up to date.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use super::{gateway_api, remote_host};
use crate::agent::plan_usage::{self, PlanUsage};
use crate::remote::api::{VmInfo, VmUsage};
use crate::remote::hunt_ctl;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::RemoteTarget;
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

/// Reads the report of the VM's idle check; a VM that has not run the check since it booted has none.
const IDLE_REPORT_COMMAND: &str = "sudo -n cat /run/hunt/idle-report.json 2>/dev/null || true";

/// The report of the last run of the idle check on a session VM (`apps/session/vm/hunt-idle-check`, which the VM runs
/// every minute): when it ran (Unix seconds), its decision (`keep: …`, `wait: …`, `idle: …` or `poweroff: …`), the
/// seconds since anything kept the VM up, the estimated seconds until the gateway suspends it, and the check's
/// IDLE_MINUTES and IDLE_CHECKS.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VmIdle {
    pub at: u64,
    pub decision: String,
    pub idle_seconds: u64,
    pub suspend_in_seconds: u64,
    pub idle_minutes: u64,
    pub idle_checks: u64,
}

/// A session's VM for the Factory tab's VM card: the gateway's `VmInfo` and, while the VM runs, the report of its idle
/// check; `idle_note` says why the report could not be read.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionVmState {
    pub info: VmInfo,
    pub idle: Option<VmIdle>,
    pub idle_note: Option<String>,
}

/// The VM of the session `session_id` as the gateway reports it and, while it runs, the report of its idle check;
/// `None` for a session without a VM. Works while the VM is off, with no report then.
#[tauri::command]
pub async fn read_session_vm_state(app: AppHandle, session_id: Uuid) -> Result<Option<SessionVmState>, String> {
    let record = store::find_session(&app, session_id)?;
    let Some((owner, target)) = remote_host(&app, &record) else {
        return Ok(None);
    };
    let info = gateway_api("read the session's VM").await?.vm_info(owner).await?;
    if !(info.exists && info.status.as_deref() == Some("RUNNING")) {
        return Ok(Some(SessionVmState { info, idle: None, idle_note: None }));
    }
    let (idle, idle_note) = match read_idle_report(&target).await {
        Ok(idle) => (idle, None),
        Err(note) => (None, Some(note)),
    };
    Ok(Some(SessionVmState { info, idle, idle_note }))
}

async fn read_idle_report(target: &RemoteTarget) -> Result<Option<VmIdle>, String> {
    let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
    let output = ssh.run(IDLE_REPORT_COMMAND).await?;
    parse_idle_report(&output)
}

/// The report as `IDLE_REPORT_COMMAND` prints it; `None` for an empty output (no report yet).
fn parse_idle_report(output: &str) -> Result<Option<VmIdle>, String> {
    let output = output.trim();
    if output.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(output).map(Some).map_err(|error| format!("failed to read the idle report of the VM: {error}: {output}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_idle_report_and_none_without_one() {
        let report = parse_idle_report(
            "{\"at\":1800000000,\"decision\":\"wait: nothing keeps the VM up, 4 of 15 checks in a row found nothing\",\"idleSeconds\":2100,\"suspendInSeconds\":660,\"idleMinutes\":30,\"idleChecks\":15}\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!((report.at, report.idle_seconds, report.suspend_in_seconds, report.idle_minutes, report.idle_checks), (1800000000, 2100, 660, 30, 15));
        assert!(report.decision.starts_with("wait:"));
        assert_eq!(parse_idle_report("\n").unwrap(), None);
        assert!(parse_idle_report("not json").unwrap_err().starts_with("failed to read the idle report of the VM"));
    }
}
