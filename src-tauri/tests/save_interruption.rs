#![cfg(windows)]

use featherpad_lib::{
    models::SaveRequest,
    services::{
        files::FileService,
        grants::GrantKind,
        save::{HardLinkPolicy, PreparedSave},
        save_journal::{digest, SaveManifest},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{fs::MetadataExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const WORKER_ENV: &str = "FEATHERPAD_SAVE_INTERRUPTION_WORKER";
const BEFORE: &str = "before-replace";
const AFTER: &str = "after-commit";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerConfig {
    root: PathBuf,
    nonce: String,
    test: String,
    phase: String,
}

// This owns only the process handle returned by spawn, never a process-name/PID lookup.
struct OwnedWorker(Child);
impl Drop for OwnedWorker {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn controlled_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T102/interruptions")
}

fn validate_fixture_parent() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    for ancestor in controlled_root().ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            assert_eq!(
                metadata.file_attributes() & 0x400,
                0,
                "Fixture ancestry cannot redirect outside the project"
            );
        }
        if ancestor == project {
            return;
        }
    }
    panic!("Fixture root is not inside this project");
}

fn validate(config: &WorkerConfig) {
    validate_fixture_parent();
    assert!(config.root.is_absolute());
    assert!(uuid::Uuid::parse_str(&config.nonce).is_ok());
    let allowed = controlled_root().canonicalize().unwrap();
    let actual = config.root.canonicalize().unwrap();
    assert_eq!(actual.parent(), Some(allowed.as_path()));
    assert_eq!(actual.file_name().unwrap(), config.nonce.as_str());
    let mut ancestor = actual.as_path();
    loop {
        assert_eq!(
            fs::symlink_metadata(ancestor).unwrap().file_attributes() & 0x400,
            0,
            "Reparse fixture is not allowed"
        );
        if ancestor == allowed {
            break;
        }
        ancestor = ancestor.parent().unwrap();
    }
    assert!(config.phase == BEFORE || config.phase == AFTER);
}

fn original(nonce: &str) -> String {
    format!("original\r\n中文😀 {nonce}")
}
fn saved(nonce: &str) -> String {
    format!("saved\r\n中文😀 {nonce}")
}

fn write_new(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
}

fn worker(config: &WorkerConfig) {
    validate(config);
    let source = config.root.join("source.txt");
    assert_eq!(
        fs::symlink_metadata(&source).unwrap().file_attributes() & 0x400,
        0
    );
    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&source, GrantKind::File)
        .unwrap();
    let opened = service.open_document(reference).unwrap();
    assert_eq!(
        opened.content.text,
        original(&config.nonce).replace("\r\n", "\n")
    );
    let request = SaveRequest {
        document_id: opened.document_id,
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 1,
        expected_disk_revision: opened.metadata.disk_revision,
        text: saved(&config.nonce).replace("\r\n", "\n"),
        format: opened.format,
        newline_map: None,
    };
    let prepared = PreparedSave::prepare(
        &service,
        request,
        &config.root.join("state"),
        HardLinkPolicy::RequireConfirmation,
    )
    .unwrap();
    let pending = if config.phase == AFTER {
        prepared.commit(&mut service).unwrap();
        None
    } else {
        Some(prepared)
    };
    write_new(
        &config.root.join("ready.json"),
        &serde_json::to_vec(&serde_json::json!({
            "pid": std::process::id(), "nonce": config.nonce, "phase": config.phase,
        }))
        .unwrap(),
    );
    // A private pipe barrier exists only in this integration-test executable, never product code.
    let mut command = [0u8];
    std::io::stdin().read_exact(&mut command).unwrap();
    assert_eq!(command, [b'C']);
    if let Some(prepared) = pending {
        prepared.commit(&mut service).unwrap();
    }
}

fn wait_for_ready(worker: &mut OwnedWorker, config: &WorkerConfig) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(bytes) = fs::read(config.root.join("ready.json")) {
            if let Ok(ready) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                assert_eq!(ready["pid"], worker.0.id());
                assert_eq!(ready["nonce"], config.nonce);
                assert_eq!(ready["phase"], config.phase);
                return;
            }
        }
        assert!(
            worker.0.try_wait().unwrap().is_none(),
            "Worker exited before the actual save barrier; see its controlled worker.log"
        );
        assert!(
            Instant::now() < deadline,
            "Save worker did not reach its barrier"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_exit(worker: &mut OwnedWorker) -> ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = worker.0.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "Owned worker did not exit");
        thread::sleep(Duration::from_millis(10));
    }
}

fn scenario(test: &str, phase: &str, terminate: bool) {
    if let Ok(raw) = std::env::var(WORKER_ENV) {
        let config: WorkerConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(config.test, test);
        assert_eq!(config.phase, phase);
        worker(&config);
        return;
    }
    let nonce = uuid::Uuid::new_v4().to_string();
    let root = controlled_root().join(&nonce);
    validate_fixture_parent();
    fs::create_dir_all(&root).unwrap();
    let config = WorkerConfig {
        root: root.canonicalize().unwrap(),
        nonce,
        test: test.into(),
        phase: phase.into(),
    };
    validate(&config);
    write_new(
        &config.root.join("source.txt"),
        original(&config.nonce).as_bytes(),
    );
    let log = File::options()
        .write(true)
        .create_new(true)
        .open(config.root.join("worker.log"))
        .unwrap();
    let mut process = OwnedWorker(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture", "--test-threads=1"])
            .env(WORKER_ENV, serde_json::to_string(&config).unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .creation_flags(0x08000000) // CREATE_NO_WINDOW; a test worker has no interactive UI.
            .spawn()
            .unwrap(),
    );
    wait_for_ready(&mut process, &config);
    assert!(process.0.try_wait().unwrap().is_none());
    if terminate {
        process.0.kill().unwrap();
    } else {
        process.0.stdin.as_mut().unwrap().write_all(b"C").unwrap();
    }
    let status = wait_for_exit(&mut process);
    assert_eq!(status.success(), !terminate);

    let before_replace = terminate && phase == BEFORE;
    let expected = if before_replace {
        original(&config.nonce)
    } else {
        saved(&config.nonce)
    };
    assert_eq!(
        fs::read(config.root.join("source.txt")).unwrap(),
        expected.as_bytes()
    );
    let entries = fs::read_dir(config.root.join("state"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(entries.len(), 1);
    let receipt = entries[0].path();
    let manifest: SaveManifest =
        serde_json::from_slice(&fs::read(receipt.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest.target, config.root.join("source.txt"));
    assert_eq!(manifest.temporary.parent(), Some(config.root.as_path()));
    let body = fs::read(receipt.join("body.bin")).unwrap();
    let backup = fs::read(receipt.join("original.bin")).unwrap();
    assert_eq!(body, saved(&config.nonce).as_bytes());
    assert_eq!(backup, original(&config.nonce).as_bytes());
    assert_eq!(digest(&body), manifest.body_sha256);
    assert_eq!(digest(&backup), manifest.original_sha256);
    assert!(receipt.join("temporary-ready.json").is_file());
    assert_eq!(receipt.join("replacing.json").is_file(), !before_replace);
    assert_eq!(receipt.join("committed.json").is_file(), !before_replace);
    if before_replace {
        assert_eq!(fs::read(&manifest.temporary).unwrap(), body);
    } else {
        assert!(!manifest.temporary.exists());
    }

    // A fresh native service reads the actual post-termination disk, without auto-restoring it.
    let mut reopened = FileService::default();
    let reference = reopened
        .grants
        .register_selection(&config.root.join("source.txt"), GrantKind::File)
        .unwrap();
    assert_eq!(
        reopened.open_document(reference).unwrap().content.text,
        expected.replace("\r\n", "\n")
    );
    write_new(&config.root.join("result.json"), &serde_json::to_vec_pretty(&serde_json::json!({
        "scope": "Windows native save core process termination; not Tauri UI/session recovery or power loss",
        "test": test, "phase": phase, "terminated": terminate, "workerExitCode": status.code(),
        "sourceSha256": digest(expected.as_bytes()), "bodySha256": manifest.body_sha256,
        "originalSha256": manifest.original_sha256, "committed": !before_replace,
        "checkedAt": chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).to_rfc3339(),
    })).unwrap());
}

#[test]
fn kill_before_replace_keeps_original_and_durable_candidates() {
    scenario(
        "kill_before_replace_keeps_original_and_durable_candidates",
        BEFORE,
        true,
    );
}

#[test]
fn kill_after_commit_keeps_verified_new_bytes_and_receipt() {
    scenario(
        "kill_after_commit_keeps_verified_new_bytes_and_receipt",
        AFTER,
        true,
    );
}

#[test]
fn unblocked_worker_commits_as_a_positive_control_for_the_kill_barrier() {
    scenario(
        "unblocked_worker_commits_as_a_positive_control_for_the_kill_barrier",
        BEFORE,
        false,
    );
}
