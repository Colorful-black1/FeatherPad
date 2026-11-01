use featherpad_lib::{
    models::{ErrorCode, Newline, NewlineMap, SaveRequest, TextFormat},
    services::recovery::{RecoveryStore, MAX_RECOVERY_BYTES},
};
use std::{fs, path::PathBuf};

fn fixture() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T105")
        .join(format!("draft-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn snapshot() -> SaveRequest {
    SaveRequest {
        document_id: uuid::Uuid::new_v4().to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 7,
        expected_disk_revision: "a".repeat(64),
        text: "未保存😀\n第二行\n第三行".to_owned(),
        format: TextFormat {
            encoding: "utf-16le".to_owned(),
            bom: "utf16le".to_owned(),
            line_ending: "mixed".to_owned(),
        },
        newline_map: Some(NewlineMap {
            document_version: 7,
            endings: vec![Newline::Crlf, Newline::Cr],
        }),
    }
}

#[test]
fn durable_draft_reopens_with_exact_text_version_encoding_and_per_line_map() {
    let root = fixture();
    let source = root.join("original.txt");
    fs::write(&source, b"original disk bytes").unwrap();
    let request = snapshot();
    let store = RecoveryStore::new(root.join("recovery"));
    let persisted = store.persist_before_trash(&request, &source).unwrap();
    let receipt = persisted.manifest.receipt_id;
    drop(store);
    let reopened = RecoveryStore::new(root.join("recovery"))
        .load(&receipt)
        .unwrap();
    assert_eq!(reopened.text, request.text);
    assert_eq!(reopened.manifest.document_id, request.document_id);
    assert_eq!(reopened.manifest.buffer_version, 7);
    assert_eq!(reopened.manifest.format.encoding, "utf-16le");
    assert_eq!(reopened.manifest.format.bom, "utf16le");
    assert_eq!(
        reopened.manifest.newline_map.unwrap().endings,
        vec![Newline::Crlf, Newline::Cr]
    );
    assert_eq!(reopened.manifest.source_path.as_ref(), Some(&source));
    assert_eq!(
        reopened.manifest.source_revision.as_deref(),
        Some(request.expected_disk_revision.as_str())
    );
    assert_eq!(fs::read(&source).unwrap(), b"original disk bytes");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupt_body_schema_and_receipt_are_rejected_without_removing_either_copy() {
    let root = fixture();
    let store = RecoveryStore::new(root.join("recovery"));
    let source = root.join("source.txt");
    fs::write(&source, b"kept source").unwrap();
    let request = snapshot();
    let persisted = store.persist_before_trash(&request, &source).unwrap();
    let receipt = persisted.manifest.receipt_id;
    let record = root.join("recovery").join(&receipt);
    let altered = request.text.replace('😀', "😃");
    assert_eq!(altered.len(), request.text.len());
    fs::write(record.join("body.bin"), altered.as_bytes()).unwrap();
    assert!(store.load(&receipt).is_err());
    assert_eq!(
        fs::read(record.join("body.bin")).unwrap(),
        altered.as_bytes()
    );
    assert!(store.load("../source.txt").is_err());
    fs::write(record.join("body.bin"), request.text.as_bytes()).unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(record.join("manifest.json")).unwrap()).unwrap();
    manifest["schemaVersion"] = 99.into();
    fs::write(
        record.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(store.load(&receipt).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"kept source");
    assert!(record.join("manifest.json").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn full_store_bad_snapshot_and_unwritable_location_do_not_protect_or_modify_source() {
    let root = fixture();
    let source = root.join("source.txt");
    fs::write(&source, b"source remains intact").unwrap();
    let store_root = root.join("recovery");
    fs::create_dir(&store_root).unwrap();
    let budget_file = fs::File::create(store_root.join("capacity.fixture")).unwrap();
    budget_file.set_len(MAX_RECOVERY_BYTES).unwrap();
    drop(budget_file);
    let store = RecoveryStore::new(store_root.clone());
    let error = store
        .persist_before_trash(&snapshot(), &source)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::DiskFull);
    assert_eq!(fs::read_dir(&store_root).unwrap().count(), 2);
    let mut request = snapshot();
    request.newline_map.as_mut().unwrap().document_version = 6;
    assert!(store.persist_before_trash(&request, &source).is_err());
    let unavailable = RecoveryStore::new(source.clone());
    assert!(unavailable
        .persist_before_trash(&snapshot(), &source)
        .is_err());
    assert_eq!(fs::read(&source).unwrap(), b"source remains intact");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn recovery_directory_junction_is_rejected_before_writing_user_text() {
    let root = fixture();
    let target = root.join("other-target");
    fs::create_dir(&target).unwrap();
    let junction = root.join("recovery");
    let result = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(result.status.success());
    let store = RecoveryStore::new(junction.clone());
    let error = store
        .persist_before_trash(&snapshot(), &root.join("source.txt"))
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::OutOfScope);
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    fs::remove_dir(junction).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn concurrent_stores_cannot_both_spend_the_remaining_recovery_budget() {
    let root = fixture();
    let storage = root.join("recovery");
    fs::create_dir(&storage).unwrap();
    let capacity = fs::File::create(storage.join("capacity.fixture")).unwrap();
    capacity.set_len(MAX_RECOVERY_BYTES - 4_000).unwrap();
    drop(capacity);
    let mut request = snapshot();
    request.text = "x".repeat(2_500);
    request.format = TextFormat {
        encoding: "utf-8".to_owned(),
        bom: "none".to_owned(),
        line_ending: "lf".to_owned(),
    };
    request.newline_map = Some(NewlineMap {
        document_version: 7,
        endings: vec![],
    });
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let storage = storage.clone();
            let source = root.join("source.txt");
            let request = request.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                RecoveryStore::new(storage).persist_before_trash(&request, &source)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let error = results.into_iter().find_map(Result::err).unwrap();
    assert!(matches!(error.code, ErrorCode::Busy | ErrorCode::DiskFull));
    let actual_bytes: u64 = fs::read_dir(&storage)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                fs::read_dir(entry.path())
                    .unwrap()
                    .map(|entry| entry.unwrap().metadata().unwrap().len())
                    .sum()
            } else {
                entry.metadata().unwrap().len()
            }
        })
        .sum();
    assert!(actual_bytes <= MAX_RECOVERY_BYTES);
    fs::remove_dir_all(root).unwrap();
}
