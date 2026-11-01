use super::{
    documents::DocumentLease,
    encode::encode_snapshot,
    files::FileService,
    save_journal::{digest, write_new_verified, SaveJournal, SaveStage},
    snapshot::{read_snapshot, DiskSnapshot},
    windows_file,
};
use crate::models::{AppError, ErrorCode, FileRef, SaveAck, SaveRequest};
use std::{fs::File, path::Path};

pub const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HardLinkPolicy {
    RequireConfirmation,
    ReplaceSelectedPathConfirmed,
}

pub struct PreparedSave {
    request: SaveRequest,
    reference: FileRef,
    policy: HardLinkPolicy,
    journal: SaveJournal,
    _parents: Vec<File>,
}

impl PreparedSave {
    pub fn prepare(
        service: &FileService,
        request: SaveRequest,
        journal_root: &Path,
        policy: HardLinkPolicy,
    ) -> Result<Self, AppError> {
        if request.text.len() > MAX_SNAPSHOT_BYTES {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "保存快照超过64MiB限制，内容仍保留在编辑器中。",
            ));
        }
        if uuid::Uuid::parse_str(&request.request_id).is_err()
            || request.expected_disk_revision.len() != 64
            || !request
                .expected_disk_revision
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "保存请求标识或磁盘版本无效。",
            ));
        }
        let document = service
            .documents
            .get(&request.document_id)
            .ok_or_else(not_open)?;
        let reference = document.reference.clone();
        let before = current_snapshot(service, &request, &reference, policy)?;
        let parents = windows_file::lock_parent_chain(&before.path)?;
        let body = encode_snapshot(&request)?;
        if body.len() as u64 > MAX_FILE_BYTES {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "编码后的文件超过100MiB保存上限。",
            ));
        }
        let journal = SaveJournal::prepare(journal_root, &request, &before, &body)?;
        let pending = Self {
            request,
            reference,
            policy,
            journal,
            _parents: parents,
        };
        // A grant authorizes this one operation's generated sibling, never an arbitrary IPC path.
        let latest = current_snapshot(service, &pending.request, &pending.reference, policy)
            .map_err(|error| pending.journal.failure(error, "before-temporary"))?;
        if latest.path != pending.journal.manifest.target {
            return Err(pending.abort(conflict(), "target-moved"));
        }
        write_new_verified(&pending.journal.manifest.temporary, &body)
            .map_err(|error| pending.journal.failure(error, "write-temporary"))?;
        pending.journal.stage(SaveStage::TemporaryReady)?;
        Ok(pending)
    }

    pub fn commit(self, service: &mut FileService) -> Result<SaveAck, AppError> {
        let current = current_snapshot(service, &self.request, &self.reference, self.policy)
            .map_err(|error| self.abort(error, "before-replace"))?;
        if current.path != self.journal.manifest.target {
            return Err(self.abort(conflict(), "target-moved"));
        }
        let temporary = File::open(&self.journal.manifest.temporary)
            .map_err(crate::models::io_error)
            .and_then(|file| read_snapshot(file, MAX_FILE_BYTES))
            .map_err(|error| self.abort(error, "verify-temporary"))?;
        if temporary.path != self.journal.manifest.temporary
            || digest(&temporary.bytes) != self.journal.manifest.body_sha256
        {
            return Err(self.abort(conflict(), "temporary-changed"));
        }
        drop(temporary); // ReplaceFileW opens its replacement without sharing.
        self.journal.stage(SaveStage::Replacing)?;
        windows_file::replace(
            &current.path,
            &self.journal.manifest.temporary,
            &self.journal.manifest.backup,
        )
        .map_err(|error| self.journal.failure(error, "replace"))?;
        let (file, _) = service
            .grants
            .open_file(&self.reference)
            .map_err(|error| self.journal.failure(error, "reopen-after-replace"))?;
        let after = read_snapshot(file, MAX_FILE_BYTES)
            .map_err(|error| self.journal.failure(error, "verify-after-replace"))?;
        if after.path != current.path || digest(&after.bytes) != self.journal.manifest.body_sha256 {
            return Err(self.journal.failure(conflict(), "changed-after-replace"));
        }
        let ack = SaveAck {
            document_version: self.request.document_version,
            disk_revision: after.metadata.disk_revision,
            saved_at: after.metadata.modified_at,
            size_bytes: after.metadata.size_bytes,
        };
        service.documents.replace(
            &self.request.document_id,
            DocumentLease {
                identity: after.identity,
                reference: self.reference,
                path: after.path,
                file: after.file,
            },
        );
        self.journal.stage(SaveStage::Committed)?;
        if windows_file::delete_owned_backup(
            &self.journal.manifest.backup,
            &self.journal.manifest.original_sha256,
        )
        .is_err()
        {
            // Never turn cleanup failure into an unknown successful write or delete an altered file.
            let _ = self.journal.stage(SaveStage::CleanupPending);
        }
        Ok(ack)
    }

    fn abort(&self, error: AppError, stage: &str) -> AppError {
        // Only the known generated temporary may be removed; journal body/original stay available.
        let _ = windows_file::delete_owned_backup(
            &self.journal.manifest.temporary,
            &self.journal.manifest.body_sha256,
        );
        self.journal.failure(error, stage)
    }
}

fn current_snapshot(
    service: &FileService,
    request: &SaveRequest,
    reference: &FileRef,
    policy: HardLinkPolicy,
) -> Result<DiskSnapshot, AppError> {
    let document = service
        .documents
        .get(&request.document_id)
        .ok_or_else(not_open)?;
    let (file, _) = service.grants.open_file(reference)?;
    let snapshot = read_snapshot(file, MAX_FILE_BYTES)?;
    if snapshot.identity != document.identity
        || snapshot.path != document.path
        || snapshot.metadata.disk_revision != request.expected_disk_revision
    {
        return Err(conflict());
    }
    if snapshot.metadata.is_read_only {
        return Err(AppError::new(
            ErrorCode::ReadOnly,
            "文件为只读，无法保存；可另存到其他位置。",
        ));
    }
    if windows_file::link_count(&snapshot.file)? > 1
        && policy == HardLinkPolicy::RequireConfirmation
    {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "文件有多个硬链接；需确认仅替换当前路径，其他链接保留旧内容。",
        ));
    }
    Ok(snapshot)
}

fn conflict() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "磁盘文件已变化，未覆盖外部修改。请比较或另存。",
    )
}
fn not_open() -> AppError {
    AppError::new(ErrorCode::NotFound, "此文档未在本地文件服务中打开。")
}
