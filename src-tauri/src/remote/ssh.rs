//! OpenSSH to the VM of remote sessions through an IAP tunnel (`gcloud compute start-iap-tunnel` as the ProxyCommand)
//! with a key of Hunt's own that is registered with OS Login. Short commands share one multiplexed connection; the
//! ACP stream of a session gets a tunnel of its own, because `AcpAgent` kills its whole process group when the session
//! ends and would take a shared master down with it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::{gcloud, shell_quote, VmRef};

/// OS Login user names by gcloud project, looked up once per app run.
static USERS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Socket of the shared connection; `%C` hashes host, port and user, and the path stays below the 104-byte limit
/// of Unix sockets.
const CONTROL_PATH: &str = "~/.ssh/hunt-%C";

/// SSH access to one VM as the OS Login user of the gcloud account.
pub struct Ssh {
    vm: VmRef,
    user: String,
    key: PathBuf,
    known_hosts: PathBuf,
}

impl Ssh {
    /// Prepares access to `vm`: Hunt's key in `dir` (created on first use, kept outside paths with spaces because ssh
    /// options cannot hold them) is registered with OS Login, and the account's POSIX user name is looked up.
    pub async fn open(vm: &VmRef, dir: &Path) -> Result<Self, String> {
        vm.validate()?;
        create_private_dir(dir)?;
        if let Some(ssh_dir) = dir.parent() {
            create_private_dir(ssh_dir)?;
        }
        let key = dir.join("id_ed25519");
        if !key.exists() {
            let output = Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-C", "hunt", "-f"])
                .arg(&key)
                .output()
                .await
                .map_err(|error| format!("failed to run ssh-keygen: {error}"))?;
            if !output.status.success() {
                return Err(format!("failed to create the SSH key for the remote VM: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        }
        let user = os_login_user(vm, &key.with_extension("pub")).await?;
        Ok(Self { vm: vm.clone(), user, key, known_hosts: dir.join("known_hosts") })
    }

    /// The options every connection uses; `shared` connections go through the multiplexed master.
    fn options(&self, shared: bool) -> Vec<String> {
        let proxy = format!(
            "gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project={} --zone={} --verbosity=warning",
            self.vm.project, self.vm.zone
        );
        let mut options: Vec<String> = vec!["-T".into(), "-l".into(), self.user.clone(), "-i".into(), self.key.display().to_string()];
        let settings = [
            "IdentitiesOnly=yes".to_string(),
            "IdentityAgent=none".to_string(),
            "BatchMode=yes".to_string(),
            format!("ProxyCommand={proxy}"),
            format!("HostKeyAlias={}.{}.{}", self.vm.instance, self.vm.zone, self.vm.project),
            format!("UserKnownHostsFile={}", self.known_hosts.display()),
            "StrictHostKeyChecking=accept-new".to_string(),
            "ServerAliveInterval=15".to_string(),
            "ServerAliveCountMax=3".to_string(),
            "ConnectTimeout=90".to_string(),
        ];
        for setting in settings {
            options.push("-o".into());
            options.push(setting);
        }
        let control = if shared {
            vec!["ControlMaster=auto".to_string(), "ControlPersist=600".to_string(), format!("ControlPath={CONTROL_PATH}")]
        } else {
            vec!["ControlPath=none".to_string()]
        };
        for setting in control {
            options.push("-o".into());
            options.push(setting);
        }
        options
    }

    /// Arguments of `ssh` that run `command` on the VM over a connection of its own, for a long-lived stream.
    pub fn stream_args(&self, command: &str) -> Vec<String> {
        let mut args = self.options(false);
        args.push(self.vm.instance.clone());
        args.push(command.to_string());
        args
    }

    /// Runs `command` on the VM and returns its standard output as text.
    pub async fn run(&self, command: &str) -> Result<String, String> {
        let output = self.run_with_input(command, &[]).await?;
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    /// Runs `command` on the VM with `input` on its standard input and returns its standard output.
    pub async fn run_with_input(&self, command: &str, input: &[u8]) -> Result<Vec<u8>, String> {
        let mut child = Command::new("ssh")
            .args(self.options(true))
            .arg(&self.vm.instance)
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("failed to run ssh: {error}"))?;
        let mut stdin = child.stdin.take().ok_or("failed to open the stdin of ssh")?;
        let input = input.to_vec();
        let writer = tokio::spawn(async move {
            stdin.write_all(&input).await?;
            stdin.shutdown().await
        });
        let output = child.wait_with_output().await.map_err(|error| format!("failed to run ssh: {error}"))?;
        // A command that exits without reading its input closes the pipe early; its exit status tells what happened.
        let _ = writer.await;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("failed to run `{}` on the VM {}: {stderr}", first_word(command), self.vm.instance));
        }
        Ok(output.stdout)
    }

    /// The value of `GIT_SSH_COMMAND` that lets git reach the VM the way `run` does.
    pub fn git_ssh_command(&self) -> String {
        let mut command = String::from("ssh");
        for option in self.options(true) {
            command.push(' ');
            command.push_str(&shell_quote(&option));
        }
        command
    }

    /// The git URL of the repository at the absolute `path` on the VM.
    pub fn git_url(&self, path: &str) -> String {
        format!("ssh://{}{}", self.vm.instance, path)
    }
}

/// The first word of a remote command, for error messages that must not repeat whole scripts.
fn first_word(command: &str) -> String {
    command.split_whitespace().take(3).collect::<Vec<_>>().join(" ")
}

/// Creates `dir` with mode 0700 when it is missing; ssh refuses keys and sockets in directories others can write.
fn create_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|error| format!("failed to restrict {}: {error}", dir.display()))
}

/// The POSIX user name of the gcloud account; registers `public_key` with OS Login on the first call of an app run.
async fn os_login_user(vm: &VmRef, public_key: &Path) -> Result<String, String> {
    if let Some(user) = USERS.lock().unwrap().as_ref().and_then(|users| users.get(&vm.project).cloned()) {
        return Ok(user);
    }
    if gcloud(&["auth", "print-access-token"]).await.is_err() {
        return Err("failed to reach Google Cloud: gcloud is not logged in, run `gcloud auth login`".into());
    }
    let key_file = format!("--key-file={}", public_key.display());
    let project = format!("--project={}", vm.project);
    gcloud(&["compute", "os-login", "ssh-keys", "add", &key_file, &project, "--format=none"]).await?;
    let output = gcloud(&["compute", "os-login", "describe-profile", &project, "--format=value(posixAccounts[0].username)"]).await?;
    let user = output.trim().to_string();
    if user.is_empty() {
        return Err("failed to read the OS Login user of the gcloud account".into());
    }
    USERS.lock().unwrap().get_or_insert_with(HashMap::new).insert(vm.project.clone(), user.clone());
    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh() -> Ssh {
        Ssh {
            vm: VmRef { project: "acme-staging".into(), zone: "europe-west1-c".into(), instance: "vm-hunt".into() },
            user: "jane_example_com".into(),
            key: PathBuf::from("/Users/jane/.ssh/hunt/id_ed25519"),
            known_hosts: PathBuf::from("/Users/jane/.ssh/hunt/known_hosts"),
        }
    }

    #[test]
    fn stream_args_use_their_own_tunnel_and_end_with_host_and_command() {
        let args = ssh().stream_args("sudo -n -u hunt socat - UNIX-CONNECT:/srv/hunt/sockets/x/acp.sock");
        assert!(args.contains(&"ControlPath=none".to_string()));
        assert!(!args.iter().any(|arg| arg.starts_with("ControlMaster")));
        assert_eq!(&args[args.len() - 2..], ["vm-hunt", "sudo -n -u hunt socat - UNIX-CONNECT:/srv/hunt/sockets/x/acp.sock"]);
        assert!(args.contains(&"ProxyCommand=gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project=acme-staging --zone=europe-west1-c --verbosity=warning".to_string()));
    }

    #[test]
    fn git_ssh_command_quotes_options_for_the_shell_and_shares_the_master() {
        let command = ssh().git_ssh_command();
        assert!(command.starts_with("ssh -T -l jane_example_com -i /Users/jane/.ssh/hunt/id_ed25519"));
        assert!(command.contains("'ProxyCommand=gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project=acme-staging --zone=europe-west1-c --verbosity=warning'"));
        assert!(command.contains("'ControlPath=~/.ssh/hunt-%C'"));
        assert_eq!(ssh().git_url("/srv/worktrees/0123"), "ssh://vm-hunt/srv/worktrees/0123");
    }
}
