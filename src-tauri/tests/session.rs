use featherpad_lib::{
    models::{
        ErrorCode, SessionBounds, SessionGroup, SessionManifest, SessionSelection, SessionView,
        SessionWindow,
    },
    services::session::SessionStore,
};
use std::{fs, path::PathBuf};

fn fixture() -> (PathBuf, SessionStore) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T110")
        .join(format!("session-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let store = SessionStore::new(root.join("session"));
    (root, store)
}

fn manifest() -> SessionManifest {
    let document_id = uuid::Uuid::new_v4().to_string();
    let receipt_id = uuid::Uuid::new_v4().to_string();
    let root_id = uuid::Uuid::new_v4().to_string();
    let file_grant_id = uuid::Uuid::new_v4().to_string();
    SessionManifest {
        schema_version: 1,
        session_id: uuid::Uuid::new_v4().to_string(),
        windows: vec![SessionWindow {
            window_id: "main".into(),
            bounds: SessionBounds {
                x: 20,
                y: 30,
                width: 1200,
                height: 800,
            },
            root_ids: vec![root_id],
            root_labels: vec!["受控目录".into()],
            active_view_id: Some(document_id.clone()),
            groups: vec![SessionGroup {
                group_id: "primary".into(),
                view_ids: vec![document_id.clone()],
            }],
            views: vec![SessionView {
                view_id: document_id.clone(),
                buffer_version: 7,
                document_id,
                recovery_receipt_id: Some(receipt_id.clone()),
                file_ref: Some(featherpad_lib::models::FileRef {
                    grant_id: file_grant_id,
                    relative_path: String::new(),
                }),
                disk_revision: Some("a".repeat(64)),
                open_mode: "normal".into(),
                title: "草稿.txt".into(),
                display_path: Some("E:\\fixtures\\草稿.txt".into()),
                is_preview: false,
                dirty: true,
                selection: vec![SessionSelection { anchor: 4, head: 9 }],
                scroll_anchor: 128.5,
            }],
        }],
        recovery_snapshot_refs: vec![receipt_id],
        persisted_at: "2026-11-02T00:00:00.000000000Z".into(),
    }
}

#[test]
fn session_manifest_round_trips_atomically_and_clear_is_idempotent() {
    let (root, store) = fixture();
    let first = manifest();
    store.save(&first).unwrap();
    assert_eq!(store.load().unwrap().session, Some(first.clone()));
    let mut second = first;
    second.persisted_at = "2026-11-02T00:01:00.000000000Z".into();
    store.save(&second).unwrap();
    assert_eq!(store.load().unwrap().session, Some(second));
    let names = fs::read_dir(root.join("session"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(!names
        .iter()
        .any(|name| name.ends_with(".tmp") || name.ends_with(".bak")));
    store.clear().unwrap();
    store.clear().unwrap();
    assert!(store.load().unwrap().session.is_none());
}

#[test]
fn session_manifest_rejects_inconsistent_references_and_unsafe_positions() {
    let (_root, store) = fixture();
    let valid = manifest();
    let mut missing_group_view = valid.clone();
    missing_group_view.windows[0].groups[0].view_ids.clear();
    assert_eq!(
        store.save(&missing_group_view).unwrap_err().code,
        ErrorCode::InvalidInput
    );

    let mut missing_receipt = valid.clone();
    missing_receipt.recovery_snapshot_refs.clear();
    assert_eq!(
        store.save(&missing_receipt).unwrap_err().code,
        ErrorCode::InvalidInput
    );

    let mut duplicate_root = valid.clone();
    let duplicate_id = duplicate_root.windows[0].root_ids[0].clone();
    duplicate_root.windows[0].root_ids.push(duplicate_id);
    duplicate_root.windows[0].root_labels.push("重复".into());
    assert_eq!(
        store.save(&duplicate_root).unwrap_err().code,
        ErrorCode::InvalidInput
    );

    let mut missing_disk_revision = valid.clone();
    missing_disk_revision.windows[0].views[0].disk_revision = None;
    assert_eq!(
        store.save(&missing_disk_revision).unwrap_err().code,
        ErrorCode::InvalidInput
    );

    let mut missing_file_reference = valid.clone();
    missing_file_reference.windows[0].views[0].file_ref = None;
    assert_eq!(
        store.save(&missing_file_reference).unwrap_err().code,
        ErrorCode::InvalidInput
    );

    let mut unsafe_version = valid.clone();
    unsafe_version.windows[0].views[0].buffer_version = 9_007_199_254_740_992;
    assert_eq!(
        store.save(&unsafe_version).unwrap_err().code,
        ErrorCode::InvalidInput
    );

    let mut unsafe_position = valid;
    unsafe_position.windows[0].views[0].selection[0].head = 9_007_199_254_740_992;
    assert_eq!(
        store.save(&unsafe_position).unwrap_err().code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn corrupt_session_is_quarantined_without_claiming_a_restored_session() {
    let (root, store) = fixture();
    store.save(&manifest()).unwrap();
    fs::write(root.join("session/manifest.json"), b"{not-json").unwrap();
    let loaded = store.load().unwrap();
    assert!(loaded.session.is_none());
    assert!(loaded.warning.is_some());
    assert!(!root.join("session/manifest.json").exists());
    assert!(fs::read_dir(root.join("session"))
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry
            .file_name()
            .to_string_lossy()
            .starts_with("manifest.corrupt-")));
}
