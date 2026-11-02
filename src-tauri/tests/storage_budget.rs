use featherpad_lib::{
    models::{ErrorCode, SaveRequest, TextFormat},
    services::{
        recovery::{RecoverySnapshot, RecoveryStore, SnapshotReason},
        save_journal::SaveJournal,
        storage_budget::MAX_STORAGE_BYTES,
    },
};
use std::{fs, path::PathBuf};

fn fixture() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T110")
        .join(format!("budget-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("recovery")).unwrap();
    fs::create_dir_all(root.join("save-transactions")).unwrap();
    root
}

fn request() -> SaveRequest {
    SaveRequest {
        document_id: uuid::Uuid::new_v4().to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 1,
        expected_disk_revision: "a".repeat(64),
        text: "draft".into(),
        format: TextFormat {
            encoding: "utf-8".into(),
            bom: "none".into(),
            line_ending: "lf".into(),
        },
        newline_map: None,
    }
}

fn snapshot(request: &SaveRequest) -> RecoverySnapshot {
    RecoverySnapshot {
        document_id: request.document_id.clone(),
        buffer_version: request.document_version,
        text: request.text.clone(),
        format: request.format.clone(),
        newline_map: None,
        source: None,
        reason: SnapshotReason::Periodic,
    }
}

#[test]
fn both_writers_enforce_the_combined_budget_before_creating_receipts() {
    let root = fixture();
    // Logical length fixtures exercise the quota; this is not a real full-volume test.
    fs::File::create(root.join("recovery/capacity.fixture"))
        .unwrap()
        .set_len(MAX_STORAGE_BYTES / 2)
        .unwrap();
    fs::File::create(root.join("save-transactions/capacity.fixture"))
        .unwrap()
        .set_len(MAX_STORAGE_BYTES / 2 - 1024)
        .unwrap();
    let mut request = request();
    request.text = "x".repeat(2048);
    let target = root.join("source.txt");
    fs::write(&target, b"untouched").unwrap();
    let recovery = RecoveryStore::new(root.join("recovery"));
    assert_eq!(
        recovery
            .persist_snapshot(snapshot(&request))
            .unwrap_err()
            .code,
        ErrorCode::DiskFull
    );
    assert_eq!(
        SaveJournal::prepare_creation(
            &root.join("save-transactions"),
            &request,
            &target,
            request.text.as_bytes()
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::DiskFull
    );
    for name in ["recovery", "save-transactions"] {
        assert!(!fs::read_dir(root.join(name)).unwrap().any(|entry| entry
            .unwrap()
            .file_type()
            .unwrap()
            .is_dir()));
    }
    assert_eq!(fs::read(target).unwrap(), b"untouched");
}

#[test]
fn a_save_reservation_excludes_concurrent_recovery_until_its_lifetime_ends() {
    let root = fixture();
    let request = request();
    let target = root.join("new.txt");
    let pending = SaveJournal::prepare_creation(
        &root.join("save-transactions"),
        &request,
        &target,
        request.text.as_bytes(),
    )
    .unwrap();
    let recovery_root = root.join("recovery");
    let competing = snapshot(&request);
    let result =
        std::thread::spawn(move || RecoveryStore::new(recovery_root).persist_snapshot(competing))
            .join()
            .unwrap();
    let error = result.unwrap_err();
    assert_eq!(error.code, ErrorCode::Busy);
    assert!(error.retryable);
    drop(pending);
    let recovered = RecoveryStore::new(root.join("recovery"))
        .persist_snapshot(snapshot(&request))
        .unwrap();
    assert_eq!(recovered.text, request.text);
    assert!(!target.exists());
}

#[test]
fn a_full_transaction_store_keeps_the_last_complete_recovery_copy_readable() {
    let root = fixture();
    let mut request = request();
    let store = RecoveryStore::new(root.join("recovery"));
    let protected = store.persist_snapshot(snapshot(&request)).unwrap();
    fs::File::create(root.join("save-transactions/capacity.fixture"))
        .unwrap()
        .set_len(MAX_STORAGE_BYTES)
        .unwrap();
    request.document_version += 1;
    request.text.push_str(" newer");
    assert_eq!(
        store.persist_snapshot(snapshot(&request)).unwrap_err().code,
        ErrorCode::DiskFull
    );
    assert_eq!(
        store.load(&protected.manifest.receipt_id).unwrap().text,
        protected.text
    );
    assert!(root.join("save-transactions/capacity.fixture").exists());
}
