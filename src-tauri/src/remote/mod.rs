//! Sessions handed off to a VM of their own: SSH through an IAP tunnel (`ssh.rs`), creating, starting and deleting the
//! session VMs (`vm.rs`), the software Hunt installs on them and on the gateway from this repository's `remote/` folder
//! (`bundle.rs`), and moving a session's git state and Claude Code transcript there and back (`handoff.rs`,
//! `retrieve.rs`, `transcript.rs`), adopting session VMs no local session knows (`adoption.rs`), the changes on a VM
//! (`diff.rs`), previews (`preview.rs`), terminals attached to the VM's tmux session (`terminal.rs`), the configuration
//! of the gateway's GitHub issue poller (`swf.rs`) and sessions an older Hunt handed off to the gateway (`legacy.rs`).
//! Knows nothing about Tauri; `session/commands.rs` owns the commands.

pub mod adoption;
pub mod bundle;
pub mod diff;
pub mod handoff;
pub mod legacy;
pub mod memory;
pub mod preview;
pub mod retrieve;
pub mod ssh;
pub mod swf;
pub mod terminal;
pub mod transcript;
pub mod vm;

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// A Compute Engine VM: the VM of one remote session, or the gateway that routes previews to them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct VmRef {
    pub project: String,
    pub zone: String,
    pub instance: String,
}

impl VmRef {
    /// Rejects empty fields and characters that Compute Engine names never contain, so the values can go into gcloud
    /// arguments and the ssh ProxyCommand unquoted.
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [("project", &self.project), ("zone", &self.zone), ("instance", &self.instance)] {
            let is_valid = !value.is_empty() && value.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-');
            if !is_valid {
                return Err(format!("failed to use the remote VM: the {name} {value:?} is not a valid Compute Engine name"));
            }
        }
        Ok(())
    }
}

/// Where Hunt creates the VM of a session it hands off, from the settings.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VmSettings {
    pub project: String,
    pub zone: String,
    /// The always-running VM that routes `https://<short>[-<port>].<domain>` to the session VMs.
    pub gateway: String,
    /// The instance template session VMs are created from.
    pub template: String,
    /// A machine type other than the template's, e.g. `e2-standard-8`.
    pub machine_type: Option<String>,
    pub preview_domain: String,
}

impl VmSettings {
    /// The gateway VM.
    pub fn gateway_vm(&self) -> VmRef {
        VmRef { project: self.project.clone(), zone: self.zone.clone(), instance: self.gateway.clone() }
    }

    /// The VM of session `id`.
    pub fn session_vm(&self, id: uuid::Uuid) -> VmRef {
        VmRef { project: self.project.clone(), zone: self.zone.clone(), instance: vm::session_vm_name(id) }
    }

    /// Rejects values that cannot go into gcloud arguments unquoted; returns the preview domain lowercased.
    pub fn validate(&self, id: uuid::Uuid) -> Result<String, String> {
        self.gateway_vm().validate()?;
        self.session_vm(id).validate()?;
        let is_name = |value: &str| !value.is_empty() && value.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-');
        if !is_name(&self.template) {
            return Err(format!("failed to use the session VM template {:?}: it is not a valid Compute Engine name", self.template));
        }
        if let Some(machine_type) = &self.machine_type {
            if !is_name(machine_type) {
                return Err(format!("failed to use the machine type {machine_type:?}: it is not a valid Compute Engine name"));
            }
        }
        preview::validate_domain(&self.preview_domain)
    }
}

/// Where a session handed off to a VM runs, and what Hunt needs to reach it and to bring it back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    /// The session's own VM, `vm-hunt-s-<short>`; older handoffs name the VM all sessions shared.
    pub vm: VmRef,
    /// The session's worktree on the VM.
    pub worktree_path: PathBuf,
    /// `<owner>/<repo>` of the bare repository on the VM that holds the session's branch.
    pub repo: String,
    /// The branch the local worktree had checked out at the handoff and the commit it pointed to; the retrieval moves
    /// that branch from this commit to the one the agent left on the VM.
    pub branch: String,
    pub handoff_head: String,
    pub handed_off_at: chrono::DateTime<chrono::Utc>,
    /// The permission mode the session had locally. The agent on the VM runs in `bypassPermissions`, which a local
    /// agent would take over from the transcript, so the retrieval sets this mode again; `None` falls back to `default`.
    #[serde(default)]
    pub local_mode: Option<String>,
    /// When the agent last worked on the session: a prompt Hunt sent or a turn that ended; `None` until the first one
    /// after the handoff.
    #[serde(default)]
    pub last_active_at: Option<chrono::DateTime<chrono::Utc>>,
    /// When Hunt last asked whether to retrieve or delete the idle session and the user chose to wait.
    #[serde(default)]
    pub cleanup_asked_at: Option<chrono::DateTime<chrono::Utc>>,
    /// The domain the session's preview URLs were set up with at the handoff; `None` for older handoffs.
    #[serde(default)]
    pub preview_domain: Option<String>,
    /// Who started the session on its VM: this Mac, or someone else whose VM this Mac adopted.
    #[serde(default)]
    pub origin: RemoteOrigin,
    /// The GitHub issue a `swf` session works on.
    #[serde(default)]
    pub issue: Option<u64>,
}

impl RemoteTarget {
    /// The permission mode the session gets back locally.
    pub fn restored_mode(&self) -> &str {
        self.local_mode.as_deref().unwrap_or("default")
    }

    /// Whether this Mac adopted the session from a VM listing instead of handing it off: there is no local worktree
    /// waiting for it, and other people may work on it too.
    pub fn is_adopted(&self) -> bool {
        self.origin != RemoteOrigin::Handoff
    }

    /// Whether session `id` was handed off before every session got a VM of its own and runs on the gateway under the
    /// `hunt-ctl` of that time (see `legacy`): its record names a VM other than `vm-hunt-s-<short id>`.
    pub fn is_legacy(&self, id: uuid::Uuid) -> bool {
        !vm::is_session_vm(&self.vm, id)
    }
}

/// Who started a remote session on its VM.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteOrigin {
    /// This Mac handed the session off; its local worktree waits for the retrieval.
    #[default]
    Handoff,
    /// Another person's Hunt handed it off (VM label `hunt-origin=desktop`).
    Desktop,
    /// The gateway's poller started it for a GitHub issue labelled `swf` (VM label `hunt-origin=swf`).
    Swf,
}

/// The time of the agent's last work the relay reports in its status (`hunt-ctl wait` or `status`): `now` while a turn
/// runs, else when the last turn ended (Unix ms); `None` when no turn ended since the relay started. Client activity
/// does not count, since every connect of Hunt is some.
pub fn relay_activity(status: &serde_json::Value, now: chrono::DateTime<chrono::Utc>) -> Option<chrono::DateTime<chrono::Utc>> {
    if status["turn"].as_str() == Some("running") {
        return Some(now);
    }
    status["lastTurnEndedAt"].as_i64().and_then(chrono::DateTime::from_timestamp_millis)
}

/// A step of a handoff, a retrieval or a connect that takes long enough to show in the UI.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteStep {
    StartingVm,
    CreatingVm,
    WaitingForVm,
    Connecting,
    InstallingRuntime,
    TransferringCode,
    InstallingDependencies,
    StartingAgent,
    StoppingAgent,
    RetrievingCode,
}

/// Receives the steps of a running remote operation.
pub type Progress<'a> = &'a (dyn Fn(RemoteStep) + Send + Sync);

/// `value` quoted for a POSIX shell, so it reaches the remote command (or `GIT_SSH_COMMAND`) as one word.
pub fn shell_quote(value: &str) -> String {
    if !value.is_empty() && value.chars().all(|character| character.is_ascii_alphanumeric() || "-_./=:@%+,".contains(character)) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The remote command `program` with `args`, each quoted for the remote shell.
pub fn shell_command(program: &str, args: &[&str]) -> String {
    let mut command = shell_quote(program);
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    command
}

/// What `hunt-ctl start` and `clear` read on stdin: the Claude Code OAuth token the relay runs Claude Code with (empty
/// with the local login, which only a running relay gets by with) and the GitHub token it pushes and runs `gh` with
/// (empty without one).
pub fn token_input(claude_token: &str, github_token: Option<&str>) -> String {
    format!("{claude_token}\n{}\n", github_token.unwrap_or_default())
}

/// The most of a repository's HUNT.md that goes into a remote session's system prompt; `remote/session/configCli.ts`
/// takes as much on the VM.
const HUNT_MD_MAX_BYTES: u64 = 20 * 1024;

/// The text of the HUNT.md in `worktree`, the repository's instructions for Hunt sessions, or None when it has none.
pub fn read_hunt_md(worktree: &Path) -> Result<Option<String>, String> {
    let path = worktree.join("HUNT.md");
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read HUNT.md: {error}")),
    };
    if !metadata.is_file() || metadata.len() > HUNT_MD_MAX_BYTES {
        return Err(format!("failed to read HUNT.md: it must be a file of at most {HUNT_MD_MAX_BYTES} bytes"));
    }
    std::fs::read_to_string(&path).map(Some).map_err(|error| format!("failed to read HUNT.md: {error}"))
}

/// Runs `hunt-ctl` with `args` on the VM as root and returns its JSON output.
pub async fn hunt_ctl(ssh: &ssh::Ssh, args: &[&str]) -> Result<serde_json::Value, String> {
    hunt_ctl_with_input(ssh, args, &[]).await
}

/// Runs `hunt-ctl` with `args` and `input` on its standard input on the VM as root and returns its JSON output.
pub async fn hunt_ctl_with_input(ssh: &ssh::Ssh, args: &[&str], input: &[u8]) -> Result<serde_json::Value, String> {
    let mut command_args = vec!["-n", "hunt-ctl"];
    command_args.extend_from_slice(args);
    let output = ssh.run_with_input(&shell_command("sudo", &command_args), input).await?;
    let output = String::from_utf8_lossy(&output);
    let output = output.trim();
    if output.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(output).map_err(|error| format!("failed to read the output of hunt-ctl {}: {error}: {output}", args.first().unwrap_or(&"")))
}

/// Runs gcloud with `args` and returns its standard output.
async fn gcloud(args: &[&str]) -> Result<String, String> {
    let output = Command::new("gcloud").args(args).output().await.map_err(|error| format!("failed to run gcloud: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("failed to run gcloud {}: {stderr}", args.iter().take(3).copied().collect::<Vec<_>>().join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A gzip'd tar of `entries` (paths relative to `dir`), without macOS AppleDouble files, `.DS_Store` and
/// `node_modules`.
async fn tar_create(dir: &Path, entries: &[String]) -> Result<Vec<u8>, String> {
    let output = Command::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .args(["-czf", "-", "--exclude", ".DS_Store", "--exclude", "node_modules", "-C"])
        .arg(dir)
        .arg("--")
        .args(entries)
        .output()
        .await
        .map_err(|error| format!("failed to run tar: {error}"))?;
    if !output.status.success() {
        return Err(format!("failed to pack {}: {}", dir.display(), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(output.stdout)
}

/// Unpacks the gzip'd tar `archive` into `dir`, which must exist.
async fn tar_extract(archive: &[u8], dir: &Path) -> Result<(), String> {
    let mut child = Command::new("tar")
        .args(["-xzf", "-", "-C"])
        .arg(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run tar: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("failed to open the stdin of tar")?;
    let archive = archive.to_vec();
    let writer = tokio::spawn(async move {
        stdin.write_all(&archive).await?;
        stdin.shutdown().await
    });
    let output = child.wait_with_output().await.map_err(|error| format!("failed to run tar: {error}"))?;
    let _ = writer.await;
    if !output.status.success() {
        return Err(format!("failed to unpack into {}: {}", dir.display(), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_leaves_plain_words_and_quotes_the_rest() {
        assert_eq!(shell_quote("refs/hunt/abc"), "refs/hunt/abc");
        assert_eq!(shell_quote("two words"), "'two words'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_command("sudo", &["-n", "hunt-ctl", "prepare", "a b"]), "sudo -n hunt-ctl prepare 'a b'");
    }

    #[test]
    fn relay_activity_takes_a_running_turn_as_now_and_else_the_last_turn_end() {
        let now = chrono::DateTime::from_timestamp_millis(1_760_000_000_000).unwrap();
        let ended = serde_json::json!({ "turn": "idle", "lastTurnEndedAt": 1_759_000_000_000_i64, "lastClientActivityAt": 1_759_900_000_000_i64 });
        assert_eq!(relay_activity(&ended, now), chrono::DateTime::from_timestamp_millis(1_759_000_000_000));
        assert_eq!(relay_activity(&serde_json::json!({ "turn": "running", "lastTurnEndedAt": null }), now), Some(now));
        assert_eq!(relay_activity(&serde_json::json!({ "turn": "idle", "lastTurnEndedAt": null }), now), None);
        assert_eq!(relay_activity(&serde_json::Value::Null, now), None);
    }

    #[test]
    fn token_input_puts_each_token_on_its_own_line() {
        assert_eq!(token_input("sk-ant-oat01", Some("github_pat_1")), "sk-ant-oat01\ngithub_pat_1\n");
        assert_eq!(token_input("sk-ant-oat01", None), "sk-ant-oat01\n\n");
        assert_eq!(token_input("", None), "\n\n");
    }

    #[test]
    fn read_hunt_md_reads_the_file_and_rejects_a_large_one() {
        let dir = std::env::temp_dir().join(format!("hunt-md-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_hunt_md(&dir), Ok(None));

        std::fs::write(dir.join("HUNT.md"), "# Preview\n").unwrap();
        assert_eq!(read_hunt_md(&dir), Ok(Some("# Preview\n".to_string())));

        std::fs::write(dir.join("HUNT.md"), "x".repeat(20 * 1024 + 1)).unwrap();
        assert_eq!(read_hunt_md(&dir), Err("failed to read HUNT.md: it must be a file of at most 20480 bytes".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn vm_settings_name_the_session_vm_and_validate_template_machine_type_and_domain() {
        let id = uuid::Uuid::parse_str("ab12cd34-0000-4000-8000-000000000001").unwrap();
        let settings = VmSettings {
            project: "acme".into(),
            zone: "europe-west1-c".into(),
            gateway: "vm-hunt-medc".into(),
            template: "tpl-hunt-session".into(),
            machine_type: None,
            preview_domain: " Hunt.Example.com ".into(),
        };
        assert_eq!(settings.session_vm(id), VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() });
        assert_eq!(settings.gateway_vm().instance, "vm-hunt-medc");
        assert_eq!(settings.validate(id), Ok("hunt.example.com".to_string()));
        assert!(VmSettings { machine_type: Some("e2-standard-8".into()), ..settings.clone() }.validate(id).is_ok());
        assert!(VmSettings { machine_type: Some("e2 standard".into()), ..settings.clone() }.validate(id).is_err());
        assert!(VmSettings { template: "".into(), ..settings.clone() }.validate(id).is_err());
        assert!(VmSettings { gateway: "".into(), ..settings.clone() }.validate(id).is_err());
        assert!(VmSettings { preview_domain: "".into(), ..settings }.validate(id).is_err());
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
