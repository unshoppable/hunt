//! Terminals on the VM of a remote session. The services of the repository's hunt.json run as systemd units on the VM
//! and log to `~/logs/<name>.log`; a terminal follows such a log. The agents run their other long-running processes in
//! the tmux session `app`, one window per process, which logs to `~/logs/<window name>.log` through the VM's
//! `/etc/tmux.conf` (`apps/session/vm/tmux.conf`); a terminal shows one of these windows and takes input. Such a
//! terminal is OpenSSH in a pseudo terminal on this Mac (`terminal/interactive.rs`). Knows nothing about Tauri;
//! `session/commands/terminal.rs` owns the commands and forwards the output to the window.

use std::path::Path;

use uuid::Uuid;

use super::preview::is_service_name;
use super::ssh::Ssh;
use super::RemoteTarget;
use crate::platform::shell::shell_command;
use crate::terminal::interactive::TerminalTarget;
use crate::terminal::tmux::{self, Machine, TmuxWindow};

/// Lines of a service's log a terminal shows before it follows the log.
const LOG_LINES: &str = "5000";

/// The `ssh` arguments of the terminal `terminal_id` showing `process` on the VM of the remote session `target`; the one
/// place that picks the VM a terminal connects to.
pub async fn attach_args(target: &RemoteTarget, process: &TerminalTarget, terminal_id: Uuid, ssh_dir: &Path) -> Result<Vec<String>, String> {
    let command = remote_command(process, &tmux::view_name(terminal_id))?;
    let ssh = Ssh::open(&target.vm, ssh_dir).await?;
    Ok(ssh.terminal_args(&command))
}

/// The windows of the tmux session `app` on the VM in their order; none while the session does not exist.
pub async fn list_windows(ssh: &Ssh) -> Result<Vec<TmuxWindow>, String> {
    Ok(tmux::parse_windows(&ssh.run(&as_agent(&["sh", "-c", &tmux::list_windows_script("tmux")])).await?))
}

/// Starts a login shell in a new window of the tmux session `app` on the VM, created when it does not exist, and returns
/// the window's ID. The window is called `shell`, or `shell-<n>` when that name is taken; like every window there, it
/// logs to `~/logs/<name>.log` (the VM's `/etc/tmux.conf`).
pub async fn open_shell_window(ssh: &Ssh) -> Result<String, String> {
    let name = tmux::free_window_name(&list_windows(ssh).await?, "shell");
    window_id_from(&run_script(ssh, &format!("{}echo \"$id\"", tmux::new_window_script("tmux", &name, None, None))).await?, "open a shell")
}

/// Runs the package.json script `script` through npm in the folder `folder` on the VM and returns the ID of its window.
/// The window stays open with the exit code once the script ends; the script's window that exists already is shown as
/// it is while the script runs, and runs it again once it ended.
pub async fn open_script_window(ssh: &Ssh, folder: &str, script: &str) -> Result<String, String> {
    let windows = list_windows(ssh).await?;
    if let Some(window) = tmux::script_window(&windows, script, folder) {
        if window.is_dead {
            run_script(ssh, &tmux::rerun_script("tmux", &window.id, folder, &script_command(script), None)?).await?;
        }
        return Ok(window.id.clone());
    }
    let name = tmux::free_window_name(&windows, &tmux::safe_window_name(script));
    let output = run_script(ssh, &tmux::script_window_script("tmux", &name, folder, script, &script_command(script), None)).await?;
    window_id_from(&output, "run the script")
}

/// Runs the hunt.json check `check` with the command line `command` in the folder `folder` on the VM and returns the ID
/// of its window, `check-<check>` when it is new. The check's window that exists already runs it again, ending what
/// still runs there; the window stays open with the exit code once the check ends.
pub async fn run_check_window(ssh: &Ssh, folder: &str, check: &str, command: &str) -> Result<String, String> {
    let windows = list_windows(ssh).await?;
    let command = login_shell_command(command);
    if let Some(window) = tmux::check_window(&windows, check, None) {
        run_script(ssh, &tmux::rerun_script("tmux", &window.id, folder, &command, None)?).await?;
        return Ok(window.id.clone());
    }
    let name = tmux::free_window_name(&windows, &tmux::safe_window_name(&format!("check-{check}")));
    let output = run_script(ssh, &tmux::check_window_script("tmux", &name, folder, check, &command, None)).await?;
    window_id_from(&output, "run the check")
}

/// Ends the program of the window `id` on the VM and keeps the window with its output (`tmux::stop_script`).
pub async fn stop_window(ssh: &Ssh, id: &str) -> Result<(), String> {
    run_script(ssh, &tmux::stop_script("tmux", id)?).await.map(|_| ())
}

/// The history and the screen of the window `id` on the VM as plain text.
pub async fn capture_window(ssh: &Ssh, id: &str) -> Result<String, String> {
    run_script(ssh, &tmux::capture_script("tmux", id)?).await
}

/// Runs the script of the script window `id` on the VM again in the same window, which logs it as before.
pub async fn rerun_window(ssh: &Ssh, id: &str) -> Result<(), String> {
    let windows = list_windows(ssh).await?;
    let (script, folder) = tmux::script_of(&windows, id)?;
    run_script(ssh, &tmux::rerun_script("tmux", id, folder, &script_command(script), None)?).await.map(|_| ())
}

/// The command a package.json script window on the VM runs: the script through npm (`login_shell_command`).
fn script_command(script: &str) -> String {
    login_shell_command(&shell_command("npm", &["run", script]))
}

/// The command a window on the VM runs for the shell command line `command_line`: the line in a login shell of the user
/// `agent`, which takes the agent's environment from `/etc/profile.d/hunt.sh`.
fn login_shell_command(command_line: &str) -> String {
    shell_command("bash", &["-l", "-c", command_line])
}

/// Runs the `sh` script `script` on the VM as the user `agent` and returns what it printed.
async fn run_script(ssh: &Ssh, script: &str) -> Result<String, String> {
    ssh.run(&as_agent(&["sh", "-c", script])).await
}

/// The window ID a window script printed last; `action` names what failed otherwise.
fn window_id_from(output: &str, action: &str) -> Result<String, String> {
    let id = output.trim().lines().last().unwrap_or_default();
    tmux::ensure_window_id(id).map_err(|_| format!("failed to {action}: tmux answered {output:?}"))?;
    Ok(id.to_string())
}

/// Ends the window `id` of the tmux session `app` on the VM and the processes in it.
pub async fn kill_window(ssh: &Ssh, id: &str) -> Result<(), String> {
    tmux::ensure_window_id(id)?;
    ssh.run(&as_agent(&["tmux", "kill-window", "-t", id])).await.map(|_| ())
}

/// The command a terminal runs on the VM to show `process`, as the user `agent`: a service's log from its last lines
/// on, followed across the rename at the service's next start, or a window in a view of its own (`tmux::view_args`).
fn remote_command(process: &TerminalTarget, view: &str) -> Result<String, String> {
    match process {
        TerminalTarget::Service { name } => {
            if !is_service_name(name) {
                return Err(format!("failed to open the terminal: {name:?} is no service name"));
            }
            Ok(as_agent(&["tail", "-n", LOG_LINES, "-F", "--", &format!("logs/{name}.log")]))
        }
        TerminalTarget::Window { id, machine: Machine::Vm } => {
            let mut args = vec!["tmux".to_string()];
            args.extend(tmux::view_args(view, id)?);
            Ok(as_agent(&args.iter().map(String::as_str).collect::<Vec<_>>()))
        }
        TerminalTarget::Window { machine: Machine::Desktop, .. } => Err("failed to open the terminal: the window runs on this Mac".to_string()),
    }
}

/// `args` run on the VM as the user `agent`, in its login environment and home folder.
fn as_agent(args: &[&str]) -> String {
    let mut sudo = vec!["-n", "-iu", "agent"];
    sudo.extend_from_slice(args);
    shell_command("sudo", &sudo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_command_follows_a_service_log_and_shows_a_window_in_a_view_of_its_own() {
        let service = TerminalTarget::Service { name: "web-api".into() };
        assert_eq!(remote_command(&service, "hunt-view-1").unwrap(), "sudo -n -iu agent tail -n 5000 -F -- logs/web-api.log");
        let window = TerminalTarget::Window { id: "@12".into(), machine: Machine::Vm };
        assert_eq!(
            remote_command(&window, "hunt-view-1").unwrap(),
            "sudo -n -iu agent tmux -u new-session -t =app -s hunt-view-1 \
             ';' set-option -t hunt-view-1 destroy-unattached on ';' set-option -t hunt-view-1 status off \
             ';' set-option -t hunt-view-1 mouse on ';' select-window -t hunt-view-1:@12"
        );
    }

    #[test]
    fn remote_command_refuses_other_names_ids_and_windows_of_this_mac() {
        for name in ["../x", "Web", "web;rm", ""] {
            assert!(remote_command(&TerminalTarget::Service { name: name.into() }, "view").is_err(), "{name}");
        }
        for id in ["", "@", "12", "@1x", "@-1", "@1 ;kill-server", "app:@1"] {
            assert!(remote_command(&TerminalTarget::Window { id: id.into(), machine: Machine::Vm }, "view").is_err(), "{id}");
        }
        assert!(remote_command(&TerminalTarget::Window { id: "@1".into(), machine: Machine::Desktop }, "view").is_err());
    }

    #[test]
    fn a_script_window_on_the_vm_runs_npm_in_a_login_shell_of_the_agent() {
        assert_eq!(script_command("start:server"), "bash -l -c 'npm run start:server'");
        assert_eq!(script_command("a b; rm"), "bash -l -c 'npm run '\\''a b; rm'\\'''");
    }
}
