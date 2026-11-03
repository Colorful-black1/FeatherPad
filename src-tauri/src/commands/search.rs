use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, ResultEnvelope},
    services::search::{SearchCoordinator, WorkspaceSearchRequest, WorkspaceSearchResult},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, Manager,
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelSearchRequest {
    request_id: String,
}

#[tauri::command]
pub async fn search_workspace(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<WorkspaceSearchResult>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录搜索请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: WorkspaceSearchRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录搜索请求格式无效。",
            ))
            .into())
        }
    };
    let coordinator = app.state::<Arc<SearchCoordinator>>().inner().clone();
    let walker = match coordinator.start(&request.request_id) {
        Ok(walker) => walker,
        Err(error) => return Ok(Err(error).into()),
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let request_id = request.request_id.clone();
    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let service = service.lock().map_err(|_| internal_error())?;
        service.search_workspace(request, coordinator, walker, move |progress| {
            let _ = progress_app.emit("featherpad:workspace-search-progress", progress);
        })
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::new(
            ErrorCode::Internal,
            "目录搜索服务暂时不可用，请重试。",
        ))
    });
    app.state::<Arc<SearchCoordinator>>().finish(&request_id);
    Ok(result.into())
}

#[tauri::command]
pub async fn cancel_workspace_search(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<CancelSearchRequest>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "取消搜索请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: CancelSearchRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "取消搜索请求格式无效。",
            ))
            .into())
        }
    };
    let cancelled = app
        .state::<Arc<SearchCoordinator>>()
        .cancel(&request.request_id);
    Ok(cancelled.map(|_| request).into())
}
