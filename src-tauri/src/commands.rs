use crate::{
    models::{
        AppError, ChosenFiles, ErrorCode, FileRef, OpenDocument, ReadChunkRequest, ResultEnvelope,
        TextChunk,
    },
    services::{
        files::{FileService, OpenRequestMode},
        grants::GrantKind,
    },
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};
use tauri_plugin_dialog::DialogExt;
pub mod save;
pub mod save_as;

type SharedFiles = Arc<Mutex<FileService>>;

#[derive(Serialize)]
pub struct ChosenFolder {
    grant: Option<FileRef>,
}

fn internal_error() -> AppError {
    AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。")
}

#[tauri::command]
pub async fn choose_files(app: AppHandle, multiple: bool) -> ResultEnvelope<ChosenFiles> {
    let service = app.state::<SharedFiles>().inner().clone();
    let Some(parent) = app.get_webview_window("main") else {
        return Err(internal_error()).into();
    };
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_parent(&parent)
            .set_title("打开文件");
        let paths = if multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        };
        let mut service = service.lock().map_err(|_| internal_error())?;
        let paths = paths.into_iter().map(|selection| {
            selection
                .into_path()
                .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地文件。"))
        });
        Ok(service.grants.register_file_selections(paths))
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn choose_folder(app: AppHandle) -> ResultEnvelope<ChosenFolder> {
    let service = app.state::<SharedFiles>().inner().clone();
    let Some(parent) = app.get_webview_window("main") else {
        return Err(internal_error()).into();
    };
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_parent(&parent)
            .set_title("打开文件夹")
            .blocking_pick_folder();
        let grant = if let Some(selection) = selection {
            let path = selection
                .into_path()
                .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地文件夹。"))?;
            Some(
                service
                    .lock()
                    .map_err(|_| internal_error())?
                    .grants
                    .register_selection(&path, GrantKind::Directory)?,
            )
        } else {
            None
        };
        Ok(ChosenFolder { grant })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn open_document(
    app: AppHandle,
    r#ref: serde_json::Value,
    encoding_override: Option<String>,
    mode: Option<String>,
) -> ResultEnvelope<OpenDocument> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if encoding_override
            .as_deref()
            .is_some_and(|encoding| encoding != "utf-8")
        {
            return Err(AppError::new(ErrorCode::Unsupported, "所选编码暂不可用。"));
        }
        let open_mode = match mode.as_deref() {
            None | Some("normal") => OpenRequestMode::Auto,
            Some("head-preview") => OpenRequestMode::HeadPreview,
            Some(_) => {
                return Err(AppError::new(
                    ErrorCode::Unsupported,
                    "所选打开模式暂不可用。",
                ))
            }
        };
        let reference = serde_json::from_value(r#ref)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "文件引用格式无效。"))?;
        let result = service
            .lock()
            .map_err(|_| internal_error())?
            .open_document_with_mode(reference, open_mode);
        result
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn read_document_chunk(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<TextChunk>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "分块读取请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: ReadChunkRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "分块读取请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .read_document_chunk(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}
