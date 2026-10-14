//! Generic passwords in the macOS keychain, written and read only through `/usr/bin/security`, which every item it
//! creates trusts, so a rebuilt Hunt binary reads them without a prompt.

use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// `security` exits with this code when no keychain item matches.
const ITEM_NOT_FOUND: i32 = 44;

/// Stores `secret` under `service` and `account`, replacing an earlier one. It goes in hex-encoded through stdin, never
/// as an argument other processes could see, and is read back because `security -i` exits with 0 even when a command
/// fails.
pub async fn store(service: &str, account: &str, secret: &str) -> Result<(), String> {
    let hex: String = secret.bytes().map(|byte| format!("{byte:02x}")).collect();
    let line = format!("add-generic-password -U -s \"{service}\" -l \"{service}\" -a \"{account}\" -X {hex}\n");
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start security: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("security stdin is not available")?;
    stdin.write_all(line.as_bytes()).await.map_err(|error| error.to_string())?;
    drop(stdin);
    let output = child.wait_with_output().await.map_err(|error| error.to_string())?;

    match read(service, account).await {
        Ok(Some(stored)) if stored == secret => Ok(()),
        _ => Err(format!("failed to store the secret in the keychain: {}", String::from_utf8_lossy(&output.stderr).trim())),
    }
}

/// The secret stored under `service` and `account`; `None` when the keychain has none.
pub async fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-a", account, "-w"])
        .output()
        .await
        .map_err(|error| format!("failed to start security: {error}"))?;
    if output.status.code() == Some(ITEM_NOT_FOUND) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).trim().to_string()))
}

/// Deletes the secret stored under `service` and `account`; a missing one counts as deleted.
pub async fn delete(service: &str, account: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", service, "-a", account])
        .output()
        .await
        .map_err(|error| format!("failed to start security: {error}"))?;
    if output.status.success() || output.status.code() == Some(ITEM_NOT_FOUND) {
        return Ok(());
    }
    Err(format!("failed to delete the secret from the keychain: {}", String::from_utf8_lossy(&output.stderr).trim()))
}
