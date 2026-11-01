#![cfg(windows)]
use featherpad_lib::{models::ErrorCode, services::grants::GrantRegistry};
use std::{fs, path::PathBuf};

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
