use featherpad_lib::{
    models::TextFormat,
    services::{
        recovery::RecoveryStore,
        save_journal::{digest, SaveManifest},
        startup_storage::{load_save_transaction, scan_save_transactions},
    },
};
use std::{fs, path::PathBuf};

fn fixture() -> (PathBuf, PathBuf, RecoveryStore) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T110")
        .join(format!("startup-storage-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let transactions = root.join("save-transactions");
    let recovery = RecoveryStore::new(root.join("recovery"));
    (root, transactions, recovery)
}

#[test]
fn unfinished_save_evidence_is_retained_and_obeys_the_discard_marker() {
    let (root, transactions, recovery) = fixture();
    let document_id = uuid::Uuid::new_v4().to_string();
    let receipt_id = uuid::Uuid::new_v4().to_string();
    let request_id = uuid::Uuid::new_v4().to_string();
    let target = root.join("fixture.txt");
    let journal = transactions.join(&receipt_id);
    fs::create_dir_all(&journal).unwrap();
    fs::write(&target, b"old body").unwrap();
    let original = b"old body";
    let body = b"new body";
    let manifest = SaveManifest {
        schema_version: 1,
        receipt_id: receipt_id.clone(),
        document_id: document_id.clone(),
        request_id,
        document_version: 1,
        target: target.clone(),
        temporary: root.join(format!(".featherpad-{receipt_id}.tmp")),
        backup: root.join(format!(".featherpad-{receipt_id}.bak")),
        expected_revision: Some("a".repeat(64)),
        original_sha256: digest(original),
        body_sha256: digest(body),
        original_bytes: original.len() as u64,
        body_bytes: body.len() as u64,
        format: TextFormat {
            encoding: "utf-8".into(),
            bom: "none".into(),
            line_ending: "lf".into(),
        },
    };
    fs::write(
        journal.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(journal.join("original.bin"), original).unwrap();
    fs::write(journal.join("body.bin"), body).unwrap();
    fs::write(
        journal.join("staged.json"),
        serde_json::to_vec(&serde_json::json!({
            "receiptId": receipt_id,
            "stage": "staged",
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(&manifest.temporary, body).unwrap();
    fs::write(&manifest.backup, original).unwrap();

    let first = scan_save_transactions(&transactions, &recovery).unwrap();
    assert_eq!(first.candidates.len(), 1);
    assert!(first.bytes > 0);
    assert!(first
        .warnings
        .iter()
        .any(|warning| warning.contains("人工恢复候选")));
    assert!(first
        .warnings
        .iter()
        .any(|warning| warning.contains("临时文件与备份")));
    let loaded = load_save_transaction(&transactions, &receipt_id, &recovery).unwrap();
    assert_eq!(loaded.text, "new body");
    assert_eq!(loaded.newline_map.document_version, 1);
    assert_eq!(fs::read(&target).unwrap(), original);

    recovery.discard_through(&document_id, 1).unwrap();
    let second = scan_save_transactions(&transactions, &recovery).unwrap();
    assert_eq!(
        second.candidates.len(),
        0,
        "warnings: {:?}",
        second.warnings
    );
    assert!(second
        .warnings
        .iter()
        .any(|warning| warning.contains("明确放弃")));
    assert!(load_save_transaction(&transactions, &receipt_id, &recovery).is_err());
    assert!(journal.join("manifest.json").is_file());
    assert!(journal.join("body.bin").is_file());
    assert!(manifest.temporary.is_file());
    assert!(manifest.backup.is_file());

    fs::write(
        root.join("recovery")
            .join(format!("discarded-{document_id}"))
            .join("1.json"),
        b"{damaged-marker",
    )
    .unwrap();
    let damaged_marker = scan_save_transactions(&transactions, &recovery).unwrap();
    assert_eq!(damaged_marker.candidates.len(), 0);
    assert!(damaged_marker
        .warnings
        .iter()
        .any(|warning| warning.contains("暂停认领")));
    assert!(!damaged_marker
        .warnings
        .iter()
        .any(|warning| warning.contains("作为人工恢复候选")));
    assert!(load_save_transaction(&transactions, &receipt_id, &recovery).is_err());
    assert_eq!(fs::read(journal.join("body.bin")).unwrap(), body);
    assert_eq!(fs::read(&manifest.temporary).unwrap(), body);
    assert_eq!(fs::read(&manifest.backup).unwrap(), original);
}

#[test]
fn encoded_transaction_copies_round_trip_without_source_access_or_bom_guessing() {
    use featherpad_lib::{
        models::{Newline, NewlineMap, SaveRequest},
        services::{encode::encode_snapshot, save_journal::SaveJournal},
    };
    for (encoding, bom) in [
        ("utf-8", "none"),
        ("utf-8", "utf8"),
        ("utf-16le", "none"),
        ("utf-16be", "none"),
        ("utf-16le", "utf16le"),
        ("utf-16be", "utf16be"),
    ] {
        let (root, transactions, recovery) = fixture();
        let request = SaveRequest {
            document_id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            document_version: 7,
            expected_disk_revision: "a".repeat(64),
            text: "\u{feff}中文😀\n第二行\n末尾".into(),
            format: TextFormat {
                encoding: encoding.into(),
                bom: bom.into(),
                line_ending: "mixed".into(),
            },
            newline_map: Some(NewlineMap {
                document_version: 7,
                endings: vec![Newline::Crlf, Newline::Cr],
            }),
        };
        let body = encode_snapshot(&request).unwrap();
        let target = root.join("未创建.txt");
        let journal =
            SaveJournal::prepare_creation(&transactions, &request, &target, &body).unwrap();
        let receipt = journal.manifest.receipt_id.clone();
        let directory = journal.directory.clone();
        drop(journal);
        let loaded = load_save_transaction(&transactions, &receipt, &recovery).unwrap();
        assert_eq!(loaded.text, request.text);
        assert_eq!(loaded.format.encoding, encoding);
        assert_eq!(loaded.format.bom, bom);
        assert_eq!(loaded.newline_map.endings, vec![Newline::Crlf, Newline::Cr]);
        assert!(!target.exists());
        fs::write(directory.join("body.bin"), b"changed evidence").unwrap();
        assert!(load_save_transaction(&transactions, &receipt, &recovery).is_err());
        assert_eq!(
            fs::read(directory.join("body.bin")).unwrap(),
            b"changed evidence"
        );
        assert!(load_save_transaction(&transactions, "../outside", &recovery).is_err());
    }
}
