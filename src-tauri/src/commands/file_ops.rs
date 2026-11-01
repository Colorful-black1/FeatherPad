use crate::{
    models::{
        AppError, CreateEntryRequest, DirectoryEntry, ErrorCode, RenameEntryRequest,
        RenameEntryResult, ResultEnvelope,
    },
    services::files::FileService,
};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Request, AppHandle, Manager};

type SharedFiles = Arc<Mutex<FileService>>;

fn internal_error() -> AppError {
    AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。")
}

fn request_value(request: &Request<'_>) -> Result<serde_json::Value, AppError> {
    match request.body() {
        tauri::ipc::InvokeBody::Json(value) => Ok(value.clone()),
        _ => Err(AppError::new(
            ErrorCode::InvalidInput,
            "文件操作请求必须为JSON对象。",
        )),
    }
}

#[tauri::command]
pub async fn create_entry(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<DirectoryEntry>, ()> {
    let value = match request_value(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: CreateEntryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "新建项目请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .create_entry(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn rename_entry(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<RenameEntryResult>, ()> {
    let value = match request_value(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: RenameEntryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "重命名请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .rename_entry(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}
