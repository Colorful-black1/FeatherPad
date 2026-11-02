#![cfg(windows)]

use featherpad_lib::{
    models::{ErrorCode, OpenDocumentContent, ReadChunkRequest, SaveRequest},
    services::{files::FileService, grants::GrantKind, recovery::RecoveryStore},
};
use std::{fs, io::Write, os::windows::fs::OpenOptionsExt, path::PathBuf};

fn fixture() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T107/release")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn release_drops_the_os_lease_preserves_source_and_draft_and_reopens_with_a_new_identity() {
    let root = fixture();
    let path = root.join("source.txt");
    let alias = root.join("hard-link.txt");
    fs::write(&path, "原始字节\r\n").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    let alias_ref = files
        .grants
        .register_selection(&alias, GrantKind::File)
        .unwrap();
    let opened = files.open_document(reference.clone()).unwrap();
    assert_eq!(
        files.open_document(alias_ref.clone()).unwrap().document_id,
        opened.document_id
    );
    let recovery = RecoveryStore::new(root.join("recovery"));
    let draft = recovery
        .persist_before_trash(
            &SaveRequest {
                document_id: opened.document_id.clone(),
                request_id: uuid::Uuid::new_v4().to_string(),
                document_version: 1,
                expected_disk_revision: opened.metadata.disk_revision,
                text: "未保存内容😀".into(),
                format: opened.format,
                newline_map: None,
            },
            &path,
        )
        .unwrap();
    assert!(fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .is_err());
    assert!(files.release_document(&opened.document_id).unwrap());
    assert!(!files.release_document(&opened.document_id).unwrap());
    assert!(files.document_lease(&opened.document_id).is_none());
    drop(
        fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap(),
    );
    assert_eq!(fs::read(&path).unwrap(), "原始字节\r\n".as_bytes());
    assert_eq!(
        recovery.load(&draft.manifest.receipt_id).unwrap().text,
        "未保存内容😀"
    );
    let reopened = files.open_document(alias_ref).unwrap();
    assert_ne!(reopened.document_id, opened.document_id);
    assert_eq!(
        files.open_document(reference).unwrap().document_id,
        reopened.document_id
    );
}

#[test]
fn release_revokes_all_chunk_handles_without_affecting_another_document() {
    let root = fixture();
    let path = root.join("large.txt");
    let mut large = fs::File::create(&path).unwrap();
    let block = [b'a'; 64 * 1024];
    for _ in 0..320 {
        large.write_all(&block).unwrap();
    }
    large.sync_all().unwrap();
    drop(large);
    let other_path = root.join("other.txt");
    fs::write(&other_path, "independent").unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    let other_ref = files
        .grants
        .register_selection(&other_path, GrantKind::File)
        .unwrap();
    let other = files.open_document(other_ref.clone()).unwrap();
    let first = files.open_document(reference.clone()).unwrap();
    let second = files.open_document(reference.clone()).unwrap();
    assert_eq!(first.document_id, second.document_id);
    assert!(files.release_document(&first.document_id).unwrap());
    let reopened = files.open_document(reference).unwrap();
    assert_ne!(reopened.document_id, first.document_id);
    for document in [first, second] {
        let OpenDocumentContent::Chunked { handle_id, .. } = document.content else {
            panic!("expected chunks");
        };
        assert_eq!(
            files
                .read_document_chunk(ReadChunkRequest {
                    document_id: document.document_id,
                    handle_id,
                    expected_disk_revision: document.metadata.disk_revision,
                    byte_offset: 0,
                    max_bytes: 32,
                })
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }
    assert!(files.document_lease(&other.document_id).is_some());
    assert_eq!(
        files.open_document(other_ref).unwrap().document_id,
        other.document_id
    );
    assert_eq!(
        files.stat_document(&other.document_id).unwrap().size_bytes,
        11
    );
    let OpenDocumentContent::Chunked { handle_id, .. } = reopened.content else {
        panic!("expected chunks");
    };
    assert_eq!(
        files
            .read_document_chunk(ReadChunkRequest {
                document_id: reopened.document_id,
                handle_id,
                expected_disk_revision: reopened.metadata.disk_revision,
                byte_offset: 0,
                max_bytes: 32,
            })
            .unwrap()
            .text
            .len(),
        32
    );
}

#[test]
fn invalid_identifiers_fail_and_unleased_drafts_are_normal_noops() {
    let mut files = FileService::default();
    for id in [
        "",
        "../source.txt",
        "urn:uuid:00000000-0000-0000-0000-000000000000",
        "0",
    ] {
        assert_eq!(
            files.release_document(id).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
    assert!(!files
        .release_document(&uuid::Uuid::new_v4().to_string())
        .unwrap());
}
