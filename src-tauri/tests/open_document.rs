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
        (vec![0x81, 0x40], ErrorCode::EncodingRequired),
        (vec![0xff, 0xfe, 0, 0xd8], ErrorCode::LossyEncoding),
        (vec![0xff, 0xfe, 65], ErrorCode::LossyEncoding),
        (vec![b'a', 0, b'b'], ErrorCode::IsBinary),
        (vec![b'a'; 2 * 1024 * 1024 + 1], ErrorCode::TooLarge),
    ] {
        let (mut service, reference) = open_bytes(&bytes);
        assert_eq!(service.open_document(reference).unwrap_err().code, expected);
    }
}

#[test]
fn utf16_bom_is_decoded_strictly_before_binary_detection() {
    for little in [true, false] {
        let mut bytes = if little {
            vec![0xff, 0xfe]
        } else {
            vec![0xfe, 0xff]
        };
        for unit in "中文😀\r\n第二行".encode_utf16() {
            bytes.extend_from_slice(&if little {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        let (mut service, reference) = open_bytes(&bytes);
        let opened = service.open_document(reference).unwrap();
        assert_eq!(opened.content.text, "中文😀\n第二行");
        assert_eq!(
            opened.format.bom,
            if little { "utf16le" } else { "utf16be" }
        );
        assert_eq!(opened.format.line_ending, "crlf");
    }
}

#[test]
fn real_hardlinks_and_case_aliases_share_one_document_but_equal_bytes_do_not() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T101")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let original = root.join("Original.txt");
    let alias = root.join("alias.txt");
    let different = root.join("different.txt");
    fs::write(&original, "same bytes").unwrap();
    fs::hard_link(&original, &alias).unwrap();
    fs::write(&different, "same bytes").unwrap();
    let mut service = FileService::default();
    let mut opened = Vec::new();
    for path in [&original, &alias, &root.join("ORIGINAL.TXT"), &different] {
        let reference = service
            .grants
            .register_selection(path, GrantKind::File)
            .unwrap();
        opened.push(service.open_document(reference).unwrap());
    }
    assert_eq!(opened[0].document_id, opened[1].document_id);
    assert_eq!(opened[0].document_id, opened[2].document_id);
    assert_eq!(
        opened[0].metadata.disk_revision,
        opened[1].metadata.disk_revision
    );
    assert_ne!(opened[0].document_id, opened[3].document_id);
    assert_ne!(
        opened[0].metadata.disk_revision,
        opened[3].metadata.disk_revision
    );
}

#[test]
fn opens_authorized_unicode_long_path_with_native_identity() {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T101")
        .join(uuid::Uuid::new_v4().to_string());
    for _ in 0..7 {
        root = root.join("controlled-long-path-segment-中文");
    }
    // Extended-length prefix ensures fixture setup also exercises a genuine >260 path.
    let root = PathBuf::from(format!("\\\\?\\{}", root.display()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("中文 emoji😀 fixture.txt");
    assert!(file.as_os_str().len() > 260);
    fs::write(&file, "long path fixture").unwrap();
    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&file, GrantKind::File)
        .unwrap();
    assert_eq!(
        service.open_document(reference).unwrap().content.text,
        "long path fixture"
    );
}

#[test]
fn path_replacement_does_not_reuse_the_open_document_identity() {
    let (mut service, reference) = open_bytes(b"same bytes");
    let before = service.open_document(reference.clone()).unwrap();
    let path = PathBuf::from(&before.metadata.display_path);
    let archived = path.with_file_name("archived.txt");
    // The open identity lease must allow rename while preventing reuse of the old file ID.
    fs::rename(&path, &archived).unwrap();
    fs::write(&path, b"same bytes").unwrap();
    let after = service.open_document(reference).unwrap();
    assert_ne!(before.document_id, after.document_id);
    assert_ne!(before.metadata.disk_revision, after.metadata.disk_revision);
    assert_eq!(fs::read(archived).unwrap(), b"same bytes");
}

#[test]
fn authorized_junction_alias_focuses_the_same_physical_document() {
    let (mut service, file_ref) = open_bytes(b"junction fixture");
    let original = service.open_document(file_ref).unwrap();
    let directory = PathBuf::from(&original.metadata.display_path)
        .parent()
        .unwrap()
        .to_owned();
    let alias = directory.join("alias");
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&alias)
        .arg(&directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Controlled junction creation failed"
    );
    let mut reference = service
        .grants
        .register_selection(&directory, GrantKind::Directory)
        .unwrap();
    reference.relative_path = "alias/中文 fixture.txt".into();
    let through_alias = service.open_document(reference).unwrap();
    assert_eq!(original.document_id, through_alias.document_id);
    assert_eq!(
        original.metadata.disk_revision,
        through_alias.metadata.disk_revision
    );
}
