#![cfg(windows)]

use featherpad_lib::{
    models::{ErrorCode, OpenDocumentContent, SaveAsRequest, SaveIntent, SaveRequest},
    services::{
        files::{FileService, OpenRequestMode},
        grants::GrantKind,
        save::HardLinkPolicy,
    },
};
use std::{fs, path::PathBuf};

fn fixture(bytes: &[u8]) -> (FileService, featherpad_lib::models::FileRef, PathBuf) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T115/text-preview-service")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let path = root.join("binary 中文😀.txt");
    fs::write(&path, bytes).unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    (files, reference, path)
}

#[test]
fn binary_requires_explicit_preview_and_all_save_entries_reject_it() {
    let bytes = b"text\0binary\xff";
    let (mut files, reference, path) = fixture(bytes);
    assert_eq!(
        files.open_document(reference.clone()).unwrap_err().code,
        ErrorCode::EncodingRequired
    );
    let opened = files
        .open_document_with_mode(reference.clone(), OpenRequestMode::TextPreview)
        .unwrap();
    assert_eq!(opened.mode, "text-preview");
    assert!(
        matches!(&opened.content, OpenDocumentContent::Head { text, truncated: false, .. } if text == "text␀binary�")
    );
    let request = SaveRequest {
        document_id: opened.document_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 0,
        expected_disk_revision: opened.metadata.disk_revision.clone(),
        text: "forged writable text".into(),
        format: opened.format.clone(),
        newline_map: None,
    };
    assert_eq!(
        files.begin_save(&request).err().unwrap().code,
        ErrorCode::ReadOnly
    );
    assert_eq!(
        files.inspect_hard_links(&request).err().unwrap().code,
        ErrorCode::ReadOnly
    );
    let journal = path.parent().unwrap().join("journal");
    assert_eq!(
        files
            .save_existing(
                request.clone(),
                &journal,
                HardLinkPolicy::RequireConfirmation
            )
            .unwrap_err()
            .code,
        ErrorCode::ReadOnly
    );
    for intent in [SaveIntent::SaveAs, SaveIntent::Copy] {
        let destination = SaveAsRequest {
            document_id: opened.document_id.clone(),
            request_id: uuid::Uuid::new_v4().to_string(),
            document_version: 0,
            text: request.text.clone(),
            format: opened.format.clone(),
            newline_map: None,
            intent,
        };
        assert_eq!(
            files.begin_save_as(&destination).err().unwrap().code,
            ErrorCode::ReadOnly
        );
    }
    assert!(!journal.exists());
    assert_eq!(
        files.open_document(reference).unwrap().document_id,
        opened.document_id
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn preview_of_an_alias_never_downgrades_an_existing_editable_lease() {
    let (mut files, reference, path) = fixture(b"editable text");
    let original = files.open_document(reference).unwrap();
    let alias = path.with_file_name("editable-alias.txt");
    fs::hard_link(&path, &alias).unwrap();
    let reference = files
        .grants
        .register_selection(&alias, GrantKind::File)
        .unwrap();
    let preview = files
        .open_document_with_mode(reference, OpenRequestMode::TextPreview)
        .unwrap();
    assert_eq!(preview.document_id, original.document_id);
    assert_eq!(preview.mode, "normal");
    let request = SaveRequest {
        document_id: original.document_id,
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 0,
        expected_disk_revision: original.metadata.disk_revision,
        text: "editable text".into(),
        format: original.format,
        newline_map: None,
    };
    assert!(files.begin_save(&request).is_ok());
    assert_eq!(fs::read(path).unwrap(), b"editable text");
}

#[test]
fn reload_and_aliases_preserve_preview_identity_and_never_upgrade_to_writable() {
    let (mut files, reference, path) = fixture(b"first\0bytes");
    let opened = files
        .open_document_with_mode(reference.clone(), OpenRequestMode::TextPreview)
        .unwrap();
    let alias = path.with_file_name("alias.bin");
    fs::hard_link(&path, &alias).unwrap();
    let alias_ref = files
        .grants
        .register_selection(&alias, GrantKind::File)
        .unwrap();
    assert_eq!(
        files
            .open_document_with_mode(alias_ref, OpenRequestMode::TextPreview)
            .unwrap()
            .document_id,
        opened.document_id
    );
    fs::rename(&path, path.with_file_name("old.bin")).unwrap();
    fs::write(&path, b"replacement\0bytes").unwrap();
    let revision = files
        .stat_document(&opened.document_id)
        .unwrap()
        .disk_revision;
    let loaded = files
        .reload_document(&opened.document_id, &revision)
        .unwrap();
    assert_eq!(loaded.document_id, opened.document_id);
    assert_eq!(loaded.mode, "text-preview");
    assert_ne!(loaded.canonical_identity, opened.canonical_identity);
    assert!(
        matches!(&loaded.content, OpenDocumentContent::Head { text, .. } if text == "replacement␀bytes")
    );
    assert_eq!(
        files
            .get_disk_snapshot(&opened.document_id)
            .unwrap_err()
            .code,
        ErrorCode::ReadOnly
    );
    let request = SaveRequest {
        document_id: loaded.document_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 0,
        expected_disk_revision: loaded.metadata.disk_revision,
        text: "cannot write".into(),
        format: loaded.format,
        newline_map: None,
    };
    assert_eq!(
        files.begin_save(&request).err().unwrap().code,
        ErrorCode::ReadOnly
    );
    assert!(files.release_document(&opened.document_id).unwrap());
    assert_eq!(
        files.open_document(reference).unwrap_err().code,
        ErrorCode::IsBinary
    );
    assert_eq!(fs::read(path).unwrap(), b"replacement\0bytes");
}
