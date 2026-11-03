use super::{
    documents::DocumentLease,
    encode::encode_snapshot,
    files::FileService,
    grants::GrantKind,
    save::{MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES},
    save_journal::{digest, write_new_verified, SaveJournal, SaveStage},
    snapshot::read_snapshot,
    targets::NewFileTarget,
    windows_file,
};
use crate::models::{
    io_error, AppError, ErrorCode, SaveAck, SaveAsAck, SaveAsRequest, SaveIntent, SaveRequest,
};
use std::{fs::File, path::Path};

pub struct PreparedCreation {
    request: SaveRequest,
    intent: SaveIntent,
    target: NewFileTarget,
    journal: SaveJournal,
    _parents: Vec<File>,
}

impl PreparedCreation {
    pub fn prepare(
        request: SaveAsRequest,
        target: NewFileTarget,
        journal_root: &Path,
    ) -> Result<Self, AppError> {
        if request.text.len() > MAX_SNAPSHOT_BYTES {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "保存快照超过64MiB限制。",
            ));
        }
        if uuid::Uuid::parse_str(&request.document_id).is_err()
            || uuid::Uuid::parse_str(&request.request_id).is_err()
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "文档或保存请求标识无效。",
            ));
        }
        let intent = request.intent;
        // Creation has no expected revision; this internal snapshot is used only by the encoder.
        let request = request.into_save_request(String::new());
        let body = encode_snapshot(&request)?;
        if body.len() as u64 > MAX_FILE_BYTES {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "编码后的文件超过100MiB保存上限。",
            ));
        }
        let parents = windows_file::lock_parent_chain(target.path())?;
        target.require_missing()?;
        let journal = SaveJournal::prepare_creation(journal_root, &request, target.path(), &body)?;
        write_new_verified(&journal.manifest.temporary, &body)
            .map_err(|error| journal.failure(error, "write-temporary"))?;
        journal.stage(SaveStage::TemporaryReady)?;
        Ok(Self {
            request,
            intent,
            target,
            journal,
            _parents: parents,
        })
    }

    pub fn commit(self, service: &mut FileService) -> Result<SaveAsAck, AppError> {
        if let Some(owner) = service.documents.owner_at(self.target.path()) {
            if owner != self.request.document_id || self.intent == SaveIntent::Copy {
                return Err(AppError::new(
                    ErrorCode::Busy,
                    "目标路径已由打开的文档占用，请选择其他路径。",
                ));
            }
        }
        self.target
            .require_missing()
            .map_err(|error| self.journal.failure(error, "target-appeared"))?;
        let temporary = read_snapshot(
            File::open(&self.journal.manifest.temporary).map_err(io_error)?,
            MAX_FILE_BYTES,
        )?;
        if temporary.path != self.journal.manifest.temporary
            || digest(&temporary.bytes) != self.journal.manifest.body_sha256
        {
            return Err(self.journal.failure(
                AppError::new(ErrorCode::Conflict, "临时文件已变化，未提交保存。"),
                "verify-temporary",
            ));
        }
        drop(temporary);
        self.journal.stage(SaveStage::Replacing)?;
        windows_file::create_from_temporary(&self.journal.manifest.temporary, self.target.path())
            .map_err(|error| self.journal.failure(error, "create-target"))?;
        let after = read_snapshot(
            File::open(self.target.path()).map_err(io_error)?,
            MAX_FILE_BYTES,
        )
        .map_err(|error| self.journal.failure(error, "verify-created"))?;
        if after.path != self.target.path()
            || digest(&after.bytes) != self.journal.manifest.body_sha256
        {
            return Err(self.journal.failure(
                AppError::new(ErrorCode::Conflict, "新目标在保存后已变化。"),
                "verify-created",
            ));
        }
        let reference = service
            .grants
            .register_selection(&after.path, GrantKind::File)?;
        let ack = SaveAck {
            document_version: self.request.document_version,
            disk_revision: after.metadata.disk_revision.clone(),
            saved_at: after.metadata.modified_at.clone(),
            size_bytes: after.metadata.size_bytes,
        };
        if self.intent == SaveIntent::SaveAs {
            service.documents.replace(
                &self.request.document_id,
                DocumentLease {
                    identity: after.identity,
                    reference: reference.clone(),
                    path: after.path,
                    file: after.file,
                },
            );
            service
                .documents
                .set_encoding(&self.request.document_id, &self.request.format.encoding);
        }
        self.journal.stage(SaveStage::Committed)?;
        Ok(SaveAsAck {
            document_id: self.request.document_id,
            reference,
            metadata: after.metadata,
            ack,
        })
    }
}
