use featherpad_lib::{
    models::{
        CreateEntryRequest, EntryKind, ErrorCode, FileRef, ListDirectoryRequest, RenameEntryRequest,
    },
    services::{files::FileService, grants::GrantKind},
};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn owned_root(label: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T105")
        .join(format!("{label}-{}", uuid::Uuid::new_v4()))
}

fn create_request(
    parent: &FileRef,
    name: &str,
    kind: EntryKind,
    request_id: String,
) -> CreateEntryRequest {
    CreateEntryRequest {
        parent: parent.clone(),
        name: name.to_owned(),
        kind,
        request_id,
    }
}

fn rename_request(
    reference: &FileRef,
    new_name: &str,
    expected_revision: Option<String>,
    request_id: String,
) -> RenameEntryRequest {
    RenameEntryRequest {
        reference: reference.clone(),
        new_name: new_name.to_owned(),
        expected_revision,
        request_id,
    }
}

fn root_reference(service: &mut FileService, root: &Path) -> FileRef {
    service
        .grants
        .register_selection(root, GrantKind::Directory)
        .unwrap()
}

fn list_entry(
    service: &mut FileService,
    root: &FileRef,
    name: &str,
) -> featherpad_lib::models::DirectoryEntry {
    service
        .list_directory(ListDirectoryRequest {
            reference: root.clone(),
            cursor: None,
            limit: Some(1000),
            show_hidden: true,
        })
        .unwrap()
        .items
        .into_iter()
        .find(|entry| entry.name == name)
        .unwrap()
}

#[test]
fn creates_real_entries_without_overwrite_and_validates_windows_names() {
    let root = owned_root("create");
    fs::create_dir_all(&root).unwrap();
    let mut service = FileService::default();
    let reference = root_reference(&mut service, &root);

    for (index, invalid) in [
        "",
        "CON",
        "nul.txt",
        "bad:name",
        "trailing.",
        "trailing ",
        &"x".repeat(256),
    ]
    .into_iter()
    .enumerate()
    {
        let error = service
            .create_entry(create_request(
                &reference,
                invalid,
                EntryKind::File,
                uuid::Uuid::new_v4().to_string(),
            ))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "case {index}");
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let request = create_request(
        &reference,
        "新建 中文😀.txt",
        EntryKind::File,
        request_id.clone(),
    );
    let created = service.create_entry(request.clone()).unwrap();
    assert_eq!(created.kind, "file");
    assert_eq!(created.reference.relative_path, "新建 中文😀.txt");
    assert_eq!(created.revision.len(), 64);
    assert!(service.grants.open_file(&created.reference).is_ok());
    assert_eq!(fs::read(root.join("新建 中文😀.txt")).unwrap(), b"");
    let replayed = service.create_entry(request).unwrap();
    assert_eq!(replayed.reference, created.reference);
    assert_eq!(replayed.id, created.id);

    let changed = service.create_entry(create_request(
        &reference,
        "另一名称.txt",
        EntryKind::File,
        request_id,
    ));
    assert_eq!(changed.unwrap_err().code, ErrorCode::InvalidInput);

    let collision = service
        .create_entry(create_request(
            &reference,
            "新建 中文😀.txt",
            EntryKind::File,
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap_err();
    assert_eq!(collision.code, ErrorCode::Conflict);
    assert_eq!(fs::read(root.join("新建 中文😀.txt")).unwrap(), b"");

    let directory = service
        .create_entry(create_request(
            &reference,
            "新目录",
            EntryKind::Directory,
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap();
    assert_eq!(directory.kind, "directory");
    assert!(root.join("新目录").is_dir());

    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rename_keeps_open_document_id_and_rejects_collisions_or_stale_revisions() {
    let root = owned_root("rename");
    let source_path = root.join("Source.txt");
    let target_path = root.join("Target.txt");
    fs::create_dir_all(&root).unwrap();
    fs::write(&source_path, b"source bytes").unwrap();
    fs::write(&target_path, b"target bytes").unwrap();
    let mut service = FileService::default();
    let root_ref = root_reference(&mut service, &root);
    let source_ref = FileRef {
        grant_id: root_ref.grant_id.clone(),
        relative_path: "Source.txt".to_owned(),
    };
    let opened = service.open_document(source_ref.clone()).unwrap();
    let source_entry = list_entry(&mut service, &root_ref, "Source.txt");

    let stale = service
        .rename_entry(rename_request(
            &source_ref,
            "Moved.txt",
            Some("0".repeat(64)),
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    assert_eq!(fs::read(&source_path).unwrap(), b"source bytes");

    let blocked = service
        .rename_entry(rename_request(
            &source_ref,
            "Target.txt",
            Some(source_entry.revision.clone()),
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap_err();
    assert_eq!(blocked.code, ErrorCode::Conflict);
    assert_eq!(fs::read(&source_path).unwrap(), b"source bytes");
    assert_eq!(fs::read(&target_path).unwrap(), b"target bytes");

    let request_id = uuid::Uuid::new_v4().to_string();
    let request = rename_request(
        &source_ref,
        "Moved.txt",
        Some(source_entry.revision),
        request_id,
    );
    let renamed = service.rename_entry(request.clone()).unwrap();
    assert_eq!(renamed.entry.name, "Moved.txt");
    assert_eq!(renamed.renamed_documents.len(), 1);
    assert_eq!(renamed.renamed_documents[0].document_id, opened.document_id);
    assert_eq!(
        renamed.renamed_documents[0].reference.relative_path,
        "Moved.txt"
    );
    assert_eq!(
        Path::new(&renamed.renamed_documents[0].display_path).file_name(),
        Some(std::ffi::OsStr::new("Moved.txt"))
    );
    let lease = service.document_lease(&opened.document_id).unwrap();
    assert_eq!(lease.reference.relative_path, "Moved.txt");
    assert!(lease.path.ends_with("Moved.txt"));
    assert!(!source_path.exists());
    assert_eq!(fs::read(root.join("Moved.txt")).unwrap(), b"source bytes");

    let replay = service.rename_entry(request).unwrap();
    assert_eq!(replay.entry.reference, renamed.entry.reference);
    assert_eq!(replay.renamed_documents[0].document_id, opened.document_id);

    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn case_only_rename_uses_the_safe_intermediate_path() {
    let root = owned_root("case");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("CaseName.txt"), b"case content").unwrap();
    let mut service = FileService::default();
    let root_ref = root_reference(&mut service, &root);
    let source = FileRef {
        grant_id: root_ref.grant_id.clone(),
        relative_path: "CaseName.txt".to_owned(),
    };
    let entry = list_entry(&mut service, &root_ref, "CaseName.txt");
    let renamed = service
        .rename_entry(rename_request(
            &source,
            "casename.txt",
            Some(entry.revision),
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap();
    assert_eq!(renamed.entry.name, "casename.txt");
    assert_eq!(
        fs::read(root.join("casename.txt")).unwrap(),
        b"case content"
    );
    assert!(fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".featherpad-rename-")));

    let root_rename = service
        .rename_entry(rename_request(
            &root_ref,
            "not-allowed",
            None,
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap_err();
    assert_eq!(root_rename.code, ErrorCode::InvalidInput);

    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn directory_rename_rebases_each_open_descendant_without_changing_document_id() {
    let root = owned_root("directory-rename");
    let source_directory = root.join("Old folder");
    let child_path = source_directory.join("Child.txt");
    fs::create_dir_all(&source_directory).unwrap();
    fs::write(&child_path, b"child bytes").unwrap();
    // NTFS can finish updating the parent directory's write time shortly after a child write.
    std::thread::sleep(std::time::Duration::from_millis(50));
    let mut service = FileService::default();
    let root_ref = root_reference(&mut service, &root);
    let child_ref = FileRef {
        grant_id: root_ref.grant_id.clone(),
        relative_path: "Old folder/Child.txt".to_owned(),
    };
    let opened = service.open_document(child_ref).unwrap();
    let directory_entry = list_entry(&mut service, &root_ref, "Old folder");
    let directory_entry_again = list_entry(&mut service, &root_ref, "Old folder");
    assert_eq!(directory_entry_again.revision, directory_entry.revision);

    let renamed = service
        .rename_entry(rename_request(
            &directory_entry.reference,
            "New folder",
            Some(directory_entry.revision.clone()),
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap();
    assert_eq!(renamed.entry.kind, "directory");
    assert_eq!(renamed.renamed_documents.len(), 1);
    let mapping = &renamed.renamed_documents[0];
    assert_eq!(mapping.document_id, opened.document_id);
    assert_eq!(mapping.reference.relative_path, "New folder/Child.txt");
    assert_eq!(
        Path::new(&mapping.display_path).file_name(),
        Some(std::ffi::OsStr::new("Child.txt"))
    );
    assert!(!source_directory.exists());
    assert_eq!(
        fs::read(root.join("New folder").join("Child.txt")).unwrap(),
        b"child bytes"
    );
    let reopened = service.open_document(mapping.reference.clone()).unwrap();
    assert_eq!(reopened.document_id, opened.document_id);

    let case_entry = list_entry(&mut service, &root_ref, "New folder");
    let case_renamed = service
        .rename_entry(rename_request(
            &case_entry.reference,
            "new folder",
            Some(case_entry.revision),
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap();
    assert_eq!(case_renamed.renamed_documents.len(), 1);
    assert_eq!(
        case_renamed.renamed_documents[0].document_id,
        opened.document_id
    );
    assert_eq!(
        case_renamed.renamed_documents[0].reference.relative_path,
        "new folder/Child.txt"
    );
    let reopened_after_case = service
        .open_document(case_renamed.renamed_documents[0].reference.clone())
        .unwrap();
    assert_eq!(reopened_after_case.document_id, opened.document_id);
    assert_eq!(
        fs::read(root.join("new folder").join("Child.txt")).unwrap(),
        b"child bytes"
    );

    drop(service);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rename_rejects_a_real_junction_without_moving_the_link_or_target() {
    let root = owned_root("junction-rename");
    let target = root.join("target");
    let junction = root.join("junction");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("inside.txt"), b"target bytes").unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Controlled junction creation failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut service = FileService::default();
    let root_ref = root_reference(&mut service, &root);
    let junction_entry = list_entry(&mut service, &root_ref, "junction");

    let rejected = service
        .rename_entry(rename_request(
            &junction_entry.reference,
            "moved-junction",
            Some(junction_entry.revision),
            uuid::Uuid::new_v4().to_string(),
        ))
        .unwrap_err();
    assert_eq!(rejected.code, ErrorCode::Unsupported);
    assert!(junction.exists());
    assert!(!root.join("moved-junction").exists());
    assert_eq!(
        fs::read(target.join("inside.txt")).unwrap(),
        b"target bytes"
    );

    drop(service);
    fs::remove_dir(&junction).unwrap();
    fs::remove_dir_all(root).unwrap();
}
