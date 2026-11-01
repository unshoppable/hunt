//! One shared text per loaded worktree file, like an IDE's document: the Monaco model of every window that loaded the
//! file is a replica of it. A window sends its edits as LSP content changes against the version it last saw; they are
//! applied here, forwarded to the worktree's language server in order and broadcast to the other windows
//! (`document:changed`). An edit against a stale version is refused and the window reads the document again
//! (`document_open`). Reloads from disk, reverts and saves go through here too, so every window and the server hold the
//! same text and the same saved state. A document with unsaved edits outlives the windows that held it, so closing a
//! tab or a window never loses edits; it closes once it is saved or reverted and no window holds it.
//!
//! Each document remembers the content and the stamp (`DiskStamp`) its file had when it was last read or written. A
//! reload skips files whose stamp did not change; one that changed under unsaved edits keeps them and is noted. A save
//! of unsaved edits whose file changed on disk since writes nothing and reports a conflict, unless it is forced.
//!
//! `WorktreeDocuments` is the Tauri-free core: every operation returns the server notifications and window events it
//! causes. `DocumentRegistry`, `update` and the commands add the per-worktree lock, the server lookup and the emission.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Window};
use uuid::Uuid;

use crate::ide::disk_file::DiskStamp;
use crate::ide::lsp::{self, LspServer, ServerKind};
use crate::ide::workspace;
use crate::session::commands::changes::write_worktree_file;
use crate::session::commands::{session_file, worktree_session};

/// Monaco language ids whose documents the language servers receive; `ServerKind::receives` picks the server.
const SERVED_LANGUAGES: [&str; 3] = ["typescript", "javascript", "html"];
/// Documents longer than this many UTF-16 code units (Monaco's length; `MAX_SERVED_LENGTH` in
/// src/ide/lsp/lsp-client.service.ts likewise) open without language servers: a bundle or a dump would cost them
/// seconds and memory for nothing.
const MAX_SERVED_LENGTH: usize = 5 * 1024 * 1024;

/// Whether a document holding `text` when it opens reaches the language servers; checked in bytes first, which are at
/// least as many as UTF-16 code units.
fn is_servable(text: &str) -> bool {
    text.len() <= MAX_SERVED_LENGTH || text.encode_utf16().count() <= MAX_SERVED_LENGTH
}

/// A position as LSP counts it: zero-based line, column in UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// An LSP content change with a range: `text` replaces `range`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct ContentChange {
    pub range: Range,
    pub text: String,
}

/// What a window needs to show a document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentState {
    pub text: String,
    pub version: i32,
    pub is_dirty: bool,
}

/// The answer to an accepted edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditAck {
    pub version: i32,
    pub is_dirty: bool,
}

/// `document:changed`: the text of `path` reached `version`, through `changes` against `version - 1` or as a whole `text`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedEvent {
    pub worktree_path: String,
    pub path: String,
    pub version: i32,
    pub changes: Option<Vec<ContentChange>>,
    pub text: Option<String>,
    pub is_dirty: bool,
}

/// `document:dirty`: whether `path` has unsaved edits changed without a text change, e.g. through a save.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyEvent {
    pub worktree_path: String,
    pub path: String,
    pub is_dirty: bool,
}

/// The answer to `document_save`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SaveOutcome {
    /// The text is on disk; `is_dirty` when edits made meanwhile keep the document dirty.
    Saved { is_dirty: bool },
    /// The file changed on disk since the unsaved edits were based on it; nothing was written.
    Conflict,
}

/// What saving a document writes.
#[derive(Debug, PartialEq, Eq)]
pub enum SavePlan {
    Write(String),
    /// Nothing: without unsaved edits the file holds the text already, or a newer one that a reload takes over.
    Unchanged,
    /// Nothing: the file changed on disk since the unsaved edits were based on it.
    Conflict,
}

/// The file of a document on disk; the commands use the worktree file, tests a fake.
pub trait DiskFile {
    /// The file's current stamp; None when it is missing or unknown.
    fn stamp(&self) -> Option<DiskStamp>;
    fn read(&self) -> Result<String, String>;
}

/// The content of a file as read or written at a time, with the stamp it had then.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskSnapshot {
    pub text: String,
    pub stamp: Option<DiskStamp>,
}

impl DiskSnapshot {
    /// Reads `disk`; the stamp is taken first, so a change during the read shows as a newer stamp later.
    fn read(disk: &impl DiskFile) -> Result<DiskSnapshot, String> {
        let stamp = disk.stamp();
        Ok(DiskSnapshot { text: disk.read()?, stamp })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DocumentEvent {
    Changed(ChangedEvent),
    Dirty(DirtyEvent),
}

/// What an operation caused: notifications for the language server in the order they must be sent, events for the windows.
#[derive(Debug, Default, PartialEq)]
pub struct Effects {
    pub notifications: Vec<(&'static str, Value)>,
    pub events: Vec<DocumentEvent>,
}

impl Effects {
    fn extend(&mut self, other: Effects) {
        self.notifications.extend(other.notifications);
        self.events.extend(other.events);
    }
}

struct Document {
    text: String,
    /// The content on disk as last read or written, which unsaved edits are based on.
    saved: DiskSnapshot,
    /// The newer content a reload found on disk while the document had unsaved edits.
    changed_on_disk: Option<DiskSnapshot>,
    version: i32,
    /// The language id the servers know the document by; None for documents no server receives.
    language_id: Option<String>,
    /// Labels of the windows that loaded the document.
    holders: HashSet<String>,
}

impl Document {
    fn is_dirty(&self) -> bool {
        self.text != self.saved.text
    }

    /// Whether the file on disk still holds the saved content: by its stamp, or when that changed, by its content.
    fn is_saved_on(&self, disk: &impl DiskFile) -> bool {
        DiskStamp::same(self.saved.stamp, disk.stamp()) || disk.read().is_ok_and(|text| text == self.saved.text)
    }

    /// The stamp of the newest content known on disk, which a reload need not read again; unsaved edits that went
    /// back to the saved content leave a change noted under them to be taken over.
    fn known_stamp(&self) -> Option<DiskStamp> {
        match &self.changed_on_disk {
            Some(changed) if self.is_dirty() => changed.stamp,
            Some(_) => None,
            None => self.saved.stamp,
        }
    }

    fn state(&self) -> DocumentState {
        DocumentState { text: self.text.clone(), version: self.version, is_dirty: self.is_dirty() }
    }
}

/// The documents of one worktree.
pub struct WorktreeDocuments {
    worktree: PathBuf,
    documents: HashMap<String, Document>,
}

impl WorktreeDocuments {
    pub fn new(worktree: PathBuf) -> Self {
        Self { worktree, documents: HashMap::new() }
    }

    /// Registers `owner` as a holder of `path` and returns the shared state; the first holder reads the file from `disk`
    /// and opens it in the language server.
    pub fn open(&mut self, path: &str, owner: &str, language_id: &str, disk: &impl DiskFile) -> Result<(DocumentState, Effects), String> {
        let mut effects = Effects::default();
        if !self.documents.contains_key(path) {
            let saved = DiskSnapshot::read(disk)?;
            let language_id = (SERVED_LANGUAGES.contains(&language_id) && is_servable(&saved.text)).then(|| language_id.to_string());
            let document =
                Document { text: saved.text.clone(), saved, changed_on_disk: None, version: 1, language_id, holders: HashSet::new() };
            effects.notifications.extend(open_notification(self.uri(path), &document));
            self.documents.insert(path.to_string(), document);
        }
        let document = self.documents.get_mut(path).expect("the document was inserted above");
        document.holders.insert(owner.to_string());
        Ok((document.state(), effects))
    }

    /// Applies `changes` made against `base_version`; None when the document moved on since.
    pub fn edit(&mut self, path: &str, base_version: i32, changes: Vec<ContentChange>) -> Result<(Option<EditAck>, Effects), String> {
        let uri = self.uri(path);
        let worktree_path = self.worktree_path();
        let document = self.documents.get_mut(path).ok_or("the document is not open")?;
        if document.version != base_version {
            return Ok((None, Effects::default()));
        }
        document.text = apply_changes(&document.text, &changes)?;
        document.version += 1;

        let mut effects = Effects::default();
        if document.language_id.is_some() {
            let params = json!({ "textDocument": { "uri": uri, "version": document.version }, "contentChanges": changes });
            effects.notifications.push(("textDocument/didChange", params));
        }
        let ack = EditAck { version: document.version, is_dirty: document.is_dirty() };
        effects.events.push(DocumentEvent::Changed(ChangedEvent {
            worktree_path,
            path: path.to_string(),
            version: ack.version,
            changes: Some(changes),
            text: None,
            is_dirty: ack.is_dirty,
        }));
        Ok((Some(ack), effects))
    }

    /// The current text of `path`.
    pub fn text(&self, path: &str) -> Result<String, String> {
        self.documents.get(path).map(|document| document.text.clone()).ok_or_else(|| "the document is not open".to_string())
    }

    /// Takes the content on `disk` over (see `take_disk`) unless its stamp shows no change since it was last read or
    /// written; a file that cannot be read keeps its document.
    pub fn reload(&mut self, path: &str, disk: &impl DiskFile) -> Effects {
        let Some(document) = self.documents.get(path) else {
            return Effects::default();
        };
        if DiskStamp::same(document.known_stamp(), disk.stamp()) {
            return Effects::default();
        }
        match DiskSnapshot::read(disk) {
            Ok(snapshot) => self.take_disk(path, snapshot),
            Err(_) => Effects::default(),
        }
    }

    /// Throws the unsaved edits of `path` away; the document goes back to the newest content known on disk.
    pub fn revert(&mut self, path: &str) -> Effects {
        let Some(document) = self.documents.get_mut(path) else {
            return Effects::default();
        };
        if !document.is_dirty() {
            return Effects::default();
        }
        if let Some(changed) = document.changed_on_disk.take() {
            document.saved = changed;
        }
        let saved_text = document.saved.text.clone();
        let mut effects = self.replace(path, saved_text, false);
        effects.extend(self.close_if_unused(path));
        effects
    }

    /// Records that the file on disk holds `text` now (read by a diff view) and returns whether the document still has
    /// unsaved edits; see `take_disk`.
    pub fn mark_saved(&mut self, path: &str, text: String) -> (bool, Effects) {
        let effects = self.take_disk(path, DiskSnapshot { text, stamp: None });
        (self.documents.get(path).is_some_and(Document::is_dirty), effects)
    }

    /// What saving `path` writes: nothing without unsaved edits, and nothing but a conflict when the file on `disk`
    /// changed since the edits were based on it, unless `force`.
    pub fn plan_save(&self, path: &str, force: bool, disk: &impl DiskFile) -> Result<SavePlan, String> {
        let document = self.documents.get(path).ok_or("the document is not open")?;
        if !document.is_dirty() {
            return Ok(SavePlan::Unchanged);
        }
        if force || document.is_saved_on(disk) {
            return Ok(SavePlan::Write(document.text.clone()));
        }
        Ok(SavePlan::Conflict)
    }

    /// Records that a save wrote `written` to disk and returns whether edits made meanwhile keep the document dirty.
    pub fn mark_written(&mut self, path: &str, written: DiskSnapshot) -> (bool, Effects) {
        let worktree_path = self.worktree_path();
        let Some(document) = self.documents.get_mut(path) else {
            return (false, Effects::default());
        };
        let was_dirty = document.is_dirty();
        document.saved = written;
        document.changed_on_disk = None;
        let is_dirty = document.is_dirty();
        let mut effects = Effects::default();
        if is_dirty != was_dirty {
            effects.events.push(DocumentEvent::Dirty(DirtyEvent { worktree_path, path: path.to_string(), is_dirty }));
        }
        effects.extend(self.close_if_unused(path));
        (is_dirty, effects)
    }

    /// Takes `disk`, content just found on disk, over. A document without unsaved edits takes it as its text, so that a
    /// later save cannot write its outdated text back. One with unsaved edits keeps them: it is clean when the disk
    /// holds its text, and otherwise notes the content as changed on disk unless it is the saved one.
    fn take_disk(&mut self, path: &str, disk: DiskSnapshot) -> Effects {
        let worktree_path = self.worktree_path();
        let Some(document) = self.documents.get_mut(path) else {
            return Effects::default();
        };
        let mut effects = Effects::default();
        if !document.is_dirty() && document.text != disk.text {
            let stamp = disk.stamp;
            effects = self.replace(path, disk.text, true);
            let document = self.documents.get_mut(path).expect("replace keeps the document");
            document.saved.stamp = stamp;
            document.changed_on_disk = None;
        } else if !document.is_dirty() || document.text == disk.text {
            let was_dirty = document.is_dirty();
            document.saved = disk;
            document.changed_on_disk = None;
            if was_dirty {
                effects.events.push(DocumentEvent::Dirty(DirtyEvent { worktree_path, path: path.to_string(), is_dirty: false }));
            }
        } else if document.saved.text == disk.text {
            document.saved = disk;
            document.changed_on_disk = None;
        } else {
            document.changed_on_disk = Some(disk);
        }
        effects.extend(self.close_if_unused(path));
        effects
    }

    /// Drops the hold of `owner` on `path`; the last holder closes the document.
    pub fn close(&mut self, path: &str, owner: &str) -> Effects {
        let Some(document) = self.documents.get_mut(path) else {
            return Effects::default();
        };
        document.holders.remove(owner);
        if !document.holders.is_empty() {
            return Effects::default();
        }
        self.remove(path)
    }

    /// The paths whose documents have unsaved edits, sorted.
    pub fn dirty_paths(&self) -> Vec<String> {
        let mut paths: Vec<String> =
            self.documents.iter().filter(|(_, document)| document.is_dirty()).map(|(path, _)| path.clone()).collect();
        paths.sort();
        paths
    }

    /// The texts of the documents with unsaved edits by path.
    pub fn unsaved_texts(&self) -> HashMap<String, Arc<str>> {
        self.documents
            .iter()
            .filter(|(_, document)| document.is_dirty())
            .map(|(path, document)| (path.clone(), Arc::from(document.text.as_str())))
            .collect()
    }

    /// Forgets the holds of `owner`, whose window closed or loads a new page; documents with unsaved edits stay open.
    pub fn release_owner(&mut self, owner: &str) -> Effects {
        let mut released = Vec::new();
        for (path, document) in &mut self.documents {
            if document.holders.remove(owner) && document.holders.is_empty() && !document.is_dirty() {
                released.push(path.clone());
            }
        }
        let mut effects = Effects::default();
        for path in released {
            effects.extend(self.remove(&path));
        }
        effects
    }

    /// Whether the language servers receive the document of `path`.
    pub fn serves(&self, path: &str) -> bool {
        self.documents.get(path).is_some_and(|document| document.language_id.is_some())
    }

    /// Whether the `kind` server receives any document of the worktree.
    pub fn serves_any(&self, kind: ServerKind) -> bool {
        self.documents.iter().any(|(path, document)| document.language_id.is_some() && kind.receives(path))
    }

    /// `didOpen` of every served document, for a server that has not seen them yet; `send` drops those of other servers.
    pub fn open_notifications(&self) -> Vec<(&'static str, Value)> {
        self.documents.iter().filter_map(|(path, document)| open_notification(self.uri(path), document)).collect()
    }

    /// Sets the text of `path` as one change to a new version; `is_saved` makes it the saved state too, with an unknown
    /// stamp that callers knowing it set.
    fn replace(&mut self, path: &str, text: String, is_saved: bool) -> Effects {
        let uri = self.uri(path);
        let worktree_path = self.worktree_path();
        let document = self.documents.get_mut(path).expect("callers checked that the document is open");
        if is_saved {
            document.saved = DiskSnapshot { text: text.clone(), stamp: None };
        }
        document.text = text;
        document.version += 1;

        let mut effects = Effects::default();
        if document.language_id.is_some() {
            let params =
                json!({ "textDocument": { "uri": uri, "version": document.version }, "contentChanges": [{ "text": document.text }] });
            effects.notifications.push(("textDocument/didChange", params));
        }
        effects.events.push(DocumentEvent::Changed(ChangedEvent {
            worktree_path,
            path: path.to_string(),
            version: document.version,
            changes: None,
            text: Some(document.text.clone()),
            is_dirty: document.is_dirty(),
        }));
        effects
    }

    /// Closes `path` when no window holds it and it has no unsaved edits, the only reason a document lives without holders.
    fn close_if_unused(&mut self, path: &str) -> Effects {
        let is_unused = self.documents.get(path).is_some_and(|document| document.holders.is_empty() && !document.is_dirty());
        if !is_unused {
            return Effects::default();
        }
        self.remove(path)
    }

    /// Closes `path`; unsaved edits it still had are gone, which the windows hear as `document:dirty`.
    fn remove(&mut self, path: &str) -> Effects {
        let mut effects = Effects::default();
        let Some(document) = self.documents.remove(path) else {
            return effects;
        };
        if document.language_id.is_some() {
            effects.notifications.push(("textDocument/didClose", json!({ "textDocument": { "uri": self.uri(path) } })));
        }
        if document.is_dirty() {
            let event = DirtyEvent { worktree_path: self.worktree_path(), path: path.to_string(), is_dirty: false };
            effects.events.push(DocumentEvent::Dirty(event));
        }
        effects
    }

    fn uri(&self, path: &str) -> String {
        lsp::file_uri(&self.worktree.join(path))
    }

    fn worktree_path(&self) -> String {
        self.worktree.to_string_lossy().into_owned()
    }
}

fn open_notification(uri: String, document: &Document) -> Option<(&'static str, Value)> {
    let language_id = document.language_id.as_ref()?;
    let text_document = json!({ "uri": uri, "languageId": language_id, "version": document.version, "text": document.text });
    Some(("textDocument/didOpen", json!({ "textDocument": text_document })))
}

/// Applies LSP content changes one after another, as Monaco reports them (last change first, so earlier ranges stay valid).
pub fn apply_changes(text: &str, changes: &[ContentChange]) -> Result<String, String> {
    let mut result = text.to_string();
    for change in changes {
        let start = offset_of(&result, change.range.start);
        let end = offset_of(&result, change.range.end);
        let (Some(start), Some(end)) = (start, end) else {
            return Err(format!("the range {:?} lies outside the document", change.range));
        };
        if start > end {
            return Err(format!("the range {:?} ends before it starts", change.range));
        }
        result.replace_range(start..end, &change.text);
    }
    Ok(result)
}

/// The byte offset of `position` in `text`; lines end at `\n`, `\r\n` or `\r`. None past the end of its line or inside
/// a surrogate pair.
fn offset_of(text: &str, position: Position) -> Option<usize> {
    let is_break = |character: char| character == '\n' || character == '\r';
    let bytes = text.as_bytes();
    let mut line_start = 0;
    for _ in 0..position.line {
        let index = line_start + text[line_start..].find(is_break)?;
        line_start = if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') { index + 2 } else { index + 1 };
    }
    let line_end = text[line_start..].find(is_break).map_or(text.len(), |index| line_start + index);
    let mut units = 0;
    for (index, character) in text[line_start..line_end].char_indices() {
        if units == position.character {
            return Some(line_start + index);
        }
        if units > position.character {
            return None;
        }
        units += character.len_utf16() as u32;
    }
    (units == position.character).then_some(line_end)
}

/// The documents of every worktree, each behind its own lock, and the worktree of every session that used them.
#[derive(Default)]
pub struct DocumentRegistry {
    worktrees: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<Entry>>>>,
    sessions: Mutex<HashMap<Uuid, PathBuf>>,
}

struct Entry {
    documents: WorktreeDocuments,
    /// Per kind the server the served documents were opened in; another one gets them all instead of the next
    /// notifications.
    servers: HashMap<ServerKind, Weak<LspServer>>,
}

impl DocumentRegistry {
    fn entry(&self, worktree: &Path) -> Arc<tokio::sync::Mutex<Entry>> {
        let mut worktrees = self.worktrees.lock().unwrap();
        let entry = worktrees.entry(worktree.to_path_buf()).or_insert_with(|| {
            Arc::new(tokio::sync::Mutex::new(Entry { documents: WorktreeDocuments::new(worktree.to_path_buf()), servers: HashMap::new() }))
        });
        entry.clone()
    }

    /// Drops the documents of a worktree no session uses any more, unsaved edits included, so a later worktree at the
    /// same path starts from its files.
    pub fn forget(&self, worktree: &Path) {
        self.worktrees.lock().unwrap().remove(worktree);
        self.sessions.lock().unwrap().retain(|_, session_worktree| session_worktree != worktree);
    }

    /// The texts of `worktree`'s documents with unsaved edits by path, for searches that must find what the editors show.
    pub async fn unsaved_texts(&self, worktree: &Path) -> HashMap<String, Arc<str>> {
        let entry = self.worktrees.lock().unwrap().get(worktree).cloned();
        match entry {
            Some(entry) => entry.lock().await.documents.unsaved_texts(),
            None => HashMap::new(),
        }
    }

    /// The text of `worktree`'s document `path` while it is at `version`, for the change markers of the editors.
    pub async fn text_at(&self, worktree: &Path, path: &str, version: i32) -> Option<String> {
        let entry = self.worktrees.lock().unwrap().get(worktree).cloned()?;
        let entry = entry.lock().await;
        entry.documents.documents.get(path).filter(|document| document.version == version).map(|document| document.text.clone())
    }
}

/// The worktree of session `id`, remembered after the first lookup so an edit needs no session store read. Paths only
/// name documents here; reading a file resolves its path through `session_file`.
fn worktree_of(app: &AppHandle, id: Uuid) -> Result<PathBuf, String> {
    let registry = app.state::<DocumentRegistry>();
    if let Some(worktree) = registry.sessions.lock().unwrap().get(&id) {
        return Ok(worktree.clone());
    }
    let worktree = worktree_session(app, id)?.worktree_path;
    registry.sessions.lock().unwrap().insert(id, worktree.clone());
    Ok(worktree)
}

/// The worktree-relative `path` of session `id` on disk; each access resolves it through `session_file`.
struct WorktreeFile<'a> {
    app: &'a AppHandle,
    id: Uuid,
    path: &'a str,
}

impl DiskFile for WorktreeFile<'_> {
    fn stamp(&self) -> Option<DiskStamp> {
        let (_, target) = session_file(self.app, self.id, self.path).ok()?;
        DiskStamp::of(&target)
    }

    fn read(&self) -> Result<String, String> {
        let (record, _) = session_file(self.app, self.id, self.path)?;
        workspace::read_file(&record.worktree_path, self.path)
    }
}

/// Runs `operation` on the documents of `worktree` and delivers what it caused, all under the worktree's lock, so the
/// server and the windows see every change in version order.
async fn update<Output>(
    app: &AppHandle,
    worktree: &Path,
    operation: impl FnOnce(&mut WorktreeDocuments) -> Result<(Output, Effects), String>,
) -> Result<Output, String> {
    let entry = app.state::<DocumentRegistry>().entry(worktree);
    let mut entry = entry.lock().await;
    let (result, effects) = operation(&mut entry.documents)?;
    deliver(app, &mut entry, effects).await;
    Ok(result)
}

/// Emits the events, then sends the notifications to the worktree's servers: the TypeScript server is started while
/// it serves any document, the Angular server only gets them while it runs (opening a document it receives or a
/// request starts it, see `start_angular_server`). A server that has not seen the documents yet (a new or restarted
/// one) gets them all opened at their current text instead. Server failures cost language features only, never the
/// operation.
async fn deliver(app: &AppHandle, entry: &mut Entry, effects: Effects) {
    for event in effects.events {
        let _ = match event {
            DocumentEvent::Changed(payload) => app.emit("document:changed", payload),
            DocumentEvent::Dirty(payload) => app.emit("document:dirty", payload),
        };
    }
    if effects.notifications.is_empty() {
        return;
    }
    let worktree = entry.documents.worktree.clone();
    for kind in ServerKind::ALL {
        let server = if kind == ServerKind::Typescript && entry.documents.serves_any(kind) {
            lsp::server_for_worktree(app, &worktree, kind).ok()
        } else {
            lsp::running_server(app, &worktree, kind)
        };
        let Some(server) = server else { continue };
        let notifications = if is_known(entry, &server) {
            effects.notifications.clone()
        } else {
            entry.servers.insert(kind, Arc::downgrade(&server));
            entry.documents.open_notifications()
        };
        send(&server, notifications).await;
    }
}

/// Whether the served documents were opened in `server` already.
fn is_known(entry: &Entry, server: &Arc<LspServer>) -> bool {
    entry.servers.get(&server.kind()).and_then(Weak::upgrade).is_some_and(|known| Arc::ptr_eq(&known, server))
}

/// Sends the notifications about documents `server` receives, in order.
async fn send(server: &LspServer, notifications: Vec<(&'static str, Value)>) {
    for (method, params) in notifications {
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default();
        if !server.kind().receives(uri) {
            continue;
        }
        if server.notify(method, params).await.is_err() {
            return;
        }
    }
}

/// Opens the served documents of `worktree` in `server` unless they are open there already; requests call it before
/// they reach the server, and concurrent callers wait until the first one has sent the documents.
pub async fn open_in(app: AppHandle, worktree: PathBuf, server: Arc<LspServer>) {
    let entry = app.state::<DocumentRegistry>().worktrees.lock().unwrap().get(&worktree).cloned();
    let Some(entry) = entry else {
        return;
    };
    let mut entry = entry.lock().await;
    if is_known(&entry, &server) {
        return;
    }
    entry.servers.insert(server.kind(), Arc::downgrade(&server));
    let notifications = entry.documents.open_notifications();
    send(&server, notifications).await;
}

/// Forgets the documents and views of the window `owner` after it closed or started loading a new page.
pub fn release_owner(app: &AppHandle, owner: &str) {
    let app = app.clone();
    let owner = owner.to_string();
    tauri::async_runtime::spawn(async move {
        let entries: Vec<_> = app.state::<DocumentRegistry>().worktrees.lock().unwrap().values().cloned().collect();
        for entry in entries {
            let mut entry = entry.lock().await;
            let effects = entry.documents.release_owner(&owner);
            deliver(&app, &mut entry, effects).await;
        }
    });
}

/// Starts the Angular server of `worktree` in the background unless it runs, and opens the served documents in it, so
/// that it has loaded and analyzed their projects (seconds each) before a request needs it. Worktrees without
/// `@angular/language-service` get none.
fn start_angular_server(app: &AppHandle, worktree: &Path) {
    if lsp::running_server(app, worktree, ServerKind::Angular).is_some() {
        return;
    }
    let app = app.clone();
    let worktree = worktree.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let Ok(server) = lsp::server_for_worktree(&app, &worktree, ServerKind::Angular) else { return };
        open_in(app, worktree, server).await;
    });
}

#[tauri::command]
pub async fn document_open(app: AppHandle, window: Window, id: Uuid, path: String, language_id: String) -> Result<DocumentState, String> {
    let worktree = worktree_of(&app, id)?;
    let file = WorktreeFile { app: &app, id, path: &path };
    let (state, is_served) = update(&app, &worktree, |documents| {
        let (state, effects) = documents.open(&path, window.label(), &language_id, &file)?;
        Ok(((state, documents.serves(&path)), effects))
    })
    .await?;
    if is_served && ServerKind::Angular.receives(&path) {
        start_angular_server(&app, &worktree);
    }
    Ok(state)
}

#[tauri::command]
pub async fn document_edit(
    app: AppHandle,
    id: Uuid,
    path: String,
    base_version: i32,
    changes: Vec<ContentChange>,
) -> Result<Option<EditAck>, String> {
    let worktree = worktree_of(&app, id)?;
    update(&app, &worktree, |documents| documents.edit(&path, base_version, changes))
        .await
        .map_err(|error| format!("failed to edit {path}: {error}"))
}

/// Writes the shared text of `path` to disk, atomically, unless it has no unsaved edits. Unsaved edits whose file changed
/// on disk since they were based on it are written only with `force`; otherwise the answer is a conflict.
#[tauri::command]
pub async fn document_save(app: AppHandle, id: Uuid, path: String, force: bool) -> Result<SaveOutcome, String> {
    let worktree = worktree_of(&app, id)?;
    let file = WorktreeFile { app: &app, id, path: &path };
    let plan = update(&app, &worktree, |documents| Ok((documents.plan_save(&path, force, &file)?, Effects::default())))
        .await
        .map_err(|error| format!("failed to save {path}: {error}"))?;
    let text = match plan {
        SavePlan::Write(text) => text,
        SavePlan::Unchanged => return Ok(SaveOutcome::Saved { is_dirty: false }),
        SavePlan::Conflict => return Ok(SaveOutcome::Conflict),
    };
    let stamp = write_worktree_file(&app, id, &path, &text).await?;
    let is_dirty = update(&app, &worktree, |documents| Ok(documents.mark_written(&path, DiskSnapshot { text, stamp }))).await?;
    Ok(SaveOutcome::Saved { is_dirty })
}

/// Rewrites `path` of session `id` with `rewrite` from the text the editors show, unless it returns None; returns whether
/// it did. A document a window holds changes in every window; it is saved unless it had unsaved edits, which it keeps.
/// One without unsaved edits first takes the content on disk over, so the rewrite never writes an outdated text back.
/// Any other file is rewritten on disk.
pub async fn rewrite(app: &AppHandle, id: Uuid, path: &str, rewrite: impl FnOnce(&str) -> Option<String>) -> Result<bool, String> {
    let worktree = worktree_of(app, id)?;
    let entry = app.state::<DocumentRegistry>().entry(&worktree);
    let mut entry = entry.lock().await;
    let file = WorktreeFile { app, id, path };
    let effects = entry.documents.reload(path, &file);
    deliver(app, &mut entry, effects).await;
    let was_dirty = entry.documents.documents.get(path).map(Document::is_dirty);
    let text = match was_dirty {
        Some(_) => entry.documents.text(path)?,
        None => file.read()?,
    };
    let Some(text) = rewrite(&text) else {
        return Ok(false);
    };
    let stamp = match was_dirty {
        Some(true) => None,
        _ => write_worktree_file(app, id, path, &text).await?,
    };
    if let Some(was_dirty) = was_dirty {
        let effects = entry.documents.replace(path, text, !was_dirty);
        if let Some(document) = entry.documents.documents.get_mut(path).filter(|_| !was_dirty) {
            document.saved.stamp = stamp;
        }
        deliver(app, &mut entry, effects).await;
    }
    Ok(true)
}

/// Takes the content on disk over for every one of `paths` whose file changed since it was last read or written;
/// documents with unsaved edits keep them.
#[tauri::command]
pub async fn document_reload(app: AppHandle, id: Uuid, paths: Vec<String>) -> Result<(), String> {
    let worktree = worktree_of(&app, id)?;
    update(&app, &worktree, |documents| {
        let mut effects = Effects::default();
        for path in &paths {
            effects.extend(documents.reload(path, &WorktreeFile { app: &app, id, path }));
        }
        Ok(((), effects))
    })
    .await
}

#[tauri::command]
pub async fn document_revert(app: AppHandle, id: Uuid, path: String) -> Result<(), String> {
    let worktree = worktree_of(&app, id)?;
    update(&app, &worktree, |documents| Ok(((), documents.revert(&path)))).await
}

/// Records that the file on disk holds `text` now (read by a diff view); returns whether the document is still dirty.
#[tauri::command]
pub async fn document_mark_saved(app: AppHandle, id: Uuid, path: String, text: String) -> Result<bool, String> {
    let worktree = worktree_of(&app, id)?;
    update(&app, &worktree, |documents| Ok(documents.mark_saved(&path, text))).await
}

#[tauri::command]
pub async fn document_close(app: AppHandle, window: Window, id: Uuid, path: String) -> Result<(), String> {
    let worktree = worktree_of(&app, id)?;
    update(&app, &worktree, |documents| Ok(((), documents.close(&path, window.label())))).await
}

/// The paths of the session's worktree whose documents have unsaved edits, for a window that starts following them.
#[tauri::command]
pub async fn dirty_documents(app: AppHandle, id: Uuid) -> Result<Vec<String>, String> {
    let worktree = worktree_of(&app, id)?;
    update(&app, &worktree, |documents| Ok((documents.dirty_paths(), Effects::default()))).await
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::time::{Duration, SystemTime};

    use super::*;

    fn position(line: u32, character: u32) -> Position {
        Position { line, character }
    }

    fn change(start: (u32, u32), end: (u32, u32), text: &str) -> ContentChange {
        ContentChange { range: Range { start: position(start.0, start.1), end: position(end.0, end.1) }, text: text.to_string() }
    }

    fn documents() -> WorktreeDocuments {
        WorktreeDocuments::new(PathBuf::from("/work tree"))
    }

    fn methods(effects: &Effects) -> Vec<&'static str> {
        effects.notifications.iter().map(|(method, _)| *method).collect()
    }

    /// A file whose content and stamp a test sets; one without a stamp is read on every reload.
    struct FakeFile {
        text: Result<String, String>,
        stamp: Option<DiskStamp>,
        reads: Cell<usize>,
    }

    impl DiskFile for FakeFile {
        fn stamp(&self) -> Option<DiskStamp> {
            self.stamp
        }

        fn read(&self) -> Result<String, String> {
            self.reads.set(self.reads.get() + 1);
            self.text.clone()
        }
    }

    fn read(text: &str) -> FakeFile {
        FakeFile { text: Ok(text.to_string()), stamp: None, reads: Cell::new(0) }
    }

    /// `text` with a stamp of modification second `second`.
    fn stamped(text: &str, second: u64) -> FakeFile {
        let modified = SystemTime::UNIX_EPOCH + Duration::from_secs(second);
        FakeFile { stamp: Some(DiskStamp { modified, len: text.len() as u64 }), ..read(text) }
    }

    fn missing() -> FakeFile {
        FakeFile { text: Err("missing".into()), ..read("") }
    }

    /// A file that must not be touched.
    struct Untouched(&'static str);

    impl DiskFile for Untouched {
        fn stamp(&self) -> Option<DiskStamp> {
            panic!("{}", self.0)
        }

        fn read(&self) -> Result<String, String> {
            panic!("{}", self.0)
        }
    }

    /// A real file.
    struct OnDisk(PathBuf);

    impl DiskFile for OnDisk {
        fn stamp(&self) -> Option<DiskStamp> {
            DiskStamp::of(&self.0)
        }

        fn read(&self) -> Result<String, String> {
            std::fs::read_to_string(&self.0).map_err(|error| error.to_string())
        }
    }

    #[test]
    fn applies_changes_in_utf16_columns() {
        let text = "const 😀 = 1;\nlet b = 2;\n";
        assert_eq!(apply_changes(text, &[change((0, 10), (0, 11), "")]).unwrap(), "const 😀 =1;\nlet b = 2;\n");
        assert_eq!(apply_changes(text, &[change((1, 4), (1, 5), "c")]).unwrap(), "const 😀 = 1;\nlet c = 2;\n");
        assert!(apply_changes(text, &[change((0, 7), (0, 7), "x")]).is_err(), "column 7 lies inside the surrogate pair");
    }

    #[test]
    fn applies_monacos_last_first_changes_one_after_another() {
        let text = "a\nb\nc";
        let changes = [change((2, 0), (2, 1), "C"), change((0, 0), (0, 1), "A")];
        assert_eq!(apply_changes(text, &changes).unwrap(), "A\nb\nC");
    }

    #[test]
    fn counts_crlf_and_lone_cr_as_one_line_break() {
        assert_eq!(apply_changes("a\r\nb\rc", &[change((1, 0), (2, 1), "x")]).unwrap(), "a\r\nx");
        assert_eq!(apply_changes("a\r\n", &[change((1, 0), (1, 0), "b")]).unwrap(), "a\r\nb");
    }

    #[test]
    fn rejects_ranges_outside_the_document() {
        assert!(apply_changes("ab", &[change((0, 3), (0, 3), "x")]).is_err());
        assert!(apply_changes("ab", &[change((1, 0), (1, 0), "x")]).is_err());
        assert!(apply_changes("ab", &[change((0, 2), (0, 1), "x")]).is_err());
    }

    #[test]
    fn the_second_window_shares_the_open_document() {
        let mut documents = documents();
        let (first, effects) = documents.open("a.ts", "main", "typescript", &read("one")).unwrap();
        assert_eq!(first, DocumentState { text: "one".into(), version: 1, is_dirty: false });
        assert_eq!(methods(&effects), ["textDocument/didOpen"]);
        assert_eq!(effects.notifications[0].1["textDocument"]["uri"], "file:///work%20tree/a.ts");

        documents.edit("a.ts", 1, vec![change((0, 3), (0, 3), "!")]).unwrap();
        let (second, effects) = documents.open("a.ts", "editor-1", "typescript", &Untouched("an open document is not read again")).unwrap();
        assert_eq!(second, DocumentState { text: "one!".into(), version: 2, is_dirty: true });
        assert_eq!(effects, Effects::default());
    }

    #[test]
    fn an_edit_against_a_stale_version_is_refused() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("x")).unwrap();
        let (ack, effects) = documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "y")]).unwrap();
        assert_eq!(ack, Some(EditAck { version: 2, is_dirty: true }));
        assert_eq!(methods(&effects), ["textDocument/didChange"]);
        let DocumentEvent::Changed(event) = &effects.events[0] else { panic!("expected a change event") };
        assert_eq!((event.version, event.text.as_deref()), (2, None));

        let (ack, effects) = documents.edit("a.ts", 1, vec![change((0, 0), (0, 0), "z")]).unwrap();
        assert_eq!((ack, effects), (None, Effects::default()));
        assert_eq!(documents.text("a.ts").unwrap(), "xy");
    }

    #[test]
    fn a_document_too_long_for_the_servers_opens_without_them() {
        let mut documents = documents();
        let (state, effects) = documents.open("dist/main.js", "main", "javascript", &read(&"x".repeat(MAX_SERVED_LENGTH + 1))).unwrap();
        assert_eq!(state.text.len(), MAX_SERVED_LENGTH + 1);
        assert!(effects.notifications.is_empty());
        assert!(!documents.serves("dist/main.js"));
        let (_, effects) = documents.edit("dist/main.js", 1, vec![change((0, 0), (0, 0), "y")]).unwrap();
        assert!(effects.notifications.is_empty());
        assert!(documents.close("dist/main.js", "main").notifications.is_empty());

        // Two bytes but one UTF-16 code unit each: the length counts as Monaco measures it.
        let (_, effects) = documents.open("src/umlaut.ts", "main", "typescript", &read(&"ä".repeat(MAX_SERVED_LENGTH))).unwrap();
        assert_eq!(methods(&effects), ["textDocument/didOpen"]);
        assert!(documents.serves("src/umlaut.ts"));
    }

    #[test]
    fn documents_of_other_languages_never_reach_the_server() {
        let mut documents = documents();
        let (_, effects) = documents.open("README.md", "main", "markdown", &read("# Hi")).unwrap();
        assert!(effects.notifications.is_empty());
        let (_, effects) = documents.edit("README.md", 1, vec![change((0, 4), (0, 4), "!")]).unwrap();
        assert!(effects.notifications.is_empty());
        assert_eq!(effects.events.len(), 1);
        assert!(!documents.serves_any(ServerKind::Typescript));
        assert!(!documents.serves_any(ServerKind::Angular));
    }

    #[test]
    fn a_template_reaches_only_the_angular_server() {
        let mut documents = documents();
        let (_, effects) = documents.open("app.html", "main", "html", &read("<p></p>")).unwrap();
        assert_eq!(methods(&effects), ["textDocument/didOpen"]);
        assert!(!documents.serves_any(ServerKind::Typescript));
        assert!(documents.serves_any(ServerKind::Angular));
    }

    #[test]
    fn a_reload_takes_the_disk_content_once_and_keeps_unsaved_edits() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("old")).unwrap();
        let effects = documents.reload("a.ts", &read("new"));
        assert_eq!(methods(&effects), ["textDocument/didChange"]);
        assert_eq!(effects.notifications[0].1["contentChanges"], json!([{ "text": "new" }]));
        let DocumentEvent::Changed(event) = &effects.events[0] else { panic!("expected a change event") };
        assert_eq!((event.version, event.text.as_deref(), event.is_dirty), (2, Some("new"), false));

        assert_eq!(documents.reload("a.ts", &read("new")), Effects::default(), "the second window's reload changes nothing");

        documents.edit("a.ts", 2, vec![change((0, 0), (0, 0), "my ")]).unwrap();
        assert_eq!(documents.reload("a.ts", &read("newer")), Effects::default());
        assert_eq!(documents.text("a.ts").unwrap(), "my new");
        assert_eq!(documents.reload("gone.ts", &read("x")), Effects::default());
    }

    #[test]
    fn a_reload_reads_only_files_whose_stamp_changed() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("old", 1)).unwrap();
        let unchanged = stamped("old", 1);
        assert_eq!(documents.reload("a.ts", &unchanged), Effects::default());
        assert_eq!(unchanged.reads.get(), 0, "an unchanged stamp skips the read");

        let touched = stamped("old", 2);
        assert_eq!(documents.reload("a.ts", &touched), Effects::default());
        assert_eq!(touched.reads.get(), 1, "a new stamp is compared by content");
        let again = stamped("old", 2);
        documents.reload("a.ts", &again);
        assert_eq!(again.reads.get(), 0, "the new stamp is remembered");

        let effects = documents.reload("a.ts", &stamped("new", 3));
        let DocumentEvent::Changed(event) = &effects.events[0] else { panic!("expected a change event") };
        assert_eq!((event.text.as_deref(), event.is_dirty), (Some("new"), false));
        assert_eq!(documents.reload("a.ts", &missing()), Effects::default(), "a vanished file keeps its document");
    }

    #[test]
    fn a_save_writes_unsaved_edits_while_the_file_holds_their_base() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("a", 1)).unwrap();
        assert_eq!(documents.plan_save("a.ts", false, &Untouched("a clean document is not written")).unwrap(), SavePlan::Unchanged);

        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();
        assert_eq!(documents.plan_save("a.ts", false, &stamped("a", 1)).unwrap(), SavePlan::Write("ab".into()));
        assert_eq!(documents.plan_save("a.ts", false, &stamped("a", 2)).unwrap(), SavePlan::Write("ab".into()), "touched, not changed");
        assert!(documents.plan_save("gone.ts", false, &read("x")).is_err());
    }

    #[test]
    fn a_save_over_a_change_on_disk_is_a_conflict_unless_forced() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("base", 1)).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 4), (0, 4), " mine")]).unwrap();

        let agent = stamped("base agent", 2);
        assert_eq!(documents.plan_save("a.ts", false, &agent).unwrap(), SavePlan::Conflict, "also before a reload saw it");
        assert_eq!(documents.reload("a.ts", &agent), Effects::default());
        assert_eq!(documents.text("a.ts").unwrap(), "base mine", "the unsaved edits stay");
        let skipped = stamped("base agent", 2);
        documents.reload("a.ts", &skipped);
        assert_eq!(skipped.reads.get(), 0, "the noted change is not read again");
        assert_eq!(documents.plan_save("a.ts", false, &stamped("base agent", 2)).unwrap(), SavePlan::Conflict);
        assert_eq!(documents.plan_save("a.ts", false, &missing()).unwrap(), SavePlan::Conflict, "a deleted file changed too");
        assert_eq!(documents.plan_save("a.ts", true, &agent).unwrap(), SavePlan::Write("base mine".into()));

        let written = DiskSnapshot { text: "base mine".into(), stamp: stamped("base mine", 3).stamp };
        let (is_dirty, effects) = documents.mark_written("a.ts", written);
        assert!(!is_dirty);
        assert_eq!(effects.events.len(), 1);
        assert_eq!(documents.plan_save("a.ts", false, &stamped("base mine", 3)).unwrap(), SavePlan::Unchanged);
    }

    #[test]
    fn edits_made_during_a_save_stay_unsaved() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("a", 1)).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();
        let SavePlan::Write(text) = documents.plan_save("a.ts", false, &stamped("a", 1)).unwrap() else { panic!("expected a write") };
        documents.edit("a.ts", 2, vec![change((0, 2), (0, 2), "c")]).unwrap();

        let (is_dirty, effects) = documents.mark_written("a.ts", DiskSnapshot { text, stamp: stamped("ab", 2).stamp });
        assert!(is_dirty);
        assert_eq!(effects, Effects::default());
        let plan = documents.plan_save("a.ts", false, &stamped("ab", 2)).unwrap();
        assert_eq!(plan, SavePlan::Write("abc".into()), "its own write is no conflict");
    }

    #[test]
    fn a_change_on_disk_that_matches_the_unsaved_edits_makes_the_document_clean() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("a", 1)).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();
        let effects = documents.reload("a.ts", &stamped("ab", 2));
        assert_eq!(
            effects.events,
            [DocumentEvent::Dirty(DirtyEvent { worktree_path: "/work tree".into(), path: "a.ts".into(), is_dirty: false })]
        );
        assert!(effects.notifications.is_empty());
    }

    #[test]
    fn reverting_after_a_change_on_disk_takes_the_new_content() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("old", 1)).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 3), (0, 3), "!")]).unwrap();
        documents.reload("a.ts", &stamped("agent", 2));

        let effects = documents.revert("a.ts");
        let DocumentEvent::Changed(event) = &effects.events[0] else { panic!("expected a change event") };
        assert_eq!((event.text.as_deref(), event.is_dirty), (Some("agent"), false));
        let unchanged = stamped("agent", 2);
        documents.reload("a.ts", &unchanged);
        assert_eq!(unchanged.reads.get(), 0);
    }

    #[test]
    fn undoing_back_to_the_base_takes_a_noted_change_over_at_the_next_reload() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("old", 1)).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 3), (0, 3), "!")]).unwrap();
        documents.reload("a.ts", &stamped("agent", 2));
        documents.edit("a.ts", 2, vec![change((0, 3), (0, 4), "")]).unwrap();

        documents.reload("a.ts", &stamped("agent", 2));
        assert_eq!(documents.text("a.ts").unwrap(), "agent");
    }

    #[test]
    fn a_diff_reading_other_content_never_rebases_unsaved_edits() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &stamped("old", 1)).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 3), (0, 3), "!")]).unwrap();
        assert_eq!(documents.mark_saved("a.ts", "agent".into()), (true, Effects::default()));
        assert_eq!(documents.plan_save("a.ts", false, &stamped("agent", 2)).unwrap(), SavePlan::Conflict);
    }

    #[test]
    fn a_save_outcome_serializes_with_its_kind() {
        assert_eq!(serde_json::to_value(SaveOutcome::Saved { is_dirty: true }).unwrap(), json!({ "kind": "saved", "isDirty": true }));
        assert_eq!(serde_json::to_value(SaveOutcome::Conflict).unwrap(), json!({ "kind": "conflict" }));
    }

    #[test]
    fn revert_and_save_change_the_dirty_state() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("a")).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();

        let (is_dirty, effects) = documents.mark_saved("a.ts", "ab".into());
        assert!(!is_dirty);
        assert_eq!(
            effects.events,
            [DocumentEvent::Dirty(DirtyEvent { worktree_path: "/work tree".into(), path: "a.ts".into(), is_dirty: false })]
        );
        assert_eq!(documents.mark_saved("a.ts", "ab".into()), (false, Effects::default()));

        documents.edit("a.ts", 2, vec![change((0, 2), (0, 2), "c")]).unwrap();
        let effects = documents.revert("a.ts");
        assert_eq!(documents.text("a.ts").unwrap(), "ab");
        let DocumentEvent::Changed(event) = &effects.events[0] else { panic!("expected a change event") };
        assert_eq!((event.text.as_deref(), event.is_dirty), (Some("ab"), false));
        assert_eq!(documents.revert("a.ts"), Effects::default());
    }

    #[test]
    fn a_clean_document_takes_the_text_written_elsewhere_over() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("old")).unwrap();

        let (is_dirty, effects) = documents.mark_saved("a.ts", "new".into());
        assert!(!is_dirty);
        assert_eq!(methods(&effects), ["textDocument/didChange"]);
        let DocumentEvent::Changed(event) = &effects.events[0] else { panic!("expected a change event") };
        assert_eq!((event.text.as_deref(), event.is_dirty), (Some("new"), false));
        assert_eq!(documents.text("a.ts").unwrap(), "new");

        documents.edit("a.ts", 2, vec![change((0, 0), (0, 0), "my ")]).unwrap();
        assert_eq!(documents.mark_saved("a.ts", "newer".into()).0, true, "unsaved edits stay");
        assert_eq!(documents.text("a.ts").unwrap(), "my new");
    }

    #[test]
    fn undoing_back_to_the_saved_text_is_clean() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("a")).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();
        let (ack, _) = documents.edit("a.ts", 2, vec![change((0, 1), (0, 2), "")]).unwrap();
        assert_eq!(ack, Some(EditAck { version: 3, is_dirty: false }));
    }

    #[test]
    fn the_last_holder_closes_the_document() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("a")).unwrap();
        documents.open("a.ts", "editor-1", "typescript", &read("a")).unwrap();
        assert_eq!(documents.close("a.ts", "main"), Effects::default());
        assert_eq!(documents.text("a.ts").unwrap(), "a");
        assert_eq!(methods(&documents.close("a.ts", "editor-1")), ["textDocument/didClose"]);
        assert!(documents.text("a.ts").is_err());
    }

    #[test]
    fn releasing_a_window_drops_its_holds() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("a")).unwrap();
        documents.open("b.ts", "main", "typescript", &read("b")).unwrap();
        documents.open("b.ts", "editor-1", "typescript", &read("b")).unwrap();

        let effects = documents.release_owner("main");
        assert_eq!(methods(&effects), ["textDocument/didClose"]);
        assert_eq!(effects.notifications[0].1["textDocument"]["uri"], "file:///work%20tree/a.ts");
        assert!(documents.text("b.ts").is_ok());

        documents.release_owner("editor-1");
        assert!(documents.text("b.ts").is_err());
    }

    #[test]
    fn unsaved_edits_outlive_every_window_until_they_are_reverted() {
        let mut documents = documents();
        documents.open("a.ts", "editor-1", "typescript", &read("a")).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();

        assert_eq!(documents.release_owner("editor-1"), Effects::default());
        assert_eq!(documents.dirty_paths(), ["a.ts"]);
        let (state, _) = documents.open("a.ts", "main", "typescript", &Untouched("a kept document is not read again")).unwrap();
        assert_eq!(state, DocumentState { text: "ab".into(), version: 2, is_dirty: true });
        documents.release_owner("main");

        let effects = documents.revert("a.ts");
        assert_eq!(methods(&effects), ["textDocument/didChange", "textDocument/didClose"]);
        assert!(documents.text("a.ts").is_err());
        assert!(documents.dirty_paths().is_empty());
    }

    #[test]
    fn a_kept_document_closes_once_saved() {
        let mut documents = documents();
        documents.open("a.ts", "editor-1", "typescript", &read("a")).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();
        documents.release_owner("editor-1");

        let (is_dirty, effects) = documents.mark_saved("a.ts", "ab".into());
        assert!(!is_dirty);
        assert_eq!(methods(&effects), ["textDocument/didClose"]);
        assert!(documents.text("a.ts").is_err());
    }

    #[test]
    fn closing_a_dirty_document_reports_it_clean() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("a")).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "b")]).unwrap();
        let effects = documents.close("a.ts", "main");
        assert_eq!(
            effects.events,
            [DocumentEvent::Dirty(DirtyEvent { worktree_path: "/work tree".into(), path: "a.ts".into(), is_dirty: false })]
        );
    }

    struct Silent;

    impl lsp::LspEvents for Silent {
        fn diagnostics(&self, _worktree: &Path, _uri: String, _diagnostics: Value) {}
        fn exited(&self, _server: &Arc<LspServer>) {}
    }

    /// The bug this module fixes: a window that replaced the server's copy with an edit computed on its own stale copy
    /// left the declarations twice in the server ("Cannot redeclare block-scoped variable").
    #[tokio::test]
    async fn the_server_holds_one_copy_whatever_the_windows_send() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.ts"), "export const first = 1;\n").unwrap();
        std::fs::write(root.join("tsconfig.json"), r#"{ "compilerOptions": { "strict": true } }"#).unwrap();
        let started = lsp::Launch::typescript(&root).and_then(|launch| LspServer::start(root.clone(), ServerKind::Typescript, launch, Arc::new(Silent)));
        let Ok(server) = started else {
            println!("tsgo not installed, skipping");
            return;
        };
        let read_disk = &OnDisk(root.join("a.ts"));
        let uri = lsp::file_uri(&root.join("a.ts"));
        let mut documents = WorktreeDocuments::new(root.clone());

        let result = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            send(&server, documents.open("a.ts", "main", "typescript", read_disk).unwrap().1.notifications).await;
            send(&server, documents.open("a.ts", "editor-1", "typescript", read_disk).unwrap().1.notifications).await;
            let typed = documents.edit("a.ts", 1, vec![change((1, 0), (1, 0), "export const second = 2;\n")]).unwrap();
            send(&server, typed.1.notifications).await;
            documents.mark_saved("a.ts", documents.text("a.ts").unwrap());

            let agent_text = "export const first = 1;\nexport const second = 2;\nexport const third = 3;\n";
            std::fs::write(root.join("a.ts"), agent_text).unwrap();
            send(&server, documents.reload("a.ts", read_disk).notifications).await;
            let stale = documents.edit("a.ts", 1, vec![change((0, 0), (1, 0), agent_text)]).unwrap();
            assert_eq!(stale, (None, Effects::default()));
            send(&server, documents.close("a.ts", "editor-1").notifications).await;

            let symbols = server.request("textDocument/documentSymbol", json!({ "textDocument": { "uri": uri } }), None).await.unwrap();
            let report = server.request("textDocument/diagnostic", json!({ "textDocument": { "uri": uri } }), None).await.unwrap();
            (symbols, report)
        })
        .await
        .expect("tsgo answers within 30s");

        let names: Vec<&str> = result.0.as_array().unwrap().iter().map(|symbol| symbol["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["first", "second", "third"]);
        assert_eq!(result.1["items"], json!([]));
        server.stop().await;
    }

    #[test]
    fn a_new_server_gets_every_served_document_at_its_current_version() {
        let mut documents = documents();
        documents.open("a.ts", "main", "typescript", &read("a")).unwrap();
        documents.open("b.md", "main", "markdown", &read("b")).unwrap();
        documents.edit("a.ts", 1, vec![change((0, 1), (0, 1), "!")]).unwrap();
        let notifications = documents.open_notifications();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].1["textDocument"]["version"], 2);
        assert_eq!(notifications[0].1["textDocument"]["text"], "a!");
    }
}
