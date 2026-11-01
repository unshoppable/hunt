//! The commands of the Factory tab: the pipeline record of a software-factory session and the results of its steps, read
//! from `.hunt/swf/` of its local worktree (`session::swf`), which the pulls of the session keep up to date.

use tauri::AppHandle;
use uuid::Uuid;

use crate::session::store;
use crate::session::swf::{self, SwfPipelineFiles};

/// The pipeline record of the session `session_id` as its local worktree holds it, with the list of its step result
/// files; `None` while the worktree has none, or the session has no local worktree yet. A `pipeline.json` that is not
/// JSON is an error.
#[tauri::command]
pub async fn read_swf_pipeline(app: AppHandle, session_id: Uuid) -> Result<Option<SwfPipelineFiles>, String> {
    let record = store::find_session(&app, session_id)?;
    if !record.worktree_path.is_dir() {
        return Ok(None);
    }
    swf::read_pipeline(&record.worktree_path)
}

/// The body of the step result the run `n` of the session `session_id` ended with (`steps/<nn>-<step>.md`); `None`
/// without one, or without a local worktree.
#[tauri::command]
pub async fn read_swf_step(app: AppHandle, session_id: Uuid, n: u32) -> Result<Option<String>, String> {
    let record = store::find_session(&app, session_id)?;
    if !record.worktree_path.is_dir() {
        return Ok(None);
    }
    swf::read_step(&record.worktree_path, n)
}
