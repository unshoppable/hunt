//! The server release on the session VMs. CI deploys the server apps onto the gateway, which installs its staged session
//! release on a session VM whenever it provisions or starts it (`sessions.provision`, `vms.start`); the app only checks
//! that a VM speaks its protocol and has the VM install the agent's tools its image lacks.

use serde::Deserialize;

use super::ssh::Ssh;
use super::{hunt_ctl, Progress, RemoteStep};

/// The numbers of `hunt-ctl` and relay protocol (`protocol`) and of the gateway API (`api`) this app speaks, shared with
/// the server apps.
pub(super) const PROTOCOL_JSON: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../libs/domain/protocol.json"));

#[derive(Deserialize)]
struct ProtocolFile {
    protocol: u32,
}

/// What `hunt-ctl version` reports; every field is null on a VM without a release.
#[derive(Deserialize)]
struct ReleaseVersion {
    version: Option<String>,
    protocol: Option<u32>,
}

/// The protocol this app speaks.
pub fn protocol() -> u32 {
    serde_json::from_str::<ProtocolFile>(PROTOCOL_JSON).expect("libs/domain/protocol.json holds a protocol number").protocol
}

/// Makes sure the session VM behind `ssh`, which the gateway started or provisioned, can run the agent: its release speaks
/// this app's protocol, and the agent's tools that the release pins are installed (`hunt-ctl install-tools` skips those
/// at their version already, so a repeated call is cheap).
pub async fn ensure_ready(ssh: &Ssh, progress: Progress<'_>) -> Result<(), String> {
    let output = hunt_ctl(ssh, &["version"]).await?;
    let release: ReleaseVersion = serde_json::from_value(output).map_err(|error| format!("failed to read the VM's release version: {error}"))?;
    check(&release, protocol())?;
    progress.step(RemoteStep::InstallingRuntime);
    hunt_ctl(ssh, &["install-tools"]).await?;
    Ok(())
}

/// Accepts a release of protocol `expected`; otherwise the error says which side has to catch up.
fn check(release: &ReleaseVersion, expected: u32) -> Result<(), String> {
    let version = release.version.as_deref().unwrap_or("without a version");
    match release.protocol {
        Some(found) if found == expected => Ok(()),
        Some(found) if found > expected => Err(format!(
            "failed to use the VM: its Hunt release {version} speaks protocol {found}, this app {expected}; update Hunt in Settings → Updates"
        )),
        found => Err(format!(
            "failed to use the VM: its Hunt release {version} speaks protocol {}, this app {expected}; the gateway's session release is older and is updated with the next server deploy",
            found.map_or_else(|| "none".to_string(), |found| found.to_string())
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_reads_the_shared_protocol_file() {
        assert!(protocol() >= 1);
    }

    #[test]
    fn release_version_accepts_a_vm_without_a_release() {
        let release: ReleaseVersion = serde_json::from_value(serde_json::json!({ "version": null, "hash": null, "protocol": null })).unwrap();
        assert_eq!((release.version, release.protocol), (None, None));
    }

    #[test]
    fn check_accepts_the_same_protocol_and_names_the_side_that_must_catch_up() {
        let release = |protocol: Option<u32>| ReleaseVersion { version: Some("1.4.0".into()), protocol };
        assert_eq!(check(&release(Some(2)), 2), Ok(()));
        assert!(check(&release(Some(3)), 2).unwrap_err().contains("update Hunt in Settings → Updates"));
        let older = check(&release(Some(1)), 2).unwrap_err();
        assert!(older.contains("speaks protocol 1, this app 2") && older.contains("next server deploy"), "{older}");
        let none = check(&ReleaseVersion { version: None, protocol: None }, 2).unwrap_err();
        assert!(none.contains("release without a version speaks protocol none"), "{none}");
    }
}
