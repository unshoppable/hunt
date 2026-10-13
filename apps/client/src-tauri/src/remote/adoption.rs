//! Adopting session VMs no local session knows: VMs the gateway's poller started for `swf` issues, or that another
//! person's Hunt handed off. The labels and metadata of the session VMs are the directory of remote sessions: Hunt lists
//! them, picks the ones to adopt, finds the local checkout of their repository and reads where the session's worktree
//! lies on the VM.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::ssh::Ssh;
use super::vm::{self, SessionVm};
use super::{handoff, shell_command, RemoteOrigin, VmRef};

/// A session VM Hunt adopts, as its labels and metadata describe it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdoptableSession {
    pub id: Uuid,
    pub vm: VmRef,
    /// `hunt-title`, or a title made from the issue or the repository when the VM names none.
    pub title: String,
    /// `<owner>/<repo>` of the session's repository (`hunt-repo`).
    pub repo: String,
    /// The branch the session started on (`hunt-branch`); empty when the VM names none.
    pub branch: String,
    pub origin: RemoteOrigin,
    /// The GitHub issue of a `swf` session (`hunt-issue`).
    pub issue: Option<u64>,
    pub is_running: bool,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// The session VMs of `project` to adopt, in the order listed: every VM in `zone`, the zone of the settings and of the
/// gateway that routes their previews, that names a session (`hunt-session-id`) none of `known` is, whose name and
/// `hunt-session` label belong to that session and whose `hunt-repo` is an `<owner>/<repo>`. VMs that fail these checks
/// are no sessions Hunt can continue and stay alone.
pub fn sessions_to_adopt(vms: &[SessionVm], project: &str, zone: &str, known: &HashSet<Uuid>) -> Vec<AdoptableSession> {
    vms.iter()
        .filter(|listed| listed.zone == zone)
        .filter_map(|listed| adoptable(listed, project))
        .filter(|session| !known.contains(&session.id))
        .collect()
}

fn adoptable(listed: &SessionVm, project: &str) -> Option<AdoptableSession> {
    let id = Uuid::parse_str(listed.metadata.get("hunt-session-id")?.trim()).ok()?;
    if listed.name != vm::session_vm_name(id) || listed.labels.get(vm::SESSION_LABEL) != Some(&vm::short_id(id)) {
        return None;
    }
    let repo = metadata(listed, "hunt-repo");
    if !is_repository_key(&repo) {
        return None;
    }
    let vm = VmRef { project: project.to_string(), zone: listed.zone.clone(), instance: listed.name.clone() };
    vm.validate().ok()?;
    let origin = match listed.labels.get(vm::ORIGIN_LABEL).map(String::as_str) {
        Some("swf") => RemoteOrigin::Swf,
        _ => RemoteOrigin::Desktop,
    };
    let issue = issue_number(&metadata(listed, "hunt-issue"));
    let title = Some(metadata(listed, "hunt-title")).filter(|title| !title.is_empty()).unwrap_or_else(|| match issue {
        Some(issue) => format!("Issue #{issue} of {repo}"),
        None => format!("Remote session of {repo}"),
    });
    Some(AdoptableSession {
        id,
        vm,
        title,
        branch: metadata(listed, "hunt-branch"),
        repo,
        origin,
        issue,
        is_running: listed.status == "RUNNING",
        created_at: listed.created_at,
    })
}

/// The trimmed metadata value `key` of `listed`; empty when it has none.
fn metadata(listed: &SessionVm, key: &str) -> String {
    listed.metadata.get(key).map(|value| value.trim().to_string()).unwrap_or_default()
}

/// Whether `value` is an `<owner>/<repo>` as `hunt-ctl` accepts it: two parts of letters, digits, `-`, `_` and `.`,
/// neither starting with a dot.
pub fn is_repository_key(value: &str) -> bool {
    let is_part = |part: &str| {
        let is_allowed = |character: char| character.is_ascii_alphanumeric() || "-_.".contains(character);
        !part.is_empty() && !part.starts_with('.') && part.chars().all(is_allowed)
    };
    value.split_once('/').is_some_and(|(owner, repo)| is_part(owner) && is_part(repo))
}

/// The issue number at the end of `value`: `123`, `#123`, `acme/app#123` or an issue URL; `None` without one.
pub fn issue_number(value: &str) -> Option<u64> {
    let digits: String = value.trim().chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
    digits.parse().ok().filter(|number| *number > 0)
}

/// The local repositories among `paths` with the `<owner>/<repo>` of their `origin`, in the order of `paths`; paths
/// without such a remote (or that are no repositories any more) and repeated paths are left out.
pub async fn repository_keys(paths: &[PathBuf]) -> Vec<(PathBuf, String)> {
    let mut seen = HashSet::new();
    let mut repositories = Vec::new();
    for path in paths {
        if path.as_os_str().is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        if let Some(key) = handoff::origin_repository_key(path).await {
            repositories.push((path.clone(), key));
        }
    }
    repositories
}

/// The first of `repositories` whose `<owner>/<repo>` is `repo`; GitHub compares both parts without case.
pub fn matching_repository<'a>(repositories: &'a [(PathBuf, String)], repo: &str) -> Option<&'a Path> {
    repositories.iter().find(|(_, key)| key.eq_ignore_ascii_case(repo)).map(|(path, _)| path.as_path())
}

/// What `hunt-ctl` records about a session on its VM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeta {
    /// The absolute path of the session's worktree on the VM.
    pub worktree: String,
    /// The branch the session's worktree was prepared on; `None` before `hunt-ctl prepare`.
    pub branch: Option<String>,
}

/// Reads `meta.json` of a session: `worktree` must be an absolute path on one line.
pub fn parse_session_meta(text: &str) -> Result<SessionMeta, String> {
    let meta: serde_json::Value = serde_json::from_str(text).map_err(|error| format!("failed to read the session's meta.json: {error}"))?;
    let worktree = meta["worktree"].as_str().unwrap_or_default();
    if !worktree.starts_with('/') || worktree.contains(['\n', '\r', '\0']) {
        return Err(format!("failed to read the session's meta.json: {worktree:?} is no worktree path"));
    }
    let branch = meta["branch"].as_str().map(str::trim).filter(|branch| !branch.is_empty()).map(str::to_string);
    Ok(SessionMeta { worktree: worktree.to_string(), branch })
}

/// Reads `meta.json` of session `id` from its running VM behind `ssh`, as Hunt's user or, where that may not read it,
/// as the agent's user or root.
pub async fn read_session_meta(ssh: &Ssh, id: Uuid) -> Result<SessionMeta, String> {
    let path = format!("/srv/hunt/sessions/{id}/meta.json");
    let command = [
        shell_command("cat", &["--", &path]),
        shell_command("sudo", &["-n", "-u", "agent", "cat", "--", &path]),
        shell_command("sudo", &["-n", "cat", "--", &path]),
    ]
    .join(" 2>/dev/null || ");
    let text = ssh.run(&command).await.map_err(|error| format!("failed to find the worktree of session {id} on its VM: {error}"))?;
    parse_session_meta(&text)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    const ID: &str = "ab12cd34-0000-4000-8000-000000000001";
    const ZONE: &str = "europe-west1-c";

    fn listed(name: &str, labels: &[(&str, &str)], metadata: &[(&str, &str)]) -> SessionVm {
        let pairs = |entries: &[(&str, &str)]| {
            entries.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect::<BTreeMap<_, _>>()
        };
        SessionVm {
            name: name.into(),
            zone: ZONE.into(),
            status: "TERMINATED".into(),
            labels: pairs(labels),
            metadata: pairs(metadata),
            created_at: None,
        }
    }

    fn swf_vm() -> SessionVm {
        listed(
            "vm-hunt-s-ab12cd34",
            &[("hunt-session", "ab12cd34"), ("hunt-origin", "swf"), ("hunt-role", "session")],
            &[
                ("hunt-session-id", ID),
                ("hunt-repo", "acme/app"),
                ("hunt-branch", "hunt/123-fix-login"),
                ("hunt-issue", "123"),
                ("hunt-title", " Fix login "),
            ],
        )
    }

    #[test]
    fn sessions_to_adopt_reads_the_labels_and_metadata_of_unknown_sessions() {
        let mut desktop = listed(
            "vm-hunt-s-00000000",
            &[("hunt-session", "00000000"), ("hunt-origin", "desktop")],
            &[("hunt-session-id", "00000000-1111-4000-8000-000000000002"), ("hunt-repo", "acme/app")],
        );
        desktop.status = "RUNNING".into();
        let adopted = sessions_to_adopt(&[swf_vm(), desktop], "acme-hunt", ZONE, &HashSet::new());

        assert_eq!(adopted.len(), 2);
        assert_eq!(adopted[0].id, Uuid::parse_str(ID).unwrap());
        let vm = VmRef { project: "acme-hunt".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() };
        assert_eq!(adopted[0].vm, vm);
        let (title, repo, branch) = (adopted[0].title.as_str(), adopted[0].repo.as_str(), adopted[0].branch.as_str());
        assert_eq!((title, repo, branch), ("Fix login", "acme/app", "hunt/123-fix-login"));
        assert_eq!((adopted[0].origin, adopted[0].issue, adopted[0].is_running), (RemoteOrigin::Swf, Some(123), false));
        assert_eq!((adopted[1].title.as_str(), adopted[1].branch.as_str()), ("Remote session of acme/app", ""));
        assert_eq!((adopted[1].origin, adopted[1].issue, adopted[1].is_running), (RemoteOrigin::Desktop, None, true));
    }

    #[test]
    fn sessions_to_adopt_skips_known_sessions_vms_of_other_zones_and_vms_that_do_not_belong_to_their_session() {
        let known = HashSet::from([Uuid::parse_str(ID).unwrap()]);
        assert!(sessions_to_adopt(&[swf_vm()], "acme-hunt", ZONE, &known).is_empty());

        let mut wrong_name = swf_vm();
        wrong_name.name = "vm-hunt-medc".into();
        let mut wrong_label = swf_vm();
        wrong_label.labels.insert("hunt-session".into(), "ffffffff".into());
        let mut no_id = swf_vm();
        no_id.metadata.remove("hunt-session-id");
        let mut bad_id = swf_vm();
        bad_id.metadata.insert("hunt-session-id".into(), "not-a-uuid".into());
        let mut no_repo = swf_vm();
        no_repo.metadata.remove("hunt-repo");
        let mut bad_repo = swf_vm();
        bad_repo.metadata.insert("hunt-repo".into(), "../etc".into());
        let mut bad_zone = swf_vm();
        bad_zone.zone = "Europe West".into();
        let mut other_zone = swf_vm();
        other_zone.zone = "us-central1-a".into();
        let vms = [wrong_name, wrong_label, no_id, bad_id, no_repo, bad_repo, bad_zone, other_zone];
        assert!(sessions_to_adopt(&vms, "acme-hunt", ZONE, &HashSet::new()).is_empty());
    }

    #[test]
    fn a_swf_vm_without_title_is_named_after_its_issue() {
        let mut vm = swf_vm();
        vm.metadata.remove("hunt-title");
        assert_eq!(sessions_to_adopt(&[vm], "acme-hunt", ZONE, &HashSet::new())[0].title, "Issue #123 of acme/app");
    }

    #[test]
    fn issue_number_takes_the_trailing_digits() {
        assert_eq!(issue_number("123"), Some(123));
        assert_eq!(issue_number(" #45 "), Some(45));
        assert_eq!(issue_number("acme/app#7"), Some(7));
        assert_eq!(issue_number("https://github.com/acme/app/issues/1454"), Some(1454));
        assert_eq!(issue_number(""), None);
        assert_eq!(issue_number("none"), None);
        assert_eq!(issue_number("0"), None);
    }

    #[test]
    fn is_repository_key_accepts_owner_and_repo_only() {
        assert!(is_repository_key("unshoppable/app-framework"));
        assert!(is_repository_key("a_b/c.d"));
        for value in ["", "app", "/app", "acme/", "acme/app/extra", ".hidden/app", "acme/.git", "ac me/app"] {
            assert!(!is_repository_key(value), "{value}");
        }
    }

    #[test]
    fn matching_repository_compares_owner_and_repo_without_case() {
        let repositories = vec![
            (PathBuf::from("/src/other"), "acme/other".to_string()),
            (PathBuf::from("/src/app"), "Acme/App".to_string()),
        ];
        assert_eq!(matching_repository(&repositories, "acme/app"), Some(Path::new("/src/app")));
        assert_eq!(matching_repository(&repositories, "acme/missing"), None);
        assert_eq!(matching_repository(&[], "acme/app"), None);
    }

    #[tokio::test]
    async fn repository_keys_reads_the_origin_of_each_repository_once() {
        let dir = tempfile::tempdir().unwrap();
        let (with_origin, without_origin) = (dir.path().join("app"), dir.path().join("scratch"));
        for (path, origin) in [(&with_origin, Some("git@github.com:acme/app.git")), (&without_origin, None)] {
            std::fs::create_dir_all(path).unwrap();
            crate::git::run_git(path, &["init", "-q"]).await.unwrap();
            if let Some(origin) = origin {
                crate::git::run_git(path, &["remote", "add", "origin", origin]).await.unwrap();
            }
        }
        let paths = [with_origin.clone(), without_origin, with_origin.clone(), PathBuf::new(), dir.path().join("missing")];
        assert_eq!(repository_keys(&paths).await, vec![(with_origin, "acme/app".to_string())]);
    }

    #[test]
    fn parse_session_meta_reads_the_worktree_and_branch() {
        let meta = parse_session_meta(r#"{"repo":"acme/app","worktree":"/home/agent/app","createdAt":1,"branch":"hunt/x"}"#).unwrap();
        assert_eq!(meta, SessionMeta { worktree: "/home/agent/app".into(), branch: Some("hunt/x".into()) });
        assert_eq!(parse_session_meta(r#"{"worktree":"/srv/worktrees/x","branch":" "}"#).unwrap().branch, None);
        assert!(parse_session_meta(r#"{"worktree":"relative"}"#).is_err());
        assert!(parse_session_meta(r#"{"repo":"acme/app"}"#).is_err());
        assert!(parse_session_meta("not json").is_err());
    }
}
