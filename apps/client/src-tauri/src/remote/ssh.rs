//! OpenSSH to the VMs of remote sessions and to the gateway through an IAP tunnel (`gcloud compute start-iap-tunnel` as
//! the ProxyCommand) with a key of Hunt's own that is registered with OS Login. Short commands and the calls of the
//! gateway API share one multiplexed connection per VM; the ACP stream of a session gets a tunnel of its own, because
//! `AcpAgent` kills its whole process group when the session ends and would take a shared master down with it.
//! Terminals join the shared connection while one is open, but never start it, for the same reason.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::{gcloud, shell_quote, VmRef};

/// OS Login user names by gcloud project, looked up once per app run.
static USERS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Socket of the shared connection; `%C` hashes host, port and user, and the path stays below the 104-byte limit
/// of Unix sockets.
const CONTROL_PATH: &str = "~/.ssh/hunt-%C";

/// How a connection relates to the multiplexed master.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Connection {
    /// Through the master; the first such connection starts it, and it stays for `ControlPersist`.
    Shared,
    /// Over a tunnel of its own.
    Own,
    /// An interactive terminal with a remote TTY: through the master while one is open, else over a tunnel of its own.
    /// It never becomes the master, so ending the terminal's process group leaves the other connections alone.
    Terminal,
}

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

    /// The options every connection uses, with the TTY and multiplexing settings of `connection`.
    fn options(&self, connection: Connection) -> Vec<String> {
        let proxy = format!(
            "gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project={} --zone={} --verbosity=warning",
            self.vm.project, self.vm.zone
        );
        let tty = if connection == Connection::Terminal { "-tt" } else { "-T" };
        let mut options: Vec<String> = vec![tty.into(), "-l".into(), self.user.clone(), "-i".into(), self.key.display().to_string()];
        let settings = [
            "IdentitiesOnly=yes".to_string(),
            "IdentityAgent=none".to_string(),
            "BatchMode=yes".to_string(),
            format!("ProxyCommand={proxy}"),
            format!("HostKeyAlias={}", host_key_alias(&self.vm)),
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
        let control = match connection {
            Connection::Shared => {
                vec!["ControlMaster=auto".to_string(), "ControlPersist=600".to_string(), format!("ControlPath={CONTROL_PATH}")]
            }
            Connection::Own => vec!["ControlPath=none".to_string()],
            // Without an escape character, `~.` typed at the start of a line reaches the remote program.
            Connection::Terminal => {
                vec!["ControlMaster=no".to_string(), format!("ControlPath={CONTROL_PATH}"), "EscapeChar=none".to_string()]
            }
        };
        for setting in control {
            options.push("-o".into());
            options.push(setting);
        }
        options
    }

    /// Arguments of `ssh` that run `command` on the VM over a connection of its own, for a long-lived stream.
    pub fn stream_args(&self, command: &str) -> Vec<String> {
        let mut args = self.options(Connection::Own);
        args.push(self.vm.instance.clone());
        args.push(command.to_string());
        args
    }

    /// Arguments of `ssh` that run the interactive `command` on the VM in a remote TTY; `ssh` must run in a local
    /// pseudo terminal, whose size changes it passes on.
    pub fn terminal_args(&self, command: &str) -> Vec<String> {
        let mut args = self.options(Connection::Terminal);
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
            .args(self.options(Connection::Shared))
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

    /// Runs `command` on the VM with `input` on its standard input and hands each line of its standard output to
    /// `on_line` as it arrives, without the line break; a last line without one counts too. Fails like `run_with_input`
    /// when the command fails, after every line was handed over.
    pub async fn run_streaming(&self, command: &str, input: &[u8], on_line: &mut (dyn FnMut(&str) + Send)) -> Result<(), String> {
        let mut child = Command::new("ssh")
            .args(self.options(Connection::Shared))
            .arg(&self.vm.instance)
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("failed to run ssh: {error}"))?;
        let mut stdin = child.stdin.take().ok_or("failed to open the stdin of ssh")?;
        let mut stdout = child.stdout.take().ok_or("failed to open the stdout of ssh")?;
        let mut stderr = child.stderr.take().ok_or("failed to open the stderr of ssh")?;
        let input = input.to_vec();
        let writer = tokio::spawn(async move {
            stdin.write_all(&input).await?;
            stdin.shutdown().await
        });
        let errors = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes).await;
            bytes
        });

        let mut pending = Vec::new();
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            let read = stdout.read(&mut chunk).await.map_err(|error| format!("failed to read the output of `{}`: {error}", first_word(command)))?;
            if read == 0 {
                break;
            }
            for line in split_lines(&mut pending, &chunk[..read]) {
                on_line(&line);
            }
        }
        if !pending.is_empty() {
            on_line(&String::from_utf8_lossy(&pending));
        }
        let status = child.wait().await.map_err(|error| format!("failed to run ssh: {error}"))?;
        // A command that exits without reading its input closes the pipe early; its exit status tells what happened.
        let _ = writer.await;
        let stderr = errors.await.unwrap_or_default();
        if !status.success() {
            let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(format!("failed to run `{}` on the VM {}: {stderr}", first_word(command), self.vm.instance));
        }
        Ok(())
    }

    /// The value of `GIT_SSH_COMMAND` that lets git reach the VM the way `run` does.
    pub fn git_ssh_command(&self) -> String {
        let mut command = String::from("ssh");
        for option in self.options(Connection::Shared) {
            command.push(' ');
            command.push_str(&shell_quote(&option));
        }
        command
    }

    /// The git URL of the repository at the absolute `path` on the VM.
    pub fn git_url(&self, path: &str) -> String {
        format!("ssh://{}{}", self.vm.instance, path)
    }

    /// The rsync location (`<host>:<path>`) of the absolute `path` on the VM, which rsync reaches with
    /// `git_ssh_command` as its `-e`.
    pub fn rsync_location(&self, path: &str) -> String {
        format!("{}:{}", self.vm.instance, path)
    }
}

/// The name `vm`'s host key is recorded under in Hunt's known hosts.
fn host_key_alias(vm: &VmRef) -> String {
    format!("{}.{}.{}", vm.instance, vm.zone, vm.project)
}

/// Forgets the host key recorded for `vm` in the known hosts in `dir`; a VM created anew under the name of a deleted
/// one has a key of its own, which ssh would otherwise refuse.
pub async fn forget_host_key(vm: &VmRef, dir: &Path) -> Result<(), String> {
    let known_hosts = dir.join("known_hosts");
    if !known_hosts.exists() {
        return Ok(());
    }
    let output = Command::new("ssh-keygen")
        .arg("-R")
        .arg(host_key_alias(vm))
        .arg("-f")
        .arg(&known_hosts)
        .output()
        .await
        .map_err(|error| format!("failed to run ssh-keygen: {error}"))?;
    if !output.status.success() {
        return Err(format!("failed to forget the host key of the VM {}: {}", vm.instance, String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

/// Appends `chunk` to `pending` and takes the complete lines out of it, without their `\n` or `\r\n`; what follows the
/// last line break stays in `pending` for the next chunk. Bytes that are no UTF-8 become U+FFFD.
fn split_lines(pending: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    pending.extend_from_slice(chunk);
    let Some(end) = pending.iter().rposition(|byte| *byte == b'\n') else { return Vec::new() };
    let complete: Vec<u8> = pending.drain(..=end).collect();
    complete[..end]
        .split(|byte| *byte == b'\n')
        .map(|line| String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line)).into_owned())
        .collect()
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
        let args = ssh().stream_args("sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock");
        assert!(args.contains(&"ControlPath=none".to_string()));
        assert!(!args.iter().any(|arg| arg.starts_with("ControlMaster")));
        assert_eq!(&args[args.len() - 2..], ["vm-hunt", "sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock"]);
        assert!(args.contains(&"ProxyCommand=gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project=acme-staging --zone=europe-west1-c --verbosity=warning".to_string()));
    }

    #[test]
    fn terminal_args_request_a_tty_and_join_the_master_without_starting_it() {
        let args = ssh().terminal_args("sudo -n -iu agent tmux -u new-session -A -s app");
        assert_eq!(args[0], "-tt");
        assert!(!args.contains(&"-T".to_string()));
        assert!(args.contains(&"ControlMaster=no".to_string()));
        assert!(args.contains(&"ControlPath=~/.ssh/hunt-%C".to_string()));
        assert!(args.contains(&"EscapeChar=none".to_string()));
        assert!(!args.iter().any(|arg| arg.starts_with("ControlPersist")));
        assert_eq!(&args[args.len() - 2..], ["vm-hunt", "sudo -n -iu agent tmux -u new-session -A -s app"]);
    }

    #[tokio::test]
    async fn forget_host_key_removes_only_the_vms_entry() {
        let dir = tempfile::tempdir().unwrap();
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let vm = VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() };
        assert_eq!(forget_host_key(&vm, dir.path()).await, Ok(()));
        let other = format!("vm-hunt-s-00000000.europe-west1-c.acme {key}\n");
        std::fs::write(dir.path().join("known_hosts"), format!("vm-hunt-s-ab12cd34.europe-west1-c.acme {key}\n{other}")).unwrap();
        forget_host_key(&vm, dir.path()).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("known_hosts")).unwrap(), other);
    }

    #[test]
    fn split_lines_returns_complete_lines_and_keeps_the_rest_for_the_next_chunk() {
        let mut pending = Vec::new();
        assert_eq!(split_lines(&mut pending, b"{\"type\":\"pro"), Vec::<String>::new());
        assert_eq!(split_lines(&mut pending, b"gress\"}\n{\"type\":\"log\"}\r\n\n{\"ty"), ["{\"type\":\"progress\"}", "{\"type\":\"log\"}", ""]);
        assert_eq!(pending, b"{\"ty");
        assert_eq!(split_lines(&mut pending, b"pe\":\"result\"}\n"), ["{\"type\":\"result\"}"]);
        assert!(pending.is_empty());

        // A multibyte character split across two chunks arrives whole.
        let text = "Grüße\n".as_bytes();
        assert_eq!(split_lines(&mut pending, &text[..3]), Vec::<String>::new());
        assert_eq!(split_lines(&mut pending, &text[3..]), ["Grüße"]);
        assert_eq!(split_lines(&mut pending, b"\xff\n"), ["\u{fffd}"]);
    }

    #[test]
    fn git_ssh_command_quotes_options_for_the_shell_and_shares_the_master() {
        let command = ssh().git_ssh_command();
        assert!(command.starts_with("ssh -T -l jane_example_com -i /Users/jane/.ssh/hunt/id_ed25519"));
        assert!(command.contains("'ProxyCommand=gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project=acme-staging --zone=europe-west1-c --verbosity=warning'"));
        assert!(command.contains("'ControlPath=~/.ssh/hunt-%C'"));
        assert_eq!(ssh().git_url("/home/agent/app"), "ssh://vm-hunt/home/agent/app");
        assert_eq!(ssh().rsync_location("/home/agent/app"), "vm-hunt:/home/agent/app");
    }
}
