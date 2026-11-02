use featherpad_lib::{
    models::{ErrorCode, SaveRequest, TextFormat},
    services::recovery::{RecoveryStore, MAX_RECOVERY_BYTES},
};
use std::{fs, path::PathBuf};

fn fixture() -> (PathBuf, PathBuf, RecoveryStore, SaveRequest) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T107")
        .join("discard")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.txt");
    fs::write(&source, b"source remains intact").unwrap();
    let store = RecoveryStore::new(root.join("recovery"));
    let request = SaveRequest {
        document_id: uuid::Uuid::new_v4().to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 1,
        expected_disk_revision: "a".repeat(64),
        text: "未保存😀".into(),
        format: TextFormat {
            encoding: "utf-8".into(),
            bom: "none".into(),
            line_ending: "lf".into(),
        },
        newline_map: None,
    };
    (root, source, store, request)
}

#[test]
fn discarded_versions_stay_discarded_after_restart_and_cannot_be_recreated_by_late_writes() {
    let (root, source, store, mut request) = fixture();
    let first = store
        .persist_before_trash(&request, &source)
        .unwrap()
        .manifest
        .receipt_id;
    request.document_version = 2;
    request.text.push_str(" 第二版");
    let second = store
        .persist_before_trash(&request, &source)
        .unwrap()
        .manifest
        .receipt_id;
    let mut peer = request.clone();
    peer.document_id = uuid::Uuid::new_v4().to_string();
    let independent = store
        .persist_before_trash(&peer, &source)
        .unwrap()
        .manifest
        .receipt_id;
    store.discard_through(&request.document_id, 2).unwrap();
    drop(store);
    let store = RecoveryStore::new(root.join("recovery"));
    for receipt in [first, second] {
        assert_eq!(store.load(&receipt).unwrap_err().code, ErrorCode::NotFound);
    }
    assert_eq!(
        store
            .persist_before_trash(&request, &source)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(store.load(&independent).unwrap().text, peer.text);
    store.discard_through(&request.document_id, 2).unwrap();
    store.discard_through(&request.document_id, 1).unwrap();
    request.document_version = 3;
    request.text.push_str(" 新输入");
    let third = store
        .persist_before_trash(&request, &source)
        .unwrap()
        .manifest
        .receipt_id;
    assert_eq!(store.load(&third).unwrap().text, request.text);
    store.discard_through(&request.document_id, 1).unwrap();
    assert!(store.load(&third).is_ok());
    store.discard_through(&request.document_id, 3).unwrap();
    assert_eq!(store.load(&third).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(fs::read(source).unwrap(), b"source remains intact");
}

#[test]
fn corrupt_marker_fails_closed_without_removing_source_or_the_only_draft() {
    let (root, source, store, request) = fixture();
    let receipt = store
        .persist_before_trash(&request, &source)
        .unwrap()
        .manifest
        .receipt_id;
    store.discard_through(&request.document_id, 0).unwrap();
    assert!(store.load(&receipt).is_ok());
    let marker = root
        .join("recovery")
        .join(format!("discarded-{}", request.document_id))
        .join("0.json");
    fs::write(marker, b"{broken marker").unwrap();
    assert_eq!(
        store.load(&receipt).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert!(store.discard_through(&request.document_id, 1).is_err());
    assert_eq!(
        fs::read(root.join("recovery").join(receipt).join("body.bin")).unwrap(),
        request.text.as_bytes()
    );
    assert_eq!(fs::read(source).unwrap(), b"source remains intact");
}

#[test]
fn invalid_inputs_and_full_or_unwritable_store_never_claim_a_durable_discard() {
    let (root, source, store, request) = fixture();
    for id in ["../outside", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", ""] {
        assert_eq!(
            store.discard_through(id, 1).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
    assert!(store
        .discard_through(&request.document_id, 9_007_199_254_740_992)
        .is_err());
    assert!(!root.join("recovery").exists());
    assert!(RecoveryStore::new(source.clone())
        .discard_through(&request.document_id, 1)
        .is_err());
    let receipt = store
        .persist_before_trash(&request, &source)
        .unwrap()
        .manifest
        .receipt_id;
    let filler = fs::File::create(root.join("recovery/capacity.fixture")).unwrap();
    filler.set_len(MAX_RECOVERY_BYTES).unwrap();
    drop(filler);
    assert_eq!(
        store
            .discard_through(&request.document_id, 1)
            .unwrap_err()
            .code,
        ErrorCode::DiskFull
    );
    assert_eq!(store.load(&receipt).unwrap().text, request.text);
    assert_eq!(fs::read(source).unwrap(), b"source remains intact");
}

#[test]
fn a_live_store_lock_blocks_discard_and_load_without_mutating_the_draft() {
    let (root, source, store, request) = fixture();
    let receipt = store
        .persist_before_trash(&request, &source)
        .unwrap()
        .manifest
        .receipt_id;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("recovery/.recovery.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    assert_eq!(
        store
            .discard_through(&request.document_id, 1)
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    assert_eq!(store.load(&receipt).unwrap_err().code, ErrorCode::Busy);
    drop(lock);
    assert_eq!(store.load(&receipt).unwrap().text, request.text);
}

#[cfg(windows)]
#[test]
fn a_tombstone_directory_junction_is_rejected_without_writing_through_it() {
    let (root, source, store, request) = fixture();
    fs::create_dir(root.join("recovery")).unwrap();
    let outside = root.join("outside");
    fs::create_dir(&outside).unwrap();
    let link = root
        .join("recovery")
        .join(format!("discarded-{}", request.document_id));
    let result = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        store
            .discard_through(&request.document_id, 1)
            .unwrap_err()
            .code,
        ErrorCode::OutOfScope
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    assert_eq!(fs::read(source).unwrap(), b"source remains intact");
    fs::remove_dir(link).unwrap();
}
