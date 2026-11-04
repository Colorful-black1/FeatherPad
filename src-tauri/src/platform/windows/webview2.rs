use crate::models::{AppError, ErrorCode};
use std::path::{Path, PathBuf};

const RUNTIME_EXECUTABLE: &str = "msedgewebview2.exe";
const HELP_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/#download-section";

pub fn ensure_available() -> Result<(), AppError> {
    if runtime_available() {
        return Ok(());
    }
    let message = format!(
        "轻羽 FeatherPad 需要 Microsoft Edge WebView2 Evergreen Runtime。\n\n\
         请连接网络后从 Microsoft 官方页面安装 Runtime，然后重新启动轻羽：\n{HELP_URL}\n\n\
         本程序不会自动联网下载，也不会在缺少 Runtime 时伪装为可用。"
    );
    show_error(&message);
    Err(AppError::new(
        ErrorCode::Unsupported,
        &format!("缺少 Microsoft Edge WebView2 Runtime。请从官方页面安装后重试：{HELP_URL}"),
    ))
}

fn runtime_available() -> bool {
    let configured = std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join(r"Microsoft\EdgeWebView\Application"));
    let machine = std::env::var_os("ProgramFiles(x86)")
        .map(PathBuf::from)
        .map(|root| root.join(r"Microsoft\EdgeWebView\Application"));
    configured
        .into_iter()
        .chain(local)
        .chain(machine)
        .any(|root| runtime_available_in(&root))
}

fn runtime_available_in(root: &Path) -> bool {
    if root.join(RUNTIME_EXECUTABLE).is_file() {
        return true;
    }
    std::fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.path().join(RUNTIME_EXECUTABLE).is_file()
        })
}

fn show_error(message: &str) {
    super::show_error(message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts/T402")
            .join(uuid::Uuid::new_v4().to_string())
    }

    #[test]
    fn detects_evergreen_runtime_in_version_or_configured_layouts() {
        let root = fixture();
        fs::create_dir_all(root.join("156.0.0.0")).unwrap();
        assert!(!runtime_available_in(&root));
        fs::write(root.join("156.0.0.0").join(RUNTIME_EXECUTABLE), b"").unwrap();
        assert!(runtime_available_in(&root));

        let configured = root.join("configured");
        fs::create_dir_all(&configured).unwrap();
        fs::write(configured.join(RUNTIME_EXECUTABLE), b"").unwrap();
        assert!(runtime_available_in(&configured));
    }
}
