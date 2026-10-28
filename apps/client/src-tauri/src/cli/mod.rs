//! `hunt`, the command line for Hunt's sessions that works without the app (binary `hunt-cli`, which Settings links as
//! `~/.local/bin/hunt`): lists the sessions (`sessions.rs`), starts, stops and opens a shell on the VM of a remote
//! session (`vm.rs`) and chats with its agent through the session's relay (`attach.rs`), next to Hunt if it runs. It
//! reads the app's `sessions.json` and `accounts.json` but never writes them; the app's lock holds only within the
//! app. Data goes to stdout, progress and errors to stderr; a usage error exits with 2, any other failure with 1.

mod attach;
mod sessions;
mod vm;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::remote::{RemoteStep, RemoteTarget, Reporter};
use crate::session::session_id::SessionId;
use crate::session::store::{self, SessionRecord};

/// The bundle identifier of the app (`tauri.conf.json`), which names its data folder.
const IDENTIFIER: &str = "info.medconomy.hunt";

/// The shortest start of a session ID that names a session.
const MIN_ID_PREFIX: usize = 4;

#[derive(Parser)]
#[command(name = "hunt", bin_name = "hunt", version, about = "Hunt's sessions and their VMs from the terminal; works without the Hunt app")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List the sessions, oldest first, each sub chat below its session
    Sessions {
        /// Print the stored sessions as JSON
        #[arg(long)]
        json: bool,
    },
    /// Start or stop the VM of a remote session, or open a shell on it
    Vm {
        #[command(subcommand)]
        command: VmCommand,
    },
    /// Chat with the agent of a remote session; Hunt may stay connected meanwhile
    Attach {
        /// The session's ID or the start of it (at least 4 characters)
        session: String,
    },
}

#[derive(Subcommand)]
enum VmCommand {
    /// Start the session's VM unless it runs
    Start {
        /// The session's ID or the start of it (at least 4 characters)
        session: String,
    },
    /// Stop the session's VM; refuses while its agent works
    Stop {
        /// The session's ID or the start of it (at least 4 characters)
        session: String,
        /// Stop it even while the agent works
        #[arg(long)]
        force: bool,
    },
    /// Open a shell on the session's VM, as a window of the agent's tmux session `app`, which Hunt's Terminal tab shows
    Ssh {
        /// The session's ID or the start of it (at least 4 characters)
        session: String,
    },
}

/// Runs `hunt` with the arguments of the process.
pub fn main() -> ExitCode {
    let arguments = Arguments::parse();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("hunt: failed to start: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(arguments.command)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("hunt: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(command: Command) -> Result<(), String> {
    let data_dir = app_data_dir()?;
    match command {
        Command::Sessions { json } => sessions::list(&data_dir, json),
        Command::Vm { command: VmCommand::Start { session } } => vm::start(&remote_session(&data_dir, &session)?).await,
        Command::Vm { command: VmCommand::Stop { session, force } } => vm::stop(&remote_session(&data_dir, &session)?, force).await,
        Command::Vm { command: VmCommand::Ssh { session } } => vm::shell(&remote_session(&data_dir, &session)?).await,
        Command::Attach { session } => attach::attach(&data_dir, &remote_session(&data_dir, &session)?).await,
    }
}

/// The app's data folder, where Tauri's `app_data_dir` puts it on macOS; the debug and the release build share it.
fn app_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("failed to find Hunt's data: HOME is not set")?;
    Ok(PathBuf::from(home).join("Library/Application Support").join(IDENTIFIER))
}

/// A session handed off to a VM.
pub struct RemoteSession {
    pub record: SessionRecord,
    pub target: RemoteTarget,
}

impl RemoteSession {
    /// The first 8 hex digits of the session's ID, as `hunt sessions` shows them.
    fn short_id(&self) -> String {
        SessionId(self.record.id).short()
    }
}

/// The stored session `argument` names, which must run on a VM.
fn remote_session(data_dir: &Path, argument: &str) -> Result<RemoteSession, String> {
    let record = find_session(store::read_sessions(data_dir)?, argument)?;
    let Some(target) = record.remote.clone() else {
        return Err(format!("the session {} runs on this Mac; hunt reaches only sessions on a VM", SessionId(record.id).short()));
    };
    Ok(RemoteSession { record, target })
}

/// The session among `sessions` that `argument` names: by its ID, or by the start of it of at least `MIN_ID_PREFIX`
/// characters (with or without dashes, in any case) that no other session's ID starts with.
fn find_session(sessions: Vec<SessionRecord>, argument: &str) -> Result<SessionRecord, String> {
    let prefix: String = argument.chars().filter(|character| *character != '-').collect::<String>().to_lowercase();
    if prefix.len() < MIN_ID_PREFIX || !prefix.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(format!("{argument:?} names no session: give its ID or at least its first {MIN_ID_PREFIX} hex digits (hunt sessions)"));
    }
    let mut matching: Vec<SessionRecord> = sessions.into_iter().filter(|session| session.id.simple().to_string().starts_with(&prefix)).collect();
    match matching.len() {
        0 => Err(format!("no session starts with {argument} (hunt sessions)")),
        1 => Ok(matching.remove(0)),
        _ => {
            let ids: Vec<String> = matching.iter().map(|session| session.id.to_string()).collect();
            Err(format!("{argument} names several sessions, give more of the ID: {}", ids.join(", ")))
        }
    }
}

/// Reports the steps of a remote operation on stderr.
struct StderrProgress;

impl Reporter for StderrProgress {
    fn step(&self, step: RemoteStep) {
        if let Some(text) = step_text(step) {
            eprintln!("{text}…");
        }
    }

    fn log(&self, message: &str) {
        eprintln!("  {message}");
    }
}

/// What the terminal says while `step` runs; `None` for the steps it leaves out.
fn step_text(step: RemoteStep) -> Option<&'static str> {
    match step {
        RemoteStep::StartingVm => Some("starting the VM"),
        RemoteStep::ResumingVm => Some("resuming the VM"),
        RemoteStep::MovingVm => Some("moving the VM to another zone"),
        RemoteStep::CreatingVm => Some("creating the VM"),
        RemoteStep::WaitingForVm => Some("waiting for the VM"),
        RemoteStep::Connecting => Some("connecting"),
        RemoteStep::InstallingRuntime => Some("installing the runtime"),
        RemoteStep::StartingAgent => Some("starting the agent"),
        RemoteStep::ConnectingAgent => Some("connecting to the agent"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// A stored session with the ID `id`, as `sessions.json` holds it.
    fn session(id: &str) -> SessionRecord {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "title": "Fix the login",
            "repoPath": "/repo",
            "worktreePath": "/worktrees/1",
            "branch": "feat/general/login",
            "baseRef": "master",
            "baseCommit": "abc",
            "acpSessionId": null,
            "createdAt": "2026-10-27T10:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn a_session_is_named_by_its_id_or_a_unique_start_of_it() {
        let sessions = || vec![session("ab12cd34-0000-4000-8000-000000000001"), session("ab12ef56-0000-4000-8000-000000000002")];
        let first = Uuid::parse_str("ab12cd34-0000-4000-8000-000000000001").unwrap();
        assert_eq!(find_session(sessions(), "ab12cd34-0000-4000-8000-000000000001").unwrap().id, first);
        assert_eq!(find_session(sessions(), "ab12c").unwrap().id, first);
        assert_eq!(find_session(sessions(), "AB12CD34").unwrap().id, first);
        assert!(find_session(sessions(), "ab12").unwrap_err().contains("names several sessions"));
        assert!(find_session(sessions(), "ffff").unwrap_err().contains("no session starts with ffff"));
        assert!(find_session(sessions(), "ab1").unwrap_err().contains("at least its first 4 hex digits"));
        assert!(find_session(sessions(), "login").unwrap_err().contains("names no session"));
    }

    #[test]
    fn a_session_on_this_mac_is_no_remote_session() {
        let data_dir = tempfile::tempdir().unwrap();
        let stored = serde_json::to_string(&vec![session("ab12cd34-0000-4000-8000-000000000001")]).unwrap();
        std::fs::write(data_dir.path().join("sessions.json"), stored).unwrap();
        let error = remote_session(data_dir.path(), "ab12cd34").err().unwrap();
        assert!(error.contains("the session ab12cd34 runs on this Mac"), "{error}");
    }

    #[test]
    fn the_identifier_is_the_apps() {
        let config: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }
}
