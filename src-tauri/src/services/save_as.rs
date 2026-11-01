use super::{
    documents::DocumentLease,
    files::FileService,
    grants::GrantKind,
    save::{HardLinkPolicy, MAX_FILE_BYTES},
    snapshot::{read_snapshot, DiskSnapshot},
};
use crate::models::{AppError, ErrorCode, SaveAsAck, SaveAsRequest, SaveIntent};
use std::path::Path;

// Captured before overwrite confirmation; no IPC can deserialize a destination or its revision.
pub struct ExistingDestination {
    before: DiskSnapshot,
    source_id: String,
    intent: SaveIntent,
}

impl ExistingDestination {
    pub fn capture(
        service: &mut FileService,
        path: &Path,
        source_id: &str,
        intent: SaveIntent,
    ) -> Result<Self, AppError> {
        let reference = service.grants.register_selection(path, GrantKind::File)?;
        let (file, _) = service.grants.open_file(&reference)?;
        let before = read_snapshot(file, MAX_FILE_BYTES)?;
        check_owner(service, &before, source_id, intent)?;
        Ok(Self {
            before,
            source_id: source_id.to_owned(),
            intent,
        })
    }

    pub fn display_path(&self) -> &str {
        &self.before.metadata.display_path
    }

    pub fn commit_confirmed(
        self,
        service: &mut FileService,
        request: SaveAsRequest,
        root: &Path,
        policy: HardLinkPolicy,
    ) -> Result<SaveAsAck, AppError> {
        if request.document_id != self.source_id || request.intent != self.intent {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "覆盖确认与源文档不匹配。",
            ));
        }
        check_owner(service, &self.before, &self.source_id, self.intent)?;
        // A private destination writer reuses the tested save core while the live source binding stays intact.
        let mut writer = FileService::default();
        let reference = writer
            .grants
            .register_selection(&self.before.path, GrantKind::File)?;
        writer.documents.replace(
            &self.source_id,
            DocumentLease {
                identity: self.before.identity,
                reference: reference.clone(),
                path: self.before.path,
                file: self.before.file,
            },
        );
        let ack = writer.save_existing(
            request.into_save_request(self.before.metadata.disk_revision),
            root,
            policy,
        )?;
        let (file, _) = writer.grants.open_file(&reference)?;
        let after = read_snapshot(file, MAX_FILE_BYTES)?;
        if after.metadata.disk_revision != ack.disk_revision {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "覆盖保存后目标又发生变化，未切换源文档绑定。",
            ));
        }
        check_owner(service, &after, &self.source_id, self.intent)?;
        let reference = service
            .grants
            .register_selection(&after.path, GrantKind::File)?;
        if self.intent == SaveIntent::SaveAs {
            service.documents.replace(
                &self.source_id,
                DocumentLease {
                    identity: after.identity,
                    reference: reference.clone(),
                    path: after.path,
                    file: after.file,
                },
            );
        }
        Ok(SaveAsAck {
            document_id: self.source_id,
            reference,
            metadata: after.metadata,
            ack,
        })
    }
}

fn check_owner(
    service: &FileService,
    target: &DiskSnapshot,
    source_id: &str,
    intent: SaveIntent,
) -> Result<(), AppError> {
    let owner = service
        .documents
        .owner_of(&target.identity)
        .or_else(|| service.documents.owner_at(&target.path));
    if owner.is_some_and(|owner| owner != source_id) {
        return Err(AppError::new(
            ErrorCode::Busy,
            "目标已由另一个打开的文档占用，请切换到该文档或选择其他路径。",
        ));
    }
    if intent == SaveIntent::Copy && owner == Some(source_id) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "保存副本必须选择与源文档不同的文件。",
        ));
    }
    if target.metadata.is_read_only {
        return Err(AppError::new(
            ErrorCode::ReadOnly,
            "目标文件为只读，请选择其他路径。",
        ));
    }
    Ok(())
}
