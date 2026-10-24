//! When the messages of a chat were written, as `_meta.hunt.at` (an RFC 3339 time) on their chunks, taken only from
//! the agent's Claude Code transcript (`~/.claude/projects/<slug>/<session id>.jsonl`). A chunk the agent replays while
//! loading a session is stamped as it arrives, by its `messageId` (the entry's `uuid` for a user message, the API
//! message id for an agent reply). A live message is stamped once its turn ended (`resolve`): an agent reply by its
//! API message id, a prompt Hunt sent by the first entry of its turn whose chain of `parentUuid`s leads back to it.
//! `last_prompt` reads a transcript's last prompt for `.hunt/sessions.md`.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
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
/// Bytes `last_prompt` reads from a transcript's end first; it doubles them until a prompt shows.
const LAST_PROMPT_BLOCK: u64 = 64 * 1024;
/// The tags whose content Claude Code's transcript adds to a prompt's text: the file of a sub chat's selection
/// (`<context ref="…">`) and reminders.
const ADDED_TAGS: [&str; 2] = ["context", "system-reminder"];

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

/// The content blocks of a transcript entry's message; none when its content is a plain string.
fn blocks_of(entry: &serde_json::Value) -> &[serde_json::Value] {
    entry.pointer("/message/content").and_then(|content| content.as_array()).map(Vec::as_slice).unwrap_or_default()
}

fn block_type(block: &serde_json::Value) -> &str {
    block.get("type").and_then(|value| value.as_str()).unwrap_or_default()
}

/// Whether the transcript entry `entry` is a prompt: a user entry that is neither a tool result nor meta text Claude
/// Code added.
fn is_prompt(entry: &serde_json::Value) -> bool {
    entry.get("type").and_then(|value| value.as_str()) == Some("user")
        && entry.get("isMeta").and_then(|value| value.as_bool()) != Some(true)
        && (entry.pointer("/message/content").is_some_and(|content| content.is_string())
            || blocks_of(entry).iter().any(|block| block_type(block) != "tool_result"))
}

/// The text of the last prompt in the transcript at `path`, without what `ADDED_TAGS` enclose and with its whitespace
/// collapsed to single spaces; `None` without a transcript, a prompt or text in the last prompt. Reads the file from its
/// end, `LAST_PROMPT_BLOCK` bytes first and twice as many each time no prompt shows.
pub fn last_prompt(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let mut length = LAST_PROMPT_BLOCK.min(size);
    loop {
        file.seek(SeekFrom::Start(size - length)).ok()?;
        let mut bytes = Vec::new();
        (&mut file).take(length).read_to_end(&mut bytes).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        // A block that does not start the file starts inside a line.
        let lines = if length < size { text.split_once('\n').map_or("", |(_, rest)| rest) } else { &text };
        let prompt = lines.lines().rev().filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok()).find(is_prompt);
        if let Some(prompt) = prompt {
            return Some(prompt_text(&prompt)).filter(|text| !text.is_empty());
        }
        if length == size {
            return None;
        }
        length = (length * 2).min(size);
    }
}

/// The text of the prompt entry `entry`: its text blocks, without what `ADDED_TAGS` enclose, whitespace collapsed.
fn prompt_text(entry: &serde_json::Value) -> String {
    let text = match entry.pointer("/message/content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        _ => blocks_of(entry)
            .iter()
            .filter(|block| block_type(block) == "text")
            .filter_map(|block| block.get("text")?.as_str())
            .collect::<Vec<_>>()
            .join(" "),
    };
    let text = ADDED_TAGS.iter().fold(text, |text, tag| without_tag(&text, tag));
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `text` without the elements `<tag …>…</tag>`; an element that is not closed runs to the end.
fn without_tag(text: &str, tag: &str) -> String {
    let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
    let mut rest = text;
    let mut kept = String::new();
    while let Some(start) = rest.find(&open) {
        kept.push_str(&rest[..start]);
        rest = rest[start..].find(&close).map_or("", |end| &rest[start + end + close.len()..]);
    }
    kept.push_str(rest);
    kept
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
            let tool_uses = blocks_of(&entry).iter().filter(|block| block_type(block) == "tool_use").filter_map(|block| block.get("id")?.as_str());
            for id in text("/message/id").into_iter().chain(tool_uses.map(str::to_string)) {
                transcript.first_entries.entry(id).or_insert_with(|| uuid.clone());
            }
            transcript.entries.insert(uuid, Entry { timestamp, parent: text("/parentUuid"), is_prompt: is_prompt(&entry) });
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
    fn last_prompt_reads_the_text_of_the_last_prompt_from_the_end_without_added_context() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("s.jsonl");
        assert_eq!(last_prompt(&path), None);
        std::fs::write(&path, TRANSCRIPT).unwrap();
        assert_eq!(last_prompt(&path).as_deref(), Some("second"));

        let selection = r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"text","text":"[@auth.ts](file:///w/auth.ts)"},{"type":"text","text":"Why  this\ncheck?"},{"type":"text","text":"\n<context ref=\"file:///w/auth.ts\">\nlet a = 1;\n</context>"},{"type":"text","text":"<system-reminder>be brief</system-reminder>"}]}}"#;
        let reply = r#"{"type":"assistant","uuid":"a9","message":{"id":"msg_9","content":[{"type":"text","text":"PADDING"}]}}"#.replace("PADDING", &"x".repeat(1000));
        let mut text = format!("{TRANSCRIPT}\n{selection}\n");
        for _ in 0..200 {
            text.push_str(&reply);
            text.push('\n');
        }
        std::fs::write(&path, &text).unwrap();
        assert!(text.len() as u64 > 2 * LAST_PROMPT_BLOCK);
        assert_eq!(last_prompt(&path).as_deref(), Some("[@auth.ts](file:///w/auth.ts) Why this check?"));

        std::fs::write(&path, format!("{selection}\n{}\n", r#"{"type":"user","uuid":"u3","message":{"role":"user","content":[{"type":"image"}]}}"#)).unwrap();
        assert_eq!(last_prompt(&path), None);
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
