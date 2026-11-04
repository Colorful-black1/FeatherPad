use super::SharedFiles;
use crate::{
    models::{AppError, ErrorCode, ResultEnvelope},
    services::windows::{complete_request, DesktopCoordinator, DesktopDelivery},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const REQUEST_EVENT: &str = "featherpad:desktop-request-ready";

type SharedDesktop = Arc<DesktopCoordinator>;

pub(super) fn require_document_owner(
    app: &AppHandle,
    window_id: &str,
    document_id: &str,
) -> Result<(), AppError> {
    if !app
        .state::<SharedDesktop>()
        .owns_document(document_id, window_id)?
    {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "文件正在另一个窗口编辑；当前窗口为只读镜像",
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWindowRequest {
    #[serde(default)]
    pub window_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowResult {
    pub window_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteDesktopRequest {
    pub request_id: String,
    pub ok: bool,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteDesktopResult {
    pub completed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusWindowResult {
    pub focused: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWindowSessionResult {
    pub removed: bool,
}

pub(crate) fn create_window(
    app: &AppHandle,
    requested_id: Option<String>,
) -> Result<String, AppError> {
    let window_id = requested_id.unwrap_or_else(|| format!("window-{}", uuid::Uuid::new_v4()));
    validate_window_id(&window_id)?;
    if let Some(existing) = app.get_webview_window(&window_id) {
        focus(&existing)?;
        return Ok(window_id);
    }
    let window = WebviewWindowBuilder::new(app, &window_id, WebviewUrl::App("index.html".into()))
        .title("轻羽 FeatherPad")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 560.0)
        .additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --disable-background-networking --disable-component-update \
             --disable-domain-reliability --disable-sync --disable-gpu --no-first-run \
             --no-default-browser-check",
        )
        .build()
        .map_err(|_| AppError::new(ErrorCode::Internal, "无法创建新窗口，请重试"))?;
    focus(&window)?;
    Ok(window_id)
}

pub(crate) fn focus(window: &WebviewWindow) -> Result<(), AppError> {
    window
        .show()
        .map_err(|_| AppError::new(ErrorCode::Internal, "窗口无法显示"))?;
    window
        .unminimize()
        .map_err(|_| AppError::new(ErrorCode::Internal, "窗口无法恢复"))?;
    window
        .set_focus()
        .map_err(|_| AppError::new(ErrorCode::Internal, "窗口无法获得焦点"))
}

pub(crate) fn validate_window_id(window_id: &str) -> Result<(), AppError> {
    if window_id == "main" {
        return Ok(());
    }
    let Some(raw) = window_id.strip_prefix("window-") else {
        return Err(AppError::new(ErrorCode::InvalidInput, "窗口标识无效"));
    };
    if uuid::Uuid::parse_str(raw)
        .ok()
        .map(|id| format!("window-{id}"))
        .as_deref()
        != Some(window_id)
    {
        return Err(AppError::new(ErrorCode::InvalidInput, "窗口标识无效"));
    }
    Ok(())
}

pub(crate) fn deliver(
    app: &AppHandle,
    desktop: &DesktopCoordinator,
    delivery: DesktopDelivery,
) -> Result<(), AppError> {
    let window_id = delivery.window_id.clone();
    desktop.enqueue(delivery)?;
    if let Some(window) = app.get_webview_window(&window_id) {
        let _ = focus(&window);
        let _ = app.emit_to(window_id, REQUEST_EVENT, ());
    }
    Ok(())
}

pub(crate) fn start_primary_scanner(app: AppHandle) {
    std::thread::spawn(move || loop {
        if app.webview_windows().is_empty() {
            break;
        }
        let desktop = app.state::<SharedDesktop>().inner().clone();
        let next = crate::services::windows::next_primary_request(desktop.root());
        let Some((_claimed_path, request)) = (match next {
            Ok(next) => next,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(250));
                continue;
            }
        }) else {
            std::thread::sleep(std::time::Duration::from_millis(100));
            continue;
        };
        let request_id = request.request_id.clone();
        let files = app.state::<SharedFiles>().inner().clone();
        let resolution = match files.lock() {
            Ok(mut files) => crate::services::windows::resolve_targets(
                &request.run,
                std::path::Path::new(&request.cwd),
                |path, kind| files.grants.register_selection(path, kind),
            ),
            Err(_) => {
                let _ = crate::services::windows::acknowledge_request(
                    desktop.root(),
                    &request_id,
                    false,
                    false,
                    "本地文件服务暂时不可用",
                );
                continue;
            }
        };
        if resolution.targets.is_empty()
            && (!request.run.paths.is_empty()
                || request.run.goto.is_some()
                || !resolution.failures.is_empty())
        {
            let message = if resolution.failures.is_empty() {
                "CLI 未提供可打开的文件或目录".to_owned()
            } else {
                resolution.failures.join(" ")
            };
            let _ = crate::services::windows::acknowledge_request(
                desktop.root(),
                &request_id,
                false,
                false,
                &message,
            );
            continue;
        }
        let window_id = match request.run.window_mode {
            crate::services::cli::WindowMode::New => create_window(&app, None),
            crate::services::cli::WindowMode::Reuse => {
                let focused = app
                    .webview_windows()
                    .values()
                    .find(|window| window.is_focused().unwrap_or(false))
                    .map(|window| window.label().to_owned());
                focused
                    .or_else(|| app.get_webview_window("main").map(|_| "main".to_owned()))
                    .ok_or_else(|| AppError::new(ErrorCode::NotFound, "没有可接收请求的窗口"))
            }
        };
        let result = window_id.and_then(|window_id| {
            deliver(
                &app,
                &desktop,
                DesktopDelivery {
                    request_id: request_id.clone(),
                    window_id,
                    wait: request.run.wait,
                    targets: resolution.targets,
                    failures: resolution.failures.clone(),
                },
            )
        });
        match result {
            Ok(()) => {
                let message = if resolution.failures.is_empty() {
                    "请求已交给 FeatherPad 窗口".to_owned()
                } else {
                    format!("已打开可访问的路径；{}", resolution.failures.join(" "))
                };
                let _ = crate::services::windows::acknowledge_request(
                    desktop.root(),
                    &request_id,
                    true,
                    !resolution.failures.is_empty(),
                    &message,
                );
            }
            Err(error) => {
                let _ = crate::services::windows::acknowledge_request(
                    desktop.root(),
                    &request_id,
                    false,
                    false,
                    &error.message,
                );
            }
        }
    });
}

#[tauri::command]
pub async fn take_desktop_requests(
    app: AppHandle,
    webview: WebviewWindow,
) -> ResultEnvelope<Vec<DesktopDelivery>> {
    let desktop = app.state::<SharedDesktop>().inner().clone();
    desktop.take(webview.label()).into()
}

#[tauri::command]
pub async fn complete_desktop_request(
    app: AppHandle,
    webview: WebviewWindow,
    request: CompleteDesktopRequest,
) -> ResultEnvelope<CompleteDesktopResult> {
    let desktop = app.state::<SharedDesktop>().inner().clone();
    let result = (|| {
        desktop.complete(&request.request_id, webview.label())?;
        complete_request(
            desktop.root(),
            &request.request_id,
            request.ok,
            &request.message,
        )?;
        Ok(CompleteDesktopResult { completed: true })
    })();
    result.into()
}

#[tauri::command]
pub async fn create_desktop_window(
    app: AppHandle,
    request: CreateWindowRequest,
) -> ResultEnvelope<DesktopWindowResult> {
    create_window(&app, request.window_id)
        .map(|window_id| DesktopWindowResult { window_id })
        .into()
}

#[tauri::command]
pub async fn focus_desktop_window(
    app: AppHandle,
    request: CreateWindowRequest,
) -> ResultEnvelope<FocusWindowResult> {
    let result = (|| {
        let window_id = request
            .window_id
            .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "窗口标识无效"))?;
        validate_window_id(&window_id)?;
        let window = app
            .get_webview_window(&window_id)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "目标窗口已关闭，请重新打开文件"))?;
        focus(&window)?;
        Ok(FocusWindowResult { focused: true })
    })();
    result.into()
}

#[tauri::command]
pub async fn remove_desktop_window_session(
    app: AppHandle,
    webview: WebviewWindow,
) -> ResultEnvelope<RemoveWindowSessionResult> {
    let desktop = app.state::<SharedDesktop>().inner().clone();
    let result = (|| {
        let _session_guard = desktop.lock_session()?;
        if app.webview_windows().len() <= 1 {
            return Ok(RemoveWindowSessionResult { removed: false });
        }
        let store = crate::services::session::SessionStore::new(super::session_root(&app)?);
        let mut loaded = store.load()?;
        let Some(session) = &mut loaded.session else {
            return Ok(RemoveWindowSessionResult { removed: false });
        };
        let before = session.windows.len();
        session
            .windows
            .retain(|window| window.window_id != webview.label());
        if session.windows.len() == before {
            return Ok(RemoveWindowSessionResult { removed: false });
        }
        if session.windows.is_empty() {
            store.clear()?;
        } else {
            session.recovery_snapshot_refs = session
                .windows
                .iter()
                .flat_map(|window| window.views.iter())
                .filter_map(|view| view.recovery_receipt_id.clone())
                .collect();
            let validated = crate::services::session::validate_manifest(session.clone())?;
            store.save(&validated)?;
        }
        Ok(RemoveWindowSessionResult { removed: true })
    })();
    result.into()
}

#[cfg(test)]
mod tests {
    use super::validate_window_id;

    #[test]
    fn only_main_or_generated_window_labels_are_accepted() {
        assert!(validate_window_id("main").is_ok());
        assert!(validate_window_id("window-9f65b481-0e36-4a48-a43f-9e97f8dbc1c7").is_ok());
        assert!(validate_window_id("window-../../escape").is_err());
        assert!(validate_window_id("main2").is_err());
    }
}
