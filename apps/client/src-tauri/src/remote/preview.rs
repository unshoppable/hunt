//! Session previews. Hunt runs the services the repository's hunt.json declares as systemd units on the session's VM,
//! and the agent starts those its task needs. The gateway routes `https://<short>-<port>.<domain>` to any port of the
//! VM behind Google login, and `https://<short>-<port>-open.<domain>` to the port of a service marked
//! `"guarded": false`, which only the app's own login protects. `hunt-ctl preview-status` reports the services with
//! their state; this module builds every URL from the session id, the domain and the port, so a URL the VM sends is
//! ignored.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::session::session_id::SessionId;

/// The longest preview domain: `<short>-<port>-open.` in front of it must fit into the 253 characters of a host name.
const MAX_DOMAIN_LENGTH: usize = 253 - "01234567-65535-open.".len();

/// The longest service name; `apps/session/src/session-config/hunt-json.rules.ts` and `hunt-ctl` allow the same.
const MAX_SERVICE_NAME_LENGTH: usize = 32;

/// The preview domain the gateway reports, lowercased, or an error unless it is a host name of at least two labels whose
/// last label consists of 2 to 63 letters. `hunt-ctl` (`DOMAIN_PATTERN`) and `libs/domain/src/session/preview-domain.rules.ts` check the
/// same.
pub fn validate_domain(domain: &str) -> Result<String, String> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = domain.split('.').collect();
    let is_label = |label: &&str| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    let is_top_level = |label: &&str| label.len() >= 2 && label.chars().all(|character| character.is_ascii_lowercase());
    let is_valid = domain.len() <= MAX_DOMAIN_LENGTH
        && labels.len() >= 2
        && labels.iter().all(is_label)
        && labels.last().is_some_and(is_top_level);
    if !is_valid {
        return Err(format!("failed to use the preview domain {domain:?}: expected a host name such as previews.example.com"));
    }
    Ok(domain)
}

/// The URL of `port` of session `id`'s VM on `domain`, behind Google login.
pub fn port_url(id: Uuid, domain: &str, port: u16) -> String {
    format!("https://{}-{port}.{domain}", SessionId(id).short())
}

/// The URL of the service on `port` of session `id`'s VM on `domain` that only the app's own login protects; the
/// gateway serves it only for a service marked `"guarded": false`.
pub fn open_url(id: Uuid, domain: &str, port: u16) -> String {
    format!("https://{}-{port}-open.{domain}", SessionId(id).short())
}

/// Whether `name` matches `^[a-z][a-z0-9-]{0,31}$`, the names hunt.json allows for services.
pub(crate) fn is_service_name(name: &str) -> bool {
    name.len() <= MAX_SERVICE_NAME_LENGTH
        && name.starts_with(|character: char| character.is_ascii_lowercase())
        && name.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

/// What the UI shows of a session's preview.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    /// Whether the session's VM runs; when it is off, the rest is empty.
    pub vm_running: bool,
    /// The services of the repository's hunt.json, in its order.
    pub services: Vec<PreviewService>,
}

/// A service of the repository's hunt.json and the state of its unit on the VM.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewService {
    pub name: String,
    pub port: u16,
    /// `open_url` for a service marked `"guarded": false`, else `port_url`.
    pub url: String,
    pub guarded: bool,
    /// Whether the service itself serves HTTPS.
    pub tls: bool,
    /// Whether its unit is enabled, so it starts again with the VM.
    pub enabled: bool,
    pub state: PreviewServiceState,
    /// Whether its port listens on the VM.
    pub responds: bool,
    /// systemd's ID of the unit's current run, new with every start and restart; `None` while the unit does not run or
    /// the VM's hunt-ctl predates it. The Terminal tab connects to the service's terminal again when it changes.
    pub invocation: Option<String>,
    /// The other services whose public URL its environment holds (`${services.<name>.publicUrl}` in hunt.json); the
    /// services linked this way make up one app. Empty while the VM's `meta.json` predates them.
    pub uses: Vec<String>,
    /// Whether the worktree's hunt.json marks it `"frontend": true`: "Browser" opens a tab at `url` while it `responds`.
    /// The VM does not report it; `mark_frontends` sets it.
    pub frontend: bool,
}

/// The state of a service's unit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PreviewServiceState {
    Running,
    Starting,
    Failed,
    Stopped,
}

#[derive(Deserialize)]
struct StatusOutput {
    services: Vec<ServiceOutput>,
}

#[derive(Deserialize)]
struct ServiceOutput {
    name: String,
    port: u16,
    tls: bool,
    guarded: bool,
    enabled: bool,
    state: PreviewServiceState,
    responds: bool,
    #[serde(default)]
    invocation: Option<String>,
    #[serde(default)]
    uses: Vec<String>,
}

/// Reads the output of `hunt-ctl preview-status` for session `id` with its URLs on `domain`.
pub fn parse_status(output: &serde_json::Value, id: Uuid, domain: &str) -> Result<PreviewStatus, String> {
    let output: StatusOutput =
        serde_json::from_value(output.clone()).map_err(|error| format!("failed to read the preview status: {error}"))?;
    let mut services = Vec::with_capacity(output.services.len());
    for service in output.services {
        if !is_service_name(&service.name) {
            return Err(format!("failed to read the preview status: {:?} is not a service name", service.name));
        }
        if let Some(used) = service.uses.iter().find(|used| !is_service_name(used)) {
            return Err(format!("failed to read the preview status: {used:?} is not a service name"));
        }
        let url = if service.guarded { port_url(id, domain, service.port) } else { open_url(id, domain, service.port) };
        services.push(PreviewService {
            name: service.name,
            port: service.port,
            url,
            guarded: service.guarded,
            tls: service.tls,
            enabled: service.enabled,
            state: service.state,
            responds: service.responds,
            invocation: service.invocation.filter(|invocation| !invocation.is_empty()),
            uses: service.uses,
            frontend: false,
        });
    }
    Ok(PreviewStatus { vm_running: true, services })
}

/// Marks the services of `status` whose name is in `frontends`, the frontend services of the worktree's hunt.json.
pub fn mark_frontends(status: &mut PreviewStatus, frontends: &[String]) {
    for service in &mut status.services {
        service.frontend = frontends.contains(&service.name);
    }
}

/// The status of a session whose VM is off: nothing runs.
pub fn stopped_status() -> PreviewStatus {
    PreviewStatus { vm_running: false, services: Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "ab12cd34-0000-4000-8000-000000000001";

    /// A service as `hunt-ctl preview-status` reports it, on port 3000.
    fn service(name: &str, state: &str) -> serde_json::Value {
        json!({"name": name, "port": 3000, "tls": false, "guarded": true, "enabled": true, "state": state, "responds": false})
    }

    #[test]
    fn validate_domain_accepts_host_names_only() {
        assert_eq!(validate_domain(" Previews.Example.com. ").unwrap(), "previews.example.com");
        assert_eq!(validate_domain("a-1.b2.example.de").unwrap(), "a-1.b2.example.de");
        for invalid in ["", "localhost", "a..b", "-a.example.com", "a_b.example.com", "https://x.example.com", "x.example.com/path"] {
            assert!(validate_domain(invalid).is_err(), "{invalid}");
        }
        for invalid_top_level in ["hunt.example.c0m", "hunt.example.c", "hunt.example.123", "hunt.example.co-m", "hunt.example.ä"] {
            assert!(validate_domain(invalid_top_level).is_err(), "{invalid_top_level}");
        }

        let domain_of_length = |length: usize| {
            format!("{}.{}.{}.{}.com", "a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(length - 196))
        };
        assert!(validate_domain(&domain_of_length(233)).is_ok());
        assert!(validate_domain(&domain_of_length(234)).is_err());
        let longest_open_host = open_url(Uuid::parse_str(ID).unwrap(), &domain_of_length(233), 65535);
        assert_eq!(longest_open_host.trim_start_matches("https://").len(), 253);
    }

    #[test]
    fn port_url_and_open_url_build_the_hosts_from_the_short_id_and_the_port() {
        let id = Uuid::parse_str(ID).unwrap();
        assert_eq!(port_url(id, "p.example.com", 4400), "https://ab12cd34-4400.p.example.com");
        assert_eq!(open_url(id, "p.example.com", 3000), "https://ab12cd34-3000-open.p.example.com");
    }

    #[test]
    fn is_service_name_follows_the_hunt_json_pattern() {
        let (longest, too_long) = (format!("a{}", "b".repeat(31)), format!("a{}", "b".repeat(32)));
        for valid in ["a", "med-backend", "ui2", longest.as_str()] {
            assert!(is_service_name(valid), "{valid}");
        }
        for invalid in ["", "2ui", "-ui", "Med", "med_ui", "med.ui", "mëd", too_long.as_str()] {
            assert!(!is_service_name(invalid), "{invalid}");
        }
    }

    #[test]
    fn parse_status_builds_the_urls_here_and_reads_the_unit_runs() {
        let id = Uuid::parse_str(ID).unwrap();
        let output = json!({
            "services": [
                {"name": "med-backend", "port": 3000, "tls": true, "guarded": false, "enabled": true, "state": "running",
                 "responds": true, "url": "https://evil.example", "invocation": "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "uses": ["med-ui"]},
                {"name": "med-ui", "port": 4400, "tls": false, "guarded": true, "enabled": false, "state": "stopped", "responds": false,
                 "invocation": ""}
            ],
            "listening": [5432, 3000],
        });
        let status = parse_status(&output, id, "p.example.com").unwrap();
        assert!(status.vm_running);
        assert_eq!(
            status.services,
            [
                PreviewService {
                    name: "med-backend".into(),
                    port: 3000,
                    url: "https://ab12cd34-3000-open.p.example.com".into(),
                    guarded: false,
                    tls: true,
                    enabled: true,
                    state: PreviewServiceState::Running,
                    responds: true,
                    invocation: Some("0f1e2d3c4b5a69788796a5b4c3d2e1f0".into()),
                    uses: vec!["med-ui".into()],
                    frontend: false,
                },
                PreviewService {
                    name: "med-ui".into(),
                    port: 4400,
                    url: "https://ab12cd34-4400.p.example.com".into(),
                    guarded: true,
                    tls: false,
                    enabled: false,
                    state: PreviewServiceState::Stopped,
                    responds: false,
                    invocation: None,
                    uses: Vec::new(),
                    frontend: false,
                },
            ]
        );
    }

    #[test]
    fn mark_frontends_marks_the_named_services_only() {
        let id = Uuid::parse_str(ID).unwrap();
        let output = json!({"services": [service("api", "running"), service("ui", "running")]});
        let mut status = parse_status(&output, id, "p.example.com").unwrap();
        mark_frontends(&mut status, &["ui".into(), "docs".into()]);
        assert_eq!(status.services.iter().map(|service| service.frontend).collect::<Vec<_>>(), [false, true]);
    }

    #[test]
    fn parse_status_reads_every_state_and_serializes_it_lowercase() {
        let id = Uuid::parse_str(ID).unwrap();
        for (text, state) in [
            ("running", PreviewServiceState::Running),
            ("starting", PreviewServiceState::Starting),
            ("failed", PreviewServiceState::Failed),
            ("stopped", PreviewServiceState::Stopped),
        ] {
            let status = parse_status(&json!({"services": [service("api", text)]}), id, "p.example.com").unwrap();
            assert_eq!(status.services[0].state, state);
            assert_eq!(serde_json::to_value(state).unwrap(), json!(text));
        }
    }

    #[test]
    fn parse_status_rejects_invalid_names_and_shapes() {
        let id = Uuid::parse_str(ID).unwrap();
        assert_eq!(
            parse_status(&json!({"services": [service("../api", "running")]}), id, "p.example.com"),
            Err("failed to read the preview status: \"../api\" is not a service name".to_string())
        );
        let mut uses_invalid = service("api", "running");
        uses_invalid["uses"] = json!(["Ui"]);
        assert_eq!(
            parse_status(&json!({"services": [uses_invalid]}), id, "p.example.com"),
            Err("failed to read the preview status: \"Ui\" is not a service name".to_string())
        );
        for invalid in [
            json!({"services": [service("api", "stopping")]}),
            json!({"services": [{"name": "api", "port": "3000"}]}),
            json!({"main": 4200, "listening": [4200], "mainResponds": true}),
        ] {
            let error = parse_status(&invalid, id, "p.example.com").unwrap_err();
            assert!(error.starts_with("failed to read the preview status: "), "{error}");
        }

        let idle = parse_status(&json!({"services": []}), id, "p.example.com").unwrap();
        assert_eq!(stopped_status(), PreviewStatus { vm_running: false, ..idle });
    }

    #[test]
    fn preview_status_serializes_in_camel_case() {
        let status = PreviewStatus { vm_running: false, services: Vec::new() };
        assert_eq!(serde_json::to_value(status).unwrap(), json!({"vmRunning": false, "services": []}));
    }
}
