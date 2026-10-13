//! The configuration of the gateway's poller `hunt-swf` (`remote/gateway/swf.ts`), which starts a session VM for every
//! open GitHub issue labelled `swf` in the configured repositories. Hunt writes it to the gateway's
//! `/etc/hunt/swf.json` through `hunt-ctl swf-config`; the poller reads it before every round.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::ssh::Ssh;
use super::{adoption, bundle, hunt_ctl_with_input, vm, Progress, VmSettings};

/// The label the poller looks for on issues.
pub const SWF_LABEL: &str = "swf";

/// The most sessions the poller may run at once.
pub const MAX_SESSIONS_LIMIT: u32 = 10;

/// What the poller reads from `/etc/hunt/swf.json`; `hunt-ctl swf-config` prints it back as stored.
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

impl SwfConfig {
    /// The configuration for `repos` and `max_sessions` with the label `swf` and the session VMs of `settings`.
    pub fn new(settings: &VmSettings, repos: Vec<String>, max_sessions: u32) -> Self {
        let repos = repos.iter().map(|repo| repo.trim().to_string()).filter(|repo| !repo.is_empty()).collect();
        SwfConfig { repos, max_sessions, label: SWF_LABEL.to_string(), template: settings.template.clone(), machine_type: settings.machine_type.clone() }
    }

    /// Rejects repositories that are no `<owner>/<repo>`, a limit above `MAX_SESSIONS_LIMIT` and label, template or
    /// machine type values that `hunt-ctl` and the Compute Engine API would refuse.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(repo) = self.repos.iter().find(|repo| !adoption::is_repository_key(repo)) {
            return Err(format!("failed to use the repository {repo:?} for the poller: expected <owner>/<repo>"));
        }
        if self.max_sessions > MAX_SESSIONS_LIMIT {
            return Err(format!("failed to use {} parallel sessions for the poller: at most {MAX_SESSIONS_LIMIT} are allowed", self.max_sessions));
        }
        let is_label = !self.label.is_empty()
            && self.label.len() <= 50
            && self.label.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || ":_-".contains(character));
        if !is_label {
            return Err(format!("failed to use the issue label {:?} for the poller", self.label));
        }
        let is_name = |value: &str| !value.is_empty() && value.chars().all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-');
        if !is_name(&self.template) {
            return Err(format!("failed to use the session VM template {:?}: it is not a valid Compute Engine name", self.template));
        }
        if let Some(machine_type) = self.machine_type.as_deref().filter(|machine_type| !is_name(machine_type)) {
            return Err(format!("failed to use the machine type {machine_type:?}: it is not a valid Compute Engine name"));
        }
        Ok(())
    }
}

/// Writes `config` to the gateway of `settings` (validated) and returns what the gateway stored. The gateway gets the
/// bundle in `bundle_dir` first, since an older release has no `hunt-ctl swf-config` and no poller.
pub async fn apply(settings: &VmSettings, bundle_dir: &Path, ssh_dir: &Path, config: &SwfConfig, progress: Progress<'_>) -> Result<SwfConfig, String> {
    config.validate()?;
    let gateway = settings.gateway_vm();
    let ssh = Ssh::open(&gateway, ssh_dir).await?;
    vm::ensure_running(&gateway, &ssh, progress).await?;
    bundle::ensure_installed(&ssh, bundle_dir, &["--domain", &settings.preview_domain], progress).await?;
    let input = serde_json::to_vec(config).map_err(|error| format!("failed to write the poller configuration: {error}"))?;
    let stored = hunt_ctl_with_input(&ssh, &["swf-config"], &input).await?;
    serde_json::from_value(stored).map_err(|error| format!("failed to read the poller configuration the gateway stored: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> VmSettings {
        VmSettings {
            project: "acme".into(),
            zone: "europe-west1-c".into(),
            gateway: "vm-hunt-medc".into(),
            template: "tpl-hunt-session".into(),
            machine_type: None,
            preview_domain: "hunt.example.com".into(),
        }
    }

    #[test]
    fn new_takes_the_label_template_and_machine_type_and_trims_the_repositories() {
        let config = SwfConfig::new(&VmSettings { machine_type: Some("e2-standard-8".into()), ..settings() }, vec![" acme/app ".into(), " ".into()], 2);
        assert_eq!(
            config,
            SwfConfig {
                repos: vec!["acme/app".into()],
                max_sessions: 2,
                label: "swf".into(),
                template: "tpl-hunt-session".into(),
                machine_type: Some("e2-standard-8".into()),
            }
        );
        assert_eq!(config.validate(), Ok(()));
    }

    #[test]
    fn serializes_in_the_shape_hunt_ctl_reads() {
        let config = SwfConfig::new(&settings(), vec!["acme/app".into()], 3);
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json, serde_json::json!({ "repos": ["acme/app"], "maxSessions": 3, "label": "swf", "template": "tpl-hunt-session", "machineType": null }));
        assert_eq!(serde_json::from_value::<SwfConfig>(json).unwrap(), config);
    }

    #[test]
    fn validate_rejects_foreign_repositories_large_limits_and_invalid_names() {
        let config = SwfConfig::new(&settings(), vec![], 0);
        assert_eq!(config.validate(), Ok(()));
        for repo in ["app", "acme/app/x", ".acme/app", "acme/app;rm"] {
            let invalid = SwfConfig { repos: vec![repo.into()], ..config.clone() };
            assert!(invalid.validate().is_err(), "{repo}");
        }
        assert!(SwfConfig { max_sessions: MAX_SESSIONS_LIMIT + 1, ..config.clone() }.validate().is_err());
        assert!(SwfConfig { label: "".into(), ..config.clone() }.validate().is_err());
        assert!(SwfConfig { label: "Swf Label".into(), ..config.clone() }.validate().is_err());
        assert!(SwfConfig { label: "swf:running".into(), ..config.clone() }.validate().is_ok());
        assert!(SwfConfig { template: "Tpl".into(), ..config.clone() }.validate().is_err());
        assert!(SwfConfig { machine_type: Some("e2 standard".into()), ..config }.validate().is_err());
    }
}
