//! The steps a handoff, a retrieval or a connect reports while it runs, and `StartSteps`, which hears those of a VM's
//! start through the gateway.

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use super::ssh;

/// A step of a handoff, a retrieval or a connect that takes long enough to show in the UI; the gateway API streams the
/// steps of the VM's start and setup under the same names.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteStep {
    /// The gateway boots the stopped VM.
    StartingVm,
    /// The gateway wakes the suspended VM.
    ResumingVm,
    /// The gateway recreates the stopped VM in another zone, since its own has no capacity for its start.
    MovingVm,
    CreatingVm,
    WaitingForVm,
    /// The VM answers over SSH and its startup script is done, while the gateway still checks its release and pushes the
    /// secrets: a signal for `StartSteps`, which opens Hunt's own connection meanwhile; the UI never sees it.
    VmReady,
    Connecting,
    InstallingRuntime,
    TransferringCode,
    InstallingDependencies,
    StartingAgent,
    /// A connect attaches to the session's relay, which keeps an agent that runs as it is.
    ConnectingAgent,
    StoppingAgent,
    RetrievingCode,
    /// A step of a newer gateway, which the UI is never told.
    #[serde(other)]
    Unknown,
}

/// Hears what a running remote operation does: its steps, and the gateway's log lines about the current one. A closure
/// over `RemoteStep` hears only the steps.
pub trait Reporter: Send + Sync {
    fn step(&self, step: RemoteStep);
    /// A line about what the current step does or why it still waits; the next step replaces it.
    fn log(&self, _message: &str) {}
}

impl<F: Fn(RemoteStep) + Send + Sync> Reporter for F {
    fn step(&self, step: RemoteStep) {
        self(step);
    }
}

/// Receives the steps of a running remote operation.
pub type Progress<'a> = &'a dyn Reporter;

/// Hears the steps of a gateway call that starts a VM on behalf of the UI's reporter `ui`: every step but `VmReady`,
/// and every log line. `VmReady`, the gateway's signal that the VM answers over SSH while the gateway still checks its
/// release and pushes the secrets, instead opens the shared SSH connection to `vm` in the background, so that the first
/// command after the call finds its control master up; without a `vm` the signal is dropped. `join` waits for that
/// connection; a `StartSteps` dropped before it stops the attempt.
pub struct StartSteps<'a> {
    ui: Progress<'a>,
    vm: Mutex<Option<ssh::Ssh>>,
    warm_up: OnceLock<JoinHandle<Result<(), String>>>,
}

impl<'a> StartSteps<'a> {
    pub fn new(ui: Progress<'a>, vm: Option<ssh::Ssh>) -> Self {
        StartSteps { ui, vm: Mutex::new(vm), warm_up: OnceLock::new() }
    }

    /// Waits for the connection `VmReady` opened, if any. A failure only means the next command opens the connection
    /// itself, such as when the gateway moved the VM to another zone than the one it was known in.
    pub async fn join(mut self) {
        let Some(warm_up) = self.warm_up.take() else { return };
        if let Err(error) = warm_up.await.unwrap_or_else(|error| Err(error.to_string())) {
            eprintln!("opening the connection to the VM early failed, the next command opens it: {error}");
        }
    }
}

impl Reporter for StartSteps<'_> {
    fn step(&self, step: RemoteStep) {
        if step != RemoteStep::VmReady {
            self.ui.step(step);
            return;
        }
        let Some(ssh) = self.vm.lock().unwrap().take() else { return };
        let _ = self.warm_up.set(tokio::spawn(async move { ssh.warm_up().await }));
    }

    fn log(&self, message: &str) {
        self.ui.log(message);
    }
}

impl Drop for StartSteps<'_> {
    fn drop(&mut self) {
        if let Some(warm_up) = self.warm_up.take() {
            warm_up.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_step_reads_the_gateways_steps_and_takes_unknown_ones_as_unknown() {
        let gateway_steps = r#"["creatingVm","startingVm","resumingVm","movingVm","waitingForVm","vmReady","installingRuntime","resizingDisk"]"#;
        let steps: Vec<RemoteStep> = serde_json::from_str(gateway_steps).unwrap();
        let known = [RemoteStep::CreatingVm, RemoteStep::StartingVm, RemoteStep::ResumingVm, RemoteStep::MovingVm, RemoteStep::WaitingForVm];
        assert_eq!(steps[..5], known);
        assert_eq!(steps[5..], [RemoteStep::VmReady, RemoteStep::InstallingRuntime, RemoteStep::Unknown]);
    }

    /// Records the steps and log lines it hears, in order.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);

    impl Reporter for Recorder {
        fn step(&self, step: RemoteStep) {
            self.0.lock().unwrap().push(format!("{step:?}"));
        }

        fn log(&self, message: &str) {
            self.0.lock().unwrap().push(format!("log: {message}"));
        }
    }

    #[tokio::test]
    async fn start_steps_keep_vm_ready_from_the_ui_and_pass_the_rest_on() {
        let recorder = Recorder::default();
        let steps = StartSteps::new(&recorder, None);
        steps.step(RemoteStep::StartingVm);
        steps.log("waiting for vm-hunt-s-ab12cd34 to finish shutting down");
        steps.step(RemoteStep::WaitingForVm);
        steps.step(RemoteStep::VmReady);
        steps.step(RemoteStep::VmReady);
        steps.step(RemoteStep::InstallingRuntime);
        steps.join().await;
        assert_eq!(
            recorder.0.into_inner().unwrap(),
            ["StartingVm", "log: waiting for vm-hunt-s-ab12cd34 to finish shutting down", "WaitingForVm", "InstallingRuntime"]
        );
    }
}
