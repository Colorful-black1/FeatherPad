use super::{
    files::FileService,
    grants::{opened_file_path, GrantKind},
    recovery::reject_reparse_chain,
    save_journal::write_new_verified,
    snapshot::read_snapshot,
    windows_file,
};
use crate::models::{io_error, AppError, ErrorCode, FileRef};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    path::{Component, Path, PathBuf},
};

pub const MAX_WORKSPACE_FILE_BYTES: u64 = 65_536;
const MAX_ROOTS: usize = 16;
const WORKSPACE_EXTENSION: &str = "featherpad-workspace";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileRoot {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileConfig {
    pub schema_version: u32,
    pub workspace_id: String,
    pub roots: Vec<WorkspaceFileRoot>,
    pub exclude: Vec<String>,
    pub respect_gitignore: bool,
    pub follow_directory_links: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileDocument {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_name: String,
    pub display_path: String,
    pub revision: String,
    pub config: WorkspaceFileConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveWorkspaceFileRequest {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub expected_revision: String,
    pub config: WorkspaceFileConfig,
}

struct WorkspaceSnapshot {
    revision: String,
    bytes: Vec<u8>,
}

impl FileService {
    pub fn open_workspace_file(&mut self, path: &Path) -> Result<WorkspaceFileDocument, AppError> {
        require_workspace_extension(path)?;
        let reference = self.grants.register_selection(path, GrantKind::File)?;
        self.read_workspace_file(&reference)
    }

    pub fn save_workspace_file(
        &mut self,
        request: SaveWorkspaceFileRequest,
    ) -> Result<WorkspaceFileDocument, AppError> {
        let (file, path) = self.grants.open_file(&request.reference)?;
        require_workspace_extension(&path)?;
        let current = snapshot(file, &path)?;
        if current.revision != request.expected_revision {
            return Err(conflict());
        }
        write_config(&path, &request.config, Some(&current.revision))?;
        self.confirm_workspace_reference(&request.reference, &path)?;
        self.read_workspace_file(&request.reference)
    }

    pub fn save_workspace_file_as(
        &mut self,
        path: &Path,
        config: WorkspaceFileConfig,
    ) -> Result<WorkspaceFileDocument, AppError> {
        require_workspace_extension(path)?;
        reject_reparse_chain(path)?;
        let existing = match File::open(path) {
            Ok(file) => Some(snapshot(file, path)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(error)),
        };
        write_config(
            path,
            &config,
            existing.as_ref().map(|item| item.revision.as_str()),
        )?;
        let reference = self.grants.register_selection(path, GrantKind::File)?;
        self.read_workspace_file(&reference)
    }

    pub fn resolve_workspace_root_candidates(
        &self,
        document: &WorkspaceFileDocument,
    ) -> Vec<String> {
        let base = workspace_parent(&document.display_path);
        document
            .config
            .roots
            .iter()
            .map(|root| {
                let path = PathBuf::from(&root.path);
                if path.is_absolute() {
                    normalized_display(&path)
                } else {
                    normalized_display(&base.join(path))
                }
            })
            .collect()
    }

    fn read_workspace_file(&self, reference: &FileRef) -> Result<WorkspaceFileDocument, AppError> {
        let (file, path) = self.grants.open_file(reference)?;
        require_workspace_extension(&path)?;
        let item = snapshot(file, &path)?;
        let config: WorkspaceFileConfig =
            serde_json::from_slice(&item.bytes).map_err(|_| invalid())?;
        validate_config(&config)?;
        Ok(WorkspaceFileDocument {
            reference: reference.clone(),
            display_name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned()),
            display_path: normalized_display(&path),
            revision: item.revision,
            config,
        })
    }

    fn confirm_workspace_reference(
        &mut self,
        reference: &FileRef,
        path: &Path,
    ) -> Result<(), AppError> {
        let file = File::open(path).map_err(io_error)?;
        if opened_file_path(&file)? != path {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "工作区文件在保存期间被替换，请重新打开后确认。",
            ));
        }
        self.grants.confirm_file_identity(reference, &file, path)
    }
}

fn snapshot(file: File, path: &Path) -> Result<WorkspaceSnapshot, AppError> {
    let item = read_snapshot(file, MAX_WORKSPACE_FILE_BYTES)?;
    if item.path != path {
        return Err(AppError::new(
            ErrorCode::OutOfScope,
            "工作区文件路径已变化，已停止访问。",
        ));
    }
    Ok(WorkspaceSnapshot {
        revision: item.metadata.disk_revision,
        bytes: item.bytes,
    })
}

fn write_config(
    target: &Path,
    config: &WorkspaceFileConfig,
    expected_revision: Option<&str>,
) -> Result<(), AppError> {
    if expected_revision.is_some_and(|revision| !is_revision(revision)) {
        return Err(invalid());
    }
    let parent = target
        .parent()
        .ok_or_else(invalid)?
        .canonicalize()
        .map_err(io_error)?;
    reject_reparse_chain(&parent)?;
    let name = target.file_name().ok_or_else(invalid)?;
    let target = parent.join(name);
    require_workspace_extension(&target)?;
    let portable = portable_config(config, &parent);
    validate_config(&portable)?;
    let bytes = serde_json::to_vec_pretty(&portable).map_err(|_| invalid())?;
    if bytes.len() as u64 > MAX_WORKSPACE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "工作区文件超过64KiB限制，未写入。",
        ));
    }

    let id = uuid::Uuid::new_v4();
    let temporary = parent.join(format!(".featherpad-workspace-{id}.tmp"));
    let backup = parent.join(format!(".featherpad-workspace-{id}.bak"));
    write_new_verified(&temporary, &bytes)?;
    let current = match File::open(&target) {
        Ok(file) => Some(snapshot(file, &target)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(io_error(error)),
    };
    if current.as_ref().map(|item| item.revision.as_str()) != expected_revision {
        return Err(conflict());
    }
    if current.is_some() {
        windows_file::replace(&target, &temporary, &backup)?;
    } else {
        windows_file::move_no_replace(
            &temporary,
            &target,
            "工作区文件在写入期间出现，请重新读取。",
        )?;
    }
    let saved = snapshot(File::open(&target).map_err(io_error)?, &target)?;
    if saved.bytes != bytes {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "工作区文件写后校验失败；原文件或同目录备份仍保留。",
        ));
    }
    Ok(())
}

fn portable_config(config: &WorkspaceFileConfig, parent: &Path) -> WorkspaceFileConfig {
    let mut next = config.clone();
    next.roots = config
        .roots
        .iter()
        .map(|root| WorkspaceFileRoot {
            name: root.name.clone(),
            path: portable_path(&root.path, parent),
        })
        .collect();
    next
}

fn portable_path(value: &str, base: &Path) -> String {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return value.replace('\\', "/");
    }
    let path = fs::canonicalize(&path).unwrap_or(path);
    relative_path(&path, base).unwrap_or_else(|| normalized_display(&path))
}

fn relative_path(path: &Path, base: &Path) -> Option<String> {
    let path_components = path.components().collect::<Vec<_>>();
    let base_components = base.components().collect::<Vec<_>>();
    if path_components.first().map(component_key) != base_components.first().map(component_key) {
        return None;
    }
    let mut common = 0;
    while common < path_components.len()
        && common < base_components.len()
        && component_key(&path_components[common]) == component_key(&base_components[common])
    {
        common += 1;
    }
    let mut parts = vec!["..".to_owned(); base_components.len().saturating_sub(common)];
    parts.extend(
        path_components[common..]
            .iter()
            .filter_map(|component| component.as_os_str().to_str().map(str::to_owned)),
    );
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn component_key(component: &Component<'_>) -> String {
    component.as_os_str().to_string_lossy().to_lowercase()
}

fn validate_config(config: &WorkspaceFileConfig) -> Result<(), AppError> {
    if config.schema_version != 1
        || !canonical_uuid(&config.workspace_id)
        || config.roots.is_empty()
        || config.roots.len() > MAX_ROOTS
        || config.exclude.len() > 256
        || config.exclude.iter().any(|item| !safe_string(item, 1024))
    {
        return Err(invalid());
    }
    for root in &config.roots {
        if !safe_string(&root.name, 128) || !safe_path(&root.path) {
            return Err(invalid());
        }
    }
    let bytes = serde_json::to_vec(config).map_err(|_| invalid())?;
    if bytes.len() as u64 > MAX_WORKSPACE_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "工作区文件超过64KiB限制，未写入。",
        ));
    }
    Ok(())
}

fn safe_string(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.contains('\0')
}

fn safe_path(value: &str) -> bool {
    safe_string(value, 32_767)
        && Path::new(value)
            .components()
            .all(|part| !matches!(part, Component::CurDir))
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|id| id.to_string())
        .as_deref()
        == Some(value)
}

fn is_revision(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn require_workspace_extension(path: &Path) -> Result<(), AppError> {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.to_ascii_lowercase()
                .ends_with(&format!(".{WORKSPACE_EXTENSION}"))
        })
    {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::InvalidInput,
            "请选择扩展名为 .featherpad-workspace 的工作区文件。",
        ))
    }
}

fn workspace_parent(display_path: &str) -> PathBuf {
    Path::new(display_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_owned()
}

fn normalized_display(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).to_owned()
    }
}

fn invalid() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "工作区文件格式无效、版本未知或包含不安全内容；原文件已保留。",
    )
}

fn conflict() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "工作区文件已被其他程序修改，请重新打开并核对。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let name = format!(
            "featherpad-workspace-file-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(name);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn config(root: &Path) -> WorkspaceFileConfig {
        WorkspaceFileConfig {
            schema_version: 1,
            workspace_id: uuid::Uuid::new_v4().to_string(),
            roots: vec![WorkspaceFileRoot {
                name: "项目".into(),
                path: root.to_string_lossy().into_owned(),
            }],
            exclude: vec!["*.tmp".into()],
            respect_gitignore: true,
            follow_directory_links: false,
        }
    }

    #[test]
    fn portable_workspace_round_trips_and_rejects_stale_revision() {
        let root = temp_root();
        let folder = root.join("folder");
        fs::create_dir(&folder).unwrap();
        let file = root.join("project.featherpad-workspace");
        let mut service = FileService::default();
        let first = service
            .save_workspace_file_as(&file, config(&folder))
            .unwrap();
        assert_eq!(first.config.roots[0].path, "folder");
        assert!(service.resolve_workspace_root_candidates(&first)[0].ends_with("folder"));

        let stale = SaveWorkspaceFileRequest {
            reference: first.reference.clone(),
            expected_revision: "0".repeat(64),
            config: first.config.clone(),
        };
        assert_eq!(
            service.save_workspace_file(stale).unwrap_err().code,
            ErrorCode::Conflict
        );
        assert!(file.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn future_or_malformed_workspace_is_rejected() {
        assert_eq!(
            validate_config(&WorkspaceFileConfig {
                schema_version: 2,
                workspace_id: uuid::Uuid::new_v4().to_string(),
                roots: vec![WorkspaceFileRoot {
                    name: "x".into(),
                    path: "x".into(),
                }],
                exclude: vec![],
                respect_gitignore: true,
                follow_directory_links: false,
            })
            .unwrap_err()
            .code,
            ErrorCode::InvalidInput
        );
    }
}
