use super::{
    documents::DocumentRegistry,
    files::{FileService, OpenRequestMode},
};
use crate::models::{AppError, ErrorCode, OpenDocument};

impl FileService {
    // Reading for comparison never changes the source lease or grants.
    pub fn get_disk_snapshot(&self, id: &str) -> Result<OpenDocument, AppError> {
        let (document, _) = self.disk_document(id)?;
        if !matches!(
            document.content,
            crate::models::OpenDocumentContent::Text { .. }
        ) {
            return Err(AppError::new(
                ErrorCode::ReadOnly,
                "磁盘文件已进入只读大文件模式，请重新载入后按页查看。",
            ));
        }
        Ok(document)
    }

    pub fn reload_document(
        &mut self,
        id: &str,
        expected_revision: &str,
    ) -> Result<OpenDocument, AppError> {
        self.reopen_with_encoding(
            id,
            expected_revision,
            self.documents.encoding(id).map(str::to_owned).as_deref(),
        )
    }

    pub fn reopen_with_encoding(
        &mut self,
        id: &str,
        expected_revision: &str,
        encoding: Option<&str>,
    ) -> Result<OpenDocument, AppError> {
        let (document, registry) = self.disk_document_with_encoding(id, encoding)?;
        if document.metadata.disk_revision != expected_revision {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "磁盘在确认后再次变化，请重新比较。",
            ));
        }
        self.documents.adopt(id, registry)?;
        let lease = self
            .documents
            .get(id)
            .expect("adopted snapshot has a lease");
        // Persist only the identity of a verified, accepted reload; merely observing or
        // comparing a replacement must not authorize it for a future session.
        self.grants
            .confirm_file_identity(&lease.reference, &lease.file, &lease.path)?;
        Ok(document)
    }

    fn disk_document(&self, id: &str) -> Result<(OpenDocument, DocumentRegistry), AppError> {
        self.disk_document_with_encoding(id, self.documents.encoding(id))
    }

    fn disk_document_with_encoding(
        &self,
        id: &str,
        encoding: Option<&str>,
    ) -> Result<(OpenDocument, DocumentRegistry), AppError> {
        let lease = self
            .documents
            .get(id)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "此文档未打开。"))?;
        let mut reader = FileService {
            grants: self.grants.clone(),
            ..FileService::default()
        };
        // Keep the source DocumentId even if an external atomic replacement changed file ID.
        // Head previews retain their explicit bounded-reading choice.
        let mode = if self.documents.is_text_preview(id) {
            OpenRequestMode::TextPreview
        } else if self.documents.is_head_preview(id)
            && self
                .grants
                .open_file(&lease.reference)?
                .0
                .metadata()
                .map_err(crate::models::io_error)?
                .len()
                > super::save::MAX_FILE_BYTES
        {
            OpenRequestMode::HeadPreview
        } else {
            OpenRequestMode::Auto
        };
        let document = reader.open_document_with_encoding(
            lease.reference.clone(),
            mode,
            Some(id),
            encoding,
        )?;
        let next_lease = reader
            .documents
            .get(id)
            .expect("reader registered its document");
        if self
            .documents
            .owner_of(&next_lease.identity)
            .is_some_and(|owner| owner != id)
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "磁盘文件已对应另一个已打开文档，请先处理重复身份。",
            ));
        }
        Ok((document, reader.documents))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::services::grants::{GrantKind, GrantRegistry};

    #[test]
    fn only_an_accepted_reload_refreshes_persistent_file_identity() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts/T111/grant-reload")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("source.txt");
        std::fs::write(&path, "original").unwrap();
        let mut files = FileService::default();
        let reference = files
            .grants
            .register_selection(&path, GrantKind::File)
            .unwrap();
        let document = files.open_document(reference.clone()).unwrap();
        let original = files.grants.persistent_grant(&reference.grant_id).unwrap();
        std::fs::rename(&path, root.join("old.txt")).unwrap();
        std::fs::write(&path, "replacement").unwrap();
        let snapshot = files.get_disk_snapshot(&document.document_id).unwrap();
        let compared = files.grants.persistent_grant(&reference.grant_id).unwrap();
        assert_eq!(compared.identity_sha256, original.identity_sha256);
        assert_eq!(
            GrantRegistry::default()
                .restore_persisted_grant(compared)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        files
            .reload_document(&document.document_id, &snapshot.metadata.disk_revision)
            .unwrap();
        let accepted = files.grants.persistent_grant(&reference.grant_id).unwrap();
        assert_ne!(accepted.identity_sha256, original.identity_sha256);
        assert_eq!(
            GrantRegistry::default()
                .restore_persisted_grant(accepted)
                .unwrap(),
            reference
        );
    }
}
