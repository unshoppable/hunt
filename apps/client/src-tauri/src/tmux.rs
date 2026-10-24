//! The tmux that runs the terminals of a session family on this Mac (a session and its sub chats, which share the
//! worktree): the bundled one (`scripts/buildTmux.ts`), one server per family. The Terminal tab shows its windows, and
//! the family's agents run their long-running processes in it. Hunt and the agents reach the server only through the
//! worktree's `.hunt/tmux`, which names its socket and Hunt's configuration, so it starts the same whoever starts it.
//! Every window writes its output to `.hunt/logs/desktop/<window name>.log`, where the family's agents read it.
//!
//! Also holds the tmux scripts that the tmux session `app` on a session VM shares (`remote/terminal.rs`): they take the
//! tmux command line, `tmux` there and the quoted `.hunt/tmux` here. Knows nothing about Tauri.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use uuid::Uuid;

use crate::remote::{shell_command, shell_quote};

/// The tmux session that holds the windows of the app's processes, on this Mac as on a session VM.
pub const APP_SESSION: &str = "app";

/// `APP_SESSION` as a tmux target that matches its name exactly, not as a prefix.
pub const APP_TARGET: &str = "=app";

/// The worktree's script through which every tmux command on this Mac reaches the family's server.
const WRAPPER_FILE: &str = ".hunt/tmux";

/// The configuration the server starts with.
const CONFIG_FILE: &str = ".hunt/tmux.conf";

/// The folder of a worktree's terminal logs: those of this Mac's windows in `DESKTOP_LOGS`, those the log stream of a
/// remote session brings from its VM next to it.
pub const LOGS_DIR: &str = ".hunt/logs";

/// The folder in `LOGS_DIR` in which every window on this Mac writes its log.
pub const DESKTOP_LOGS: &str = "desktop";

/// Size above which a window's log moves to `<name>.log.1` when the window starts, as `hunt-service` does on a VM.
const MAX_LOG_BYTES: u64 = 20 * 1024 * 1024;

/// The folder of the servers' sockets in the user's temporary folder; a debug build has its own, so that a Hunt in
/// development never ends the servers of the installed one.
const SOCKET_DIR: &str = if cfg!(debug_assertions) { "hunt-tmux-dev" } else { "hunt-tmux" };

/// The longest socket path macOS accepts: `sun_path` holds 104 bytes with the terminating NUL.
const MAX_SOCKET_PATH: usize = 103;

/// Lines of history each window keeps for scrolling back.
const HISTORY_LINES: u32 = 50_000;

/// What a script window runs until its script replaces it, so that `remain-on-exit` is set before the script can end.
const PLACEHOLDER_COMMAND: &str = "exec sleep 2147483647";

/// The fields `parse_windows` reads, separated by tabs: names may hold spaces.
const LIST_FORMAT: &str = "#{window_id}\t#{pane_dead}\t#{pane_dead_status}\t#{@hunt-script}\t#{@hunt-dir}\t#{window_name}";

/// The window options of a script window: the package.json script and the folder it runs in.
const SCRIPT_OPTION: &str = "@hunt-script";
const FOLDER_OPTION: &str = "@hunt-dir";

/// Where a tmux window runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Machine {
    /// The VM of a remote session, whose tmux session `app` the agent there uses.
    Vm,
    /// This Mac, in the family's tmux server.
    Desktop,
}

/// A window of the tmux session `app`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindow {
    /// tmux's ID of the window, such as `@3`; unlike its index and name, it neither changes nor repeats.
    pub id: String,
    pub name: String,
    /// The package.json script a script window runs; `None` for a shell or a process an agent started.
    pub script: Option<String>,
    /// Whether the window's program has ended; only a script window stays open after that.
    pub is_dead: bool,
    /// The exit code of an ended program, `None` while it runs or when a signal ended it.
    pub exit_code: Option<i32>,
    /// The folder a script window runs its script in.
    #[serde(skip)]
    pub folder: Option<String>,
}

/// Refuses anything but a tmux window ID such as `@3`, so that it never reaches tmux as another kind of target.
pub fn ensure_window_id(id: &str) -> Result<(), String> {
    let digits = id.strip_prefix('@').unwrap_or_default();
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return Err(format!("failed to reach the tmux window {id:?}: it is no window ID"));
    }
    Ok(())
}

/// The `sh` script that prints the windows of the tmux session `app` with `LIST_FORMAT`, nothing while the session
/// does not exist; `tmux` is the tmux command line.
pub fn list_windows_script(tmux: &str) -> String {
    format!("{tmux} has-session -t {APP_TARGET} 2>/dev/null || exit 0; exec {tmux} list-windows -t {APP_TARGET} -F {}", shell_quote(LIST_FORMAT))
}

/// The windows `list_windows_script` printed; other lines are skipped.
pub fn parse_windows(output: &str) -> Vec<TmuxWindow> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, '\t');
            let [id, dead, status, script, folder, name] = [(); 6].map(|_| fields.next());
            let (id, name) = (id?, name?);
            ensure_window_id(id).ok()?;
            let given = |field: Option<&str>| field.filter(|value| !value.is_empty()).map(str::to_string);
            Some(TmuxWindow {
                id: id.to_string(),
                name: name.to_string(),
                script: given(script),
                is_dead: dead == Some("1"),
                exit_code: status.and_then(|status| status.parse().ok()),
                folder: given(folder),
            })
        })
        .collect()
}

/// The first of `base`, `base-2`, `base-3`, … that no window in `windows` is called, so that every window has a log
/// of its own.
pub fn free_window_name(windows: &[TmuxWindow], base: &str) -> String {
    let is_taken = |name: &str| windows.iter().any(|window| window.name == name);
    if !is_taken(base) {
        return base.to_string();
    }
    (2..).map(|number| format!("{base}-{number}")).find(|name| !is_taken(name)).unwrap_or_default()
}

/// The window name of the package.json script `script`, usable as the name of its log file.
pub fn script_window_name(script: &str) -> String {
    let name: String =
        script.chars().map(|character| if character.is_ascii_alphanumeric() || "._:-".contains(character) { character } else { '-' }).collect();
    if name.is_empty() { "script".to_string() } else { name }
}

/// The start of an `sh` script that creates the window `name` in the tmux session `app`, which it creates when it does
/// not exist, and keeps the window's ID in `$id`; the window starts in `folder` and runs `command`, else a login shell.
/// The script continues with what follows, so it must end with `echo "$id"`.
pub fn new_window_script(tmux: &str, name: &str, folder: Option<&str>, command: Option<&str>) -> String {
    let folder = folder.map(|folder| format!(" -c {}", shell_quote(folder))).unwrap_or_default();
    let command = command.map(|command| format!(" {}", shell_quote(command))).unwrap_or_default();
    let (name, format) = (shell_quote(name), shell_quote("#{window_id}"));
    format!(
        "id=$(if {tmux} has-session -t {APP_TARGET} 2>/dev/null; then {tmux} new-window -d -t {APP_TARGET}: -n {name}{folder} -P -F {format}{command}; \
         else {tmux} new-session -d -s {APP_SESSION} -n {name}{folder} -P -F {format}{command}; fi) || exit 1; "
    )
}

/// The tmux arguments that show the window `window_id` in the tmux session `view` of its own, grouped with `app`, so
/// terminals show different windows at once. The view has no status bar, takes the mouse (the wheel scrolls the
/// window's history) and ends with its terminal. `-u` makes tmux send UTF-8 even when the environment names no UTF-8
/// locale.
pub fn view_args(view: &str, window_id: &str) -> Result<Vec<String>, String> {
    ensure_window_id(window_id)?;
    let mut args = vec!["-u", "new-session", "-t", APP_TARGET, "-s", view];
    for (option, value) in [("destroy-unattached", "on"), ("status", "off"), ("mouse", "on")] {
        args.extend([";", "set-option", "-t", view, option, value]);
    }
    let window = format!("{view}:{window_id}");
    args.extend([";", "select-window", "-t", &window]);
    Ok(args.into_iter().map(str::to_string).collect())
}

/// The name of the tmux session that shows a terminal's window.
pub fn view_name(terminal_id: Uuid) -> String {
    format!("hunt-view-{}", terminal_id.simple())
}

/// The family's tmux server on this Mac, reached through the worktree's `.hunt/tmux`.
pub struct LocalTmux {
    worktree: PathBuf,
}

impl LocalTmux {
    /// Writes the worktree's `.hunt/tmux` and `.hunt/tmux.conf` for the family whose root session is `family_id` and
    /// creates the folder of its logs; files that are current stay untouched.
    pub fn prepare(worktree: &Path, family_id: Uuid) -> Result<Self, String> {
        let binary = bundled_binary()?;
        let socket = socket_path(family_id)?;
        let socket_dir = socket.parent().unwrap_or(Path::new("/"));
        std::fs::create_dir_all(socket_dir).map_err(|error| format!("failed to create {}: {error}", socket_dir.display()))?;
        std::fs::set_permissions(socket_dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .map_err(|error| format!("failed to protect {}: {error}", socket_dir.display()))?;
        let logs = desktop_logs(worktree);
        std::fs::create_dir_all(&logs).map_err(|error| format!("failed to create {}: {error}", logs.display()))?;
        let config = worktree.join(CONFIG_FILE);
        write_if_changed(&config, &config_text(&logs), 0o644)?;
        write_if_changed(&worktree.join(WRAPPER_FILE), &wrapper_text(&binary, &socket, &config), 0o755)?;
        Ok(LocalTmux { worktree: worktree.to_path_buf() })
    }

    /// The `.hunt/tmux` every tmux command on this Mac goes through.
    pub fn wrapper(&self) -> PathBuf {
        wrapper_path(&self.worktree)
    }

    pub async fn list_windows(&self) -> Result<Vec<TmuxWindow>, String> {
        Ok(parse_windows(&self.run(&list_windows_script(&self.tmux())).await?))
    }

    /// Starts a login shell in a new window in the folder `folder` and returns the window's ID; the window is called
    /// `shell`, or `shell-<n>` when that name is taken.
    pub async fn open_shell_window(&self, folder: &Path) -> Result<String, String> {
        let name = free_window_name(&self.list_windows().await?, "shell");
        let script = format!("{}echo \"$id\"", new_window_script(&self.tmux(), &name, Some(&folder.to_string_lossy()), None));
        window_id_from(&self.run(&script).await?)
    }

    /// Runs the package.json script `script` through npm in the folder `folder` and returns the ID of its window. The
    /// window stays open with the exit code once the script ends; the script's window that exists already is shown as it
    /// is while the script runs, and runs it again once it ended.
    pub async fn open_script_window(&self, folder: &Path, script: &str) -> Result<String, String> {
        let windows = self.list_windows().await?;
        let folder = folder.to_string_lossy();
        let existing = windows.iter().find(|window| window.script.as_deref() == Some(script) && window.folder.as_deref() == Some(&*folder));
        if let Some(window) = existing {
            if window.is_dead {
                self.rerun_window(&window.id).await?;
            }
            return Ok(window.id.clone());
        }
        let name = free_window_name(&windows, &script_window_name(script));
        let tmux = self.tmux();
        let created = new_window_script(&tmux, &name, Some(&folder), Some(PLACEHOLDER_COMMAND));
        let options: Vec<String> = [("remain-on-exit", "on"), (SCRIPT_OPTION, script), (FOLDER_OPTION, &folder)]
            .iter()
            .map(|(option, value)| format!("set-option -w -t \"$id\" {} {} ';' ", shell_quote(option), shell_quote(value)))
            .collect();
        let respawn = format!("respawn-pane -k -t \"$id\" -c {} {}", shell_quote(&folder), shell_quote(&script_command(script)));
        let started = format!("{tmux} {}{respawn} && echo \"$id\"", options.concat());
        window_id_from(&self.run(&format!("{created}{started}")).await?)
    }

    /// Runs the script of the script window `window_id` again in the same window and logs it as before.
    pub async fn rerun_window(&self, window_id: &str) -> Result<(), String> {
        ensure_window_id(window_id)?;
        let format = format!("#{{{SCRIPT_OPTION}}}\t#{{{FOLDER_OPTION}}}");
        let output = self.run(&format!("{} display-message -p -t {window_id} {}", self.tmux(), shell_quote(&format))).await?;
        let (script, folder) = output.trim_end_matches('\n').split_once('\t').unwrap_or_default();
        if script.is_empty() {
            return Err(format!("failed to run the window {window_id} again: it runs no package.json script"));
        }
        let log = log_command(&desktop_logs(&self.worktree));
        let args = ["respawn-pane", "-k", "-t", window_id, "-c", folder, &script_command(script), ";", "pipe-pane", "-o", "-t", window_id, &log];
        self.run(&shell_command(&self.wrapper().to_string_lossy(), &args)).await.map(|_| ())
    }

    /// Ends the window `window_id` and the processes in it.
    pub async fn kill_window(&self, window_id: &str) -> Result<(), String> {
        ensure_window_id(window_id)?;
        self.run(&shell_command(&self.wrapper().to_string_lossy(), &["kill-window", "-t", window_id])).await.map(|_| ())
    }

    /// The tmux command line of `sh` scripts.
    fn tmux(&self) -> String {
        shell_quote(&self.wrapper().to_string_lossy())
    }

    /// Runs `script` with `sh` in the worktree and returns what it printed; the server it may start keeps nothing of
    /// Hunt's own npm environment.
    async fn run(&self, script: &str) -> Result<String, String> {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script).current_dir(&self.worktree).stdin(Stdio::null());
        for name in crate::terminal::foreign_env() {
            command.env_remove(name);
        }
        let output = command.output().await.map_err(|error| format!("failed to run tmux: {error}"))?;
        if !output.status.success() {
            return Err(format!("failed to run tmux: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// The worktree's `.hunt/tmux`.
pub fn wrapper_path(worktree: &Path) -> PathBuf {
    worktree.join(WRAPPER_FILE)
}

/// The worktree's `.hunt/logs/desktop`.
pub fn desktop_logs(worktree: &Path) -> PathBuf {
    worktree.join(LOGS_DIR).join(DESKTOP_LOGS)
}

/// Ends the tmux server of the family whose root session is `family_id` and every process in its windows; a server
/// that does not run is no error.
pub async fn kill_server(family_id: Uuid) -> Result<(), String> {
    let socket = socket_path(family_id)?;
    if !socket.exists() {
        return Ok(());
    }
    kill_server_at(&socket).await
}

/// Ends every family's tmux server, as Hunt quits.
pub async fn kill_all_servers() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir().join(SOCKET_DIR)) else { return };
    for entry in entries.flatten() {
        if let Err(error) = kill_server_at(&entry.path()).await {
            eprintln!("ending the tmux server {} failed: {error}", entry.path().display());
        }
    }
}

async fn kill_server_at(socket: &Path) -> Result<(), String> {
    let output = Command::new(bundled_binary()?)
        .arg("-S")
        .arg(socket)
        .arg("kill-server")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("failed to end the tmux server: {error}"))?;
    // A socket whose server is gone answers with an error; it is removed all the same.
    if !output.status.success() {
        let _ = std::fs::remove_file(socket);
    }
    Ok(())
}

/// The tmux next to Hunt's executable, where Tauri puts the sidecar (`bundle.externalBin`); a debug build, the tests
/// included, uses the one `scripts/buildTmux.ts` built.
fn bundled_binary() -> Result<PathBuf, String> {
    let binary = if cfg!(debug_assertions) {
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/binaries/tmux-aarch64-apple-darwin"))
    } else {
        std::env::current_exe().map_err(|error| format!("failed to find Hunt's executable: {error}"))?.with_file_name("tmux")
    };
    if !binary.is_file() {
        return Err(format!("failed to find the bundled tmux: {} does not exist; `npx nx run client:tmux` builds it", binary.display()));
    }
    Ok(binary)
}

/// The socket of the family's server, in the user's own temporary folder.
fn socket_path(family_id: Uuid) -> Result<PathBuf, String> {
    let socket = std::env::temp_dir().join(SOCKET_DIR).join(family_id.simple().to_string());
    if socket.as_os_str().len() > MAX_SOCKET_PATH {
        return Err(format!("failed to place the tmux socket: {} is longer than macOS allows", socket.display()));
    }
    Ok(socket)
}

/// The command a package.json script window runs: the script through npm in the user's interactive login shell, as
/// checks run, so that the profile files put Node on the `PATH`.
fn script_command(script: &str) -> String {
    let (program, args) = crate::terminal::local_command(&shell_command("npm", &["run", script]));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    shell_command(&program, &args)
}

/// The `sh` command that `pipe-pane` runs for a window: it appends the window's output to `<logs>/<window name>.log`,
/// after moving a log above `MAX_LOG_BYTES` to `<name>.log.1`. tmux expands the window name, quoted for `sh`.
fn log_command(logs: &Path) -> String {
    let folder = shell_quote(&logs.to_string_lossy()).replace('#', "##");
    format!(
        "log={folder}/#{{q:window_name}}.log; [ \"$(stat -f %z \"$log\" 2>/dev/null || echo 0)\" -gt {MAX_LOG_BYTES} ] && mv -f \"$log\" \"$log.1\"; \
         exec cat >> \"$log\""
    )
}

/// The server's configuration: every new window logs to `logs` (`log_command`), and a window keeps the name it was
/// given, which names its log and its tab.
fn config_text(logs: &Path) -> String {
    let pipe = format!("pipe-pane -o \"{}\"", log_command(logs).replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$"));
    let mut text = format!(
        "# Written by Hunt for the terminals of this worktree; Hunt overwrites changes.\n\
         set -g history-limit {HISTORY_LINES}\n\
         set -gw automatic-rename off\n\
         set -gw allow-rename off\n"
    );
    for hook in ["after-new-session", "after-new-window", "after-split-window"] {
        text.push_str(&format!("set-hook -g {hook} {{ {pipe} }}\n"));
    }
    text
}

/// `.hunt/tmux`: runs the bundled tmux on the family's socket with the worktree's configuration.
fn wrapper_text(binary: &Path, socket: &Path, config: &Path) -> String {
    let quote = |path: &Path| shell_quote(&path.to_string_lossy());
    format!(
        "#!/bin/sh\n# Written by Hunt: the tmux of this worktree's terminals, on its session family's server.\nexec {} -S {} -f {} \"$@\"\n",
        quote(binary),
        quote(socket),
        quote(config),
    )
}

/// Replaces `path` with `text` unless it holds it already; through a temporary file, so that a running `sh` never
/// reads half a script.
fn write_if_changed(path: &Path, text: &str, mode: u32) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    let temporary = path.with_extension("hunt-tmp");
    std::fs::write(&temporary, text).map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    std::fs::set_permissions(&temporary, std::os::unix::fs::PermissionsExt::from_mode(mode))
        .map_err(|error| format!("failed to set the mode of {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

/// The window ID a window script printed last.
fn window_id_from(output: &str) -> Result<String, String> {
    let id = output.trim().lines().last().unwrap_or_default();
    ensure_window_id(id).map_err(|_| format!("failed to open the window: tmux answered {output:?}"))?;
    Ok(id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::terminal::{Terminal, TerminalEvent, TerminalSize};

    fn window(id: &str, name: &str) -> TmuxWindow {
        TmuxWindow { id: id.into(), name: name.into(), script: None, is_dead: false, exit_code: None, folder: None }
    }

    #[test]
    fn parse_windows_reads_names_with_spaces_scripts_and_exit_codes_and_skips_other_lines() {
        let output = "@1\t0\t\t\t\tweb\n@7\t1\t3\tbuild\t/w/app\tmy build\nWelcome to the VM\n@x\t0\t\t\t\tbad\n\n";
        let build = TmuxWindow {
            id: "@7".into(),
            name: "my build".into(),
            script: Some("build".into()),
            is_dead: true,
            exit_code: Some(3),
            folder: Some("/w/app".into()),
        };
        assert_eq!(parse_windows(output), [window("@1", "web"), build]);
    }

    #[test]
    fn free_window_name_counts_up_from_the_second() {
        assert_eq!(free_window_name(&[], "shell"), "shell");
        assert_eq!(free_window_name(&[window("@1", "shell")], "shell"), "shell-2");
        assert_eq!(free_window_name(&[window("@1", "shell"), window("@2", "shell-2"), window("@3", "shell-4")], "shell"), "shell-3");
    }

    #[test]
    fn script_window_name_keeps_what_a_file_name_takes() {
        assert_eq!(script_window_name("start:server"), "start:server");
        assert_eq!(script_window_name("test/unit e2e"), "test-unit-e2e");
        assert_eq!(script_window_name(""), "script");
    }

    #[test]
    fn view_args_show_a_window_in_a_grouped_session_of_its_own() {
        assert_eq!(
            view_args("hunt-view-1", "@12").unwrap().join(" "),
            "-u new-session -t =app -s hunt-view-1 ; set-option -t hunt-view-1 destroy-unattached on ; set-option -t hunt-view-1 status off \
             ; set-option -t hunt-view-1 mouse on ; select-window -t hunt-view-1:@12"
        );
        for id in ["", "@", "12", "@1x", "@-1", "@1 ;kill-server", "app:@1"] {
            assert!(view_args("view", id).is_err(), "{id}");
        }
    }

    #[test]
    fn new_window_script_creates_the_session_when_it_is_missing() {
        assert_eq!(
            new_window_script("tmux", "start:server", Some("/home/agent/app dir"), None),
            "id=$(if tmux has-session -t =app 2>/dev/null; then tmux new-window -d -t =app: -n start:server -c '/home/agent/app dir' -P -F '#{window_id}'; \
             else tmux new-session -d -s app -n start:server -c '/home/agent/app dir' -P -F '#{window_id}'; fi) || exit 1; "
        );
        assert!(new_window_script("'/w/.hunt/tmux'", "build", None, Some("exec sleep 1")).contains("-n build -P -F '#{window_id}' 'exec sleep 1';"));
    }

    #[test]
    fn config_logs_every_new_window_under_its_name() {
        let config = config_text(Path::new("/Users/jane/Library/Application Support/hunt/wt #1/.hunt/logs/desktop"));
        let hook = "set-hook -g after-new-window { pipe-pane -o \"log='/Users/jane/Library/Application Support/hunt/wt ##1/.hunt/logs/desktop'\
                    /#{q:window_name}.log; [ \\\"\\$(stat -f %z \\\"\\$log\\\" 2>/dev/null || echo 0)\\\" -gt 20971520 ] \
                    && mv -f \\\"\\$log\\\" \\\"\\$log.1\\\"; exec cat >> \\\"\\$log\\\"\" }";
        assert!(config.contains(hook), "{config}");
        assert!(config.contains("set-hook -g after-new-session {"));
        assert!(config.contains("set -gw automatic-rename off"));
    }

    /// Waits until the log `name` of the worktree holds `text` and returns the log.
    async fn wait_for_log(worktree: &Path, name: &str, text: &str) -> String {
        let path = desktop_logs(worktree).join(format!("{name}.log"));
        for _ in 0..200 {
            let log = std::fs::read_to_string(&path).unwrap_or_default();
            if log.contains(text) {
                return log;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("{} never held {text:?}", path.display());
    }

    #[tokio::test]
    async fn windows_of_the_bundled_tmux_log_their_output_show_in_a_view_and_a_script_window_runs_again() {
        let worktree = tempfile::tempdir().unwrap();
        std::fs::write(worktree.path().join("package.json"), r#"{"scripts":{"fail":"echo failing && exit 3"}}"#).unwrap();
        let family_id = Uuid::new_v4();
        let tmux = LocalTmux::prepare(worktree.path(), family_id).unwrap();

        let started = shell_command(&tmux.wrapper().to_string_lossy(), &["new-session", "-d", "-s", APP_SESSION, "-n", "greeting", "echo hello; sleep 30"]);
        tmux.run(&started).await.unwrap();
        wait_for_log(worktree.path(), "greeting", "hello").await;

        let greeting = tmux.list_windows().await.unwrap().into_iter().find(|window| window.name == "greeting").unwrap();
        let (events, received) = std::sync::mpsc::channel();
        let view = Terminal::spawn(
            &tmux.wrapper().to_string_lossy(),
            &view_args(&view_name(Uuid::new_v4()), &greeting.id).unwrap(),
            Some(worktree.path()),
            &[],
            TerminalSize { cols: 80, rows: 24 },
            move |event| {
                let _ = events.send(event);
            },
        )
        .unwrap();
        let mut screen = Vec::new();
        while !String::from_utf8_lossy(&screen).contains("hello") {
            match received.recv_timeout(std::time::Duration::from_secs(10)) {
                Ok(TerminalEvent::Output(bytes)) => screen.extend(bytes),
                other => panic!("the view ended before it showed the window: {other:?}, {}", String::from_utf8_lossy(&screen)),
            }
        }
        drop(view);
        let sessions = shell_command(&tmux.wrapper().to_string_lossy(), &["list-sessions", "-F", "#{session_name}"]);
        for _ in 0..200 {
            if tmux.run(&sessions).await.unwrap().trim() == APP_SESSION {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(tmux.run(&sessions).await.unwrap().trim(), APP_SESSION);

        let script_window = tmux.open_script_window(worktree.path(), "fail").await.unwrap();
        wait_for_log(worktree.path(), "fail", "failing").await;
        for _ in 0..200 {
            if tmux.list_windows().await.unwrap().iter().any(|window| window.id == script_window && window.is_dead) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let windows = tmux.list_windows().await.unwrap();
        let ended = windows.iter().find(|window| window.id == script_window).unwrap();
        assert_eq!((ended.name.as_str(), ended.script.as_deref(), ended.is_dead), ("fail", Some("fail"), true), "{windows:?}");
        assert!(ended.exit_code.is_some_and(|code| code != 0), "{ended:?}");

        assert_eq!(tmux.open_script_window(worktree.path(), "fail").await.unwrap(), script_window);
        let log = wait_for_log(worktree.path(), "fail", "failing\r\n").await;
        for _ in 0..200 {
            if std::fs::read_to_string(desktop_logs(worktree.path()).join("fail.log")).unwrap().matches("failing").count() == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(std::fs::read_to_string(desktop_logs(worktree.path()).join("fail.log")).unwrap().matches("failing").count(), 2, "{log}");

        tmux.kill_window(&script_window).await.unwrap();
        assert!(tmux.list_windows().await.unwrap().iter().all(|window| window.id != script_window));
        kill_server(family_id).await.unwrap();
        assert!(tmux.list_windows().await.unwrap().is_empty());
    }

    #[test]
    fn wrapper_runs_the_bundled_tmux_on_the_family_socket() {
        let wrapper = wrapper_text(Path::new("/Applications/Hunt.app/Contents/MacOS/tmux"), Path::new("/tmp/hunt-tmux/ab12"), Path::new("/w x/.hunt/tmux.conf"));
        assert!(wrapper.starts_with("#!/bin/sh\n"));
        assert!(wrapper.ends_with("exec /Applications/Hunt.app/Contents/MacOS/tmux -S /tmp/hunt-tmux/ab12 -f '/w x/.hunt/tmux.conf' \"$@\"\n"));
    }
}
