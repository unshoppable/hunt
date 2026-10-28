//! `hunt-ctl`, the control CLI on a session VM: running it there as root, the tokens `start` and `clear` read on stdin,
//! starting the session's relay with them, the conversation and the agent's last work its status reports, and the
//! command that streams an ACP connection to the relay. Hunt and the `hunt` command line (`crate::cli`) share them.

use std::path::Path;

use uuid::Uuid;

use super::{ssh, RemoteOrigin};
use crate::agent::accounts;
use crate::github::github_token;
use crate::platform::shell::shell_command;

/// The relay of a session VM, as `socat` addresses it.
const RELAY_SOCKET: &str = "UNIX-CONNECT:/run/hunt/relay.sock";

/// What `hunt-ctl start` and `clear` read on stdin: the Claude Code OAuth token the relay runs Claude Code with (empty
/// with the local login, which only a running relay gets by with) and the GitHub token it pushes and runs `gh` with
/// (empty without one).
pub fn token_input(claude_token: &str, github_token: Option<&str>) -> String {
    format!("{claude_token}\n{}\n", github_token.unwrap_or_default())
}

/// The tokens for `hunt-ctl start` of a session from this Mac: the Claude account selected in the app data folder
/// `data_dir` (empty with the local login) and the keychain's GitHub token. A poller session's relay takes them only
/// where its VM stores none (`RemoteOrigin::relay_token_args`).
pub async fn local_token_input(data_dir: &Path) -> Result<String, String> {
    let claude_token = accounts::active_token_in(data_dir).await?.unwrap_or_default();
    Ok(token_input(&claude_token, github_token::read().await?.as_deref()))
}

/// Makes sure the relay of session `id` runs on the VM behind `ssh`, with the tokens `token_input`
/// (`local_token_input`) where its `origin` lets it take them. A running relay keeps its conversation and its clients;
/// it restarts only for another Claude token while no turn runs.
pub async fn start_relay(ssh: &ssh::Ssh, id: Uuid, origin: RemoteOrigin, token_input: &str) -> Result<(), String> {
    let id_text = id.to_string();
    let mut args = vec!["start", &id_text];
    args.extend(origin.relay_token_args());
    hunt_ctl_with_input(ssh, &args, token_input.as_bytes()).await.map(|_| ())
}

/// The conversation a relay serves according to its `status` (`hunt-ctl wait`), else the one stored as `known`.
pub fn relay_conversation(status: &serde_json::Value, known: Option<&str>) -> Option<String> {
    status["acpSessionId"].as_str().or(known).map(str::to_string)
}

/// The command that streams an ACP connection to the session's relay as the user `agent`, for `Ssh::stream_args`.
pub fn relay_stream_command() -> String {
    shell_command("sudo", &["-n", "-u", "agent", "socat", "-", RELAY_SOCKET])
}

/// The time of the agent's last work the relay reports in its status (`hunt-ctl wait` or `status`): `now` while a turn
/// runs, else when the last turn ended (Unix ms); `None` when no turn ended since the relay started. Client activity
/// does not count, since every connect of Hunt is some.
pub fn relay_activity(status: &serde_json::Value, now: chrono::DateTime<chrono::Utc>) -> Option<chrono::DateTime<chrono::Utc>> {
    if status["turn"].as_str() == Some("running") {
        return Some(now);
    }
    status["lastTurnEndedAt"].as_i64().and_then(chrono::DateTime::from_timestamp_millis)
}

/// Runs `hunt-ctl` with `args` on the VM as root and returns its JSON output.
pub async fn hunt_ctl(ssh: &ssh::Ssh, args: &[&str]) -> Result<serde_json::Value, String> {
    hunt_ctl_with_input(ssh, args, &[]).await
}

/// Runs `hunt-ctl` with `args` and `input` on its standard input on the VM as root and returns its JSON output.
pub async fn hunt_ctl_with_input(ssh: &ssh::Ssh, args: &[&str], input: &[u8]) -> Result<serde_json::Value, String> {
    let mut command_args = vec!["-n", "hunt-ctl"];
    command_args.extend_from_slice(args);
    let output = ssh.run_with_input(&shell_command("sudo", &command_args), input).await?;
    let output = String::from_utf8_lossy(&output);
    let output = output.trim();
    if output.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(output).map_err(|error| format!("failed to read the output of hunt-ctl {}: {error}: {output}", args.first().unwrap_or(&"")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_activity_takes_a_running_turn_as_now_and_else_the_last_turn_end() {
        let now = chrono::DateTime::from_timestamp_millis(1_760_000_000_000).unwrap();
        let ended = serde_json::json!({ "turn": "idle", "lastTurnEndedAt": 1_759_000_000_000_i64, "lastClientActivityAt": 1_759_900_000_000_i64 });
        assert_eq!(relay_activity(&ended, now), chrono::DateTime::from_timestamp_millis(1_759_000_000_000));
        assert_eq!(relay_activity(&serde_json::json!({ "turn": "running", "lastTurnEndedAt": null }), now), Some(now));
        assert_eq!(relay_activity(&serde_json::json!({ "turn": "idle", "lastTurnEndedAt": null }), now), None);
        assert_eq!(relay_activity(&serde_json::Value::Null, now), None);
    }

    #[test]
    fn the_conversation_comes_from_the_relay_and_else_from_the_record() {
        assert_eq!(relay_conversation(&serde_json::json!({ "acpSessionId": "relay" }), Some("stored")).as_deref(), Some("relay"));
        assert_eq!(relay_conversation(&serde_json::json!({ "acpSessionId": null }), Some("stored")).as_deref(), Some("stored"));
        assert_eq!(relay_conversation(&serde_json::Value::Null, None), None);
    }

    #[test]
    fn the_relay_stream_runs_socat_as_the_agent() {
        assert_eq!(relay_stream_command(), "sudo -n -u agent socat - UNIX-CONNECT:/run/hunt/relay.sock");
    }

    #[test]
    fn token_input_puts_each_token_on_its_own_line() {
        assert_eq!(token_input("sk-ant-oat01", Some("github_pat_1")), "sk-ant-oat01\ngithub_pat_1\n");
        assert_eq!(token_input("sk-ant-oat01", None), "sk-ant-oat01\n\n");
        assert_eq!(token_input("", None), "\n\n");
    }
}
