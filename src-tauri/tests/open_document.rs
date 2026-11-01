#![cfg(windows)]

use featherpad_lib::{
    models::ErrorCode,
    services::{files::FileService, grants::GrantKind},
};
use std::{fs, path::PathBuf};

fn open_bytes(bytes: &[u8]) -> (FileService, featherpad_lib::models::FileRef) {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T003")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("中文 fixture.txt");
    fs::write(&path, bytes).unwrap();
    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    (service, reference)
}

#[test]
fn reads_utf8_bom_and_keeps_each_original_newline_and_document_identity() {
    let (mut service, reference) = open_bytes("\u{feff}中文\r\nsecond\nthird\rfinal".as_bytes());
    let document = service.open_document(reference.clone()).unwrap();
    assert_eq!(document.content.text, "中文\nsecond\nthird\nfinal");
    assert_eq!(document.format.bom, "utf8");
    assert_eq!(document.format.line_ending, "mixed");
    assert_eq!(document.content.newline_map.endings.len(), 3);
    assert_eq!(
        serde_json::to_value(&document.content.newline_map.endings).unwrap(),
        serde_json::json!(["crlf", "lf", "cr"])
    );
    assert_eq!(
        document.document_id,
        service.open_document(reference).unwrap().document_id
    );
}

#[test]
fn rejects_non_utf8_binary_and_oversize_without_lossy_decoding() {
    for (bytes, expected) in [
        (vec![0xff, 0xfe, 65, 0], ErrorCode::EncodingRequired),
        (vec![b'a', 0, b'b'], ErrorCode::IsBinary),
        (vec![b'a'; 2 * 1024 * 1024 + 1], ErrorCode::TooLarge),
    ] {
        let (mut service, reference) = open_bytes(&bytes);
        assert_eq!(service.open_document(reference).unwrap_err().code, expected);
    }
}
