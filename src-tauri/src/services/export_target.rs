//! Opaque, native-selector-only byte destinations. Text documents keep using
//! the existing save core; generated PDFs never pass through a text encoder.
use super::{
    files::FileService,
    grants::GrantKind,
    save::MAX_FILE_BYTES,
    save_journal::{digest, write_new_verified},
    snapshot::{read_snapshot, DiskSnapshot},
    targets::NewFileTarget,
    windows_file,
};
use crate::models::{io_error, AppError, ErrorCode};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

pub struct ExportTarget {
    path: PathBuf,
    before: Option<DiskSnapshot>,
    missing: Option<NewFileTarget>,
    _parents: Vec<File>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAck {
    pub display_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

impl ExportTarget {
    // No Deserialize and no path IPC. Only an OS selection or controlled test
    // can construct this ticket; confirmations cannot swap its destination.
    pub fn capture(service: &mut FileService, path: &Path) -> Result<Self, AppError> {
        super::recovery::reject_reparse_chain(path)?;
        let (path, before, missing) = if path.try_exists().map_err(io_error)? {
            let reference = service.grants.register_selection(path, GrantKind::File)?;
            let (file, _) = service.grants.open_file(&reference)?;
            let before = read_snapshot(file, MAX_FILE_BYTES)?;
            check_owner(service, &before)?;
            (before.path.clone(), Some(before), None)
        } else {
            let missing = service.grants.authorize_new_target(path)?;
            (missing.path().to_owned(), None, Some(missing))
        };
        let parents = windows_file::lock_parent_chain(&path)?;
        Ok(Self {
            path,
            before,
            missing,
            _parents: parents,
        })
    }
    pub fn exists(&self) -> bool {
        self.before.is_some()
    }
    pub fn display_path(&self) -> String {
        self.path
            .to_string_lossy()
            .strip_prefix(r"\\?\")
            .unwrap_or(&self.path.to_string_lossy())
            .to_owned()
    }

    fn recheck(&self, service: &mut FileService) -> Result<(), AppError> {
        if service.documents.owner_at(&self.path).is_some() {
            return Err(busy());
        }
        if let Some(before) = &self.before {
            let reference = service
                .grants
                .register_selection(&self.path, GrantKind::File)?;
            let (file, _) = service.grants.open_file(&reference)?;
            let now = read_snapshot(file, MAX_FILE_BYTES)?;
            check_owner(service, &now)?;
            if before.path != now.path
                || before.identity != now.identity
                || before.metadata.disk_revision != now.metadata.disk_revision
            {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "导出目标在确认后发生变化，未覆盖。",
                ));
            }
        } else if let Some(missing) = &self.missing {
            missing.require_missing()?;
        }
        Ok(())
    }

    pub fn commit(
        self,
        service: &mut FileService,
        bytes: &[u8],
        journal_root: &Path,
    ) -> Result<ExportAck, AppError> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "导出结果为空或超过100MiB。",
            ));
        }
        self.recheck(service)?;
        super::recovery::reject_reparse_chain(journal_root)?;
        fs::create_dir_all(journal_root).map_err(io_error)?;
        let receipt = uuid::Uuid::new_v4().to_string();
        let parent = self.path.parent().ok_or_else(busy)?;
        let temporary = parent.join(format!(".featherpad-export-{receipt}.tmp"));
        let backup = parent.join(format!(".featherpad-export-{receipt}.bak"));
        let expected_hash = digest(bytes);
        let metadata =
            serde_json::to_vec(&serde_json::json!({ "schemaVersion":1, "receiptId":receipt,
            "target":self.path, "temporary":temporary, "backup":backup, "sha256":expected_hash,
            "expectedRevision":self.before.as_ref().map(|before| &before.metadata.disk_revision) }))
            .map_err(|_| AppError::new(ErrorCode::Internal, "无法记录导出事务。"))?;
        write_new_verified(&journal_root.join(format!("{receipt}.json")), &metadata)?;
        let transaction = || -> Result<ExportAck, AppError> {
            write_new_verified(&temporary, bytes)?;
            let staged = read_snapshot(File::open(&temporary).map_err(io_error)?, MAX_FILE_BYTES)?;
            if staged.path != temporary || digest(&staged.bytes) != expected_hash {
                return Err(AppError::new(ErrorCode::Conflict, "导出临时文件已变化。"));
            }
            drop(staged);
            self.recheck(service)?;
            if self.before.is_some() {
                windows_file::replace(&self.path, &temporary, &backup)?;
            } else {
                windows_file::create_from_temporary(&temporary, &self.path)?;
            }
            let after = read_snapshot(File::open(&self.path).map_err(io_error)?, MAX_FILE_BYTES)?;
            if after.path != self.path || digest(&after.bytes) != expected_hash {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "导出结果在提交后发生变化，未确认成功。",
                ));
            }
            write_new_verified(
                &journal_root.join(format!("{receipt}.committed.json")),
                b"{\"committed\":true}",
            )?;
            if let Some(before) = &self.before {
                let _ = windows_file::delete_owned_backup(&backup, &digest(&before.bytes));
            }
            Ok(ExportAck {
                display_path: self.display_path(),
                size_bytes: bytes.len() as u64,
                sha256: expected_hash,
            })
        };
        transaction().map_err(|mut error| {
            error.message = format!(
                "{} 导出事务{receipt}未确认完成，原件或备份/临时文件已保留，请核对后重试。",
                error.message
            );
            error
        })
    }
}

fn check_owner(service: &FileService, snapshot: &DiskSnapshot) -> Result<(), AppError> {
    if service.documents.owner_of(&snapshot.identity).is_some()
        || service.documents.owner_at(&snapshot.path).is_some()
    {
        return Err(busy());
    }
    if snapshot.metadata.is_read_only {
        return Err(AppError::new(
            ErrorCode::ReadOnly,
            "导出目标为只读，请选择其他路径。",
        ));
    }
    Ok(())
}
fn busy() -> AppError {
    AppError::new(
        ErrorCode::Busy,
        "导出目标已由打开的文档占用，请选择其他文件。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_export_keeps_existing_bytes_and_never_creates_a_complete_destination() {
        let root =
            std::env::temp_dir().join(format!("featherpad-export-fault-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("original.pdf");
        fs::write(&path, b"original-pdf-bytes").unwrap();
        let mut service = FileService::default();
        // A real non-directory journal prevents durable staging; no target may change.
        let journal = root.join("blocked-journal");
        fs::write(&journal, b"not-a-directory").unwrap();
        assert!(ExportTarget::capture(&mut service, &path)
            .unwrap()
            .commit(&mut service, b"%PDF-new", &journal)
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original-pdf-bytes");
        let missing = root.join("new.pdf");
        assert!(ExportTarget::capture(&mut service, &missing)
            .unwrap()
            .commit(&mut service, b"%PDF-new", &journal)
            .is_err());
        assert!(!missing.exists());
        assert!(ExportTarget::capture(&mut service, &path)
            .unwrap()
            .commit(&mut service, b"", &root.join("journal"))
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original-pdf-bytes");
    }

    #[cfg(windows)]
    #[test]
    fn locked_export_target_keeps_bytes_and_preserves_failed_transaction_evidence() {
        use std::os::windows::fs::OpenOptionsExt;
        let root =
            std::env::temp_dir().join(format!("featherpad-export-lock-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("locked.pdf");
        fs::write(&path, b"original-locked-bytes").unwrap();
        let mut service = FileService::default();
        let target = ExportTarget::capture(&mut service, &path).unwrap();
        // Permit reading/writing while denying deletion/atomic replacement, as a PDF viewer can.
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(&path)
            .unwrap();
        let journal = root.join("journal");
        assert!(target
            .commit(&mut service, b"%PDF-replacement", &journal)
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original-locked-bytes");
        assert!(fs::read_dir(&journal).unwrap().next().is_some());
        assert!(fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        drop(lock);
    }

    #[test]
    fn byte_export_is_atomic_and_rejects_changes_after_confirmation() {
        let root = std::env::temp_dir().join(format!("featherpad-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("actual.pdf");
        let journal = root.join("journal");
        let mut service = FileService::default();
        ExportTarget::capture(&mut service, &path)
            .unwrap()
            .commit(&mut service, b"%PDF-first", &journal)
            .unwrap();
        let target = ExportTarget::capture(&mut service, &path).unwrap();
        fs::write(&path, b"external-new").unwrap();
        assert_eq!(
            target
                .commit(&mut service, b"%PDF-second", &journal)
                .err()
                .unwrap()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(fs::read(&path).unwrap(), b"external-new");
        ExportTarget::capture(&mut service, &path)
            .unwrap()
            .commit(&mut service, b"%PDF-final", &journal)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-final");
        // Test evidence stays in the controlled TEMP root for later inspection.
    }
}
