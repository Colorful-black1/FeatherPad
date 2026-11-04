#![cfg(windows)]

use featherpad_lib::services::{export_target::ExportTarget, files::FileService};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[test]
#[ignore = "requires an explicitly prepared, owned full WSL tmpfs"]
fn pdf_byte_export_to_full_backing_filesystem_keeps_the_original_and_failure_receipt() {
    let root =
        std::env::var("FEATHERPAD_EXPORT_FAULT_ROOT").expect("explicit fault volume required");
    let prefix = r"\\wsl.localhost\Ubuntu\mnt\featherpad-fault-";
    assert!(root.starts_with(prefix));
    let suffix = &root[prefix.len()..];
    assert_eq!(suffix.len(), 32);
    assert!(suffix.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let root = PathBuf::from(root);
    let token = std::env::var("FEATHERPAD_EXPORT_FAULT_TOKEN").unwrap();
    assert!(uuid::Uuid::parse_str(&token).is_ok());
    let fixture_token = root.join("fixture.token");
    let fixture_value = fs::read_to_string(&fixture_token).unwrap_or_else(|error| {
        panic!(
            "fault fixture token must be readable at {}: {error}",
            fixture_token.display()
        )
    });
    assert_eq!(fixture_value, token);
    let original = root.join("original.pdf");
    assert_eq!(
        fs::read(&original)
            .unwrap_or_else(|error| panic!("fault fixture source must be readable: {error}")),
        b"controlled-original-pdf"
    );
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.artifacts/T311/export-faults")
        .join(&token);
    fs::create_dir_all(&evidence).unwrap();
    let evidence = evidence.canonicalize().unwrap();
    let mut service = FileService::default();
    let target = ExportTarget::capture(&mut service, &original).unwrap();
    let error = target
        .commit(
            &mut service,
            &vec![b'P'; 2 * 1024 * 1024],
            &evidence.join("journal"),
        )
        .err()
        .expect("a truly full volume must refuse staging");
    let after = fs::read(&original).unwrap();
    eprintln!("controlled export fault result: {error:?}");
    assert_eq!(after, b"controlled-original-pdf");
    assert!(fs::read_dir(evidence.join("journal"))
        .unwrap()
        .next()
        .is_some());
    let side_files: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".featherpad-export-")
        })
        .collect();
    assert!(!side_files.is_empty());
    assert!(side_files
        .iter()
        .all(|path| fs::metadata(path).unwrap().len() < 2 * 1024 * 1024));
    fs::write(evidence.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "realBackingFilesystemFull": true, "releaseService": !cfg!(debug_assertions),
        "sourceSha256": format!("{:x}",Sha256::digest(&after)), "sourceBytesUnchanged": true,
        "failedTransactionPreserved": true, "partialSideFiles":side_files.len(), "error":error,
        "boundary":"Windows WSL 9P can map ENOSPC to ERROR_GEN_FAILURE; this is not NTFS error-code proof"
    })).unwrap()).unwrap();
}
