//! The diagrams the agent writes to `<worktree>/.hunt/`: the file-level dependency graph in `graph.json` and the
//! shape diagrams (C4 context and container, states, ERD, process) in `diagram.<type>.json`, each described by a
//! prompt and validated against a schema file placed next to it, plus a watcher that tells the UI about rewrites
//! and the reader.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, Meta, SessionNotification, SessionUpdate};
use chrono::{DateTime, Utc};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::preferences::ENGLISH_TERMS;

const GRAPH_DIR: &str = ".hunt";
/// Name the diagram folder had before the application was called Hunt; still found in worktrees of older sessions.
const LEGACY_GRAPH_DIR: &str = ".harness";
const GRAPH_FILE: &str = "graph.json";
const GRAPH_SCHEMA_FILE: &str = "graph.schema.json";
const DIAGRAM_SCHEMA_FILE: &str = "diagram.schema.json";
/// The schema files relative to the worktree, which the sync of a remote session copies explicitly.
const GRAPH_SCHEMA_PATH: &str = ".hunt/graph.schema.json";
const DIAGRAM_SCHEMA_PATH: &str = ".hunt/diagram.schema.json";

/// JSON schema of the dependency graph file; written into `.hunt/` so the agent can read it, and the frontend
/// validates against the same shape.
pub const SCHEMA: &str = include_str!("graph.schema.json");
/// JSON schema shared by the shape diagrams, written into `.hunt/` next to the graph schema.
pub const DIAGRAM_SCHEMA: &str = include_str!("diagram.schema.json");

/// Which diagram a request is about: the file-level dependency graph or one of the shape diagrams. The frontend
/// sends the kebab-case id, which is also the `<type>` in `diagram.<type>.json`.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagramType {
    Dependencies,
    C4Context,
    C4Container,
    States,
    Erd,
    Process,
}

/// The diagram types that share `diagram.schema.json` and a user prompt file each.
pub const SHAPE_TYPES: [DiagramType; 5] =
    [DiagramType::C4Context, DiagramType::C4Container, DiagramType::States, DiagramType::Erd, DiagramType::Process];

impl DiagramType {
    /// Name of the file the agent writes into `.hunt/`.
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Dependencies => GRAPH_FILE,
            Self::C4Context => "diagram.c4-context.json",
            Self::C4Container => "diagram.c4-container.json",
            Self::States => "diagram.states.json",
            Self::Erd => "diagram.erd.json",
            Self::Process => "diagram.process.json",
        }
    }

    /// The diagram file relative to the worktree, which the sync of a remote session copies explicitly.
    pub fn path(self) -> String {
        format!("{GRAPH_DIR}/{}", self.file_name())
    }

    /// The schema file the diagram is validated against, relative to the worktree.
    pub fn schema_path(self) -> &'static str {
        match self {
            Self::Dependencies => GRAPH_SCHEMA_PATH,
            _ => DIAGRAM_SCHEMA_PATH,
        }
    }

    /// Template of the user turn that asks for the diagram; `None` for the dependency graph, whose prompt
    /// `refresh_prompt` builds itself.
    fn user_prompt_template(self) -> Option<&'static str> {
        match self {
            Self::Dependencies => None,
            Self::C4Context => Some(C4_CONTEXT_PROMPT),
            Self::C4Container => Some(C4_CONTAINER_PROMPT),
            Self::States => Some(STATES_PROMPT),
            Self::Erd => Some(ERD_PROMPT),
            Self::Process => Some(PROCESS_PROMPT),
        }
    }
}

/// Section of the system prompt describing the shape diagrams, with `{{language}}` and `{{englishTerms}}` placeholders.
const SHAPE_SYSTEM_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/diagram/diagram.system-prompt.md"));
const C4_CONTEXT_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/diagram/diagram-c4-context.user-prompt.md"));
const C4_CONTAINER_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/diagram/diagram-c4-container.user-prompt.md"));
const STATES_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/diagram/diagram-states.user-prompt.md"));
const ERD_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/diagram/diagram-erd.user-prompt.md"));
const PROCESS_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/diagram/diagram-process.user-prompt.md"));

/// Replaces every `{{name}}` placeholder of `template` with its value.
fn fill_prompt(template: &str, values: &[(&str, &str)]) -> String {
    values.iter().fold(template.to_string(), |text, (name, value)| text.replace(&format!("{{{{{name}}}}}"), value))
}

/// The text of a prompt template before its first placeholder, which every prompt filled from it starts with.
fn prompt_start(template: &str) -> &str {
    template.split("{{").next().unwrap_or(template).trim()
}

/// Appended to Claude Code's system prompt so the agent knows what the diagrams are and how to write them;
/// `language` is the one every label and description is written in.
pub fn system_prompt(language: &str) -> String {
    let shapes = fill_prompt(SHAPE_SYSTEM_PROMPT, &[("language", language), ("englishTerms", ENGLISH_TERMS)]);
    format!(
        "{SYSTEM_PROMPT}\nWrite every label and description in {language}, whatever language the code and its comments use. \
         {ENGLISH_TERMS}\n\n{shapes}"
    )
}

const SYSTEM_PROMPT: &str = r#"
## Hunt component diagram

The client application "Hunt" renders an interactive component diagram from `.hunt/graph.json` in the
working directory (git-ignored; its JSON schema is in `.hunt/graph.schema.json`). Every node is a file and
every edge a dependency between two files, scoped to the changes of this session:

- Nodes: every file the session changed is a node, identified by its worktree-relative `path`: the files
  `git diff --name-only <base>` lists for the base the update request names, plus untracked files from
  `git ls-files --others --exclude-standard`. Add an unchanged file only when it helps to understand the change: a
  file a changed file imports, or one that imports a changed file, whose role matters (a shared store, a type
  definition, the component rendering a changed one). Skip generated files, lock files and third-party packages:
  never a path under `node_modules` (Hunt drops such nodes and edges). A dependency on a package is not an edge.
  Keep the diagram under ~60 nodes.
- Edges point from the dependent file (`source`) to the file it depends on (`target`), both given as the file's
  `path`: imports, references, IPC calls, file reads. Give every import between two nodes an edge; Hunt draws the
  imports you leave out without a label. Every edge carries a `label` of one to three words that tells a reviewer
  how the source uses the target without opening either file: a verb, a noun or both, e.g. `calls`, `validates input`,
  `maps rows`, `uses types`, `stores orders`, `test data`; never the name of the imported symbol or the file: Hunt
  drops a label such as `PaginatedResult` or `user.service`. Every edge also carries a `description` of two to four
  sentences: how the source uses the target (which functions, types or data it takes and where in the flow) and
  what that use achieves for the change (the goal, e.g. "so the list endpoint can page through users"). One edge
  per file pair; summarize several uses in one label and description.
- Every node carries a `review` rating, an integer from 1 to 4, saying how much a human should review that file.
  Weigh two things together. First, how relevant the file is: how often its functionality is reused (count its
  dependents), its architectural significance (interfaces and contracts such as API endpoints, IPC and public types,
  data models and schemas, migrations, central abstractions), its weight for the business logic (calculations,
  rules, imports and exports of domain data, authentication, authorization, payments, security). Second, how drastic
  its change is: a changed contract, behavior or data flow weighs more than a rename, a new case following an
  existing pattern, comments or formatting, and many changed lines weigh more than few. 4 when a relevant file changes
  substantially; 3 for a relevant file with a small change or an ordinary file with a substantial one; 2 for ordinary
  feature code with a contained change; 1 for leaf files, tests, styling, translations, generated and boilerplate
  code, and mechanical edits. An unchanged context file is rated by its relevance alone. Add a `reviewReason` of one
  sentence naming the deciding criteria, e.g. "Changes the response type every client parses." Hunt shows the
  rating as a signal-strength icon on the node and the reason when it is hovered.
- Shape, exactly: {"nodes":[{"path","review","reviewReason"}],"edges":[{"source","target","label","description"}]}.
  There are no other fields: no `id`, `kind`, `group`, `level` or `isChanged`, and no hierarchy. A previous
  graph.json with another shape is obsolete; never copy its shape.

Hunt itself knows which files changed and how much and dims the unchanged files you add.

Write the whole file whenever you are asked to update the diagram, replacing the previous content. Reply with one
sentence that the diagram was updated and nothing else.
"#;

/// Opening sentence of every dependency-graph refresh prompt; a replayed user turn that starts with it was a refresh.
const REFRESH_PROMPT_START: &str = "Update the Hunt component diagram for this session.";

/// The user turn that asks the agent for a fresh diagram of `diagram_type` covering the session's changes against
/// `diff_base` (the commit or ref the changelist compares the worktree with), labeled in `language`; `instructions`
/// is the user's free text for this one run, empty when there is none.
pub fn refresh_prompt(diagram_type: DiagramType, language: &str, diff_base: &str, instructions: &str) -> String {
    if let Some(template) = diagram_type.user_prompt_template() {
        let instructions = if instructions.is_empty() { "(none)" } else { instructions };
        return fill_prompt(
            template,
            &[("language", language), ("diffBase", diff_base), ("englishTerms", ENGLISH_TERMS), ("instructions", instructions)],
        );
    }

    let mut prompt = format!(
        "{REFRESH_PROMPT_START} The session's changes are the files `git diff --name-only {diff_base}` lists plus \
         untracked files (`git ls-files --others --exclude-standard`); use exactly this base, whatever earlier \
         diagrams covered. Rebuild `.hunt/graph.json` as described in your instructions: one node per changed file, \
         the unchanged files they depend on where helpful, an edge for every import or other dependency between two \
         nodes, each with a label of one to three words (a verb, a noun or both, never a symbol or file name) stating \
         how the source uses the target and a description of two to four sentences on how the dependency is used and \
         what that achieves. Give every node a `review` \
         rating from 1 to 4 for how much a human should review the file, weighing its relevance (how often it is \
         reused, architectural significance, weight for the business logic) together with how drastic its change \
         is (4: a substantial change to an interface, data model, business rule or central abstraction; 1: leaf \
         files, tests, styling, mechanical edits) and a one-sentence `reviewReason` naming the deciding criteria. Never add a path under \
         `node_modules`; package imports are not edges. Write every label, description and reason \
         in {language}. {ENGLISH_TERMS} Write exactly the shape \
         {{\"nodes\":[{{\"path\",\"review\",\"reviewReason\"}}],\"edges\":[{{\"source\",\"target\",\"label\",\"description\"}}]}} \
         with `source` and `target` being node paths; ignore the shape of any previous graph.json."
    );
    if !instructions.is_empty() {
        prompt.push_str(&format!(" Additional instructions for this run: {instructions}"));
    }
    prompt
}

/// `_meta` of the user message chunk of a refresh turn, which the chat shows neither as a bubble nor with the
/// agent's output.
pub fn hidden_turn_meta() -> Meta {
    let mut meta = Meta::new();
    meta.insert("hunt".into(), serde_json::json!({ "hidden": true }));
    meta
}

/// True for the text of a user turn that `refresh_prompt` built for any diagram type.
fn is_refresh_prompt(text: &str) -> bool {
    text.starts_with(REFRESH_PROMPT_START)
        || SHAPE_TYPES
            .iter()
            .filter_map(|diagram_type| diagram_type.user_prompt_template())
            .any(|template| text.starts_with(prompt_start(template)))
}

/// Adds the hidden-turn meta to the user chunk of a refresh prompt that a loaded session replays from its
/// transcript, which keeps the prompt text but not the meta Hunt recorded for the turn.
pub fn hide_replayed_refresh(notification: &mut SessionNotification) {
    let SessionUpdate::UserMessageChunk(chunk) = &mut notification.update else { return };
    if chunk.meta.is_none() && matches!(&chunk.content, ContentBlock::Text(text) if is_refresh_prompt(&text.text)) {
        chunk.meta = Some(hidden_turn_meta());
    }
}

/// Active watchers keyed by Hunt session ID; dropping a debouncer stops watching.
#[derive(Default)]
pub struct WatcherRegistry(pub Mutex<HashMap<Uuid, Debouncer<RecommendedWatcher, RecommendedCache>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphChangedEvent {
    hunt_session_id: Uuid,
}

/// Absolute path of the file `diagram_type` is written to in `worktree`.
pub fn diagram_path(worktree: &Path, diagram_type: DiagramType) -> PathBuf {
    worktree.join(GRAPH_DIR).join(diagram_type.file_name())
}

/// True for `graph.json` and every `diagram.<type>.json`, the files whose rewrite the UI is told about; the schema
/// files Hunt writes itself are not diagrams.
fn is_diagram_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return false };
    name == GRAPH_FILE || (name.starts_with("diagram.") && name.ends_with(".json") && name != DIAGRAM_SCHEMA_FILE)
}

/// Creates `.hunt/` with the current schema files (taking over a `.hunt/` folder of an older session) and starts
/// watching it for diagram rewrites.
pub fn watch(app: &AppHandle, registry: &WatcherRegistry, hunt_session_id: Uuid, worktree: &Path) -> Result<(), String> {
    let directory = worktree.join(GRAPH_DIR);
    let legacy = worktree.join(LEGACY_GRAPH_DIR);
    if legacy.is_dir() && !directory.exists() {
        std::fs::rename(&legacy, &directory)
            .map_err(|error| format!("failed to rename {} to {}: {error}", legacy.display(), directory.display()))?;
    }
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(directory.join(GRAPH_SCHEMA_FILE), SCHEMA).map_err(|error| error.to_string())?;
    std::fs::write(directory.join(DIAGRAM_SCHEMA_FILE), DIAGRAM_SCHEMA).map_err(|error| error.to_string())?;

    let handle = app.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(400), None, move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let touches_diagram = events.iter().any(|event| event.paths.iter().any(|path| is_diagram_file(path)));
        if !touches_diagram {
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

/// Age of a diagram relative to the worktree it describes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatus {
    /// When the agent last wrote the diagram file; `None` while there is none.
    pub generated_at: Option<DateTime<Utc>>,
    /// True once a session changed files in the worktree after the diagram was generated.
    pub is_outdated: bool,
}

/// Compares the modification time of the file of `diagram_type` with `changed_at`, the latest file change of the
/// worktree's sessions.
pub fn status(worktree: &Path, diagram_type: DiagramType, changed_at: Option<DateTime<Utc>>) -> Result<GraphStatus, String> {
    let path = diagram_path(worktree, diagram_type);
    if !path.exists() {
        return Ok(GraphStatus { generated_at: None, is_outdated: false });
    }

    let modified = std::fs::metadata(&path).and_then(|metadata| metadata.modified()).map_err(|error| error.to_string())?;
    let generated_at = DateTime::<Utc>::from(modified);
    let is_outdated = changed_at.is_some_and(|changed| changed > generated_at);
    Ok(GraphStatus { generated_at: Some(generated_at), is_outdated })
}

/// Writes `content`, the serialized diagram the frontend edited, as the file of `diagram_type` in `worktree`; the
/// content must be a JSON object whose `type` is the diagram's id, so a stray write can never put another diagram
/// into the file. The watcher of `.hunt/` reports the rewrite like the agent's.
pub fn write_graph(worktree: &Path, diagram_type: DiagramType, content: &str) -> Result<(), String> {
    let file_name = diagram_type.file_name();
    let value: serde_json::Value = serde_json::from_str(content).map_err(|error| format!("failed to write {file_name}: the content is not valid JSON: {error}"))?;
    let expected = file_name.trim_start_matches("diagram.").trim_end_matches(".json");
    if value.get("type").and_then(|kind| kind.as_str()) != Some(expected) {
        return Err(format!("failed to write {file_name}: the content is not a {expected} diagram"));
    }
    let path = diagram_path(worktree, diagram_type);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    std::fs::write(&path, content).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

/// Parsed file of `diagram_type`, or `None` while the agent has not written one yet. The frontend validates the shape.
pub fn read_graph(worktree: &Path, diagram_type: DiagramType) -> Result<Option<serde_json::Value>, String> {
    let path = diagram_path(worktree, diagram_type);
    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let graph = serde_json::from_str(&content).map_err(|error| format!("{} is not valid JSON: {error}", diagram_type.file_name()))?;
    Ok(Some(graph))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagram_type_deserializes_from_its_id() {
        let ids = [
            ("dependencies", DiagramType::Dependencies),
            ("c4-context", DiagramType::C4Context),
            ("c4-container", DiagramType::C4Container),
            ("states", DiagramType::States),
            ("erd", DiagramType::Erd),
            ("process", DiagramType::Process),
        ];
        for (id, expected) in ids {
            let parsed: DiagramType = serde_json::from_value(serde_json::json!(id)).unwrap_or_else(|error| panic!("{id}: {error}"));
            assert_eq!(parsed, expected);
            assert_eq!(parsed.path(), format!(".hunt/{}", parsed.file_name()));
        }
        assert_eq!(DiagramType::Erd.file_name(), "diagram.erd.json");
        assert_eq!(DiagramType::Dependencies.schema_path(), ".hunt/graph.schema.json");
        assert_eq!(DiagramType::States.schema_path(), ".hunt/diagram.schema.json");
    }

    #[test]
    fn fill_prompt_replaces_every_placeholder() {
        let filled = fill_prompt("a {{x}} b {{y}} c {{x}}", &[("x", "1"), ("y", "2")]);
        assert_eq!(filled, "a 1 b 2 c 1");
        assert_eq!(prompt_start("Update it. The base is {{diffBase}}."), "Update it. The base is");
        assert!(!system_prompt("German").contains("{{"));
        assert!(system_prompt("German").contains("in German"));
    }

    #[test]
    fn refresh_prompt_names_the_diff_base() {
        let prompt = refresh_prompt(DiagramType::Dependencies, "German", "d9f3dfc", "");
        assert!(prompt.starts_with(REFRESH_PROMPT_START));
        assert!(prompt.contains("`git diff --name-only d9f3dfc`"));
        assert!(prompt.contains("in German"));
        assert!(!prompt.contains("Additional instructions"));

        let with_instructions = refresh_prompt(DiagramType::Dependencies, "German", "d9f3dfc", "only the backend");
        assert!(with_instructions.ends_with(" Additional instructions for this run: only the backend"));
    }

    #[test]
    fn shape_refresh_prompts_fill_their_template() {
        for diagram_type in SHAPE_TYPES {
            let template = diagram_type.user_prompt_template().expect("shape types have a template");
            let prompt = refresh_prompt(diagram_type, "German", "d9f3dfc", "");
            assert!(prompt.starts_with(prompt_start(template)), "{diagram_type:?}");
            assert!(prompt.contains("`git diff --name-only d9f3dfc`"), "{diagram_type:?}");
            assert!(prompt.contains("in German"), "{diagram_type:?}");
            assert!(prompt.contains(&format!("`{}`", diagram_type.path())), "{diagram_type:?}");
            assert!(prompt.ends_with("Additional instructions for this run: (none)\n"), "{diagram_type:?}");
            assert!(!prompt.contains("{{"), "{diagram_type:?}");

            let with_instructions = refresh_prompt(diagram_type, "German", "d9f3dfc", "only the backend");
            assert!(with_instructions.ends_with("Additional instructions for this run: only the backend\n"), "{diagram_type:?}");
            assert!(!with_instructions.contains("(none)"), "{diagram_type:?}");
        }
    }

    #[test]
    fn diagram_files_are_told_apart_from_schemas() {
        assert!(is_diagram_file(Path::new("/w/.hunt/graph.json")));
        assert!(is_diagram_file(Path::new("/w/.hunt/diagram.erd.json")));
        assert!(!is_diagram_file(Path::new("/w/.hunt/diagram.schema.json")));
        assert!(!is_diagram_file(Path::new("/w/.hunt/graph.schema.json")));
        assert!(!is_diagram_file(Path::new("/w/.hunt/other.json")));
    }

    #[test]
    fn status_without_diagram_is_not_outdated() {
        let worktree = tempfile::tempdir().unwrap();
        let status = status(worktree.path(), DiagramType::Dependencies, Some(Utc::now())).unwrap();
        assert!(status.generated_at.is_none());
        assert!(!status.is_outdated);
    }

    #[test]
    fn status_compares_diagram_mtime_with_latest_change() {
        let worktree = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(worktree.path().join(GRAPH_DIR)).unwrap();
        std::fs::write(diagram_path(worktree.path(), DiagramType::Dependencies), "{}").unwrap();

        let fresh = status(worktree.path(), DiagramType::Dependencies, None).unwrap();
        let generated_at = fresh.generated_at.expect("diagram file has a modification time");
        assert!(!fresh.is_outdated);
        let before = Some(generated_at - chrono::Duration::seconds(1));
        let after = Some(generated_at + chrono::Duration::seconds(1));
        assert!(!status(worktree.path(), DiagramType::Dependencies, before).unwrap().is_outdated);
        assert!(status(worktree.path(), DiagramType::Dependencies, after).unwrap().is_outdated);
    }

    #[test]
    fn status_and_read_graph_use_the_file_of_the_type() {
        let worktree = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(worktree.path().join(GRAPH_DIR)).unwrap();
        std::fs::write(worktree.path().join(GRAPH_DIR).join("diagram.erd.json"), r#"{"type":"erd"}"#).unwrap();

        assert!(status(worktree.path(), DiagramType::Erd, None).unwrap().generated_at.is_some());
        assert!(status(worktree.path(), DiagramType::Dependencies, None).unwrap().generated_at.is_none());
        assert_eq!(read_graph(worktree.path(), DiagramType::Erd).unwrap(), Some(serde_json::json!({ "type": "erd" })));
        assert_eq!(read_graph(worktree.path(), DiagramType::Dependencies).unwrap(), None);

        std::fs::write(worktree.path().join(GRAPH_DIR).join("diagram.states.json"), "{").unwrap();
        let error = read_graph(worktree.path(), DiagramType::States).unwrap_err();
        assert!(error.starts_with("diagram.states.json is not valid JSON"), "{error}");
    }

    #[test]
    fn replayed_refresh_prompt_becomes_hidden() {
        let chunk = |text: String| {
            let block = ContentBlock::Text(agent_client_protocol::schema::v1::TextContent::new(text));
            let update = SessionUpdate::UserMessageChunk(agent_client_protocol::schema::v1::ContentChunk::new(block));
            SessionNotification::new("acp-session", update)
        };
        let meta_of = |notification: &SessionNotification| match &notification.update {
            SessionUpdate::UserMessageChunk(chunk) => chunk.meta.clone(),
            _ => None,
        };

        let mut refresh = chunk(refresh_prompt(DiagramType::Dependencies, "German", "HEAD", ""));
        hide_replayed_refresh(&mut refresh);
        assert_eq!(meta_of(&refresh), Some(hidden_turn_meta()));

        let mut shape_refresh = chunk(refresh_prompt(DiagramType::Process, "German", "HEAD", "only the checkout"));
        hide_replayed_refresh(&mut shape_refresh);
        assert_eq!(meta_of(&shape_refresh), Some(hidden_turn_meta()));

        let mut question = chunk("Why does the diagram miss a file?".into());
        hide_replayed_refresh(&mut question);
        assert_eq!(meta_of(&question), None);
    }
}
