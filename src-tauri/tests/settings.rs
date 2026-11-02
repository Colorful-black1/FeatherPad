#![cfg(windows)]
use featherpad_lib::{
    models::ErrorCode,
    services::settings::{SaveSettingsRequest, SettingsStore},
};
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf};

fn fixture() -> (PathBuf, SettingsStore) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T112/settings")
        .join(uuid::Uuid::new_v4().to_string());
    (root.clone(), SettingsStore::new(root))
}
fn values(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn versioned_roundtrip_keeps_unknown_and_invalid_domain_values_and_rejects_stale_writers() {
    let (_, store) = fixture();
    let empty = store.load().unwrap();
    assert_eq!(empty.version, 0);
    assert!(empty.revision.is_none());
    let settings =
        values(json!({"theme":"dark", "fontSize": "invalid", "futureOption":{"enabled":false}}));
    let first = store
        .save(SaveSettingsRequest {
            expected_version: 0,
            expected_revision: None,
            settings: settings.clone(),
        })
        .unwrap();
    assert_eq!(first.version, 1);
    let loaded = store.load().unwrap();
    assert_eq!(loaded.settings, settings);
    assert_eq!(loaded.revision, Some(first.revision.clone()));
    assert_eq!(
        store
            .save(SaveSettingsRequest {
                expected_version: 0,
                expected_revision: None,
                settings: Map::new()
            })
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    let second = store
        .save(SaveSettingsRequest {
            expected_version: 1,
            expected_revision: Some(first.revision),
            settings: values(json!({"theme":"light"})),
        })
        .unwrap();
    assert_eq!(second.version, 2);
    let copies = store.load().unwrap().recovery_copies;
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0].version, 1);
    let restored = store
        .restore(2, Some(second.revision), &copies[0].id)
        .unwrap();
    assert_eq!(restored.version, 3);
    assert_eq!(store.load().unwrap().settings, settings);
}

#[test]
fn same_version_external_edits_are_not_silently_overwritten() {
    let (root, store) = fixture();
    let first = store
        .save(SaveSettingsRequest {
            expected_version: 0,
            expected_revision: None,
            settings: values(json!({"theme":"dark"})),
        })
        .unwrap();
    let target = root.join("settings.json");
    let changed = fs::read_to_string(&target).unwrap().replace("dark", "lite");
    fs::write(&target, &changed).unwrap();
    assert_eq!(
        store
            .save(SaveSettingsRequest {
                expected_version: 1,
                expected_revision: Some(first.revision),
                settings: Map::new()
            })
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read_to_string(target).unwrap(), changed);
}

#[test]
fn corrupt_configuration_is_isolated_with_old_copies_available_for_explicit_restore() {
    let (root, store) = fixture();
    let first = store
        .save(SaveSettingsRequest {
            expected_version: 0,
            expected_revision: None,
            settings: values(json!({"theme":"dark"})),
        })
        .unwrap();
    store
        .save(SaveSettingsRequest {
            expected_version: 1,
            expected_revision: Some(first.revision),
            settings: Map::new(),
        })
        .unwrap();
    fs::write(root.join("settings.json"), b"{broken json").unwrap();
    let loaded = store.load().unwrap();
    assert!(loaded.warning.is_some());
    assert_eq!(loaded.version, 0);
    assert_eq!(loaded.recovery_copies.len(), 1);
    let corrupt = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("settings.corrupt-")
        })
        .unwrap();
    assert_eq!(fs::read(corrupt).unwrap(), b"{broken json");
    store
        .restore(0, None, &loaded.recovery_copies[0].id)
        .unwrap();
    assert_eq!(store.load().unwrap().settings["theme"], "dark");
}

#[test]
fn future_schemas_excessive_input_and_prototype_keys_are_preserved_or_rejected_without_writes() {
    let (root, store) = fixture();
    store.load().unwrap();
    let future = br#"{"schemaVersion":2,"version":7,"settings":{"future":true}}"#;
    fs::write(root.join("settings.json"), future).unwrap();
    assert_eq!(store.load().unwrap_err().code, ErrorCode::Unsupported);
    assert_eq!(fs::read(root.join("settings.json")).unwrap(), future);
    assert_eq!(
        store
            .save(SaveSettingsRequest {
                expected_version: 0,
                expected_revision: None,
                settings: values(json!({"__proto__":{"polluted":true}}))
            })
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        store
            .save(SaveSettingsRequest {
                expected_version: 0,
                expected_revision: None,
                settings: values(json!({"large":"x".repeat(65_536)}))
            })
            .unwrap_err()
            .code,
        ErrorCode::TooLarge
    );
    assert_eq!(
        store.restore(0, None, "../settings.json").unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(fs::read(root.join("settings.json")).unwrap(), future);
}

#[test]
fn workspace_configuration_is_read_without_hidden_documents_or_file_mutations() {
    use featherpad_lib::services::{files::FileService, grants::GrantKind};
    let (root, _) = fixture();
    fs::create_dir_all(root.join(".featherpad")).unwrap();
    let path = root.join(".featherpad/settings.json");
    let raw =
        br#"{"schemaVersion":1,"settings":{"tabSize":8,"autoSave":"afterDelay","future":true}}"#;
    fs::write(&path, raw).unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&root, GrantKind::Directory)
        .unwrap();
    let loaded = files.load_workspace_settings(reference.clone()).unwrap();
    assert_eq!(loaded.settings["tabSize"], 8);
    assert_eq!(loaded.settings["autoSave"], "afterDelay"); // provider returns data; consumer enforces the allowlist.
    assert!(loaded.warning.is_none());
    assert_eq!(fs::read(&path).unwrap(), raw);
    fs::write(&path, b"bad config").unwrap();
    let broken = files.load_workspace_settings(reference).unwrap();
    assert!(broken.warning.is_some());
    assert!(broken.settings.is_empty());
    assert_eq!(fs::read(&path).unwrap(), b"bad config");
    assert_eq!(
        files
            .load_workspace_settings(featherpad_lib::models::FileRef {
                grant_id: uuid::Uuid::new_v4().to_string(),
                relative_path: String::new(),
            })
            .unwrap_err()
            .code,
        ErrorCode::OutOfScope
    );
}

#[test]
fn local_font_enumeration_returns_bounded_unique_installed_family_names_without_network() {
    let fonts = featherpad_lib::services::fonts::list_font_families().unwrap();
    assert!(!fonts.families.is_empty());
    assert!(fonts.families.len() <= 4096);
    assert!(fonts
        .families
        .iter()
        .all(|name| !name.is_empty() && name.encode_utf16().count() <= 32));
    assert_eq!(
        fonts
            .families
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        fonts.families.len()
    );
    assert!(fonts
        .families
        .iter()
        .any(|name| name == "Consolas" || name == "Arial"));
}
