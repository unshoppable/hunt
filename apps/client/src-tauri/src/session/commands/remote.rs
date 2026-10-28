//! The commands of remote sessions: handing a session off to a VM of its own, bringing it back or continuing it here
//! without its VM, adopting the session VMs the gateway lists, their preview, link and idle reminder, the remote secrets
//! and the remote settings, whose first arrival starts the VM deletions that failed before (`session::vm_cleanup`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use uuid::Uuid;

use super::{
    activate, activate_remote, finish_progress, finish_retrieval, gateway_api, gateway_vm, live_session, local_session, local_start,
    memory_base_path, progress_reporter, remote_claude_token, remote_worktree, shown_config_values, stop_agent_and_wait, SessionView, VmEnd,
    EFFORT_CONFIG_ID, MODEL_CONFIG_ID, MODE_CONFIG_ID, REMOTE_SETTINGS,
};
use crate::agent::acp::{system_prompt_append, AgentTransport, PermissionRegistry, SessionRegistry};
use crate::agent::claude_config::claude_dir;
use crate::github::github_token;
use crate::graph::WatcherRegistry;
use crate::remote::api::{validate_remote_secret_name, validate_remote_secret_value, GatewayApi, RemoteSecretSummary};
use crate::remote::preview::PreviewStatus;
use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::{self, RemoteTarget, VmSettings};
use crate::session::link::{self, Link};
use crate::session::relay_watch;
use crate::session::store::{self, announce_sessions_changed, SelectionContext, SessionRecord, Workspace};
use crate::session::sync;
use crate::session::vm_cleanup::{deleted_session_vms, run_pending_cleanups};
use crate::terminal::tmux;

/// The preview of the remote session `id`: the services of its repository's hunt.json with their state and URLs, and the
/// other ports that listen on its VM. A VM that is off has none; it is not started. A connected session proves a running
/// VM, so only an unconnected one asks the gateway.
#[tauri::command]
pub async fn preview_status(app: AppHandle, registry: State<'_, SessionRegistry>, id: Uuid) -> Result<PreviewStatus, String> {
    let target = store::find_session(&app, id)?.remote.ok_or("failed to read the preview: the session runs locally")?;
    let domain = target
        .preview_domain
        .as_deref()
        .ok_or("failed to read the preview: the session was handed off without a preview domain; bring it back and hand it off again")?;
    let is_connected = registry.live.lock().await.contains_key(&id);
    if !is_connected && !gateway_api("read the preview").await?.is_vm_running(id).await? {
        return Ok(remote::preview::stopped_status());
    }
    let ssh = remote::ssh::Ssh::open(&target.vm, &ssh_dir()?).await?;
    let status = remote::hunt_ctl(&ssh, &["preview-status", &id.to_string()]).await?;
    remote::preview::parse_status(&status, id, domain)
}

/// The session VMs the gateway of the remote settings lists, running or not (see `remote::adoption::list_session_vms`),
/// for the start view's list of remote sessions.
#[tauri::command]
pub async fn list_session_vms() -> Result<Vec<remote::adoption::AdoptableSession>, String> {
    let gateway = gateway_api("list the remote sessions").await?;
    let listed = gateway.list_sessions().await?;
    let hello = gateway.hello();
    Ok(remote::adoption::list_session_vms(&listed, &hello.project, &hello.zone))
}

/// The remote secrets the gateway of `settings` keeps for every session VM, as names and hints.
#[tauri::command]
pub async fn list_remote_secrets(settings: VmSettings) -> Result<Vec<RemoteSecretSummary>, String> {
    gateway_of(&settings).await?.list_remote_secrets().await
}

/// Creates the remote secret `name` with `value` or replaces its value; session VMs get it when their session starts or
/// is handed off.
#[tauri::command]
pub async fn set_remote_secret(settings: VmSettings, name: String, value: String) -> Result<(), String> {
    validate_remote_secret_name(&name).map_err(|error| format!("failed to save the remote secret: {error}"))?;
    validate_remote_secret_value(&value).map_err(|error| format!("failed to save the remote secret {name}: {error}"))?;
    gateway_of(&settings).await?.set_remote_secret(&name, &value).await
}

/// Deletes the remote secret `name`; returns whether it existed.
#[tauri::command]
pub async fn delete_remote_secret(settings: VmSettings, name: String) -> Result<bool, String> {
    validate_remote_secret_name(&name).map_err(|error| format!("failed to delete the remote secret: {error}"))?;
    gateway_of(&settings).await?.delete_remote_secret(&name).await
}

/// Adopts the sessions of `ids` the gateway of `settings` lists that no local session knows (see `remote::adoption`):
/// each becomes a remote session of this Mac in the local checkout of its repository, found among `repo_paths` and the
/// repositories of the stored sessions, or without one when none matches. With or without `ids`, adopted sessions still
/// without a checkout get another chance to find one, and the remote sessions this Mac already has take the agent state
/// the listing reports for them and have the relays on their running VMs watched (`relay_watch`). VMs this Mac deletes
/// or deleted are left out. Returns the IDs of the new sessions.
#[tauri::command]
pub async fn adopt_session_vms(app: AppHandle, settings: VmSettings, repo_paths: Vec<String>, ids: Vec<Uuid>) -> Result<Vec<Uuid>, String> {
    settings.validate()?;
    let gateway = GatewayApi::open(&remote::gateway_vm(&settings).await?, &ssh_dir()?).await?;
    let preview_domain = gateway.preview_domain()?;
    let listed = gateway.list_sessions().await?;
    let sessions = store::load_sessions(&app)?;
    let mut known: HashSet<Uuid> = sessions.iter().map(|session| session.id).collect();
    known.extend(deleted_session_vms(&app));
    let hello = gateway.hello();
    let remote_targets: HashMap<Uuid, &RemoteTarget> = sessions.iter().filter_map(|session| Some((session.id, session.remote.as_ref()?))).collect();
    let listed_vms = remote::adoption::list_session_vms(&listed, &hello.project, &hello.zone);
    let agent_updates = remote::adoption::agent_updates(&listed_vms, &remote_targets);
    for (id, agent) in agent_updates.iter().cloned() {
        store::update_session(&app, id, |stored| {
            if let Some(target) = stored.remote.as_mut() {
                target.agent = agent;
            }
        })?;
    }
    // A VM the gateway moved to another zone keeps its name; the stored session follows it there.
    let vm_updates = remote::adoption::vm_updates(&listed_vms, &remote_targets);
    for (id, vm) in vm_updates.iter().cloned() {
        store::update_session(&app, id, |stored| {
            if let Some(target) = stored.remote.as_mut() {
                target.vm = vm;
            }
        })?;
    }
    // A VM that stopped mid-turn reports no end of the turn; the turn ends with it.
    for id in remote::adoption::stopped_turns(&listed_vms, &remote_targets) {
        relay_watch::end_turn(&app, id)?;
    }
    relay_watch::reconcile(&app, remote::adoption::running_session_vms(&listed_vms, &remote_targets));
    let mut has_changed = !agent_updates.is_empty() || !vm_updates.is_empty();
    let adoptable: Vec<_> = remote::adoption::sessions_to_adopt(&listed, &hello.project, &hello.zone, &known)
        .into_iter()
        .filter(|session| ids.contains(&session.id))
        .collect();
    let without_checkout: Vec<&SessionRecord> = sessions
        .iter()
        .filter(|session| session.remote.as_ref().is_some_and(RemoteTarget::is_adopted) && session.repo_path.as_os_str().is_empty())
        .collect();
    if adoptable.is_empty() && without_checkout.is_empty() {
        if has_changed {
            announce_sessions_changed(&app);
        }
        return Ok(Vec::new());
    }

    let stored_repos = sessions.iter().map(|session| session.repo_path.clone());
    let candidates: Vec<PathBuf> = repo_paths.iter().map(PathBuf::from).chain(stored_repos).collect();
    let repositories = remote::adoption::repository_keys(&candidates).await;
    let worktrees = store::worktrees_dir(&app)?;
    let mut adopted = Vec::new();
    for session in &adoptable {
        let repo_path = remote::adoption::matching_repository(&repositories, &session.repo).map(Path::to_path_buf).unwrap_or_default();
        let record = SessionRecord::adopted(session, repo_path, worktrees.join(session.id.to_string()), preview_domain.clone());
        if store::insert_session(&app, record)? {
            adopted.push(session.id);
        }
    }
    has_changed |= !adopted.is_empty();
    for session in without_checkout {
        let Some(repo) = session.remote.as_ref().map(|target| target.repo.as_str()) else { continue };
        let Some(repo_path) = remote::adoption::matching_repository(&repositories, repo) else { continue };
        let repo_path = repo_path.to_path_buf();
        store::update_session(&app, session.id, |stored| {
            if stored.repo_path.as_os_str().is_empty() {
                stored.repo_path = repo_path;
            }
        })?;
        has_changed = true;
    }
    if has_changed {
        announce_sessions_changed(&app);
    }

    // The worktree paths of running VMs are read in the background; the others follow with the first connect.
    for session in adoptable.into_iter().filter(|session| session.is_running && adopted.contains(&session.id)) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let id = session.id;
            let found = async {
                let target = store::find_session(&app, id)?.remote.ok_or("the session runs locally")?;
                let ssh = Ssh::open(&target.vm, &ssh_dir()?).await?;
                remote_worktree(&app, id, &target, &ssh).await
            }
            .await;
            if let Err(error) = found {
                eprintln!("finding the worktree of the adopted session {id} on its VM failed: {error}");
            }
        });
    }
    Ok(adopted)
}

/// What Hunt tells the agent of a remote session on top of its usual system prompt addition, whatever the repository.
const REMOTE_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../libs/domain/prompts/remote.system-prompt.md"));

/// The Git part of `REMOTE_PROMPT` when Hunt hands the user's GitHub token to the agent on the VM.
const REMOTE_GIT_PUSH_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../libs/domain/prompts/git-push.system-prompt.md"));

/// The Git part of `REMOTE_PROMPT` without a GitHub token.
const REMOTE_GIT_LOCAL_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../libs/domain/prompts/git-local.system-prompt.md"));

/// What Hunt appends to the system prompt of a remote session: `base`, the usual addition, then `REMOTE_PROMPT`, the Git
/// part that fits whether the agent has the user's GitHub token, the section on the repository's services that
/// `hunt-ctl session-config` writes (`services_prompt`, skipped when empty) and the repository's hunt.agent.md under
/// a heading of its own. The gateway's poller (`apps/gateway/src/swf/swf-prompts.utils.ts`) composes the prompt of its sessions the
/// same way, with an empty `base` and the shared question part and its swf workflow before the services.
fn remote_system_prompt(base: &str, has_github_token: bool, services_prompt: &str, agent_md: Option<&str>) -> String {
    let git_prompt = if has_github_token { REMOTE_GIT_PUSH_PROMPT } else { REMOTE_GIT_LOCAL_PROMPT };
    let mut prompt = format!("{base}\n\n{REMOTE_PROMPT}\n{git_prompt}");
    let services_prompt = services_prompt.trim();
    if !services_prompt.is_empty() {
        prompt.push_str(&format!("\n{services_prompt}\n"));
    }
    if let Some(text) = agent_md.map(str::trim).filter(|text| !text.is_empty()) {
        prompt.push_str(&format!("\n### The repository's hunt.agent.md\n{text}\n"));
    }
    prompt
}

/// Brings up the VM the session `id` moves to while its agent still works here (see `remote::handoff::prepare`), so the
/// handoff after the agent's turn finds it ready. The session and its agent stay as they are; the VM stays on failure,
/// for the handoff to retry.
#[tauri::command]
pub async fn prepare_hand_off(app: AppHandle, id: Uuid, settings: VmSettings) -> Result<(), String> {
    let record = local_session(&app, id)?;
    ensure_hand_off_allowed(&record)?;
    settings.validate()?;
    let prepared = async {
        let gateway = remote::gateway_vm(&settings).await?;
        store::update_session(&app, id, |stored| stored.leftover_vm = Some(gateway.session_vm(id)))?;
        let ssh_dir = ssh_dir()?;
        let request = remote::handoff::VmRequest {
            hunt_session_id: id,
            title: &record.title,
            worktree: &record.worktree_path,
            gateway: &gateway,
            machine_type: settings.machine_type.as_deref(),
            ssh_dir: &ssh_dir,
        };
        remote::handoff::prepare(&request, &progress_reporter(&app, id)).await
    }
    .await;
    finish_progress(&app, id);
    prepared
}

/// Moves the session `id` to a VM of its own, which the gateway of `settings` provisions: its agent stops here, its
/// branch, uncommitted work, transcript and the private files its hunt.json names go to the VM, and the chat
/// continues with the agent there. Its sub chats stay on this Mac: their agents stop while the worktree moves and start
/// again once they are opened. On failure the session stays local, its agent starts again and the VM stays for the next
/// attempt.
#[tauri::command]
pub async fn hand_off_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
    settings: VmSettings,
) -> Result<SessionView, String> {
    let record = local_session(&app, id)?;
    ensure_hand_off_allowed(&record)?;
    settings.validate()?;
    let claude_token = remote_claude_token(&app, "hand off the session").await?;
    let github_token = github_token::read().await?;
    let (config_values, local_mode) = match live_session(&registry, id).await {
        Ok(handles) => {
            let history = handles.history.lock().unwrap();
            let local_mode = shown_config_values(&history, &[MODE_CONFIG_ID]).pop().map(|(_, value)| value);
            (shown_config_values(&history, &[MODEL_CONFIG_ID, EFFORT_CONFIG_ID]), local_mode)
        }
        Err(_) => (Vec::new(), None),
    };
    // The sub chats' agents stop while the worktree moves, and their starts stay claimed until the handoff ended, so that
    // opening one meanwhile waits until the worktree settled.
    let child_ids: Vec<Uuid> = store::load_sessions(&app)?.into_iter().filter(|session| session.parent_id == Some(id)).map(|session| session.id).collect();
    let mut claimed_children: Vec<Uuid> = Vec::new();
    for child_id in child_ids {
        stop_agent_and_wait(&app, &registry, &watchers, &permissions, child_id).await;
        if !registry.claim_start(child_id).await {
            end_starts(&registry, claimed_children.into_iter()).await;
            return Err("failed to hand off the session: one of its sub chats was started again meanwhile".into());
        }
        claimed_children.push(child_id);
    }
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    if !registry.claim_start(id).await {
        end_starts(&registry, claimed_children.into_iter()).await;
        return Err("failed to hand off the session: its agent was started again meanwhile".into());
    }

    let handed_off = async {
        let gateway = remote::gateway_vm(&settings).await?;
        store::update_session(&app, id, |stored| stored.leftover_vm = Some(gateway.session_vm(id)))?;
        let context_prompt = record.selection.as_ref().map(SelectionContext::to_system_prompt);
        let local_agent_md = remote::handoff::read_agent_md(&record.worktree_path)?;
        let base_prompt = system_prompt_append(&app, id, context_prompt, None);
        let has_github_token = github_token.is_some();
        let system_prompt = |services_prompt: &str, agent_md: Option<&str>| {
            remote_system_prompt(&base_prompt, has_github_token, services_prompt, agent_md.or(local_agent_md.as_deref()))
        };
        let token_input = remote::token_input(&claude_token, github_token.as_deref());
        let (ssh_dir, claude_dir) = (ssh_dir()?, claude_dir()?);
        let memory_base = memory_base_path(&app, id)?;
        let request = remote::handoff::HandoffRequest {
            hunt_session_id: id,
            title: &record.title,
            worktree: &record.worktree_path,
            acp_session_id: record.acp_session_id.as_deref(),
            gateway: &gateway,
            machine_type: settings.machine_type.as_deref(),
            ssh_dir: &ssh_dir,
            claude_dir: &claude_dir,
            memory_base: &memory_base,
            system_prompt: &system_prompt,
            config_values: &config_values,
            token_input: &token_input,
            local_mode: local_mode.as_deref(),
        };
        remote::handoff::hand_off(request, &progress_reporter(&app, id)).await
    }
    .await;

    let activated = match handed_off {
        Ok(handed_off) => {
            // The app's processes run on the VM from now on; those still running here would hold its ports.
            if let Err(error) = tmux::kill_server(id).await {
                eprintln!("ending the tmux server of session {id} failed: {error}");
            }
            // The first sync takes the VM's files as they are after the handoff.
            sync::forget(&app, id);
            let stored = store::update_session(&app, id, |stored| {
                stored.remote = Some(handed_off.target.clone());
                stored.leftover_vm = None;
                if let Some(acp_session_id) = &handed_off.acp_session_id {
                    stored.acp_session_id = Some(acp_session_id.clone());
                }
            });
            announce_sessions_changed(&app);
            match stored {
                Ok(Some(record)) => activate_remote(&app, &registry, &watchers, record).await,
                Ok(None) => Err("failed to hand off the session: it was closed meanwhile".into()),
                Err(error) => Err(error),
            }
        }
        Err(error) => {
            // The session stays local, so its agent comes back and the chat can go on.
            let start = local_start(&record);
            if let Err(restart_error) = activate(&app, &registry, &watchers, record, start, AgentTransport::Local).await {
                eprintln!("restarting the agent of session {id} after a failed handoff failed: {restart_error}");
            }
            Err(error)
        }
    };
    registry.end_start(id).await;
    // The sub chats start again here when they are opened next.
    end_starts(&registry, claimed_children.into_iter()).await;
    finish_progress(&app, id);
    announce_sessions_changed(&app);
    activated
}

/// Gives back the starts of the agents of `ids` claimed with `SessionRegistry::claim_start`.
async fn end_starts(registry: &SessionRegistry, ids: impl Iterator<Item = Uuid>) {
    for id in ids {
        registry.end_start(id).await;
    }
}

/// Rejects sessions that cannot run on a VM: sub sessions, which run here in their session's worktree, sessions in the
/// repository's own checkout, and pull request reviews.
fn ensure_hand_off_allowed(record: &SessionRecord) -> Result<(), String> {
    if record.parent_id.is_some() {
        return Err("failed to hand off the session: a sub session runs here in its session's worktree".into());
    }
    if record.workspace != Workspace::Worktree {
        return Err("failed to hand off the session: sessions in the repository's own checkout stay local".into());
    }
    if record.pull_request.is_some() {
        return Err("failed to hand off the session: pull request reviews stay local".into());
    }
    Ok(())
}

/// Brings the remote session `id` back: its relay stops, its commits, uncommitted work and transcript come back into the
/// local worktree, its VM is deleted and the chat continues with a local agent.
#[tauri::command]
pub async fn retrieve_session(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    ensure_retrievable(&store::find_session(&app, id)?)?;
    // The sub chats' agents stop while the worktree comes back and start again once they are opened.
    for child in store::load_sessions(&app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent_and_wait(&app, &registry, &watchers, &permissions, child.id).await;
    }
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    // The first sync of an adopted session may have created its local worktree meanwhile.
    let record = store::find_session(&app, id)?;
    ensure_retrievable(&record)?;
    let target = record.remote.clone().ok_or("failed to retrieve the session: it runs locally")?;
    let adopted_into = (target.is_adopted() && !record.worktree_path.is_dir()).then_some(record.repo_path.as_path());
    if !registry.claim_start(id).await {
        return Err("failed to retrieve the session: its agent was started again meanwhile".into());
    }

    let activated = async {
        let (ssh_dir, claude_dir) = (ssh_dir()?, claude_dir()?);
        let memory_base = memory_base_path(&app, id)?;
        let sync_manifest = sync::manifest_path(&app, id)?;
        let sync_base_ref = target.start_ref(id);
        let local_ids = store::sub_chat_acp_ids(&app, id)?;
        let gateway = gateway_vm("retrieve the session").await?;
        let request = remote::retrieve::RetrieveRequest {
            hunt_session_id: id,
            worktree: &record.worktree_path,
            target: &target,
            gateway: &gateway,
            ssh_dir: &ssh_dir,
            claude_dir: &claude_dir,
            memory_base: &memory_base,
            sync_manifest: &sync_manifest,
            sync_base_ref: &sync_base_ref,
            adopted_into,
            local_ids: &local_ids,
        };
        let retrieved = remote::retrieve::retrieve(request, &progress_reporter(&app, id)).await?;
        finish_retrieval(&app, &registry, &watchers, id, &target, retrieved, VmEnd::Delete).await
    }
    .await;
    registry.end_start(id).await;
    finish_progress(&app, id);
    announce_sessions_changed(&app);
    activated
}

/// Continues the remote session `id` here while its VM cannot be reached (Settings → Remote VM unreachable, or offline):
/// the session becomes local with the files of its local worktree as the last sync left them and the conversation as of
/// the agent's last finished turn, and this Mac is the only side that writes. What the agent did on the VM since is
/// saved as `refs/hunt/<id>/abandoned` once the VM can be reached, and the VM is deleted then.
#[tauri::command]
pub async fn continue_locally(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    watchers: State<'_, WatcherRegistry>,
    permissions: State<'_, PermissionRegistry>,
    id: Uuid,
) -> Result<SessionView, String> {
    let record = store::find_session(&app, id)?;
    let target = record.remote.clone().ok_or("failed to continue the session here: it runs here already")?;
    if record.parent_id.is_some() {
        return Err("failed to continue the session here: continue its remote session instead".into());
    }
    if sync::has_channel(&app, id) {
        return Err("failed to continue the session here: it is connected to its VM; bring it back instead".into());
    }
    if !record.worktree_path.is_dir() {
        return Err("failed to continue the session here: nothing of it is on this Mac yet".into());
    }
    for child in store::load_sessions(&app)?.into_iter().filter(|session| session.parent_id == Some(id)) {
        stop_agent_and_wait(&app, &registry, &watchers, &permissions, child.id).await;
    }
    stop_agent_and_wait(&app, &registry, &watchers, &permissions, id).await;
    if !registry.claim_start(id).await {
        return Err("failed to continue the session here: its agent was started again meanwhile".into());
    }
    remote::sync::clear_staging(&record.worktree_path);
    let retrieved = remote::retrieve::Retrieved { acp_session_id: None, branch: None };
    let continued = finish_retrieval(&app, &registry, &watchers, id, &target, retrieved, VmEnd::PreserveAndDelete).await;
    registry.end_start(id).await;
    announce_sessions_changed(&app);
    continued
}

/// Whether the local worktree of the remote session `id`, or of the remote session whose sub chat `id` is, may change
/// (`session::link`); `None` for a local session.
#[tauri::command]
pub async fn remote_link(app: AppHandle, id: Uuid) -> Result<Option<Link>, String> {
    Ok(link::current(&app, id).await)
}

/// Refuses to bring back `record` when it runs locally, or when it is an adopted session without a local worktree and
/// there is no local checkout of its repository to create one in.
fn ensure_retrievable(record: &SessionRecord) -> Result<(), String> {
    let target = record.remote.as_ref().ok_or("failed to retrieve the session: it runs locally")?;
    if target.is_adopted() && !record.worktree_path.is_dir() && record.repo_path.as_os_str().is_empty() {
        return Err(format!(
            "failed to bring back the session: there is no local checkout of {}; start a session in one, then refresh the remote sessions",
            target.repo
        ));
    }
    Ok(())
}

/// Whether this app run started the deletions that failed before; they wait for the first remote settings.
static HAS_STARTED_PENDING_CLEANUPS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Takes the remote settings from the main window, at its start and on every change; `None` while they are incomplete.
/// Commands on stored remote sessions reach the gateway of these settings. Invalid settings count as none.
#[tauri::command]
pub fn set_remote_settings(app: AppHandle, settings: Option<VmSettings>) -> Result<(), String> {
    let validated = settings.as_ref().map_or(Ok(()), VmSettings::validate);
    let settings = settings.filter(|_| validated.is_ok());
    let is_set = settings.is_some();
    *REMOTE_SETTINGS.lock().unwrap() = settings;
    if is_set && !HAS_STARTED_PENDING_CLEANUPS.swap(true, std::sync::atomic::Ordering::SeqCst) {
        run_pending_cleanups(&app);
    }
    validated
}

/// The gateway API of the project in `settings`, which the calling window passes along with the call.
async fn gateway_of(settings: &VmSettings) -> Result<GatewayApi, String> {
    settings.validate()?;
    GatewayApi::open(&remote::gateway_vm(settings).await?, &ssh_dir()?).await
}

/// Remembers that the user chose to keep the idle remote session `id` for now; Hunt asks again three days later.
#[tauri::command]
pub async fn snooze_remote_cleanup(app: AppHandle, id: Uuid) -> Result<(), String> {
    store::update_session(&app, id, |record| {
        if let Some(remote) = record.remote.as_mut() {
            remote.cleanup_asked_at = Some(chrono::Utc::now());
        }
    })?;
    announce_sessions_changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_system_prompt_appends_the_git_part_the_services_and_the_agent_md_of_the_repository() {
        let services = "\n### The repository's services\n- `api`: port 3000\n\n";
        let with_token = remote_system_prompt("BASE", true, services, Some("\n# Services\nStart api.\n\n"));
        assert_eq!(
            with_token,
            format!(
                "BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_PUSH_PROMPT}\n### The repository's services\n- `api`: port 3000\n\n\
                 ### The repository's hunt.agent.md\n# Services\nStart api.\n"
            )
        );
        let services_only = remote_system_prompt("BASE", true, services, None);
        assert_eq!(
            services_only,
            format!("BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_PUSH_PROMPT}\n### The repository's services\n- `api`: port 3000\n")
        );

        let without_token = remote_system_prompt("BASE", false, "", None);
        assert_eq!(without_token, format!("BASE\n\n{REMOTE_PROMPT}\n{REMOTE_GIT_LOCAL_PROMPT}"));
        assert_eq!(remote_system_prompt("BASE", false, " \n", Some(" \n")), without_token);
        assert!(REMOTE_PROMPT.contains("the section \"The repository's services\" below"));
        assert!(REMOTE_PROMPT.contains("```sh\nsudo -n hunt-ctl service start <name>…\n```"));
        assert!(REMOTE_PROMPT.contains("$HUNT_PREVIEW_URL_TEMPLATE` with `{port}`"));
        assert!(REMOTE_PROMPT.contains("tmux new-window -t app -n <name> '<command>'\n```"));
        assert!(!REMOTE_PROMPT.contains("pipe-pane"), "every window on the VM logs through its /etc/tmux.conf");

        let poller = remote_system_prompt("", false, "", None);
        assert!(poller.starts_with("\n\n## Remote session\nThis session runs on a VM of its own. The user brings its commits back to their machine.\n\n"));
        assert!(poller.ends_with(
            "The repository's hunt.agent.md, its instructions for Hunt sessions, follows at the end when it has one.\n\n\
             ### Git\nThere is no GitHub token for this session, so pushing fails: commit locally and do not push.\n"
        ));
    }
}
