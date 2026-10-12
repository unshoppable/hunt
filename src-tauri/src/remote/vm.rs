//! The power state of the VM: Hunt starts it when a remote session needs it; the VM shuts itself down when idle.

use std::time::{Duration, Instant};

use super::ssh::Ssh;
use super::{gcloud, Progress, RemoteStep, VmRef};

/// How long a start (VM boot plus SSH) may take before Hunt gives up.
const START_TIMEOUT: Duration = Duration::from_secs(6 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// The VM's status as Compute Engine reports it, e.g. `RUNNING`, `TERMINATED` or `STOPPING`.
pub async fn status(vm: &VmRef) -> Result<String, String> {
    let zone = format!("--zone={}", vm.zone);
    let project = format!("--project={}", vm.project);
    let output = gcloud(&["compute", "instances", "describe", &vm.instance, &zone, &project, "--format=value(status)"]).await?;
    Ok(output.trim().to_string())
}

/// Starts the VM unless it runs (waiting out a shutdown in progress) and waits until SSH answers. `progress` hears
/// `StartingVm` only when the VM was not running.
pub async fn ensure_running(vm: &VmRef, ssh: &Ssh, progress: Progress<'_>) -> Result<(), String> {
    let deadline = Instant::now() + START_TIMEOUT;
    let mut is_starting = false;
    loop {
        let status = status(vm).await?;
        match status.as_str() {
            "RUNNING" => break,
            "TERMINATED" | "STOPPED" | "SUSPENDED" if !is_starting => {
                progress(RemoteStep::StartingVm);
                let verb = if status == "SUSPENDED" { "resume" } else { "start" };
                let zone = format!("--zone={}", vm.zone);
                let project = format!("--project={}", vm.project);
                // `--async` returns at once; waiting through gcloud would need permissions on zone operations.
                gcloud(&["compute", "instances", verb, &vm.instance, &zone, &project, "--async"]).await?;
                is_starting = true;
            }
            _ => {}
        }
        if Instant::now() > deadline {
            return Err(format!("failed to start the VM {}: it is still {status}", vm.instance));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    loop {
        match ssh.run("true").await {
            Ok(_) => return Ok(()),
            Err(error) if Instant::now() > deadline => return Err(format!("failed to reach the VM {} over SSH: {error}", vm.instance)),
            Err(_) => tokio::time::sleep(POLL_INTERVAL).await,
        }
    }
}
