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
    RenameEntryRequest, RenameEntryResult, RenamedDocument,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    path::{Component, Path, PathBuf},
};

const MAX_COMPLETED_OPERATIONS: usize = 256;

#[derive(Clone)]
enum CompletedEntryOperation {
    Created(DirectoryEntry),
    Renamed(RenameEntryResult),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryOperationKind {
    Create,
    Rename,
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
}

impl EntryOperationHistory {
    fn replay(
        &self,
        request_id: &str,
        kind: EntryOperationKind,
        fingerprint: &str,
    ) -> Result<Option<CompletedEntryOperation>, AppError> {
        let Some(recorded) = self.completed.get(request_id) else {
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

    fn record(
        &mut self,
        request_id: String,
        kind: EntryOperationKind,
        fingerprint: String,
        result: CompletedEntryOperation,
    ) {
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

fn validate_request_id(request_id: &str) -> Result<(), AppError> {
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

fn validate_revision(revision: &str) -> Result<(), AppError> {
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
