//! `hunt vm start|stop|ssh`: the VM of a remote session through the gateway of its project, as Hunt reaches it (gcloud
//! login, IAP tunnel and Hunt's SSH key in `~/.ssh/hunt`).

use std::os::unix::process::CommandExt;

use uuid::Uuid;

use super::{RemoteSession, StderrProgress};
use crate::remote::api::GatewayApi;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::terminal::{attach_args, open_shell_window};
use crate::remote::{gateway_vm, hunt_ctl, start_session_vm, RemoteTarget, VmRef, VmSettings};
use crate::terminal::interactive::TerminalTarget;
use crate::terminal::tmux::Machine;

/// Starts the VM of `session` unless it runs.
pub async fn start(session: &RemoteSession) -> Result<(), String> {
    let (_, target) = start_vm(session).await?;
    eprintln!("the VM {} of session {} runs", target.vm.instance, session.short_id());
    Ok(())
}

/// Stops the VM of `session` unless it is off; refuses while its agent works, unless `force`.
pub async fn stop(session: &RemoteSession, force: bool) -> Result<(), String> {
    let instance = &session.target.vm.instance;
    let api = GatewayApi::open(&gateway_of(&session.target).await?, &ssh_dir()?).await?;
    if !api.is_vm_running(session.record.id).await? {
        eprintln!("the VM {instance} of session {} is not running", session.short_id());
        return Ok(());
    }
    if !force {
        let ssh = Ssh::open(&session.target.vm, &ssh_dir()?).await?;
        let status = hunt_ctl(&ssh, &["status", &session.record.id.to_string()])
            .await
            .map_err(|error| format!("failed to ask the VM whether its agent works ({error}); stop it anyway with --force"))?;
        if is_turn_running(&status) {
            return Err(format!("the agent of session {} is working; wait for its turn to end or stop the VM with --force", session.short_id()));
        }
    }
    api.stop_vm(session.record.id).await?;
    eprintln!("the VM {instance} of session {} stops", session.short_id());
    Ok(())
}

/// Opens a shell on the VM of `session`, started unless it runs: a new window `shell` (or `shell-<n>`) of the tmux
/// session `app`, which Hunt's Terminal tab shows too, in a view of its own that ends with the terminal. Replaces this
/// process with `ssh`, which takes over the terminal; returns only when `ssh` cannot run.
pub async fn shell(session: &RemoteSession) -> Result<(), String> {
    let (ssh, target) = start_vm(session).await?;
    let window = open_shell_window(&ssh).await?;
    let args = attach_args(&target, &TerminalTarget::Window { id: window, machine: Machine::Vm }, Uuid::new_v4(), &ssh_dir()?).await?;
    let error = std::process::Command::new("ssh").args(&args).exec();
    Err(format!("failed to run ssh: {error}"))
}

/// Brings up the VM of `session`, which the gateway starts when it is off; returns the connection to it and the
/// session's target with the VM as the gateway reports it, which lies in another zone than the stored one when the
/// gateway had to move it. Hunt stores that zone with its next connect; the command line never writes the sessions.
pub async fn start_vm(session: &RemoteSession) -> Result<(Ssh, RemoteTarget), String> {
    let gateway = gateway_of(&session.target).await?;
    let started = start_session_vm(&gateway, session.record.id, &session.target.vm, &ssh_dir()?, &StderrProgress).await?;
    let Some((ssh, vm)) = started else {
        return Err(format!("the VM {} of session {} no longer exists; open the session in Hunt", session.target.vm.instance, session.short_id()));
    };
    Ok((ssh, RemoteTarget { vm, ..session.target.clone() }))
}

/// The gateway of the project the session's VM lives in: the gateway creates every session VM in its own project
/// (`VmRef::session_vm`), so the session names it without Hunt's settings.
async fn gateway_of(target: &RemoteTarget) -> Result<VmRef, String> {
    let settings = VmSettings { project: target.vm.project.clone(), machine_type: None };
    settings.validate()?;
    gateway_vm(&settings).await
}

/// Whether the `hunt-ctl status` output `status` reports a turn of the agent that runs.
fn is_turn_running(status: &serde_json::Value) -> bool {
    status["status"]["turn"].as_str() == Some("running")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_running_turn_holds_the_vm() {
        assert!(is_turn_running(&serde_json::json!({ "relay": "running", "status": { "turn": "running" } })));
        assert!(!is_turn_running(&serde_json::json!({ "relay": "running", "status": { "turn": "idle" } })));
        assert!(!is_turn_running(&serde_json::json!({ "relay": "stopped", "status": {} })));
        assert!(!is_turn_running(&serde_json::Value::Null));
    }
}
