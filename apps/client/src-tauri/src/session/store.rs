//! Persistent list of Hunt sessions (`sessions.json` in the app data directory).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::git::DIFF_BASE;
use crate::github::{PullRequestRef, ReviewComment};
use crate::remote::adoption::AdoptableSession;
use crate::remote::{RemoteTarget, VmRef};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: Uuid,
    pub title: String,
    pub repo_path: PathBuf,
    pub worktree_path: PathBuf,
    pub branch: String,
    /// The ref the session was created from. Where its push lands is the upstream of `branch` (`push_target` in
    /// `session/commands.rs`), not this.
    pub base_ref: String,
    pub base_commit: String,
    pub acp_session_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Set for a sub chat: the session whose worktree this one shares and under which the UI lists it.
    #[serde(default)]
    pub parent_id: Option<Uuid>,
    /// The diff selection a sub chat was opened from; it is added to the agent's system prompt.
    #[serde(default)]
    pub selection: Option<SelectionContext>,
    /// Short bullet points of what happened in the session so far, maintained by the background summarizer.
    #[serde(default)]
    pub summary: Vec<String>,
    /// Worktree-relative paths whose uncommitted changes this session's tool calls produced. Sessions
    /// sharing a worktree use it to tell their changes apart; a path leaves the list once it is
    /// committed, shelved or reverted.
    #[serde(default)]
    pub touched_files: Vec<String>,
    /// When this session last changed files in its worktree: an agent edit, a save in a Hunt pane, or a
    /// revert, commit, shelve or unshelve. The component diagram counts as outdated once it predates this.
    #[serde(default)]
    pub worktree_changed_at: Option<chrono::DateTime<chrono::Utc>>,
    /// The pull request this session reviews, when it was started from one; sub sessions share their parent's.
    #[serde(default)]
    pub pull_request: Option<PullRequestRef>,
    /// Commit the changelist and the diffs compare the worktree against; `None` means `HEAD`. A pull request review
    /// sets it to the merge base of the pull request so its changes stay in the changelist.
    #[serde(default)]
    pub diff_base: Option<String>,
    /// Review comments drafted for the pull request and not yet submitted. They live on the top-level session;
    /// a sub session drafts into its parent's list.
    #[serde(default)]
    pub review_comments: Vec<ReviewComment>,
    /// Where the session works: in a worktree Hunt created and owns, or in the repository's own checkout.
    #[serde(default)]
    pub workspace: Workspace,
    /// Set when the session's worktree works on a branch that existed before the session (the local branch of a
    /// reviewed pull request), which deleting the session keeps; otherwise Hunt created the branch and deletes it with
    /// the worktree.
    #[serde(default)]
    pub keeps_branch: bool,
    /// Set while the session is handed off to a VM: its agent runs there, and the local worktree waits unchanged
    /// for the session to be retrieved.
    #[serde(default)]
    pub remote: Option<RemoteTarget>,
    /// The session VM a failed handoff left behind; also set while a handoff runs. The next handoff reuses it and
    /// deleting the session deletes it.
    #[serde(default)]
    pub leftover_vm: Option<VmRef>,
}

/// Where a session works. `Worktree` is a worktree Hunt creates and deletes with the session, on a new
/// `feat/general/<slug>-<id>` branch off the base branch or, for a pull request review, on the pull request's branch;
/// `Checkout` is the repository's own checkout on whatever branch it has, which Hunt leaves alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Workspace {
    #[default]
    Worktree,
    Checkout,
}

impl SessionRecord {
    /// The ref the changelist and the diffs compare the worktree against.
    pub fn diff_base(&self) -> &str {
        self.diff_base.as_deref().unwrap_or(DIFF_BASE)
    }

    /// A fresh top-level session in the worktree `worktree_path`, checked out on `branch` at `base_commit` of
    /// `base_ref`; nothing has happened in it yet.
    pub fn new(
        id: Uuid,
        title: String,
        repo_path: PathBuf,
        worktree_path: PathBuf,
        branch: String,
        base_ref: String,
        base_commit: String,
    ) -> Self {
        Self {
            id,
            title,
            repo_path,
            worktree_path,
            branch,
            base_ref,
            base_commit,
            acp_session_id: None,
            created_at: chrono::Utc::now(),
            parent_id: None,
            selection: None,
            summary: Vec::new(),
            touched_files: Vec::new(),
            worktree_changed_at: None,
            pull_request: None,
            diff_base: None,
            review_comments: Vec::new(),
            workspace: Workspace::Worktree,
            keeps_branch: false,
            remote: None,
            leftover_vm: None,
        }
    }

    /// A remote session this Mac adopts from the listing of its VM: its agent runs there and nothing of it exists here
    /// yet. `repo_path` is the local checkout of its repository (empty without one), `worktree_path` where bringing it
    /// back creates its worktree; the VM's preview URLs use `preview_domain`. Its worktree path on the VM is filled in
    /// once Hunt reaches the VM.
    pub fn adopted(session: &AdoptableSession, repo_path: PathBuf, worktree_path: PathBuf, preview_domain: String) -> Self {
        let now = chrono::Utc::now();
        let target = RemoteTarget {
            vm: session.vm.clone(),
            worktree_path: PathBuf::new(),
            repo: session.repo.clone(),
            branch: session.branch.clone(),
            handoff_head: String::new(),
            handed_off_at: now,
            local_mode: None,
            last_active_at: None,
            cleanup_asked_at: None,
            preview_domain: Some(preview_domain),
            origin: session.origin,
            issue: session.issue,
            agent: session.agent.clone(),
            push_target_pending: false,
            relay_activity: None,
        };
        let branch = session.branch.clone();
        let mut record = Self::new(session.id, session.title.clone(), repo_path, worktree_path, branch.clone(), branch, String::new());
        record.created_at = session.created_at.unwrap_or(now);
        record.remote = Some(target);
        record
    }

    /// A fresh sub chat of `parent`: it shares the parent's repository, worktree and branch and carries the
    /// `selection` it was opened from. Sub chats of sub chats would nest without end, so the record is attached
    /// to the top-level session.
    pub fn sub_session(id: Uuid, title: String, parent: &SessionRecord, selection: Option<SelectionContext>) -> Self {
        let mut record = Self::new(
            id,
            title,
            parent.repo_path.clone(),
            parent.worktree_path.clone(),
            parent.branch.clone(),
            parent.base_ref.clone(),
            parent.base_commit.clone(),
        );
        record.parent_id = Some(parent.parent_id.unwrap_or(parent.id));
        record.selection = selection;
        record.pull_request = parent.pull_request.clone();
        record.diff_base = parent.diff_base.clone();
        record.workspace = parent.workspace;
        record.keeps_branch = parent.keeps_branch;
        record
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionContext {
    /// Worktree-relative path of the file the text was selected in.
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    /// What the sub chat is for when it was not opened from a code selection, e.g. writing the file's content;
    /// replaces the default framing of the system prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

impl SelectionContext {
    /// System prompt section that puts the selected lines into the agent's context or, with a task, states the task;
    /// the file's current content then comes with every prompt (see `send_prompt`) rather than as a snapshot here.
    pub fn to_system_prompt(&self) -> String {
        match &self.task {
            Some(task) => format!(
                "\n## Task\n{}\n\nEvery message of the user carries the current content of `{}` as a context block, as long as the file exists.\n",
                task, self.path
            ),
            None => format!(
                "\n## Selected code\nThe user opened this chat from a selection in `{}` (lines {}-{}, current working-tree version). \
Questions refer to this selection unless stated otherwise.\n```\n{}\n```\n",
                self.path, self.start_line, self.end_line, self.text
            ),
        }
    }
}

/// Tells every window that the stored sessions changed in a way the sidebar must reload: a session was added or
/// removed, or its title or state changed.
pub fn announce_sessions_changed(app: &AppHandle) {
    let _ = app.emit("sessions:changed", ());
    crate::session::related::refresh_all(app);
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

pub fn worktrees_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("worktrees");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("sessions.json"))
}

/// Points every worktree below `from` stored in the `sessions.json` of `data_dir` to the same place below `to`, after
/// the folder moved there.
pub fn relocate_worktrees(data_dir: &Path, from: &Path, to: &Path) -> Result<(), String> {
    let store = Store::at(data_dir.join("sessions.json"));
    let mut sessions = store.load()?;
    let mut changed = false;
    for session in &mut sessions {
        let Ok(rest) = session.worktree_path.strip_prefix(from) else { continue };
        session.worktree_path = to.join(rest);
        changed = true;
    }
    if changed {
        store.save(&sessions)?;
    }
    Ok(())
}

/// Serializes every read and read-modify-write cycle on `sessions.json`; commands and the background summarizer share the file.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Exclusive access to `sessions.json` for as long as the handle lives: every read goes through it, so a reader
/// never sees a half-written list and a read-modify-write cycle never races another one.
struct Store {
    path: PathBuf,
    _guard: MutexGuard<'static, ()>,
}

impl Store {
    /// Locks the store of the app; released when the handle is dropped. Never hold two handles at once.
    fn open(app: &AppHandle) -> Result<Self, String> {
        Ok(Self::at(store_path(app)?))
    }

    /// Locks the store kept in the file `path`.
    fn at(path: PathBuf) -> Self {
        // The guarded state is `()`, so a panic while holding the lock leaves nothing inconsistent behind.
        Self { path, _guard: STORE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner) }
    }

    /// Every stored record; an absent file counts as an empty list.
    fn load(&self) -> Result<Vec<SessionRecord>, String> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(&self.path).map_err(|error| format!("failed to read sessions.json: {error}"))?;
        serde_json::from_str(&content).map_err(|error| format!("sessions.json is corrupt: {error}"))
    }

    /// Replaces the stored list atomically: the content goes to a sibling temp file that is renamed over the target,
    /// so a crash mid-write leaves the previous list intact.
    fn save(&self, sessions: &[SessionRecord]) -> Result<(), String> {
        let content = serde_json::to_string_pretty(sessions).map_err(|error| error.to_string())?;
        let temp_path = self.path.with_extension("json.tmp");
        std::fs::write(&temp_path, content).map_err(|error| format!("failed to write {}: {error}", temp_path.display()))?;
        std::fs::rename(&temp_path, &self.path).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            format!("failed to replace sessions.json: {error}")
        })
    }

    fn find(&self, id: Uuid) -> Result<SessionRecord, String> {
        self.load()?.into_iter().find(|session| session.id == id).ok_or_else(|| format!("unknown session {id}"))
    }

    /// Stores `record` unless a record of its id exists; returns whether it did.
    fn insert(&self, record: SessionRecord) -> Result<bool, String> {
        let mut sessions = self.load()?;
        if sessions.iter().any(|session| session.id == record.id) {
            return Ok(false);
        }
        sessions.push(record);
        self.save(&sessions)?;
        Ok(true)
    }

    fn upsert(&self, record: SessionRecord) -> Result<(), String> {
        let mut sessions = self.load()?;
        match sessions.iter_mut().find(|session| session.id == record.id) {
            Some(existing) => {
                *existing = record;
            }
            None => sessions.push(record),
        }
        self.save(&sessions)
    }

    /// Applies `update` to the record of `id` and returns the result; `None` when the session no longer exists.
    fn update(&self, id: Uuid, update: impl FnOnce(&mut SessionRecord)) -> Result<Option<SessionRecord>, String> {
        let mut sessions = self.load()?;
        let Some(record) = sessions.iter_mut().find(|session| session.id == id) else {
            return Ok(None);
        };
        update(record);
        let updated = record.clone();
        self.save(&sessions)?;
        Ok(Some(updated))
    }

    fn remove(&self, id: Uuid) -> Result<(), String> {
        let sessions: Vec<SessionRecord> = self.load()?.into_iter().filter(|session| session.id != id).collect();
        self.save(&sessions)
    }

    /// Moves every remote session on the VM `from` to the VM `to` (the owner's record and its sub sessions share the
    /// VM); returns how many records changed, and saves nothing when none did.
    fn replace_remote_vm(&self, from: &VmRef, to: &VmRef) -> Result<usize, String> {
        let mut sessions = self.load()?;
        let mut changed = 0;
        for target in sessions.iter_mut().filter_map(|session| session.remote.as_mut()) {
            if target.vm != *from {
                continue;
            }
            target.vm = to.clone();
            changed += 1;
        }
        if changed > 0 {
            self.save(&sessions)?;
        }
        Ok(changed)
    }
}

pub fn load_sessions(app: &AppHandle) -> Result<Vec<SessionRecord>, String> {
    Store::open(app)?.load()
}

pub fn find_session(app: &AppHandle, id: Uuid) -> Result<SessionRecord, String> {
    Store::open(app)?.find(id)
}

/// The ACP session ids of the sub chats of `id`, whose transcripts live in the local project folder of its worktree.
pub fn sub_chat_acp_ids(app: &AppHandle, id: Uuid) -> Result<Vec<String>, String> {
    Ok(load_sessions(app)?.into_iter().filter(|session| session.parent_id == Some(id)).filter_map(|session| session.acp_session_id).collect())
}

pub fn upsert_session(app: &AppHandle, record: SessionRecord) -> Result<(), String> {
    Store::open(app)?.upsert(record)
}

/// Stores `record` unless a session of its id exists; returns whether it did.
pub fn insert_session(app: &AppHandle, record: SessionRecord) -> Result<bool, String> {
    Store::open(app)?.insert(record)
}

/// Applies `update` to the stored record of `id` and returns the result; `None` when the session no longer exists.
pub fn update_session(app: &AppHandle, id: Uuid, update: impl FnOnce(&mut SessionRecord)) -> Result<Option<SessionRecord>, String> {
    Store::open(app)?.update(id, update)
}

/// Adds `paths` to the touched files of `id`; paths already listed are kept once.
pub fn add_touched_files(app: &AppHandle, id: Uuid, paths: &[String]) -> Result<(), String> {
    update_session(app, id, |record| {
        for path in paths {
            if record.touched_files.contains(path) {
                continue;
            }
            record.touched_files.push(path.clone());
        }
    })?;
    Ok(())
}

/// Removes `paths` from the touched files of every session that works in `worktree`.
pub fn forget_touched_files(app: &AppHandle, worktree: &Path, paths: &[String]) -> Result<(), String> {
    let store = Store::open(app)?;
    let mut sessions = store.load()?;
    for session in sessions.iter_mut().filter(|session| session.worktree_path == worktree) {
        session.touched_files.retain(|path| !paths.contains(path));
    }
    store.save(&sessions)
}

/// Records that `id` changed files in its worktree just now, which its family's `.hunt/sessions.md` then lists.
pub fn note_worktree_changed(app: &AppHandle, id: Uuid) -> Result<(), String> {
    update_session(app, id, |record| record.worktree_changed_at = Some(chrono::Utc::now()))?;
    crate::session::related::refresh_family(app, id);
    Ok(())
}

/// The latest time any session working in `worktree` changed its files; `None` while none did.
pub fn worktree_changed_at(app: &AppHandle, worktree: &Path) -> Result<Option<chrono::DateTime<chrono::Utc>>, String> {
    Ok(load_sessions(app)?
        .into_iter()
        .filter(|session| session.worktree_path == worktree)
        .filter_map(|session| session.worktree_changed_at)
        .max())
}

/// Sessions that touched each path in `worktree`, keyed by path.
pub fn touched_by(app: &AppHandle, worktree: &Path) -> Result<HashMap<String, Vec<Uuid>>, String> {
    let mut result: HashMap<String, Vec<Uuid>> = HashMap::new();
    for session in load_sessions(app)?.into_iter().filter(|session| session.worktree_path == worktree) {
        for path in session.touched_files {
            result.entry(path).or_default().push(session.id);
        }
    }
    Ok(result)
}

pub fn remove_session(app: &AppHandle, id: Uuid) -> Result<(), String> {
    Store::open(app)?.remove(id)
}

/// Moves every stored remote session on the VM `from` to the VM `to`, as the gateway did when it moved the VM to
/// another zone; returns how many records changed.
pub fn replace_remote_vm(app: &AppHandle, from: &VmRef, to: &VmRef) -> Result<usize, String> {
    Store::open(app)?.replace_remote_vm(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(title: &str) -> SessionRecord {
        let id = Uuid::new_v4();
        let worktree = format!("/worktrees/{id}").into();
        SessionRecord::new(id, title.into(), "/repo".into(), worktree, "feat/general/x".into(), "main".into(), "abc".into())
    }

    fn store_in(dir: &tempfile::TempDir) -> Store {
        Store::at(dir.path().join("sessions.json"))
    }

    #[test]
    fn loading_a_missing_file_yields_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        assert!(store.load().unwrap().is_empty());
        assert!(store.find(Uuid::new_v4()).is_err());
    }

    #[test]
    fn save_and_load_round_trip_without_leaving_a_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let first = record("first");
        let second = record("second");
        store.save(&[first.clone(), second.clone()]).unwrap();

        let loaded = store.load().unwrap();
        let ids: Vec<Uuid> = loaded.iter().map(|session| session.id).collect();
        assert_eq!(ids, vec![first.id, second.id]);
        assert_eq!(loaded[1].title, "second");
        assert_eq!(loaded[0].worktree_path, first.worktree_path);
        assert!(dir.path().join("sessions.json").is_file());
        assert!(!dir.path().join("sessions.json.tmp").exists());
    }

    #[test]
    fn update_changes_one_record_and_preserves_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let first = record("first");
        let second = record("second");
        store.upsert(first.clone()).unwrap();
        store.upsert(second.clone()).unwrap();

        let updated = store.update(second.id, |session| session.title = "renamed".into()).unwrap().unwrap();
        assert_eq!(updated.title, "renamed");
        assert_eq!(store.update(Uuid::new_v4(), |_| unreachable!()).unwrap().map(|session| session.id), None);

        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].title, "first");
        assert_eq!(loaded[1].title, "renamed");
        assert!(!dir.path().join("sessions.json.tmp").exists());
    }

    #[test]
    fn replace_remote_vm_moves_the_owner_and_its_sub_sessions_and_leaves_other_vms_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let vm = |zone: &str, instance: &str| VmRef { project: "acme-hunt".into(), zone: zone.into(), instance: instance.into() };
        let target = |vm: VmRef| RemoteTarget {
            vm,
            worktree_path: "/home/agent/app".into(),
            repo: "acme/app".into(),
            branch: "feat/general/x".into(),
            handoff_head: "abc".into(),
            handed_off_at: chrono::Utc::now(),
            local_mode: None,
            last_active_at: None,
            cleanup_asked_at: None,
            preview_domain: None,
            origin: crate::remote::RemoteOrigin::Handoff,
            issue: None,
            agent: String::new(),
            push_target_pending: false,
            relay_activity: None,
        };
        let (old, new) = (vm("europe-west1-c", "vm-hunt-s-ab12cd34"), vm("europe-west1-b", "vm-hunt-s-ab12cd34"));
        let mut owner = record("owner");
        owner.remote = Some(target(old.clone()));
        let mut sub = SessionRecord::sub_session(Uuid::new_v4(), "sub".into(), &owner, None);
        sub.remote = Some(target(old.clone()));
        let mut other = record("other");
        other.remote = Some(target(vm("europe-west1-c", "vm-hunt-s-ffffffff")));
        store.save(&[owner.clone(), sub.clone(), other.clone(), record("local")]).unwrap();

        assert_eq!(store.replace_remote_vm(&old, &new).unwrap(), 2);
        let loaded = store.load().unwrap();
        let vms: Vec<Option<&VmRef>> = loaded.iter().map(|session| session.remote.as_ref().map(|target| &target.vm)).collect();
        assert_eq!(vms, vec![Some(&new), Some(&new), Some(&other.remote.as_ref().unwrap().vm), None]);
        assert_eq!(loaded[1].parent_id, Some(owner.id));
        assert_eq!(store.replace_remote_vm(&old, &new).unwrap(), 0);
    }

    #[test]
    fn a_record_stored_before_remote_sessions_existed_loads_as_local() {
        let dir = tempfile::tempdir().unwrap();
        let mut stored = serde_json::to_value(record("old")).unwrap();
        stored.as_object_mut().unwrap().remove("remote");
        std::fs::write(dir.path().join("sessions.json"), serde_json::to_vec(&vec![stored]).unwrap()).unwrap();

        let loaded = store_in(&dir).load().unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].remote.is_none());
    }

    #[test]
    fn a_record_handed_off_to_the_shared_vm_loads_without_preview_domain_and_leftover_vm() {
        let dir = tempfile::tempdir().unwrap();
        let mut stored = serde_json::to_value(record("old")).unwrap();
        let object = stored.as_object_mut().unwrap();
        object.remove("leftoverVm");
        object.remove("keepsBranch");
        object.insert(
            "remote".into(),
            serde_json::json!({
                "vm": {"project": "acme", "zone": "europe-west1-c", "instance": "vm-hunt-medc"},
                "worktreePath": "/srv/worktrees/x", "repo": "acme/app", "branch": "hunt/x", "handoffHead": "abc",
                "handedOffAt": "2026-10-01T10:00:00Z"
            }),
        );
        std::fs::write(dir.path().join("sessions.json"), serde_json::to_vec(&vec![stored]).unwrap()).unwrap();

        let loaded = store_in(&dir).load().unwrap();
        let remote = loaded[0].remote.as_ref().unwrap();
        assert_eq!((remote.vm.instance.as_str(), remote.preview_domain.as_deref(), remote.local_mode.as_deref()), ("vm-hunt-medc", None, None));
        assert!(loaded[0].leftover_vm.is_none());
        // Every older worktree session works on a branch Hunt created, which deleting it deletes as before.
        assert!(!loaded[0].keeps_branch);
    }

    #[test]
    fn insert_keeps_an_existing_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let first = record("first");
        assert!(store.insert(first.clone()).unwrap());
        let mut renamed = first.clone();
        renamed.title = "renamed".into();
        assert!(!store.insert(renamed).unwrap());
        assert_eq!(store.load().unwrap().iter().map(|session| session.title.as_str()).collect::<Vec<_>>(), ["first"]);
    }

    #[test]
    fn an_adopted_record_runs_remotely_without_a_local_worktree_yet() {
        let session = AdoptableSession {
            id: Uuid::parse_str("ab12cd34-0000-4000-8000-000000000001").unwrap(),
            vm: VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() },
            title: "Fix login".into(),
            repo: "acme/app".into(),
            branch: "fix/general/123-fix-login".into(),
            origin: crate::remote::RemoteOrigin::Swf,
            owner: String::new(),
            issue: Some(123),
            status: "TERMINATED".into(),
            is_running: false,
            created_at: chrono::DateTime::from_timestamp(1_760_000_000, 0),
            agent: "question".into(),
        };
        let adopted = SessionRecord::adopted(&session, PathBuf::new(), "/worktrees/ab12cd34".into(), "hunt.example.com".into());
        let remote = adopted.remote.as_ref().unwrap();
        assert!(remote.is_adopted() && remote.worktree_path.as_os_str().is_empty() && remote.handoff_head.is_empty());
        assert_eq!((remote.issue, remote.preview_domain.as_deref()), (Some(123), Some("hunt.example.com")));
        assert_eq!(remote.agent, "question");
        assert_eq!((remote.branch.as_str(), adopted.branch.as_str()), ("fix/general/123-fix-login", "fix/general/123-fix-login"));
        assert_eq!((adopted.title.as_str(), adopted.created_at), ("Fix login", session.created_at.unwrap()));
        assert!(adopted.repo_path.as_os_str().is_empty() && adopted.acp_session_id.is_none());

        // Records stored before adoptions existed were handed off by this Mac.
        let mut stored = serde_json::to_value(&adopted).unwrap();
        let object = stored["remote"].as_object_mut().unwrap();
        object.remove("origin");
        object.remove("issue");
        object.remove("agent");
        let loaded: SessionRecord = serde_json::from_value(stored).unwrap();
        let remote = loaded.remote.unwrap();
        assert!(!remote.is_adopted() && remote.agent.is_empty());
    }

    #[test]
    fn upsert_replaces_an_existing_record_and_remove_drops_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let mut first = record("first");
        let second = record("second");
        store.upsert(first.clone()).unwrap();
        store.upsert(second.clone()).unwrap();

        first.acp_session_id = Some("acp-1".into());
        store.upsert(first.clone()).unwrap();
        assert_eq!(store.find(first.id).unwrap().acp_session_id.as_deref(), Some("acp-1"));
        assert_eq!(store.load().unwrap().len(), 2);

        store.remove(first.id).unwrap();
        let remaining: Vec<Uuid> = store.load().unwrap().iter().map(|session| session.id).collect();
        assert_eq!(remaining, vec![second.id]);
    }
}
