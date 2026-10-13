//! The configuration of the gateway's poller `hunt-swf` (`apps/gateway/src/swf.ts`), which starts a session VM for every
//! open GitHub issue labelled `swf` in the configured repositories. Hunt sends the repositories, the session limit and
//! the machine type through the gateway API (`swf.applyConfig`); the gateway adds the label and the instance template,
//! stores it and the poller reads it before every round.

use serde::{Deserialize, Serialize};

use super::{adoption, is_compute_name};

/// The most sessions the poller may run at once.
pub const MAX_SESSIONS_LIMIT: u32 = 10;

/// The poller's configuration as the gateway stored it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SwfConfig {
    /// `<owner>/<repo>` of every repository whose issues the poller reads; empty keeps it idle.
    pub repos: Vec<String>,
    /// How many session VMs the poller started may run at once.
    pub max_sessions: u32,
    pub label: String,
    /// The instance template the poller creates session VMs from.
    pub template: String,
    /// A machine type other than the template's.
    pub machine_type: Option<String>,
}

/// What Hunt asks the gateway to store for the poller.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SwfRequest {
    pub repos: Vec<String>,
    pub max_sessions: u32,
    pub machine_type: Option<String>,
}

impl SwfRequest {
    /// The request for `repos` (trimmed, blank ones left out), `max_sessions` and `machine_type`.
    pub fn new(repos: Vec<String>, max_sessions: u32, machine_type: Option<String>) -> Self {
        let repos = repos.iter().map(|repo| repo.trim().to_string()).filter(|repo| !repo.is_empty()).collect();
        SwfRequest { repos, max_sessions, machine_type }
    }

    /// Rejects repositories that are no `<owner>/<repo>`, a limit above `MAX_SESSIONS_LIMIT` and a machine type that is
    /// no Compute Engine name.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(repo) = self.repos.iter().find(|repo| !adoption::is_repository_key(repo)) {
            return Err(format!("failed to use the repository {repo:?} for the poller: expected <owner>/<repo>"));
        }
        if self.max_sessions > MAX_SESSIONS_LIMIT {
            return Err(format!("failed to use {} parallel sessions for the poller: at most {MAX_SESSIONS_LIMIT} are allowed", self.max_sessions));
        }
        if let Some(machine_type) = self.machine_type.as_deref().filter(|machine_type| !is_compute_name(machine_type)) {
            return Err(format!("failed to use the machine type {machine_type:?}: it is not a valid Compute Engine name"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_trims_the_repositories_and_serializes_in_the_shape_of_the_contract() {
        let request = SwfRequest::new(vec![" acme/app ".into(), " ".into()], 2, Some("e2-standard-8".into()));
        assert_eq!(request, SwfRequest { repos: vec!["acme/app".into()], max_sessions: 2, machine_type: Some("e2-standard-8".into()) });
        assert_eq!(request.validate(), Ok(()));
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json, serde_json::json!({ "repos": ["acme/app"], "maxSessions": 2, "machineType": "e2-standard-8" }));
    }

    #[test]
    fn the_stored_configuration_reads_what_the_gateway_returns() {
        let stored = serde_json::json!({ "repos": ["acme/app"], "maxSessions": 3, "label": "swf", "template": "tpl-hunt-session", "machineType": null });
        let config: SwfConfig = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!((config.label.as_str(), config.template.as_str(), config.max_sessions), ("swf", "tpl-hunt-session", 3));
        assert_eq!(serde_json::to_value(&config).unwrap(), stored);
    }

    #[test]
    fn validate_rejects_foreign_repositories_large_limits_and_invalid_machine_types() {
        let request = SwfRequest::new(vec![], 0, None);
        assert_eq!(request.validate(), Ok(()));
        for repo in ["app", "acme/app/x", ".acme/app", "acme/app;rm"] {
            let invalid = SwfRequest { repos: vec![repo.into()], ..request.clone() };
            assert!(invalid.validate().is_err(), "{repo}");
        }
        assert!(SwfRequest { max_sessions: MAX_SESSIONS_LIMIT + 1, ..request.clone() }.validate().is_err());
        assert!(SwfRequest { machine_type: Some("e2 standard".into()), ..request }.validate().is_err());
    }
}
