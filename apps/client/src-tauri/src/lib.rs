mod accounts;
mod acp;
mod declined_guardrails;
mod documents;
mod external_links;
mod find_in_files;
mod formatter;
mod git;
mod github;
mod github_token;
mod graph;
mod ide;
mod keychain;
mod legacy_identifier;
mod lsp;
mod menu;
mod plan_usage;
mod preferences;
mod private_files;
mod remote;
mod screenshots;
mod workspace;
mod session;
mod terminal;

use acp::{PermissionRegistry, SessionRegistry};
use graph::WatcherRegistry;
use remote::terminal::TerminalRegistry;
use session::attribution::AttributionRegistry;
use session::dependencies::DependencyRegistry;
use session::diagram_agent::DiagramRuns;
use session::summary::SummaryRegistry;
use session::sync::SyncRegistry;
use tauri::webview::PageLoadEvent;
use tauri::Manager;

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
        .invoke_handler(tauri::generate_handler![
            session::commands::list_sessions,
            session::commands::list_branches,
            session::commands::current_branch,
            session::commands::fetch_repo_branch,
            session::commands::list_pull_requests,
            session::commands::issue_title,
            session::commands::github_viewer,
            session::commands::view_pull_request,
            session::commands::pull_request_state,
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
            session::commands::prepare_hand_off,
            session::commands::hand_off_session,
            session::commands::retrieve_session,
            session::commands::continue_locally,
            session::commands::remote_link,
            session::commands::snooze_remote_cleanup,
            session::commands::preview_status,
            session::commands::adopt_session_vms,
            session::commands::list_session_vms,
            session::commands::list_remote_secrets,
            session::commands::set_remote_secret,
            session::commands::delete_remote_secret,
            session::commands::set_remote_settings,
            session::commands::open_terminal,
            session::commands::open_local_terminal,
            session::commands::write_terminal,
            session::commands::resize_terminal,
            session::commands::close_terminal,
            session::commands::terminal_windows,
            session::commands::open_shell_window,
            session::commands::close_terminal_window,
            session::commands::prepare_dependencies,
            session::commands::close_session,
            session::commands::send_prompt,
            session::commands::session_history,
            session::commands::cancel_prompt,
            session::commands::set_session_mode,
            session::commands::set_session_config_option,
            session::commands::answer_permission,
            session::commands::list_changed_files,
            session::commands::git_log,
            session::commands::git_refs,
            session::commands::git_commit,
            session::commands::git_commit_file_diff,
            session::commands::git_rebase,
            session::commands::git_merge,
            session::commands::git_reset,
            session::commands::git_update_branch,
            session::commands::git_pull_branch,
            session::commands::git_force_pull_branch,
            session::commands::git_push_local_branch,
            session::commands::git_rename_branch,
            session::commands::set_push_target,
            session::commands::git_delete_branch,
            session::commands::git_delete_remote_branch,
            session::commands::git_fetch_branch,
            session::commands::git_fetch_origin,
            session::commands::git_checkout,
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
            session::commands::commit_files,
            session::commands::push_branch,
            session::commands::unpushed_commit_count,
            session::commands::open_worktree_in_webstorm,
            session::commands::open_file_in_webstorm,
            session::commands::open_changed_files_diff_in_webstorm,
            session::commands::open_worktree_in_terminal,
            session::commands::read_graph,
            session::commands::write_graph,
            session::commands::graph_status,
            session::commands::refresh_graph,
            session::commands::list_dir,
            session::commands::list_files,
            session::commands::read_file,
            session::commands::format_with_prettier,
            session::commands::resolve_imports,
            session::commands::search_word,
            session::commands::find_in_files,
            session::commands::list_screenshots,
            session::commands::decline_guardrail,
            session::commands::image_files,
            lsp::lsp_request,
            lsp::lsp_cancel,
            documents::document_open,
            documents::document_edit,
            documents::document_save,
            documents::document_reload,
            documents::document_revert,
            documents::document_mark_saved,
            documents::document_close,
            documents::dirty_documents,
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
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
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
