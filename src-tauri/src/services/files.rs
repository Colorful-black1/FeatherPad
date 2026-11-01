use super::grants::GrantRegistry;
use super::{
    documents::{DocumentLease, DocumentRegistry},
    identity::FileIdentity,
    open_policy::{has_long_line, OpenPolicy},
    snapshot::read_snapshot,
    text::{decode_basic, normalize_newlines},
};
use crate::models::{
    AppError, ErrorCode, FileRef, Newline, NewlineMap, OpenDocument, TextContent, TextFormat,
};

#[derive(Default)]
pub struct FileService {
    pub grants: GrantRegistry,
    pub(super) documents: DocumentRegistry,
    pub(super) saves: super::save_requests::SaveHistory,
}

impl FileService {
    pub fn open_document(&mut self, reference: FileRef) -> Result<OpenDocument, AppError> {
        let (file, _) = self.grants.open_file(&reference)?;
        let initial_size = file.metadata().map_err(crate::models::io_error)?.len();
        let limit = OpenPolicy::for_size(initial_size)
            .editable_read_limit()
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::TooLarge,
                    "文件需要只读分块或限量预览，不能作为完整可编辑文本打开。",
                )
            })?;
        let snapshot = read_snapshot(file, limit)?;
        let decoded = decode_basic(&snapshot.bytes)?;
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
        let document_id = self.documents.register(DocumentLease {
            identity: snapshot.identity,
            reference: reference.clone(),
            path: snapshot.path,
            file: snapshot.file,
        });
        Ok(OpenDocument {
            document_id,
            reference,
            metadata: snapshot.metadata,
            format: TextFormat {
                encoding: decoded.encoding.into(),
                bom: decoded.bom.into(),
                line_ending: line_ending.into(),
            },
            warnings,
            mode: if degraded { "degraded" } else { "normal" },
            content: TextContent {
                kind: "text",
                text,
                newline_map: NewlineMap {
                    document_version: 0,
                    endings,
                },
            },
        })
    }
}
