//! Sessions handed off to a VM of their own: SSH through an IAP tunnel (`ssh.rs`) and the gcloud CLI (`gcloud.rs`), the
//! gateway the settings name (`gateway.rs`) and its API that lists, provisions, starts and deletes the session VMs
//! (`api.rs`), the VMs and the connection to a session's VM (`vm.rs`), where a handed-off session runs (`target.rs`),
//! the steps a remote operation reports (`progress.rs`), `hunt-ctl` on the VM (`hunt_ctl.rs`), the release check and
//! tool install on them (`release.rs`), moving a session's git state and Claude Code transcript there and back
//! (`handoff.rs`, `retrieve.rs`, `transcript.rs`, with the tar archives of `archive.rs`), streaming the transcripts and
//! the terminal logs both ways while the session is connected (`transcript_channel.rs`, `transcript_sync.rs`), reading
//! what a session's relay does while its VM runs (`status_channel.rs`), adopting session VMs no local session knows
//! (`adoption.rs`), keeping the files of the VM and the local worktree in sync (`sync.rs`), committing and pushing on
//! the VM for the changelist (`commit.rs`), previews (`preview.rs`) and terminals attached to the VM's tmux session
//! (`terminal.rs`). Knows nothing about Tauri; `session/commands/` owns the commands.

pub mod adoption;
pub mod api;
mod archive;
pub mod channel;
pub mod commit;
pub mod desktop;
mod gateway;
mod gcloud;
pub mod handoff;
mod hunt_ctl;
pub mod memory;
pub mod preview;
mod progress;
pub mod release;
pub mod retrieve;
pub mod ssh;
pub mod status_channel;
pub mod sync;
mod target;
pub mod terminal;
pub mod transcript;
pub mod transcript_channel;
pub mod transcript_sync;
pub mod vm;

pub use gateway::{gateway_vm, VmSettings};
pub use hunt_ctl::{hunt_ctl, hunt_ctl_with_input, local_token_input, relay_activity, relay_conversation, relay_stream_command, start_relay, token_input};
pub use progress::{Progress, RemoteStep, Reporter, StartSteps};
pub use target::{RelayActivity, RemoteOrigin, RemoteTarget};
pub use vm::{start_session_vm, VmRef};
