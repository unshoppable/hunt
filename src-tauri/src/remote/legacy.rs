//! Sessions handed off before every session got a VM of its own (`RemoteTarget::is_legacy`). Their record names the VM
//! all sessions shared, today's gateway, which runs the `hunt-ctl` of that time until a handoff installs the current
//! bundle there: each session lives in a container, its worktree in `/srv/worktrees/<id>` and its relay socket in
//! `/srv/hunt/sockets/<id>/acp.sock`. That `hunt-ctl` takes `start`, `wait`, `clear`, `stop`, `snapshot`,
//! `upload-pack`, `lfs-get`, `get-claude` and `destroy` with the arguments of today's, so Hunt connects to these
//! sessions and brings them back as usual, except that it installs nothing on the gateway, reaches the relay through
//! the old socket and finally removes the session from the gateway instead of deleting a VM.

use std::path::Path;

use uuid::Uuid;

use super::ssh::Ssh;
use super::{hunt_ctl, shell_command, RemoteTarget};

/// The command that connects to the relay of the legacy session `id` on the gateway.
pub fn relay_command(id: Uuid) -> String {
    let socket = format!("UNIX-CONNECT:/srv/hunt/sockets/{id}/acp.sock");
    shell_command("sudo", &["-n", "-u", "hunt", "socat", "-", &socket])
}

/// Refuses a handoff while one of `sessions`, the ID, title and remote side of every stored session, is a legacy
/// session: the handoff installs the current bundle on the gateway, which stops the old `hunt-ctl` from serving them.
pub fn ensure_none<'a>(sessions: impl IntoIterator<Item = (Uuid, &'a str, Option<&'a RemoteTarget>)>) -> Result<(), String> {
    let titles: Vec<String> = sessions
        .into_iter()
        .filter(|(id, _, target)| target.is_some_and(|target| target.is_legacy(*id)))
        .map(|(_, title, _)| format!("{title:?}"))
        .collect();
    if titles.is_empty() {
        return Ok(());
    }
    Err(format!(
        "failed to hand off the session: bring back the remote sessions an older Hunt version handed off first ({}); a handoff \
         now would update the gateway they run on, after which they could neither run nor come back",
        titles.join(", ")
    ))
}

/// Removes the legacy session `id` of `target` from the gateway with the `hunt-ctl destroy` of its time: its
/// containers, network, worktree and files. The gateway itself stays.
pub async fn destroy(target: &RemoteTarget, id: Uuid, ssh_dir: &Path) -> Result<(), String> {
    let ssh = Ssh::open(&target.vm, ssh_dir).await?;
    hunt_ctl(&ssh, &["destroy", &id.to_string()]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::remote::{RemoteOrigin, VmRef};

    const ID: &str = "ab12cd34-0000-4000-8000-000000000001";

    fn target(instance: &str, worktree: &str) -> RemoteTarget {
        RemoteTarget {
            vm: VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: instance.into() },
            worktree_path: PathBuf::from(worktree),
            repo: "acme/app".into(),
            branch: "hunt/x".into(),
            handoff_head: "abc".into(),
            handed_off_at: chrono::Utc::now(),
            local_mode: None,
            last_active_at: None,
            cleanup_asked_at: None,
            preview_domain: None,
            origin: RemoteOrigin::Handoff,
            issue: None,
        }
    }

    #[test]
    fn a_session_is_legacy_unless_its_record_names_its_own_vm() {
        let id = Uuid::parse_str(ID).unwrap();
        assert!(!target("vm-hunt-s-ab12cd34", "/home/agent/app").is_legacy(id));
        assert!(target("vm-hunt-medc", &format!("/srv/worktrees/{id}")).is_legacy(id));
        assert!(target("vm-hunt-s-00000000", "/home/agent/app").is_legacy(id));
    }

    #[test]
    fn ensure_none_blocks_a_handoff_while_legacy_sessions_exist_and_names_them() {
        let (own, legacy, other_legacy) = (Uuid::parse_str(ID).unwrap(), Uuid::new_v4(), Uuid::new_v4());
        let on_own_vm = target("vm-hunt-s-ab12cd34", "/home/agent/app");
        let on_gateway = target("vm-hunt-medc", &format!("/srv/worktrees/{legacy}"));

        assert_eq!(ensure_none([(own, "Own VM", Some(&on_own_vm)), (Uuid::new_v4(), "Local", None)]), Ok(()));
        assert_eq!(ensure_none([]), Ok(()));

        let blocked = ensure_none([
            (own, "Own VM", Some(&on_own_vm)),
            (legacy, "Fix \"login\"", Some(&on_gateway)),
            (other_legacy, "Old one", Some(&on_gateway)),
            (Uuid::new_v4(), "Local", None),
        ])
        .unwrap_err();
        assert!(blocked.starts_with("failed to hand off the session: bring back the remote sessions an older Hunt version"), "{blocked}");
        assert!(blocked.contains(r#"("Fix \"login\"", "Old one")"#), "{blocked}");
        assert!(!blocked.contains("Own VM") && !blocked.contains("Local"), "{blocked}");
    }

    #[test]
    fn relay_command_connects_to_the_sessions_socket_on_the_gateway_as_hunt() {
        let id = Uuid::parse_str(ID).unwrap();
        assert_eq!(relay_command(id), format!("sudo -n -u hunt socat - UNIX-CONNECT:/srv/hunt/sockets/{ID}/acp.sock"));
    }
}
