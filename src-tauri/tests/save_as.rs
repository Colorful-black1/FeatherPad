#![cfg(windows)]
use featherpad_lib::{models::ErrorCode, services::grants::GrantRegistry};
use featherpad_lib::{
    models::{SaveAsRequest, SaveIntent, TextFormat},
    services::{create_file::PreparedCreation, files::FileService},
};
use std::{fs, path::PathBuf};

fn request(intent: SaveIntent) -> SaveAsRequest {
    SaveAsRequest {
        document_id: uuid::Uuid::new_v4().to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 3,
        text: "新正文😀\n末行".into(),
        format: TextFormat {
            encoding: "utf-8".into(),
            bom: "none".into(),
            line_ending: "crlf".into(),
        },
        newline_map: None,
        intent,
    }
}

fn root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T102/save-as")
        .join(uuid::Uuid::new_v4().to_string());
    assert!(root.is_absolute());
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn native_new_destination_authorization_does_not_create_or_overwrite_any_file() {
    let root = root();
    let grants = GrantRegistry::default();
    for name in ["新建 中文😀.txt", ".env", "COM10.txt"] {
        let path = root.join(name);
        let target = grants.authorize_new_target(&path).unwrap();
        assert_eq!(
            target.path().parent().unwrap(),
            root.canonicalize().unwrap()
        );
        assert!(!path.exists());
    }
    let path = root.join("existing.txt");
    fs::write(&path, b"original").unwrap();
    assert_eq!(
        grants.authorize_new_target(&path).err().unwrap().code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(path).unwrap(), b"original");
}

#[test]
fn rejects_reserved_devices_ads_ambiguous_names_and_relative_destinations() {
    let root = root();
    let grants = GrantRegistry::default();
    for name in [
        "CON",
        "nul.txt",
        "COM1.tar.gz",
        "LPT9.txt",
        "COM¹.txt",
        "LPT²",
        "CONOUT$",
        "name.",
        "name ",
        "file:stream",
        "a?b.txt",
        "a\0b",
    ] {
        assert_eq!(
            grants
                .authorize_new_target(&root.join(name))
                .err()
                .unwrap()
                .code,
            ErrorCode::InvalidInput,
            "{name:?}"
        );
    }
    assert_eq!(
        grants
            .authorize_new_target(&PathBuf::from("relative.txt"))
            .err()
            .unwrap()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}

#[test]
fn creation_commits_complete_bytes_before_binding_the_original_buffer_id() {
    let root = root();
    let mut service = FileService::default();
    let path = root.join("首次保存 中文😀.txt");
    let snapshot = request(SaveIntent::SaveAs);
    let id = snapshot.document_id.clone();
    let target = service.grants.authorize_new_target(&path).unwrap();
    let prepared = PreparedCreation::prepare(snapshot, target, &root.join("journal")).unwrap();
    assert!(!path.exists());
    assert_eq!(
        service.stat_document(&id).unwrap_err().code,
        ErrorCode::NotFound
    );
    let result = prepared.commit(&mut service).unwrap();
    assert_eq!(fs::read(&path).unwrap(), "新正文😀\r\n末行".as_bytes());
    assert_eq!(
        service.open_document(result.reference).unwrap().document_id,
        id
    );
    assert_eq!(result.document_id, id);
    assert_eq!(result.ack.document_version, 3);
    assert_eq!(result.ack.disk_revision, result.metadata.disk_revision);
}

#[test]
fn a_destination_appearing_after_prepare_is_not_overwritten_or_bound() {
    let root = root();
    let mut service = FileService::default();
    let path = root.join("collision.txt");
    let snapshot = request(SaveIntent::SaveAs);
    let id = snapshot.document_id.clone();
    let target = service.grants.authorize_new_target(&path).unwrap();
    let prepared = PreparedCreation::prepare(snapshot, target, &root.join("journal")).unwrap();
    fs::write(&path, b"external appeared").unwrap();
    assert_eq!(
        prepared.commit(&mut service).unwrap_err().code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(path).unwrap(), b"external appeared");
    assert_eq!(
        service.stat_document(&id).unwrap_err().code,
        ErrorCode::NotFound
    );
}

#[test]
fn creating_a_copy_does_not_attach_a_destination_to_the_source_buffer() {
    let root = root();
    let mut service = FileService::default();
    let path = root.join("copy.txt");
    let snapshot = request(SaveIntent::Copy);
    let id = snapshot.document_id.clone();
    let target = service.grants.authorize_new_target(&path).unwrap();
    let result = PreparedCreation::prepare(snapshot, target, &root.join("journal"))
        .unwrap()
        .commit(&mut service)
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), "新正文😀\r\n末行".as_bytes());
    assert_eq!(
        service.stat_document(&id).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_ne!(
        service.open_document(result.reference).unwrap().document_id,
        id
    );
}

#[test]
fn save_as_wire_does_not_accept_an_ipc_target_path_or_unknown_intent() {
    let mut value = serde_json::to_value(request(SaveIntent::SaveAs)).unwrap();
    value["path"] = serde_json::json!("ungranted.txt");
    assert!(serde_json::from_value::<SaveAsRequest>(value).is_err());
    let mut value = serde_json::to_value(request(SaveIntent::SaveAs)).unwrap();
    value["intent"] = serde_json::json!("overwrite-without-confirmation");
    assert!(serde_json::from_value::<SaveAsRequest>(value).is_err());
}

#[test]
fn kernel_move_without_replace_flag_preserves_an_existing_destination() {
    use featherpad_lib::services::windows_file::create_from_temporary;
    let root = root();
    let temporary = root.join("owned temporary.tmp");
    let destination = root.join("existing destination.txt");
    fs::write(&temporary, b"new body").unwrap();
    fs::write(&destination, b"external body").unwrap();
    assert!(temporary.is_absolute() && temporary.starts_with(&root));
    assert!(destination.is_absolute() && destination.starts_with(&root));
    assert_eq!(
        create_from_temporary(&temporary, &destination)
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(&destination).unwrap(), b"external body");
    assert_eq!(fs::read(&temporary).unwrap(), b"new body");
}
