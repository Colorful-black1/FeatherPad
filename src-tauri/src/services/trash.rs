use super::{
    directories::revision_from_metadata,
    documents::DocumentLease,
    encode::encode_snapshot,
    file_ops::{
        validate_request_id, validate_revision, CompletedEntryOperation, EntryOperationKind,
    },
    files::FileService,
    grants::ResolvedEntry,
    identity::identify,
    recovery::{RecoveryStore, MAX_RECOVERY_BYTES},
    save_requests::payload_hash,
    windows_file,
    windows_trash::{self, RecycleReceipt},
};
use crate::models::{
    AppError, ErrorCode, TrashDocument, TrashDraftReceipt, TrashEntryRequest, TrashEntryResult,
    TrashImpact, TrashImpactRequest,
};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

impl FileService {
    pub fn get_trash_impact(&self, request: TrashImpactRequest) -> Result<TrashImpact, AppError> {
        let (source, kind) = self.trash_source(&request)?;
        let _parents = windows_file::lock_parent_chain(&source.path)?;
        // Re-resolve after pinning the parent names, not only before taking the locks.
        let (source, _) = self.trash_source(&request)?;
        let mut affected_documents = self
            .documents
            .under(&source.path)
            .map(|(id, lease)| TrashDocument {
                document_id: id.to_owned(),
                display_path: lease.path.to_string_lossy().into_owned(),
                can_snapshot: !self.documents.is_fragment(id),
            })
            .collect::<Vec<_>>();
        if affected_documents.len() > 1000 {
            return Err(too_many());
        }
        affected_documents.sort_by(|left, right| left.document_id.cmp(&right.document_id));
        Ok(TrashImpact {
            reference: request.reference,
            display_path: source.path.to_string_lossy().into_owned(),
            kind,
            identity: windows_trash::entry_identity(&source.path, &request.expected_revision)?,
            revision: request.expected_revision,
            affected_documents,
        })
    }

    pub fn trash_entry(
        &mut self,
        request: TrashEntryRequest,
        recovery_root: &Path,
    ) -> Result<TrashEntryResult, AppError> {
        self.trash_with_recycler(request, recovery_root, windows_trash::recycle_checked)
    }

    fn trash_with_recycler(
        &mut self,
        request: TrashEntryRequest,
        recovery_root: &Path,
        recycle: impl FnOnce(&Path, &str, &str) -> Result<RecycleReceipt, AppError>,
    ) -> Result<TrashEntryResult, AppError> {
        validate_request_id(&request.request_id)?;
        validate_revision(&request.expected_revision)?;
        validate_revision(&request.expected_identity)?;
        let fingerprint = trash_fingerprint(&request)?;
        if let Some(CompletedEntryOperation::Trashed(result)) = self.entry_operations.replay(
            &request.request_id,
            EntryOperationKind::Trash,
            &fingerprint,
        )? {
            return result;
        }
        let result = self.perform_trash(&request, recovery_root, recycle);
        // Cache failures too: a lost reply must never turn into a delete of a new same-name file.
        self.entry_operations.record(
            request.request_id,
            EntryOperationKind::Trash,
            fingerprint,
            CompletedEntryOperation::Trashed(result.clone()),
        );
        result
    }

    fn perform_trash(
        &mut self,
        request: &TrashEntryRequest,
        recovery_root: &Path,
        recycle: impl FnOnce(&Path, &str, &str) -> Result<RecycleReceipt, AppError>,
    ) -> Result<TrashEntryResult, AppError> {
        let impact_request = TrashImpactRequest {
            reference: request.reference.clone(),
            expected_revision: request.expected_revision.clone(),
        };
        let (source, _) = self.trash_source(&impact_request)?;
        let _parents = windows_file::lock_parent_chain(&source.path)?;
        let impact = self.get_trash_impact(impact_request.clone())?;
        if impact.identity != request.expected_identity {
            return Err(changed_documents());
        }
        protect_private_state(&source.path, recovery_root)?;
        validate_documents(request, &impact)?;

        let store = RecoveryStore::new(recovery_root.to_owned());
        let mut drafts = Vec::with_capacity(request.snapshots.len());
        for snapshot in &request.snapshots {
            let document = self
                .documents
                .get(&snapshot.document_id)
                .ok_or_else(changed_documents)?;
            let saved = store.persist_before_trash(snapshot, &document.path)?;
            drafts.push(TrashDraftReceipt {
                document_id: snapshot.document_id.clone(),
                document_version: snapshot.document_version,
                receipt_id: saved.manifest.receipt_id,
            });
        }
        // Storage can take time. Check the source again before releasing any open file handles.
        let (latest, _) = self.trash_source(&impact_request)?;
        if latest.path != source.path {
            return Err(changed_documents());
        }
        protect_private_state(&source.path, recovery_root)?;
        let detached = self.documents.detach_under(&source.path);
        match recycle(
            &source.path,
            &request.expected_revision,
            &request.expected_identity,
        ) {
            Ok(_native_receipt) => Ok(TrashEntryResult {
                trashed: true,
                receipt_id: request.request_id.clone(),
                missing_document_ids: impact
                    .affected_documents
                    .into_iter()
                    .map(|document| document.document_id)
                    .collect(),
                drafts,
            }),
            Err(mut error) => {
                let reopened = detached
                    .iter()
                    .map(|document| {
                        let (file, path) = self.grants.open_file(&document.reference)?;
                        let identity = identify(&file, &path);
                        if identity != document.identity || path != document.path {
                            return Err(changed_documents());
                        }
                        Ok((
                            document.id.clone(),
                            DocumentLease {
                                identity,
                                reference: document.reference.clone(),
                                path,
                                file,
                            },
                        ))
                    })
                    .collect::<Result<Vec<_>, AppError>>();
                if reopened
                    .and_then(|leases| self.documents.restore_all(leases))
                    .is_err()
                {
                    error.message.push_str(
                        " 已打开文档重新绑定失败；缓冲及已落盘草稿仍保留，请刷新后检查文件位置。",
                    );
                }
                if !drafts.is_empty() {
                    error
                        .message
                        .push_str(" 删除前草稿已保留，原操作不会自动重试。");
                }
                Err(error)
            }
        }
    }

    fn trash_source(
        &self,
        request: &TrashImpactRequest,
    ) -> Result<(ResolvedEntry, &'static str), AppError> {
        validate_revision(&request.expected_revision)?;
        let source = self.grants.resolve_entry(&request.reference)?;
        let kind = if source.metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        let name = source
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(changed_documents)?;
        if revision_from_metadata(name, kind, &source.metadata)? != request.expected_revision {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "文件树项目已变化，请刷新后重新确认。",
            ));
        }
        Ok((source, kind))
    }
}

fn validate_documents(request: &TrashEntryRequest, impact: &TrashImpact) -> Result<(), AppError> {
    let expected_ids = impact
        .affected_documents
        .iter()
        .map(|document| document.document_id.as_str())
        .collect::<HashSet<_>>();
    let supplied_ids = request
        .affected_document_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if supplied_ids.len() != request.affected_document_ids.len() || supplied_ids != expected_ids {
        return Err(changed_documents());
    }
    let expected_snapshots = impact
        .affected_documents
        .iter()
        .filter(|document| document.can_snapshot)
        .map(|document| document.document_id.as_str())
        .collect::<HashSet<_>>();
    let snapshots = request
        .snapshots
        .iter()
        .map(|snapshot| snapshot.document_id.as_str())
        .collect::<HashSet<_>>();
    if snapshots.len() != request.snapshots.len() || snapshots != expected_snapshots {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "删除前必须保护所有受影响文档的完整快照，请重新确认。",
        ));
    }
    // Validate the whole set before storing the first body. Only the canonical encoder validates maps.
    for snapshot in &request.snapshots {
        encode_snapshot(snapshot)?;
    }
    Ok(())
}

fn trash_fingerprint(request: &TrashEntryRequest) -> Result<String, AppError> {
    if request.snapshots.len() > 1000 || request.affected_document_ids.len() > 1000 {
        return Err(too_many());
    }
    if request
        .snapshots
        .iter()
        .map(|snapshot| snapshot.text.len() as u64)
        .sum::<u64>()
        > MAX_RECOVERY_BYTES
    {
        return Err(too_many());
    }
    let mut hash = Sha256::new();
    for field in [
        &request.reference.grant_id,
        &request.reference.relative_path,
        &request.expected_revision,
        &request.expected_identity,
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field.as_bytes());
    }
    hash.update((request.affected_document_ids.len() as u64).to_le_bytes());
    for id in &request.affected_document_ids {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(changed_documents());
        }
        hash.update((id.len() as u64).to_le_bytes());
        hash.update(id.as_bytes());
    }
    hash.update((request.snapshots.len() as u64).to_le_bytes());
    for snapshot in &request.snapshots {
        hash.update(payload_hash(snapshot)?.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn protect_private_state(source: &Path, recovery_root: &Path) -> Result<(), AppError> {
    let private = recovery_root.parent().ok_or_else(changed_documents)?;
    if let Ok(private) = private.canonicalize() {
        if private.starts_with(source) || source.starts_with(&private) {
            return Err(AppError::new(
                ErrorCode::OutOfScope,
                "应用私有状态目录及其父目录不能从文件树回收。",
            ));
        }
    }
    Ok(())
}

fn changed_documents() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "受影响的已打开文档已变化，请重新查看删除确认。",
    )
}

fn too_many() -> AppError {
    AppError::new(
        ErrorCode::TooLarge,
        "受影响文档或快照总量超过保护上限，请先另存或分批处理。",
    )
}

#[cfg(all(test, windows))]
mod tests {
    include!("trash_tests.rs");
}
