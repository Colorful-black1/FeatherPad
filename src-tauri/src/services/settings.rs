use super::{
    grants::opened_file_path, recovery::reject_reparse_chain, save_journal::write_new_verified,
    snapshot::read_snapshot, windows_file,
};
use crate::models::{io_error, AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub const MAX_SETTINGS_BYTES: u64 = 65_536;
const MAX_VERSION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsFile {
    schema_version: u32,
    version: u64,
    settings: Map<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSettings {
    pub schema_version: u32,
    pub version: u64,
    pub revision: Option<String>,
    pub settings: Map<String, Value>,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSettings {
    pub version: u64,
    pub revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSettingsRequest {
    pub expected_version: u64,
    pub expected_revision: Option<String>,
    pub settings: Map<String, Value>,
}

pub struct SettingsStore {
    root: PathBuf,
}
struct CurrentSettings {
    value: SettingsFile,
    revision: String,
    bytes: Vec<u8>,
}

impl SettingsStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn load(&self) -> Result<LoadedSettings, AppError> {
        let root = self.root()?;
        let target = root.join("settings.json");
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _lock = settings_guard(&root)?;
        let mut warning = None;
        let current = match read_settings(&target) {
            Ok(current) => current,
            Err(error) if error.code == ErrorCode::InvalidInput => {
                let isolated = root.join(format!("settings.corrupt-{}.json", uuid::Uuid::new_v4()));
                windows_file::move_no_replace(
                    &target,
                    &isolated,
                    "隔离目标已存在，原设置仍保留。",
                )?;
                warning = Some("设置文件损坏，已隔离并保留原件；当前使用默认值。".into());
                None
            }
            Err(error) => return Err(error),
        };
        if current.is_some() {
            cleanup_backups(&root);
        }
        Ok(LoadedSettings {
            schema_version: 1,
            version: current.as_ref().map_or(0, |current| current.value.version),
            revision: current.as_ref().map(|current| current.revision.clone()),
            settings: current.map_or_else(Map::new, |current| current.value.settings),
            warning,
        })
    }

    pub fn save(&self, request: SaveSettingsRequest) -> Result<SavedSettings, AppError> {
        validate_settings(&request.settings)?;
        if request.expected_version >= MAX_VERSION
            || request.expected_revision.as_ref().is_some_and(|revision| {
                revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(invalid());
        }
        let root = self.root()?;
        let target = root.join("settings.json");
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _lock = settings_guard(&root)?;
        let current = read_settings(&target)?;
        if current.as_ref().map_or(0, |current| current.value.version) != request.expected_version
            || current.as_ref().map(|current| current.revision.as_str())
                != request.expected_revision.as_deref()
        {
            return Err(conflict());
        }
        let value = SettingsFile {
            schema_version: 1,
            version: request.expected_version + 1,
            settings: request.settings,
        };
        let bytes = serde_json::to_vec_pretty(&value).map_err(|_| invalid())?;
        if bytes.len() as u64 > MAX_SETTINGS_BYTES {
            return Err(too_large());
        }
        let id = uuid::Uuid::new_v4();
        let temporary = root.join(format!("settings-{id}.tmp"));
        let backup = root.join(format!("settings-{id}.bak"));
        write_new_verified(&temporary, &bytes)?;
        let latest = read_settings(&target)?;
        if latest.as_ref().map(|current| current.revision.as_str())
            != request.expected_revision.as_deref()
        {
            return Err(conflict());
        }
        if current.is_some() {
            windows_file::replace(&target, &temporary, &backup)?;
        } else {
            windows_file::move_no_replace(&temporary, &target, "设置在写入期间出现，请重新读取。")?;
        }
        let saved = read_settings(&target)?.ok_or_else(invalid)?;
        if saved.bytes != bytes {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "设置写后校验失败；旧副本保留，当前选择仅本次生效。",
            ));
        }
        // The settings restore feature is gone; keep only the live file so repeated
        // saves do not accumulate backup copies.
        cleanup_backups(&root);
        Ok(SavedSettings {
            version: value.version,
            revision: saved.revision,
        })
    }

    fn root(&self) -> Result<PathBuf, AppError> {
        if !self.root.is_absolute() {
            return Err(invalid());
        }
        reject_reparse_chain(&self.root)?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        reject_reparse_chain(&self.root)?;
        self.root.canonicalize().map_err(io_error)
    }
}

fn read_settings(target: &Path) -> Result<Option<CurrentSettings>, AppError> {
    reject_reparse_chain(target)?;
    let file = match File::open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    let snapshot = read_snapshot(file, MAX_SETTINGS_BYTES)?;
    if snapshot.path != target {
        return Err(AppError::new(
            ErrorCode::OutOfScope,
            "设置路径已变化，已停止访问。",
        ));
    }
    let raw: Value = serde_json::from_slice(&snapshot.bytes).map_err(|_| invalid())?;
    if raw
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .is_some_and(|version| version > 1)
    {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "设置来自较新版本，已保留原件；当前只能使用临时设置。",
        ));
    }
    let value: SettingsFile = serde_json::from_value(raw).map_err(|_| invalid())?;
    if value.schema_version != 1 || value.version > MAX_VERSION {
        return Err(invalid());
    }
    validate_settings(&value.settings)?;
    Ok(Some(CurrentSettings {
        value,
        revision: snapshot.metadata.disk_revision,
        bytes: snapshot.bytes,
    }))
}

pub fn validate_settings(settings: &Map<String, Value>) -> Result<(), AppError> {
    fn safe(value: &Value, depth: usize, nodes: &mut usize) -> bool {
        *nodes += 1;
        if depth > 16 || *nodes > 4096 {
            return false;
        }
        match value {
            Value::Array(values) => {
                values.len() <= 256 && values.iter().all(|value| safe(value, depth + 1, nodes))
            }
            Value::Object(values) => {
                values.len() <= 256
                    && values.iter().all(|(key, value)| {
                        !key.is_empty()
                            && key.len() <= 256
                            && !key.contains('\0')
                            && !matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
                            && safe(value, depth + 1, nodes)
                    })
            }
            _ => true,
        }
    }
    let value = Value::Object(settings.clone());
    if !safe(&value, 0, &mut 0) {
        return Err(invalid());
    }
    if serde_json::to_vec(&value).map_err(|_| invalid())?.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(too_large());
    }
    Ok(())
}

fn cleanup_backups(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.take(4096).flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("settings-") || !(name.ends_with(".bak") || name.ends_with(".tmp")) {
            continue;
        }
        let _ = fs::remove_file(entry.path());
    }
}

fn settings_guard(root: &Path) -> Result<File, AppError> {
    let path = root.join(".settings.lock");
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
    if opened_file_path(&file)? != path {
        return Err(invalid());
    }
    file.try_lock()
        .map_err(|_| AppError::new(ErrorCode::Busy, "设置正在写入，请稍后重试。"))?;
    Ok(file)
}
fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "设置格式无效，原配置仍保留。")
}
fn too_large() -> AppError {
    AppError::new(ErrorCode::TooLarge, "设置超过64KiB限制，未写入配置。")
}
fn conflict() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "设置已被其他窗口或程序修改，请重新读取并核对；当前选择仍保留。",
    )
}
