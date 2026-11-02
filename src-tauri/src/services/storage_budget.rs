use super::{grants::opened_file_path, recovery::reject_reparse_chain, windows_file};
use crate::models::{io_error, AppError, ErrorCode};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub const MAX_STORAGE_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) struct StorageBudget {
    store: PathBuf,
    peer: PathBuf,
    _lock: File,
    _parents: Vec<File>,
}

impl StorageBudget {
    pub(crate) fn lock(store: &Path, peer_name: &str) -> Result<Self, AppError> {
        if !store.is_absolute() || !matches!(peer_name, "recovery" | "save-transactions") {
            return Err(invalid());
        }
        reject_reparse_chain(store)?;
        let store = store.canonicalize().map_err(io_error)?;
        let parent = store.parent().ok_or_else(invalid)?;
        let peer = parent.join(peer_name);
        let path = parent.join(".snapshot-budget.lock");
        let parents = windows_file::lock_parent_chain(&path)?;
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
        let lock = options.open(&path).map_err(io_error)?;
        reject_reparse_chain(&path)?;
        if opened_file_path(&lock)? != path {
            return Err(invalid());
        }
        lock.try_lock()
            .map_err(|_| AppError::new(ErrorCode::Busy, "恢复与保存存储正在写入，请稍后重试。"))?;
        Ok(Self {
            store,
            peer,
            _lock: lock,
            _parents: parents,
        })
    }

    pub(crate) fn require_space(&self, additional: u64) -> Result<(), AppError> {
        let used = directory_bytes(&self.store)?.saturating_add(directory_bytes(&self.peer)?);
        if used.saturating_add(additional) > MAX_STORAGE_BYTES {
            return Err(AppError::new(
                ErrorCode::DiskFull,
                "恢复副本与保存事务已达到256MiB上限，当前内容未获得新的落盘保护；请保留正文并管理冗余副本后重试。",
            ));
        }
        Ok(())
    }
}

fn directory_bytes(root: &Path) -> Result<u64, AppError> {
    reject_reparse_chain(root)?;
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(io_error(error)),
        Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
        Ok(_) => {}
    }
    let mut pending = vec![(root.to_owned(), 0)];
    let mut bytes = 0u64;
    let mut count = 0;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 2 {
            return Err(invalid());
        }
        let _directory = windows_file::lock_directory(&directory)?;
        for entry in fs::read_dir(&directory).map_err(io_error)? {
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
            if bytes > MAX_STORAGE_BYTES {
                return Ok(bytes);
            }
        }
    }
    Ok(bytes)
}

fn invalid() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "恢复与保存存储结构无效，已停止新增写入。",
    )
}
