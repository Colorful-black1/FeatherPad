fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "choose_files",
            "choose_folder",
            "open_document",
            "save_document",
            "save_document_as",
            "stat_document",
        ]));
    tauri_build::try_build(attributes).expect("FeatherPad build configuration is invalid");
}
