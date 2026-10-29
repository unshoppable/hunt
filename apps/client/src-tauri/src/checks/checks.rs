//! The checks of a repository: named command lines such as lint, test or build that its `hunt.json` declares under
//! `checks`, which the Checks tab runs in a tmux window of a session, on this Mac or on its VM (`host.rs`). Each check of
//! a session keeps its last run: state, times, exit code, the window it runs in and the worktree's tree object at its
//! start, which tells whether the result still describes the worktree. Knows nothing about Tauri;
//! `session/commands/checks.rs` owns the commands, follows the windows to the end of their checks and tells the app's
//! windows about every change.
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::terminal::tmux::Machine;

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
/// validates the file fully (`apps/session/src/session-config/hunt-json.value-object.ts`); here only the shape of the section matters.
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

/// The tmux window a run's check runs in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckWindow {
    /// tmux's ID of the window, such as `@3`.
    pub id: String,
    pub machine: Machine,
}

/// The last run of a check as the Checks tab shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunView {
    pub name: String,
    /// Counts the runs of all checks, so that what follows an older run of the check can tell it was replaced.
    pub run: u64,
    pub state: CheckState,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    /// The command's exit code; `None` while it runs, when a signal ended it or when it could not start.
    pub exit_code: Option<i32>,
    /// The window the check runs in; `None` until the window opened and for a run that could not start.
    pub window: Option<CheckWindow>,
    /// Why the run could not start or could not be followed to its end.
    pub error: Option<String>,
}

struct CheckRun {
    view: CheckRunView,
    /// The worktree's tree object when the run started; `None` when git could not tell.
    tree: Option<String>,
}

impl CheckRun {
    fn finish(&mut self, state: CheckState, exit_code: Option<i32>, error: Option<String>) {
        self.view.state = state;
        self.view.exit_code = exit_code;
        self.view.error = error;
        self.view.finished_at = Some(Utc::now());
    }
}

type Runs = HashMap<(Uuid, String), CheckRun>;

/// The last run of every check of every session.
#[derive(Default)]
pub struct CheckRegistry {
    runs: Mutex<Runs>,
    next_run: Mutex<u64>,
}

impl CheckRegistry {
    /// Records a new run of the check `name` of `session` on the worktree's tree object `tree` and returns its number; a
    /// check that runs already is an error.
    pub fn start(&self, session: Uuid, name: &str, tree: Option<String>) -> Result<u64, String> {
        let mut runs = self.runs.lock().unwrap();
        let key = (session, name.to_string());
        if runs.get(&key).is_some_and(|current| current.view.state == CheckState::Running) {
            return Err(format!("failed to run the check {name}: it runs already"));
        }
        let number = {
            let mut next_run = self.next_run.lock().unwrap();
            *next_run += 1;
            *next_run
        };
        let view = CheckRunView {
            name: name.to_string(),
            run: number,
            state: CheckState::Running,
            started_at: Utc::now(),
            finished_at: None,
            exit_code: None,
            window: None,
            error: None,
        };
        runs.insert(key, CheckRun { view, tree });
        Ok(number)
    }

    /// Records the window the run `run` of the check `name` runs in; false when that run no longer runs, because it
    /// was cancelled meanwhile: the caller then stops the window's program.
    pub fn attach(&self, session: Uuid, name: &str, run: u64, window: CheckWindow) -> bool {
        let mut runs = self.runs.lock().unwrap();
        let Some(current) = running(&mut runs, session, name, run) else { return false };
        current.view.window = Some(window);
        true
    }

    /// Ends the run `run` of the check `name` with the exit code of its program: passed with 0, failed with any other
    /// or none. False when that run no longer runs.
    pub fn end(&self, session: Uuid, name: &str, run: u64, exit_code: Option<i32>) -> bool {
        let mut runs = self.runs.lock().unwrap();
        let Some(current) = running(&mut runs, session, name, run) else { return false };
        let state = if exit_code == Some(0) { CheckState::Passed } else { CheckState::Failed };
        current.finish(state, exit_code, None);
        true
    }

    /// Ends the run `run` of the check `name` as failed with `error`; false when that run no longer runs.
    pub fn fail(&self, session: Uuid, name: &str, run: u64, error: String) -> bool {
        let mut runs = self.runs.lock().unwrap();
        let Some(current) = running(&mut runs, session, name, run) else { return false };
        current.finish(CheckState::Failed, None, Some(error));
        true
    }

    /// Whether the run `run` of the check `name` still runs.
    pub fn is_current(&self, session: Uuid, name: &str, run: u64) -> bool {
        running(&mut self.runs.lock().unwrap(), session, name, run).is_some()
    }

    /// Cancels the check `name` of `session` if it runs and returns its window, whose program the caller stops; `None`
    /// also while the window is not open yet, which `attach` then refuses.
    pub fn cancel(&self, session: Uuid, name: &str) -> Option<CheckWindow> {
        let mut runs = self.runs.lock().unwrap();
        let current = runs.get_mut(&(session, name.to_string())).filter(|current| current.view.state == CheckState::Running)?;
        current.finish(CheckState::Cancelled, None, None);
        current.view.window.clone()
    }

    /// Cancels every running check of `session` and returns their windows, whose programs the caller stops.
    pub fn cancel_all(&self, session: Uuid) -> Vec<CheckWindow> {
        let mut runs = self.runs.lock().unwrap();
        let mut windows = Vec::new();
        for ((owner, _), current) in runs.iter_mut() {
            if *owner != session || current.view.state != CheckState::Running {
                continue;
            }
            current.finish(CheckState::Cancelled, None, None);
            windows.extend(current.view.window.clone());
        }
        windows
    }

    /// Drops every run of `session`, e.g. when the session is deleted; checks that still run end on their own.
    pub fn forget(&self, session: Uuid) {
        self.runs.lock().unwrap().retain(|(owner, _), _| *owner != session);
    }

    pub fn is_running(&self, session: Uuid, name: &str) -> bool {
        self.runs.lock().unwrap().get(&(session, name.to_string())).is_some_and(|current| current.view.state == CheckState::Running)
    }

    /// The last run of the check `name` of `session`.
    pub fn run(&self, session: Uuid, name: &str) -> Option<CheckRunView> {
        self.runs.lock().unwrap().get(&(session, name.to_string())).map(|current| current.view.clone())
    }

    /// The last run of each check of `session` with the worktree's tree object at its start.
    pub fn runs(&self, session: Uuid) -> Vec<(CheckRunView, Option<String>)> {
        let runs = self.runs.lock().unwrap();
        let mut views: Vec<_> =
            runs.iter().filter(|((owner, _), _)| *owner == session).map(|(_, current)| (current.view.clone(), current.tree.clone())).collect();
        views.sort_by(|(left, _), (right, _)| left.name.cmp(&right.name));
        views
    }
}

/// The run `run` of the check `name` of `session`, while it runs.
fn running<'a>(runs: &'a mut Runs, session: Uuid, name: &str, run: u64) -> Option<&'a mut CheckRun> {
    runs.get_mut(&(session, name.to_string())).filter(|current| current.view.run == run && current.view.state == CheckState::Running)
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

    fn write_hunt_json(text: &str) -> tempfile::TempDir {
        let worktree = tempfile::tempdir().unwrap();
        std::fs::write(worktree.path().join("hunt.json"), text).unwrap();
        worktree
    }

    fn window(id: &str) -> CheckWindow {
        CheckWindow { id: id.into(), machine: Machine::Desktop }
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
    fn runs_on_another_tree_are_outdated() {
        let view = |name: &str| CheckRunView {
            name: name.into(),
            run: 1,
            state: CheckState::Passed,
            started_at: Utc::now(),
            finished_at: None,
            exit_code: Some(0),
            window: None,
            error: None,
        };
        let runs = vec![(view("lint"), Some("a".to_string())), (view("test"), Some("b".to_string())), (view("build"), None)];
        assert_eq!(outdated_names(&runs, Some("a")), ["test"]);
        assert!(outdated_names(&runs, None).is_empty());
    }

    #[test]
    fn a_run_passes_with_exit_code_zero_and_fails_otherwise() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        let lint = registry.start(session, "lint", None).unwrap();
        assert!(registry.attach(session, "lint", lint, window("@1")));
        assert!(registry.end(session, "lint", lint, Some(0)));
        let passed = registry.run(session, "lint").unwrap();
        assert_eq!((passed.state, passed.exit_code, passed.window), (CheckState::Passed, Some(0), Some(window("@1"))));
        assert!(passed.finished_at.is_some());

        let test = registry.start(session, "test", None).unwrap();
        assert!(registry.end(session, "test", test, Some(3)));
        assert_eq!(registry.run(session, "test").unwrap().state, CheckState::Failed);
        assert!(!registry.end(session, "test", test, Some(0)), "an ended run stays as it ended");
    }

    #[test]
    fn a_running_check_cannot_start_twice_and_a_new_run_replaces_the_last() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        let first = registry.start(session, "build", None).unwrap();
        assert!(registry.start(session, "build", None).is_err());
        assert!(registry.is_running(session, "build"));
        assert!(registry.end(session, "build", first, Some(1)));
        let second = registry.start(session, "build", None).unwrap();
        assert!(!registry.is_current(session, "build", first));
        assert!(registry.is_current(session, "build", second));
        assert!(!registry.end(session, "build", first, Some(0)));
    }

    #[test]
    fn cancelling_hands_back_the_open_windows_and_refuses_a_window_that_opens_later() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        let lint = registry.start(session, "lint", None).unwrap();
        let test = registry.start(session, "test", None).unwrap();
        assert!(registry.attach(session, "lint", lint, window("@1")));
        assert_eq!(registry.cancel_all(session), [window("@1")]);
        assert!(!registry.attach(session, "test", test, window("@2")));
        assert!(registry.runs(session).iter().all(|(view, _)| view.state == CheckState::Cancelled));
        assert_eq!(registry.cancel(session, "lint"), None);

        let build = registry.start(session, "build", None).unwrap();
        assert!(registry.attach(session, "build", build, window("@3")));
        assert_eq!(registry.cancel(session, "build"), Some(window("@3")));
        assert_eq!(registry.run(session, "build").unwrap().state, CheckState::Cancelled);
    }

    #[test]
    fn a_run_that_cannot_start_fails_with_the_error_and_forgetting_drops_the_runs() {
        let registry = CheckRegistry::default();
        let session = Uuid::new_v4();
        let run = registry.start(session, "lint", None).unwrap();
        assert!(registry.fail(session, "lint", run, "failed to run tmux: gone".into()));
        let view = registry.run(session, "lint").unwrap();
        assert_eq!((view.state, view.exit_code, view.error.as_deref()), (CheckState::Failed, None, Some("failed to run tmux: gone")));
        registry.forget(session);
        assert!(registry.runs(session).is_empty());
    }
}
