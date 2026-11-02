use super::{
    save_journal::{digest, write_new_verified},
    windows_file,
};
use crate::models::{io_error, AppError, ErrorCode, SessionLoadResult, SessionManifest};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SESSION_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BUFFER_VERSION: u64 = 9_007_199_254_740_991;

pub struct SessionStore {
    root: PathBuf,
}

impl SessionStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn load(&self) -> Result<SessionLoadResult, AppError> {
        match fs::symlink_metadata(&self.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SessionLoadResult {
                    session: None,
                    warning: None,
                    restored_grant_ids: Vec::new(),
                })
            }
            Err(error) => return Err(io_error(error)),
            Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
            Ok(_) => {}
        }
        reject_reparse_chain(&self.root)?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let manifest = root.join("manifest.json");
        let _parents = windows_file::lock_parent_chain(&manifest)?;
        let _lock = session_guard(&root)?;
        let bytes = match read_bounded(&manifest, MAX_SESSION_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.code == ErrorCode::NotFound => {
                return Ok(SessionLoadResult {
                    session: None,
                    warning: None,
                    restored_grant_ids: Vec::new(),
                })
            }
            Err(error) => return Err(error),
        };
        match serde_json::from_slice::<SessionManifest>(&bytes)
            .map_err(|_| invalid())
            .and_then(validate_manifest)
        {
            Ok(session) => Ok(SessionLoadResult {
                session: Some(session),
                warning: None,
                restored_grant_ids: Vec::new(),
            }),
            Err(_) => {
                let corrupt = root.join(format!("manifest.corrupt-{}.json", uuid::Uuid::new_v4()));
                fs::rename(&manifest, &corrupt).map_err(io_error)?;
                Ok(SessionLoadResult {
                    session: None,
                    warning: Some(
                        "会话清单损坏，已隔离并保留原文件；恢复正文仍可继续读取。".into(),
                    ),
                    restored_grant_ids: Vec::new(),
                })
            }
        }
    }

    pub fn save(&self, manifest: &SessionManifest) -> Result<(), AppError> {
        validate_manifest(manifest.clone())?;
        self.ensure_root()?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let target = root.join("manifest.json");
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _lock = session_guard(&root)?;
        let bytes = serde_json::to_vec(manifest).map_err(|_| invalid())?;
        if bytes.len() as u64 > MAX_SESSION_BYTES {
            return Err(invalid());
        }
        let nonce = uuid::Uuid::new_v4();
        let temporary = root.join(format!("manifest-{nonce}.tmp"));
        let backup = root.join(format!("manifest-{nonce}.bak"));
        write_new_verified(&temporary, &bytes)?;
        let existing_digest = match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(error)),
            Ok(_) => Some(digest(&read_bounded(&target, MAX_SESSION_BYTES)?)),
        };
        match existing_digest.as_ref() {
            None => windows_file::move_no_replace(
                &temporary,
                &target,
                "会话清单在保存期间出现，已停止覆盖。",
            )?,
            Some(_) => windows_file::replace(&target, &temporary, &backup)?,
        }
        let verified = read_bounded(&target, MAX_SESSION_BYTES)?;
        if verified != bytes {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "会话清单写入后校验失败，旧备份仍保留。",
            ));
        }
        if let Some(expected_hash) = existing_digest {
            // Cleanup is best-effort and never removes a backup altered by another process.
            let _ = windows_file::delete_owned_backup(&backup, &expected_hash);
        }
        Ok(())
    }

    pub fn clear(&self) -> Result<(), AppError> {
        match fs::symlink_metadata(&self.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(error)),
            Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
            Ok(_) => {}
        }
        reject_reparse_chain(&self.root)?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let target = root.join("manifest.json");
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _lock = session_guard(&root)?;
        match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        }
    }

    fn ensure_root(&self) -> Result<(), AppError> {
        if !self.root.is_absolute() {
            return Err(invalid());
        }
        reject_reparse_chain(&self.root)?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        reject_reparse_chain(&self.root)
    }
}

pub(crate) fn validate_manifest(manifest: SessionManifest) -> Result<SessionManifest, AppError> {
    if manifest.schema_version != 1
        || !canonical_uuid(&manifest.session_id)
        || manifest.windows.len() > 32
        || manifest.recovery_snapshot_refs.len() > 1000
        || chrono::DateTime::parse_from_rfc3339(&manifest.persisted_at).is_err()
    {
        return Err(invalid());
    }
    let mut refs = HashSet::new();
    for receipt in &manifest.recovery_snapshot_refs {
        if !canonical_uuid(receipt) || !refs.insert(receipt.clone()) {
            return Err(invalid());
        }
    }
    let mut referenced_receipts = HashSet::new();
    let mut window_ids = HashSet::new();
    for window in &manifest.windows {
        if !safe_text(&window.window_id, 128)
            || !window_ids.insert(window.window_id.clone())
            || window.root_ids.len() > 16
            || window.root_ids.len() != window.root_labels.len()
            || window.views.len() > 1000
            || window.groups.len() > 2
            || window.bounds.width == 0
            || window.bounds.height == 0
            || window.bounds.width > 100_000
            || window.bounds.height > 100_000
            || window.bounds.x.unsigned_abs() > 1_000_000
            || window.bounds.y.unsigned_abs() > 1_000_000
        {
            return Err(invalid());
        }
        let mut roots = HashSet::new();
        for (id, label) in window.root_ids.iter().zip(&window.root_labels) {
            if !canonical_uuid(id) || !safe_text(label, 32_767) || !roots.insert(id) {
                return Err(invalid());
            }
        }
        let mut view_ids = HashSet::new();
        let mut grouped = HashSet::new();
        for view in &window.views {
            if !canonical_uuid(&view.view_id)
                || view.buffer_version > MAX_BUFFER_VERSION
                || !canonical_uuid(&view.document_id)
                || !view_ids.insert(view.view_id.clone())
                || view.file_ref.as_ref().is_some_and(|reference| {
                    !canonical_uuid(&reference.grant_id)
                        || !safe_relative_path(&reference.relative_path)
                })
                || view.disk_revision.as_ref().is_some_and(|revision| {
                    revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                || view.file_ref.is_some() != view.disk_revision.is_some()
                || !matches!(
                    view.open_mode.as_str(),
                    "normal" | "head-preview" | "text-preview"
                )
                || !safe_text(&view.title, 32_767)
                || view
                    .display_path
                    .as_ref()
                    .is_some_and(|path| !safe_text(path, 32_767))
                || view.selection.is_empty()
                || view.selection.len() > 16
                || !view.scroll_anchor.is_finite()
                || !(0.0..=1_000_000_000_000.0).contains(&view.scroll_anchor)
                || view.selection.iter().any(|selection| {
                    selection.anchor > MAX_BUFFER_VERSION || selection.head > MAX_BUFFER_VERSION
                })
            {
                return Err(invalid());
            }
            if let Some(receipt) = &view.recovery_receipt_id {
                if !canonical_uuid(receipt) || !refs.contains(receipt) {
                    return Err(invalid());
                }
                referenced_receipts.insert(receipt.clone());
            }
        }
        let mut group_ids = HashSet::new();
        for group in &window.groups {
            if !matches!(group.group_id.as_str(), "primary" | "secondary")
                || !group_ids.insert(group.group_id.clone())
            {
                return Err(invalid());
            }
            for view_id in &group.view_ids {
                if !view_ids.contains(view_id) || !grouped.insert(view_id.clone()) {
                    return Err(invalid());
                }
            }
        }
        if grouped != view_ids
            || window
                .active_view_id
                .as_ref()
                .is_some_and(|id| !view_ids.contains(id))
        {
            return Err(invalid());
        }
    }
    if referenced_receipts != refs {
        return Err(invalid());
    }
    Ok(manifest)
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|id| id.to_string())
        .as_deref()
        == Some(value)
}

fn safe_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty() && !value.contains('\0') && value.chars().count() <= max_chars
}

fn safe_relative_path(value: &str) -> bool {
    if value.encode_utf16().count() > 32_767 || value.contains(['\0', ':']) {
        return false;
    }
    let path = Path::new(value);
    path.components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
        && !value
            .split(['/', '\\'])
            .any(|part| part == "." || part == ".." || part.ends_with([' ', '.']))
}

fn session_guard(root: &Path) -> Result<std::fs::File, AppError> {
    let path = root.join(".session.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path).map_err(io_error)?;
    reject_reparse_chain(&path)?;
    if super::grants::opened_file_path(&file)? != path {
        return Err(invalid());
    }
    file.try_lock()
        .map_err(|_| AppError::new(ErrorCode::Busy, "会话清单正在写入，请等待后重试。"))?;
    Ok(file)
}

fn reject_reparse_chain(path: &Path) -> Result<(), AppError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes()
                        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                        != 0
                    {
                        return Err(AppError::new(
                            ErrorCode::OutOfScope,
                            "会话目录包含链接，已停止访问。",
                        ));
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err(invalid());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, AppError> {
    reject_reparse_chain(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file.metadata().map_err(io_error)?.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
            || super::grants::opened_file_path(&file)? != path
        {
            return Err(invalid());
        }
    }
    if file.metadata().map_err(io_error)?.len() > max_bytes {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > max_bytes {
        return Err(invalid());
    }
    Ok(bytes)
}

fn invalid() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "会话清单格式无效或包含不一致的引用。",
    )
}

pub(crate) fn grant_ids(manifest: &SessionManifest) -> HashSet<String> {
    let mut ids = HashSet::new();
    for window in &manifest.windows {
        ids.extend(window.root_ids.iter().cloned());
        ids.extend(
            window
                .views
                .iter()
                .filter_map(|view| view.file_ref.as_ref())
                .map(|reference| reference.grant_id.clone()),
        );
    }
    ids
}
