use super::{
    assets::{inspect_resource_image, MAX_IMAGE_BYTES},
    documents::DocumentLease,
    files::{canonical_identity, FileService},
    snapshot::read_snapshot,
};
use crate::models::{io_error, FileRef, OpenDocument, OpenDocumentContent, TextFormat};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

impl FileService {
    pub(super) fn try_open_image(
        &mut self,
        reference: FileRef,
        mut file: File,
        preferred: Option<&str>,
    ) -> Result<Option<OpenDocument>, crate::models::AppError> {
        let path = super::grants::opened_file_path(&file)?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut header = [0u8; 64];
        let read = file.read(&mut header).map_err(io_error)?;
        file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let known = matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
        ) || matches!(
            imagesize::image_type(&header[..read]),
            Ok(imagesize::ImageType::Png
                | imagesize::ImageType::Jpeg
                | imagesize::ImageType::Gif
                | imagesize::ImageType::Webp)
        );
        if !known {
            return Ok(None);
        }
        let snapshot = read_snapshot(file, MAX_IMAGE_BYTES)?;
        let image = inspect_resource_image(&snapshot.bytes, MAX_IMAGE_BYTES)?;
        let canonical_identity = canonical_identity(&snapshot.identity);
        let id = self.documents.register_preferred(
            DocumentLease {
                identity: snapshot.identity,
                reference: reference.clone(),
                path: snapshot.path,
                file: snapshot.file,
            },
            preferred,
        )?;
        self.documents.mark_fragment(&id);
        self.documents.set_encoding(&id, "binary");
        Ok(Some(OpenDocument {
            document_id: id,
            canonical_identity,
            reference,
            metadata: snapshot.metadata,
            format: TextFormat {
                encoding: "binary".into(),
                bom: "none".into(),
                line_ending: "lf".into(),
            },
            warnings: vec![],
            mode: "image-readonly",
            content: OpenDocumentContent::Image { image },
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::super::{files::OpenRequestMode, grants::GrantKind};
    use super::*;
    #[test]
    fn image_open_is_readonly_identity_bound_and_svg_requires_explicit_text_encoding() {
        let root = std::env::temp_dir().join(format!("featherpad-image-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("safe.svg");
        std::fs::write(
            &path,
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"20\"/>",
        )
        .unwrap();
        let mut files = FileService::default();
        let reference = files
            .grants
            .register_selection(&path, GrantKind::File)
            .unwrap();
        let image = files.open_document(reference.clone()).unwrap();
        assert_eq!(image.mode, "image-readonly");
        assert!(files.documents.is_fragment(&image.document_id));
        assert_eq!(
            files.open_document(reference.clone()).unwrap().document_id,
            image.document_id
        );
        let source = files
            .reopen_with_encoding(
                &image.document_id,
                &image.metadata.disk_revision,
                Some("utf-8"),
            )
            .unwrap();
        assert_eq!(source.mode, "normal");
        assert_eq!(source.document_id, image.document_id);
        assert!(!files.documents.is_fragment(&source.document_id));
        assert!(source.content.text().unwrap().starts_with("<svg"));
        assert_eq!(
            files
                .open_document_with_mode(reference, OpenRequestMode::Auto)
                .unwrap()
                .mode,
            "normal"
        );
    }
}
