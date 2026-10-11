//! The component diagram the agent writes to `<worktree>/.hunt/graph.json`: the prompts that
//! describe it, the schema file placed next to it, a watcher that tells the UI about rewrites, and
//! the reader.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::schema::v1::Meta;
use chrono::{DateTime, Utc};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const GRAPH_DIR: &str = ".hunt";
/// Name the diagram folder had before the application was called Hunt; still found in worktrees of older sessions.
const LEGACY_GRAPH_DIR: &str = ".harness";
const GRAPH_FILE: &str = "graph.json";
const SCHEMA_FILE: &str = "graph.schema.json";

/// JSON schema of the diagram file; written into `.hunt/` so the agent can read it, and the
/// frontend validates against the same shape.
pub const SCHEMA: &str = include_str!("graph.schema.json");

/// Appended to Claude Code's system prompt so the agent knows what the diagram is and how to write it;
/// `language` is the one every label and description is written in.
pub fn system_prompt(language: &str) -> String {
    format!("{SYSTEM_PROMPT}\nWrite every label and description in {language}, whatever language the code and its comments use.\n")
}

const SYSTEM_PROMPT: &str = r#"
## Hunt component diagram

The client application "Hunt" renders an interactive component diagram from `.hunt/graph.json` in the
working directory (git-ignored; its JSON schema is in `.hunt/graph.schema.json`). Every node is a file and
every edge a dependency between two files, scoped to the uncommitted changes of this session:

- Nodes: every file with uncommitted changes (`git diff --name-only HEAD` plus untracked files from
  `git ls-files --others --exclude-standard`) is a node, identified by its worktree-relative `path`. Add an
  unchanged file only when it helps to understand the change: a file a changed file imports, or one that imports
  a changed file, whose role matters (a shared store, a type definition, the component rendering a changed one).
  Skip generated files, lock files and third-party packages: never a path under `node_modules` (Hunt drops
  such nodes and edges). A dependency on a package is not an edge. Keep the diagram under ~60 nodes.
- Edges point from the dependent file (`source`) to the file it depends on (`target`), both given as the file's
  `path`: imports, references, IPC calls, file reads. Every edge carries a `label` of one to three words naming
  what the dependency is for, e.g. `business logic`, `shape response`, `types only`, `persistence`, `rendering`;
  never the name of the imported symbol or the file: Hunt rejects a label such as `PaginatedResult` or
  `user.service` and replaces it. Every edge also carries a `description` of two to four
  sentences: how the source uses the target (which functions, types or data it takes and where in the flow) and
  what that use achieves for the change (the goal, e.g. "so the list endpoint can page through users"). One edge
  per file pair; summarize several uses in one label and description.
- Optional `description` per node: one sentence on the file's role in the change.
- Every node carries a `review` rating, an integer from 1 to 4, saying how much a human should review that file.
  Judge the file's weight in the system, not the size of its change: 4 for interfaces and contracts (API endpoints,
  IPC, public types), data models and schemas, migrations, authentication, authorization, payments, security,
  architecture decisions and central abstractions many files depend on; 3 for files with many dependents or helpers
  used across the code base; 2 for ordinary feature code with few dependents; 1 for leaf files, tests, styling and
  boilerplate. Add a `reviewReason` of one sentence naming the criterion, e.g. "Defines the response types every
  client parses." Hunt shows the rating as a signal-strength icon on the node and the reason when it is hovered.
- Shape, exactly: {"nodes":[{"path","description"?,"review","reviewReason"}],"edges":[{"source","target","label","description"}]}.
  There are no other fields: no `id`, `kind`, `group`, `level` or `isChanged`, and no hierarchy. A previous
  graph.json with another shape is obsolete; never copy its shape.

Hunt itself knows which files changed and how much and dims the unchanged files you add.

Write the whole file whenever you are asked to update the diagram, replacing the previous content. Reply with one
sentence that the diagram was updated and nothing else.
"#;

/// The user turn that asks the agent for a fresh diagram of the session's uncommitted changes, labeled in `language`.
pub fn refresh_prompt(language: &str) -> String {
    format!(
        "Update the Hunt component diagram for this session. The session's changes are `git diff HEAD` plus untracked \
         files (`git ls-files --others --exclude-standard`). Rebuild `.hunt/graph.json` as described in your \
         instructions: one node per changed file, the unchanged files they depend on where helpful, every edge with a \
         label of one to three words naming what the dependency is for (never a symbol or file name) and a description \
         of two to four sentences on how the dependency is used and what that achieves. Give every node a `review` \
         rating from 1 to 4 for how much a human should review the file (4: interfaces, data models, auth, payments, \
         architecture decisions, central abstractions with many dependents; 1: leaf files, tests, styling) and a \
         one-sentence `reviewReason`. Never add a path under \
         `node_modules`; package imports are not edges. Write every label, description and reason \
         in {language}. Write exactly the shape \
         {{\"nodes\":[{{\"path\",\"description\"?,\"review\",\"reviewReason\"}}],\"edges\":[{{\"source\",\"target\",\"label\",\"description\"}}]}} \
         with `source` and `target` being node paths; ignore the shape of any previous graph.json."
    )
}

/// `_meta` of a user message chunk the chat shows as a status line instead of a bubble.
pub fn hidden_turn_meta(label: &str) -> Meta {
    let mut meta = Meta::new();
    meta.insert("hunt".into(), serde_json::json!({ "hidden": true, "label": label }));
    meta
}

/// Active watchers keyed by Hunt session ID; dropping a debouncer stops watching.
#[derive(Default)]
pub struct WatcherRegistry(pub Mutex<HashMap<Uuid, Debouncer<RecommendedWatcher, RecommendedCache>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphChangedEvent {
    hunt_session_id: Uuid,
}

pub fn graph_path(worktree: &Path) -> PathBuf {
    worktree.join(GRAPH_DIR).join(GRAPH_FILE)
}

/// Creates `.hunt/` with the current schema file (taking over a `.hunt/` folder of an older session) and starts
/// watching it for diagram rewrites.
pub fn watch(app: &AppHandle, registry: &WatcherRegistry, hunt_session_id: Uuid, worktree: &Path) -> Result<(), String> {
    let directory = worktree.join(GRAPH_DIR);
    let legacy = worktree.join(LEGACY_GRAPH_DIR);
    if legacy.is_dir() && !directory.exists() {
        std::fs::rename(&legacy, &directory).map_err(|error| format!("failed to rename {} to {}: {error}", legacy.display(), directory.display()))?;
    }
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(directory.join(SCHEMA_FILE), SCHEMA).map_err(|error| error.to_string())?;

    let handle = app.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(400), None, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let touches_graph = events.iter().any(|event| event.paths.iter().any(|path| path.ends_with(GRAPH_FILE)));
        if !touches_graph {
            return;
        }
        let _ = handle.emit("graph:changed", GraphChangedEvent { hunt_session_id });
    })
    .map_err(|error| error.to_string())?;
    debouncer.watch(&directory, RecursiveMode::NonRecursive).map_err(|error| error.to_string())?;

    registry.0.lock().unwrap().insert(hunt_session_id, debouncer);
    Ok(())
}

pub fn unwatch(registry: &WatcherRegistry, hunt_session_id: Uuid) {
    registry.0.lock().unwrap().remove(&hunt_session_id);
}

/// Age of the diagram relative to the worktree it describes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatus {
    /// When the agent last wrote the diagram file; `None` while there is none.
    pub generated_at: Option<DateTime<Utc>>,
    /// True once a session changed files in the worktree after the diagram was generated.
    pub is_outdated: bool,
}

/// Compares the modification time of the diagram file with `changed_at`, the latest file change of the worktree's sessions.
pub fn status(worktree: &Path, changed_at: Option<DateTime<Utc>>) -> Result<GraphStatus, String> {
    let path = graph_path(worktree);
    if !path.exists() {
        return Ok(GraphStatus { generated_at: None, is_outdated: false });
    }

    let modified = std::fs::metadata(&path).and_then(|metadata| metadata.modified()).map_err(|error| error.to_string())?;
    let generated_at = DateTime::<Utc>::from(modified);
    let is_outdated = changed_at.is_some_and(|changed| changed > generated_at);
    Ok(GraphStatus { generated_at: Some(generated_at), is_outdated })
}

/// Parsed diagram file, or `None` while the agent has not written one yet. The frontend validates the shape.
pub fn read_graph(worktree: &Path) -> Result<Option<serde_json::Value>, String> {
    let path = graph_path(worktree);
    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let graph = serde_json::from_str(&content).map_err(|error| format!("graph.json is not valid JSON: {error}"))?;
    Ok(Some(graph))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_without_diagram_is_not_outdated() {
        let worktree = tempfile::tempdir().unwrap();
        let status = status(worktree.path(), Some(Utc::now())).unwrap();
        assert!(status.generated_at.is_none());
        assert!(!status.is_outdated);
    }

    #[test]
    fn status_compares_diagram_mtime_with_latest_change() {
        let worktree = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(worktree.path().join(GRAPH_DIR)).unwrap();
        std::fs::write(graph_path(worktree.path()), "{}").unwrap();

        let fresh = status(worktree.path(), None).unwrap();
        let generated_at = fresh.generated_at.expect("diagram file has a modification time");
        assert!(!fresh.is_outdated);
        assert!(!status(worktree.path(), Some(generated_at - chrono::Duration::seconds(1))).unwrap().is_outdated);
        assert!(status(worktree.path(), Some(generated_at + chrono::Duration::seconds(1))).unwrap().is_outdated);
    }
}
