use super::{internal_error, save::journal_root, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, ResultEnvelope, SaveAsAck, SaveAsRequest, SaveIntent},
    services::{
        create_file::PreparedCreation,
        save::HardLinkPolicy,
        save_as::ExistingDestination,
        save_requests::{InFlightSaves, SaveAsStart},
    },
};
use std::sync::Arc;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
pub async fn save_document_as(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SaveAsAck>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "另存请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let active = app.state::<Arc<InFlightSaves>>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: SaveAsRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "另存快照格式无效。"))?;
        let _permit = active.enter_as(&request)?;
        let start = service
            .lock()
            .map_err(|_| internal_error())?
            .begin_save_as(&request)?;
        let ticket = match start {
            SaveAsStart::Fresh(ticket) => ticket,
            SaveAsStart::Replay(result) => return result,
        };
        let result = choose_and_save(&app, &service, request);
        service
            .lock()
            .map_err(|_| internal_error())?
            .finish_save_as(ticket, result)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

fn choose_and_save(
    app: &AppHandle,
    service: &SharedFiles,
    request: SaveAsRequest,
) -> Result<SaveAsAck, AppError> {
    let root = journal_root(app)?;
    let parent = app.get_webview_window("main").ok_or_else(internal_error)?;
    let title = if request.intent == SaveIntent::Copy {
        "保存副本"
    } else {
        "另存为"
    };
    let selection = app
        .dialog()
        .file()
        .set_parent(&parent)
        .set_title(title)
        .set_file_name("无标题.txt")
        .blocking_save_file();
    let Some(selection) = selection else {
        return Err(AppError::new(
            ErrorCode::Cancelled,
            "已取消路径选择，正文仍保留。",
        ));
    };
    let path = selection
        .into_path()
        .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地文件路径。"))?;
    if path.try_exists().map_err(crate::models::io_error)? {
        let destination = {
            let mut files = service.lock().map_err(|_| internal_error())?;
            ExistingDestination::capture(&mut files, &path, &request.document_id, request.intent)?
        };
        let confirmed = app
            .dialog()
            .message(format!(
                "目标已存在：\n{}\n\n覆盖仅影响所选路径，其他硬链接保留旧内容。是否覆盖？",
                destination.display_path()
            ))
            .title("确认覆盖文件")
            .parent(&parent)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show();
        if !confirmed {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "已取消覆盖，源文档未变。",
            ));
        }
        let mut files = service.lock().map_err(|_| internal_error())?;
        destination.commit_confirmed(
            &mut files,
            request,
            &root,
            HardLinkPolicy::ReplaceSelectedPathConfirmed,
        )
    } else {
        let target = service
            .lock()
            .map_err(|_| internal_error())?
            .grants
            .authorize_new_target(&path)?;
        let prepared = PreparedCreation::prepare(request, target, &root)?;
        let mut files = service.lock().map_err(|_| internal_error())?;
        prepared.commit(&mut files)
    }
}
