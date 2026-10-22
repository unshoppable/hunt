//! The claude.ai plan rate limits (5-hour, weekly, weekly per model) of the signed-in Claude Code account, read
//! through the Agent SDK by `scripts/planUsage.mjs`.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command;

use crate::accounts;
use crate::acp::bundled_script_path;
use crate::session::store;

const SCRIPT: &str = "apps/client/scripts/planUsage.mjs";
const TIMEOUT: Duration = Duration::from_secs(15);

/// The plan limits in display order; empty when no plan limits apply (API key, Bedrock, Vertex) or the read was
/// refused for too many requests.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub subscription_type: Option<String>,
    pub windows: Vec<UsageWindow>,
    /// Set when the usage endpoint refused the read for too many requests: seconds until it answers again.
    pub retry_after_seconds: Option<u64>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub label: String,
    /// Percentage of the window used, 0–100.
    pub utilization: f64,
    /// ISO 8601 time the window resets.
    pub resets_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptOutput {
    subscription_type: Option<String>,
    #[serde(default)]
    rate_limits_available: bool,
    rate_limits: Option<RateLimits>,
    retry_after_seconds: Option<u64>,
}

/// The typed part of the SDK's experimental usage answer; every other field is ignored.
#[derive(Deserialize)]
struct RateLimits {
    five_hour: Option<RawWindow>,
    seven_day: Option<RawWindow>,
    seven_day_opus: Option<RawWindow>,
    seven_day_sonnet: Option<RawWindow>,
    #[serde(default)]
    model_scoped: Vec<ModelWindow>,
}

#[derive(Deserialize)]
struct RawWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Deserialize)]
struct ModelWindow {
    display_name: String,
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[tauri::command]
pub async fn get_plan_usage(app: AppHandle) -> Result<PlanUsage, String> {
    let script = bundled_script_path(&app, SCRIPT)?;
    let cwd = store::app_data_dir(&app)?;
    let mut command = Command::new("node");
    if let Some(token) = accounts::active_token(&app).await? {
        command.env(accounts::TOKEN_ENV, token);
    }
    let child = command
        .arg(script)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start node: {error}"))?;

    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "failed to read plan usage: no answer in time".to_string())?
        .map_err(|error| format!("failed to read plan usage: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("failed to read plan usage: node exited with {}: {}", output.status, stderr.trim()));
    }

    parse_output(&String::from_utf8_lossy(&output.stdout))
}

/// Maps the script output to the windows Hunt shows: 5-hour, weekly, then one weekly window per model; the Opus
/// and Sonnet windows stand in when the server lists no per-model windows.
fn parse_output(stdout: &str) -> Result<PlanUsage, String> {
    let output: ScriptOutput = serde_json::from_str(stdout.trim()).map_err(|error| format!("failed to read plan usage: {error}"))?;
    let mut windows = Vec::new();
    if let Some(limits) = output.rate_limits.filter(|_| output.rate_limits_available) {
        push_window(&mut windows, "5h", limits.five_hour);
        push_window(&mut windows, "Week", limits.seven_day);
        if limits.model_scoped.is_empty() {
            push_window(&mut windows, "Opus", limits.seven_day_opus);
            push_window(&mut windows, "Sonnet", limits.seven_day_sonnet);
        }
        for model in limits.model_scoped {
            let Some(utilization) = model.utilization else { continue };
            windows.push(UsageWindow { label: model.display_name, utilization, resets_at: model.resets_at });
        }
    }
    Ok(PlanUsage { subscription_type: output.subscription_type, windows, retry_after_seconds: output.retry_after_seconds })
}

fn push_window(windows: &mut Vec<UsageWindow>, label: &str, window: Option<RawWindow>) {
    let Some(RawWindow { utilization: Some(utilization), resets_at }) = window else { return };
    windows.push(UsageWindow { label: label.to_string(), utilization, resets_at });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(label: &str, utilization: f64, resets_at: &str) -> UsageWindow {
        UsageWindow { label: label.to_string(), utilization, resets_at: Some(resets_at.to_string()) }
    }

    #[test]
    fn maps_plan_windows_and_ignores_unknown_fields() {
        let stdout = r#"{"subscriptionType":"max","rateLimitsAvailable":true,"rateLimits":{
            "five_hour":{"utilization":8,"resets_at":"2026-10-12T11:10:00Z","limit_dollars":null},
            "seven_day":{"utilization":48,"resets_at":"2026-10-17T21:00:00Z"},
            "seven_day_opus":{"utilization":3,"resets_at":"2026-10-17T21:00:00Z"},
            "seven_day_sonnet":null,"iguana_necktie":{"utilization":0},"limits":[{"kind":"session"}],
            "model_scoped":[{"display_name":"Fable","utilization":94,"resets_at":"2026-10-17T21:00:00Z"}]}}"#;

        let usage = parse_output(stdout).unwrap();

        assert_eq!(usage.subscription_type.as_deref(), Some("max"));
        assert_eq!(
            usage.windows,
            vec![
                window("5h", 8.0, "2026-10-12T11:10:00Z"),
                window("Week", 48.0, "2026-10-17T21:00:00Z"),
                window("Fable", 94.0, "2026-10-17T21:00:00Z"),
            ]
        );
    }

    #[test]
    fn falls_back_to_opus_and_sonnet_without_model_windows() {
        let stdout = r#"{"subscriptionType":"pro","rateLimitsAvailable":true,"rateLimits":{
            "five_hour":null,"seven_day":{"utilization":null,"resets_at":null},
            "seven_day_opus":{"utilization":12,"resets_at":"2026-10-17T21:00:00Z"},
            "seven_day_sonnet":{"utilization":30,"resets_at":"2026-10-17T21:00:00Z"}}}"#;

        let labels: Vec<String> = parse_output(stdout).unwrap().windows.into_iter().map(|window| window.label).collect();

        assert_eq!(labels, ["Opus", "Sonnet"]);
    }

    #[test]
    fn has_no_windows_without_plan_limits() {
        let stdout = r#"{"subscriptionType":null,"rateLimitsAvailable":false,"rateLimits":null}"#;

        assert_eq!(parse_output(stdout).unwrap(), PlanUsage { subscription_type: None, windows: vec![], retry_after_seconds: None });
    }

    #[test]
    fn passes_on_the_wait_of_a_refused_read() {
        let stdout = r#"{"retryAfterSeconds":3264}"#;

        assert_eq!(parse_output(stdout).unwrap(), PlanUsage { subscription_type: None, windows: vec![], retry_after_seconds: Some(3264) });
    }
}
