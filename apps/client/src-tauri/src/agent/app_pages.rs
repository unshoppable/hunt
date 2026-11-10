//! The pages of a session's apps: the services of the worktree's hunt.json (`crate::services`) marked
//! `"frontend": true` whose port accepts connections, on this Mac for a local session and on its VM for a remote one,
//! whose pages are those of its preview (`crate::remote::preview`). The inspector's "Browser" stays disabled until one
//! does and opens a tab of the session's Chrome for each (`crate::agent::browser`). Knows nothing about Tauri;
//! `session/commands/browser.rs` owns the commands.

use std::path::Path;

use serde::Serialize;

use crate::remote::preview::PreviewStatus;
use crate::services;

/// A frontend service of hunt.json whose port accepts connections.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppPage {
    pub name: String,
    /// `http://localhost:<port>`, `https://` for a service with `tls`; the preview URL for a remote session.
    pub url: String,
}

/// The names of the frontend services of the worktree's hunt.json, in the file's order; none for a malformed file.
pub fn frontend_names(worktree: &Path) -> Vec<String> {
    let definitions = services::read_services(worktree).unwrap_or_default();
    definitions.into_iter().filter(|definition| definition.frontend).map(|definition| definition.name).collect()
}

/// The frontend services of a remote session's preview `status` whose port listens on the VM, at their preview URLs.
pub fn remote_pages(status: &PreviewStatus) -> Vec<AppPage> {
    let shown = status.services.iter().filter(|service| service.frontend && service.responds);
    shown.map(|service| AppPage { name: service.name.clone(), url: service.url.clone() }).collect()
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
        assert!(frontend_names(tempfile::tempdir().unwrap().path()).is_empty());
    }

    #[test]
    fn remote_pages_are_the_frontend_services_that_respond_at_their_preview_urls() {
        let worktree = tempfile::tempdir().unwrap();
        let hunt_json = r#"{ "services": {
            "api": { "command": "npm run api", "port": 3000 },
            "ui": { "command": "npm run ui", "port": 4200, "frontend": true },
            "admin": { "command": "npm run admin", "port": 4300, "frontend": true }
        } }"#;
        std::fs::write(worktree.path().join("hunt.json"), hunt_json).unwrap();
        let frontends = frontend_names(worktree.path());
        assert_eq!(frontends, ["ui", "admin"]);

        let service = |name: &str, port: u16, responds: bool| {
            serde_json::json!({"name": name, "port": port, "guarded": true, "tls": false, "enabled": true, "state": "running", "responds": responds})
        };
        let output = serde_json::json!({"services": [service("api", 3000, true), service("ui", 4200, true), service("admin", 4300, false)]});
        let id = uuid::Uuid::parse_str("ab12cd34-0000-4000-8000-000000000000").unwrap();
        let mut status = crate::remote::preview::parse_status(&output, id, "p.example.com").unwrap();
        assert!(remote_pages(&status).is_empty());
        crate::remote::preview::mark_frontends(&mut status, &frontends);
        assert_eq!(remote_pages(&status), [AppPage { name: "ui".into(), url: "https://ab12cd34-4200.p.example.com".into() }]);
    }
}
