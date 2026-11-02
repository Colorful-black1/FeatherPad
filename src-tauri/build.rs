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
            "get_disk_snapshot",
            "reload_document",
            "start_watch",
            "stop_watch",
            "release_document",
            "discard_recovery",
            "write_recovery_snapshot",
            "list_recovery_entries",
            "load_recovery_entry",
            "load_save_transaction",
            "save_session",
            "load_session",
            "clear_session",
            "read_document_chunk",
            "save_document",
            "overwrite_document",
            "save_document_as",
            "stat_document",
        ]));
    tauri_build::try_build(attributes).expect("FeatherPad build configuration is invalid");
}
