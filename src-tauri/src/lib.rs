mod commands;
mod global_shortcut;
pub mod models;
use tauri::Manager;
pub mod services {
    pub mod assets;
    pub mod cli;
    pub mod comparison;
    pub mod create_file;
    pub mod data_dir;
    pub mod directories;
    pub mod documents;
    pub mod encode;
    pub mod encoding;
    pub mod export;
    pub mod export_target;
    pub mod external;
    pub mod file_ops;
    pub mod files;
    pub mod fonts;
    pub mod grants;
    pub mod identity;
    pub mod images;
    pub mod open_policy;
    pub mod preview_links;
    pub mod recovery;
    pub mod replace_plan;
    pub mod save;
    pub mod save_as;
    pub mod save_journal;
    pub mod save_requests;
    pub mod search;
    pub mod session;
    pub mod session_grants;
    pub mod settings;
    pub mod snapshot;
    pub mod startup_storage;
    pub mod storage_budget;
    pub mod stream_snapshot;
    pub mod targets;
    pub mod text;
    pub mod text_preview;
    pub mod trash;
    pub mod walker;
    pub mod watch;
    pub mod windows;
    pub mod windows_file;
    pub mod windows_trash;
    pub mod workspace;
    pub mod workspace_file;
    pub mod workspace_settings;
}

pub mod platform {
    #[cfg(windows)]
    pub mod pdf;
    #[cfg(windows)]
    pub mod windows;
}

pub fn run() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let action = match services::cli::parse(&args) {
        Ok(action) => action,
        Err(error) => {
            eprintln!("{}", error.message);
            std::process::exit(i32::from(error.exit_code));
        }
    };
    let run = match action {
        services::cli::CliAction::Help => {
            println!("{}", services::cli::HELP);
            return;
        }
        services::cli::CliAction::Run(run) => run,
    };
    let guard = match services::windows::acquire_instance() {
        Ok(services::windows::InstanceStart::Primary(guard)) => {
            if run.wait {
                // Keep the CLI waiter separate from the GUI lifetime, including
                // when this invocation starts the first application instance.
                drop(guard);
                let started = std::env::current_exe().and_then(|executable| {
                    std::process::Command::new(executable)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                });
                if let Err(error) = started {
                    eprintln!("无法启动 FeatherPad 窗口：{error}");
                    std::process::exit(1);
                }
                let outcome = services::windows::route_to_primary(&args);
                if !outcome.message.is_empty() {
                    if outcome.exit_code == 0 {
                        println!("{}", outcome.message);
                    } else {
                        eprintln!("{}", outcome.message);
                    }
                }
                std::process::exit(i32::from(outcome.exit_code));
            }
            if let Err(error) = platform::windows::webview2::ensure_available() {
                eprintln!("{}", error.message);
                std::process::exit(1);
            }
            guard
        }
        Ok(services::windows::InstanceStart::Secondary(_outcome)) => {
            let outcome = services::windows::route_to_primary(&args);
            if !outcome.message.is_empty() {
                if outcome.exit_code == 0 {
                    println!("{}", outcome.message);
                } else {
                    eprintln!("{}", outcome.message);
                }
            }
            std::process::exit(i32::from(outcome.exit_code));
        }
        Err(error) => {
            eprintln!("{}", error.message);
            platform::windows::show_error(&error.message);
            std::process::exit(1);
        }
    };
    let desktop = std::sync::Arc::new(services::windows::DesktopCoordinator::new(guard));
    if let Err(error) = desktop.enqueue_initial(run) {
        eprintln!("{}", error.message);
        platform::windows::show_error(&error.message);
        std::process::exit(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Arc::new(std::sync::Mutex::new(
            services::files::FileService::default(),
        )))
        .manage(std::sync::Arc::new(
            services::save_requests::InFlightSaves::default(),
        ))
        .manage(std::sync::Arc::new(std::sync::Mutex::new(
            services::watch::WatchRegistry::default(),
        )))
        .manage(std::sync::Arc::new(
            services::walker::WalkCoordinator::default(),
        ))
        .manage(std::sync::Arc::new(
            services::search::SearchCoordinator::default(),
        ))
        .manage(global_shortcut::GlobalShortcutState::default())
        .manage(commands::export::PdfCoordinator::default())
        .manage(desktop)
        .setup(|app| {
            commands::desktop::start_primary_scanner(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                commands::workspace::handle_native_drop(window.app_handle(), window.label(), paths.clone());
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let desktop = window
                    .app_handle()
                    .state::<std::sync::Arc<services::windows::DesktopCoordinator>>()
                    .inner()
                    .clone();
                if let Ok(document_ids) = desktop.release_window(window.label()) {
                    if let Some(files) = window
                        .app_handle()
                        .try_state::<std::sync::Arc<std::sync::Mutex<services::files::FileService>>>()
                    {
                        if let Ok(mut files) = files.inner().lock() {
                            for document_id in document_ids {
                                let _ = files.release_document(&document_id);
                            }
                        }
                    }
                }
                if let Ok(request_ids) = desktop.finish_window_requests(window.label()) {
                    for request_id in request_ids {
                        let _ = services::windows::complete_request(
                            desktop.root(),
                            &request_id,
                            true,
                            "窗口已关闭",
                        );
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop::take_desktop_requests,
            commands::desktop::complete_desktop_request,
            commands::desktop::create_desktop_window,
            commands::desktop::focus_desktop_window,
            commands::desktop::remove_desktop_window_session,
            commands::integration::get_desktop_integration,
            commands::integration::set_desktop_integration,
            commands::assets::read_preview_resource,
            commands::comparison::read_comparison_snapshot,
            commands::export::export_html,
            commands::export::export_pdf,
            commands::export::cancel_pdf_export,
            commands::assets::authorize_preview_link,
            commands::assets::open_external_preview,
            commands::choose_files,
            commands::choose_folder,
            commands::workspace::inspect_workspace_root,
            commands::workspace::release_workspace_root,
            commands::workspace::open_workspace_file,
            commands::workspace::save_workspace_file,
            commands::workspace::save_workspace_file_as,
            commands::workspace::walk_workspace,
            commands::workspace::cancel_workspace_walk,
            commands::search::search_workspace,
            commands::search::cancel_workspace_search,
            commands::set_global_shortcut,
            commands::replacement::create_replace_plan,
            commands::replacement::commit_replace_plan,
            commands::replacement::rollback_replace_batch,
            commands::list_directory,
            commands::file_ops::create_entry,
            commands::file_ops::rename_entry,
            commands::file_ops::transfer_entry,
            commands::file_ops::get_trash_impact,
            commands::file_ops::trash_entry,
            commands::open_document,
            commands::encoding::check_encoding,
            commands::encoding::reopen_with_encoding,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::restore_settings,
            commands::settings::load_workspace_settings,
            commands::settings::list_font_families,
            commands::external::get_disk_snapshot,
            commands::external::reload_document,
            commands::external::start_watch,
            commands::external::stop_watch,
            commands::release_document,
            commands::discard_recovery,
            commands::write_recovery_snapshot,
            commands::list_recovery_entries,
            commands::load_recovery_entry,
            commands::load_save_transaction,
            commands::save_session,
            commands::load_session,
            commands::clear_session,
            commands::read_document_chunk,
            commands::save::save_document,
            commands::save::auto_save_document,
            commands::save::overwrite_document,
            commands::save_as::save_document_as,
            commands::save::stat_document
        ])
        .run(tauri::generate_context!())
        .expect("FeatherPad could not start");
}
