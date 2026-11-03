use super::files::FileService;
use crate::models::{AppError, ErrorCode, FileRef, NativeDropEntry, RenamedDocument};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_name: String,
    pub display_path: String,
    pub canonical_identity: String,
}

impl FileService {
    pub fn register_native_drop(
        &mut self,
        paths: impl IntoIterator<Item = std::path::PathBuf>,
    ) -> Result<Vec<NativeDropEntry>, AppError> {
        let mut entries = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for path in paths.into_iter().take(32) {
            let canonical = path.canonicalize().map_err(crate::models::io_error)?;
            let metadata = std::fs::symlink_metadata(&path).map_err(crate::models::io_error)?;
            if metadata.file_type().is_symlink()
                || !(metadata.is_file() || metadata.is_dir())
                || !seen.insert(canonical.to_string_lossy().to_lowercase())
            {
                continue;
            }
            let kind = if metadata.is_dir() {
                super::grants::GrantKind::Directory
            } else {
                super::grants::GrantKind::File
            };
            let reference = self.grants.register_selection(&path, kind)?;
            entries.push(NativeDropEntry {
                reference,
                display_name: canonical
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| canonical.to_string_lossy().into_owned()),
                is_directory: metadata.is_dir(),
            });
        }
        if entries.is_empty() {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "拖入的项目中没有可打开的文件或目录。",
            ));
        }
        Ok(entries)
    }

    pub fn inspect_workspace_root(&self, reference: &FileRef) -> Result<WorkspaceRoot, AppError> {
        if !reference.relative_path.is_empty() {
            return Err(AppError::new(
                ErrorCode::OutOfScope,
                "工作区必须使用已授权目录根。",
            ));
        }
        let path = self.grants.resolve_directory(reference)?;
        let file = super::windows_file::lock_directory(&path)?;
        Ok(WorkspaceRoot {
            reference: reference.clone(),
            display_name: self
                .grants
                .root_display_name(reference)
                .unwrap_or_else(|| path.to_string_lossy().into_owned()),
            display_path: path.to_string_lossy().into_owned(),
            canonical_identity: format!(
                "{:x}",
                Sha256::digest(super::identity::identify(&file, &path).revision_tag())
            ),
        })
    }

    pub fn release_workspace_root(
        &mut self,
        reference: &FileRef,
        state_root: &std::path::Path,
    ) -> Result<Vec<RenamedDocument>, AppError> {
        if !reference.relative_path.is_empty() {
            return Err(AppError::new(ErrorCode::OutOfScope, "只能移除完整目录根。"));
        }
        if let Some(previous) = self.released_roots.get(&reference.grant_id) {
            return Ok(previous.clone());
        }
        if self.released_roots.len() >= 256 {
            return Err(AppError::new(
                ErrorCode::Busy,
                "根移除回执已达会话上限，请正常退出后重试。",
            ));
        }
        let renamed =
            self.documents
                .release_root(reference, &mut self.grants, |staged, renamed| {
                    let records = renamed
                        .iter()
                        .filter_map(|item| staged.persistent_grant(&item.reference.grant_id))
                        .collect::<Vec<_>>();
                    super::session_grants::SessionGrantStore::new(state_root.to_owned())
                        .save_with_revocations(&records, std::slice::from_ref(&reference.grant_id))
                })?;
        self.released_roots
            .insert(reference.grant_id.clone(), renamed.clone());
        Ok(renamed)
    }
}
