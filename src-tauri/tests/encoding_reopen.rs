use featherpad_lib::{
    models::{ErrorCode, NewlineMap, OpenDocumentContent, SaveRequest, TextFormat},
    services::{
        encoding::encode_text,
        files::{FileService, OpenRequestMode},
        grants::GrantKind,
        recovery::RecoveryStore,
        save::{HardLinkPolicy, PreparedSave},
        startup_storage::{load_save_transaction, scan_save_transactions},
    },
};
use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.artifacts/T201/native-encoding")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn selected_encoding_survives_comparison_reload_and_identity_aliases() {
    let root = root();
    for (label, source) in [
        ("gb18030", "中文😀"),
        ("gbk", "中文"),
        ("shift_jis", "日本"),
        ("big5", "中文"),
        ("windows-1252", "café €"),
        ("utf-16be", "中文😀"),
    ] {
        let path = root.join(format!("{label}.txt"));
        let bytes = encode_text(&format!("{source}\r\nsecond\rthird\n"), label, "none").unwrap();
        fs::write(&path, &bytes).unwrap();
        let mut files = FileService::default();
        let reference = files
            .grants
            .register_selection(&path, GrantKind::File)
            .unwrap();
        let opened = files
            .open_document_with_encoding(
                reference.clone(),
                OpenRequestMode::Auto,
                None,
                Some(label),
            )
            .unwrap();
        assert_eq!(opened.format.encoding, label);
        assert_eq!(opened.format.line_ending, "mixed");
        let comparison = files.get_disk_snapshot(&opened.document_id).unwrap();
        assert_eq!(comparison.format.encoding, label);
        assert_eq!(
            serde_json::to_value(&comparison.content).unwrap(),
            serde_json::to_value(&opened.content).unwrap()
        );
        let reload = files
            .reload_document(&opened.document_id, &opened.metadata.disk_revision)
            .unwrap();
        assert_eq!(reload.document_id, opened.document_id);
        assert_eq!(
            serde_json::to_value(&reload.content).unwrap(),
            serde_json::to_value(&opened.content).unwrap()
        );
        let alias = root.join(format!("{label}-alias.txt"));
        fs::hard_link(&path, &alias).unwrap();
        let alias_ref = files
            .grants
            .register_selection(&alias, GrantKind::File)
            .unwrap();
        let alias_opened = files
            .open_document_with_encoding(alias_ref, OpenRequestMode::Auto, None, Some("utf-8"))
            .unwrap();
        assert_eq!(alias_opened.document_id, opened.document_id);
        assert_eq!(alias_opened.format.encoding, label);
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn explicit_reinterpretation_keeps_id_and_revision_while_stale_or_invalid_choices_preserve_lease() {
    let path = root().join("reinterpret.txt");
    fs::write(&path, "café").unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    let opened = files.open_document(reference).unwrap();
    let revision = opened.metadata.disk_revision;
    let reinterpreted = files
        .reopen_with_encoding(&opened.document_id, &revision, Some("windows-1252"))
        .unwrap();
    assert_eq!(reinterpreted.document_id, opened.document_id);
    assert_eq!(reinterpreted.metadata.disk_revision, revision);
    assert!(
        matches!(reinterpreted.content, OpenDocumentContent::Text { text, .. } if text == "cafÃ©")
    );
    assert_eq!(
        files
            .reopen_with_encoding(&opened.document_id, &revision, Some("invalid"))
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        files
            .get_disk_snapshot(&opened.document_id)
            .unwrap()
            .format
            .encoding,
        "windows-1252"
    );
    fs::write(&path, "changed").unwrap();
    assert_eq!(
        files
            .reopen_with_encoding(&opened.document_id, &revision, Some("utf-8"))
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        files
            .get_disk_snapshot(&opened.document_id)
            .unwrap()
            .format
            .encoding,
        "windows-1252"
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "changed");
}

#[test]
fn real_save_conversion_retains_active_encoding_and_unfinished_legacy_body_is_recoverable() {
    let root = root();
    let path = root.join("conversion.txt");
    fs::write(&path, "中文\r\noriginal").unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    let opened = files.open_document(reference).unwrap();
    let request = SaveRequest {
        document_id: opened.document_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 1,
        expected_disk_revision: opened.metadata.disk_revision,
        text: "中文\nchanged".into(),
        format: TextFormat {
            encoding: "gbk".into(),
            bom: "none".into(),
            line_ending: "crlf".into(),
        },
        newline_map: None,
    };
    files
        .save_existing(
            request,
            &root.join("committed"),
            HardLinkPolicy::RequireConfirmation,
        )
        .unwrap();
    assert_eq!(
        fs::read(&path).unwrap(),
        encode_text("中文\r\nchanged", "gbk", "none").unwrap()
    );
    let disk = files.get_disk_snapshot(&opened.document_id).unwrap();
    assert_eq!(disk.format.encoding, "gbk");
    let OpenDocumentContent::Text { text, .. } = &disk.content else {
        panic!("expected complete text");
    };
    assert_eq!(text, "中文\nchanged");
    let mut next = SaveRequest {
        document_id: opened.document_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 2,
        expected_disk_revision: disk.metadata.disk_revision,
        text: "中文\nnext\nlast".into(),
        format: TextFormat {
            encoding: "gbk".into(),
            bom: "none".into(),
            line_ending: "mixed".into(),
        },
        newline_map: Some(NewlineMap {
            document_version: 2,
            endings: vec![
                featherpad_lib::models::Newline::Cr,
                featherpad_lib::models::Newline::Lf,
            ],
        }),
    };
    let journal = root.join("unfinished");
    drop(
        PreparedSave::prepare(
            &files,
            next.clone(),
            &journal,
            HardLinkPolicy::RequireConfirmation,
        )
        .unwrap(),
    );
    let recovery = RecoveryStore::new(root.join("recovery"));
    let scan = scan_save_transactions(&journal, &recovery).unwrap();
    assert_eq!(scan.candidates.len(), 1);
    let recovered =
        load_save_transaction(&journal, &scan.candidates[0].receipt_id, &recovery).unwrap();
    assert_eq!(recovered.text, next.text);
    assert_eq!(recovered.format.encoding, "gbk");
    assert_eq!(recovered.newline_map.endings.len(), 2);
    let before = fs::read(&path).unwrap();
    next.text.push('😀');
    assert_eq!(
        PreparedSave::prepare(
            &files,
            next,
            &root.join("rejected"),
            HardLinkPolicy::RequireConfirmation
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::LossyEncoding
    );
    assert_eq!(fs::read(path).unwrap(), before);
}
