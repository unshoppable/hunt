mod agent;
mod checks;
pub mod cli;
mod git;
mod github;
mod graph;
mod ide;
mod platform;
mod remote;
mod session;
mod terminal;

use agent::acp::{PermissionRegistry, SessionRegistry};
use agent::browser::BrowserRegistry;
use graph::WatcherRegistry;
use ide::{documents, find_in_files, lsp};
use platform::{control, external_links, legacy_identifier, menu, preferences};
use remote::desktop::DesktopRegistry;
use session::attribution::AttributionRegistry;
use session::commands::control::ControlRegistry;
use session::dependencies::DependencyRegistry;
use session::diagram_agent::DiagramRuns;
use session::summary::SummaryRegistry;
use session::sync::SyncRegistry;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};
use terminal::interactive::TerminalRegistry;
use terminal::tmux;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    legacy_identifier::migrate(&context.config().identifier);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(external_links::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SessionRegistry::default())
        .manage(PermissionRegistry::default())
        .manage(WatcherRegistry::default())
        .manage(session::worktree_watch::WorktreeWatchers::default())
        .manage(SummaryRegistry::default())
        .manage(SyncRegistry::default())
        .manage(session::link::LinkRegistry::default())
        .manage(session::related::RelatedRegistry::default())
        .manage(session::relay_watch::RelayWatchRegistry::default())
        .manage(DependencyRegistry::default())
        .manage(DiagramRuns::default())
        .manage(preferences::Preferences::default())
        .menu(|app| menu::build(app))
        .manage(AttributionRegistry::default())
        .manage(find_in_files::FindRegistry::default())
        .manage(lsp::LspRegistry::default())
        .manage(documents::DocumentRegistry::default())
        .manage(TerminalRegistry::default())
        .manage(DesktopRegistry::default())
        .manage(BrowserRegistry::default())
        .manage(ControlRegistry::default())
        .manage(checks::CheckRegistry::default())
        .invoke_handler(session::commands::handler())
        // The local agents steer the app through the control socket: their Playwright MCP wrappers open the session's
        // Chrome, `hunt-client` runs commands of the UI.
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let socket_path = match session::store::control_dir(&handle) {
                    Ok(control_dir) => control::socket_path(&control_dir),
                    Err(error) => {
                        eprintln!("failed to find the control folder: {error}");
                        return;
                    }
                };
                let carry_out = move |request| {
                    let handle = handle.clone();
                    async move { session::commands::control::carry_out(&handle, request).await }
                };
                if let Err(error) = control::serve(socket_path, carry_out).await {
                    eprintln!("{error}");
                }
            });
            Ok(())
        })
        // A page that loads again (a reload) has lost its terminals and its document replicas, so they end with the old page.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview.app_handle().state::<TerminalRegistry>().close_owned_by(webview.label());
                documents::release_owner(webview.app_handle(), webview.label());
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().state::<TerminalRegistry>().close_owned_by(window.label());
                documents::release_owner(window.app_handle(), window.label());
            }
            // The main window's traffic light hides it like a Mac app's: the agents keep running and the Dock icon shows it again.
            // Its popup windows hide with it (see popup/PopupWindow.tsx).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    if let Err(error) = window.emit("window:hidden", serde_json::json!({ "label": window.label() })) {
                        eprintln!("failed to announce the hidden main window: {error}");
                    }
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            // `run` ends in process::exit, which skips Drop; stop the agent, language server, tmux and Chrome processes explicitly
            // first.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app.state::<TerminalRegistry>().close_all();
                app.state::<checks::CheckRegistry>().cancel_everything();
                let registry = app.state::<SessionRegistry>();
                let lsp_registry = app.state::<lsp::LspRegistry>();
                let desktops = app.state::<DesktopRegistry>();
                let browsers = app.state::<BrowserRegistry>();
                tauri::async_runtime::block_on(async {
                    tokio::join!(
                        registry.shutdown_all(),
                        lsp::shutdown_all(&lsp_registry),
                        tmux::kill_all_servers(),
                        desktops.close_all(),
                        browsers.close_all()
                    );
                });
            }
        });
}
