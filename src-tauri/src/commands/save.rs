use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, FileMetadata, ResultEnvelope, SaveAck, SaveRequest},
    services::{
        save::{HardLinkPolicy, PreparedSave},
        save_requests::{InFlightSaves, SaveStart},
    },
};
use std::{path::PathBuf, sync::Arc};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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
    run_save(app, request, SaveMode::Interactive).await
}

#[tauri::command]
pub async fn auto_save_document(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAck>, ()> {
    run_save(app, request, SaveMode::Background).await
}

enum SaveMode {
    Interactive,
    Overwrite,
    Background,
}

#[tauri::command]
pub async fn overwrite_document(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAck>, ()> {
    run_save(app, request, SaveMode::Overwrite).await
}

async fn run_save(
    app: AppHandle,
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: SaveRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "保存请求格式无效。"))?;
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
            SaveMode::Overwrite => confirm_overwrite(&app, &service, &request)
                .and_then(|()| save_with_confirmation(&app, &service, request)),
            SaveMode::Interactive => save_with_confirmation(&app, &service, request),
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
    let parent = app.get_webview_window("main").ok_or_else(internal_error)?;
    let confirmed = app.dialog().message(format!("将用当前缓冲替换磁盘文件：\n{}\n\n外部修改会被覆盖。保存前将再次核对磁盘版本；事务恢复副本会保留原件。是否继续？", snapshot.metadata.display_path))
        .title("确认覆盖外部修改").parent(&parent).kind(MessageDialogKind::Warning)
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
    service: &SharedFiles,
    request: SaveRequest,
) -> Result<SaveAck, AppError> {
    let root = journal_root(app)?;
    let confirmation = service
        .lock()
        .map_err(|_| internal_error())?
        .inspect_hard_links(&request)?;
    if let Some(confirmation) = &confirmation {
        let parent = app.get_webview_window("main").ok_or_else(internal_error)?;
        let message = format!(
            "文件有 {} 个硬链接：\n{}\n\n保存仅替换所选路径，其他硬链接保留旧内容。是否继续？",
            confirmation.link_count(),
            confirmation.display_path()
        );
        let confirmed = app
            .dialog()
            .message(message)
            .title("确认替换硬链接")
            .parent(&parent)
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
