#![cfg(windows)]
use featherpad_lib::{
    models::{ErrorCode, FileRef},
    services::{files::FileService, grants::GrantKind},
};
use std::{fs, path::PathBuf};

#[test]
fn removing_root_revokes_directory_and_durably_pins_open_documents_without_releasing_identity() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T204")
        .join(uuid::Uuid::new_v4().to_string());
    let folder = directory.join("folder");
    fs::create_dir_all(&folder).unwrap();
    let path = folder.join("中文.txt");
    fs::write(&path, "original\r\n中文😀").unwrap();
    let state = directory.join("state");
    let mut service = FileService::default();
    let root = service
        .grants
        .register_selection(&folder, GrantKind::Directory)
        .unwrap();
    let repeated = service
        .grants
        .register_selection(&folder.join("."), GrantKind::Directory)
        .unwrap();
    assert_eq!(root.grant_id, repeated.grant_id);
    let descriptor = service.inspect_workspace_root(&root).unwrap();
    assert_eq!(descriptor.canonical_identity.len(), 64);
    assert!(descriptor.display_path.ends_with("folder"));
    let child = FileRef {
        grant_id: root.grant_id.clone(),
        relative_path: "中文.txt".into(),
    };
    let opened = service.open_document(child.clone()).unwrap();
    let remapped = service.release_workspace_root(&root, &state).unwrap();
    assert_eq!(remapped.len(), 1);
    assert_eq!(remapped[0].document_id, opened.document_id);
    assert_ne!(remapped[0].reference.grant_id, root.grant_id);
    assert!(remapped[0].reference.relative_path.is_empty());
    assert_eq!(
        service.grants.resolve_directory(&root).unwrap_err().code,
        ErrorCode::OutOfScope
    );
    assert_eq!(
        service.grants.open_file(&child).unwrap_err().code,
        ErrorCode::OutOfScope
    );
    assert_eq!(
        service
            .open_document(remapped[0].reference.clone())
            .unwrap()
            .document_id,
        opened.document_id
    );
    assert_eq!(
        serde_json::to_value(service.release_workspace_root(&root, &state).unwrap()).unwrap(),
        serde_json::to_value(&remapped).unwrap()
    );
    let stored: serde_json::Value =
        serde_json::from_slice(&fs::read(state.join("grants.json")).unwrap()).unwrap();
    assert_eq!(stored["revokedGrantIds"][0], root.grant_id);
    assert_eq!(
        stored["grants"][0]["grantId"],
        remapped[0].reference.grant_id
    );
    assert_eq!(fs::read(&path).unwrap(), "original\r\n中文😀".as_bytes());
}

#[test]
fn failed_durable_rebinding_keeps_root_and_document_grants_unchanged() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T204")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).unwrap();
    let source = directory.join("source.txt");
    fs::write(&source, b"retained").unwrap();
    let mut service = FileService::default();
    let root = service
        .grants
        .register_selection(&directory, GrantKind::Directory)
        .unwrap();
    let opened = service
        .open_document(FileRef {
            grant_id: root.grant_id.clone(),
            relative_path: "source.txt".into(),
        })
        .unwrap();
    let blocked = directory.join("blocked");
    fs::write(&blocked, b"not a directory").unwrap();
    assert!(service.release_workspace_root(&root, &blocked).is_err());
    assert!(service.grants.resolve_directory(&root).is_ok());
    assert_eq!(
        service
            .document_lease(&opened.document_id)
            .unwrap()
            .reference
            .grant_id,
        root.grant_id
    );
    assert_eq!(fs::read(source).unwrap(), b"retained");
}
