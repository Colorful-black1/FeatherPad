use super::{
    files::FileService,
    settings::{validate_settings, MAX_SETTINGS_BYTES},
    snapshot::read_snapshot,
};
use crate::models::{AppError, ErrorCode, FileRef};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    pub settings: Map<String, Value>,
    pub revision: Option<String>,
    pub warning: Option<String>,
}

impl FileService {
    pub fn load_workspace_settings(&self, root: FileRef) -> Result<WorkspaceSettings, AppError> {
        if !root.relative_path.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "工作区设置必须使用已授权的根目录。",
            ));
        }
        self.grants.resolve_directory(&root)?;
        let reference = FileRef {
            grant_id: root.grant_id,
            relative_path: ".featherpad/settings.json".into(),
        };
        let (file, _) = match self.grants.open_file(&reference) {
            Ok(file) => file,
            Err(error) if error.code == ErrorCode::NotFound => {
                return Ok(WorkspaceSettings {
                    settings: Map::new(),
                    revision: None,
                    warning: None,
                })
            }
            Err(error) => return Err(error),
        };
        let snapshot = read_snapshot(file, MAX_SETTINGS_BYTES)?;
        let parsed = serde_json::from_slice::<Value>(&snapshot.bytes)
            .ok()
            .and_then(|value| {
                if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                    return None;
                }
                let settings = value.get("settings")?.as_object()?.clone();
                validate_settings(&settings).ok()?;
                Some(settings)
            });
        let warning = parsed
            .is_none()
            .then(|| "工作区设置格式无效或版本不受支持；原文件保留，已使用用户/默认设置。".into());
        Ok(WorkspaceSettings {
            settings: parsed.unwrap_or_default(),
            revision: Some(snapshot.metadata.disk_revision),
            warning,
        })
    }
}
