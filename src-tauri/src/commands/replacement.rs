use super::{internal_error, save, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, ResultEnvelope},
    services::{
        replace_plan::{
            CommitReplacePlanRequest, CreateReplacePlanRequest, ReplaceBatchOutcome,
            ReplacementPlan, RollbackBatchOutcome, RollbackReplaceBatchRequest,
        },
        walker::WalkCoordinator,
    },
};
use std::{fs, sync::Arc};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};

#[tauri::command]
pub async fn create_replace_plan(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<ReplacementPlan>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "跨文件替换预览请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: CreateReplacePlanRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "跨文件替换预览请求格式无效。",
            ))
            .into())
        }
    };
    let coordinator = app.state::<Arc<WalkCoordinator>>().inner().clone();
    if let Err(error) = coordinator.start(&request.request_id) {
        return Ok(Err(error).into());
    }
    let service = app.state::<SharedFiles>().inner().clone();
    let request_id = request.request_id.clone();
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = save::journal_root(&worker_app)?.with_file_name("replacement-plans");
        fs::create_dir_all(&root).map_err(crate::models::io_error)?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .create_replace_plan(request, &root, coordinator)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    app.state::<Arc<WalkCoordinator>>().finish(&request_id);
    Ok(result.into())
}

#[tauri::command]
pub async fn commit_replace_plan(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<ReplaceBatchOutcome>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "跨文件替换提交请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: CommitReplacePlanRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "跨文件替换提交请求格式无效。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = save::journal_root(&app)?.with_file_name("replacement-plans");
        service
            .lock()
            .map_err(|_| internal_error())?
            .commit_replace_plan(request, &root)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn rollback_replace_batch(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<RollbackBatchOutcome>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "替换回滚请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: RollbackReplaceBatchRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "替换回滚请求格式无效。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = save::journal_root(&app)?.with_file_name("replacement-plans");
        service
            .lock()
            .map_err(|_| internal_error())?
            .rollback_replace_batch(request, &root)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}
