use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, FileRef, OpenDocument, ResultEnvelope},
    services::{save_requests::InFlightSaves, watch::WatchRegistry},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, Manager, WebviewWindow,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DocumentRequest {
    document_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReloadRequest {
    document_id: String,
    expected_disk_revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatchRequest {
    refs: Vec<FileRef>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopRequest {
    watch_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedWatch {
    watch_id: String,
}
#[derive(Serialize)]
pub struct StoppedWatch {
    stopped: bool,
}

fn parse<T: DeserializeOwned>(request: &Request<'_>) -> Result<T, AppError> {
    let InvokeBody::Json(value) = request.body() else {
        return Err(invalid());
    };
    serde_json::from_value(value.clone()).map_err(|_| invalid())
}
fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "外部变化请求格式无效。")
}
fn validate_id(id: &str) -> Result<(), AppError> {
    if uuid::Uuid::parse_str(id)
        .ok()
        .map(|id| id.to_string())
        .as_deref()
        != Some(id)
    {
        return Err(invalid());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_disk_snapshot(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<OpenDocument>, ()> {
    let request = match parse::<DocumentRequest>(&request) {
        Ok(request) => request,
        Err(error) => return Ok(Err(error).into()),
    };
    let files = app.state::<SharedFiles>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        validate_id(&request.document_id)?;
        files
            .lock()
            .map_err(|_| internal_error())?
            .get_disk_snapshot(&request.document_id)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn reload_document(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<OpenDocument>, ()> {
    let request = match parse::<ReloadRequest>(&request) {
        Ok(request) => request,
        Err(error) => return Ok(Err(error).into()),
    };
    let files = app.state::<SharedFiles>().inner().clone();
    let active = app.state::<Arc<InFlightSaves>>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        validate_id(&request.document_id)?;
        let desktop = app.state::<Arc<crate::services::windows::DesktopCoordinator>>();
        if !desktop.owns_document(&request.document_id, webview.label())? {
            let mut snapshot = files
                .lock()
                .map_err(|_| internal_error())?
                .get_disk_snapshot(&request.document_id)?;
            if snapshot.metadata.disk_revision != request.expected_disk_revision {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "磁盘版本已变化，请重新读取只读镜像。",
                ));
            }
            snapshot.writable = false;
            snapshot.write_owner_window_id =
                Some(desktop.claim_document(&request.document_id, webview.label())?);
            return Ok(snapshot);
        }
        let _permit = active.reserve_documents(
            std::slice::from_ref(&request.document_id),
            &uuid::Uuid::new_v4().to_string(),
        )?;
        files
            .lock()
            .map_err(|_| internal_error())?
            .reload_document(&request.document_id, &request.expected_disk_revision)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn start_watch(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<StartedWatch>, ()> {
    let request = match parse::<WatchRequest>(&request) {
        Ok(request) => request,
        Err(error) => return Ok(Err(error).into()),
    };
    let files = app.state::<SharedFiles>().inner().clone();
    let watches = app.state::<Arc<Mutex<WatchRegistry>>>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let grants = files.lock().map_err(|_| internal_error())?.grants.clone();
        let watch_id = watches.lock().map_err(|_| internal_error())?.start(
            &grants,
            request.refs,
            Arc::new(move |event| {
                let _ = app.emit_to(webview.label(), "filesystem_changed", event);
            }),
        )?;
        Ok(StartedWatch { watch_id })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn stop_watch(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<StoppedWatch>, ()> {
    let request = match parse::<StopRequest>(&request) {
        Ok(request) => request,
        Err(error) => return Ok(Err(error).into()),
    };
    let watches = app.state::<Arc<Mutex<WatchRegistry>>>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        validate_id(&request.watch_id)?;
        Ok(StoppedWatch {
            stopped: watches
                .lock()
                .map_err(|_| internal_error())?
                .stop(&request.watch_id),
        })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}
