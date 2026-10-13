mod accounts;
mod acp;
mod git;
mod github;
mod github_token;
mod graph;
mod ide;
mod keychain;
mod lsp;
mod menu;
mod plan_usage;
mod preferences;
mod remote;
mod screenshots;
mod workspace;
mod session;

use acp::{PermissionRegistry, SessionRegistry};
use graph::WatcherRegistry;
use remote::terminal::TerminalRegistry;
use session::attribution::AttributionRegistry;
use session::dependencies::DependencyRegistry;
use session::summary::SummaryRegistry;
use tauri::webview::PageLoadEvent;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SessionRegistry::default())
        .manage(PermissionRegistry::default())
        .manage(WatcherRegistry::default())
        .manage(SummaryRegistry::default())
        .manage(DependencyRegistry::default())
        .manage(preferences::Preferences::default())
        .menu(|app| menu::build(app))
        .manage(AttributionRegistry::default())
        .manage(lsp::LspRegistry::default())
        .manage(TerminalRegistry::default())
        .invoke_handler(tauri::generate_handler![
            session::commands::list_sessions,
            session::commands::list_branches,
            session::commands::current_branch,
            session::commands::list_pull_requests,
            session::commands::github_viewer,
            session::commands::view_pull_request,
            session::commands::list_review_threads,
            session::commands::submit_pull_request_review,
            session::commands::add_review_comment,
            session::commands::update_review_comment,
            session::commands::delete_review_comment,
            session::commands::reply_to_review_thread,
            session::commands::resolve_review_thread,
            session::commands::create_session,
            session::commands::create_sub_session,
            session::commands::rename_session,
            session::commands::open_session,
            session::commands::clear_session,
            session::commands::hand_off_session,
            session::commands::retrieve_session,
            session::commands::snooze_remote_cleanup,
            session::commands::start_preview,
            session::commands::preview_status,
            session::commands::stop_preview,
            session::commands::restart_preview_process,
            session::commands::read_preview_log,
            session::commands::open_terminal,
            session::commands::write_terminal,
            session::commands::resize_terminal,
            session::commands::close_terminal,
            session::commands::prepare_dependencies,
            session::commands::close_session,
            session::commands::send_prompt,
            session::commands::session_history,
            session::commands::cancel_prompt,
            session::commands::set_session_mode,
            session::commands::set_session_config_option,
            session::commands::answer_permission,
            session::commands::list_changed_files,
            session::commands::change_stats,
            session::commands::read_file_diff,
            session::commands::read_file_history,
            session::commands::write_file,
            session::commands::revert_file,
            session::commands::delete_path,
            session::commands::move_path,
            session::commands::shelve_files,
            session::commands::list_shelves,
            session::commands::unshelve,
            session::commands::drop_shelf,
            session::commands::open_worktree_in_webstorm,
            session::commands::open_file_in_webstorm,
            session::commands::open_changed_files_diff_in_webstorm,
            session::commands::read_graph,
            session::commands::graph_status,
            session::commands::refresh_graph,
            session::commands::list_dir,
            session::commands::list_files,
            session::commands::read_file,
            session::commands::resolve_imports,
            session::commands::search_word,
            session::commands::list_screenshots,
            lsp::lsp_request,
            lsp::lsp_notify,
            lsp::lsp_cancel,
            preferences::set_ai_language,
            preferences::set_system_prompt,
            plan_usage::get_plan_usage,
            accounts::list_accounts,
            accounts::sign_in_account,
            accounts::cancel_sign_in,
            accounts::remove_account,
            accounts::set_active_account,
            github_token::github_token_status,
            github_token::set_github_token,
            github_token::remove_github_token,
        ])
        // A page that loads again (a reload) has lost its terminals, so they end with the old page.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview.app_handle().state::<TerminalRegistry>().close_owned_by(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().state::<TerminalRegistry>().close_owned_by(window.label());
            }
            // The other windows (editor, diff, guardrails, settings) belong to the main window: closing it closes them too, which ends the app.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                for (label, other) in window.app_handle().webview_windows() {
                    if label != "main" {
                        let _ = other.close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // `run` ends in process::exit, which skips Drop; stop the agent and language server processes explicitly first.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app.state::<TerminalRegistry>().close_all();
                let registry = app.state::<SessionRegistry>();
                let lsp_registry = app.state::<lsp::LspRegistry>();
                tauri::async_runtime::block_on(async {
                    tokio::join!(registry.shutdown_all(), lsp::shutdown_all(&lsp_registry));
                });
            }
        });
}
