mod commands;
pub mod models;
pub mod services {
    pub mod files;
    pub mod grants;
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Arc::new(std::sync::Mutex::new(
            services::files::FileService::default(),
        )))
        .invoke_handler(tauri::generate_handler![
            commands::choose_files,
            commands::choose_folder,
            commands::open_document
        ])
        .run(tauri::generate_context!())
        .expect("FeatherPad could not start");
}
