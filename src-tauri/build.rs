fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "choose_files",
            "choose_folder",
            "list_directory",
            "create_entry",
            "rename_entry",
            "get_trash_impact",
            "trash_entry",
            "open_document",
            "release_document",
            "discard_recovery",
            "read_document_chunk",
            "save_document",
            "save_document_as",
            "stat_document",
        ]));
    tauri_build::try_build(attributes).expect("FeatherPad build configuration is invalid");
}
