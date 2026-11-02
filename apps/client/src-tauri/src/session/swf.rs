//! The pipeline record of a software-factory session (`SessionMode::Swf`). The gateway's poller mirrors the record of the
//! session's issue onto its VM into `.hunt/swf/` of the worktree (`hunt-ctl swf-record`): `pipeline.json` holds the
//! record (`libs/domain/src/swf/pipeline.domain.ts`), `steps/<nn>-<step>.md` the body of the step result the run `nn`
//! ended with. `.hunt/` stays out of the file sync, so the folder is pulled on its own: when the session is opened,
//! whenever the VM's status helper reports the record written (`relay_watch`; after every turn that ended with an older
//! helper) and with the retrieval, before the remote side is dropped. The
//! Factory tab then reads the pipeline from the local worktree (`read_pipeline`, `read_step`), also once the VM is gone.
//! A pull never fails its caller: failures are logged, a VM without the folder yet copies nothing, and the pulls of a
//! session run one after the other.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::remote::ssh::Ssh;
use crate::remote::sync::{self as file_sync, Direction};
use crate::session::store::{self, SessionMode, SessionRecord};
use crate::session::sync;

/// The folder of the pipeline record in a worktree.
pub const SWF_DIR: &str = ".hunt/swf";
const PIPELINE_FILE: &str = "pipeline.json";
const STEPS_DIR: &str = "steps";
/// What a pull copies. rsync copies the files directly inside a listed folder (`--files-from` without `-r`), so the steps
/// folder is listed on its own.
const PULLED_PATHS: [&str; 2] = [".hunt/swf/", ".hunt/swf/steps/"];

/// Per-session locks, so that overlapping pulls of a session run one after the other.
static PULL_LOCKS: LazyLock<Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

/// Tells the windows that the pipeline record of a session was pulled from its VM, as `swf:pulled`; mirror of
/// `SwfPulledEvent` in src/sessions/swf-pipeline.types.ts.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SwfPulledEvent {
    hunt_session_id: Uuid,
}

/// What `.hunt/swf/` of a worktree holds, as the Factory tab shows it; mirror of `SwfPipelineFiles` in
/// src/sessions/swf-pipeline.types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwfPipelineFiles {
    /// The content of `pipeline.json`: the record as `libs/domain/src/swf/pipeline.domain.ts` defines it.
    pub pipeline: serde_json::Value,
    /// The step result files, ascending by run.
    pub steps: Vec<SwfStepFile>,
}

/// A file `steps/<nn>-<step>.md`: the body of the result the run `n` of `step` ended with; mirror of `SwfStepFile` in
/// src/sessions/swf-pipeline.types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwfStepFile {
    pub n: u32,
    pub step: String,
}

/// Whether `record` has a pipeline record to pull: a software-factory session on its VM with a local worktree to pull into.
fn pulls(record: &SessionRecord) -> bool {
    record.mode == SessionMode::Swf && record.remote.is_some() && record.worktree_path.is_dir()
}

/// Copies `.hunt/swf/` of the software-factory session `id` from its VM into its local worktree and tells the windows as
/// `swf:pulled`; nothing for a session of another mode, one that runs here or one without a local worktree. A failure is
/// logged, since the pipeline the local worktree has is shown anyway.
pub async fn pull(app: &AppHandle, id: Uuid) {
    let record = match store::find_session(app, id) {
        Ok(record) => record,
        Err(error) => {
            eprintln!("pulling the pipeline record of session {id} failed: {error}");
            return;
        }
    };
    if !pulls(&record) {
        return;
    }
    let lock = PULL_LOCKS.lock().unwrap().entry(id).or_default().clone();
    let _guard = lock.lock().await;
    let paths: Vec<String> = PULLED_PATHS.iter().map(|path| path.to_string()).collect();
    match sync::copy_files(app, id, Direction::Pull, &paths).await {
        Ok(()) => announce_pulled(app, id),
        Err(error) => eprintln!("pulling the pipeline record of session {id} from its VM failed: {error}"),
    }
}

/// Tells the windows that the pipeline record of the session `id` in its local worktree is current, so that the Factory
/// tab reads it again; a retrieval announces it once the record it brought is stored.
pub fn announce_pulled(app: &AppHandle, id: Uuid) {
    let _ = app.emit("swf:pulled", SwfPulledEvent { hunt_session_id: id });
}

/// `pull` in the background, for a caller that must not wait for it.
pub fn pull_later(app: &AppHandle, id: Uuid) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { pull(&app, id).await });
}

/// Copies `.hunt/swf/` of the worktree `remote_worktree` on the VM behind `ssh` into the local `worktree`, for a
/// retrieval, which has the connection already.
pub async fn pull_record(ssh: &Ssh, worktree: &Path, remote_worktree: &str) -> Result<(), String> {
    let paths: Vec<String> = PULLED_PATHS.iter().map(|path| path.to_string()).collect();
    file_sync::copy_files(ssh, Direction::Pull, worktree, remote_worktree, &paths).await
}

/// The pipeline record in `worktree`: `None` without a `pipeline.json`, an error when it is not JSON.
pub fn read_pipeline(worktree: &Path) -> Result<Option<SwfPipelineFiles>, String> {
    let dir = worktree.join(SWF_DIR);
    let path = dir.join(PIPELINE_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let pipeline =
        serde_json::from_str(&content).map_err(|error| format!("failed to read {}: it is not valid JSON: {error}", path.display()))?;
    let steps = step_files(&dir.join(STEPS_DIR))?.into_iter().map(|(_, file)| file).collect();
    Ok(Some(SwfPipelineFiles { pipeline, steps }))
}

/// The body of the step result the run `n` in `worktree` ended with; `None` without one.
pub fn read_step(worktree: &Path, n: u32) -> Result<Option<String>, String> {
    let steps = worktree.join(SWF_DIR).join(STEPS_DIR);
    let Some((name, _)) = step_files(&steps)?.into_iter().find(|(_, file)| file.n == n) else {
        return Ok(None);
    };
    let path = steps.join(name);
    std::fs::read_to_string(&path).map(Some).map_err(|error| format!("failed to read {}: {error}", path.display()))
}

/// The step result files in the folder `steps` with their file names, ascending by run; a missing folder holds none, and
/// files named otherwise are left out.
fn step_files(steps: &Path) -> Result<Vec<(String, SwfStepFile)>, String> {
    let entries = match std::fs::read_dir(steps) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("failed to list {}: {error}", steps.display())),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to list {}: {error}", steps.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(file) = parse_step_file(&name) {
            files.push((name, file));
        }
    }
    files.sort_by_key(|(_, file)| file.n);
    Ok(files)
}

/// The run and step a file `<nn>-<step>.md` holds the result of; `None` for any other name.
fn parse_step_file(name: &str) -> Option<SwfStepFile> {
    let stem = name.strip_suffix(".md")?;
    let (n, step) = stem.split_once('-')?;
    if step.is_empty() {
        return None;
    }
    Some(SwfStepFile { n: n.parse().ok()?, step: step.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{RemoteOrigin, RemoteTarget, VmRef};
    use std::path::PathBuf;

    fn write(dir: &Path, path: &str, content: &str) {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn step_file_names_give_the_run_and_the_step() {
        assert_eq!(parse_step_file("01-plan.md"), Some(SwfStepFile { n: 1, step: "plan".into() }));
        assert_eq!(parse_step_file("12-human-review.md"), Some(SwfStepFile { n: 12, step: "human-review".into() }));
        assert_eq!(parse_step_file("100-merge.md"), Some(SwfStepFile { n: 100, step: "merge".into() }));
        for name in ["plan.md", "01-plan.txt", "x-plan.md", "01-.md", ".DS_Store", "01-plan"] {
            assert_eq!(parse_step_file(name), None, "{name}");
        }
    }

    #[test]
    fn the_pipeline_comes_with_its_step_files_in_the_order_of_their_runs() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".hunt/swf/pipeline.json", r#"{"step": "verify", "runs": [{"n": 1, "step": "plan"}]}"#);
        write(dir.path(), ".hunt/swf/steps/10-verify.md", "verify");
        write(dir.path(), ".hunt/swf/steps/02-implement.md", "implement");
        write(dir.path(), ".hunt/swf/steps/01-plan.md", "plan");
        write(dir.path(), ".hunt/swf/steps/notes.txt", "ignored");

        let pipeline = read_pipeline(dir.path()).unwrap().unwrap();
        assert_eq!(pipeline.pipeline["step"], serde_json::json!("verify"));
        assert_eq!(pipeline.pipeline["runs"][0]["n"], serde_json::json!(1));
        let steps: Vec<(u32, &str)> = pipeline.steps.iter().map(|file| (file.n, file.step.as_str())).collect();
        assert_eq!(steps, vec![(1, "plan"), (2, "implement"), (10, "verify")]);

        assert_eq!(read_step(dir.path(), 2).unwrap().as_deref(), Some("implement"));
        assert_eq!(read_step(dir.path(), 10).unwrap().as_deref(), Some("verify"));
        assert_eq!(read_step(dir.path(), 3).unwrap(), None);
    }

    #[test]
    fn a_worktree_without_a_record_has_no_pipeline_and_a_record_without_steps_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_pipeline(dir.path()).unwrap(), None);
        assert_eq!(read_step(dir.path(), 1).unwrap(), None);

        write(dir.path(), ".hunt/swf/pipeline.json", r#"{"step": "plan"}"#);
        let pipeline = read_pipeline(dir.path()).unwrap().unwrap();
        assert!(pipeline.steps.is_empty());
        assert_eq!(read_step(dir.path(), 1).unwrap(), None);
    }

    #[test]
    fn a_record_that_is_not_json_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".hunt/swf/pipeline.json", "{not json");
        let error = read_pipeline(dir.path()).unwrap_err();
        assert!(error.contains("pipeline.json") && error.contains("not valid JSON"), "{error}");
    }

    #[test]
    fn only_a_remote_swf_session_with_a_local_worktree_pulls() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, worktree) = (PathBuf::from("/repo"), dir.path().to_path_buf());
        let mut record = SessionRecord::new(Uuid::new_v4(), "swf".into(), repo, worktree, "b".into(), "main".into(), "c".into());
        record.mode = SessionMode::Swf;
        assert!(!pulls(&record));
        record.remote = Some(RemoteTarget {
            vm: VmRef { project: "acme".into(), zone: "europe-west1-c".into(), instance: "vm-hunt-s-ab12cd34".into() },
            worktree_path: PathBuf::from("/home/agent/app"),
            repo: "acme/app".into(),
            branch: "b".into(),
            handoff_head: String::new(),
            handed_off_at: chrono::Utc::now(),
            local_mode: None,
            last_active_at: None,
            cleanup_asked_at: None,
            preview_domain: None,
            origin: RemoteOrigin::Swf,
            issue: Some(123),
            agent: String::new(),
            push_target_pending: false,
            relay_activity: None,
        });
        assert!(pulls(&record));
        record.worktree_path = dir.path().join("missing");
        assert!(!pulls(&record));
        record.worktree_path = dir.path().into();
        record.mode = SessionMode::Edit;
        assert!(!pulls(&record));
    }
}
