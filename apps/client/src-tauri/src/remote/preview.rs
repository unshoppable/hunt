//! Session previews: the gateway routes `https://<short>.<domain>` to the main port the repository's hunt.json names and
//! `https://<short>-<port>.<domain>` to any port of the session's VM, where the agent runs the app as a developer would
//! locally. `hunt-ctl preview-status` reports which ports listen; this module builds the URLs from the session id and
//! the domain, so the VM only reports port numbers.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::vm::short_id;

/// The longest preview domain: `<short>-<port>.` in front of it must fit into the 253 characters of a host name.
const MAX_DOMAIN_LENGTH: usize = 253 - "01234567-65535.".len();

/// The preview domain from the settings, lowercased, or an error unless it is a host name of at least two labels whose
/// last label consists of 2 to 63 letters. `hunt-ctl` (`DOMAIN_PATTERN`), `apps/session/src/config.ts` and
/// `src/state/settings.ts` check the same.
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

/// The URL of session `id`'s preview on `domain`: the main host, or the host of `port`.
pub fn url(id: Uuid, domain: &str, port: Option<u16>) -> String {
    let short = short_id(id);
    match port {
        Some(port) => format!("https://{short}-{port}.{domain}"),
        None => format!("https://{short}.{domain}"),
    }
}

/// What the UI shows of a session's preview.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    /// Whether the session's VM runs; when it is off, nothing listens and the rest is empty.
    pub vm_running: bool,
    /// `https://<short>.<domain>`, which serves the main port.
    pub main_url: String,
    /// The main port the repository's hunt.json names, if any.
    pub main: Option<u16>,
    /// The ports something listens on, in ascending order.
    pub listening: Vec<PreviewPort>,
    /// Whether the main port answers HTTP requests.
    pub main_responds: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPort {
    pub port: u16,
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusOutput {
    main: Option<u16>,
    #[serde(default)]
    listening: Vec<u16>,
    #[serde(default)]
    main_responds: bool,
}

/// Reads the output of `hunt-ctl preview-status` for session `id` with its URLs on `domain`.
pub fn parse_status(output: &serde_json::Value, id: Uuid, domain: &str) -> Result<PreviewStatus, String> {
    let output: StatusOutput = serde_json::from_value(output.clone()).map_err(|error| format!("failed to read the preview status: {error}"))?;
    let mut ports = output.listening;
    ports.sort_unstable();
    ports.dedup();
    Ok(PreviewStatus {
        vm_running: true,
        main_url: url(id, domain, None),
        main: output.main,
        listening: ports.into_iter().map(|port| PreviewPort { port, url: url(id, domain, Some(port)) }).collect(),
        main_responds: output.main_responds,
    })
}

/// The status of session `id` whose VM is off: its URLs exist, but nothing listens.
pub fn stopped_status(id: Uuid, domain: &str) -> PreviewStatus {
    PreviewStatus { vm_running: false, main_url: url(id, domain, None), main: None, listening: Vec::new(), main_responds: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "ab12cd34-0000-4000-8000-000000000001";

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
        assert!(validate_domain(&domain_of_length(238)).is_ok());
        assert!(validate_domain(&domain_of_length(239)).is_err());
    }

    #[test]
    fn url_builds_the_main_and_port_hosts_from_the_short_id() {
        let id = Uuid::parse_str(ID).unwrap();
        assert_eq!(url(id, "p.example.com", None), "https://ab12cd34.p.example.com");
        assert_eq!(url(id, "p.example.com", Some(4400)), "https://ab12cd34-4400.p.example.com");
    }

    #[test]
    fn parse_status_builds_the_urls_of_the_listening_ports_here() {
        let id = Uuid::parse_str(ID).unwrap();
        let output = json!({"main": 4200, "listening": [4400, 4200, 3000, 4200], "mainResponds": true, "url": "https://evil.example"});
        let status = parse_status(&output, id, "p.example.com").unwrap();
        assert!(status.vm_running && status.main_responds);
        assert_eq!(status.main_url, "https://ab12cd34.p.example.com");
        assert_eq!(status.main, Some(4200));
        let ports: Vec<(u16, &str)> = status.listening.iter().map(|port| (port.port, port.url.as_str())).collect();
        assert_eq!(
            ports,
            [(3000, "https://ab12cd34-3000.p.example.com"), (4200, "https://ab12cd34-4200.p.example.com"), (4400, "https://ab12cd34-4400.p.example.com")]
        );

        let idle = parse_status(&json!({"main": null, "listening": [], "mainResponds": false}), id, "p.example.com").unwrap();
        assert_eq!((idle.main, idle.listening.len(), idle.main_responds), (None, 0, false));
        assert!(parse_status(&json!({"main": "4200"}), id, "p.example.com").is_err());
        assert_eq!(stopped_status(id, "p.example.com"), PreviewStatus { vm_running: false, ..idle });
    }
}
