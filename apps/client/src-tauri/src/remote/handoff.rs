//! Moving a session from the local worktree to a VM of its own, which the gateway provisions (`sessions.provision`): the
//! session's branch and uncommitted work (as a snapshot commit), the Git LFS objects of its checkout, the ignored files
//! it needs to run, and its Claude Code transcript. Afterwards `hunt-ctl` configures the session's environment and
//! preview proxy, installs the dependencies and starts the relay.

use std::path::{Path, PathBuf};

use glob::{MatchOptions, Pattern};
use serde_json::json;
use uuid::Uuid;

use super::api::{GatewayApi, ProvisionRequest};
use super::ssh::{self, Ssh};
use super::{hunt_ctl, hunt_ctl_with_input, release, tar_create, Progress, RemoteOrigin, RemoteStep, RemoteTarget, VmRef};
use super::{memory, transcript};
use crate::git;

/// Where the agent's `~/.claude` lives on the VM; transcripts there name this path.
pub const REMOTE_CLAUDE_DIR: &str = "/home/agent/.claude";

/// The permission mode the relay runs the agent in: nobody is there to answer permission requests.
pub const REMOTE_MODE: &str = "bypassPermissions";

/// Everything a handoff needs from the session and the settings.
pub struct HandoffRequest<'a> {
    pub hunt_session_id: Uuid,
    /// The session's title, which its VM records in its metadata.
    pub title: &'a str,
    pub worktree: &'a Path,
    pub acp_session_id: Option<&'a str>,
    /// The gateway that provisions the session's VM and routes its previews; validated.
    pub gateway: &'a VmRef,
    /// The machine type of the session's VM if the gateway creates it; `None` keeps the template's.
    pub machine_type: Option<&'a str>,
    /// Hunt's SSH key and known hosts.
    pub ssh_dir: &'a Path,
    /// The local `~/.claude`.
    pub claude_dir: &'a Path,
    /// Where Hunt keeps the base of the repository memory the handoff sends, for the retrieval's merge.
    pub memory_base: &'a Path,
    /// Ignored files to copy, as glob patterns relative to the worktree root.
    pub file_patterns: &'a [String],
    /// Builds what Hunt appends to Claude Code's system prompt from the repository's HUNT.md as the VM reads it.
    pub system_prompt: &'a (dyn Fn(Option<&str>) -> String + Send + Sync),
    /// Agent config values (`model`, `effort`) the session had locally.
    pub config_values: &'a [(String, String)],
    /// What `hunt-ctl start` reads on stdin: the Claude and GitHub tokens of `super::token_input`.
    pub token_input: &'a str,
    /// The permission mode of the local agent, which the retrieval restores.
    pub local_mode: Option<&'a str>,
}

/// The result of a handoff: where the session runs now and the ACP session id its relay serves.
pub struct HandedOff {
    pub target: RemoteTarget,
    pub acp_session_id: Option<String>,
}

/// Moves the session to its VM, which the gateway provisions, and starts it there. On failure the session's worktree on
/// the VM is removed again but the VM stays, so a retry starts faster and deleting the session deletes it; the local
/// worktree is left as it was.
pub async fn hand_off(request: HandoffRequest<'_>, progress: Progress<'_>) -> Result<HandedOff, String> {
    let id = request.hunt_session_id.to_string();
    let worktree = request.worktree;
    ensure_movable(worktree).await?;
    let patterns = compile_patterns(request.file_patterns)?;
    let branch = git::current_branch(worktree).await?;
    if branch == "HEAD" {
        return Err("failed to hand off the session: its worktree has no branch checked out".into());
    }
    let head = git::rev_parse(worktree, "HEAD").await?;
    let snapshot = git::snapshot_commit(worktree, "Hunt handoff snapshot").await?;
    let handoff_ref = format!("refs/hunt/{id}/handoff");
    git::run_git(worktree, &["update-ref", &handoff_ref, &snapshot]).await?;
    let repo = repository_key(worktree).await;
    let (git_name, git_email) = git_identity(worktree).await?;
    let origin = git::run_git(worktree, &["remote", "get-url", "origin"]).await.ok().and_then(|url| github_https_url(url.trim()));
    let upstream = origin_upstream(worktree, &branch).await;
    let hooks_path = hooks_path(worktree).await;

    progress.step(RemoteStep::Connecting);
    let gateway = GatewayApi::open(request.gateway, request.ssh_dir).await?;
    let preview_domain = gateway.preview_domain()?;
    let provision = ProvisionRequest {
        id: request.hunt_session_id,
        title: request.title,
        repo: &repo,
        branch: &branch,
        machine_type: request.machine_type,
    };
    let provisioned = gateway.provision(&provision, progress).await?;
    let session_vm = provisioned.vm;
    if provisioned.created {
        ssh::forget_host_key(&session_vm, request.ssh_dir).await?;
    }
    let ssh = Ssh::open(&session_vm, request.ssh_dir).await?;
    release::ensure_ready(&ssh, progress).await?;

    progress.step(RemoteStep::TransferringCode);
    let remote_worktree = hunt_ctl(&ssh, &["init", &id, "--repo", &repo]).await?["path"]
        .as_str()
        .map(str::to_string)
        .ok_or("failed to create the session's repository on the VM: hunt-ctl returned no path")?;

    let started = async {
        push(worktree, &ssh, &remote_worktree, &branch, &handoff_ref).await?;
        upload_lfs_objects(worktree, &ssh, &id, &["HEAD", &handoff_ref]).await?;
        let mut prepare_args = vec!["prepare", &id, "--branch", &branch, "--snapshot", &handoff_ref, "--git-name", &git_name, "--git-email", &git_email];
        if let Some(origin) = &origin {
            prepare_args.extend(["--origin", origin.as_str()]);
            if let Some(upstream) = &upstream {
                prepare_args.extend(["--upstream", upstream.as_str()]);
            }
        }
        if let Some(hooks_path) = &hooks_path {
            prepare_args.extend(["--hooks-path", hooks_path.as_str()]);
        }
        hunt_ctl(&ssh, &prepare_args).await?;
        upload_ignored_files(worktree, &ssh, &id, &patterns, hooks_path.as_deref()).await?;
        // Reads the worktree's hunt.json and HUNT.md, so it runs once the worktree is checked out, and before the
        // relay's session file is written, which carries the HUNT.md in the system prompt.
        let session_config = hunt_ctl(&ssh, &["session-config", &id, "--domain", &preview_domain]).await?;
        let system_prompt = (request.system_prompt)(session_config["hunt_md"].as_str());
        upload_claude_dir(&request, &ssh, &remote_worktree, &system_prompt).await?;

        progress.step(RemoteStep::InstallingDependencies);
        hunt_ctl(&ssh, &["deps", &id]).await?;
        progress.step(RemoteStep::StartingAgent);
        hunt_ctl_with_input(&ssh, &["start", &id], request.token_input.as_bytes()).await?;
        hunt_ctl(&ssh, &["wait", &id, "--timeout", "180"]).await
    }
    .await;
    let status = match started {
        Ok(status) => status,
        Err(error) => {
            if let Err(cleanup) = hunt_ctl(&ssh, &["destroy", &id]).await {
                eprintln!("removing session {id} from its VM after a failed handoff failed: {cleanup}");
            }
            return Err(error);
        }
    };

    let target = RemoteTarget {
        vm: session_vm,
        worktree_path: PathBuf::from(&remote_worktree),
        repo,
        branch,
        handoff_head: head,
        handed_off_at: chrono::Utc::now(),
        local_mode: request.local_mode.map(str::to_string),
        last_active_at: None,
        cleanup_asked_at: None,
        preview_domain: Some(preview_domain),
        origin: RemoteOrigin::Handoff,
        issue: None,
    };
    let acp_session_id = status["acpSessionId"].as_str().map(str::to_string);
    Ok(HandedOff { target, acp_session_id })
}

/// Refuses worktrees whose state a snapshot cannot carry: an unfinished merge, rebase, cherry-pick or revert,
/// unresolved conflicts, or submodules.
async fn ensure_movable(worktree: &Path) -> Result<(), String> {
    for (reference, operation) in [("MERGE_HEAD", "merge"), ("REBASE_HEAD", "rebase"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")] {
        if git::run_git(worktree, &["rev-parse", "-q", "--verify", reference]).await.is_ok() {
            return Err(format!("failed to hand off the session: finish or abort the {operation} in its worktree first"));
        }
    }
    let rebase_dir = git::run_git(worktree, &["rev-parse", "--git-path", "rebase-merge"]).await?;
    if worktree.join(rebase_dir.trim()).exists() {
        return Err("failed to hand off the session: finish or abort the rebase in its worktree first".into());
    }
    if !git::run_git(worktree, &["ls-files", "--unmerged"]).await?.trim().is_empty() {
        return Err("failed to hand off the session: its worktree has unresolved conflicts".into());
    }
    if worktree.join(".gitmodules").exists() {
        return Err("failed to hand off the session: repositories with submodules cannot run remotely yet".into());
    }
    Ok(())
}

/// `<owner>/<repo>` of the `origin` remote, or `local/<folder of the main checkout>` without one.
async fn repository_key(worktree: &Path) -> String {
    if let Some(key) = origin_repository_key(worktree).await {
        return key;
    }
    let common = git::run_git(worktree, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await.unwrap_or_default();
    let checkout = PathBuf::from(common.trim());
    let name = checkout.parent().and_then(Path::file_name).map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let name = sanitize_segment(&name);
    format!("local/{}", if name.is_empty() { "repository" } else { name.as_str() })
}

/// `<owner>/<repo>` of the `origin` remote of the repository at `repo`, as session VMs record it in `hunt-repo`; `None`
/// without such a remote.
pub async fn origin_repository_key(repo: &Path) -> Option<String> {
    let url = git::run_git(repo, &["remote", "get-url", "origin"]).await.ok()?;
    repository_key_from_url(url.trim())
}

/// `owner/repo` from an ssh or https remote URL; `None` when the URL has no such tail.
fn repository_key_from_url(url: &str) -> Option<String> {
    let path = url.trim_end_matches('/').trim_end_matches(".git");
    let path = path.rsplit_once(':').map(|(_, tail)| tail).unwrap_or(path);
    let mut segments = path.rsplit('/').filter(|segment| !segment.is_empty());
    let repo = sanitize_segment(segments.next()?);
    let owner = sanitize_segment(segments.next()?);
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// `segment` reduced to the characters `hunt-ctl` accepts in repository paths.
fn sanitize_segment(segment: &str) -> String {
    segment
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() || "-_.".contains(character) { character } else { '-' })
        .collect::<String>()
        .trim_start_matches('.')
        .to_string()
}

/// The `https://github.com/<owner>/<repo>.git` form of a GitHub remote URL (scp, ssh or https); `None` for other hosts.
/// The session's VM reaches GitHub over https only, with the user's GitHub token.
fn github_https_url(url: &str) -> Option<String> {
    let rest = ["https://", "http://", "ssh://", "git+ssh://"].iter().find_map(|scheme| url.strip_prefix(scheme)).unwrap_or(url);
    let rest = rest.split_once('@').map(|(_, host_and_path)| host_and_path).unwrap_or(rest);
    let (host, path) = rest.split_once(['/', ':'])?;
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    let is_valid = |segment: &str| {
        !segment.is_empty() && !segment.starts_with('.') && segment.chars().all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    };
    if !is_valid(owner) || !is_valid(repo) {
        return None;
    }
    Some(format!("https://github.com/{owner}/{repo}.git"))
}

/// The branch on `origin` that `branch` tracks; `None` without an upstream there.
async fn origin_upstream(worktree: &Path, branch: &str) -> Option<String> {
    let remote = git::run_git(worktree, &["config", &format!("branch.{branch}.remote")]).await.ok()?;
    if remote.trim() != "origin" {
        return None;
    }
    let merge = git::run_git(worktree, &["config", &format!("branch.{branch}.merge")]).await.ok()?;
    merge.trim().strip_prefix("refs/heads/").map(str::to_string)
}

/// The repository's `core.hooksPath` when it is a folder inside the worktree (husky's `.husky`); the session's
/// VM runs the same hooks, so commits there pass the same checks and `git push` uploads Git LFS files.
async fn hooks_path(worktree: &Path) -> Option<String> {
    let path = git::run_git(worktree, &["config", "core.hooksPath"]).await.ok()?;
    let path = path.trim().trim_start_matches("./").trim_end_matches('/');
    if path.is_empty() || path.starts_with(['/', '-', '~']) || path.split('/').any(|segment| segment == "..") {
        return None;
    }
    Some(path.to_string())
}

/// The author name and email the worktree commits with; the agent on the VM commits under the same identity.
async fn git_identity(worktree: &Path) -> Result<(String, String), String> {
    let name = git::run_git(worktree, &["config", "user.name"]).await.unwrap_or_default();
    let email = git::run_git(worktree, &["config", "user.email"]).await.unwrap_or_default();
    if name.trim().is_empty() || email.trim().is_empty() {
        return Err("failed to hand off the session: git has no user.name or user.email for its repository".into());
    }
    Ok((name.trim().to_string(), email.trim().to_string()))
}

/// Pushes the branch, the snapshot and the origin's default branch into the session's own repository on the VM, through
/// `hunt-ctl receive-pack`, which runs git there as the agent's user. The repository's own pre-push hooks are skipped: they
/// guard pushes to the team's remote, not this transfer.
async fn push(worktree: &Path, ssh: &Ssh, remote_worktree: &str, branch: &str, handoff_ref: &str) -> Result<(), String> {
    let mut refspecs = vec![format!("+HEAD:refs/heads/{branch}"), format!("+{handoff_ref}:{handoff_ref}")];
    if let Some(default_branch) = origin_default_branch(worktree).await {
        refspecs.push(format!("+refs/remotes/origin/{default_branch}:refs/remotes/origin/{default_branch}"));
    }
    let url = ssh.git_url(remote_worktree);
    let mut args = vec!["push", "--no-verify", "--quiet", "--receive-pack=sudo -n hunt-ctl receive-pack", url.as_str()];
    args.extend(refspecs.iter().map(String::as_str));
    let ssh_command = ssh.git_ssh_command();
    git::run_git_with_env(worktree, &args, &[("GIT_SSH_COMMAND", ssh_command.as_str())])
        .await
        .map_err(|error| format!("failed to push the session to the VM: {error}"))?;
    Ok(())
}

/// The branch `origin/HEAD` points to, or `main`/`master` when the remote-tracking ref of one of them exists.
async fn origin_default_branch(worktree: &Path) -> Option<String> {
    if let Ok(head) = git::run_git(worktree, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).await {
        if let Some(branch) = head.trim().strip_prefix("refs/remotes/origin/") {
            return Some(branch.to_string());
        }
    }
    for candidate in ["main", "master"] {
        if git::run_git(worktree, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{candidate}")]).await.is_ok() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// The local Git LFS store of the repository of `worktree`.
pub async fn lfs_objects_dir(worktree: &Path) -> Result<PathBuf, String> {
    let common = git::run_git(worktree, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    Ok(PathBuf::from(common.trim()).join("lfs").join("objects"))
}

/// Object ids of the Git LFS files in the trees of `references`; empty when git-lfs is missing or unused.
pub async fn lfs_object_ids(worktree: &Path, references: &[&str]) -> Vec<String> {
    let mut ids = Vec::new();
    for reference in references {
        let Ok(output) = git::run_git(worktree, &["lfs", "ls-files", "--long", reference]).await else { continue };
        for line in output.lines() {
            if let Some(id) = line.split_whitespace().next().filter(|id| id.len() == 64 && id.chars().all(|character| character.is_ascii_hexdigit())) {
                if !ids.iter().any(|known| known == id) {
                    ids.push(id.to_string());
                }
            }
        }
    }
    ids
}

/// Path of the LFS object `id` relative to an LFS objects folder.
pub fn lfs_object_path(id: &str) -> String {
    format!("{}/{}/{id}", &id[0..2], &id[2..4])
}

/// Copies the LFS objects of `references` that exist locally into the session's repository on the VM.
async fn upload_lfs_objects(worktree: &Path, ssh: &Ssh, id: &str, references: &[&str]) -> Result<(), String> {
    let ids = lfs_object_ids(worktree, references).await;
    if ids.is_empty() {
        return Ok(());
    }
    let objects_dir = lfs_objects_dir(worktree).await?;
    let present: Vec<String> = ids.iter().map(|id| lfs_object_path(id)).filter(|path| objects_dir.join(path).is_file()).collect();
    if present.is_empty() {
        return Ok(());
    }
    let archive = tar_create(&objects_dir, &present).await?;
    hunt_ctl_with_input(ssh, &["lfs-put", id], &archive).await?;
    Ok(())
}

/// The glob patterns from the settings; absolute patterns and `..` segments are rejected.
fn compile_patterns(patterns: &[String]) -> Result<Vec<Pattern>, String> {
    patterns
        .iter()
        .map(|pattern| pattern.trim())
        .filter(|pattern| !pattern.is_empty())
        .map(|pattern| {
            if pattern.starts_with('/') || pattern.split('/').any(|segment| segment == "..") {
                return Err(format!("failed to use the file pattern {pattern:?}: it must stay inside the worktree"));
            }
            Pattern::new(pattern).map_err(|error| format!("failed to use the file pattern {pattern:?}: {error}"))
        })
        .collect()
}

/// Whether the worktree-relative `path` matches one of `patterns`; `*` stays within a folder, `**` crosses folders.
fn matches_any(patterns: &[Pattern], path: &str) -> bool {
    let options = MatchOptions { case_sensitive: true, require_literal_separator: true, require_literal_leading_dot: false };
    patterns.iter().any(|pattern| pattern.matches_with(path, options))
}

/// Copies the ignored files of the worktree that match `patterns` (e.g. `.env.private`) and those in `hooks_path`
/// (husky's generated `.husky/_`) to the same paths on the VM.
async fn upload_ignored_files(worktree: &Path, ssh: &Ssh, id: &str, patterns: &[Pattern], hooks_path: Option<&str>) -> Result<(), String> {
    let mut files: Vec<String> = Vec::new();
    if !patterns.is_empty() {
        let output = git::run_git(worktree, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).await?;
        files.extend(output.split('\0').filter(|path| !path.is_empty() && !path.ends_with('/')).filter(|path| matches_any(patterns, path)).map(str::to_string));
    }
    if let Some(hooks_path) = hooks_path {
        let output = git::run_git(worktree, &["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", hooks_path]).await?;
        files.extend(output.split('\0').filter(|path| !path.is_empty()).map(str::to_string));
        files.sort();
        files.dedup();
    }
    if files.is_empty() {
        return Ok(());
    }
    let archive = tar_create(worktree, &files).await?;
    hunt_ctl_with_input(ssh, &["put-files", id], &archive).await?;
    Ok(())
}

/// The parts of the local `~/.claude` a remote session gets as they are: instructions, rules and the user's own skills,
/// agents, commands and output styles. `settings.json` and plugins stay behind: their hooks, paths and plugins belong to
/// this Mac, and the relay sets the permission mode itself.
const PROFILE_ENTRIES: [&str; 6] = ["CLAUDE.md", "rules", "skills", "agents", "commands", "output-styles"];

/// Copies the entries of `PROFILE_ENTRIES` that exist in `claude_dir` into `staging`; symlinks stay behind.
fn copy_profile(claude_dir: &Path, staging: &Path) -> Result<(), String> {
    for name in PROFILE_ENTRIES {
        let source = claude_dir.join(name);
        let Ok(metadata) = std::fs::symlink_metadata(&source) else { continue };
        if metadata.is_dir() {
            transcript::copy_rewritten(&source, &staging.join(name), &[])?;
        } else if metadata.is_file() {
            std::fs::copy(&source, staging.join(name)).map_err(|error| format!("failed to copy {}: {error}", source.display()))?;
        }
    }
    Ok(())
}

/// Fills the agent's `~/.claude` on the VM: the session's transcript with its paths moved to the VM, the user's profile
/// (`PROFILE_ENTRIES`), the memory of the repository and `hunt-session.json` for the relay with `system_prompt`. The
/// memory sent becomes the base of the retrieval's merge.
async fn upload_claude_dir(request: &HandoffRequest<'_>, ssh: &Ssh, remote_worktree: &str, system_prompt: &str) -> Result<(), String> {
    let staging = std::env::temp_dir().join(format!("hunt-handoff-{}", Uuid::new_v4()));
    let result = async {
        std::fs::create_dir_all(&staging).map_err(|error| format!("failed to create {}: {error}", staging.display()))?;
        let local_worktree = request.worktree.display().to_string();
        let local_project = request.claude_dir.join("projects").join(transcript::project_slug(&local_worktree));
        let remote_slug = transcript::project_slug(remote_worktree);
        let replacements = vec![
            (local_worktree, remote_worktree.to_string()),
            (local_project.display().to_string(), format!("{REMOTE_CLAUDE_DIR}/projects/{remote_slug}")),
        ];
        let has_transcript = match request.acp_session_id {
            Some(acp_session_id) => transcript::copy_session(&local_project, &staging.join("projects").join(&remote_slug), acp_session_id, &replacements)?,
            None => false,
        };

        copy_profile(request.claude_dir, &staging)?;
        let local_memory = memory::local_dir(request.claude_dir, request.worktree).await?;
        let memory_files = memory::read_files(&local_memory)?;
        if !memory_files.is_empty() {
            transcript::copy_rewritten(&local_memory, &staging.join("projects").join(&remote_slug).join("memory"), &replacements)?;
        }

        let config_options: serde_json::Map<String, serde_json::Value> =
            request.config_values.iter().map(|(config_id, value)| (config_id.clone(), json!(value))).collect();
        let session = json!({
            "huntSessionId": request.hunt_session_id.to_string(),
            "acpSessionId": if has_transcript { request.acp_session_id } else { None },
            "cwd": remote_worktree,
            "systemPromptAppend": system_prompt,
            "modeId": REMOTE_MODE,
            "configOptions": config_options,
        });
        let session = serde_json::to_vec_pretty(&session).map_err(|error| error.to_string())?;
        std::fs::write(staging.join("hunt-session.json"), session).map_err(|error| format!("failed to write hunt-session.json: {error}"))?;

        let archive = tar_create(&staging, &[".".to_string()]).await?;
        hunt_ctl_with_input(ssh, &["put-files", &request.hunt_session_id.to_string(), "--claude"], &archive).await?;
        memory::write_base(request.memory_base, &memory::base_of(&memory_files))
    }
    .await;
    let _ = std::fs::remove_dir_all(&staging);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_key_reads_owner_and_name_from_ssh_and_https_urls() {
        assert_eq!(repository_key_from_url("git@github.com:unshoppable/app-framework.git").as_deref(), Some("unshoppable/app-framework"));
        assert_eq!(repository_key_from_url("https://github.com/unshoppable/infrastructure").as_deref(), Some("unshoppable/infrastructure"));
        assert_eq!(repository_key_from_url("ssh://git@host:2222/team/repo.git/").as_deref(), Some("team/repo"));
        assert_eq!(repository_key_from_url("repo"), None);
    }

    #[test]
    fn copy_profile_takes_instructions_and_extensions_but_not_settings_or_links() {
        let root = std::env::temp_dir().join(format!("hunt-profile-{}", Uuid::new_v4()));
        let (claude_dir, staging) = (root.join("claude"), root.join("staging"));
        for dir in ["skills/review", "rules", "plugins", "projects/x"] {
            std::fs::create_dir_all(claude_dir.join(dir)).unwrap();
        }
        std::fs::create_dir_all(&staging).unwrap();
        for file in ["CLAUDE.md", "settings.json", "skills/review/SKILL.md", "rules/style.md", "plugins/installed_plugins.json", "projects/x/a.jsonl"] {
            std::fs::write(claude_dir.join(file), file).unwrap();
        }
        std::os::unix::fs::symlink(root.join("elsewhere"), claude_dir.join("agents")).unwrap();

        copy_profile(&claude_dir, &staging).unwrap();
        let mut copied: Vec<String> = memory::read_files(&staging).unwrap().into_keys().collect();
        copied.sort();
        assert_eq!(copied, ["CLAUDE.md", "rules/style.md", "skills/review/SKILL.md"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn github_https_url_accepts_github_remotes_only() {
        let expected = Some("https://github.com/unshoppable/app-framework.git".to_string());
        assert_eq!(github_https_url("git@github.com:unshoppable/app-framework.git"), expected);
        assert_eq!(github_https_url("ssh://git@github.com/unshoppable/app-framework"), expected);
        assert_eq!(github_https_url("https://github.com/unshoppable/app-framework.git/"), expected);
        assert_eq!(github_https_url("https://user@GitHub.com/unshoppable/app-framework"), expected);
        assert_eq!(github_https_url("git@gitlab.com:team/repo.git"), None);
        assert_eq!(github_https_url("https://github.com/team/repo/tree/main"), None);
        assert_eq!(github_https_url("https://github.com/team/.hidden"), None);
        assert_eq!(github_https_url("/Users/me/repo"), None);
    }

    #[test]
    fn patterns_match_nested_files_and_reject_paths_outside_the_worktree() {
        let patterns = compile_patterns(&["**/.env.private".to_string(), "config/*.local".to_string(), " ".to_string()]).unwrap();
        assert!(matches_any(&patterns, ".env.private"));
        assert!(matches_any(&patterns, "apps/med/.env.private"));
        assert!(matches_any(&patterns, "config/app.local"));
        assert!(!matches_any(&patterns, "config/nested/app.local"));
        assert!(!matches_any(&patterns, "apps/med/.env"));
        assert!(compile_patterns(&["../secrets".to_string()]).is_err());
        assert!(compile_patterns(&["/etc/passwd".to_string()]).is_err());
    }

    #[test]
    fn lfs_object_path_splits_the_id_like_git_lfs() {
        let id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(lfs_object_path(id), format!("01/23/{id}"));
    }
}
