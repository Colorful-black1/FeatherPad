use super::files::{FileService, OpenRequestMode};
use crate::models::{AppError, ErrorCode, FileMetadata, FileRef, OpenDocumentContent, TextFormat};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComparisonRequest {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub encoding: Option<String>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonSnapshot {
    pub text: String,
    pub metadata: FileMetadata,
    pub format: TextFormat,
}

impl FileService {
    pub fn read_comparison_snapshot(
        &self,
        request: ComparisonRequest,
    ) -> Result<ComparisonSnapshot, AppError> {
        // A private reader owns all transient leases. Comparing never rebinds,
        // releases or registers a writer in the live document registry.
        let mut reader = Self {
            grants: self.grants.clone(),
            ..Self::default()
        };
        let opened = reader.open_document_with_encoding(
            request.reference,
            OpenRequestMode::Auto,
            None,
            request.encoding.as_deref(),
        )?;
        match opened.content {
            OpenDocumentContent::Text{text,..} if text.len()<20*1024*1024 => Ok(ComparisonSnapshot{text,metadata:opened.metadata,format:opened.format}),
            _=>Err(AppError::new(ErrorCode::TooLarge,"只允许完整文本快照比较，图片/限量预览或20MiB以上内容不可全量比较；SVG请显式选择文本编码。"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::grants::GrantKind;
    use super::*;
    #[test]
    fn comparison_reads_changed_disk_without_rebinding_the_open_buffer() {
        let root = std::env::temp_dir().join(format!("featherpad-diff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("source.txt");
        std::fs::write(&path, "before\r\n").unwrap();
        let mut files = FileService::default();
        let reference = files
            .grants
            .register_selection(&path, GrantKind::File)
            .unwrap();
        let opened = files.open_document(reference.clone()).unwrap();
        let identity = files
            .document_lease(&opened.document_id)
            .unwrap()
            .identity
            .clone();
        std::fs::write(&path, "after\r\n").unwrap();
        let snapshot = files
            .read_comparison_snapshot(ComparisonRequest {
                reference,
                encoding: None,
            })
            .unwrap();
        assert_eq!(snapshot.text, "after\n");
        assert_ne!(
            snapshot.metadata.disk_revision,
            opened.metadata.disk_revision
        );
        assert_eq!(
            files.document_lease(&opened.document_id).unwrap().identity,
            identity
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"after\r\n");
    }
}
