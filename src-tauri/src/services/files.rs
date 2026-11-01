use super::grants::GrantRegistry;
use super::{
    documents::{DocumentLease, DocumentRegistry},
    identity::FileIdentity,
    snapshot::read_snapshot,
    text::{decode_basic, normalize_newlines},
};
use crate::models::{
    AppError, ErrorCode, FileRef, Newline, NewlineMap, OpenDocument, TextContent, TextFormat,
};

const NORMAL_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct FileService {
    pub grants: GrantRegistry,
    pub(super) documents: DocumentRegistry,
}

impl FileService {
    pub fn open_document(&mut self, reference: FileRef) -> Result<OpenDocument, AppError> {
        let (file, _) = self.grants.open_file(&reference)?;
        let snapshot = read_snapshot(file, NORMAL_LIMIT)?;
        let decoded = decode_basic(&snapshot.bytes)?;
        let source = decoded.text.as_str();
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
            mode: "normal",
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
