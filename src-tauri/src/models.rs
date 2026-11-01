use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NotFound,
    PermissionDenied,
    OutOfScope,
    IsBinary,
    TooLarge,
    Conflict,
    EncodingRequired,
    LossyEncoding,
    DiskFull,
    ReadOnly,
    InvalidInput,
    InvalidPattern,
    Cancelled,
    Unsupported,
    Busy,
    PartialFailure,
    IpcUnavailable,
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl AppError {
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }
}

pub fn io_error(error: std::io::Error) -> AppError {
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return AppError::new(
            ErrorCode::Busy,
            "文件被其他程序锁定，请关闭占用后重试或另存。",
        );
    }
    let (code, message) = match error.kind() {
        std::io::ErrorKind::NotFound => {
            (ErrorCode::NotFound, "所选文件不存在，可能已被移动或删除。")
        }
        std::io::ErrorKind::PermissionDenied => (
            ErrorCode::PermissionDenied,
            "没有权限访问所选文件，请检查文件或目录权限。",
        ),
        std::io::ErrorKind::StorageFull => (
            ErrorCode::DiskFull,
            "磁盘空间不足，保存未完成；当前正文仍保留，请释放空间后重试或另存。",
        ),
        _ => (
            ErrorCode::Internal,
            "无法访问所选文件，请检查文件是否存在及访问权限。",
        ),
    };
    // OS error strings may contain sensitive paths. Never send them verbatim.
    AppError::new(code, message)
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ResultEnvelope<T> {
    Success { ok: bool, value: T },
    Failure { ok: bool, error: AppError },
}

impl<T> From<Result<T, AppError>> for ResultEnvelope<T> {
    fn from(result: Result<T, AppError>) -> Self {
        match result {
            Ok(value) => Self::Success { ok: true, value },
            Err(error) => Self::Failure { ok: false, error },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{io_error, ErrorCode};

    #[test]
    fn windows_disk_full_error_maps_to_actionable_error() {
        let error = io_error(std::io::Error::from_raw_os_error(112));
        assert_eq!(error.code, ErrorCode::DiskFull);
        assert!(error.message.contains("磁盘空间不足"));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRef {
    pub grant_id: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionFailure {
    pub selection_index: usize,
    pub error: AppError,
}

#[derive(Debug, Serialize)]
pub struct ChosenFiles {
    pub grants: Vec<FileRef>,
    pub failures: Vec<SelectionFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChosenFolder {
    pub grant: Option<FileRef>,
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub display_path: String,
    pub size_bytes: u64,
    pub modified_at: String,
    pub is_read_only: bool,
    pub disk_revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Newline {
    Lf,
    Crlf,
    Cr,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewlineMap {
    pub document_version: u64,
    pub endings: Vec<Newline>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFormat {
    pub encoding: String,
    pub bom: String,
    pub line_ending: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    pub document_id: String,
    pub request_id: String,
    pub document_version: u64,
    pub expected_disk_revision: String,
    pub text: String,
    pub format: TextFormat,
    pub newline_map: Option<NewlineMap>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAck {
    pub document_version: u64,
    pub disk_revision: String,
    pub saved_at: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SaveIntent {
    #[default]
    SaveAs,
    Copy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAsRequest {
    pub document_id: String,
    pub request_id: String,
    pub document_version: u64,
    pub text: String,
    pub format: TextFormat,
    pub newline_map: Option<NewlineMap>,
    #[serde(default)]
    pub intent: SaveIntent,
}

impl SaveAsRequest {
    pub fn into_save_request(self, expected_disk_revision: String) -> SaveRequest {
        SaveRequest {
            document_id: self.document_id,
            request_id: self.request_id,
            document_version: self.document_version,
            text: self.text,
            format: self.format,
            newline_map: self.newline_map,
            expected_disk_revision,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAsAck {
    pub document_id: String,
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub metadata: FileMetadata,
    pub ack: SaveAck,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextChunk {
    pub byte_start: u64,
    pub byte_end: u64,
    pub first_line: u64,
    pub text: String,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum OpenDocumentContent {
    Text {
        text: String,
        newline_map: NewlineMap,
    },
    Chunked {
        handle_id: String,
        initial_chunk: TextChunk,
        total_bytes: u64,
    },
    Head {
        text: String,
        preview_bytes: u64,
        total_bytes: u64,
        truncated: bool,
    },
}

impl OpenDocumentContent {
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text { text, .. } | Self::Head { text, .. } => Some(text),
            Self::Chunked { initial_chunk, .. } => Some(&initial_chunk.text),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocument {
    pub document_id: String,
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub metadata: FileMetadata,
    pub format: TextFormat,
    pub warnings: Vec<String>,
    pub mode: &'static str,
    pub content: OpenDocumentContent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadChunkRequest {
    pub document_id: String,
    pub handle_id: String,
    pub expected_disk_revision: String,
    pub byte_offset: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub id: String,
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub name: String,
    pub kind: &'static str,
    pub is_hidden: bool,
    pub is_read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub items: Vec<DirectoryEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListDirectoryRequest {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    #[serde(default)]
    pub show_hidden: bool,
}
