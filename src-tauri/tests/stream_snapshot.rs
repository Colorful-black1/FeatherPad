#![cfg(windows)]
use featherpad_lib::{
    models::ErrorCode,
    services::{
        snapshot::read_snapshot,
        stream_snapshot::{read_stream_snapshot, MAX_WINDOW_BYTES},
    },
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
};

fn fixture(bytes: &[u8]) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T103/stream")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let path = root.join("流式 中文😀.txt");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    path
}

#[test]
fn streaming_revision_matches_existing_snapshot_for_bom_utf16_and_empty_files() {
    for bytes in [
        vec![],
        "中文😀\r\nline".as_bytes().to_vec(),
        vec![0xef, 0xbb, 0xbf, b'x'],
        vec![0xff, 0xfe, 0x2d, 0x4e, 0x3d, 0xd8, 0, 0xde],
    ] {
        let path = fixture(&bytes);
        let original = read_snapshot(File::open(&path).unwrap(), 1024).unwrap();
        let streamed = read_stream_snapshot(
            File::open(&path).unwrap(),
            1024,
            0..bytes.len().min(5) as u64,
        )
        .unwrap();
        assert_eq!(
            streamed.metadata.disk_revision,
            original.metadata.disk_revision
        );
        assert_eq!(streamed.metadata.size_bytes, original.metadata.size_bytes);
        assert_eq!(
            streamed.metadata.display_path,
            original.metadata.display_path
        );
        assert_eq!(streamed.path, original.path);
        assert_eq!(streamed.identity, original.identity);
        assert_eq!(streamed.prefix, bytes[..bytes.len().min(4)]);
        assert_eq!(streamed.window, bytes[..bytes.len().min(5)]);
    }
}

#[test]
fn twenty_mib_full_revision_is_identical_while_only_a_small_window_is_retained() {
    let bytes = vec![b'x'; 20 * 1024 * 1024];
    let path = fixture(&bytes);
    let original = read_snapshot(File::open(&path).unwrap(), bytes.len() as u64).unwrap();
    let streamed =
        read_stream_snapshot(File::open(&path).unwrap(), bytes.len() as u64, 123..144).unwrap();
    assert_eq!(
        streamed.metadata.disk_revision,
        original.metadata.disk_revision
    );
    assert_eq!(streamed.window_start, 123);
    assert_eq!(streamed.window, bytes[123..144]);
    assert_eq!(streamed.prefix.len(), 4);
    assert!(streamed.window.len() < 1024);
}

#[test]
fn hundred_mib_metadata_scan_retains_no_body_and_late_windows_are_exact() {
    let path = fixture(b"header");
    let size = 100 * 1024 * 1024;
    let tail = "尾部😀".as_bytes();
    let mut file = OpenOptions::new().write(true).open(&path).unwrap();
    let body = [b'x'; 64 * 1024];
    for _ in 0..(size / body.len() as u64) {
        file.write_all(&body).unwrap();
    }
    file.seek(SeekFrom::Start(size - tail.len() as u64))
        .unwrap();
    file.write_all(tail).unwrap();
    file.sync_all().unwrap();
    drop(file);
    let metadata = read_stream_snapshot(File::open(&path).unwrap(), size, 0..0).unwrap();
    assert_eq!(metadata.metadata.size_bytes, size);
    assert!(metadata.window.is_empty());
    let last = read_stream_snapshot(
        File::open(&path).unwrap(),
        size,
        (size - tail.len() as u64)..size,
    )
    .unwrap();
    assert_eq!(last.window, tail);
    assert_eq!(last.metadata.disk_revision, metadata.metadata.disk_revision);
}

#[test]
fn changes_outside_the_window_change_revision_even_if_size_and_mtime_are_restored() {
    let path = fixture(b"visible window and unseen tail");
    let before = fs::metadata(&path).unwrap();
    let first = read_stream_snapshot(File::open(&path).unwrap(), 1024, 0..7).unwrap();
    let mut changed = fs::read(&path).unwrap();
    *changed.last_mut().unwrap() = b'X';
    fs::write(&path, changed).unwrap();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(before.modified().unwrap()))
        .unwrap();
    let after = read_stream_snapshot(File::open(&path).unwrap(), 1024, 0..7).unwrap();
    assert_eq!(after.window, first.window);
    assert_eq!(after.metadata.modified_at, first.metadata.modified_at);
    assert_eq!(after.metadata.size_bytes, first.metadata.size_bytes);
    assert_ne!(after.metadata.disk_revision, first.metadata.disk_revision);
}

#[test]
#[allow(clippy::reversed_empty_ranges)]
fn invalid_windows_and_over_limit_files_are_rejected_without_partial_success() {
    let path = fixture(b"small");
    for range in [4..2, 0..(MAX_WINDOW_BYTES + 1), 6..6] {
        assert_eq!(
            read_stream_snapshot(File::open(&path).unwrap(), 1024, range)
                .err()
                .unwrap()
                .code,
            ErrorCode::InvalidInput
        );
    }
    assert_eq!(
        read_stream_snapshot(File::open(&path).unwrap(), 4, 0..0)
            .err()
            .unwrap()
            .code,
        ErrorCode::TooLarge
    );
    let eof = read_stream_snapshot(File::open(&path).unwrap(), 5, 5..8).unwrap();
    assert!(eof.window.is_empty());
    assert_eq!(eof.window_start, 5);
}
