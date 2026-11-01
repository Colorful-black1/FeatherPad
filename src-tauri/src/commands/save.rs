use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, FileMetadata, ResultEnvelope, SaveAck, SaveRequest},
    services::{save::HardLinkPolicy, save_requests::InFlightSaves},
};
use std::{path::PathBuf, sync::Arc};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};

pub(super) fn journal_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let root = if let Some(directory) = std::env::var_os("FEATHERPAD_USER_DATA_DIR") {
        let directory = PathBuf::from(directory);
        if !directory.is_absolute() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "本地状态目录必须为绝对路径。",
            ));
        }
        directory
    } else {
        app.path()
            .app_local_data_dir()
            .map_err(|_| internal_error())?
    };
    Ok(root.join("save-transactions"))
}

// Tauri requires Result for an async borrowed Request; normal outcomes always use our envelope.
#[tauri::command]
pub async fn save_document(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAck>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "保存请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let active = app.state::<Arc<InFlightSaves>>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: SaveRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "保存请求格式无效。"))?;
        let _permit = active.enter(&request)?;
        let root = journal_root(&app)?;
        service.lock().map_err(|_| internal_error())?.save_existing(
            request,
            &root,
            HardLinkPolicy::RequireConfirmation,
        )
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn stat_document(app: AppHandle, document_id: String) -> ResultEnvelope<FileMetadata> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if document_id.is_empty() || document_id.len() > 128 {
            return Err(AppError::new(ErrorCode::InvalidInput, "文档标识无效。"));
        }
        service
            .lock()
            .map_err(|_| internal_error())?
            .stat_document(&document_id)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}
