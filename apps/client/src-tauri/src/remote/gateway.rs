//! The gateway VM, which serves the gateway API (`api.rs`) and routes previews to the session VMs: the settings that
//! name its project, and the lookup of the VM labelled `hunt-role=gateway` there.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;

use super::gcloud::gcloud;
use super::vm::{is_compute_name, VmRef};

/// How Hunt reaches the gateway, from the settings.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VmSettings {
    /// The project whose VM labelled `hunt-role=gateway` serves the gateway API and routes
    /// `https://<short>[-<port>].<domain>` to the session VMs (`gateway_vm`).
    pub project: String,
    /// The machine type of the session VMs the gateway creates instead of its template's; the gateway accepts only the
    /// ones of `libs/domain/src/session/session-machine-type.types.ts`.
    #[serde(default)]
    pub machine_type: Option<String>,
}

impl VmSettings {
    /// Rejects a project that cannot go into the ssh ProxyCommand unquoted or that Compute Engine would refuse, and a
    /// machine type that is no Compute Engine name.
    pub fn validate(&self) -> Result<(), String> {
        if !is_compute_name(&self.project) {
            return Err(format!("failed to use the remote VM: the project {:?} is not a valid Compute Engine name", self.project));
        }
        if let Some(machine_type) = self.machine_type.as_deref().filter(|machine_type| !is_compute_name(machine_type)) {
            return Err(format!("failed to use the remote VM: the machine type {machine_type:?} is not a valid Compute Engine name"));
        }
        Ok(())
    }
}

/// The gateways looked up in this app run, keyed by project.
static GATEWAYS: Mutex<Option<HashMap<String, VmRef>>> = Mutex::new(None);

/// The gateway VM of `settings`: the VM of its project labelled `hunt-role=gateway`, which the infrastructure repository
/// configures; looked up with gcloud once per app run.
pub async fn gateway_vm(settings: &VmSettings) -> Result<VmRef, String> {
    let cached = GATEWAYS.lock().unwrap().as_ref().and_then(|gateways| gateways.get(&settings.project).cloned());
    if let Some(gateway) = cached {
        return Ok(gateway);
    }
    let project = format!("--project={}", settings.project);
    let output = gcloud(&["compute", "instances", "list", &project, "--filter=labels.hunt-role=gateway", "--format=value(name,zone.basename())"]).await?;
    let gateway = parse_gateway(&output, &settings.project)?;
    GATEWAYS.lock().unwrap().get_or_insert_with(Default::default).insert(settings.project.clone(), gateway.clone());
    Ok(gateway)
}

/// The gateway in `output` of `gcloud compute instances list --format=value(name,zone.basename())` for `project`:
/// exactly one VM, as name and zone separated by whitespace.
fn parse_gateway(output: &str, project: &str) -> Result<VmRef, String> {
    let rows: Vec<&str> = output.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let [row] = rows.as_slice() else {
        if rows.is_empty() {
            return Err(format!("failed to find the gateway in the project {project}: no VM there is labelled hunt-role=gateway"));
        }
        return Err(format!("failed to find the gateway in the project {project}: several VMs are labelled hunt-role=gateway: {rows:?}"));
    };
    let fields: Vec<&str> = row.split_whitespace().collect();
    let [instance, zone] = fields.as_slice() else {
        return Err(format!("failed to read the gateway of the project {project} from gcloud: {row:?}"));
    };
    let gateway = VmRef { project: project.to_string(), zone: (*zone).to_string(), instance: (*instance).to_string() };
    gateway.validate()?;
    Ok(gateway)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_settings_validate_the_project_and_machine_type() {
        let settings = |project: &str, machine_type: Option<&str>| VmSettings {
            project: project.into(),
            machine_type: machine_type.map(str::to_string),
        };
        assert_eq!(settings("acme-hunt", None).validate(), Ok(()));
        assert_eq!(settings("acme-hunt", Some("c4d-standard-8")).validate(), Ok(()));
        assert!(settings("", None).validate().is_err());
        assert!(settings("Acme", None).validate().is_err());
        assert!(settings("acme-hunt", Some("c4d standard")).validate().is_err());
        let parsed: VmSettings = serde_json::from_value(serde_json::json!({ "project": "acme-hunt" })).unwrap();
        assert_eq!(parsed, settings("acme-hunt", None));
    }

    #[test]
    fn parse_gateway_takes_exactly_one_labelled_vm() {
        let gateway = VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-medc".into() };
        assert_eq!(parse_gateway("vm-hunt-medc\teurope-west1-c\n", "acme"), Ok(gateway));
        assert_eq!(
            parse_gateway("\n", "acme"),
            Err("failed to find the gateway in the project acme: no VM there is labelled hunt-role=gateway".to_string())
        );
        assert!(parse_gateway("vm-a\teurope-west1-c\nvm-b\tus-central1-a\n", "acme").is_err());
        assert!(parse_gateway("vm-hunt-medc\n", "acme").is_err());
        assert!(parse_gateway("vm-hunt-medc\tEurope West\n", "acme").is_err());
    }
}
