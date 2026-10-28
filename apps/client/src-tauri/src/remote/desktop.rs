//! The remote desktop of a session VM: a headless Wayland desktop that the Waymote gateway streams as H.264 over
//! WebSockets (`/stream`, `/audio`, `/control`). On the VM, the session's `hunt-proxy` listens on 127.0.0.1:9231 and
//! passes on to the gateway only requests from Hunt's origins (`tauri://localhost`, the dev server's
//! `http://localhost:1420`). Hunt reaches that port through a forward of the shared SSH connection from a free port on
//! this Mac's loopback address, opened once per session and kept until the session's agent or the session ends; the
//! panel's WebSockets connect to it directly. Knows nothing about Tauri; `session/commands/browser.rs` owns the
//! command.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use uuid::Uuid;

use super::ssh::Ssh;
use super::VmRef;

/// The port of the VM's desktop proxy, on its loopback address.
pub const DESKTOP_PROXY_PORT: u16 = 9231;

/// The origin the health check sends; the VM's proxy refuses requests from any other than Hunt's.
const HEALTH_ORIGIN: &str = "tauri://localhost";

/// How long the health check waits for the desktop to answer through the forward.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

/// The bytes of a health check's response that are read; the status line is all that counts.
const MAX_RESPONSE_BYTES: u64 = 4096;

/// Where the remote desktop of a session answers on this Mac (mirror of `DesktopEndpoint` in src/desktop/desktop.types.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEndpoint {
    /// The base URL of the Waymote gateway, `http://127.0.0.1:<local port>`; the client derives `ws://` URLs of its
    /// paths from it.
    pub url: String,
}

/// An open forward from `local_port` on this Mac to the desktop proxy of a VM.
struct DesktopForward {
    ssh: Ssh,
    local_port: u16,
}

impl DesktopForward {
    fn endpoint(&self) -> DesktopEndpoint {
        DesktopEndpoint { url: format!("http://127.0.0.1:{}", self.local_port) }
    }

    async fn cancel(&self) -> Result<(), String> {
        self.ssh.cancel_local_forward(self.local_port, DESKTOP_PROXY_PORT).await
    }
}

/// The forward of a session, behind a lock of its own so that concurrent opens of one session make one forward while
/// other sessions' opens go on.
type ForwardSlot = Arc<tokio::sync::Mutex<Option<DesktopForward>>>;

/// The desktop forwards of the sessions by session ID.
#[derive(Default)]
pub struct DesktopRegistry {
    forwards: Mutex<HashMap<Uuid, ForwardSlot>>,
}

impl DesktopRegistry {
    /// The endpoint of the remote desktop of the session `id`. A remembered forward through which the desktop answers
    /// is reused; otherwise `running_vm` names the session's VM, which must run, and a new forward to it is opened with
    /// Hunt's SSH key in `ssh_dir` and checked. A forward whose desktop does not answer is cancelled again.
    pub async fn open<RunningVm, VmFuture>(&self, id: Uuid, ssh_dir: &Path, running_vm: RunningVm) -> Result<DesktopEndpoint, String>
    where
        RunningVm: FnOnce() -> VmFuture,
        VmFuture: Future<Output = Result<VmRef, String>>,
    {
        let slot = self.forwards.lock().unwrap().entry(id).or_default().clone();
        let mut forward = slot.lock().await;
        if let Some(current) = forward.take() {
            if check_health(current.local_port).await.is_ok() {
                let endpoint = current.endpoint();
                *forward = Some(current);
                return Ok(endpoint);
            }
            // The master ended and took the forward with it, or the desktop stopped answering; a new forward replaces it.
            if let Err(error) = current.cancel().await {
                eprintln!("cancelling the stale desktop forward of session {id} failed: {error}");
            }
        }
        let vm = running_vm().await?;
        let ssh = Ssh::open(&vm, ssh_dir).await?;
        let local_port = free_local_port()?;
        ssh.forward_local_port(local_port, DESKTOP_PROXY_PORT).await?;
        let opened = DesktopForward { ssh, local_port };
        if let Err(error) = check_health(local_port).await {
            if let Err(cancel_error) = opened.cancel().await {
                eprintln!("cancelling the desktop forward of session {id} failed: {cancel_error}");
            }
            return Err(format!("failed to open the remote desktop of the VM {}: {error}", vm.instance));
        }
        let endpoint = opened.endpoint();
        *forward = Some(opened);
        Ok(endpoint)
    }

    /// Cancels the forward of the session `id`, if it has one; open streams through it stay until they close. A failure
    /// is only logged, since the forward ends with the SSH master in any case.
    pub async fn close(&self, id: Uuid) {
        let Some(slot) = self.forwards.lock().unwrap().remove(&id) else { return };
        let Some(forward) = slot.lock().await.take() else { return };
        if let Err(error) = forward.cancel().await {
            eprintln!("cancelling the desktop forward of session {id} failed: {error}");
        }
    }

    /// Cancels every session's forward.
    pub async fn close_all(&self) {
        let ids: Vec<Uuid> = self.forwards.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.close(id).await;
        }
    }
}

/// A port of this Mac's loopback address that is free now; the forward binds it right after.
fn free_local_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("failed to find a free local port: {error}"))?;
    let address = listener.local_addr().map_err(|error| format!("failed to find a free local port: {error}"))?;
    Ok(address.port())
}

/// Asks the desktop for `/healthz` through the forward at `local_port` with Hunt's origin; succeeds on a 2xx answer.
async fn check_health(local_port: u16) -> Result<(), String> {
    let request = format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{local_port}\r\nOrigin: {HEALTH_ORIGIN}\r\nConnection: close\r\n\r\n");
    let exchange = async {
        let mut stream =
            TcpStream::connect(("127.0.0.1", local_port)).await.map_err(|error| format!("failed to reach the desktop proxy: {error}"))?;
        stream.write_all(request.as_bytes()).await.map_err(|error| format!("failed to ask the desktop proxy: {error}"))?;
        let mut response = Vec::new();
        stream
            .take(MAX_RESPONSE_BYTES)
            .read_to_end(&mut response)
            .await
            .map_err(|error| format!("failed to read the answer of the desktop proxy: {error}"))?;
        Ok::<_, String>(response)
    };
    let response = tokio::time::timeout(HEALTH_TIMEOUT, exchange)
        .await
        .map_err(|_| format!("failed to reach the desktop proxy: no answer within {} s", HEALTH_TIMEOUT.as_secs()))??;
    health_result(status_code(&response))
}

/// The status code of the HTTP response that starts with `response`, if it has a status line.
fn status_code(response: &[u8]) -> Option<u16> {
    let line_end = response.iter().position(|byte| *byte == b'\n')?;
    let line = std::str::from_utf8(&response[..line_end]).ok()?;
    let mut parts = line.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

/// What the status `status` of the health check means; the errors name the likely cause.
fn health_result(status: Option<u16>) -> Result<(), String> {
    match status {
        Some(200..=299) => Ok(()),
        Some(403) => Err("the desktop proxy refuses Hunt's origin (403)".into()),
        Some(code @ 502..=504) => Err(format!("the desktop does not run on the VM ({code})")),
        Some(code) => Err(format!("the desktop proxy answered {code}")),
        None => Err("the desktop proxy closed the connection without an HTTP answer; is the VM's desktop installed?".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn status_code_reads_the_status_line_only() {
        assert_eq!(status_code(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"), Some(200));
        assert_eq!(status_code(b"HTTP/1.1 403 Forbidden\r\n"), Some(403));
        assert_eq!(status_code(b"HTTP/1.1 200 OK"), None);
        assert_eq!(status_code(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(status_code(b""), None);
    }

    #[test]
    fn health_result_names_the_cause_of_a_failure() {
        assert_eq!(health_result(Some(204)), Ok(()));
        assert!(health_result(Some(403)).unwrap_err().contains("origin"));
        assert!(health_result(Some(502)).unwrap_err().contains("does not run"));
        assert!(health_result(Some(500)).unwrap_err().contains("500"));
        assert!(health_result(None).is_err());
    }

    #[test]
    fn free_local_port_returns_a_bindable_port() {
        let port = free_local_port().unwrap();
        assert_ne!(port, 0);
        std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    }

    #[tokio::test]
    async fn check_health_sends_hunts_origin_and_reads_the_status() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 1024];
            let read = stream.read(&mut request).await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await.unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        assert_eq!(check_health(port).await, Ok(()));
        let request = server.await.unwrap();
        assert!(request.starts_with("GET /healthz HTTP/1.1\r\n"));
        assert!(request.contains("\r\nOrigin: tauri://localhost\r\n"));
    }

    #[tokio::test]
    async fn check_health_fails_when_nothing_listens() {
        let port = free_local_port().unwrap();
        assert!(check_health(port).await.unwrap_err().starts_with("failed to reach the desktop proxy"));
    }
}
