//! The gzip'd tar archives a handoff packs for a session's VM and a retrieval unpacks from it.

use std::path::Path;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// A gzip'd tar of `entries` (paths relative to `dir`), without macOS AppleDouble files, `.DS_Store` and
/// `node_modules`.
pub(super) async fn tar_create(dir: &Path, entries: &[String]) -> Result<Vec<u8>, String> {
    let output = Command::new("tar")
        .env("COPYFILE_DISABLE", "1")
        .args(["-czf", "-", "--exclude", ".DS_Store", "--exclude", "node_modules", "-C"])
        .arg(dir)
        .arg("--")
        .args(entries)
        .output()
        .await
        .map_err(|error| format!("failed to run tar: {error}"))?;
    if !output.status.success() {
        return Err(format!("failed to pack {}: {}", dir.display(), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(output.stdout)
}

/// Unpacks the gzip'd tar `archive` into `dir`, which must exist.
pub(super) async fn tar_extract(archive: &[u8], dir: &Path) -> Result<(), String> {
    let mut child = Command::new("tar")
        .args(["-xzf", "-", "-C"])
        .arg(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run tar: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("failed to open the stdin of tar")?;
    let archive = archive.to_vec();
    let writer = tokio::spawn(async move {
        stdin.write_all(&archive).await?;
        stdin.shutdown().await
    });
    let output = child.wait_with_output().await.map_err(|error| format!("failed to run tar: {error}"))?;
    let _ = writer.await;
    if !output.status.success() {
        return Err(format!("failed to unpack into {}: {}", dir.display(), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}
