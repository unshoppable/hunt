//! The config options a new session of the local agent starts with, for the start view, which offers them before a
//! session exists.

use std::path::PathBuf;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ClientCapabilities, InitializeRequest, NewSessionRequest, SessionConfigOption};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo};
use tauri::AppHandle;

use super::connection::{bundled_script_path, ACP_SCRIPT};
use crate::agent::accounts;

/// How long `agent_config_options` waits for the agent to start and create its session.
const CONFIG_OPTIONS_TIMEOUT: Duration = Duration::from_secs(60);

/// The config options (model, effort, mode) a new session of the local agent in `cwd` starts with, read from an agent
/// that creates the session and ends without a prompt.
#[tauri::command]
pub async fn agent_config_options(app: AppHandle, cwd: PathBuf) -> Result<Vec<SessionConfigOption>, String> {
    let script = bundled_script_path(&app, ACP_SCRIPT)?;
    let mut config = AcpAgentConfig::new("node").arg(script.to_string_lossy());
    if let Some(token) = accounts::active_token(&app).await? {
        config = config.env(accounts::TOKEN_ENV, token);
    }
    let probe = Client.builder().name("hunt").connect_with(AcpAgent::new(config), async move |connection: ConnectionTo<Agent>| {
        let initialize = InitializeRequest::new(ProtocolVersion::V1).client_capabilities(ClientCapabilities::new());
        connection.send_request(initialize).block_task().await?;
        let response = connection.send_request(NewSessionRequest::new(cwd)).block_task().await?;
        Ok(response.config_options.unwrap_or_default())
    });
    tokio::time::timeout(CONFIG_OPTIONS_TIMEOUT, probe)
        .await
        .map_err(|_| "failed to read the agent's config options: no answer in time".to_string())?
        .map_err(|error| format!("failed to read the agent's config options: {error}"))
}
