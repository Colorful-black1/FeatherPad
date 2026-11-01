use super::grants::GrantRegistry;
use super::{
    identity::{identify, FileIdentity},
    text::{decode_basic, normalize_newlines},
};
use crate::models::{
    io_error, AppError, ErrorCode, FileMetadata, FileRef, Newline, NewlineMap, OpenDocument,
    TextContent, TextFormat,
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::Read};

const NORMAL_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct FileService {
    pub grants: GrantRegistry,
    // Keep an open handle per document as an identity lease; std File shares delete on Windows.
    documents: HashMap<FileIdentity, (String, File)>,
}

impl FileService {
    pub fn open_document(&mut self, reference: FileRef) -> Result<OpenDocument, AppError> {
        let (mut file, path) = self.grants.open_file(&reference)?;
        let metadata = file.metadata().map_err(io_error)?;
        if metadata.len() > NORMAL_LIMIT {
            return Err(too_large());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(NORMAL_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() as u64 > NORMAL_LIMIT {
            return Err(too_large());
        }
        let after = file.metadata().map_err(io_error)?;
        let modified = metadata.modified().map_err(io_error)?;
        if metadata.len() != bytes.len() as u64
            || metadata.len() != after.len()
            || modified != after.modified().map_err(io_error)?
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "读取期间文件已变化，请重新打开。",
            ));
        }
        let decoded = decode_basic(&bytes)?;
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
        let mut revision = Sha256::new();
        let identity = identify(&file, &path);
        revision.update(identity.revision_tag());
        revision.update(&bytes);
        revision.update(metadata.len().to_le_bytes());
        let modified_at = chrono::DateTime::<chrono::Utc>::from(modified)
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        revision.update(&modified_at);
        let mut warnings = if has_cr {
            vec!["文件含孤立CR换行，请确认原始格式。".into()]
        } else {
            vec![]
        };
        if matches!(identity, FileIdentity::Canonical(_)) {
            warnings.push("文件系统未提供稳定文件标识，当前按规范路径识别。".into());
        }
        let document_id = self
            .documents
            .entry(identity)
            .or_insert_with(|| (uuid::Uuid::new_v4().to_string(), file))
            .0
            .clone();
        let display = path.to_string_lossy();
        let display_path = if let Some(unc) = display.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}")
        } else {
            display
                .strip_prefix("\\\\?\\")
                .unwrap_or(&display)
                .to_owned()
        };
        Ok(OpenDocument {
            document_id,
            reference,
            metadata: FileMetadata {
                display_path,
                size_bytes: bytes.len() as u64,
                modified_at,
                is_read_only: metadata.permissions().readonly(),
                disk_revision: format!("{:x}", revision.finalize()),
            },
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

fn too_large() -> AppError {
    AppError::new(
        ErrorCode::TooLarge,
        "此文件超过普通文本大小限制，需要大文件打开模式。",
    )
}
