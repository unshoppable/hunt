//! Runs of a job per key that concurrent callers share: a caller joins the run that has not started its work yet, or,
//! while one is under way, queues the single follow-up run that every caller arriving meanwhile shares. A result
//! therefore always comes from a run that started after its caller called, so it never misses a change made before the
//! call, while a burst of callers costs at most two runs.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;

type Outcome<V> = Option<Result<V, String>>;

/// A run that has not started its work yet: its callers wait on `receiver`, the driver sends through `sender`.
struct PendingRun<V> {
    sender: watch::Sender<Outcome<V>>,
    receiver: watch::Receiver<Outcome<V>>,
}

impl<V> PendingRun<V> {
    fn new() -> Self {
        let (sender, receiver) = watch::channel(None);
        Self { sender, receiver }
    }
}

/// The keys whose driver task lives, each with the pending run that callers join, if any.
type Slots<K, V> = Arc<Mutex<HashMap<K, Option<PendingRun<V>>>>>;

pub struct SingleFlight<K, V> {
    slots: Slots<K, V>,
    /// How long the first run of an idle key waits for further callers before it starts, so that callers which react
    /// to the same event in several windows share it.
    gather: Duration,
}

impl<K, V> SingleFlight<K, V>
where
    K: Eq + Hash + Clone + Send + 'static,
    V: Clone + Send + Sync + 'static,
{
    pub fn new(gather: Duration) -> Self {
        Self { slots: Arc::new(Mutex::new(HashMap::new())), gather }
    }

    /// The result of a run of `job` for `key` that starts after this call: the pending run when there is one,
    /// otherwise a new one, which starts after the run under way for `key` ends. Every run of `key` runs the `job` of
    /// the caller that found the key idle, so all jobs of one key must do the same work.
    pub async fn run<F, Fut>(&self, key: K, job: F) -> Result<V, String>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<V, String>> + Send + 'static,
    {
        let mut receiver = {
            let mut slots = self.slots.lock().expect("single-flight lock poisoned");
            match slots.get_mut(&key) {
                Some(pending) => pending.get_or_insert_with(PendingRun::new).receiver.clone(),
                None => {
                    let run = PendingRun::new();
                    let receiver = run.receiver.clone();
                    slots.insert(key.clone(), Some(run));
                    tokio::spawn(drive(self.slots.clone(), key, job, self.gather));
                    receiver
                }
            }
        };
        const ENDED: &str = "failed to run the job: its task ended without a result";
        let outcome = receiver.wait_for(Option::is_some).await.map_err(|_| ENDED.to_string())?;
        outcome.clone().unwrap_or_else(|| Err(ENDED.to_string()))
    }
}

/// Runs `job` for every pending run of `key`, one after the other, until none is left, and then forgets `key`.
async fn drive<K, V, F, Fut>(slots: Slots<K, V>, key: K, job: F, gather: Duration)
where
    K: Eq + Hash,
    F: Fn() -> Fut,
    Fut: Future<Output = Result<V, String>>,
{
    tokio::time::sleep(gather).await;
    loop {
        let sender = {
            let mut slots = slots.lock().expect("single-flight lock poisoned");
            let Some(run) = slots.get_mut(&key).and_then(Option::take) else {
                slots.remove(&key);
                return;
            };
            run.sender
        };
        let outcome = job().await;
        sender.send_replace(Some(outcome));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A job that counts its runs, takes `duration` and returns the number of its run.
    fn counting_job(runs: Arc<AtomicU32>, duration: Duration) -> impl Fn() -> Pin<Box<dyn Future<Output = Result<u32, String>> + Send>> {
        move || {
            let runs = runs.clone();
            Box::pin(async move {
                let run = runs.fetch_add(1, Ordering::SeqCst) + 1;
                tokio::time::sleep(duration).await;
                Ok(run)
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_callers_share_one_run() {
        let flights = Arc::new(SingleFlight::new(Duration::from_millis(20)));
        let runs = Arc::new(AtomicU32::new(0));

        let callers: Vec<_> = (0..8)
            .map(|_| {
                let flights = flights.clone();
                let job = counting_job(runs.clone(), Duration::from_millis(30));
                tokio::spawn(async move { flights.run("worktree", job).await })
            })
            .collect();
        let mut results = Vec::new();
        for caller in callers {
            results.push(caller.await.unwrap().unwrap());
        }

        assert_eq!(results, vec![1; 8]);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(flights.slots.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn callers_during_a_run_share_exactly_one_follow_up_that_starts_after_them() {
        let flights = Arc::new(SingleFlight::new(Duration::ZERO));
        let runs = Arc::new(AtomicU32::new(0));
        let first = {
            let flights = flights.clone();
            let job = counting_job(runs.clone(), Duration::from_millis(150));
            tokio::spawn(async move { flights.run("worktree", job).await })
        };
        while runs.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }

        let during: Vec<_> = (0..5)
            .map(|_| {
                let flights = flights.clone();
                let job = counting_job(runs.clone(), Duration::from_millis(150));
                tokio::spawn(async move { flights.run("worktree", job).await })
            })
            .collect();
        let mut results = Vec::new();
        for caller in during {
            results.push(caller.await.unwrap().unwrap());
        }

        assert_eq!(first.await.unwrap().unwrap(), 1);
        assert_eq!(results, vec![2; 5]);
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert!(flights.slots.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn keys_run_independently_and_errors_reach_every_caller() {
        let flights = SingleFlight::<&str, u32>::new(Duration::ZERO);
        let failing = || async { Err::<u32, String>("failed to list the changes: boom".to_string()) };

        let (left, right, failed) = tokio::join!(
            flights.run("left", || async { Ok(1) }),
            flights.run("right", || async { Ok(2) }),
            flights.run("failing", failing),
        );

        assert_eq!((left, right), (Ok(1), Ok(2)));
        assert_eq!(failed, Err("failed to list the changes: boom".to_string()));
        // A key that went idle starts a fresh run.
        assert_eq!(flights.run("left", || async { Ok(3) }).await, Ok(3));
    }
}
