use super::{
    encode::encode_snapshot,
    save::MAX_SNAPSHOT_BYTES,
    save_journal::{digest, write_new_verified},
    save_requests::payload_hash,
    storage_budget::StorageBudget,
    windows_file,
};
use crate::models::{
    io_error, AppError, ErrorCode, NewlineMap, RecoverySnapshotReason, SaveRequest, TextFormat,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const MAX_RECOVERY_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_SNAPSHOTS_PER_DOCUMENT: usize = 10;
const MAX_BUFFER_VERSION: u64 = 9_007_199_254_740_991;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscardMarker {
    schema_version: u32,
    document_id: String,
    through_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryManifest {
    pub schema_version: u32,
    pub receipt_id: String,
    pub reason: String,
    pub document_id: String,
    pub buffer_version: u64,
    pub source_path: Option<PathBuf>,
    pub source_revision: Option<String>,
    pub format: TextFormat,
    pub newline_map: Option<NewlineMap>,
    pub body_bytes: u64,
    pub body_sha256: String,
    pub created_at: String,
}

#[derive(Debug)]
pub struct RecoveredDraft {
    pub manifest: RecoveryManifest,
    pub text: String,
}

pub struct RecoveryScanFailure {
    pub entry_id: String,
    pub message: String,
}

pub struct RecoveryScan {
    pub entries: Vec<RecoveryManifest>,
    pub failures: Vec<RecoveryScanFailure>,
    pub storage_bytes: u64,
}

pub struct RecoverySource {
    pub path: PathBuf,
    pub revision: String,
}

#[derive(Clone, Copy)]
pub enum SnapshotReason {
    BeforeTrash,
    Periodic,
    HotExit,
}

impl SnapshotReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::BeforeTrash => "before-trash",
            Self::Periodic => "periodic",
            Self::HotExit => "hot-exit",
        }
    }
}

// Native-only metadata. Source paths are never accepted by the snapshot IPC.
pub struct RecoverySnapshot {
    pub document_id: String,
    pub buffer_version: u64,
    pub text: String,
    pub format: TextFormat,
    pub newline_map: Option<NewlineMap>,
    pub source: Option<RecoverySource>,
    pub reason: SnapshotReason,
}

pub struct RecoveryStore {
    root: PathBuf,
}

impl super::files::FileService {
    // Called while the command holds the same per-document permit as save/release/trash.
    pub fn prepare_recovery_snapshot(
        &self,
        request: crate::models::WriteRecoverySnapshotRequest,
    ) -> Result<RecoverySnapshot, AppError> {
        validate_document_version(&request.document_id, request.document_version)?;
        if self.documents.is_fragment(&request.document_id) {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "限量预览不能作为完整恢复正文写入。",
            ));
        }
        let source = match request.base_disk_revision {
            Some(revision) => {
                let lease = self.document_lease(&request.document_id).ok_or_else(|| {
                    AppError::new(
                        ErrorCode::NotFound,
                        "文档绑定已不可用，当前内容需作为未绑定副本保护。",
                    )
                })?;
                Some(RecoverySource {
                    path: lease.path.clone(),
                    revision,
                })
            }
            // A draft or an uncertain-release copy grants no access to an original source.
            None => None,
        };
        Ok(RecoverySnapshot {
            document_id: request.document_id,
            buffer_version: request.document_version,
            text: request.text,
            format: request.format,
            newline_map: request.newline_map,
            source,
            reason: match request.reason {
                RecoverySnapshotReason::Periodic => SnapshotReason::Periodic,
                RecoverySnapshotReason::HotExit => SnapshotReason::HotExit,
            },
        })
    }
}

impl RecoveryStore {
    // Native-only root; no IPC request may choose the recovery directory or a source path.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn persist_before_trash(
        &self,
        request: &SaveRequest,
        source_path: &Path,
    ) -> Result<RecoveredDraft, AppError> {
        payload_hash(request)?;
        self.persist_snapshot(RecoverySnapshot {
            document_id: request.document_id.clone(),
            buffer_version: request.document_version,
            text: request.text.clone(),
            format: request.format.clone(),
            newline_map: request.newline_map.clone(),
            source: Some(RecoverySource {
                path: source_path.to_owned(),
                revision: request.expected_disk_revision.clone(),
            }),
            reason: SnapshotReason::BeforeTrash,
        })
    }

    pub fn persist_snapshot(&self, snapshot: RecoverySnapshot) -> Result<RecoveredDraft, AppError> {
        validate_document_version(&snapshot.document_id, snapshot.buffer_version)?;
        if snapshot
            .source
            .as_ref()
            .is_some_and(|source| !source.path.is_absolute())
            || matches!(snapshot.reason, SnapshotReason::BeforeTrash) && snapshot.source.is_none()
        {
            return Err(invalid());
        }
        let receipt_id = uuid::Uuid::new_v4().to_string();
        let request = SaveRequest {
            document_id: snapshot.document_id,
            request_id: receipt_id.clone(),
            document_version: snapshot.buffer_version,
            expected_disk_revision: snapshot
                .source
                .as_ref()
                .map_or_else(|| "0".repeat(64), |source| source.revision.clone()),
            text: snapshot.text,
            format: snapshot.format,
            newline_map: snapshot.newline_map,
        };
        payload_hash(&request)?;
        // Reuse the canonical snapshot validator, including per-line map/version/BOM checks.
        encode_snapshot(&request)?;
        let (source_path, source_revision) = snapshot.source.map_or((None, None), |source| {
            (Some(source.path), Some(source.revision))
        });
        let manifest = RecoveryManifest {
            schema_version: 1,
            receipt_id: receipt_id.clone(),
            reason: snapshot.reason.as_str().to_owned(),
            document_id: request.document_id.clone(),
            buffer_version: request.document_version,
            source_path,
            source_revision,
            format: request.format.clone(),
            newline_map: request.newline_map.clone(),
            body_bytes: request.text.len() as u64,
            body_sha256: digest(request.text.as_bytes()),
            created_at: chrono::DateTime::<chrono::Utc>::from(SystemTime::now())
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        };
        let encoded_manifest = serde_json::to_vec(&manifest).map_err(|_| invalid())?;
        self.ensure_root()?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let _parents = windows_file::lock_parent_chain(&root.join("pending"))?;
        let budget = StorageBudget::lock(&root, "save-transactions")?;
        let _quota = quota_guard(&root)?;
        require_recoverable(&root, &request.document_id, request.document_version)?;
        let required = request.text.len() as u64 + encoded_manifest.len() as u64;
        budget.require_space(required)?;
        if storage_bytes(&root)?.saturating_add(required) > MAX_RECOVERY_BYTES {
            return Err(AppError::new(
                ErrorCode::DiskFull,
                "恢复存储已达到256MiB上限，草稿未获得落盘保护；请另存或清理冗余副本后重试。",
            ));
        }
        let directory = root.join(&receipt_id);
        fs::create_dir(&directory).map_err(io_error)?;
        // A visible manifest is written only after the complete body has been flushed.
        write_new_verified(&directory.join("body.bin"), request.text.as_bytes())?;
        write_new_verified(&directory.join("manifest.json"), &encoded_manifest)?;
        let recovered = self.load_locked(&receipt_id)?;
        if recovered.text != request.text {
            return Err(invalid());
        }
        // The new snapshot is already verified. Cleanup is best-effort so a locked
        // redundant copy cannot turn durable protection into a false failure.
        let _ = self.prune_redundant_snapshots(&root, &recovered.manifest.document_id, &receipt_id);
        Ok(recovered)
    }

    pub fn load(&self, receipt_id: &str) -> Result<RecoveredDraft, AppError> {
        reject_reparse_chain(&self.root)?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let _parents = windows_file::lock_parent_chain(&root.join("pending"))?;
        let _quota = quota_guard(&root)?;
        self.load_locked(receipt_id)
    }

    pub fn scan(&self) -> Result<RecoveryScan, AppError> {
        match fs::symlink_metadata(&self.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RecoveryScan {
                    entries: Vec::new(),
                    failures: Vec::new(),
                    storage_bytes: 0,
                })
            }
            Err(error) => return Err(io_error(error)),
            Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
            Ok(_) => {}
        }
        reject_reparse_chain(&self.root)?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let _parents = windows_file::lock_parent_chain(&root.join("pending"))?;
        let _quota = quota_guard(&root)?;
        let mut entries = Vec::new();
        let mut failures = Vec::new();
        for (index, entry) in fs::read_dir(&root).map_err(io_error)?.enumerate() {
            if index >= 100_000 {
                return Err(invalid());
            }
            let entry = entry.map_err(io_error)?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                failures.push(RecoveryScanFailure {
                    entry_id: "invalid-name".into(),
                    message: "恢复条目名称无效，已隔离。".into(),
                });
                continue;
            };
            if name == ".recovery.lock" || name.starts_with("discarded-") {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
            if !metadata.is_dir() {
                failures.push(RecoveryScanFailure {
                    entry_id: name,
                    message: "恢复目录包含无法识别的文件，已隔离。".into(),
                });
                continue;
            }
            if uuid::Uuid::parse_str(&name)
                .ok()
                .map(|id| id.to_string())
                .as_deref()
                != Some(name.as_str())
            {
                failures.push(RecoveryScanFailure {
                    entry_id: name,
                    message: "恢复条目标识无效，已隔离。".into(),
                });
                continue;
            }
            match self.load_locked(&name) {
                Ok(draft) => entries.push(draft.manifest),
                Err(error) => failures.push(RecoveryScanFailure {
                    entry_id: name,
                    message: error.message,
                }),
            }
        }
        entries.sort_by(|left, right| {
            left.document_id
                .cmp(&right.document_id)
                .then_with(|| right.buffer_version.cmp(&left.buffer_version))
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| left.receipt_id.cmp(&right.receipt_id))
        });
        failures.sort_by(|left, right| left.entry_id.cmp(&right.entry_id));
        Ok(RecoveryScan {
            entries,
            failures,
            storage_bytes: storage_bytes(&root)?,
        })
    }

    // Caller holds the store lock, so discard cannot race a load or a completed snapshot write.
    fn load_locked(&self, receipt_id: &str) -> Result<RecoveredDraft, AppError> {
        if uuid::Uuid::parse_str(receipt_id)
            .ok()
            .map(|id| id.to_string())
            .as_deref()
            != Some(receipt_id)
        {
            return Err(invalid());
        }
        reject_reparse_chain(&self.root)?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let directory = root.join(receipt_id);
        let _parents = windows_file::lock_parent_chain(&directory.join("manifest.json"))?;
        let manifest_bytes = read_bounded(&directory.join("manifest.json"), MAX_RECOVERY_BYTES)?;
        let manifest: RecoveryManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|_| invalid())?;
        if manifest.schema_version != 1
            || manifest.receipt_id != receipt_id
            || !matches!(
                manifest.reason.as_str(),
                "before-trash" | "periodic" | "hot-exit"
            )
            || manifest.body_bytes > MAX_SNAPSHOT_BYTES as u64
            || manifest.source_path.is_some() != manifest.source_revision.is_some()
            || manifest.reason == "before-trash" && manifest.source_path.is_none()
            || manifest
                .source_path
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
            || chrono::DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
        {
            return Err(invalid());
        }
        let body = read_bounded(&directory.join("body.bin"), MAX_SNAPSHOT_BYTES as u64)?;
        if body.len() as u64 != manifest.body_bytes || digest(&body) != manifest.body_sha256 {
            return Err(invalid());
        }
        let text = String::from_utf8(body).map_err(|_| invalid())?;
        let request = SaveRequest {
            document_id: manifest.document_id.clone(),
            request_id: receipt_id.to_owned(),
            document_version: manifest.buffer_version,
            expected_disk_revision: manifest
                .source_revision
                .clone()
                .unwrap_or_else(|| "0".repeat(64)),
            text: text.clone(),
            format: manifest.format.clone(),
            newline_map: manifest.newline_map.clone(),
        };
        payload_hash(&request)?;
        if uuid::Uuid::parse_str(&request.document_id).is_err() {
            return Err(invalid());
        }
        encode_snapshot(&request)?;
        require_recoverable(&root, &request.document_id, request.document_version)?;
        Ok(RecoveredDraft { manifest, text })
    }

    pub fn discard_through(&self, document_id: &str, through_version: u64) -> Result<(), AppError> {
        validate_document_version(document_id, through_version)?;
        self.ensure_root()?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let _parents = windows_file::lock_parent_chain(&root.join("pending"))?;
        let budget = StorageBudget::lock(&root, "save-transactions")?;
        let _quota = quota_guard(&root)?;
        if let Some(previous) =
            discarded_version(&root, document_id)?.filter(|version| *version >= through_version)
        {
            return purge_discarded_snapshots(&root, document_id, previous);
        }
        let marker = DiscardMarker {
            schema_version: 1,
            document_id: document_id.to_owned(),
            through_version,
        };
        let bytes = serde_json::to_vec(&marker).map_err(|_| invalid())?;
        budget.require_space(bytes.len() as u64)?;
        if storage_bytes(&root)?.saturating_add(bytes.len() as u64) > MAX_RECOVERY_BYTES {
            return Err(AppError::new(
                ErrorCode::DiskFull,
                "恢复存储已满，放弃标记未落盘，文档尚未关闭。",
            ));
        }
        let directory = root.join(format!("discarded-{document_id}"));
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error(error)),
        }
        let path = directory.join(format!("{through_version}.json"));
        let _directory = windows_file::lock_parent_chain(&path)?;
        write_new_verified(&path, &bytes)?;
        if discarded_version(&root, document_id)? != Some(through_version) {
            return Err(invalid());
        }
        purge_discarded_snapshots(&root, document_id, through_version)
    }

    pub(crate) fn is_discarded(&self, document_id: &str, version: u64) -> Result<bool, AppError> {
        validate_document_version(document_id, version)?;
        match fs::symlink_metadata(&self.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
            Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
            Ok(_) => {}
        }
        reject_reparse_chain(&self.root)?;
        let root = self.root.canonicalize().map_err(io_error)?;
        Ok(discarded_version(&root, document_id)?.is_some_and(|discarded| version <= discarded))
    }

    fn ensure_root(&self) -> Result<(), AppError> {
        if !self.root.is_absolute() {
            return Err(invalid());
        }
        reject_reparse_chain(&self.root)?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        reject_reparse_chain(&self.root)
    }

    fn prune_redundant_snapshots(
        &self,
        root: &Path,
        document_id: &str,
        current_receipt: &str,
    ) -> Result<(), AppError> {
        let mut candidates = Vec::new();
        for (index, entry) in fs::read_dir(root).map_err(io_error)?.enumerate() {
            if index >= 100_000 {
                return Err(invalid());
            }
            let entry = entry.map_err(io_error)?;
            let Some(receipt) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_document_version(&receipt, 0).is_err()
                || !entry.file_type().map_err(io_error)?.is_dir()
            {
                continue;
            }
            let Ok(draft) = self.load_locked(&receipt) else {
                continue;
            };
            if draft.manifest.document_id == document_id {
                candidates.push(draft.manifest);
            }
        }
        candidates.sort_by(|left, right| {
            right
                .buffer_version
                .cmp(&left.buffer_version)
                .then_with(|| right.created_at.cmp(&left.created_at))
                .then_with(|| left.receipt_id.cmp(&right.receipt_id))
        });
        let mut keep = candidates
            .iter()
            .take(MAX_SNAPSHOTS_PER_DOCUMENT)
            .map(|manifest| manifest.receipt_id.clone())
            .collect::<HashSet<_>>();
        if !keep.contains(current_receipt) {
            if keep.len() >= MAX_SNAPSHOTS_PER_DOCUMENT {
                if let Some(oldest) = candidates
                    .iter()
                    .rev()
                    .find(|manifest| keep.contains(&manifest.receipt_id))
                {
                    keep.remove(&oldest.receipt_id);
                }
            }
            keep.insert(current_receipt.to_owned());
        }
        for manifest in candidates {
            if !keep.contains(&manifest.receipt_id) {
                remove_verified_snapshot(root, &manifest.receipt_id)?;
            }
        }
        Ok(())
    }
}

fn remove_verified_snapshot(root: &Path, receipt_id: &str) -> Result<(), AppError> {
    if validate_document_version(receipt_id, 0).is_err() {
        return Err(invalid());
    }
    let directory = root.join(receipt_id);
    reject_reparse_chain(&directory)?;
    let _parents = windows_file::lock_parent_chain(&directory.join("manifest.json"))?;
    let mut names = Vec::new();
    for child in fs::read_dir(&directory).map_err(io_error)? {
        let child = child.map_err(io_error)?;
        reject_reparse_chain(&child.path())?;
        if !child.file_type().map_err(io_error)?.is_file() {
            return Err(invalid());
        }
        names.push(child.file_name());
    }
    if names.len() != 2
        || !names.iter().any(|name| name == "body.bin")
        || !names.iter().any(|name| name == "manifest.json")
    {
        return Err(invalid());
    }
    match fs::remove_file(directory.join("body.bin")) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    fs::remove_file(directory.join("manifest.json")).map_err(io_error)?;
    drop(_parents);
    fs::remove_dir(&directory).map_err(io_error)
}

fn purge_discarded_snapshots(
    root: &Path,
    document_id: &str,
    through_version: u64,
) -> Result<(), AppError> {
    // Never follow manifest source paths or recursively delete an unverified directory tree.
    for (index, entry) in fs::read_dir(root).map_err(io_error)?.enumerate() {
        if index >= 100_000 {
            return Err(invalid());
        }
        let entry = entry.map_err(io_error)?;
        let Some(receipt) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_document_version(&receipt, 0).is_err() {
            continue;
        }
        let directory = root.join(&receipt);
        reject_reparse_chain(&directory)?;
        if !entry.file_type().map_err(io_error)?.is_dir() {
            continue;
        }
        let parents = windows_file::lock_parent_chain(&directory.join("manifest.json"))?;
        let bytes = match read_bounded(&directory.join("manifest.json"), MAX_RECOVERY_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.code == ErrorCode::NotFound => continue,
            Err(error) => return Err(error),
        };
        let Ok(manifest) = serde_json::from_slice::<RecoveryManifest>(&bytes) else {
            continue;
        };
        if manifest.document_id != document_id || manifest.buffer_version > through_version {
            continue;
        }
        validate_document_version(&manifest.document_id, manifest.buffer_version)?;
        if manifest.schema_version != 1 || manifest.receipt_id != receipt {
            return Err(invalid());
        }
        for child in fs::read_dir(&directory).map_err(io_error)? {
            let child = child.map_err(io_error)?;
            reject_reparse_chain(&child.path())?;
            if !child.file_type().map_err(io_error)?.is_file()
                || !matches!(
                    child.file_name().to_str(),
                    Some("body.bin" | "manifest.json")
                )
            {
                return Err(invalid());
            }
        }
        // Keep the manifest until its body is gone so interrupted cleanup can be retried.
        match fs::remove_file(directory.join("body.bin")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        fs::remove_file(directory.join("manifest.json")).map_err(io_error)?;
        drop(parents);
        fs::remove_dir(&directory).map_err(io_error)?;
    }
    Ok(())
}

fn validate_document_version(document_id: &str, version: u64) -> Result<(), AppError> {
    if version > MAX_BUFFER_VERSION
        || uuid::Uuid::parse_str(document_id)
            .ok()
            .map(|id| id.to_string())
            .as_deref()
            != Some(document_id)
    {
        return Err(invalid());
    }
    Ok(())
}

fn discarded_version(root: &Path, document_id: &str) -> Result<Option<u64>, AppError> {
    validate_document_version(document_id, 0)?;
    let directory = root.join(format!("discarded-{document_id}"));
    reject_reparse_chain(&directory)?;
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
        Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
        Ok(_) => {}
    }
    let _directory = windows_file::lock_directory(&directory)?;
    let mut latest = None;
    for (index, entry) in fs::read_dir(&directory).map_err(io_error)?.enumerate() {
        if index >= 100_000 {
            return Err(invalid());
        }
        let path = entry.map_err(io_error)?.path();
        let marker: DiscardMarker =
            serde_json::from_slice(&read_bounded(&path, 4096)?).map_err(|_| invalid())?;
        validate_document_version(&marker.document_id, marker.through_version)?;
        if marker.schema_version != 1
            || marker.document_id != document_id
            || path.file_name().and_then(|name| name.to_str())
                != Some(format!("{}.json", marker.through_version).as_str())
        {
            return Err(invalid());
        }
        latest = Some(latest.map_or(marker.through_version, |previous: u64| {
            previous.max(marker.through_version)
        }));
    }
    Ok(latest)
}

fn require_recoverable(root: &Path, document_id: &str, version: u64) -> Result<(), AppError> {
    validate_document_version(document_id, version)?;
    if discarded_version(root, document_id)?.is_some_and(|discarded| version <= discarded) {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "该版本已明确放弃，不再写入或恢复。",
        ));
    }
    Ok(())
}

fn quota_guard(root: &Path) -> Result<std::fs::File, AppError> {
    let path = root.join(".recovery.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path).map_err(io_error)?;
    reject_reparse_chain(&path)?;
    if super::grants::opened_file_path(&file)? != path {
        return Err(invalid());
    }
    file.try_lock()
        .map_err(|_| AppError::new(ErrorCode::Busy, "恢复存储正在写入，请等待后重试。"))?;
    Ok(file)
}

pub(crate) fn reject_reparse_chain(path: &Path) -> Result<(), AppError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes()
                        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                        != 0
                    {
                        return Err(AppError::new(
                            ErrorCode::OutOfScope,
                            "恢复目录包含链接，已停止访问。",
                        ));
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err(invalid());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

pub(crate) fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, AppError> {
    reject_reparse_chain(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file.metadata().map_err(io_error)?.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
            || super::grants::opened_file_path(&file)? != path
        {
            return Err(invalid());
        }
    }
    if file.metadata().map_err(io_error)?.len() > max_bytes {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > max_bytes {
        return Err(invalid());
    }
    Ok(bytes)
}

fn storage_bytes(root: &Path) -> Result<u64, AppError> {
    let mut pending = vec![(root.to_owned(), 0)];
    let mut count = 0;
    let mut bytes = 0u64;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 2 {
            return Err(invalid());
        }
        let _directory = windows_file::lock_directory(&directory)?;
        for entry in fs::read_dir(directory).map_err(io_error)? {
            count += 1;
            if count > 100_000 {
                return Err(invalid());
            }
            let entry = entry.map_err(io_error)?;
            reject_reparse_chain(&entry.path())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
            if metadata.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
            } else {
                return Err(invalid());
            }
            if bytes > MAX_RECOVERY_BYTES {
                return Ok(bytes);
            }
        }
    }
    Ok(bytes)
}

fn invalid() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "恢复快照缺失、损坏或格式无效；现有副本已保留。",
    )
}
