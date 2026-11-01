use super::{
    grants::opened_file_path,
    identity::{identify, FileIdentity},
};
use crate::models::{io_error, AppError, ErrorCode, FileMetadata};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};

pub struct DiskSnapshot {
    pub file: File,
    pub path: PathBuf,
    pub identity: FileIdentity,
    pub metadata: FileMetadata,
    pub bytes: Vec<u8>,
}

pub fn read_snapshot(mut file: File, limit: u64) -> Result<DiskSnapshot, AppError> {
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let path = opened_file_path(&file)?;
    let before = file.metadata().map_err(io_error)?;
    if before.len() > limit {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > limit {
        return Err(too_large());
    }
    let after = file.metadata().map_err(io_error)?;
    let modified = before.modified().map_err(io_error)?;
    if before.len() != bytes.len() as u64
        || before.len() != after.len()
        || modified != after.modified().map_err(io_error)?
    {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "读取期间文件已变化，请重试。",
        ));
    }
    let identity = identify(&file, &path);
    let modified_at = chrono::DateTime::<chrono::Utc>::from(modified)
        .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let mut hash = Sha256::new();
    hash.update(identity.revision_tag());
    hash.update(&bytes);
    hash.update(before.len().to_le_bytes());
    hash.update(&modified_at);
    let display = path.to_string_lossy();
    let display_path = if let Some(unc) = display.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        display
            .strip_prefix("\\\\?\\")
            .unwrap_or(&display)
            .to_owned()
    };
    Ok(DiskSnapshot {
        file,
        path,
        identity,
        metadata: FileMetadata {
            display_path,
            size_bytes: bytes.len() as u64,
            modified_at,
            is_read_only: before.permissions().readonly(),
            disk_revision: format!("{:x}", hash.finalize()),
        },
        bytes,
    })
}

fn too_large() -> AppError {
    AppError::new(
        ErrorCode::TooLarge,
        "文件超过当前读取模式的大小限制，请选择大文件模式。",
    )
}
