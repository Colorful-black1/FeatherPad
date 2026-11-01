pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("FeatherPad could not start");
}
