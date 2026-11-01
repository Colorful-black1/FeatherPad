//! Windows-only recycle operation. This module has no IPC/path authorization entry point.
//! Callers must resolve the grant and finish dirty-document decisions before calling it.
use crate::models::{AppError, ErrorCode};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct RecycleReceipt {
    // Kept inside Rust; callers expose an opaque receipt ID, never this system path.
    pub recycled_path: PathBuf,
}

#[cfg(windows)]
pub fn recycle(path: &Path, expected_revision: &str) -> Result<RecycleReceipt, AppError> {
    recycle_on_thread(path, expected_revision, None)
}

#[cfg(windows)]
pub fn entry_identity(path: &Path, revision: &str) -> Result<String, AppError> {
    native::entry_identity(path, revision)
}

#[cfg(windows)]
pub fn recycle_checked(
    path: &Path,
    revision: &str,
    identity: &str,
) -> Result<RecycleReceipt, AppError> {
    recycle_on_thread(path, revision, Some(identity.to_owned()))
}

#[cfg(windows)]
fn recycle_on_thread(
    path: &Path,
    expected_revision: &str,
    identity: Option<String>,
) -> Result<RecycleReceipt, AppError> {
    let path = path.to_owned();
    let revision = expected_revision.to_owned();
    // A dedicated thread guarantees STA initialization without changing Tauri's thread apartment.
    std::thread::Builder::new()
        .name("featherpad-recycle".into())
        .spawn(move || native::recycle(&path, &revision, identity.as_deref()))
        .map_err(|_| unavailable())?
        .join()
        .map_err(|_| AppError::new(ErrorCode::Internal, "回收结果未确认，请刷新目录后检查。"))?
}

#[cfg(not(windows))]
pub fn recycle(_path: &Path, _expected_revision: &str) -> Result<RecycleReceipt, AppError> {
    Err(unavailable())
}

#[cfg(not(windows))]
pub fn entry_identity(_path: &Path, _revision: &str) -> Result<String, AppError> {
    Err(unavailable())
}

#[cfg(not(windows))]
pub fn recycle_checked(
    _path: &Path,
    _revision: &str,
    _identity: &str,
) -> Result<RecycleReceipt, AppError> {
    Err(unavailable())
}

fn unavailable() -> AppError {
    AppError::new(
        ErrorCode::TrashUnavailable,
        "无法确认项目可安全移至回收站，操作已停止；不会改为永久删除。",
    )
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::models::io_error;
    use crate::services::{
        directories::revision_from_metadata, grants::opened_file_path, identity::identify,
        identity::FileIdentity, windows_file,
    };
    use std::{
        fs::{self, OpenOptions},
        os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
        sync::{Arc, Mutex},
    };
    use windows::{
        core::{implement, Error, Ref, HRESULT, PCWSTR},
        Win32::{
            Foundation::{E_ABORT, E_NOTIMPL},
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IFileOperationProgressSink,
                IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
                FILEOPERATION_FLAGS, FOFX_EARLYFAILURE, FOFX_NOCOPYHOOKS, FOFX_RECYCLEONDELETE,
                FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_NO_CONNECTED_ELEMENTS,
                FOF_SILENT, SIGDN_FILESYSPATH, TSF_DELETE_RECYCLE_IF_POSSIBLE,
            },
        },
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    pub(super) fn recycle(
        path: &Path,
        revision: &str,
        identity: Option<&str>,
    ) -> Result<RecycleReceipt, AppError> {
        let _com = Apartment::new()?;
        perform(path, revision, identity, recycle_flags())
    }

    pub(super) fn entry_identity(path: &Path, revision: &str) -> Result<String, AppError> {
        use sha2::{Digest, Sha256};
        Ok(format!(
            "{:x}",
            Sha256::digest(Source::inspect(path, revision)?.identity.revision_tag())
        ))
    }

    fn recycle_flags() -> FILEOPERATION_FLAGS {
        FOFX_RECYCLEONDELETE
            | FOF_ALLOWUNDO
            | FOFX_EARLYFAILURE
            | FOFX_NOCOPYHOOKS
            | FOF_NO_CONNECTED_ELEMENTS
            | FOF_SILENT
            | FOF_NOCONFIRMATION
            | FOF_NOERRORUI
    }

    struct Apartment;
    impl Apartment {
        fn new() -> Result<Self, AppError> {
            // SAFETY: this thread owns its COM lifetime; no COM objects outlive this guard.
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|_| unavailable())?;
            Ok(Self)
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: exactly balances successful CoInitializeEx on the same thread.
            unsafe { CoUninitialize() };
        }
    }

    struct Source {
        path: PathBuf,
        revision: String,
        identity: FileIdentity,
    }

    impl Source {
        fn inspect(path: &Path, expected_revision: &str) -> Result<Self, AppError> {
            if !path.is_absolute()
                || expected_revision.len() != 64
                || !expected_revision
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "回收目标或版本无效。",
                ));
            }
            let file = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .map_err(io_error)?;
            let metadata = file.metadata().map_err(io_error)?;
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(AppError::new(
                    ErrorCode::Unsupported,
                    "链接或目录联接不能移至回收站。",
                ));
            }
            let canonical = path.canonicalize().map_err(io_error)?;
            if opened_file_path(&file)? != canonical {
                return Err(AppError::new(ErrorCode::Conflict, "回收目标路径已变化。"));
            }
            let kind = if metadata.is_dir() {
                "directory"
            } else if metadata.is_file() {
                "file"
            } else {
                return Err(unavailable());
            };
            let name = canonical
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(unavailable)?;
            if revision_from_metadata(name, kind, &metadata)? != expected_revision {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "文件树项目已变化，请刷新后重试。",
                ));
            }
            let identity = identify(&file, &canonical);
            if !matches!(identity, FileIdentity::Windows { .. }) {
                return Err(unavailable());
            }
            Ok(Self {
                path: canonical,
                revision: expected_revision.to_owned(),
                identity,
            })
        }

        fn validate(&self, item: &IShellItem) -> Result<(), AppError> {
            if shell_path(item)
                .map_err(|_| unavailable())?
                .canonicalize()
                .map_err(io_error)?
                != self.path
            {
                return Err(AppError::new(
                    ErrorCode::OutOfScope,
                    "系统回收目标不匹配，已停止操作。",
                ));
            }
            let current = Self::inspect(&self.path, &self.revision)?;
            if current.identity != self.identity {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "回收目标身份已变化，请刷新后重试。",
                ));
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct Outcome {
        error: Option<AppError>,
        recycled_path: Option<PathBuf>,
    }

    #[implement(IFileOperationProgressSink)]
    struct RecycleSink {
        source: Source,
        outcome: Arc<Mutex<Outcome>>,
    }

    impl RecycleSink {
        fn reject(&self, error: AppError) -> windows::core::Result<()> {
            if let Ok(mut outcome) = self.outcome.lock() {
                outcome.error.get_or_insert(error);
            }
            Err(Error::from_hresult(E_ABORT))
        }
    }

    #[allow(non_snake_case)]
    impl IFileOperationProgressSink_Impl for RecycleSink_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, _result: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreDeleteItem(&self, flags: u32, item: Ref<IShellItem>) -> windows::core::Result<()> {
            // The Shell can propose a permanent delete when recycling is unavailable. Veto it.
            if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
                return self.reject(AppError::new(
                    ErrorCode::TrashUnavailable,
                    "系统未提供回收站操作，已拒绝永久删除。",
                ));
            }
            let Some(item) = item.as_ref() else {
                return self.reject(unavailable());
            };
            match self.source.validate(item) {
                Ok(()) => Ok(()),
                Err(error) => self.reject(error),
            }
        }
        fn PostDeleteItem(
            &self,
            flags: u32,
            _item: Ref<IShellItem>,
            result: HRESULT,
            recycled: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            if result.is_err() || flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
                return self.reject(unavailable());
            }
            let Some(recycled) = recycled.as_ref() else {
                return self.reject(unavailable());
            };
            let path = shell_path(recycled)?;
            self.outcome
                .lock()
                .map_err(|_| Error::from_hresult(E_ABORT))?
                .recycled_path = Some(path);
            Ok(())
        }
        fn PreRenameItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }
        fn PostRenameItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreMoveItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }
        fn PostMoveItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreCopyItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }
        fn PostCopyItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }
        #[allow(clippy::too_many_arguments)]
        fn PostNewItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: &PCWSTR,
            _: u32,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    fn shell_path(item: &IShellItem) -> windows::core::Result<PathBuf> {
        // SAFETY: valid COM item; Shell allocates a NUL-terminated string with CoTaskMemAlloc.
        let allocated = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH)? };
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        // SAFETY: the returned pointer remains live until it is freed below.
        let path = PathBuf::from(OsString::from_wide(unsafe { allocated.as_wide() }));
        // SAFETY: free the exact allocation once, after copying its UTF-16 contents.
        unsafe { CoTaskMemFree(Some(allocated.0.cast())) };
        Ok(path)
    }

    fn shell_item(path: &Path) -> windows::core::Result<IShellItem> {
        // Shell parsing rejects the extended-length prefix returned by std::fs::canonicalize.
        // Only the presentation passed to Shell changes; validation retains the canonical path.
        let encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
        let mut wide = if encoded.starts_with(&[92, 92, 63, 92, 85, 78, 67, 92]) {
            [vec![92, 92], encoded[8..].to_vec()].concat()
        } else if encoded.starts_with(&[92, 92, 63, 92]) {
            encoded[4..].to_vec()
        } else {
            encoded
        };
        wide.push(0);
        // SAFETY: live NUL-terminated filesystem path, no custom bind context.
        unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }
    }

    fn perform(
        path: &Path,
        revision: &str,
        identity: Option<&str>,
        flags: FILEOPERATION_FLAGS,
    ) -> Result<RecycleReceipt, AppError> {
        let canonical = path.canonicalize().map_err(io_error)?;
        let _parents = windows_file::lock_parent_chain(&canonical)?;
        let source = Source::inspect(path, revision)?;
        if identity.is_some_and(|expected| {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(source.identity.revision_tag())) != expected
        }) {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "回收目标身份已变化，请重新确认。",
            ));
        }
        let item = shell_item(&source.path).map_err(|_| unavailable())?;
        let outcome = Arc::new(Mutex::new(Outcome::default()));
        let sink: IFileOperationProgressSink = RecycleSink {
            source,
            outcome: outcome.clone(),
        }
        .into();
        // SAFETY: COM initialized on this thread; objects and sink stay live through PerformOperations.
        let operation: IFileOperation =
            unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER) }
                .map_err(|_| unavailable())?;
        let result = unsafe {
            operation
                .SetOperationFlags(flags)
                .and_then(|()| operation.DeleteItem(&item, &sink))
                .and_then(|()| operation.PerformOperations())
                .and_then(|()| operation.GetAnyOperationsAborted())
        };
        let mut outcome = outcome.lock().map_err(|_| unavailable())?;
        if let Some(error) = outcome.error.take() {
            return Err(error);
        }
        if result.map_err(|_| unavailable())?.as_bool() {
            return Err(unavailable());
        }
        let recycled_path = outcome.recycled_path.take().ok_or_else(unavailable)?;
        match fs::symlink_metadata(&canonical) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(RecycleReceipt { recycled_path })
            }
            _ => Err(AppError::new(
                ErrorCode::Conflict,
                "回收后源路径状态未确认，请刷新目录后检查。",
            )),
        }
    }

    #[cfg(test)]
    mod tests {
        include!("windows_trash_tests.rs");
    }
}
