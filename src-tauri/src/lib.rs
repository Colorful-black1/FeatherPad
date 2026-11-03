mod commands;
pub mod models;
pub mod services {
    pub mod create_file;
    pub mod directories;
    pub mod documents;
    pub mod encode;
    pub mod encoding;
    pub mod external;
    pub mod file_ops;
    pub mod files;
    pub mod fonts;
    pub mod grants;
    pub mod identity;
    pub mod open_policy;
    pub mod recovery;
    pub mod save;
    pub mod save_as;
    pub mod save_journal;
    pub mod save_requests;
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
    pub mod watch;
    pub mod windows_file;
    pub mod windows_trash;
    pub mod workspace_settings;
}

pub fn run() {
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
        .invoke_handler(tauri::generate_handler![
            commands::choose_files,
            commands::choose_folder,
            commands::list_directory,
            commands::file_ops::create_entry,
            commands::file_ops::rename_entry,
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
