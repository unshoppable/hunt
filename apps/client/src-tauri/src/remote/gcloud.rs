//! The gcloud CLI, which Hunt runs to register its SSH key with OS Login and to look up the gateway.

use tokio::process::Command;

/// Runs gcloud with `args` and returns its standard output.
pub(super) async fn gcloud(args: &[&str]) -> Result<String, String> {
    let output = Command::new("gcloud").args(args).output().await.map_err(|error| format!("failed to run gcloud: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("failed to run gcloud {}: {stderr}", args.iter().take(3).copied().collect::<Vec<_>>().join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
