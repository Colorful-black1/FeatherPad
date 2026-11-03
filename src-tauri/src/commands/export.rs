use super::{internal_error, save_as::perform_save_as};
use crate::{
    models::{AppError, ErrorCode, ResultEnvelope, SaveAsAck},
    services::export::HtmlExportRequest,
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle,
};

#[tauri::command]
pub async fn export_html(
    app: AppHandle,
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
        perform_save_as(&app, request.into_snapshot()?, true)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}
