//! The pages of a local session's apps: the services of the worktree's hunt.json (`crate::services`) marked
//! `"frontend": true` whose port accepts connections on this Mac. The inspector's "Browser" stays disabled until one
//! does and opens a tab of the session's Chrome for each (`crate::agent::browser`). Knows nothing about Tauri;
//! `session/commands/browser.rs` owns the commands.

use std::path::Path;

use serde::Serialize;

use crate::services;

/// A frontend service of hunt.json whose port accepts connections on this Mac.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppPage {
    pub name: String,
    /// `http://localhost:<port>`, `https://` for a service with `tls`.
    pub url: String,
}

/// The frontend services of the worktree's hunt.json that run now, in the file's order; their ports are asked at once.
/// A malformed hunt.json has none; the Terminal tab reports its problem.
pub async fn running_pages(worktree: &Path) -> Vec<AppPage> {
    let frontends: Vec<(AppPage, u16)> = services::read_services(worktree)
        .unwrap_or_default()
        .into_iter()
        .filter(|definition| definition.frontend)
        .filter_map(|definition| {
            let port = definition.port?;
            let scheme = if definition.tls { "https" } else { "http" };
            Some((AppPage { name: definition.name, url: format!("{scheme}://localhost:{port}") }, port))
        })
        .collect();
    let listening = futures_util::future::join_all(frontends.iter().map(|(_, port)| services::is_listening(*port))).await;
    frontends.into_iter().zip(listening).filter(|(_, is_listening)| *is_listening).map(|((page, _), _)| page).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn running_pages_are_the_frontend_services_whose_port_listens() {
        let listener = |address: &str| std::net::TcpListener::bind((address, 0)).unwrap();
        let (ui, admin, api, docs) = (listener("::1"), listener("127.0.0.1"), listener("127.0.0.1"), listener("127.0.0.1"));
        let port = |listener: &std::net::TcpListener| listener.local_addr().unwrap().port();
        let closed = port(&listener("127.0.0.1"));
        let worktree = tempfile::tempdir().unwrap();
        let hunt_json = format!(
            r#"{{ "services": {{
                "api": {{ "command": "npm run api", "port": {} }},
                "ui": {{ "command": "npm run ui", "port": {}, "frontend": true }},
                "off": {{ "command": "npm run off", "port": {closed}, "frontend": true }},
                "admin": {{ "command": "npm run admin", "port": {}, "frontend": true, "tls": true }},
                "docs": {{ "command": "npm run docs", "port": {}, "frontend": false }},
                "storybook": {{ "command": "npm run storybook", "frontend": true }}
            }} }}"#,
            port(&api),
            port(&ui),
            port(&admin),
            port(&docs),
        );
        std::fs::write(worktree.path().join("hunt.json"), hunt_json).unwrap();
        assert_eq!(
            running_pages(worktree.path()).await,
            [
                AppPage { name: "ui".into(), url: format!("http://localhost:{}", port(&ui)) },
                AppPage { name: "admin".into(), url: format!("https://localhost:{}", port(&admin)) },
            ]
        );
    }

    #[tokio::test]
    async fn a_worktree_without_hunt_json_has_no_pages() {
        assert!(running_pages(tempfile::tempdir().unwrap().path()).await.is_empty());
    }
}
