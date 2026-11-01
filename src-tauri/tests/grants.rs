#![cfg(windows)]

use featherpad_lib::models::{ErrorCode, FileRef};
use featherpad_lib::services::grants::{GrantKind, GrantRegistry};
use std::{fs, io::Read, path::PathBuf, process::Command};

fn fixture() -> (PathBuf, PathBuf) {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T003")
        .join("fixtures")
        .join(uuid::Uuid::new_v4().to_string());
    let root = base.join("authorized");
    let outside = base.join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(root.join("中文 fixture.txt"), "受控测试\r\nFeatherPad").unwrap();
    fs::write(outside.join("secret.txt"), "controlled outside fixture").unwrap();
    (root, outside)
}

#[test]
fn reads_native_utf8_file_only_with_issued_grant() {
    let (root, _) = fixture();
    let mut registry = GrantRegistry::default();
    let reference = registry
        .register_selection(&root.join("中文 fixture.txt"), GrantKind::File)
        .unwrap();
    let (mut file, _) = registry.open_file(&reference).unwrap();
    let mut text = String::new();
    file.read_to_string(&mut text).unwrap();
    assert_eq!(text, "受控测试\r\nFeatherPad");
    let sibling = FileRef {
        relative_path: "secret.txt".into(),
        ..reference
    };
    assert_eq!(
        registry.open_file(&sibling).unwrap_err().code,
        ErrorCode::OutOfScope
    );
}

#[test]
fn rejects_forged_grants_and_escape_syntax_before_reading() {
    let (root, _) = fixture();
    let mut registry = GrantRegistry::default();
    let reference = registry
        .register_selection(&root, GrantKind::Directory)
        .unwrap();
    for path in [
        "../outside/secret.txt",
        "..\\outside\\secret.txt",
        "C:\\Windows\\win.ini",
        "/Windows/win.ini",
        "a:stream",
        "a\0b",
        "file.",
        "file ",
    ] {
        let invalid = FileRef {
            relative_path: path.into(),
            ..reference.clone()
        };
        assert_eq!(
            registry.open_file(&invalid).unwrap_err().code,
            ErrorCode::InvalidInput,
            "{path:?}"
        );
    }
    let unknown = FileRef {
        grant_id: "forged-grant".into(),
        relative_path: "secret.txt".into(),
    };
    assert_eq!(
        registry.open_file(&unknown).unwrap_err().code,
        ErrorCode::OutOfScope
    );
}

#[test]
fn directory_grant_rejects_real_junction_escape() {
    let (root, outside) = fixture();
    let output = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(root.join("escape"))
        .arg(outside)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Fixture junction creation failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut registry = GrantRegistry::default();
    let mut reference = registry
        .register_selection(&root, GrantKind::Directory)
        .unwrap();
    reference.relative_path = "escape/secret.txt".into();
    assert_eq!(
        registry.open_file(&reference).unwrap_err().code,
        ErrorCode::OutOfScope
    );
    reference.relative_path = "中文 fixture.txt".into();
    assert!(registry.open_file(&reference).is_ok());
}
