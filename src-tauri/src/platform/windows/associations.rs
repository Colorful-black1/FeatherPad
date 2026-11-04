use crate::{
    models::{AppError, ErrorCode},
    services::data_dir::{runtime_data_root, RuntimeMode},
};
use serde::Serialize;
use std::{
    ffi::c_void,
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_NOT_FOUND, ERROR_PATH_NOT_FOUND,
        ERROR_SUCCESS, WIN32_ERROR,
    },
    System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegDeleteTreeW, RegDeleteValueW, RegGetValueW,
        RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    },
};

const APP_ID: &str = "app.featherpad.desktop";
const MARKER_NAME: &str = "FeatherPadManaged";
const PROG_ID: &str = "FeatherPad.Text";
const APPLICATION_KEY: &str = r"HKCU\Software\Classes\Applications\featherpad.exe";
const PROG_ID_KEY: &str = r"HKCU\Software\Classes\FeatherPad.Text";
const DIRECTORY_MENU_KEY: &str = r"HKCU\Software\Classes\Directory\shell\FeatherPad";
const SUPPORTED_EXTENSIONS: &[&str] = &[
    ".txt",
    ".md",
    ".markdown",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".csv",
    ".log",
    ".ini",
    ".conf",
    ".sql",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub runtime_mode: String,
    pub data_root: String,
    pub executable_path: String,
    pub file_association: bool,
    pub context_menu: bool,
    pub supported_extensions: Vec<String>,
    pub changes_default_app: bool,
}

pub fn status() -> Result<IntegrationStatus, AppError> {
    let executable = executable_path()?;
    let data = runtime_data_root()?;
    Ok(IntegrationStatus {
        runtime_mode: match data.mode {
            RuntimeMode::Installed => "installed",
            RuntimeMode::Portable => "portable",
        }
        .into(),
        data_root: data.root.to_string_lossy().into_owned(),
        executable_path: executable.to_string_lossy().into_owned(),
        file_association: file_association_owned()?,
        context_menu: context_menu_owned()?,
        supported_extensions: SUPPORTED_EXTENSIONS
            .iter()
            .map(|extension| (*extension).to_owned())
            .collect(),
        changes_default_app: false,
    })
}

pub fn apply(file_association: bool, context_menu: bool) -> Result<IntegrationStatus, AppError> {
    let executable = executable_path()?;
    let before = status()?;
    let result = (|| {
        if file_association {
            enable_file_association(&executable)?;
        } else {
            disable_file_association()?;
        }
        if context_menu {
            enable_context_menu(&executable)?;
        } else {
            disable_context_menu()?;
        }
        status()
    })();
    if result.is_err() {
        if !before.file_association {
            let _ = disable_file_association();
        }
        if !before.context_menu {
            let _ = disable_context_menu();
        }
    }
    unsafe {
        windows::Win32::UI::Shell::SHChangeNotify(
            windows::Win32::UI::Shell::SHCNE_ASSOCCHANGED,
            windows::Win32::UI::Shell::SHCNF_IDLIST,
            None,
            None,
        );
    }
    result
}

fn executable_path() -> Result<PathBuf, AppError> {
    let executable = std::env::current_exe().map_err(|error| {
        AppError::new(
            ErrorCode::Internal,
            &format!("无法定位 FeatherPad 可执行文件：{error}"),
        )
    })?;
    if !executable.is_file() || executable.to_string_lossy().contains('"') {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "FeatherPad 可执行文件路径不可用于系统集成。",
        ));
    }
    Ok(executable)
}

fn enable_file_association(executable: &Path) -> Result<(), AppError> {
    ensure_exact_owned_or_absent(PROG_ID_KEY, || prog_id_owned(executable))?;
    ensure_exact_owned_or_absent(APPLICATION_KEY, || application_owned(executable))?;
    if !key_exists(PROG_ID_KEY)? {
        for extension in SUPPORTED_EXTENSIONS {
            if value_exists(
                &format!(r"HKCU\Software\Classes\{extension}\OpenWithProgids"),
                PROG_ID,
            )? {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "已有其他程序使用相同的轻羽“打开方式”注册项；未覆盖现有设置。",
                ));
            }
        }
    }
    let command = format!("\"{}\" \"%1\"", executable.display());
    add(PROG_ID_KEY, None, "轻羽文本文档")?;
    add(
        &format!(r"{PROG_ID_KEY}\DefaultIcon"),
        None,
        &executable.to_string_lossy(),
    )?;
    add(PROG_ID_KEY, Some(MARKER_NAME), APP_ID)?;
    add(
        &format!(r"{PROG_ID_KEY}\shell\open\command"),
        None,
        &command,
    )?;
    add(APPLICATION_KEY, None, "轻羽 FeatherPad")?;
    add(APPLICATION_KEY, Some("FriendlyAppName"), "轻羽 FeatherPad")?;
    add(
        &format!(r"{APPLICATION_KEY}\DefaultIcon"),
        None,
        &executable.to_string_lossy(),
    )?;
    add(APPLICATION_KEY, Some(MARKER_NAME), APP_ID)?;
    add(
        &format!(r"{APPLICATION_KEY}\shell\open\command"),
        None,
        &command,
    )?;
    for extension in SUPPORTED_EXTENSIONS {
        add(
            &format!(r"{APPLICATION_KEY}\SupportedTypes"),
            Some(extension),
            "",
        )?;
        add(
            &format!(r"HKCU\Software\Classes\{extension}\OpenWithProgids"),
            Some(PROG_ID),
            "",
        )?;
    }
    Ok(())
}

fn disable_file_association() -> Result<(), AppError> {
    let executable = executable_path()?;
    let prog_id_is_owned = prog_id_owned(&executable)?;
    let application_is_owned = application_owned(&executable)?;
    if prog_id_is_owned {
        delete_key(PROG_ID_KEY)?;
    }
    if application_is_owned {
        delete_key(APPLICATION_KEY)?;
    }
    if prog_id_is_owned {
        for extension in SUPPORTED_EXTENSIONS {
            let key = format!(r"HKCU\Software\Classes\{extension}\OpenWithProgids");
            if value_matches(&key, Some(PROG_ID), "")? {
                delete_value(&key, PROG_ID)?;
            }
        }
    }
    Ok(())
}

fn enable_context_menu(executable: &Path) -> Result<(), AppError> {
    let command = format!("\"{}\" \"%1\"", executable.display());
    for key in context_menu_keys() {
        ensure_exact_owned_or_absent(&key, || context_menu_key_owned(&key, executable))?;
        add(&key, None, "用轻羽打开")?;
        add(&key, Some("Icon"), &executable.to_string_lossy())?;
        add(&key, Some(MARKER_NAME), APP_ID)?;
        add(&format!(r"{key}\command"), None, &command)?;
    }
    Ok(())
}

fn disable_context_menu() -> Result<(), AppError> {
    let executable = executable_path()?;
    for key in context_menu_keys() {
        if context_menu_key_owned(&key, &executable)? {
            delete_key(&key)?;
        }
    }
    Ok(())
}

fn context_menu_keys() -> Vec<String> {
    let mut keys = SUPPORTED_EXTENSIONS
        .iter()
        .map(|extension| {
            format!(r"HKCU\Software\Classes\SystemFileAssociations\{extension}\shell\FeatherPad")
        })
        .collect::<Vec<_>>();
    keys.push(DIRECTORY_MENU_KEY.to_owned());
    keys
}

fn file_association_owned() -> Result<bool, AppError> {
    let executable = executable_path()?;
    if !prog_id_owned(&executable)? || !application_owned(&executable)? {
        return Ok(false);
    }
    for extension in SUPPORTED_EXTENSIONS {
        if !value_exists(&format!(r"{APPLICATION_KEY}\SupportedTypes"), extension)?
            || !value_exists(
                &format!(r"HKCU\Software\Classes\{extension}\OpenWithProgids"),
                PROG_ID,
            )?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn context_menu_owned() -> Result<bool, AppError> {
    let executable = executable_path()?;
    for key in context_menu_keys() {
        if !context_menu_key_owned(&key, &executable)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn ensure_exact_owned_or_absent(
    key: &str,
    is_owned: impl FnOnce() -> Result<bool, AppError>,
) -> Result<(), AppError> {
    if !key_exists(key)? || is_owned()? {
        return Ok(());
    }
    Err(AppError::new(
        ErrorCode::Conflict,
        "已有其他程序使用相同的轻羽系统集成注册项；未覆盖现有设置。",
    ))
}

fn key_exists(key: &str) -> Result<bool, AppError> {
    let key = RegistryKey::open(key, KEY_READ)?;
    Ok(key.is_some())
}

fn owned(key: &str) -> Result<bool, AppError> {
    value_matches(key, Some(MARKER_NAME), APP_ID)
}

fn prog_id_owned(executable: &Path) -> Result<bool, AppError> {
    if !owned(PROG_ID_KEY)? {
        return Ok(false);
    }
    let command = format!("\"{}\" \"%1\"", executable.display());
    Ok(value_matches(
        &format!(r"{PROG_ID_KEY}\shell\open\command"),
        None,
        &command,
    )? && value_matches(
        &format!(r"{PROG_ID_KEY}\DefaultIcon"),
        None,
        &executable.to_string_lossy(),
    )?)
}

fn application_owned(executable: &Path) -> Result<bool, AppError> {
    if !owned(APPLICATION_KEY)? {
        return Ok(false);
    }
    let command = format!("\"{}\" \"%1\"", executable.display());
    Ok(value_matches(
        &format!(r"{APPLICATION_KEY}\shell\open\command"),
        None,
        &command,
    )? && value_matches(
        &format!(r"{APPLICATION_KEY}\DefaultIcon"),
        None,
        &executable.to_string_lossy(),
    )?)
}

fn context_menu_key_owned(key: &str, executable: &Path) -> Result<bool, AppError> {
    if !owned(key)? {
        return Ok(false);
    }
    let command = format!("\"{}\" \"%1\"", executable.display());
    Ok(value_matches(&format!(r"{key}\command"), None, &command)?
        && value_matches(key, Some("Icon"), &executable.to_string_lossy())?)
}

fn value_exists(key: &str, value: &str) -> Result<bool, AppError> {
    Ok(value_string(key, Some(value))?.is_some())
}

fn value_matches(key: &str, value: Option<&str>, expected: &str) -> Result<bool, AppError> {
    Ok(value_string(key, value)?.is_some_and(|actual| actual == expected))
}

fn add(key: &str, value: Option<&str>, data: &str) -> Result<(), AppError> {
    let key = RegistryKey::create(key)?;
    key.set_string(value, data)
}

fn delete_key(key: &str) -> Result<(), AppError> {
    let subkey = wide_registry_subkey(key);
    let tree_result = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, subkey.as_ptr()) };
    if tree_result != ERROR_SUCCESS && !registry_missing(tree_result) {
        return Err(registry_error("删除轻羽系统集成注册项失败", tree_result));
    }
    let delete_result = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, subkey.as_ptr()) };
    if delete_result == ERROR_SUCCESS || registry_missing(delete_result) {
        return Ok(());
    }
    Err(registry_error("删除轻羽系统集成注册项失败", delete_result))
}

fn delete_value(key: &str, value: &str) -> Result<(), AppError> {
    let Some(key) = RegistryKey::open(key, KEY_WRITE)? else {
        return Ok(());
    };
    let value = wide_value_name(Some(value));
    let result = unsafe { RegDeleteValueW(key.raw(), value.as_ptr()) };
    if result == ERROR_SUCCESS || registry_missing(result) {
        Ok(())
    } else {
        Err(registry_error("删除轻羽系统集成候选值失败", result))
    }
}

fn value_string(key: &str, value: Option<&str>) -> Result<Option<String>, AppError> {
    let subkey = wide_registry_subkey(key);
    let value = wide_value_name(value);
    let mut value_type = 0;
    let mut bytes = 0;
    let size_result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            &mut value_type,
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if registry_missing(size_result) {
        return Ok(None);
    }
    if size_result != ERROR_SUCCESS {
        return Err(registry_error("读取系统集成注册项失败", size_result));
    }
    if bytes > 64 * 1024 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "系统集成注册项超过读取预算。",
        ));
    }
    let mut data = vec![0u16; (bytes as usize).div_ceil(2)];
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            &mut value_type,
            data.as_mut_ptr().cast::<c_void>(),
            &mut bytes,
        )
    };
    if registry_missing(result) {
        return Ok(None);
    }
    if result != ERROR_SUCCESS {
        return Err(registry_error("读取系统集成注册项失败", result));
    }
    while data.last() == Some(&0) {
        data.pop();
    }
    Ok(Some(String::from_utf16_lossy(&data)))
}

struct RegistryKey(HKEY);

impl RegistryKey {
    fn open(key: &str, access: u32) -> Result<Option<Self>, AppError> {
        let subkey = wide_registry_subkey(key);
        let mut handle = std::ptr::null_mut();
        let result =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, access, &mut handle) };
        if result == ERROR_SUCCESS {
            return Ok(Some(Self(handle)));
        }
        if registry_missing(result) {
            return Ok(None);
        }
        Err(registry_error("打开系统集成注册项失败", result))
    }

    fn create(key: &str) -> Result<Self, AppError> {
        let subkey = wide_registry_subkey(key);
        let mut handle = std::ptr::null_mut();
        let mut disposition = 0;
        let result = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                std::ptr::null(),
                &mut handle,
                &mut disposition,
            )
        };
        if result == ERROR_SUCCESS {
            return Ok(Self(handle));
        }
        Err(registry_error("创建系统集成注册项失败", result))
    }

    fn set_string(&self, value: Option<&str>, data: &str) -> Result<(), AppError> {
        let value = wide_value_name(value);
        let data = data
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let bytes = u32::try_from(data.len() * size_of::<u16>())
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "系统集成注册项内容过长。"))?;
        let result = unsafe {
            RegSetValueExW(
                self.raw(),
                value.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast::<u8>(),
                bytes,
            )
        };
        if result == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(registry_error("写入系统集成注册项失败", result))
        }
    }

    fn raw(&self) -> HKEY {
        self.0
    }
}

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn wide_registry_subkey(key: &str) -> Vec<u16> {
    key.strip_prefix(r"HKCU\")
        .unwrap_or(key)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

fn wide_value_name(value: Option<&str>) -> Vec<u16> {
    value
        .unwrap_or("")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

fn registry_missing(error: WIN32_ERROR) -> bool {
    matches!(
        error,
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_NOT_FOUND
    )
}

fn registry_error(context: &str, error: WIN32_ERROR) -> AppError {
    let code = if error == ERROR_ACCESS_DENIED {
        ErrorCode::PermissionDenied
    } else {
        ErrorCode::Internal
    };
    AppError::new(code, &format!("{context}（Windows 错误 {error}）"))
}
