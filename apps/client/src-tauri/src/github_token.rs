//! The GitHub token remote sessions push and use `gh` with: one fine-grained personal access token per user, kept in
//! the macOS keychain. Hunt hands it to the session's VM, where `hunt-ctl` keeps it in `/etc/hunt/github-token` for
//! gh's wrapper and git's credential helper.

use serde::Serialize;

use crate::keychain;

const KEYCHAIN_SERVICE: &str = "Hunt GitHub token";
const KEYCHAIN_ACCOUNT: &str = "default";

/// Whether a token is stored, with its last four characters to tell tokens apart.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTokenStatus {
    pub saved: bool,
    pub hint: Option<String>,
}

/// The stored token; `None` without one.
pub async fn read() -> Result<Option<String>, String> {
    keychain::read(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).await.map_err(|error| format!("failed to read the GitHub token: {error}"))
}

fn status_of(token: Option<&str>) -> GithubTokenStatus {
    GithubTokenStatus { saved: token.is_some(), hint: token.and_then(|token| token.get(token.len().saturating_sub(4)..)).map(str::to_string) }
}

/// Trims the token; rejects an empty one or one with whitespace inside, which the VM's env file cannot carry.
fn validate(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("the GitHub token is empty".into());
    }
    if token.chars().any(char::is_whitespace) {
        return Err("the GitHub token must not contain whitespace".into());
    }
    Ok(token)
}

#[tauri::command]
pub async fn github_token_status() -> Result<GithubTokenStatus, String> {
    Ok(status_of(read().await?.as_deref()))
}

/// Stores `token` for remote sessions started from now on, replacing an earlier one.
#[tauri::command]
pub async fn set_github_token(token: String) -> Result<GithubTokenStatus, String> {
    let token = validate(&token)?;
    keychain::store(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token).await.map_err(|error| format!("failed to store the GitHub token: {error}"))?;
    Ok(status_of(Some(token)))
}

#[tauri::command]
pub async fn remove_github_token() -> Result<GithubTokenStatus, String> {
    keychain::delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).await.map_err(|error| format!("failed to remove the GitHub token: {error}"))?;
    Ok(status_of(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_trims_and_rejects_inner_whitespace() {
        assert_eq!(validate("  github_pat_abc\n"), Ok("github_pat_abc"));
        assert!(validate(" ").is_err());
        assert!(validate("github_pat a").is_err());
    }

    #[test]
    fn status_shows_the_last_four_characters() {
        assert_eq!(status_of(Some("github_pat_1234abcd")), GithubTokenStatus { saved: true, hint: Some("abcd".into()) });
        assert_eq!(status_of(None), GithubTokenStatus { saved: false, hint: None });
    }
}
