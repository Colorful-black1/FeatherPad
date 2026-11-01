use crate::models::{io_error, AppError, ErrorCode};
use std::{fs::File, path::Path};

#[cfg(windows)]
pub fn lock_parent_chain(path: &Path) -> Result<Vec<File>, AppError> {
    use super::grants::opened_file_path;
    use std::{
        fs::OpenOptions,
        os::windows::fs::{MetadataExt, OpenOptionsExt},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let mut parents: Vec<_> = path.ancestors().skip(1).collect();
    parents.reverse();
    let mut guards = Vec::with_capacity(parents.len());
    for parent in parents {
        // Lock names top-down; child file operations still require directory write sharing.
        let file = OpenOptions::new()
            .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(parent)
            .map_err(io_error)?;
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_dir()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || opened_file_path(&file)? != parent
        {
            return Err(AppError::new(
                ErrorCode::OutOfScope,
                "目录路径已变化或包含链接，已停止访问。",
            ));
        }
        guards.push(file);
    }
    Ok(guards)
}

#[cfg(windows)]
pub fn lock_directory(path: &Path) -> Result<File, AppError> {
    use super::grants::opened_file_path;
    use std::{
        fs::OpenOptions,
        os::windows::fs::{MetadataExt, OpenOptionsExt},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let file = OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_dir()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || opened_file_path(&file)? != path
    {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "目录已变化或包含链接，请刷新后重试。",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
pub fn link_count(file: &File) -> Result<u32, AppError> {
    use std::{
        mem::{size_of, MaybeUninit},
        os::windows::io::AsRawHandle,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO,
    };
    let mut info = MaybeUninit::<FILE_STANDARD_INFO>::zeroed();
    // SAFETY: live file, correctly sized/aligned output, initialized only on success.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    // SAFETY: successful FileStandardInfo filled the complete structure.
    Ok(unsafe { info.assume_init() }.NumberOfLinks)
}

#[cfg(windows)]
pub fn create_from_temporary(temporary: &Path, target: &Path) -> Result<(), AppError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let temporary: Vec<_> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: live NUL-terminated paths. No COPY_ALLOWED or REPLACE_EXISTING; same-directory move only.
    if unsafe { MoveFileExW(temporary.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(80 | 183)) {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "目标在保存期间出现，未覆盖；请重新选择或确认覆盖。",
            ));
        }
        return Err(io_error(error));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn create_from_temporary(_temporary: &Path, _target: &Path) -> Result<(), AppError> {
    Err(unsupported())
}

#[cfg(windows)]
pub fn replace(target: &Path, temporary: &Path, backup: &Path) -> Result<(), AppError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let (target, temporary, backup) = (wide(target), wide(temporary), wide(backup));
    // SAFETY: three NUL-terminated buffers live across the call; flags=0 preserves ACL errors.
    if unsafe {
        ReplaceFileW(
            target.as_ptr(),
            temporary.as_ptr(),
            backup.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(windows)]
pub fn delete_owned_backup(path: &Path, expected_hash: &str) -> Result<(), AppError> {
    use super::{save_journal::digest, snapshot::read_snapshot};
    use std::{
        fs::OpenOptions,
        mem::size_of,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO, FILE_SHARE_READ,
    };
    // DELETE access, while denying other writers/renamers during verification and disposition.
    let file = OpenOptions::new()
        .read(true)
        .access_mode(0x8000_0000 | 0x0001_0000)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(io_error)?;
    let snapshot = read_snapshot(file, 100 * 1024 * 1024)?;
    if snapshot.path != path || digest(&snapshot.bytes) != expected_hash {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "保存备份已变化，保留备份供人工检查。",
        ));
    }
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: validated live DELETE handle and correctly sized disposition structure.
    if unsafe {
        SetFileInformationByHandle(
            snapshot.file.as_raw_handle(),
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn link_count(_file: &File) -> Result<u32, AppError> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn lock_parent_chain(_path: &Path) -> Result<Vec<File>, AppError> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn lock_directory(_path: &Path) -> Result<File, AppError> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn replace(_target: &Path, _temporary: &Path, _backup: &Path) -> Result<(), AppError> {
    Err(unsupported())
}
#[cfg(not(windows))]
pub fn delete_owned_backup(_path: &Path, _hash: &str) -> Result<(), AppError> {
    Err(unsupported())
}
#[cfg(not(windows))]
fn unsupported() -> AppError {
    AppError::new(ErrorCode::Unsupported, "当前仅支持Windows原生保存。")
}
