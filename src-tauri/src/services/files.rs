use super::grants::GrantRegistry;
use super::{
    documents::{DocumentLease, DocumentRegistry},
    identity::FileIdentity,
    open_policy::{has_long_line, OpenPolicy},
    snapshot::read_snapshot,
    stream_snapshot::{
        decode_window, read_stream_snapshot, NewlineStats, StreamEncoding, HEAD_PREVIEW_BYTES,
        INITIAL_CHUNK_BYTES, MAX_CHUNK_BYTES, MAX_WINDOW_BYTES,
    },
    text::normalize_newlines,
};
use crate::models::{
    AppError, ErrorCode, FileRef, Newline, NewlineMap, OpenDocument, OpenDocumentContent,
    ReadChunkRequest, TextChunk, TextFormat,
};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenRequestMode {
    Auto,
    HeadPreview,
    TextPreview,
}

#[derive(Default)]
pub struct FileService {
    pub grants: GrantRegistry,
    pub(super) documents: DocumentRegistry,
    pub(super) saves: super::save_requests::SaveHistory,
    pub(super) directory_cursors: super::directories::DirectoryCursors,
    pub(super) entry_operations: super::file_ops::EntryOperationHistory,
}

impl FileService {
    pub fn release_document(&mut self, document_id: &str) -> Result<bool, AppError> {
        if uuid::Uuid::parse_str(document_id)
            .ok()
            .map(|id| id.to_string())
            .as_deref()
            != Some(document_id)
        {
            return Err(AppError::new(ErrorCode::InvalidInput, "文档标识无效。"));
        }
        Ok(self.documents.release(document_id))
    }

    pub fn document_lease(&self, document_id: &str) -> Option<&DocumentLease> {
        self.documents.get(document_id)
    }

    pub fn open_document(&mut self, reference: FileRef) -> Result<OpenDocument, AppError> {
        self.open_document_with_mode(reference, OpenRequestMode::Auto)
    }

    pub fn open_document_with_mode(
        &mut self,
        reference: FileRef,
        requested_mode: OpenRequestMode,
    ) -> Result<OpenDocument, AppError> {
        self.open_document_with_mode_and_id(reference, requested_mode, None)
    }

    pub fn open_document_with_mode_and_id(
        &mut self,
        reference: FileRef,
        requested_mode: OpenRequestMode,
        preferred_document_id: Option<&str>,
    ) -> Result<OpenDocument, AppError> {
        self.open_document_with_encoding(reference, requested_mode, preferred_document_id, None)
    }

    pub fn open_document_with_encoding(
        &mut self,
        reference: FileRef,
        requested_mode: OpenRequestMode,
        preferred_document_id: Option<&str>,
        encoding: Option<&str>,
    ) -> Result<OpenDocument, AppError> {
        if encoding.is_some_and(|label| !super::encoding::LABELS.contains(&label)) {
            return Err(AppError::new(ErrorCode::Unsupported, "不支持所选编码。"));
        }
        let (file, path) = self.grants.open_file(&reference)?;
        if preferred_document_id.is_none() {
            if let Some(id) = self.documents.owner_at(&path).or_else(|| {
                self.documents
                    .owner_of(&super::identity::identify(&file, &path))
            }) {
                // A path reopened between an external replacement and its notification
                // focuses its existing buffer; only explicit reload may adopt a new lease.
                if !self.documents.is_fragment(id) {
                    return self.get_disk_snapshot(id);
                }
                if self
                    .documents
                    .get(id)
                    .is_some_and(|lease| lease.identity != super::identity::identify(&file, &path))
                {
                    return Err(AppError::new(
                        ErrorCode::Conflict,
                        "外部替换已改变预览文件，请重新载入原标签。",
                    ));
                }
                if self.documents.is_text_preview(id) {
                    let id = id.to_owned();
                    return self.open_text_preview(reference, file, Some(&id));
                }
            }
        }
        if requested_mode == OpenRequestMode::TextPreview {
            let identity = super::identity::identify(&file, &path);
            if let Some(id) = self.documents.owner_of(&identity) {
                if !self.documents.is_fragment(id) {
                    return self.get_disk_snapshot(id);
                }
            }
            return self.open_text_preview(reference, file, preferred_document_id);
        }
        let initial_size = file.metadata().map_err(crate::models::io_error)?.len();
        match (OpenPolicy::for_size(initial_size), requested_mode) {
            (OpenPolicy::LargeReadOnly, OpenRequestMode::Auto) => {
                return self.open_large_readonly(reference, file, preferred_document_id);
            }
            (OpenPolicy::HeadPreviewOnly, OpenRequestMode::HeadPreview) => {
                return self.open_head_preview(reference, file, preferred_document_id);
            }
            (OpenPolicy::HeadPreviewOnly, OpenRequestMode::Auto) => {
                return Err(AppError::new(
                    ErrorCode::TooLarge,
                    "文件超过100MiB；请明确选择前1MiB只读预览。",
                ));
            }
            (_, OpenRequestMode::HeadPreview) => {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "限量预览仅用于超过100MiB的文件。",
                ));
            }
            _ => {}
        }
        self.open_editable_snapshot(
            reference,
            file,
            initial_size,
            preferred_document_id,
            encoding,
        )
    }

    fn open_editable_snapshot(
        &mut self,
        reference: FileRef,
        file: std::fs::File,
        initial_size: u64,
        preferred_document_id: Option<&str>,
        encoding: Option<&str>,
    ) -> Result<OpenDocument, AppError> {
        let limit = OpenPolicy::for_size(initial_size)
            .editable_read_limit()
            .expect("editable policies have a read limit");
        let snapshot = match read_snapshot(file, limit) {
            Ok(snapshot) => snapshot,
            Err(error) if error.code == ErrorCode::TooLarge => {
                let (latest, _) = self.grants.open_file(&reference)?;
                let latest_size = latest.metadata().map_err(crate::models::io_error)?.len();
                return match OpenPolicy::for_size(latest_size) {
                    OpenPolicy::LargeReadOnly => {
                        self.open_large_readonly(reference, latest, preferred_document_id)
                    }
                    OpenPolicy::HeadPreviewOnly => Err(AppError::new(
                        ErrorCode::TooLarge,
                        "文件在读取期间增长到100MiB以上；请明确选择前1MiB只读预览。",
                    )),
                    _ => Err(AppError::new(
                        ErrorCode::Conflict,
                        "文件在读取期间发生变化，请重新打开。",
                    )),
                };
            }
            Err(error) => return Err(error),
        };
        let decoded = super::encoding::decode_text(&snapshot.bytes, encoding)?;
        let source = decoded.text.as_str();
        let long_line = has_long_line(source);
        let degraded =
            OpenPolicy::for_size(snapshot.metadata.size_bytes) == OpenPolicy::Degraded || long_line;
        let controls = source
            .chars()
            .filter(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            .count();
        if source.contains('\0') || controls > source.chars().count() / 100 {
            return Err(AppError::new(
                ErrorCode::IsBinary,
                "文件可能是二进制，无法作为普通文本打开。",
            ));
        }
        let (text, endings) = normalize_newlines(source);
        let has_cr = endings.iter().any(|e| matches!(e, Newline::Cr));
        let has_lf = endings.iter().any(|e| matches!(e, Newline::Lf));
        let has_crlf = endings.iter().any(|e| matches!(e, Newline::Crlf));
        let line_ending = if has_cr || (has_lf && has_crlf) {
            "mixed"
        } else if has_lf {
            "lf"
        } else {
            "crlf"
        };
        let mut warnings = if has_cr {
            vec!["文件含孤立CR换行，请确认原始格式。".into()]
        } else {
            vec![]
        };
        if degraded {
            warnings
                .push("已使用纯文本降级模式：语法高亮、补全、折叠和实时 Markdown 已关闭。".into());
        }
        if long_line {
            warnings.push("文件含超过100,000字符的长行。".into());
        }
        if matches!(snapshot.identity, FileIdentity::Canonical(_)) {
            warnings.push("文件系统未提供稳定文件标识，当前按规范路径识别。".into());
        }
        let canonical_identity = canonical_identity(&snapshot.identity);
        let document_id = self.documents.register_preferred(
            DocumentLease {
                identity: snapshot.identity,
                reference: reference.clone(),
                path: snapshot.path,
                file: snapshot.file,
            },
            preferred_document_id,
        )?;
        self.documents.set_encoding(&document_id, decoded.encoding);
        Ok(OpenDocument {
            document_id,
            canonical_identity,
            reference,
            metadata: snapshot.metadata,
            format: TextFormat {
                encoding: decoded.encoding.into(),
                bom: decoded.bom.into(),
                line_ending: line_ending.into(),
            },
            warnings,
            mode: if degraded { "degraded" } else { "normal" },
            content: OpenDocumentContent::Text {
                text,
                newline_map: NewlineMap {
                    document_version: 0,
                    endings,
                },
            },
        })
    }

    pub fn read_document_chunk(
        &mut self,
        request: ReadChunkRequest,
    ) -> Result<TextChunk, AppError> {
        if request.max_bytes == 0 || request.max_bytes > MAX_CHUNK_BYTES {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "分块读取大小必须在1字节到1MiB之间。",
            ));
        }
        if request.expected_disk_revision.len() != 64
            || !request
                .expected_disk_revision
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(AppError::new(ErrorCode::InvalidInput, "磁盘版本无效。"));
        }
        let owner = self
            .documents
            .chunk_document(&request.handle_id)
            .filter(|owner| *owner == request.document_id)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "分块句柄无效或已释放。"))?;
        let document = self
            .documents
            .get(owner)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "此文档未打开。"))?;
        let total = document
            .file
            .metadata()
            .map_err(crate::models::io_error)?
            .len();
        if request.byte_offset > total {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "读取起点超出文件范围。",
            ));
        }
        let raw_start = request.byte_offset.saturating_sub(4);
        let raw_end = request
            .byte_offset
            .saturating_add(request.max_bytes)
            .saturating_add(8)
            .min(total.saturating_add(MAX_WINDOW_BYTES));
        let snapshot = read_stream_snapshot(
            document.file.try_clone().map_err(crate::models::io_error)?,
            super::save::MAX_FILE_BYTES,
            raw_start..raw_end,
        )?;
        if snapshot.identity != document.identity
            || snapshot.path != document.path
            || snapshot.metadata.disk_revision != request.expected_disk_revision
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "磁盘文件已变化，请重新打开后再读取。",
            ));
        }
        let decoded = decode_window(&snapshot, request.byte_offset, request.max_bytes)?;
        let first_line = super::stream_snapshot::line_number_at(
            document.file.try_clone().map_err(crate::models::io_error)?,
            decoded.byte_start,
            snapshot.encoding,
        )?;
        Ok(TextChunk {
            byte_start: decoded.byte_start,
            byte_end: decoded.byte_end,
            first_line,
            text: decoded.text,
            has_more: decoded.byte_end < snapshot.metadata.size_bytes,
        })
    }

    fn open_large_readonly(
        &mut self,
        reference: FileRef,
        file: std::fs::File,
        preferred_document_id: Option<&str>,
    ) -> Result<OpenDocument, AppError> {
        let snapshot = read_stream_snapshot(
            file,
            super::save::MAX_FILE_BYTES,
            0..INITIAL_CHUNK_BYTES + 8,
        )?;
        if OpenPolicy::for_size(snapshot.metadata.size_bytes) != OpenPolicy::LargeReadOnly {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "读取期间文件大小发生变化，请重新打开。",
            ));
        }
        let decoded = decode_window(&snapshot, 0, INITIAL_CHUNK_BYTES)?;
        let format = stream_format(snapshot.encoding, snapshot.newlines);
        let canonical_identity = canonical_identity(&snapshot.identity);
        let document_id = self.documents.register_preferred(
            DocumentLease {
                identity: snapshot.identity,
                reference: reference.clone(),
                path: snapshot.path,
                file: snapshot.file,
            },
            preferred_document_id,
        )?;
        self.documents.mark_fragment(&document_id);
        let handle_id = self
            .documents
            .issue_chunk_handle(&document_id)
            .ok_or_else(|| AppError::new(ErrorCode::Internal, "无法建立只读分块句柄。"))?;
        Ok(OpenDocument {
            document_id,
            canonical_identity,
            reference,
            metadata: snapshot.metadata.clone(),
            format,
            warnings: vec![
                "文件从20MiB起以只读分块模式打开；保存、另存和批量工具均不可用。".into(),
            ],
            mode: "large-readonly",
            content: OpenDocumentContent::Chunked {
                handle_id,
                initial_chunk: TextChunk {
                    byte_start: decoded.byte_start,
                    byte_end: decoded.byte_end,
                    first_line: 1,
                    text: decoded.text,
                    has_more: decoded.byte_end < snapshot.metadata.size_bytes,
                },
                total_bytes: snapshot.metadata.size_bytes,
            },
        })
    }

    fn open_head_preview(
        &mut self,
        reference: FileRef,
        file: std::fs::File,
        preferred_document_id: Option<&str>,
    ) -> Result<OpenDocument, AppError> {
        let snapshot = read_stream_snapshot(file, u64::MAX, 0..HEAD_PREVIEW_BYTES + 8)?;
        if OpenPolicy::for_size(snapshot.metadata.size_bytes) != OpenPolicy::HeadPreviewOnly {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "读取期间文件大小发生变化，请重新打开。",
            ));
        }
        let decoded = decode_window(&snapshot, 0, HEAD_PREVIEW_BYTES)?;
        let format = stream_format(snapshot.encoding, snapshot.newlines);
        let canonical_identity = canonical_identity(&snapshot.identity);
        let document_id = self.documents.register_preferred(
            DocumentLease {
                identity: snapshot.identity,
                reference: reference.clone(),
                path: snapshot.path,
                file: snapshot.file,
            },
            preferred_document_id,
        )?;
        self.documents.mark_fragment(&document_id);
        Ok(OpenDocument {
            document_id,
            canonical_identity,
            reference,
            metadata: snapshot.metadata.clone(),
            format,
            warnings: vec!["已按选择只加载前1MiB；内容已截断且只读，不能保存或另存。".into()],
            mode: "head-preview",
            content: OpenDocumentContent::Head {
                text: decoded.text,
                preview_bytes: decoded.byte_end,
                total_bytes: snapshot.metadata.size_bytes,
                truncated: true,
            },
        })
    }
}

pub(super) fn canonical_identity(identity: &FileIdentity) -> String {
    format!("{:x}", Sha256::digest(identity.revision_tag()))
}

fn stream_format(encoding: StreamEncoding, newlines: NewlineStats) -> TextFormat {
    let line_ending = if newlines.has_cr || (newlines.has_lf && newlines.has_crlf) {
        "mixed"
    } else if newlines.has_lf {
        "lf"
    } else {
        "crlf"
    };
    TextFormat {
        encoding: encoding.encoding().into(),
        bom: encoding.bom().into(),
        line_ending: line_ending.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{FileService, OpenDocumentContent};
    use crate::services::{grants::GrantKind, open_policy::CHUNKED_THRESHOLD};
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        path::PathBuf,
    };

    #[test]
    fn oversized_read_is_reclassified_from_an_observed_editable_size() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts/T103/reclassified")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("grew-during-open.txt");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let buffer = [b'a'; 64 * 1024];
        let mut remaining = CHUNKED_THRESHOLD + 1;
        while remaining > 0 {
            let length = buffer.len().min(remaining as usize);
            file.write_all(&buffer[..length]).unwrap();
            remaining -= length as u64;
        }
        file.sync_all().unwrap();
        drop(file);

        let mut service = FileService::default();
        let reference = service
            .grants
            .register_selection(&path, GrantKind::File)
            .unwrap();
        let (file, _) = service.grants.open_file(&reference).unwrap();
        let opened = service
            .open_editable_snapshot(reference, file, CHUNKED_THRESHOLD - 1, None, None)
            .unwrap();
        assert_eq!(opened.mode, "large-readonly");
        assert!(matches!(
            opened.content,
            OpenDocumentContent::Chunked { .. }
        ));
    }
}
