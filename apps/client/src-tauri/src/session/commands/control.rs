//! Carries out the requests of the control socket (`crate::platform::control`): opens a session's Chrome, or hands a
//! `hunt-client` command to the main window, whose `useControlCommands` (`src/control/control-commands.hook.ts`) checks
//! and runs it and answers through `answer_control_command`. Only the main window runs commands, since every window and
//! tab of the UI is opened from there.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::browser::open_browser;
use crate::agent::acp::bundled_script_path;
use crate::platform::control::{self, ControlRequest};
use crate::platform::shell::find_on_path;

/// The label of the window that runs the commands.
const MAIN_WINDOW: &str = "main";

/// How long the main window may take to run a command; opening a window boots it first, which takes seconds in a
/// debug build.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);

/// The commands handed to the main window that wait for its answer: `None` when it ran the command, else the error.
#[derive(Default)]
pub struct ControlRegistry(Mutex<HashMap<Uuid, oneshot::Sender<Option<String>>>>);

impl ControlRegistry {
    /// Registers a command waiting for its answer; returns its request ID and the receiver of the answer.
    fn register(&self) -> (Uuid, oneshot::Receiver<Option<String>>) {
        let request_id = Uuid::new_v4();
        let (answer, answer_receiver) = oneshot::channel();
        self.0.lock().unwrap().insert(request_id, answer);
        (request_id, answer_receiver)
    }

    /// Hands the answer `error` (`None` when the command ran) to the command `request_id`.
    fn answer(&self, request_id: Uuid, error: Option<String>) -> Result<(), String> {
        let answer = self.0.lock().unwrap().remove(&request_id).ok_or("failed to answer the command: it is no longer pending")?;
        answer.send(error).map_err(|_| "failed to answer the command: the control socket stopped waiting".to_string())
    }

    /// Forgets the command `request_id`, which gets no answer any more.
    fn forget(&self, request_id: Uuid) {
        self.0.lock().unwrap().remove(&request_id);
    }

    /// Waits up to `timeout` for the answer `answer_receiver` of the command `request_id`; an unanswered one is forgotten.
    async fn wait(&self, request_id: Uuid, answer_receiver: oneshot::Receiver<Option<String>>, timeout: Duration) -> Result<(), String> {
        match tokio::time::timeout(timeout, answer_receiver).await {
            Ok(Ok(None)) => Ok(()),
            Ok(Ok(Some(error))) => Err(error),
            Ok(Err(_)) => Err("failed to run the command: Hunt's main window dropped it".into()),
            Err(_) => {
                self.forget(request_id);
                Err("failed to run the command: Hunt's main window did not answer".into())
            }
        }
    }
}

/// What the main window gets as `control:command`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlCommandEvent {
    request_id: Uuid,
    session_id: Uuid,
    command: Value,
}

/// Carries out the control socket's `request`.
pub async fn carry_out(app: &AppHandle, request: ControlRequest) -> Result<(), String> {
    match request {
        ControlRequest::OpenBrowser { session } => open_browser(app, session, false).await,
        ControlRequest::Ui { session, command } => run_in_main_window(app, session, command).await,
    }
}

/// Hands `command` for the session `session_id` to the main window and waits for its answer.
async fn run_in_main_window(app: &AppHandle, session_id: Uuid, command: Value) -> Result<(), String> {
    let controls = app.state::<ControlRegistry>();
    let (request_id, answer_receiver) = controls.register();
    let event = ControlCommandEvent { request_id, session_id, command };
    if let Err(error) = app.emit_to(MAIN_WINDOW, "control:command", event) {
        controls.forget(request_id);
        return Err(format!("failed to run the command: {error}"));
    }
    controls.wait(request_id, answer_receiver, ANSWER_TIMEOUT).await
}

/// The main window's answer to the command `request_id`: `None` when it ran, else the error the `hunt-client` call
/// prints.
#[tauri::command]
pub fn answer_control_command(controls: State<'_, ControlRegistry>, request_id: Uuid, error: Option<String>) -> Result<(), String> {
    controls.answer(request_id, error)
}

/// Writes the worktree's `.hunt/hunt-client` for an agent on this Mac, which runs the bundled `hunt-client` script with
/// the `node` on the PATH.
pub fn prepare_client(app: &AppHandle, worktree: &Path) -> Result<(), String> {
    let node = find_on_path("node").ok_or("failed to prepare hunt-client: node is not on the PATH")?;
    let script = bundled_script_path(app, control::CLIENT_SCRIPT)?;
    control::prepare_client(worktree, &node, &script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_command_ends_with_the_answer_of_the_main_window() {
        let controls = ControlRegistry::default();
        let (done_id, done_receiver) = controls.register();
        controls.answer(done_id, None).unwrap();
        assert_eq!(controls.wait(done_id, done_receiver, ANSWER_TIMEOUT).await, Ok(()));

        let (failed_id, failed_receiver) = controls.register();
        controls.answer(failed_id, Some("failed to open the file: it is outside the worktree".into())).unwrap();
        assert_eq!(controls.wait(failed_id, failed_receiver, ANSWER_TIMEOUT).await, Err("failed to open the file: it is outside the worktree".into()));
        assert!(controls.answer(failed_id, None).unwrap_err().contains("no longer pending"));
    }

    #[tokio::test]
    async fn an_unanswered_command_is_forgotten() {
        let controls = ControlRegistry::default();
        let (request_id, answer_receiver) = controls.register();
        let error = controls.wait(request_id, answer_receiver, Duration::from_millis(10)).await.unwrap_err();
        assert!(error.contains("did not answer"), "{error}");
        assert!(controls.0.lock().unwrap().is_empty());
        assert!(controls.answer(request_id, None).is_err());
    }
}
