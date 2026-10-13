//! Session previews: `hunt-ctl preview …` runs the services and dev processes a repository declares in the `preview`
//! section of its hunt.json and routes `https://<short id>.<domain>` to them. This module reads its answers into what
//! the UI shows. Preview URLs are built here from the session id, the configured domain and port numbers; the VM only
//! reports ports.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The preview domain from the settings, lowercased, or an error when it is not a hostname of at least two labels.
pub fn validate_domain(domain: &str) -> Result<String, String> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = domain.split('.').collect();
    let is_label = |label: &&str| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|character| character.is_ascii_alphanumeric() || character == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    if labels.len() < 2 || !labels.iter().all(is_label) {
        return Err(format!("failed to use the preview domain {domain:?}: expected a host name such as previews.example.com"));
    }
    Ok(domain)
}

/// The URL of session `id`'s preview on `domain`: the main host, or the host of `port`.
pub fn url(id: Uuid, domain: &str, port: Option<u16>) -> String {
    let short = &id.simple().to_string()[..8];
    match port {
        Some(port) => format!("https://{short}-{port}.{domain}"),
        None => format!("https://{short}.{domain}"),
    }
}

/// What the UI shows of a session's preview.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    /// Whether a preview runs (or starts) for the session.
    pub active: bool,
    /// The relay's state of the preview (`preparing`, `init`, `starting`, `ready`, `degraded`, `failed`, `stopped`), or
    /// `stopped` without one.
    pub state: String,
    pub step: Option<String>,
    pub error: Option<String>,
    pub main_url: Option<String>,
    pub processes: Vec<PreviewProcess>,
    pub services: Vec<PreviewService>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProcess {
    pub name: String,
    /// `starting`, `ready`, `crashed` or `stopped`; `stopped` while the relay reports nothing about it.
    pub state: String,
    pub url: Option<String>,
    pub restarts: u32,
    pub exit_code: Option<i32>,
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewService {
    pub name: String,
    /// Docker's state of the service's container, e.g. `running` or `exited`.
    pub state: String,
}

/// A part of a preview log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLogChunk {
    /// Size of the whole log in bytes.
    pub size: u64,
    /// Byte offset of `text` in the log.
    pub offset: u64,
    pub text: String,
    /// Whether the log was rotated since the offset the caller asked for.
    pub reset: bool,
}

#[derive(Deserialize)]
struct StatusOutput {
    #[serde(default)]
    active: bool,
    #[serde(default)]
    processes: Vec<PlannedProcess>,
    #[serde(default)]
    services: BTreeMap<String, String>,
    relay: Option<RelayPreview>,
}

#[derive(Deserialize)]
struct PlannedProcess {
    name: String,
    port: Option<u16>,
    #[serde(default)]
    main: bool,
    #[serde(default)]
    optional: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayPreview {
    state: Option<String>,
    step: Option<String>,
    error: Option<String>,
    #[serde(default)]
    processes: BTreeMap<String, RelayProcess>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayProcess {
    state: Option<String>,
    #[serde(default)]
    restarts: u32,
    exit_code: Option<i32>,
}

/// Reads the output of `hunt-ctl preview status` for session `id` with its URLs on `domain`.
pub fn parse_status(output: &serde_json::Value, id: Uuid, domain: &str) -> Result<PreviewStatus, String> {
    let output: StatusOutput =
        serde_json::from_value(output.clone()).map_err(|error| format!("failed to read the preview status: {error}"))?;
    let relay = output.relay;
    let main = output.processes.iter().find(|process| process.main);
    let processes = output
        .processes
        .iter()
        .map(|process| {
            let reported = relay.as_ref().and_then(|relay| relay.processes.get(&process.name));
            PreviewProcess {
                name: process.name.clone(),
                state: reported.and_then(|reported| reported.state.clone()).unwrap_or_else(|| "stopped".into()),
                url: process.port.map(|port| url(id, domain, Some(port))),
                restarts: reported.map(|reported| reported.restarts).unwrap_or(0),
                exit_code: reported.and_then(|reported| reported.exit_code),
                optional: process.optional,
            }
        })
        .collect();
    let services = output.services.into_iter().map(|(name, state)| PreviewService { name, state }).collect();
    Ok(PreviewStatus {
        active: output.active,
        state: relay.as_ref().and_then(|relay| relay.state.clone()).filter(|_| output.active).unwrap_or_else(|| "stopped".into()),
        step: relay.as_ref().and_then(|relay| relay.step.clone()),
        error: relay.as_ref().and_then(|relay| relay.error.clone()),
        main_url: main.filter(|_| output.active).map(|_| url(id, domain, None)),
        processes,
        services,
    })
}

/// The status of a session whose VM is not running: no preview.
pub fn stopped_status() -> PreviewStatus {
    PreviewStatus { active: false, state: "stopped".into(), step: None, error: None, main_url: None, processes: Vec::new(), services: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "ab12cd34-0000-4000-8000-000000000001";

    #[test]
    fn validate_domain_accepts_host_names_only() {
        assert_eq!(validate_domain(" Previews.Example.com. ").unwrap(), "previews.example.com");
        for invalid in ["", "localhost", "a..b", "-a.example.com", "a_b.example.com", "https://x.example.com", "x.example.com/path"] {
            assert!(validate_domain(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn url_builds_the_main_and_port_hosts_from_the_short_id() {
        let id = Uuid::parse_str(ID).unwrap();
        assert_eq!(url(id, "p.example.com", None), "https://ab12cd34.p.example.com");
        assert_eq!(url(id, "p.example.com", Some(4400)), "https://ab12cd34-4400.p.example.com");
    }

    #[test]
    fn parse_status_combines_the_plan_with_the_relay_state_and_ignores_reported_urls() {
        let id = Uuid::parse_str(ID).unwrap();
        let output = json!({
            "active": true,
            "processes": [
                {"name": "admin-ui", "port": 4200, "main": true, "optional": false},
                {"name": "worker", "port": null, "main": false, "optional": false},
                {"name": "ui", "port": 4400, "main": false, "optional": true}
            ],
            "services": {"postgres": "running"},
            "relay": {"state": "starting", "step": null, "error": null, "urls": {"main": "https://evil.example"},
                      "processes": {"admin-ui": {"state": "ready", "restarts": 1, "exitCode": null}}}
        });
        let status = parse_status(&output, id, "p.example.com").unwrap();
        assert_eq!(status.state, "starting");
        assert_eq!(status.main_url.as_deref(), Some("https://ab12cd34.p.example.com"));
        assert_eq!(status.processes[0].url.as_deref(), Some("https://ab12cd34-4200.p.example.com"));
        assert_eq!((status.processes[0].state.as_str(), status.processes[0].restarts), ("ready", 1));
        assert_eq!((status.processes[1].state.as_str(), status.processes[1].url.clone()), ("stopped", None));
        assert!(status.processes[2].optional);
        assert_eq!(status.services, vec![PreviewService { name: "postgres".into(), state: "running".into() }]);

        let inactive = parse_status(&json!({"active": false, "processes": [], "services": {}, "relay": null}), id, "p.example.com").unwrap();
        assert_eq!(inactive, PreviewStatus { active: false, ..stopped_status() });
    }
}
