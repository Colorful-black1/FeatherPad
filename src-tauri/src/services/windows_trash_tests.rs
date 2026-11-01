use super::*;

fn fixture(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T105")
        .join(format!("trash-{label}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn revision(path: &Path) -> String {
    let metadata = fs::symlink_metadata(path).unwrap();
    revision_from_metadata(
        path.file_name().unwrap().to_str().unwrap(),
        if metadata.is_dir() {
            "directory"
        } else {
            "file"
        },
        &metadata,
    )
    .unwrap()
}

fn restore_owned_fixture(receipt: &RecycleReceipt, original: &Path) {
    assert!(!original.exists());
    assert!(receipt
        .recycled_path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("$R"));
    let _com = Apartment::new().unwrap();
    let item = shell_item(&receipt.recycled_path).unwrap();
    let parent = shell_item(original.parent().unwrap()).unwrap();
    let name: Vec<u16> = original
        .file_name()
        .unwrap()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: only the exact recycled item returned by this fixture operation is moved back.
    // No replacement/copy-across-volume flags; collisions must fail without overwriting.
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER).unwrap();
        operation
            .SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOFX_EARLYFAILURE)
            .unwrap();
        operation
            .MoveItem(&item, &parent, PCWSTR(name.as_ptr()), None)
            .unwrap();
        operation.PerformOperations().unwrap();
        assert!(!operation.GetAnyOperationsAborted().unwrap().as_bool());
    }
    assert!(original.exists());
    assert!(!receipt.recycled_path.exists());
}

#[test]
fn actual_shell_recycling_returns_a_bin_item_with_the_original_bytes() {
    let root = fixture("file");
    let source = root.join("回收 中文😀.txt");
    fs::write(&source, "受控回收正文😀").unwrap();
    let receipt = super::super::recycle(&source, &revision(&source)).unwrap();
    assert!(!source.exists());
    assert_eq!(
        fs::read_to_string(&receipt.recycled_path).unwrap(),
        "受控回收正文😀"
    );
    restore_owned_fixture(&receipt, &source);
    assert_eq!(fs::read_to_string(&source).unwrap(), "受控回收正文😀");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn actual_shell_recycles_a_nonempty_directory_and_can_restore_it() {
    let root = fixture("directory");
    let source = root.join("有内容目录");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("child.txt"), b"kept child").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    let receipt = super::super::recycle(&source, &revision(&source)).unwrap();
    assert!(!source.exists());
    assert_eq!(
        fs::read(receipt.recycled_path.join("child.txt")).unwrap(),
        b"kept child"
    );
    restore_owned_fixture(&receipt, &source);
    assert_eq!(fs::read(source.join("child.txt")).unwrap(), b"kept child");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn actual_permanent_delete_proposal_is_vetoed_before_source_mutation() {
    let root = fixture("permanent-veto");
    let source = root.join("must-survive.txt");
    fs::write(&source, b"permanent deletion is forbidden").unwrap();
    let _com = Apartment::new().unwrap();
    // Deliberately omit both recycling flags to exercise a real Shell permanent-delete proposal.
    // This private path is only reachable in this Rust unit test, never through IPC.
    let error = perform(
        &source,
        &revision(&source),
        None,
        FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOFX_EARLYFAILURE,
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::TrashUnavailable);
    assert!(
        error.message.contains("已拒绝永久删除"),
        "must reach the actual Shell pre-delete veto"
    );
    assert_eq!(
        fs::read(&source).unwrap(),
        b"permanent deletion is forbidden"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn shell_sharing_failure_leaves_the_source_intact() {
    let root = fixture("sharing");
    let source = root.join("locked.txt");
    fs::write(&source, b"locked original bytes").unwrap();
    let guard = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&source)
        .unwrap();
    let error = super::super::recycle(&source, &revision(&source)).unwrap_err();
    assert_eq!(error.code, ErrorCode::TrashUnavailable);
    assert_eq!(fs::read(&source).unwrap(), b"locked original bytes");
    drop(guard);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_missing_and_link_targets_are_rejected_without_deleting_any_bytes() {
    let root = fixture("rejection");
    let source = root.join("source.txt");
    fs::write(&source, b"source stays").unwrap();
    let error = super::super::recycle(&source, &"0".repeat(64)).unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(fs::read(&source).unwrap(), b"source stays");
    let error = super::super::recycle(&root.join("missing.txt"), &"0".repeat(64)).unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    let target = root.join("target");
    let link = root.join("junction");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("kept.txt"), b"link target stays").unwrap();
    let result = std::process::Command::new("cmd.exe")
        .args(["/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "junction setup: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let error = super::super::recycle(&link, &revision(&target)).unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert_eq!(
        fs::read(target.join("kept.txt")).unwrap(),
        b"link target stays"
    );
    fs::remove_dir(&link).unwrap();
    fs::remove_dir_all(root).unwrap();
}
