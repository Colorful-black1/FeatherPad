#![cfg(windows)]

use featherpad_lib::{
    models::{ErrorCode, ListDirectoryRequest},
    services::{files::FileService, grants::GrantKind},
};
use std::{
    fs::{self, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
const FILE_ATTRIBUTE_READONLY: u32 = 0x1;

fn fixture() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T104")
        .join("directories")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    root
}

fn list(
    service: &mut FileService,
    reference: &featherpad_lib::models::FileRef,
    cursor: Option<&str>,
    limit: u32,
    show_hidden: bool,
) -> Result<featherpad_lib::models::DirectoryPage, featherpad_lib::models::AppError> {
    service.list_directory(ListDirectoryRequest {
        reference: reference.clone(),
        cursor: cursor.map(str::to_owned),
        limit: Some(limit),
        show_hidden,
    })
}

fn create_file(path: &Path, attributes: u32) {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .attributes(attributes)
        .open(path)
        .unwrap();
}

#[test]
fn lists_only_one_level_with_folders_first_natural_sort_hidden_filter_and_cursor_pages() {
    let root = fixture();
    for directory in ["folder10", "Folder2", "alpha"] {
        fs::create_dir(root.join(directory)).unwrap();
    }
    for file in ["file10.txt", "File2.txt", "alpha.txt"] {
        fs::write(root.join(file), file).unwrap();
    }
    create_file(&root.join("hidden.txt"), FILE_ATTRIBUTE_HIDDEN);
    create_file(&root.join("readonly.txt"), FILE_ATTRIBUTE_READONLY);
    fs::write(root.join("Folder2/nested.txt"), "not in the first layer").unwrap();

    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&root, GrantKind::Directory)
        .unwrap();
    let reopened = service
        .grants
        .register_selection(&root, GrantKind::Directory)
        .unwrap();
    assert_eq!(reopened.grant_id, reference.grant_id);
    assert_eq!(
        service.grants.root_display_name(&reference),
        root.file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
    );

    let first = list(&mut service, &reference, None, 3, false).unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["alpha", "Folder2", "folder10"]
    );
    assert!(first.items.iter().all(|entry| entry.kind == "directory"));
    assert!(first.next_cursor.is_some());

    let second = list(
        &mut service,
        &reference,
        first.next_cursor.as_deref(),
        20,
        false,
    )
    .unwrap();
    assert_eq!(
        second
            .items
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["alpha.txt", "File2.txt", "file10.txt", "readonly.txt"]
    );
    assert!(second.next_cursor.is_none());
    assert!(second
        .items
        .iter()
        .all(|entry| { entry.name != "hidden.txt" && entry.name != "nested.txt" }));
    assert!(
        second
            .items
            .iter()
            .find(|entry| entry.name == "readonly.txt")
            .unwrap()
            .is_read_only
    );

    let with_hidden = list(&mut service, &reference, None, 20, true).unwrap();
    assert!(with_hidden
        .items
        .iter()
        .any(|entry| entry.name == "hidden.txt" && entry.is_hidden));
}

#[test]
fn cursor_is_bound_to_filter_directory_revision_and_authorized_root() {
    let root = fixture();
    fs::write(root.join("one.txt"), "one").unwrap();
    fs::write(root.join("two.txt"), "two").unwrap();
    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&root, GrantKind::Directory)
        .unwrap();

    let first = list(&mut service, &reference, None, 1, false).unwrap();
    let cursor = first.next_cursor.unwrap();
    assert_eq!(
        list(&mut service, &reference, Some(&cursor), 1, true)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    fs::write(root.join("three.txt"), "three").unwrap();
    assert_eq!(
        list(&mut service, &reference, Some(&cursor), 1, false)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(
        list(&mut service, &reference, Some("not-a-cursor"), 1, false)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn rejects_file_and_escaping_grants_plus_empty_and_invalid_limits() {
    let root = fixture();
    let empty = root.join("empty");
    let file = root.join("single.txt");
    fs::create_dir(&empty).unwrap();
    fs::write(&file, "single").unwrap();
    let mut service = FileService::default();
    let empty_reference = service
        .grants
        .register_selection(&empty, GrantKind::Directory)
        .unwrap();
    let page = list(&mut service, &empty_reference, None, 200, false).unwrap();
    assert!(page.items.is_empty());
    assert!(page.next_cursor.is_none());
    assert_eq!(
        list(&mut service, &empty_reference, None, 0, false)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        list(&mut service, &empty_reference, None, 1001, false)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );

    let mut escaped = empty_reference.clone();
    escaped.relative_path = "../single.txt".into();
    assert_eq!(
        list(&mut service, &escaped, None, 200, false)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    let file_reference = service
        .grants
        .register_selection(&file, GrantKind::File)
        .unwrap();
    assert_eq!(
        list(&mut service, &file_reference, None, 200, false)
            .unwrap_err()
            .code,
        ErrorCode::OutOfScope
    );
}

#[test]
fn directory_guard_rejects_a_junction_that_resolves_to_another_path() {
    let root = fixture();
    let actual = root.join("actual");
    let alias = root.join("alias");
    fs::create_dir(&actual).unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&alias)
        .arg(&actual)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Controlled junction creation failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let error = featherpad_lib::services::windows_file::lock_directory(&alias).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
}
