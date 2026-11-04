//! The native subagent sessions of claude-agent-acp: with `clientCapabilities.subagents` the adapter runs every
//! subagent (Agent/Task tool) in a child session of its own, announces it on its parent session with a
//! `subagent_spawned` update, re-addresses the child's traffic to the child's session ID and reports its end with a
//! `subagent_state_update`. A load replays each child's history from `<session>/subagents/agent-<id>.jsonl` the same
//! way, under the child ID `<session>:replay-subagent:<tool use id>`.
//!
//! Both updates are the adapter's preliminary shape, which the typed `SessionNotification` cannot parse; `translate`
//! turns them into the protocol's `subagent_update`, whose `_meta.hunt.subagent` carries what the chat shows: the
//! child's state, its prompt and its token usage. The usage of a live child comes from the raw SDK messages
//! `task_progress` and `task_notification` the adapter forwards as `_claude/sdkMessage` (see `raw_sdk_messages`); a
//! replayed child's is read from its transcript, since a replay forwards none.

use std::collections::HashMap;
use std::path::Path;

use agent_client_protocol::schema::v1::{Meta, SessionId, SessionNotification, SessionUpdate, SubagentUpdate};
use serde::Serialize;
use serde_json::{json, Value};

/// The JSON-RPC method of the adapter's session updates.
const SESSION_UPDATE_METHOD: &str = "session/update";
/// The ext notification that carries a raw SDK message (`raw_sdk_messages`).
const SDK_MESSAGE_METHOD: &str = "_claude/sdkMessage";
/// Separates the root session from the tool use ID in the ID of a replayed child.
const REPLAY_SEPARATOR: &str = ":replay-subagent:";
/// Separates the task ID from the generation in the ID of a resumed child.
const GENERATION_SEPARATOR: &str = ":generation:";

/// What a subagent spent, as Claude Code reports it: `total_tokens` is the size of its last request (input, cache and
/// output tokens), which grows with every step, not a sum over its requests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentUsage {
    pub total_tokens: u64,
    pub tool_uses: u64,
    pub duration_ms: u64,
}

/// The subagents of one agent connection: the parent session of every child and the latest child of every task, so
/// that a task's usage reaches the child that runs it.
#[derive(Default)]
pub struct SubagentTree {
    parents: HashMap<String, SessionId>,
    tasks: HashMap<String, String>,
    usage: HashMap<String, SubagentUsage>,
    /// The usage of the replayed children of a root session, by tool use ID; read once per root.
    replayed_usage: HashMap<String, HashMap<String, SubagentUsage>>,
}

/// The `session/new` and `session/load` meta that has the adapter forward the raw SDK messages carrying a subagent's
/// usage as `_claude/sdkMessage`.
pub fn raw_sdk_messages() -> Value {
    json!([
        { "type": "system", "subtype": "task_progress" },
        { "type": "system", "subtype": "task_notification" },
    ])
}

impl SubagentTree {
    /// Whether `session_id` is a child session, whose updates belong to a subagent.
    pub fn is_child(&self, session_id: &SessionId) -> bool {
        self.parents.contains_key(&*session_id.0)
    }

    /// The `subagent_update` an untyped notification stands for; `None` for every other notification, which the typed
    /// handler takes. Usage the chat already shows yields `None` as well. `claude_dir` holds the transcripts the usage of
    /// a replayed child is read from.
    pub fn translate(&mut self, method: &str, params: &Value, claude_dir: Option<&Path>) -> Option<SessionNotification> {
        match method {
            SESSION_UPDATE_METHOD => self.session_update(params, claude_dir),
            SDK_MESSAGE_METHOD => self.sdk_message(params),
            _ => None,
        }
    }

    fn session_update(&mut self, params: &Value, claude_dir: Option<&Path>) -> Option<SessionNotification> {
        let parent = SessionId::new(params.get("sessionId")?.as_str()?);
        let update = params.get("update")?;
        let child = update.get("subagentSessionId")?.as_str()?.to_string();
        let text = |key: &str| update.get(key).and_then(Value::as_str).map(str::to_string);
        match update.get("sessionUpdate")?.as_str()? {
            "subagent_spawned" => {
                self.parents.insert(child.clone(), parent.clone());
                self.tasks.insert(task_of(&child).to_string(), child.clone());
                let mut subagent = json!({ "state": "running" });
                if let Some(prompt) = text("prompt") {
                    subagent["prompt"] = Value::String(prompt);
                }
                if let Some(usage) = self.replayed(&child, claude_dir) {
                    self.usage.insert(child.clone(), usage);
                    subagent["usage"] = json!(usage);
                }
                let mut announced = SubagentUpdate::new(child).meta(hunt_meta(subagent));
                if let Some(name) = text("name") {
                    announced = announced.title(name);
                }
                if let Some(task) = text("task") {
                    announced = announced.description(task);
                }
                Some(SessionNotification::new(parent, SessionUpdate::SubagentUpdate(announced)))
            }
            "subagent_state_update" => {
                let state = text("state")?;
                let changed = SubagentUpdate::new(child).meta(hunt_meta(json!({ "state": state })));
                Some(SessionNotification::new(parent, SessionUpdate::SubagentUpdate(changed)))
            }
            _ => None,
        }
    }

    fn sdk_message(&mut self, params: &Value) -> Option<SessionNotification> {
        let message = params.get("message")?;
        if !matches!(message.get("subtype")?.as_str()?, "task_progress" | "task_notification") {
            return None;
        }
        let child = self.tasks.get(message.get("task_id")?.as_str()?)?.clone();
        let usage = message.get("usage")?;
        let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or_default();
        let usage = SubagentUsage { total_tokens: count("total_tokens"), tool_uses: count("tool_uses"), duration_ms: count("duration_ms") };
        if self.usage.get(&child) == Some(&usage) {
            return None;
        }
        self.usage.insert(child.clone(), usage);
        let parent = self.parents.get(&child)?.clone();
        let changed = SubagentUpdate::new(child).meta(hunt_meta(json!({ "usage": usage })));
        Some(SessionNotification::new(parent, SessionUpdate::SubagentUpdate(changed)))
    }

    /// The usage of the replayed child `child`, read from the transcripts of its root session below `claude_dir`.
    fn replayed(&mut self, child: &str, claude_dir: Option<&Path>) -> Option<SubagentUsage> {
        let (root, tool_use_id) = child.split_once(REPLAY_SEPARATOR)?;
        let usage = self
            .replayed_usage
            .entry(root.to_string())
            .or_insert_with(|| claude_dir.map(|dir| read_replayed_usage(dir, root)).unwrap_or_default());
        usage.get(tool_use_id).copied()
    }
}

/// The task a child runs: a resumed child's ID is its task's plus a generation.
fn task_of(child: &str) -> &str {
    child.split_once(GENERATION_SEPARATOR).map_or(child, |(task, _)| task)
}

/// `{"hunt": {"subagent": subagent}}`, the meta the chat reads a subagent's state, prompt and usage from.
fn hunt_meta(subagent: Value) -> Meta {
    let mut meta = Meta::new();
    meta.insert("hunt".into(), json!({ "subagent": subagent }));
    meta
}

/// The usage of every subagent of the session `root`, by the tool use ID that started it: the subagent transcripts
/// `<project>/<root>/subagents/agent-<id>.jsonl` of any project folder below `claude_dir` (a remote session's copy lives
/// under the slug of its local worktree), each named by its `agent-<id>.meta.json`.
fn read_replayed_usage(claude_dir: &Path, root: &str) -> HashMap<String, SubagentUsage> {
    let mut usage = HashMap::new();
    let Ok(projects) = std::fs::read_dir(claude_dir.join("projects")) else { return usage };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path().join(root).join("subagents")) else { continue };
        for file in files.flatten() {
            let path = file.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
            let Some(agent) = name.strip_suffix(".meta.json") else { continue };
            let Some(tool_use_id) = std::fs::read_to_string(&path).ok().and_then(|text| tool_use_id_of(&text)) else { continue };
            let Ok(transcript) = std::fs::read_to_string(path.with_file_name(format!("{agent}.jsonl"))) else { continue };
            usage.insert(tool_use_id, usage_of(&transcript));
        }
        break;
    }
    usage
}

/// The `toolUseId` of a subagent's `.meta.json`.
fn tool_use_id_of(meta_json: &str) -> Option<String> {
    let meta: Value = serde_json::from_str(meta_json).ok()?;
    Some(meta.get("toolUseId")?.as_str()?.to_string())
}

/// What the subagent transcript `jsonl` spent, counted like `task_progress`: the tokens of its last request, its tool
/// uses and the time from its first to its last record.
fn usage_of(jsonl: &str) -> SubagentUsage {
    let mut usage = SubagentUsage::default();
    let mut tool_uses = std::collections::HashSet::new();
    let (mut first, mut last) = (None, None);
    for line in jsonl.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(at) = entry.get("timestamp").and_then(Value::as_str).and_then(timestamp_ms) {
            first = first.or(Some(at));
            last = Some(at);
        }
        if entry.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message) = entry.get("message") else { continue };
        if let Some(tokens) = message.get("usage") {
            let count = |key: &str| tokens.get(key).and_then(Value::as_u64).unwrap_or_default();
            usage.total_tokens = count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens") + count("output_tokens");
        }
        let blocks = message.get("content").and_then(Value::as_array).into_iter().flatten();
        for block in blocks.filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use")) {
            if let Some(id) = block.get("id").and_then(Value::as_str) {
                tool_uses.insert(id.to_string());
            }
        }
    }
    usage.tool_uses = tool_uses.len() as u64;
    usage.duration_ms = match (first, last) {
        (Some(first), Some(last)) => last.saturating_sub(first),
        _ => 0,
    };
    usage
}

/// The milliseconds since the epoch of an RFC 3339 timestamp.
fn timestamp_ms(text: &str) -> Option<u64> {
    let time = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    u64::try_from(time.timestamp_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "7e012531-89e1-4011-a2d2-20999cdb5a15";

    /// Recorded from claude-agent-acp 0.89.1 with `clientCapabilities.subagents`.
    fn spawned(parent: &str, child: &str, prompt: Option<&str>) -> Value {
        let mut update = json!({
            "sessionUpdate": "subagent_spawned",
            "subagentSessionId": child,
            "name": "Count files",
            "task": "Run `ls | wc -l` and report the number.",
            "capabilities": {},
        });
        if let Some(prompt) = prompt {
            update["prompt"] = json!(prompt);
        }
        json!({ "sessionId": parent, "update": update })
    }

    fn progress(task: &str, total_tokens: u64) -> Value {
        json!({ "sessionId": ROOT, "message": {
            "type": "system", "subtype": "task_progress", "task_id": task, "tool_use_id": "toolu_1",
            "usage": { "total_tokens": total_tokens, "tool_uses": 1, "duration_ms": 1307 },
        } })
    }

    fn as_json(notification: SessionNotification) -> Value {
        serde_json::to_value(notification).unwrap()
    }

    #[test]
    fn announces_a_spawned_child_as_a_running_subagent_of_its_parent() {
        let mut tree = SubagentTree::default();
        let notification = tree.translate(SESSION_UPDATE_METHOD, &spawned(ROOT, "a84ac2fc8a50f5d9a", Some("Run it.")), None).unwrap();
        assert_eq!(
            as_json(notification),
            json!({ "sessionId": ROOT, "update": {
                "sessionUpdate": "subagent_update",
                "sessionId": "a84ac2fc8a50f5d9a",
                "title": "Count files",
                "description": "Run `ls | wc -l` and report the number.",
                "_meta": { "hunt": { "subagent": { "state": "running", "prompt": "Run it." } } },
            } })
        );
        assert!(tree.is_child(&SessionId::new("a84ac2fc8a50f5d9a")));
        assert!(!tree.is_child(&SessionId::new(ROOT)));
    }

    #[test]
    fn reports_the_end_of_a_child_as_its_state() {
        let mut tree = SubagentTree::default();
        let ended = json!({ "sessionId": ROOT, "update": {
            "sessionUpdate": "subagent_state_update", "subagentSessionId": "a84ac2fc8a50f5d9a", "state": "completed",
        } });
        let notification = tree.translate(SESSION_UPDATE_METHOD, &ended, None).unwrap();
        assert_eq!(as_json(notification)["update"]["_meta"], json!({ "hunt": { "subagent": { "state": "completed" } } }));
    }

    #[test]
    fn passes_every_other_notification_on() {
        let mut tree = SubagentTree::default();
        let chunk = json!({ "sessionId": ROOT, "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } } });
        assert!(tree.translate(SESSION_UPDATE_METHOD, &chunk, None).is_none());
        assert!(tree.translate("_auth/status_update", &json!({}), None).is_none());
    }

    #[test]
    fn gives_the_usage_of_a_task_to_its_latest_child_once_per_change() {
        let mut tree = SubagentTree::default();
        tree.translate(SESSION_UPDATE_METHOD, &spawned(ROOT, "a84ac2fc8a50f5d9a", None), None);
        tree.translate(SESSION_UPDATE_METHOD, &spawned(ROOT, "a84ac2fc8a50f5d9a:generation:1", None), None);
        let notification = tree.translate(SDK_MESSAGE_METHOD, &progress("a84ac2fc8a50f5d9a", 16347), None).unwrap();
        let json = as_json(notification);
        assert_eq!(json["sessionId"], ROOT);
        assert_eq!(json["update"]["sessionId"], "a84ac2fc8a50f5d9a:generation:1");
        assert_eq!(
            json["update"]["_meta"],
            json!({ "hunt": { "subagent": { "usage": { "totalTokens": 16347, "toolUses": 1, "durationMs": 1307 } } } })
        );
        assert!(tree.translate(SDK_MESSAGE_METHOD, &progress("a84ac2fc8a50f5d9a", 16347), None).is_none());
    }

    #[test]
    fn ignores_the_usage_of_a_task_without_a_child() {
        let mut tree = SubagentTree::default();
        assert!(tree.translate(SDK_MESSAGE_METHOD, &progress("bash-task", 10), None).is_none());
    }

    /// The handler chain of `connection::run_agent_task`: an untyped handler that takes what `translate` knows and a
    /// typed one after it, which must still get every other notification.
    #[tokio::test]
    async fn the_untyped_handler_leaves_every_other_notification_to_the_typed_one() {
        use agent_client_protocol::{on_receive_notification, Agent, Channel, Client, ConnectionTo, Handled, UntypedMessage};
        use std::sync::{Arc, Mutex};

        let received: Arc<Mutex<Vec<String>>> = Arc::default();
        let (untyped_received, typed_received) = (received.clone(), received.clone());
        let tree: Arc<Mutex<SubagentTree>> = Arc::default();
        let (client_side, agent_side) = Channel::duplex();
        let chunk = json!({ "sessionId": ROOT, "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } } });

        let agent = Agent.builder().connect_with(agent_side, async move |connection: ConnectionTo<Client>| {
            connection.send_notification(UntypedMessage::new(SESSION_UPDATE_METHOD, spawned(ROOT, "child", None))?)?;
            connection.send_notification(UntypedMessage::new(SESSION_UPDATE_METHOD, chunk)?)?;
            connection.incoming_closed().await;
            Ok(())
        });
        let client = Client
            .builder()
            .on_receive_notification(
                async move |message: UntypedMessage, connection: ConnectionTo<Agent>| match tree.lock().unwrap().translate(&message.method, &message.params, None) {
                    Some(notification) => {
                        untyped_received.lock().unwrap().push(format!("untyped {}", as_json(notification)["update"]["sessionUpdate"]));
                        Ok(Handled::Yes)
                    }
                    None => Ok(Handled::No { message: (message, connection), retry: false }),
                },
                on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: SessionNotification, _connection| {
                    typed_received.lock().unwrap().push(format!("typed {}", as_json(notification)["update"]["sessionUpdate"]));
                    Ok(())
                },
                on_receive_notification!(),
            )
            .connect_with(client_side, async |_connection: ConnectionTo<Agent>| {
                for _ in 0..100 {
                    if received.lock().unwrap().len() == 2 {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Ok(())
            });
        let (client, _) = tokio::time::timeout(std::time::Duration::from_secs(5), futures_util::future::join(client, agent)).await.unwrap();
        client.unwrap();
        assert_eq!(*received.lock().unwrap(), ["untyped \"subagent_update\"", "typed \"agent_message_chunk\""]);
    }

    #[test]
    fn reads_the_usage_of_a_replayed_child_from_its_transcript() {
        let claude_dir = tempfile::tempdir().unwrap();
        let subagents = claude_dir.path().join("projects/-probe").join(ROOT).join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        std::fs::write(subagents.join("agent-a84.meta.json"), r#"{"agentType":"general-purpose","toolUseId":"toolu_01Scc"}"#).unwrap();
        std::fs::write(
            subagents.join("agent-a84.jsonl"),
            [
                r#"{"type":"user","timestamp":"2026-11-04T12:00:00.000Z","message":{"role":"user","content":"Run it."}}"#,
                r#"{"type":"assistant","timestamp":"2026-11-04T12:00:01.000Z","message":{"content":[{"type":"tool_use","id":"toolu_a"}],"usage":{"input_tokens":2,"cache_read_input_tokens":16000,"output_tokens":5}}}"#,
                r#"{"type":"assistant","timestamp":"2026-11-04T12:00:04.500Z","message":{"content":[{"type":"tool_use","id":"toolu_b"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":2760,"cache_read_input_tokens":16320,"output_tokens":3}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let mut tree = SubagentTree::default();
        let child = format!("{ROOT}{REPLAY_SEPARATOR}toolu_01Scc");
        let notification = tree.translate(SESSION_UPDATE_METHOD, &spawned(ROOT, &child, None), Some(claude_dir.path())).unwrap();
        assert_eq!(
            as_json(notification)["update"]["_meta"]["hunt"]["subagent"]["usage"],
            json!({ "totalTokens": 19085, "toolUses": 2, "durationMs": 4500 })
        );
    }
}
