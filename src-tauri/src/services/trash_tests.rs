use super::*;
use crate::{
    models::{FileRef, ListDirectoryRequest, NewlineMap, OpenDocument, SaveRequest, TextFormat},
    services::grants::GrantKind,
};
use std::{fs, path::PathBuf};

fn fixture() -> (PathBuf, FileService, FileRef) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T105")
        .join(format!("trash-service-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("workspace")).unwrap();
    let mut service = FileService::default();
    let grant = service
        .grants
        .register_selection(&root.join("workspace"), GrantKind::Directory)
        .unwrap();
    (root, service, grant)
}

fn impact(service: &mut FileService, grant: &FileRef, name: &str) -> TrashImpact {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let entry = service
            .list_directory(ListDirectoryRequest {
                reference: grant.clone(),
                cursor: None,
                limit: None,
                show_hidden: true,
            })
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.name == name)
            .unwrap();
        match service.get_trash_impact(TrashImpactRequest {
            reference: entry.reference,
            expected_revision: entry.revision,
        }) {
            Ok(impact) => return impact,
            // NTFS enumeration metadata can lag immediately after fixture creation. Re-list
            // only this read-only preview; never retry the subsequent frozen trash request.
            Err(error)
                if error.code == ErrorCode::Conflict && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => panic!("Controlled trash preview failed: {error:?}"),
        }
    }
}

fn snapshot(document: &OpenDocument, text: &str) -> SaveRequest {
    SaveRequest {
        document_id: document.document_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 3,
        expected_disk_revision: document.metadata.disk_revision.clone(),
        text: text.to_owned(),
        format: TextFormat {
            encoding: "utf-8".into(),
            bom: "none".into(),
            line_ending: "lf".into(),
        },
        newline_map: Some(NewlineMap {
            document_version: 3,
            endings: vec![],
        }),
    }
}

fn request(impact: &TrashImpact, snapshots: Vec<SaveRequest>) -> TrashEntryRequest {
    TrashEntryRequest {
        reference: impact.reference.clone(),
        expected_revision: impact.revision.clone(),
        expected_identity: impact.identity.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        affected_document_ids: impact
            .affected_documents
            .iter()
            .map(|document| document.document_id.clone())
            .collect(),
        snapshots,
    }
}

fn restore_owned(recycled: &Path, source: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
                FOFX_EARLYFAILURE, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
            },
        },
    };
    assert!(!source.exists());
    assert!(recycled
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("$R"));
    let from: Vec<u16> = recycled.as_os_str().encode_wide().chain(Some(0)).collect();
    let parent: Vec<u16> = source
        .parent()
        .unwrap()
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let name: Vec<u16> = source
        .file_name()
        .unwrap()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: only the exact item returned by this fixture's real recycle operation is restored.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
        {
            let item: IShellItem =
                SHCreateItemFromParsingName(PCWSTR(from.as_ptr()), None).unwrap();
            let parent: IShellItem =
                SHCreateItemFromParsingName(PCWSTR(parent.as_ptr()), None).unwrap();
            let operation: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER).unwrap();
            operation
                .SetOperationFlags(
                    FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOFX_EARLYFAILURE,
                )
                .unwrap();
            operation
                .MoveItem(&item, &parent, PCWSTR(name.as_ptr()), None)
                .unwrap();
            operation.PerformOperations().unwrap();
            assert!(!operation.GetAnyOperationsAborted().unwrap().as_bool());
        }
        CoUninitialize();
    }
    assert!(source.exists());
}

#[test]
fn real_recycle_protects_dirty_body_and_replay_never_deletes_a_new_same_name_file() {
    let (root, mut service, grant) = fixture();
    let source = root.join("workspace").join("中文😀.txt");
    fs::write(&source, b"original disk bytes").unwrap();
    let file_grant = service
        .grants
        .register_selection(&source, GrantKind::File)
        .unwrap();
    let opened = service.open_document(file_grant).unwrap();
    let impact = impact(&mut service, &grant, "中文😀.txt");
    assert_eq!(impact.affected_documents[0].document_id, opened.document_id);
    let request = request(&impact, vec![snapshot(&opened, "dirty body😀")]);
    let recovery = root.join("private").join("recovery");
    let mut bin = None;
    let result = service
        .trash_with_recycler(request.clone(), &recovery, |path, revision, identity| {
            let receipt = windows_trash::recycle_checked(path, revision, identity)?;
            bin = Some(receipt.recycled_path.clone());
            Ok(receipt)
        })
        .unwrap();
    assert_eq!(
        result.missing_document_ids,
        vec![opened.document_id.clone()]
    );
    assert!(service.document_lease(&opened.document_id).is_none());
    let draft = RecoveryStore::new(recovery)
        .load(&result.drafts[0].receipt_id)
        .unwrap();
    assert_eq!(draft.text, "dirty body😀");
    assert_eq!(draft.manifest.buffer_version, 3);
    assert_eq!(
        fs::read(bin.as_ref().unwrap()).unwrap(),
        b"original disk bytes"
    );
    fs::write(&source, b"new same-name file").unwrap();
    let replay = service
        .trash_entry(request.clone(), &root.join("unavailable"))
        .unwrap();
    assert_eq!(replay.receipt_id, result.receipt_id);
    assert_eq!(fs::read(&source).unwrap(), b"new same-name file");
    let mut changed = request.clone();
    changed.snapshots[0].text.push('!');
    assert_eq!(
        service
            .trash_entry(changed, &root.join("private/recovery"))
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    fs::remove_file(&source).unwrap();
    restore_owned(bin.as_ref().unwrap(), &source);
    for index in 0..257 {
        service
            .create_entry(crate::models::CreateEntryRequest {
                parent: grant.clone(),
                name: format!("cache-eviction-{index}.txt"),
                kind: crate::models::EntryKind::File,
                request_id: uuid::Uuid::new_v4().to_string(),
            })
            .unwrap();
    }
    let expired = service
        .trash_entry(request, &root.join("private/recovery"))
        .unwrap_err();
    assert_eq!(expired.code, ErrorCode::Conflict);
    assert!(expired.message.contains("不会重复执行"));
    assert_eq!(fs::read(&source).unwrap(), b"original disk bytes");
    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn directory_impact_detects_newly_opened_descendants_and_recycles_only_after_all_snapshots() {
    let (root, mut service, grant) = fixture();
    let folder = root.join("workspace").join("folder");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("first.txt"), b"first").unwrap();
    fs::write(folder.join("second.txt"), b"second").unwrap();
    let first_ref = service
        .grants
        .register_selection(&folder.join("first.txt"), GrantKind::File)
        .unwrap();
    let first = service.open_document(first_ref).unwrap();
    let old_impact = impact(&mut service, &grant, "folder");
    let second = service
        .open_document(FileRef {
            grant_id: grant.grant_id.clone(),
            relative_path: "folder/second.txt".into(),
        })
        .unwrap();
    let recovery = root.join("private").join("recovery");
    let stale = request(&old_impact, vec![snapshot(&first, "first dirty")]);
    assert_eq!(
        service.trash_entry(stale, &recovery).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert!(folder.exists());
    assert!(!recovery.exists());
    let current = impact(&mut service, &grant, "folder");
    let mut missing = request(&current, vec![snapshot(&first, "first dirty")]);
    assert_eq!(
        service
            .trash_entry(missing.clone(), &recovery)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    missing.request_id = uuid::Uuid::new_v4().to_string();
    missing.snapshots.push(snapshot(&second, "second dirty"));
    let mut bin = None;
    let result = service
        .trash_with_recycler(missing, &recovery, |path, revision, identity| {
            let receipt = windows_trash::recycle_checked(path, revision, identity)?;
            bin = Some(receipt.recycled_path.clone());
            Ok(receipt)
        })
        .unwrap();
    assert_eq!(result.drafts.len(), 2);
    assert!(!folder.exists());
    assert_eq!(
        fs::read(bin.as_ref().unwrap().join("second.txt")).unwrap(),
        b"second"
    );
    restore_owned(bin.as_ref().unwrap(), &folder);
    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn real_shell_failure_rebinds_the_original_document_and_is_not_retried_after_unlock() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let (root, mut service, grant) = fixture();
    let source = root.join("workspace/locked.txt");
    fs::write(&source, b"source survives").unwrap();
    let reference = FileRef {
        grant_id: grant.grant_id.clone(),
        relative_path: "locked.txt".into(),
    };
    let opened = service.open_document(reference.clone()).unwrap();
    let impact = impact(&mut service, &grant, "locked.txt");
    let request = request(&impact, vec![snapshot(&opened, "saved recovery input")]);
    let recovery = root.join("private/recovery");
    let guard = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&source)
        .unwrap();
    let error = service.trash_entry(request.clone(), &recovery).unwrap_err();
    assert_eq!(error.code, ErrorCode::TrashUnavailable);
    assert_eq!(
        service
            .document_lease(&opened.document_id)
            .unwrap()
            .reference,
        reference
    );
    assert_eq!(fs::read(&source).unwrap(), b"source survives");
    drop(guard);
    let replay = service.trash_entry(request, &recovery).unwrap_err();
    assert_eq!(replay.code, error.code);
    assert_eq!(fs::read(&source).unwrap(), b"source survives");
    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn identity_storage_and_scope_failures_preserve_source_and_document_binding() {
    let (root, mut service, grant) = fixture();
    let source = root.join("workspace/source.txt");
    fs::write(&source, b"original").unwrap();
    let opened = service
        .open_document(FileRef {
            grant_id: grant.grant_id.clone(),
            relative_path: "source.txt".into(),
        })
        .unwrap();
    let impact = impact(&mut service, &grant, "source.txt");
    let mut bad_identity = request(&impact, vec![snapshot(&opened, "protected dirty")]);
    bad_identity.expected_identity = "0".repeat(64);
    let recovery = root.join("private/recovery");
    assert_eq!(
        service
            .trash_entry(bad_identity, &recovery)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert!(!recovery.exists());
    fs::create_dir_all(recovery.parent().unwrap()).unwrap();
    fs::write(&recovery, b"not a directory").unwrap();
    assert!(service
        .trash_entry(
            request(&impact, vec![snapshot(&opened, "protected dirty")]),
            &recovery
        )
        .is_err());
    assert!(service.document_lease(&opened.document_id).is_some());
    for reference in [
        FileRef {
            grant_id: "unknown".into(),
            relative_path: "source.txt".into(),
        },
        FileRef {
            grant_id: grant.grant_id.clone(),
            relative_path: "../private".into(),
        },
        grant,
    ] {
        assert!(service
            .get_trash_impact(TrashImpactRequest {
                reference,
                expected_revision: impact.revision.clone()
            })
            .is_err());
    }
    assert_eq!(fs::read(&source).unwrap(), b"original");
    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn same_name_size_time_and_bytes_cannot_reuse_a_confirmation_for_a_new_file_identity() {
    let (root, mut service, grant) = fixture();
    let source = root.join("workspace").join("source.txt");
    fs::write(&source, b"same bytes").unwrap();
    let old_time = fs::metadata(&source).unwrap().modified().unwrap();
    let original = impact(&mut service, &grant, "source.txt");
    fs::rename(&source, root.join("workspace").join("old-source.txt")).unwrap();
    fs::write(&source, b"same bytes").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old_time))
        .unwrap();
    let replacement = impact(&mut service, &grant, "source.txt");
    assert_eq!(replacement.revision, original.revision);
    assert_ne!(replacement.identity, original.identity);
    let recovery = root.join("private").join("recovery");
    let error = service
        .trash_entry(request(&original, vec![]), &recovery)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(fs::read(&source).unwrap(), b"same bytes");
    assert!(!recovery.exists());
    drop(service);
    fs::remove_dir_all(root).unwrap();
}
