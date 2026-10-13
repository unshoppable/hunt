//! The Claude account Hunt starts Claude Code with: the local login (`claude /login`, kept by Claude Code itself) or a
//! named long-lived OAuth token from `claude setup-token`. Names and the active choice live in `accounts.json` in the
//! app data folder; tokens live in the macOS keychain (`keychain.rs`).
//! Hunt creates the token itself: it runs `claude setup-token` and opens its sign-in in a private browser window with
//! the account's email filled in, so no session of another account interferes.

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::keychain;
use crate::lsp::kill_group;
use crate::session::store;

/// Claude Code takes an OAuth token from this variable in place of the local login.
pub const TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";

const KEYCHAIN_SERVICE: &str = "Hunt Claude account";
const FILE_NAME: &str = "accounts.json";

/// Prefix of the tokens `claude setup-token` prints.
const TOKEN_PREFIX: &str = "sk-ant-oat";
/// How long the browser sign-in of `claude setup-token` may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Browsers that open a private window from the command line, by app name, with the flag for it; the first one
/// installed opens the sign-in. Arc and Safari have no such flag.
const PRIVATE_BROWSERS: [(&str, &str); 4] =
    [("Google Chrome", "--incognito"), ("Brave Browser", "--incognito"), ("Microsoft Edge", "--inprivate"), ("Firefox", "--private-window")];

/// Serializes every read-modify-write of `accounts.json` together with its keychain change.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Cancels the running sign-in; `None` while none runs.
static SIGN_IN_CANCEL: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: Uuid,
    pub email: String,
}

/// The token accounts in the order they were added and the one in use; `None` uses the local login.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    #[serde(default)]
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub active_id: Option<Uuid>,
}

impl Accounts {
    fn find(&self, id: Uuid) -> Option<&Account> {
        self.accounts.iter().find(|account| account.id == id)
    }
}

/// The OAuth token of the active account, `None` for the local login. Spawners of Claude Code set it as `TOKEN_ENV`.
pub async fn active_token(app: &AppHandle) -> Result<Option<String>, String> {
    let accounts = read_file(&file_path(app)?)?;
    let Some(account) = accounts.active_id.and_then(|id| accounts.find(id)) else { return Ok(None) };
    read_token(account.id)
        .await
        .map(Some)
        .map_err(|error| format!("failed to read the token of the Claude account {}: {error}", account.email))
}

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(store::app_data_dir(app)?.join(FILE_NAME))
}

fn read_file(path: &Path) -> Result<Accounts, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("failed to read {FILE_NAME}: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Accounts::default()),
        Err(error) => Err(format!("failed to read {FILE_NAME}: {error}")),
    }
}

fn write_file(path: &Path, accounts: &Accounts) -> Result<(), String> {
    let json = serde_json::to_string_pretty(accounts).map_err(|error| format!("failed to write {FILE_NAME}: {error}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json).map_err(|error| format!("failed to write {FILE_NAME}: {error}"))?;
    std::fs::rename(&temp, path).map_err(|error| format!("failed to write {FILE_NAME}: {error}"))
}

/// Stores `token` under `id` in the keychain, replacing an earlier one.
async fn store_token(id: Uuid, token: &str) -> Result<(), String> {
    keychain::store(KEYCHAIN_SERVICE, &id.to_string(), token).await
}

async fn read_token(id: Uuid) -> Result<String, String> {
    keychain::read(KEYCHAIN_SERVICE, &id.to_string()).await?.ok_or_else(|| "the keychain has no token for it".to_string())
}

/// Deletes the token stored under `id`; a missing one counts as deleted.
async fn delete_token(id: Uuid) -> Result<(), String> {
    keychain::delete(KEYCHAIN_SERVICE, &id.to_string()).await
}

/// The first token in the terminal output of `claude setup-token`; `None` until it has arrived in full, i.e. a character
/// that cannot be part of it follows.
fn find_token(output: &str) -> Option<&str> {
    let rest = &output[output.find(TOKEN_PREFIX)?..];
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))?;
    Some(&rest[..end])
}

/// Trims the email; rejects one without `@` or with whitespace inside.
fn validate_email(email: &str) -> Result<String, String> {
    let email = email.trim();
    if !email.contains('@') || email.chars().any(char::is_whitespace) {
        return Err(format!("{email} is not an email address"));
    }
    Ok(email.to_string())
}

/// `value` as a URL query value: every byte but the unreserved characters percent-encoded.
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// `value` as one single-quoted `sh` word.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The app bundle and private-window flag of the first installed browser of `PRIVATE_BROWSERS`.
fn private_browser() -> Option<(PathBuf, &'static str)> {
    let dirs = [Some(PathBuf::from("/Applications")), std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications"))];
    PRIVATE_BROWSERS.iter().find_map(|(name, flag)| {
        let bundle = format!("{name}.app");
        dirs.iter().flatten().map(|dir| dir.join(&bundle)).find(|path| path.exists()).map(|path| (path, *flag))
    })
}

/// An `open` stand-in for `claude setup-token`: it opens the sign-in URL (its last argument) with `login_hint`, which
/// fills in `email` on the login page, in a private window of `browser`, or in the default browser without one.
fn open_shim_script(email: &str, browser: Option<&(PathBuf, &str)>) -> String {
    let url = format!("\"$url&login_hint={}\"", percent_encode(email));
    let open = match browser {
        Some((app, flag)) => format!("/usr/bin/open -na {} --args {flag} {url}", shell_quote(&app.to_string_lossy())),
        None => format!("/usr/bin/open {url}"),
    };
    format!("#!/bin/sh\nfor url in \"$@\"; do :; done\nexec {open}\n")
}

/// Writes the `open` stand-in for `email` into a new temp folder only the user can read; that folder goes first on the
/// `PATH` of `claude setup-token`.
fn write_open_shim(email: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("hunt-sign-in-{}", Uuid::new_v4()));
    let shim = dir.join("open");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .and_then(|_| std::fs::write(&shim, open_shim_script(email, private_browser().as_ref())))
        .and_then(|_| std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700)))
        .map_err(|error| format!("failed to prepare the private browser window: {error}"))?;
    Ok(dir)
}

/// Runs `claude setup-token` with its sign-in in a private window filled in with `email` and reads the token it prints.
async fn create_token(email: &str, cancel: oneshot::Receiver<()>) -> Result<String, String> {
    let shim_dir = write_open_shim(email)?;
    let mut command = Command::new("/usr/bin/script");
    command.env("PATH", format!("{}:{}", shim_dir.display(), std::env::var("PATH").unwrap_or_default()));
    let result = run_setup_token(command, cancel).await;
    let _ = std::fs::remove_dir_all(shim_dir);
    result
}

/// Runs `claude setup-token` through `command` (`script`, which gives it a pseudo terminal) and reads the token it
/// prints. The terminal is 500 columns wide, so the token is printed on one line.
async fn run_setup_token(mut command: Command, cancel: oneshot::Receiver<()>) -> Result<String, String> {
    let mut child = command
        .args(["-q", "/dev/null", "/bin/sh", "-c", "stty cols 500 rows 50 && exec claude setup-token"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Its own process group, so stopping it stops `claude` along with `script`.
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start claude setup-token: {error}"))?;
    // `script` passes the end of its input on to the terminal, which would end the sign-in; the pipe stays open.
    let _stdin = child.stdin.take();
    let mut stdout = child.stdout.take().ok_or("claude setup-token stdout is not available")?;

    let read_output = async {
        let mut output = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let count = stdout.read(&mut chunk).await.map_err(|error| error.to_string())?;
            if count == 0 {
                return Err("claude setup-token ended without printing a token".to_string());
            }
            output.extend_from_slice(&chunk[..count]);
            if let Some(token) = find_token(&String::from_utf8_lossy(&output)) {
                return Ok(token.to_string());
            }
        }
    };
    let result = tokio::select! {
        result = read_output => result,
        _ = cancel => Err("the sign-in was cancelled".to_string()),
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err("the sign-in timed out".to_string()),
    };
    kill_group(&mut child);
    result
}

/// Stores `token` for the account of `email` and makes it the active one; an account with that email already gets the
/// new token in place of its old one.
async fn upsert_account(app: &AppHandle, email: String, token: &str) -> Result<Accounts, String> {
    let _guard = LOCK.lock().await;
    let mut accounts = read_file(&file_path(app)?)?;
    let existing = accounts.accounts.iter().find(|account| account.email.eq_ignore_ascii_case(&email)).map(|account| account.id);
    let id = existing.unwrap_or_else(Uuid::new_v4);
    store_token(id, token).await?;
    if existing.is_none() {
        accounts.accounts.push(Account { id, email });
    }
    accounts.active_id = Some(id);
    save(app, &accounts)?;
    Ok(accounts)
}

/// Writes `accounts` and tells every window, so the main window reads the plan usage of the new account.
fn save(app: &AppHandle, accounts: &Accounts) -> Result<(), String> {
    write_file(&file_path(app)?, accounts)?;
    let _ = app.emit("accounts:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn list_accounts(app: AppHandle) -> Result<Accounts, String> {
    let _guard = LOCK.lock().await;
    read_file(&file_path(&app)?)
}

/// Creates a token through the sign-in of `claude setup-token`, opened in a private window with `email` filled in, and
/// makes it the active account. Resolves once the user signed in, cancelled (`cancel_sign_in`) or the sign-in timed out.
#[tauri::command]
pub async fn sign_in_account(app: AppHandle, email: String) -> Result<Accounts, String> {
    let email = validate_email(&email)?;
    let (cancel_sender, cancel) = oneshot::channel();
    {
        let mut running = SIGN_IN_CANCEL.lock().unwrap();
        if running.is_some() {
            return Err("a sign-in is already running".into());
        }
        *running = Some(cancel_sender);
    }
    let token = create_token(&email, cancel).await;
    SIGN_IN_CANCEL.lock().unwrap().take();
    let token = token.map_err(|error| format!("failed to create a token: {error}"))?;
    upsert_account(&app, email, &token).await
}

/// Stops the running sign-in of `sign_in_account`; a no-op while none runs.
#[tauri::command]
pub fn cancel_sign_in() {
    if let Some(cancel) = SIGN_IN_CANCEL.lock().unwrap().take() {
        let _ = cancel.send(());
    }
}

/// Removes a token account and its token; removing the active one switches to the local login.
#[tauri::command]
pub async fn remove_account(app: AppHandle, id: Uuid) -> Result<Accounts, String> {
    let _guard = LOCK.lock().await;
    let mut accounts = read_file(&file_path(&app)?)?;
    delete_token(id).await?;
    accounts.accounts.retain(|account| account.id != id);
    if accounts.active_id == Some(id) {
        accounts.active_id = None;
    }
    save(&app, &accounts)?;
    Ok(accounts)
}

/// Selects the account for every Claude Code process started from now on; `None` selects the local login.
#[tauri::command]
pub async fn set_active_account(app: AppHandle, id: Option<Uuid>) -> Result<Accounts, String> {
    let _guard = LOCK.lock().await;
    let mut accounts = read_file(&file_path(&app)?)?;
    if let Some(id) = id {
        accounts.find(id).ok_or("the account does not exist")?;
    }
    accounts.active_id = id;
    save(&app, &accounts)?;
    Ok(accounts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_reads_as_local_login() {
        let dir = std::env::temp_dir().join(format!("hunt-accounts-{}", Uuid::new_v4()));
        assert_eq!(read_file(&dir.join(FILE_NAME)).unwrap(), Accounts::default());
    }

    #[test]
    fn file_round_trips() {
        let dir = std::env::temp_dir().join(format!("hunt-accounts-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        let id = Uuid::new_v4();
        let accounts = Accounts { accounts: vec![Account { id, email: "a@b.c".into() }], active_id: Some(id) };
        write_file(&path, &accounts).unwrap();
        assert_eq!(read_file(&path).unwrap(), accounts);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finds_the_token_once_it_is_complete() {
        let screen = "\u{1b}[33msk-ant-oat01-Ab_c-9\u{1b}[39m\r\nStore this token securely.";
        assert_eq!(find_token(screen), Some("sk-ant-oat01-Ab_c-9"));
        assert_eq!(find_token("Your OAuth token: \u{1b}[33msk-ant-oat01-Ab"), None);
        assert_eq!(find_token("Opening browser to sign in…"), None);
    }

    #[test]
    fn validates_the_email() {
        assert_eq!(validate_email(" a.b@example.com ").unwrap(), "a.b@example.com");
        assert!(validate_email("example.com").is_err());
        assert!(validate_email("a b@example.com").is_err());
    }

    #[test]
    fn open_shim_adds_the_email_and_opens_a_private_window() {
        let browser = (PathBuf::from("/Applications/Google Chrome.app"), "--incognito");
        let script = open_shim_script("a.b+test@example.com", Some(&browser));
        assert!(script.ends_with(
            "exec /usr/bin/open -na '/Applications/Google Chrome.app' --args --incognito \"$url&login_hint=a.b%2Btest%40example.com\"\n"
        ));
        assert!(open_shim_script("a@b.c", None).ends_with("exec /usr/bin/open \"$url&login_hint=a%40b.c\"\n"));
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
