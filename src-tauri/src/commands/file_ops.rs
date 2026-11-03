use crate::{
    models::{
        AppError, CreateEntryRequest, DirectoryEntry, ErrorCode, RenameEntryRequest,
        RenameEntryResult, ResultEnvelope, TransferEntryRequest, TransferEntryResult,
        TrashEntryRequest, TrashEntryResult, TrashImpact, TrashImpactRequest,
    },
    services::files::FileService,
};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Request, AppHandle, Manager};

type SharedFiles = Arc<Mutex<FileService>>;

fn internal_error() -> AppError {
    AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。")
}

#[tauri::command]
pub async fn get_trash_impact(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<TrashImpact>, ()> {
    let value = match request_value(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: TrashImpactRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "回收预览请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .get_trash_impact(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn trash_entry(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<TrashEntryResult>, ()> {
    let value = match request_value(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let active = app
        .state::<Arc<crate::services::save_requests::InFlightSaves>>()
        .inner()
        .clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: TrashEntryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "回收请求格式无效。"))?;
        let recovery = super::save::journal_root(&app)?.with_file_name("recovery");
        let mut service = service.lock().map_err(|_| internal_error())?;
        let _permits =
            active.reserve_documents(&request.affected_document_ids, &request.request_id)?;
        service.trash_entry(request, &recovery)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
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

#[tauri::command]
pub async fn transfer_entry(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<TransferEntryResult>, ()> {
    let value = match request_value(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: TransferEntryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "移动或复制请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .transfer_entry(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}
