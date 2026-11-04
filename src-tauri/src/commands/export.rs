use super::{internal_error, save_as::perform_save_as};
use crate::{
    models::{AppError, ErrorCode, ResultEnvelope, SaveAsAck},
    services::export::HtmlExportRequest,
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, WebviewWindow,
};

#[derive(Default)]
pub struct PdfCoordinator(
    std::sync::Mutex<Option<(String, std::sync::Arc<std::sync::atomic::AtomicBool>)>>,
);
struct PdfPermit<'a>(&'a PdfCoordinator);
impl Drop for PdfPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut current) = self.0 .0.lock() {
            *current = None;
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfExportRequest {
    document_id: String,
    request_id: String,
    document_version: u64,
    html: String,
    options: crate::platform::pdf::PdfOptions,
}

#[tauri::command]
pub fn cancel_pdf_export(
    state: tauri::State<'_, PdfCoordinator>,
    request_id: String,
) -> ResultEnvelope<bool> {
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err(AppError::new(ErrorCode::InvalidInput, "PDF请求标识无效。")).into();
    }
    let result = state.0.lock().map_err(|_| internal_error()).map(|active| {
        if let Some((id, cancelled)) = active.as_ref() {
            if id == &request_id {
                cancelled.store(true, std::sync::atomic::Ordering::Release);
                return true;
            }
        }
        false
    });
    result.into()
}

#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<crate::services::export_target::ExportAck>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "PDF请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        use crate::services::{export::HtmlExportRequest, export_target::ExportTarget};
        use tauri::Manager;
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let request: PdfExportRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "PDF导出请求格式无效。"))?;
        request.options.validate()?;
        let snapshot = HtmlExportRequest {
            document_id: request.document_id,
            request_id: request.request_id.clone(),
            document_version: request.document_version,
            html: request.html,
        }
        .into_snapshot()?;
        let state = app.state::<PdfCoordinator>();
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut active = state.0.lock().map_err(|_| internal_error())?;
            if active.is_some() {
                return Err(AppError::new(
                    ErrorCode::Busy,
                    "已有PDF作业正在生成，请完成或取消后重试。",
                ));
            }
            *active = Some((request.request_id.clone(), cancelled.clone()));
        }
        let _permit = PdfPermit(&state);
        let files = app.state::<super::SharedFiles>().inner().clone();
        let Some(selection) = app
            .dialog()
            .file()
            .set_parent(&webview)
            .set_title("导出 PDF")
            .set_file_name("文档.pdf")
            .add_filter("PDF文档", &["pdf"])
            .blocking_save_file()
        else {
            return Err(AppError::new(ErrorCode::Cancelled, "已取消PDF位置选择。"));
        };
        let path = selection
            .into_path()
            .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地PDF路径。"))?;
        let target = {
            let mut service = files.lock().map_err(|_| internal_error())?;
            service.require_complete_export(&snapshot.document_id)?;
            ExportTarget::capture(&mut service, &path)?
        };
        if target.exists()
            && !app
                .dialog()
                .message(format!(
                    "目标已存在：\n{}\n\n是否覆盖？其他硬链接保留旧内容。",
                    target.display_path()
                ))
                .title("确认覆盖文件")
                .parent(&webview)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNo)
                .blocking_show()
        {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "已取消覆盖，原目标保留。",
            ));
        }
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(AppError::new(ErrorCode::Cancelled, "已取消PDF生成。"));
        }
        let bytes = crate::platform::pdf::render(
            &app,
            &request.request_id,
            snapshot.text,
            request.options,
            &cancelled,
        )?;
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "已取消PDF写入，原目标保留。",
            ));
        }
        let root = super::save::journal_root(&app)?.with_file_name("pdf-exports");
        let mut service = files.lock().map_err(|_| internal_error())?;
        target.commit(&mut service, &bytes, &root)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn export_html(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAsAck>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "导出请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: HtmlExportRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "HTML导出请求格式无效。"))?;
        perform_save_as(&app, &webview, request.into_snapshot()?, true)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}
