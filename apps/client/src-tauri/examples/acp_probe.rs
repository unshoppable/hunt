//! Headless probe: drives claude-agent-acp exactly like the app does and prints every notification
//! the Rust crate manages to deserialize. Usage: cargo run --example acp_probe -- <cwd> "<prompt>"
use agent_client_protocol::schema::v1::*;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{on_receive_notification, on_receive_request, AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::args().nth(1).expect("cwd");
    let prompt = std::env::args().nth(2).unwrap_or_else(|| "Say hello in three words.".into());
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
    let agent = AcpAgent::new(AcpAgentConfig::new("node").arg(script)).with_debug(|line, direction| {
        if line.contains("session/update") && !line.contains("agent_message_chunk") {
            eprintln!("[wire {direction:?}] {}", &line[..line.len().min(300)]);
        }
    });

    Client.builder()
        .name("probe")
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                match &notification.update {
                    SessionUpdate::AgentMessageChunk(chunk) => {
                        if let ContentBlock::Text(text) = &chunk.content { print!("{}", text.text); }
                    }
                    other => println!("\n[rust ok] {}", serde_json::to_string(other)?.chars().take(160).collect::<String>()),
                }
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let option = request.options.iter().find(|option| option.kind == PermissionOptionKind::AllowOnce).or(request.options.first()).unwrap();
                println!("\n[permission] {:?} -> {}", request.tool_call.fields.title, option.option_id);
                responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone()))))
            },
            on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            let mut meta = Meta::new();
            meta.insert("terminal_output".into(), serde_json::Value::Bool(true));
            connection.send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(ClientCapabilities::new().meta(meta))).block_task().await?;
            let session = connection.send_request(NewSessionRequest::new(cwd)).block_task().await?;
            println!("[session] {}", session.session_id);
            let result = connection.send_request(PromptRequest::new(session.session_id, vec![ContentBlock::Text(TextContent::new(prompt))])).block_task().await?;
            println!("\n[stop] {:?}", result.stop_reason);
            Ok(())
        })
        .await?;
    Ok(())
}
