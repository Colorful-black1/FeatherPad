mod commands;
pub mod models;
pub mod services {
    pub mod create_file;
    pub mod directories;
    pub mod documents;
    pub mod encode;
    pub mod file_ops;
    pub mod files;
    pub mod grants;
    pub mod identity;
    pub mod open_policy;
    pub mod save;
    pub mod save_as;
    pub mod save_journal;
    pub mod save_requests;
    pub mod snapshot;
    pub mod stream_snapshot;
    pub mod targets;
    pub mod text;
    pub mod windows_file;
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
        .invoke_handler(tauri::generate_handler![
            commands::choose_files,
            commands::choose_folder,
            commands::list_directory,
            commands::file_ops::create_entry,
            commands::file_ops::rename_entry,
            commands::open_document,
            commands::read_document_chunk,
            commands::save::save_document,
            commands::save_as::save_document_as,
            commands::save::stat_document
        ])
        .run(tauri::generate_context!())
        .expect("FeatherPad could not start");
}
