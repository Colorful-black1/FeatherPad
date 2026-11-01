use super::{
    encode::encode_snapshot,
    save::MAX_SNAPSHOT_BYTES,
    save_journal::{digest, write_new_verified},
    save_requests::payload_hash,
    windows_file,
};
use crate::models::{io_error, AppError, ErrorCode, NewlineMap, SaveRequest, TextFormat};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const MAX_RECOVERY_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
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

pub struct RecoveryStore {
    root: PathBuf,
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
        if !source_path.is_absolute() || uuid::Uuid::parse_str(&request.document_id).is_err() {
            return Err(invalid());
        }
        // Reuse the canonical snapshot validator, including per-line map/version/BOM checks.
        encode_snapshot(request)?;
        let receipt_id = uuid::Uuid::new_v4().to_string();
        let manifest = RecoveryManifest {
            schema_version: 1,
            receipt_id: receipt_id.clone(),
            reason: "before-trash".to_owned(),
            document_id: request.document_id.clone(),
            buffer_version: request.document_version,
            source_path: Some(source_path.to_owned()),
            source_revision: Some(request.expected_disk_revision.clone()),
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
        let _quota = quota_guard(&root)?;
        let required = request.text.len() as u64 + encoded_manifest.len() as u64;
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
        let recovered = self.load(&receipt_id)?;
        if recovered.text != request.text {
            return Err(invalid());
        }
        Ok(recovered)
    }

    pub fn load(&self, receipt_id: &str) -> Result<RecoveredDraft, AppError> {
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
            || manifest.reason != "before-trash"
            || manifest.body_bytes > MAX_SNAPSHOT_BYTES as u64
            || manifest
                .source_path
                .as_ref()
                .is_none_or(|path| !path.is_absolute())
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
            expected_disk_revision: manifest.source_revision.clone().ok_or_else(invalid)?,
            text: text.clone(),
            format: manifest.format.clone(),
            newline_map: manifest.newline_map.clone(),
        };
        payload_hash(&request)?;
        if uuid::Uuid::parse_str(&request.document_id).is_err() {
            return Err(invalid());
        }
        encode_snapshot(&request)?;
        Ok(RecoveredDraft { manifest, text })
    }

    fn ensure_root(&self) -> Result<(), AppError> {
        if !self.root.is_absolute() {
            return Err(invalid());
        }
        reject_reparse_chain(&self.root)?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        reject_reparse_chain(&self.root)
    }
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

fn reject_reparse_chain(path: &Path) -> Result<(), AppError> {
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

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, AppError> {
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
