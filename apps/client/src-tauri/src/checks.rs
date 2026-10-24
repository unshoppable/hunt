//! The checks of a repository: named command lines such as lint, test or build that its `hunt.json` declares under
//! `checks`, which the Checks tab runs in a session's worktree, locally or on the VM (`hunt-ctl check`). Each check of a
//! session keeps its last run: state, times, exit code, the tail of its output and the worktree's tree object at its
//! start, which tells whether the result still describes the worktree. Knows nothing about Tauri;
//! `session/commands.rs` owns the commands, spawns the processes and forwards the changes to the windows.
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::remote::terminal::{Terminal, TerminalEvent};

/// Bytes of a run's output that stay readable; older output is dropped from the front.
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

/// A check as the worktree's `hunt.json` declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDefinition {
    pub name: String,
    pub command: String,
    /// Worktree-relative folder the command runs in; `None` runs it in the worktree.
    pub cwd: Option<String>,
}

/// The checks of the worktree's `hunt.json` in the file's order; none without the file or the section. The VM
/// validates the file fully (`apps/session/src/config.ts`); here only the shape of the section matters.
pub fn read_checks(worktree: &Path) -> Result<Vec<CheckDefinition>, String> {
    let path = worktree.join("hunt.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    let json: Value = serde_json::from_str(&text).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let checks = match json.get("checks") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(checks)) => checks,
        Some(_) => return Err(format!("failed to read {}: checks must be an object of named checks", path.display())),
    };
    let mut definitions = Vec::new();
    for (name, check) in checks {
        let command = check.get("command").and_then(Value::as_str).map(str::trim).filter(|command| !command.is_empty() && !command.contains('\n'));
        let Some(command) = command else {
            return Err(format!("failed to read {}: checks.{name}.command must be a command line", path.display()));
        };
        let cwd = match check.get("cwd") {
            None | Some(Value::Null) => None,
            Some(Value::String(cwd)) => Some(cwd.clone()),
            Some(_) => return Err(format!("failed to read {}: checks.{name}.cwd must be a folder of the worktree", path.display())),
        };
        definitions.push(CheckDefinition { name: name.clone(), command: command.to_string(), cwd });
    }
    Ok(definitions)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Running,
    Passed,
    Failed,
    Cancelled,
}

/// The last run of a check as the Checks tab shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunView {
    pub name: String,
    /// Counts the runs of all checks; output events of an older run carry its number and are ignored.
    pub run: u64,
    pub state: CheckState,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    /// The command's exit code; `None` while it runs, when a signal ended it or when it could not start.
    pub exit_code: Option<u32>,
}

/// A run's output: its last `OUTPUT_LIMIT` bytes and how many bytes it wrote in all, which is the offset at which the
/// next `CheckOutput` event continues.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckOutputTail {
    pub run: u64,
    pub end: u64,
    pub data: Vec<u8>,
}

/// What a run reports to the windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckNotice {
    /// A run started, ended or was cancelled.
    Changed { session: Uuid },
    /// The run wrote `data`, starting at byte `offset` of its output.
    Output { session: Uuid, name: String, run: u64, offset: u64, data: Vec<u8> },
}

struct CheckRun {
    number: u64,
    state: CheckState,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    exit_code: Option<u32>,
    /// The worktree's tree object when the run started; `None` when git could not tell.
    tree: Option<String>,
    output: Vec<u8>,
    written: u64,
    terminal: Option<Terminal>,
    /// Fires when the run ends, however it ends.
    finished: Option<oneshot::Sender<()>>,
}

impl CheckRun {
    fn view(&self, name: &str) -> CheckRunView {
        CheckRunView {
            name: name.to_string(),
            run: self.number,
            state: self.state,
            started_at: self.started_at,
            finished_at: self.finished_at,
            exit_code: self.exit_code,
        }
    }

    fn append(&mut self, data: &[u8]) -> u64 {
        let offset = self.written;
        self.written += data.len() as u64;
        self.output.extend_from_slice(data);
        if self.output.len() > OUTPUT_LIMIT {
            let excess = self.output.len() - OUTPUT_LIMIT;
            self.output.drain(..excess);
        }
        offset
    }

    /// Ends the run in `state`, signals its end and hands back its terminal, which the caller drops outside the lock:
    /// dropping it kills a program that still runs.
    fn finish(&mut self, state: CheckState, exit_code: Option<u32>) -> Option<Terminal> {
        self.state = state;
        self.exit_code = exit_code;
        self.finished_at = Some(Utc::now());
        if let Some(finished) = self.finished.take() {
            let _ = finished.send(());
        }
        self.terminal.take()
    }
}

type Runs = HashMap<(Uuid, String), CheckRun>;

/// The last run of every check of every session.
#[derive(Default)]
pub struct CheckRegistry {
    runs: Arc<Mutex<Runs>>,
    next_run: Mutex<u64>,
}

impl CheckRegistry {
    /// Runs the check `name` of `session` in the terminal `spawn` starts with the event handler it is given; `tree` is
    /// the worktree's tree object now. A check that runs already is an error. A terminal that fails to start ends the
    /// run as failed, with the error as its output. `notify` gets every change of the run; the receiver fires at its end.
    pub fn start(
        &self,
        session: Uuid,
        name: &str,
        tree: Option<String>,
        spawn: impl FnOnce(Box<dyn FnMut(TerminalEvent) + Send>) -> Result<Terminal, String>,
        notify: impl Fn(CheckNotice) + Send + Sync + 'static,
    ) -> Result<oneshot::Receiver<()>, String> {
        let key = (session, name.to_string());
        let number = {
            let mut next_run = self.next_run.lock().unwrap();
            *next_run += 1;
            *next_run
        };
        let (finished, on_finish) = oneshot::channel();
        {
            let mut runs = self.runs.lock().unwrap();
            if runs.get(&key).is_some_and(|run| run.state == CheckState::Running) {
                return Err(format!("failed to run the check {name}: it runs already"));
            }
            let run = CheckRun {
                number,
                state: CheckState::Running,
                started_at: Utc::now(),
                finished_at: None,
                exit_code: None,
                tree,
                output: Vec::new(),
                written: 0,
                terminal: None,
                finished: Some(finished),
            };
            runs.insert(key.clone(), run);
        }
        let notify = Arc::new(notify);
        notify(CheckNotice::Changed { session });

        let handler = run_events(self.runs.clone(), key.clone(), number, notify.clone());
        match spawn(Box::new(handler)) {
            Ok(terminal) => {
                let mut runs = self.runs.lock().unwrap();
                match runs.get_mut(&key) {
                    Some(run) if run.number == number && run.state == CheckState::Running => run.terminal = Some(terminal),
                    // The program ended or was cancelled before its terminal was kept.
                    _ => {
                        drop(runs);
                        drop(terminal);
                    }
                }
            }
            Err(error) => {
                let ended = {
                    let mut runs = self.runs.lock().unwrap();
                    runs.get_mut(&key).filter(|run| run.number == number).map(|run| {
                        run.append(format!("{error}\r\n").as_bytes());
                        run.finish(CheckState::Failed, None)
                    })
                };
                drop(ended);
                notify(CheckNotice::Changed { session });
            }
        }
        Ok(on_finish)
    }

    /// Cancels the check `name` of `session` if it runs; true when a run ended.
    pub fn cancel(&self, session: Uuid, name: &str) -> bool {
        let ended = {
            let mut runs = self.runs.lock().unwrap();
            match runs.get_mut(&(session, name.to_string())) {
                Some(run) if run.state == CheckState::Running => Some(run.finish(CheckState::Cancelled, None)),
                _ => None,
            }
        };
        ended.is_some()
    }

    /// Cancels every running check of `session`.
    pub fn cancel_all(&self, session: Uuid) {
        let ended: Vec<_> = {
            let mut runs = self.runs.lock().unwrap();
            runs.iter_mut()
                .filter(|((owner, _), run)| *owner == session && run.state == CheckState::Running)
                .map(|(_, run)| run.finish(CheckState::Cancelled, None))
                .collect()
        };
        drop(ended);
    }

    /// Drops every run of `session`, cancelling those that run, e.g. when the session is deleted.
    pub fn forget(&self, session: Uuid) {
        let removed: Vec<_> = self.runs.lock().unwrap().extract_if(|(owner, _), _| *owner == session).collect();
        drop(removed);
    }

    /// Cancels every run of every session, e.g. when Hunt quits.
    pub fn cancel_everything(&self) {
        let removed = std::mem::take(&mut *self.runs.lock().unwrap());
        drop(removed);
    }

    pub fn is_running(&self, session: Uuid, name: &str) -> bool {
        self.runs.lock().unwrap().get(&(session, name.to_string())).is_some_and(|run| run.state == CheckState::Running)
    }

    /// The last run of each check of `session` with the worktree's tree object at its start.
    pub fn runs(&self, session: Uuid) -> Vec<(CheckRunView, Option<String>)> {
        let runs = self.runs.lock().unwrap();
        let mut views: Vec<_> = runs
            .iter()
            .filter(|((owner, _), _)| *owner == session)
            .map(|((_, name), run)| (run.view(name), run.tree.clone()))
            .collect();
        views.sort_by(|(left, _), (right, _)| left.name.cmp(&right.name));
        views
    }

    pub fn output(&self, session: Uuid, name: &str) -> Option<CheckOutputTail> {
        let runs = self.runs.lock().unwrap();
        let run = runs.get(&(session, name.to_string()))?;
        Some(CheckOutputTail { run: run.number, end: run.written, data: run.output.clone() })
    }
}

/// The terminal event handler of the run `number` of the check `key`: it keeps the output, ends the run with the
/// program and reports both through `notify`. Events of a run that was cancelled or replaced change nothing.
fn run_events(runs: Arc<Mutex<Runs>>, key: (Uuid, String), number: u64, notify: Arc<dyn Fn(CheckNotice) + Send + Sync>) -> impl FnMut(TerminalEvent) + Send {
    move |event| match event {
        TerminalEvent::Output(data) => {
            let offset = {
                let mut runs = runs.lock().unwrap();
                let Some(run) = runs.get_mut(&key).filter(|run| run.number == number && run.state == CheckState::Running) else { return };
                run.append(&data)
            };
            notify(CheckNotice::Output { session: key.0, name: key.1.clone(), run: number, offset, data });
        }
        TerminalEvent::Exit(code) => {
            let ended = {
                let mut runs = runs.lock().unwrap();
                let Some(run) = runs.get_mut(&key).filter(|run| run.number == number && run.state == CheckState::Running) else { return };
                let state = if code == Some(0) { CheckState::Passed } else { CheckState::Failed };
                run.finish(state, code)
            };
            drop(ended);
            notify(CheckNotice::Changed { session: key.0 });
        }
    }
}

/// The names of the checks whose last run started on another tree object than `current`, the worktree's now. Without
/// a current tree, or a run without one, nothing counts as outdated.
pub fn outdated_names(runs: &[(CheckRunView, Option<String>)], current: Option<&str>) -> Vec<String> {
    let Some(current) = current else { return Vec::new() };
    runs.iter()
        .filter(|(_, tree)| tree.as_deref().is_some_and(|tree| tree != current))
        .map(|(view, _)| view.name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::terminal::TerminalSize;
    use std::time::Duration;

    const SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

    fn write_hunt_json(text: &str) -> tempfile::TempDir {
        let worktree = tempfile::tempdir().unwrap();
        std::fs::write(worktree.path().join("hunt.json"), text).unwrap();
        worktree
    }

    #[test]
    fn checks_come_from_hunt_json_in_the_order_of_the_file() {
        let worktree = write_hunt_json(r#"{"version":3,"checks":{"test":{"command":"npm test"},"lint":{"command":" npx eslint . ","cwd":"apps/web"}}}"#);
        let checks = read_checks(worktree.path()).unwrap();
        assert_eq!(
            checks,
            [
                CheckDefinition { name: "test".into(), command: "npm test".into(), cwd: None },
                CheckDefinition { name: "lint".into(), command: "npx eslint .".into(), cwd: Some("apps/web".into()) },
            ]
        );
    }

    #[test]
    fn a_worktree_without_hunt_json_or_checks_has_none() {
        let worktree = tempfile::tempdir().unwrap();
        assert_eq!(read_checks(worktree.path()).unwrap(), []);
        let worktree = write_hunt_json(r#"{"version":3,"services":{}}"#);
        assert_eq!(read_checks(worktree.path()).unwrap(), []);
    }

    #[test]
    fn a_malformed_checks_section_names_the_offending_value() {
        for (text, problem) in [
            (r#"{"checks":[]}"#, "checks must be an object of named checks"),
            (r#"{"checks":{"lint":{}}}"#, "checks.lint.command must be a command line"),
            (r#"{"checks":{"lint":{"command":"a\nb"}}}"#, "checks.lint.command must be a command line"),
            (r#"{"checks":{"lint":{"command":"x","cwd":1}}}"#, "checks.lint.cwd must be a folder of the worktree"),
        ] {
            let worktree = write_hunt_json(text);
            let error = read_checks(worktree.path()).unwrap_err();
            assert!(error.ends_with(problem), "{text}: {error}");
        }
    }

    #[test]
    fn the_output_keeps_its_last_bytes_and_counts_all_of_them() {
        let mut run = CheckRun {
            number: 1,
            state: CheckState::Running,
            started_at: Utc::now(),
            finished_at: None,
            exit_code: None,
            tree: None,
            output: Vec::new(),
            written: 0,
            terminal: None,
            finished: None,
        };
        assert_eq!(run.append(&vec![b'a'; OUTPUT_LIMIT]), 0);
        assert_eq!(run.append(b"bc"), OUTPUT_LIMIT as u64);
        assert_eq!(run.output.len(), OUTPUT_LIMIT);
        assert!(run.output.ends_with(b"abc"));
        assert_eq!(run.written, OUTPUT_LIMIT as u64 + 2);
    }

    #[test]
    fn runs_on_another_tree_are_outdated() {
        let view = |name: &str| CheckRunView { name: name.into(), run: 1, state: CheckState::Passed, started_at: Utc::now(), finished_at: None, exit_code: Some(0) };
        let runs = vec![(view("lint"), Some("a".to_string())), (view("test"), Some("b".to_string())), (view("build"), None)];
        assert_eq!(outdated_names(&runs, Some("a")), ["test"]);
        assert!(outdated_names(&runs, None).is_empty());
    }

    async fn run_shell(registry: &CheckRegistry, session: Uuid, name: &str, script: &str) -> CheckRunView {
        let script = script.to_string();
        let finished = registry
            .start(session, name, None, move |handler| Terminal::spawn("/bin/sh", &["-c".to_string(), script], None, &[], SIZE, handler), |_| {})
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), finished).await.unwrap().unwrap();
        registry.runs(session).into_iter().map(|(view, _)| view).find(|view| view.name == name).unwrap()
    }

    #[tokio::test]
    async fn a_run_passes_with_exit_code_zero_and_fails_otherwise() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        let passed = run_shell(&registry, session, "lint", "echo fine").await;
        assert_eq!((passed.state, passed.exit_code), (CheckState::Passed, Some(0)));
        assert!(String::from_utf8_lossy(&registry.output(session, "lint").unwrap().data).contains("fine"));
        let failed = run_shell(&registry, session, "test", "echo broken; exit 3").await;
        assert_eq!((failed.state, failed.exit_code), (CheckState::Failed, Some(3)));
    }

    #[tokio::test]
    async fn a_cancelled_run_stays_cancelled_and_a_running_check_cannot_start_twice() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        let spawn = |handler| Terminal::spawn("/bin/sh", &["-c".to_string(), "sleep 30".to_string()], None, &[], SIZE, handler);
        let finished = registry.start(session, "build", None, spawn, |_| {}).unwrap();
        assert!(registry.start(session, "build", None, spawn, |_| {}).is_err());
        assert!(registry.cancel(session, "build"));
        tokio::time::timeout(Duration::from_secs(5), finished).await.unwrap().unwrap();
        let (view, _) = registry.runs(session).remove(0);
        assert_eq!(view.state, CheckState::Cancelled);
    }

    #[tokio::test]
    async fn the_checks_of_a_session_run_at_the_same_time() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        let spawn = |handler| Terminal::spawn("/bin/sh", &["-c".to_string(), "sleep 30".to_string()], None, &[], SIZE, handler);
        let lint = registry.start(session, "lint", None, spawn, |_| {}).unwrap();
        let test = registry.start(session, "test", None, spawn, |_| {}).unwrap();
        assert!(registry.is_running(session, "lint") && registry.is_running(session, "test"));
        registry.cancel_all(session);
        for finished in [lint, test] {
            tokio::time::timeout(Duration::from_secs(5), finished).await.unwrap().unwrap();
        }
        assert!(registry.runs(session).iter().all(|(view, _)| view.state == CheckState::Cancelled));
    }

    #[test]
    fn a_terminal_that_fails_to_start_fails_the_run_with_the_error() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        registry.start(session, "lint", None, |_| Err("failed to start node: gone".to_string()), |_| {}).unwrap();
        let (view, _) = registry.runs(session).remove(0);
        assert_eq!(view.state, CheckState::Failed);
        assert!(String::from_utf8_lossy(&registry.output(session, "lint").unwrap().data).contains("gone"));
    }
}
