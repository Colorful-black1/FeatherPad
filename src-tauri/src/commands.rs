use crate::{
    models::{AppError, ErrorCode, FileRef, OpenDocument, ResultEnvelope},
    services::{files::FileService, grants::GrantKind},
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
pub mod save;

type SharedFiles = Arc<Mutex<FileService>>;

#[derive(Serialize)]
pub struct ChosenFiles {
    grants: Vec<FileRef>,
}

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
        let grants = paths
            .into_iter()
            .map(|selection| {
                let path = selection
                    .into_path()
                    .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地文件。"))?;
                service.grants.register_selection(&path, GrantKind::File)
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        Ok(ChosenFiles { grants })
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
            || mode.as_deref().is_some_and(|mode| mode != "normal")
        {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "所选打开模式暂不可用。",
            ));
        }
        let reference = serde_json::from_value(r#ref)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "文件引用格式无效。"))?;
        let result = service
            .lock()
            .map_err(|_| internal_error())?
            .open_document(reference);
        result
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}
