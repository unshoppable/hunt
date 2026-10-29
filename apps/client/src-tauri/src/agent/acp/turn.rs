//! Whether the agent of a session runs a turn, as the chat and the sessions file show it. A prompt runs a turn until the
//! agent answered it. Claude Code also runs turns of its own, e.g. when a background task it started stops, which
//! `claude-agent-acp` reports only through their output and the `usage_update` of their result, the only one that
//! carries the cost. Both kinds reach the UI as a `session_info_update` with `_meta.hunt.turn` (`running` or `idle`).

use std::sync::Mutex;

use agent_client_protocol::schema::v1::{Meta, SessionId, SessionInfoUpdate, SessionNotification, SessionUpdate};
use tauri::AppHandle;
use uuid::Uuid;

use super::connection::publish_update;
use crate::session::related;
use crate::session::sync::relay_turn;

/// Publishes that the agent of `hunt_session_id` runs a turn (`is_running`) or ended it, to the UI and the sessions file.
pub fn report_turn(
    app: &AppHandle,
    hunt_session_id: Uuid,
    history: &Mutex<Vec<SessionNotification>>,
    acp_session_id: &SessionId,
    is_running: bool,
) {
    publish_update(app, hunt_session_id, history, turn_update(acp_session_id, if is_running { "running" } else { "idle" }));
    related::set_turn(app, hunt_session_id, is_running);
}

/// The `session_info_update` saying whether the session runs a turn (`turn` is `running` or `idle`), in the
/// `_meta.hunt.turn` shape the relay of a remote session reports it in.
fn turn_update(acp_session_id: &SessionId, turn: &str) -> SessionNotification {
    let mut meta = Meta::new();
    meta.insert("hunt".into(), serde_json::json!({ "turn": turn }));
    SessionNotification::new(acp_session_id.clone(), SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().meta(meta)))
}

/// A turn Claude Code started or ended on its own.
#[derive(Debug, PartialEq, Eq)]
pub enum OwnTurn {
    Started,
    Ended,
}

/// Follows the turns of one session's agent to tell when Claude Code runs one of its own.
#[derive(Default)]
pub struct TurnTracker {
    /// Prompts of this app the agent has not answered yet.
    open_prompts: usize,
    /// A turn the relay of a remote session reports, which a prompt of any of its clients started.
    is_relay_turn_running: bool,
    is_own_turn_running: bool,
}

impl TurnTracker {
    /// Notes a prompt sent to the agent; its turn takes over an own turn that runs.
    pub fn prompt_started(&mut self) {
        self.open_prompts += 1;
        self.is_own_turn_running = false;
    }

    /// Notes that the agent answered a prompt.
    pub fn prompt_ended(&mut self) {
        self.open_prompts = self.open_prompts.saturating_sub(1);
    }

    /// Ends the own turn the user stopped; true when one ran.
    pub fn stop_own_turn(&mut self) -> bool {
        std::mem::replace(&mut self.is_own_turn_running, false)
    }

    /// What `update` of the agent tells about an own turn: output while no prompt's turn runs starts one, the cost of
    /// its result ends it.
    pub fn observe(&mut self, update: &SessionUpdate) -> Option<OwnTurn> {
        match update {
            SessionUpdate::SessionInfoUpdate(info) => {
                match relay_turn(info.meta.as_ref()) {
                    Some("running") => {
                        self.is_relay_turn_running = true;
                        self.is_own_turn_running = false;
                    }
                    Some("idle") => self.is_relay_turn_running = false,
                    _ => {}
                }
                None
            }
            SessionUpdate::AgentMessageChunk(_) | SessionUpdate::AgentThoughtChunk(_) | SessionUpdate::ToolCall(_) => {
                if self.is_own_turn_running || self.open_prompts > 0 || self.is_relay_turn_running {
                    return None;
                }
                self.is_own_turn_running = true;
                Some(OwnTurn::Started)
            }
            SessionUpdate::UsageUpdate(usage) if usage.cost.is_some() && self.is_own_turn_running => {
                self.is_own_turn_running = false;
                Some(OwnTurn::Ended)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ContentBlock, ContentChunk, Cost, TextContent, ToolCall, UsageUpdate};

    fn message() -> SessionUpdate {
        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(TextContent::new("Done."))))
    }

    fn tool_call() -> SessionUpdate {
        SessionUpdate::ToolCall(ToolCall::new("tool-1", "Bash"))
    }

    fn result_usage() -> SessionUpdate {
        SessionUpdate::UsageUpdate(UsageUpdate::new(1000, 200_000).cost(Cost::new(0.5, "USD")))
    }

    fn relay(turn: &str) -> SessionUpdate {
        turn_update(&SessionId::new("acp"), turn).update
    }

    #[test]
    fn output_without_a_prompt_runs_an_own_turn_until_its_result() {
        let mut tracker = TurnTracker::default();
        assert_eq!(tracker.observe(&tool_call()), Some(OwnTurn::Started));
        assert_eq!(tracker.observe(&message()), None);
        assert_eq!(tracker.observe(&SessionUpdate::UsageUpdate(UsageUpdate::new(1000, 200_000))), None);
        assert_eq!(tracker.observe(&result_usage()), Some(OwnTurn::Ended));
        assert_eq!(tracker.observe(&result_usage()), None);
    }

    #[test]
    fn output_of_a_prompt_runs_no_own_turn() {
        let mut tracker = TurnTracker::default();
        tracker.prompt_started();
        tracker.prompt_started();
        tracker.prompt_ended();
        assert_eq!(tracker.observe(&message()), None);
        assert_eq!(tracker.observe(&result_usage()), None);
        tracker.prompt_ended();
        assert_eq!(tracker.observe(&message()), Some(OwnTurn::Started));
    }

    #[test]
    fn a_turn_the_relay_reports_runs_no_own_turn() {
        let mut tracker = TurnTracker::default();
        assert_eq!(tracker.observe(&relay("running")), None);
        assert_eq!(tracker.observe(&tool_call()), None);
        assert_eq!(tracker.observe(&relay("idle")), None);
        assert_eq!(tracker.observe(&tool_call()), Some(OwnTurn::Started));
    }

    #[test]
    fn a_prompt_or_a_stop_ends_the_own_turn() {
        let mut tracker = TurnTracker::default();
        tracker.observe(&message());
        assert!(tracker.stop_own_turn());
        assert!(!tracker.stop_own_turn());
        tracker.observe(&message());
        tracker.prompt_started();
        assert!(!tracker.stop_own_turn());
    }
}
