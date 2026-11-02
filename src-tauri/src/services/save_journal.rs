use super::{grants::opened_file_path, snapshot::DiskSnapshot, storage_budget::StorageBudget};
use crate::models::{io_error, AppError, ErrorCode, SaveRequest, TextFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveManifest {
    pub schema_version: u32,
    pub receipt_id: String,
    pub document_id: String,
    pub request_id: String,
    pub document_version: u64,
    pub target: PathBuf,
    pub temporary: PathBuf,
    pub backup: PathBuf,
    pub expected_revision: Option<String>,
    pub original_sha256: String,
    pub body_sha256: String,
    pub original_bytes: u64,
    pub body_bytes: u64,
    pub format: TextFormat,
}

pub struct SaveJournal {
    pub directory: PathBuf,
    pub manifest: SaveManifest,
    _budget: StorageBudget,
}

pub enum SaveStage {
    Staged,
    TemporaryReady,
    Replacing,
    Committed,
    CleanupPending,
}

impl SaveStage {
    fn name(&self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::TemporaryReady => "temporary-ready",
            Self::Replacing => "replacing",
            Self::Committed => "committed",
            Self::CleanupPending => "cleanup-pending",
        }
    }
}

impl SaveJournal {
    pub fn prepare(
        root: &Path,
        request: &SaveRequest,
        before: &DiskSnapshot,
        body: &[u8],
    ) -> Result<Self, AppError> {
        Self::prepare_target(root, request, &before.path, Some(&before.bytes), body)
    }

    pub fn prepare_creation(
        root: &Path,
        request: &SaveRequest,
        target: &Path,
        body: &[u8],
    ) -> Result<Self, AppError> {
        Self::prepare_target(root, request, target, None, body)
    }

    fn prepare_target(
        root: &Path,
        request: &SaveRequest,
        target: &Path,
        original: Option<&[u8]>,
        body: &[u8],
    ) -> Result<Self, AppError> {
        super::recovery::reject_reparse_chain(root)?;
        fs::create_dir_all(root).map_err(io_error)?;
        let root = root.canonicalize().map_err(io_error)?;
        let budget = StorageBudget::lock(&root, "recovery")?;
        let receipt = uuid::Uuid::new_v4().to_string();
        let directory = root.join(&receipt);
        let parent = target
            .parent()
            .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "目标目录无效。"))?;
        let journal = Self {
            directory,
            manifest: SaveManifest {
                schema_version: 1,
                receipt_id: receipt.clone(),
                document_id: request.document_id.clone(),
                request_id: request.request_id.clone(),
                document_version: request.document_version,
                target: target.to_owned(),
                temporary: parent.join(format!(".featherpad-{receipt}.tmp")),
                backup: parent.join(format!(".featherpad-{receipt}.bak")),
                expected_revision: original.map(|_| request.expected_disk_revision.clone()),
                original_sha256: digest(original.unwrap_or_default()),
                body_sha256: digest(body),
                original_bytes: original.unwrap_or_default().len() as u64,
                body_bytes: body.len() as u64,
                format: request.format.clone(),
            },
            _budget: budget,
        };
        let manifest_bytes = serde_json::to_vec(&journal.manifest)
            .map_err(|_| AppError::new(ErrorCode::Internal, "无法建立保存事务记录。"))?;
        let mut required = manifest_bytes.len() as u64
            + original.unwrap_or_default().len() as u64
            + body.len() as u64;
        for stage in [
            SaveStage::Staged,
            SaveStage::TemporaryReady,
            SaveStage::Replacing,
            SaveStage::Committed,
            SaveStage::CleanupPending,
        ] {
            required += journal.stage_bytes(stage)?.len() as u64;
        }
        journal._budget.require_space(required)?;
        fs::create_dir(&journal.directory).map_err(io_error)?;
        journal.persist("manifest.json", &manifest_bytes)?;
        journal.persist("original.bin", original.unwrap_or_default())?;
        journal.persist("body.bin", body)?;
        journal.stage(SaveStage::Staged)?;
        Ok(journal)
    }

    pub fn stage(&self, stage: SaveStage) -> Result<(), AppError> {
        let name = stage.name();
        let bytes = self.stage_bytes(stage)?;
        self.persist(&format!("{name}.json"), &bytes)
    }

    fn stage_bytes(&self, stage: SaveStage) -> Result<Vec<u8>, AppError> {
        serde_json::to_vec(&serde_json::json!({
            "receiptId": self.manifest.receipt_id, "stage": stage.name(),
        }))
        .map_err(|_| AppError::new(ErrorCode::Internal, "无法记录保存阶段。"))
    }

    pub fn failure(&self, mut error: AppError, stage: &str) -> AppError {
        error.message = format!(
            "{} 保存未能确认完成，已保留恢复记录（{}；阶段：{}）。请勿盲目重试。",
            error.message, self.manifest.receipt_id, stage
        );
        error
    }

    fn persist(&self, name: &str, bytes: &[u8]) -> Result<(), AppError> {
        let path = self.directory.join(name);
        write_new_verified(&path, bytes).map_err(|error| self.failure(error, name))
    }
}

pub fn write_new_verified(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let _parents = super::windows_file::lock_parent_chain(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    // Validate the opened object before writing any user bytes, including journal blobs.
    if opened_file_path(&file)? != path {
        return Err(AppError::new(
            ErrorCode::OutOfScope,
            "保存目录已变化，已停止写入。",
        ));
    }
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
