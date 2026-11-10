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
    TrashUnavailable,
    ReadOnly,
    InvalidInput,
    InvalidPattern,
    Cancelled,
    Unsupported,
    Busy,
    PartialFailure,
    SessionIncomplete,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewlineMap {
    pub document_version: u64,
    pub endings: Vec<Newline>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFormat {
    pub encoding: String,
    pub bom: String,
    pub line_ending: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    Image {
        image: ResourceImage,
    },
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
            Self::Image { .. } => None,
            Self::Text { text, .. } | Self::Head { text, .. } => Some(text),
            Self::Chunked { initial_chunk, .. } => Some(&initial_chunk.text),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceImage {
    pub mime: String,
    pub data_base64: String,
    pub size_bytes: u64,
    pub width: Option<usize>,
    pub height: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocument {
    pub document_id: String,
    pub canonical_identity: String,
    pub write_owner_window_id: Option<String>,
    pub writable: bool,
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
pub struct ReleaseDocumentRequest {
    pub document_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDocumentResult {
    pub released: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscardRecoveryRequest {
    pub document_id: String,
    pub through_version: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardRecoveryResult {
    pub document_id: String,
    pub through_version: u64,
    pub discarded: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRecoverySnapshotRequest {
    pub document_id: String,
    pub document_version: u64,
    pub reason: RecoverySnapshotReason,
    pub base_disk_revision: Option<String>,
    pub text: String,
    pub format: TextFormat,
    pub newline_map: Option<NewlineMap>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoverySnapshotReason {
    Periodic,
    HotExit,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshotAck {
    pub document_id: String,
    pub durable_version: u64,
    pub receipt_id: String,
    pub written_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub receipt_id: String,
    pub reason: String,
    pub document_id: String,
    pub buffer_version: u64,
    pub source_path: Option<String>,
    pub source_revision: Option<String>,
    pub format: TextFormat,
    pub newline_map: Option<NewlineMap>,
    pub body_bytes: u64,
    pub body_sha256: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryFailure {
    pub entry_id: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInventory {
    pub entries: Vec<RecoveryEntry>,
    pub failures: Vec<RecoveryFailure>,
    pub startup_warnings: Vec<String>,
    pub storage_bytes: u64,
    pub save_transactions: Vec<SaveTransactionCandidate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTransactionCandidate {
    pub receipt_id: String,
    pub display_name: String,
    pub buffer_version: u64,
    pub body_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSaveTransaction {
    pub receipt_id: String,
    pub display_name: String,
    pub text: String,
    pub format: TextFormat,
    pub newline_map: NewlineMap,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRecoveryEntriesRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadRecoveryEntryRequest {
    pub receipt_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedRecoveryEntry {
    pub entry: RecoveryEntry,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSelection {
    pub anchor: u64,
    pub head: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionView {
    pub view_id: String,
    pub buffer_version: u64,
    pub document_id: String,
    pub recovery_receipt_id: Option<String>,
    pub file_ref: Option<FileRef>,
    pub disk_revision: Option<String>,
    pub open_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding_override: Option<String>,
    pub title: String,
    pub display_path: Option<String>,
    pub is_preview: bool,
    pub dirty: bool,
    pub selection: Vec<SessionSelection>,
    pub scroll_anchor: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionGroup {
    pub group_id: String,
    pub view_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionWindow {
    pub window_id: String,
    pub bounds: SessionBounds,
    pub root_ids: Vec<String>,
    pub root_labels: Vec<String>,
    pub active_view_id: Option<String>,
    pub groups: Vec<SessionGroup>,
    pub views: Vec<SessionView>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionManifest {
    pub schema_version: u32,
    pub session_id: String,
    pub windows: Vec<SessionWindow>,
    pub recovery_snapshot_refs: Vec<String>,
    pub persisted_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSessionRequest {
    pub manifest: SessionManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadSessionRequest {
    #[serde(default)]
    pub restore_grant_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearSessionRequest {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadResult {
    pub session: Option<SessionManifest>,
    pub warning: Option<String>,
    pub restored_grant_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSaveResult {
    pub saved: bool,
    pub persisted_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClearResult {
    pub cleared: bool,
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
    pub revision: String,
    pub modified_at: Option<String>,
    pub created_at: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEntryRequest {
    pub parent: FileRef,
    pub name: String,
    pub kind: EntryKind,
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameEntryRequest {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub new_name: String,
    pub expected_revision: Option<String>,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedDocument {
    pub document_id: String,
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameEntryResult {
    pub entry: DirectoryEntry,
    pub renamed_documents: Vec<RenamedDocument>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Move,
    Copy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferEntryRequest {
    pub source: FileRef,
    pub target_parent: FileRef,
    pub mode: TransferMode,
    pub expected_revision: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEntryResult {
    pub entry: DirectoryEntry,
    pub renamed_documents: Vec<RenamedDocument>,
    pub mode: TransferMode,
    pub source_removed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDropEntry {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_name: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashImpactRequest {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashDocument {
    pub document_id: String,
    pub display_path: String,
    pub can_snapshot: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashImpact {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_path: String,
    pub kind: &'static str,
    pub revision: String,
    pub identity: String,
    pub affected_documents: Vec<TrashDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashEntryRequest {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub expected_revision: String,
    pub expected_identity: String,
    pub request_id: String,
    pub affected_document_ids: Vec<String>,
    pub snapshots: Vec<SaveRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashDraftReceipt {
    pub document_id: String,
    pub document_version: u64,
    pub receipt_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryResult {
    pub trashed: bool,
    pub receipt_id: String,
    pub missing_document_ids: Vec<String>,
    pub drafts: Vec<TrashDraftReceipt>,
}
