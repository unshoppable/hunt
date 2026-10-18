//! The two-way transcript stream of a remote session, between the local Claude Code project folder of its worktree and
//! the agent's on the VM (`transcript_channel`): the files the VM's agent writes (the session's transcript, its subagent
//! transcripts, tool results) arrive as they grow and are appended to a local mirror with their paths moved here, and
//! the files this Mac owns (the transcripts of the session's sub chats, which run here) go to the VM the same way. A
//! file is appended line by line, since a path is rewritten only in a complete line, and every offset is remembered
//! per side (`TranscriptState`, persisted), so a channel that reopens asks only for what is missing. A local mirror
//! that changed under the stream (the per-turn backup wrote it while no channel was open) is pulled from the start
//! again. Knows nothing about Tauri.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::transcript::{rewrite, Replacements};
use super::transcript_channel::Event;

/// The most bytes of one write to the VM.
const WRITE_CHUNK: usize = 1 << 20;
/// The folder of the repository memory, which the retrieval merges rather than the stream mirrors.
const MEMORY_FOLDER: &str = "memory";

/// What the stream holds of every file, persisted next to the file sync's manifest.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptState {
    /// The files of the VM's agent, by project-relative path.
    #[serde(default)]
    pub pulled: BTreeMap<String, Pulled>,
    /// The files this Mac owns, by project-relative path.
    #[serde(default)]
    pub pushed: BTreeMap<String, Pushed>,
}

/// A file of the VM's agent: the bytes of it consumed up to a line end, and the length of the local mirror they left.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pulled {
    pub consumed: u64,
    pub local_len: u64,
}

/// A file this Mac owns: the bytes of the local file sent, and the size of the VM's copy they left.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    pub sent: u64,
    pub remote_size: u64,
}

/// What applying a report of the helper asks for next.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    Done,
    /// The helper is to report the file at `path` from `offset` again.
    Read { path: String, offset: u64 },
}

/// One write to a file on the VM: `data` goes at `offset` of the VM's copy (replacing its content with `truncate`) and
/// covers the local file up to `sent_to`.
#[derive(Debug, PartialEq, Eq)]
pub struct Write {
    pub path: String,
    pub offset: u64,
    pub data: Vec<u8>,
    pub truncate: bool,
    pub sent_to: u64,
}

/// The stream state of one session.
pub struct TranscriptSync {
    state: TranscriptState,
    state_path: PathBuf,
    local_project: PathBuf,
    replacements: Replacements,
    /// Received bytes of the VM's files beyond `consumed` that do not end a line yet.
    pending: HashMap<String, Vec<u8>>,
}

impl TranscriptSync {
    /// The stream of the local project folder `local_project` with its state at `state_path`; a state that cannot be
    /// read starts over, which costs a full pull.
    pub fn load(state_path: PathBuf, local_project: PathBuf, replacements: Replacements) -> Self {
        let state = match std::fs::read(&state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                eprintln!("reading the transcript stream state {} failed: {error}", state_path.display());
                TranscriptState::default()
            }),
            Err(_) => TranscriptState::default(),
        };
        TranscriptSync { state, state_path, local_project, replacements, pending: HashMap::new() }
    }

    /// What the helper is told after the channel opened: per file of the VM the bytes consumed, and the paths this Mac
    /// owns. Bytes received without a line end are forgotten; the helper sends them again.
    pub fn sync_request(&mut self) -> (BTreeMap<String, u64>, Vec<String>) {
        self.pending.clear();
        let files = self.state.pulled.iter().map(|(path, pulled)| (path.clone(), pulled.consumed)).collect();
        let owned = self.state.pushed.keys().cloned().collect();
        (files, owned)
    }

    /// Applies one report of the helper to the local mirror; a file this Mac owns (`owned_ids` are the session ids of
    /// its transcripts) is ignored, since the helper only reports it before it learned the owned paths.
    pub fn apply(&mut self, event: Event, owned_ids: &HashSet<String>) -> Result<Applied, String> {
        match event {
            Event::File { path, offset, data, size } => {
                if is_owned(&path, owned_ids) {
                    return Ok(Applied::Done);
                }
                self.apply_file(path, offset, &data, size)
            }
            Event::Reset(path) | Event::Gone(path) => {
                if !is_owned(&path, owned_ids) {
                    self.forget_pulled(&path)?;
                }
                Ok(Applied::Done)
            }
            Event::Closed(_) => Ok(Applied::Done),
        }
    }

    fn apply_file(&mut self, path: String, offset: u64, data: &[u8], size: u64) -> Result<Applied, String> {
        let mut pulled = self.state.pulled.get(&path).copied().unwrap_or_default();
        let received = pulled.consumed + self.pending.get(&path).map_or(0, |pending| pending.len() as u64);
        if offset != received {
            self.pending.remove(&path);
            return Ok(Applied::Read { path, offset: pulled.consumed });
        }
        let local = self.local_project.join(&path);
        if file_len(&local)? != pulled.local_len {
            // Something else wrote the mirror (the per-turn backup): it is pulled from the start again.
            self.forget_pulled(&path)?;
            pulled = Pulled::default();
            if offset != 0 {
                return Ok(Applied::Read { path, offset: 0 });
            }
        }
        let pending = self.pending.entry(path.clone()).or_default();
        pending.extend_from_slice(data);
        let is_complete = offset + data.len() as u64 == size;
        let cut = if is_complete { pending.len() } else { pending.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1) };
        if cut == 0 {
            return Ok(Applied::Done);
        }
        let complete: Vec<u8> = pending.drain(..cut).collect();
        if pending.is_empty() {
            self.pending.remove(&path);
        }
        append(&local, &rewrite_bytes(complete, &self.replacements.to_local))?;
        self.state.pulled.insert(path, Pulled { consumed: pulled.consumed + cut as u64, local_len: file_len(&local)? });
        self.persist()
            .map(|()| Applied::Done)
    }

    /// Drops the local mirror of the VM's file at `path` and what the stream holds of it.
    fn forget_pulled(&mut self, path: &str) -> Result<(), String> {
        let local = self.local_project.join(path);
        if let Err(error) = std::fs::remove_file(&local) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("failed to delete the transcript mirror {}: {error}", local.display()));
            }
        }
        self.pending.remove(path);
        if self.state.pulled.remove(path).is_some() {
            self.persist()?;
        }
        Ok(())
    }

    /// The project-relative paths of every file below the local project folder that this Mac owns.
    pub fn owned_paths(&self, owned_ids: &HashSet<String>) -> Result<BTreeSet<String>, String> {
        let mut paths = BTreeSet::new();
        if self.local_project.is_dir() {
            walk(&self.local_project, "", &mut paths)?;
        }
        paths.retain(|path| is_owned(path, owned_ids));
        Ok(paths)
    }

    /// The next write that brings the VM's copy of the local file at `path` up to date: `None` when it is. A local file
    /// shorter than what was sent is sent from the start again, replacing the VM's copy.
    pub fn next_write(&self, path: &str) -> Result<Option<Write>, String> {
        let local = self.local_project.join(path);
        let len = file_len(&local)?;
        let pushed = self.state.pushed.get(path).copied().unwrap_or_default();
        let start = if len < pushed.sent { 0 } else { pushed.sent };
        if start == len && start != 0 {
            return Ok(None);
        }
        if len == 0 {
            return Ok(None);
        }
        let end = len.min(start + WRITE_CHUNK as u64);
        let chunk = read_range(&local, start, end)?;
        let is_tail = end == len;
        // A line longer than a chunk is sent as it is, in pieces.
        let cut = if is_tail { chunk.len() } else { chunk.iter().rposition(|byte| *byte == b'\n').map_or(chunk.len(), |at| at + 1) };
        let truncate = start == 0;
        Ok(Some(Write {
            path: path.to_string(),
            offset: if truncate { 0 } else { pushed.remote_size },
            data: rewrite_bytes(chunk[..cut].to_vec(), &self.replacements.to_remote),
            truncate,
            sent_to: start + cut as u64,
        }))
    }

    /// Records that the helper applied `write`, leaving the VM's copy `remote_size` bytes long.
    pub fn record_write(&mut self, write: &Write, remote_size: u64) -> Result<(), String> {
        self.state.pushed.insert(write.path.clone(), Pushed { sent: write.sent_to, remote_size });
        self.persist()
    }

    /// Forgets what was sent of the file at `path`, after the helper refused a write: the next write starts over.
    pub fn reset_push(&mut self, path: &str) -> Result<(), String> {
        if self.state.pushed.remove(path).is_some() {
            self.persist()?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.state).map_err(|error| format!("failed to write the transcript stream state: {error}"))?;
        if let Some(folder) = self.state_path.parent() {
            std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
        }
        let temporary = self.state_path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes)
            .and_then(|()| std::fs::rename(&temporary, &self.state_path))
            .map_err(|error| format!("failed to write the transcript stream state {}: {error}", self.state_path.display()))
    }
}

/// The session id a project-relative path belongs to: the stem of `<id>.jsonl`, the first folder of `<id>/…`.
pub fn owner_id(path: &str) -> &str {
    let first = path.split('/').next().unwrap_or(path);
    first.strip_suffix(".jsonl").unwrap_or(first)
}

/// Whether the file at the project-relative `path` belongs to one of the transcripts `owned_ids`.
pub fn is_owned(path: &str, owned_ids: &HashSet<String>) -> bool {
    owned_ids.contains(owner_id(path))
}

/// `bytes` with `replacements` applied when they are UTF-8 text; other bytes stay as they are.
fn rewrite_bytes(bytes: Vec<u8>, replacements: &[(String, String)]) -> Vec<u8> {
    match String::from_utf8(bytes) {
        Ok(text) => rewrite(&text, replacements).into_bytes(),
        Err(error) => error.into_bytes(),
    }
}

/// The length of the regular file at `path`; 0 when there is none.
fn file_len(path: &Path) -> Result<u64, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Ok(0),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!("failed to inspect {}: {error}", path.display())),
    }
}

/// Appends `data` to the file at `path`, creating it (readable by the owner only, as Claude Code keeps transcripts) and
/// its folders as needed.
fn append(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| format!("failed to create {}: {error}", folder.display()))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    file.write_all(data).map_err(|error| format!("failed to append to {}: {error}", path.display()))
}

/// The bytes `start..end` of the file at `path`.
fn read_range(path: &Path, start: u64, end: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(start)).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let mut bytes = Vec::with_capacity((end - start) as usize);
    file.take(end - start).read_to_end(&mut bytes).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    Ok(bytes)
}

/// Collects the project-relative paths of the regular files below `folder` (relative `prefix`), the memory left out.
fn walk(root: &Path, prefix: &str, paths: &mut BTreeSet<String>) -> Result<(), String> {
    let folder = root.join(prefix);
    let entries = std::fs::read_dir(&folder).map_err(|error| format!("failed to read {}: {error}", folder.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        if path == MEMORY_FOLDER {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            walk(root, &path, paths)?;
        } else if file_type.is_file() {
            paths.insert(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replacements() -> Replacements {
        Replacements::new(Path::new("/Users/jane/wt"), Path::new("/Users/jane/.claude"), "/home/agent/app")
    }

    fn stream(root: &Path) -> TranscriptSync {
        TranscriptSync::load(root.join("state.json"), root.join("project"), replacements())
    }

    fn file(path: &str, offset: u64, data: &str, size: u64) -> Event {
        Event::File { path: path.into(), offset, data: data.as_bytes().to_vec(), size }
    }

    #[test]
    fn owner_ids_come_from_the_first_segment() {
        assert_eq!(owner_id("abc.jsonl"), "abc");
        assert_eq!(owner_id("abc/subagents/agent-1.jsonl"), "abc");
        assert_eq!(owner_id("abc/tool-results/1.txt"), "abc");
        assert!(is_owned("abc.jsonl", &HashSet::from(["abc".to_string()])));
        assert!(!is_owned("abcd.jsonl", &HashSet::from(["abc".to_string()])));
    }

    #[test]
    fn pulled_lines_land_in_the_mirror_with_local_paths_once_complete() {
        let root = tempfile::tempdir().unwrap();
        let mut stream = stream(root.path());
        let none = HashSet::new();
        let line_1 = "{\"cwd\":\"/home/agent/app\"}\n";
        let line_2 = "{\"file\":\"/home/agent/.claude/projects/-home-agent-app/abc/tool-results/1.txt\"}\n";
        let size = (line_1.len() + line_2.len()) as u64;
        let (head, tail) = line_2.split_at(10);

        assert_eq!(stream.apply(file("abc.jsonl", 0, &format!("{line_1}{head}"), size), &none).unwrap(), Applied::Done);
        let mirror = root.path().join("project/abc.jsonl");
        assert_eq!(std::fs::read_to_string(&mirror).unwrap(), "{\"cwd\":\"/Users/jane/wt\"}\n");
        assert_eq!(stream.state.pulled["abc.jsonl"], Pulled { consumed: line_1.len() as u64, local_len: 25 });

        assert_eq!(stream.apply(file("abc.jsonl", (line_1.len() + head.len()) as u64, tail, size), &none).unwrap(), Applied::Done);
        let expected = "{\"cwd\":\"/Users/jane/wt\"}\n{\"file\":\"/Users/jane/.claude/projects/-Users-jane-wt/abc/tool-results/1.txt\"}\n";
        assert_eq!(std::fs::read_to_string(&mirror).unwrap(), expected);
        assert_eq!(stream.state.pulled["abc.jsonl"], Pulled { consumed: size, local_len: expected.len() as u64 });

        // A file read to its end is written whole, line end or not.
        assert_eq!(stream.apply(file("abc/tool-results/1.txt", 0, "see /home/agent/app/x", 21), &none).unwrap(), Applied::Done);
        assert_eq!(std::fs::read_to_string(root.path().join("project/abc/tool-results/1.txt")).unwrap(), "see /Users/jane/wt/x");

        // The state survives a reload, and the sync request names what was consumed.
        let mut reloaded = TranscriptSync::load(root.path().join("state.json"), root.path().join("project"), replacements());
        let (files, owned) = reloaded.sync_request();
        assert_eq!(files, BTreeMap::from([("abc.jsonl".to_string(), size), ("abc/tool-results/1.txt".to_string(), 21)]));
        assert!(owned.is_empty());
    }

    #[test]
    fn a_report_out_of_order_or_a_mirror_changed_underneath_asks_for_the_file_again() {
        let root = tempfile::tempdir().unwrap();
        let mut stream = stream(root.path());
        let none = HashSet::new();
        assert_eq!(stream.apply(file("abc.jsonl", 0, "{}\n", 6), &none).unwrap(), Applied::Done);
        assert_eq!(stream.apply(file("abc.jsonl", 5, "}\n", 6), &none).unwrap(), Applied::Read { path: "abc.jsonl".into(), offset: 3 });

        std::fs::write(root.path().join("project/abc.jsonl"), "{}\n{}\n{}\n").unwrap();
        assert_eq!(stream.apply(file("abc.jsonl", 3, "{}\n", 6), &none).unwrap(), Applied::Read { path: "abc.jsonl".into(), offset: 0 });
        assert!(!root.path().join("project/abc.jsonl").exists());
        assert_eq!(stream.apply(file("abc.jsonl", 0, "{}\n{}\n", 6), &none).unwrap(), Applied::Done);
        assert_eq!(std::fs::read_to_string(root.path().join("project/abc.jsonl")).unwrap(), "{}\n{}\n");

        // A reset or a gone file drops the mirror; a file this Mac owns is left alone.
        assert_eq!(stream.apply(Event::Reset("abc.jsonl".into()), &none).unwrap(), Applied::Done);
        assert!(!root.path().join("project/abc.jsonl").exists() && stream.state.pulled.is_empty());
        std::fs::write(root.path().join("project/sub.jsonl"), "mine\n").unwrap();
        let owned = HashSet::from(["sub".to_string()]);
        assert_eq!(stream.apply(file("sub.jsonl", 0, "theirs\n", 7), &owned).unwrap(), Applied::Done);
        assert_eq!(stream.apply(Event::Gone("sub.jsonl".into()), &owned).unwrap(), Applied::Done);
        assert_eq!(std::fs::read_to_string(root.path().join("project/sub.jsonl")).unwrap(), "mine\n");
    }

    #[test]
    fn pushed_writes_carry_complete_lines_with_remote_paths_and_follow_the_file() {
        let root = tempfile::tempdir().unwrap();
        let mut stream = stream(root.path());
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join("sub/tool-results")).unwrap();
        std::fs::create_dir_all(project.join("memory")).unwrap();
        std::fs::write(project.join("sub.jsonl"), "{\"cwd\":\"/Users/jane/wt\"}\n").unwrap();
        std::fs::write(project.join("sub/tool-results/1.txt"), "x").unwrap();
        std::fs::write(project.join("abc.jsonl"), "theirs\n").unwrap();
        std::fs::write(project.join("memory/MEMORY.md"), "m").unwrap();
        let owned = HashSet::from(["sub".to_string()]);
        assert_eq!(stream.owned_paths(&owned).unwrap(), BTreeSet::from(["sub.jsonl".to_string(), "sub/tool-results/1.txt".to_string()]));

        let write = stream.next_write("sub.jsonl").unwrap().unwrap();
        assert_eq!(write, Write { path: "sub.jsonl".into(), offset: 0, data: b"{\"cwd\":\"/home/agent/app\"}\n".to_vec(), truncate: true, sent_to: 25 });
        stream.record_write(&write, 26).unwrap();
        assert_eq!(stream.next_write("sub.jsonl").unwrap(), None);

        std::fs::OpenOptions::new().append(true).open(project.join("sub.jsonl")).unwrap().write_all(b"{\"a\":1}\n{\"b\"").unwrap();
        let write = stream.next_write("sub.jsonl").unwrap().unwrap();
        assert_eq!(write, Write { path: "sub.jsonl".into(), offset: 26, data: b"{\"a\":1}\n{\"b\"".to_vec(), truncate: false, sent_to: 37 });
        stream.record_write(&write, 38).unwrap();

        // A file that shrank goes from the start again, and a refused write starts over too.
        std::fs::write(project.join("sub.jsonl"), "{}\n").unwrap();
        assert_eq!(stream.next_write("sub.jsonl").unwrap().unwrap(), Write { path: "sub.jsonl".into(), offset: 0, data: b"{}\n".to_vec(), truncate: true, sent_to: 3 });
        stream.reset_push("sub.jsonl").unwrap();
        assert_eq!(stream.next_write("sub.jsonl").unwrap().unwrap().truncate, true);
        let (_, owned_paths) = stream.sync_request();
        assert!(owned_paths.is_empty());
    }
}
