use crate::models::{io_error, AppError, ChosenFiles, ErrorCode, FileRef, SelectionFailure};
use std::collections::HashMap;
use std::fs::{self, File, Metadata};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    File,
    Directory,
}

struct Grant {
    target: PathBuf,
    kind: GrantKind,
}

pub struct ResolvedEntry {
    pub path: PathBuf,
    pub metadata: Metadata,
}

#[derive(Default)]
pub struct GrantRegistry {
    grants: HashMap<String, Grant>,
}

impl GrantRegistry {
    // Results must originate in a native selector/validated OS entry, never an IPC path list.
    pub fn register_file_selections(
        &mut self,
        paths: impl IntoIterator<Item = Result<PathBuf, AppError>>,
    ) -> ChosenFiles {
        let mut chosen = ChosenFiles {
            grants: Vec::new(),
            failures: Vec::new(),
        };
        for (selection_index, path) in paths.into_iter().enumerate() {
            match path.and_then(|path| self.register_selection(&path, GrantKind::File)) {
                Ok(reference) => chosen.grants.push(reference),
                Err(error) => chosen.failures.push(SelectionFailure {
                    selection_index,
                    error,
                }),
            }
        }
        chosen
    }

    // Native save-selector result only; never accept a path through IPC.
    pub fn authorize_new_target(
        &self,
        path: &Path,
    ) -> Result<super::targets::NewFileTarget, AppError> {
        super::targets::NewFileTarget::authorize(path)
    }
    // Only native selectors/validated OS entry points may call this; never an IPC command.
    pub fn register_selection(
        &mut self,
        path: &Path,
        kind: GrantKind,
    ) -> Result<FileRef, AppError> {
        let target = path.canonicalize().map_err(io_error)?;
        let metadata = target.metadata().map_err(io_error)?;
        if !matches!(
            (kind, metadata.is_file(), metadata.is_dir()),
            (GrantKind::File, true, _) | (GrantKind::Directory, _, true)
        ) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "所选项目类型不匹配。",
            ));
        }
        if let Some(existing) = self.grants.iter().find_map(|(grant_id, grant)| {
            (grant.kind == kind && grant.target == target).then(|| grant_id.clone())
        }) {
            return Ok(FileRef {
                grant_id: existing,
                relative_path: String::new(),
            });
        }
        let grant_id = uuid::Uuid::new_v4().to_string();
        self.grants.insert(grant_id.clone(), Grant { target, kind });
        Ok(FileRef {
            grant_id,
            relative_path: String::new(),
        })
    }

    pub fn open_file(&self, reference: &FileRef) -> Result<(File, PathBuf), AppError> {
        validate_reference(reference)?;
        let grant = self
            .grants
            .get(&reference.grant_id)
            .ok_or_else(out_of_scope)?;
        if matches!(grant.kind, GrantKind::File) && !reference.relative_path.is_empty() {
            return Err(out_of_scope());
        }
        let candidate = if reference.relative_path.is_empty() {
            grant.target.clone()
        } else {
            grant.target.join(&reference.relative_path)
        };
        let target = candidate.canonicalize().map_err(io_error)?;
        if !grant.contains(&target) {
            return Err(out_of_scope());
        }
        let file = File::open(&target).map_err(io_error)?;
        // Check the opened object, not just a pre-open path, against junction/symlink races.
        let final_path = opened_file_path(&file)?;
        if !grant.contains(&final_path) {
            return Err(out_of_scope());
        }
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err(AppError::new(ErrorCode::InvalidInput, "请选择文本文件。"));
        }
        Ok((file, final_path))
    }

    pub fn resolve_directory(&self, reference: &FileRef) -> Result<PathBuf, AppError> {
        validate_reference(reference)?;
        let grant = self
            .grants
            .get(&reference.grant_id)
            .ok_or_else(out_of_scope)?;
        if !matches!(grant.kind, GrantKind::Directory) {
            return Err(out_of_scope());
        }
        let candidate = if reference.relative_path.is_empty() {
            grant.target.clone()
        } else {
            grant.target.join(&reference.relative_path)
        };
        let target = candidate.canonicalize().map_err(io_error)?;
        if !grant.contains(&target) || !target.metadata().map_err(io_error)?.is_dir() {
            return Err(out_of_scope());
        }
        Ok(target)
    }

    pub fn resolve_entry(&self, reference: &FileRef) -> Result<ResolvedEntry, AppError> {
        validate_reference(reference)?;
        let grant = self
            .grants
            .get(&reference.grant_id)
            .ok_or_else(out_of_scope)?;
        if !matches!(grant.kind, GrantKind::Directory) || reference.relative_path.is_empty() {
            return Err(out_of_scope());
        }
        let literal = grant.target.join(&reference.relative_path);
        let metadata = fs::symlink_metadata(&literal).map_err(io_error)?;
        ensure_not_reparse_entry(&metadata)?;
        let path = literal.canonicalize().map_err(io_error)?;
        if !grant.contains(&path) || !(metadata.is_file() || metadata.is_dir()) {
            return Err(out_of_scope());
        }
        Ok(ResolvedEntry { path, metadata })
    }

    pub fn root_display_name(&self, reference: &FileRef) -> Option<String> {
        let grant = self.grants.get(&reference.grant_id)?;
        if !matches!(grant.kind, GrantKind::Directory) {
            return None;
        }
        Some(grant.target.file_name().map_or_else(
            || grant.target.to_string_lossy().into_owned(),
            |name| name.to_string_lossy().into_owned(),
        ))
    }
}

impl Grant {
    fn contains(&self, target: &Path) -> bool {
        match self.kind {
            GrantKind::File => target == self.target,
            GrantKind::Directory => target.starts_with(&self.target),
        }
    }
}

fn validate_reference(reference: &FileRef) -> Result<(), AppError> {
    let relative = &reference.relative_path;
    if reference.grant_id.is_empty()
        || reference.grant_id.len() > 128
        || relative.encode_utf16().count() > 32_767
        || relative.contains(['\0', ':'])
        || Path::new(relative)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative
            .split(['/', '\\'])
            .any(|part| part == "." || part == ".." || part.ends_with([' ', '.']))
    {
        return Err(AppError::new(ErrorCode::InvalidInput, "文件引用格式无效。"));
    }
    Ok(())
}

fn out_of_scope() -> AppError {
    AppError::new(ErrorCode::OutOfScope, "文件不在已授权范围内，请重新选择。")
}

pub(super) fn ensure_not_reparse_entry(metadata: &Metadata) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "链接或目录联接不能在文件树中重命名。",
            ));
        }
    }
    #[cfg(not(windows))]
    if metadata.file_type().is_symlink() {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "链接或目录联接不能在文件树中重命名。",
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn opened_file_path(file: &File) -> Result<PathBuf, AppError> {
    use std::ffi::OsString;
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: live File handle, writable buffer of the supplied length, normalized DOS path.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if length == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    if length as usize >= buffer.len() {
        return Err(AppError::new(ErrorCode::InvalidInput, "文件路径过长。"));
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..length as usize],
    )))
}

#[cfg(not(windows))]
pub(crate) fn opened_file_path(_file: &File) -> Result<PathBuf, AppError> {
    Err(AppError::new(
        ErrorCode::Unsupported,
        "当前仅支持Windows原生文件访问。",
    ))
}
