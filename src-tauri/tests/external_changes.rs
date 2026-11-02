#![cfg(windows)]

use featherpad_lib::{
    models::{ErrorCode, OpenDocumentContent},
    services::{files::FileService, grants::GrantKind},
};
use std::{fs, path::PathBuf};

fn fixture() -> (FileService, PathBuf, String) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T111/rust")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let path = root.join("外部变化.txt");
    fs::write(&path, "原件\r\n").unwrap();
    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    let id = service.open_document(reference).unwrap().document_id;
    (service, path, id)
}

#[test]
fn comparison_is_readonly_and_reload_keeps_id_after_atomic_replacement() {
    let (mut service, path, id) = fixture();
    let original = service.document_lease(&id).unwrap().identity.clone();
    fs::rename(&path, path.with_extension("old")).unwrap();
    fs::write(&path, "外部更新\n").unwrap();
    let reference = service.document_lease(&id).unwrap().reference.clone();
    assert_eq!(service.open_document(reference).unwrap().document_id, id);
    let snapshot = service.get_disk_snapshot(&id).unwrap();
    assert_eq!(snapshot.document_id, id);
    assert_eq!(service.document_lease(&id).unwrap().identity, original);
    assert!(
        matches!(snapshot.content, OpenDocumentContent::Text { ref text, .. } if text == "外部更新\n")
    );
    let loaded = service
        .reload_document(&id, &snapshot.metadata.disk_revision)
        .unwrap();
    assert_eq!(loaded.document_id, id);
    assert_ne!(service.document_lease(&id).unwrap().identity, original);
    assert_eq!(
        service.open_document(loaded.reference).unwrap().document_id,
        id
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "外部更新\n");
}

#[test]
fn revision_includes_same_length_same_mtime_changes_and_stale_reload_does_not_rebind() {
    let (mut service, path, id) = fixture();
    let before = service.get_disk_snapshot(&id).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "改件\r\n").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_ne!(
        service.stat_document(&id).unwrap().disk_revision,
        before.metadata.disk_revision
    );
    assert_eq!(
        service
            .reload_document(&id, &before.metadata.disk_revision)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert!(service.get_disk_snapshot(&id).is_ok());
}

#[test]
fn missing_source_is_not_a_permission_failure_and_failed_decode_keeps_lease() {
    let (service, path, id) = fixture();
    let original = service.document_lease(&id).unwrap().identity.clone();
    fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
    assert_eq!(
        service.get_disk_snapshot(&id).unwrap_err().code,
        ErrorCode::LossyEncoding
    );
    assert_eq!(service.document_lease(&id).unwrap().identity, original);
    fs::rename(&path, path.with_extension("moved")).unwrap();
    assert_eq!(
        service.get_disk_snapshot(&id).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert!(service.document_lease(&id).is_some());
    assert_eq!(
        service
            .get_disk_snapshot(&uuid::Uuid::new_v4().to_string())
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn replacement_with_another_open_identity_is_rejected() {
    let (mut service, path, id) = fixture();
    let other = path.with_extension("other");
    fs::write(&other, "其他文件").unwrap();
    let reference = service
        .grants
        .register_selection(&other, GrantKind::File)
        .unwrap();
    let other_id = service.open_document(reference).unwrap().document_id;
    fs::rename(&path, path.with_extension("old")).unwrap();
    fs::hard_link(&other, &path).unwrap();
    assert_eq!(
        service.get_disk_snapshot(&id).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert!(service.document_lease(&id).is_some());
    assert!(service.document_lease(&other_id).is_some());
}

#[test]
fn native_watch_invalidates_only_selected_refs_for_edit_rename_delete_and_stops() {
    use featherpad_lib::services::watch::WatchRegistry;
    use std::{
        sync::{mpsc, Arc},
        time::Duration,
    };
    let (service, path, id) = fixture();
    let reference = service.document_lease(&id).unwrap().reference.clone();
    let (sender, receiver) = mpsc::channel();
    let mut watches = WatchRegistry::default();
    let watched = reference.clone();
    let watch_id = watches
        .start(
            &service.grants,
            vec![reference],
            Arc::new(move |event| {
                sender.send(event).unwrap();
            }),
        )
        .unwrap();
    fs::write(&path, "changed").unwrap();
    let event = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(event.watch_id, watch_id);
    assert_eq!(event.entries.len(), 1);
    assert_eq!(event.entries[0].reference, watched);
    let sibling = path.with_extension("private-name");
    fs::write(&sibling, "sibling").unwrap();
    let event = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(event.entries[0].reference, watched);
    fs::rename(&path, path.with_extension("renamed")).unwrap();
    receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    fs::remove_file(path.with_extension("renamed")).unwrap();
    receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(watches.stop(&watch_id));
    assert!(!watches.stop(&watch_id));
}

#[test]
fn invalid_watch_refs_and_excessive_scope_are_rejected() {
    use featherpad_lib::{models::FileRef, services::watch::WatchRegistry};
    use std::sync::Arc;
    let (service, _, _) = fixture();
    let mut watches = WatchRegistry::default();
    let emit = Arc::new(|_| {});
    assert!(watches
        .start(&service.grants, vec![], emit.clone())
        .is_err());
    let invalid = FileRef {
        grant_id: uuid::Uuid::new_v4().to_string(),
        relative_path: String::new(),
    };
    assert_eq!(
        watches
            .start(&service.grants, vec![invalid.clone()], emit.clone())
            .unwrap_err()
            .code,
        ErrorCode::OutOfScope
    );
    assert_eq!(
        watches
            .start(&service.grants, vec![invalid; 257], emit)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn reload_transfers_chunk_handles_and_later_clears_fragment_state_when_disk_shrinks() {
    use featherpad_lib::models::ReadChunkRequest;
    let (mut service, path, id) = fixture();
    // This size-specific test covers the newly changed lease/handle transfer, not performance.
    fs::write(&path, vec![b'x'; 20 * 1024 * 1024]).unwrap();
    let revision = service.stat_document(&id).unwrap().disk_revision;
    let large = service.reload_document(&id, &revision).unwrap();
    let OpenDocumentContent::Chunked { handle_id, .. } = large.content else {
        panic!("expected chunked mode")
    };
    assert!(service
        .read_document_chunk(ReadChunkRequest {
            document_id: id.clone(),
            handle_id: handle_id.clone(),
            expected_disk_revision: revision,
            byte_offset: 100,
            max_bytes: 64
        })
        .is_ok());
    assert_eq!(
        service.get_disk_snapshot(&id).unwrap_err().code,
        ErrorCode::ReadOnly
    );
    fs::write(&path, "small again").unwrap();
    let revision = service.stat_document(&id).unwrap().disk_revision;
    assert!(matches!(
        service.reload_document(&id, &revision).unwrap().content,
        OpenDocumentContent::Text { .. }
    ));
    assert!(service.get_disk_snapshot(&id).is_ok());
    assert_eq!(
        service
            .read_document_chunk(ReadChunkRequest {
                document_id: id,
                handle_id,
                expected_disk_revision: revision,
                byte_offset: 0,
                max_bytes: 64
            })
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}
