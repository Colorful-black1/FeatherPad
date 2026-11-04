use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, FileRef, RenamedDocument, ResultEnvelope},
    services::{
        walker::{WalkCoordinator, WalkWorkspaceRequest, WalkWorkspaceResult},
        workspace::WorkspaceRoot,
        workspace_file::{SaveWorkspaceFileRequest, WorkspaceFileConfig, WorkspaceFileDocument},
    },
};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, Manager, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasedRoot {
    renamed_documents: Vec<RenamedDocument>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveWorkspaceAsRequest {
    config: WorkspaceFileConfig,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelWalkRequest {
    request_id: String,
}

#[tauri::command]
pub async fn inspect_workspace_root(
    app: AppHandle,
    root: FileRef,
) -> ResultEnvelope<WorkspaceRoot> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .lock()
            .map_err(|_| internal_error())?
            .inspect_workspace_root(&root)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn release_workspace_root(app: AppHandle, root: FileRef) -> ResultEnvelope<ReleasedRoot> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state_root = super::session_root(&app)?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .release_workspace_root(&root, &state_root)
            .map(|renamed_documents| ReleasedRoot { renamed_documents })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn open_workspace_file(
    app: AppHandle,
    webview: WebviewWindow,
) -> ResultEnvelope<Option<WorkspaceFileDocument>> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_parent(&webview)
            .set_title("打开 FeatherPad 工作区")
            .add_filter("FeatherPad 工作区", &["featherpad-workspace"])
            .blocking_pick_file();
        let Some(selection) = selection else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地工作区文件。"))?;
        service
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。"))?
            .open_workspace_file(&path)
            .map(Some)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::new(
            ErrorCode::Internal,
            "本地文件服务暂时不可用，请重试。",
        ))
    })
    .into()
}

#[tauri::command]
pub async fn save_workspace_file(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<WorkspaceFileDocument>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "工作区保存请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: SaveWorkspaceFileRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "工作区保存请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。"))?
            .save_workspace_file(request)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::new(
            ErrorCode::Internal,
            "本地文件服务暂时不可用，请重试。",
        ))
    });
    Ok(result.into())
}

#[tauri::command]
pub async fn save_workspace_file_as(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<Option<WorkspaceFileDocument>>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "工作区另存请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: SaveWorkspaceAsRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "工作区另存请求格式无效。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_parent(&webview)
            .set_title("保存 FeatherPad 工作区")
            .set_file_name("project.featherpad-workspace")
            .add_filter("FeatherPad 工作区", &["featherpad-workspace"])
            .blocking_save_file();
        let Some(selection) = selection else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地工作区文件。"))?;
        service
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。"))?
            .save_workspace_file_as(&path, request.config)
            .map(Some)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::new(
            ErrorCode::Internal,
            "本地文件服务暂时不可用，请重试。",
        ))
    });
    Ok(result.into())
}

#[tauri::command]
pub async fn walk_workspace(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<WalkWorkspaceResult>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录遍历请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: WalkWorkspaceRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录遍历请求格式无效。",
            ))
            .into())
        }
    };
    let coordinator = app
        .state::<std::sync::Arc<WalkCoordinator>>()
        .inner()
        .clone();
    if let Err(error) = coordinator.start(&request.request_id) {
        return Ok(Err(error).into());
    }
    let service = app.state::<SharedFiles>().inner().clone();
    let request_id = request.request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let service = service
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。"))?;
        service.walk_workspace(request, coordinator)
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::new(
            ErrorCode::Internal,
            "目录遍历服务暂时不可用，请重试。",
        ))
    });
    app.state::<std::sync::Arc<WalkCoordinator>>()
        .inner()
        .finish(&request_id);
    Ok(result.into())
}

#[tauri::command]
pub async fn cancel_workspace_walk(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<CancelWalkRequest>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "取消目录遍历请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let request: CancelWalkRequest = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "取消目录遍历请求格式无效。",
            ))
            .into())
        }
    };
    let cancelled = app
        .state::<std::sync::Arc<WalkCoordinator>>()
        .cancel(&request.request_id);
    Ok(cancelled.map(|_| request).into())
}

pub fn handle_native_drop(app: &AppHandle, window_id: &str, paths: Vec<std::path::PathBuf>) {
    let app = app.clone();
    let window_id = window_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let service = app.state::<SharedFiles>().inner().clone();
        let result = service
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。"))
            .and_then(|mut service| service.register_native_drop(paths));
        match result {
            Ok(entries) => {
                let _ = app.emit_to(&window_id, "featherpad:native-drop", entries);
            }
            Err(error) => {
                let _ = app.emit_to(&window_id, "featherpad:native-drop-error", error);
            }
        }
    });
}
