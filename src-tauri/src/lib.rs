mod commands;
pub mod models;
pub mod services {
    pub mod create_file;
    pub mod documents;
    pub mod encode;
    pub mod files;
    pub mod grants;
    pub mod identity;
    pub mod save;
    pub mod save_journal;
    pub mod save_requests;
    pub mod snapshot;
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
            commands::open_document,
            commands::save::save_document,
            commands::save::stat_document
        ])
        .run(tauri::generate_context!())
        .expect("FeatherPad could not start");
}
