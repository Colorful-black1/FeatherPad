use super::{
    recovery::{read_bounded, reject_reparse_chain, RecoveryStore},
    save::MAX_FILE_BYTES,
    save_journal::{digest, SaveManifest},
    storage_budget::StorageBudget,
    text::normalize_newlines,
    windows_file,
};
use crate::models::{
    io_error, AppError, ErrorCode, LoadedSaveTransaction, NewlineMap, SaveRequest,
    SaveTransactionCandidate,
};
use serde::Deserialize;
use std::{collections::HashSet, fs, path::Path};

const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 100_000;
const STAGE_FILES: [(&str, u8); 5] = [
    ("staged.json", 1),
    ("temporary-ready.json", 2),
    ("replacing.json", 3),
    ("committed.json", 4),
    ("cleanup-pending.json", 5),
];

#[derive(Debug, Default)]
pub struct SaveTransactionScan {
    pub warnings: Vec<String>,
    pub bytes: u64,
    pub candidates: Vec<SaveTransactionCandidate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageRecord {
    receipt_id: String,
    stage: String,
}

struct EntryScan {
    warnings: Vec<String>,
    candidate: Option<SaveTransactionCandidate>,
}

pub fn scan_save_transactions(
    root: &Path,
    recovery: &RecoveryStore,
) -> Result<SaveTransactionScan, AppError> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SaveTransactionScan::default())
        }
        Err(error) => return Err(io_error(error)),
        Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
        Ok(_) => {}
    }
    reject_reparse_chain(root)?;
    let canonical = root.canonicalize().map_err(io_error)?;
    let _root_lock = windows_file::lock_directory(&canonical)?;
    let mut scan = SaveTransactionScan::default();
    for (index, entry) in fs::read_dir(&canonical).map_err(io_error)?.enumerate() {
        if index >= MAX_SCAN_ENTRIES {
            return Err(invalid());
        }
        let entry = entry.map_err(io_error)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            scan.warnings
                .push("保存事务目录包含无效名称，已保留且未自动清理。".into());
            continue;
        };
        scan.bytes = scan.bytes.saturating_add(entry_bytes(&entry.path())?);
        if !canonical_uuid(&name) || !entry.file_type().map_err(io_error)?.is_dir() {
            scan.warnings.push(format!(
                "保存事务目录项“{}”无法识别，已保留且未自动清理。",
                safe_id(&name)
            ));
            continue;
        }
        match inspect_entry(&entry.path(), &name, recovery) {
            Ok(inspected) => {
                scan.warnings.extend(inspected.warnings);
                if let Some(candidate) = inspected.candidate {
                    scan.candidates.push(candidate);
                }
            }
            Err(error) => scan.warnings.push(format!(
                "保存事务“{}”无法完整核对：{} 已保留全部证据。",
                name, error.message
            )),
        }
    }
    scan.warnings.sort();
    scan.warnings.dedup();
    Ok(scan)
}

fn inspect_entry(
    directory: &Path,
    receipt_id: &str,
    recovery: &RecoveryStore,
) -> Result<EntryScan, AppError> {
    reject_reparse_chain(directory)?;
    let _directory_lock = windows_file::lock_directory(directory)?;
    let manifest_bytes = read_bounded(&directory.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    let manifest: SaveManifest = serde_json::from_slice(&manifest_bytes).map_err(|_| invalid())?;
    validate_manifest(&manifest, receipt_id)?;

    let body = read_bounded(&directory.join("body.bin"), MAX_FILE_BYTES)?;
    if body.len() as u64 != manifest.body_bytes || digest(&body) != manifest.body_sha256 {
        return Err(invalid());
    }
    let original = read_bounded(&directory.join("original.bin"), MAX_FILE_BYTES)?;
    if original.len() as u64 != manifest.original_bytes
        || digest(&original) != manifest.original_sha256
    {
        return Err(invalid());
    }

    let mut names = HashSet::new();
    for (index, child) in fs::read_dir(directory).map_err(io_error)?.enumerate() {
        if index >= 32 {
            return Err(invalid());
        }
        let child = child.map_err(io_error)?;
        let Some(name) = child.file_name().to_str().map(str::to_owned) else {
            return Err(invalid());
        };
        if !child.file_type().map_err(io_error)?.is_file() {
            return Err(invalid());
        }
        reject_reparse_chain(&child.path())?;
        names.insert(name);
    }
    let mut latest_stage = 0;
    for (name, priority) in STAGE_FILES {
        if !names.contains(name) {
            continue;
        }
        let record: StageRecord =
            serde_json::from_slice(&read_bounded(&directory.join(name), 4096)?)
                .map_err(|_| invalid())?;
        let expected = name.trim_end_matches(".json");
        if record.receipt_id != receipt_id || record.stage != expected {
            return Err(invalid());
        }
        latest_stage = latest_stage.max(priority);
    }
    let allowed = STAGE_FILES
        .iter()
        .map(|(name, _)| *name)
        .chain(["manifest.json", "original.bin", "body.bin"])
        .collect::<HashSet<_>>();
    let mut warnings = Vec::new();
    if names.iter().any(|name| !allowed.contains(name.as_str())) {
        warnings.push(format!(
            "保存事务“{receipt_id}”包含未知证据，已保留且未自动清理。"
        ));
    }

    let temporary_exists = evidence_exists(&manifest.temporary)?;
    let backup_exists = evidence_exists(&manifest.backup)?;
    if temporary_exists || backup_exists {
        warnings.push(format!(
            "保存事务“{receipt_id}”仍有{}证据，已保留且不会静默删除。",
            if temporary_exists && backup_exists {
                "临时文件与备份"
            } else if temporary_exists {
                "临时文件"
            } else {
                "备份"
            }
        ));
    }

    // Successful saves intentionally retain the journal body/original as evidence.
    // Their presence alone is not a cleanup failure; external leftovers and
    // unknown entries have already produced warnings above.
    if matches!(latest_stage, 4 | 5) {
        if latest_stage == 5 {
            warnings.push(format!(
                "保存事务“{receipt_id}”已提交，但备份清理曾失败；已保留事务证据。"
            ));
        }
        return Ok(EntryScan {
            warnings,
            candidate: None,
        });
    }

    let discarded = match recovery.is_discarded(&manifest.document_id, manifest.document_version) {
        Ok(discarded) => discarded,
        Err(error) => {
            warnings.push(format!(
                "保存事务“{receipt_id}”的放弃标记无法核对：{} 已保留证据并暂停认领。",
                error.message
            ));
            return Ok(EntryScan {
                warnings,
                candidate: None,
            });
        }
    };
    let mut candidate = None;
    if discarded {
        warnings.push(format!(
            "保存事务“{receipt_id}”对应版本已明确放弃；证据仍保留，但不作为恢复候选。"
        ));
    } else {
        candidate = Some(SaveTransactionCandidate {
            receipt_id: receipt_id.to_owned(),
            display_name: manifest
                .target
                .file_name()
                .ok_or_else(invalid)?
                .to_string_lossy()
                .into_owned(),
            buffer_version: manifest.document_version,
            body_bytes: manifest.body_bytes,
        });
        warnings.push(format!(
            "保存事务“{receipt_id}”未确认完成，已保留待保存正文和原始副本，作为人工恢复候选。"
        ));
    }
    Ok(EntryScan {
        warnings,
        candidate,
    })
}

pub fn load_save_transaction(
    root: &Path,
    receipt_id: &str,
    recovery: &RecoveryStore,
) -> Result<LoadedSaveTransaction, AppError> {
    if !canonical_uuid(receipt_id) {
        return Err(invalid());
    }
    reject_reparse_chain(root)?;
    let root = root.canonicalize().map_err(io_error)?;
    let _budget = StorageBudget::lock(&root, "recovery")?;
    let directory = root.join(receipt_id);
    let _parents = windows_file::lock_parent_chain(&directory.join("manifest.json"))?;
    let inspected = inspect_entry(&directory, receipt_id, recovery)?;
    let candidate = inspected.candidate.ok_or_else(|| {
        AppError::new(
            ErrorCode::NotFound,
            "此保存事务已提交、已放弃或未能安全核对，未读取为恢复副本。",
        )
    })?;
    let manifest: SaveManifest = serde_json::from_slice(&read_bounded(
        &directory.join("manifest.json"),
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|_| invalid())?;
    validate_manifest(&manifest, receipt_id)?;
    let body = read_bounded(&directory.join("body.bin"), MAX_FILE_BYTES)?;
    if body.len() as u64 != manifest.body_bytes || digest(&body) != manifest.body_sha256 {
        return Err(invalid());
    }
    let bom: &[u8] = match (
        manifest.format.encoding.as_str(),
        manifest.format.bom.as_str(),
    ) {
        (
            "utf-8" | "utf-16le" | "utf-16be" | "gb18030" | "gbk" | "shift_jis" | "big5"
            | "windows-1252",
            "none",
        ) => &[],
        ("utf-8", "utf8") => &[0xef, 0xbb, 0xbf],
        ("utf-16le", "utf16le") => &[0xff, 0xfe],
        ("utf-16be", "utf16be") => &[0xfe, 0xff],
        _ => return Err(invalid()),
    };
    let bytes = body.strip_prefix(bom).ok_or_else(invalid)?;
    let decoded = if manifest.format.encoding == "utf-8" {
        std::str::from_utf8(bytes)
            .map_err(|_| invalid())?
            .to_owned()
    } else if !matches!(manifest.format.encoding.as_str(), "utf-16le" | "utf-16be") {
        super::encoding::decode_text(bytes, Some(&manifest.format.encoding))?.text
    } else {
        let (pairs, remaining) = bytes.as_chunks::<2>();
        if !remaining.is_empty() {
            return Err(invalid());
        }
        let units = pairs
            .iter()
            .map(|pair| {
                if manifest.format.encoding == "utf-16le" {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16(&units).map_err(|_| invalid())?
    };
    let (text, endings) = normalize_newlines(&decoded);
    if text.len() > super::save::MAX_SNAPSHOT_BYTES {
        return Err(invalid());
    }
    let newline_map = NewlineMap {
        document_version: 1,
        endings,
    };
    let snapshot = SaveRequest {
        document_id: manifest.document_id,
        request_id: receipt_id.to_owned(),
        document_version: 1,
        expected_disk_revision: manifest.expected_revision.unwrap_or_default(),
        text: text.clone(),
        format: manifest.format.clone(),
        newline_map: Some(newline_map.clone()),
    };
    if super::encode::encode_snapshot(&snapshot)? != body {
        return Err(invalid());
    }
    Ok(LoadedSaveTransaction {
        receipt_id: receipt_id.to_owned(),
        display_name: candidate.display_name,
        text,
        format: manifest.format,
        newline_map,
    })
}

fn validate_manifest(manifest: &SaveManifest, receipt_id: &str) -> Result<(), AppError> {
    let parent = manifest.target.parent().ok_or_else(invalid)?;
    if manifest.schema_version != 1
        || manifest.receipt_id != receipt_id
        || !canonical_uuid(receipt_id)
        || !canonical_uuid(&manifest.document_id)
        || !canonical_uuid(&manifest.request_id)
        || manifest.document_version > 9_007_199_254_740_991
        || !manifest.target.is_absolute()
        || manifest.temporary.parent() != Some(parent)
        || manifest.backup.parent() != Some(parent)
        || manifest
            .temporary
            .file_name()
            .and_then(|name| name.to_str())
            != Some(format!(".featherpad-{receipt_id}.tmp").as_str())
        || manifest.backup.file_name().and_then(|name| name.to_str())
            != Some(format!(".featherpad-{receipt_id}.bak").as_str())
        || manifest.expected_revision.as_ref().is_some_and(|revision| {
            revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        || !valid_digest(&manifest.original_sha256)
        || !valid_digest(&manifest.body_sha256)
        || manifest.original_bytes > MAX_FILE_BYTES
        || manifest.body_bytes > MAX_FILE_BYTES
        || manifest.format.encoding.is_empty()
        || manifest.format.encoding.len() > 64
        || !matches!(
            manifest.format.bom.as_str(),
            "none" | "utf8" | "utf16le" | "utf16be"
        )
        || !matches!(
            manifest.format.line_ending.as_str(),
            "lf" | "crlf" | "mixed"
        )
    {
        return Err(invalid());
    }
    Ok(())
}

fn evidence_exists(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
        Ok(_) => {
            reject_reparse_chain(path)?;
            Ok(true)
        }
    }
}

fn entry_bytes(path: &Path) -> Result<u64, AppError> {
    reject_reparse_chain(path)?;
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let _directory_lock = windows_file::lock_directory(path)?;
    let mut bytes = 0u64;
    for (index, child) in fs::read_dir(path).map_err(io_error)?.enumerate() {
        if index >= 32 {
            return Err(invalid());
        }
        let child = child.map_err(io_error)?;
        reject_reparse_chain(&child.path())?;
        let metadata = fs::symlink_metadata(child.path()).map_err(io_error)?;
        if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
        }
    }
    Ok(bytes)
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|id| id.to_string())
        .as_deref()
        == Some(value)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_id(value: &str) -> String {
    value.chars().take(64).collect()
}

fn invalid() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "保存事务记录格式无效或证据不完整。",
    )
}
