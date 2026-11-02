use featherpad_lib::services::{files::FileService, grants::GrantKind};
use featherpad_lib::{
    models::{
        ErrorCode, Newline, NewlineMap, RecoverySnapshotReason, TextFormat,
        WriteRecoverySnapshotRequest,
    },
    services::recovery::{
        RecoverySnapshot, RecoverySource, RecoveryStore, SnapshotReason, MAX_RECOVERY_BYTES,
        MAX_SNAPSHOTS_PER_DOCUMENT,
    },
};
use std::{fs, path::PathBuf};

fn fixture() -> (PathBuf, RecoveryStore) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T110")
        .join(format!("native-snapshot-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let store = RecoveryStore::new(root.join("recovery"));
    (root, store)
}

fn snapshot(id: &str, version: u64, reason: SnapshotReason) -> RecoverySnapshot {
    RecoverySnapshot {
        document_id: id.to_owned(),
        buffer_version: version,
        text: "尚未命名😀\n下一行\n保留换行意图".into(),
        format: TextFormat {
            encoding: "utf-16be".into(),
            bom: "utf16be".into(),
            line_ending: "mixed".into(),
        },
        newline_map: Some(NewlineMap {
            document_version: version,
            endings: vec![Newline::Crlf, Newline::Cr],
        }),
        source: None,
        reason,
    }
}

#[test]
fn unnamed_periodic_and_hot_exit_snapshots_reopen_with_exact_body_and_intent() {
    let (root, store) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    for reason in [SnapshotReason::Periodic, SnapshotReason::HotExit] {
        let request = snapshot(&id, 7, reason);
        let expected = request.text.clone();
        let record = store.persist_snapshot(request).unwrap();
        let reopened = RecoveryStore::new(root.join("recovery"))
            .load(&record.manifest.receipt_id)
            .unwrap();
        assert_eq!(reopened.text, expected);
        assert_eq!(reopened.manifest.document_id, id);
        assert_eq!(reopened.manifest.buffer_version, 7);
        assert_eq!(reopened.manifest.format.encoding, "utf-16be");
        assert_eq!(reopened.manifest.format.bom, "utf16be");
        assert_eq!(
            reopened.manifest.newline_map.unwrap().endings,
            vec![Newline::Crlf, Newline::Cr]
        );
        assert!(reopened.manifest.source_path.is_none());
        assert!(reopened.manifest.source_revision.is_none());
        assert!(matches!(
            reopened.manifest.reason.as_str(),
            "periodic" | "hot-exit"
        ));
    }
}

#[test]
fn named_snapshots_preserve_the_base_revision_and_never_touch_changed_or_missing_source() {
    let (root, store) = fixture();
    let source = root.join("源文件😀.txt");
    fs::write(&source, b"original source").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut request = snapshot(&id, 1, SnapshotReason::Periodic);
    request.source = Some(RecoverySource {
        path: source.clone(),
        revision: "a".repeat(64),
    });
    let record = store.persist_snapshot(request).unwrap();
    fs::write(&source, b"external change must survive recovery").unwrap();
    let loaded = store.load(&record.manifest.receipt_id).unwrap();
    assert_eq!(loaded.manifest.source_path.as_ref(), Some(&source));
    assert_eq!(loaded.manifest.source_revision, Some("a".repeat(64)));
    assert_eq!(
        fs::read(&source).unwrap(),
        b"external change must survive recovery"
    );
    let missing = root.join("missing-source.txt");
    let mut request = snapshot(&id, 2, SnapshotReason::HotExit);
    request.source = Some(RecoverySource {
        path: missing.clone(),
        revision: "b".repeat(64),
    });
    let record = store.persist_snapshot(request).unwrap();
    assert_eq!(
        store
            .load(&record.manifest.receipt_id)
            .unwrap()
            .manifest
            .source_path,
        Some(missing.clone())
    );
    assert!(!missing.exists());
}

#[test]
fn invalid_origins_versions_and_newline_maps_fail_before_creating_storage() {
    let (root, store) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let mut invalid_revision = snapshot(&id, 1, SnapshotReason::Periodic);
    invalid_revision.source = Some(RecoverySource {
        path: root.join("source.txt"),
        revision: "invalid".into(),
    });
    let mut relative = snapshot(&id, 1, SnapshotReason::Periodic);
    relative.source = Some(RecoverySource {
        path: PathBuf::from("relative.txt"),
        revision: "a".repeat(64),
    });
    let mut bad_map = snapshot(&id, 1, SnapshotReason::HotExit);
    bad_map.newline_map.as_mut().unwrap().document_version = 0;
    for request in [
        snapshot(&id, 1, SnapshotReason::BeforeTrash),
        invalid_revision,
        relative,
        bad_map,
        snapshot("../outside", 1, SnapshotReason::Periodic),
        snapshot(&id, 9_007_199_254_740_992, SnapshotReason::Periodic),
    ] {
        assert_eq!(
            store.persist_snapshot(request).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(!root.join("recovery").exists());
    }
}

#[test]
fn damaged_latest_snapshot_leaves_an_older_complete_copy_and_incomplete_body_intact() {
    let (root, store) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let first = store
        .persist_snapshot(snapshot(&id, 1, SnapshotReason::Periodic))
        .unwrap();
    let latest = store
        .persist_snapshot(snapshot(&id, 2, SnapshotReason::HotExit))
        .unwrap();
    let latest_dir = root.join("recovery").join(&latest.manifest.receipt_id);
    fs::write(latest_dir.join("body.bin"), latest.text.replace('😀', "😃")).unwrap();
    assert_eq!(
        store.load(&latest.manifest.receipt_id).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        store
            .load(&first.manifest.receipt_id)
            .unwrap()
            .manifest
            .buffer_version,
        1
    );
    let incomplete_id = uuid::Uuid::new_v4().to_string();
    let incomplete = root.join("recovery").join(&incomplete_id);
    fs::create_dir(&incomplete).unwrap();
    fs::write(incomplete.join("body.bin"), b"incomplete but retained").unwrap();
    assert_eq!(
        store.load(&incomplete_id).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        fs::read(incomplete.join("body.bin")).unwrap(),
        b"incomplete but retained"
    );
    assert!(latest_dir.join("manifest.json").exists());
}

#[test]
fn scan_isolates_damaged_entries_and_retains_only_ten_verified_versions_per_document() {
    let (root, store) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let peer_id = uuid::Uuid::new_v4().to_string();
    let peer = store
        .persist_snapshot(snapshot(&peer_id, 1, SnapshotReason::HotExit))
        .unwrap();
    let mut retained = Vec::new();
    for version in 1..=12 {
        retained.push(
            store
                .persist_snapshot(snapshot(&id, version, SnapshotReason::Periodic))
                .unwrap(),
        );
    }
    let scan = store.scan().unwrap();
    let document_entries = scan
        .entries
        .iter()
        .filter(|entry| entry.document_id == id)
        .collect::<Vec<_>>();
    assert_eq!(document_entries.len(), MAX_SNAPSHOTS_PER_DOCUMENT);
    assert_eq!(
        document_entries
            .iter()
            .map(|entry| entry.buffer_version)
            .collect::<Vec<_>>(),
        vec![12, 11, 10, 9, 8, 7, 6, 5, 4, 3]
    );
    for record in &retained[..2] {
        assert!(!root
            .join("recovery")
            .join(&record.manifest.receipt_id)
            .exists());
    }
    assert!(root
        .join("recovery")
        .join(&peer.manifest.receipt_id)
        .exists());
    assert!(scan.failures.is_empty());

    let latest = retained.last().unwrap();
    fs::write(
        root.join("recovery")
            .join(&latest.manifest.receipt_id)
            .join("body.bin"),
        b"corrupt latest",
    )
    .unwrap();
    let incomplete_id = uuid::Uuid::new_v4().to_string();
    let incomplete = root.join("recovery").join(&incomplete_id);
    fs::create_dir(&incomplete).unwrap();
    fs::write(incomplete.join("body.bin"), b"incomplete").unwrap();
    let scan = store.scan().unwrap();
    assert!(scan
        .failures
        .iter()
        .any(|failure| failure.entry_id == latest.manifest.receipt_id));
    assert!(scan
        .failures
        .iter()
        .any(|failure| failure.entry_id == incomplete_id));
    assert_eq!(
        scan.entries
            .iter()
            .filter(|entry| entry.document_id == id)
            .map(|entry| entry.buffer_version)
            .max(),
        Some(11)
    );
    assert!(fs::read(incomplete.join("body.bin")).unwrap() == b"incomplete");
}

#[test]
fn unknown_reason_and_unpaired_source_fields_are_not_accepted_as_recoverable_data() {
    let (root, store) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let receipt = store
        .persist_snapshot(snapshot(&id, 1, SnapshotReason::Periodic))
        .unwrap()
        .manifest
        .receipt_id;
    let manifest_path = root.join("recovery").join(&receipt).join("manifest.json");
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    for (field, value) in [
        ("reason", serde_json::json!("unknown-future-reason")),
        (
            "sourcePath",
            serde_json::json!(root.join("never-read-this-source")),
        ),
        ("sourceRevision", serde_json::json!("a".repeat(64))),
    ] {
        let mut corrupt = original.clone();
        corrupt[field] = value;
        fs::write(&manifest_path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        assert_eq!(
            store.load(&receipt).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(manifest_path.with_file_name("body.bin").exists());
    }
}

#[test]
fn discard_blocks_old_unnamed_snapshots_and_allows_only_later_versions_without_harming_peers() {
    let (root, store) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let peer_id = uuid::Uuid::new_v4().to_string();
    let first = store
        .persist_snapshot(snapshot(&id, 1, SnapshotReason::Periodic))
        .unwrap();
    let peer = store
        .persist_snapshot(snapshot(&peer_id, 1, SnapshotReason::HotExit))
        .unwrap();
    store.discard_through(&id, 1).unwrap();
    assert_eq!(
        store.load(&first.manifest.receipt_id).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert!(!root
        .join("recovery")
        .join(first.manifest.receipt_id)
        .exists());
    assert_eq!(
        store
            .persist_snapshot(snapshot(&id, 1, SnapshotReason::HotExit))
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let next = store
        .persist_snapshot(snapshot(&id, 2, SnapshotReason::Periodic))
        .unwrap();
    assert_eq!(
        store
            .load(&next.manifest.receipt_id)
            .unwrap()
            .manifest
            .buffer_version,
        2
    );
    assert_eq!(
        store
            .load(&peer.manifest.receipt_id)
            .unwrap()
            .manifest
            .document_id,
        peer_id
    );
}

#[test]
fn unnamed_snapshot_obeys_existing_quota_and_keeps_the_last_complete_copy() {
    let (root, store) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let first = store
        .persist_snapshot(snapshot(&id, 1, SnapshotReason::Periodic))
        .unwrap();
    let capacity = fs::File::create(root.join("recovery").join("capacity.fixture")).unwrap();
    capacity.set_len(MAX_RECOVERY_BYTES).unwrap();
    drop(capacity);
    assert_eq!(
        store
            .persist_snapshot(snapshot(&id, 2, SnapshotReason::HotExit))
            .unwrap_err()
            .code,
        ErrorCode::DiskFull
    );
    assert_eq!(
        store.load(&first.manifest.receipt_id).unwrap().text,
        first.text
    );
}

fn wire_request(id: &str, revision: Option<String>) -> WriteRecoverySnapshotRequest {
    WriteRecoverySnapshotRequest {
        document_id: id.to_owned(),
        document_version: 1,
        reason: RecoverySnapshotReason::Periodic,
        base_disk_revision: revision,
        text: "前端完整缓冲😀".into(),
        format: TextFormat {
            encoding: "utf-8".into(),
            bom: "none".into(),
            line_ending: "lf".into(),
        },
        newline_map: None,
    }
}

#[test]
fn snapshot_wire_request_rejects_paths_grants_fractional_and_negative_versions() {
    let valid = serde_json::json!({ "documentId": uuid::Uuid::new_v4().to_string(), "documentVersion": 1,
        "reason": "periodic",
        "text": "controlled", "format": { "encoding": "utf-8", "bom": "none", "lineEnding": "lf" } });
    assert!(serde_json::from_value::<WriteRecoverySnapshotRequest>(valid.clone()).is_ok());
    for (field, value) in [
        ("sourcePath", serde_json::json!("arbitrary.txt")),
        ("path", serde_json::json!("arbitrary.txt")),
        ("grantId", serde_json::json!("not-issued")),
        ("documentVersion", serde_json::json!(-1)),
        ("documentVersion", serde_json::json!(1.5)),
        ("documentVersion", serde_json::Value::Null),
        ("reason", serde_json::json!("before-trash")),
        ("reason", serde_json::json!("unknown")),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        assert!(serde_json::from_value::<WriteRecoverySnapshotRequest>(invalid).is_err());
    }
}

#[test]
fn snapshot_source_is_derived_from_native_lease_and_never_revalidates_by_reading_or_writing_source()
{
    let (root, store) = fixture();
    let source = root.join("authorized.txt");
    fs::write(&source, b"original").unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&source, GrantKind::File)
        .unwrap();
    let opened = files.open_document(reference).unwrap();
    let prepared = files
        .prepare_recovery_snapshot(wire_request(
            &opened.document_id,
            Some(opened.metadata.disk_revision.clone()),
        ))
        .unwrap();
    fs::write(&source, b"external original must survive").unwrap();
    let persisted = store.persist_snapshot(prepared).unwrap();
    assert_eq!(
        persisted.manifest.source_path,
        Some(source.canonicalize().unwrap())
    );
    assert_eq!(
        persisted.manifest.source_revision,
        Some(opened.metadata.disk_revision)
    );
    assert_eq!(persisted.text, "前端完整缓冲😀");
    assert_eq!(
        fs::read(&source).unwrap(),
        b"external original must survive"
    );
    assert!(files.document_lease(&opened.document_id).is_some());
}

#[test]
fn missing_named_lease_is_rejected_but_an_unbound_full_copy_can_still_be_protected() {
    let (_root, store) = fixture();
    let files = FileService::default();
    let id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        files
            .prepare_recovery_snapshot(wire_request(&id, Some("a".repeat(64))))
            .err()
            .unwrap()
            .code,
        ErrorCode::NotFound
    );
    let prepared = files
        .prepare_recovery_snapshot(wire_request(&id, None))
        .unwrap();
    let persisted = store.persist_snapshot(prepared).unwrap();
    assert_eq!(persisted.text, "前端完整缓冲😀");
    assert!(persisted.manifest.source_path.is_none());
    assert!(persisted.manifest.source_revision.is_none());
}

#[test]
fn native_fragment_identity_cannot_bypass_full_snapshot_protection_by_omitting_the_revision() {
    use std::io::Write;
    let (root, _store) = fixture();
    let source = root.join("controlled-fragment.txt");
    let mut output = fs::File::create(&source).unwrap();
    let block = vec![b'a'; 64 * 1024];
    for _ in 0..320 {
        output.write_all(&block).unwrap();
    }
    drop(output);
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&source, GrantKind::File)
        .unwrap();
    let opened = files.open_document(reference).unwrap();
    assert_eq!(opened.mode, "large-readonly");
    for base in [None, Some(opened.metadata.disk_revision.clone())] {
        assert_eq!(
            files
                .prepare_recovery_snapshot(wire_request(&opened.document_id, base))
                .err()
                .unwrap()
                .code,
            ErrorCode::Unsupported
        );
    }
    assert!(!root.join("recovery").exists());
    assert_eq!(fs::metadata(source).unwrap().len(), 20 * 1024 * 1024);
}
