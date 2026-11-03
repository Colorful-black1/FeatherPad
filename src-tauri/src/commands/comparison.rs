use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, ResultEnvelope},
    services::comparison::{ComparisonRequest, ComparisonSnapshot},
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};

#[tauri::command]
pub async fn read_comparison_snapshot(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<ComparisonSnapshot>, ()> {
    let request: ComparisonRequest = match request.body() {
        InvokeBody::Json(value) => match serde_json::from_value(value.clone()) {
            Ok(request) => request,
            Err(_) => {
                return Ok(Err(AppError::new(ErrorCode::InvalidInput, "比较请求格式无效。")).into())
            }
        },
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "比较请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let files = app.state::<SharedFiles>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        files
            .lock()
            .map_err(|_| internal_error())?
            .read_comparison_snapshot(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}
