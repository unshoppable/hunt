//! The VMs of remote sessions: Hunt creates one per session from an instance template, starts it when the session needs
//! it and deletes it with the session; the VM shuts itself down when idle.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::ssh::Ssh;
use super::{gcloud, Progress, RemoteStep, VmRef};

/// What every session VM's name starts with; Hunt deletes no VM without it.
pub const SESSION_VM_PREFIX: &str = "vm-hunt-s-";

/// The label that marks session VMs; its value is the session's short id.
const SESSION_LABEL: &str = "hunt-session";

/// The file the startup script of a session VM writes once the VM has everything `hunt-ctl install` needs.
const READY_STAMP: &str = "/var/lib/hunt/session-ready";

/// How long a start (VM boot plus SSH) may take before Hunt gives up.
const START_TIMEOUT: Duration = Duration::from_secs(6 * 60);
/// How long a new VM may take to appear in Compute Engine after the create request.
const CREATE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// How long the startup script of a new VM may take to install its base software.
const READY_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const READY_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The first 8 hex digits of session `id`, which name its VM and its preview hosts.
pub fn short_id(id: Uuid) -> String {
    id.simple().to_string()[..8].to_string()
}

/// The name of the VM of session `id`.
pub fn session_vm_name(id: Uuid) -> String {
    format!("{SESSION_VM_PREFIX}{}", short_id(id))
}

/// Whether `vm` is the VM of session `id`, which deleting the session may delete.
pub fn is_session_vm(vm: &VmRef, id: Uuid) -> bool {
    vm.instance == session_vm_name(id)
}

/// What a session VM records about its session in its metadata.
pub struct SessionMetadata<'a> {
    pub hunt_session_id: Uuid,
    /// `<owner>/<repo>`.
    pub repo: &'a str,
    pub branch: &'a str,
    pub title: &'a str,
}

/// Requests the VM `vm` of session `id` from the instance template `template`, optionally with another `machine_type`,
/// and waits until Compute Engine lists it; it boots afterwards. The labels given here replace the template's, so they
/// include its `hunt-role`.
pub async fn create(vm: &VmRef, id: Uuid, template: &str, machine_type: Option<&str>) -> Result<(), String> {
    let mut args = vec![
        "compute".to_string(),
        "instances".into(),
        "create".into(),
        vm.instance.clone(),
        format!("--source-instance-template={template}"),
        format!("--zone={}", vm.zone),
        format!("--project={}", vm.project),
        format!("--labels=hunt-role=session,{SESSION_LABEL}={},hunt-origin=desktop", short_id(id)),
        // Returns once the request is accepted; waiting through gcloud would need permissions on zone operations.
        "--async".into(),
    ];
    if let Some(machine_type) = machine_type {
        args.push(format!("--machine-type={machine_type}"));
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    gcloud(&args).await.map_err(|error| format!("failed to create the VM {}: {error}", vm.instance))?;

    let deadline = Instant::now() + CREATE_TIMEOUT;
    loop {
        if status_if_exists(vm).await?.is_some() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("failed to create the VM {}: Compute Engine does not list it; check the quota and the template", vm.instance));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Sets the session keys of `vm`'s metadata to `metadata`, leaving the template's keys (startup script, OS Login) alone.
pub async fn set_session_metadata(vm: &VmRef, metadata: &SessionMetadata<'_>) -> Result<(), String> {
    let session_id = metadata.hunt_session_id.to_string();
    let entries = [("hunt-session-id", session_id.as_str()), ("hunt-repo", metadata.repo), ("hunt-branch", metadata.branch), ("hunt-title", metadata.title)];
    let zone = format!("--zone={}", vm.zone);
    let project = format!("--project={}", vm.project);
    let value = format!("--metadata={}", metadata_value(&entries));
    gcloud(&["compute", "instances", "add-metadata", &vm.instance, &zone, &project, &value])
        .await
        .map_err(|error| format!("failed to label the VM {} with its session: {error}", vm.instance))?;
    Ok(())
}

/// The `--metadata` value of gcloud for `entries`. gcloud splits it at commas unless it starts with `^<delimiter>^`, so
/// the entries are joined with the first delimiter that splits them apart again, which lets the values keep every
/// character.
fn metadata_value(entries: &[(&str, &str)]) -> String {
    let parts: Vec<String> = entries.iter().map(|(key, value)| format!("{key}={value}")).collect();
    let candidates = [";", "|", "~", "#"].into_iter().map(str::to_string).chain((0u64..).map(|number| format!("|{number}|")));
    let delimiter = candidates
        .into_iter()
        .find(|delimiter| parts.join(delimiter).split(delimiter.as_str()).eq(parts.iter().map(String::as_str)))
        .unwrap_or_else(|| ",".to_string());
    format!("^{delimiter}^{}", parts.join(&delimiter))
}

/// Deletes the session VM `vm` with all its disks; a VM that does not exist counts as deleted. Refuses VMs whose name
/// is not a session VM's, so a record of an older handoff can never delete the VM all sessions shared.
pub async fn delete(vm: &VmRef) -> Result<(), String> {
    if !vm.instance.starts_with(SESSION_VM_PREFIX) {
        return Err(format!("failed to delete the VM {}: it is no session VM", vm.instance));
    }
    vm.validate()?;
    let zone = format!("--zone={}", vm.zone);
    let project = format!("--project={}", vm.project);
    match gcloud(&["compute", "instances", "delete", &vm.instance, &zone, &project, "--delete-disks=all", "--quiet", "--async"]).await {
        Ok(_) => Ok(()),
        Err(error) if is_not_found(&error) => Ok(()),
        Err(error) => Err(format!("failed to delete the VM {}: {error}", vm.instance)),
    }
}

/// Whether a gcloud error says the resource does not exist.
fn is_not_found(error: &str) -> bool {
    error.contains("was not found")
}

/// The VM's status as Compute Engine reports it, e.g. `RUNNING`, `TERMINATED` or `STOPPING`.
pub async fn status(vm: &VmRef) -> Result<String, String> {
    status_if_exists(vm).await?.ok_or_else(|| format!("failed to find the VM {}: it does not exist", vm.instance))
}

/// The VM's status, or `None` when Compute Engine has no such VM.
pub async fn status_if_exists(vm: &VmRef) -> Result<Option<String>, String> {
    let zone = format!("--zone={}", vm.zone);
    let project = format!("--project={}", vm.project);
    match gcloud(&["compute", "instances", "describe", &vm.instance, &zone, &project, "--format=value(status)"]).await {
        Ok(output) => Ok(Some(output.trim().to_string())),
        Err(error) if is_not_found(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Starts the VM unless it runs (waiting out a shutdown in progress or the boot of a new VM) and waits until SSH
/// answers. `progress` hears `StartingVm` only when the VM was off.
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

/// Waits until the startup script of the running session VM behind `ssh` has installed the VM's base software; a VM
/// that did so before returns at once. `progress` hears `WaitingForVm` only when there is something to wait for.
pub async fn wait_until_ready(vm: &VmRef, ssh: &Ssh, progress: Progress<'_>) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let check = format!("test -e {READY_STAMP} && echo ready || true");
    let mut is_waiting = false;
    loop {
        let answer = ssh.run(&check).await;
        if answer.as_deref().is_ok_and(|output| output.trim() == "ready") {
            return Ok(());
        }
        if Instant::now() > deadline {
            let reason = answer.err().unwrap_or_else(|| format!("{READY_STAMP} is still missing"));
            return Err(format!("failed to set up the VM {}: its startup script did not finish within 10 minutes: {reason}", vm.instance));
        }
        if !is_waiting {
            progress(RemoteStep::WaitingForVm);
            is_waiting = true;
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

/// A session VM as Compute Engine lists it, with the labels and metadata that name its session.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionVm {
    pub name: String,
    pub zone: String,
    /// E.g. `RUNNING` or `TERMINATED`.
    pub status: String,
    pub labels: BTreeMap<String, String>,
    /// The metadata items, such as `hunt-session-id`, `hunt-repo`, `hunt-branch` and `hunt-title`.
    pub metadata: BTreeMap<String, String>,
}

/// Every session VM of `project`, in any zone.
pub async fn list_session_vms(project: &str) -> Result<Vec<SessionVm>, String> {
    let project = format!("--project={project}");
    let filter = format!("--filter=labels.{SESSION_LABEL}:*");
    let output = gcloud(&["compute", "instances", "list", &project, &filter, "--format=json"]).await?;
    parse_session_vms(&output)
}

#[derive(Deserialize)]
struct ListedInstance {
    name: String,
    #[serde(default)]
    zone: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    metadata: ListedMetadata,
}

#[derive(Deserialize, Default)]
struct ListedMetadata {
    #[serde(default)]
    items: Vec<MetadataItem>,
}

#[derive(Deserialize)]
struct MetadataItem {
    key: String,
    #[serde(default)]
    value: String,
}

/// Reads the output of `gcloud compute instances list --format=json`; zones come as URLs and keep their last segment.
fn parse_session_vms(output: &str) -> Result<Vec<SessionVm>, String> {
    let instances: Vec<ListedInstance> = serde_json::from_str(output).map_err(|error| format!("failed to read the list of session VMs: {error}"))?;
    Ok(instances
        .into_iter()
        .map(|instance| SessionVm {
            name: instance.name,
            zone: instance.zone.rsplit('/').next().unwrap_or_default().to_string(),
            status: instance.status,
            labels: instance.labels,
            metadata: instance.metadata.items.into_iter().map(|item| (item.key, item.value)).collect(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_vm_name_takes_the_first_eight_hex_digits() {
        let id = Uuid::parse_str("AB12CD34-0000-4000-8000-000000000001").unwrap();
        assert_eq!(session_vm_name(id), "vm-hunt-s-ab12cd34");
        assert!(is_session_vm(&VmRef { project: "p".into(), zone: "z".into(), instance: "vm-hunt-s-ab12cd34".into() }, id));
        assert!(!is_session_vm(&VmRef { project: "p".into(), zone: "z".into(), instance: "vm-hunt-medc".into() }, id));
    }

    /// Splits a `--metadata` value the way gcloud does: the delimiter between the leading carets, then `key=value`.
    fn split_metadata(value: &str) -> Vec<(String, String)> {
        let (delimiter, joined) = value.strip_prefix('^').unwrap().split_once('^').unwrap();
        joined.split(delimiter).map(|part| part.split_once('=').unwrap()).map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    #[test]
    fn metadata_value_keeps_commas_delimiters_and_carets_in_values() {
        assert_eq!(metadata_value(&[("hunt-repo", "acme/app"), ("hunt-title", "Fix login, then logout")]), "^;^hunt-repo=acme/app;hunt-title=Fix login, then logout");
        for title in ["a;b", "ends with;", "x;y|z~w#v", "x;y|z~w#v|0|", "^caret^ = sign", ""] {
            let value = metadata_value(&[("hunt-title", title), ("hunt-branch", "hunt/x")]);
            let expected = vec![("hunt-title".to_string(), title.to_string()), ("hunt-branch".to_string(), "hunt/x".to_string())];
            assert_eq!(split_metadata(&value), expected, "{value}");
        }
    }

    #[test]
    fn parse_session_vms_reads_name_zone_status_labels_and_metadata() {
        let output = r#"[
          {
            "name": "vm-hunt-s-ab12cd34",
            "zone": "https://www.googleapis.com/compute/v1/projects/acme/zones/europe-west1-c",
            "status": "TERMINATED",
            "labels": {"hunt-session": "ab12cd34", "hunt-origin": "swf"},
            "metadata": {"fingerprint": "x", "kind": "compute#metadata", "items": [
              {"key": "hunt-session-id", "value": "ab12cd34-0000-4000-8000-000000000001"},
              {"key": "hunt-title", "value": "Fix login, then logout"}
            ]}
          },
          {"name": "vm-hunt-s-00000000", "zone": "europe-west1-b", "status": "RUNNING"}
        ]"#;
        let vms = parse_session_vms(output).unwrap();
        assert_eq!(vms.len(), 2);
        assert_eq!((vms[0].name.as_str(), vms[0].zone.as_str(), vms[0].status.as_str()), ("vm-hunt-s-ab12cd34", "europe-west1-c", "TERMINATED"));
        assert_eq!(vms[0].labels.get("hunt-origin").map(String::as_str), Some("swf"));
        assert_eq!(vms[0].metadata.get("hunt-title").map(String::as_str), Some("Fix login, then logout"));
        assert_eq!(vms[1].zone, "europe-west1-b");
        assert!(vms[1].labels.is_empty() && vms[1].metadata.is_empty());
        assert_eq!(parse_session_vms("[]").unwrap(), Vec::new());
        assert!(parse_session_vms("not json").is_err());
    }

    #[test]
    fn is_not_found_recognizes_the_gcloud_message() {
        let missing = "failed to run gcloud compute instances describe: ERROR: (gcloud.compute.instances.describe) Could not fetch resource:\n \
                       - The resource 'projects/p/zones/z/instances/vm-hunt-s-1' was not found";
        assert!(is_not_found(missing));
        assert!(!is_not_found("failed to run gcloud compute instances describe: ERROR: permission denied"));
    }

    #[tokio::test]
    async fn delete_refuses_vms_that_are_no_session_vms() {
        let gateway = VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-medc".into() };
        assert_eq!(delete(&gateway).await, Err("failed to delete the VM vm-hunt-medc: it is no session VM".to_string()));
    }
}
