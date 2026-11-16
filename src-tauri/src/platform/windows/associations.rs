use crate::{
    models::{AppError, ErrorCode},
    services::data_dir::{runtime_data_root, RuntimeMode},
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
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
/// Backward-compatible ProgId used for `.txt` (and any extension not in the
/// per-type icon table). Its DefaultIcon still points at the feather file-type
/// icon so the system shows a text-like glyph.
const LEGACY_PROG_ID: &str = "FeatherPad.Text";
const APPLICATION_KEY: &str = r"HKCU\Software\Classes\Applications\featherpad.exe";
const DIRECTORY_MENU_KEY: &str = r"HKCU\Software\Classes\Directory\shell\FeatherPad";

/// Core text extensions shown in the UI status and always associated. Kept at
/// the original set so the public `supportedExtensions` contract (and the
/// settings UI, capped at 64) stays unchanged.
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

/// Every (extension, shape, color) that FeatherPad knows how to open, mirroring
/// `src/features/workspace/file-icons.ts`. The shape/color pair selects the
/// per-type `.ico` served under `icons/filetypes/<shape>-<color>.ico`.
const EXTENSION_ICONS: &[(&str, &str, &str)] = &[
    ("7z", "archive", "gold"),
    ("aac", "audio", "purple"),
    ("avi", "video", "purple"),
    ("avif", "image", "purple"),
    ("bash", "terminal", "green"),
    ("bat", "terminal", "green"),
    ("bin", "binary", "grey"),
    ("bmp", "image", "purple"),
    ("bz2", "archive", "gold"),
    ("c", "code", "blue"),
    ("cc", "code", "blue"),
    ("cfg", "gear", "grey"),
    ("cjs", "code", "yellow"),
    ("cmd", "terminal", "green"),
    ("conf", "gear", "grey"),
    ("cpp", "code", "blue"),
    ("cs", "code", "purple"),
    ("csproj", "html", "orange"),
    ("css", "hash", "blue"),
    ("csv", "sheet", "green"),
    ("cts", "code", "blue"),
    ("cxx", "code", "blue"),
    ("dart", "code", "teal"),
    ("ddl", "database", "pink"),
    ("diff", "git", "orange"),
    ("dll", "binary", "grey"),
    ("dml", "database", "pink"),
    ("doc", "word", "blue"),
    ("docx", "word", "blue"),
    ("dylib", "binary", "grey"),
    ("env", "gear", "yellow"),
    ("eot", "font", "grey"),
    ("erb", "code", "red"),
    ("exe", "binary", "grey"),
    ("fish", "terminal", "green"),
    ("flac", "audio", "purple"),
    ("flv", "video", "purple"),
    ("geojson", "braces", "yellow"),
    ("gif", "image", "purple"),
    ("go", "code", "teal"),
    ("gz", "archive", "gold"),
    ("h", "code", "blue"),
    ("hh", "code", "blue"),
    ("hpp", "code", "blue"),
    ("htm", "html", "orange"),
    ("html", "html", "orange"),
    ("hxx", "code", "blue"),
    ("ico", "image", "purple"),
    ("ini", "gear", "grey"),
    ("iso", "archive", "gold"),
    ("jar", "archive", "gold"),
    ("java", "code", "red"),
    ("jpeg", "image", "purple"),
    ("jpg", "image", "purple"),
    ("js", "code", "yellow"),
    ("json", "braces", "yellow"),
    ("json5", "braces", "yellow"),
    ("jsonc", "braces", "yellow"),
    ("jsx", "react", "sky"),
    ("key", "slides", "orange"),
    ("kt", "code", "purple"),
    ("kts", "code", "purple"),
    ("less", "hash", "pink"),
    ("lock", "lock", "gold"),
    ("log", "text", "grey"),
    ("lua", "code", "blue"),
    ("m4a", "audio", "purple"),
    ("markdown", "markdown", "blue"),
    ("md", "markdown", "blue"),
    ("mdown", "markdown", "blue"),
    ("mdx", "markdown", "blue"),
    ("mjs", "code", "yellow"),
    ("mkd", "markdown", "blue"),
    ("mkv", "video", "purple"),
    ("mov", "video", "purple"),
    ("mp3", "audio", "purple"),
    ("mp4", "video", "purple"),
    ("msi", "binary", "grey"),
    ("mts", "code", "blue"),
    ("odp", "slides", "orange"),
    ("ods", "sheet", "green"),
    ("odt", "word", "blue"),
    ("ogg", "audio", "purple"),
    ("otf", "font", "grey"),
    ("patch", "git", "orange"),
    ("pdf", "pdf", "red"),
    ("php", "code", "purple"),
    ("plist", "html", "orange"),
    ("png", "image", "purple"),
    ("ppt", "slides", "orange"),
    ("pptx", "slides", "orange"),
    ("properties", "gear", "grey"),
    ("props", "html", "orange"),
    ("ps1", "terminal", "green"),
    ("psm1", "terminal", "green"),
    ("py", "code", "teal"),
    ("pyi", "code", "teal"),
    ("pyw", "code", "teal"),
    ("r", "code", "blue"),
    ("rar", "archive", "gold"),
    ("rb", "code", "red"),
    ("rs", "code", "brown"),
    ("rtf", "word", "blue"),
    ("sass", "hash", "pink"),
    ("scala", "code", "red"),
    ("scss", "hash", "pink"),
    ("sh", "terminal", "green"),
    ("so", "binary", "grey"),
    ("sql", "database", "pink"),
    ("styl", "hash", "pink"),
    ("svg", "image", "purple"),
    ("swift", "code", "orange"),
    ("tar", "archive", "gold"),
    ("text", "text", "grey"),
    ("tgz", "archive", "gold"),
    ("tif", "image", "purple"),
    ("tiff", "image", "purple"),
    ("toml", "gear", "brown"),
    ("ts", "code", "blue"),
    ("tsv", "sheet", "green"),
    ("tsx", "react", "blue"),
    ("ttf", "font", "grey"),
    ("txt", "text", "grey"),
    ("war", "archive", "gold"),
    ("wav", "audio", "purple"),
    ("webm", "video", "purple"),
    ("webmanifest", "braces", "yellow"),
    ("webp", "image", "purple"),
    ("wmv", "video", "purple"),
    ("woff", "font", "grey"),
    ("woff2", "font", "grey"),
    ("xhtml", "html", "orange"),
    ("xls", "sheet", "green"),
    ("xlsx", "sheet", "green"),
    ("xml", "html", "orange"),
    ("xsl", "html", "orange"),
    ("xslt", "html", "orange"),
    ("xz", "archive", "gold"),
    ("yaml", "list", "purple"),
    ("yml", "list", "purple"),
    ("zip", "archive", "gold"),
    ("zsh", "terminal", "green"),
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

/// Look up the (shape, color) pair for an extension (leading dot optional).
fn icon_for_extension(extension: &str) -> Option<(&'static str, &'static str)> {
    let bare = extension.strip_prefix('.').unwrap_or(extension);
    EXTENSION_ICONS
        .iter()
        .find(|(ext, _, _)| ext.eq_ignore_ascii_case(bare))
        .map(|(_, shape, color)| (*shape, *color))
}

/// ProgId for an extension. `.txt` (and unknown extensions) use the legacy
/// `FeatherPad.Text`; everything else gets a type-specific `FeatherPad.<shape>.<color>`.
fn prog_id_for(extension: &str) -> String {
    let bare = extension.strip_prefix('.').unwrap_or(extension);
    if bare.eq_ignore_ascii_case("txt") {
        return LEGACY_PROG_ID.to_owned();
    }
    match icon_for_extension(bare) {
        Some((shape, color)) => format!("FeatherPad.{shape}.{color}"),
        None => LEGACY_PROG_ID.to_owned(),
    }
}

/// Extension with a leading dot, as stored in registry keys.
fn dotted(extension: &str) -> String {
    if extension.starts_with('.') {
        extension.to_owned()
    } else {
        format!(".{extension}")
    }
}

/// `<exe_dir>\icons\filetypes\<shape>-<color>.ico`, or the exe itself if the
/// specific icon file is unavailable at runtime.
fn icon_path_for(extension: &str, executable: &Path) -> String {
    if let Some((shape, color)) = icon_for_extension(extension) {
        if let Some(dir) = executable.parent() {
            let candidate = dir
                .join("icons")
                .join("filetypes")
                .join(format!("{shape}-{color}.ico"));
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    executable.to_string_lossy().into_owned()
}

/// Distinct ProgIds required for the full extension set (ordered, deduped).
fn all_prog_ids() -> Vec<String> {
    let set: BTreeSet<String> = EXTENSION_ICONS
        .iter()
        .map(|(ext, _, _)| prog_id_for(ext))
        .collect();
    set.into_iter().collect()
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

fn prog_id_key(prog_id: &str) -> String {
    format!(r"HKCU\Software\Classes\{prog_id}")
}

/// Write one ProgId's keys: display name, DefaultIcon (per-type ico), marker and
/// open command. Assumes the ProgId subtree is owned/absent (checked by caller).
fn write_prog_id(prog_id: &str, display: &str, icon: &str, command: &str) -> Result<(), AppError> {
    let key = prog_id_key(prog_id);
    add(&key, None, display)?;
    add(&format!(r"{key}\DefaultIcon"), None, icon)?;
    add(&key, Some(MARKER_NAME), APP_ID)?;
    add(&format!(r"{key}\shell\open\command"), None, command)?;
    Ok(())
}

fn enable_file_association(executable: &Path) -> Result<(), AppError> {
    let command = format!("\"{}\" \"%1\"", executable.display());

    // 1. Guard every ProgId we are about to write: only touch absent or
    //    FeatherPad-owned subtrees, never hijack another app's ProgId.
    for prog_id in all_prog_ids() {
        ensure_exact_owned_or_absent(&prog_id_key(&prog_id), || prog_id_owned(&prog_id, executable))?;
    }
    ensure_exact_owned_or_absent(APPLICATION_KEY, || application_owned(executable))?;

    // 2. Conflict guard: refuse if an extension's OpenWithProgids already lists
    //    our ProgId name but we don't own the ProgId (someone else's mapping).
    for (ext, _, _) in EXTENSION_ICONS {
        let prog_id = prog_id_for(ext);
        let key = format!(
            r"HKCU\Software\Classes\{}\OpenWithProgids",
            dotted(ext)
        );
        if value_exists(&key, &prog_id)? && !key_exists(&prog_id_key(&prog_id))? {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "已有其他程序使用相同的轻羽“打开方式”注册项；未覆盖现有设置。",
            ));
        }
    }

    // 3. Write each distinct ProgId once, with the per-type icon.
    for prog_id in all_prog_ids() {
        // Determine representative extension for icon lookup.
        let ext = EXTENSION_ICONS
            .iter()
            .find(|(e, _, _)| prog_id_for(e) == prog_id)
            .map(|(e, _, _)| *e)
            .unwrap_or("txt");
        let icon = icon_path_for(ext, executable);
        let display = if prog_id == LEGACY_PROG_ID {
            "轻羽文本文档"
        } else {
            "轻羽文档"
        };
        write_prog_id(&prog_id, display, &icon, &command)?;
    }

    // 4. Applications\featherpad.exe entry (pointer for "open with").
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

    // 5. Per-extension OpenWithProgids + SupportedTypes + default ProgId.
    // Setting the extension's (Default) value makes Explorer fall back to our
    // per-type icon when the user has not chosen a default app. Binary and
    // executable extensions are never made the default handler (that would
    // break launching those files) nor offered in "open with"; they keep only a
    // type icon association when relevant.
    for (ext, _, _) in EXTENSION_ICONS {
        let dotted_ext = dotted(ext);
        let prog_id = prog_id_for(ext);
        add(
            &format!(r"{APPLICATION_KEY}\SupportedTypes"),
            Some(&dotted_ext),
            "",
        )?;
        let ext_key = format!(r"HKCU\Software\Classes\{dotted_ext}");
        add(
            &format!(r"{ext_key}\OpenWithProgids"),
            Some(&prog_id),
            "",
        )?;
        if !is_binary_extension(ext) {
            add(&ext_key, None, &prog_id)?;
        }
    }
    Ok(())
}

/// Extensions that must never be claimed as FeatherPad's default handler.
fn is_binary_extension(extension: &str) -> bool {
    matches!(
        extension,
        "exe" | "dll" | "so" | "dylib" | "bin" | "msi"
    )
}

fn disable_file_association() -> Result<(), AppError> {
    let executable = executable_path()?;
    let application_is_owned = application_owned(&executable)?;
    if application_is_owned {
        delete_key(APPLICATION_KEY)?;
    }
    // Relinquish any extension default ProgId that still points at one of ours,
    // so double-click no longer routes to (now removed) FeatherPad ProgIds.
    for (ext, _, _) in EXTENSION_ICONS {
        let dotted_ext = dotted(ext);
        let prog_id = prog_id_for(ext);
        let ext_key = format!(r"HKCU\Software\Classes\{dotted_ext}");
        if !is_binary_extension(ext) && value_matches(&ext_key, None, &prog_id)? {
            delete_value(&ext_key, "")?;
        }
        let owp = format!(r"{ext_key}\OpenWithProgids");
        if value_matches(&owp, Some(&prog_id), "")? {
            delete_value(&owp, &prog_id)?;
        }
    }
    for prog_id in all_prog_ids() {
        if prog_id_owned(&prog_id, &executable)? {
            delete_key(&prog_id_key(&prog_id))?;
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
    if !application_owned(&executable)? {
        return Ok(false);
    }
    for prog_id in all_prog_ids() {
        if !prog_id_owned(&prog_id, &executable)? {
            return Ok(false);
        }
    }
    for (ext, _, _) in EXTENSION_ICONS {
        let dotted_ext = dotted(ext);
        let prog_id = prog_id_for(ext);
        let ext_key = format!(r"HKCU\Software\Classes\{dotted_ext}");
        if !value_exists(&format!(r"{APPLICATION_KEY}\SupportedTypes"), &dotted_ext)?
            || !value_exists(&format!(r"{ext_key}\OpenWithProgids"), &prog_id)?
            || (!is_binary_extension(ext) && !value_matches(&ext_key, None, &prog_id)?)
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

/// A specific ProgId is "owned" when the marker matches, the open command points
/// at this executable, and the DefaultIcon is one of our file-type icons (or the
/// executable itself, for the legacy fallback).
fn prog_id_owned(prog_id: &str, executable: &Path) -> Result<bool, AppError> {
    let key = prog_id_key(prog_id);
    if !owned(&key)? {
        return Ok(false);
    }
    let command = format!("\"{}\" \"%1\"", executable.display());
    if !value_matches(&format!(r"{key}\shell\open\command"), None, &command)? {
        return Ok(false);
    }
    let icon = value_string(&format!(r"{key}\DefaultIcon"), None)?;
    let owned_icon = match icon {
        Some(value) => {
            value == executable.to_string_lossy()
                || (value.contains("filetypes")
                    && value.ends_with(".ico")
                    && executable
                        .parent()
                        .is_some_and(|dir| Path::new(&value).starts_with(dir)))
        }
        None => false,
    };
    Ok(owned_icon)
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
