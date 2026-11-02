//! The services of a repository: the long-running processes such as a backend or a dev server that its `hunt.json`
//! declares under `services`. A local session runs each in a window of its family's tmux server (`terminal/tmux.rs`),
//! which the Terminal tab shows and whose output lands in `.hunt/logs/desktop/<window name>.log`; the window is the
//! service's whole state. On a session VM the VM runs them itself (`apps/session/src/session-config/`). Knows nothing
//! about Tauri; `session/commands/services.rs` owns the commands.
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::terminal::tmux::{service_window, TmuxWindow, DESKTOP_LOGS, LOGS_DIR};

/// The placeholder start of the public URL of a service on a session VM. A local session leaves a variable that holds
/// one out, so that the app falls back to its own URL.
const PUBLIC_URL_PLACEHOLDER: &str = "${services.";

/// How long `is_listening` waits for a port to accept a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// A service as the worktree's `hunt.json` declares it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDefinition {
    pub name: String,
    pub command: String,
    /// Worktree-relative folder the command runs in; `None` runs it in the worktree.
    pub cwd: Option<String>,
    /// The port the service listens on, if it declares one.
    pub port: Option<u16>,
    /// Whether the port speaks HTTPS (`tls`).
    pub tls: bool,
    /// Whether the service shows pages in a browser (`frontend`), such as a dev server: "Browser" opens a tab for it.
    pub frontend: bool,
    /// The variables the command runs with on this Mac: those of `env` without a public URL placeholder.
    #[serde(skip)]
    pub env: Vec<(String, String)>,
}

/// The services of the worktree's `hunt.json` in the file's order; none without the file or the section. The VM
/// validates the file fully (`apps/session/src/session-config/hunt-json.value-object.ts`); here only the shape of the
/// fields a local run uses matters.
pub fn read_services(worktree: &Path) -> Result<Vec<ServiceDefinition>, String> {
    let path = worktree.join("hunt.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    let invalid = |message: String| format!("failed to read {}: {message}", path.display());
    let json: Value = serde_json::from_str(&text).map_err(|error| invalid(error.to_string()))?;
    let services = match json.get("services") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Object(services)) => services,
        Some(_) => return Err(invalid("services must be an object of named services".into())),
    };
    let mut definitions = Vec::new();
    for (name, service) in services {
        let command = service.get("command").and_then(Value::as_str).map(str::trim).filter(|command| !command.is_empty() && !command.contains('\n'));
        let Some(command) = command else { return Err(invalid(format!("services.{name}.command must be a command line"))) };
        let cwd = match service.get("cwd") {
            None | Some(Value::Null) => None,
            Some(Value::String(cwd)) => Some(cwd.clone()),
            Some(_) => return Err(invalid(format!("services.{name}.cwd must be a folder of the worktree"))),
        };
        let port = match service.get("port") {
            None | Some(Value::Null) => None,
            Some(port) => Some(port.as_u64().and_then(|port| u16::try_from(port).ok()).ok_or_else(|| invalid(format!("services.{name}.port must be a port number")))?),
        };
        let flag = |field: &str| match service.get(field) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(value)) => Ok(*value),
            Some(_) => Err(invalid(format!("services.{name}.{field} must be true or false"))),
        };
        let (tls, frontend) = (flag("tls")?, flag("frontend")?);
        let env = match service.get("env") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Object(env)) => {
                let mut variables = Vec::new();
                for (key, value) in env {
                    let Some(value) = value.as_str() else { return Err(invalid(format!("services.{name}.env.{key} must be a string"))) };
                    if !value.contains(PUBLIC_URL_PLACEHOLDER) {
                        variables.push((key.clone(), value.to_string()));
                    }
                }
                variables
            }
            Some(_) => return Err(invalid(format!("services.{name}.env must be an object of variables"))),
        };
        definitions.push(ServiceDefinition { name: name.clone(), command: command.to_string(), cwd, port, tls, frontend, env });
    }
    Ok(definitions)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    /// No window runs the service.
    Stopped,
    Running,
    /// Its window stays with the output and the exit code.
    Ended,
}

/// A service of a local session as the Terminal tab and `hunt-client services` show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub name: String,
    pub command: String,
    pub port: Option<u16>,
    pub state: ServiceState,
    /// The exit code of an ended service; `None` otherwise and when a signal ended it.
    pub exit_code: Option<i32>,
    /// The tmux window that runs or ran the service.
    pub window_id: Option<String>,
    /// The worktree-relative log of the service's window.
    pub log: Option<String>,
    /// Whether something accepts connections on its port on this Mac now.
    pub is_listening: bool,
}

/// The view of each service of `definitions` with the state of its window among `windows`; `is_listening` stays false.
pub fn service_views(definitions: &[ServiceDefinition], windows: &[TmuxWindow]) -> Vec<ServiceView> {
    definitions
        .iter()
        .map(|definition| {
            let window = service_window(windows, &definition.name);
            let state = match window {
                None => ServiceState::Stopped,
                Some(window) if window.is_dead => ServiceState::Ended,
                Some(_) => ServiceState::Running,
            };
            ServiceView {
                name: definition.name.clone(),
                command: definition.command.clone(),
                port: definition.port,
                state,
                exit_code: window.filter(|window| window.is_dead).and_then(|window| window.exit_code),
                window_id: window.map(|window| window.id.clone()),
                log: window.map(|window| format!("{LOGS_DIR}/{DESKTOP_LOGS}/{}.log", window.name)),
                is_listening: false,
            }
        })
        .collect()
}

/// Whether something on this Mac accepts connections on `port`, on IPv4 or IPv6 (`localhost` resolves to both).
pub async fn is_listening(port: u16) -> bool {
    matches!(tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(("localhost", port))).await, Ok(Ok(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_hunt_json(text: &str) -> tempfile::TempDir {
        let worktree = tempfile::tempdir().unwrap();
        std::fs::write(worktree.path().join("hunt.json"), text).unwrap();
        worktree
    }

    fn window(id: &str, name: &str, service: &str, is_dead: bool, exit_code: Option<i32>) -> TmuxWindow {
        TmuxWindow {
            id: id.into(),
            name: name.into(),
            script: None,
            check: None,
            service: Some(service.into()),
            is_dead,
            exit_code,
            owner: None,
            folder: None,
        }
    }

    #[test]
    fn services_come_from_hunt_json_in_the_order_of_the_file_without_public_url_variables() {
        let worktree = write_hunt_json(
            r#"{"version":3,"services":{
                "web":{"command":" npm start ","port":4200,"frontend":true,"env":{"API":"${services.api.publicUrl}","MODE":"dev"}},
                "api":{"command":"npm run api","cwd":"apps/api","tls":true}}}"#,
        );
        let services = read_services(worktree.path()).unwrap();
        assert_eq!(
            services,
            [
                ServiceDefinition {
                    name: "web".into(),
                    command: "npm start".into(),
                    cwd: None,
                    port: Some(4200),
                    tls: false,
                    frontend: true,
                    env: vec![("MODE".into(), "dev".into())],
                },
                ServiceDefinition {
                    name: "api".into(),
                    command: "npm run api".into(),
                    cwd: Some("apps/api".into()),
                    port: None,
                    tls: true,
                    frontend: false,
                    env: Vec::new(),
                },
            ]
        );
    }

    #[test]
    fn a_worktree_without_hunt_json_or_services_has_none_and_a_malformed_service_is_an_error() {
        assert!(read_services(tempfile::tempdir().unwrap().path()).unwrap().is_empty());
        assert!(read_services(write_hunt_json(r#"{"version":3}"#).path()).unwrap().is_empty());
        for (text, problem) in [
            (r#"{"services":[]}"#, "services must be an object of named services"),
            (r#"{"services":{"web":{}}}"#, "services.web.command must be a command line"),
            (r#"{"services":{"web":{"command":"a\nb"}}}"#, "services.web.command must be a command line"),
            (r#"{"services":{"web":{"command":"a","port":70000}}}"#, "services.web.port must be a port number"),
            (r#"{"services":{"web":{"command":"a","env":{"A":1}}}}"#, "services.web.env.A must be a string"),
            (r#"{"services":{"web":{"command":"a","frontend":"yes"}}}"#, "services.web.frontend must be true or false"),
        ] {
            let error = read_services(write_hunt_json(text).path()).unwrap_err();
            assert!(error.ends_with(problem), "{error}");
        }
    }

    #[test]
    fn a_service_is_stopped_without_a_window_and_running_or_ended_with_one() {
        let definition = |name: &str| ServiceDefinition {
            name: name.into(),
            command: "npm start".into(),
            cwd: None,
            port: Some(3000),
            tls: false,
            frontend: false,
            env: Vec::new(),
        };
        let windows = [window("@1", "web", "web", false, None), window("@2", "api-2", "api", true, Some(1))];
        let views = service_views(&[definition("web"), definition("api"), definition("docs")], &windows);
        let states: Vec<_> = views.iter().map(|view| (view.name.as_str(), view.state, view.exit_code, view.window_id.as_deref(), view.log.as_deref())).collect();
        assert_eq!(
            states,
            [
                ("web", ServiceState::Running, None, Some("@1"), Some(".hunt/logs/desktop/web.log")),
                ("api", ServiceState::Ended, Some(1), Some("@2"), Some(".hunt/logs/desktop/api-2.log")),
                ("docs", ServiceState::Stopped, None, None, None),
            ]
        );
    }

    #[tokio::test]
    async fn a_port_listens_while_something_accepts_connections_on_it() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        assert!(is_listening(listener.local_addr().unwrap().port()).await);
        // A freed port may be taken at once by a test running beside this one; nothing ever listens on port 0.
        assert!(!is_listening(0).await);
    }
}
