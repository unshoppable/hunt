//! Where a session handed off to a VM runs (`RemoteTarget`): its VM, worktree and branch there, who started it on the VM
//! and what its relay last reported.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::retrieve;
use super::vm::VmRef;

/// Where a session handed off to a VM runs, and what Hunt needs to reach it and to bring it back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    /// The session's own VM, `vm-hunt-s-<short>`; older handoffs name the VM all sessions shared.
    pub vm: VmRef,
    /// The session's worktree on the VM.
    pub worktree_path: PathBuf,
    /// `<owner>/<repo>` of the bare repository on the VM that holds the session's branch.
    pub repo: String,
    /// The branch the local worktree has checked out and the VM's commit it points to: the one of the handoff, or the
    /// last one Hunt made on the VM (`commit.rs`); the retrieval moves that branch from this commit to the one the agent
    /// left on the VM.
    pub branch: String,
    pub handoff_head: String,
    pub handed_off_at: chrono::DateTime<chrono::Utc>,
    /// The permission mode the session had locally. The agent on the VM runs in `bypassPermissions`, which a local
    /// agent would take over from the transcript, so the retrieval sets this mode again; `None` falls back to `auto`.
    #[serde(default)]
    pub local_mode: Option<String>,
    /// When the agent last worked on the session: a prompt Hunt sent or a turn that ended; `None` until the first one
    /// after the handoff.
    #[serde(default)]
    pub last_active_at: Option<chrono::DateTime<chrono::Utc>>,
    /// When Hunt last asked whether to retrieve or delete the idle session and the user chose to wait.
    #[serde(default)]
    pub cleanup_asked_at: Option<chrono::DateTime<chrono::Utc>>,
    /// The domain the session's preview URLs were set up with at the handoff; `None` for older handoffs.
    #[serde(default)]
    pub preview_domain: Option<String>,
    /// Who started the session on its VM: this Mac, or someone else whose VM this Mac adopted.
    #[serde(default)]
    pub origin: RemoteOrigin,
    /// The GitHub issue a `swf` session works on.
    #[serde(default)]
    pub issue: Option<u64>,
    /// The state of the session's agent as the gateway recorded it: the step of the poller's pipeline (`plan`,
    /// `implement`, `verify`, `gate`, `pr`, `review`, `human-review`, `merge`), `question` (waits for an answer), `done`
    /// or `failed`; empty when unknown.
    #[serde(default)]
    pub agent: String,
    /// The push target the local branch tracks is not yet recorded in the VM's worktree, which Hunt could not reach when
    /// the target changed; the next connect writes it there instead of taking the VM's over.
    #[serde(default)]
    pub push_target_pending: bool,
    /// What the session's relay last reported through the status channel while its VM ran (`session::relay_watch`);
    /// `None` before the first report.
    #[serde(default)]
    pub relay_activity: Option<RelayActivity>,
}

impl RemoteTarget {
    /// The permission mode the session gets back locally: its mode before the handoff, else `auto`, the mode new
    /// sessions start in.
    pub fn restored_mode(&self) -> &str {
        self.local_mode.as_deref().unwrap_or("auto")
    }

    /// Whether this Mac adopted the session from a VM listing instead of handing it off: there is no local worktree
    /// waiting for it, and other people may work on it too.
    pub fn is_adopted(&self) -> bool {
        self.origin != RemoteOrigin::Handoff
    }

    /// The ref of the snapshot the local worktree of session `id` and its VM started from, which its first sync compares
    /// against: the handoff's, or for an adopted session the one its local worktree was created from.
    pub fn start_ref(&self, id: uuid::Uuid) -> String {
        if self.is_adopted() {
            retrieve::adopted_ref(id)
        } else {
            format!("refs/hunt/{id}/handoff")
        }
    }
}

/// What the relay of a remote session last reported through the status channel (`status_channel.rs`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayActivity {
    /// Whether the agent runs a turn.
    pub is_turn_running: bool,
    /// Whether the agent waits for the user's answer to a question; `None` for an older relay that does not say.
    pub is_question: Option<bool>,
}

/// Who started a remote session on its VM.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteOrigin {
    /// This Mac handed the session off; its local worktree waits for the retrieval.
    #[default]
    Handoff,
    /// Another person's Hunt handed it off (VM label `hunt-origin=desktop`).
    Desktop,
    /// The gateway's poller started it for a GitHub issue labelled `swf` (VM label `hunt-origin=swf`).
    Swf,
}

impl RemoteOrigin {
    /// Whether the session's relay keeps the tokens stored on its VM over this Mac's: a poller session runs with the
    /// poller's tokens from Secret Manager, so that everything its agent does on GitHub happens as the poller, and takes
    /// this Mac's only where its VM stores none. Hunt's push of such a session runs on the VM with the stored token too
    /// (`hunt-ctl push --stored`); any other session's branch is pushed from this Mac.
    pub fn keeps_vm_tokens(self) -> bool {
        self == RemoteOrigin::Swf
    }

    /// The arguments after the session id of `hunt-ctl start` and `clear` for a session of this origin: `--keep-stored`
    /// makes the relay keep the tokens its VM stores and take those on stdin only where it stores none.
    pub fn relay_token_args(self) -> &'static [&'static str] {
        if self.keeps_vm_tokens() {
            &["--keep-stored"]
        } else {
            &[]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_poller_session_keeps_the_tokens_of_its_vm() {
        assert!(RemoteOrigin::Swf.keeps_vm_tokens());
        assert!(!RemoteOrigin::Handoff.keeps_vm_tokens());
        assert!(!RemoteOrigin::Desktop.keeps_vm_tokens());
        assert_eq!(RemoteOrigin::Swf.relay_token_args(), ["--keep-stored"]);
        assert_eq!(RemoteOrigin::Handoff.relay_token_args(), [] as [&str; 0]);
    }
}
