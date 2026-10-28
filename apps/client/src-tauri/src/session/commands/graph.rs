//! The commands of the Architecture tab: a session's diagrams, which the user may edit, their status, and generating one
//! in a background agent (`session::diagram_agent`).

use tauri::AppHandle;
use uuid::Uuid;

use super::worktree_session;
use crate::graph;
use crate::session::diagram_agent;
use crate::session::store;

/// Generates the diagram of `diagram_type` with its standard prompt, extended by the user's free-text `instructions`
/// for this one run, in a background agent on `model` with `effort` (see `diagram_agent`); the session's chat agent
/// takes no part.
#[tauri::command]
pub async fn refresh_graph(
    app: AppHandle,
    id: Uuid,
    diagram_type: graph::DiagramType,
    instructions: String,
    model: String,
    effort: String,
) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    diagram_agent::generate(&app, &record, diagram_type, &instructions, &model, &effort).await
}

/// The session's diagram file of `diagram_type`, or `None` while the agent has not written it.
#[tauri::command]
pub async fn read_graph(app: AppHandle, id: Uuid, diagram_type: graph::DiagramType) -> Result<Option<serde_json::Value>, String> {
    let record = worktree_session(&app, id)?;
    graph::read_graph(&record.worktree_path, diagram_type)
}

/// Writes the diagram of `diagram_type` the user edited in the Architecture tab; `content` is the whole file, which the
/// next diagram refresh starts from.
#[tauri::command]
pub async fn write_graph(app: AppHandle, id: Uuid, diagram_type: graph::DiagramType, content: String) -> Result<(), String> {
    let record = worktree_session(&app, id)?;
    graph::write_graph(&record.worktree_path, diagram_type, &content)
}

/// When the session's diagram of `diagram_type` was generated and whether files of its worktree changed since.
#[tauri::command]
pub async fn graph_status(app: AppHandle, id: Uuid, diagram_type: graph::DiagramType) -> Result<graph::GraphStatus, String> {
    let record = worktree_session(&app, id)?;
    let changed_at = store::worktree_changed_at(&app, &record.worktree_path)?;
    graph::status(&record.worktree_path, diagram_type, changed_at)
}
