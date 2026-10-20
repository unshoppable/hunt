//! When the messages of a chat were written, as `_meta.hunt.at` (an RFC 3339 time) on their chunks, taken only from
//! the agent's Claude Code transcript (`~/.claude/projects/<slug>/<session id>.jsonl`). A chunk the agent replays while
//! loading a session is stamped as it arrives, by its `messageId` (the entry's `uuid` for a user message, the API
//! message id for an agent reply). A live message is stamped once its turn ended (`resolve`): an agent reply by its
//! API message id, a prompt Hunt sent by the first entry of its turn whose chain of `parentUuid`s leads back to it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentChunk, Meta, SessionNotification, SessionUpdate};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::remote::claude_dir;

/// How often `resolve` reads the transcript before it gives up on a message, and how long it waits in between: a
/// remote session's local copy of the transcript follows its VM's with a short delay.
const RESOLVE_ATTEMPTS: usize = 4;
const RESOLVE_RETRY: Duration = Duration::from_millis(500);
/// The most `parentUuid` links a prompt is searched across, which also ends a chain that runs in a circle.
const MAX_CHAIN: usize = 1000;

/// One entry of a transcript: when it was written, the entry before it and whether it is a prompt (a user entry that
/// is neither a tool result nor meta text Claude Code added).
struct Entry {
    timestamp: String,
    parent: Option<String>,
    is_prompt: bool,
}

/// The entries of a transcript by `uuid`, and the first entry of every API message id and tool use id.
#[derive(Default)]
pub struct Transcript {
    entries: HashMap<String, Entry>,
    first_entries: HashMap<String, String>,
}

impl Transcript {
    /// The transcript of the agent session `acp_session_id`, found in any project folder below `claude_dir`, since a
    /// remote session's local copy lives under the slug of its local worktree; empty when there is none.
    pub fn read(claude_dir: &Path, acp_session_id: &str) -> Self {
        let file_name = format!("{acp_session_id}.jsonl");
        let Ok(projects) = std::fs::read_dir(claude_dir.join("projects")) else { return Self::default() };
        for project in projects.flatten() {
            let Ok(text) = std::fs::read_to_string(project.path().join(&file_name)) else { continue };
            return Self::parse(&text);
        }
        Self::default()
    }

    fn parse(jsonl: &str) -> Self {
        let mut transcript = Self::default();
        for line in jsonl.lines() {
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let text = |pointer: &str| entry.pointer(pointer).and_then(|value| value.as_str()).map(str::to_string);
            let (Some(uuid), Some(timestamp)) = (text("/uuid"), text("/timestamp")) else { continue };
            let content = entry.pointer("/message/content");
            let blocks = content.and_then(|content| content.as_array()).map(Vec::as_slice).unwrap_or_default();
            let block_type = |block: &serde_json::Value| block.get("type").and_then(|value| value.as_str()).unwrap_or_default().to_string();
            let is_prompt = text("/type").as_deref() == Some("user")
                && entry.get("isMeta").and_then(|value| value.as_bool()) != Some(true)
                && (content.is_some_and(|content| content.is_string()) || blocks.iter().any(|block| block_type(block) != "tool_result"));
            let tool_uses = blocks.iter().filter(|block| block_type(block) == "tool_use").filter_map(|block| block.get("id")?.as_str());
            for id in text("/message/id").into_iter().chain(tool_uses.map(str::to_string)) {
                transcript.first_entries.entry(id).or_insert_with(|| uuid.clone());
            }
            transcript.entries.insert(uuid, Entry { timestamp, parent: text("/parentUuid"), is_prompt });
        }
        transcript
    }

    /// When the message `id` (an entry's `uuid` or an API message id) was written.
    fn time_of(&self, id: &str) -> Option<&str> {
        let uuid = self.first_entries.get(id).map(String::as_str).unwrap_or(id);
        self.entries.get(uuid).map(|entry| entry.timestamp.as_str())
    }

    /// When the prompt was written that the entry of `anchor` (an API message id or tool use id) answers.
    fn prompt_time_before(&self, anchor: &str) -> Option<&str> {
        let mut uuid = self.first_entries.get(anchor)?;
        for _ in 0..MAX_CHAIN {
            let entry = self.entries.get(uuid)?;
            if entry.is_prompt {
                return Some(&entry.timestamp);
            }
            uuid = entry.parent.as_ref()?;
        }
        None
    }
}

/// The message chunk `notification` carries, if it is one of the user or of the agent's reply.
fn message_chunk(notification: &mut SessionNotification) -> Option<&mut ContentChunk> {
    match &mut notification.update {
        SessionUpdate::UserMessageChunk(chunk) | SessionUpdate::AgentMessageChunk(chunk) => Some(chunk),
        _ => None,
    }
}

/// The time `meta` holds as `hunt.at`.
fn time_in(meta: Option<&Meta>) -> Option<&str> {
    meta?.get("hunt")?.get("at")?.as_str()
}

/// `meta` with `hunt.at` set to `at`, keeping every other key, including `hunt.hidden`.
fn with_time(meta: Option<Meta>, at: &str) -> Meta {
    let mut meta = meta.unwrap_or_default();
    let hunt = meta.entry("hunt").or_insert_with(|| serde_json::json!({}));
    if !hunt.is_object() {
        *hunt = serde_json::json!({});
    }
    hunt["at"] = serde_json::Value::String(at.to_string());
    meta
}

/// Stamps the message chunk of `notification`, which a load replays from `transcript`, with the time the transcript
/// records for its message; other updates and chunks of unknown messages stay as they are.
pub fn stamp_replayed(notification: &mut SessionNotification, transcript: &Transcript) {
    let Some(chunk) = message_chunk(notification) else { return };
    let Some(at) = chunk.message_id.as_ref().and_then(|id| transcript.time_of(&id.0)) else { return };
    chunk.meta = Some(with_time(chunk.meta.take(), at));
}

/// The entry that tells when the prompt chunk at `index` was written: the first agent reply or tool call after it,
/// up to the next prompt.
fn prompt_anchor(history: &[SessionNotification], index: usize, message_id: &str) -> Option<String> {
    history[index + 1..].iter().find_map(|notification| match &notification.update {
        SessionUpdate::UserMessageChunk(chunk) if chunk.message_id.as_ref().is_some_and(|id| &*id.0 != message_id) => Some(None),
        SessionUpdate::AgentMessageChunk(chunk) => chunk.message_id.as_ref().map(|id| Some(id.0.to_string())),
        SessionUpdate::ToolCall(tool_call) => Some(Some(tool_call.tool_call_id.0.to_string())),
        _ => None,
    })?
}

/// Stamps every message chunk of `history` that has a `messageId` but no time yet with the time `transcript` records
/// for it; returns the new times by message id.
fn stamp_history(history: &mut [SessionNotification], transcript: &Transcript) -> HashMap<String, String> {
    let mut times = HashMap::new();
    for index in 0..history.len() {
        let is_prompt = matches!(history[index].update, SessionUpdate::UserMessageChunk(_));
        let Some(chunk) = message_chunk(&mut history[index]) else { continue };
        if time_in(chunk.meta.as_ref()).is_some() {
            continue;
        }
        let Some(message_id) = chunk.message_id.as_ref().map(|id| id.0.to_string()) else { continue };
        let at = match transcript.time_of(&message_id) {
            Some(at) => Some(at.to_string()),
            None if is_prompt => prompt_anchor(history, index, &message_id).and_then(|anchor| transcript.prompt_time_before(&anchor).map(str::to_string)),
            None => None,
        };
        let Some(at) = at else { continue };
        let chunk = message_chunk(&mut history[index]).expect("checked above");
        chunk.meta = Some(with_time(chunk.meta.take(), &at));
        times.insert(message_id, at);
    }
    times
}

/// Whether a message chunk from `start` on still waits for its time.
fn has_unstamped(history: &mut [SessionNotification], start: usize) -> bool {
    history.iter_mut().skip(start).filter_map(message_chunk).any(|chunk| chunk.message_id.is_some() && time_in(chunk.meta.as_ref()).is_none())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageTimesEvent {
    hunt_session_id: Uuid,
    times: HashMap<String, String>,
}

/// Stamps the messages of `history` with their transcript times in the background once a turn ended, and announces
/// the new times to the UI (`acp:message-times`); retries a few times while a message from `turn_start` on has none.
pub fn resolve(app: AppHandle, hunt_session_id: Uuid, acp_session_id: String, history: Arc<Mutex<Vec<SessionNotification>>>, turn_start: usize) {
    tauri::async_runtime::spawn(async move {
        let claude_dir = match claude_dir() {
            Ok(dir) => dir,
            Err(error) => return eprintln!("failed to resolve the message times: {error}"),
        };
        for attempt in 0..RESOLVE_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(RESOLVE_RETRY).await;
            }
            let (dir, id) = (claude_dir.clone(), acp_session_id.clone());
            let transcript = match tokio::task::spawn_blocking(move || Transcript::read(&dir, &id)).await {
                Ok(transcript) => transcript,
                Err(error) => return eprintln!("failed to read the transcript of {acp_session_id}: {error}"),
            };
            let (times, is_done) = {
                let mut history = history.lock().unwrap();
                let times = stamp_history(&mut history, &transcript);
                (times, !has_unstamped(&mut history, turn_start))
            };
            if !times.is_empty() {
                let _ = app.emit("acp:message-times", MessageTimesEvent { hunt_session_id, times });
            }
            if is_done {
                return;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ContentBlock, MessageId, SessionId, TextContent, ToolCall};

    const TRANSCRIPT: &str = r#"{"type":"user","uuid":"u0","parentUuid":null,"timestamp":"T0","message":{"role":"user","content":"first"}}
{"type":"assistant","uuid":"a0","parentUuid":"u0","timestamp":"T0a","message":{"id":"msg_0","content":[{"type":"text","text":"hi"}]}}
{"type":"user","uuid":"u1","parentUuid":"a0","timestamp":"T1","message":{"role":"user","content":[{"type":"text","text":"second"},{"type":"image"}]}}
{"type":"attachment","uuid":"x1","parentUuid":"u1","timestamp":"T1x"}
{"type":"user","uuid":"m1","parentUuid":"x1","isMeta":true,"timestamp":"T1m","message":{"role":"user","content":[{"type":"text","text":"meta"}]}}
{"type":"assistant","uuid":"a1","parentUuid":"m1","timestamp":"T2","message":{"id":"msg_1","content":[{"type":"tool_use","id":"toolu_1"}]}}
{"type":"user","uuid":"r1","parentUuid":"a1","timestamp":"T3","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1"}]}}
{"type":"assistant","uuid":"a2","parentUuid":"r1","timestamp":"T4","message":{"id":"msg_2","content":[{"type":"text","text":"done"}]}}
{"type":"assistant","uuid":"a3","parentUuid":"a2","timestamp":"T5","message":{"id":"msg_2","content":[{"type":"text","text":"more"}]}}
not json"#;

    fn chunk(message_id: Option<&str>, meta: Option<Meta>) -> ContentChunk {
        let mut chunk = ContentChunk::new(ContentBlock::Text(TextContent::new("text"))).meta(meta);
        chunk.message_id = message_id.map(|id| MessageId::new(id.to_string()));
        chunk
    }

    fn notification(update: SessionUpdate) -> SessionNotification {
        SessionNotification::new(SessionId::new("s"), update)
    }

    fn time_of(notification: &mut SessionNotification) -> Option<String> {
        time_in(message_chunk(notification)?.meta.as_ref()).map(str::to_string)
    }

    #[test]
    fn a_message_id_finds_its_first_entry_and_a_prompt_is_found_across_meta_and_attachments() {
        let transcript = Transcript::parse(TRANSCRIPT);
        assert_eq!(transcript.time_of("u1"), Some("T1"));
        assert_eq!(transcript.time_of("msg_2"), Some("T4"));
        assert_eq!(transcript.prompt_time_before("toolu_1"), Some("T1"));
        assert_eq!(transcript.prompt_time_before("msg_2"), Some("T1"));
        assert_eq!(transcript.prompt_time_before("msg_0"), Some("T0"));
        assert_eq!(transcript.prompt_time_before("msg_9"), None);
    }

    #[test]
    fn a_replayed_chunk_takes_its_transcript_time_and_keeps_the_hidden_flag() {
        let transcript = Transcript::parse(TRANSCRIPT);
        let mut hidden = Meta::new();
        hidden.insert("hunt".into(), serde_json::json!({ "hidden": true }));
        let mut known = notification(SessionUpdate::UserMessageChunk(chunk(Some("u1"), Some(hidden))));
        stamp_replayed(&mut known, &transcript);
        assert_eq!(time_of(&mut known).as_deref(), Some("T1"));
        assert_eq!(message_chunk(&mut known).unwrap().meta.as_ref().unwrap()["hunt"]["hidden"], serde_json::json!(true));

        let mut unknown = notification(SessionUpdate::AgentMessageChunk(chunk(Some("msg_9"), None)));
        stamp_replayed(&mut unknown, &transcript);
        assert_eq!(time_of(&mut unknown), None);
    }

    #[test]
    fn a_prompt_hunt_sent_takes_the_time_its_turn_leads_back_to() {
        let transcript = Transcript::parse(TRANSCRIPT);
        let mut history = vec![
            notification(SessionUpdate::UserMessageChunk(chunk(Some("hunt-1"), None))),
            notification(SessionUpdate::UserMessageChunk(chunk(Some("hunt-1"), None))),
            notification(SessionUpdate::ToolCall(ToolCall::new("toolu_1", "Bash"))),
            notification(SessionUpdate::AgentMessageChunk(chunk(Some("msg_2"), None))),
            notification(SessionUpdate::UserMessageChunk(chunk(Some("hunt-2"), None))),
        ];
        let times = stamp_history(&mut history, &transcript);
        assert_eq!(times, HashMap::from([("hunt-1".to_string(), "T1".to_string()), ("msg_2".to_string(), "T4".to_string())]));
        assert_eq!(time_of(&mut history[1]).as_deref(), Some("T1"));
        assert!(has_unstamped(&mut history, 4));
        assert!(!has_unstamped(&mut history[..4], 0));
    }
}
