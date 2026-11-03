use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, FileRef, ResultEnvelope},
    services::assets::{ResourceImage, ResourceRequest},
};
use serde::Deserialize;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinkRequest {
    document_id: Option<String>,
    directory: Option<FileRef>,
    url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExternalRequest {
    url: String,
    confirmed: bool,
}

fn parse<T: serde::de::DeserializeOwned>(request: &Request<'_>) -> Result<T, AppError> {
    let InvokeBody::Json(value) = request.body() else {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "链接请求必须是JSON对象。",
        ));
    };
    serde_json::from_value(value.clone())
        .map_err(|_| AppError::new(ErrorCode::InvalidInput, "链接请求格式无效。"))
}

#[tauri::command]
pub async fn authorize_preview_link(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<FileRef>, ()> {
    let request: LinkRequest = match parse(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    let files = app.state::<SharedFiles>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        files
            .lock()
            .map_err(|_| internal_error())?
            .authorize_preview_link(
                request.document_id.as_deref(),
                request.directory.as_ref(),
                &request.url,
            )
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn open_external_preview(request: Request<'_>) -> Result<ResultEnvelope<bool>, ()> {
    let request: ExternalRequest = match parse(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        crate::services::preview_links::open_external_url(&request.url, request.confirmed)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn read_preview_resource(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<ResourceImage>, ()> {
    let parsed = match request.body() {
        InvokeBody::Json(value) => serde_json::from_value::<ResourceRequest>(value.clone()),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "资源请求必须是JSON对象。",
            ))
            .into())
        }
    };
    let request = match parsed {
        Ok(request) => request,
        Err(_) => {
            return Ok(Err(AppError::new(ErrorCode::InvalidInput, "资源请求格式无效。")).into())
        }
    };
    let files = app.state::<SharedFiles>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        files
            .lock()
            .map_err(|_| internal_error())?
            .read_preview_resource(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}
