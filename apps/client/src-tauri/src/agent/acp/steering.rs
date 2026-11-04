//! Steering: a prompt the user sends while a turn runs goes into that turn, as in Claude Code's own terminal, instead of
//! waiting for its end. `claude-agent-acp` takes it through the `_session/steering` request, which it advertises in
//! `_meta.steering.supported` of its `initialize` result, and delivers it between the turn's tool calls. The UI learns
//! whether the agent of a session steers from a `session_info_update` with `_meta.hunt.steering`.

use agent_client_protocol::schema::v1::{ContentBlock, Meta, SessionId, SessionInfoUpdate, SessionNotification, SessionUpdate};
use agent_client_protocol::{Agent, ConnectionTo, ErrorCode, UntypedMessage};
use serde::Serialize;

const STEER_METHOD: &str = "_session/steering";

/// What became of a prompt sent to steer the running turn.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SteerOutcome {
    /// The running turn took the prompt in.
    Injected,
    /// No turn runs (any more); the prompt has to start a turn of its own.
    PromptRequired,
    /// The agent, or the relay of a remote session in between, does not know the steering request.
    Unsupported,
}

/// Whether the agent steers, from the `_meta` of its `initialize` result.
pub fn is_supported(initialize_meta: Option<&Meta>) -> bool {
    initialize_meta
        .and_then(|meta| meta.get("steering"))
        .and_then(|steering| steering.get("supported"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// The `session_info_update` telling the UI that the agent of the session steers.
pub fn supported_update(acp_session_id: &SessionId) -> SessionNotification {
    let mut meta = Meta::new();
    meta.insert("hunt".into(), serde_json::json!({ "steering": true }));
    SessionNotification::new(acp_session_id.clone(), SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().meta(meta)))
}

/// Sends `blocks` into the turn the agent of `acp_session_id` runs. With no turn running the agent leaves the prompt to
/// Hunt (`PromptRequired`) instead of starting a turn whose end Hunt would not see.
pub async fn steer(connection: &ConnectionTo<Agent>, acp_session_id: &SessionId, blocks: Vec<ContentBlock>) -> Result<SteerOutcome, String> {
    let params = serde_json::json!({
        "sessionId": acp_session_id,
        "prompt": blocks,
        "_meta": { "steering": { "idleBehavior": "promptRequired" } },
    });
    let request = UntypedMessage::new(STEER_METHOD, params).map_err(|error| format!("failed to steer the turn: {error}"))?;
    match connection.send_request(request).block_task().await {
        Ok(response) => Ok(outcome_of(&response)),
        Err(error) if error.code == ErrorCode::MethodNotFound => Ok(SteerOutcome::Unsupported),
        Err(error) => Err(format!("failed to steer the turn: {error}")),
    }
}

/// The outcome the agent answered a steering request with. An agent that ignores `idleBehavior` starts a turn of its own
/// for the prompt (`startedNewTurn`), which took it in as well; any other answer leaves the prompt to Hunt.
fn outcome_of(response: &serde_json::Value) -> SteerOutcome {
    match response.get("outcome").and_then(serde_json::Value::as_str) {
        Some("injected" | "startedNewTurn") => SteerOutcome::Injected,
        _ => SteerOutcome::PromptRequired,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_initialize_meta_tells_whether_the_agent_steers() {
        let meta = |value: serde_json::Value| value.as_object().cloned();
        assert!(is_supported(meta(serde_json::json!({ "steering": { "supported": true } })).as_ref()));
        assert!(!is_supported(meta(serde_json::json!({ "steering": { "supported": false } })).as_ref()));
        assert!(!is_supported(meta(serde_json::json!({ "other": true })).as_ref()));
        assert!(!is_supported(None));
    }

    #[test]
    fn a_prompt_the_agent_took_in_counts_as_steered() {
        assert_eq!(outcome_of(&serde_json::json!({ "outcome": "injected" })), SteerOutcome::Injected);
        assert_eq!(outcome_of(&serde_json::json!({ "outcome": "startedNewTurn" })), SteerOutcome::Injected);
        assert_eq!(outcome_of(&serde_json::json!({ "outcome": "promptRequired", "reason": "noRunningTurn" })), SteerOutcome::PromptRequired);
        assert_eq!(outcome_of(&serde_json::Value::Null), SteerOutcome::PromptRequired);
    }
}
