//! Interactive terminals, one per process of the app: on the VM of a remote session, and on this Mac in the family's
//! tmux server (`crate::tmux`). The services of the repository's hunt.json run as systemd units on the VM and log to
//! `~/logs/<name>.log`; a terminal follows such a log. The agents run their other long-running processes in the tmux
//! session `app`, one window per process; a terminal shows one of these windows and takes input. A terminal is a
//! program in a local pseudo terminal (OpenSSH for the VM, the bundled tmux here), so the programs see a real TTY and
//! keep their colors. Knows nothing about Tauri; `session/commands.rs` owns the commands and forwards the output to the
//! window.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use uuid::Uuid;

use super::preview::is_service_name;
use super::ssh::Ssh;
use super::{shell_command, shell_quote};
use super::RemoteTarget;
use crate::tmux::{self, Machine, TmuxWindow};

/// Lines of a service's log a terminal shows before it follows the log.
const LOG_LINES: &str = "5000";

/// The terminal type the programs are told; xterm.js implements it, 256 colors included.
const TERM: &str = "xterm-256color";

/// Bytes read from the pseudo terminal at once; a busy terminal fills it, so its output arrives in few large chunks.
const READ_BUFFER_SIZE: usize = 64 * 1024;

/// How often the reader asks whether the program has ended once its terminal closed.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// What a terminal shows.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalTarget {
    /// The log of the hunt.json service `name` on the VM, read-only.
    Service { name: String },
    /// The window `id` of the tmux session `app` on `machine`.
    Window { id: String, machine: Machine },
}

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

/// A package.json script a new tmux window runs: `npm run <script>`, typed into its shell in the folder `directory`.
pub struct ScriptRun<'a> {
    pub directory: &'a str,
    pub script: &'a str,
}

/// Starts a shell in a new window of the tmux session `app` on the VM, created when it does not exist, and returns the
/// window's ID. Without `run` the window is called `shell`; with it, it is named after the script, starts in its folder
/// and runs it, and its shell stays once the script ends, so its output does too. A name that is taken gets a number
/// (`shell-2`), and the window logs to `~/logs/<name>.log` like the agent's windows.
pub async fn open_shell_window(ssh: &Ssh, run: Option<ScriptRun<'_>>) -> Result<String, String> {
    let windows = list_windows(ssh).await?;
    let output = ssh.run(&as_agent(&["sh", "-c", &shell_window_script(&windows, run)])).await?;
    let id = output.trim().lines().last().unwrap_or_default();
    tmux::ensure_window_id(id).map_err(|_| format!("failed to open a shell: tmux answered {output:?}"))?;
    Ok(id.to_string())
}

/// The `sh` script behind `open_shell_window` next to the windows `windows`, which prints the new window's ID last.
fn shell_window_script(windows: &[TmuxWindow], run: Option<ScriptRun<'_>>) -> String {
    let (base, folder, typed) = match run {
        None => ("shell".to_string(), None, String::new()),
        Some(run) => {
            let command = shell_command("npm", &["run", run.script]);
            let typed = format!(r#"tmux send-keys -t "$id" -l {} && tmux send-keys -t "$id" Enter && "#, shell_quote(&command));
            (tmux::script_window_name(run.script), Some(run.directory), typed)
        }
    };
    let name = tmux::free_window_name(windows, &base);
    let logged = format!(r#"mkdir -p logs && tmux pipe-pane -o -t "$id" {} && "#, shell_quote(&format!("cat >> ~/logs/{name}.log")));
    format!("{}{logged}{typed}echo \"$id\"", tmux::new_window_script("tmux", &name, folder, None))
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

/// Size of a terminal in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    fn to_pty(self) -> Result<PtySize, String> {
        if self.cols == 0 || self.rows == 0 {
            return Err(format!("failed to size the terminal: {} × {} cells hold nothing", self.cols, self.rows));
        }
        Ok(PtySize { cols: self.cols, rows: self.rows, pixel_width: 0, pixel_height: 0 })
    }
}

/// What a terminal reports from its reader thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    /// Bytes the program wrote, in order; a chunk may end inside a UTF-8 or an escape sequence.
    Output(Vec<u8>),
    /// The program ended with this exit code, `None` when a signal ended it; always the last event.
    Exit(Option<u32>),
}

/// A program running in a pseudo terminal. Dropping it hangs the program up.
pub struct Terminal {
    master: Box<dyn MasterPty + Send>,
    input: Sender<Vec<u8>>,
    /// Shared with the reader thread, which reaps the program; holding the lock keeps its process ID from being reused
    /// between the check whether it still runs and the signal.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl Terminal {
    /// Starts `program` with `args` in a pseudo terminal of `size`, in the folder `cwd` (else Hunt's own), without the
    /// environment variables `removed_env`. A thread of its own hands what the program writes and then its end to
    /// `on_event`.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: Option<&Path>,
        removed_env: &[String],
        size: TerminalSize,
        on_event: impl FnMut(TerminalEvent) + Send + 'static,
    ) -> Result<Self, String> {
        let pair = native_pty_system().openpty(size.to_pty()?).map_err(|error| format!("failed to open a pseudo terminal: {error}"))?;
        let reader = pair.master.try_clone_reader().map_err(|error| format!("failed to read the pseudo terminal: {error}"))?;
        let writer = pair.master.take_writer().map_err(|error| format!("failed to write to the pseudo terminal: {error}"))?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        for name in removed_env {
            command.env_remove(name);
        }
        command.env("TERM", TERM);
        let child = pair.slave.spawn_command(command).map_err(|error| format!("failed to run {program} in a pseudo terminal: {error}"))?;
        // The program now holds the only other end, so reading ends once it and everything it started let go of it.
        drop(pair.slave);

        let child = Arc::new(Mutex::new(child));
        let (input, inputs) = mpsc::channel();
        let terminal = Terminal { master: pair.master, input, child: child.clone() };
        let writing = thread::Builder::new()
            .name("terminal-writer".into())
            .spawn(move || write_input(writer, inputs))
            .map_err(|error| format!("failed to start writing to the terminal: {error}"))?;
        thread::Builder::new()
            .name("terminal-reader".into())
            .spawn(move || read_output(reader, child, writing, on_event))
            .map_err(|error| format!("failed to start reading the terminal: {error}"))?;
        Ok(terminal)
    }

    /// Hands `data` to the program as typed input.
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.input.send(data).map_err(|_| "failed to write to the terminal: its program has ended".to_string())
    }

    /// Changes the size the program sees; it receives `SIGWINCH`, and ssh passes the size on to the remote TTY.
    pub fn resize(&self, size: TerminalSize) -> Result<(), String> {
        self.master.resize(size.to_pty()?).map_err(|error| format!("failed to resize the terminal: {error}"))
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap();
        // A program that has ended may be reaped already, and its process ID may then belong to another process.
        if let Ok(None) = child.try_wait() {
            let _ = child.clone_killer().kill();
        }
    }
}

/// Writes what arrives on `inputs` until the terminal is dropped or the program stops reading, and returns the writer
/// instead of dropping it: dropping it sends end-of-file (a newline and ⌃D), which must not reach a running program.
fn write_input(mut writer: Box<dyn Write + Send>, inputs: Receiver<Vec<u8>>) -> Box<dyn Write + Send> {
    for data in inputs {
        if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
            break;
        }
    }
    writer
}

/// Hands the program's output to `on_event` until the pseudo terminal closes, then its exit code. The writer of
/// `writing` is dropped only after the program has ended.
fn read_output(
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    writing: JoinHandle<Box<dyn Write + Send>>,
    mut on_event: impl FnMut(TerminalEvent),
) {
    let mut buffer = vec![0; READ_BUFFER_SIZE];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => on_event(TerminalEvent::Output(buffer[..count].to_vec())),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            // A pseudo terminal whose other end closed reads as EIO.
            Err(_) => break,
        }
    }
    drop(reader);
    // Polls instead of blocking in `wait`, so `Terminal::drop` never waits for the lock.
    let code = loop {
        match child.lock().unwrap().try_wait() {
            Ok(Some(status)) => break status.signal().is_none().then(|| status.exit_code()),
            Ok(None) => {}
            Err(_) => break None,
        }
        thread::sleep(EXIT_POLL_INTERVAL);
    };
    on_event(TerminalEvent::Exit(code));
    let _ = writing.join();
}

/// The open terminals by ID, each with the label of the window that shows it.
#[derive(Default)]
pub struct TerminalRegistry {
    terminals: Mutex<HashMap<Uuid, (String, Terminal)>>,
}

impl TerminalRegistry {
    /// Keeps `terminal` as `id` for the window `owner`. An ID in use is an error, and `terminal` ends.
    pub fn insert(&self, id: Uuid, owner: &str, terminal: Terminal) -> Result<(), String> {
        let mut terminals = self.terminals.lock().unwrap();
        if terminals.contains_key(&id) {
            return Err(format!("failed to open the terminal {id}: the ID is in use"));
        }
        terminals.insert(id, (owner.to_string(), terminal));
        Ok(())
    }

    pub fn write(&self, id: Uuid, data: Vec<u8>) -> Result<(), String> {
        self.with_terminal(id, |terminal| terminal.write(data))
    }

    pub fn resize(&self, id: Uuid, size: TerminalSize) -> Result<(), String> {
        self.with_terminal(id, |terminal| terminal.resize(size))
    }

    /// Ends terminal `id`; an ID that is not open is no error, so closing twice is harmless.
    pub fn close(&self, id: Uuid) {
        let closed = self.terminals.lock().unwrap().remove(&id);
        drop(closed);
    }

    /// Ends every terminal of the window `owner`, e.g. when it closes or loads its page again.
    pub fn close_owned_by(&self, owner: &str) {
        let closed: Vec<_> = self.terminals.lock().unwrap().extract_if(|_, (candidate, _)| candidate == owner).collect();
        drop(closed);
    }

    pub fn close_all(&self) {
        let closed = std::mem::take(&mut *self.terminals.lock().unwrap());
        drop(closed);
    }

    fn with_terminal(&self, id: Uuid, action: impl FnOnce(&Terminal) -> Result<(), String>) -> Result<(), String> {
        let terminals = self.terminals.lock().unwrap();
        let (_, terminal) = terminals.get(&id).ok_or_else(|| format!("failed to reach the terminal {id}: it is not open"))?;
        action(terminal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };
    const TIMEOUT: Duration = Duration::from_secs(10);

    /// Runs `script` with `/bin/sh` in a terminal whose events arrive on the returned receiver.
    fn shell(script: &str) -> (Terminal, Receiver<TerminalEvent>) {
        let (events, received) = mpsc::channel();
        let args = vec!["-c".to_string(), script.to_string()];
        let terminal = Terminal::spawn("/bin/sh", &args, None, &[], SIZE, move |event| {
            let _ = events.send(event);
        })
        .unwrap();
        (terminal, received)
    }

    /// The output up to the exit event, and the exit code.
    fn until_exit(events: &Receiver<TerminalEvent>) -> (String, Option<u32>) {
        let mut output = Vec::new();
        loop {
            match events.recv_timeout(TIMEOUT).expect("the terminal did not end in time") {
                TerminalEvent::Output(bytes) => output.extend(bytes),
                TerminalEvent::Exit(code) => return (String::from_utf8_lossy(&output).into_owned(), code),
            }
        }
    }

    #[test]
    fn spawn_passes_the_output_with_its_escape_sequences_and_the_exit_code() {
        let (_terminal, events) = shell(r#"printf '\033[31m%s\033[0m' "$TERM"; exit 3"#);
        let (output, code) = until_exit(&events);
        assert_eq!(output, "\u{1b}[31mxterm-256color\u{1b}[0m");
        assert_eq!(code, Some(3));
    }

    #[test]
    fn write_reaches_the_program_and_resize_changes_the_size_it_sees() {
        let (terminal, events) = shell(r#"read line; echo "got:$line"; stty size"#);
        terminal.resize(TerminalSize { cols: 100, rows: 30 }).unwrap();
        terminal.write(b"hello\n".to_vec()).unwrap();
        let (output, code) = until_exit(&events);
        assert!(output.contains("got:hello\r\n"), "{output:?}");
        assert!(output.contains("30 100"), "{output:?}");
        assert_eq!(code, Some(0));
        assert!(terminal.resize(TerminalSize { cols: 0, rows: 30 }).is_err());
    }

    #[test]
    fn dropping_a_terminal_hangs_its_program_up_without_sending_input() {
        let (terminal, events) = shell(r#"trap 'exit 7' HUP; read line; echo "read:$line" > /dev/null; exit 9"#);
        thread::sleep(Duration::from_millis(200));
        drop(terminal);
        let (_, code) = until_exit(&events);
        assert_eq!(code, Some(7));
    }

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
    fn shell_window_script_logs_the_window_and_types_a_script_into_it_in_its_folder() {
        let shell = TmuxWindow { id: "@1".into(), name: "shell".into(), script: None, is_dead: false, exit_code: None, folder: None };
        assert_eq!(
            shell_window_script(&[shell], None),
            "id=$(if tmux has-session -t =app 2>/dev/null; then tmux new-window -d -t =app: -n shell-2 -P -F '#{window_id}'; \
             else tmux new-session -d -s app -n shell-2 -P -F '#{window_id}'; fi) || exit 1; \
             mkdir -p logs && tmux pipe-pane -o -t \"$id\" 'cat >> ~/logs/shell-2.log' && echo \"$id\""
        );
        let run = ScriptRun { directory: "/home/agent/work/app dir", script: "start:server" };
        assert_eq!(
            shell_window_script(&[], Some(run)),
            "id=$(if tmux has-session -t =app 2>/dev/null; then tmux new-window -d -t =app: -n start:server -c '/home/agent/work/app dir' -P -F '#{window_id}'; \
             else tmux new-session -d -s app -n start:server -c '/home/agent/work/app dir' -P -F '#{window_id}'; fi) || exit 1; \
             mkdir -p logs && tmux pipe-pane -o -t \"$id\" 'cat >> ~/logs/start:server.log' && \
             tmux send-keys -t \"$id\" -l 'npm run start:server' && tmux send-keys -t \"$id\" Enter && echo \"$id\""
        );
    }

    #[test]
    fn a_target_arrives_as_the_frontend_sends_it() {
        let service: TerminalTarget = serde_json::from_str(r#"{"kind":"service","name":"web"}"#).unwrap();
        assert_eq!(service, TerminalTarget::Service { name: "web".into() });
        let window: TerminalTarget = serde_json::from_str(r#"{"kind":"window","id":"@3","machine":"desktop"}"#).unwrap();
        assert_eq!(window, TerminalTarget::Window { id: "@3".into(), machine: Machine::Desktop });
    }

    #[test]
    fn registry_keeps_ids_apart_and_closes_the_terminals_of_a_window() {
        let registry = TerminalRegistry::default();
        let (first, first_events) = shell("sleep 30");
        let (second, _second_events) = shell("sleep 30");
        let (first_id, second_id) = (Uuid::new_v4(), Uuid::new_v4());
        registry.insert(first_id, "main", first).unwrap();
        registry.insert(second_id, "editor-1", second).unwrap();
        let (duplicate, _duplicate_events) = shell("sleep 30");
        assert!(registry.insert(first_id, "main", duplicate).is_err());

        registry.close_owned_by("main");
        let (_, code) = until_exit(&first_events);
        assert_eq!(code, None);
        assert!(registry.write(first_id, b"x".to_vec()).unwrap_err().contains("not open"));
        assert!(registry.write(second_id, b"x".to_vec()).is_ok());
        registry.close(first_id);
        registry.close_all();
        assert!(registry.resize(second_id, SIZE).is_err());
    }
}
