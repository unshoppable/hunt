//! The status channel of a remote session: the status helper on its VM (`session/statusHelper.mjs` of the installed
//! session release, run over the shared SSH connection as the agent's user) reports what the session's relay records in
//! its status whenever the turn, the question or the end of the last turn changes, and delivers each annotation a person
//! made with the review widget on a preview page of the VM once. Messages are JSON lines, first `{"t":"ready"}`, then one
//! `{"t":"status",…}` per change and one `{"t":"annotation","annotation":{…}}` per annotation; the helper ends with its
//! stdin. The helper only reads, so the channel neither starts a stopped VM nor keeps one awake. Knows nothing about
//! Tauri.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::oneshot;

use super::ssh::Ssh;
use crate::platform::shell::shell_command;

/// The status helper of the installed session release and the Node that runs it.
const HELPER: &str = "/srv/hunt/current/session/statusHelper.mjs";
const NODE: &str = "/opt/hunt/node/bin/node";

/// How long the helper may take to read the relay's status for the first time.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// The turn of a relay that serves the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Turn {
    Running,
    Idle,
}

/// What the relay records, as the helper reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// `None` while no relay serves the session.
    pub turn: Option<Turn>,
    /// Whether the agent waits for the user's answer to a question; `None` from an older relay that does not record it.
    pub question: Option<bool>,
    /// When the last turn ended (Unix ms); `None` when none ended since the relay started.
    pub last_turn_ended_at: Option<i64>,
}

/// An annotation a person made with the review widget on a preview page of the VM, as the review server stored it
/// (mirror of `StoredBrowserAnnotation` in `libs/domain/src/review/browser-annotation.utils.ts`); unknown fields are ignored.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// A random UUID the review server assigns.
    pub id: String,
    /// When the review server received it (Unix ms).
    pub created_at: i64,
    pub url: String,
    pub title: String,
    /// A CSS selector that matches the picked element only.
    pub selector: String,
    /// The element's visible text, shortened.
    pub text: String,
    /// The element's HTML, shortened.
    pub outer_html: String,
    /// The element's box in CSS pixels of the viewport.
    pub rect: AnnotationRect,
    pub viewport: AnnotationViewport,
    /// A few computed styles of the element, by CSS property.
    pub styles: BTreeMap<String, String>,
    /// Where the element is rendered in the app's sources, when the page tells.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AnnotationSource>,
    pub comment: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct AnnotationRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct AnnotationViewport {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct AnnotationSource {
    pub file: String,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
}

/// What the helper reports once it is ready.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Status(Report),
    /// An annotation of the review widget, delivered once.
    Annotation(Annotation),
    /// The channel ended, with what the helper or ssh said last.
    Closed(String),
}

/// The open channel to the status helper of one VM; dropping it ends the helper.
pub struct StatusChannel {
    /// The ssh process, whose stdin stays open as long as it lives, so the helper keeps running.
    _child: Child,
}

impl StatusChannel {
    /// Starts the helper on the VM behind `ssh` and returns once it is ready; every later report goes to `on_event`, the
    /// last being `Event::Closed`. A helper that ends before it is ready, such as on a VM whose release lacks it, fails
    /// the call with what it said.
    pub async fn open(ssh: &Ssh, on_event: impl Fn(Event) + Send + 'static) -> Result<StatusChannel, String> {
        let command = shell_command("sudo", &["-n", "-u", "agent", NODE, HELPER]);
        let mut child = ssh.spawn(&command)?;
        let stdout = child.stdout.take().ok_or("failed to open the output of the status helper")?;
        let mut stderr = child.stderr.take().ok_or("failed to open the errors of the status helper")?;
        let (ready, is_ready) = oneshot::channel::<Result<(), String>>();
        tokio::spawn(async move {
            let errors = tokio::spawn(async move {
                let mut bytes = Vec::new();
                let _ = stderr.read_to_end(&mut bytes).await;
                String::from_utf8_lossy(&bytes).trim().to_string()
            });
            let mut ready = Some(ready);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match parse_message(&line) {
                    Some(Message::Ready) => {
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(Ok(()));
                        }
                    }
                    Some(Message::Status(report)) => on_event(Event::Status(report)),
                    Some(Message::Annotation(annotation)) => on_event(Event::Annotation(annotation)),
                    None => {}
                }
            }
            let said = errors.await.unwrap_or_default();
            let said = if said.is_empty() { "the status helper on the VM ended".to_string() } else { said };
            match ready.take() {
                Some(ready) => {
                    let _ = ready.send(Err(said));
                }
                None => on_event(Event::Closed(said)),
            }
        });
        match tokio::time::timeout(READY_TIMEOUT, is_ready).await {
            Ok(Ok(Ok(()))) => Ok(StatusChannel { _child: child }),
            Ok(Ok(Err(said))) => Err(format!("failed to start the status helper on the VM: {said}")),
            Ok(Err(_)) => Err("failed to start the status helper on the VM: it ended before it was ready".into()),
            Err(_) => Err(format!("failed to start the status helper on the VM: it was not ready within {} s", READY_TIMEOUT.as_secs())),
        }
    }
}

/// A message of the helper, read.
#[derive(Debug, PartialEq)]
enum Message {
    Ready,
    Status(Report),
    Annotation(Annotation),
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Incoming {
    Ready,
    Status(Report),
    Annotation { annotation: Annotation },
}

/// Reads one line of the helper; `None` for a line it cannot read, such as a message of a newer helper.
fn parse_message(line: &str) -> Option<Message> {
    Some(match serde_json::from_str(line).ok()? {
        Incoming::Ready => Message::Ready,
        Incoming::Status(report) => Message::Status(report),
        Incoming::Annotation { annotation } => Message::Annotation(annotation),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ready_and_the_turn_of_a_status() {
        assert_eq!(parse_message(r#"{"t":"ready"}"#), Some(Message::Ready));
        let running = r#"{"t":"status","turn":"running","question":false,"lastTurnEndedAt":null}"#;
        let report = Report { turn: Some(Turn::Running), question: Some(false), last_turn_ended_at: None };
        assert_eq!(parse_message(running), Some(Message::Status(report)));
        let idle = r#"{"t":"status","turn":"idle","question":true,"lastTurnEndedAt":1760000000000}"#;
        let report = Report { turn: Some(Turn::Idle), question: Some(true), last_turn_ended_at: Some(1_760_000_000_000) };
        assert_eq!(parse_message(idle), Some(Message::Status(report)));
        let without_relay = r#"{"t":"status","turn":null,"question":null,"lastTurnEndedAt":null}"#;
        assert_eq!(parse_message(without_relay), Some(Message::Status(Report { turn: None, question: None, last_turn_ended_at: None })));
    }

    #[test]
    fn a_status_without_question_comes_from_an_older_relay() {
        let older = r#"{"t":"status","turn":"idle","lastTurnEndedAt":1760000000000}"#;
        let report = Report { turn: Some(Turn::Idle), question: None, last_turn_ended_at: Some(1_760_000_000_000) };
        assert_eq!(parse_message(older), Some(Message::Status(report)));
    }

    const ANNOTATION: &str = concat!(
        r#"{"t":"annotation","annotation":{"id":"5b0c","createdAt":1760000000000,"url":"https://app.example/cart","title":"Cart","#,
        r#""selector":"main > button.buy","text":"Buy","outerHtml":"<button class=\"buy\">Buy</button>","#,
        r#""rect":{"x":10,"y":20.5,"width":80,"height":32},"viewport":{"width":1280,"height":800},"styles":{"color":"rgb(0, 0, 0)"},"#,
        r#""source":{"file":"src/Cart.tsx","line":12,"column":5},"comment":"Make it blue","extra":true}}"#,
    );

    #[test]
    fn reads_an_annotation_and_ignores_unknown_fields() {
        let Some(Message::Annotation(annotation)) = parse_message(ANNOTATION) else { panic!("no annotation read") };
        assert_eq!(annotation.id, "5b0c");
        assert_eq!(annotation.created_at, 1_760_000_000_000);
        assert_eq!(annotation.outer_html, r#"<button class="buy">Buy</button>"#);
        assert_eq!(annotation.rect, AnnotationRect { x: 10.0, y: 20.5, width: 80.0, height: 32.0 });
        assert_eq!(annotation.viewport, AnnotationViewport { width: 1280.0, height: 800.0 });
        assert_eq!(annotation.styles, BTreeMap::from([("color".to_string(), "rgb(0, 0, 0)".to_string())]));
        assert_eq!(annotation.source, Some(AnnotationSource { file: "src/Cart.tsx".into(), line: 12, column: Some(5) }));
        assert_eq!(annotation.comment, "Make it blue");
    }

    #[test]
    fn an_annotation_without_source_or_column_keeps_them_out_of_the_frontend_payload() {
        let without_source = ANNOTATION.replace(r#""source":{"file":"src/Cart.tsx","line":12,"column":5},"#, "");
        let Some(Message::Annotation(annotation)) = parse_message(&without_source) else { panic!("no annotation read") };
        assert_eq!(annotation.source, None);
        let payload = serde_json::to_value(&annotation).unwrap();
        assert!(payload.get("source").is_none());
        assert_eq!(payload["outerHtml"], r#"<button class="buy">Buy</button>"#);
        assert_eq!(payload["createdAt"], 1_760_000_000_000_i64);

        let without_column = ANNOTATION.replace(r#","column":5"#, "");
        let Some(Message::Annotation(annotation)) = parse_message(&without_column) else { panic!("no annotation read") };
        assert_eq!(annotation.source, Some(AnnotationSource { file: "src/Cart.tsx".into(), line: 12, column: None }));
        assert_eq!(serde_json::to_value(&annotation).unwrap()["source"], serde_json::json!({ "file": "src/Cart.tsx", "line": 12 }));
    }

    #[test]
    fn skips_a_malformed_annotation() {
        assert_eq!(parse_message(r#"{"t":"annotation"}"#), None);
        assert_eq!(parse_message(&ANNOTATION.replace(r#""comment":"Make it blue","#, "")), None);
        assert_eq!(parse_message(&ANNOTATION.replace(r#""line":12"#, r#""line":"12""#)), None);
        assert_eq!(parse_message(&ANNOTATION.replace(r#""createdAt":1760000000000"#, r#""createdAt":"now""#)), None);
        assert_eq!(parse_message(&ANNOTATION.replace(r#""rect":{"x":10,"#, r#""rect":{"#)), None);
    }

    #[test]
    fn skips_lines_it_cannot_read() {
        assert_eq!(parse_message("not json"), None);
        assert_eq!(parse_message(""), None);
        assert_eq!(parse_message(r#"{"t":"hello"}"#), None);
        assert_eq!(parse_message(r#"{"turn":"running"}"#), None);
        assert_eq!(parse_message(r#"{"t":"status","turn":"paused"}"#), None);
        assert_eq!(parse_message(r#"{"t":"status","turn":"idle","lastTurnEndedAt":"yesterday"}"#), None);
    }
}
