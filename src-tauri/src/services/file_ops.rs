use super::{
    directories::{entry_id, revision_from_metadata},
    documents::{DetachedDocument, DocumentLease},
    files::FileService,
    grants::ensure_not_reparse_entry,
    identity::identify,
    targets::validate_name,
    windows_file,
};
use crate::models::{
    io_error, AppError, CreateEntryRequest, DirectoryEntry, EntryKind, ErrorCode, FileRef,
    RenameEntryRequest, RenameEntryResult, RenamedDocument, TransferEntryRequest,
    TransferEntryResult, TransferMode, TrashEntryResult,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_COMPLETED_OPERATIONS: usize = 256;
const MAX_TRASH_REQUESTS: usize = 10_000;

#[derive(Clone)]
pub(super) enum CompletedEntryOperation {
    Created(DirectoryEntry),
    Renamed(RenameEntryResult),
    Transferred(TransferEntryResult),
    Trashed(Result<TrashEntryResult, AppError>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum EntryOperationKind {
    Create,
    Rename,
    Transfer,
    Trash,
}

#[derive(Clone)]
struct RecordedEntryOperation {
    kind: EntryOperationKind,
    fingerprint: String,
    result: CompletedEntryOperation,
}

type ReopenedDocuments = (Vec<RenamedDocument>, Vec<(String, DocumentLease)>);

#[derive(Default)]
pub struct EntryOperationHistory {
    completed: HashMap<String, RecordedEntryOperation>,
    order: VecDeque<String>,
    trash_seen: HashMap<String, String>,
}

impl EntryOperationHistory {
    pub(super) fn replay(
        &self,
        request_id: &str,
        kind: EntryOperationKind,
        fingerprint: &str,
    ) -> Result<Option<CompletedEntryOperation>, AppError> {
        let Some(recorded) = self.completed.get(request_id) else {
            if let Some(previous) = self.trash_seen.get(request_id) {
                return Err(
                    if kind != EntryOperationKind::Trash || previous != fingerprint {
                        AppError::new(
                            ErrorCode::InvalidInput,
                            "同一回收请求标识对应了不同内容，已拒绝重放。",
                        )
                    } else {
                        AppError::new(
                            ErrorCode::Conflict,
                            "此回收请求已处理，详细回执已过期；不会重复执行，请刷新后检查。",
                        )
                    },
                );
            }
            if kind == EntryOperationKind::Trash && self.trash_seen.len() >= MAX_TRASH_REQUESTS {
                return Err(AppError::new(
                    ErrorCode::Busy,
                    "本次会话的回收请求已达到安全上限，请重启应用后重新确认。",
                ));
            }
            return Ok(None);
        };
        if recorded.kind != kind || recorded.fingerprint != fingerprint {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "同一文件操作请求标识对应了不同内容，已拒绝重放。",
            ));
        }
        Ok(Some(recorded.result.clone()))
    }

    pub(super) fn record(
        &mut self,
        request_id: String,
        kind: EntryOperationKind,
        fingerprint: String,
        result: CompletedEntryOperation,
    ) {
        if kind == EntryOperationKind::Trash {
            self.trash_seen
                .insert(request_id.clone(), fingerprint.clone());
        }
        self.completed.insert(
            request_id.clone(),
            RecordedEntryOperation {
                kind,
                fingerprint,
                result,
            },
        );
        self.order.push_back(request_id);
        while self.order.len() > MAX_COMPLETED_OPERATIONS {
            if let Some(expired) = self.order.pop_front() {
                self.completed.remove(&expired);
            }
        }
    }
}

impl FileService {
    pub fn create_entry(
        &mut self,
        request: CreateEntryRequest,
    ) -> Result<DirectoryEntry, AppError> {
        validate_request_id(&request.request_id)?;
        validate_name(&request.name)?;
        let fingerprint = create_fingerprint(&request);
        if let Some(CompletedEntryOperation::Created(entry)) = self.entry_operations.replay(
            &request.request_id,
            EntryOperationKind::Create,
            &fingerprint,
        )? {
            return Ok(entry);
        }

        let parent = self.grants.resolve_directory(&request.parent)?;
        let target = parent.join(&request.name);
        validate_target_path(&target)?;
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _directory = windows_file::lock_directory(&parent)?;
        ensure_missing(&target)?;

        match request.kind {
            EntryKind::File => {
                let file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(existing_target)?;
                file.sync_all().map_err(io_error)?;
            }
            EntryKind::Directory => fs::create_dir(&target).map_err(existing_target)?,
        }

        let kind = entry_kind(request.kind);
        let reference = FileRef {
            grant_id: request.parent.grant_id.clone(),
            relative_path: join_relative(&request.parent.relative_path, &request.name),
        };
        let entry = entry_from_path(&reference, &target, kind)?;
        self.entry_operations.record(
            request.request_id,
            EntryOperationKind::Create,
            fingerprint,
            CompletedEntryOperation::Created(entry.clone()),
        );
        Ok(entry)
    }

    pub fn rename_entry(
        &mut self,
        request: RenameEntryRequest,
    ) -> Result<RenameEntryResult, AppError> {
        validate_request_id(&request.request_id)?;
        validate_name(&request.new_name)?;
        let fingerprint = rename_fingerprint(&request);
        if let Some(CompletedEntryOperation::Renamed(result)) = self.entry_operations.replay(
            &request.request_id,
            EntryOperationKind::Rename,
            &fingerprint,
        )? {
            return Ok(result);
        }
        if request.reference.relative_path.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "不能在文件树中重命名已授权根目录。",
            ));
        }

        let source = self.grants.resolve_entry(&request.reference)?;
        let old_name = request
            .reference
            .relative_path
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "当前项目名称无效。"))?;
        if old_name == request.new_name {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "新名称与当前名称相同。",
            ));
        }
        let kind = if source.metadata.is_dir() {
            "directory"
        } else if source.metadata.is_file() {
            "file"
        } else {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "当前项目不是可重命名的文件或目录。",
            ));
        };
        if let Some(expected) = request.expected_revision.as_deref() {
            validate_revision(expected)?;
            let current = revision_from_metadata(old_name, kind, &source.metadata)?;
            if current != expected {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "文件树项目已变化，请刷新后重试。",
                ));
            }
        }

        let parent = source
            .path
            .parent()
            .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "不能重命名卷根目录。"))?;
        let target = parent.join(&request.new_name);
        validate_target_path(&target)?;
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _directory = windows_file::lock_directory(parent)?;

        let latest = fs::symlink_metadata(&source.path).map_err(io_error)?;
        ensure_not_reparse_entry(&latest)?;
        let latest_kind = if latest.is_dir() {
            "directory"
        } else if latest.is_file() {
            "file"
        } else {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "文件树项目已变化，请刷新后重试。",
            ));
        };
        if latest_kind != kind
            || request
                .expected_revision
                .as_deref()
                .is_some_and(|expected| {
                    revision_from_metadata(old_name, kind, &latest)
                        .map(|revision| revision != expected)
                        .unwrap_or(true)
                })
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "文件树项目已变化，请刷新后重试。",
            ));
        }

        let case_only = match fs::symlink_metadata(&target) {
            Ok(_) => {
                if old_name.to_lowercase() != request.new_name.to_lowercase() {
                    return Err(AppError::new(
                        ErrorCode::Conflict,
                        "目标名称已存在，未覆盖。",
                    ));
                }
                let target_path = target.canonicalize().map_err(io_error)?;
                if target_path != source.path {
                    return Err(AppError::new(
                        ErrorCode::Conflict,
                        "目标名称已存在，未覆盖。",
                    ));
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(io_error(error)),
        };

        let detached = if kind == "directory" {
            self.documents.detach_under(&source.path)
        } else {
            Vec::new()
        };
        let move_result = if case_only {
            rename_case_only(&source.path, &target)
        } else {
            windows_file::move_no_replace(&source.path, &target, "目标名称已存在，未覆盖。")
        };
        if let Err(error) = move_result {
            if kind == "directory" {
                return Err(recover_directory_not_moved(
                    self,
                    detached,
                    &source.path,
                    &request.reference,
                    error,
                ));
            }
            return Err(error);
        }

        let new_parent_relative = request
            .reference
            .relative_path
            .rsplit_once(['/', '\\'])
            .map_or("", |(parent, _)| parent);
        let new_reference = FileRef {
            grant_id: request.reference.grant_id.clone(),
            relative_path: join_relative(new_parent_relative, &request.new_name),
        };
        let entry = match entry_from_path(&new_reference, &target, kind) {
            Ok(entry) => entry,
            Err(error) if kind == "directory" => {
                return Err(recover_directory_moved(
                    self,
                    detached,
                    &source.path,
                    &target,
                    &request.reference,
                    case_only,
                    error,
                ));
            }
            Err(error) => return Err(error),
        };
        let renamed_documents = self
            .documents
            .rebase_under(&source.path, &target, &new_reference);
        if kind == "directory" {
            let (mapped_documents, leases) = match reopen_detached_documents(
                self,
                &detached,
                &source.path,
                &target,
                &new_reference,
            ) {
                Ok(reopened) => reopened,
                Err(error) => {
                    return Err(recover_directory_moved(
                        self,
                        detached,
                        &source.path,
                        &target,
                        &request.reference,
                        case_only,
                        error,
                    ));
                }
            };
            if let Err(error) = self.documents.restore_all(leases) {
                return Err(recover_directory_moved(
                    self,
                    detached,
                    &source.path,
                    &target,
                    &request.reference,
                    case_only,
                    error,
                ));
            }
            let result = RenameEntryResult {
                entry,
                renamed_documents: mapped_documents,
            };
            self.entry_operations.record(
                request.request_id,
                EntryOperationKind::Rename,
                fingerprint,
                CompletedEntryOperation::Renamed(result.clone()),
            );
            return Ok(result);
        }
        let result = RenameEntryResult {
            entry,
            renamed_documents,
        };
        self.entry_operations.record(
            request.request_id,
            EntryOperationKind::Rename,
            fingerprint,
            CompletedEntryOperation::Renamed(result.clone()),
        );
        Ok(result)
    }

    pub fn transfer_entry(
        &mut self,
        request: TransferEntryRequest,
    ) -> Result<TransferEntryResult, AppError> {
        validate_request_id(&request.request_id)?;
        validate_revision(&request.expected_revision)?;
        if request.source.relative_path.is_empty() {
            return Err(AppError::new(
                ErrorCode::OutOfScope,
                "不能在文件树中移动或复制已授权根目录。",
            ));
        }
        let fingerprint = transfer_fingerprint(&request);
        if let Some(CompletedEntryOperation::Transferred(result)) = self.entry_operations.replay(
            &request.request_id,
            EntryOperationKind::Transfer,
            &fingerprint,
        )? {
            return Ok(result);
        }
        let source = self.grants.resolve_entry(&request.source)?;
        ensure_not_reparse_entry(&source.metadata)?;
        let kind = if source.metadata.is_dir() {
            "directory"
        } else if source.metadata.is_file() {
            "file"
        } else {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "当前项目不是可移动或复制的文件/目录。",
            ));
        };
        let source_name = source
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::new(ErrorCode::Unsupported, "项目名称无法无损显示。"))?;
        if revision_from_metadata(source_name, kind, &source.metadata)? != request.expected_revision
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "源项目已变化，请刷新后重新拖放。",
            ));
        }
        let target_parent = self.grants.resolve_directory(&request.target_parent)?;
        if kind == "directory" && target_parent.starts_with(&source.path) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "不能把目录移动到自身内部。",
            ));
        }
        let target = target_parent.join(source_name);
        validate_target_path(&target)?;
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _source_parent = windows_file::lock_directory(
            source
                .path
                .parent()
                .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "不能移动卷根目录。"))?,
        )?;
        let _target_parent = windows_file::lock_directory(&target_parent)?;
        ensure_missing(&target)?;
        let target_reference = FileRef {
            grant_id: request.target_parent.grant_id.clone(),
            relative_path: join_relative(&request.target_parent.relative_path, source_name),
        };

        if request.mode == TransferMode::Copy {
            if kind == "directory" {
                copy_tree_verified(&source.path, &target)?;
            } else {
                copy_file_verified(&source.path, &target)?;
            }
            let entry = entry_from_path(&target_reference, &target, kind)?;
            let result = TransferEntryResult {
                entry,
                renamed_documents: Vec::new(),
                mode: request.mode,
                source_removed: false,
            };
            self.entry_operations.record(
                request.request_id,
                EntryOperationKind::Transfer,
                fingerprint,
                CompletedEntryOperation::Transferred(result.clone()),
            );
            return Ok(result);
        }

        let detached = self.documents.detach_under(&source.path);
        let same_volume = same_volume(&source.path, &target_parent)?;
        let operation = if same_volume {
            windows_file::move_no_replace(&source.path, &target, "目标位置已存在，未覆盖。")
        } else {
            let copied = if kind == "directory" {
                copy_tree_verified(&source.path, &target)
            } else {
                copy_file_verified(&source.path, &target)
            };
            if let Err(error) = copied {
                return Err(recover_directory_not_moved(
                    self,
                    detached,
                    &source.path,
                    &request.source,
                    error,
                ));
            }
            let removed = if kind == "directory" {
                fs::remove_dir_all(&source.path)
            } else {
                fs::remove_file(&source.path)
            };
            match removed {
                Ok(()) => Ok(()),
                Err(error) => {
                    let restore = reopen_detached_documents(
                        self,
                        &detached,
                        &source.path,
                        &source.path,
                        &request.source,
                    )
                    .and_then(|(_, leases)| self.documents.restore_all(leases));
                    return Err(AppError::new(
                        ErrorCode::PartialFailure,
                        &format!(
                            "目标已完整复制并校验，但源项目删除失败：{}；{}",
                            io_error(error).message,
                            match restore {
                                Ok(()) => "原文件仍保留，可在刷新后重试。",
                                Err(_) =>
                                    "原文件仍保留，但重新绑定已打开文档失败，请刷新后重新打开。",
                            }
                        ),
                    ));
                }
            }
        };
        if let Err(error) = operation {
            return Err(recover_directory_not_moved(
                self,
                detached,
                &source.path,
                &request.source,
                error,
            ));
        }

        let (renamed_documents, leases) = match reopen_detached_documents(
            self,
            &detached,
            &source.path,
            &target,
            &target_reference,
        ) {
            Ok(reopened) => reopened,
            Err(error) => {
                return Err(AppError::new(
                    ErrorCode::Internal,
                    &format!(
                        "项目已移动到目标，但更新已打开文档失败：{}。请刷新目录并重新打开。",
                        error.message
                    ),
                ));
            }
        };
        if let Err(error) = self.documents.restore_all(leases) {
            return Err(AppError::new(
                ErrorCode::Internal,
                &format!(
                    "项目已移动到目标，但恢复文档句柄失败：{}。请刷新目录并重新打开。",
                    error.message
                ),
            ));
        }
        let entry = entry_from_path(&target_reference, &target, kind)?;
        let result = TransferEntryResult {
            entry,
            renamed_documents,
            mode: request.mode,
            source_removed: true,
        };
        self.entry_operations.record(
            request.request_id,
            EntryOperationKind::Transfer,
            fingerprint,
            CompletedEntryOperation::Transferred(result.clone()),
        );
        Ok(result)
    }
}

fn create_fingerprint(request: &CreateEntryRequest) -> String {
    let mut hash = Sha256::new();
    hash.update(b"create\0");
    hash.update(request.parent.grant_id.as_bytes());
    hash.update([0]);
    hash.update(request.parent.relative_path.as_bytes());
    hash.update([0]);
    hash.update(request.name.as_bytes());
    hash.update([0, entry_kind(request.kind).as_bytes()[0]]);
    format!("{:x}", hash.finalize())
}

fn rename_fingerprint(request: &RenameEntryRequest) -> String {
    let mut hash = Sha256::new();
    hash.update(b"rename\0");
    hash.update(request.reference.grant_id.as_bytes());
    hash.update([0]);
    hash.update(request.reference.relative_path.as_bytes());
    hash.update([0]);
    hash.update(request.new_name.as_bytes());
    hash.update([0]);
    hash.update(request.expected_revision.as_deref().unwrap_or(""));
    format!("{:x}", hash.finalize())
}

fn transfer_fingerprint(request: &TransferEntryRequest) -> String {
    let mut hash = Sha256::new();
    hash.update(b"transfer\0");
    hash.update(request.source.grant_id.as_bytes());
    hash.update([0]);
    hash.update(request.source.relative_path.as_bytes());
    hash.update([0]);
    hash.update(request.target_parent.grant_id.as_bytes());
    hash.update([0]);
    hash.update(request.target_parent.relative_path.as_bytes());
    hash.update([0]);
    hash.update(match request.mode {
        TransferMode::Move => b"move".as_slice(),
        TransferMode::Copy => b"copy".as_slice(),
    });
    hash.update([0]);
    hash.update(request.expected_revision.as_bytes());
    format!("{:x}", hash.finalize())
}

fn same_volume(source: &Path, target_parent: &Path) -> Result<bool, AppError> {
    let source_metadata = fs::symlink_metadata(source).map_err(io_error)?;
    let source_file = if source_metadata.is_dir() {
        windows_file::lock_directory(source)?
    } else {
        fs::File::open(source).map_err(io_error)?
    };
    let target_parent_file = windows_file::lock_directory(target_parent)?;
    let source_identity = identify(&source_file, source);
    let target_identity = identify(&target_parent_file, target_parent);
    Ok(match (source_identity, target_identity) {
        (
            super::identity::FileIdentity::Windows { volume: left, .. },
            super::identity::FileIdentity::Windows { volume: right, .. },
        ) => left == right,
        (
            super::identity::FileIdentity::Canonical(left),
            super::identity::FileIdentity::Canonical(right),
        ) => left.components().next() == right.components().next(),
        _ => false,
    })
}

fn copy_file_verified(source: &Path, target: &Path) -> Result<(), AppError> {
    let source_hash = digest_file(source)?;
    let mut reader = fs::File::open(source).map_err(io_error)?;
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(existing_target)?;
    if let Err(error) = std::io::copy(&mut reader, &mut writer)
        .map_err(io_error)
        .and_then(|_| writer.sync_all().map_err(io_error))
    {
        drop(writer);
        let _ = fs::remove_file(target);
        return Err(error);
    }
    drop(writer);
    let source_metadata = source.metadata().map_err(io_error)?;
    let target_metadata = target.metadata().map_err(io_error)?;
    if source_metadata.len() != target_metadata.len()
        || digest_file(source)? != source_hash
        || digest_file(target)? != source_hash
    {
        let _ = fs::remove_file(target);
        return Err(AppError::new(
            ErrorCode::Conflict,
            "源文件在复制期间变化，目标已清理，请重试。",
        ));
    }
    Ok(())
}

fn copy_tree_verified(source: &Path, target: &Path) -> Result<(), AppError> {
    let source_hash = digest_tree(source)?;
    fs::create_dir(target).map_err(existing_target)?;
    let result = (|| {
        let mut entries = fs::read_dir(source)
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
            ensure_not_reparse_entry(&metadata)?;
            let destination = target.join(entry.file_name());
            if metadata.is_dir() {
                copy_tree_verified(&entry.path(), &destination)?;
            } else if metadata.is_file() {
                copy_file_verified(&entry.path(), &destination)?;
            } else {
                return Err(AppError::new(
                    ErrorCode::Unsupported,
                    "目录中含不支持的链接或特殊项目。",
                ));
            }
        }
        if digest_tree(source)? != source_hash {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "源目录在复制期间变化，请重试。",
            ));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(target);
    }
    result
}

fn digest_file(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn digest_tree(path: &Path) -> Result<String, AppError> {
    fn visit(root: &Path, current: &Path, digest: &mut Sha256) -> Result<(), AppError> {
        let mut entries = fs::read_dir(current)
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let entry_path = entry.path();
            let relative = entry_path
                .strip_prefix(root)
                .map_err(|_| AppError::new(ErrorCode::OutOfScope, "目录复制路径越出授权根。"))?;
            let metadata = fs::symlink_metadata(&entry_path).map_err(io_error)?;
            ensure_not_reparse_entry(&metadata)?;
            let key = relative.to_string_lossy().replace('\\', "/");
            digest.update(key.as_bytes());
            digest.update([0]);
            if metadata.is_dir() {
                digest.update(b"d");
                visit(root, &entry_path, digest)?;
            } else if metadata.is_file() {
                digest.update(b"f");
                digest.update(digest_file(&entry_path)?.as_bytes());
            } else {
                return Err(AppError::new(
                    ErrorCode::Unsupported,
                    "目录中含不支持的链接或特殊项目。",
                ));
            }
        }
        Ok(())
    }
    let mut digest = Sha256::new();
    visit(path, path, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn validate_request_id(request_id: &str) -> Result<(), AppError> {
    if uuid::Uuid::parse_str(request_id).is_err() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "文件操作请求标识无效。",
        ));
    }
    Ok(())
}

fn validate_target_path(path: &Path) -> Result<(), AppError> {
    if path.as_os_str().to_string_lossy().encode_utf16().count() > 32_767 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "目标路径超过Windows长路径限制。",
        ));
    }
    Ok(())
}

pub(super) fn validate_revision(revision: &str) -> Result<(), AppError> {
    if revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "文件树项目版本无效，请刷新后重试。",
        ));
    }
    Ok(())
}

fn ensure_missing(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(AppError::new(
            ErrorCode::Conflict,
            "目标名称已存在，未覆盖。",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn existing_target(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        AppError::new(ErrorCode::Conflict, "目标名称已存在，未覆盖。")
    } else {
        io_error(error)
    }
}

fn rename_case_only(source: &Path, target: &Path) -> Result<(), AppError> {
    let parent = source
        .parent()
        .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "不能重命名卷根目录。"))?;
    let temporary = parent.join(format!(".featherpad-rename-{}.tmp", uuid::Uuid::new_v4()));
    ensure_missing(&temporary)?;
    windows_file::move_no_replace(
        source,
        &temporary,
        "无法建立大小写改名中间项，请刷新后重试。",
    )?;
    if let Err(error) =
        windows_file::move_no_replace(&temporary, target, "目标名称在改名期间出现，未覆盖。")
    {
        return match windows_file::move_no_replace(
            &temporary,
            source,
            "无法回卷大小写改名的中间项。",
        ) {
            Ok(()) => Err(error),
            Err(rollback) => Err(AppError::new(
                ErrorCode::Internal,
                &format!(
                    "大小写改名未完成：{}；原名回卷也失败：{}。请刷新目录并检查文件树。",
                    error.message, rollback.message
                ),
            )),
        };
    }
    Ok(())
}

fn reopen_detached_documents(
    service: &mut FileService,
    detached: &[DetachedDocument],
    old_root: &Path,
    new_root: &Path,
    new_reference: &FileRef,
) -> Result<ReopenedDocuments, AppError> {
    let mut renamed = Vec::with_capacity(detached.len());
    let mut leases = Vec::with_capacity(detached.len());
    for document in detached {
        let Some((reference, expected_path)) =
            rebase_detached_reference(document, old_root, new_root, new_reference)
        else {
            return Err(AppError::new(
                ErrorCode::Internal,
                "目录改名期间的已打开文档路径不一致，请刷新后重试。",
            ));
        };
        let (file, path) = service.grants.open_file(&reference)?;
        let identity = identify(&file, &path);
        if identity != document.identity || path != expected_path {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "目录改名后文件身份发生变化，已尝试恢复原名。",
            ));
        }
        renamed.push(RenamedDocument {
            document_id: document.id.clone(),
            reference: reference.clone(),
            display_path: path.to_string_lossy().into_owned(),
        });
        leases.push((
            document.id.clone(),
            DocumentLease {
                identity,
                reference,
                path,
                file,
            },
        ));
    }
    Ok((renamed, leases))
}

fn rebase_detached_reference(
    document: &DetachedDocument,
    old_root: &Path,
    new_root: &Path,
    new_reference: &FileRef,
) -> Option<(FileRef, PathBuf)> {
    let suffix = document.path.strip_prefix(old_root).ok()?;
    let path = if suffix.as_os_str().is_empty() {
        new_root.to_path_buf()
    } else {
        new_root.join(suffix)
    };
    let mut relative_path = new_reference
        .relative_path
        .trim_end_matches(['/', '\\'])
        .to_owned();
    for component in suffix.components() {
        let Component::Normal(segment) = component else {
            return None;
        };
        if !relative_path.is_empty() {
            relative_path.push('/');
        }
        relative_path.push_str(&segment.to_string_lossy());
    }
    Some((
        FileRef {
            grant_id: new_reference.grant_id.clone(),
            relative_path,
        },
        path,
    ))
}

fn recover_directory_not_moved(
    service: &mut FileService,
    detached: Vec<DetachedDocument>,
    source: &Path,
    source_reference: &FileRef,
    operation_error: AppError,
) -> AppError {
    match reopen_detached_documents(service, &detached, source, source, source_reference)
        .and_then(|(_, leases)| service.documents.restore_all(leases))
    {
        Ok(()) => operation_error,
        Err(reopen_error) => AppError::new(
            ErrorCode::Internal,
            &format!(
                "{}；释放句柄后重新绑定原文件也失败：{}。请刷新目录并重新打开相关文档。",
                operation_error.message, reopen_error.message
            ),
        ),
    }
}

fn recover_directory_moved(
    service: &mut FileService,
    detached: Vec<DetachedDocument>,
    source: &Path,
    target: &Path,
    source_reference: &FileRef,
    case_only: bool,
    operation_error: AppError,
) -> AppError {
    let rollback = if case_only {
        rename_case_only(target, source)
    } else {
        windows_file::move_no_replace(target, source, "原名位置在回卷前被其他项目占用。")
    };
    if let Err(rollback_error) = rollback {
        return AppError::new(
            ErrorCode::Internal,
            &format!(
                "{}；目录改名回卷失败：{}。请刷新目录后检查项目位置。",
                operation_error.message, rollback_error.message
            ),
        );
    }
    match reopen_detached_documents(service, &detached, source, source, source_reference)
        .and_then(|(_, leases)| service.documents.restore_all(leases))
    {
        Ok(()) => operation_error,
        Err(reopen_error) => AppError::new(
            ErrorCode::Internal,
            &format!(
                "{}；目录已回卷但重新绑定已打开文档失败：{}。请刷新目录并重新打开相关文档。",
                operation_error.message, reopen_error.message
            ),
        ),
    }
}

fn entry_from_path(
    reference: &FileRef,
    path: &Path,
    kind: &'static str,
) -> Result<DirectoryEntry, AppError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if (kind == "file" && !metadata.is_file()) || (kind == "directory" && !metadata.is_dir()) {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "文件树项目在操作期间发生变化。",
        ));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::new(ErrorCode::Unsupported, "项目名称无法无损显示。"))?
        .to_owned();
    #[cfg(windows)]
    let (is_hidden, is_read_only) = {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY,
        };
        let attributes = metadata.file_attributes();
        (
            attributes & FILE_ATTRIBUTE_HIDDEN != 0,
            attributes & FILE_ATTRIBUTE_READONLY != 0,
        )
    };
    #[cfg(not(windows))]
    let (is_hidden, is_read_only) = (name.starts_with('.'), metadata.permissions().readonly());
    let timestamps = super::directories::metadata_timestamps(&metadata);
    Ok(DirectoryEntry {
        id: entry_id(&reference.grant_id, &reference.relative_path),
        reference: reference.clone(),
        name,
        kind,
        is_hidden,
        is_read_only,
        revision: revision_from_metadata(
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
            kind,
            &metadata,
        )?,
        modified_at: timestamps.0,
        created_at: timestamps.1,
    })
}

fn entry_kind(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::File => "file",
        EntryKind::Directory => "directory",
    }
}

fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{}/{}", parent.trim_end_matches(['/', '\\']), name)
    }
}
