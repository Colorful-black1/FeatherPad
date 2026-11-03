#![cfg(windows)]

use base64::{engine::general_purpose::STANDARD, Engine};
use featherpad_lib::{
    models::ErrorCode,
    services::{
        assets::{decode_resource_path, inspect_resource_image, ResourceRequest, MAX_IMAGE_BYTES},
        files::FileService,
        grants::GrantKind,
    },
};
use std::{fs, os::windows::fs::symlink_file, path::PathBuf};

const GIF: &str = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

fn fixture() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.artifacts/T303/resources")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(root.join("文档")).unwrap();
    fs::create_dir_all(root.join("outside")).unwrap();
    root.canonicalize().unwrap()
}

#[test]
fn native_resource_scope_reads_encoded_names_and_rejects_escape_until_directory_is_authorized() {
    let root = fixture();
    let source = root.join("文档/说明.md");
    let image = root.join("文档/图 100%#.gif");
    let outside = root.join("outside/secret.gif");
    let bytes = STANDARD.decode(GIF).unwrap();
    fs::write(&source, "# 文档").unwrap();
    fs::write(&image, &bytes).unwrap();
    fs::write(&outside, &bytes).unwrap();
    let mut files = FileService::default();
    let reference = files
        .grants
        .register_selection(&source, GrantKind::File)
        .unwrap();
    let opened = files.open_document(reference).unwrap();
    let request = |url: &str| ResourceRequest {
        document_id: Some(opened.document_id.clone()),
        directory: None,
        url: url.into(),
        max_bytes: MAX_IMAGE_BYTES,
    };
    let result = files
        .read_preview_resource(request("图%20100%25%23.gif#片段"))
        .unwrap();
    assert_eq!(result.mime, "image/gif");
    assert_eq!(result.width, Some(1));
    assert_eq!(result.height, Some(1));
    assert_eq!(STANDARD.decode(result.data_base64).unwrap(), bytes);
    assert_eq!(
        files
            .read_preview_resource(request("../outside/secret.gif"))
            .err()
            .unwrap()
            .code,
        ErrorCode::OutOfScope
    );
    symlink_file(&outside, root.join("文档/linked.gif")).unwrap();
    assert_eq!(
        files
            .read_preview_resource(request("linked.gif"))
            .err()
            .unwrap()
            .code,
        ErrorCode::OutOfScope
    );
    let directory = files
        .grants
        .register_selection(&root.join("outside"), GrantKind::Directory)
        .unwrap();
    let mut allowed = request("../outside/secret.gif");
    allowed.directory = Some(directory.clone());
    assert_eq!(
        files.read_preview_resource(allowed).unwrap().size_bytes,
        bytes.len() as u64
    );
    assert_eq!(
        files
            .read_preview_resource(ResourceRequest {
                document_id: None,
                directory: Some(directory),
                url: "secret.gif".into(),
                max_bytes: MAX_IMAGE_BYTES
            })
            .unwrap()
            .width,
        Some(1)
    );
    assert_eq!(fs::read(source).unwrap(), "# 文档".as_bytes());
    assert_eq!(fs::read(outside).unwrap(), bytes);
    let linked = files
        .authorize_preview_link(Some(&opened.document_id), None, "图%20100%25%23.gif")
        .unwrap();
    assert_eq!(
        files.grants.open_file(&linked).unwrap().1,
        image.canonicalize().unwrap()
    );
    assert_eq!(
        files
            .authorize_preview_link(Some(&opened.document_id), None, "../outside/secret.gif")
            .err()
            .unwrap()
            .code,
        ErrorCode::OutOfScope
    );
}

#[test]
fn resource_decoding_is_single_layer_and_never_accepts_network_device_or_protocol_paths() {
    for path in [
        "//server/share",
        "\\\\server\\share",
        "%5c%5cserver/share",
        "C:/secret",
        "image.gif:stream",
        "https://example.com/a",
        "image%00.gif",
        "%252e%252e/secret",
        "file:///C:/secret",
    ] {
        assert!(decode_resource_path(path).is_err(), "{path}");
    }
    assert_eq!(
        decode_resource_path("图%20100%25%23.gif#片段").unwrap(),
        PathBuf::from("图 100%#.gif")
    );
}

#[test]
fn image_metadata_budget_and_data_mime_spoofing_are_rejected_before_display() {
    let mut bytes = STANDARD.decode(GIF).unwrap();
    assert_eq!(
        inspect_resource_image(&bytes, 2).err().unwrap().code,
        ErrorCode::TooLarge
    );
    bytes[6..10].copy_from_slice(&[255, 255, 255, 255]);
    assert_eq!(
        inspect_resource_image(&bytes, MAX_IMAGE_BYTES)
            .err()
            .unwrap()
            .code,
        ErrorCode::TooLarge
    );
    let files = FileService::default();
    let data = |header: &str| ResourceRequest {
        document_id: None,
        directory: None,
        url: format!("data:{header};base64,{GIF}"),
        max_bytes: MAX_IMAGE_BYTES,
    };
    assert_eq!(
        files
            .read_preview_resource(data("image/gif"))
            .unwrap()
            .width,
        Some(1)
    );
    assert!(files.read_preview_resource(data("image/png")).is_err());
    assert!(files.read_preview_resource(data("text/html")).is_err());
}
