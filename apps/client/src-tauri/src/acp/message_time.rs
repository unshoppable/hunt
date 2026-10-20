//! When the messages of a chat were written, as `_meta.hunt.at` (an RFC 3339 time) on their chunks: a live chunk gets
//! the time Hunt receives or sends it, a chunk the agent replays while loading a session the time its transcript
//! records for the chunk's `messageId` (the entry's `uuid` for a user message, the API message id for an agent reply).

use std::collections::HashMap;
use std::path::Path;

use agent_client_protocol::schema::v1::{ContentChunk, Meta, SessionNotification, SessionUpdate};
use chrono::{SecondsFormat, Utc};

/// Message ids of a transcript mapped to the time their first entry was written.
pub type TranscriptTimes = HashMap<String, String>;

/// The current time as `_meta.hunt.at` holds it.
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// The message chunk `notification` carries, if it is one of the user or of the agent's reply.
fn message_chunk(notification: &mut SessionNotification) -> Option<&mut ContentChunk> {
    match &mut notification.update {
        SessionUpdate::UserMessageChunk(chunk) | SessionUpdate::AgentMessageChunk(chunk) => Some(chunk),
        _ => None,
    }
}

/// Stamps the message chunk of `notification` with the time `at`, or with the time `replay_times` records for its
/// message while a load replays the transcript; other updates and replayed chunks of unknown messages stay as they are.
pub fn stamp_notification(notification: &mut SessionNotification, replay_times: Option<&TranscriptTimes>) {
    let Some(chunk) = message_chunk(notification) else { return };
    let at = match replay_times {
        Some(times) => chunk.message_id.as_ref().and_then(|id| times.get(&*id.0)).cloned(),
        None => Some(now()),
    };
    if let Some(at) = at {
        chunk.meta = Some(with_time(chunk.meta.take(), &at));
    }
}

/// `meta` with `hunt.at` set to `at`, keeping every other key, including `hunt.hidden`.
pub fn with_time(meta: Option<Meta>, at: &str) -> Meta {
    let mut meta = meta.unwrap_or_default();
    let hunt = meta.entry("hunt").or_insert_with(|| serde_json::json!({}));
    if !hunt.is_object() {
        *hunt = serde_json::json!({});
    }
    hunt["at"] = serde_json::Value::String(at.to_string());
    meta
}

/// The message times of the transcript of the agent session `acp_session_id`, found in any project folder below
/// `claude_dir`, since a remote session's local copy lives under the slug of its local worktree; empty when there is none.
pub fn transcript_times(claude_dir: &Path, acp_session_id: &str) -> TranscriptTimes {
    let file_name = format!("{acp_session_id}.jsonl");
    let Ok(projects) = std::fs::read_dir(claude_dir.join("projects")) else { return TranscriptTimes::new() };
    for project in projects.flatten() {
        let Ok(text) = std::fs::read_to_string(project.path().join(&file_name)) else { continue };
        return parse_times(&text);
    }
    TranscriptTimes::new()
}

/// Maps the `uuid` and the API message id of every transcript entry in `jsonl` to its `timestamp`; a message id that
/// spans several entries keeps the first one's.
fn parse_times(jsonl: &str) -> TranscriptTimes {
    let mut times = TranscriptTimes::new();
    for line in jsonl.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(timestamp) = entry.get("timestamp").and_then(|value| value.as_str()) else { continue };
        let ids = [entry.get("uuid"), entry.pointer("/message/id")];
        for id in ids.into_iter().flatten().filter_map(|value| value.as_str()) {
            times.entry(id.to_string()).or_insert_with(|| timestamp.to_string());
        }
    }
    times
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ContentBlock, MessageId, SessionId, TextContent};

    fn agent_chunk(message_id: Option<&str>, meta: Option<Meta>) -> SessionNotification {
        let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("hi"))).meta(meta);
        chunk.message_id = message_id.map(|id| MessageId::new(id.to_string()));
        SessionNotification::new(SessionId::new("s"), SessionUpdate::AgentMessageChunk(chunk))
    }

    fn time_of(notification: &SessionNotification) -> Option<String> {
        let SessionUpdate::AgentMessageChunk(chunk) = &notification.update else { return None };
        chunk.meta.as_ref()?.get("hunt")?.get("at")?.as_str().map(str::to_string)
    }

    #[test]
    fn transcript_entries_map_their_uuid_and_first_api_message_id() {
        let jsonl = [
            r#"{"type":"user","uuid":"u1","timestamp":"2026-10-19T22:00:05.667Z","message":{"role":"user"}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-10-19T22:00:09.000Z","message":{"id":"msg_1"}}"#,
            r#"{"type":"assistant","uuid":"a2","timestamp":"2026-10-19T22:00:12.000Z","message":{"id":"msg_1"}}"#,
            r#"{"type":"file-history-snapshot"}"#,
            "not json",
        ]
        .join("\n");
        let times = parse_times(&jsonl);
        assert_eq!(times.get("u1").map(String::as_str), Some("2026-10-19T22:00:05.667Z"));
        assert_eq!(times.get("msg_1").map(String::as_str), Some("2026-10-19T22:00:09.000Z"));
        assert_eq!(times.len(), 4);
    }

    #[test]
    fn a_replayed_chunk_takes_its_transcript_time_and_keeps_the_hidden_flag() {
        let times = TranscriptTimes::from([("msg_1".to_string(), "2026-10-19T22:00:09.000Z".to_string())]);
        let mut hidden = Meta::new();
        hidden.insert("hunt".into(), serde_json::json!({ "hidden": true }));
        let mut known = agent_chunk(Some("msg_1"), Some(hidden));
        stamp_notification(&mut known, Some(&times));
        assert_eq!(time_of(&known).as_deref(), Some("2026-10-19T22:00:09.000Z"));
        let SessionUpdate::AgentMessageChunk(chunk) = &known.update else { unreachable!() };
        assert_eq!(chunk.meta.as_ref().unwrap()["hunt"]["hidden"], serde_json::json!(true));

        let mut unknown = agent_chunk(Some("msg_2"), None);
        stamp_notification(&mut unknown, Some(&times));
        assert_eq!(time_of(&unknown), None);
    }

    #[test]
    fn a_live_chunk_takes_the_current_time() {
        let mut live = agent_chunk(None, None);
        stamp_notification(&mut live, None);
        assert!(time_of(&live).is_some_and(|at| at.ends_with('Z')));
    }
}
