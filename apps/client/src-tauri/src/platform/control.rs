//! The control socket through which the processes of Hunt's local agents steer this Hunt: the Playwright MCP wrapper
//! (`apps/client/scripts/browserMcp.mjs`) opens its session's Chrome before the agent's first browser tool, and
//! `hunt-client` (`apps/client/scripts/huntClient.mjs`, run through the worktree's `.hunt/hunt-client`) hands a command
//! of the UI to the main window. Each Hunt process has a socket of its own, whose path its local agents and their
//! wrappers get in `SOCKET_ENV`; an agent on a session VM gets neither. Knows nothing about Tauri;
//! `session/commands/control.rs` carries the requests out.

use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;

use crate::platform::shell::{shell_quote, write_if_changed};

/// Where an agent and its wrappers find the control socket of the Hunt that started them.
pub const SOCKET_ENV: &str = "HUNT_CONTROL_SOCKET";

/// The script `.hunt/hunt-client` runs, relative to the workspace root (`crate::agent::acp::bundled_script_path`).
pub const CLIENT_SCRIPT: &str = "apps/client/scripts/huntClient.mjs";

/// The worktree's wrapper of `CLIENT_SCRIPT`, which the system prompt of a local agent names.
const CLIENT_WRAPPER_FILE: &str = ".hunt/hunt-client";

/// The longest path of a Unix socket on macOS, whose `sun_path` holds 104 bytes with the closing NUL.
const MAX_SOCKET_PATH_BYTES: usize = 103;

/// The start of the file name of a control socket, which ends in the process ID of its Hunt and `.sock`.
const SOCKET_PREFIX: &str = "hunt-";

/// The longest request line of the control socket.
const MAX_LINE_BYTES: u64 = 4096;

/// A request of the control socket, one JSON line tagged by `type`.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlRequest {
    /// Opens the Chrome of `session`.
    OpenBrowser { session: Uuid },
    /// Runs the `hunt-client` command `command` for `session` in the main window, which checks it.
    Ui { session: Uuid, command: Value },
}

/// The control socket of this Hunt process in `control_dir`. Each process has its own, since a `tauri dev` beside the
/// installed app shares its app data folder.
pub fn socket_path(control_dir: &Path) -> PathBuf {
    control_dir.join(format!("{SOCKET_PREFIX}{}.sock", std::process::id()))
}

/// Removes the control sockets in `dir` that no Hunt process listens on any more.
fn remove_stale_sockets(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let is_socket = path.file_name().is_some_and(|name| name.to_string_lossy().starts_with(SOCKET_PREFIX));
        if is_socket && std::os::unix::net::UnixStream::connect(&path).is_err() {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Serves the control socket at `socket_path`, which only this user may use: a client sends one `ControlRequest` line
/// and gets `{"ok":true}` once `carry_out` carried it out, or `{"error":"…"}`. Sockets left by earlier runs are removed.
/// Returns only when it cannot listen.
pub async fn serve<CarryOut, CarryOutFuture>(socket_path: PathBuf, carry_out: CarryOut) -> Result<(), String>
where
    CarryOut: Fn(ControlRequest) -> CarryOutFuture + Clone + Send + Sync + 'static,
    CarryOutFuture: Future<Output = Result<(), String>> + Send,
{
    let failed = |error: std::io::Error| format!("failed to listen on {}: {error}", socket_path.display());
    let path_length = socket_path.as_os_str().len();
    if path_length > MAX_SOCKET_PATH_BYTES {
        return Err(format!(
            "failed to listen on {}: the path has {path_length} bytes, more than the {MAX_SOCKET_PATH_BYTES} macOS allows for a socket",
            socket_path.display()
        ));
    }
    if let Some(dir) = socket_path.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(failed)?;
        remove_stale_sockets(dir).map_err(failed)?;
    }
    let listener = UnixListener::bind(&socket_path).map_err(failed)?;
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).map_err(failed)?;
    loop {
        let (stream, _) = listener.accept().await.map_err(failed)?;
        let carry_out = carry_out.clone();
        tokio::spawn(async move {
            if let Err(error) = answer(stream, carry_out).await {
                eprintln!("{error}");
            }
        });
    }
}

/// Reads the one request of a client on `stream`, carries it out with `carry_out` and answers.
async fn answer<CarryOut, CarryOutFuture>(stream: UnixStream, carry_out: CarryOut) -> Result<(), String>
where
    CarryOut: Fn(ControlRequest) -> CarryOutFuture,
    CarryOutFuture: Future<Output = Result<(), String>>,
{
    let (reader, mut writer) = stream.into_split();
    let mut line = String::new();
    BufReader::new(reader.take(MAX_LINE_BYTES))
        .read_line(&mut line)
        .await
        .map_err(|error| format!("failed to read a request of the control socket: {error}"))?;
    let result = match parse_request(&line) {
        Ok(request) => carry_out(request).await,
        Err(error) => Err(error),
    };
    writer.write_all(reply(&result).as_bytes()).await.map_err(|error| format!("failed to answer on the control socket: {error}"))
}

/// The request of the line `line`.
fn parse_request(line: &str) -> Result<ControlRequest, String> {
    serde_json::from_str(line.trim()).map_err(|error| format!("failed to read the request: {error}"))
}

/// The answer line to a request that ended with `result`.
fn reply(result: &Result<(), String>) -> String {
    let reply = match result {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "error": error }),
    };
    format!("{reply}\n")
}

/// The worktree's `.hunt/hunt-client`.
pub fn client_wrapper_path(worktree: &Path) -> PathBuf {
    worktree.join(CLIENT_WRAPPER_FILE)
}

/// Writes the worktree's `.hunt/hunt-client`, which runs `script` (`CLIENT_SCRIPT`) with the Node `node`.
pub fn prepare_client(worktree: &Path, node: &Path, script: &Path) -> Result<(), String> {
    let path = client_wrapper_path(worktree);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    }
    write_if_changed(&path, &client_wrapper_text(node, script), 0o755)
}

/// The text of `.hunt/hunt-client`.
fn client_wrapper_text(node: &Path, script: &Path) -> String {
    format!("#!/bin/sh\nexec {} {} \"$@\"\n", shell_quote(&node.to_string_lossy()), shell_quote(&script.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn requests_are_tagged_by_type() {
        let session = Uuid::new_v4();
        assert_eq!(parse_request(&format!("{{\"type\":\"openBrowser\",\"session\":\"{session}\"}}\n")).unwrap(), ControlRequest::OpenBrowser { session });
        let ui = format!("{{\"type\":\"ui\",\"session\":\"{session}\",\"command\":{{\"name\":\"tab\",\"tab\":\"terminal\"}}}}");
        assert_eq!(parse_request(&ui).unwrap(), ControlRequest::Ui { session, command: json!({ "name": "tab", "tab": "terminal" }) });
        assert!(parse_request("{}").is_err());
        assert!(parse_request(r#"{"type":"openBrowser","session":"nope"}"#).is_err());
        assert!(parse_request(&format!("{{\"type\":\"ui\",\"session\":\"{session}\"}}")).is_err());
        assert!(parse_request(&format!("{{\"open\":\"{session}\"}}")).is_err());
        assert!(parse_request("").is_err());
        assert_eq!(reply(&Ok(())), "{\"ok\":true}\n");
        assert_eq!(reply(&Err("no \"session\"".into())), "{\"error\":\"no \\\"session\\\"\"}\n");
    }

    #[tokio::test]
    async fn the_socket_answers_each_request() {
        let root = tempfile::tempdir().unwrap();
        let socket_path = socket_path(&root.path().join("control"));
        let known = Uuid::new_v4();
        let server = tokio::spawn(serve(socket_path.clone(), move |request| async move {
            match request {
                ControlRequest::OpenBrowser { session } if session == known => Ok(()),
                ControlRequest::OpenBrowser { session } => Err(format!("failed to open the browser: the session {session} is not stored")),
                ControlRequest::Ui { command, .. } => Err(format!("ran {command}")),
            }
        }));
        while !socket_path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mode = std::fs::metadata(&socket_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let ask = |line: String| {
            let socket_path = socket_path.clone();
            async move {
                let mut stream = UnixStream::connect(&socket_path).await.unwrap();
                stream.write_all(line.as_bytes()).await.unwrap();
                let mut reply = String::new();
                BufReader::new(stream).read_line(&mut reply).await.unwrap();
                reply
            }
        };
        assert_eq!(ask(format!("{{\"type\":\"openBrowser\",\"session\":\"{known}\"}}\n")).await, "{\"ok\":true}\n");
        assert!(ask(format!("{{\"type\":\"openBrowser\",\"session\":\"{}\"}}\n", Uuid::new_v4())).await.contains("is not stored"));
        let ui = format!("{{\"type\":\"ui\",\"session\":\"{known}\",\"command\":{{\"name\":\"show\"}}}}\n");
        assert!(ask(ui).await.contains("ran {\\\"name\\\":\\\"show\\\"}"));
        assert!(ask("garbage\n".into()).await.starts_with("{\"error\":\"failed to read the request"));
        server.abort();
    }

    #[tokio::test]
    async fn the_socket_refuses_a_path_macos_cannot_bind() {
        let long_path = PathBuf::from(format!("/tmp/{}/control.sock", "x".repeat(100)));
        let error = serve(long_path, |_| async { Ok(()) }).await.unwrap_err();
        assert!(error.contains("more than the 103 macOS allows for a socket"), "{error}");
    }

    #[test]
    fn the_client_wrapper_runs_the_script_with_node() {
        let worktree = tempfile::tempdir().unwrap();
        prepare_client(worktree.path(), Path::new("/usr/local/bin/node"), Path::new("/Applications/Hunt.app/Contents/Resources/huntClient.mjs")).unwrap();
        let wrapper = client_wrapper_path(worktree.path());
        assert_eq!(std::fs::read_to_string(&wrapper).unwrap(), "#!/bin/sh\nexec /usr/local/bin/node /Applications/Hunt.app/Contents/Resources/huntClient.mjs \"$@\"\n");
        assert_eq!(std::fs::metadata(&wrapper).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(client_wrapper_text(Path::new("/my node"), Path::new("/a's.mjs")), "#!/bin/sh\nexec '/my node' '/a'\\''s.mjs' \"$@\"\n");
    }
}
