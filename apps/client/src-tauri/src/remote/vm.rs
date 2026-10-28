//! Compute Engine VMs: the reference to one, the VMs of sessions and the connection to a session's VM. The gateway
//! creates one VM per session, named after the session's ID (`SessionId::vm_name`), starts it when the session needs it
//! and deletes it with the session; the VM shuts itself down when idle.

use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::progress::{Progress, StartSteps};
use super::{api, release, ssh};
use crate::session::session_id::SessionId;

/// A Compute Engine VM: the VM of one remote session, or the gateway that routes previews to them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct VmRef {
    pub project: String,
    pub zone: String,
    pub instance: String,
}

impl VmRef {
    /// Rejects empty fields and characters that Compute Engine names never contain, so the values can go into the ssh
    /// ProxyCommand unquoted.
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [("project", &self.project), ("zone", &self.zone), ("instance", &self.instance)] {
            if !is_compute_name(value) {
                return Err(format!("failed to use the remote VM: the {name} {value:?} is not a valid Compute Engine name"));
            }
        }
        Ok(())
    }

    /// The VM of session `id` as the gateway `self` names it, in the gateway's project and zone.
    pub fn session_vm(&self, id: Uuid) -> VmRef {
        VmRef { project: self.project.clone(), zone: self.zone.clone(), instance: SessionId(id).vm_name() }
    }
}

/// Whether `value` is a Compute Engine name: lowercase letters, digits and `-`, not empty.
pub fn is_compute_name(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

/// Whether `vm` is the VM of session `id`, which deleting the session may delete.
pub fn is_session_vm(vm: &VmRef, id: Uuid) -> bool {
    vm.instance == SessionId(id).vm_name()
}

/// Connects to the VM of session `id`, stored as `known`, once it can run the agent (see `release::ensure_ready`);
/// Hunt's SSH key lives in `ssh_dir`. A VM the gateway reports as running is reached directly: the gateway's start
/// also waits for the VM's boot and checks its release over `gcloud compute ssh`, which takes seconds a running VM
/// does not need. A VM that is off, or that does not answer under its stored name and zone, is started through
/// `gateway`, which boots it and installs the staged release; Hunt's own connection to the VM opens as soon as the
/// gateway reports the VM ready (`StartSteps`), while the gateway still checks its release. Returns the connection and
/// the VM as the gateway reports it, which may lie in another zone than the one stored when the gateway had to move it
/// for the start. `None` when the session's VM no longer exists.
pub async fn start_session_vm(
    gateway: &VmRef,
    id: uuid::Uuid,
    known: &VmRef,
    ssh_dir: &Path,
    progress: Progress<'_>,
) -> Result<Option<(ssh::Ssh, VmRef)>, String> {
    let api = api::GatewayApi::open(gateway, ssh_dir).await?;
    let known_ssh = ssh::Ssh::open(known, ssh_dir).await?;
    if api.is_vm_running(id).await? {
        match release::ensure_ready(&known_ssh, progress).await {
            Ok(()) => return Ok(Some((known_ssh, known.clone()))),
            Err(error) => {
                eprintln!("connecting to the running VM {} of session {id} directly failed, starting it through the gateway: {error}", known.instance);
            }
        }
    }
    let steps = StartSteps::new(progress, Some(known_ssh));
    let Some(vm) = api.start_vm(id, &steps).await? else { return Ok(None) };
    steps.join().await;
    let ssh = ssh::Ssh::open(&vm, ssh_dir).await?;
    release::ensure_ready(&ssh, progress).await?;
    Ok(Some((ssh, vm)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_session_vm_matches_only_the_vm_named_after_the_session() {
        let id = Uuid::parse_str("AB12CD34-0000-4000-8000-000000000001").unwrap();
        assert!(is_session_vm(&VmRef { project: "p".into(), zone: "z".into(), instance: "vm-hunt-s-ab12cd34".into() }, id));
        assert!(!is_session_vm(&VmRef { project: "p".into(), zone: "z".into(), instance: "vm-hunt-medc".into() }, id));
    }

    #[test]
    fn session_vm_is_in_the_gateways_project_and_zone() {
        let id = uuid::Uuid::parse_str("ab12cd34-0000-4000-8000-000000000001").unwrap();
        let gateway = VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-medc".into() };
        assert_eq!(gateway.session_vm(id), VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() });
    }

    #[test]
    fn validate_rejects_empty_and_foreign_characters() {
        let vm = VmRef { project: "acme-staging".into(), zone: "europe-west1-c".into(), instance: "vm-hunt".into() };
        assert!(vm.validate().is_ok());
        assert!(VmRef { instance: String::new(), ..vm.clone() }.validate().is_err());
        assert!(VmRef { zone: "europe west".into(), ..vm.clone() }.validate().is_err());
        assert!(VmRef { project: "Acme".into(), ..vm }.validate().is_err());
    }
}
