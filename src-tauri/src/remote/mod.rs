//! Sessions handed off to a VM: SSH through an IAP tunnel (`ssh.rs`), the VM's power state (`vm.rs`), the software
//! Hunt installs on it from this repository's `remote/` folder (`bundle.rs`), and moving a session's git state and
//! Claude Code transcript there and back (`handoff.rs`, `retrieve.rs`, `transcript.rs`). Knows nothing about Tauri;
//! `session/commands.rs` owns the commands.

pub mod bundle;
pub mod handoff;
pub mod preview;
pub mod retrieve;
pub mod ssh;
pub mod transcript;
pub mod vm;

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// A Compute Engine VM that runs remote sessions.
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

/// Where a session handed off to a VM runs, and what Hunt needs to reach it and to bring it back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    pub vm: VmRef,
    /// The session's worktree on the VM; its container sees it under the same path.
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
}

impl RemoteTarget {
    /// The permission mode the session gets back locally.
    pub fn restored_mode(&self) -> &str {
        self.local_mode.as_deref().unwrap_or("default")
    }
}

/// A step of a handoff, a retrieval or a connect that takes long enough to show in the UI.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteStep {
    StartingVm,
    Connecting,
    InstallingRuntime,
    TransferringCode,
    InstallingDependencies,
    StartingAgent,
    StoppingAgent,
    RetrievingCode,
    StartingPreview,
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

/// What `hunt-ctl start`, `clear` and `preview start` read on stdin: the Claude Code OAuth token a new container runs
/// Claude Code with (empty with the local login, which only a running container gets by with) and the GitHub token it
/// pushes and runs `gh` with (empty without one).
pub fn token_input(claude_token: &str, github_token: Option<&str>) -> String {
    format!("{claude_token}\n{}\n", github_token.unwrap_or_default())
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
    fn token_input_puts_each_token_on_its_own_line() {
        assert_eq!(token_input("sk-ant-oat01", Some("github_pat_1")), "sk-ant-oat01\ngithub_pat_1\n");
        assert_eq!(token_input("sk-ant-oat01", None), "sk-ant-oat01\n\n");
        assert_eq!(token_input("", None), "\n\n");
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
