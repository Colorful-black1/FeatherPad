use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, FileMetadata, ResultEnvelope, SaveAck, SaveRequest},
    services::{
        data_dir::runtime_data_root,
        save::{HardLinkPolicy, PreparedSave},
        save_requests::{InFlightSaves, SaveStart},
    },
};
use std::{path::PathBuf, sync::Arc};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(super) fn journal_root(_app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(runtime_data_root()?.root.join("save-transactions"))
}

// Tauri requires Result for an async borrowed Request; normal outcomes always use our envelope.
#[tauri::command]
pub async fn save_document(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAck>, ()> {
    run_save(app, webview, request, SaveMode::Interactive).await
}

#[tauri::command]
pub async fn auto_save_document(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAck>, ()> {
    run_save(app, webview, request, SaveMode::Background).await
}

enum SaveMode {
    Interactive,
    Overwrite,
    Background,
}

#[tauri::command]
pub async fn overwrite_document(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAck>, ()> {
    run_save(app, webview, request, SaveMode::Overwrite).await
}

async fn run_save(
    app: AppHandle,
    webview: WebviewWindow,
    request: Request<'_>,
    mode: SaveMode,
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
    let desktop = app
        .state::<Arc<crate::services::windows::DesktopCoordinator>>()
        .inner()
        .clone();
    let window_id = webview.label().to_owned();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: SaveRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "保存请求格式无效。"))?;
        if !desktop.owns_document(&request.document_id, &window_id)? {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "文件正在另一个窗口编辑；当前窗口为只读镜像",
            ));
        }
        let _permit = active.enter(&request)?;
        let start = service
            .lock()
            .map_err(|_| internal_error())?
            .begin_save(&request)?;
        let ticket = match start {
            SaveStart::Replay(result) => return result,
            SaveStart::Fresh(ticket) => ticket,
        };
        let result = match mode {
            SaveMode::Overwrite => confirm_overwrite(&app, &webview, &service, &request)
                .and_then(|()| save_with_confirmation(&app, &webview, &service, request)),
            SaveMode::Interactive => save_with_confirmation(&app, &webview, &service, request),
            SaveMode::Background => save_without_confirmation(&app, &service, request),
        };
        service
            .lock()
            .map_err(|_| internal_error())?
            .finish_save(ticket, result)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

fn save_without_confirmation(
    app: &AppHandle,
    service: &SharedFiles,
    request: SaveRequest,
) -> Result<SaveAck, AppError> {
    let root = journal_root(app)?;
    let mut files = service.lock().map_err(|_| internal_error())?;
    PreparedSave::prepare(&files, request, &root, HardLinkPolicy::RequireConfirmation)?
        .commit(&mut files)
}

fn confirm_overwrite(
    app: &AppHandle,
    webview: &WebviewWindow,
    service: &SharedFiles,
    request: &SaveRequest,
) -> Result<(), AppError> {
    let snapshot = service
        .lock()
        .map_err(|_| internal_error())?
        .get_disk_snapshot(&request.document_id)?;
    if snapshot.metadata.disk_revision != request.expected_disk_revision {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "磁盘在比较后再次变化，请重新比较后确认覆盖。",
        ));
    }
    let confirmed = app.dialog().message(format!("将用当前缓冲替换磁盘文件：\n{}\n\n外部修改会被覆盖。保存前将再次核对磁盘版本；事务恢复副本会保留原件。是否继续？", snapshot.metadata.display_path))
        .title("确认覆盖外部修改").parent(webview).kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo).blocking_show();
    if !confirmed {
        return Err(AppError::new(
            ErrorCode::Cancelled,
            "已取消覆盖，当前正文和外部文件均保留。",
        ));
    }
    service
        .lock()
        .map_err(|_| internal_error())?
        .reload_document(&request.document_id, &request.expected_disk_revision)?;
    Ok(())
}

fn save_with_confirmation(
    app: &AppHandle,
    webview: &WebviewWindow,
    service: &SharedFiles,
    request: SaveRequest,
) -> Result<SaveAck, AppError> {
    let root = journal_root(app)?;
    let confirmation = service
        .lock()
        .map_err(|_| internal_error())?
        .inspect_hard_links(&request)?;
    if let Some(confirmation) = &confirmation {
        let message = format!(
            "文件有 {} 个硬链接：\n{}\n\n保存仅替换所选路径，其他硬链接保留旧内容。是否继续？",
            confirmation.link_count(),
            confirmation.display_path()
        );
        let confirmed = app
            .dialog()
            .message(message)
            .title("确认替换硬链接")
            .parent(webview)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show();
        if !confirmed {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "已取消保存，正文与磁盘文件均保留。",
            ));
        }
    }
    // Never hold the file-service mutex while waiting for the native dialog.
    let mut files = service.lock().map_err(|_| internal_error())?;
    let prepared = match confirmation {
        Some(confirmation) => confirmation.prepare_confirmed(&files, request, &root)?,
        None => PreparedSave::prepare(&files, request, &root, HardLinkPolicy::RequireConfirmation)?,
    };
    prepared.commit(&mut files)
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
