use crate::models::{io_error, AppError, ErrorCode};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const APP_IDENTIFIER: &str = "app.featherpad.desktop";
pub const PORTABLE_MARKER: &str = "portable.flag";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeMode {
    Installed,
    Portable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeDataRoot {
    pub mode: RuntimeMode,
    pub root: PathBuf,
}

pub fn application_data_root() -> Result<PathBuf, AppError> {
    Ok(runtime_data_root()?.root)
}

pub fn runtime_data_root() -> Result<RuntimeDataRoot, AppError> {
    let executable = std::env::current_exe().map_err(io_error)?;
    let executable_dir = executable.parent().ok_or_else(|| {
        AppError::new(
            ErrorCode::Unsupported,
            "无法定位 FeatherPad 可执行文件所在目录。",
        )
    })?;
    let portable_marker = executable_dir.join(PORTABLE_MARKER);
    let portable = validate_marker(&portable_marker)?;
    let root = match std::env::var_os("FEATHERPAD_USER_DATA_DIR") {
        Some(directory) => {
            let directory = PathBuf::from(directory);
            if !directory.is_absolute() {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "本地状态目录必须为绝对路径。",
                ));
            }
            directory
        }
        None if portable => executable_dir.join("data"),
        None => {
            let local = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
                AppError::new(
                    ErrorCode::Unsupported,
                    "Windows 本地应用数据目录不可用，无法保存设置、恢复和会话。",
                )
            })?;
            PathBuf::from(local).join(APP_IDENTIFIER)
        }
    };
    ensure_owned_directory(&root).map_err(|error| {
        if portable {
            AppError::new(
                error.code,
                &format!(
                    "便携模式数据目录不可用或不可写：{}。请将整个程序移到可写目录，或移除程序同目录的 {PORTABLE_MARKER} 以使用安装版数据目录。原错误：{}",
                    root.display(),
                    error.message
                ),
            )
        } else {
            error
        }
    })?;
    verify_writable(&root).map_err(|error| {
        let message = if portable {
            format!(
                    "便携模式数据目录不可写：{}。请将程序移到可写目录，或移除程序同目录的 {PORTABLE_MARKER}。原错误：{}",
                    root.display(),
                    error.message
                )
        } else {
            format!(
                "应用数据目录不可写：{}。原错误：{}",
                root.display(),
                error.message
            )
        };
        AppError::new(error.code, &message)
    })?;
    Ok(RuntimeDataRoot {
        mode: if portable {
            RuntimeMode::Portable
        } else {
            RuntimeMode::Installed
        },
        root,
    })
}

pub fn coordination_root() -> Result<PathBuf, AppError> {
    let root = application_data_root()?.join("coordination");
    ensure_owned_directory(&root)?;
    Ok(root)
}

fn ensure_owned_directory(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_dir() => {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "本地数据路径不是目录，已停止读取其内容。",
            ))
        }
        Ok(metadata) if is_reparse_point(&metadata) => {
            return Err(AppError::new(
                ErrorCode::PermissionDenied,
                "本地数据目录是链接或重解析点，已拒绝使用。",
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(io_error)?;
        }
        Err(error) => return Err(io_error(error)),
    }
    Ok(())
}

fn validate_marker(path: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || is_reparse_point(&metadata) => Err(AppError::new(
            ErrorCode::PermissionDenied,
            &format!("{PORTABLE_MARKER} 必须是普通文件，且不能是链接或重解析点。"),
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn verify_writable(path: &Path) -> Result<(), AppError> {
    let probe = path.join(format!(".write-probe-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .map_err(io_error)?;
        file.write_all(b"featherpad-write-probe")
            .map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        fs::remove_file(&probe).map_err(io_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&probe);
    }
    result
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes()
        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
        != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_root_must_be_absolute() {
        let before = std::env::var_os("FEATHERPAD_USER_DATA_DIR");
        std::env::set_var("FEATHERPAD_USER_DATA_DIR", "relative");
        let error = application_data_root().unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        match before {
            Some(value) => std::env::set_var("FEATHERPAD_USER_DATA_DIR", value),
            None => std::env::remove_var("FEATHERPAD_USER_DATA_DIR"),
        }
    }

    #[test]
    fn portable_marker_selects_adjacent_data_and_rejects_non_file_markers() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts/T403")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(PORTABLE_MARKER), b"portable\n").unwrap();
        assert!(validate_marker(&root.join(PORTABLE_MARKER)).unwrap());

        let marker_directory = root.join("marker-directory");
        fs::create_dir_all(marker_directory.join(PORTABLE_MARKER)).unwrap();
        assert_eq!(
            validate_marker(&marker_directory.join(PORTABLE_MARKER))
                .unwrap_err()
                .code,
            ErrorCode::PermissionDenied
        );
    }

    #[test]
    fn data_directory_must_be_a_real_writable_directory() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts/T403")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let data = root.join("data");
        fs::write(&data, b"not a directory").unwrap();
        assert_eq!(
            ensure_owned_directory(&data).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}
