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
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::StorageFull => ErrorCode::DiskFull,
        _ => ErrorCode::Internal,
    };
    // OS error strings may contain sensitive paths. Never send them verbatim.
    AppError::new(code, "无法访问所选文件，请检查文件是否存在及访问权限。")
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRef {
    pub grant_id: String,
    pub relative_path: String,
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
pub struct TextContent {
    pub kind: &'static str,
    pub text: String,
    pub newline_map: NewlineMap,
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
    pub content: TextContent,
}
