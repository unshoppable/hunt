//! Watches what the relays of the remote sessions do while their VMs run, so that the sidebar shows whether an agent runs
//! a turn or waits for an answer before its session is opened. Every top-level remote session whose VM the gateway lists
//! as running gets a status channel (`remote::status_channel`) over the shared SSH connection, which never starts a
//! stopped VM. The listing (`adopt_session_vms`, every 30 s) starts and stops the watches (`reconcile`), and so reopens a
//! channel that closed while its VM still runs; a channel that failed to open is tried again at the next listing, then
//! not before `SECOND_RETRY`, then not before `LATER_RETRY`. What a relay reports lands in the session's
//! `relay_activity`, which the windows hear as `remote:relay`; the sessions are not announced, since nothing else of
//! them changed. An annotation the channel delivers goes to the windows as `review:annotation`, for the session's
//! composer.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::remote::ssh::{ssh_dir, Ssh};
use crate::remote::status_channel::{Annotation, Event, Report, StatusChannel, Turn};
use crate::remote::{RelayActivity, RemoteTarget, VmRef};
use crate::session::store;

/// How long a session whose channel failed to open waits for the next try after the second failure in a row, and after
/// every later one.
const SECOND_RETRY: Duration = Duration::from_secs(2 * 60);
const LATER_RETRY: Duration = Duration::from_secs(10 * 60);

/// The watch of every remote session whose VM runs, and the failed opens in a row of the sessions whose channel failed
/// to open.
#[derive(Default)]
pub struct RelayWatchRegistry(Mutex<Watches>);

#[derive(Default)]
struct Watches {
    watches: HashMap<Uuid, Watch>,
    streaks: HashMap<Uuid, Streak>,
    /// The generation of the last watch started, so that a watch that ended removes only itself.
    generation: u64,
}

/// The watch of one session: the VM it watches and the task that opens its channel and holds it until it closes.
struct Watch {
    vm: VmRef,
    generation: u64,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// The failed opens in a row of a session's channel, and when the last one failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Streak {
    failures: u32,
    last_failed_at: Instant,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayActivityEvent {
    hunt_session_id: Uuid,
    relay_activity: RelayActivity,
}

/// An annotation of the review widget for the composer of the session `hunt_session_id`, from the status channel of its
/// VM or from the Chrome of a local session (`crate::agent::browser`); mirror of `AnnotationEvent` in
/// src/sessions/session.types.ts.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationEvent {
    pub hunt_session_id: Uuid,
    pub annotation: Annotation,
}

/// Tells the windows about `annotation`, made for the session `id`, as `review:annotation`.
pub fn emit_annotation(app: &AppHandle, id: Uuid, annotation: Annotation) {
    let _ = app.emit("review:annotation", AnnotationEvent { hunt_session_id: id, annotation });
}

/// Watches the relays of `running`, the top-level remote sessions whose VM runs, each with its VM as the gateway lists
/// it: starts a watch for each that has none once its failed opens allow, restarts one whose VM moved and stops the
/// watches of every other session. A session missing from `running` forgets its failed opens, since its VM starts with the
/// staged release, which may bring the helper.
pub fn reconcile(app: &AppHandle, running: Vec<(Uuid, VmRef)>) {
    let registry = app.state::<RelayWatchRegistry>();
    let mut state = registry.0.lock().unwrap();
    state.streaks.retain(|id, _| running.iter().any(|(running_id, _)| running_id == id));
    let watched: HashMap<Uuid, &VmRef> = state.watches.iter().map(|(id, watch)| (*id, &watch.vm)).collect();
    let Plan { stop, start } = plan(&watched, &state.streaks, &running, Instant::now());
    for id in stop {
        if let Some(watch) = state.watches.remove(&id) {
            watch.task.abort();
        }
    }
    for (id, vm) in start {
        state.generation += 1;
        let generation = state.generation;
        // The task records how its open went under this lock, so it finds its watch inserted.
        let task = spawn_watch(app, id, vm.clone(), generation);
        state.watches.insert(id, Watch { vm, generation, task });
    }
}

/// Stops the watch of `id`, which runs locally now or is gone, and forgets its failed opens.
pub fn stop(app: &AppHandle, id: Uuid) {
    let registry = app.state::<RelayWatchRegistry>();
    let mut state = registry.0.lock().unwrap();
    state.streaks.remove(&id);
    if let Some(watch) = state.watches.remove(&id) {
        watch.task.abort();
    }
}

/// Records that the turn of the remote session `id` ended with its VM, which stopped while its relay reported a running
/// turn (`remote::adoption::stopped_turns`), and tells the windows.
pub fn end_turn(app: &AppHandle, id: Uuid) -> Result<(), String> {
    let updated = store::update_session(app, id, |record| {
        if let Some(activity) = record.remote.as_mut().and_then(|target| target.relay_activity.as_mut()) {
            activity.is_turn_running = false;
        }
    })?;
    if let Some(activity) = updated.and_then(|record| record.remote?.relay_activity) {
        announce(app, id, activity);
    }
    Ok(())
}

impl RelayWatchRegistry {
    /// Removes the watch `generation` of `id` unless a newer one replaced it.
    fn end(&self, id: Uuid, generation: u64) {
        let mut state = self.0.lock().unwrap();
        if state.watches.get(&id).is_some_and(|watch| watch.generation == generation) {
            state.watches.remove(&id);
        }
    }
}

/// Opens the channel of the watch `generation` of session `id` on `vm` and holds it until it closes; the watch then ends,
/// and the next listing starts a new one while the VM runs. Only the first failed open in a row is logged.
fn spawn_watch(app: &AppHandle, id: Uuid, vm: VmRef, generation: u64) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (closed, is_closed) = oneshot::channel::<String>();
        let opened = connect(&app, id, &vm, closed).await;
        let registry = app.state::<RelayWatchRegistry>();
        match opened {
            Ok(channel) => {
                registry.0.lock().unwrap().streaks.remove(&id);
                let reason = is_closed.await.unwrap_or_default();
                drop(channel);
                eprintln!("the status channel of session {id} ended: {reason}");
            }
            Err(error) => {
                let mut state = registry.0.lock().unwrap();
                let streak = failed_again(state.streaks.get(&id).copied(), Instant::now());
                state.streaks.insert(id, streak);
                if streak.failures == 1 {
                    eprintln!("opening the status channel of session {id} failed: {error}");
                }
            }
        }
        registry.end(id, generation);
    })
}

/// Opens the status channel of session `id` on `vm`; its reports land in the session's record, its annotations go to the
/// windows, and `closed` gets why it ended.
async fn connect(app: &AppHandle, id: Uuid, vm: &VmRef, closed: oneshot::Sender<String>) -> Result<StatusChannel, String> {
    let ssh = Ssh::open(vm, &ssh_dir()?).await?;
    let handle = app.clone();
    let watched = vm.clone();
    let closed = Mutex::new(Some(closed));
    StatusChannel::open(&ssh, move |event| match event {
        Event::Status(report) => {
            if let Err(error) = record_report(&handle, id, &watched, &report) {
                eprintln!("recording the relay status of session {id} failed: {error}");
            }
        }
        Event::Annotation(annotation) => emit_annotation(&handle, id, annotation),
        Event::Closed(reason) => {
            if let Some(closed) = closed.lock().unwrap().take() {
                let _ = closed.send(reason);
            }
        }
    })
    .await
}

/// Stores what `report` changes on the remote session `id` while it runs on `vm` (`report_changes`) and tells the windows
/// about a new relay activity.
fn record_report(app: &AppHandle, id: Uuid, vm: &VmRef, report: &Report) -> Result<(), String> {
    let sessions = store::load_sessions(app)?;
    let stored = sessions.into_iter().find(|session| session.id == id).and_then(|session| session.remote);
    let Some(target) = stored.filter(|target| target.vm == *vm) else { return Ok(()) };
    let (activity, ended_at) = report_changes(report, &target);
    if activity.is_none() && ended_at.is_none() {
        return Ok(());
    }
    let updated = store::update_session(app, id, |record| {
        let Some(target) = record.remote.as_mut().filter(|target| target.vm == *vm) else { return };
        target.relay_activity = activity.or(target.relay_activity);
        target.last_active_at = target.last_active_at.max(ended_at);
    })?;
    let Some(activity) = activity else { return Ok(()) };
    if updated.and_then(|record| record.remote).is_some_and(|target| target.vm == *vm) {
        announce(app, id, activity);
    }
    Ok(())
}

/// Tells the windows the relay activity of session `id`.
fn announce(app: &AppHandle, id: Uuid, relay_activity: RelayActivity) {
    let _ = app.emit("remote:relay", RelayActivityEvent { hunt_session_id: id, relay_activity });
}

/// What `reconcile` does.
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    stop: Vec<Uuid>,
    start: Vec<(Uuid, VmRef)>,
}

/// The watches to stop and to start, given the VMs of the `watched` sessions, the failed opens `streaks`, the sessions
/// whose VM runs with that VM (`running`) and `now`: a watch stops when its session is missing from `running` or runs on
/// another VM, and a session of `running` without a watch on its VM gets one once its failed opens allow (`is_due`).
fn plan(watched: &HashMap<Uuid, &VmRef>, streaks: &HashMap<Uuid, Streak>, running: &[(Uuid, VmRef)], now: Instant) -> Plan {
    let stop = watched
        .iter()
        .filter(|(id, vm)| !running.iter().any(|(running_id, running_vm)| running_id == *id && running_vm == **vm))
        .map(|(id, _)| *id)
        .collect();
    let start = running
        .iter()
        .filter(|(id, vm)| watched.get(id) != Some(&vm) && is_due(streaks.get(id), now))
        .cloned()
        .collect();
    Plan { stop, start }
}

/// Whether a session whose channel failed to open `streak` times in a row (`None` when it did not fail) may try again at
/// `now`: right away after the first failure, `SECOND_RETRY` after the second and `LATER_RETRY` after every later one.
fn is_due(streak: Option<&Streak>, now: Instant) -> bool {
    let Some(streak) = streak else { return true };
    let wait = match streak.failures {
        0 | 1 => Duration::ZERO,
        2 => SECOND_RETRY,
        _ => LATER_RETRY,
    };
    now.saturating_duration_since(streak.last_failed_at) >= wait
}

/// The failed opens in a row after `streak` once another one failed at `now`.
fn failed_again(streak: Option<Streak>, now: Instant) -> Streak {
    Streak { failures: streak.map_or(0, |streak| streak.failures) + 1, last_failed_at: now }
}

/// What `report` changes on `target`: the relay activity it leaves (`None` when that is the stored one) and the end of
/// the last turn when that is later than the agent's last known work (`None` otherwise). A report without a relay that
/// serves the session counts as no turn and keeps the stored question.
fn report_changes(report: &Report, target: &RemoteTarget) -> (Option<RelayActivity>, Option<DateTime<Utc>>) {
    let activity = match report.turn {
        Some(turn) => RelayActivity { is_turn_running: turn == Turn::Running, is_question: report.question },
        None => RelayActivity { is_turn_running: false, is_question: target.relay_activity.and_then(|stored| stored.is_question) },
    };
    let ended_at = report
        .last_turn_ended_at
        .and_then(DateTime::from_timestamp_millis)
        .filter(|ended_at| target.last_active_at < Some(*ended_at));
    (Some(activity).filter(|activity| target.relay_activity != Some(*activity)), ended_at)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::remote::RemoteOrigin;

    fn vm(zone: &str, instance: &str) -> VmRef {
        VmRef { project: "acme-hunt".into(), zone: zone.into(), instance: instance.into() }
    }

    #[test]
    fn plan_starts_a_watch_per_running_vm_and_stops_those_of_vms_that_stopped_or_moved() {
        let (kept, started, stopped, moved) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let (kept_vm, stopped_vm) = (vm("europe-west1-c", "vm-hunt-s-1"), vm("europe-west1-c", "vm-hunt-s-3"));
        let (old_vm, new_vm) = (vm("europe-west1-c", "vm-hunt-s-4"), vm("europe-west1-b", "vm-hunt-s-4"));
        let watched = HashMap::from([(kept, &kept_vm), (stopped, &stopped_vm), (moved, &old_vm)]);
        let started_vm = vm("europe-west1-c", "vm-hunt-s-2");
        let running = [(kept, kept_vm.clone()), (started, started_vm.clone()), (moved, new_vm.clone())];

        let Plan { stop, start } = plan(&watched, &HashMap::new(), &running, Instant::now());
        assert_eq!(stop.into_iter().collect::<HashSet<_>>(), HashSet::from([stopped, moved]));
        assert_eq!(start, vec![(started, started_vm), (moved, new_vm)]);

        let Plan { stop, start } = plan(&HashMap::new(), &HashMap::new(), &[], Instant::now());
        assert!(stop.is_empty() && start.is_empty());
    }

    #[test]
    fn plan_waits_for_the_retry_of_a_session_whose_channel_failed() {
        let id = Uuid::new_v4();
        let now = Instant::now();
        let running = [(id, vm("europe-west1-c", "vm-hunt-s-1"))];
        let streaks = HashMap::from([(id, Streak { failures: 2, last_failed_at: now })]);
        assert_eq!(plan(&HashMap::new(), &streaks, &running, now + Duration::from_secs(60)).start, vec![]);
        assert_eq!(plan(&HashMap::new(), &streaks, &running, now + SECOND_RETRY).start, running.to_vec());
    }

    #[test]
    fn failed_opens_wait_for_the_next_listing_then_two_then_ten_minutes() {
        let now = Instant::now();
        assert!(is_due(None, now));
        let first = failed_again(None, now);
        assert_eq!(first, Streak { failures: 1, last_failed_at: now });
        assert!(is_due(Some(&first), now));

        let second = failed_again(Some(first), now);
        assert_eq!(second.failures, 2);
        assert!(!is_due(Some(&second), now + Duration::from_secs(119)));
        assert!(is_due(Some(&second), now + SECOND_RETRY));

        let third = failed_again(Some(second), now);
        assert!(!is_due(Some(&third), now + Duration::from_secs(9 * 60)));
        assert!(is_due(Some(&third), now + LATER_RETRY));
        let fifth = failed_again(Some(failed_again(Some(third), now)), now);
        assert_eq!(fifth.failures, 5);
        assert!(!is_due(Some(&fifth), now + Duration::from_secs(9 * 60)));
        assert!(is_due(Some(&fifth), now + LATER_RETRY));
    }

    fn target(relay_activity: Option<RelayActivity>, last_active_at: Option<DateTime<Utc>>) -> RemoteTarget {
        RemoteTarget {
            vm: vm("europe-west1-c", "vm-hunt-s-ab12cd34"),
            worktree_path: "/home/agent/app".into(),
            repo: "acme/app".into(),
            branch: "feat/general/x".into(),
            handoff_head: "abc".into(),
            handed_off_at: Utc::now(),
            local_mode: None,
            last_active_at,
            cleanup_asked_at: None,
            preview_domain: None,
            origin: RemoteOrigin::Handoff,
            issue: None,
            agent: String::new(),
            push_target_pending: false,
            relay_activity,
        }
    }

    fn report(turn: Option<Turn>, question: Option<bool>, last_turn_ended_at: Option<i64>) -> Report {
        Report { turn, question, last_turn_ended_at }
    }

    #[test]
    fn a_report_sets_the_turn_and_the_question_the_relay_reports() {
        let running = RelayActivity { is_turn_running: true, is_question: Some(false) };
        assert_eq!(report_changes(&report(Some(Turn::Running), Some(false), None), &target(None, None)), (Some(running), None));
        let asking = RelayActivity { is_turn_running: false, is_question: Some(true) };
        assert_eq!(report_changes(&report(Some(Turn::Idle), Some(true), None), &target(Some(running), None)), (Some(asking), None));
        let older_relay = RelayActivity { is_turn_running: false, is_question: None };
        assert_eq!(report_changes(&report(Some(Turn::Idle), None, None), &target(Some(asking), None)), (Some(older_relay), None));
        assert_eq!(report_changes(&report(Some(Turn::Idle), Some(true), None), &target(Some(asking), None)), (None, None));
    }

    #[test]
    fn a_report_without_a_serving_relay_ends_the_turn_and_keeps_the_question() {
        let asking = RelayActivity { is_turn_running: true, is_question: Some(true) };
        let ended = RelayActivity { is_turn_running: false, is_question: Some(true) };
        assert_eq!(report_changes(&report(None, None, None), &target(Some(asking), None)), (Some(ended), None));
        assert_eq!(report_changes(&report(None, Some(false), None), &target(Some(ended), None)), (None, None));
        let unknown = RelayActivity { is_turn_running: false, is_question: None };
        assert_eq!(report_changes(&report(None, None, None), &target(None, None)), (Some(unknown), None));
    }

    #[test]
    fn a_report_records_the_end_of_the_last_turn_when_it_is_later_than_the_last_known_work() {
        let idle = RelayActivity { is_turn_running: false, is_question: Some(false) };
        let ended_at = DateTime::from_timestamp_millis(1_760_000_000_000);
        let idle_report = report(Some(Turn::Idle), Some(false), Some(1_760_000_000_000));
        assert_eq!(report_changes(&idle_report, &target(Some(idle), None)), (None, ended_at));
        let earlier = DateTime::from_timestamp_millis(1_759_000_000_000);
        assert_eq!(report_changes(&idle_report, &target(Some(idle), earlier)), (None, ended_at));
        assert_eq!(report_changes(&idle_report, &target(Some(idle), ended_at)), (None, None));
        let later = DateTime::from_timestamp_millis(1_761_000_000_000);
        assert_eq!(report_changes(&idle_report, &target(Some(idle), later)), (None, None));
    }
}
