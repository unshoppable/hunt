//! `hunt attach`: a line-based chat in the terminal with the agent of a remote session, through the session's relay on
//! its VM like Hunt's own connection (`agent/acp/connection.rs`). The relay serves any number of clients: it replays the
//! conversation to each one that loads it, queues the prompts of all of them and asks every one for a permission, the
//! first answer winning; so Hunt stays connected meanwhile. Each line typed is a prompt; Ctrl+C cancels the running turn,
//! a second Ctrl+C (or one while no turn runs) and Ctrl+D end the chat, which leaves the agent's turn running.

use std::collections::VecDeque;
use std::io::Write;
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, InitializeRequest, LoadSessionRequest, PermissionOptionKind, PromptRequest,
    PromptResponse, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, StopReason, TextContent, ToolCallStatus,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{
    on_receive_notification, on_receive_request, AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, RequestCancellation, Responder,
};
use futures_util::stream::{FuturesUnordered, StreamExt};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use super::{RemoteSession, StderrProgress};
use crate::remote::{hunt_ctl, local_token_input, relay_conversation, relay_stream_command, start_relay, RemoteStep, Reporter};

/// How many lines of the replayed conversation the chat shows when it starts.
const REPLAY_LINES: usize = 40;

/// How long the relay may take to serve the conversation after `hunt-ctl start`.
const RELAY_WAIT_SECONDS: &str = "180";

/// What the chat says how to use it, once the conversation is shown.
const HELP: &str = "Type a message and press Enter to send it. Ctrl+C cancels the agent's turn, Ctrl+D quits.";

/// Chats with the agent of `session` in the terminal, with the Claude account active in the app data folder `data_dir`:
/// starts the VM and the relay unless they run, loads the relay's conversation and shows its last lines, then sends
/// every line typed until the user quits.
pub async fn attach(data_dir: &Path, session: &RemoteSession) -> Result<(), String> {
    let (ssh, target) = super::vm::start_vm(session).await?;
    StderrProgress.step(RemoteStep::ConnectingAgent);
    // The same tokens as Hunt's, so a relay that runs for Hunt keeps running.
    start_relay(&ssh, session.record.id, target.origin, &local_token_input(data_dir).await?).await?;
    let status = hunt_ctl(&ssh, &["wait", &session.record.id.to_string(), "--timeout", RELAY_WAIT_SECONDS]).await?;
    let acp_session_id = relay_conversation(&status, session.record.acp_session_id.as_deref())
        .ok_or_else(|| format!("failed to attach to session {}: its relay reports no conversation", session.short_id()))?;
    eprintln!("attached to session {} \"{}\" on {}", session.short_id(), session.record.title, target.vm.instance);
    chat(ssh.stream_args(&relay_stream_command()), target.worktree_path, acp_session_id).await
}

/// Runs the chat over the ACP stream `ssh_args` opens to the relay, in the conversation `acp_session_id` of the
/// worktree `cwd`.
async fn chat(ssh_args: Vec<String>, cwd: PathBuf, acp_session_id: String) -> Result<(), String> {
    let screen = Arc::new(Mutex::new(Screen::replaying()));
    let notification_screen = screen.clone();
    let (permission_sender, permissions) = unbounded_channel::<Question>();
    let agent = AcpAgent::new(AcpAgentConfig::new("ssh").args(ssh_args));
    let conversation = Conversation { session_id: SessionId::new(acp_session_id), cwd, screen, permissions };
    let result = Client
        .builder()
        .name("hunt-cli")
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                let text = notification_screen.lock().unwrap().show(&notification.update);
                print_now(&text);
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder: Responder<RequestPermissionResponse>, _connection| {
                // Answered by the chat loop with the next line typed; the handler must not wait for it.
                let cancellation = responder.cancellation();
                let _ = permission_sender.send(Question { request, responder, cancellation });
                Ok(())
            },
            on_receive_request!(),
        )
        .connect_with(agent, async move |connection: ConnectionTo<Agent>| Ok(conversation.run(connection).await))
        .await;
    result.map_err(|error| format!("the connection to the agent failed: {error}"))?
}

/// The chat's side of the connection: the conversation it loads, the screen and the permission requests waiting for
/// an answer.
struct Conversation {
    session_id: SessionId,
    cwd: PathBuf,
    screen: Arc<Mutex<Screen>>,
    permissions: UnboundedReceiver<Question>,
}

/// A permission request of the agent waiting for the user's answer.
struct Question {
    request: RequestPermissionRequest,
    responder: Responder<RequestPermissionResponse>,
    /// Fires when another client answered first and the relay withdrew the request.
    cancellation: RequestCancellation,
}

impl Conversation {
    /// Loads the conversation, shows its end and then sends what the user types until the chat ends; fails when the
    /// relay closes the connection.
    async fn run(mut self, connection: ConnectionTo<Agent>) -> Result<(), String> {
        let failed = |error: agent_client_protocol::Error| format!("failed to load the conversation: {error}");
        let initialize = InitializeRequest::new(ProtocolVersion::V1).client_capabilities(ClientCapabilities::new());
        connection.send_request(initialize).block_task().await.map_err(failed)?;
        connection.send_request(LoadSessionRequest::new(self.session_id.clone(), self.cwd.clone())).block_task().await.map_err(failed)?;
        let replayed = self.screen.lock().unwrap().end_replay();
        print_now(&replayed);
        eprintln!("{HELP}");

        let mut interrupts = signal(SignalKind::interrupt()).map_err(|error| format!("failed to listen for Ctrl+C: {error}"))?;
        let mut lines = typed_lines();
        // The prompts sent that wait for their turn's end. Never dropped while one waits: dropping it sends
        // `$/cancel_request`, which would cancel the turn for every client, whereas the relay runs the prompts of a client
        // that leaves.
        let mut turns = ManuallyDrop::new(FuturesUnordered::new());
        let mut is_cancelling = false;
        let mut questions: VecDeque<Question> = VecDeque::new();
        loop {
            let asked = questions.front().map(|question| question.cancellation.clone());
            tokio::select! {
                line = lines.recv() => {
                    let Some(line) = line else { return Ok(()) };
                    if let Some(question) = questions.pop_front() {
                        let notice = answer(question, &line);
                        self.notice(&notice);
                        self.ask_next(&questions);
                        continue;
                    }
                    let text = line.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let prompt = PromptRequest::new(self.session_id.clone(), vec![ContentBlock::Text(TextContent::new(text))]);
                    turns.push(connection.send_request(prompt).block_task());
                }
                Some(ended) = turns.next() => {
                    if turns.is_empty() {
                        is_cancelling = false;
                    }
                    let text = self.screen.lock().unwrap().turn_ended(&ended);
                    print_now(&text);
                }
                Some(question) = self.permissions.recv() => {
                    questions.push_back(question);
                    if questions.len() == 1 {
                        self.ask_next(&questions);
                    }
                }
                () = withdrawn(asked) => {
                    questions.pop_front();
                    self.notice("answered in another client");
                    self.ask_next(&questions);
                }
                _ = interrupts.recv() => {
                    if turns.is_empty() || is_cancelling {
                        return Ok(());
                    }
                    connection
                        .send_notification(CancelNotification::new(self.session_id.clone()))
                        .map_err(|error| format!("failed to cancel the turn: {error}"))?;
                    is_cancelling = true;
                    self.notice("cancelling the turn; Ctrl+C again quits");
                }
                () = connection.incoming_closed() => return Err("the relay closed the connection".into()),
            }
        }
    }

    /// Shows the first of `questions`, if any, as a question the next line answers.
    fn ask_next(&self, questions: &VecDeque<Question>) {
        let Some(question) = questions.front() else { return };
        let title = question.request.tool_call.fields.title.as_deref().unwrap_or("a tool call");
        self.notice(&format!("the agent asks to run {title}; allow it? [y/N]"));
    }

    /// Shows `notice` on a line of its own.
    fn notice(&self, notice: &str) {
        let text = self.screen.lock().unwrap().line(&format!("· {notice}"));
        print_now(&text);
    }
}

/// The lines typed in the terminal, read on a thread of their own: a read of tokio's stdin cannot be cancelled and would
/// hold up the runtime's shutdown until the next Enter. The channel closes at Ctrl+D or when the terminal fails.
fn typed_lines() -> UnboundedReceiver<String> {
    let (sender, receiver) = unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                return;
            }
        }
    });
    receiver
}

/// Waits until the relay withdraws the question `asked` was taken from; never for no question.
async fn withdrawn(asked: Option<RequestCancellation>) {
    match asked {
        Some(cancellation) => cancellation.cancelled().await,
        None => std::future::pending().await,
    }
}

/// Answers `question` with the line `line` typed: `y` or `yes` allows the tool call once, anything else rejects it.
/// Returns what the chat says about it.
fn answer(question: Question, line: &str) -> String {
    let allows = matches!(line.trim().to_lowercase().as_str(), "y" | "yes");
    let kinds = if allows {
        [PermissionOptionKind::AllowOnce, PermissionOptionKind::AllowAlways]
    } else {
        [PermissionOptionKind::RejectOnce, PermissionOptionKind::RejectAlways]
    };
    let option = kinds.iter().find_map(|kind| question.request.options.iter().find(|option| option.kind == *kind));
    let outcome = match option {
        Some(option) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone())),
        None => RequestPermissionOutcome::Cancelled,
    };
    match question.responder.respond(RequestPermissionResponse::new(outcome)) {
        Ok(()) if allows => "allowed".to_string(),
        Ok(()) => "rejected".to_string(),
        Err(error) => format!("failed to answer: {error}"),
    }
}

/// Writes `text` to stdout right away.
fn print_now(text: &str) {
    if text.is_empty() {
        return;
    }
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

/// What the terminal shows of the conversation: the agent's text as it streams, a line per tool call, per failed tool
/// call and per prompt. While the relay replays the conversation it collects instead, and shows only its last
/// `REPLAY_LINES` lines once the replay ends. Each method returns the text to print.
struct Screen {
    /// The replay so far; `None` once the conversation is live.
    replay: Option<String>,
    /// Whether the text shown last ended its line.
    at_line_start: bool,
}

impl Screen {
    fn replaying() -> Self {
        Screen { replay: Some(String::new()), at_line_start: true }
    }

    /// Shows `update`.
    fn show(&mut self, update: &SessionUpdate) -> String {
        match shown(update, self.replay.is_some()) {
            Some(Shown::Text(text)) => self.text(&text),
            Some(Shown::Line(line)) => self.line(&line),
            None => String::new(),
        }
    }

    /// Ends the replay; returns its last `REPLAY_LINES` lines, after a line that says how many it left out.
    fn end_replay(&mut self) -> String {
        let Some(replay) = self.replay.take() else { return String::new() };
        let lines: Vec<&str> = replay.lines().collect();
        let start = lines.len().saturating_sub(REPLAY_LINES);
        let mut text = String::new();
        if start > 0 {
            text.push_str(&format!("· {start} earlier lines of the conversation left out\n"));
        }
        for line in &lines[start..] {
            text.push_str(line);
            text.push('\n');
        }
        self.at_line_start = true;
        text
    }

    /// Ends the turn `ended`: says why unless the agent simply finished.
    fn turn_ended(&mut self, ended: &Result<PromptResponse, agent_client_protocol::Error>) -> String {
        let reason = match ended {
            Ok(response) => match response.stop_reason {
                StopReason::EndTurn => None,
                StopReason::Cancelled => Some("the turn was cancelled".to_string()),
                StopReason::MaxTokens => Some("the turn stopped at the token limit".to_string()),
                StopReason::MaxTurnRequests => Some("the turn stopped at the request limit".to_string()),
                StopReason::Refusal => Some("the agent refused".to_string()),
                other => Some(format!("the turn stopped: {other:?}")),
            },
            Err(error) => Some(format!("the turn failed: {error}")),
        };
        match reason {
            Some(reason) => self.line(&format!("· {reason}")),
            None => self.end_line(),
        }
    }

    /// Streams `text` of the agent.
    fn text(&mut self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        self.at_line_start = text.ends_with('\n');
        self.emit(text.to_string())
    }

    /// Shows `line` on a line of its own.
    fn line(&mut self, line: &str) -> String {
        let text = format!("{}{line}\n", if self.at_line_start { "" } else { "\n" });
        self.at_line_start = true;
        self.emit(text)
    }

    /// Ends the current line unless it is ended.
    fn end_line(&mut self) -> String {
        if self.at_line_start {
            return String::new();
        }
        self.at_line_start = true;
        self.emit("\n".to_string())
    }

    /// `text` to print now, or nothing while it goes to the replay.
    fn emit(&mut self, text: String) -> String {
        match &mut self.replay {
            Some(replay) => {
                replay.push_str(&text);
                String::new()
            }
            None => text,
        }
    }
}

/// How the terminal shows an update.
#[derive(Debug, PartialEq)]
enum Shown {
    /// Text of the agent, streamed as it comes.
    Text(String),
    /// A line of its own.
    Line(String),
}

/// How the terminal shows `update`; `None` for what it leaves out: thoughts, plans, tool output, the session's state
/// and the prompts Hunt sends on its own. A prompt that arrives live comes from another client, since the relay never
/// echoes one to its sender; the replay holds every client's.
fn shown(update: &SessionUpdate, is_replay: bool) -> Option<Shown> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
            ContentBlock::Text(text) => Some(Shown::Text(text.text.clone())),
            _ => None,
        },
        SessionUpdate::UserMessageChunk(chunk) => {
            let hunt_meta = chunk.meta.as_ref().and_then(|meta| meta.get("hunt"));
            let is_hidden = hunt_meta.and_then(|hunt| hunt.get("hidden")).and_then(serde_json::Value::as_bool);
            let ContentBlock::Text(text) = &chunk.content else { return None };
            if is_hidden == Some(true) {
                return None;
            }
            let marker = if is_replay { "›" } else { "› (another client)" };
            Some(Shown::Line(format!("{marker} {}", text.text.trim_end().replace('\n', "\n  "))))
        }
        SessionUpdate::ToolCall(call) => Some(Shown::Line(format!("▸ {}", call.title))),
        SessionUpdate::ToolCallUpdate(update) if update.fields.status == Some(ToolCallStatus::Failed) => {
            Some(Shown::Line(format!("  ✗ {} failed", update.fields.title.as_deref().unwrap_or("the tool call"))))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The session update of the ACP JSON `json`.
    fn update(json: serde_json::Value) -> SessionUpdate {
        serde_json::from_value(json).unwrap()
    }

    fn agent_text(text: &str) -> SessionUpdate {
        update(serde_json::json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }))
    }

    fn user_text(text: &str, meta: serde_json::Value) -> SessionUpdate {
        update(serde_json::json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": text }, "_meta": meta }))
    }

    fn tool_call(title: &str) -> SessionUpdate {
        update(serde_json::json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": title, "kind": "execute", "status": "pending" }))
    }

    #[test]
    fn the_agents_text_streams_and_tool_calls_take_a_line_of_their_own() {
        let mut screen = Screen { replay: None, at_line_start: true };
        assert_eq!(screen.show(&agent_text("Let me ")), "Let me ");
        assert_eq!(screen.show(&agent_text("check.")), "check.");
        assert_eq!(screen.show(&tool_call("npm test")), "\n▸ npm test\n");
        let failed =
            update(serde_json::json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "failed", "title": "npm test" }));
        assert_eq!(screen.show(&failed), "  ✗ npm test failed\n");
        let done = update(serde_json::json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" }));
        assert_eq!(screen.show(&done), "");
        assert_eq!(screen.show(&agent_text("All green.")), "All green.");
        assert_eq!(screen.turn_ended(&Ok(PromptResponse::new(StopReason::EndTurn))), "\n");
        assert_eq!(screen.turn_ended(&Ok(PromptResponse::new(StopReason::Cancelled))), "· the turn was cancelled\n");
    }

    #[test]
    fn prompts_show_who_sent_them_and_hidden_ones_stay_hidden() {
        assert_eq!(shown(&user_text("Fix it\nplease", serde_json::Value::Null), true), Some(Shown::Line("› Fix it\n  please".into())));
        assert_eq!(shown(&user_text("Fix it", serde_json::Value::Null), false), Some(Shown::Line("› (another client) Fix it".into())));
        assert_eq!(shown(&user_text("Start the services", serde_json::json!({ "hunt": { "hidden": true } })), false), None);
        let thought = update(serde_json::json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hmm" } }));
        assert_eq!(shown(&thought, false), None);
    }

    #[test]
    fn the_replay_shows_only_its_last_lines() {
        let mut screen = Screen::replaying();
        for index in 0..45 {
            assert_eq!(screen.show(&tool_call(&format!("step {index}"))), "");
        }
        let replayed = screen.end_replay();
        let lines: Vec<&str> = replayed.lines().collect();
        assert_eq!(lines.len(), REPLAY_LINES + 1);
        assert_eq!(lines[0], "· 5 earlier lines of the conversation left out");
        assert_eq!(lines[1], "▸ step 5");
        assert_eq!(lines[REPLAY_LINES], "▸ step 44");
        assert_eq!(screen.show(&agent_text("live")), "live");

        let mut short = Screen::replaying();
        short.show(&agent_text("Hello"));
        assert_eq!(short.end_replay(), "Hello\n");
    }
}
