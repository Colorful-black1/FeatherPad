use crate::models::{io_error, AppError, ErrorCode};
use std::{
    fs,
    path::{Path, PathBuf},
};

// No Deserialize: only a trusted native selector may authorize a new destination.
pub struct NewFileTarget {
    path: PathBuf,
}

impl NewFileTarget {
    pub(crate) fn authorize(path: &Path) -> Result<Self, AppError> {
        if !path.is_absolute() || path.to_string_lossy().encode_utf16().count() > 32_767 {
            return Err(invalid_name());
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(invalid_name)?;
        validate_name(name)?;
        let parent = path
            .parent()
            .ok_or_else(invalid_name)?
            .canonicalize()
            .map_err(io_error)?;
        if !parent.is_dir() {
            return Err(invalid_name());
        }
        let target = Self {
            path: parent.join(name),
        };
        target.require_missing()?;
        Ok(target)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn require_missing(&self) -> Result<(), AppError> {
        match fs::symlink_metadata(&self.path) {
            Ok(_) => Err(AppError::new(
                ErrorCode::Conflict,
                "目标已存在，未覆盖；请重新选择并确认覆盖。",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        }
    }
}

fn validate_name(name: &str) -> Result<(), AppError> {
    let base = name.split('.').next().unwrap_or("").to_uppercase();
    let numbered_device = ["COM", "LPT"].iter().any(|prefix| {
        base.strip_prefix(prefix).is_some_and(|suffix| {
            ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&suffix)
        })
    });
    if name.is_empty()
        || name.ends_with([' ', '.'])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
        || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str())
        || numbered_device
    {
        return Err(invalid_name());
    }
    Ok(())
}

fn invalid_name() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "目标文件名无效，不能使用保留设备名、非法字符或末尾空格/点。",
    )
}
