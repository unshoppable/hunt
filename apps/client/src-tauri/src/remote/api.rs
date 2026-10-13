//! The gateway API (`libs/domain/src/gatewayApi.ts`), the control plane of remote sessions: Hunt lists, provisions,
//! starts and deletes session VMs and configures the gateway's poller only through it. A call runs `hunt-api <method>`
//! over the SSH connection to the gateway with the request as one JSON object on stdin; stdout carries NDJSON events,
//! `progress` and `log` lines, then one `result` (exit 0) or `error` (exit 1). Hunt passes only session IDs: the gateway
//! names the VMs and owns their project, zone, instance template and preview domain. The first connect to a gateway in an
//! app run asks its `hello` and refuses a gateway whose API differs from `api` in `libs/domain/protocol.json`.

use std::path::Path;
use std::sync::Mutex;

use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::release::PROTOCOL_JSON;
use super::ssh::Ssh;
use super::swf::{SwfConfig, SwfRequest};
use super::{preview, shell_command, Progress, RemoteStep, VmRef};

#[derive(Deserialize)]
struct ApiFile {
    api: u32,
}

/// The gateway API this app speaks.
pub fn api_version() -> u32 {
    serde_json::from_str::<ApiFile>(PROTOCOL_JSON).expect("libs/domain/protocol.json holds an api number").api
}

/// What `hello` reports about the gateway, as far as Hunt uses it.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub api: u32,
    /// The gateway's own release version.
    pub release: String,
    /// Where the session VMs run.
    pub project: String,
    pub zone: String,
    /// The domain of the preview hosts `<short>[-<port>].<domain>`.
    pub preview_domain: String,
}

/// The `hello` of every gateway this app run reached that speaks its API.
static HELLOS: Mutex<Vec<(VmRef, Hello)>> = Mutex::new(Vec::new());

/// A session as `sessions.list` reports it from the labels and metadata of its VM.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    /// The VM's name.
    pub vm: String,
    pub zone: String,
    /// The Compute Engine status, e.g. `RUNNING` or `TERMINATED`.
    pub status: String,
    /// `desktop` or `swf`.
    pub origin: String,
    /// `<owner>/<repo>`.
    pub repo: String,
    pub branch: String,
    pub title: String,
    /// The GitHub issue of a session the poller started.
    pub issue: Option<u64>,
    /// When the VM was created, RFC 3339.
    pub created_at: String,
}

#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<SessionSummary>,
}

#[derive(Deserialize)]
struct VmStatus {
    exists: bool,
    status: Option<String>,
}

#[derive(Deserialize)]
struct StartedVm {
    vm: VmRef,
}

/// What `sessions.provision` needs to set up the VM of a session handed off.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionRequest<'a> {
    pub id: Uuid,
    pub title: &'a str,
    /// `<owner>/<repo>`.
    pub repo: &'a str,
    pub branch: &'a str,
    /// A machine type other than the instance template's.
    pub machine_type: Option<&'a str>,
}

/// The session VM `sessions.provision` set up; `created` when it did not exist before, so its host key is new too.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Provisioned {
    pub vm: VmRef,
    pub created: bool,
}

/// The gateway API over an SSH connection to the gateway.
pub struct GatewayApi {
    ssh: Ssh,
    hello: Hello,
}

impl GatewayApi {
    /// Connects to `gateway` with Hunt's SSH key in `ssh_dir`. The first connect of an app run calls `hello` and fails
    /// unless the gateway speaks this app's API.
    pub async fn open(gateway: &VmRef, ssh_dir: &Path) -> Result<Self, String> {
        let ssh = Ssh::open(gateway, ssh_dir).await?;
        let known = HELLOS.lock().unwrap().iter().find(|(vm, _)| vm == gateway).map(|(_, hello)| hello.clone());
        let hello = match known {
            Some(hello) => hello,
            None => {
                let hello: Hello = call(&ssh, "hello", &json!({}), &|_| {}).await.map_err(|error| without_api(gateway, error))?;
                check_api(&hello, api_version())?;
                HELLOS.lock().unwrap().push((gateway.clone(), hello.clone()));
                hello
            }
        };
        Ok(Self { ssh, hello })
    }

    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    /// The gateway's preview domain, lowercased; fails unless it is a host name.
    pub fn preview_domain(&self) -> Result<String, String> {
        preview::validate_domain(&self.hello.preview_domain)
    }

    /// Calls `method` with `params` and returns its result.
    pub async fn call<T: DeserializeOwned>(&self, method: &str, params: &(impl Serialize + Sync)) -> Result<T, String> {
        call(&self.ssh, method, params, &|_| {}).await
    }

    /// Calls `method` with `params`, reports the steps it streams to `progress` and returns its result.
    pub async fn call_streaming<T: DeserializeOwned>(&self, method: &str, params: &(impl Serialize + Sync), progress: Progress<'_>) -> Result<T, String> {
        call(&self.ssh, method, params, progress).await
    }

    /// The sessions of the gateway's project and zone.
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, String> {
        let listed: SessionList = self.call("sessions.list", &json!({})).await?;
        Ok(listed.sessions)
    }

    /// Whether the VM of session `id` runs; false when it is off or does not exist.
    pub async fn is_vm_running(&self, id: Uuid) -> Result<bool, String> {
        let vm: VmStatus = self.call("vms.get", &json!({ "id": id })).await?;
        Ok(vm.exists && vm.status.as_deref() == Some("RUNNING"))
    }

    /// Creates the VM of the session unless it exists, records the session in its metadata, starts it and waits until
    /// its startup script and release are in place. Fails when the VM holds another session.
    pub async fn provision(&self, request: &ProvisionRequest<'_>, progress: Progress<'_>) -> Result<Provisioned, String> {
        let provisioned: Provisioned = self.call_streaming("sessions.provision", request, progress).await?;
        provisioned.vm.validate()?;
        Ok(provisioned)
    }

    /// Starts or resumes the VM of session `id` unless it runs, waits until it answers and returns it.
    pub async fn start_vm(&self, id: Uuid, progress: Progress<'_>) -> Result<VmRef, String> {
        let started: StartedVm = self.call_streaming("vms.start", &json!({ "id": id }), progress).await?;
        started.vm.validate()?;
        Ok(started.vm)
    }

    /// Deletes the VM of session `id` with its disks; a VM that is gone already counts as deleted.
    pub async fn delete_vm(&self, id: Uuid) -> Result<(), String> {
        let _: IgnoredAny = self.call("vms.delete", &json!({ "id": id })).await?;
        Ok(())
    }

    /// Stores the configuration of the gateway's poller and returns it as stored, with the label and template the
    /// gateway adds.
    pub async fn apply_swf_config(&self, request: &SwfRequest) -> Result<SwfConfig, String> {
        request.validate()?;
        self.call("swf.applyConfig", request).await
    }
}

/// Runs `hunt-api <method>` on the gateway behind `ssh` with `params` on stdin; see `Outcome` for how its output becomes
/// the result.
async fn call<T: DeserializeOwned>(ssh: &Ssh, method: &str, params: &(impl Serialize + Sync), progress: Progress<'_>) -> Result<T, String> {
    let mut input = serde_json::to_vec(params).map_err(|error| format!("failed to write the request of {method}: {error}"))?;
    input.push(b'\n');
    let mut outcome = Outcome::new(method);
    let exit = ssh.run_streaming(&shell_command("hunt-api", &[method]), &input, &mut |line| outcome.take(line, progress)).await;
    outcome.finish(exit)
}

/// One line of the output of a call.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Event {
    Progress {
        step: RemoteStep,
    },
    Log {
        message: String,
    },
    Result {
        #[serde(default)]
        data: Value,
    },
    Error {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
    },
    /// An event of a newer gateway.
    #[serde(other)]
    Unknown,
}

/// The most output lines that were no events an error message repeats.
const MAX_STRAY_LINES: usize = 5;

/// What the output of one call amounts to: its result or error, and lines that were no events.
struct Outcome<'a> {
    method: &'a str,
    result: Option<Value>,
    error: Option<(String, String)>,
    stray: Vec<String>,
}

impl<'a> Outcome<'a> {
    fn new(method: &'a str) -> Self {
        Outcome { method, result: None, error: None, stray: Vec::new() }
    }

    /// Takes one line of output: a known progress step goes to `progress`, a log line to stderr, a result or an error is
    /// kept; unknown events and steps are dropped.
    fn take(&mut self, line: &str, progress: Progress<'_>) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        match serde_json::from_str::<Event>(line) {
            Ok(Event::Progress { step: RemoteStep::Unknown }) | Ok(Event::Unknown) => {}
            Ok(Event::Progress { step }) => progress(step),
            Ok(Event::Log { message }) => eprintln!("gateway {}: {message}", self.method),
            Ok(Event::Result { data }) => self.result = Some(data),
            Ok(Event::Error { code, message }) => self.error = Some((code, message)),
            Err(_) if self.stray.len() < MAX_STRAY_LINES => self.stray.push(line.to_string()),
            Err(_) => {}
        }
    }

    /// The result as `T`, given how the remote command ended: an error event goes before a failed `exit`, which goes
    /// before a missing result.
    fn finish<T: DeserializeOwned>(self, exit: Result<(), String>) -> Result<T, String> {
        let method = self.method;
        if let Some((code, message)) = self.error {
            let reason = if message.trim().is_empty() { code } else { message };
            return Err(format!("failed to run {method} on the gateway: {reason}"));
        }
        exit?;
        let Some(data) = self.result else {
            let output = if self.stray.is_empty() { String::new() } else { format!(": {}", self.stray.join("\n")) };
            return Err(format!("failed to run {method} on the gateway: it sent no result{output}"));
        };
        serde_json::from_value(data).map_err(|error| format!("failed to read the result of {method} from the gateway: {error}"))
    }
}

/// Accepts a gateway of API `expected`; otherwise the error says which side has to catch up.
fn check_api(hello: &Hello, expected: u32) -> Result<(), String> {
    let found = hello.api;
    if found > expected {
        return Err(format!("failed to use the gateway: it speaks gateway API {found}, this app {expected}; update Hunt in Settings → Updates"));
    }
    if found < expected {
        return Err(format!(
            "failed to use the gateway: it runs the older Hunt release {} with gateway API {found}, this app {expected}; it is updated with the next server deploy",
            hello.release
        ));
    }
    Ok(())
}

/// `error` of a `hello` call, explained when the gateway has no `hunt-api` at all.
fn without_api(gateway: &VmRef, error: String) -> String {
    if error.contains("hunt-api: command not found") || error.contains("hunt-api: not found") {
        return format!(
            "failed to use the gateway {}: it runs an older Hunt release without the gateway API; it is updated with the next server deploy",
            gateway.instance
        );
    }
    error
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Feeds `output` line by line into an outcome of `method` and finishes it with `exit`; returns the result and the
    /// steps reported.
    fn run<T: DeserializeOwned>(method: &str, output: &str, exit: Result<(), String>) -> (Result<T, String>, Vec<RemoteStep>) {
        let steps = Mutex::new(Vec::new());
        let progress = |step: RemoteStep| steps.lock().unwrap().push(step);
        let mut outcome = Outcome::new(method);
        for line in output.lines() {
            outcome.take(line, &progress);
        }
        let result = outcome.finish(exit);
        (result, steps.into_inner().unwrap())
    }

    #[test]
    fn api_version_reads_the_shared_protocol_file() {
        assert!(api_version() >= 1);
    }

    #[test]
    fn a_call_reports_known_steps_and_returns_the_result() {
        let output = r#"{"type":"progress","step":"creatingVm"}
{"type":"log","message":"created vm-hunt-s-ab12cd34"}

{"type":"progress","step":"configuringDns"}
{"type":"progress","step":"waitingForVm"}
{"type":"heartbeat"}
{"type":"progress","step":"installingRuntime"}
{"type":"result","data":{"vm":{"project":"acme","zone":"europe-west1-c","instance":"vm-hunt-s-ab12cd34"},"created":true,"release":{"version":"1.2.0","protocol":1}}}"#;
        let (result, steps) = run::<Provisioned>("sessions.provision", output, Ok(()));
        let vm = VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() };
        assert_eq!(result, Ok(Provisioned { vm, created: true }));
        assert_eq!(steps, [RemoteStep::CreatingVm, RemoteStep::WaitingForVm, RemoteStep::InstallingRuntime]);
    }

    #[test]
    fn an_error_event_wins_over_the_exit_status_and_falls_back_to_its_code() {
        let output = r#"{"type":"progress","step":"startingVm"}
{"type":"error","code":"notFound","message":"the session ab12cd34 has no VM"}"#;
        let exit = Err("failed to run `hunt-api vms.start` on the VM vm-hunt-medc: ".to_string());
        let (result, steps) = run::<StartedVm>("vms.start", output, exit.clone());
        assert_eq!(result.err().as_deref(), Some("failed to run vms.start on the gateway: the session ab12cd34 has no VM"));
        assert_eq!(steps, [RemoteStep::StartingVm]);

        let (result, _) = run::<StartedVm>("vms.start", r#"{"type":"error","code":"forbidden"}"#, exit);
        assert_eq!(result.err().as_deref(), Some("failed to run vms.start on the gateway: forbidden"));
    }

    #[test]
    fn a_failed_command_without_an_error_event_reports_the_ssh_error() {
        let exit = Err("failed to run `hunt-api vms.get` on the VM vm-hunt-medc: Connection closed".to_string());
        let (result, _) = run::<IgnoredAny>("vms.get", "", exit.clone());
        assert_eq!(result.err(), exit.err());
    }

    #[test]
    fn output_without_a_result_or_of_the_wrong_shape_fails() {
        let (result, _) = run::<IgnoredAny>("sessions.list", "Welcome to the gateway\n{\"type\":\"log\",\"message\":\"x\"}", Ok(()));
        assert_eq!(result.err().as_deref(), Some("failed to run sessions.list on the gateway: it sent no result: Welcome to the gateway"));

        let (result, _) = run::<SessionList>("sessions.list", r#"{"type":"result","data":{"vms":[]}}"#, Ok(()));
        assert!(result.err().is_some_and(|error| error.starts_with("failed to read the result of sessions.list from the gateway: missing field `sessions`")));
    }

    #[test]
    fn session_summaries_read_the_listing() {
        let output = r#"{"type":"result","data":{"sessions":[{"id":"ab12cd34-0000-4000-8000-000000000001","vm":"vm-hunt-s-ab12cd34","zone":"europe-west1-c",
"status":"TERMINATED","origin":"swf","owner":"","repo":"acme/app","branch":"hunt/123-fix-login","title":"Fix login","issue":123,
"createdAt":"2026-10-12T03:04:05.678-07:00"}]}}"#;
        let (result, _) = run::<SessionList>("sessions.list", &output.replace('\n', ""), Ok(()));
        let sessions = result.unwrap().sessions;
        assert_eq!(sessions.len(), 1);
        assert_eq!((sessions[0].vm.as_str(), sessions[0].origin.as_str(), sessions[0].issue), ("vm-hunt-s-ab12cd34", "swf", Some(123)));
    }

    #[test]
    fn check_api_refuses_a_newer_and_an_older_gateway() {
        let hello = Hello { api: 2, release: "1.4.0".into(), project: "acme".into(), zone: "europe-west1-c".into(), preview_domain: "hunt.example.com".into() };
        assert_eq!(check_api(&hello, 2), Ok(()));
        assert!(check_api(&hello, 1).unwrap_err().contains("gateway API 2, this app 1; update Hunt in Settings → Updates"));
        let older = check_api(&hello, 3).unwrap_err();
        assert!(older.contains("older Hunt release 1.4.0 with gateway API 2, this app 3") && older.contains("next server deploy"), "{older}");
    }

    #[test]
    fn hello_reads_the_gateway_and_without_api_explains_a_missing_hunt_api() {
        let output = r#"{"type":"result","data":{"api":1,"protocol":1,"release":"1.4.0","project":"acme","zone":"europe-west1-c","previewDomain":"hunt.example.com","caller":"jane_example_com"}}"#;
        let (result, _) = run::<Hello>("hello", output, Ok(()));
        assert_eq!(result.unwrap().preview_domain, "hunt.example.com");

        let gateway = VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-medc".into() };
        let missing = without_api(&gateway, "failed to run `hunt-api hello` on the VM vm-hunt-medc: bash: line 1: hunt-api: command not found".into());
        assert!(missing.starts_with("failed to use the gateway vm-hunt-medc: it runs an older Hunt release without the gateway API"), "{missing}");
        assert_eq!(without_api(&gateway, "Permission denied".into()), "Permission denied");
    }

    #[test]
    fn requests_serialize_in_the_shape_of_the_contract() {
        let id = Uuid::parse_str("ab12cd34-0000-4000-8000-000000000001").unwrap();
        let request = ProvisionRequest { id, title: "Fix login", repo: "acme/app", branch: "hunt/x", machine_type: None };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({ "id": "ab12cd34-0000-4000-8000-000000000001", "title": "Fix login", "repo": "acme/app", "branch": "hunt/x", "machineType": null })
        );
        assert_eq!(json!({ "id": id }), json!({ "id": "ab12cd34-0000-4000-8000-000000000001" }));
    }
}
