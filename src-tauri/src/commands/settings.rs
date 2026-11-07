use super::{internal_error, save::journal_root, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, FileRef, ResultEnvelope},
    services::{
        fonts::{list_font_families as enumerate_fonts, LocalFonts},
        settings::{LoadedSettings, SaveSettingsRequest, SavedSettings, SettingsStore},
        workspace_settings::WorkspaceSettings,
    },
};
use serde::{de::DeserializeOwned, Deserialize};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceRequest {
    root: FileRef,
}

fn parse<T: DeserializeOwned>(request: &Request<'_>) -> Result<T, AppError> {
    let InvokeBody::Json(value) = request.body() else {
        return Err(invalid());
    };
    serde_json::from_value(value.clone()).map_err(|_| invalid())
}
fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "设置请求格式无效。")
}

#[tauri::command]
pub async fn load_settings(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<LoadedSettings>, ()> {
    if let Err(error) = parse::<EmptyRequest>(&request) {
        return Ok(Err(error).into());
    }
    Ok(tauri::async_runtime::spawn_blocking(move || {
        SettingsStore::new(journal_root(&app)?.with_file_name("settings")).load()
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SavedSettings>, ()> {
    let request = match parse::<SaveSettingsRequest>(&request) {
        Ok(request) => request,
        Err(error) => return Ok(Err(error).into()),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        SettingsStore::new(journal_root(&app)?.with_file_name("settings")).save(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn load_workspace_settings(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<WorkspaceSettings>, ()> {
    let request = match parse::<WorkspaceRequest>(&request) {
        Ok(request) => request,
        Err(error) => return Ok(Err(error).into()),
    };
    let files = app.state::<SharedFiles>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        files
            .lock()
            .map_err(|_| internal_error())?
            .load_workspace_settings(request.root)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn list_font_families(request: Request<'_>) -> Result<ResultEnvelope<LocalFonts>, ()> {
    if let Err(error) = parse::<EmptyRequest>(&request) {
        return Ok(Err(error).into());
    }
    Ok(tauri::async_runtime::spawn_blocking(enumerate_fonts)
        .await
        .unwrap_or_else(|_| Err(internal_error()))
        .into())
}
