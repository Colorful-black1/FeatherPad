#![cfg(windows)]
use featherpad_lib::{
    models::{ErrorCode, FileRef, OpenDocument, SaveRequest},
    services::{
        files::FileService,
        grants::GrantKind,
        save::{HardLinkPolicy, PreparedSave},
    },
};
use std::{fs, path::PathBuf};

struct Fixture {
    service: FileService,
    reference: FileRef,
    opened: OpenDocument,
    path: PathBuf,
    journal: PathBuf,
}
fn fixture() -> Fixture {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T102")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let path = root.join("中文 saved fixture.txt");
    fs::write(&path, "original\r\n中文😀").unwrap();
    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&path, GrantKind::File)
        .unwrap();
    let opened = service.open_document(reference.clone()).unwrap();
    Fixture {
        service,
        reference,
        opened,
        path,
        journal: root.join("save-journal"),
    }
}
fn request(opened: &OpenDocument) -> SaveRequest {
    SaveRequest {
        document_id: opened.document_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 1,
        expected_disk_revision: opened.metadata.disk_revision.clone(),
        text: "changed\n中文😀".into(),
        format: opened.format.clone(),
        newline_map: None,
    }
}
fn journal_directory(fixture: &Fixture) -> PathBuf {
    fs::read_dir(&fixture.journal)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
}

#[test]
fn saves_real_utf8_crlf_bytes_and_keeps_the_document_id_after_atomic_replacement() {
    let mut fixture = fixture();
    let prepared = PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::RequireConfirmation,
    )
    .unwrap();
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
    let ack = prepared.commit(&mut fixture.service).unwrap();
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        "changed\r\n中文😀".as_bytes()
    );
    let reopened = fixture
        .service
        .open_document(fixture.reference.clone())
        .unwrap();
    assert_eq!(reopened.document_id, fixture.opened.document_id);
    assert_eq!(ack.disk_revision, reopened.metadata.disk_revision);
    assert_eq!(ack.document_version, 1);
    assert_eq!(ack.size_bytes, fs::metadata(&fixture.path).unwrap().len());
    assert_ne!(ack.disk_revision, fixture.opened.metadata.disk_revision);
    let directory = journal_directory(&fixture);
    assert!(directory.join("committed.json").is_file());
    assert_eq!(
        fs::read(directory.join("original.bin")).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
    assert_eq!(
        fs::read(directory.join("body.bin")).unwrap(),
        "changed\r\n中文😀".as_bytes()
    );
    assert!(!fs::read_dir(fixture.path.parent().unwrap())
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".bak")));
}

#[test]
fn external_change_between_prepare_and_commit_is_not_overwritten_and_both_snapshots_survive() {
    let mut fixture = fixture();
    let prepared = PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::RequireConfirmation,
    )
    .unwrap();
    fs::write(&fixture.path, "external new contents").unwrap();
    assert_eq!(
        prepared.commit(&mut fixture.service).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(&fixture.path).unwrap(), b"external new contents");
    let directory = journal_directory(&fixture);
    assert!(directory.join("original.bin").is_file());
    assert!(directory.join("body.bin").is_file());
    assert!(!directory.join("replacing.json").exists());
}

#[test]
fn rejects_forged_document_invalid_revision_and_readonly_before_any_target_write() {
    let fixture = fixture();
    let mut forged = request(&fixture.opened);
    forged.document_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        PreparedSave::prepare(
            &fixture.service,
            forged,
            &fixture.journal,
            HardLinkPolicy::RequireConfirmation
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::NotFound
    );
    let mut stale = request(&fixture.opened);
    stale.expected_disk_revision = "0".repeat(64);
    assert_eq!(
        PreparedSave::prepare(
            &fixture.service,
            stale,
            &fixture.journal,
            HardLinkPolicy::RequireConfirmation
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::Conflict
    );
    let mut permissions = fs::metadata(&fixture.path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&fixture.path, permissions).unwrap();
    assert_eq!(
        PreparedSave::prepare(
            &fixture.service,
            request(&fixture.opened),
            &fixture.journal,
            HardLinkPolicy::RequireConfirmation
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::ReadOnly
    );
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
    assert!(!fixture.journal.exists());
}

#[test]
fn hardlinks_require_confirmation_and_replaced_path_gets_its_own_identity() {
    let mut fixture = fixture();
    let alias = fixture.path.with_file_name("hardlink alias.txt");
    fs::hard_link(&fixture.path, &alias).unwrap();
    assert_eq!(
        PreparedSave::prepare(
            &fixture.service,
            request(&fixture.opened),
            &fixture.journal,
            HardLinkPolicy::RequireConfirmation
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::Unsupported
    );
    let prepared = PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::ReplaceSelectedPathConfirmed,
    )
    .unwrap();
    prepared.commit(&mut fixture.service).unwrap();
    assert_eq!(fs::read(&alias).unwrap(), "original\r\n中文😀".as_bytes());
    let reference = fixture
        .service
        .grants
        .register_selection(&alias, GrantKind::File)
        .unwrap();
    assert_ne!(
        fixture
            .service
            .open_document(reference)
            .unwrap()
            .document_id,
        fixture.opened.document_id
    );
    assert_eq!(
        fixture
            .service
            .open_document(fixture.reference)
            .unwrap()
            .document_id,
        fixture.opened.document_id
    );
}

#[test]
fn real_windows_sharing_violation_preserves_source_body_and_journal() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut fixture = fixture();
    let prepared = PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::RequireConfirmation,
    )
    .unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&fixture.path)
        .unwrap();
    assert!(prepared.commit(&mut fixture.service).is_err());
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
    assert!(journal_directory(&fixture).join("body.bin").is_file());
    assert!(!journal_directory(&fixture).join("committed.json").exists());
    drop(lock);
}

#[test]
fn prepared_save_holds_parent_names_stable_until_commit_or_cancel() {
    let fixture = fixture();
    let prepared = PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::RequireConfirmation,
    )
    .unwrap();
    let root = fixture.path.parent().unwrap();
    let moved = root.with_extension("moved");
    let controlled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T102");
    assert!(root.starts_with(&controlled) && moved.starts_with(&controlled));
    assert!(
        fs::rename(root, &moved).is_err(),
        "Directory guard must prevent parent rename before writing"
    );
    drop(prepared);
    drop(fixture.service);
    fs::rename(root, &moved).unwrap();
    assert_eq!(
        fs::read(moved.join("中文 saved fixture.txt")).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
}

#[test]
fn same_length_and_restored_mtime_cannot_hide_external_byte_changes() {
    let fixture = fixture();
    let metadata = fs::metadata(&fixture.path).unwrap();
    let mut changed = fs::read(&fixture.path).unwrap();
    changed[0] = b'X';
    fs::write(&fixture.path, changed).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&fixture.path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    assert_eq!(metadata.len(), fs::metadata(&fixture.path).unwrap().len());
    assert_eq!(
        metadata.modified().unwrap(),
        fs::metadata(&fixture.path).unwrap().modified().unwrap()
    );
    assert_eq!(
        PreparedSave::prepare(
            &fixture.service,
            request(&fixture.opened),
            &fixture.journal,
            HardLinkPolicy::RequireConfirmation
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(&fixture.path).unwrap()[0], b'X');
}

#[test]
fn unavailable_journal_prevents_target_mutation() {
    let fixture = fixture();
    fs::write(&fixture.journal, b"controlled journal path is a file").unwrap();
    assert!(PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::RequireConfirmation
    )
    .is_err());
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
    assert!(!fs::read_dir(fixture.path.parent().unwrap())
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
}

#[test]
fn altered_temporary_is_preserved_and_never_replaces_the_original() {
    use featherpad_lib::services::save_journal::SaveManifest;
    let mut fixture = fixture();
    let prepared = PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::RequireConfirmation,
    )
    .unwrap();
    let directory = journal_directory(&fixture);
    let manifest: SaveManifest =
        serde_json::from_slice(&fs::read(directory.join("manifest.json")).unwrap()).unwrap();
    assert!(manifest
        .temporary
        .starts_with(fixture.path.parent().unwrap().canonicalize().unwrap()));
    assert!(manifest
        .temporary
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(".featherpad-"));
    fs::write(&manifest.temporary, b"external changed the temp").unwrap();
    assert_eq!(
        prepared.commit(&mut fixture.service).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
    assert_eq!(
        fs::read(manifest.temporary).unwrap(),
        b"external changed the temp"
    );
    assert_eq!(
        fs::read(directory.join("body.bin")).unwrap(),
        "changed\r\n中文😀".as_bytes()
    );
}

#[test]
fn failing_precommit_stage_record_stops_before_replacement() {
    let mut fixture = fixture();
    let prepared = PreparedSave::prepare(
        &fixture.service,
        request(&fixture.opened),
        &fixture.journal,
        HardLinkPolicy::RequireConfirmation,
    )
    .unwrap();
    let directory = journal_directory(&fixture);
    // An occupied record makes create_new fail: no test IPC or fake OS success.
    fs::write(
        directory.join("replacing.json"),
        b"controlled occupied record",
    )
    .unwrap();
    assert!(prepared.commit(&mut fixture.service).is_err());
    assert_eq!(
        fs::read(&fixture.path).unwrap(),
        "original\r\n中文😀".as_bytes()
    );
    assert!(!directory.join("committed.json").exists());
    assert!(directory.join("body.bin").is_file());
}

#[test]
fn repeated_request_replays_ack_without_writing_and_different_payload_is_rejected() {
    let mut fixture = fixture();
    let request = request(&fixture.opened);
    let ack = fixture
        .service
        .save_existing(
            request.clone(),
            &fixture.journal,
            HardLinkPolicy::RequireConfirmation,
        )
        .unwrap();
    let mtime = fs::metadata(&fixture.path).unwrap().modified().unwrap();
    let replay = fixture
        .service
        .save_existing(
            request.clone(),
            &fixture.journal,
            HardLinkPolicy::RequireConfirmation,
        )
        .unwrap();
    assert_eq!(ack.disk_revision, replay.disk_revision);
    assert_eq!(
        mtime,
        fs::metadata(&fixture.path).unwrap().modified().unwrap()
    );
    assert_eq!(fs::read_dir(&fixture.journal).unwrap().count(), 1);
    let mut different = request;
    different.text = "different".into();
    assert_eq!(
        fixture
            .service
            .save_existing(
                different,
                &fixture.journal,
                HardLinkPolicy::RequireConfirmation
            )
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        fixture
            .service
            .stat_document(&fixture.opened.document_id)
            .unwrap()
            .disk_revision,
        ack.disk_revision
    );
}

#[test]
fn in_flight_identical_request_is_busy_and_changed_payload_is_invalid() {
    use featherpad_lib::services::save_requests::InFlightSaves;
    use std::sync::Arc;
    let fixture = fixture();
    let request = request(&fixture.opened);
    let active = Arc::new(InFlightSaves::default());
    let permit = active.enter(&request).unwrap();
    assert_eq!(active.enter(&request).err().unwrap().code, ErrorCode::Busy);
    let mut changed = request.clone();
    changed.text.push('x');
    assert_eq!(
        active.enter(&changed).err().unwrap().code,
        ErrorCode::InvalidInput
    );
    drop(permit);
    assert!(active.enter(&request).is_ok());
}
