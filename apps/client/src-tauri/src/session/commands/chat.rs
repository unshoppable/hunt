//! The commands of a session's chat: sending a prompt with its images (and, in a sub chat about a file, the file's
//! current text), the conversation so far, cancelling a turn, the agent's permission mode and config options, the
//! answers to its permission requests, the screenshots and image files a prompt attaches, and declining a guardrail the
//! agent suggested.

use std::path::Path;

use agent_client_protocol::schema::v1::{
    CancelNotification, ConfigOptionUpdate, ContentBlock, ContentChunk, EmbeddedResource, EmbeddedResourceResource, ImageContent, Meta,
    MessageId, PromptRequest, SessionConfigId, SessionConfigOption, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent, TextResourceContents,
};
use agent_client_protocol::{Agent, ConnectionTo};
use base64::Engine;
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::{drop_pending_permissions, live_session, note_remote_activity, set_mode, worktree_file, worktree_session};
use crate::agent::acp::{message_time, publish_update, turn, LiveHandles, PermissionRegistry, SessionRegistry};
use crate::agent::declined_guardrails;
use crate::platform::screenshots::{self, Screenshot};
use crate::session::attribution;
use crate::session::link;
use crate::session::store;
use crate::session::summary;
use crate::session::sync;

/// Sends one user turn (the text plus the image files in `images`) and resolves with the stop reason once the
/// agent finished. A sub chat about writing a file (a selection with a task) gets the file's current content
/// ahead of the text, so the agent always sees the version on disk; a remote session's local edits reach its VM
/// first. The finished turn is handed to the background summarizer, which refreshes the session's summary and title.
/// `message_id` is the id the chat shows the prompt under (see `run_turn`).
#[tauri::command]
pub async fn send_prompt(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    text: String,
    images: Vec<String>,
    message_id: String,
) -> Result<String, String> {
    let mut blocks = prompt_blocks(&text, &images)?;
    if blocks.is_empty() {
        return Err("the prompt is empty".into());
    }
    let record = store::find_session(&app, id)?;
    if let Some(selection) = record.selection.as_ref().filter(|selection| selection.task.is_some() && !selection.is_folder) {
        if let Ok(target) = worktree_file(&record, &selection.path) {
            // The agent on a VM knows the file by its path there; the local copy holds the same content once synced.
            let shown_as = match &record.remote {
                Some(host) => host.worktree_path.join(&selection.path),
                None => target.clone(),
            };
            if let Some(block) = file_context_block(&target, &shown_as) {
                blocks.insert(0, block);
            }
        }
    }
    // The agent on a VM sees the files saved here before it reads the prompt.
    sync::flush(&app, id).await;
    run_turn(&app, &registry, id, blocks, None, Some(message_id)).await
}

/// The current text of the file at `target` as an embedded resource block, which the agent receives as a context
/// block tagged with the URI of `shown_as` (the path the agent knows the file by); none when there is no readable file
/// there (yet).
fn file_context_block(target: &Path, shown_as: &Path) -> Option<ContentBlock> {
    let text = std::fs::read_to_string(target).ok()?;
    let uri = format!("file://{}", shown_as.display());
    Some(ContentBlock::Resource(EmbeddedResource::new(EmbeddedResourceResource::TextResourceContents(TextResourceContents::new(text, uri)))))
}

/// Records `blocks` as a user turn, sends them and resolves with the stop reason once the agent finished.
/// `hidden_meta` marks the recorded chunks and the request as a hidden turn; a visible turn is summarized afterwards.
/// `message_id` is the id the UI shows the prompt under, which the time of the prompt is announced for once the turn
/// ended (`acp::message_time::resolve`).
async fn run_turn(
    app: &AppHandle,
    registry: &SessionRegistry,
    id: Uuid,
    blocks: Vec<ContentBlock>,
    hidden_meta: Option<Meta>,
    message_id: Option<String>,
) -> Result<String, String> {
    let LiveHandles { connection, acp_session_id, history, turns } = live_session(registry, id).await?;
    note_remote_activity(app, id, chrono::Utc::now());

    // The agent never echoes the prompt back, so the prompt and the turn's state go into the history and to every window
    // from here: a window that did not send the prompt shows it and the running turn as well.
    let turn_start = history.lock().unwrap().len();
    for block in &blocks {
        let mut chunk = ContentChunk::new(block.clone()).meta(hidden_meta.clone());
        chunk.message_id = message_id.clone().map(MessageId::new);
        publish_update(app, id, &history, SessionNotification::new(acp_session_id.clone(), SessionUpdate::UserMessageChunk(chunk)));
    }
    turns.lock().unwrap().prompt_started();
    turn::report_turn(app, id, &history, &acp_session_id, true);

    let request = PromptRequest::new(acp_session_id.clone(), blocks).meta(hidden_meta.clone());
    let response = connection.send_request(request).block_task().await;
    turns.lock().unwrap().prompt_ended();
    turn::report_turn(app, id, &history, &acp_session_id, false);
    message_time::resolve(app.clone(), id, acp_session_id.to_string(), history.clone(), turn_start);
    let response = response.map_err(|error| format!("failed to send the prompt: {error}"))?;

    note_remote_activity(app, id, chrono::Utc::now());
    if hidden_meta.is_none() {
        let turn = history.lock().unwrap()[turn_start..].to_vec();
        summary::schedule(app.clone(), id, turn);
    }

    Ok(format!("{:?}", response.stop_reason))
}

/// The content blocks of one prompt: the text (left out when blank) followed by one image block per file.
fn prompt_blocks(text: &str, images: &[String]) -> Result<Vec<ContentBlock>, String> {
    let mut blocks = Vec::with_capacity(images.len() + 1);
    if !text.trim().is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text.to_string())));
    }
    for path in images {
        let mime_type = screenshots::image_mime_type(path).ok_or_else(|| format!("{path} is not an image"))?;
        let bytes = std::fs::read(path).map_err(|error| format!("failed to read {path}: {error}"))?;
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        blocks.push(ContentBlock::Image(ImageContent::new(data, mime_type).uri(format!("file://{path}"))));
    }
    Ok(blocks)
}

/// Every image in the macOS screenshot folder, newest first, for the prompt's screenshot picker.
#[tauri::command]
pub async fn list_screenshots() -> Result<Vec<Screenshot>, String> {
    screenshots::list_screenshots().await
}

/// The image files among `paths`, e.g. files dropped into the chat, as attachments; other files are left out.
#[tauri::command]
pub fn image_files(paths: Vec<String>) -> Vec<Screenshot> {
    screenshots::image_files(&paths)
}

/// Every notification of a running session so far, for rebuilding its chat in the UI.
#[tauri::command]
pub async fn session_history(registry: State<'_, SessionRegistry>, id: Uuid) -> Result<Vec<SessionNotification>, String> {
    let history = live_session(&registry, id).await?.history;
    let history = history.lock().unwrap().clone();
    Ok(history)
}

/// Cancels the turn the agent runs. A turn Claude Code runs on its own ends in the chat at once, since its end is known
/// only from its result, which a cancel may cut off.
#[tauri::command]
pub async fn cancel_prompt(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<(), String> {
    drop_pending_permissions(&permissions, id);

    let LiveHandles { connection, acp_session_id, history, turns } = live_session(&registry, id).await?;
    connection
        .send_notification(CancelNotification::new(acp_session_id.clone()))
        .map_err(|error| format!("failed to cancel the prompt: {error}"))?;
    if turns.lock().unwrap().stop_own_turn() {
        turn::report_turn(&app, id, &history, &acp_session_id, false);
    }
    Ok(())
}

#[tauri::command]
pub async fn set_session_mode(registry: State<'_, SessionRegistry>, id: Uuid, mode_id: String) -> Result<(), String> {
    set_mode(&registry, id, mode_id).await
}

/// Changes one session config option (model, effort, …). The agent answers with the full option
/// list, which is published as a `config_option_update` so the UI has a single code path.
#[tauri::command]
pub async fn set_session_config_option(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    id: Uuid,
    config_id: String,
    value: String,
) -> Result<(), String> {
    let LiveHandles { connection, acp_session_id, history, .. } = live_session(&registry, id).await?;

    let options = set_config_option(&connection, &acp_session_id, &config_id, &value).await?;
    let update = SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(options));
    publish_update(&app, id, &history, SessionNotification::new(acp_session_id, update));
    Ok(())
}

/// Sets the session config option `config_id` to `value` and returns the agent's full option list.
async fn set_config_option(
    connection: &ConnectionTo<Agent>,
    acp_session_id: &SessionId,
    config_id: &str,
    value: &str,
) -> Result<Vec<SessionConfigOption>, String> {
    let request = SetSessionConfigOptionRequest::new(acp_session_id.clone(), SessionConfigId::new(config_id), value);
    let response = connection
        .send_request(request)
        .block_task()
        .await
        .map_err(|error| format!("failed to set the session config option {config_id}: {error}"))?;
    Ok(response.config_options)
}

#[tauri::command]
pub fn answer_permission(permissions: State<'_, PermissionRegistry>, request_id: Uuid, option_id: String) -> Result<(), String> {
    let pending = permissions.0.lock().unwrap().remove(&request_id).ok_or("permission request is no longer pending")?;
    pending.answer.send(option_id).map_err(|_| "agent stopped waiting for the permission answer".to_string())
}

/// Records in the session's worktree that the user declined the guardrail its agent suggested (`declined_guardrails`);
/// the change counts as the session's own.
#[tauri::command]
pub async fn decline_guardrail(app: AppHandle, id: Uuid, kind: String, summary: String, reason: declined_guardrails::DeclineReason) -> Result<(), String> {
    if !declined_guardrails::KINDS.contains(&kind.as_str()) {
        return Err(format!("failed to record the declined guardrail: unknown kind {kind}"));
    }
    link::ensure_writable(&app, id, "record the declined guardrail")?;
    let record = worktree_session(&app, id)?;
    let entry = declined_guardrails::DeclinedGuardrail { kind, reason, summary, declined_at: chrono::Local::now().date_naive() };
    let mut changed = Vec::new();
    attribution::record_write(&app, &record.worktree_path, id, || {
        changed = declined_guardrails::record(&record.worktree_path, &entry).map_err(|error| format!("failed to record the declined guardrail: {error}"))?;
        Ok(())
    })
    .await?;
    store::add_touched_files(&app, id, &changed)?;
    sync::note_local_change(&app, id);
    store::note_worktree_changed(&app, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_context_block_embeds_the_file_text_and_skips_missing_files() {
        let directory = std::env::temp_dir().join(format!("hunt-file-context-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("rule.md");
        std::fs::write(&file, "# Rule\n").unwrap();
        let on_vm = Path::new("/home/agent/app/rule.md");

        let block = file_context_block(&file, on_vm).unwrap();
        match block {
            ContentBlock::Resource(resource) => match resource.resource {
                EmbeddedResourceResource::TextResourceContents(contents) => {
                    assert_eq!(contents.text, "# Rule\n");
                    assert_eq!(contents.uri, "file:///home/agent/app/rule.md");
                }
                _ => panic!("expected text contents"),
            },
            _ => panic!("expected a resource block"),
        }
        assert!(file_context_block(&directory.join("missing.md"), on_vm).is_none());
        assert!(file_context_block(&directory, on_vm).is_none());
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn prompt_blocks_skips_blank_text_and_rejects_non_images() {
        let blocks = prompt_blocks("  hello  ", &[]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text(text) if text.text == "  hello  "));

        assert!(prompt_blocks("   \n", &[]).unwrap().is_empty());
        assert!(prompt_blocks("text", &["/tmp/notes.txt".to_string()]).is_err());
        assert!(prompt_blocks("text", &["/nowhere/missing.png".to_string()]).is_err());
    }

    #[test]
    fn prompt_blocks_attaches_images_after_the_text() {
        let directory = tempfile::tempdir().unwrap();
        let image = directory.path().join("shot.PNG");
        std::fs::write(&image, [1u8, 2, 3]).unwrap();
        let image = image.to_string_lossy().to_string();

        let blocks = prompt_blocks("look", &[image.clone()]).unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], ContentBlock::Text(_)));
        match &blocks[1] {
            ContentBlock::Image(content) => {
                assert_eq!(content.mime_type, "image/png");
                assert_eq!(content.data, "AQID");
                assert_eq!(content.uri.as_deref(), Some(format!("file://{image}").as_str()));
            }
            other => panic!("expected an image block, got {other:?}"),
        }
    }
}
