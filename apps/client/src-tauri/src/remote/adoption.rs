//! Adopting session VMs no local session knows: VMs the gateway's poller started for `swf` issues, or that another
//! person's Hunt handed off. The gateway's listing of the sessions (`sessions.list`, from the labels and metadata of the
//! session VMs) is the directory of remote sessions: Hunt picks the ones to adopt, finds the local checkout of their
//! repository and reads where the session's worktree lies on the VM.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::api::SessionSummary;
use super::ssh::Ssh;
use super::{handoff, shell_command, vm, RemoteOrigin, VmRef};

/// A session VM Hunt adopts, as the gateway lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdoptableSession {
    pub id: Uuid,
    pub vm: VmRef,
    /// The session's title, or one made from the issue or the repository when the VM names none.
    pub title: String,
    /// `<owner>/<repo>` of the session's repository.
    pub repo: String,
    /// The branch the session started on; empty when the VM names none.
    pub branch: String,
    pub origin: RemoteOrigin,
    /// The GitHub issue of a `swf` session.
    pub issue: Option<u64>,
    pub is_running: bool,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// The sessions of `listed` to adopt, in the order listed: every session whose VM is in `project` and `zone`, the
/// gateway's, that none of `known` is, whose VM is named after it and whose repository is an `<owner>/<repo>`. Sessions
/// that fail these checks are no sessions Hunt can continue and stay alone.
pub fn sessions_to_adopt(listed: &[SessionSummary], project: &str, zone: &str, known: &HashSet<Uuid>) -> Vec<AdoptableSession> {
    listed
        .iter()
        .filter(|session| session.zone == zone)
        .filter_map(|session| adoptable(session, project))
        .filter(|session| !known.contains(&session.id))
        .collect()
}

fn adoptable(listed: &SessionSummary, project: &str) -> Option<AdoptableSession> {
    let id = Uuid::parse_str(listed.id.trim()).ok()?;
    if listed.vm != vm::session_vm_name(id) {
        return None;
    }
    let repo = listed.repo.trim().to_string();
    if !is_repository_key(&repo) {
        return None;
    }
    let vm = VmRef { project: project.to_string(), zone: listed.zone.clone(), instance: listed.vm.clone() };
    vm.validate().ok()?;
    let origin = if listed.origin == "swf" { RemoteOrigin::Swf } else { RemoteOrigin::Desktop };
    let issue = listed.issue.filter(|issue| *issue > 0);
    let title = Some(listed.title.trim().to_string()).filter(|title| !title.is_empty()).unwrap_or_else(|| match issue {
        Some(issue) => format!("Issue #{issue} of {repo}"),
        None => format!("Remote session of {repo}"),
    });
    Some(AdoptableSession {
        id,
        vm,
        title,
        branch: listed.branch.trim().to_string(),
        repo,
        origin,
        issue,
        is_running: listed.status == "RUNNING",
        created_at: chrono::DateTime::parse_from_rfc3339(&listed.created_at).ok().map(|time| time.with_timezone(&chrono::Utc)),
    })
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
    use super::*;

    const ID: &str = "ab12cd34-0000-4000-8000-000000000001";
    const ZONE: &str = "europe-west1-c";

    fn swf_session() -> SessionSummary {
        SessionSummary {
            id: ID.into(),
            vm: "vm-hunt-s-ab12cd34".into(),
            zone: ZONE.into(),
            status: "TERMINATED".into(),
            origin: "swf".into(),
            repo: "acme/app".into(),
            branch: "hunt/123-fix-login".into(),
            title: " Fix login ".into(),
            issue: Some(123),
            created_at: "2026-10-12T03:04:05.678-07:00".into(),
        }
    }

    #[test]
    fn sessions_to_adopt_reads_the_listing_of_unknown_sessions() {
        let desktop = SessionSummary {
            id: "00000000-1111-4000-8000-000000000002".into(),
            vm: "vm-hunt-s-00000000".into(),
            status: "RUNNING".into(),
            origin: "desktop".into(),
            branch: "".into(),
            title: "".into(),
            issue: None,
            created_at: "".into(),
            ..swf_session()
        };
        let adopted = sessions_to_adopt(&[swf_session(), desktop], "acme-hunt", ZONE, &HashSet::new());

        assert_eq!(adopted.len(), 2);
        assert_eq!(adopted[0].id, Uuid::parse_str(ID).unwrap());
        let vm = VmRef { project: "acme-hunt".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() };
        assert_eq!(adopted[0].vm, vm);
        let (title, repo, branch) = (adopted[0].title.as_str(), adopted[0].repo.as_str(), adopted[0].branch.as_str());
        assert_eq!((title, repo, branch), ("Fix login", "acme/app", "hunt/123-fix-login"));
        assert_eq!((adopted[0].origin, adopted[0].issue, adopted[0].is_running), (RemoteOrigin::Swf, Some(123), false));
        assert_eq!(adopted[0].created_at.map(|time| time.to_rfc3339()).as_deref(), Some("2026-10-12T10:04:05.678+00:00"));
        assert_eq!((adopted[1].title.as_str(), adopted[1].branch.as_str()), ("Remote session of acme/app", ""));
        assert_eq!((adopted[1].origin, adopted[1].issue, adopted[1].is_running), (RemoteOrigin::Desktop, None, true));
        assert_eq!(adopted[1].created_at, None);
    }

    #[test]
    fn sessions_to_adopt_skips_known_sessions_vms_of_other_zones_and_vms_that_do_not_belong_to_their_session() {
        let known = HashSet::from([Uuid::parse_str(ID).unwrap()]);
        assert!(sessions_to_adopt(&[swf_session()], "acme-hunt", ZONE, &known).is_empty());

        let listed = [
            SessionSummary { vm: "vm-hunt-medc".into(), ..swf_session() },
            SessionSummary { vm: "vm-hunt-s-ffffffff".into(), ..swf_session() },
            SessionSummary { id: "".into(), ..swf_session() },
            SessionSummary { id: "not-a-uuid".into(), ..swf_session() },
            SessionSummary { repo: "".into(), ..swf_session() },
            SessionSummary { repo: "../etc".into(), ..swf_session() },
            SessionSummary { zone: "us-central1-a".into(), ..swf_session() },
        ];
        assert!(sessions_to_adopt(&listed, "acme-hunt", ZONE, &HashSet::new()).is_empty());
        assert!(sessions_to_adopt(&[swf_session()], "Acme Hunt", ZONE, &HashSet::new()).is_empty());
    }

    #[test]
    fn a_swf_session_without_title_is_named_after_its_issue() {
        let untitled = SessionSummary { title: " ".into(), ..swf_session() };
        assert_eq!(sessions_to_adopt(&[untitled], "acme-hunt", ZONE, &HashSet::new())[0].title, "Issue #123 of acme/app");
        let without_issue = SessionSummary { title: "".into(), issue: Some(0), ..swf_session() };
        let adopted = sessions_to_adopt(&[without_issue], "acme-hunt", ZONE, &HashSet::new());
        assert_eq!((adopted[0].title.as_str(), adopted[0].issue), ("Remote session of acme/app", None));
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
